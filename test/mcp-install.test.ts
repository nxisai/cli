/**
 * `nxis mcp install`: the local server by default, with no key anywhere; `--remote` as before.
 *
 * Every agent config here is written under a temporary HOME and working directory. Claude Code
 * is a stand-in `claude` on PATH that records its arguments, so the real one is never run.
 */

import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claudeAddStdioArgs } from "../src/agents.js";
import { cmdMcpInstall, type McpInstallArgs } from "../src/commands/mcp.js";
import { resolveConfig } from "../src/config.js";
import type { Ctx } from "../src/context.js";
import { CliError } from "../src/errors.js";
import type { Io } from "../src/output.js";
import { isEphemeralPath, localServerEntry, packageVersion } from "../src/self.js";
import { saveSettings } from "../src/state.js";
import { setTrace } from "../src/trace.js";

const ORG = "org-test";
const MINTED = "nxis_dev_mcp_fake_minted_key"; // gitleaks:allow

/** A JWT with an account claim, unsigned. Fake test value only. */
function fakeToken(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ "https://nxis.ai/user_data": { account: { _id: { value: "acct-1" } } } })}.x`;
}

/** Every request the fake API received: a stdio install must send none. */
const requests: string[] = [];
let http: Server;
let base: string;

beforeAll(async () => {
  http = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === "POST" && req.url === `/v1/organizations/${ORG}/apikeys`) {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ raw_key: MINTED, key_id: "key-1", preview: "…key" }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

const savedEnv = { ...process.env };
const savedCwd = process.cwd();
let home: string;
let project: string;
let bin: string;
let claudeLog: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "nxis-install-home-")));
  project = join(home, "project");
  mkdirSync(project);
  bin = join(home, "bin");
  mkdirSync(bin);
  claudeLog = join(home, "claude-calls.log");
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  process.env.NXIS_NO_KEYCHAIN = "1";
  process.env.NXIS_TOKEN = fakeToken();
  // No real `claude` on this PATH: only the stand-in, when a test adds it, and the system tools.
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  delete process.env.NXIS_API;
  delete process.env.NXIS_MCP_URL;
  saveSettings({ activeOrg: ORG });
  process.chdir(project);
  requests.length = 0;
});

/**
 * Puts the environment back in place. Not `process.env = { … }`: that swaps in a plain object,
 * and `os.homedir()` would go on reading the real environment, HOME included.
 */
function restoreEnv(): void {
  for (const name of Object.keys(process.env)) if (!(name in savedEnv)) delete process.env[name];
  Object.assign(process.env, savedEnv);
}

afterEach(() => {
  process.chdir(savedCwd);
  restoreEnv();
  rmSync(home, { recursive: true, force: true });
});

/** A stand-in `claude` that logs each call; `mcp add` fails like the real one when an entry exists. */
function fakeClaude(): void {
  const marker = join(home, "claude-has-entry");
  writeFileSync(
    join(bin, "claude"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> '${claudeLog}'`,
      `if [ "$2" = "remove" ]; then [ -f '${marker}' ] && rm '${marker}' && exit 0; exit 1; fi`,
      `if [ "$2" = "add" ]; then`,
      `  if [ -f '${marker}' ]; then echo "MCP server nxis-onboarding already exists in local config" >&2; exit 1; fi`,
      `  touch '${marker}'; exit 0`,
      "fi",
      "exit 0",
    ].join("\n"),
  );
  chmodSync(join(bin, "claude"), 0o755);
}

/** An installed `nxis`: an executable script at a lasting path. */
function installedNxis(): string {
  const path = join(home, "lib", "node_modules", "@nxisai", "cli", "dist", "cli.js");
  const link = join(bin, "nxis");
  if (existsSync(link)) return link;
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/usr/bin/env node\n");
  chmodSync(path, 0o755);
  symlinkSync(path, link);
  return link;
}

/** Runs `nxis mcp install` in process, returning what it emitted. */
async function install(args: McpInstallArgs, ctx: Partial<Ctx> = {}): Promise<Record<string, unknown>> {
  let emitted: Record<string, unknown> = {};
  const io: Io = { json: true, note: () => undefined, emit: (payload) => (emitted = payload) };
  await cmdMcpInstall({ config: resolveConfig({ api: base }), io, ...ctx }, { self: { script: installedNxis() }, ...args });
  return emitted;
}

/** Every file under the temporary HOME, for scanning. */
function allFiles(dir = home): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) return [];
    return entry.isDirectory() ? allFiles(path) : [path];
  });
}

/** No key material in any file: no key header, no key prefix. */
function expectNoKeyMaterial(): void {
  for (const file of allFiles()) {
    const text = readFileSync(file, "utf8");
    expect(text, file).not.toContain("nxis-api-key");
    expect(text, file).not.toMatch(/nxis_(live|test|dev)_/);
  }
}

describe("mcp install (stdio, the default)", () => {
  it("writes the installed nxis into .mcp.json, with no key, and mints nothing", async () => {
    const out = await install({ agent: "mcp-json" });
    const doc = JSON.parse(readFileSync(join(project, ".mcp.json"), "utf8"));
    expect(doc).toEqual({
      mcpServers: { "nxis-onboarding": { command: join(bin, "nxis"), args: ["mcp", "serve"] } },
    });
    expect(out).toMatchObject({ ok: true, mode: "stdio", source: "installed", agent: "mcp-json", replaced: false, org_id: ORG });
    expect(requests).toEqual([]);
    expectNoKeyMaterial();
  });


  it("writes Cursor's config under HOME", async () => {
    await install({ agent: "cursor" });
    const doc = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"));
    expect(doc.mcpServers["nxis-onboarding"]).toEqual({ command: join(bin, "nxis"), args: ["mcp", "serve"] });
    expectNoKeyMaterial();
  });

  it("adds it to Claude Code at local scope, as a command", async () => {
    fakeClaude();
    const out = await install({ agent: "claude-code" });
    expect(readFileSync(claudeLog, "utf8").trim()).toBe(
      `mcp add --transport stdio --scope local nxis-onboarding -- ${join(bin, "nxis")} mcp serve`,
    );
    expect(out).toMatchObject({ agent: "claude-code", replaced: false });
    expect(requests).toEqual([]);
    expectNoKeyMaterial();
  });

  it("refuses to replace an existing Claude Code entry without --force, and replaces it with --force", async () => {
    fakeClaude();
    await install({ agent: "claude-code" });
    const refused = await install({ agent: "claude-code" }).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(CliError);
    expect((refused as CliError).reason).toBe("server_exists");

    const out = await install({ agent: "claude-code", force: true });
    expect(out).toMatchObject({ replaced: true });
    expect(readFileSync(claudeLog, "utf8")).toContain("mcp remove --scope local nxis-onboarding");
  });

  it("replaces a remote entry from an earlier install only with --force, keeping other servers", async () => {
    writeFileSync(
      join(project, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          other: { command: "other-server" },
          "nxis-onboarding": { url: `${base}/v1/organizations/${ORG}/mcp`, headers: { "nxis-api-key": MINTED } },
        },
      }),
    );
    const refused = await install({ agent: "mcp-json" }).catch((err: unknown) => err);
    expect((refused as CliError).reason).toBe("server_exists");

    const out = await install({ agent: "mcp-json", force: true });
    expect(out).toMatchObject({ replaced: true });
    const doc = JSON.parse(readFileSync(join(project, ".mcp.json"), "utf8"));
    expect(doc.mcpServers).toEqual({
      other: { command: "other-server" },
      "nxis-onboarding": { command: join(bin, "nxis"), args: ["mcp", "serve"] },
    });
    expectNoKeyMaterial();
  });

  it("carries --read-only and --allow-unconfirmed into the installed command only when given", async () => {
    const { parseArgs } = await import("../src/args.js");
    const { serveFlagsFrom } = await import("../src/commands/mcp.js");
    const flags = (argv: string[]) => serveFlagsFrom(parseArgs(argv).flags);
    expect(flags(["mcp", "install"])).toEqual([]);
    expect(flags(["mcp", "install", "--read-only", "--org", "o"])).toEqual(["--org", "o", "--read-only"]);
    // Boolean: neither swallows the word after it.
    expect(flags(["--allow-unconfirmed", "mcp", "install"])).toEqual(["--allow-unconfirmed"]);
    expect(parseArgs(["--read-only", "mcp", "serve"]).positional).toEqual(["mcp", "serve"]);
    await install({ agent: "mcp-json", serveFlags: flags(["mcp", "install", "--read-only"]) });
    const doc = JSON.parse(readFileSync(join(project, ".mcp.json"), "utf8"));
    expect(doc.mcpServers["nxis-onboarding"].args).toEqual(["mcp", "serve", "--read-only"]);
  });

  it("passes on --org, --site and --api only when they were given", async () => {
    await install({ agent: "mcp-json", serveFlags: ["--org", "org-b", "--site", "example.com"] });
    const doc = JSON.parse(readFileSync(join(project, ".mcp.json"), "utf8"));
    expect(doc.mcpServers["nxis-onboarding"].args).toEqual(["mcp", "serve", "--org", "org-b", "--site", "example.com"]);
  });

  it("prints the config with --print, and writes nothing", async () => {
    const out = await install({ print: true });
    expect(JSON.parse(out["config"] as string)).toEqual({
      mcpServers: { "nxis-onboarding": { command: join(bin, "nxis"), args: ["mcp", "serve"] } },
    });
    expect(existsSync(join(project, ".mcp.json"))).toBe(false);
    expect(requests).toEqual([]);
  });

  it("installs signed out, and says what is missing", async () => {
    delete process.env.NXIS_TOKEN;
    saveSettings({});
    const out = await install({ agent: "mcp-json" });
    expect(out["warnings"]).toEqual([expect.stringContaining("nxis login"), expect.stringContaining("nxis orgs use")]);
    expect(out["org_id"]).toBeNull();
  });

  it("refuses --stdio with --remote", async () => {
    const err = await install({ stdio: true, remote: true }).catch((e: unknown) => e);
    expect((err as CliError).reason).toBe("conflicting_flags");
  });
});

describe("mcp install --remote", () => {
  it("mints a key and writes the URL and key, as before", async () => {
    const out = await install({ agent: "mcp-json", remote: true });
    expect(requests).toEqual([`POST /v1/organizations/${ORG}/apikeys`]);
    const doc = JSON.parse(readFileSync(join(project, ".mcp.json"), "utf8"));
    expect(doc.mcpServers["nxis-onboarding"]).toEqual({
      url: `${base}/v1/organizations/${ORG}/mcp`,
      headers: { "nxis-api-key": MINTED },
    });
    expect(statSync(join(project, ".mcp.json")).mode & 0o777).toBe(0o600);
    expect(out).toMatchObject({ mode: "remote", key_preview: "…key" });
    expect(JSON.stringify(out)).not.toContain(MINTED);
  });

});

describe("mcp install keeps a project .mcp.json out of git", () => {
  const GITIGNORE_LINES = "# MCP server config: it can hold credentials, so it is never committed.\n.mcp.json\n";
  const gitignore = () => join(project, ".gitignore");
  /** @returns True when git ignores the project's .mcp.json. */
  const ignored = () => {
    try {
      execFileSync("git", ["-C", project, "check-ignore", "-q", ".mcp.json"], { stdio: "ignore", timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  };
  const track = () => {
    writeFileSync(join(project, ".mcp.json"), "{}\n");
    execFileSync("git", ["-C", project, "add", ".mcp.json"], { timeout: 10_000 });
  };

  beforeEach(() => {
    execFileSync("git", ["init", "-q", project], { timeout: 10_000 });
  });
  afterEach(() => setTrace({ dryRun: false }));

  it("not ignored: adds it to a new .gitignore, with a comment, and says so", async () => {
    const out = await install({ agent: "mcp-json" });
    expect(out["gitignored"]).toBe("added");
    expect(readFileSync(gitignore(), "utf8")).toBe(GITIGNORE_LINES);
    expect(ignored()).toBe(true);
    expect(existsSync(join(project, ".mcp.json"))).toBe(true);
  }, 20_000);

  it("not ignored: appends it on its own line to an existing .gitignore", async () => {
    writeFileSync(gitignore(), "node_modules");
    const out = await install({ agent: "mcp-json", remote: true });
    expect(out["gitignored"]).toBe("added");
    expect(readFileSync(gitignore(), "utf8")).toBe(`node_modules\n\n${GITIGNORE_LINES}`);
    expect(ignored()).toBe(true);
    // With --remote the key goes in, now that git ignores the file.
    expect(readFileSync(join(project, ".mcp.json"), "utf8")).toContain(MINTED);
  }, 20_000);

  it("already ignored: changes nothing else", async () => {
    writeFileSync(gitignore(), "*.json\n");
    const out = await install({ agent: "mcp-json", remote: true });
    expect(out["gitignored"]).toBe("already");
    expect(readFileSync(gitignore(), "utf8")).toBe("*.json\n");
    expect(existsSync(join(project, ".mcp.json"))).toBe(true);
  }, 20_000);

  it("tracked, with --remote: refuses before minting, and says to untrack it and rotate the key", async () => {
    track();
    const err = await install({ agent: "mcp-json", remote: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).reason).toBe("mcp_json_tracked");
    expect((err as CliError).exitCode).toBe(2);
    expect((err as CliError).message).toContain("git rm --cached .mcp.json");
    expect((err as CliError).message).toContain("rotate");
    expect(requests).toEqual([]);
    expect(readFileSync(join(project, ".mcp.json"), "utf8")).toBe("{}\n");
    expect(existsSync(gitignore())).toBe(false);
  }, 20_000);

  it("tracked, with stdio: writes it, ignores it from now on, and warns with the same advice", async () => {
    track();
    const out = await install({ agent: "mcp-json" });
    expect(out["gitignored"]).toBe("added");
    expect(out["warnings"]).toEqual([expect.stringMatching(/tracked by git.*git rm --cached \.mcp\.json.*rotate/)]);
    expect(JSON.parse(readFileSync(join(project, ".mcp.json"), "utf8")).mcpServers["nxis-onboarding"]).toBeDefined();
    expectNoKeyMaterial();
  }, 20_000);

  it("no work tree, or no git: skips it silently", async () => {
    rmSync(join(project, ".git"), { recursive: true, force: true });
    const out = await install({ agent: "mcp-json" });
    expect(out["gitignored"]).toBeNull();
    expect(out["warnings"]).toBeUndefined();
    expect(existsSync(gitignore())).toBe(false);

    // A work tree, but no git on PATH.
    execFileSync("git", ["init", "-q", project], { timeout: 10_000 });
    process.env.PATH = bin;
    const again = await install({ agent: "mcp-json", force: true });
    expect(again["gitignored"]).toBeNull();
    expect(existsSync(gitignore())).toBe(false);
  }, 20_000);

  it("--dry-run: says what would happen to .gitignore, and writes nothing", async () => {
    setTrace({ dryRun: true });
    const out = await install({ agent: "mcp-json" });
    expect(out).toMatchObject({ dry_run: true, gitignored: "would_add", location: join(project, ".mcp.json") });
    expect(existsSync(gitignore())).toBe(false);
    expect(existsSync(join(project, ".mcp.json"))).toBe(false);

    // --remote stops at the mint, and reports the same.
    const err = await install({ agent: "mcp-json", remote: true }).catch((e: unknown) => e);
    expect((err as CliError).reason).toBe("dry_run");
    expect((err as CliError).details).toMatchObject({ gitignored: "would_add", location: join(project, ".mcp.json") });
    expect(requests).toEqual([]);
    expect(existsSync(gitignore())).toBe(false);
  }, 20_000);
});

describe("localServerEntry", () => {
  it("uses the installed nxis, by the path it was run as", () => {
    const link = installedNxis();
    expect(localServerEntry([], { script: link, npmCache: undefined })).toEqual({
      command: link,
      args: ["mcp", "serve"],
      source: "installed",
    });
  });

  it("uses a standalone install's launcher, which outlasts the versioned bundle", () => {
    const launcher = join(home, ".local", "bin", "nxis-launcher-test");
    mkdirSync(join(launcher, ".."), { recursive: true });
    writeFileSync(launcher, "#!/bin/sh\n");
    chmodSync(launcher, 0o755);
    const bundle = join(home, ".nxis", "current", "app", "dist", "nxis.mjs");
    expect(localServerEntry(["--read-only"], { script: bundle, launcher, npmCache: undefined })).toEqual({
      command: launcher,
      args: ["mcp", "serve", "--read-only"],
      source: "installed",
    });
    // A launcher that isn't there, or isn't absolute, is ignored.
    expect(localServerEntry([], { script: undefined, launcher: join(home, "missing"), version: "1.0.0" }).source).toBe("npx");
    expect(localServerEntry([], { script: undefined, launcher: "nxis", version: "1.0.0" }).source).toBe("npx");
  });

  it("falls back to npx for a copy in npx's cache", () => {
    const cached = join(home, ".npm", "_npx", "abc123", "node_modules", ".bin", "nxis");
    mkdirSync(join(cached, ".."), { recursive: true });
    writeFileSync(cached, "#!/usr/bin/env node\n");
    chmodSync(cached, 0o755);
    expect(localServerEntry([], { script: cached, npmCache: undefined, version: "1.4.2" })).toEqual({
      command: "npx",
      args: ["-y", "@nxisai/cli@1.4.2", "mcp", "serve"],
      source: "npx",
    });
  });

  it("falls back to npx when a lasting-looking path links into a cache", () => {
    const cached = join(home, ".npm", "_npx", "abc123", "cli.js");
    mkdirSync(join(cached, ".."), { recursive: true });
    writeFileSync(cached, "#!/usr/bin/env node\n");
    const link = join(bin, "nxis-linked");
    symlinkSync(cached, link);
    expect(localServerEntry([], { script: link, npmCache: undefined }).source).toBe("npx");
  });

  it("falls back to npx with nothing to go on", () => {
    expect(localServerEntry(["--org", "o"], { script: undefined, npmCache: undefined, version: "1.4.2" })).toEqual({
      command: "npx",
      args: ["-y", "@nxisai/cli@1.4.2", "mcp", "serve", "--org", "o"],
      source: "npx",
    });
  });

  it("pins the npx fallback to this CLI's own version by default", () => {
    const { args } = localServerEntry([], { script: undefined, npmCache: undefined });
    expect(args[1]).toBe(`@nxisai/cli@${packageVersion()}`);
  });

  it("leaves the npx fallback unpinned when the version cannot be read", () => {
    expect(localServerEntry([], { script: undefined, npmCache: undefined, version: "0.0.0" }).args).toEqual([
      "-y",
      "@nxisai/cli",
      "mcp",
      "serve",
    ]);
  });

  it("runs a script that is not executable with node", () => {
    const script = join(home, "checkout", "dist", "cli.js");
    mkdirSync(join(script, ".."), { recursive: true });
    writeFileSync(script, "");
    chmodSync(script, 0o644);
    expect(localServerEntry([], { script, execPath: "/opt/node/bin/node", npmCache: undefined })).toEqual({
      command: "/opt/node/bin/node",
      args: [script, "mcp", "serve"],
      source: "installed",
    });
  });

  it("runs node, or cmd for npx, on Windows", () => {
    const link = installedNxis();
    const real = realpathSync(link);
    expect(localServerEntry([], { script: link, execPath: "node.exe", platform: "win32", npmCache: undefined })).toEqual({
      command: "node.exe",
      args: [real, "mcp", "serve"],
      source: "installed",
    });
    expect(localServerEntry([], { script: undefined, platform: "win32", npmCache: undefined }).command).toBe("cmd");
  });

  it("tells a package runner's cache from an installation", () => {
    expect(isEphemeralPath("/home/u/.npm/_npx/1a2b/node_modules/.bin/nxis")).toBe(true);
    expect(isEphemeralPath("C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\1a2b\\node_modules\\@nxisai\\cli\\dist\\cli.js")).toBe(true);
    expect(isEphemeralPath("/tmp/dlx-12345/node_modules/.bin/nxis")).toBe(true);
    expect(isEphemeralPath("/tmp/bunx-501-@nxisai/cli/node_modules/.bin/nxis")).toBe(true);
    expect(isEphemeralPath("/custom/cache/x/nxis", "/custom/cache")).toBe(true);
    expect(isEphemeralPath("/usr/local/lib/node_modules/@nxisai/cli/dist/cli.js")).toBe(false);
    expect(isEphemeralPath("/home/u/project/node_modules/.bin/nxis")).toBe(false);
  });

  it("puts nxis's own flags after `--` for Claude Code", () => {
    expect(claudeAddStdioArgs({ command: "/bin/nxis", args: ["mcp", "serve", "--org", "o"] })).toEqual([
      "mcp", "add", "--transport", "stdio", "--scope", "local", "nxis-onboarding", "--", "/bin/nxis", "mcp", "serve", "--org", "o",
    ]);
  });
});
