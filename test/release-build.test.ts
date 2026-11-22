/**
 * The standalone build (release/build.mjs) and the check that nothing internal ships
 * (release/check-public.mjs).
 *
 * The build runs for real, bundle and tarball, except that a stand-in replaces Node.js's
 * download: a two-line script that runs the Node running these tests. The real download and its
 * pinned hashes are exercised by release/smoke-tarball.sh in CI.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkPaths, findInternal } from "../release/check-public.mjs";

const root = join(import.meta.dirname, "..");
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
const host = `${process.platform}-${process.arch}`;
const supported = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"].includes(host);

describe("check-public", () => {
  // The references below are put together at run time, so this file passes the check itself: it
  // ships in the public tree, which CI scans with the same rules.
  const HASH = "#";
  const PRIVATE = ["nxisai", "some-private-repo"].join("/");
  const hits = (s: string, hidden?: Set<string>) => (findInternal(s, hidden) as Array<{ why: string }>).map((p) => p.why);

  it("finds private repositories, issue references and internal hosts", () => {
    expect(hits(`see github.com/${PRIVATE} for more`)).toEqual(["a private repository"]);
    expect(hits(`fixed in nxisai/cli${HASH}12`)).toEqual(["an issue or pull request reference"]);
    expect(hits(`as decided in ${HASH}75`)).toEqual(["a bare issue or pull request number"]);
    expect(hits(["curl http://api.example", "internal/x"].join("."))).toEqual(["an internal host"]);
    expect(hits(["https://api-abc123-uc.a", "run.app/v1"].join("."))).toEqual(["a cloud or tunnel host"]);
    expect(hits(["https://demo.ngrok", "io/x"].join("."))).toEqual(["a cloud or tunnel host"]);
    expect(hits(["mongodb+srv:", "", "user:pw@db.example.com/app"].join("/"))).toEqual(["a database connection string"]);
    expect(hits(["see NOTES", "internal.md"].join("."))).toEqual(["an internal document"]);
    expect(hits(["write to someone", "corp-mail.io"].join("@"))).toEqual(["an email address"]);
  });

  it("finds a hidden name by its hash, whole or as a dotted part", () => {
    const hidden = new Set([createHash("sha256").update("made-up-service").digest("hex")]);
    expect(hits("calls Made-Up-Service directly", hidden)).toEqual(["an internal name"]);
    expect(hits("see made-up-service.md", hidden)).toEqual(["an internal name"]);
    expect(hits("calls made-up-services", hidden)).toEqual([]);
  });

  it("allows the public mirror, the tap, npm package names and placeholder addresses", () => {
    expect(findInternal("https://github.com/nxisai/cli/releases and brew tap nxisai/cli")).toEqual([]);
    expect(findInternal("github.com/nxisai/homebrew-cli")).toEqual([]);
    expect(findInternal("npm i -g @nxisai/cli; it runs @nxisai/agent-harness")).toEqual([]);
    expect(findInternal('color: "#123"; $# args; a#1')).toEqual([]);
    expect(findInternal("you@example.com, pw@x.example.com, git@github.com, a@b.test")).toEqual([]);
    expect(findInternal("*.internal.md")).toEqual([]);
    expect(findInternal(["Copyright (c) Jane Doe <jane", "upstream.dev>"].join("@"), undefined, "app/THIRD_PARTY_LICENSES")).toEqual([]);
  });

  it("looks inside tarballs", () => {
    const dir = mkdtempSync(join(tmpdir(), "nxis-check-public-test-"));
    try {
      writeFileSync(join(dir, "notes.txt"), `Ships from ${PRIVATE}.\n`);
      execFileSync("tar", ["-czf", join(dir, "t.tar.gz"), "-C", dir, "notes.txt"]);
      const problems = checkPaths([join(dir, "t.tar.gz")]) as string[];
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(`notes.txt:1: ${PRIVATE}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!supported)("build.mjs", () => {
  let dir: string;
  let out: string;
  const name = `nxis-${version}-${host}`;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "nxis-release-build-test-"));
    out = join(dir, "out");
    const stand = join(dir, "node");
    writeFileSync(stand, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
    chmodSync(stand, 0o755);
    execFileSync(process.execPath, [join(root, "release/build.mjs"), "--platforms", "host", "--out", out, "--node-binary", stand], {
      cwd: root,
      stdio: "pipe",
    });
  }, 120_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the tarball and its checksum at the release's download path", () => {
    const tarball = join(out, "download", `v${version}`, `${name}.tar.gz`);
    expect(existsSync(tarball)).toBe(true);
    const sum = readFileSync(`${tarball}.sha256`, "utf8");
    expect(sum).toBe(`${createHash("sha256").update(readFileSync(tarball)).digest("hex")}  ${name}.tar.gz\n`);
  });

  it("packs Node, the launcher, the bundle and the licenses", () => {
    const list = execFileSync("tar", ["-tzf", join(out, "download", `v${version}`, `${name}.tar.gz`)], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map((f) => f.replace(/\/$/, ""));
    for (const f of ["bin/node", "bin/nxis", "app/dist/nxis.mjs", "app/package.json", "app/THIRD_PARTY_LICENSES", "LICENSE", "NOTICE", "NODE-LICENSE"]) {
      expect(list).toContain(`${name}/${f}`);
    }
  });

  it("runs from the unpacked folder and reports its version, with no node on PATH", () => {
    const x = join(dir, "x");
    execFileSync("mkdir", ["-p", x]);
    execFileSync("tar", ["-xzf", join(out, "download", `v${version}`, `${name}.tar.gz`), "-C", x]);
    const got = execFileSync(join(x, name, "bin/nxis"), ["--version"], {
      encoding: "utf8",
      env: { HOME: dir, PATH: "/usr/bin:/bin" },
    }).trim();
    expect(got).toBe(version);
    const licenses = readFileSync(join(x, name, "app/THIRD_PARTY_LICENSES"), "utf8");
    expect(licenses).toMatch(/@modelcontextprotocol\/sdk \d+\.\d+\.\d+ \(MIT\)/);
    expect(licenses).toMatch(/\nzod \d+\.\d+\.\d+ \(MIT\)/);
    expect(checkPaths([join(x, name)])).toEqual([]);
  });
});
