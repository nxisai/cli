/**
 * The organization tools of `nxis mcp serve`: list, use and create, against an in-process accounts
 * service, and the server acting on the organization chosen from its next call on, with no restart.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSettings } from "../src/state.js";
import { ORG_TOOLS, TOOLS } from "../src/tools/index.js";
import { cmdOrgsList } from "../src/commands/orgs.js";
import { capture, cleanFake, fake, ORG, resetFake, startFake, stopFake, type AuthSeen } from "./support/fake-endpoints.js";
import { body, fakeJwt, guidedServe, type GuidedSession } from "./support/guided.js";

type Json = Record<string, unknown>;
type Org = { id: string; name?: string; website?: string; onboarded?: boolean };

const OTHER = "0000000000000000000000aa";
const SITE = "0123456789abcdef01234567";

let orgs: Org[];
let created: number;

function accounts(req: AuthSeen) {
  const raw = (o: Org) => ({ _id: { value: o.id }, ...(o.name ? { name: o.name } : {}), ...(o.website ? { website: o.website } : {}), ...(o.onboarded ? { onboarded: true } : {}) });
  if (req.url === "/v1alpha/accounts/acct-1/organizations" && req.method === "GET") return { status: 200, body: { organizations: orgs.map(raw) } };
  if (req.url === "/v1alpha/organizations" && req.method === "POST") {
    const o = ((req.body as Json)["organization"] ?? {}) as Json;
    const org: Org = { id: `00000000000000000000new${created++}`, name: String(o["name"]), onboarded: true, ...(o["website"] ? { website: String(o["website"]) } : {}) };
    orgs.push(org);
    return { status: 200, body: raw(org) };
  }
  const m = req.url.match(/^\/v1alpha\/organizations\/([^/?]+)$/);
  if (m && req.method === "PATCH") {
    const org = orgs.find((o) => o.id === m[1]);
    if (!org) return { status: 404 };
    Object.assign(org, ((req.body as Json)["organization"] ?? {}) as Json, { onboarded: true });
    return { status: 200, body: raw(org) };
  }
  return { status: 404 };
}

beforeAll(startFake);
afterAll(stopFake);
beforeEach(() => {
  resetFake();
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  process.env.NXIS_TOKEN = fakeJwt();
  orgs = [
    { id: ORG, name: "Ridgeline", onboarded: true },
    { id: OTHER, name: "Harbor Labs", onboarded: true },
  ];
  created = 0;
  fake.accounts = accounts;
  fake.sites = () => ({ status: 200, body: { connections: [] } });
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NXIS_TOKEN;
  cleanFake();
});

/** A server with no --org: it acts on the saved organization, as read on each call. */
async function withServe<T>(answer: Parameters<typeof guidedServe>[0], run: (s: GuidedSession) => Promise<T>, ctx: Json = { orgOverride: undefined }): Promise<T> {
  const s = await guidedServe(answer, { ctx });
  try {
    return await run(s);
  } finally {
    await s.close();
  }
}

const yes = () => ({ action: "accept" as const, content: { confirm: true } });
const orgCalls = () => fake.accountsCalls.filter((c) => c.method !== "GET");

describe("the organization tools", () => {
  it("are listed first, local, strict, and only list is read-only", () => {
    expect(ORG_TOOLS.map((t) => t.name)).toEqual(["nxis_list_orgs", "nxis_use_org", "nxis_create_org"]);
    expect(TOOLS.slice(0, 3)).toEqual([...ORG_TOOLS]);
    for (const t of ORG_TOOLS) {
      expect(t.surface).toBe("local");
      expect(t.readOnly).toBe(t.name === "nxis_list_orgs");
    }
  });
});

describe("nxis_list_orgs", () => {
  it("lists the organizations and which is current, as `orgs list --json` does", async () => {
    const { ctx, out } = capture();
    delete ctx.orgOverride;
    await cmdOrgsList(ctx);
    await withServe(yes, async (s) => {
      const listed = body(await s.call("nxis_list_orgs"));
      expect(listed).toEqual(out.json);
      expect(listed).toMatchObject({ ok: true, current_org_id: null, orgs: [{ id: ORG, current: false }, { id: OTHER, current: false }] });
      expect(s.asked).toHaveLength(0);
    });
  });
});

describe("nxis_use_org", () => {
  it("switches without asking, and the server's next call acts on that organization", async () => {
    await withServe(yes, async (s) => {
      expect(body(await s.call("nxis_use_org", { org: "harbor labs" }))).toEqual({ ok: true, org_id: OTHER, name: "Harbor Labs" });
      expect(loadSettings().activeOrg).toBe(OTHER);
      expect(body(await s.call("nxis_list_orgs"))).toMatchObject({ current_org_id: OTHER });
      // A call that needs the organization: it goes to the one just chosen.
      expect((await s.call("nxis_list_connections", { site: SITE })).isError).toBeFalsy();
      expect(fake.sitesCalls.at(-1)?.url).toBe(`/v1/organizations/${OTHER}/sites/${SITE}/connections`);

      await s.call("nxis_use_org", { org: ORG });
      await s.call("nxis_list_connections", { site: SITE });
      expect(fake.sitesCalls.at(-1)?.url).toBe(`/v1/organizations/${ORG}/sites/${SITE}/connections`);
      expect(s.asked).toHaveLength(0);
    });
  });

  it("refuses an organization the user isn't a member of, and a name two have", async () => {
    orgs.push({ id: "0000000000000000000000bb", name: "Harbor Labs" });
    await withServe(yes, async (s) => {
      expect(body(await s.call("nxis_use_org", { org: "nope" }))).toMatchObject({ reason: "org_not_found" });
      expect(body(await s.call("nxis_use_org", { org: "Harbor Labs" }))).toMatchObject({ reason: "org_ambiguous", org_ids: [OTHER, "0000000000000000000000bb"] });
    });
    expect(loadSettings().activeOrg).toBeUndefined();
  });

  it("a server started with --org refuses to switch away from it", async () => {
    await withServe(
      yes,
      async (s) => {
        expect(body(await s.call("nxis_use_org", { org: OTHER }))).toMatchObject({ reason: "org_pinned", pinned_org_id: ORG });
        expect(body(await s.call("nxis_use_org", { org: "Ridgeline" }))).toMatchObject({ ok: true, org_id: ORG });
      },
      { orgOverride: ORG },
    );
  });
});

describe("nxis_create_org", () => {
  it("asks first, creates it named, and the next call acts on it", async () => {
    await withServe(yes, async (s) => {
      const out = body(await s.call("nxis_create_org", { name: "Cedar Studio", website: "https://cedar.example.com" }));
      expect(out).toMatchObject({ ok: true, name: "Cedar Studio", reused: false });
      expect(s.asked[0]?.message).toBe(
        'Create the NxisAI organization "Cedar Studio" in your account, with website cedar.example.com? It becomes the organization this server and the CLI act on.',
      );
      expect(body(await s.call("nxis_list_orgs"))).toMatchObject({ current_org_id: out["org_id"] });
    });
    expect(orgCalls()).toEqual([expect.objectContaining({ method: "POST", url: "/v1alpha/organizations" })]);
  });

  it("reuses the unnamed organization a browser sign-up left, and says so in the question", async () => {
    orgs = [{ id: OTHER }];
    await withServe(yes, async (s) => {
      expect(body(await s.call("nxis_create_org", { name: "Cedar Studio" }))).toMatchObject({ ok: true, org_id: OTHER, reused: true });
      expect(s.asked[0]?.message).toContain(`Name your unnamed NxisAI organization (${OTHER}, left by a sign-up in the browser) "Cedar Studio"?`);
    });
    expect(orgCalls()).toEqual([expect.objectContaining({ method: "PATCH", url: `/v1alpha/organizations/${OTHER}` })]);
    expect(loadSettings().activeOrg).toBe(OTHER);
  });

  it("works with no organization selected yet: nothing else is opened first", async () => {
    await withServe(yes, async (s) => {
      expect((await s.call("nxis_create_org", { name: "First" })).isError).toBeFalsy();
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("declined, dismissed, or with a client that can't ask, creates nothing", async () => {
    for (const reply of [{ action: "decline" as const }, { action: "cancel" as const }]) {
      await withServe(() => reply, async (s) => {
        expect(body(await s.call("nxis_create_org", { name: "Cedar Studio" }))).toMatchObject({ reason: reply.action === "cancel" ? "cancelled_by_user" : "declined_by_user" });
      });
    }
    await withServe(null, async (s) => {
      expect(body(await s.call("nxis_create_org", { name: "Cedar Studio" }))).toMatchObject({ reason: "confirmation_unavailable", terminal_command: "nxis orgs create" });
    });
    expect(orgCalls()).toHaveLength(0);
    expect(loadSettings().activeOrg).toBeUndefined();
  });

  it("refuses an empty name by the schema, before asking", async () => {
    await withServe(yes, async (s) => {
      expect((await s.call("nxis_create_org", { name: "  " })).isError).toBe(true);
      expect(s.asked).toHaveLength(0);
    });
    expect(orgCalls()).toHaveLength(0);
  });
});
