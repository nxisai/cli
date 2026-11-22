#!/usr/bin/env node
/**
 * Builds the standalone release: for each platform, a tarball with an official Node.js runtime,
 * the CLI bundled into one file, and a launcher. The output has the paths the release has on
 * GitHub, so a static file server on the folder stands in for it:
 *
 *   download/v<v>/nxis-<v>-<platform>.tar.gz          Node + the bundled CLI
 *   download/v<v>/nxis-<v>-<platform>.tar.gz.sha256
 *   download/v<v>/install.sh                         the installer, with the release keys and Node's hashes in it
 *
 * Each tarball unpacks to nxis-<v>-<platform>/:
 *
 *   bin/node                 Node.js, checked against the hashes pinned in release/node.json
 *   bin/nxis                 a launcher that runs app/dist/nxis.mjs on bin/node, from wherever it is
 *   app/                     the bundle (release/app.mjs)
 *   LICENSE NOTICE TRADEMARK.md NODE-LICENSE
 *
 *   node release/build.mjs [--platforms darwin-arm64,linux-x64|host] [--out dir]
 *
 * Node downloads are cached in .dev/cache/node. --node-binary <file> puts that file in as
 * bin/node instead of downloading Node, for tests only. --trust-key <base64> adds a public key the
 * bundle trusts besides those pinned in src/release-keys.ts, for a release signed with a test key.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildApp, packageInfo, root } from "./app.mjs";
import { PLATFORMS } from "./platforms.mjs";
import { isPublicKey, pinnedKeys } from "./signing.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const node = JSON.parse(readFileSync(join(here, "node.json"), "utf8"));

const { values: args } = parseArgs({
  options: {
    platforms: { type: "string", default: PLATFORMS.join(",") },
    out: { type: "string", default: join(root, "dist/release") },
    "node-binary": { type: "string" },
    "trust-key": { type: "string", multiple: true, default: [] },
  },
});
/** Where releases are: GitHub's releases of the public repository. */
const RELEASES_URL = "https://github.com/nxisai/cli/releases";
const host = `${process.platform}-${process.arch}`;
const platforms = args.platforms.split(",").map((p) => (p.trim() === "host" ? host : p.trim()));
for (const p of platforms) if (!PLATFORMS.includes(p)) throw new Error(`unknown platform ${p}; use ${PLATFORMS.join(", ")} or host`);
const out = resolve(args.out);
const { version } = packageInfo();

// The keys nxis update will trust: the pinned ones, and any --trust-key, for a test release only
// (release/verify.mjs refuses to publish a release that isn't signed by a pinned key).
const pinned = await pinnedKeys();
for (const k of args["trust-key"]) if (!isPublicKey(k)) throw new Error(`--trust-key isn't a base64 Ed25519 public key: ${k}`);
const trusted = [...pinned.real, ...args["trust-key"]];

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: ["ignore", "inherit", "inherit"], ...opts });
const log = (s) => console.log(`release: ${s}`);

const work = mkdtempSync(join(tmpdir(), "nxis-release-"));

// 1. The app, the same on every platform.
const app = join(work, "app");
log(`bundling nxis ${version}`);
const bundled = await buildApp(app, { define: { __NXIS_RELEASE_KEYS__: JSON.stringify(trusted) } });
log(`bundled ${bundled.length} packages`);

// 2. Per platform: Node and the app, as nxis-<v>-<platform>/.
const cache = join(root, ".dev/cache/node");
mkdirSync(cache, { recursive: true });
const releaseDir = join(out, "download", `v${version}`);
mkdirSync(releaseDir, { recursive: true });

for (const platform of platforms) {
  const name = `nxis-${version}-${platform}`;
  const dir = join(work, name);
  mkdirSync(join(dir, "bin"), { recursive: true });

  if (args["node-binary"]) {
    cpSync(resolve(args["node-binary"]), join(dir, "bin/node"));
    writeFileSync(join(dir, "NODE-LICENSE"), "A stand-in Node.js for tests.\n");
  } else {
    const nodeName = `node-v${node.version}-${platform}`;
    const nodeTar = join(cache, `${nodeName}.tar.gz`);
    if (!existsSync(nodeTar)) {
      log(`downloading Node ${node.version} for ${platform}`);
      run("curl", ["--proto", "=https", "--tlsv1.2", "-fsSL", "--retry", "4", "--retry-all-errors", "--retry-delay", "2", "-o", nodeTar, `https://nodejs.org/dist/v${node.version}/${nodeName}.tar.gz`]);
    }
    if (sha256(nodeTar) !== node.tarballs[platform]) {
      rmSync(nodeTar);
      throw new Error(`${nodeName}.tar.gz doesn't match the hash pinned in release/node.json; run again to download it fresh`);
    }
    run("tar", ["-xzf", nodeTar, "-C", work, `${nodeName}/bin/node`, `${nodeName}/LICENSE`]);
    cpSync(join(work, nodeName, "bin/node"), join(dir, "bin/node"));
    // install.sh checks this binary against node.json before it uses it to verify a release.
    if (sha256(join(dir, "bin/node")) !== node.binaries[platform]) throw new Error(`${nodeName}/bin/node doesn't match release/node.json`);
    cpSync(join(work, nodeName, "LICENSE"), join(dir, "NODE-LICENSE"));
  }
  chmodSync(join(dir, "bin/node"), 0o755);
  for (const f of ["LICENSE", "NOTICE", "TRADEMARK.md"]) cpSync(join(root, f), join(dir, f));
  cpSync(app, join(dir, "app"), { recursive: true });
  // Runs from wherever the folder is. The installer writes its own launcher into ~/.local/bin.
  writeFileSync(join(dir, "bin/nxis"), '#!/bin/sh\nd=$(cd "$(dirname "$0")/.." && pwd)\nexec "$d/bin/node" "$d/app/dist/nxis.mjs" "$@"\n');
  chmodSync(join(dir, "bin/nxis"), 0o755);

  const tarball = join(releaseDir, `${name}.tar.gz`);
  // On macOS, keep extended attributes and ._ files out, or GNU tar warns about them on Linux.
  const macFlags = process.platform === "darwin" ? ["--no-xattrs", "--no-mac-metadata"] : [];
  run("tar", [...macFlags, "-czf", tarball, "-C", work, name], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  writeFileSync(`${tarball}.sha256`, `${sha256(tarball)}  ${name}.tar.gz\n`);
  log(`${name}.tar.gz ${(readFileSync(tarball).length / 1e6).toFixed(1)} MB`);
}

// 3. The installer, with what it checks a release against written in.
const script = readFileSync(join(here, "install.sh"), "utf8")
  .replace("__NXIS_RELEASES_URL__", RELEASES_URL)
  .replace("__NXIS_RELEASE_KEYS__", trusted.join(" "))
  .replace("__NXIS_NODE_SHA256__", PLATFORMS.map((p) => `${p}=${node.binaries[p]}`).join(" "));
const unfilled = script.match(/__NXIS_[A-Z0-9_]+__/);
if (unfilled) throw new Error(`install.sh has a setting build.mjs doesn't fill in: ${unfilled[0]}`);
writeFileSync(join(releaseDir, "install.sh"), script, { mode: 0o755 });

rmSync(work, { recursive: true, force: true });
log(`done: ${releaseDir}`);
