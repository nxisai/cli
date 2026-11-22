/**
 * An in-process provisioning endpoint for command tests, which also serves the site's files.
 *
 * Like the fake in `tools-run.test.ts`, it registers the CLI's own tool definitions on an SDK
 * `McpServer`, so arguments are checked against the same schemas, wants the CLI's key, and
 * records every call. Each tool's answer is programmable, either per tool in `answers` or for
 * every tool through `respond`, and any other GET path serves a file (a sitemap), so the site's
 * host is this server's. Shared by the site and data command suites.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { TOOLS } from "../../src/tools/index.js";

export const ORG = "org-test";
export const KEY = "nxis_dev_mcp_fake_key"; // gitleaks:allow

/** One tool call the fake received. */
export interface Call {
  tool: string;
  args: Record<string, unknown>;
}

/** A tool's answer: a payload, or a failure the tool reports. */
export type Answer = Record<string, unknown> | { isError: true; text: string };

export interface Fake {
  base: string;
  calls: Call[];
  /** Answers by tool name, or by `tool:mode`. A function sees the arguments. */
  answers: Record<string, Answer | ((args: Record<string, unknown>) => Answer | Promise<Answer>)>;
  /** Answers any tool `answers` doesn't name, before the defaults. */
  respond?: (tool: string, args: Record<string, unknown>) => Answer | Promise<Answer>;
  /** Files served on GET, by path. */
  /** `chunked` sends the body without a Content-Length, so only reading it shows its size. */
  files: Record<string, { status?: number; body: string | Buffer; type?: string; chunked?: boolean }>;
  /** Every GET the fake served. */
  gets: string[];
  close(): Promise<void>;
  reset(): void;
}

/** @returns The calls to one tool, in the given mode when one is named. */
export function callsTo(fake: Fake, tool: string, mode?: string): Call[] {
  return fake.calls.filter((c) => c.tool === tool && (mode === undefined || c.args["mode"] === mode));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

/** Starts the fake on a free loopback port. */
export async function startFake(): Promise<Fake> {
  const fake = {
    base: "",
    calls: [] as Call[],
    answers: {} as Fake["answers"],
    files: {} as Fake["files"],
    gets: [] as string[],
  } as Fake;

  const defaultSites = () => ({
    organization: ORG,
    count: 1,
    truncated: false,
    sites: [{ site: "site-1", domain: fake.base, host: "127.0.0.1", is_verified: true, active: true }],
  });

  const answer = async (tool: string, args: Record<string, unknown>): Promise<Answer> => {
    const mode = typeof args["mode"] === "string" ? `${tool}:${args["mode"]}` : tool;
    const programmed = fake.answers[mode] ?? fake.answers[tool];
    if (programmed) return typeof programmed === "function" ? programmed(args) : programmed;
    if (fake.respond) return fake.respond(tool, args);
    if (tool === "nxis_list_sites") return defaultSites();
    return { tool, args };
  };

  const mcp = (): McpServer => {
    const server = new McpServer({ name: "fake", version: "0.0.0" });
    for (const tool of TOOLS.filter((t) => t.surface === "provisioning")) {
      server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input }, async (args) => {
        const a = args as Record<string, unknown>;
        fake.calls.push({ tool: tool.name, args: a });
        const out = await answer(tool.name, a);
        if ((out as { isError?: boolean }).isError) {
          return { isError: true, content: [{ type: "text", text: (out as { text: string }).text }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
      });
    }
    return server;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = req.url ?? "";
    if (req.method === "GET" && url !== `/v1/organizations/${ORG}/mcp`) {
      fake.gets.push(url);
      const file = fake.files[url];
      if (!file) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(file.status ?? 200, { "content-type": file.type ?? "application/xml" });
      if (file.chunked) {
        res.on("error", () => undefined);
        res.write(file.body);
        res.end();
      } else {
        res.end(file.body);
      }
      return;
    }
    if (url !== `/v1/organizations/${ORG}/mcp`) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    if (req.headers["nxis-api-key"] !== KEY) {
      res.writeHead(401).end();
      return;
    }
    const body = await readBody(req);
    const server = mcp();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const http: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500).end(String(err));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  fake.base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  fake.reset = () => {
    fake.calls = [];
    fake.answers = {};
    fake.respond = undefined;
    fake.files = {};
    fake.gets = [];
  };
  fake.close = async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  };
  return fake;
}

/** @returns A `<urlset>` sitemap of these URLs. */
export function urlset(locs: string[]): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    locs.map((loc) => `  <url><loc>${loc}</loc></url>`).join("\n") +
    "\n</urlset>\n"
  );
}

/** @returns A `<sitemapindex>` of these sitemaps. */
export function sitemapIndex(locs: string[]): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    locs.map((loc) => `  <sitemap><loc>${loc}</loc></sitemap>`).join("\n") +
    "\n</sitemapindex>\n"
  );
}
