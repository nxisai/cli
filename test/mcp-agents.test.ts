/**
 * The hosted agent tools of `nxis mcp serve`: status, the catalog, enable (with the connection
 * choice, the agreement and the confirmation), configure, disable, pause, resume and branding,
 * against an in-process sites service, through a client that may or may not elicit.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallToolResult, ElicitRequest } from "@modelcontextprotocol/sdk/types.js";
import { parseArgs } from "../src/args.js";
import { runHostedAgents } from "../src/commands/hosted-agents.js";
import { AGENT_TOOLS, TOOLS } from "../src/tools/index.js";
import { capture, cleanFake, fake, ORG, resetFake, startFake, stopFake, type AuthSeen } from "./support/fake-endpoints.js";
import { body, expectNoSecrets, guidedServe, type GuidedSession } from "./support/guided.js";

const SITE = "site-1";
const BASE = `/v1/organizations/${ORG}/sites/${SITE}`;
const VERSION = "2026-11-16";

type Json = Record<string, unknown>;

const MODEL = {
  name: "model",
  type: "SETTING_MODEL",
  label: "Model",
  allowed_values: [{ value: "claude-haiku-5-5", is_default: true }, { value: "claude-sonnet-5" }, { value: "claude-old", retired: true }],
};
const LABEL = { name: "label", type: "SETTING_STRING", label: "Name visitors see", required: true, max_length: 100 };
const DESCRIPTION = { name: "description", type: "SETTING_TEXT", label: "Description", max_length: 300 };
const EXAMPLES = { name: "examples", type: "SETTING_STRING_LIST", label: "Example questions", max_items: 3, item_max_length: 50, flag: "example" };
const SLOT = { name: "slot_minutes", type: "SETTING_INTEGER", label: "Slot length", min: "15", max: "480", flag: "slot-minutes" };
const AVAILABILITY = { name: "availability", type: "SETTING_ENUM", label: "Availability", allowed_values: [{ value: "auto" }, { value: "opening_hours" }] };
const CONNECTION = { id: "connection", kind: "PREREQUISITE_CONNECTION", enforcement: "ENFORCED_ON_ENABLE", label: "A connection to your website", action_types: ["QuoteAction"] };
const RECORDS = { id: "records", kind: "PREREQUISITE_RECORDS", enforcement: "ENFORCED_ON_ENABLE", label: "Prices on your site", record_types: ["Offer"] };

const SETUPS: Record<string, Json> = {
  quote: { settings: [MODEL, LABEL, DESCRIPTION, EXAMPLES], prerequisites: [RECORDS, CONNECTION], pausable: true },
  booking: { settings: [MODEL, LABEL, AVAILABILITY, SLOT], prerequisites: [CONNECTION], pausable: true },
  support: { settings: [MODEL, LABEL, DESCRIPTION], prerequisites: [], pausable: true },
};
const NAMES: Record<string, string> = { quote: "Quote", booking: "Booking", support: "Support" };

let agents: Record<string, { enabled: boolean; settings: Json; kill?: Json }>;
let version: number;
/** The site's connections, by name. */
let connections: string[];
/** Whether each agent's connection route is set. */
let routed: Record<string, boolean>;
let dpaAccepted: boolean;
/** Answers for the next hosted agent writes, instead of applying them. */
let refusals: Array<{ status: number; body: Json }>;
let siteKill: Json | null;
let branding: Json;

const err = (code: number, status: number, reason: string, metadata: Json, message = "refused") => ({
  status,
  body: { code, message, details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "nxis.ai", metadata }] },
});

function hostedAgent(id: string): Json {
  const a = agents[id] ?? { enabled: false, settings: {} };
  const needs = (SETUPS[id]?.["prerequisites"] as Json[]).some((p) => p["kind"] === "PREREQUISITE_CONNECTION");
  return {
    name: `organizations/${ORG}/sites/${SITE}/hostedAgents/${id}`,
    agent: id,
    display_name: NAMES[id],
    ...(a.enabled ? { enabled: true } : {}),
    state: a.enabled ? (a.kill ? "HOSTED_AGENT_PAUSED" : "HOSTED_AGENT_LIVE") : "HOSTED_AGENT_OFF",
    ...(a.enabled && a.kill ? { state_reason: "AGENT_PAUSED", state_message: "Paused." } : {}),
    prerequisites: needs
      ? [
          routed[id]
            ? { id: "connection", kind: "PREREQUISITE_CONNECTION", enforcement: "ENFORCED_ON_ENABLE", met: true }
            : { id: "connection", kind: "PREREQUISITE_CONNECTION", enforcement: "ENFORCED_ON_ENABLE", reason: "CONNECTION_REQUIRED", message: "Choose a connection." },
        ]
      : [],
    ...(a.kill ? { kill_switch: a.kill, effective_kill_switch: a.kill } : {}),
    setup: SETUPS[id],
    config_version: String(version),
    settings: a.settings,
  };
}

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
    entry: { id, name: NAMES[id] ?? id, job: "answers", readiness: "available", hosted: true, setup: SETUPS[id] },
    fit: 60,
    ...(agents[id]?.enabled ? { added: true } : {}),
    state: agents[id]?.enabled ? "HOSTED_AGENT_LIVE" : "HOSTED_AGENT_OFF",
    prerequisites: id === "quote" && !routed["quote"] ? [{ id: "connection", kind: "PREREQUISITE_CONNECTION", reason: "CONNECTION_REQUIRED" }] : [],
  };
}

function service(req: AuthSeen) {
  const [path = ""] = req.url.split("?");
  if (path === `${BASE}/agentConfig` && req.method === "GET") {
    return {
      status: 200,
      body: {
        name: `${BASE.slice(4)}/agentConfig`,
        version: String(version),
        page: { enabled: false, branding },
        support: { enabled: agents["support"]?.enabled ?? false, label: (agents["support"]?.settings["label"] as string) ?? "" },
        ...(siteKill ? { kill_switch: siteKill } : {}),
      },
    };
  }
  if (path === `${BASE}/agentConfig` && req.method === "PATCH") {
    const sent = req.body as Json;
    siteKill = (sent["kill_switch"] as Json | undefined) ?? (sent["killSwitch"] as Json | undefined) ?? null;
    if (siteKill && (siteKill["scope"] === "KILL_SCOPE_UNSPECIFIED" || !siteKill["scope"])) siteKill = null;
    branding = ((sent["page"] as Json | undefined)?.["branding"] as Json) ?? branding;
    version++;
    return { status: 200, body: { ...sent, version: String(version) } };
  }
  if (path === `${BASE}/agentSetup` && req.method === "GET") {
    return { status: 200, body: { current_dpa_version: VERSION, dpa_current: dpaAccepted, dpa_status: dpaAccepted ? "DPA_ACCEPTED" : "DPA_REQUIRED" } };
  }
  if (path === `${BASE}/agentSetup:acceptDpa` && req.method === "POST") {
    dpaAccepted = true;
    return { status: 200, body: { current_dpa_version: VERSION, dpa_current: true, dpa_status: "DPA_ACCEPTED" } };
  }
  if (path === `${BASE}/connections` && req.method === "GET") {
    return { status: 200, body: { connections: connections.map((name, i) => ({ id: `c${i}`.padEnd(24, "0"), name, url: `https://${name.toLowerCase()}.example.com/hook` })) } };
  }
  if (path === `${BASE}/agentCatalog` && req.method === "GET") {
    return { status: 200, body: { entries: Object.keys(SETUPS).map(catalogEntry), total_size: 3 } };
  }
  const entry = path.match(new RegExp(`^${BASE}/agentCatalog/([a-z-]+)$`));
  if (entry) {
    const id = entry[1] as string;
    return SETUPS[id] ? { status: 200, body: catalogEntry(id) } : { status: 404, body: { code: 5, message: "no catalog entry has that id" } };
  }
  if (path === `${BASE}/hostedAgents` && req.method === "GET") {
    return { status: 200, body: { hosted_agents: Object.keys(SETUPS).map(hostedAgent), config_version: String(version), live: true } };
  }
  const m = path.match(new RegExp(`^${BASE}/hostedAgents/([a-z-]+)(:setEnabled)?$`));
  if (!m) return { status: 404 };
  const id = m[1] as string;
  if (!SETUPS[id]) return err(5, 404, "AGENT_NOT_FOUND", { agent: id });
  if (req.method === "GET") return { status: 200, body: hostedAgent(id) };
  const next = refusals.shift();
  if (next) return next;
  const sent = req.body as Json;
  const current = agents[id] ?? { enabled: false, settings: {} };
  if (m[2]) {
    if (typeof sent["connection"] === "string") routed[id] = true;
    agents[id] = { ...current, enabled: sent["enabled"] === true, settings: merge(current.settings, sent["settings"] as Json) };
  } else {
    const kill = "kill_switch" in sent ? (Object.keys((sent["kill_switch"] as Json) ?? {}).length ? (sent["kill_switch"] as Json) : undefined) : current.kill;
    agents[id] = { enabled: current.enabled, settings: merge(current.settings, sent["settings"] as Json), ...(kill ? { kill } : {}) };
  }
  version++;
  return { status: 200, body: hostedAgent(id) };
}

const writes = () => fake.sitesCalls.filter((c) => c.method !== "GET" && !c.url.includes("acceptDpa"));
const accepts = () => fake.sitesCalls.filter((c) => c.url.includes("acceptDpa")).map((c) => c.body);

beforeAll(startFake);
afterAll(stopFake);
beforeEach(() => {
  resetFake();
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  process.env.NXIS_TOKEN = "header.payload.sig";
  agents = { support: { enabled: true, settings: { label: "Help" } } };
  version = 42;
  connections = ["Website", "Spare"];
  routed = { quote: true, booking: true };
  dpaAccepted = true;
  refusals = [];
  siteKill = null;
  branding = {};
  fake.sites = service;
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NXIS_TOKEN;
  cleanFake();
});

type Reply = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };

/** A person who answers each kind of question as given: a choice by index, a line of text, a confirmation. */
function person(opts: { choices?: Array<number | "decline" | "cancel">; text?: string; confirm?: boolean | "decline" | "cancel" } = {}) {
  const choices = [...(opts.choices ?? [])];
  return (params: ElicitRequest["params"]): Reply => {
    const props = ((params as { requestedSchema?: { properties?: Json } }).requestedSchema?.properties ?? {}) as Json;
    if ("choice" in props) {
      const c = choices.shift();
      if (c === undefined || c === "cancel") return { action: "cancel" };
      if (c === "decline") return { action: "decline" };
      return { action: "accept", content: { choice: String(c) } };
    }
    if ("value" in props) return opts.text ? { action: "accept", content: { value: opts.text } } : { action: "cancel" };
    const confirm = opts.confirm ?? true;
    if (confirm === true) return { action: "accept", content: { confirm: true } };
    return { action: confirm === false ? "decline" : confirm };
  };
}

async function withServe<T>(answer: Parameters<typeof guidedServe>[0], run: (s: GuidedSession) => Promise<T>, opts: Parameters<typeof guidedServe>[1] = {}): Promise<T> {
  const s = await guidedServe(answer, { ...opts, ctx: { siteOverride: SITE, ...opts.ctx } });
  try {
    return await run(s);
  } finally {
    await s.close();
  }
}

/** The `--json` object of an `nxis agents …` command. */
async function cli(argv: string[]): Promise<Json> {
  const { positional, flags } = parseArgs(argv);
  const { ctx, out } = capture({ siteOverride: SITE });
  await runHostedAgents(ctx, positional, flags);
  return out.json;
}

/** The SDK checks a call against the tool's schema before the server sees it. */
async function refusedBySchema(call: Promise<CallToolResult>, field: string): Promise<void> {
  const r = await call;
  expect(r.isError).toBe(true);
  expect(r.content.map((p) => (p as { text?: string }).text ?? "").join("\n")).toContain(field);
}

const isConfirm = (p: ElicitRequest["params"] | undefined) => "confirm" in (((p as { requestedSchema?: { properties?: Json } })?.requestedSchema?.properties ?? {}) as Json);

describe("the hosted agent tools", () => {
  it("are listed, local, with site, and read-only only for status and the catalog", () => {
    const names = AGENT_TOOLS.map((t) => t.name);
    expect(names).toEqual([
      "nxis_agents_status",
      "nxis_agents_catalog",
      "nxis_enable_agent",
      "nxis_configure_agent",
      "nxis_disable_agent",
      "nxis_pause_agents",
      "nxis_resume_agents",
      "nxis_agents_brand",
    ]);
    for (const t of AGENT_TOOLS) {
      expect(TOOLS).toContain(t);
      expect(t.surface).toBe("local");
      expect(t.takesSite).toBe(true);
      expect(Object.keys(t.input.shape)).toContain("site");
      expect(t.readOnly, t.name).toBe(t.name === "nxis_agents_status" || t.name === "nxis_agents_catalog");
    }
  });
});

describe("nxis_agents_status and nxis_agents_catalog", () => {
  it("status returns what `agents status --json` prints, without asking", async () => {
    const expected = await cli(["status"]);
    await withServe(person(), async (s) => {
      const out = body(await s.call("nxis_agents_status"));
      expect(out).toEqual(expected);
      expect(out["agents"]).toEqual(expect.arrayContaining([expect.objectContaining({ id: "support", state: "live" })]));
      expect(s.asked).toHaveLength(0);
    });
  });

  it("the catalog lists the agents, filtered as asked", async () => {
    await withServe(person(), async (s) => {
      const out = body(await s.call("nxis_agents_catalog", { readiness: ["available"], by_fit: true, added: false }));
      expect(out).toMatchObject({ ok: true, total: 3 });
      expect((out["entries"] as Json[]).map((e) => e["id"])).toEqual(["quote", "booking", "support"]);
      const url = fake.sitesCalls.find((c) => c.url.startsWith(`${BASE}/agentCatalog?`))?.url ?? "";
      const q = new URLSearchParams(url.split("?")[1]);
      expect(q.getAll("readiness")).toEqual(["available"]);
      expect(q.get("order_by")).toBe("fit");
      expect(q.get("added")).toBe("false");
    });
  });

  it("one agent has its settings as typed fields, its prerequisites, what is unmet and the enable arguments", async () => {
    routed["quote"] = false;
    const expected = await cli(["catalog", "quote"]);
    await withServe(person(), async (s) => {
      const out = body(await s.call("nxis_agents_catalog", { agent: "quote" }));
      expect(out).toMatchObject(expected);
      const flags = out["flags"] as Json[];
      expect(flags.find((f) => f["setting"] === "examples")).toMatchObject({ type: "string_list", max_items: 3, item_max_length: 50 });
      expect(flags.find((f) => f["setting"] === "model")).toMatchObject({ allowed: ["claude-haiku-5-5", "claude-sonnet-5"] });
      expect(out["unmet"]).toEqual(["connection"]);
      expect(out["enable_with"]).toEqual({ agent: "quote", settings: { label: "<Name visitors see>" }, connection: "<name|id>" });
    });
  });

  it("an unknown agent is unknown_agent, with the step that lists them", async () => {
    await withServe(person(), async (s) => {
      expect(body(await s.call("nxis_agents_catalog", { agent: "nope" }))).toMatchObject({ reason: "unknown_agent", next: expect.stringContaining("nxis_agents_catalog") });
    });
  });
});

describe("nxis_enable_agent", () => {
  it("turns an agent on with settings by name and a connection, after the user confirms", async () => {
    await withServe(person(), async (s) => {
      const result = await s.call("nxis_enable_agent", { agent: "quote", settings: { label: "Get a quote", examples: ["How much?", "Do you deliver?"] }, connection: "Website" });
      expect(result.isError).toBeFalsy();
      expect(body(result)).toMatchObject({ ok: true, changed: true, agent: { id: "quote", enabled: true, state: "live" } });
      expect(body(result)["next"]).toBeUndefined();
      expect(s.asked).toHaveLength(1);
      expect(s.asked[0]?.message).toContain('Turn on Quote on example.com? Once on, it answers the site\'s visitors and sends their requests, with what they enter, through the connection "Website".');
      expect(s.asked[0]?.message).toContain('label "Get a quote"');
      expectNoSecrets(s.asked);
    });
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({
      url: `${BASE}/hostedAgents/quote:setEnabled`,
      body: { enabled: true, connection: "Website", settings: { label: "Get a quote", examples: ["How much?", "Do you deliver?"] }, expected_version: "42" },
    });
  });

  it("sends integers, enums and booleans as their types", async () => {
    await withServe(person(), async (s) => {
      expect((await s.call("nxis_enable_agent", { agent: "booking", settings: { label: "Book", slot_minutes: 30, availability: "opening_hours" } })).isError).toBeFalsy();
    });
    expect(writes()[0]?.body).toMatchObject({ settings: { label: "Book", slot_minutes: 30, availability: "opening_hours" } });
  });

  it.each([
    [{ agent: "quote", settings: { label: "Q", colour: "red" } }, "unknown_setting", { field: "settings.colour", allowed: ["model", "label", "description", "examples"] }],
    [{ agent: "booking", settings: { label: "B", slot_minutes: 5 } }, "invalid_slot_minutes", { field: "settings.slot_minutes", min: 15, max: 480 }],
    [{ agent: "booking", settings: { label: "B", slot_minutes: 30.5 } }, "invalid_slot_minutes", { setting: "slot_minutes" }],
    [{ agent: "booking", settings: { label: "B", availability: "always" } }, "invalid_availability", { allowed: ["auto", "opening_hours"] }],
    [{ agent: "quote", settings: { label: "Q", examples: ["a", "b", "c", "d"] } }, "too_many_examples", { limit: 3 }],
    [{ agent: "quote", settings: { label: "x".repeat(101) } }, "label_too_long", { limit: 100 }],
    [{ agent: "quote", settings: { label: "Q", model: "claude-old" } }, "model_retired", {}],
    [{ agent: "quote", settings: { label: 7 } }, "invalid_label", { rule: "type" }],
    [{ agent: "quote", settings: { description: "only this" } }, "missing_label", { setting: "label" }],
    [{ agent: "support", connection: "Website" }, "connection_not_taken", { field: "connection" }],
    [{ agent: "nope" }, "unknown_agent", {}],
  ])("refuses %j with %s before asking or sending anything", async (args, reason, details) => {
    await withServe(person(), async (s) => {
      const out = body(await s.call("nxis_enable_agent", args));
      expect(out).toMatchObject({ ok: false, reason, ...details });
      expect(String(out["next"])).toMatch(/nxis_agents_catalog/);
      expect(s.asked).toHaveLength(0);
    });
    expect(writes()).toHaveLength(0);
  });

  it("refuses an argument the tool doesn't define, and a list for a text setting, by the schema", async () => {
    await withServe(person(), async (s) => {
      await refusedBySchema(s.call("nxis_enable_agent", { agent: "quote", flags: ["--label"] }), "flags");
      await refusedBySchema(s.call("nxis_enable_agent", { agent: "quote", settings: { label: { text: "Q" } } }), "settings");
      expect(s.asked).toHaveLength(0);
    });
    expect(writes()).toHaveLength(0);
  });

  describe("a refusal from the service", () => {
    it.each([
      ["connection_required", err(9, 400, "CONNECTION_REQUIRED", { agent: "quote", action_types: "QuoteAction", unmet: "connection" }), { connections: ["Website", "Spare"], unmet: ["connection"] }, /connection set to one of the site's connections: "Website", "Spare"/],
      ["records_missing", err(9, 400, "RECORDS_MISSING", { agent: "quote", types: "Offer", unmet: "records" }, "Quote needs prices. The agent's route to the connection was set, and stays."), { types: ["Offer"], unmet: ["records"], kept: ["route", "settings"] }, /nxis_crawl_sitemap.*nxis_bulk_autofill.*nxis_publish_entities/],
      ["actions_off", err(9, 400, "ACTIONS_OFF", { agent: "quote", unmet: "actions" }), { unmet: ["actions"] }, /nxis_bind_mcp_action, sending only enabled: true/],
      ["opening_hours_required", err(9, 400, "OPENING_HOURS_REQUIRED", { agent: "quote" }), {}, /opening hours/],
      ["connection_unusable", err(9, 400, "CONNECTION_UNUSABLE", { agent: "quote", action_type: "QuoteAction" }), { action_type: "QuoteAction" }, /nxis_test_connection/],
      ["connection_not_found", err(5, 404, "CONNECTION_NOT_FOUND", { agent: "quote", connection: "Gone" }), { connection: "Gone" }, /nxis_list_connections/],
    ] as const)("%s comes back with its details and the call that meets it", async (reason, refusal, details, next) => {
      refusals = [refusal];
      await withServe(person(), async (s) => {
        const out = body(await s.call("nxis_enable_agent", { agent: "quote", settings: { label: "Q" }, connection: "Website" }));
        expect(out).toMatchObject({ ok: false, reason, agent: "quote", ...details });
        expect(String(out["next"])).toMatch(next);
      });
    });

    it("says what a refusal that kept the route kept, in sentences", async () => {
      refusals = [err(9, 400, "RECORDS_MISSING", { agent: "quote", types: "Offer" }, "Quote needs prices. The agent's route to the connection was set, and stays.")];
      await withServe(person(), async (s) => {
        const out = body(await s.call("nxis_enable_agent", { agent: "quote", settings: { label: "Q" }, connection: "Website" }));
        expect(out["kept"]).toEqual(["route", "settings"]);
        expect(String(out["error"] ?? out["message"])).toContain("The agent's route to the connection and the settings given were saved, and stay; the agent is still off.");
      });
      // The refused enable, then the settings saved on their own.
      expect(writes().map((w) => w.method)).toEqual(["POST", "PATCH"]);
    });

    it("a version conflict twice is version_conflict, with the step to call again", async () => {
      refusals = [err(10, 409, "AGENT_CONFIG_CHANGED", {}), err(10, 409, "AGENT_CONFIG_CHANGED", {})];
      await withServe(person(), async (s) => {
        expect(body(await s.call("nxis_enable_agent", { agent: "quote", settings: { label: "Q" }, connection: "Website" }))).toMatchObject({
          reason: "version_conflict",
          next: expect.stringContaining("call the tool again"),
        });
      });
    });
  });

  it("an agent that is on but held back says the next step as a tool", async () => {
    agents["quote"] = { enabled: true, settings: { label: "Q" }, kill: { scope: "AGENT", reason: "" } };
    await withServe(person(), async (s) => {
      const out = body(await s.call("nxis_enable_agent", { agent: "quote", settings: { label: "Quotes" } }));
      expect(out).toMatchObject({ ok: true, agent: { state: "paused", state_reason: "agent_paused" } });
      expect(out["next"]).toBe('It is paused on its own: nxis_resume_agents with agent "quote" resumes it.');
    });
  });

  it("asks nothing and sends nothing when the agent is already on with those settings", async () => {
    await withServe(person(), async (s) => {
      expect(body(await s.call("nxis_enable_agent", { agent: "support", settings: { label: "Help" } }))).toMatchObject({ ok: true, changed: false });
      expect(s.asked).toHaveLength(0);
    });
    expect(writes()).toHaveLength(0);
  });

  describe("the agreement", () => {
    beforeEach(() => {
      dpaAccepted = false;
    });

    it("is offered first, accepted for the organization, then the enable is confirmed", async () => {
      await withServe(person({ choices: [0] }), async (s) => {
        expect((await s.call("nxis_enable_agent", { agent: "quote", settings: { label: "Q" }, connection: "Website" })).isError).toBeFalsy();
        expect(s.asked[0]?.message).toContain(`version ${VERSION}`);
        expect(s.asked[0]?.message).toContain(`https://nxis.ai/dpa/${VERSION}`);
        const schema = s.asked[0]?.requestedSchema as { properties: { choice: { oneOf: Array<{ title: string }>; default?: string } } };
        expect(schema.properties.choice.oneOf.map((o) => o.title)).toEqual([
          `Accept for organization ${ORG} (all of its sites)`,
          expect.stringContaining("Accept for the legal entity"),
        ]);
        expect(schema.properties.choice.default).toBeUndefined();
        expect(isConfirm(s.asked[1])).toBe(true);
        expectNoSecrets(s.asked);
      });
      expect(accepts()).toEqual([{ name: `organizations/${ORG}/sites/${SITE}/agentSetup`, version: VERSION }]);
      expect(writes()).toHaveLength(1);
    });

    it("is accepted for the site's legal entity, by the name the user gives", async () => {
      await withServe(person({ choices: [1], text: "Ridgeline Air Services LLC" }), async (s) => {
        expect((await s.call("nxis_enable_agent", { agent: "quote", settings: { label: "Q" }, connection: "Website" })).isError).toBeFalsy();
        expect(s.asked).toHaveLength(3);
      });
      expect(accepts()).toEqual([expect.objectContaining({ legal_entity: "Ridgeline Air Services LLC" })]);
    });

    it("dismissed, nothing is accepted or enabled", async () => {
      await withServe(person({ choices: ["cancel"] }), async (s) => {
        const out = body(await s.call("nxis_enable_agent", { agent: "quote", settings: { label: "Q" }, connection: "Website" }));
        expect(out).toMatchObject({ reason: "cancelled_by_user", version: VERSION, agent: "quote" });
        expect(s.asked).toHaveLength(1);
      });
      expect(accepts()).toHaveLength(0);
      expect(writes()).toHaveLength(0);
    });

    it("without elicitation, the enable is refused with what it would do and the terminal command", async () => {
      await withServe(null, async (s) => {
        const out = body(await s.call("nxis_enable_agent", { agent: "quote", settings: { label: "Q" }, connection: "Website" }));
        expect(out).toMatchObject({ reason: "confirmation_unavailable", terminal_command: "nxis agents enable quote" });
        expect(String(out["would_do"])).toContain("Turn on Quote on example.com?");
      });
      expect(accepts()).toHaveLength(0);
      expect(writes()).toHaveLength(0);
    });

    it("under --allow-unconfirmed with a client that can't ask, the enable runs and nothing is accepted", async () => {
      await withServe(
        null,
        async (s) => {
          expect((await s.call("nxis_enable_agent", { agent: "quote", settings: { label: "Q" }, connection: "Website" })).isError).toBeFalsy();
        },
        { allowUnconfirmed: true },
      );
      expect(accepts()).toHaveLength(0);
      expect(writes()).toHaveLength(1);
    });
  });

  describe("the connection", () => {
    beforeEach(() => {
      routed["quote"] = false;
    });

    it("is chosen by the user among the site's connections when none is given", async () => {
      await withServe(person({ choices: [1] }), async (s) => {
        expect((await s.call("nxis_enable_agent", { agent: "quote", settings: { label: "Q" } })).isError).toBeFalsy();
        const schema = s.asked[0]?.requestedSchema as { properties: { choice: { oneOf: Array<{ title: string }> } } };
        expect(schema.properties.choice.oneOf.map((o) => o.title)).toEqual([
          '"Website" (website.example.com)',
          '"Spare" (spare.example.com)',
          "None of these: create a new connection first",
        ]);
        expect(s.asked[1]?.message).toContain('through the connection "Spare"');
      });
      expect(writes()[0]?.body).toMatchObject({ connection: "Spare" });
    });

    it("isn't asked about when the agent's route is already set, or the call names one", async () => {
      routed["quote"] = true;
      await withServe(person(), async (s) => {
        await s.call("nxis_enable_agent", { agent: "quote", settings: { label: "Q" } });
        expect(s.asked).toHaveLength(1);
        expect(isConfirm(s.asked[0])).toBe(true);
      });
      expect(writes()[0]?.body).not.toHaveProperty("connection");
    });

    it("a new one first: nothing is created or changed, and the step is to create one at the user's address", async () => {
      await withServe(person({ choices: [2] }), async (s) => {
        const out = body(await s.call("nxis_enable_agent", { agent: "quote", settings: { label: "Q" } }));
        expect(out).toMatchObject({ reason: "connection_required", connections: ["Website", "Spare"] });
        expect(String(out["next"])).toContain("nxis_create_connection");
        expect(String(out["next"])).toContain("write_env");
        expect(s.asked).toHaveLength(1);
      });
      expect(fake.sitesCalls.filter((c) => c.method !== "GET")).toHaveLength(0);
    });

    it("a site with none: the step to create one, without asking", async () => {
      connections = [];
      await withServe(person(), async (s) => {
        const out = body(await s.call("nxis_enable_agent", { agent: "quote", settings: { label: "Q" } }));
        expect(out).toMatchObject({ reason: "connection_required", connections: [] });
        expect(String(out["next"])).toContain("nxis_create_connection");
        expect(s.asked).toHaveLength(0);
      });
      expect(writes()).toHaveLength(0);
    });

    it("declined: nothing is changed", async () => {
      await withServe(person({ choices: ["decline"] }), async (s) => {
        expect(body(await s.call("nxis_enable_agent", { agent: "quote", settings: { label: "Q" } }))).toMatchObject({ reason: "declined_by_user" });
      });
      expect(writes()).toHaveLength(0);
    });
  });

  it("is sent nothing on a declined or dismissed confirmation", async () => {
    for (const confirm of ["decline", "cancel", false] as const) {
      await withServe(person({ confirm }), async (s) => {
        const out = body(await s.call("nxis_enable_agent", { agent: "quote", settings: { label: "Q" }, connection: "Website" }));
        expect(out).toMatchObject({ reason: confirm === "cancel" ? "cancelled_by_user" : "declined_by_user" });
      });
    }
    expect(writes()).toHaveLength(0);
  });

  it("is refused under --read-only, while status still answers", async () => {
    await withServe(
      person(),
      async (s) => {
        expect(body(await s.call("nxis_enable_agent", { agent: "quote", settings: { label: "Q" } }))).toMatchObject({ reason: "read_only_server" });
        expect((await s.call("nxis_agents_status")).isError).toBeFalsy();
        expect(s.asked).toHaveLength(0);
      },
      { readOnly: true },
    );
    expect(writes()).toHaveLength(0);
  });
});

describe("nxis_configure_agent", () => {
  it("changes an agent that is off without asking, and clears settings by name", async () => {
    agents["quote"] = { enabled: false, settings: { label: "Q", description: "Old" } };
    await withServe(person(), async (s) => {
      const out = body(await s.call("nxis_configure_agent", { agent: "quote", settings: { label: "Quotes" }, clear: ["description"] }));
      expect(out).toMatchObject({ ok: true, changed: true, agent: { enabled: false, settings: { label: "Quotes" } } });
      expect(s.asked).toHaveLength(0);
    });
    expect(writes()).toEqual([expect.objectContaining({ method: "PATCH", body: expect.objectContaining({ settings: { label: "Quotes", description: null } }) })]);
  });

  it("asks first for an agent that is on, naming what changes", async () => {
    await withServe(person(), async (s) => {
      expect((await s.call("nxis_configure_agent", { agent: "support", settings: { description: "We answer fast" } })).isError).toBeFalsy();
      expect(s.asked[0]?.message).toContain("Change the settings of Support, which is on and answering visitors on example.com?");
      expect(s.asked[0]?.message).toContain('description "We answer fast"');
    });
    expect(writes()).toHaveLength(1);
  });

  it("an agent that is on: declined, or unconfirmable, nothing is sent", async () => {
    await withServe(person({ confirm: false }), async (s) => {
      expect(body(await s.call("nxis_configure_agent", { agent: "support", settings: { description: "x" } }))).toMatchObject({ reason: "declined_by_user" });
    });
    await withServe(null, async (s) => {
      expect(body(await s.call("nxis_configure_agent", { agent: "support", settings: { description: "x" } }))).toMatchObject({
        reason: "confirmation_unavailable",
        terminal_command: "nxis agents configure support",
      });
    });
    expect(writes()).toHaveLength(0);
  });

  it("refuses nothing to change, clearing a required setting of an agent that is on, and a setting both set and cleared", async () => {
    await withServe(person(), async (s) => {
      expect(body(await s.call("nxis_configure_agent", { agent: "support" }))).toMatchObject({ reason: "missing_settings" });
      expect(body(await s.call("nxis_configure_agent", { agent: "support", clear: ["label"] }))).toMatchObject({ reason: "missing_label" });
      expect(body(await s.call("nxis_configure_agent", { agent: "support", settings: { label: "A" }, clear: ["label"] }))).toMatchObject({ reason: "conflicting_settings" });
      expect(body(await s.call("nxis_configure_agent", { agent: "support", clear: ["colour"] }))).toMatchObject({ reason: "unknown_setting" });
      expect(s.asked).toHaveLength(0);
    });
    expect(writes()).toHaveLength(0);
  });
});

describe("nxis_disable_agent, nxis_pause_agents, nxis_resume_agents", () => {
  it("disable asks first, then turns the agent off and keeps its settings", async () => {
    await withServe(person(), async (s) => {
      const out = body(await s.call("nxis_disable_agent", { agent: "support" }));
      expect(out).toMatchObject({ ok: true, changed: true, agent: { enabled: false, settings: { label: "Help" } } });
      expect(s.asked[0]?.message).toContain("Turn off Support on example.com? It stops answering the site's visitors.");
    });
    expect(writes()).toEqual([expect.objectContaining({ url: `${BASE}/hostedAgents/support:setEnabled`, body: expect.objectContaining({ enabled: false }) })]);
  });

  it("disable, declined, sends nothing; an agent that is off is left as it is without asking", async () => {
    await withServe(person({ confirm: "decline" }), async (s) => {
      expect(body(await s.call("nxis_disable_agent", { agent: "support" }))).toMatchObject({ reason: "declined_by_user" });
    });
    await withServe(person(), async (s) => {
      expect(body(await s.call("nxis_disable_agent", { agent: "quote" }))).toMatchObject({ ok: true, changed: false });
      expect(s.asked).toHaveLength(0);
    });
    expect(writes()).toHaveLength(0);
  });

  it("pause never asks, even when the client can't: one agent by its own pause, or the whole site", async () => {
    await withServe(null, async (s) => {
      const one = body(await s.call("nxis_pause_agents", { agent: "support", tools: true, reason: "Back soon" }));
      expect(one).toMatchObject({ ok: true, changed: true, agent: { kill_switch: { scope: "tools", reason: "Back soon" } } });
      expect(body(await s.call("nxis_pause_agents", {}))).toMatchObject({ ok: true, changed: true, kill_switch: { scope: "agent" } });
    });
    expect(writes().map((w) => [w.method, w.url.split("?")[0]])).toEqual([
      ["PATCH", `${BASE}/hostedAgents/support`],
      ["PATCH", `${BASE}/agentConfig`],
    ]);
  });

  it("pause refuses a reason over 200 characters by the schema", async () => {
    await withServe(null, async (s) => {
      await refusedBySchema(s.call("nxis_pause_agents", { reason: "x".repeat(201) }), "reason");
    });
    expect(writes()).toHaveLength(0);
  });

  it("resume asks first, for one agent or the whole site, and a decline sends nothing", async () => {
    agents["support"] = { enabled: true, settings: { label: "Help" }, kill: { scope: "AGENT", reason: "" } };
    siteKill = { scope: "AGENT", reason: "" };
    await withServe(person({ confirm: "decline" }), async (s) => {
      expect(body(await s.call("nxis_resume_agents", { agent: "support" }))).toMatchObject({ reason: "declined_by_user" });
    });
    expect(writes()).toHaveLength(0);
    await withServe(person(), async (s) => {
      expect(body(await s.call("nxis_resume_agents", { agent: "support" }))).toMatchObject({ ok: true, changed: true, agent: { kill_switch: null } });
      expect(s.asked[0]?.message).toContain("Resume Support on example.com? It answers the site's visitors again.");
      expect(body(await s.call("nxis_resume_agents", {}))).toMatchObject({ ok: true, changed: true, kill_switch: null });
      expect(s.asked[1]?.message).toContain("Resume every hosted agent on example.com?");
    });
    expect(writes()).toHaveLength(2);
  });

  it("resume without elicitation is confirmation_unavailable with the terminal command", async () => {
    await withServe(null, async (s) => {
      expect(body(await s.call("nxis_resume_agents", {}))).toMatchObject({ reason: "confirmation_unavailable", terminal_command: "nxis agents resume" });
    });
    expect(writes()).toHaveLength(0);
  });
});

describe("nxis_agents_brand", () => {
  it("asks with what visitors will see, then sets only the parts given", async () => {
    await withServe(person(), async (s) => {
      const out = body(await s.call("nxis_agents_brand", { name: "Ridgeline", accent: "#C73A17", logo: "https://cdn.example.com/logo.svg", clear: ["privacy_url"] }));
      expect(out).toMatchObject({ ok: true, changed: true });
      expect(s.asked[0]?.message).toContain("Change how the on-page chat looks to visitors on example.com?");
      expect(s.asked[0]?.message).toContain('name "Ridgeline"');
      expect(s.asked[0]?.message).toContain("logo cdn.example.com");
      expect(s.asked[0]?.message).toContain("Back to the default: privacy page.");
    });
    const sent = writes()[0]?.body as Json;
    expect((sent["page"] as Json)["branding"]).toEqual({ name: "Ridgeline", accentColor: "#C73A17", logoUrl: "https://cdn.example.com/logo.svg" });
  });

  it("refuses a bad accent or a non-https logo before asking", async () => {
    await withServe(person(), async (s) => {
      expect(body(await s.call("nxis_agents_brand", { accent: "red" }))).toMatchObject({ reason: "invalid_accent" });
      expect(body(await s.call("nxis_agents_brand", { logo: "/logo.svg" }))).toMatchObject({ reason: "invalid_url" });
      await refusedBySchema(s.call("nxis_agents_brand", { clear: ["colour"] }), "clear");
      expect(s.asked).toHaveLength(0);
    });
    expect(writes()).toHaveLength(0);
  });
});

