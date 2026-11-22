/**
 * Where `mcp install` may put an API key.
 *
 * The key must never land in a file git would commit, and a project `.mcp.json` is never committed
 * at all: a key committed once stays in the repository's history.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeAddArgs, gitExposure, installMcpServer } from "../src/agents.js";
import { CliError } from "../src/errors.js";

function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "nxis-agents-")));
  execFileSync("git", ["init", "-q", dir]);
  return dir;
}

describe("gitExposure", () => {
  it("is null outside a git work tree", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "nxis-agents-")));
    expect(gitExposure(join(dir, ".mcp.json"))).toBeNull();
  });

  it("reports a file a commit would pick up", () => {
    expect(gitExposure(join(repo(), ".mcp.json"))).toBe("not_ignored");
  });

  it("is null for an ignored file", () => {
    const dir = repo();
    writeFileSync(join(dir, ".gitignore"), ".mcp.json\n");
    expect(gitExposure(join(dir, ".mcp.json"))).toBeNull();
  });

  it("reports a file that is already tracked, even if it is also ignored", () => {
    const dir = repo();
    writeFileSync(join(dir, ".mcp.json"), "{}\n");
    execFileSync("git", ["-C", dir, "add", ".mcp.json"]);
    writeFileSync(join(dir, ".gitignore"), ".mcp.json\n");
    expect(gitExposure(join(dir, ".mcp.json"))).toBe("tracked");
  });
});

describe("claudeAddArgs", () => {
  it("installs at local scope, never project", () => {
    const args = claudeAddArgs("https://mcp.example.test/v1/organizations/o/mcp", "nxis_dev_mcp_x");
    expect(args).toContain("local");
    expect(args).not.toContain("project");
    expect(args).not.toContain("--force");
  });
});

describe("installMcpServer with mcp-json", () => {
  const cwd = process.cwd();
  let dir = "";

  beforeEach(() => {
    dir = repo();
    process.chdir(dir);
  });
  afterEach(() => process.chdir(cwd));

  it("adds .mcp.json to .gitignore where git would commit it, then writes it", () => {
    const result = installMcpServer({ agent: "mcp-json", url: "https://x.test/mcp", apiKey: "nxis_dev_mcp_secret", force: false });
    expect(result).toMatchObject({ gitignored: "added", gitignore: join(dir, ".gitignore") });
    expect(gitExposure(join(dir, ".mcp.json"))).toBeNull();
    expect(existsSync(join(dir, ".mcp.json"))).toBe(true);
  });

  it("refuses to write a key into a .mcp.json git tracks", () => {
    writeFileSync(join(dir, ".mcp.json"), "{}\n");
    execFileSync("git", ["-C", dir, "add", ".mcp.json"]);
    let caught: unknown;
    try {
      installMcpServer({ agent: "mcp-json", url: "https://x.test/mcp", apiKey: "nxis_dev_mcp_secret", force: false });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).reason).toBe("mcp_json_tracked");
    expect((caught as CliError).exitCode).toBe(2);
    expect(readFileSync(join(dir, ".mcp.json"), "utf8")).toBe("{}\n");
  });

  it("writes it, changing nothing else, once git ignores it", () => {
    writeFileSync(join(dir, ".gitignore"), ".mcp.json\n");
    const result = installMcpServer({ agent: "mcp-json", url: "https://x.test/mcp", apiKey: "nxis_dev_mcp_secret", force: false });
    expect(result).toMatchObject({ location: join(dir, ".mcp.json"), gitignored: "already", gitignore: null });
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(".mcp.json\n");
    expect(existsSync(join(dir, ".mcp.json"))).toBe(true);
  });
});
