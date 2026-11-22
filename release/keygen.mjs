#!/usr/bin/env node
/**
 * Makes a release signing key:
 *
 *   node release/keygen.mjs <path outside any git checkout>
 *
 * Writes the Ed25519 private key to <path> (mode 600; it refuses a path inside a git checkout, or
 * one that exists) and prints only the public key, to pin in src/release-keys.ts.
 */
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { root, writeNewKey } from "./signing.mjs";

const arg = process.argv[2];
if (!arg) {
  console.error("usage: node release/keygen.mjs <path outside any git checkout>, e.g. ~/nxis-release-keys/release.pem");
  process.exit(2);
}
const path = resolve(arg.replace(/^~(?=$|\/)/, homedir()));
if (existsSync(path)) {
  console.error(`keygen: ${path} exists; pick a new path (an existing key is never overwritten)`);
  process.exit(1);
}

// The nearest folder that exists, resolved through symlinks, to see where the key would land.
let parent = dirname(path);
while (!existsSync(parent)) parent = dirname(parent);
const real = resolve(realpathSync(parent), relative(parent, path));
const inside = (dir) => {
  const r = relative(realpathSync(dir), real);
  return r === "" || (!r.startsWith("..") && !r.startsWith(sep));
};
let gitTop = "";
try {
  gitTop = execFileSync("git", ["-C", realpathSync(parent), "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  // Not in a git checkout: good.
}
if (inside(root) || gitTop) {
  console.error(`keygen: ${path} is inside a git checkout (${gitTop || root}); keep the private key outside any repository`);
  process.exit(1);
}

const publicKey = writeNewKey(path);
console.log(`Wrote the private key to ${path} (mode 600). It is not printed.

Public key:

  ${publicKey}

Next:
  1. Add the public key to RELEASE_KEYS in src/release-keys.ts (replacing the placeholder, the
     first time), and commit it. A new key has to ship in a release before one is signed with it.
  2. Store the private key as the release signing secret, and only there (docs/releasing.md).
  3. Keep an offline copy somewhere safe, then delete ${path} from this machine.
`);
