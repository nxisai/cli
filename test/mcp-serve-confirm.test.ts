/**
 * `nxis mcp serve`'s checks before a risky call: the person's yes over elicitation, the refusal
 * when the client cannot ask, `--read-only`, and the tools' annotations.
 *
 * The server is built in process and spoken to over the SDK's in-memory transport pair, by a
 * client that may or may not declare elicitation. Its calls reach the in-process provisioning
 * fake in `support/fake-endpoints.ts`, which records them.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type CallToolResult, type ElicitRequest } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuardOptions } from "../src/commands/mcp-guard.js";
import { createServeServer, ProvisioningConnection } from "../src/commands/mcp-serve.js";
import { TOOLS } from "../src/tools/index.js";
import { setTrace } from "../src/trace.js";
import { capture, cleanFake, fake, resetFake, startFake, stopFake, toolCalls } from "./support/fake-endpoints.js";

beforeAll(startFake);
afterAll(stopFake);
beforeEach(() => {
  resetFake();
  quiet();
  fake.responses["nxis_bulk_autofill"] = (a) =>
    a["mode"] === "plan"
      ? { mode: "plan", resource_count: 240, site_total: 240, credits_remaining: 5000, existing: a["existing"] ?? "generate" }
      : { mode: "submit", started: true, batch_id: "batch-1" };
  fake.responses["nxis_publish_entities"] = (a) => ({ dry_run: a["dry_run"] === true, published_count: 12 });
  fake.responses["nxis_bind_mcp_action"] = (a) => ({ changed: true, default_route: { route: a["route"], url: a["webhook_url"] } });
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanFake();
});

type Reply = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };

interface Session {
  client: Client;
  /** Every question the server asked. */
  asked: ElicitRequest["params"][];
  call: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
  close: () => Promise<void>;
}

/**
 * Connects a client to a new server.
 *
 * @param reply - How the person answers; null for a client that declares no elicitation.
 * @param opts - The server's flags.
 */
async function connect(reply: Reply | null, opts: GuardOptions = {}): Promise<Session> {
  const { ctx } = capture({ io: { json: false, note: () => undefined, emit: () => undefined } });
  const connection = new ProvisioningConnection(ctx);
  const server = createServeServer(ctx, connection, opts);
  const client = new Client({ name: "test", version: "0.0.0" }, reply ? { capabilities: { elicitation: {} } } : {});
  const asked: ElicitRequest["params"][] = [];
  if (reply) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked.push(req.params);
      return reply;
    });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    client,
    asked,
    call: async (name, args = {}) => (await client.callTool({ name, arguments: args })) as CallToolResult,
    close: async () => {
      await client.close();
      await server.close();
      await connection.drop();
    },
  };
}

/** @returns The JSON object in a tool result's first text part. */
function body(result: CallToolResult): Record<string, unknown> {
  const text = result.content.find((part) => part.type === "text") as { text: string };
  return JSON.parse(text.text) as Record<string, unknown>;
}

const yes: Reply = { action: "accept", content: { confirm: true } };
const submit = { mode: "submit", existing: "import" };
const called = (tool: string, mode?: string) =>
  toolCalls().filter((c) => c.tool === tool && (mode === undefined || c.args["mode"] === mode));

/** Mutes the server's log lines on stderr. */
function quiet(): void {
  vi.restoreAllMocks();
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}

describe("annotations", () => {
  it("are accurate for every tool, and only a tool that never writes is read-only", async () => {
    const s = await connect(null);
    try {
      const { tools } = await s.client.listTools();
      const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
      expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));

      for (const name of ["nxis_list_sites", "nxis_mcp_settings", "nxis_aio_files", "nxis_list_types", "nxis_query"]) {
        expect(by[name]).toEqual({ readOnlyHint: true, openWorldHint: false });
      }
      // A mode or flag decides between reading and writing: not read-only.
      for (const name of ["nxis_verify_site", "nxis_site_tag", "nxis_crawl_sitemap", "nxis_bulk_autofill", "nxis_publish_entities", "nxis_list_in_app"]) {
        expect(by[name]?.readOnlyHint).toBe(false);
      }
      expect(by["nxis_bulk_autofill"]).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
      expect(by["nxis_publish_entities"]).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
      expect(by["nxis_enable_public_mcp"]).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
      expect(by["nxis_bind_mcp_action"]).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
      expect(by["nxis_list_in_app"]).toMatchObject({ destructiveHint: true, idempotentHint: true });
      expect(by["nxis_create_site"]).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
      expect(by["nxis_verify_site"]).toMatchObject({ destructiveHint: false, openWorldHint: true });
    } finally {
      await s.close();
    }
  });

  it("are set explicitly on every tool that may write", () => {
    for (const tool of TOOLS.filter((t) => t.readOnly !== true)) {
      expect(typeof tool.hints.destructive, tool.name).toBe("boolean");
      expect(typeof tool.hints.idempotent, tool.name).toBe("boolean");
    }
  });
});

describe("a risky call, when the client can ask", () => {
  it("asks with the plan's count and price, and submits on an accept", async () => {
    const s = await connect(yes);
    try {
      const result = await s.call("nxis_bulk_autofill", submit);
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ started: true, batch_id: "batch-1" });
    } finally {
      await s.close();
    }
    expect(s.asked).toHaveLength(1);
    const message = s.asked[0]?.message ?? "";
    expect(message).toContain("example.com");
    expect(message).toContain("spends credits");
    expect(message).toMatch(/Resources\s+240/);
    expect(message).toMatch(/Credits\s+5,000 remaining/);
    expect(message).toContain("Submit 240 resources?");
    expect(message).not.toMatch(/\u001b/);
    expect(s.asked[0]).toMatchObject({ mode: "form", requestedSchema: { required: ["confirm"] } });
    // The plan was read with the same scope, then the submit was sent once.
    expect(called("nxis_bulk_autofill").map((c) => c.args["mode"])).toEqual(["plan", "submit"]);
    expect(called("nxis_bulk_autofill", "plan")[0]?.args).toMatchObject({ existing: "import", site: "site-1" });
  });

  it("refuses on a decline, and sends nothing", async () => {
    const s = await connect({ action: "decline" });
    try {
      const result = await s.call("nxis_bulk_autofill", submit);
      expect(result.isError).toBe(true);
      expect(body(result)).toMatchObject({ ok: false, reason: "declined_by_user", site: "site-1", host: "example.com" });
      expect(String(body(result)["hint"])).toContain("Don't call it again");
    } finally {
      await s.close();
    }
    expect(called("nxis_bulk_autofill", "submit")).toEqual([]);
  });

  it("refuses on a cancel, and sends nothing", async () => {
    const s = await connect({ action: "cancel" });
    try {
      const result = await s.call("nxis_bulk_autofill", submit);
      expect(result.isError).toBe(true);
      expect(body(result)).toMatchObject({ ok: false, reason: "cancelled_by_user" });
    } finally {
      await s.close();
    }
    expect(called("nxis_bulk_autofill", "submit")).toEqual([]);
  });

  it("treats an accept without the box ticked as a decline", async () => {
    const s = await connect({ action: "accept", content: { confirm: false } });
    try {
      const result = await s.call("nxis_publish_entities", {});
      expect(body(result)).toMatchObject({ ok: false, reason: "declined_by_user" });
    } finally {
      await s.close();
    }
    expect(called("nxis_publish_entities").map((c) => c.args["dry_run"])).toEqual([true]);
  });

  it("asks before a publish with how many records would go live", async () => {
    const s = await connect(yes);
    try {
      const result = await s.call("nxis_publish_entities", { schema_type: "Product" });
      expect(result.isError).toBeFalsy();
    } finally {
      await s.close();
    }
    expect(s.asked[0]?.message).toContain("Publish 12 draft Product records on example.com?");
    expect(called("nxis_publish_entities").map((c) => c.args["dry_run"])).toEqual([true, undefined]);
  });

  it("names the webhook's host in the question and in the result", async () => {
    const s = await connect(yes);
    let result: CallToolResult;
    try {
      result = await s.call("nxis_bind_mcp_action", { route: "webhook", webhook_url: "https://hooks.example.net/in?x=1", action: "reserve" });
    } finally {
      await s.close();
    }
    expect(s.asked[0]?.message).toContain("reserve submissions from example.com to a webhook at hooks.example.net");
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ webhook_host: "hooks.example.net" });
    expect(result.content.map((p) => (p as { text: string }).text).join("\n")).toContain(
      "Webhook target host: hooks.example.net",
    );
  });

  it("names the site before turning its MCP server public, or listing it in the app", async () => {
    const s = await connect(yes);
    try {
      expect((await s.call("nxis_enable_public_mcp", {})).isError).toBeFalsy();
      expect((await s.call("nxis_list_in_app", {})).isError).toBeFalsy();
    } finally {
      await s.close();
    }
    expect(s.asked.map((q) => q.message)).toEqual([
      expect.stringContaining("Make the MCP server of example.com public?"),
      expect.stringContaining("List example.com in the NxisAI app"),
    ]);
  });

  it("doesn't ask for a read, a safe direction, or a write that only adds", async () => {
    const s = await connect(yes);
    try {
      for (const [name, args] of [
        ["nxis_bulk_autofill", { mode: "plan" }],
        ["nxis_bulk_autofill", { mode: "status" }],
        ["nxis_publish_entities", { dry_run: true }],
        ["nxis_enable_public_mcp", { enabled: false }],
        ["nxis_list_in_app", { preview: true }],
        ["nxis_list_in_app", { listed: false }],
        ["nxis_bind_mcp_action", { route: "browser" }],
        ["nxis_bind_mcp_action", { enabled: false }],
        ["nxis_create_site", { url: "https://example.com" }],
      ] as const) {
        expect((await s.call(name, args)).isError, name).toBeFalsy();
      }
    } finally {
      await s.close();
    }
    expect(s.asked).toEqual([]);
  });

  it("doesn't ask under --dry-run, which withholds the write anyway", async () => {
    setTrace({ dryRun: true });
    quiet();
    const s = await connect(yes);
    try {
      const result = await s.call("nxis_bulk_autofill", submit);
      expect(body(result)).toMatchObject({ ok: true, dry_run: true });
    } finally {
      await s.close();
    }
    expect(s.asked).toEqual([]);
    expect(called("nxis_bulk_autofill", "submit")).toEqual([]);
  });

  it("checks the arguments before asking", async () => {
    const s = await connect(yes);
    try {
      // The SDK checks the schema before the handler runs; the server checks again before asking.
      const result = await s.call("nxis_bulk_autofill", { mode: "submit", media_type: "html" });
      expect(result.isError).toBe(true);
    } finally {
      await s.close();
    }
    expect(s.asked).toEqual([]);
    expect(toolCalls()).toEqual([]);
  });
});

describe("a risky call, when the client cannot ask", () => {
  it("is refused with what it would do and the terminal command, and nothing is sent", async () => {
    quiet();
    const s = await connect(null);
    try {
      const result = await s.call("nxis_bulk_autofill", submit);
      expect(result.isError).toBe(true);
      const error = body(result);
      expect(error).toMatchObject({ ok: false, reason: "confirmation_unavailable", terminal_command: "nxis autofill submit" });
      expect(String(error["would_do"])).toContain("Submit 240 resources?");
      expect(String(error["hint"])).toContain("--allow-unconfirmed");

      const hook = await s.call("nxis_bind_mcp_action", { route: "webhook", webhook_url: "https://hooks.example.net/x" });
      expect(body(hook)).toMatchObject({ reason: "confirmation_unavailable", webhook_host: "hooks.example.net" });
    } finally {
      await s.close();
    }
    expect(called("nxis_bulk_autofill", "submit")).toEqual([]);
    expect(called("nxis_bind_mcp_action")).toEqual([]);
  });

  it("runs on the client's own approval under --allow-unconfirmed", async () => {
    const s = await connect(null, { allowUnconfirmed: true });
    try {
      const result = await s.call("nxis_bulk_autofill", submit);
      expect(result.isError).toBeFalsy();
      const hook = await s.call("nxis_bind_mcp_action", { route: "webhook", webhook_url: "https://hooks.example.net/x" });
      expect(hook.structuredContent).toMatchObject({ webhook_host: "hooks.example.net" });
    } finally {
      await s.close();
    }
    // No plan is read: nobody is asked.
    expect(called("nxis_bulk_autofill").map((c) => c.args["mode"])).toEqual(["submit"]);
  });

  it("still asks under --allow-unconfirmed when the client can", async () => {
    const s = await connect({ action: "decline" }, { allowUnconfirmed: true });
    try {
      expect(body(await s.call("nxis_enable_public_mcp", {}))).toMatchObject({ reason: "declined_by_user" });
    } finally {
      await s.close();
    }
    expect(s.asked).toHaveLength(1);
  });
});

describe("--read-only", () => {
  it("runs reads, and refuses every call that may write without asking", async () => {
    quiet();
    const s = await connect(yes, { readOnly: true });
    try {
      expect((await s.call("nxis_list_sites")).isError).toBeFalsy();
      expect((await s.call("nxis_bulk_autofill", { mode: "plan" })).isError).toBeFalsy();
      expect((await s.call("nxis_publish_entities", { dry_run: true })).isError).toBeFalsy();
      expect((await s.call("nxis_list_in_app", { preview: true })).isError).toBeFalsy();

      for (const [name, args] of [
        ["nxis_create_site", { url: "https://example.com" }],
        ["nxis_bulk_autofill", submit],
        ["nxis_verify_site", { mode: "check" }],
        ["nxis_enable_public_mcp", { enabled: false }],
      ] as const) {
        const result = await s.call(name, args);
        expect(body(result), name).toMatchObject({ ok: false, reason: "read_only_server", tool: name });
      }
    } finally {
      await s.close();
    }
    expect(s.asked).toEqual([]);
    expect(toolCalls().map((c) => c.tool)).not.toContain("nxis_create_site");
    expect(called("nxis_bulk_autofill", "submit")).toEqual([]);
    expect(called("nxis_verify_site")).toEqual([]);
  });
});
