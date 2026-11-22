/**
 * `nxis sites …` against a scripted provisioning endpoint.
 *
 * The commands are run through the same dispatcher `cli.ts` calls, with output captured, so what
 * is checked is what a script would see: the `--json` object, the saved site, and the exit code
 * (here, the thrown error's, mapped as `cli.ts` maps it).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { runSites } from "../src/commands/sites.js";
import { endpointKey, resolveConfig } from "../src/config.js";
import type { Ctx } from "../src/context.js";
import { saveProvisioningKey } from "../src/credentials.js";
import { CliError, ExitCode } from "../src/errors.js";
import type { Io } from "../src/output.js";
import { loadSettings, saveActiveSite } from "../src/state.js";
import { hostOf, type SiteSummary } from "../src/tools/index.js";
import { setTrace } from "../src/trace.js";
import { KEY, ORG, startFake, type Fake } from "./support/fake-provisioning.js";

const TAG = '<meta name="nxisai-verification" content="3f2a9c" />';

let fake: Fake;
let dir: string;
const savedEnv = { ...process.env };

/** The scripted server's state. */
const state = { sites: [] as SiteSummary[], deployed: false, unreachable: false, named: null as string | null };

/** Answers like the provisioning endpoint, from {@link state}. */
function respond(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (tool) {
    case "nxis_list_sites":
      return { organization: ORG, count: state.sites.length, truncated: false, sites: state.sites };
    case "nxis_create_site": {
      const url = args["url"] as string;
      const site = { site: `site-${state.sites.length + 1}`, domain: url, host: hostOf(url) ?? url, is_verified: false };
      state.sites.push(site);
      return { ...site, subdomain: "abc", note: "Not verified yet." };
    }
    case "nxis_verify_site":
      if (args["mode"] === "token") return { mode: "token", meta_tag: TAG, token: "tok", next: "Deploy it." };
      if (state.unreachable) {
        return {
          mode: "check",
          verified: false,
          reason: "site_unreachable",
          url: "https://example.com",
          note:
            "https://example.com could not be reached, so the tag could not be looked for. Check that the site " +
            "is deployed at that address and publicly reachable, then check again. Reported reason: " +
            "example.com: Name or service not known",
        };
      }
      return state.deployed
        ? { mode: "check", verified: true, url: "https://example.com" }
        : {
            mode: "check",
            verified: false,
            note:
              "The tag was not found on the live site. This usually means the deploy has not landed yet — " +
              "wait for it and check again. Reported reason: no verification tag at https://example.com",
          };
    case "nxis_set_site_name":
      state.named = args["display_name"] as string;
      return { display_name: state.named };
    case "nxis_site_tag":
      if (args["mode"] === "status") return { mode: "status", exists: false, next: "No tag yet." };
      return state.deployed
        ? {
            mode: "issue",
            exists: true,
            changed: true,
            token: "jwt",
            script_tag: '<script src="https://cdn.example/tag.js" data-token="jwt"></script>',
            claims: { site_id: args["site"], domains: ["example.com"], webmcp_mode: "browser" },
          }
        : { mode: "issue", issued: false, reason: "site_not_verified", next: "Verify the site first." };
    case "nxis_list_in_app":
      return {
        listed_in_app: args["preview"] ? false : args["listed"] !== false,
        domain: "example.com",
        as_listed: { title: state.named ?? "example.com", verticals: ["Store"], places: [], public: true },
        next: ["The title is a domain; set a name."],
      };
    default:
      return {};
  }
}

beforeAll(async () => {
  fake = await startFake();
});

afterAll(async () => {
  await fake.close();
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nxis-sites-"));
  process.env.XDG_CONFIG_HOME = dir;
  process.env.NXIS_NO_KEYCHAIN = "1";
  delete process.env.NXIS_TOKEN;
  delete process.env.NXIS_API;
  delete process.env.NXIS_MCP_URL;
  fake.calls = [];
  fake.respond = respond;
  state.sites = [];
  state.deployed = false;
  state.unreachable = false;
  state.named = null;
  saveProvisioningKey({
    apiKey: KEY,
    keyId: "key-1",
    preview: "…_key",
    orgId: ORG,
    endpoints: endpointKey(context().ctx.config.endpoints),
    env: "dev",
    createdAt: 0,
  });
});

afterEach(() => {
  setTrace({ verbose: false, dryRun: false });
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

/** A context whose output is captured rather than written. */
function context(overrides: Partial<Ctx> = {}) {
  const out = { emitted: [] as Array<Record<string, unknown>>, text: [] as string[], notes: [] as string[] };
  const io: Io = {
    json: true,
    note: (line) => out.notes.push(line),
    emit: (payload, human) => {
      out.emitted.push(payload);
      out.text.push(human());
    },
  };
  const ctx: Ctx = { config: resolveConfig({ api: fake.base }), io, orgOverride: ORG, ...overrides };
  return { ctx, out };
}

/** Runs `nxis sites <argv>` and returns the exit code `cli.ts` would, with the error. */
async function sites(argv: string[], overrides: Partial<Ctx> = {}) {
  const { ctx, out } = context(overrides);
  const { positional, flags } = parseArgs(argv);
  try {
    await runSites(ctx, positional, flags);
    return { code: ExitCode.OK as number, json: out.emitted[0], out, error: null as CliError | null };
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    const code = err.reason === "dry_run" ? ExitCode.OK : err.exitCode;
    return { code: code as number, json: err.toJSON(), out, error: err };
  }
}

const tools = () => fake.calls.map((c) => c.tool);

/** Two sites, as the organization would have after `create` twice. */
function seed(...hosts: string[]) {
  state.sites = hosts.map((host, i) => ({
    site: `site-${i + 1}`,
    domain: `https://${host}`,
    host,
    display_name: host,
    is_verified: i === 0,
  }));
}

describe("sites create", () => {
  it("creates the site with only its url, names it on the same connection, and saves it as current", async () => {
    const r = await sites(["create", "https://example.com", "--name", "Example Outfitters"]);
    expect(r.code).toBe(0);
    expect(fake.calls).toEqual([
      { tool: "nxis_create_site", args: { url: "https://example.com" } },
      { tool: "nxis_set_site_name", args: { site: "site-1", display_name: "Example Outfitters" } },
    ]);
    expect(loadSettings().activeSite).toEqual({ id: "site-1", orgId: ORG, domain: "example.com" });
    expect(r.json).toMatchObject({
      ok: true,
      site: "site-1",
      org_id: ORG,
      domain: "example.com",
      display_name: "Example Outfitters",
      is_verified: false,
      current: true,
    });
    expect(r.json?.["warning"]).toMatch(/fixed at creation/);
    expect(r.out.text[0]).toMatch(/preview or branch/);
  });

  it("makes no name call without --name", async () => {
    const r = await sites(["create", "https://example.com"]);
    expect(r.code).toBe(0);
    expect(tools()).toEqual(["nxis_create_site"]);
    expect(r.json).not.toHaveProperty("display_name");
  });

  it("keeps the site current when naming it fails", async () => {
    fake.respond = (tool, args) => (tool === "nxis_set_site_name" ? { isError: true, text: "name too long" } : respond(tool, args));
    const r = await sites(["create", "https://example.com", "--name", "x"]);
    expect(r.code).toBe(ExitCode.ERROR);
    expect(r.json).toMatchObject({ ok: false, reason: "site_name_failed", site: "site-1", cause: "tool_error" });
    expect(loadSettings().activeSite?.id).toBe("site-1");
  });

  it("withholds both calls under --dry-run, saying what each would send", async () => {
    setTrace({ dryRun: true });
    const r = await sites(["create", "https://example.com", "--name", "Example"]);
    expect(r.code).toBe(0);
    expect(r.error?.reason).toBe("dry_run");
    expect(r.error?.details).toMatchObject({
      tool: "nxis_create_site",
      arguments: { url: "https://example.com" },
      then: { tool: "nxis_set_site_name", arguments: { display_name: "Example" } },
    });
    expect(fake.calls).toEqual([]);
    expect(loadSettings().activeSite).toBeUndefined();
  });

  it("needs a url", async () => {
    const r = await sites(["create"]);
    expect(r.code).toBe(ExitCode.ERROR);
    expect(r.error?.reason).toBe("missing_url");
    expect(r.error?.message).toMatch(/step 1/);
  });
});

describe("sites list", () => {
  it("passes every site through and marks the current one", async () => {
    seed("example.com", "other.example");
    saveActiveSite({ id: "site-2", orgId: ORG });
    const r = await sites(["list"]);
    expect(r.code).toBe(0);
    expect(r.json).toEqual({
      ok: true,
      organization: ORG,
      count: 2,
      truncated: false,
      current: "site-2",
      sites: [
        { site: "site-1", domain: "https://example.com", host: "example.com", display_name: "example.com", is_verified: true, current: false },
        { site: "site-2", domain: "https://other.example", host: "other.example", display_name: "other.example", is_verified: false, current: true },
      ],
    });
    expect(r.out.text[0]).toMatch(/^\* other\.example/m);
  });

  it("marks the site --site names by domain", async () => {
    seed("example.com", "other.example");
    const r = await sites(["list"], { siteOverride: "https://Example.com/" });
    expect(r.json?.["current"]).toBe("site-1");
  });
});

describe("sites use", () => {
  it("picks a site by id, after checking it exists", async () => {
    seed("example.com", "other.example");
    const r = await sites(["use", "site-2"]);
    expect(r.code).toBe(0);
    expect(r.json).toEqual({
      ok: true,
      site: "site-2",
      org_id: ORG,
      domain: "other.example",
      display_name: "other.example",
      is_verified: false,
      match: "id",
    });
    expect(loadSettings().activeSite).toEqual({ id: "site-2", orgId: ORG, domain: "other.example" });
  });

  it("refuses an id the organization does not have", async () => {
    seed("example.com");
    const r = await sites(["use", "site-9"]);
    expect(r.code).toBe(ExitCode.NEEDS_USER);
    expect(r.error?.reason).toBe("site_not_found");
    expect(loadSettings().activeSite).toBeUndefined();
  });

  it("picks a site by domain or URL", async () => {
    seed("example.com", "other.example");
    const r = await sites(["use", "https://Example.com/pricing"]);
    expect(r.json).toMatchObject({ site: "site-1", match: "host" });
  });

  it("falls back to ignoring www, and says so", async () => {
    seed("example.com");
    const r = await sites(["use", "www.example.com"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ site: "site-1", domain: "example.com", match: "www" });
    expect(r.out.text[0]).toMatch(/differs only by www/);

    seed("www.example.com");
    expect((await sites(["use", "example.com"])).json).toMatchObject({ site: "site-1", match: "www" });
  });

  it("prefers the exact host over a www match", async () => {
    seed("www.example.com", "example.com");
    expect((await sites(["use", "example.com"])).json).toMatchObject({ site: "site-2", match: "host" });
    expect((await sites(["use", "www.example.com"])).json).toMatchObject({ site: "site-1", match: "host" });
  });

  it("refuses an ambiguous domain, listing the candidates, and saves nothing", async () => {
    seed("www.example.com", "www.example.com");
    const r = await sites(["use", "example.com"]);
    expect(r.code).toBe(ExitCode.NEEDS_USER);
    expect(r.json).toMatchObject({
      ok: false,
      reason: "site_ambiguous",
      sites: ["site-1", "site-2"],
      candidates: [
        { site: "site-1", host: "www.example.com" },
        { site: "site-2", host: "www.example.com" },
      ],
    });
    expect(loadSettings().activeSite).toBeUndefined();
  });

  it("applies the same matching to --site", async () => {
    seed("example.com");
    const r = await sites(["name", "Example"], { siteOverride: "www.example.com" });
    expect(r.code).toBe(0);
    expect(fake.calls.at(-1)).toEqual({ tool: "nxis_set_site_name", args: { site: "site-1", display_name: "Example" } });
  });
});

describe("sites verify", () => {
  beforeEach(() => {
    seed("example.com");
    saveActiveSite({ id: "site-1", orgId: ORG });
  });

  it("--token returns the tag with its name and content split out", async () => {
    const r = await sites(["verify", "--token"]);
    expect(r.code).toBe(0);
    expect(fake.calls).toEqual([{ tool: "nxis_verify_site", args: { mode: "token", site: "site-1" } }]);
    expect(r.json).toEqual({
      ok: true,
      site: "site-1",
      tag: TAG,
      name: "nxisai-verification",
      content: "3f2a9c",
      next: "Deploy it.",
    });
    // Alone on stdout, so it can be redirected into a file.
    expect(r.out.text[0]).toBe(TAG);
    expect(r.out.notes.join("\n")).toMatch(/never verifies/);
  });

  it("--token still runs under --dry-run, since it only reads", async () => {
    setTrace({ dryRun: true });
    const r = await sites(["verify", "--token"]);
    expect(r.code).toBe(0);
    expect(r.json?.["tag"]).toBe(TAG);
  });

  it("--check exits 0 when the tag is live", async () => {
    state.deployed = true;
    const r = await sites(["verify", "--check"]);
    expect(r.code).toBe(0);
    expect(r.json).toEqual({ ok: true, site: "site-1", verified: true, url: "https://example.com" });
  });

  it("--check exits 2 with the verifier's reason when it is not, and names preview deploys", async () => {
    const r = await sites(["verify", "--check"]);
    expect(r.code).toBe(ExitCode.NEEDS_USER);
    expect(r.json).toMatchObject({
      ok: false,
      reason: "site_not_verified",
      site: "site-1",
      verified: false,
      verifier_reason: "no verification tag at https://example.com",
    });
    expect(r.error?.message).toMatch(/preview or branch deploy/);
  });

  it("--check exits 2 with site_unreachable when the verifier could not fetch the site", async () => {
    state.unreachable = true;
    const r = await sites(["verify", "--check"]);
    expect(r.code).toBe(ExitCode.NEEDS_USER);
    expect(r.json).toMatchObject({
      ok: false,
      reason: "site_unreachable",
      site: "site-1",
      verified: false,
      url: "https://example.com",
      verifier_reason: "example.com: Name or service not known",
    });
    expect(r.error?.message).toContain("deployed at that address");
    expect(r.error?.message).not.toMatch(/deploy has not landed/);
  });

  it("--check is withheld under --dry-run, since a pass marks the site verified", async () => {
    setTrace({ dryRun: true });
    const r = await sites(["verify", "--check"]);
    expect(r.code).toBe(0);
    expect(r.error?.reason).toBe("dry_run");
    expect(fake.calls).toEqual([]);
  });

  it("needs exactly one of --token and --check", async () => {
    for (const argv of [["verify"], ["verify", "--token", "--check"]]) {
      const r = await sites(argv);
      expect(r.code).toBe(ExitCode.ERROR);
      expect(r.error?.reason).toBe("missing_mode");
      expect(r.error?.message).toMatch(/step 2.*step 3/);
    }
  });

  it("needs a site", async () => {
    saveActiveSite({ id: "site-1", orgId: "another-org" });
    const r = await sites(["verify", "--token"]);
    expect(r.code).toBe(ExitCode.NEEDS_USER);
    expect(r.error?.reason).toBe("no_active_site");
  });

  it("resolves a domain from --site once, then calls with the id", async () => {
    await sites(["verify", "--token"], { siteOverride: "example.com" });
    expect(fake.calls).toEqual([
      { tool: "nxis_list_sites", args: { limit: 500 } },
      { tool: "nxis_verify_site", args: { mode: "token", site: "site-1" } },
    ]);
  });
});

describe("sites tag", () => {
  beforeEach(() => {
    seed("example.com");
    saveActiveSite({ id: "site-1", orgId: ORG });
  });

  it("reads the tag by default", async () => {
    const r = await sites(["tag"]);
    expect(r.code).toBe(0);
    expect(fake.calls).toEqual([{ tool: "nxis_site_tag", args: { mode: "status", site: "site-1" } }]);
    expect(r.json).toEqual({ ok: true, mode: "status", exists: false, next: "No tag yet.", site: "site-1" });
  });

  it("issues one for the hosts given", async () => {
    state.deployed = true;
    const r = await sites(["tag", "issue", "--domain", "localhost", "--domain", "staging.example.com", "--webmcp-mode", "ssr"]);
    expect(r.code).toBe(0);
    expect(fake.calls[0]).toEqual({
      tool: "nxis_site_tag",
      args: { mode: "issue", site: "site-1", domains: ["localhost", "staging.example.com"], webmcp_mode: "ssr" },
    });
    expect(r.json).toMatchObject({ ok: true, site: "site-1", script_tag: expect.stringContaining("<script") });
  });

  it("exits 2 when the site is not verified yet", async () => {
    const r = await sites(["tag", "issue"]);
    expect(r.code).toBe(ExitCode.NEEDS_USER);
    expect(r.json).toMatchObject({ ok: false, reason: "site_not_verified", issued: false });
  });

  it("withholds issue under --dry-run and still reads status", async () => {
    setTrace({ dryRun: true });
    expect((await sites(["tag", "issue"])).error?.reason).toBe("dry_run");
    expect((await sites(["tag"])).code).toBe(0);
    expect(tools()).toEqual(["nxis_site_tag"]);
  });

  it("refuses issue-only flags on status, and a bad WebMCP mode before sending", async () => {
    expect((await sites(["tag", "--domain", "x.example"])).error?.reason).toBe("invalid_input");
    const bad = await sites(["tag", "issue", "--webmcp-mode", "server"]);
    expect(bad.error?.reason).toBe("invalid_input");
    expect(bad.json).toMatchObject({ field: "webmcp_mode" });
    expect(fake.calls).toEqual([]);
  });
});

describe("sites name and list-in-app", () => {
  beforeEach(() => {
    seed("example.com");
    saveActiveSite({ id: "site-1", orgId: ORG });
  });

  it("names the site, joining the words", async () => {
    const r = await sites(["name", "Example", "Outfitters"]);
    expect(fake.calls).toEqual([{ tool: "nxis_set_site_name", args: { site: "site-1", display_name: "Example Outfitters" } }]);
    expect(r.json).toEqual({ ok: true, site: "site-1", display_name: "Example Outfitters" });
  });

  it("withholds the name under --dry-run", async () => {
    setTrace({ dryRun: true });
    const r = await sites(["name", "Example"]);
    expect(r.code).toBe(0);
    expect(r.error?.details).toMatchObject({ tool: "nxis_set_site_name", arguments: { site: "site-1", display_name: "Example" } });
    expect(fake.calls).toEqual([]);
  });

  it("--preview changes nothing, and runs under --dry-run", async () => {
    setTrace({ dryRun: true });
    const r = await sites(["list-in-app", "--preview"]);
    expect(r.code).toBe(0);
    expect(fake.calls).toEqual([{ tool: "nxis_list_in_app", args: { site: "site-1", preview: true } }]);
    expect(r.json).toMatchObject({ ok: true, site: "site-1", preview: true, as_listed: { title: "example.com" } });
    expect(r.out.text[0]).toMatch(/nothing changed/);
  });

  it("lists it, and --off unlists it", async () => {
    await sites(["list-in-app"]);
    const off = await sites(["list-in-app", "--off"]);
    expect(fake.calls.map((c) => c.args)).toEqual([{ site: "site-1" }, { site: "site-1", listed: false }]);
    expect(off.json).toMatchObject({ listed_in_app: false, preview: false });
  });

  it("withholds listing under --dry-run", async () => {
    setTrace({ dryRun: true });
    expect((await sites(["list-in-app"])).error?.reason).toBe("dry_run");
    expect(fake.calls).toEqual([]);
  });

  it("refuses --preview with --off", async () => {
    const r = await sites(["list-in-app", "--preview", "--off"]);
    expect(r.error?.reason).toBe("invalid_input");
    expect(fake.calls).toEqual([]);
  });
});

describe("the site sequence, scripted", () => {
  it("runs create, verify token, verify check, name and list-in-app on the saved site", async () => {
    const created = await sites(["create", "https://example.com"]);
    expect(created.json).toMatchObject({ ok: true, site: "site-1" });

    const token = await sites(["verify", "--token"]);
    expect(token.json).toMatchObject({ site: "site-1", content: "3f2a9c" });

    // Before the deploy lands: exit 2, wait and check again.
    expect((await sites(["verify", "--check"])).code).toBe(ExitCode.NEEDS_USER);
    state.deployed = true;
    expect((await sites(["verify", "--check"])).json).toMatchObject({ ok: true, verified: true });

    const preview = await sites(["list-in-app", "--preview"]);
    expect(preview.json).toMatchObject({ as_listed: { title: "example.com" } });

    expect((await sites(["name", "Example Outfitters"])).code).toBe(0);
    const listed = await sites(["list-in-app"]);
    expect(listed.json).toMatchObject({ ok: true, listed_in_app: true, as_listed: { title: "Example Outfitters" } });

    expect(tools()).toEqual([
      "nxis_create_site",
      "nxis_verify_site",
      "nxis_verify_site",
      "nxis_verify_site",
      "nxis_list_in_app",
      "nxis_set_site_name",
      "nxis_list_in_app",
    ]);
    // Every site-scoped call went to the site create saved, by id.
    expect(fake.calls.slice(1).every((c) => c.args["site"] === "site-1")).toBe(true);
  });
});

describe("sites, unknown", () => {
  it("names the subcommands", async () => {
    const r = await sites(["frobnicate"]);
    expect(r.code).toBe(ExitCode.ERROR);
    expect(r.error?.reason).toBe("unknown_command");
    expect(r.error?.message).toMatch(/create, list, use, verify/);
  });
});
