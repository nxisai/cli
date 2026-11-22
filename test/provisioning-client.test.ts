/**
 * The provisioning client, against an in-process MCP server.
 *
 * The fake serves both halves of what the client touches: the organization's MCP endpoint, over
 * the SDK's own Streamable HTTP server transport, and the API-key endpoint the CLI mints its key
 * from and revokes it on. It accepts only the keys it has issued and not revoked, so a test can
 * revoke the stored key and watch the client revoke it by id and mint exactly one more.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { endpointKey, resolveConfig } from "../src/config.js";
import type { Ctx } from "../src/context.js";
import { withSite } from "../src/context.js";
import { loadProvisioningKey, saveProvisioningKey } from "../src/credentials.js";
import { CliError, ExitCode } from "../src/errors.js";
import { createIo, type Io } from "../src/output.js";
import { McpClient } from "../src/provisioning/client.js";
import {
  openProvisioning,
  provisioningEndpoint,
  RENEWAL_INTERVAL_MS,
  resetRenewalLimit,
  siteEndpoint,
  withProvisioning,
} from "../src/provisioning/endpoint.js";
import { setTrace } from "../src/trace.js";

const ORG = "org-test";

/** What the fake server has seen and will accept. */
const fake = {
  issued: [] as string[],
  valid: new Set<string>(),
  mints: 0,
  toolCalls: [] as Array<{ name: string; args: unknown }>,
  /** When set, every MCP request gets this status. */
  forceStatus: null as number | null,
  /** Raw keys by key id, for revoking. */
  byId: new Map<string, string>(),
  /** Revoke requests, by key id, with their bodies. */
  revokes: [] as Array<{ keyId: string; body: unknown }>,
  /** Mints and revokes, in the order they arrived. */
  events: [] as string[],
  /** When set, every revoke request gets this status, and `revokeMessage`. */
  revokeStatus: null as number | null,
  revokeMessage: "revocation is unavailable",
};

/** A JWT the CLI will read an account id from. Unsigned: nothing here checks signatures. */
function fakeToken(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ "https://nxis.ai/user_data": { account: { _id: { value: "acct-1" } } } })}.x`;
}

/** The MCP server for one request; stateless, as the transport allows. */
function mcpServer(): McpServer {
  const server = new McpServer({ name: "fake-provisioning", version: "0.0.0" });
  server.registerTool(
    "nxis_echo",
    { description: "Echoes its arguments.", inputSchema: { site: z.string().optional(), mode: z.string().optional() } },
    async (args) => {
      fake.toolCalls.push({ name: "nxis_echo", args });
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, echoed: args }) }] };
    },
  );
  server.registerTool("nxis_fail", { description: "Always fails." }, async () => {
    fake.toolCalls.push({ name: "nxis_fail", args: {} });
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "The site is not verified yet." }) }] };
  });
  server.registerTool("nxis_plain", { description: "Answers in prose." }, async () => ({
    content: [{ type: "text", text: "All good." }],
  }));
  return server;
}

/** @returns The request body, parsed as JSON. */
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

/** Serves the API-key and MCP endpoints. */
async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? "";
  if (req.method === "POST" && url === `/v1/organizations/${ORG}/apikeys`) {
    await readBody(req);
    fake.mints++;
    const raw = `nxis_dev_mcp_fake_${fake.mints}_secretvalue`; // gitleaks:allow
    fake.issued.push(raw);
    fake.valid.add(raw);
    res.writeHead(200, { "content-type": "application/json" });
    fake.byId.set(`key-${fake.mints}`, raw);
    fake.events.push(`mint key-${fake.mints}`);
    res.end(JSON.stringify({ raw_key: raw, key_id: `key-${fake.mints}`, preview: `…${fake.mints}lue` }));
    return;
  }
  const revoke = new RegExp(`^/v1/organizations/${ORG}/apikeys/([^/:]+):revoke$`).exec(url);
  if (req.method === "POST" && revoke) {
    const keyId = decodeURIComponent(revoke[1] as string);
    fake.revokes.push({ keyId, body: await readBody(req) });
    fake.events.push(`revoke ${keyId}`);
    if (fake.revokeStatus) {
      res.writeHead(fake.revokeStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 13, message: fake.revokeMessage }));
      return;
    }
    const raw = fake.byId.get(keyId);
    if (!raw) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 5, message: `API key not found: ${keyId}` }));
      return;
    }
    fake.byId.delete(keyId);
    fake.valid.delete(raw);
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
    return;
  }
  if (url !== `/v1/organizations/${ORG}/mcp`) {
    res.writeHead(404).end();
    return;
  }
  if (fake.forceStatus) {
    res.writeHead(fake.forceStatus, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Not an owner of this organization" } }));
    return;
  }
  const key = req.headers["nxis-api-key"];
  if (typeof key !== "string" || !fake.valid.has(key)) {
    res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid api key" }));
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  const body = await readBody(req);
  const server = mcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

let http: Server;
let base: string;
let dir: string;
const savedEnv = { ...process.env };

beforeAll(async () => {
  http = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      res.writeHead(500).end(String(err));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nxis-client-"));
  process.env.XDG_CONFIG_HOME = dir;
  process.env.NXIS_NO_KEYCHAIN = "1";
  process.env.NXIS_TOKEN = fakeToken();
  delete process.env.NXIS_API;
  delete process.env.NXIS_MCP_URL;
  fake.issued = [];
  fake.valid.clear();
  fake.mints = 0;
  fake.toolCalls = [];
  fake.forceStatus = null;
  fake.byId.clear();
  fake.revokes = [];
  fake.events = [];
  fake.revokeStatus = null;
  fake.revokeMessage = "revocation is unavailable";
  resetRenewalLimit();
});

afterEach(() => {
  setTrace({ verbose: false, dryRun: false });
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

/** A context pointed at the fake server, acting on the test organization. */
function ctx(overrides: Partial<Ctx> = {}): Ctx {
  return { config: resolveConfig({ api: base }), io: createIo(true), orgOverride: ORG, ...overrides };
}

/** @returns What `fn` threw, as a CliError. */
async function caught(fn: () => Promise<unknown>): Promise<CliError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(CliError);
    return err as CliError;
  }
  throw new Error("expected a failure");
}

/** Turns on `--verbose` and collects what it prints. */
function traced(): string[] {
  const lines: string[] = [];
  setTrace({ verbose: true });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  return lines;
}

/** Output that keeps the notices. */
function notesIo(notes: string[]): Io {
  return { json: true, note: (line) => notes.push(line), emit: () => undefined };
}

describe("the provisioning endpoint", () => {
  it("resolves like `mcp install`, honouring NXIS_MCP_URL", () => {
    expect(provisioningEndpoint(ctx()).url).toBe(`${base}/v1/organizations/${ORG}/mcp`);
    process.env.NXIS_MCP_URL = "http://localhost:9/";
    expect(provisioningEndpoint(ctx()).url).toBe(`http://localhost:9/v1/organizations/${ORG}/mcp`);
  });

  it("needs an organization", async () => {
    const err = await caught(async () => provisioningEndpoint(ctx({ orgOverride: undefined })));
    expect(err.reason).toBe("no_active_org");
  });
});

describe("listing and calling tools", () => {
  it("lists the endpoint's tools", async () => {
    const tools = await withProvisioning(ctx(), (client) => client.listTools());
    expect(tools.map((t) => t.name).sort()).toEqual(["nxis_echo", "nxis_fail", "nxis_plain"]);
  });

  it("calls a tool with the site filled in, and parses its JSON", async () => {
    const c = ctx({ siteOverride: "example.com" });
    const out = await withProvisioning(c, (client) => client.callTool("nxis_echo", withSite(c, { mode: "token" })));
    expect(out.data).toEqual({ ok: true, echoed: { mode: "token", site: "example.com" } });
  });

  it("returns prose as text, with no data", async () => {
    const out = await withProvisioning(ctx(), (client) => client.callTool("nxis_plain"));
    expect(out.text).toBe("All good.");
    expect(out.data).toBeNull();
  });
});

describe("the provisioning key", () => {
  it("is minted once, stored, and reused by the next invocation", async () => {
    await withProvisioning(ctx(), (client) => client.callTool("nxis_plain"));
    await withProvisioning(ctx(), (client) => client.callTool("nxis_plain"));
    expect(fake.mints).toBe(1);
    const stored = loadProvisioningKey(endpointKey(ctx().config.endpoints), ORG);
    expect(stored?.apiKey).toBe(fake.issued[0]);
    expect(stored?.keyId).toBe("key-1");
    expect(stored?.env).toBe("dev");
  });

  it("is written to the key store only", async () => {
    await withProvisioning(ctx(), (client) => client.callTool("nxis_plain"));
    const holding = readdirSync(join(dir, "nxis")).filter((name) =>
      readFileSync(join(dir, "nxis", name), "utf8").includes(fake.issued[0] as string),
    );
    expect(holding).toEqual(["provisioning-keys.json"]);
  });

  it("is minted again, once, when the stored one was revoked, and the call goes through", async () => {
    await withProvisioning(ctx(), (client) => client.callTool("nxis_plain"));
    fake.valid.clear();
    const out = await withProvisioning(ctx(), (client) => client.callTool("nxis_echo", { mode: "x" }));
    expect(out.data).toEqual({ ok: true, echoed: { mode: "x" } });
    expect(fake.mints).toBe(2);
    expect(loadProvisioningKey(endpointKey(ctx().config.endpoints), ORG)?.apiKey).toBe(fake.issued[1]);
  });

  it("is reported, not retried forever, when even a new key is refused", async () => {
    // Every key is refused: drop each one as soon as it is issued.
    const original = fake.valid.add.bind(fake.valid);
    fake.valid.add = () => fake.valid;
    saveProvisioningKey({
      apiKey: "nxis_dev_mcp_stale", // gitleaks:allow
      keyId: "old",
      preview: "…tale",
      orgId: ORG,
      endpoints: endpointKey(ctx().config.endpoints),
      env: "dev",
      createdAt: 0,
    });
    try {
      const err = await caught(() => withProvisioning(ctx(), (client) => client.callTool("nxis_plain")));
      expect(err.reason).toBe("key_refused");
      expect(err.exitCode).toBe(ExitCode.NOT_AUTHORIZED);
      expect(err.message).toContain("nxis login");
      expect(fake.mints).toBe(1);
      expect(fake.toolCalls).toEqual([]);
      // The stale key, then the new one that was refused too, are both revoked rather than left live.
      expect(fake.events).toEqual(["revoke old", "mint key-1", "revoke key-1"]);
      // Forgotten, so the next invocation starts with a fresh mint rather than a known-bad key.
      expect(loadProvisioningKey(endpointKey(ctx().config.endpoints), ORG)).toBeNull();
    } finally {
      fake.valid.add = original;
    }
  });

  it("revokes the refused key by its id before minting another", async () => {
    await withProvisioning(ctx(), (client) => client.callTool("nxis_plain"));
    // Refused, as a proxy or a transient failure might: the key is still valid on the server.
    const refused = fake.issued[0] as string;
    fake.valid.delete(refused);
    fake.byId.set("key-1", refused);
    await withProvisioning(ctx(), (client) => client.callTool("nxis_plain"));
    expect(fake.events).toEqual(["mint key-1", "revoke key-1", "mint key-2"]);
    expect(fake.revokes[0]?.body).toMatchObject({ parent: `organizations/${ORG}`, key_id: "key-1" });
    expect(String((fake.revokes[0]?.body as { reason?: string }).reason)).toContain("Refused");
    expect(fake.byId.has("key-1")).toBe(false);
    expect(loadProvisioningKey(endpointKey(ctx().config.endpoints), ORG)?.keyId).toBe("key-2");
  });

  it("treats a key the service doesn't know as revoked, and says so in the trace", async () => {
    await withProvisioning(ctx(), (client) => client.callTool("nxis_plain"));
    fake.valid.clear();
    fake.byId.clear(); // revoked elsewhere: the service answers 404
    const lines = traced();
    const out = await withProvisioning(ctx(), (client) => client.callTool("nxis_echo", { mode: "x" }));
    expect(out.data).toEqual({ ok: true, echoed: { mode: "x" } });
    expect(fake.events).toEqual(["mint key-1", "revoke key-1", "mint key-2"]);
    expect(lines.join("")).toContain("key-1) was already revoked, or is unknown to the service");
  });

  it("treats a key the service has already revoked as revoked", async () => {
    await withProvisioning(ctx(), (client) => client.callTool("nxis_plain"));
    fake.valid.clear();
    fake.revokeStatus = 400; // a failed precondition, as the gateway maps it
    fake.revokeMessage = "API key already revoked: key-1";
    const notes: string[] = [];
    const lines = traced();
    await withProvisioning(ctx({ io: notesIo(notes) }), (client) => client.callTool("nxis_plain"));
    expect(fake.mints).toBe(2);
    expect(lines.join("")).toContain("was already revoked");
    expect(notes.join("\n")).not.toContain("may still be valid");
  });

  it("still renews when revoking fails, and says the old key may be live", async () => {
    await withProvisioning(ctx(), (client) => client.callTool("nxis_plain"));
    fake.valid.clear();
    fake.revokeStatus = 503;
    const notes: string[] = [];
    const lines = traced();
    const out = await withProvisioning(ctx({ io: notesIo(notes) }), (client) => client.callTool("nxis_echo", { mode: "x" }));
    expect(out.data).toEqual({ ok: true, echoed: { mode: "x" } });
    expect(fake.events).toEqual(["mint key-1", "revoke key-1", "mint key-2"]);
    expect(lines.join("")).toContain("Could not revoke the refused provisioning key …1lue (key-1)");
    expect(notes.join("\n")).toContain("it may still be valid");
    for (const raw of fake.issued) {
      expect(lines.join("")).not.toContain(raw);
      expect(notes.join("\n")).not.toContain(raw);
    }
  });

  it("renews at most once a minute for an organization", async () => {
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    await withProvisioning(ctx(), (client) => client.callTool("nxis_plain"));
    fake.valid.clear();
    await withProvisioning(ctx(), (client) => client.callTool("nxis_plain"));
    expect(fake.mints).toBe(2);

    // Refused again 30s later: reported, with the stored key kept, and nothing minted or revoked.
    fake.valid.clear();
    clock.mockReturnValue(start + 30_000);
    const err = await caught(() => withProvisioning(ctx(), (client) => client.callTool("nxis_plain")));
    expect(err.reason).toBe("key_refused");
    expect(err.details).toMatchObject({ retry_after_s: 30 });
    expect(fake.mints).toBe(2);
    expect(fake.revokes.map((r) => r.keyId)).toEqual(["key-1"]);
    expect(loadProvisioningKey(endpointKey(ctx().config.endpoints), ORG)?.keyId).toBe("key-2");

    // A minute after the last renewal, it renews again.
    clock.mockReturnValue(start + RENEWAL_INTERVAL_MS);
    await withProvisioning(ctx(), (client) => client.callTool("nxis_plain"));
    expect(fake.events.slice(-2)).toEqual(["revoke key-2", "mint key-3"]);
  });

  it("asks for a sign-in when one is needed to mint", async () => {
    delete process.env.NXIS_TOKEN;
    const err = await caught(() => withProvisioning(ctx(), (client) => client.callTool("nxis_plain")));
    expect(err.reason).toBe("signed_out");
    expect(err.exitCode).toBe(ExitCode.NOT_AUTHORIZED);
  });
});

describe("errors", () => {
  it("turns a tool's isError result into a failure with the tool's words", async () => {
    const err = await caught(() => withProvisioning(ctx(), (client) => client.callTool("nxis_fail")));
    expect(err.reason).toBe("tool_error");
    expect(err.exitCode).toBe(ExitCode.ERROR);
    expect(err.message).toBe("The site is not verified yet.");
    expect(err.toJSON()).toMatchObject({ ok: false, tool: "nxis_fail", tool_error: { error: "The site is not verified yet." } });
  });

  it("maps 403 to not authorized, with the endpoint's message", async () => {
    fake.forceStatus = 403;
    const err = await caught(() => withProvisioning(ctx(), (client) => client.callTool("nxis_plain")));
    expect(err.reason).toBe("forbidden");
    expect(err.exitCode).toBe(ExitCode.NOT_AUTHORIZED);
    expect(err.message).toContain("Not an owner of this organization");
  });

  it("maps 401 and 403 from a site endpoint, which gets no key, to site_mcp_not_public", async () => {
    // The fake's MCP endpoint refuses a request without a key with 401, as a private site's does.
    const url = `${base}/v1/organizations/${ORG}/mcp`;
    for (const status of [401, 403]) {
      fake.forceStatus = status === 403 ? 403 : null;
      const client = new McpClient(siteEndpoint(url));
      const err = await caught(() => client.callTool("nxis_plain"));
      await client.close();
      expect(err.reason).toBe("site_mcp_not_public");
      expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
      expect(err.message).toContain("nxis mcp public on");
      expect(err.message).not.toContain("nxis login");
      expect(err.details).toEqual({ status, endpoint: url });
    }
    expect(fake.mints).toBe(0);
  });

  it("maps a server failure to a plain failure", async () => {
    fake.forceStatus = 502;
    const err = await caught(() => withProvisioning(ctx(), (client) => client.callTool("nxis_plain")));
    expect(err.reason).toBe("request_failed");
    expect(err.exitCode).toBe(ExitCode.ERROR);
  });

  it("maps an unreachable endpoint to a network failure", async () => {
    const client = new McpClient({ url: "http://127.0.0.1:9/mcp", label: "The test endpoint", keys: null });
    const err = await caught(() => client.callTool("nxis_plain"));
    expect(err.reason).toBe("network");
    expect(err.exitCode).toBe(ExitCode.ERROR);
    await client.close();
  });

  it("maps an unknown tool to a failure", async () => {
    const err = await caught(() => withProvisioning(ctx(), (client) => client.callTool("nxis_missing")));
    expect(err.exitCode).toBe(ExitCode.ERROR);
    expect(["mcp_error", "tool_error"]).toContain(err.reason);
  });

  it("refuses to send a key over plain http to another machine", async () => {
    const err = await caught(async () => new McpClient({ url: "http://example.com/mcp", label: "x", keys: { get: async () => "k" } }));
    expect(err.reason).toBe("insecure_mcp_url");
  });
});

describe("--dry-run", () => {
  it("withholds a call, without connecting or minting a key", async () => {
    setTrace({ dryRun: true });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const err = await caught(() => withProvisioning(ctx(), (client) => client.callTool("nxis_echo", { mode: "token" })));
    expect(err.reason).toBe("dry_run");
    expect(err.exitCode).toBe(ExitCode.OK);
    expect(err.details).toMatchObject({ dry_run: true, tool: "nxis_echo", arguments: { mode: "token" } });
    expect(fake.mints).toBe(0);
    expect(fake.toolCalls).toEqual([]);
  });

  it("withholds revoking a refused key, and keeps it", async () => {
    await withProvisioning(ctx(), (client) => client.callTool("nxis_plain")); // mint outside the dry run
    fake.valid.clear();
    setTrace({ dryRun: true });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const err = await caught(() => withProvisioning(ctx(), (client) => client.callTool("nxis_echo", { mode: "plan" }, { readOnly: true })));
    expect(err.reason).toBe("dry_run");
    expect(fake.revokes).toEqual([]);
    expect(fake.mints).toBe(1);
    expect(loadProvisioningKey(endpointKey(ctx().config.endpoints), ORG)?.keyId).toBe("key-1");
  });

  it("still makes a call marked read-only", async () => {
    await withProvisioning(ctx(), (client) => client.callTool("nxis_plain")); // mint outside the dry run
    setTrace({ dryRun: true });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const out = await withProvisioning(ctx(), (client) => client.callTool("nxis_echo", { mode: "plan" }, { readOnly: true }));
    expect(out.data).toEqual({ ok: true, echoed: { mode: "plan" } });
  });
});

describe("--verbose", () => {
  it("prints each JSON-RPC message, and never the key", async () => {
    const lines: string[] = [];
    setTrace({ verbose: true });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    const client = openProvisioning(ctx());
    try {
      await client.callTool("nxis_echo", { mode: "token" });
    } finally {
      await client.close();
    }
    const out = lines.join("");
    expect(out).toContain('"method":"initialize"');
    expect(out).toContain('"method":"tools/call"');
    expect(out).toContain("nxis-api-key: <redacted>");
    for (const raw of fake.issued) expect(out).not.toContain(raw);
  });
});
