/**
 * Release signing: release/keygen.mjs, release/sign.mjs and release/verify.mjs, and the CLI's own
 * check of a signed manifest (src/release.ts).
 *
 * Every key here is a throwaway pair made in a temporary folder for this run and deleted after it.
 * No real private key is involved: src/release-keys.ts pins the real public key, and its private
 * half is never in a checkout.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RELEASE_KEY_PLACEHOLDER, RELEASE_KEYS } from "../src/release-keys.js";
import { releasePlatform, releaseTarball, ReleaseError, trustedReleaseKeys, verifyManifest } from "../src/release.js";

const root = join(import.meta.dirname, "..");
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
const host = `${process.platform}-${process.arch}`;
const supported = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"].includes(host);

/** A throwaway Ed25519 pair: the private key object and the public key in the pinned format. */
function pair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, pub: publicKey.export({ format: "der", type: "spki" }).toString("base64") };
}

const sha = "a".repeat(64);
const manifestBytes = (m: unknown) => Buffer.from(JSON.stringify(m, null, 2) + "\n");

describe("verifyManifest", () => {
  const k = pair();
  const other = pair();
  const body = manifestBytes({ name: "nxis", version: "1.2.3", files: { "nxis-1.2.3-linux-x64.tar.gz": { sha256: sha, size: 10 } } });
  const sig = sign(null, body, k.privateKey).toString("base64");

  it("returns the manifest when a trusted key signed it", () => {
    const m = verifyManifest(body, `${sig}\n`, [other.pub, k.pub]);
    expect(m.version).toBe("1.2.3");
    expect(releaseTarball(m, "1.2.3", "linux-x64")).toEqual({ name: "nxis-1.2.3-linux-x64.tar.gz", sha256: sha, size: 10 });
  });

  it("refuses a manifest signed by another key, or changed after signing", () => {
    expect(() => verifyManifest(body, sig, [other.pub])).toThrow(/isn't signed/);
    const changed = Buffer.from(body.toString("utf8").replace("1.2.3", "1.2.4"));
    expect(() => verifyManifest(changed, sig, [k.pub])).toThrow(/isn't signed/);
    expect(() => verifyManifest(body, "bm90IGEgc2lnbmF0dXJl", [k.pub])).toThrow(/malformed/);
  });

  it("never trusts the placeholder", () => {
    expect(() => verifyManifest(body, sig, [RELEASE_KEY_PLACEHOLDER])).toThrow(/no release key/);
  });

  it("refuses a signed manifest that isn't nxis's, or is malformed", () => {
    for (const m of [
      { name: "other", version: "1.2.3", files: {} },
      { name: "nxis", version: "latest", files: {} },
      { name: "nxis", version: "1.2.3", files: { x: { sha256: "nothex", size: 1 } } },
    ]) {
      const b = manifestBytes(m);
      expect(() => verifyManifest(b, sign(null, b, k.privateKey).toString("base64"), [k.pub])).toThrow(ReleaseError);
    }
  });

  it("finds no tarball for another version or platform", () => {
    const m = verifyManifest(body, sig, [k.pub]);
    expect(() => releaseTarball(m, "1.2.4", "linux-x64")).toThrow(/for 1.2.3, not 1.2.4/);
    expect(() => releaseTarball(m, "1.2.3", "darwin-arm64")).toThrow(/no build for darwin-arm64/);
  });

  it("names the supported platforms", () => {
    expect(releasePlatform("darwin", "arm64")).toBe("darwin-arm64");
    expect(releasePlatform("linux", "x64")).toBe("linux-x64");
    expect(() => releasePlatform("win32", "x64")).toThrow(/no standalone nxis for win32-x64/);
  });

  it("pins the real release key, and not the placeholder", () => {
    const real = "MCowBQYDK2VwAyEAm/iQrAGXPqkGbNFBIYekgg4/bYL9SLik4q6eLI6K3YQ=";
    expect(RELEASE_KEYS).toEqual([real]);
    expect(RELEASE_KEYS).not.toContain(RELEASE_KEY_PLACEHOLDER);
    expect(trustedReleaseKeys()).toEqual([real]);
  });
});

describe("keygen.mjs", () => {
  it("writes a 600 key outside the checkout and prints only the public key", () => {
    const dir = mkdtempSync(join(tmpdir(), "nxis-keygen-test-"));
    try {
      const key = join(dir, "k.pem");
      const printed = execFileSync(process.execPath, [join(root, "release/keygen.mjs"), key], { encoding: "utf8" });
      expect(statSync(key).mode & 0o777).toBe(0o600);
      expect(printed).toMatch(/Public key:\n\n {2}MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=\n/);
      expect(printed).not.toContain("PRIVATE KEY");
      // It never overwrites one.
      expect(spawnSync(process.execPath, [join(root, "release/keygen.mjs"), key]).status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a path inside a git checkout", () => {
    const r = spawnSync(process.execPath, [join(root, "release/keygen.mjs"), join(root, ".dev/never-made.pem")], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("inside a git checkout");
    expect(existsSync(join(root, ".dev/never-made.pem"))).toBe(false);
  });
});

describe.skipIf(!supported)("sign.mjs and verify.mjs", () => {
  let dir: string;
  let out: string;
  let keyFile: string;
  let pub: string;
  const node = (script: string, args: string[]) =>
    spawnSync(process.execPath, [join(root, "release", script), ...args], { cwd: root, encoding: "utf8" });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "nxis-sign-test-"));
    out = join(dir, "out");
    keyFile = join(dir, "test-key.pem");
    pub = /Public key:\n\n {2}(\S+)/.exec(execFileSync(process.execPath, [join(root, "release/keygen.mjs"), keyFile], { encoding: "utf8" }))![1]!;
    const stand = join(dir, "node");
    writeFileSync(stand, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
    chmodSync(stand, 0o755);
    const b = node("build.mjs", ["--platforms", "host", "--out", out, "--node-binary", stand, "--trust-key", pub]);
    if (b.status !== 0) throw new Error(b.stderr);
  }, 120_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a key that isn't pinned or trusted", () => {
    const r = node("sign.mjs", ["--out", out, "--key", keyFile]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("the signing key's public key isn't pinned in src/release-keys.ts");
  });

  it("signs every tarball into a manifest the CLI accepts, and points latest at it", () => {
    const r = node("sign.mjs", ["--out", out, "--key", keyFile, "--trust-key", pub]);
    expect(r.status, r.stderr).toBe(0);
    const v = join(out, "download", `v${version}`);
    const body = readFileSync(join(v, "manifest.json"));
    const m = verifyManifest(body, readFileSync(join(v, "manifest.json.sig"), "utf8"), [pub]);
    const t = releaseTarball(m, version, host);
    expect(t.size).toBe(statSync(join(v, t.name)).size);
    expect(readFileSync(join(out, "latest/download/manifest.json")).equals(body)).toBe(true);
  });

  it("verify.mjs refuses to publish a release signed with a test key", () => {
    const r = node("verify.mjs", ["--out", out]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no release key yet|isn't signed by a pinned release key/);
  });
});
