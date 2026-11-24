/**
 * `nxis connections create|rotate --write-env <file>`, and `write_env` on the matching tools of
 * `nxis mcp serve`: the signing secret goes into an env file git ignores (or one outside a
 * repository), readable by its owner only, and into no output.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/args.js";
import { runConnections } from "../src/commands/connections.js";
import { createServeServer, ProvisioningConnection } from "../src/commands/mcp-serve.js";
import { checkEnvTarget, setEnvLine } from "../src/env-file.js";
import { CliError, ExitCode } from "../src/errors.js";
import { setTrace } from "../src/trace.js";
import { capture, cleanFake, fake, ORG, resetFake, startFake, stopFake, type AuthSeen } from "./support/fake-endpoints.js";

const SITE = "site-1";
const BASE = `/v1/organizations/${ORG}/sites/${SITE}/connections`;
const QUOTE_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";

let secrets: string[];
let current: string;
let created: Array<{ id: string; name: string; url: string }>;

function newSecret(): string {
  current = `whsec_fake_${secrets.length + 1}_${"y".repeat(24)}`; // gitleaks:allow
  secrets.push(current);
  return current;
}

function wire(c: { id: string; name: string; url: string }, secret: string): Record<string, unknown> {
  return {
    id: c.id,
    name: c.name,
    url: c.url,
    method: "POST",
    encoding: "JSON",
    secret_preview: secret.slice(0, 8),
    used_by: { agents: c.id === QUOTE_ID ? ["quote"] : [], action_types: [] },
  };
}

function service(req: AuthSeen): { status: number; body?: unknown } {
  const path = req.url.split("?")[0] ?? "";
  const body = (req.body ?? {}) as Record<string, unknown>;
  const quote = { id: QUOTE_ID, name: "Quotes API", url: "https://api.example.com/quotes" };
  if (path === BASE && req.method === "GET") return { status: 200, body: { connections: [quote, ...created].map((c) => wire(c, current)) } };
  if (path === BASE && req.method === "POST") {
    const c = { id: "c".repeat(24), name: String(body["name"]), url: String(body["url"]) };
    created.push(c);
    const s = newSecret();
    return { status: 200, body: { connection: wire(c, s), signing_secret: s } };
  }
  if (path === `${BASE}/${QUOTE_ID}:rotateSecret` && req.method === "POST") {
    const s = newSecret();
    return { status: 200, body: { connection: wire(quote, s), signing_secret: s } };
  }
  return { status: 404 };
}

let stderrText: string;
let work: string;

function git(dir: string, ...args: string[]): void {
  const r = spawnSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

/** A repository with `.env.local` ignored and `.env` tracked. */
function repo(): string {
  const dir = join(work, "repo");
  mkdirSync(dir);
  git(dir, "init", "-q");
  writeFileSync(join(dir, ".gitignore"), ".env.local\n");
  writeFileSync(join(dir, ".env"), "PUBLIC=1\n");
  writeFileSync(join(dir, ".env.example"), "NXIS_ACTION_SECRET=\n");
  git(dir, "add", ".env", ".gitignore");
  return dir;
}

async function connections(argv: string[]) {
  const { positional, flags } = parseArgs(argv);
  const { ctx, out } = capture();
  await runConnections(ctx, positional, flags);
  return out;
}

async function caught(fn: () => Promise<unknown>): Promise<CliError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(CliError);
    return err as CliError;
  }
  throw new Error("expected a failure");
}

function expectNoSecret(text: string): void {
  for (const s of secrets) expect(text).not.toContain(s);
}

const mode = (path: string) => statSync(path).mode & 0o777;

beforeAll(startFake);
afterAll(stopFake);
beforeEach(() => {
  resetFake();
  process.env.NXIS_TOKEN = "header.payload.sig";
  secrets = [];
  current = "whsec_initial_zzzzzzzzzzzzzzzzzzzz"; // gitleaks:allow
  created = [];
  fake.sites = service;
  work = mkdtempSync(join(tmpdir(), "nxis-env-"));
  stderrText = "";
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderrText += String(chunk);
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanFake();
  rmSync(work, { recursive: true, force: true });
});

describe("setEnvLine", () => {
  it("replaces the variable's line, keeping every other line and the trailing newline", () => {
    const text = "# app\nA=1\nNXIS_ACTION_SECRET=old\n\nB=\"two words\"\n";
    expect(setEnvLine(text, "NXIS_ACTION_SECRET", "new_1")).toBe("# app\nA=1\nNXIS_ACTION_SECRET=new_1\n\nB=\"two words\"\n");
  });

  it("appends when absent, adding a newline to a file without one", () => {
    expect(setEnvLine("A=1", "S", "v")).toBe("A=1\nS=v\n");
    expect(setEnvLine("", "S", "v")).toBe("S=v\n");
  });

  it("keeps `export`, CRLF line endings, and drops a later duplicate that would win", () => {
    expect(setEnvLine("export S=old\r\nA=1\r\nS=older\r\n", "S", "v")).toBe("export S=v\r\nA=1\r\n");
  });

  it("doesn't touch a variable whose name only starts the same", () => {
    expect(setEnvLine("S_OLD=1\n", "S", "v")).toBe("S_OLD=1\nS=v\n");
  });

  it("quotes a value that isn't plain", () => {
    expect(setEnvLine("", "S", 'a b"$')).toBe('S="a b\\"\\$"\n');
  });
});

describe("checkEnvTarget", () => {
  it("allows an ignored file and a file outside any repository, saying which", () => {
    const dir = repo();
    expect(checkEnvTarget(".env.local", undefined, dir)).toEqual({ path: join(dir, ".env.local"), name: "NXIS_ACTION_SECRET", git: "ignored" });
    mkdirSync(join(work, "plain"));
    expect(checkEnvTarget("plain/.env", "MY_SECRET", work)).toMatchObject({ name: "MY_SECRET", git: "not_a_repository" });
  });

  it("refuses a tracked file, an unignored one, a missing directory and a bad variable name", () => {
    const dir = repo();
    const reason = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return (e as CliError).reason;
      }
      return "ok";
    };
    expect(reason(() => checkEnvTarget(".env", undefined, dir))).toBe("env_file_tracked");
    expect(reason(() => checkEnvTarget(".env.example", undefined, dir))).toBe("env_file_not_ignored");
    expect(reason(() => checkEnvTarget("nope/.env", undefined, work))).toBe("env_dir_missing");
    expect(reason(() => checkEnvTarget(".env.local", "1BAD", dir))).toBe("invalid_input");
    expect(reason(() => checkEnvTarget(".env.local", "A=B", dir))).toBe("invalid_input");
    expect(reason(() => checkEnvTarget(dir, undefined, work))).toBe("env_file_not_regular");
  });
});

describe("connections create --write-env", () => {
  it("writes the secret into an ignored file (mode 600, other lines kept, the variable replaced), and shows it nowhere", async () => {
    setTrace({ verbose: true });
    const dir = repo();
    const file = join(dir, ".env.local");
    writeFileSync(file, "# local\nDATABASE_URL=postgres://x\nNXIS_ACTION_SECRET=stale\nOTHER=1\n", { mode: 0o644 });
    const out = await connections(["create", "--name", "Bookings", "--url", "https://book.example.com/hook", "--write-env", file]);
    const secret = secrets[secrets.length - 1]!;
    expect(readFileSync(file, "utf8")).toBe(`# local\nDATABASE_URL=postgres://x\nNXIS_ACTION_SECRET=${secret}\nOTHER=1\n`);
    expect(mode(file)).toBe(0o600);
    expect(out.json).toMatchObject({
      ok: true,
      written_to: file,
      env_name: "NXIS_ACTION_SECRET",
      secret_preview: secret.slice(0, 8),
      git: "ignored",
      connection: { name: "Bookings" },
    });
    expect(out.json).not.toHaveProperty("signing_secret");
    expect(out.text).toContain(`Wrote the signing secret to ${file} as NXIS_ACTION_SECRET`);
    expectNoSecret(JSON.stringify(out.json));
    expectNoSecret(out.text);
    expectNoSecret(out.notes.join(""));
    expectNoSecret(stderrText);
  });

  it("creates a new file with mode 600 outside a repository, under --env-name", async () => {
    const file = join(work, "secrets.env");
    const out = await connections(["create", "--name", "B", "--url", "https://b.example.com", "--write-env", file, "--env-name", "BOOKING_SECRET"]);
    expect(readFileSync(file, "utf8")).toBe(`BOOKING_SECRET=${secrets[0]}\n`);
    expect(mode(file)).toBe(0o600);
    expect(out.json).toMatchObject({ env_name: "BOOKING_SECRET", git: "not_a_repository" });
    expectNoSecret(out.text);
  });

  it("refuses a tracked or unignored file before anything is created", async () => {
    const dir = repo();
    for (const [name, reason] of [
      [".env", "env_file_tracked"],
      [".env.example", "env_file_not_ignored"],
    ] as const) {
      const err = await caught(() => connections(["create", "--name", "B", "--url", "https://b.example.com", "--write-env", join(dir, name)]));
      expect(err.reason).toBe(reason);
      expect(err.exitCode).toBe(ExitCode.ERROR);
    }
    expect(fake.sitesCalls).toEqual([]);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("PUBLIC=1\n");
  });

  it("refuses --write-env without a file, and --env-name alone", async () => {
    expect((await caught(() => connections(["create", "--name", "B", "--url", "https://b.example.com", "--write-env"]))).reason).toBe("missing_value");
    expect((await caught(() => connections(["create", "--name", "B", "--url", "https://b.example.com", "--env-name", "X"]))).reason).toBe("invalid_input");
    expect(fake.sitesCalls).toEqual([]);
  });

  it("when the file can't be written after creating, says so without the secret", async () => {
    // A file that can't be created: its directory is read-only.
    const dir = join(work, "ro");
    mkdirSync(dir);
    const locked = join(dir, ".env");
    spawnSync("chmod", ["500", dir]);
    try {
      if (process.getuid?.() === 0) return; // root writes anyway
      const err = await caught(() => connections(["create", "--name", "B", "--url", "https://b.example.com", "--write-env", locked]));
      expect(err.reason).toBe("env_write_failed");
      expect(err.message).toContain('Created the connection "B"');
      expect(err.message).toContain("nxis connections rotate");
      expectNoSecret(err.message);
      expectNoSecret(JSON.stringify(err.toJSON()));
    } finally {
      spawnSync("chmod", ["700", dir]);
    }
  });
});

describe("connections rotate --write-env", () => {
  it("writes the new secret, and a refused file asks and rotates nothing", async () => {
    const dir = repo();
    const err = await caught(() => connections(["rotate", "Quotes API", "--write-env", join(dir, ".env")]));
    expect(err.reason).toBe("env_file_tracked");
    expect(fake.sitesCalls).toEqual([]);

    const file = join(dir, ".env.local");
    const out = await connections(["rotate", "Quotes API", "--yes", "--write-env", file]);
    const secret = secrets[secrets.length - 1]!;
    expect(readFileSync(file, "utf8")).toBe(`NXIS_ACTION_SECRET=${secret}\n`);
    expect(mode(file)).toBe(0o600);
    expect(out.json).toMatchObject({ written_to: file, env_name: "NXIS_ACTION_SECRET", secret_preview: secret.slice(0, 8) });
    expect(String(out.json["next"])).toContain("The previous secret no longer works.");
    expect(out.json).not.toHaveProperty("signing_secret");
    expectNoSecret(out.text);
    expectNoSecret(stderrText);
  });
});

describe("mcp serve: write_env", () => {
  async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const { ctx } = capture({ io: { json: false, note: () => undefined, emit: () => undefined } });
    const connection = new ProvisioningConnection(ctx);
    const server = createServeServer(ctx, connection, {});
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: { elicitation: {} } });
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { confirm: true } }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      return (await client.callTool({ name, arguments: args })) as CallToolResult;
    } finally {
      await client.close();
      await server.close();
      await connection.drop();
    }
  }

  it("create and rotate write the secret into the file, and the result never carries it", async () => {
    const dir = repo();
    const file = join(dir, ".env.local");
    const made = await call("nxis_create_connection", { name: "Bookings", url: "https://book.example.com/hook", write_env: file, env_name: "BOOK_SECRET" });
    expect(made.isError).toBeFalsy();
    expect(made.structuredContent).toMatchObject({ written_to: file, env_name: "BOOK_SECRET", git: "ignored" });
    expect(readFileSync(file, "utf8")).toBe(`BOOK_SECRET=${secrets[0]}\n`);

    const rotated = await call("nxis_rotate_connection_secret", { connection: "Quotes API", write_env: file });
    expect(rotated.isError).toBeFalsy();
    expect(readFileSync(file, "utf8")).toBe(`BOOK_SECRET=${secrets[0]}\nNXIS_ACTION_SECRET=${secrets[1]}\n`);
    expectNoSecret(JSON.stringify(made));
    expectNoSecret(JSON.stringify(rotated));
    expectNoSecret(stderrText);
  });

  it("a tracked file is refused, and nothing is created", async () => {
    const dir = repo();
    const result = await call("nxis_create_connection", { name: "B", url: "https://b.example.com", write_env: join(dir, ".env") });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("env_file_tracked");
    expect(fake.sitesCalls.filter((c) => c.method === "POST")).toEqual([]);
  });
});
