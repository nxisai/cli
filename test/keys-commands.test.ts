/**
 * `nxis keys create|list|revoke`: site keys, against an in-process authorization service and
 * provisioning endpoint.
 *
 * The provisioning endpoint answers `nxis_list_sites` with one site, `site-1` on example.com; the
 * key routes answer whatever each test sets in `fake.auth`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runKeys } from "../src/commands/keys.js";
import { parseArgs } from "../src/args.js";
import { CliError } from "../src/errors.js";
import { redactBody, setTrace } from "../src/trace.js";
import { capture, cleanFake, fake, ORG, resetFake, startFake, stopFake, type AuthSeen } from "./support/fake-endpoints.js";

/** A made-up site key; the marker keeps the mirror's secret scan from flagging it. */
const SITE_KEY = "nxis_dev_mcp_fake_site_key_0001"; // gitleaks:allow

/** A JWT with an account claim, unsigned. Fake test value only. */
function fakeToken(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ "https://nxis.ai/user_data": { account: { _id: { value: "acct-1" } } } })}.x`;
}

/** Runs `nxis keys <argv>` and returns what it emitted. */
async function keys(argv: string[], overrides: Parameters<typeof capture>[0] = {}) {
  const { positional, flags } = parseArgs(argv);
  const { ctx, out } = capture(overrides);
  await runKeys(ctx, positional, flags);
  return out;
}

/** Expects `nxis keys <argv>` to fail with this reason. */
async function fails(argv: string[], reason: string, overrides: Parameters<typeof capture>[0] = {}): Promise<CliError> {
  const err = await keys(argv, overrides).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CliError);
  expect((err as CliError).reason).toBe(reason);
  return err as CliError;
}

/** An authorization service that mints and revokes as the new one does. */
function scopedService(overrides: { mint?: (req: AuthSeen) => { status: number; body?: unknown } } = {}) {
  fake.auth = (req) => {
    if (req.method === "POST" && req.url === `/v1/organizations/${ORG}/apikeys`) {
      if (overrides.mint) return overrides.mint(req);
      const body = req.body as { scopes?: string[]; site?: string };
      return {
        status: 200,
        body: { raw_key: SITE_KEY, key_id: "sk-1", preview: "nxis_dev_mcp_abc…", scopes: body.scopes, site: body.site },
      };
    }
    if (req.method === "POST" && req.url.endsWith(":revoke")) return { status: 200, body: {} };
    return { status: 404 };
  };
}

beforeAll(startFake);
afterAll(stopFake);
beforeEach(() => {
  resetFake();
  process.env.NXIS_TOKEN = fakeToken();
});
afterEach(cleanFake);

describe("nxis keys create", () => {
  it("mints a key bound to the site and scope, and shows it once", async () => {
    scopedService();
    const out = await keys(["create", "--scope", "content_gaps:report"], { siteOverride: "example.com" });

    const mint = fake.authCalls[0];
    expect(mint?.method).toBe("POST");
    expect(mint?.body).toMatchObject({
      parent: `organizations/${ORG}`,
      kind: "mcp",
      env: "dev",
      account_id: "acct-1",
      scopes: ["content_gaps:report"],
      site: "site-1", // the domain, resolved to the id the service binds
    });
    expect(out.json).toEqual({
      ok: true,
      api_key: SITE_KEY,
      key_id: "sk-1",
      preview: "nxis_dev_mcp_abc…",
      scopes: ["content_gaps:report"],
      site: "site-1",
      domain: "example.com",
      org_id: ORG,
      env: "dev",
    });
    expect(out.text).toContain("shown once");
    expect(out.text).toContain(SITE_KEY);
  });

  it("checks a site id against the organization's sites before minting", async () => {
    scopedService();
    await fails(["create", "--scope", "content_gaps:report"], "site_not_found", { siteOverride: "0123456789abcdef01234567" });
    expect(fake.authCalls).toEqual([]);
  });

  it("refuses a missing or unknown scope before anything is sent", async () => {
    scopedService();
    const missing = await fails(["create"], "missing_scope");
    expect(missing.details["scopes"]).toEqual(["content_gaps:report"]);
    await fails(["create", "--scope", "sites:write"], "unknown_scope");
    expect(fake.authCalls).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it("needs a site", async () => {
    scopedService();
    await fails(["create", "--scope", "content_gaps:report"], "no_active_site", { siteOverride: undefined });
  });

  it("revokes, and never shows, a key an older service minted for the whole organization", async () => {
    // A service that predates site keys ignores `site` and echoes neither field back.
    scopedService({ mint: () => ({ status: 200, body: { raw_key: SITE_KEY, key_id: "sk-1", preview: "p" } }) });
    const err = await fails(["create", "--scope", "content_gaps:report"], "site_keys_unsupported");

    expect(fake.authCalls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST /v1/organizations/${ORG}/apikeys`,
      `POST /v1/organizations/${ORG}/apikeys/sk-1:revoke`,
    ]);
    expect(err.details).toMatchObject({ key_id: "sk-1", revoked: true });
    expect(JSON.stringify(err.toJSON())).not.toContain(SITE_KEY);
    expect(err.message).not.toContain(SITE_KEY);
  });

  it("says so when that revocation fails too", async () => {
    fake.auth = (req) =>
      req.url.endsWith(":revoke")
        ? { status: 500, body: { message: "boom" } }
        : { status: 200, body: { raw_key: SITE_KEY, key_id: "sk-1", preview: "p", scopes: [], site: "" } };
    const err = await fails(["create", "--scope", "content_gaps:report"], "site_keys_unsupported");
    expect(err.details["revoked"]).toBe(false);
    expect(err.message).toContain("nxis keys revoke sk-1");
  });

  it("sends nothing that changes anything under --dry-run", async () => {
    scopedService();
    setTrace({ dryRun: true });
    await fails(["create", "--scope", "content_gaps:report"], "dry_run");
    expect(fake.authCalls).toEqual([]);
  });

  it("never traces the key", () => {
    // Requests are traced, responses are not; a key field is redacted wherever it appears anyway.
    const redacted = JSON.stringify(redactBody({ raw_key: SITE_KEY, api_key: SITE_KEY, nested: { raw_key: SITE_KEY } }));
    expect(redacted).not.toContain(SITE_KEY);
  });
});

describe("nxis keys list", () => {
  const listed = {
    keys: [
      {
        key_id: "sk-1",
        preview: "nxis_dev_mcp_abc…",
        env: "dev",
        kind: "mcp",
        scopes: ["content_gaps:report"],
        site: "site-1",
        created_at: "1762560000",
        last_used_at: "1762646400",
      },
      // What a service that ignores the site filter would add: an org-wide key.
      { key_id: "org-1", preview: "nxis_dev_mcp_xyz…", env: "dev", kind: "mcp", scopes: [], created_at: "1" },
    ],
  };

  it("lists the site's keys, with no secret", async () => {
    fake.auth = () => ({ status: 200, body: listed });
    const out = await keys(["list"]);

    const url = new URL(fake.authCalls[0]?.url ?? "", "http://x");
    expect(fake.authCalls[0]?.method).toBe("GET");
    expect(url.pathname).toBe(`/v1/organizations/${ORG}/apikeys:byAccountAndOrg`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ account_id: "acct-1", site: "site-1" });

    expect(out.json).toMatchObject({ ok: true, site: "site-1", org_id: ORG, count: 1 });
    expect(out.json["keys"]).toEqual([
      {
        key_id: "sk-1",
        preview: "nxis_dev_mcp_abc…",
        scopes: ["content_gaps:report"],
        site: "site-1",
        env: "dev",
        kind: "mcp",
        created_at: 1762560000,
        last_used_at: 1762646400,
        revoked_at: null,
        revoked: false,
      },
    ]);
    expect(out.text).toContain("sk-1");
  });

  it("asks for revoked keys too with --all", async () => {
    fake.auth = () => ({ status: 200, body: { keys: [] } });
    const out = await keys(["list", "--all"]);
    expect(new URL(fake.authCalls[0]?.url ?? "", "http://x").searchParams.get("include_revoked")).toBe("true");
    expect(out.json).toMatchObject({ ok: true, count: 0, keys: [] });
  });

  it("still runs under --dry-run, since it only reads", async () => {
    fake.auth = () => ({ status: 200, body: listed });
    setTrace({ dryRun: true });
    const out = await keys(["list"]);
    expect(out.json["count"]).toBe(1);
  });
});

describe("nxis keys revoke", () => {
  it("revokes a key by id", async () => {
    scopedService();
    const out = await keys(["revoke", "sk-1"]);
    expect(fake.authCalls[0]).toMatchObject({
      method: "POST",
      url: `/v1/organizations/${ORG}/apikeys/sk-1:revoke`,
      body: { parent: `organizations/${ORG}`, key_id: "sk-1" },
    });
    expect(out.json).toEqual({ ok: true, key_id: "sk-1", org_id: ORG, revoked: true, outcome: "revoked" });
  });

  it("treats an unknown or already-revoked key as done", async () => {
    fake.auth = () => ({ status: 404, body: { message: "API key not found: sk-9" } });
    const out = await keys(["revoke", "sk-9"]);
    expect(out.json).toMatchObject({ ok: true, revoked: false, outcome: "already_gone" });
  });

  it("needs an id", async () => {
    await fails(["revoke"], "missing_key_id");
  });
});

describe("nxis keys", () => {
  it("names the subcommands for anything else", async () => {
    await fails(["rotate"], "unknown_command");
  });
});
