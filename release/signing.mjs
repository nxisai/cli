/**
 * Release signing, shared by sign.mjs, verify.mjs, keygen.mjs and formula.mjs.
 *
 * A release's manifest.json lists every file of a version with its sha256 and size;
 * manifest.json.sig is an Ed25519 signature over its exact bytes, in base64. Public keys are
 * base64 SPKI DER, pinned in src/release-keys.ts, which `nxis update` and install.sh trust.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
export const root = resolve(here, "..");

/** The manifest's `name`, which install.sh and `nxis update` check. */
export const MANIFEST_NAME = "nxis";

const isPlaceholder = (placeholder) => (k) => !k || k === placeholder || k.startsWith("PLACEHOLDER");

/**
 * The keys pinned in src/release-keys.ts, read from the source itself so the CLI, the installer
 * and these scripts can't disagree.
 *
 * @returns `real`: the usable keys; `placeholder`: whether the placeholder is still listed.
 */
export async function pinnedKeys() {
  const { code } = await transform(readFileSync(join(root, "src/release-keys.ts"), "utf8"), { loader: "ts", format: "esm" });
  const { RELEASE_KEYS, RELEASE_KEY_PLACEHOLDER } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  const fake = isPlaceholder(RELEASE_KEY_PLACEHOLDER);
  return { real: RELEASE_KEYS.filter((k) => !fake(k)), placeholder: RELEASE_KEYS.some(fake) };
}

/** A public key in the pinned format, from a private or public key. */
export const publicKeyOf = (key) => createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64");

/** @returns Whether `k` parses as a base64 SPKI Ed25519 public key. */
export function isPublicKey(k) {
  try {
    return createPublicKey({ key: Buffer.from(k, "base64"), format: "der", type: "spki" }).asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

/** Reads an Ed25519 private key from a PEM file that only its owner can read. Never echoes it. */
export function readPrivateKey(path) {
  const st = statSync(path);
  if ((st.mode & 0o077) !== 0) throw new Error(`${path} can be read by others; chmod 600 it`);
  let key;
  try {
    key = createPrivateKey(readFileSync(path));
  } catch {
    throw new Error(`${path} isn't a PEM private key`);
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`${path} isn't an Ed25519 key`);
  return key;
}

/** Writes a new Ed25519 private key (PKCS#8 PEM, mode 600) to `path`, which mustn't exist. @returns Its public key. */
export function writeNewKey(path) {
  const { privateKey } = generateKeyPairSync("ed25519");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  return publicKeyOf(privateKey);
}

export const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

export const signBytes = (bytes, privateKey) => sign(null, bytes, privateKey).toString("base64");

/** @returns Whether any of `keys` made `signature` (base64) over `bytes`. */
export function verifyBytes(bytes, signature, keys) {
  const sig = Buffer.from(signature.trim(), "base64");
  return keys.some((k) => {
    try {
      return verify(null, bytes, createPublicKey({ key: Buffer.from(k, "base64"), format: "der", type: "spki" }), sig);
    } catch {
      return false;
    }
  });
}
