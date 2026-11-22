/**
 * `nxis agents dpa` and `nxis agents dpa accept`, and what `nxis agents status` says about the
 * agreement, against an in-process sites service.
 *
 * The fake answers the setup and the acceptance as the sites service does through its HTTP gateway: an
 * acceptance of anything but the current version is refused with FAILED_PRECONDITION (400 over
 * HTTP, gRPC code 9), with the service's own message.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/args.js";
import { camelKeys } from "../src/api/agent-config.js";
import { dpaBaseUrl, dpaUrl, parseAgentSetup } from "../src/api/agent-setup.js";
import { runHostedAgents } from "../src/commands/hosted-agents.js";
import { CliError } from "../src/errors.js";
import type { Asker } from "../src/prompt.js";
import { setTrace } from "../src/trace.js";
import { capture, cleanFake, fake, ORG, resetFake, startFake, stopFake } from "./support/fake-endpoints.js";

const SITE = "0123456789abcdef01234567";
const SETUP = `/v1/organizations/${ORG}/sites/${SITE}/agentSetup`;
const CONFIG = `/v1/organizations/${ORG}/sites/${SITE}/agentConfig`;
const ME = "auth0|owner";
const AT = "2026-11-16T14:05:00Z";

/** What the fake holds. */
let current = "";
let acceptances: Array<{ version: string; accepted_by: string; accept_time: string }> = [];
let live: boolean | undefined;
let style: "snake" | "camel" = "snake";
/** A version the fake publishes just before the next acceptance, as if it were published in between. */
let publishBeforeAccept: string | null = null;
/** The organization's acceptances, and the legal entity the site belongs to when it isn't the organization. */
let orgAcceptances: Array<{ version: string; accepted_by: string; accept_time: string }> = [];
let legalEntity = "";
let status = "";
let graceEnd = "";

function setupBody(): Record<string, unknown> {
  // As the service counts them: only the entity's for a site of another legal entity, else the organization's and
  // the site's own from before.
  const counted = legalEntity ? acceptances : [...orgAcceptances, ...acceptances];
  const latest = counted.at(-1);
  const body = {
    name: `organizations/${ORG}/sites/${SITE}/agentSetup`,
    current_dpa_version: current,
    dpa_current: Boolean(current) && counted.some((a) => a.version === current),
    ...(latest ? { dpa_acceptance: latest } : {}),
    dpa_acceptances: acceptances,
    organization_dpa_acceptances: orgAcceptances,
    ...(legalEntity ? { legal_entity: legalEntity } : {}),
    ...(status ? { dpa_status: status } : {}),
    ...(graceEnd ? { dpa_grace_end_time: graceEnd } : {}),
    agents: [{ agent: "page", available: true }],
  };
  return style === "camel" ? (camelKeys(body) as Record<string, unknown>) : body;
}

function service(): void {
  fake.sites = (req) => {
    if (req.url === CONFIG && req.method === "GET") {
      return { status: 200, body: { version: "4", page: { enabled: true }, ...(live !== undefined ? { live } : {}) } };
    }
    if (req.url === SETUP && req.method === "GET") return { status: 200, body: setupBody() };
    if (req.url === `${SETUP}:acceptDpa` && req.method === "POST") {
      if (publishBeforeAccept) {
        current = publishBeforeAccept;
        publishBeforeAccept = null;
      }
      const body = req.body as { name?: string; version?: string; legal_entity?: string };
      if (!current) {
        return { status: 400, body: { code: 9, message: "no data processing agreement is published yet (AGENT_DPA_VERSION)" } };
      }
      if (body.version !== current) {
        return { status: 400, body: { code: 9, message: `the current data processing agreement is version ${current}, not ${body.version}` } };
      }
      const entity = (body.legal_entity ?? "").trim();
      if (legalEntity && !entity) {
        return { status: 400, body: { code: 9, message: `this site belongs to ${legalEntity}, a different legal entity than its organization: ${legalEntity} accepts the agreement for it` } };
      }
      const a = { version: current, accepted_by: ME, accept_time: AT, ...(entity ? { legal_entity: entity } : {}) };
      if (entity) {
        legalEntity = entity;
        if (!acceptances.some((x) => x.version === current && (x as { legal_entity?: string }).legal_entity === entity)) acceptances = [...acceptances, a];
      } else if (!orgAcceptances.some((x) => x.version === current)) {
        orgAcceptances = [...orgAcceptances, a];
      }
      return { status: 200, body: setupBody() };
    }
    return { status: 404 };
  };
}

/** An asker that answers as told, and keeps the questions. */
function asker(answer: boolean, interactive = true): Asker & { asked: string[] } {
  const asked: string[] = [];
  return { interactive, asked, confirm: async (q) => (asked.push(q), answer) };
}

async function agents(argv: string[], ask: Asker = asker(false, false)) {
  const { positional, flags } = parseArgs(argv);
  const { ctx, out } = capture({ siteOverride: SITE });
  await runHostedAgents(ctx, positional, flags, ask);
  return out;
}

async function fails(argv: string[], reason: string, ask?: Asker): Promise<CliError> {
  const err = await agents(argv, ask).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CliError);
  expect((err as CliError).reason).toBe(reason);
  return err as CliError;
}

const accepts = () => fake.sitesCalls.filter((c) => c.method === "POST" && c.url.endsWith(":acceptDpa"));

let stderr: string[] = [];
beforeAll(startFake);
afterAll(stopFake);
beforeEach(() => {
  resetFake();
  process.env.NXIS_TOKEN = "header.payload.sig";
  delete process.env.NXIS_DPA_URL;
  current = "2026-11-16";
  acceptances = [];
  live = false;
  style = "snake";
  publishBeforeAccept = null;
  orgAcceptances = [];
  legalEntity = "";
  status = "";
  graceEnd = "";
  stderr = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => (stderr.push(String(chunk)), true));
  service();
});
afterEach(() => {
  vi.restoreAllMocks();
  setTrace({ verbose: false, dryRun: false });
  delete process.env.NXIS_DPA_URL;
  cleanFake();
});

describe("the agreement's address", () => {
  it("is https://nxis.ai/dpa/<version>, or under NXIS_DPA_URL", () => {
    expect(dpaBaseUrl({})).toBe("https://nxis.ai/dpa");
    expect(dpaBaseUrl({ NXIS_DPA_URL: "  " })).toBe("https://nxis.ai/dpa");
    expect(dpaBaseUrl({ NXIS_DPA_URL: "http://localhost:4321/dpa/" })).toBe("http://localhost:4321/dpa");
    expect(dpaUrl("2026-11-16")).toBe("https://nxis.ai/dpa/2026-11-16");
    expect(dpaUrl("a b", "https://staging.example.com/dpa")).toBe("https://staging.example.com/dpa/a%20b");
    expect(() => dpaBaseUrl({ NXIS_DPA_URL: "javascript:alert(1)" })).toThrow(/NXIS_DPA_URL/);
  });

  it("reads a setup in either naming", () => {
    const raw = { currentDpaVersion: "v2", dpaCurrent: true, dpaAcceptance: { version: "v2", acceptedBy: ME, acceptTime: AT } };
    expect(parseAgentSetup(raw)).toEqual({
      currentVersion: "v2",
      current: true,
      acceptance: { version: "v2", acceptedBy: ME, acceptTime: AT, legalEntity: "" },
      acceptances: [],
      organizationAcceptances: [],
      legalEntity: "",
      status: "",
      graceEnd: "",
    });
    expect(parseAgentSetup(null)).toEqual({
      currentVersion: "",
      current: false,
      acceptance: null,
      acceptances: [],
      organizationAcceptances: [],
      legalEntity: "",
      status: "",
      graceEnd: "",
    });
    // The status by name or by number.
    expect(parseAgentSetup({ dpa_status: "DPA_GRACE", dpa_grace_end_time: "2027-03-31T00:00:00Z" })).toMatchObject({ status: "grace", graceEnd: "2027-03-31T00:00:00Z" });
    expect(parseAgentSetup({ dpaStatus: 4 }).status).toBe("required");
  });
});

describe("nxis agents dpa", () => {
  it("shows the current version and its link, not accepted", async () => {
    const out = await agents(["dpa"]);
    expect(out.json).toEqual({
      ok: true,
      org: ORG,
      site: SITE,
      state: "not_accepted",
      version: "2026-11-16",
      url: "https://nxis.ai/dpa/2026-11-16",
      accepted: false,
      accepted_for: "organization",
      legal_entity: null,
      grace_end: null,
      acceptance: null,
      acceptances: [],
      organization_acceptances: [],
    });
    expect(out.text).toContain("Current version  2026-11-16");
    expect(out.text).toContain(`organization ${ORG} (all of its sites)`);
    expect(out.text).toContain("https://nxis.ai/dpa/2026-11-16");
    expect(out.text).toContain("nxis agents dpa accept");
    expect(accepts()).toEqual([]);
  });

  it.each(["snake", "camel"] as const)("shows who accepted it and when (%s_case)", async (s) => {
    style = s;
    acceptances = [{ version: "2026-11-16", accepted_by: ME, accept_time: AT }];
    const out = await agents(["dpa"]);
    expect(out.json).toMatchObject({
      state: "accepted",
      accepted: true,
      acceptance: { version: "2026-11-16", accepted_by: ME, accept_time: AT, url: "https://nxis.ai/dpa/2026-11-16" },
    });
    expect(out.text).toContain(`Accepted         yes, by ${ME} on 2026-11-16 14:05 UTC`);
  });

  it("shows a newer published version as not accepted, keeping the earlier acceptance", async () => {
    acceptances = [{ version: "2026-11-16", accepted_by: ME, accept_time: AT }];
    current = "2027-02-01";
    process.env.NXIS_DPA_URL = "https://staging.example.com/dpa";
    const out = await agents(["dpa"]);
    expect(out.json).toMatchObject({
      state: "newer_version",
      version: "2027-02-01",
      url: "https://staging.example.com/dpa/2027-02-01",
      accepted: false,
      acceptance: { version: "2026-11-16", url: "https://staging.example.com/dpa/2026-11-16" },
    });
    expect(out.text).toContain("not this version. Version 2026-11-16 was accepted");
    expect(out.text).toContain("version 2027-02-01 replaced it");
  });

  it("says none is published", async () => {
    current = "";
    const out = await agents(["dpa"]);
    expect(out.json).toMatchObject({ state: "not_published", version: null, url: null, accepted: false });
    expect(out.text).toContain("hasn't published it yet");
  });

  it("refuses another subcommand", async () => {
    await fails(["dpa", "reject"], "unknown_command");
  });
});

describe("nxis agents dpa accept", () => {
  it("stops with confirmation_required (exit 2), the version and the link, with no terminal and no --yes", async () => {
    const ask = asker(true, false);
    const err = await fails(["dpa", "accept"], "confirmation_required", ask);
    expect(err.exitCode).toBe(2);
    expect(err.toJSON()).toMatchObject({ version: "2026-11-16", url: "https://nxis.ai/dpa/2026-11-16", site: SITE });
    expect(err.message).toContain("Version 2026-11-16");
    expect(err.message).toContain("https://nxis.ai/dpa/2026-11-16");
    expect(err.message).toContain("--yes");
    expect(ask.asked).toEqual([]);
    expect(accepts()).toEqual([]);
  });

  it("on a terminal, prints the version and the link, then asks; a no accepts nothing", async () => {
    const ask = asker(false);
    const err = await fails(["dpa", "accept"], "cancelled", ask);
    expect(err.exitCode).toBe(2);
    expect(stderr.join("")).toContain("Version 2026-11-16");
    expect(stderr.join("")).toContain("Read it at https://nxis.ai/dpa/2026-11-16");
    expect(ask.asked).toEqual(["Accept the data processing agreement, version 2026-11-16?"]);
    expect(accepts()).toEqual([]);
  });

  it("on a yes, accepts exactly the version shown", async () => {
    const ask = asker(true);
    const out = await agents(["dpa", "accept"], ask);
    expect(ask.asked).toHaveLength(1);
    expect(accepts().map((c) => c.body)).toEqual([{ name: `organizations/${ORG}/sites/${SITE}/agentSetup`, version: "2026-11-16" }]);
    expect(out.json).toMatchObject({ state: "accepted", accepted: true, changed: true, acceptance: { accepted_by: ME, accept_time: AT } });
    expect(out.text).toContain(`Accepted the data processing agreement, version 2026-11-16, for organization ${ORG} (all of its sites).`);
  });

  it("--yes skips the question, with no terminal", async () => {
    const ask = asker(false, false);
    const out = await agents(["dpa", "accept", "--yes"], ask);
    expect(ask.asked).toEqual([]);
    expect(accepts()).toHaveLength(1);
    expect(out.json).toMatchObject({ changed: true, version: "2026-11-16" });
  });

  it("offers a newer version, naming the one it replaces", async () => {
    acceptances = [{ version: "2026-11-16", accepted_by: ME, accept_time: AT }];
    current = "2027-02-01";
    const ask = asker(true);
    await agents(["dpa", "accept"], ask);
    expect(stderr.join("")).toContain("It replaces version 2026-11-16");
    expect(accepts().map((c) => (c.body as { version: string }).version)).toEqual(["2027-02-01"]);
  });

  it("refuses a version published in between: dpa_version_changed (exit 2) with the new one to read", async () => {
    publishBeforeAccept = "2027-02-01";
    const err = await fails(["dpa", "accept", "--yes"], "dpa_version_changed");
    expect(err.exitCode).toBe(2);
    expect(err.toJSON()).toMatchObject({ version: "2027-02-01", url: "https://nxis.ai/dpa/2027-02-01", refused_version: "2026-11-16" });
    expect(accepts().map((c) => (c.body as { version: string }).version)).toEqual(["2026-11-16"]);
    expect(acceptances).toEqual([]);
  });

  it("with none published: dpa_not_published (exit 1), before asking or sending", async () => {
    current = "";
    const ask = asker(true);
    const err = await fails(["dpa", "accept", "--yes"], "dpa_not_published", ask);
    expect(err.exitCode).toBe(1);
    expect(err.message).not.toMatch(/AGENT_DPA_VERSION|nxisai\//);
    expect(ask.asked).toEqual([]);
    expect(accepts()).toEqual([]);
  });

  it("maps the service's own refusal when the agreement is withdrawn in between", async () => {
    fake.sites = (req) =>
      req.method === "GET"
        ? { status: 200, body: { current_dpa_version: "2026-11-16", dpa_current: false } }
        : { status: 400, body: { code: 9, message: "no data processing agreement is published yet (AGENT_DPA_VERSION)" } };
    const err = await fails(["dpa", "accept", "--yes"], "dpa_not_published");
    expect(err.message).not.toContain("AGENT_DPA_VERSION");
  });

  it("does nothing when the current version is already accepted", async () => {
    acceptances = [{ version: "2026-11-16", accepted_by: ME, accept_time: AT }];
    const ask = asker(true);
    const out = await agents(["dpa", "accept"], ask);
    expect(out.json).toMatchObject({ changed: false, state: "accepted" });
    expect(ask.asked).toEqual([]);
    expect(accepts()).toEqual([]);
  });

  it("sends nothing under --dry-run, and shows the request", async () => {
    setTrace({ verbose: false, dryRun: true });
    const err = await fails(["dpa", "accept"], "dry_run", asker(false, false));
    expect(err.exitCode).toBe(0);
    expect(err.toJSON()).toMatchObject({ method: "POST", body: { version: "2026-11-16" } });
    expect(accepts()).toEqual([]);
  });
});

describe("nxis agents status and the agreement", () => {
  it("says the agreement holds back going live, with the version and the link", async () => {
    const out = await agents(["status"]);
    expect(out.json).toMatchObject({
      live: false,
      dpa: { state: "not_accepted", version: "2026-11-16", url: "https://nxis.ai/dpa/2026-11-16", accepted: false },
      go_live_blocked_by: "dpa_not_accepted",
    });
    expect(out.text).toContain("Going live needs the data processing agreement (version 2026-11-16) accepted");
    expect(out.text).toContain("nxis agents dpa accept");
  });

  it("says a newer version holds it back too", async () => {
    acceptances = [{ version: "2026-11-16", accepted_by: ME, accept_time: AT }];
    current = "2027-02-01";
    const out = await agents(["status"]);
    expect(out.json).toMatchObject({ dpa: { state: "newer_version", version: "2027-02-01" }, go_live_blocked_by: "dpa_not_accepted" });
  });

  it("says when none is published", async () => {
    current = "";
    const out = await agents(["status"]);
    expect(out.json).toMatchObject({ go_live_blocked_by: "dpa_not_published", dpa: { state: "not_published", version: null } });
    expect(out.text).toContain("not published yet");
  });

  it("doesn't mention it once accepted, or for a live site", async () => {
    acceptances = [{ version: "2026-11-16", accepted_by: ME, accept_time: AT }];
    let out = await agents(["status"]);
    expect(out.json).toMatchObject({ go_live_blocked_by: null, live: false });
    expect(out.text).not.toContain("agreement");
    acceptances = [];
    live = true;
    out = await agents(["status"]);
    expect(out.json).toMatchObject({ go_live_blocked_by: null, live: true });
    expect(out.text).toContain("reached: the agents are live");
    expect(out.text).not.toContain("agreement");
  });

  it("still answers when the setup can't be read", async () => {
    const sites = fake.sites;
    fake.sites = (req) => (req.url === SETUP ? { status: 500, body: { message: "boom" } } : sites!(req));
    const out = await agents(["status"]);
    expect(out.json).toMatchObject({ dpa: null, go_live_blocked_by: null, version: 4 });
  });
});

describe("per organization, or a site's own legal entity", () => {
  it("accepts for the organization by default, covering all of its sites", async () => {
    const out = await agents(["dpa", "accept", "--yes"]);
    expect(accepts().map((c) => c.body)).toEqual([{ name: `organizations/${ORG}/sites/${SITE}/agentSetup`, version: "2026-11-16" }]);
    expect(out.json).toMatchObject({ accepted: true, accepted_for: "organization", legal_entity: null, organization_acceptances: [{ version: "2026-11-16" }] });
    expect(out.text).toContain(`for organization ${ORG} (all of its sites)`);
  });

  it("--entity accepts for the site's own legal entity, for that site only, after saying so", async () => {
    const ask = asker(true);
    const out = await agents(["dpa", "accept", "--entity", "  Ridgeline Air Services LLC "], ask);
    expect(stderr.join("")).toContain(`for Ridgeline Air Services LLC, the legal entity site ${SITE} belongs to (this site only)`);
    expect(stderr.join("")).toContain("authorized to bind Ridgeline Air Services LLC");
    expect(accepts().map((c) => c.body)).toEqual([
      { name: `organizations/${ORG}/sites/${SITE}/agentSetup`, version: "2026-11-16", legal_entity: "Ridgeline Air Services LLC" },
    ]);
    expect(out.json).toMatchObject({ accepted: true, accepted_for: "legal_entity", legal_entity: "Ridgeline Air Services LLC" });
  });

  it("a site already another legal entity's: accepting without --entity is refused before anything is sent", async () => {
    legalEntity = "Ridgeline Air Services LLC";
    const err = await fails(["dpa", "accept", "--yes"], "dpa_entity_required");
    expect(err.message).toContain('nxis agents dpa accept --entity "Ridgeline Air Services LLC"');
    expect(accepts()).toEqual([]);
    const shown = await agents(["dpa"]);
    expect(shown.text).toContain('nxis agents dpa accept --entity "Ridgeline Air Services LLC"');
  });

  it("--entity with no name, or one too long, is refused before anything is sent", async () => {
    await fails(["dpa", "accept", "--entity", "--yes"], "invalid_entity");
    await fails(["dpa", "accept", "--entity", "x".repeat(201), "--yes"], "invalid_entity");
    expect(accepts()).toEqual([]);
  });

  it("an earlier version in its grace: the date it keeps applying until", async () => {
    current = "2027-03-01";
    orgAcceptances = [{ version: "2026-11-16", accepted_by: ME, accept_time: AT }];
    status = "DPA_GRACE";
    graceEnd = "2027-03-31T00:00:00Z";
    const out = await agents(["dpa"]);
    expect(out.json).toMatchObject({ state: "newer_version", grace_end: "2027-03-31T00:00:00Z" });
    expect(out.text).toContain("it keeps applying until 2027-03-31");
  });
});

describe("nxis agents status and the agreement", () => {
  it("a site set up before preview, with the current version not accepted, waits on the agreement", async () => {
    live = undefined;
    status = "DPA_REQUIRED";
    const out = await agents(["status"]);
    expect(out.json).toMatchObject({ live: false, waiting_on_dpa: true, go_live_blocked_by: "dpa_not_accepted", dpa: { state: "not_accepted" } });
    expect(out.text).toContain("not reached: waiting on the data processing agreement (version 2026-11-16)");
  });

  it("during the grace: live, and until when", async () => {
    live = true;
    current = "2027-03-01";
    orgAcceptances = [{ version: "2026-11-16", accepted_by: ME, accept_time: AT }];
    status = "DPA_GRACE";
    graceEnd = "2027-03-31T00:00:00Z";
    const out = await agents(["status"]);
    expect(out.json).toMatchObject({ live: true, waiting_on_dpa: false, go_live_blocked_by: null, dpa: { grace_end: "2027-03-31T00:00:00Z" } });
    expect(out.text).toContain("reached until 2027-03-31");
  });
});
