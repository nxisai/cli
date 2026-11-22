/**
 * release/formula.mjs: the Homebrew formula, from a release's signed manifest.
 *
 * The manifest is made here and signed with a throwaway key, passed with --trust-key.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkPaths } from "../release/check-public.mjs";

const root = join(import.meta.dirname, "..");
const VERSION = "1.2.3";
const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
const hasRuby = spawnSync("ruby", ["--version"]).status === 0;

let dir: string;
let pub: string;
const formula = (...args: string[]) =>
  spawnSync(process.execPath, [join(root, "release/formula.mjs"), "--dir", join(dir, "out"), "--version", VERSION, ...args], {
    cwd: root,
    encoding: "utf8",
  });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "nxis-formula-test-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  pub = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const files = Object.fromEntries(
    PLATFORMS.map((p, i) => [`nxis-${VERSION}-${p}.tar.gz`, { sha256: String(i + 1).repeat(64), size: 100 }]),
  );
  const body = Buffer.from(JSON.stringify({ name: "nxis", version: VERSION, files }, null, 2) + "\n");
  const v = join(dir, "out", "download", `v${VERSION}`);
  mkdirSync(v, { recursive: true });
  writeFileSync(join(v, "manifest.json"), body);
  writeFileSync(join(v, "manifest.json.sig"), sign(null, body, privateKey).toString("base64") + "\n");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("formula.mjs", () => {
  it("refuses a manifest no pinned key signed", () => {
    const r = formula();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/no release key yet|isn't signed/);
  });

  it("writes each platform's tarball URL and its sha256 from the manifest", () => {
    const r = formula("--trust-key", pub);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("class Nxis < Formula");
    expect(r.stdout).toContain(`version "${VERSION}"`);
    for (const [i, p] of PLATFORMS.entries()) {
      expect(r.stdout).toContain(
        `      url "https://github.com/nxisai/cli/releases/download/v${VERSION}/nxis-${VERSION}-${p}.tar.gz"\n      sha256 "${String(i + 1).repeat(64)}"`,
      );
    }
    // The wrapper tells nxis Homebrew installed it, and gives mcp install a lasting path.
    expect(r.stdout).toContain('NXIS_INSTALLED_BY: "homebrew"');
    expect(r.stdout).toContain('NXIS_LAUNCHER:     opt_bin/"nxis"');
    if (hasRuby) {
      writeFileSync(join(dir, "nxis.rb"), r.stdout);
      expect(execFileSync("ruby", ["-c", join(dir, "nxis.rb")], { encoding: "utf8" })).toContain("Syntax OK");
    }
  });

  it("writes the formula, README and CI workflow into a tap checkout, with nothing internal", () => {
    const tap = join(dir, "tap");
    const r = formula("--trust-key", pub, "--tap", tap);
    expect(r.status, r.stderr).toBe(0);
    for (const f of ["Formula/nxis.rb", "README.md", ".github/workflows/tests.yml"]) expect(existsSync(join(tap, f))).toBe(true);
    expect(readFileSync(join(tap, "README.md"), "utf8")).toContain("brew tap nxisai/cli");
    expect(checkPaths([tap])).toEqual([]);
  });
});
