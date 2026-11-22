/**
 * `nxis mcp public|settings`, `nxis actions bind`, `nxis types` and `nxis query`, against the
 * in-process provisioning and site endpoints.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cmdActionsBind, cmdActionsSwitch } from "../src/commands/actions.js";
import { cmdMcpPublic, cmdMcpSettings, parseSets, parseSettingValue } from "../src/commands/mcp-site.js";
import { cmdQuery, cmdTypes, parseFilter } from "../src/commands/reads.js";
import { CliError, ExitCode } from "../src/errors.js";
import { setTrace } from "../src/trace.js";
import { KEY, capture, cleanFake, fake, resetFake, siteUrl, startFake, stopFake, toolCalls } from "./support/fake-endpoints.js";

const ENDPOINT = "https://example.com/mcp";

beforeAll(startFake);
afterAll(stopFake);
beforeEach(resetFake);
afterEach(() => {
  vi.restoreAllMocks();
  cleanFake();
});

async function caught(fn: () => Promise<unknown>): Promise<CliError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(CliError);
    return err as CliError;
  }
  throw new Error("expected a failure");
}

/** Captures stderr, where the --verbose trace goes. */
function stderr(): string[] {
  const lines: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  return lines;
}

/** Settings as the server reports them, with `over` applied. */
function settings(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    domain: "example.com",
    endpoint: ENDPOINT,
    enabled: true,
    is_public: false,
    listed_in_app: false,
    on_page_agent: false,
    api_key_preview: "…k3y",
    actions_enabled: false,
    default_route: { route: "browser" },
    ...over,
  };
}

describe("mcp public", () => {
  beforeEach(() => {
    fake.responses["nxis_enable_public_mcp"] = (a) => ({
      is_public: a["enabled"] !== false,
      domain: "example.com",
      endpoint: ENDPOINT,
    });
  });

  it("on: turns the server public and prints its endpoint", async () => {
    const { ctx, out } = capture();
    await cmdMcpPublic(ctx, true);
    expect(toolCalls()).toEqual([
      { endpoint: "provisioning", tool: "nxis_enable_public_mcp", args: { enabled: true, site: "site-1" }, key: KEY },
    ]);
    expect(out.json).toEqual({ ok: true, site: "site-1", domain: "example.com", is_public: true, endpoint: ENDPOINT });
    expect(out.text).toContain(`Endpoint  ${ENDPOINT}`);
  });

  it("off: sends enabled false", async () => {
    const { ctx, out } = capture();
    await cmdMcpPublic(ctx, false);
    expect(toolCalls()[0]?.args).toEqual({ enabled: false, site: "site-1" });
    expect(out.json["is_public"]).toBe(false);
    expect(out.text).toContain("no longer public");
  });

  it("is withheld under --dry-run", async () => {
    stderr();
    setTrace({ dryRun: true });
    const { ctx } = capture();
    const err = await caught(() => cmdMcpPublic(ctx, true));
    expect(err.reason).toBe("dry_run");
    expect(toolCalls()).toEqual([]);
  });
});

describe("mcp settings", () => {
  let current: Record<string, unknown>;
  beforeEach(() => {
    current = settings();
    fake.responses["nxis_mcp_settings"] = () => current;
    fake.responses["nxis_enable_public_mcp"] = (a) => {
      current = { ...current, is_public: a["enabled"] };
      return { is_public: a["enabled"], domain: "example.com", endpoint: ENDPOINT };
    };
    fake.responses["nxis_list_in_app"] = (a) => {
      current = { ...current, listed_in_app: a["listed"] };
      return { listed_in_app: a["listed"] };
    };
    fake.responses["nxis_on_page_agent"] = (a) => {
      current = { ...current, on_page_agent: a["enabled"] };
      return { on_page_agent: a["enabled"] };
    };
  });

  it("shows the settings", async () => {
    current = settings({
      actions_enabled: true,
      default_route: { route: "webhook", url: "https://hooks.example.com/in", method: "POST", signing_secret_preview: "…abc" },
      overrides: { reserve: { route: "browser" } },
    });
    const { ctx, out } = capture();
    await cmdMcpSettings(ctx);
    expect(toolCalls().map((c) => c.tool)).toEqual(["nxis_mcp_settings"]);
    expect(out.json).toEqual({ ok: true, site: "site-1", settings: current });
    expect(out.text).toContain("Default route    webhook POST https://hooks.example.com/in, signed with …abc");
    expect(out.text).toContain("reserve");
  });

  it("says when the site was never set up, and that the values are the defaults", async () => {
    current = { ...settings(), configured: false, enabled: false, is_public: false };
    const { ctx, out } = capture();
    await cmdMcpSettings(ctx);
    expect(out.json).toMatchObject({ ok: true, settings: { configured: false } });
    expect(out.text).toContain("Not set up yet, so these are the defaults");
    expect(out.text).toContain("nxis mcp public on");
  });

  it("--set writes each setting with the tool that owns it, then reads them back", async () => {
    const { ctx, out } = capture();
    await cmdMcpSettings(ctx, { set: ["public=true", "listed_in_app=yes", "on_page_agent=on"] });
    expect(toolCalls().map((c) => [c.tool, c.args])).toEqual([
      ["nxis_mcp_settings", { site: "site-1" }],
      ["nxis_enable_public_mcp", { enabled: true, site: "site-1" }],
      ["nxis_list_in_app", { listed: true, site: "site-1" }],
      ["nxis_on_page_agent", { enabled: true, site: "site-1" }],
      ["nxis_mcp_settings", { site: "site-1" }],
    ]);
    expect(out.json["changed"]).toEqual([
      { key: "public", value: true, tool: "nxis_enable_public_mcp" },
      { key: "listed_in_app", value: true, tool: "nxis_list_in_app" },
      { key: "on_page_agent", value: true, tool: "nxis_on_page_agent" },
    ]);
    expect(out.json["settings"]).toMatchObject({ is_public: true, listed_in_app: true, on_page_agent: true });
  });

  it("--set changes only what differs", async () => {
    current = settings({ is_public: true });
    const { ctx, out } = capture();
    await cmdMcpSettings(ctx, { set: ["is_public=true"] });
    expect(toolCalls().map((c) => c.tool)).toEqual(["nxis_mcp_settings"]);
    expect(out.json["changed"]).toEqual([]);
    expect(out.json["unchanged"]).toEqual([{ key: "public", value: true }]);
  });

  it("--set under --dry-run reads, and reports the writes it withheld", async () => {
    stderr();
    setTrace({ dryRun: true });
    const { ctx, out } = capture();
    await cmdMcpSettings(ctx, { set: ["public=false", "on_page_agent=true"] });
    expect(toolCalls().map((c) => c.tool)).toEqual(["nxis_mcp_settings"]);
    expect(out.json["dry_run"]).toBe(true);
    expect(out.json["would_change"]).toEqual([
      { key: "on_page_agent", value: true, tool: "nxis_on_page_agent", arguments: { enabled: true, site: "site-1" } },
    ]);
  });

  it("refuses an unknown key or a non-boolean value before sending anything", async () => {
    const { ctx } = capture();
    const unknown = await caught(() => cmdMcpSettings(ctx, { set: ["default_route=webhook"] }));
    expect(unknown.reason).toBe("invalid_input");
    expect(unknown.message).toContain("nxis actions bind");
    expect(unknown.details["settable"]).toEqual(["public", "listed_in_app", "on_page_agent"]);
    expect((await caught(() => cmdMcpSettings(ctx, { set: ["public=maybe"] }))).reason).toBe("invalid_input");
    expect((await caught(() => cmdMcpSettings(ctx, { set: ["public"] }))).reason).toBe("invalid_input");
    expect(fake.calls).toEqual([]);
  });

  it("parses values sensibly", () => {
    expect(["true", "ON", "yes", "1"].map(parseSettingValue)).toEqual([true, true, true, true]);
    expect(["false", "off", "No", "0"].map(parseSettingValue)).toEqual([false, false, false, false]);
    expect(parseSettingValue("42")).toBe(42);
    expect(parseSettingValue("text")).toBe("text");
    expect(parseSets(["listed=false"]).map((c) => [c.key, c.value])).toEqual([["listed_in_app", false]]);
  });
});

describe("actions bind", () => {
  beforeEach(() => {
    fake.responses["nxis_bind_mcp_action"] = (a) => {
      if (a["route"] === "gateway") {
        return { changed: false, next: "Gateways are configured in the dashboard, Action Binding tab." };
      }
      const binding =
        a["route"] === "webhook"
          ? { route: "webhook", url: a["webhook_url"], method: "POST", signing_secret_preview: "…123" }
          : { route: "browser" };
      return {
        ...settings({ actions_enabled: true }),
        ...(a["action"] ? { overrides: { [a["action"] as string]: binding } } : { default_route: binding }),
        note: a["action"] ? `Set for ${String(a["action"])} only.` : "Set as the default route for every action.",
      };
    };
  });

  it("--self-page routes the default to the page that hosts the action", async () => {
    const { ctx, out } = capture();
    await cmdActionsBind(ctx, { action: "default", selfPage: true });
    expect(toolCalls()[0]?.args).toEqual({ route: "browser", site: "site-1" });
    expect(out.json).toMatchObject({ ok: true, action: "default", route: "browser", binding: { route: "browser" } });
    expect(out.json).not.toHaveProperty("signing_secret");
    expect(out.text).toContain("Every action now goes to the page that hosts the action.");
  });

  // --webhook and --connection go through the site's connections: see connections-commands.test.ts.

  it("an unverified site is exit 2 with site_not_verified, and says how to verify it", async () => {
    fake.errors["nxis_bind_mcp_action"] =
      "nxis_bind_mcp_action failed (FAILED_PRECONDITION): Site must be verified before its actions can be bound.";
    const { ctx } = capture();
    const err = await caught(() => cmdActionsBind(ctx, { action: "quote", selfPage: true }));
    expect(err.reason).toBe("site_not_verified");
    expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
    expect(err.message).toContain("nxis sites verify --check");
    expect(err.details).toMatchObject({ site: "site-1", action: "quote", route: "browser" });
  });

  it("the tool's reason decides over its words: SITE_NOT_VERIFIED is site_not_verified, another reason is not", async () => {
    fake.errors["nxis_bind_mcp_action"] = JSON.stringify({ message: "Prove you own the domain first.", reason: "SITE_NOT_VERIFIED" });
    const { ctx } = capture();
    const err = await caught(() => cmdActionsBind(ctx, { action: "quote", selfPage: true }));
    expect(err.reason).toBe("site_not_verified");
    expect(err.exitCode).toBe(ExitCode.NEEDS_USER);

    fake.errors["nxis_bind_mcp_action"] = JSON.stringify({ message: "Site must be verified, and the gateway set up.", reason: "GATEWAY_NOT_SET_UP" });
    const other = await caught(() => cmdActionsBind(ctx, { action: "quote", selfPage: true }));
    expect(other.reason).toBe("tool_error");
  });

  it("--gateway relays what the server needs, as exit 2", async () => {
    const { ctx } = capture();
    const err = await caught(() => cmdActionsBind(ctx, { action: "default", gateway: true }));
    expect(toolCalls()[0]?.args).toEqual({ route: "gateway", site: "site-1" });
    expect(err.reason).toBe("bind_incomplete");
    expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
    expect(err.message).toContain("dashboard");
  });

  it("refuses a bad action, a bad URL, and no destination or two, before sending anything", async () => {
    const { ctx } = capture();
    for (const args of [
      { action: "teleport", selfPage: true },
      { selfPage: true },
      { action: "default" },
      { action: "default", selfPage: true, gateway: true },
      { action: "default", webhook: "ftp://example.com" },
      { action: "default", webhook: "not a url" },
    ]) {
      expect((await caught(() => cmdActionsBind(ctx, args))).reason).toBe("invalid_input");
    }
    expect(fake.calls).toEqual([]);
  });

  it("is withheld under --dry-run", async () => {
    stderr();
    setTrace({ dryRun: true });
    const { ctx } = capture();
    expect((await caught(() => cmdActionsBind(ctx, { action: "default", selfPage: true }))).reason).toBe("dry_run");
    expect(toolCalls()).toEqual([]);
  });
});

describe("actions on|off", () => {
  const WEBHOOK = { route: "webhook", url: "https://hooks.example.com/in", method: "POST", signing_secret_preview: "…abc" };
  /** The site's settings, as the server holds them; null for a site with none. */
  let held: Record<string, unknown> | null;
  beforeEach(() => {
    held = settings({ actions_enabled: true, default_route: WEBHOOK, overrides: { quote: { route: "browser" } } });
    // The server's switch: `enabled` alone changes actions_enabled and nothing else.
    fake.responses["nxis_bind_mcp_action"] = (a) => {
      const on = a["enabled"] as boolean;
      if (!held) {
        return on
          ? { changed: false, next: "No route is bound yet, so there is nowhere to send submissions. Bind one first." }
          : { changed: false, configured: false, actions_enabled: false, note: "The site has no MCP settings yet." };
      }
      if (on && !held["default_route"] && !held["overrides"]) {
        return { changed: false, next: "No route is bound yet, so there is nowhere to send submissions. Bind one first." };
      }
      const changed = held["actions_enabled"] !== on;
      held = { ...held, actions_enabled: on };
      return { ...held, changed, note: on ? "Actions are on. Routes are unchanged." : "Actions are off. Routes are kept." };
    };
  });

  it("off sends enabled alone, and keeps every route", async () => {
    const { ctx, out } = capture();
    await cmdActionsSwitch(ctx, false);
    expect(toolCalls()).toEqual([
      { endpoint: "provisioning", tool: "nxis_bind_mcp_action", args: { enabled: false, site: "site-1" }, key: KEY },
    ]);
    expect(out.json).toEqual({
      ok: true,
      site: "site-1",
      enabled: false,
      changed: true,
      configured: true,
      actions_enabled: false,
      default_route: WEBHOOK,
      overrides: { quote: { route: "browser" } },
      note: "Actions are off. Routes are kept.",
    });
    expect(out.text).toContain("Actions are off for site-1");
    expect(out.text).toContain("nxis actions on");
  });

  it("on turns them back on with the same routes, and no secret", async () => {
    held = { ...(held as Record<string, unknown>), actions_enabled: false };
    const { ctx, out } = capture();
    await cmdActionsSwitch(ctx, true);
    expect(toolCalls()[0]?.args).toEqual({ enabled: true, site: "site-1" });
    expect(out.json).toMatchObject({ ok: true, enabled: true, changed: true, actions_enabled: true, default_route: WEBHOOK });
    expect(out.json).not.toHaveProperty("signing_secret");
  });

  it("says so when actions are already in that state", async () => {
    const { ctx, out } = capture();
    await cmdActionsSwitch(ctx, true);
    expect(out.json).toMatchObject({ ok: true, changed: false, actions_enabled: true });
    expect(out.text).toContain("already on");
  });

  it("off on a site with no settings is already off, and succeeds", async () => {
    held = null;
    const { ctx, out } = capture();
    await cmdActionsSwitch(ctx, false);
    expect(out.json).toMatchObject({ ok: true, changed: false, configured: false, actions_enabled: false });
    expect(out.text).toContain("no MCP settings");
  });

  it("on with nothing bound is exit 2, nothing_bound, with the server's next", async () => {
    for (const state of [null, settings({ actions_enabled: false, default_route: undefined })]) {
      held = state;
      const { ctx } = capture();
      const err = await caught(() => cmdActionsSwitch(ctx, true));
      expect(err.reason).toBe("nothing_bound");
      expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
      expect(err.message).toContain("nxis actions bind default --self-page");
      expect(err.message).not.toContain("this tool");
      expect(err.details).toMatchObject({ site: "site-1", enabled: true, next: expect.stringContaining("Bind one first") });
    }
  });

  it("an unverified site is exit 2 with site_not_verified", async () => {
    fake.errors["nxis_bind_mcp_action"] =
      "nxis_bind_mcp_action failed (FAILED_PRECONDITION): Site must be verified before its actions can be bound.";
    const { ctx } = capture();
    const err = await caught(() => cmdActionsSwitch(ctx, false));
    expect(err.reason).toBe("site_not_verified");
    expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
    expect(err.details).toMatchObject({ site: "site-1", enabled: false });
  });

  it("says when an older server also reset the default route", async () => {
    // A server that predates the switch binds the page as the default and answers with no `changed`.
    fake.responses["nxis_bind_mcp_action"] = () => ({ ...settings({ actions_enabled: false }), note: "Set as the default route for every action." });
    const { ctx } = capture();
    const err = await caught(() => cmdActionsSwitch(ctx, false));
    expect(err.reason).toBe("route_reset");
    expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
    expect(err.message).toContain("nxis actions bind default");
    expect(err.details).toMatchObject({ actions_enabled: false, default_route: { route: "browser" } });
  });

  it("both are withheld under --dry-run", async () => {
    stderr();
    setTrace({ dryRun: true });
    const { ctx } = capture();
    for (const on of [true, false]) {
      const err = await caught(() => cmdActionsSwitch(ctx, on));
      expect(err.reason).toBe("dry_run");
      expect(err.exitCode).toBe(ExitCode.OK);
    }
    expect(toolCalls()).toEqual([]);
  });
});

describe("types", () => {
  beforeEach(() => {
    fake.responses["nxis_list_types"] = () => ({
      types: [
        { name: "Product", group: "Product", count: 128 },
        { name: "Store", group: "Organization", count: 1 },
      ],
      total: 2,
      truncated: false,
    });
  });

  it("reads the site's own endpoint, with no key and no site", async () => {
    const { ctx, out } = capture();
    await cmdTypes(ctx);
    expect(toolCalls()).toEqual([{ endpoint: "site", tool: "nxis_list_types", args: {}, key: undefined }]);
    expect(out.json).toEqual({
      ok: true,
      endpoint: siteUrl(),
      types: [
        { name: "Product", group: "Product", count: 128 },
        { name: "Store", group: "Organization", count: 1 },
      ],
      total: 2,
      truncated: false,
    });
    expect(out.text).toMatch(/Product\s+128/);
  });

  it("says when the site serves nothing yet", async () => {
    fake.responses["nxis_list_types"] = () => ({ types: [], total: 0 });
    const { ctx, out } = capture();
    await cmdTypes(ctx, { limit: 5 });
    expect(toolCalls()[0]?.args).toEqual({ limit: 5 });
    expect(out.text).toContain("serves no records yet");
  });

  it("fails with site_mcp_not_public for a private server", async () => {
    fake.siteMcp = { enabled: true, is_public: false };
    const { ctx } = capture();
    const err = await caught(() => cmdTypes(ctx));
    expect(err.reason).toBe("site_mcp_not_public");
    expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
    expect(err.message).toContain("nxis mcp public on");
    expect(toolCalls()).toEqual([]);
  });

  for (const status of [401, 403]) {
    it(`fails with site_mcp_not_public, not key_refused, when the site's endpoint answers ${status}`, async () => {
      // The site's settings say public, but its endpoint refuses a request without a key.
      fake.siteStatus = status;
      const { ctx } = capture();
      const err = await caught(() => cmdTypes(ctx));
      expect(err.reason).toBe("site_mcp_not_public");
      expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
      expect(err.message).toContain("nxis mcp public on");
      expect(err.message).not.toContain("nxis login");
      expect(err.details).toEqual({ status, endpoint: siteUrl() });
    });
  }

  it("fails with site_mcp_off for a site with no MCP server", async () => {
    fake.siteMcp = null;
    const { ctx } = capture();
    expect((await caught(() => cmdTypes(ctx))).reason).toBe("site_mcp_off");
  });

  it("still runs under --dry-run, since it only reads", async () => {
    stderr();
    setTrace({ dryRun: true });
    const { ctx, out } = capture();
    await cmdTypes(ctx);
    expect(out.json["total"]).toBe(2);
  });
});

describe("query", () => {
  beforeEach(() => {
    fake.responses["nxis_query"] = () => ({
      results: [{ "@id": "https://example.com/p/1#product", "@type": "Product", name: "Tent" }],
      total: 3,
      matched_types: ["Product"],
      next_page_token: "tok-2",
    });
  });

  it("sends the type, filters and limit to the site's endpoint", async () => {
    const { ctx, out } = capture();
    await cmdQuery(ctx, {
      type: "Product",
      filters: ["offers.price=lt:100", "brand.name=eq:Acme", "areaServed.postalCode=eq:\"48067\"", "color=in:red,blue", "sku=exists"],
      limit: 1,
      exact: true,
    });
    expect(toolCalls()).toEqual([
      {
        endpoint: "site",
        tool: "nxis_query",
        key: undefined,
        args: {
          limit: 1,
          filter: {
            schema_type: "Product",
            exact_type_match: true,
            field_filters: [
              { path: "offers.price", operator: "LESS_THAN", value: 100 },
              { path: "brand.name", operator: "EQUALS", value: "Acme" },
              { path: "areaServed.postalCode", operator: "EQUALS", value: "48067" },
              { path: "color", operator: "IN", value: ["red", "blue"] },
              { path: "sku", operator: "EXISTS" },
            ],
          },
        },
      },
    ]);
    expect(out.json).toEqual({
      ok: true,
      endpoint: siteUrl(),
      type: "Product",
      total: 3,
      results: [{ "@id": "https://example.com/p/1#product", "@type": "Product", name: "Tent" }],
      matched_types: ["Product"],
      next_page_token: "tok-2",
      filter_types: {},
    });
    expect(out.text).toContain("1 of 3 Product record");
    expect(out.text).toContain("--page-token tok-2");
  });

  it("notes that --text is a billed semantic search", async () => {
    const { ctx, out } = capture();
    await cmdQuery(ctx, { type: "Product", text: "waterproof tent", pageToken: "tok-2" });
    expect(toolCalls()[0]?.args).toEqual({ filter: { schema_type: "Product" }, text: "waterproof tent", page_token: "tok-2" });
    expect(out.notes.join("")).toContain("billed");
  });

  it("refuses a missing type or a bad filter before sending anything", async () => {
    const { ctx } = capture();
    expect((await caught(() => cmdQuery(ctx, {}))).reason).toBe("invalid_input");
    for (const f of ["noequals", "price=between:1", "price=gt:cheap", "price=eq"]) {
      expect((await caught(() => cmdQuery(ctx, { type: "Product", filters: [f] }))).reason).toBe("invalid_input");
    }
    expect(fake.calls).toEqual([]);
  });

  it("fails with site_mcp_not_public for a private server", async () => {
    fake.siteMcp = { enabled: true, is_public: false };
    const { ctx } = capture();
    expect((await caught(() => cmdQuery(ctx, { type: "Product" }))).reason).toBe("site_mcp_not_public");
  });

  it("fails with site_mcp_not_public when the site's endpoint refuses it", async () => {
    fake.siteStatus = 401;
    const { ctx } = capture();
    const err = await caught(() => cmdQuery(ctx, { type: "Product" }));
    expect(err.reason).toBe("site_mcp_not_public");
    expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
  });

  describe("equality values follow the field's stored type", () => {
    /** Answers the probe (the field EXISTS, a few records) with `sample`, and the query with nothing. */
    function storedAs(sample: Record<string, unknown>[]): void {
      fake.responses["nxis_query"] = (args) => (isProbe(args) ? { results: sample, total: sample.length } : { results: [], total: 0 });
    }
    function isProbe(args: Record<string, unknown>): boolean {
      const ff = (args["filter"] as { field_filters?: { operator: string }[] }).field_filters ?? [];
      return ff.length === 1 && ff[0]?.operator === "EXISTS" && args["limit"] === 5;
    }
    const probes = () => toolCalls().filter((c) => isProbe(c.args));
    /** The field filters of the real query, the last call. */
    const sent = () => (toolCalls().at(-1)?.args["filter"] as { field_filters: unknown[] }).field_filters;

    it("sends a ZIP code stored as text as text, leading zero kept", async () => {
      storedAs([{ address: { postalCode: "48067" } }, { address: [{ postalCode: "02134" }] }]);
      const { ctx, out } = capture();
      await cmdQuery(ctx, { type: "Place", filters: ["address.postalCode=eq:02134"] });
      expect(probes().map((c) => c.args)).toEqual([
        { filter: { schema_type: "Place", field_filters: [{ path: "address.postalCode", operator: "EXISTS" }] }, limit: 5 },
      ]);
      expect(sent()).toEqual([{ path: "address.postalCode", operator: "EQUALS", value: "02134" }]);
      expect(out.json["filter_types"]).toEqual({ "address.postalCode": "string" });
    });

    it("sends a ratingValue stored as a number as a number", async () => {
      storedAs([{ aggregateRating: { ratingValue: 4.5 } }, { aggregateRating: { ratingValue: 5 } }]);
      const { ctx, out } = capture();
      await cmdQuery(ctx, { type: "Product", filters: ["aggregateRating.ratingValue=ne:5"], exact: true });
      expect(probes()[0]?.args["filter"]).toMatchObject({ exact_type_match: true });
      expect(sent()).toEqual([{ path: "aggregateRating.ratingValue", operator: "NOT_EQUALS", value: 5 }]);
      expect(out.json["filter_types"]).toEqual({ "aggregateRating.ratingValue": "number" });
    });

    it("sends text when the sample mixes numbers and text", async () => {
      storedAs([{ aggregateRating: { ratingValue: 4.5 } }, { aggregateRating: { ratingValue: "5" } }]);
      const { ctx, out } = capture();
      await cmdQuery(ctx, { type: "Product", filters: ["aggregateRating.ratingValue=eq:5"] });
      expect(sent()).toEqual([{ path: "aggregateRating.ratingValue", operator: "EQUALS", value: "5" }]);
      expect(out.json["filter_types"]).toEqual({ "aggregateRating.ratingValue": "string" });
    });

    it("keeps the number when no record has the field, and says so under --verbose", async () => {
      const err = stderr();
      setTrace({ verbose: true });
      storedAs([]);
      const { ctx, out } = capture();
      await cmdQuery(ctx, { type: "Place", filters: ["address.postalCode=eq:48067"] });
      expect(sent()).toEqual([{ path: "address.postalCode", operator: "EQUALS", value: 48067 }]);
      expect(out.json["filter_types"]).toEqual({ "address.postalCode": "unknown" });
      expect(err.join("")).toContain("address.postalCode: 0 Place records sampled, none settles how it is stored");
    });

    it("always sends a quoted value as text, without a probe", async () => {
      storedAs([{ address: { postalCode: 48067 } }]);
      const { ctx, out } = capture();
      await cmdQuery(ctx, { type: "Place", filters: ['address.postalCode=eq:"48067"'] });
      expect(probes()).toEqual([]);
      expect(sent()).toEqual([{ path: "address.postalCode", operator: "EQUALS", value: "48067" }]);
      expect(out.json["filter_types"]).toEqual({});
    });

    it("sends no probe for a range operator", async () => {
      storedAs([{ aggregateRating: { ratingValue: "4.5" } }]);
      const { ctx } = capture();
      await cmdQuery(ctx, { type: "Product", filters: ["aggregateRating.ratingValue=gte:4"] });
      expect(toolCalls()).toHaveLength(1);
      expect(sent()).toEqual([{ path: "aggregateRating.ratingValue", operator: "GREATER_THAN_OR_EQUAL", value: 4 }]);
    });

    it("types each IN value, probing each field once", async () => {
      storedAs([{ address: { postalCode: "48067" }, isAccessibleForFree: true }]);
      const { ctx, out } = capture();
      await cmdQuery(ctx, {
        type: "Place",
        filters: ['address.postalCode=in:48067, 48068,"x"', "address.postalCode=ne:48069", "isAccessibleForFree=eq:true"],
      });
      expect(probes()).toHaveLength(2);
      expect(sent()).toEqual([
        { path: "address.postalCode", operator: "IN", value: ["48067", "48068", "x"] },
        { path: "address.postalCode", operator: "NOT_EQUALS", value: "48069" },
        { path: "isAccessibleForFree", operator: "EQUALS", value: true },
      ]);
      expect(out.json["filter_types"]).toEqual({ "address.postalCode": "string", isAccessibleForFree: "boolean" });
    });

    it("types IN values as numbers for a number field", async () => {
      storedAs([{ aggregateRating: { ratingValue: 4 } }]);
      const { ctx } = capture();
      await cmdQuery(ctx, { type: "Product", filters: ["aggregateRating.ratingValue=in:4,5"] });
      expect(sent()).toEqual([{ path: "aggregateRating.ratingValue", operator: "IN", value: [4, 5] }]);
    });
  });

  it("parses operator names and their short forms", () => {
    expect(parseFilter("a=GREATER_THAN_OR_EQUAL:4.5")).toEqual({ path: "a", operator: "GREATER_THAN_OR_EQUAL", value: 4.5 });
    expect(parseFilter("a=gte:4.5")).toEqual(parseFilter("a=GREATER_THAN_OR_EQUAL:4.5"));
    expect(parseFilter("a=ne:true")).toEqual({ path: "a", operator: "NOT_EQUALS", value: true });
    expect(parseFilter("a=contains:42")).toEqual({ path: "a", operator: "CONTAINS", value: "42" });
    expect(parseFilter("startDate=gt:2026-01-01")).toEqual({ path: "startDate", operator: "GREATER_THAN", value: "2026-01-01" });
    expect(parseFilter("url=eq:https://example.com/a:b")).toEqual({ path: "url", operator: "EQUALS", value: "https://example.com/a:b" });
  });
});
