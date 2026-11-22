#!/usr/bin/env node
/**
 * Checks a signed release before it is published (the release workflow runs it):
 *
 *   node release/verify.mjs [--out dir]
 *
 * The version's manifest.json has to be signed by a key pinned in src/release-keys.ts (not a
 * throwaway test key), every file it lists has to be there and match its sha256 and size, every
 * tarball in the folder has to be listed, each .sha256 has to agree, install.sh has to be listed
 * and trust exactly the pinned keys, and latest/download/ has to hold the same manifest, signature
 * and installer.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { packageInfo, root } from "./app.mjs";
import { MANIFEST_NAME, pinnedKeys, sha256, verifyBytes } from "./signing.mjs";

const { values: args } = parseArgs({ options: { out: { type: "string", default: join(root, "dist/release") } } });
const out = resolve(args.out);
const fail = (s) => {
  console.error(`verify: ${s}`);
  process.exit(1);
};

const { version } = packageInfo();
const dir = join(out, "download", `v${version}`);
const keys = await pinnedKeys();
if (keys.real.length === 0) fail("src/release-keys.ts has no release key yet; make one with release/keygen.mjs and pin it");

const body = readFileSync(join(dir, "manifest.json"));
if (!verifyBytes(body, readFileSync(join(dir, "manifest.json.sig"), "utf8"), keys.real)) {
  fail(`download/v${version}/manifest.json isn't signed by a pinned release key (a test key can't be published)`);
}
const m = JSON.parse(body.toString("utf8"));
if (m.name !== MANIFEST_NAME || m.version !== version) fail(`the manifest is for ${m.name} ${m.version}, not ${MANIFEST_NAME} ${version}`);
for (const [name, f] of Object.entries(m.files)) {
  const file = join(dir, name);
  if (!existsSync(file)) fail(`${name} is in the manifest but not in ${dir}`);
  if (sha256(file) !== f.sha256 || statSync(file).size !== f.size) fail(`${name} doesn't match the manifest`);
}
for (const f of readdirSync(dir)) {
  if (f.endsWith(".tar.gz") && !m.files[f]) fail(`${f} isn't in the manifest`);
  if (f.endsWith(".tar.gz.sha256")) {
    const tarball = f.slice(0, -".sha256".length);
    if (readFileSync(join(dir, f), "utf8") !== `${m.files[tarball]?.sha256}  ${tarball}\n`) fail(`${f} doesn't match the manifest`);
  }
}
if (!m.files["install.sh"]) fail("the manifest doesn't list install.sh");
// The installer trusts exactly the pinned keys: a test key never ships in it.
const installKeys = /^RELEASE_KEYS="([^"]*)"$/m.exec(readFileSync(join(dir, "install.sh"), "utf8"))?.[1].split(" ").filter(Boolean) ?? [];
if (installKeys.join(" ") !== keys.real.join(" ")) fail("install.sh doesn't trust exactly the keys pinned in src/release-keys.ts");
for (const f of ["manifest.json", "manifest.json.sig", "install.sh"]) {
  const latest = join(out, "latest/download", f);
  if (!existsSync(latest) || !readFileSync(latest).equals(readFileSync(join(dir, f)))) fail(`latest/download/${f} isn't this version's`);
}
console.log(`verify: nxis ${version} is signed and complete (${Object.keys(m.files).length} files)`);
