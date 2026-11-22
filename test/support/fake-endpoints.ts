/**
 * An in-process provisioning endpoint and site endpoint, for running commands end to end, with
 * hooks for the authorization and sites services' HTTP routes.
 *
 * Both register the CLI's own tool definitions on SDK `McpServer`s, as the tool tests do, but each
 * tool answers with whatever the test sets in `fake.responses`, so a command sees the server's
 * real result shapes. Every call is recorded with the endpoint it reached and the key it carried.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { endpointKey, resolveConfig } from "../../src/config.js";
import type { Ctx } from "../../src/context.js";
import { saveProvisioningKey } from "../../src/credentials.js";
import type { Io } from "../../src/output.js";
import { TOOLS } from "../../src/tools/index.js";
import { setTrace } from "../../src/trace.js";

export const ORG = "org-test";
export const KEY = "nxis_dev_mcp_fake_key"; // gitleaks:allow

export interface Seen {
  endpoint: "provisioning" | "site";
  tool: string;
  args: Record<string, unknown>;
  key: string | undefined;
}

type Responder = (args: Record<string, unknown>) => Record<string, unknown>;

/** A request to the authorization service's key routes, as the fake saw it. */
export interface AuthSeen {
  method: string;
  /** Path and query. */
  url: string;
  body: unknown;
}

/** How the fake authorization service answers one request: a status and a JSON body. */
type AuthResponder = (req: AuthSeen) => { status: number; body?: unknown };

/** What the fake answers, and what it saw. */
export const fake = {
  calls: [] as Seen[],
  /** The site's MCP state, as `nxis_list_sites` reports it; null for a site with no MCP server. */
  siteMcp: { enabled: true, is_public: true } as { enabled: boolean; is_public: boolean } | null,
  responses: {} as Record<string, Responder>,
  /** Tools that answer with `isError`. */
  errors: {} as Record<string, string>,
  /** An HTTP status the site endpoint answers every request with, as a private server does. */
  siteStatus: null as number | null,
  /** Requests to the authorization service's `/v1/organizations/<org>/apikeys…` routes. */
  authCalls: [] as AuthSeen[],
  /** Answers them; without one, they get 404. */
  auth: null as AuthResponder | null,
  /** Requests to the sites service's `/v1/organizations/<org>/sites/…` and `…/agentNotices` routes. */
  sitesCalls: [] as AuthSeen[],
  /** Answers them; without one, they get 404. */
  sites: null as AuthResponder | null,
};

let base = "";

/** @returns The site endpoint's URL. */
export function siteUrl(): string {
  return `${base}/site/mcp`;
}

function listSites(): Record<string, unknown> {
  return {
    organization: ORG,
    count: 1,
    sites: [
      {
        site: "site-1",
        domain: "example.com",
        host: "example.com",
        is_verified: true,
        ...(fake.siteMcp ? { mcp: { endpoint: siteUrl(), ...fake.siteMcp, listed_in_app: false } } : {}),
      },
    ],
  };
}

function mcpServer(endpoint: Seen["endpoint"], key: string | undefined): McpServer {
  const server = new McpServer({ name: "fake", version: "0.0.0" });
  for (const tool of TOOLS.filter((t) => t.surface === endpoint)) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input }, async (args) => {
      const a = args as Record<string, unknown>;
      fake.calls.push({ endpoint, tool: tool.name, args: a, key });
      const error = fake.errors[tool.name];
      if (error) return { content: [{ type: "text", text: error }], isError: true };
      const payload =
        tool.name === "nxis_list_sites" ? listSites() : (fake.responses[tool.name]?.(a) ?? { tool: tool.name, args: a });
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
  if (url.startsWith(`/v1/organizations/${ORG}/apikeys`)) {
    const seen: AuthSeen = { method: req.method ?? "", url, body: await readBody(req) };
    fake.authCalls.push(seen);
    const answer = fake.auth?.(seen) ?? { status: 404 };
    res.writeHead(answer.status, { "content-type": "application/json" });
    res.end(answer.body === undefined ? "" : JSON.stringify(answer.body));
    return;
  }
  if (url.startsWith(`/v1/organizations/${ORG}/sites/`) || url.startsWith(`/v1/organizations/${ORG}/agentNotices`)) {
    const seen: AuthSeen = { method: req.method ?? "", url, body: await readBody(req) };
    fake.sitesCalls.push(seen);
    const answer = fake.sites?.(seen) ?? { status: 404 };
    res.writeHead(answer.status, { "content-type": "application/json" });
    res.end(answer.body === undefined ? "" : JSON.stringify(answer.body));
    return;
  }
  const endpoint: Seen["endpoint"] | null =
    url === `/v1/organizations/${ORG}/mcp` ? "provisioning" : url === "/site/mcp" ? "site" : null;
  if (!endpoint || req.method !== "POST") {
    res.writeHead(endpoint ? 405 : 404).end();
    return;
  }
  const key = req.headers["nxis-api-key"] as string | undefined;
  if (endpoint === "provisioning" && key !== KEY) {
    res.writeHead(401).end();
    return;
  }
  if (endpoint === "site" && fake.siteStatus !== null) {
    res.writeHead(fake.siteStatus).end();
    return;
  }
  const body = await readBody(req);
  const server = mcpServer(endpoint, key);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

let http: Server | null = null;
let dir = "";
const savedEnv = { ...process.env };

/** Starts the server. Call from `beforeAll`. */
export async function startFake(): Promise<void> {
  http = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => res.writeHead(500).end(String(err)));
  });
  await new Promise<void>((resolve) => (http as Server).listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${((http as Server).address() as AddressInfo).port}`;
}

/** Stops the server. Call from `afterAll`. */
export async function stopFake(): Promise<void> {
  await new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()));
}

/** A fresh config directory with a stored key, and a fake with no answers set. Call from `beforeEach`. */
export function resetFake(): void {
  dir = mkdtempSync(join(tmpdir(), "nxis-cmd-"));
  process.env.XDG_CONFIG_HOME = dir;
  process.env.NXIS_NO_KEYCHAIN = "1";
  for (const name of ["NXIS_TOKEN", "NXIS_API", "NXIS_MCP_URL", "NXIS_SITE_MCP_URL", "NXIS_SITES_URL"]) delete process.env[name];
  fake.calls = [];
  fake.siteMcp = { enabled: true, is_public: true };
  fake.responses = {};
  fake.errors = {};
  fake.siteStatus = null;
  fake.authCalls = [];
  fake.auth = null;
  fake.sitesCalls = [];
  fake.sites = null;
  saveProvisioningKey({
    apiKey: KEY,
    keyId: "key-1",
    preview: "…_key",
    orgId: ORG,
    endpoints: endpointKey(resolveConfig({ api: base }).endpoints),
    env: "dev",
    createdAt: 0,
  });
}

/** Removes the config directory and restores the environment. Call from `afterEach`. */
export function cleanFake(): void {
  setTrace({ verbose: false, dryRun: false });
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...savedEnv };
}

/** What a command emitted. */
export interface Emitted {
  json: Record<string, unknown>;
  text: string;
  notes: string[];
}

/** A command context on the fake, acting on site-1, that captures what the command emits. */
export function capture(overrides: Partial<Ctx> = {}): { ctx: Ctx; out: Emitted } {
  const out: Emitted = { json: {}, text: "", notes: [] };
  const io: Io = {
    json: true,
    note: (line) => out.notes.push(line),
    emit: (payload, human) => {
      out.json = payload;
      out.text = human();
    },
  };
  const ctx: Ctx = {
    config: resolveConfig({ api: base }),
    io,
    orgOverride: ORG,
    siteOverride: "site-1",
    ...overrides,
  };
  return { ctx, out };
}

/** The calls the fake received, without the site lookups. */
export const toolCalls = (): Seen[] => fake.calls.filter((c) => c.tool !== "nxis_list_sites");
