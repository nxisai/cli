/**
 * `run()` for the shared tool definitions, against an in-process server.
 *
 * The fake serves two endpoints: the organization's provisioning endpoint, which wants a key, and
 * one site's own endpoint, which wants none. Each registers the CLI's own definitions on an SDK
 * `McpServer`, as `nxis mcp serve` will, and records every call it receives and where.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { endpointKey, resolveConfig } from "../src/config.js";
import type { Ctx } from "../src/context.js";
import { saveProvisioningKey } from "../src/credentials.js";
import { CliError, ExitCode } from "../src/errors.js";
import { createIo } from "../src/output.js";
import { withProvisioning } from "../src/provisioning/endpoint.js";
import { saveActiveSite } from "../src/state.js";
import {
  TOOLS,
  bulkAutofill,
  crawlSitemap,
  createSite,
  getTool,
  hostOf,
  listTypes,
  looksLikeSiteId,
  query,
  setSiteName,
  verifySite,
  type ToolCaller,
} from "../src/tools/index.js";
import { setTrace } from "../src/trace.js";
import { schemaDiff, type JsonSchema } from "./support/schema-drift.js";

const ORG = "org-test";
const KEY = "nxis_dev_mcp_fake_key"; // gitleaks:allow

interface Seen {
  endpoint: "provisioning" | "site-public" | "site-private";
  tool: string;
  args: Record<string, unknown>;
  key: string | undefined;
}

const fake = { calls: [] as Seen[], publicSite: true };
let base: string;

/** The sites `nxis_list_sites` reports. */
function sites() {
  return {
    organization: ORG,
    count: 2,
    truncated: false,
    sites: [
      {
        site: "site-1",
        domain: "https://Example.com/",
        host: "example.com",
        is_verified: true,
        active: true,
        mcp: { endpoint: `${base}/site-public/mcp`, enabled: true, is_public: fake.publicSite, listed_in_app: false },
      },
      { site: "site-2", domain: "other.example", host: "other.example", is_verified: false, active: true },
    ],
  };
}

/** One endpoint's server, registering the CLI's definitions for that surface. */
function mcpServer(endpoint: Seen["endpoint"], key: string | undefined): McpServer {
  const server = new McpServer({ name: "fake", version: "0.0.0" });
  const surface = endpoint === "provisioning" ? "provisioning" : "site";
  for (const tool of TOOLS.filter((t) => t.surface === surface)) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input }, async (args) => {
      fake.calls.push({ endpoint, tool: tool.name, args: args as Record<string, unknown>, key });
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
  const endpoint: Seen["endpoint"] | null =
    url === `/v1/organizations/${ORG}/mcp`
      ? "provisioning"
      : url === "/site-public/mcp"
        ? "site-public"
        : url === "/site-private/mcp"
          ? "site-private"
          : null;
  if (!endpoint || req.method !== "POST") {
    res.writeHead(endpoint ? 405 : 404).end();
    return;
  }
  const key = req.headers["nxis-api-key"] as string | undefined;
  if (endpoint === "provisioning" && key !== KEY) {
    res.writeHead(401).end();
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

let http: Server;
let dir: string;
const savedEnv = { ...process.env };

beforeAll(async () => {
  http = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => res.writeHead(500).end(String(err)));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nxis-tools-"));
  process.env.XDG_CONFIG_HOME = dir;
  process.env.NXIS_NO_KEYCHAIN = "1";
  delete process.env.NXIS_TOKEN;
  delete process.env.NXIS_API;
  delete process.env.NXIS_MCP_URL;
  delete process.env.NXIS_SITE_MCP_URL;
  fake.calls = [];
  fake.publicSite = true;
  saveProvisioningKey({
    apiKey: KEY,
    keyId: "key-1",
    preview: "…_key",
    orgId: ORG,
    endpoints: endpointKey(ctx().config.endpoints),
    env: "dev",
    createdAt: 0,
  });
});

afterEach(() => {
  setTrace({ verbose: false, dryRun: false });
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

function ctx(overrides: Partial<Ctx> = {}): Ctx {
  return { config: resolveConfig({ api: base }), io: createIo(true), orgOverride: ORG, ...overrides };
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

/** The calls the fake received, without the site lookups. */
const toolCalls = () => fake.calls.filter((c) => c.tool !== "nxis_list_sites");

describe("provisioning tools", () => {
  it("call the provisioning endpoint with the key, and return typed data", async () => {
    const out = await createSite.run(ctx(), { url: "https://example.com" });
    expect(fake.calls).toEqual([
      { endpoint: "provisioning", tool: "nxis_create_site", args: { url: "https://example.com" }, key: KEY },
    ]);
    expect(out.data).toEqual({ tool: "nxis_create_site", args: { url: "https://example.com" } });
  });

  it("fill `site` from --site", async () => {
    await verifySite.run(ctx({ siteOverride: "site-1" }), { mode: "token" });
    expect(fake.calls).toEqual([
      { endpoint: "provisioning", tool: "nxis_verify_site", args: { mode: "token", site: "site-1" }, key: KEY },
    ]);
  });

  it("fill `site` from the saved site", async () => {
    saveActiveSite({ id: "site-2", orgId: ORG });
    await setSiteName.run(ctx(), { display_name: "Acme" });
    expect(toolCalls()[0]?.args).toEqual({ display_name: "Acme", site: "site-2" });
  });

  it("keep a `site` given in the arguments", async () => {
    await setSiteName.run(ctx({ siteOverride: "site-1" }), { display_name: "Acme", site: "site-2" });
    expect(toolCalls()[0]?.args).toEqual({ display_name: "Acme", site: "site-2" });
  });

  it("turn a domain into the site id, since the endpoint takes only ids", async () => {
    await verifySite.run(ctx({ siteOverride: "https://EXAMPLE.com:443/about" }), { mode: "check" });
    expect(fake.calls.map((c) => c.tool)).toEqual(["nxis_list_sites", "nxis_verify_site"]);
    expect(toolCalls()[0]?.args).toEqual({ mode: "check", site: "site-1" });
  });

  it("report a domain no site has, before calling the tool", async () => {
    const err = await caught(() => verifySite.run(ctx({ siteOverride: "nowhere.example" }), { mode: "token" }));
    expect(err.reason).toBe("site_not_found");
    expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
    expect(toolCalls()).toEqual([]);
  });

  it("need a site when none is selected, and send nothing", async () => {
    const err = await caught(() => verifySite.run(ctx(), { mode: "token" }));
    expect(err.reason).toBe("no_active_site");
    expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
    expect(fake.calls).toEqual([]);
  });

  it("do not take a site when they create one", async () => {
    await createSite.run(ctx({ siteOverride: "site-1" }), { url: "https://new.example" });
    expect(toolCalls()[0]?.args).toEqual({ url: "https://new.example" });
  });

  it("reuse a connection they are given", async () => {
    const c = ctx({ siteOverride: "site-1" });
    await withProvisioning(c, async (provisioning) => {
      await createSite.run(c, { url: "https://example.com" }, { provisioning });
      await setSiteName.run(c, { display_name: "Acme" }, { provisioning });
    });
    expect(fake.calls.map((x) => x.tool)).toEqual(["nxis_create_site", "nxis_set_site_name"]);
  });
});

describe("site tools", () => {
  it("call the site's own endpoint from nxis_list_sites, with no key and no `site`", async () => {
    const out = await listTypes.run(ctx({ siteOverride: "example.com" }), { limit: 5 });
    expect(fake.calls).toEqual([
      { endpoint: "provisioning", tool: "nxis_list_sites", args: { limit: 500 }, key: KEY },
      { endpoint: "site-public", tool: "nxis_list_types", args: { limit: 5 }, key: undefined },
    ]);
    expect(out.data).toEqual({ tool: "nxis_list_types", args: { limit: 5 } });
  });

  it("use NXIS_SITE_MCP_URL when set, without asking the provisioning endpoint", async () => {
    process.env.NXIS_SITE_MCP_URL = `${base}/site-private/mcp`;
    await query.run(ctx(), { filter: { schema_type: "Product" } });
    expect(fake.calls).toEqual([
      { endpoint: "site-private", tool: "nxis_query", args: { filter: { schema_type: "Product" } }, key: undefined },
    ]);
  });

  it("use the URL they are given", async () => {
    await listTypes.run(ctx(), {}, { siteUrl: `${base}/site-private/mcp` });
    expect(fake.calls.map((c) => c.endpoint)).toEqual(["site-private"]);
  });

  it("refuse a site whose MCP server is not public, since they send no key", async () => {
    fake.publicSite = false;
    const err = await caught(() => listTypes.run(ctx({ siteOverride: "site-1" }), {}));
    expect(err.reason).toBe("site_mcp_not_public");
    expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
    expect(toolCalls()).toEqual([]);
  });

  it("refuse a site with no MCP server", async () => {
    const err = await caught(() => listTypes.run(ctx({ siteOverride: "site-2" }), {}));
    expect(err.reason).toBe("site_mcp_off");
  });

  it("refuse a `site` argument, which a site endpoint rejects", async () => {
    const err = await caught(() =>
      listTypes.run(ctx(), { site: "site-1" } as never, { siteUrl: `${base}/site-public/mcp` }),
    );
    expect(err.reason).toBe("invalid_input");
    expect(err.details["field"]).toBe("site");
  });
});

describe("--dry-run", () => {
  it("withholds a write, before resolving or sending anything", async () => {
    setTrace({ dryRun: true });
    const err = await caught(() => verifySite.run(ctx({ siteOverride: "site-1" }), { mode: "check" }));
    expect(err.reason).toBe("dry_run");
    expect(err.exitCode).toBe(ExitCode.OK);
    expect(err.details).toMatchObject({ tool: "nxis_verify_site", arguments: { mode: "check", site: "site-1" } });
    expect(fake.calls).toEqual([]);
  });

  it("still runs the read modes of a tool that also writes", async () => {
    setTrace({ dryRun: true });
    const c = ctx({ siteOverride: "site-1" });
    await bulkAutofill.run(c, { mode: "plan", existing: "import_and_complete" });
    await bulkAutofill.run(c, { mode: "status", batch_id: "b-1" });
    await crawlSitemap.run(c, { url: "https://example.com/sitemap.xml", mode: "status" });
    await verifySite.run(c, { mode: "token" });
    expect(fake.calls.map((x) => x.tool)).toEqual([
      "nxis_bulk_autofill",
      "nxis_bulk_autofill",
      "nxis_crawl_sitemap",
      "nxis_verify_site",
    ]);

    const submit = await caught(() => bulkAutofill.run(c, { mode: "submit" }));
    expect(submit.reason).toBe("dry_run");
    const crawl = await caught(() => crawlSitemap.run(c, { url: "https://example.com/sitemap.xml" }));
    expect(crawl.reason).toBe("dry_run");
    expect(fake.calls).toHaveLength(4);
  });

  it("still runs the site reads", async () => {
    setTrace({ dryRun: true });
    await listTypes.run(ctx({ siteOverride: "site-1" }), {});
    expect(fake.calls.map((c) => c.tool)).toEqual(["nxis_list_sites", "nxis_list_types"]);
  });
});

describe("input validation", () => {
  const stub: ToolCaller = {
    callTool: async () => {
      throw new Error("must not be called");
    },
  };

  it("names an argument the tool does not have", async () => {
    const err = await caught(() =>
      verifySite.run(ctx({ siteOverride: "site-1" }), { mode: "token", sitee: "x" } as never, { provisioning: stub }),
    );
    expect(err.reason).toBe("invalid_input");
    expect(err.exitCode).toBe(ExitCode.ERROR);
    expect(err.details).toMatchObject({ tool: "nxis_verify_site", field: "sitee" });
  });

  it("names a value outside an enum", async () => {
    const err = await caught(() =>
      bulkAutofill.run(ctx({ siteOverride: "site-1" }), { mode: "plan", existing: "replace" } as never, {
        provisioning: stub,
      }),
    );
    expect(err.details["field"]).toBe("existing");
    expect(err.message).toMatch(/^Invalid input for nxis_bulk_autofill: `existing`: /);
  });

  it("names a missing required argument, nested ones included", async () => {
    const missing = await caught(() => crawlSitemap.run(ctx({ siteOverride: "site-1" }), {} as never, { provisioning: stub }));
    expect(missing.details["field"]).toBe("url");
    const nested = await caught(() =>
      query.run(ctx(), { filter: { field_filters: [{ path: "a" }] } } as never, { site: stub }),
    );
    expect((nested.details["issues"] as Array<{ field: string }>).map((i) => i.field)).toEqual(
      expect.arrayContaining(["filter.schema_type", "filter.field_filters.0.operator"]),
    );
  });

  it("validates before resolving the site", async () => {
    const err = await caught(() => verifySite.run(ctx(), { mode: "nope" } as never));
    expect(err.reason).toBe("invalid_input");
    expect(fake.calls).toEqual([]);
  });
});

describe("the registry", () => {
  it("looks tools up by name", () => {
    expect(getTool("nxis_query")).toBe(query);
    expect(getTool("nxis_nothing")).toBeUndefined();
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
  });

  it("registers on an SDK McpServer, which lists the server's own schemas", async () => {
    // What `nxis mcp serve` will expose: the SDK's own conversion of our zod schemas.
    const fixture = JSON.parse(
      readFileSync(new URL("./fixtures/provisioning-tools.json", import.meta.url), "utf8"),
    ) as { provisioning: { tools: Array<{ name: string; inputSchema: JsonSchema }> } };
    const listed = await withProvisioning(ctx(), (client) => client.listTools());
    for (const tool of listed) {
      const recorded = fixture.provisioning.tools.find((t) => t.name === tool.name);
      expect(schemaDiff(tool.inputSchema as JsonSchema, recorded?.inputSchema ?? {}), tool.name).toEqual([]);
    }
    expect(listed).toHaveLength(fixture.provisioning.tools.length);
  });
});

describe("site names", () => {
  it("tells an id from a domain", () => {
    expect(looksLikeSiteId("site-1")).toBe(true);
    expect(looksLikeSiteId("6650f1c2a9")).toBe(true);
    expect(looksLikeSiteId("example.com")).toBe(false);
    expect(looksLikeSiteId("localhost")).toBe(false);
    expect(looksLikeSiteId("localhost:3000")).toBe(false);
    expect(looksLikeSiteId("https://example.com")).toBe(false);
  });

  it("reduces a domain or URL to its host, as the server does", () => {
    expect(hostOf("https://User@Example.COM:8443/path?q#h")).toBe("example.com");
    expect(hostOf("www.example.com.")).toBe("www.example.com");
    expect(hostOf("example.com/shop")).toBe("example.com");
    expect(hostOf("")).toBeNull();
  });
});
