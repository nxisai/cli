#!/usr/bin/env node
/**
 * Signs a built release (release/build.mjs's output):
 *
 *   NXIS_RELEASE_SIGNING_KEY_FILE=<key.pem> node release/sign.mjs [--out dir]
 *
 * Writes, in download/v<v>/:
 *
 *   manifest.json        every tarball of the version, and install.sh, with sha256 and size
 *   manifest.json.sig    an Ed25519 signature over manifest.json's exact bytes, base64
 *
 * and copies manifest.json, its signature and install.sh to latest/download/, which is where
 * GitHub's releases/latest/download/<file> redirect finds them, so a static server on the folder
 * behaves like the release.
 *
 * The key's public half has to be pinned in src/release-keys.ts. --trust-key <base64> accepts
 * another public key as well, for a test release signed with a throwaway key: release/verify.mjs,
 * which runs before anything is published, refuses such a release.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { packageInfo, root } from "./app.mjs";
import { MANIFEST_NAME, pinnedKeys, publicKeyOf, readPrivateKey, sha256, signBytes, verifyBytes } from "./signing.mjs";

const { values: args } = parseArgs({
  options: {
    out: { type: "string", default: join(root, "dist/release") },
    key: { type: "string" },
    "trust-key": { type: "string", multiple: true, default: [] },
  },
});
const out = resolve(args.out);
const { version } = packageInfo();
const dir = join(out, "download", `v${version}`);
if (!existsSync(dir)) throw new Error(`nothing built for ${version} in ${dir}; run release/build.mjs first`);

const keyFile = args.key ?? process.env.NXIS_RELEASE_SIGNING_KEY_FILE;
if (!keyFile) throw new Error("set NXIS_RELEASE_SIGNING_KEY_FILE to the signing key's file (or pass --key)");
const key = readPrivateKey(keyFile);
const pinned = await pinnedKeys();
const trusted = [...pinned.real, ...args["trust-key"]];
if (!trusted.includes(publicKeyOf(key))) {
  throw new Error(
    pinned.real.length === 0
      ? "src/release-keys.ts has no release key yet: make one with release/keygen.mjs and pin it"
      : "the signing key's public key isn't pinned in src/release-keys.ts",
  );
}

const files = {};
for (const f of readdirSync(dir).sort()) {
  if ((f.startsWith(`nxis-${version}-`) && f.endsWith(".tar.gz")) || f === "install.sh") {
    files[f] = { sha256: sha256(join(dir, f)), size: statSync(join(dir, f)).size };
  }
}
if (!Object.keys(files).some((f) => f.endsWith(".tar.gz"))) throw new Error(`no tarballs for ${version} in ${dir}`);

const manifest = Buffer.from(JSON.stringify({ name: MANIFEST_NAME, version, files }, null, 2) + "\n");
const signature = signBytes(manifest, key);
if (!verifyBytes(manifest, signature, trusted)) throw new Error("the manifest's signature doesn't verify");
writeFileSync(join(dir, "manifest.json"), manifest);
writeFileSync(join(dir, "manifest.json.sig"), `${signature}\n`);

// The stable pointer, last, so it never names a version whose files aren't all there.
const latest = join(out, "latest", "download");
mkdirSync(latest, { recursive: true });
for (const f of ["manifest.json", "manifest.json.sig", "install.sh"]) if (existsSync(join(dir, f))) copyFileSync(join(dir, f), join(latest, f));
console.log(`sign: signed download/v${version}/manifest.json (${Object.keys(files).length} files)`);
