/**
 * `nxis mcp serve`, run as an agent runs it: the built CLI as a subprocess, spoken to over stdio
 * by the SDK's own client.
 *
 * The CLI is compiled for this test into a directory of its own, so it always runs the current
 * source. It talks to an in-process fake with three endpoints: the organization's provisioning
 * endpoint, which wants a key; the API-key endpoint, which mints one; and a site's own public
 * endpoint, which wants none. The server's stdout is copied to a file on the way to the client,
 * and every line of it has to be a JSON-RPC message.
 */

import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { endpointKey, resolveConfig } from "../src/config.js";
import { saveCredentials, saveProvisioningKey } from "../src/credentials.js";
import { saveSettings } from "../src/state.js";
import { annotationsOf, TOOLS } from "../src/tools/index.js";

const ORG = "org-test";
const KEY = "nxis_dev_mcp_fake_stored_key"; // gitleaks:allow
const root = fileURLToPath(new URL("..", import.meta.url));
const tee = fileURLToPath(new URL("./support/tee-stdout.mjs", import.meta.url));
const buildDir = join(root, "node_modules", ".cache", "nxis-serve-test");
const cli = join(buildDir, "dist", "cli.js");

interface Seen {
  endpoint: "provisioning" | "site";
  method: string;
  tool?: string;
  args?: Record<string, unknown>;
  key?: string | undefined;
}

const fake = { seen: [] as Seen[], valid: new Set<string>(), mints: 0 };
let base: string;
let http: Server;
let dir: string;

/** A JWT with an account claim, unsigned: the fake never checks it. Fake test value only. */
function fakeToken(ttlSeconds?: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const exp = ttlSeconds ? { exp: Math.floor(Date.now() / 1000) + ttlSeconds } : {};
  return `${b64({ alg: "none" })}.${b64({ ...exp, "https://nxis.ai/user_data": { account: { _id: { value: "acct-1" } } } })}.x`;
}

function sites() {
  return {
    organization: ORG,
    count: 1,
    truncated: false,
    sites: [
      {
        site: "site-1",
        domain: "example.com",
        host: "example.com",
        is_verified: true,
        active: true,
        mcp: { endpoint: `${base}/site/mcp`, enabled: true, is_public: true, listed_in_app: false },
      },
    ],
  };
}

function mcpServer(endpoint: Seen["endpoint"], key: string | undefined): McpServer {
  const server = new McpServer({ name: "fake", version: "0.0.0" });
  for (const tool of TOOLS.filter((t) => t.surface === endpoint)) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input }, async (args) => {
      fake.seen.push({ endpoint, method: "tools/call", tool: tool.name, args: args as Record<string, unknown>, key });
      const payload = tool.name === "nxis_list_sites" ? sites() : { tool: tool.name, args };
      return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
    });
  }
  return server;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? "";
  if (req.method === "POST" && url === `/v1/organizations/${ORG}/apikeys`) {
    await readBody(req);
    fake.mints++;
    const raw = `nxis_dev_mcp_fake_minted_${fake.mints}`; // gitleaks:allow
    fake.valid.add(raw);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ raw_key: raw, key_id: `key-${fake.mints}`, preview: `…${fake.mints}` }));
    return;
  }
  const endpoint: Seen["endpoint"] | null =
    url === `/v1/organizations/${ORG}/mcp` ? "provisioning" : url === "/site/mcp" ? "site" : null;
  if (!endpoint || req.method !== "POST") {
    res.writeHead(endpoint ? 405 : 404).end();
    return;
  }
  const key = req.headers["nxis-api-key"] as string | undefined;
  if (endpoint === "provisioning" && (!key || !fake.valid.has(key))) {
    res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid api key" }));
    return;
  }
  const body = (await readBody(req)) as { method?: string } | undefined;
  if (body?.method && body.method !== "tools/call") fake.seen.push({ endpoint, method: body.method, key });
  const server = mcpServer(endpoint, key);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

beforeAll(async () => {
  // Compile the current source, so the test never runs a stale dist/. Inside node_modules so the
  // compiled CLI finds its dependencies; the package.json makes its .js files ES modules.
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });
  writeFileSync(join(buildDir, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
  execFileSync(
    process.execPath,
    [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", join(root, "tsconfig.json"), "--outDir", join(buildDir, "dist"), "--declaration", "false", "--declarationMap", "false", "--sourceMap", "false"],
    { stdio: "inherit" },
  );

  http = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => res.writeHead(500).end(String(err)));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()));
  rmSync(buildDir, { recursive: true, force: true });
});

const savedEnv = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nxis-serve-"));
  // The key and settings are written through the CLI's own modules, into the same files the
  // subprocess reads.
  process.env.XDG_CONFIG_HOME = dir;
  process.env.NXIS_NO_KEYCHAIN = "1";
  delete process.env.NXIS_API;
  delete process.env.NXIS_MCP_URL;
  fake.seen = [];
  fake.valid = new Set([KEY]);
  fake.mints = 0;
  // Saved, as `--api` would save it, so the server prints its "Using …" notice: on stderr.
  saveSettings({ api: base, activeOrg: ORG });
  saveProvisioningKey({
    apiKey: KEY,
    keyId: "key-0",
    preview: "…key",
    orgId: ORG,
    endpoints: endpointKey(resolveConfig({ api: base }).endpoints),
    env: "dev",
    createdAt: 0,
  });
});

afterEach(() => {
  // In place, rather than `process.env = { … }`, which would detach it from the real environment.
  for (const name of Object.keys(process.env)) if (!(name in savedEnv)) delete process.env[name];
  Object.assign(process.env, savedEnv);
  rmSync(dir, { recursive: true, force: true });
});

interface Running {
  client: Client;
  stdout: () => string;
  stderr: () => string;
  close: () => Promise<void>;
}

/** Starts `nxis mcp serve` and connects the SDK client to it. */
async function serve(opts: { args?: string[]; env?: Record<string, string> } = {}): Promise<Running> {
  const out = join(dir, "stdout.raw");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tee, out, cli, "mcp", "serve", "--verbose", ...(opts.args ?? [])],
    env: {
      HOME: dir,
      XDG_CONFIG_HOME: dir,
      NXIS_NO_KEYCHAIN: "1",
      NXIS_NO_BROWSER: "1",
      NO_COLOR: "1",
      ...opts.env,
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  return {
    client,
    stdout: () => readFileSync(out, "utf8"),
    stderr: () => stderr,
    close: async () => {
      await client.close();
      // Wait for the server to exit, and the copy of its stdout to be flushed.
      for (let i = 0; i < 100 && transport.pid !== null; i++) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 100));
    },
  };
}

/** @returns The JSON object in a tool result's text. */
function body(result: CallToolResult): Record<string, unknown> {
  const text = result.content.find((part) => part.type === "text");
  return JSON.parse((text as { text: string }).text) as Record<string, unknown>;
}

/** Every line on stdout must be one JSON-RPC 2.0 message. */
function expectOnlyFrames(stdout: string): void {
  const lines = stdout.split("\n");
  expect(lines.pop()).toBe("");
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    let parsed: unknown;
    expect(() => {
      parsed = JSON.parse(line);
    }, `not JSON on stdout: ${line.slice(0, 120)}`).not.toThrow();
    expect((parsed as { jsonrpc?: unknown }).jsonrpc).toBe("2.0");
  }
}

describe("nxis mcp serve", () => {
  it("lists all 21 tools with the server's names and schemas, and their annotations", async () => {
    const s = await serve();
    try {
      expect(s.client.getServerVersion()?.name).toBe("nxis-onboarding");
      expect(s.client.getInstructions()).toMatch(/nxis_create_site[\s\S]*nxis_verify_site[\s\S]*nxis_bulk_autofill/);
      expect(s.client.getInstructions()).toContain("PAUSED");

      const { tools } = await s.client.listTools();
      expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
      expect(tools).toHaveLength(21);
      for (const tool of tools) {
        const def = TOOLS.find((t) => t.name === tool.name)!;
        expect(tool.description).toBe(def.description);
        expect(tool.annotations?.readOnlyHint).toBe(def.readOnly === true);
        expect(tool.annotations).toEqual(annotationsOf(def));
        expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(Object.keys(def.input.shape).sort());
      }
    } finally {
      await s.close();
    }
    expectOnlyFrames(s.stdout());
  });

  it("runs a read and a write on one provisioning connection, with the stored key", async () => {
    const s = await serve();
    try {
      const read = (await s.client.callTool({ name: "nxis_list_sites", arguments: {} })) as CallToolResult;
      expect(read.isError).toBeFalsy();
      expect(read.structuredContent).toMatchObject({ organization: ORG, count: 1 });

      const write = (await s.client.callTool({
        name: "nxis_create_site",
        arguments: { url: "https://example.com" },
      })) as CallToolResult;
      expect(write.isError).toBeFalsy();
      expect(body(write)).toEqual({ tool: "nxis_create_site", args: { url: "https://example.com" } });

      // A domain as `site` is turned into the id, as on the command line.
      const named = (await s.client.callTool({
        name: "nxis_set_site_name",
        arguments: { site: "example.com", display_name: "Example" },
      })) as CallToolResult;
      expect(named.isError).toBeFalsy();
    } finally {
      await s.close();
    }

    const calls = fake.seen.filter((c) => c.method === "tools/call");
    expect(calls.map((c) => c.tool)).toEqual([
      "nxis_list_sites",
      "nxis_create_site",
      "nxis_list_sites",
      "nxis_set_site_name",
    ]);
    expect(calls.every((c) => c.endpoint === "provisioning" && c.key === KEY)).toBe(true);
    expect(calls[3]?.args).toEqual({ site: "site-1", display_name: "Example" });
    // One connection for all four calls.
    expect(fake.seen.filter((c) => c.method === "initialize")).toHaveLength(1);
    expect(fake.mints).toBe(0);

    expectOnlyFrames(s.stdout());
    // --verbose traces went to stderr, with the key removed, as did the saved-environment notice.
    expect(s.stderr()).toContain("tools/call");
    expect(s.stderr()).toContain("saved by an earlier --api");
    expect(s.stderr()).not.toContain(KEY);
  });

  it("reads a site's own endpoint for nxis_list_types, with no key, and takes --site as the default", async () => {
    const s = await serve({ args: ["--site", "example.com"] });
    try {
      const result = (await s.client.callTool({ name: "nxis_list_types", arguments: {} })) as CallToolResult;
      expect(result.isError).toBeFalsy();
      expect(body(result)).toEqual({ tool: "nxis_list_types", args: {} });
    } finally {
      await s.close();
    }
    const site = fake.seen.filter((c) => c.endpoint === "site" && c.method === "tools/call");
    expect(site).toEqual([{ endpoint: "site", method: "tools/call", tool: "nxis_list_types", args: {}, key: undefined }]);
    expectOnlyFrames(s.stdout());
  });

  it("returns a failure as isError with the CLI's error JSON, and keeps serving", async () => {
    const s = await serve();
    try {
      // No --site and no saved site.
      const failed = (await s.client.callTool({ name: "nxis_verify_site", arguments: { mode: "token" } })) as CallToolResult;
      expect(failed.isError).toBe(true);
      expect(body(failed)).toMatchObject({ ok: false, reason: "no_active_site", error: expect.stringContaining("No site selected") });
      expect(body(failed)["hint"]).toContain("site");

      // An argument the schema refuses never reaches the endpoint.
      const invalid = (await s.client.callTool({
        name: "nxis_crawl_sitemap",
        arguments: { site: "site-1", mode: "nope" },
      })) as CallToolResult;
      expect(invalid.isError).toBe(true);

      // Still serving.
      const after = (await s.client.callTool({ name: "nxis_list_sites", arguments: {} })) as CallToolResult;
      expect(after.isError).toBeFalsy();
    } finally {
      await s.close();
    }
    expect(fake.seen.filter((c) => c.tool === "nxis_crawl_sitemap" || c.tool === "nxis_verify_site")).toEqual([]);
    expectOnlyFrames(s.stdout());
  });

  it("withholds a write under --dry-run without calling it a failure", async () => {
    const s = await serve({ args: ["--dry-run"] });
    try {
      const result = (await s.client.callTool({
        name: "nxis_create_site",
        arguments: { url: "https://example.com" },
      })) as CallToolResult;
      expect(result.isError).toBeFalsy();
      expect(body(result)).toMatchObject({ ok: true, dry_run: true, tool: "nxis_create_site" });
    } finally {
      await s.close();
    }
    expect(fake.seen.filter((c) => c.method === "tools/call")).toEqual([]);
    expectOnlyFrames(s.stdout());
  });

  it("refuses writes under --read-only, and a risky call when the client can't ask", async () => {
    const ro = await serve({ args: ["--read-only", "--site", "example.com"] });
    try {
      const read = (await ro.client.callTool({ name: "nxis_list_sites", arguments: {} })) as CallToolResult;
      expect(read.isError).toBeFalsy();
      const write = (await ro.client.callTool({ name: "nxis_create_site", arguments: { url: "https://example.com" } })) as CallToolResult;
      expect(write.isError).toBe(true);
      expect(body(write)).toMatchObject({ ok: false, reason: "read_only_server" });
    } finally {
      await ro.close();
    }
    expect(ro.stderr()).toContain("read-only");

    // This test's client declares no elicitation, so nobody can be asked.
    const s = await serve({ args: ["--site", "example.com"] });
    try {
      const submit = (await s.client.callTool({ name: "nxis_bulk_autofill", arguments: { mode: "submit" } })) as CallToolResult;
      expect(submit.isError).toBe(true);
      expect(body(submit)).toMatchObject({ ok: false, reason: "confirmation_unavailable", terminal_command: "nxis autofill submit" });
    } finally {
      await s.close();
    }
    const calls = fake.seen.filter((c) => c.method === "tools/call").map((c) => [c.tool, c.args?.["mode"]]);
    expect(calls).not.toContainEqual(["nxis_create_site", undefined]);
    expect(calls).not.toContainEqual(["nxis_bulk_autofill", "submit"]);
    expectOnlyFrames(s.stdout());
  });

  it("replaces a revoked key using the signed-in session", async () => {
    fake.valid = new Set();
    const s = await serve({ env: { NXIS_TOKEN: fakeToken() } });
    try {
      const result = (await s.client.callTool({ name: "nxis_list_sites", arguments: {} })) as CallToolResult;
      expect(result.isError).toBeFalsy();
    } finally {
      await s.close();
    }
    expect(fake.mints).toBe(1);
    expect(s.stderr()).toContain("Issued a provisioning key");
    expectOnlyFrames(s.stdout());
  });

  it("says to run `nxis login` when the key is revoked and the session is gone", async () => {
    fake.valid = new Set();
    const s = await serve();
    try {
      const result = (await s.client.callTool({ name: "nxis_list_sites", arguments: {} })) as CallToolResult;
      expect(result.isError).toBe(true);
      const error = body(result);
      expect(error).toMatchObject({ ok: false, reason: "signed_out" });
      expect(error["hint"]).toContain("nxis login");

      // Signing in while the server runs needs no restart: the next call reads the session again.
      saveCredentials({ accessToken: fakeToken(3600), endpoints: endpointKey(resolveConfig({ api: base }).endpoints) });
      const after = (await s.client.callTool({ name: "nxis_list_sites", arguments: {} })) as CallToolResult;
      expect(after.isError).toBeFalsy();
    } finally {
      await s.close();
    }
    expect(fake.mints).toBe(1);
    expectOnlyFrames(s.stdout());
  });

  it("says to run `nxis login` when a newly minted key is refused too", async () => {
    fake.valid = new Set();
    const s = await serve({ env: { NXIS_TOKEN: fakeToken() } });
    // Every minted key is refused.
    const mint = fake.valid.add.bind(fake.valid);
    fake.valid.add = (value: string) => (value === KEY ? mint(value) : fake.valid);
    try {
      const result = (await s.client.callTool({ name: "nxis_list_sites", arguments: {} })) as CallToolResult;
      expect(result.isError).toBe(true);
      const error = body(result);
      expect(error).toMatchObject({ ok: false, reason: "key_refused" });
      expect(error["hint"]).toContain("nxis login");
    } finally {
      await s.close();
    }
    expectOnlyFrames(s.stdout());
  });
});
