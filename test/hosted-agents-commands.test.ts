/**
 * `nxis agents …`: a site's hosted agent settings, against an in-process sites service.
 *
 * The fake service keeps one config, answers GET with it (in snake_case or lowerCamelCase, as
 * different gateways do, with `version` as a string as int64 arrives), and applies a PATCH only at
 * the expected version, as the real one does.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { camelKeys } from "../src/api/agent-config.js";
import { runHostedAgents } from "../src/commands/hosted-agents.js";
import { CliError } from "../src/errors.js";
import { setTrace } from "../src/trace.js";
import { capture, cleanFake, fake, ORG, resetFake, startFake, stopFake } from "./support/fake-endpoints.js";

const SITE = "0123456789abcdef01234567";
const PATH = `/v1/organizations/${ORG}/sites/${SITE}/agentConfig`;
const INSTRUCTIONS = `/v1/organizations/${ORG}/sites/${SITE}/agentInstructions/page`;
const NOTICES = `/v1/organizations/${ORG}/agentNotices`;

/** The service's refusal of a policy with `systemPrompt`, as the HTTP transcoder sends INVALID_ARGUMENT. */
const REFUSED = { status: 400, body: { code: 3, message: "systemPrompt can't be set: hosted agents use NxisAI's instructions." } };

/** The fake's stored config, in lowerCamelCase. */
let stored: Record<string, unknown>;
/** How the fake names fields in its answers. */
let style: "snake" | "camel";
/** Writes someone else makes just before each of the next PATCHes, to force a conflict. */
let interleave = 0;
/** How the fake answers GET of the on-page assistant's instructions. */
let instructions: { status: number; body?: unknown };
/** How the fake answers GET of the organization's notices. */
let notices: { status: number; body?: unknown };
/** How the fake answers the next PATCH instead of applying it, when set. */
let patchAnswer: { status: number; body?: unknown } | null;

/** @returns The value with object keys in snake_case. */
function snakeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), snakeKeys(v)]),
    );
  }
  return value;
}

/** The config as the fake answers it: `version` as a string, keys in the current style. */
function answer(): Record<string, unknown> {
  const body = { ...stored, version: String(stored["version"]) };
  return (style === "snake" ? snakeKeys(body) : body) as Record<string, unknown>;
}

/** A sites service that behaves as AgentConfigService does through the HTTP transcoder. */
function service(): void {
  fake.sites = (req) => {
    const [path, query = ""] = req.url.split("?");
    if (path === INSTRUCTIONS && req.method === "GET") return instructions;
    if (path === NOTICES && req.method === "GET") return notices;
    if (path !== PATH) return { status: 404 };
    if (req.method === "GET") return { status: 200, body: answer() };
    if (req.method !== "PATCH") return { status: 405 };
    if (patchAnswer) return patchAnswer;
    if (interleave > 0) {
      interleave--;
      stored = { ...stored, version: (stored["version"] as number) + 1 };
    }
    const expected = Number(new URLSearchParams(query).get("expectedVersion"));
    if (expected > 0 && expected !== stored["version"]) {
      return { status: 409, body: { code: 10, message: "agent config version mismatch" } };
    }
    const body = camelKeys(req.body) as Record<string, unknown>;
    const version = (stored["version"] as number) + 1;
    const next: Record<string, unknown> = {
      ...body,
      version,
      verifiedHosts: stored["verifiedHosts"],
      mcpServer: stored["mcpServer"],
      updateTime: "2026-11-13T00:00:00Z",
    };
    if (typeof body["policy"] === "string" && body["policy"] !== stored["policy"] && body["policy"]) {
      next["policy"] = JSON.stringify({ ...JSON.parse(body["policy"] as string), version: `v${version}` });
    }
    stored = next;
    return { status: 200, body: answer() };
  };
}

/** A config with every field set, at version 12. */
function fullConfig(): Record<string, unknown> {
  return {
    name: `organizations/${ORG}/sites/${SITE}/agentConfig`,
    version: 12,
    page: { enabled: true, model: "" },
    support: { enabled: false, model: "", label: "Help", description: "Ask us", examples: ["Where is my order?"] },
    policy: JSON.stringify({ schema: 1, version: "v11", tools: { deny: ["refund"] } }),
    killSwitch: { scope: "KILL_SCOPE_UNSPECIFIED", reason: "" },
    monthlySpendCapNxc: "5000",
    bookingDestination: { integrationId: "int-1" },
    transcripts: { doNotStore: true, retentionDays: 7, webhookUrl: "https://hooks.example.com/t", webhookSecretId: "sec-1" },
    verifiedHosts: ["https://example.com"],
    mcpServer: { url: "https://example.com/mcp", public: true, apiKeyId: "" },
    updateTime: "2026-11-01T00:00:00Z",
  };
}

/** Runs `nxis agents <argv>` and returns what it emitted. */
async function agents(argv: string[], overrides: Parameters<typeof capture>[0] = {}) {
  const { positional, flags } = parseArgs(argv);
  const { ctx, out } = capture({ siteOverride: SITE, ...overrides });
  await runHostedAgents(ctx, positional, flags);
  return out;
}

/** Expects `nxis agents <argv>` to fail with this reason. */
async function fails(argv: string[], reason: string, overrides: Parameters<typeof capture>[0] = {}): Promise<CliError> {
  const err = await agents(argv, overrides).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CliError);
  expect((err as CliError).reason).toBe(reason);
  return err as CliError;
}

const patches = () => fake.sitesCalls.filter((c) => c.method === "PATCH");

beforeAll(startFake);
afterAll(stopFake);
beforeEach(() => {
  resetFake();
  process.env.NXIS_TOKEN = "header.payload.sig";
  stored = fullConfig();
  style = "snake";
  interleave = 0;
  patchAnswer = null;
  instructions = {
    status: 200,
    body: {
      name: `organizations/${ORG}/sites/${SITE}/agentInstructions/page`,
      agent: "page",
      type: "onpage",
      version: "3",
      text: "You are Ava, the assistant on the website of Ridgeline Air.\n\n  Answer from the page.\u001b[2J",
      values: { site: "Ridgeline Air", label: "Ava" },
      publish_time: "2026-11-14T09:30:00Z",
    },
  };
  notices = { status: 200, body: { notices: [] } };
  service();
});
afterEach(cleanFake);

describe("nxis agents status", () => {
  it.each(["snake", "camel"] as const)("reads a %s_case config, version as a string", async (s) => {
    style = s;
    stored = { ...stored, killSwitch: { scope: "TOOLS", reason: "Maintenance" } };
    const out = await agents(["status"]);
    expect(out.json).toEqual({
      ok: true,
      org: ORG,
      site: SITE,
      version: 12,
      page: {
        enabled: true,
        model: null,
        kill_switch: null,
        branding: { name: null, logo_url: null, accent_color: null },
        privacy_url: null,
      },
      support: { enabled: false, label: "Help", description: "Ask us", examples: ["Where is my order?"], model: null, kill_switch: null },
      kill_switch: { scope: "tools", reason: "Maintenance" },
      policy_version: "v11",
      transcripts: { store: false, retention_days: 7, webhook_url: "https://hooks.example.com/t", webhook_secret_id: "sec-1" },
      mcp_server: { url: "https://example.com/mcp", public: true, api_key_id: null },
      verified_hosts: ["https://example.com"],
      // `live` unset is live; this fake answers no agent setup, so the agreement is unknown.
      live: true,
      waiting_on_dpa: false,
      dpa: null,
      go_live_blocked_by: null,
      notices: [],
    });
    expect(out.text).toContain("version 12");
    expect(out.text).not.toContain("Notices");
    expect(out.text).toContain("not stored, webhook https://hooks.example.com/t");
    expect(out.text).toContain("turns without tools still answered");
    expect(patches()).toEqual([]);
  });

  it("reads an empty config at version 0, and says the Support Agent has no MCP server", async () => {
    stored = { name: "", version: 0 };
    const out = await agents(["status"]);
    expect(out.json).toMatchObject({
      version: 0,
      page: { enabled: false, model: null },
      support: { enabled: false, label: "", examples: [] },
      kill_switch: null,
      policy_version: null,
      mcp_server: null,
      verified_hosts: [],
    });
    expect(out.text).toContain("no MCP server: the Support Agent stays off at the edge");
    expect(out.text).toContain("built-in defaults");
  });

  it("shows the notices for this site that haven't been dismissed", async () => {
    notices = {
      status: 200,
      body: {
        notices: [
          {
            name: `organizations/${ORG}/agentNotices/instructions-replaced`,
            kind: "instructions_replaced",
            title: "Your on-page assistant now uses NxisAI's instructions",
            message: "NxisAI now sets the instructions its hosted agents follow.",
            sites: [`organizations/${ORG}/sites/${SITE}`],
            create_time: "2026-11-15T00:00:00Z",
          },
          {
            name: `organizations/${ORG}/agentNotices/other-site`,
            kind: "instructions_replaced",
            title: "About another site",
            message: "",
            sites: [`organizations/${ORG}/sites/ffffffffffffffffffffffff`],
          },
          {
            name: `organizations/${ORG}/agentNotices/old`,
            kind: "instructions_replaced",
            title: "Already dismissed",
            message: "",
            sites: [],
            dismiss_time: "2026-11-15T01:00:00Z",
          },
        ],
      },
    };
    const out = await agents(["status"]);
    expect(out.json["notices"]).toEqual([
      {
        name: `organizations/${ORG}/agentNotices/instructions-replaced`,
        kind: "instructions_replaced",
        title: "Your on-page assistant now uses NxisAI's instructions",
        message: "NxisAI now sets the instructions its hosted agents follow.",
        create_time: "2026-11-15T00:00:00Z",
      },
    ]);
    expect(out.text).toContain("Notices\n  - Your on-page assistant now uses NxisAI's instructions");
    expect(out.text).not.toContain("another site");
    expect(out.text).not.toContain("Already dismissed");
  });

  it("still shows the status when the notices can't be read", async () => {
    notices = { status: 404 };
    const out = await agents(["status"]);
    expect(out.json).toMatchObject({ ok: true, version: 12, notices: null });
    expect(out.text).not.toContain("Notices");
  });

  it("resolves a domain to the site's id", async () => {
    fake.sites = (req) => (req.url === `/v1/organizations/${ORG}/sites/site-1/agentConfig` ? { status: 200, body: { version: 3 } } : { status: 404 });
    const out = await agents(["status"], { siteOverride: "example.com" });
    expect(out.json).toMatchObject({ site: "site-1", version: 3 });
  });

  it("needs an organization and a site", async () => {
    await fails(["status"], "no_active_site", { siteOverride: undefined });
  });
});

describe("writes", () => {
  it("round-trips every field it does not change, with expectedVersion", async () => {
    const before = fullConfig();
    const out = await agents(["disable", "page"]);
    const [patch] = patches();
    expect(patch?.url).toBe(`${PATH}?expectedVersion=12`);
    expect(patch?.body).toEqual({
      name: before["name"],
      page: { enabled: false, model: "" },
      support: before["support"],
      policy: before["policy"],
      killSwitch: before["killSwitch"],
      monthlySpendCapNxc: "5000",
      bookingDestination: { integrationId: "int-1" },
      transcripts: before["transcripts"],
    });
    expect(out.json).toMatchObject({ ok: true, changed: true, version: 13, page: { enabled: false } });
    expect(out.text).toContain("reaches the site within seconds");
  });

  it("sends lowerCamelCase when the config was read in snake_case", async () => {
    style = "snake";
    await agents(["pause"]);
    const body = patches()[0]?.body as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(expect.arrayContaining(["killSwitch", "bookingDestination", "monthlySpendCapNxc"]));
    expect(JSON.stringify(body)).not.toMatch(/_[a-z]+"\s*:/);
    expect((body["transcripts"] as Record<string, unknown>)["webhookSecretId"]).toBe("sec-1");
  });

  it("skips the write when the config already matches", async () => {
    const out = await agents(["enable", "page"]);
    expect(patches()).toEqual([]);
    expect(out.json).toMatchObject({ ok: true, changed: false, version: 12 });
    await agents(["resume"]);
    expect(patches()).toEqual([]);
  });

  it("sends no write under --dry-run", async () => {
    setTrace({ verbose: false, dryRun: true });
    const err = await fails(["disable", "page"], "dry_run");
    expect(err.details).toMatchObject({ method: "PATCH", url: expect.stringContaining("expectedVersion=12") });
    expect(patches()).toEqual([]);
    expect(stored["version"]).toBe(12);
  });

  it("retries once on a version conflict, against the config as it now is", async () => {
    interleave = 1;
    const out = await agents(["disable", "page"]);
    expect(patches().map((p) => p.url)).toEqual([`${PATH}?expectedVersion=12`, `${PATH}?expectedVersion=13`]);
    expect(out.json).toMatchObject({ changed: true, version: 14 });
  });

  it("reports version_conflict when the retry conflicts too", async () => {
    interleave = 2;
    const err = await fails(["disable", "page"], "version_conflict");
    expect(err.exitCode).toBe(1);
    expect(err.message).toContain("Run the command again");
    expect(patches()).toHaveLength(2);
  });
});

describe("nxis agents enable|disable", () => {
  it("enables the Support Agent with its existing label, replacing the examples when given", async () => {
    const out = await agents(["enable", "support", "--example", "Do you ship to Canada?", "--example", "What sizes?", "--model", "claude-x"]);
    expect((patches()[0]?.body as Record<string, unknown>)["support"]).toEqual({
      enabled: true,
      model: "claude-x",
      label: "Help",
      description: "Ask us",
      examples: ["Do you ship to Canada?", "What sizes?"],
    });
    expect(out.json).toMatchObject({ support: { enabled: true, label: "Help", model: "claude-x" } });
  });

  it("refuses the Support Agent without a label, before writing", async () => {
    stored = { name: "", version: 0 };
    await fails(["enable", "support"], "missing_label");
    expect(patches()).toEqual([]);
    await agents(["enable", "support", "--label", "Support"]);
    expect(patches()[0]?.url).toBe(`${PATH}?expectedVersion=0`);
    expect((patches()[0]?.body as Record<string, unknown>)["name"]).toBe(`organizations/${ORG}/sites/${SITE}/agentConfig`);
  });

  it("checks the service's limits before sending anything", async () => {
    await fails(["enable", "support", "--label", "x".repeat(101)], "label_too_long");
    await fails(["enable", "support", "--description", "x".repeat(301)], "description_too_long");
    await fails(["enable", "support", ...Array.from({ length: 11 }, (_, i) => ["--example", `q${i}`]).flat()], "too_many_examples");
    await fails(["enable", "support", "--example", "x".repeat(201)], "example_too_long");
    await fails(["pause", "--reason", "x".repeat(201)], "reason_too_long");
    expect(fake.sitesCalls).toEqual([]);
    await agents(["enable", "support", "--label", "x".repeat(100)]);
    expect(patches()).toHaveLength(1);
  });

  it("disables the Support Agent, keeping its settings", async () => {
    stored = { ...stored, support: { ...(stored["support"] as object), enabled: true } };
    await agents(["disable", "support"]);
    expect((patches()[0]?.body as Record<string, unknown>)["support"]).toMatchObject({ enabled: false, label: "Help", examples: ["Where is my order?"] });
  });

  it("asks which agent", async () => {
    await fails(["enable"], "missing_agent");
    await fails(["disable", "chat"], "missing_agent");
  });
});

describe("nxis agents pause|resume", () => {
  it("pauses every turn, or only tools with --tools", async () => {
    const out = await agents(["pause", "--reason", "Back soon"]);
    expect((patches()[0]?.body as Record<string, unknown>)["killSwitch"]).toEqual({ scope: "AGENT", reason: "Back soon" });
    expect(out.json).toMatchObject({ kill_switch: { scope: "agent", reason: "Back soon" } });

    const tools = await agents(["pause", "--tools"]);
    expect((patches()[1]?.body as Record<string, unknown>)["killSwitch"]).toEqual({ scope: "TOOLS", reason: "Back soon" });
    expect(tools.json).toMatchObject({ kill_switch: { scope: "tools" } });
  });

  it("reads a kill scope sent as a number", async () => {
    stored = { ...stored, killSwitch: { scope: 1, reason: "" } };
    expect((await agents(["status"])).json["kill_switch"]).toEqual({ scope: "agent", reason: "" });
  });

  it("resumes", async () => {
    stored = { ...stored, killSwitch: { scope: "AGENT", reason: "x" } };
    const out = await agents(["resume"]);
    expect((patches()[0]?.body as Record<string, unknown>)["killSwitch"]).toEqual({ scope: "KILL_SCOPE_UNSPECIFIED", reason: "" });
    expect(out.json).toMatchObject({ changed: true, kill_switch: null });
  });

  it("pauses one agent by name, leaving the site-wide switch and the agent's other settings as they were", async () => {
    const out = await agents(["pause", "support", "--reason", "Back at 9"]);
    const body = patches()[0]?.body as Record<string, Record<string, unknown>>;
    expect(body["support"]).toEqual({
      enabled: false,
      model: "",
      label: "Help",
      description: "Ask us",
      examples: ["Where is my order?"],
      killSwitch: { scope: "AGENT", reason: "Back at 9" },
    });
    expect(body["killSwitch"]).toEqual({ scope: "KILL_SCOPE_UNSPECIFIED", reason: "" });
    expect(body["page"]).toEqual({ enabled: true, model: "" });
    expect(out.json).toMatchObject({
      changed: true,
      kill_switch: null,
      page: { kill_switch: null },
      support: { kill_switch: { scope: "agent", reason: "Back at 9" } },
    });
    expect(out.text).toContain('paused: every turn refused ("Back at 9")');

    const page = await agents(["pause", "page", "--tools"]);
    expect((patches()[1]?.body as Record<string, Record<string, unknown>>)["page"]).toEqual({
      enabled: true,
      model: "",
      killSwitch: { scope: "TOOLS", reason: "" },
    });
    expect(page.json).toMatchObject({ page: { kill_switch: { scope: "tools" } }, support: { kill_switch: { scope: "agent" } } });

    // Already paused that way: nothing is sent.
    expect((await agents(["pause", "page", "--tools"])).json).toMatchObject({ changed: false });
    expect(patches()).toHaveLength(2);
  });

  it("resumes one agent by name; resuming the site leaves an agent paused by name paused", async () => {
    stored = {
      ...stored,
      killSwitch: { scope: "AGENT", reason: "" },
      support: { ...(stored["support"] as object), killSwitch: { scope: "TOOLS", reason: "x" } },
    };
    const site = await agents(["resume"]);
    expect(site.json).toMatchObject({ kill_switch: null, support: { kill_switch: { scope: "tools", reason: "x" } } });

    const support = await agents(["resume", "support"]);
    expect((patches()[1]?.body as Record<string, Record<string, unknown>>)["support"]?.["killSwitch"]).toEqual({
      scope: "KILL_SCOPE_UNSPECIFIED",
      reason: "",
    });
    expect(support.json).toMatchObject({ changed: true, support: { kill_switch: null } });

    // An agent that isn't paused: nothing to resume.
    expect((await agents(["resume", "page"])).json).toMatchObject({ changed: false });
  });

  it("refuses an agent that isn't page or support", async () => {
    await fails(["pause", "chat"], "unknown_agent");
    await fails(["resume", "booking"], "unknown_agent");
    expect(patches()).toEqual([]);
  });
});

describe("nxis agents policy", () => {
  const file = (name: string, content: string) => {
    const path = join(tmpdir(), `nxis-policy-${process.pid}-${name}`);
    writeFileSync(path, content);
    return path;
  };

  it("sends the document as compact JSON text and prints the version the service set", async () => {
    const out = await agents(["policy", "set", file("ok.json", '{\n  "schema": 1,\n  "tools": { "deny": ["refund", "cancel"] }\n}\n')]);
    expect((patches()[0]?.body as Record<string, unknown>)["policy"]).toBe('{"schema":1,"tools":{"deny":["refund","cancel"]}}');
    expect(out.json).toMatchObject({ changed: true, version: 13, policy_version: "v13" });
  });

  it("does not write a policy that matches apart from its version and key order", async () => {
    const out = await agents(["policy", "set", file("same.json", '{"tools":{"deny":["refund"]},"schema":1,"version":"v1"}')]);
    expect(patches()).toEqual([]);
    expect(out.json).toMatchObject({ changed: false });
  });

  it("refuses a file that isn't a JSON object, before sending anything", async () => {
    await fails(["policy", "set", file("bad.json", "{ nope")], "invalid_policy");
    await fails(["policy", "set", file("array.json", "[1, 2]")], "invalid_policy");
    await fails(["policy", "set", join(tmpdir(), "nxis-no-such-policy.json")], "invalid_policy");
    await fails(["policy", "set"], "missing_policy_file");
    expect(fake.sitesCalls).toEqual([]);
  });

  it("refuses a policy with systemPrompt before sending anything, whatever its value", async () => {
    for (const value of ['"Be terse."', '""', "null"]) {
      const err = await fails(["policy", "set", file("prompt.json", `{"schema":1,"systemPrompt":${value}}`)], "system_prompt_not_settable");
      expect(err.exitCode).toBe(2);
      expect(err.message).toBe(
        `Hosted agents use NxisAI's instructions, so the policy can't set them. Remove "systemPrompt" from the policy to save the rest.`,
      );
      expect(err.toJSON()).toMatchObject({ ok: false, reason: "system_prompt_not_settable", field: "systemPrompt" });
    }
    expect(patches()).toEqual([]);
  });

  it("saves a policy whose systemPrompt is nested, not top-level, as the service does", async () => {
    await agents(["policy", "set", file("nested.json", '{"schema":1,"notes":{"systemPrompt":"x"}}')]);
    expect(patches()).toHaveLength(1);
  });

  it("maps the service's refusal of systemPrompt to the same reason and message", async () => {
    patchAnswer = REFUSED;
    const err = await fails(["policy", "set", file("ok2.json", '{"schema":1}')], "system_prompt_not_settable");
    expect(err.exitCode).toBe(2);
    expect(err.message).toContain('Remove "systemPrompt" from the policy to save the rest.');
    expect(err.message).not.toMatch(/INVALID_ARGUMENT|#\d/);
  });

  it("leaves other refusals as the service's own message", async () => {
    patchAnswer = { status: 400, body: { code: 3, message: "policy is over 65536 bytes" } };
    const err = await fails(["policy", "set", file("ok3.json", '{"schema":1}')], "request_failed");
    expect(err.message).toBe("policy is over 65536 bytes");
  });

  it("shows the document and the instructions' version, without their text", async () => {
    const out = await agents(["policy", "show"]);
    expect(out.json).toEqual({
      ok: true,
      org: ORG,
      site: SITE,
      version: 12,
      policy_version: "v11",
      policy: { schema: 1, version: "v11", tools: { deny: ["refund"] } },
      instructions: { type: "onpage", version: 3, publish_time: "2026-11-14T09:30:00Z" },
    });
    expect(out.text).toContain('"deny": [');
    expect(out.text).toContain("Instructions: NxisAI, version 3, published 2026-11-14");
    expect(out.text).not.toContain("Ridgeline Air");
    stored = { name: "", version: 0 };
    expect((await agents(["policy", "show"])).json["policy"]).toBeNull();
  });

  it("prints the instructions in full with --instructions, lines kept and control characters removed", async () => {
    const out = await agents(["policy", "show", "--instructions"]);
    expect(out.json["instructions"]).toEqual({
      type: "onpage",
      version: 3,
      publish_time: "2026-11-14T09:30:00Z",
      text: "You are Ava, the assistant on the website of Ridgeline Air.\n\n  Answer from the page.\u001b[2J",
    });
    expect(out.text).toContain(
      "Instructions: NxisAI, version 3, published 2026-11-14\n\nYou are Ava, the assistant on the website of Ridgeline Air.\n\n  Answer from the page. [2J",
    );
    expect(out.text).not.toContain("\u001b");
  });

  it("still shows the policy when the instructions can't be read, unless they were asked for", async () => {
    instructions = { status: 404, body: { code: 5, message: "Not found" } };
    const out = await agents(["policy", "show"]);
    expect(out.json).toMatchObject({ policy_version: "v11", instructions: null });
    expect(out.text).not.toContain("Instructions:");
    await fails(["policy", "show", "--instructions"], "request_failed");
  });
});

describe("nxis agents brand", () => {
  const LOGO = "https://wrenfield-events.example.com/logo-mark.svg";
  const PRIVACY = "https://wrenfield-events.example.com/privacy/";
  const page = () => (patches()[0]?.body as Record<string, unknown>)["page"];

  it("sets the name, logo, accent and privacy link, and status shows them", async () => {
    const out = await agents(["brand", "--name", "Wrenfield", "--logo", LOGO, "--accent", "#C73A17", "--privacy-url", PRIVACY]);
    expect(patches()[0]?.url).toBe(`${PATH}?expectedVersion=12`);
    expect(page()).toEqual({
      enabled: true,
      model: "",
      branding: { name: "Wrenfield", logoUrl: LOGO, accentColor: "#C73A17" },
      privacyUrl: PRIVACY,
    });
    expect(out.json).toMatchObject({
      changed: true,
      version: 13,
      page: { enabled: true, branding: { name: "Wrenfield", logo_url: LOGO, accent_color: "#C73A17" }, privacy_url: PRIVACY },
    });
    const status = await agents(["status"]);
    expect(status.json).toMatchObject({
      page: { branding: { name: "Wrenfield", logo_url: LOGO, accent_color: "#C73A17" }, privacy_url: PRIVACY },
    });
    expect(status.text).toContain('chat name "Wrenfield", logo https://wrenfield-events.example.com/logo-mark.svg, accent #C73A17');
    expect(status.text).toContain(`privacy page ${PRIVACY}`);
  });

  it("changes only the part given, leaving the rest of the branding and every other setting as it was", async () => {
    style = "snake";
    stored = {
      ...stored,
      page: { enabled: true, model: "m-1", killSwitch: { scope: "TOOLS", reason: "x" }, branding: { name: "Old", logoUrl: LOGO, accentColor: "#123", futurePart: "kept" }, privacyUrl: PRIVACY },
    };
    await agents(["brand", "--accent", "#abcdef"]);
    expect(page()).toEqual({
      enabled: true,
      model: "m-1",
      killSwitch: { scope: "TOOLS", reason: "x" },
      branding: { name: "Old", logoUrl: LOGO, accentColor: "#abcdef", futurePart: "kept" },
      privacyUrl: PRIVACY,
    });
    const body = patches()[0]?.body as Record<string, unknown>;
    expect(body["support"]).toEqual(fullConfig()["support"]);
    expect(body["transcripts"]).toEqual(fullConfig()["transcripts"]);
  });

  it("clears one part with --clear, and the privacy link with --clear privacy-url", async () => {
    stored = { ...stored, page: { enabled: true, branding: { name: "Old", logoUrl: LOGO, accentColor: "#123" }, privacyUrl: PRIVACY } };
    const out = await agents(["brand", "--clear", "logo", "--clear", "privacy-url"]);
    expect(page()).toEqual({ enabled: true, branding: { name: "Old", logoUrl: "", accentColor: "#123" }, privacyUrl: "" });
    expect(out.json).toMatchObject({ page: { branding: { name: "Old", logo_url: null, accent_color: "#123" }, privacy_url: null } });
  });

  it("sends nothing when the branding already says so, or when clearing what is unset", async () => {
    stored = { ...stored, page: { enabled: true, branding: { name: "Wrenfield" } } };
    const out = await agents(["brand", "--name", "  Wrenfield "]);
    expect(out.json).toMatchObject({ changed: false, version: 12 });
    await agents(["brand", "--clear", "accent", "--clear", "privacy-url"]);
    expect(patches()).toEqual([]);
  });

  it("sends no write under --dry-run, and retries once on a version conflict", async () => {
    setTrace({ verbose: false, dryRun: true });
    const err = await fails(["brand", "--name", "Wrenfield"], "dry_run");
    expect(err.details).toMatchObject({ method: "PATCH", body: { page: { branding: { name: "Wrenfield" } } } });
    expect(patches()).toEqual([]);
    setTrace({ verbose: false, dryRun: false });
    interleave = 1;
    const out = await agents(["brand", "--name", "Wrenfield"]);
    expect(patches().map((p) => p.url)).toEqual([`${PATH}?expectedVersion=12`, `${PATH}?expectedVersion=13`]);
    expect(out.json).toMatchObject({ changed: true, version: 14 });
  });

  it.each([
    [["--name", "   "], "invalid_name"],
    [["--name", "x".repeat(61)], "name_too_long"],
    [["--name"], "missing_value"],
    [["--logo", "http://example.com/logo.svg"], "invalid_url"],
    [["--logo", "/logo-mark.svg"], "invalid_url"],
    [["--logo", "javascript:alert(1)"], "invalid_url"],
    [["--logo", '<img src="https://example.com/x.svg">'], "invalid_url"],
    [["--logo", 'https://example.com/x.svg" onload="x'], "invalid_url"],
    [["--logo", `https://example.com/${"x".repeat(2040)}`], "invalid_url"],
    [["--privacy-url", "example.com/privacy"], "invalid_url"],
    [["--privacy-url", "https:///privacy"], "invalid_url"],
    [["--accent", "C73A17"], "invalid_accent"],
    [["--accent", "#C73A1"], "invalid_accent"],
    [["--accent", "red"], "invalid_accent"],
    [["--clear", "color"], "invalid_clear"],
    [["--name", "A", "--clear", "name"], "conflicting_flags"],
    [[], "missing_branding"],
  ])("refuses %j with %s, before sending anything", async (argv, reason) => {
    const err = await fails(["brand", ...argv], reason);
    expect(err.exitCode).toBe(1);
    expect(fake.sitesCalls).toEqual([]);
  });

  it("takes the limits exactly: a 60-character name, #rgb, and a 2,048-character URL", async () => {
    const url = `https://example.com/${"x".repeat(2048 - "https://example.com/".length)}`;
    await agents(["brand", "--name", "x".repeat(60), "--accent", "#c73", "--logo", url]);
    expect(page()).toMatchObject({ branding: { name: "x".repeat(60), accentColor: "#c73", logoUrl: url } });
  });
});
