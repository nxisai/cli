#!/usr/bin/env node
/**
 * Writes the Homebrew formula for a release, from its signed manifest:
 *
 *   node release/formula.mjs --dir dist/release [--tap <checkout of the tap>]
 *   node release/formula.mjs --version 0.2.0 [--tap <dir>]      (from the published release)
 *
 * The manifest's signature has to verify with a key pinned in src/release-keys.ts, and the
 * sha256s come from it, never from a tarball's own .sha256 file. Without --tap it prints the
 * formula; with --tap it writes Formula/nxis.rb, and the tap's README and CI workflow from
 * release/homebrew/, into that checkout. The formula downloads the installer's tarballs from the
 * GitHub release, so Homebrew users get the same signed files.
 *
 * --trust-key <base64> also accepts a test key, to try the formula with a test release; such a
 * formula is never pushed (the release workflow passes no --trust-key).
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PLATFORMS } from "./platforms.mjs";
import { MANIFEST_NAME, pinnedKeys, verifyBytes } from "./signing.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const RELEASES_URL = "https://github.com/nxisai/cli/releases";

const { values: args } = parseArgs({
  options: {
    version: { type: "string" },
    dir: { type: "string" },
    tap: { type: "string" },
    "trust-key": { type: "string", multiple: true, default: [] },
  },
});

/** A file of the release: from the local build (--dir), or from the GitHub release. */
async function read(version, name) {
  if (args.dir) return readFileSync(join(resolve(args.dir), version ? `download/v${version}` : "latest/download", name));
  const url = version ? `${RELEASES_URL}/download/v${version}/${name}` : `${RELEASES_URL}/latest/download/${name}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} answered HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

const version = (args.version ?? JSON.parse((await read("", "manifest.json")).toString("utf8")).version).replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) throw new Error(`not a version: ${version}`);
const body = await read(version, "manifest.json");
const sig = (await read(version, "manifest.json.sig")).toString("utf8");
const keys = [...(await pinnedKeys()).real, ...args["trust-key"]];
if (keys.length === 0) throw new Error("src/release-keys.ts has no release key yet");
if (!verifyBytes(body, sig, keys)) throw new Error(`nxis ${version}'s manifest isn't signed by a pinned release key`);
const manifest = JSON.parse(body.toString("utf8"));
if (manifest.name !== MANIFEST_NAME || manifest.version !== version) throw new Error(`the manifest is for ${manifest.name} ${manifest.version}, not nxis ${version}`);

const asset = (platform) => {
  const file = `nxis-${version}-${platform}.tar.gz`;
  const sha = manifest.files[file]?.sha256;
  if (!/^[0-9a-f]{64}$/.test(sha ?? "")) throw new Error(`the manifest has no sha256 for ${file}`);
  return `      url "${RELEASES_URL}/download/v${version}/${file}"\n      sha256 "${sha}"`;
};
for (const p of PLATFORMS) asset(p);

const formula = `# Written by release/formula.mjs from nxis ${version}'s signed manifest. Don't edit it by hand:
# the next release replaces it.
class Nxis < Formula
  desc "Set up NxisAI from the terminal and connect your coding agent"
  homepage "https://github.com/nxisai/cli"
  version "${version}"
  license "Apache-2.0"

  # The installer's tarballs: nxis with the Node.js it runs on, so nothing else is needed.
  on_macos do
    on_arm do
${asset("darwin-arm64")}
    end
    on_intel do
${asset("darwin-x64")}
    end
  end

  on_linux do
    on_arm do
${asset("linux-arm64")}
    end
    on_intel do
${asset("linux-x64")}
    end
  end

  def install
    libexec.install Dir["*"]
    # NXIS_INSTALLED_BY: nxis update says to run brew upgrade. NXIS_LAUNCHER: what
    # nxis mcp install writes into an agent's config, a path that survives upgrades.
    (bin/"nxis").write_env_script libexec/"bin/nxis",
      NXIS_INSTALLED_BY: "homebrew",
      NXIS_LAUNCHER:     opt_bin/"nxis"
  end

  def caveats
    <<~EOS
      Sign in, then connect your coding agent:
        nxis signup
        nxis mcp install

      This version of nxis sends no telemetry. If a later version adds usage
      reporting, its README will say what it collects first, and DO_NOT_TRACK=1
      will turn it off.
    EOS
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/nxis --version").strip
  end
end
`;

if (!args.tap) {
  process.stdout.write(formula);
} else {
  const tap = resolve(args.tap);
  mkdirSync(join(tap, "Formula"), { recursive: true });
  mkdirSync(join(tap, ".github/workflows"), { recursive: true });
  writeFileSync(join(tap, "Formula/nxis.rb"), formula);
  cpSync(join(here, "homebrew/README.md"), join(tap, "README.md"));
  cpSync(join(here, "homebrew/tests.yml"), join(tap, ".github/workflows/tests.yml"));
  console.log(`formula: wrote nxis ${version} into ${tap}`);
}
