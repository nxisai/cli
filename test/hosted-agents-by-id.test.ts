/**
 * `nxis agents catalog` and `enable|configure|disable|pause|resume <id>`, against an in-process
 * sites service that serves hosted agents by catalog id as the gateway prints them: snake_case,
 * enums as names, int64 as strings, defaults left out, and `settings` and `metadata` keys as data.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { camelKeys } from "../src/api/agent-config.js";
import { runHostedAgents } from "../src/commands/hosted-agents.js";
import { CliError } from "../src/errors.js";
import { capture, cleanFake, fake, ORG, resetFake, startFake, stopFake, type AuthSeen } from "./support/fake-endpoints.js";

const SITE = "0123456789abcdef01234567";
const BASE = `/v1/organizations/${ORG}/sites/${SITE}`;

type Json = Record<string, unknown>;

/** The setup blocks, as the service writes them. */
const MODEL = {
  name: "model",
  type: "SETTING_MODEL",
  label: "Model",
  group: "basics",
  allowed_values: [
    { value: "claude-haiku-5-5", label: "Claude Haiku 5.5", is_default: true },
    { value: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { value: "claude-old", label: "Old", retired: true },
  ],
  default_value: "claude-haiku-5-5",
};
const LABEL = { name: "label", type: "SETTING_STRING", label: "Name visitors see", required: true, max_length: 100, group: "basics" };
const DESCRIPTION = { name: "description", type: "SETTING_TEXT", label: "Description", max_length: 300, group: "basics" };
const EXAMPLES = { name: "examples", type: "SETTING_STRING_LIST", label: "Example questions", max_items: 10, item_max_length: 200, flag: "example", group: "basics" };
const VERIFIED = { id: "site_verified", kind: "PREREQUISITE_SITE_VERIFIED", enforcement: "ENFORCED_ON_SERVE", label: "A verified site" };
const DPA = { id: "dpa", kind: "PREREQUISITE_DPA", enforcement: "ENFORCED_ON_SERVE", label: "The data processing agreement" };

const SETUPS: Record<string, Json> = {
  page: { settings: [MODEL], prerequisites: [VERIFIED, DPA], pausable: true },
  support: {
    settings: [MODEL, LABEL, DESCRIPTION, EXAMPLES, { name: "advice_line", type: "SETTING_TEXT", label: "Advice line", max_length: 300, flag: "advice-line" }],
    prerequisites: [{ id: "mcp_server", kind: "PREREQUISITE_MCP_SERVER", enforcement: "ENFORCED_ON_SERVE", label: "Your site's MCP server" }, VERIFIED, DPA],
    pausable: true,
  },
  quote: {
    settings: [MODEL, LABEL, DESCRIPTION, EXAMPLES],
    prerequisites: [
      { id: "records", kind: "PREREQUISITE_RECORDS", enforcement: "ENFORCED_ON_ENABLE", label: "Prices on your site", record_types: ["Offer", "AggregateOffer"], priced_types: ["Service", "Product"] },
      { id: "connection", kind: "PREREQUISITE_CONNECTION", enforcement: "ENFORCED_ON_ENABLE", label: "A connection to your website", action_types: ["QuoteAction", "AskAction"] },
      VERIFIED,
      DPA,
    ],
    pausable: true,
  },
  booking: {
    settings: [
      MODEL,
      LABEL,
      DESCRIPTION,
      EXAMPLES,
      {
        name: "availability",
        type: "SETTING_ENUM",
        label: "Availability",
        group: "booking",
        allowed_values: [{ value: "auto", is_default: true }, { value: "opening_hours" }, { value: "binding_list" }],
      },
      { name: "slot_minutes", type: "SETTING_INTEGER", label: "Slot length", min: "15", max: "480", zero_is_default: true, default_value: 120, flag: "slot-minutes", group: "booking" },
      { name: "lead_minutes", type: "SETTING_INTEGER", label: "Lead time", min: "0", max: "10080", flag: "lead-minutes", group: "booking" },
    ],
    prerequisites: [
      { id: "records", kind: "PREREQUISITE_RECORDS", enforcement: "ENFORCED_ON_ENABLE", record_types: ["Service"] },
      { id: "connection", kind: "PREREQUISITE_CONNECTION", enforcement: "ENFORCED_ON_ENABLE", action_types: ["ScheduleAction", "ReserveAction"] },
      VERIFIED,
      DPA,
    ],
    pausable: true,
  },
  // An agent this CLI has never heard of.
  events: {
    settings: [{ name: "venue", type: "SETTING_STRING", label: "Venue", max_length: 80, required: true }],
    prerequisites: [VERIFIED, DPA],
    pausable: true,
  },
};

const NAMES: Record<string, string> = { page: "On-page assistant", support: "Support", quote: "Quote", booking: "Booking", events: "Events" };

/** Each agent as stored: on or off, settings by name, pause. */
let agents: Record<string, { enabled: boolean; settings: Json; kill?: Json }>;
let version: number;
/** How the fake names fields (never `settings` or `metadata` keys). */
let style: "snake" | "camel";
/** Answers for the next writes, in order, instead of applying them. */
let refusals: Array<{ status: number; body: Json }>;
/** Whether the service has the hosted agent routes. */
let hostedRoutes: boolean;
/** The site's connections. */
let connections: string[];
/** State per agent while on; defaults to live. */
let stateOf: Record<string, { state: string; reason?: string; message?: string }>;

function snakeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Json).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), snakeKeys(v)]),
    );
  }
  return value;
}

/** In the fake's style, except the data keys, which go as stored. */
function styled(body: Json, data: { settings?: Json }): Json {
  const out = (style === "camel" ? camelKeys(body) : body) as Json;
  if (data.settings) out["settings"] = data.settings;
  return out;
}

function hostedAgent(id: string): Json {
  const a = agents[id] ?? { enabled: false, settings: {} };
  const s = a.enabled ? (stateOf[id] ?? { state: "HOSTED_AGENT_LIVE" }) : { state: "HOSTED_AGENT_OFF" };
  const body: Json = {
    name: `organizations/${ORG}/sites/${SITE}/hostedAgents/${id}`,
    agent: id,
    display_name: NAMES[id],
    ...(a.enabled ? { enabled: true } : {}),
    state: s.state,
    ...(s.reason ? { state_reason: s.reason, state_message: s.message } : {}),
    prerequisites: [
      { id: "site_verified", kind: "PREREQUISITE_SITE_VERIFIED", enforcement: "ENFORCED_ON_SERVE", met: true },
      ...(id === "quote" && connections.length === 0
        ? [{ id: "connection", kind: "PREREQUISITE_CONNECTION", enforcement: "ENFORCED_ON_ENABLE", reason: "CONNECTION_REQUIRED", message: "Choose a connection.", metadata: { agent: "quote", action_types: "QuoteAction,AskAction" } }]
        : []),
    ],
    ...(a.kill ? { kill_switch: a.kill, effective_kill_switch: a.kill } : {}),
    setup: SETUPS[id],
    config_version: String(version),
  };
  return styled(body, { settings: a.settings });
}

const err = (code: number, status: number, reason: string, metadata: Json, message = "refused") => ({
  status,
  body: { code, message, details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "nxis.ai", metadata }] },
});

/** Merges settings as the service does: `null` clears one. */
function merge(stored: Json, change: Json | undefined): Json {
  const out = { ...stored };
  for (const [k, v] of Object.entries(change ?? {})) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

function catalogEntry(id: string): Json {
  return {
    entry: { id, name: NAMES[id] ?? id, job: id === "booking" ? "bookings" : "answers", readiness: id === "jobs" ? "coming_soon" : "available", hosted: id !== "jobs", ...(SETUPS[id] ? { setup: SETUPS[id] } : {}) },
    fit: id === "quote" ? 80 : 40,
    ...(id === "quote" ? { missing: "Works better with: Product" } : {}),
    ...(agents[id]?.enabled ? { added: true } : {}),
    state: agents[id]?.enabled ? "HOSTED_AGENT_LIVE" : "HOSTED_AGENT_OFF",
    prerequisites: id === "quote" && connections.length === 0 ? [{ id: "connection", reason: "CONNECTION_REQUIRED", metadata: { action_types: "QuoteAction,AskAction" } }] : [],
  };
}

function service(): void {
  fake.sites = (req: AuthSeen) => {
    const [path = "", query = ""] = req.url.split("?");
    if (path === `${BASE}/agentConfig` && req.method === "GET") {
      return {
        status: 200,
        body: {
          name: `${BASE.slice(4)}/agentConfig`,
          version: String(version),
          page: { enabled: agents["page"]?.enabled ?? false },
          support: { enabled: agents["support"]?.enabled ?? false, label: (agents["support"]?.settings["label"] as string) ?? "" },
        },
      };
    }
    if (path === `${BASE}/agentConfig` && req.method === "PATCH") {
      version++;
      return { status: 200, body: { ...(req.body as Json), version: String(version) } };
    }
    if (path === `${BASE}/connections` && req.method === "GET") {
      return { status: 200, body: { connections: connections.map((name, i) => ({ id: `c${i}`.padEnd(24, "0"), name, url: "https://example.com/hook" })) } };
    }
    if (path === `${BASE}/agentCatalog` && req.method === "GET") {
      return { status: 200, body: { entries: ["quote", "booking", "jobs"].map(catalogEntry), total_size: 3, jobs: [{ value: "answers", count: 2 }] } };
    }
    const entry = path.match(new RegExp(`^${BASE}/agentCatalog/([a-z-]+)$`));
    if (entry) {
      const id = entry[1] as string;
      if (!SETUPS[id] && id !== "jobs") return { status: 404, body: { code: 5, message: "no catalog entry has that id" } };
      return { status: 200, body: catalogEntry(id) };
    }
    if (!hostedRoutes) return { status: 404 };
    if (path === `${BASE}/hostedAgents` && req.method === "GET") {
      return { status: 200, body: { hosted_agents: Object.keys(SETUPS).map(hostedAgent), config_version: String(version), live: true } };
    }
    const m = path.match(new RegExp(`^${BASE}/hostedAgents/([a-z-]+)(:setEnabled)?$`));
    if (!m) return { status: 404 };
    const id = m[1] as string;
    if (id === "jobs") return err(9, 400, "AGENT_NOT_HOSTED", { agent: "jobs", readiness: "coming_soon" });
    if (!SETUPS[id]) return err(5, 404, "AGENT_NOT_FOUND", { agent: id });
    if (req.method === "GET") return { status: 200, body: hostedAgent(id) };
    const next = refusals.shift();
    if (next) return next;
    const body = req.body as Json;
    const current = agents[id] ?? { enabled: false, settings: {} };
    if (m[2] && req.method === "POST") {
      agents[id] = { ...current, enabled: body["enabled"] === true, settings: merge(current.settings, body["settings"] as Json) };
    } else if (req.method === "PATCH") {
      void query;
      const settings = merge(current.settings, body["settings"] as Json);
      const kill = "kill_switch" in body ? (Object.keys((body["kill_switch"] as Json) ?? {}).length ? (body["kill_switch"] as Json) : undefined) : current.kill;
      agents[id] = { ...current, settings, ...(kill ? { kill } : {}) };
      if (!kill) delete agents[id]?.kill;
    } else {
      return { status: 405 };
    }
    version++;
    return { status: 200, body: hostedAgent(id) };
  };
}

async function run(argv: string[]) {
  const { positional, flags } = parseArgs(argv);
  const { ctx, out } = capture({ siteOverride: SITE });
  await runHostedAgents(ctx, positional, flags);
  return out;
}

async function fails(argv: string[], reason: string): Promise<CliError> {
  const e = await run(argv).then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(CliError);
  expect((e as CliError).reason).toBe(reason);
  return e as CliError;
}

const writes = () => fake.sitesCalls.filter((c) => c.method !== "GET");

beforeAll(startFake);
afterAll(stopFake);
beforeEach(() => {
  resetFake();
  process.env.NXIS_TOKEN = "header.payload.sig";
  agents = { support: { enabled: false, settings: { label: "Help" } } };
  version = 42;
  style = "snake";
  refusals = [];
  hostedRoutes = true;
  connections = ["Website"];
  stateOf = {};
  service();
});
afterEach(cleanFake);

describe("nxis agents catalog", () => {
  it("lists every entry with fit, readiness, hosted, missing, added, state and unmet prerequisites", async () => {
    connections = [];
    agents["booking"] = { enabled: true, settings: { label: "Book" } };
    const out = await run(["catalog", "--job", "answers", "--job", "bookings", "--readiness", "available", "--not-added", "--query", "price", "--by-fit"]);
    const url = fake.sitesCalls[0]?.url ?? "";
    expect(url.split("?")[0]).toBe(`${BASE}/agentCatalog`);
    const q = new URLSearchParams(url.split("?")[1]);
    expect(q.getAll("job")).toEqual(["answers", "bookings"]);
    expect(q.get("readiness")).toBe("available");
    expect(q.get("added")).toBe("false");
    expect(q.get("query")).toBe("price");
    expect(q.get("order_by")).toBe("fit");
    expect(out.json).toMatchObject({ ok: true, org: ORG, site: SITE, total: 3, jobs: [{ value: "answers", count: 2 }] });
    expect((out.json["entries"] as Json[])[0]).toEqual({
      id: "quote",
      name: "Quote",
      job: "answers",
      readiness: "available",
      hosted: true,
      fit: 80,
      missing: "Works better with: Product",
      added: false,
      state: "off",
      unmet: ["connection"],
    });
    expect((out.json["entries"] as Json[])[1]).toMatchObject({ id: "booking", added: true, state: "live", unmet: [] });
    expect((out.json["entries"] as Json[])[2]).toMatchObject({ id: "jobs", hosted: false, readiness: "coming_soon" });
    expect(out.text).toContain("quote");
  });

  it("refuses an unknown readiness, and --added with --not-added", async () => {
    await fails(["catalog", "--readiness", "soon"], "invalid_readiness");
    await fails(["catalog", "--added", "--not-added"], "conflicting_flags");
    expect(fake.sitesCalls).toEqual([]);
  });

  it("shows one agent's flags with their limits, what it needs, and the enable line", async () => {
    connections = [];
    const out = await run(["catalog", "quote"]);
    expect(out.json).toMatchObject({ id: "quote", hosted: true, state: "off", enabled: false, settings: {} });
    const flags = out.json["flags"] as Json[];
    expect(flags.map((f) => f["flag"])).toEqual(["--model", "--label", "--description", "--example"]);
    expect(flags[1]).toMatchObject({ setting: "label", type: "string", required: true, max_length: 100 });
    expect(flags[3]).toMatchObject({ setting: "examples", type: "string_list", repeats: true, max_items: 10, item_max_length: 200 });
    expect(flags[0]).toMatchObject({ allowed: ["claude-haiku-5-5", "claude-sonnet-5"], default: "claude-haiku-5-5" });
    expect(out.json["enable"]).toBe('nxis agents enable quote --label "Name visitors see" --connection <name|id>');
    expect(out.json["prerequisites"]).toEqual([
      { id: "site_verified", met: true, reason: null, kind: "site_verified", enforcement: "on_serve", label: "A verified site" },
      {
        id: "connection",
        met: false,
        reason: "connection_required",
        message: "Choose a connection.",
        kind: "connection",
        enforcement: "on_enable",
        label: "A connection to your website",
      },
    ]);
    expect(out.text).toContain("--label <text>");
    expect(out.text).toContain("Turn it on: nxis agents enable quote");
  });

  it("shows an entry NxisAI doesn't host yet, without its settings", async () => {
    const out = await run(["catalog", "jobs"]);
    expect(out.json).toMatchObject({ id: "jobs", hosted: false, flags: [], enable: null });
  });

  it("says unknown_agent for an id the catalog doesn't have", async () => {
    await fails(["catalog", "nope"], "unknown_agent");
  });
});

describe("nxis agents enable <id>", () => {
  it("turns Quote on with a label and a connection in one call", async () => {
    const out = await run(["enable", "quote", "--label", "Get a quote", "--connection", "Website"]);
    expect(writes()).toHaveLength(1);
    expect(writes()[0]?.url).toBe(`${BASE}/hostedAgents/quote:setEnabled`);
    expect(writes()[0]?.body).toEqual({
      name: `organizations/${ORG}/sites/${SITE}/hostedAgents/quote`,
      enabled: true,
      settings: { label: "Get a quote" },
      connection: "Website",
      expected_version: "42",
    });
    expect(out.json).toMatchObject({
      ok: true,
      org: ORG,
      site: SITE,
      changed: true,
      agent: { id: "quote", enabled: true, state: "live", state_reason: null, settings: { label: "Get a quote" }, kill_switch: null, effective_kill_switch: null },
    });
    expect(out.json["page"]).toBeUndefined();
  });

  it("exits 2 with connection_required, listing the site's connections, when the service asks for one", async () => {
    connections = [];
    refusals = [err(9, 400, "CONNECTION_REQUIRED", { agent: "quote", action_types: "QuoteAction,AskAction" })];
    const e = await fails(["enable", "quote", "--label", "Get a quote"], "connection_required");
    expect(e.exitCode).toBe(2);
    expect(e.toJSON()).toMatchObject({ agent: "quote", action_types: ["QuoteAction", "AskAction"], connections: [] });
    expect(e.message).toContain("nxis connections create");

    connections = ["Website", "Booking hook"];
    refusals = [err(9, 400, "CONNECTION_REQUIRED", { agent: "quote", action_types: "QuoteAction,AskAction" })];
    const again = await fails(["enable", "quote", "--label", "Get a quote"], "connection_required");
    expect(again.toJSON()["connections"]).toEqual(["Website", "Booking hook"]);
    expect(again.message).toContain('"Website", "Booking hook"');
  });

  it.each([
    ["RECORDS_MISSING", { agent: "quote", types: "Offer,AggregateOffer", unmet: "records,connection" }, "records_missing", { types: ["Offer", "AggregateOffer"], unmet: ["records", "connection"] }],
    ["ACTIONS_OFF", { agent: "quote" }, "actions_off", { agent: "quote" }],
    ["CONNECTION_UNUSABLE", { agent: "quote", action_type: "QuoteAction", connection_id: "abc" }, "connection_unusable", { action_type: "QuoteAction" }],
    ["CONNECTION_NOT_FOUND", { agent: "quote", connection: "Nope" }, "connection_not_found", { connection: "Nope" }],
    ["OPENING_HOURS_REQUIRED", { agent: "booking", setting: "availability" }, "opening_hours_required", { agent: "booking" }],
  ])("maps %s to %s (exit 2)", async (reason, metadata, cli, details) => {
    refusals = [err(reason === "CONNECTION_NOT_FOUND" ? 5 : 9, reason === "CONNECTION_NOT_FOUND" ? 404 : 400, reason, metadata)];
    const e = await fails(["enable", "quote", "--label", "Q"], cli);
    expect(e.exitCode).toBe(2);
    expect(e.toJSON()).toMatchObject(details);
  });

  it("checks Booking's integer range before sending: invalid_slot_minutes with min and max", async () => {
    const e = await fails(["enable", "booking", "--label", "Book", "--slot-minutes", "10"], "invalid_slot_minutes");
    expect(e.exitCode).toBe(1);
    expect(e.toJSON()).toMatchObject({ flag: "--slot-minutes", rule: "range", min: 15, max: 480 });
    await fails(["enable", "booking", "--label", "Book", "--slot-minutes", "two"], "invalid_slot_minutes");
    await fails(["enable", "booking", "--label", "Book", "--availability", "always"], "invalid_availability");
    await fails(["enable", "booking", "--label", "Book", "--lead-minutes", "-1"], "invalid_lead_minutes");
    expect(writes()).toEqual([]);
    // 0 is the default, which the range allows.
    await run(["enable", "booking", "--label", "Book", "--slot-minutes", "0", "--lead-minutes", "0", "--availability", "opening_hours"]);
    expect((writes()[0]?.body as Json)["settings"]).toEqual({ label: "Book", slot_minutes: 0, lead_minutes: 0, availability: "opening_hours" });
  });

  it("turns on an agent this CLI has never heard of, with the flags its setup names", async () => {
    const out = await run(["enable", "events", "--venue", "Hall A"]);
    expect((writes()[0]?.body as Json)["settings"]).toEqual({ venue: "Hall A" });
    expect(out.json).toMatchObject({ changed: true, agent: { id: "events", enabled: true, settings: { venue: "Hall A" } } });
    await fails(["enable", "events", "--venue", "x".repeat(81)], "venue_too_long");
    await fails(["enable", "events", "--room", "B"], "unknown_flag");
    agents["events"] = { enabled: false, settings: {} };
    await fails(["enable", "events"], "missing_venue");
    await fails(["enable", "events", "--venue", "A", "--connection", "Website"], "unknown_flag");
  });

  it("refuses an 11th --example for any agent with examples at most 10, before sending", async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => ["--example", `q${i}`]).flat();
    for (const id of ["quote", "booking"]) {
      const e = await fails(["enable", id, "--label", "L", ...eleven], "too_many_examples");
      expect(e.toJSON()).toMatchObject({ flag: "--example", limit: 10, count: 11 });
    }
    await fails(["enable", "quote", "--label", "L", "--example", "x".repeat(201)], "example_too_long");
    await fails(["enable", "quote", "--label", "L", "--example", " "], "invalid_example");
    expect(writes()).toEqual([]);
  });

  it("counts lengths in UTF-16 code units, as the service does", async () => {
    // 51 characters, 102 code units: too long for the service's 100.
    const e = await fails(["enable", "quote", "--label", "\u{1F600}".repeat(51), "--connection", "Website"], "label_too_long");
    expect(e.toJSON()).toMatchObject({ limit: 100, length: 102 });
    expect(writes()).toEqual([]);
    // For the Support Agent, as always, before anything is read.
    const before = fake.sitesCalls.length;
    await fails(["enable", "support", "--label", "\u{1F600}".repeat(51)], "label_too_long");
    expect(fake.sitesCalls).toHaveLength(before);
    await run(["enable", "quote", "--label", "\u{1F600}".repeat(50), "--connection", "Website"]);
    expect(writes()).toHaveLength(1);
  });

  it("needs the required settings, merged with what is stored", async () => {
    const e = await fails(["enable", "quote"], "missing_label");
    expect(e.toJSON()).toMatchObject({ flag: "--label", setting: "label" });
    agents["quote"] = { enabled: false, settings: { label: "Prices" } };
    await run(["enable", "quote", "--connection", "Website"]);
    expect((writes()[0]?.body as Json)["settings"]).toBeUndefined();
  });

  it("takes a model the site offers, refuses one it doesn't, and refuses a retired one chosen anew", async () => {
    await fails(["enable", "quote", "--label", "Q", "--model", "gpt"], "invalid_model");
    const e = await fails(["enable", "quote", "--label", "Q", "--model", "claude-old"], "model_retired");
    expect(e.toJSON()).toMatchObject({ model: "claude-old", allowed: ["claude-haiku-5-5", "claude-sonnet-5"] });
    agents["quote"] = { enabled: false, settings: { label: "Q", model: "claude-old" } };
    await run(["enable", "quote", "--model", "claude-old"]);
    expect(writes()).toHaveLength(1);
  });

  it("exits 0 with needs_setup and a next line when a serve-time need is unmet", async () => {
    stateOf = { support: { state: "HOSTED_AGENT_NEEDS_SETUP", reason: "MCP_SERVER_NOT_SET_UP", message: "Set up your MCP server." } };
    const out = await run(["enable", "support"]);
    expect(out.json).toMatchObject({ changed: true, agent: { state: "needs_setup", state_reason: "mcp_server_not_set_up" } });
    expect(out.json["next"]).toContain("MCP server");
    // page and support keep every key their commands always printed.
    expect(out.json).toMatchObject({ version: 43, page: { enabled: false }, support: { enabled: true, label: "Help" } });
  });

  it("sends nothing when the agent is already on with those settings", async () => {
    agents["quote"] = { enabled: true, settings: { label: "Q" } };
    const out = await run(["enable", "quote", "--label", "Q"]);
    expect(out.json).toMatchObject({ changed: false, agent: { enabled: true } });
    expect(writes()).toEqual([]);
  });

  it("retries once on a version conflict, then reports version_conflict", async () => {
    refusals = [err(10, 409, "AGENT_CONFIG_CHANGED", { expected_version: "42", current_version: "43" })];
    const out = await run(["enable", "quote", "--label", "Q", "--connection", "Website"]);
    expect(out.notes.join(" ")).toContain("retrying once");
    expect(out.json).toMatchObject({ changed: true });
    expect(writes()).toHaveLength(2);

    refusals = [err(10, 409, "AGENT_CONFIG_CHANGED", {}), err(10, 409, "AGENT_CONFIG_CHANGED", {})];
    const e = await fails(["disable", "quote"], "version_conflict");
    expect(e.exitCode).toBe(1);
    expect(e.toJSON()).toMatchObject({ expected_version: 43 });
  });

  it("says unknown_agent and agent_not_hosted from the service's reasons", async () => {
    expect((await fails(["enable", "nope"], "unknown_agent")).toJSON()).toMatchObject({ agent: "nope" });
    expect((await fails(["enable", "jobs"], "agent_not_hosted")).toJSON()).toMatchObject({ agent: "jobs", readiness: "coming_soon" });
  });

  it("maps a setting the service refuses that the CLI let through to invalid_input", async () => {
    refusals = [err(3, 400, "INVALID_SETTING", { agent: "quote", setting: "label", rule: "max_length", limit: "50", settings: "label" })];
    const e = await fails(["enable", "quote", "--label", "Q", "--connection", "Website"], "invalid_input");
    expect(e.toJSON()).toMatchObject({ field: "settings.label", rule: "max_length", limit: 50, settings: ["label"] });
  });

  it.each(["snake", "camel"] as const)("reads %s_case answers, keeping setting names as sent", async (s) => {
    style = s;
    agents["booking"] = { enabled: false, settings: { label: "Book", slot_minutes: 60 } };
    const out = await run(["enable", "booking", "--lead-minutes", "30", "--connection", "Website"]);
    expect((out.json["agent"] as Json)["settings"]).toEqual({ label: "Book", slot_minutes: 60, lead_minutes: 30 });
    expect((writes()[0]?.body as Json)["expected_version"]).toBe("42");
  });
});

describe("nxis agents configure|disable|pause|resume <id>", () => {
  it("changes settings without turning the agent on, and --clear returns one to its default", async () => {
    agents["quote"] = { enabled: true, settings: { label: "Q", description: "Old" } };
    const out = await run(["configure", "quote", "--example", "a", "--example", "b", "--clear", "description"]);
    const w = writes()[0];
    expect(w?.method).toBe("PATCH");
    const [path, query] = (w?.url ?? "").split("?");
    expect(path).toBe(`${BASE}/hostedAgents/quote`);
    // No mask: the keys sent say what changes, and a gateway can't re-case them.
    expect(new URLSearchParams(query).get("update_mask")).toBeNull();
    expect(new URLSearchParams(query).get("expected_version")).toBe("42");
    expect(w?.body).toEqual({ name: `organizations/${ORG}/sites/${SITE}/hostedAgents/quote`, settings: { examples: ["a", "b"], description: null } });
    expect(out.json).toMatchObject({ changed: true, agent: { settings: { label: "Q", examples: ["a", "b"] } } });
  });

  it("refuses clearing a required setting of an agent that is on, a flag set and cleared, and nothing at all", async () => {
    agents["quote"] = { enabled: true, settings: { label: "Q" } };
    await fails(["configure", "quote", "--clear", "label"], "missing_label");
    await fails(["configure", "quote", "--label", "A", "--clear", "label"], "conflicting_flags");
    await fails(["configure", "quote", "--clear", "venue"], "unknown_flag");
    await fails(["configure", "quote"], "missing_settings");
    expect(writes()).toEqual([]);
    // Off, a required setting may be cleared.
    agents["quote"] = { enabled: false, settings: { label: "Q" } };
    await run(["configure", "quote", "--clear", "label"]);
    expect(writes()).toHaveLength(1);
  });

  it("configures a setting the CLI doesn't know for support from the service's setup", async () => {
    await run(["configure", "support", "--advice-line", "Call us"]);
    expect(writes()[0]?.body).toMatchObject({ settings: { advice_line: "Call us" } });
  });

  it("disables, keeping the settings; nothing is sent when it is off", async () => {
    agents["quote"] = { enabled: true, settings: { label: "Q" } };
    const out = await run(["disable", "quote"]);
    expect(writes()[0]?.body).toEqual({ name: `organizations/${ORG}/sites/${SITE}/hostedAgents/quote`, enabled: false, expected_version: "42" });
    expect(out.json).toMatchObject({ changed: true, agent: { enabled: false, state: "off", settings: { label: "Q" } } });
    expect((await run(["disable", "quote"])).json).toMatchObject({ changed: false });
    expect(writes()).toHaveLength(1);
  });

  it("pauses and resumes one agent by its own kill switch", async () => {
    agents["booking"] = { enabled: true, settings: { label: "B" } };
    const out = await run(["pause", "booking", "--tools", "--reason", "Back at 9"]);
    const [, query] = (writes()[0]?.url ?? "").split("?");
    expect(new URLSearchParams(query).get("update_mask")).toBeNull();
    expect(writes()[0]?.body).toEqual({ name: `organizations/${ORG}/sites/${SITE}/hostedAgents/booking`, kill_switch: { scope: "TOOLS", reason: "Back at 9" } });
    expect(out.json).toMatchObject({ agent: { kill_switch: { scope: "tools", reason: "Back at 9" } } });
    // Paused that way already: nothing sent. Without --reason, the message is kept.
    expect((await run(["pause", "booking", "--tools"])).json).toMatchObject({ changed: false });
    await run(["pause", "booking"]);
    expect(writes()[1]?.body).toMatchObject({ kill_switch: { scope: "AGENT", reason: "Back at 9" } });

    const resumed = await run(["resume", "booking"]);
    expect(writes()[2]?.body).toEqual({ name: `organizations/${ORG}/sites/${SITE}/hostedAgents/booking`, kill_switch: {} });
    expect(resumed.json).toMatchObject({ changed: true, agent: { kill_switch: null } });
    expect((await run(["resume", "booking"])).json).toMatchObject({ changed: false });
    await fails(["pause", "booking", "--reason", "x".repeat(201)], "reason_too_long");
  });

  it("still pauses the whole site with no id, through the agent config", async () => {
    const out = await run(["pause", "--reason", "Down"]);
    expect(writes().map((w) => w.url)).toEqual([`${BASE}/agentConfig?expectedVersion=42`]);
    expect(out.json).toMatchObject({ kill_switch: { scope: "agent", reason: "Down" } });
  });
});

describe("against a service without hosted agents by id", () => {
  beforeEach(() => {
    hostedRoutes = false;
  });

  it("fails with hosted_agents_unavailable for an agent the catalog knows", async () => {
    const e = await fails(["enable", "quote", "--label", "Q"], "hosted_agents_unavailable");
    expect(e.toJSON()).toMatchObject({ agent: "quote" });
    await fails(["pause", "booking"], "hosted_agents_unavailable");
  });

  it("keeps the older reasons for an id nobody knows", async () => {
    await fails(["enable", "nope"], "missing_agent");
    await fails(["resume", "nope"], "unknown_agent");
  });

  it("refuses support flags the older path has no place for", async () => {
    await fails(["enable", "support", "--advice-line", "x"], "unknown_flag");
    await fails(["enable", "support", "--connection", "Website"], "unknown_flag");
    expect(writes()).toEqual([]);
  });

  it("leaves agents out of status", async () => {
    const out = await run(["status"]);
    expect(out.json["agents"]).toBeUndefined();
  });
});

describe("nxis agents status", () => {
  it("adds every hosted agent by id, keeping the keys it always printed", async () => {
    agents["quote"] = { enabled: true, settings: { label: "Q" } };
    stateOf = { quote: { state: "HOSTED_AGENT_PAUSED", reason: "SITE_PAUSED", message: "Paused site-wide." } };
    const out = await run(["status"]);
    expect(out.json).toMatchObject({ ok: true, version: 42, page: { enabled: false }, support: { enabled: false } });
    const list = out.json["agents"] as Json[];
    expect(list.map((a) => a["id"])).toEqual(["page", "support", "quote", "booking", "events"]);
    expect(list[2]).toMatchObject({ id: "quote", enabled: true, state: "paused", state_reason: "site_paused", settings: { label: "Q" } });
    expect(out.text).toContain("By catalog id");
  });
});
