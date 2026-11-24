/**
 * Guided setup: the data processing agreement (before `agents enable`, and `nxis_accept_dpa`),
 * and the autofill scope (path clusters with counts beside all pages), on a terminal and through
 * `nxis mcp serve` over MCP elicitation.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/args.js";
import { cmdAutofillSubmit } from "../src/commands/autofill.js";
import { runHostedAgents } from "../src/commands/hosted-agents.js";
import { endpointKey } from "../src/config.js";
import { saveCredentials } from "../src/credentials.js";
import { terminalGuide } from "../src/guide.js";
import { agreementBeforeEnable } from "../src/guided/agreement.js";
import type { Asker } from "../src/prompt.js";
import { capture, cleanFake, fake, ORG, resetFake, startFake, stopFake, toolCalls } from "./support/fake-endpoints.js";
import { body, expectNoSecrets, fakeJwt, guidedServe, scriptedTerminal } from "./support/guided.js";

beforeAll(startFake);
afterAll(stopFake);

let stderr: string[] = [];
beforeEach(() => {
  resetFake();
  stderr = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => (stderr.push(String(chunk)), true));
  const { ctx } = capture();
  saveCredentials({ accessToken: fakeJwt(), profile: ctx.config.profile, endpoints: endpointKey(ctx.config.endpoints) });
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanFake();
});

// ── The agreement ────────────────────────────────────────────────────────────

const SITE = "0123456789abcdef01234567";
const SETUP = `/v1/organizations/${ORG}/sites/${SITE}/agentSetup`;
const VERSION = "2026-11-16";

/** The sites service: an agreement at VERSION, accepted when `accepted`; the site another entity's when `entity`. */
function agreement(opts: { accepted?: boolean; entity?: string } = {}): void {
  let accepted = opts.accepted === true;
  let entity = opts.entity ?? "";
  fake.sites = (req) => {
    const setup = () => ({
      current_dpa_version: VERSION,
      dpa_current: accepted,
      ...(entity ? { legal_entity: entity } : {}),
      dpa_status: accepted ? "DPA_ACCEPTED" : "DPA_REQUIRED",
    });
    if (req.url === SETUP && req.method === "GET") return { status: 200, body: setup() };
    if (req.url === `${SETUP}:acceptDpa` && req.method === "POST") {
      accepted = true;
      entity = (req.body as { legal_entity?: string }).legal_entity ?? entity;
      return { status: 200, body: setup() };
    }
    return { status: 404 };
  };
}

const accepts = () => fake.sitesCalls.filter((c) => c.url === `${SETUP}:acceptDpa`).map((c) => c.body);

describe("the agreement before agents enable, on a terminal", () => {
  it("shows the version and link, and accepts for the organization when that is chosen", async () => {
    agreement();
    const t = scriptedTerminal(["1"]);
    await agreementBeforeEnable(capture({ siteOverride: SITE, guide: t.guide }).ctx, { yes: false, dryRun: false });
    expect(t.written()).toContain(`version ${VERSION}`);
    expect(t.written()).toContain(`https://nxis.ai/dpa/${VERSION}`);
    expect(t.written()).toContain(`1) Accept for organization ${ORG} (all of its sites)`);
    expect(t.written()).toContain("2) Accept for the legal entity");
    expect(accepts()).toEqual([{ name: `organizations/${ORG}/sites/${SITE}/agentSetup`, version: VERSION }]);
    expectNoSecrets([t.written()]);
  });

  it("accepts for the site's legal entity, by the name given", async () => {
    agreement();
    const t = scriptedTerminal(["2", "Ridgeline Air Services LLC"]);
    await agreementBeforeEnable(capture({ siteOverride: SITE, guide: t.guide }).ctx, { yes: false, dryRun: false });
    expect(accepts()).toEqual([
      { name: `organizations/${ORG}/sites/${SITE}/agentSetup`, version: VERSION, legal_entity: "Ridgeline Air Services LLC" },
    ]);
  });

  it("offers only the site's own legal entity when the site already has one", async () => {
    agreement({ entity: "Ridgeline Air Services LLC" });
    const t = scriptedTerminal(["1"]);
    await agreementBeforeEnable(capture({ siteOverride: SITE, guide: t.guide }).ctx, { yes: false, dryRun: false });
    expect(t.written()).toContain("1) Accept for Ridgeline Air Services LLC");
    expect(t.written()).not.toContain("2)");
    expect(accepts()).toEqual([expect.objectContaining({ legal_entity: "Ridgeline Air Services LLC" })]);
  });

  it("accepts nothing, and stops before enabling, on a cancel", async () => {
    agreement();
    const { positional, flags } = parseArgs(["enable", "quote"]);
    const { ctx } = capture({ siteOverride: SITE, guide: scriptedTerminal([""]).guide });
    await expect(runHostedAgents(ctx, positional, flags)).rejects.toMatchObject({ reason: "cancelled", details: { version: VERSION } });
    expect(accepts()).toHaveLength(0);
    expect(fake.sitesCalls.filter((c) => c.url.includes("hostedAgents"))).toHaveLength(0);
  });

  it("asks nothing with --yes, --json, --dry-run, or once it is accepted", async () => {
    agreement();
    const t = scriptedTerminal(["1"]);
    await agreementBeforeEnable(capture({ siteOverride: SITE, guide: t.guide }).ctx, { yes: true, dryRun: false });
    await agreementBeforeEnable(capture({ siteOverride: SITE, guide: t.guide }).ctx, { yes: false, dryRun: true });
    await agreementBeforeEnable(capture({ siteOverride: SITE, guide: terminalGuide({ json: true }) }).ctx, { yes: false, dryRun: false });
    agreement({ accepted: true });
    await agreementBeforeEnable(capture({ siteOverride: SITE, guide: t.guide }).ctx, { yes: false, dryRun: false });
    expect(t.written()).toBe("");
    expect(accepts()).toHaveLength(0);
  });
});

describe("nxis_accept_dpa through nxis mcp serve", () => {
  const serve = (answer: Parameters<typeof guidedServe>[0]) => guidedServe(answer, { ctx: { siteOverride: SITE } });

  it("asks who accepts, with the version and link and no default, and records the user's choice", async () => {
    agreement();
    const s = await serve(() => ({ action: "accept", content: { choice: "0" } }));
    try {
      const out = body(await s.call("nxis_accept_dpa"));
      expect(out).toMatchObject({ ok: true, changed: true, state: "accepted", version: VERSION });
      expect(s.asked[0]?.message).toContain(`https://nxis.ai/dpa/${VERSION}`);
      const schema = s.asked[0]?.requestedSchema as { properties: { choice: { oneOf: Array<{ title: string }>; default?: string } } };
      expect(schema.properties.choice.oneOf).toHaveLength(2);
      expect(schema.properties.choice.default).toBeUndefined();
      expect(accepts()).toEqual([{ name: `organizations/${ORG}/sites/${SITE}/agentSetup`, version: VERSION }]);
      expectNoSecrets(s.asked);
    } finally {
      await s.close();
    }
  });

  it("asks the legal entity's name for an acceptance for the site only", async () => {
    agreement();
    const s = await serve((_p, n) => (n === 0 ? { action: "accept", content: { choice: "1" } } : { action: "accept", content: { value: "Ridgeline Air Services LLC" } }));
    try {
      expect(body(await s.call("nxis_accept_dpa"))).toMatchObject({ changed: true, accepted_for: "legal_entity" });
      expect(accepts()).toEqual([expect.objectContaining({ legal_entity: "Ridgeline Air Services LLC" })]);
    } finally {
      await s.close();
    }
  });

  it("accepts nothing on a decline or a dismissal", async () => {
    agreement();
    for (const action of ["decline", "cancel"] as const) {
      const s = await serve(() => ({ action }));
      try {
        expect(body(await s.call("nxis_accept_dpa"))).toMatchObject({ reason: action === "decline" ? "declined_by_user" : "cancelled_by_user" });
      } finally {
        await s.close();
      }
    }
    expect(accepts()).toHaveLength(0);
  });

  it("refuses with the version, link and terminal command when the client can't ask", async () => {
    agreement();
    const s = await guidedServe(null, { ctx: { siteOverride: SITE } });
    try {
      const out = body(await s.call("nxis_accept_dpa"));
      expect(out).toMatchObject({ reason: "confirmation_unavailable", terminal_command: "nxis agents dpa accept", version: VERSION });
      expect(String(out["would_do"])).toContain(`https://nxis.ai/dpa/${VERSION}`);
      expect(accepts()).toHaveLength(0);
    } finally {
      await s.close();
    }
  });

  it("changes nothing when the current version is accepted", async () => {
    agreement({ accepted: true });
    const s = await serve(() => ({ action: "accept", content: { choice: "0" } }));
    try {
      expect(body(await s.call("nxis_accept_dpa"))).toMatchObject({ ok: true, changed: false, state: "accepted" });
      expect(s.asked).toHaveLength(0);
    } finally {
      await s.close();
    }
  });
});

// ── The autofill scope ───────────────────────────────────────────────────────

const GROUPS = `/v1/organizations/${ORG}/sites/site-1/resources:pageGroups`;
const CLUSTERS: Record<string, number> = { "/blog/*": 120, "/products/*": 80 };

/** The plan counts 240 pages, and a cluster's own count for a pattern; the sites service lists the clusters. */
function site(opts: { groups?: boolean } = {}): void {
  fake.responses["nxis_bulk_autofill"] = (a) =>
    a["mode"] === "plan"
      ? {
          mode: "plan",
          resource_count: 240,
          site_total: 240,
          ...(typeof a["pattern"] === "string" ? { pattern: a["pattern"], pattern_count: CLUSTERS[a["pattern"]] ?? 0 } : {}),
          existing: a["existing"] ?? "generate",
          ...(a["existing"] === "import" ? { import_cost_per_resource_milli: 500 } : {}),
        }
      : { mode: "submit", started: true, batch_id: "batch-1" };
  fake.sites = (req) =>
    req.url === GROUPS && req.method === "POST" && opts.groups !== false
      ? { status: 200, body: { byPattern: Object.entries(CLUSTERS).map(([pattern, count]) => ({ pattern, count })), total: 240 } }
      : { status: 404 };
  fake.billing = (req) =>
    req.url.endsWith("/quotas")
      ? {
          status: 200,
          body: { quotas: [{ metered_resource: { name: "credits" }, credit_limit_milli: 1_000_000, credit_usage_milli: 0, credit_topup_milli: 0 }] },
        }
      : { status: 404 };
}

const yes: Asker = { interactive: true, confirm: async () => true };
const submits = () => toolCalls().filter((c) => c.tool === "nxis_bulk_autofill" && c.args["mode"] === "submit");

describe("the autofill scope, on a terminal", () => {
  it("offers the path clusters with counts beside all pages, and submits the one chosen", async () => {
    site();
    const t = scriptedTerminal(["2"]);
    const { ctx, out } = capture({ guide: t.guide });
    await cmdAutofillSubmit(ctx, { existing: "import", asker: yes });
    expect(t.written()).toContain("1) All pages (240 pages, about 120 NXC)");
    expect(t.written()).toContain("2) /blog/* (120 pages, about 60 NXC)");
    expect(t.written()).toContain("3) /products/* (80 pages, about 40 NXC)");
    expect(submits().map((c) => c.args["pattern"])).toEqual(["/blog/*"]);
    // The confirmation's count is the narrowed plan's, not the site's resource_count.
    expect(stderr.join("")).toMatch(/Resources\s+(\S*)120/);
    expect(out.json).toMatchObject({ pattern: "/blog/*", planned_count: 120 });
  });

  it("keeps all pages when that is chosen", async () => {
    site();
    await cmdAutofillSubmit(capture({ guide: scriptedTerminal(["1"]).guide }).ctx, { asker: yes });
    expect(submits().map((c) => c.args["pattern"])).toEqual([undefined]);
  });

  it("submits nothing on a cancel", async () => {
    site();
    await expect(cmdAutofillSubmit(capture({ guide: scriptedTerminal([""]).guide }).ctx, { asker: yes })).rejects.toMatchObject({
      reason: "cancelled",
    });
    expect(submits()).toHaveLength(0);
  });

  it("asks nothing with --pattern, with --yes, or when the clusters can't be read", async () => {
    site();
    const t = scriptedTerminal(["2"]);
    await cmdAutofillSubmit(capture({ guide: t.guide }).ctx, { pattern: "/products/*", asker: yes });
    await cmdAutofillSubmit(capture({ guide: t.guide }).ctx, { yes: true });
    site({ groups: false });
    await cmdAutofillSubmit(capture({ guide: t.guide }).ctx, { asker: yes });
    expect(t.written()).toBe("");
    expect(submits().map((c) => c.args["pattern"])).toEqual(["/products/*", undefined, undefined]);
  });
});

describe("the autofill scope, through nxis mcp serve", () => {
  const submit = { mode: "submit", existing: "generate" };

  it("asks for the scope, then confirms with the narrowed count, and submits that scope", async () => {
    site();
    const s = await guidedServe((_p, n) => (n === 0 ? { action: "accept", content: { choice: "2" } } : { action: "accept", content: { confirm: true } }));
    try {
      const result = await s.call("nxis_bulk_autofill", submit);
      expect(result.isError).toBeFalsy();
      const schema = s.asked[0]?.requestedSchema as { properties: { choice: { oneOf: Array<{ title: string }> } } };
      expect(schema.properties.choice.oneOf.map((o) => o.title)).toEqual(["All pages (240 pages)", "/blog/* (120 pages)", "/products/* (80 pages)"]);
      expect(s.asked[1]?.message).toContain("Submit 80 resources?");
      expect(submits().map((c) => c.args["pattern"])).toEqual(["/products/*"]);
      expectNoSecrets(s.asked);
    } finally {
      await s.close();
    }
  });

  it("submits nothing when the user declines the scope", async () => {
    site();
    const s = await guidedServe(() => ({ action: "decline" }));
    try {
      expect(body(await s.call("nxis_bulk_autofill", submit))).toMatchObject({ reason: "declined_by_user" });
      expect(s.asked).toHaveLength(1);
      expect(submits()).toHaveLength(0);
    } finally {
      await s.close();
    }
  });

  it("doesn't ask for a scope when the call names one, or when the client can't ask", async () => {
    site();
    const s = await guidedServe(() => ({ action: "accept", content: { confirm: true } }));
    try {
      await s.call("nxis_bulk_autofill", { ...submit, pattern: "/blog/*" });
      expect(s.asked).toHaveLength(1);
      expect(s.asked[0]?.message).toContain("Submit 120 resources?");
    } finally {
      await s.close();
    }
    const none = await guidedServe(null);
    try {
      expect(body(await none.call("nxis_bulk_autofill", submit))).toMatchObject({ reason: "confirmation_unavailable" });
    } finally {
      await none.close();
    }
    expect(submits().map((c) => c.args["pattern"])).toEqual(["/blog/*"]);
  });
});
