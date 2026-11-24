/**
 * `nxis crawl`, `nxis autofill` and `nxis publish`, against an in-process provisioning endpoint
 * that also serves the site's sitemaps.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/args.js";
import { cmdAutofillPlan, cmdAutofillStatus, cmdAutofillSubmit, autofill } from "../src/commands/autofill.js";
import { cmdCrawlStatus, cmdCrawlSubmit } from "../src/commands/crawl.js";
import { cmdPublish, publish } from "../src/commands/publish.js";
import { endpointKey, resolveConfig } from "../src/config.js";
import type { Ctx } from "../src/context.js";
import { saveProvisioningKey } from "../src/credentials.js";
import { CliError, ExitCode } from "../src/errors.js";
import { rememberJobs, siteJobs } from "../src/jobs.js";
import { createIo } from "../src/output.js";
import type { Asker } from "../src/prompt.js";
import { isYes } from "../src/prompt.js";
import { MAX_SITEMAP_BYTES, parseSitemap } from "../src/sitemap.js";
import { setTrace } from "../src/trace.js";
import { callsTo, KEY, ORG, sitemapIndex, startFake, urlset, type Fake } from "./support/fake-provisioning.js";

let fake: Fake;
let dir: string;
const savedEnv = { ...process.env };
let stdout: string[];
let stderr: string[];

beforeAll(async () => {
  fake = await startFake();
});

afterAll(async () => {
  await fake.close();
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nxis-data-"));
  process.env.XDG_CONFIG_HOME = dir;
  process.env.NXIS_NO_KEYCHAIN = "1";
  delete process.env.NXIS_TOKEN;
  delete process.env.NXIS_API;
  delete process.env.NXIS_MCP_URL;
  fake.reset();
  storeKey();
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  setTrace({ verbose: false, dryRun: false });
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

function storeKey(): void {
  saveProvisioningKey({
    apiKey: KEY,
    keyId: "key-1",
    preview: "…_key",
    orgId: ORG,
    endpoints: endpointKey(ctx().config.endpoints),
    env: "dev",
    createdAt: 0,
  });
}

function ctx(json = true): Ctx {
  return { config: resolveConfig({ api: fake.base }), io: createIo(json), orgOverride: ORG, siteOverride: "site-1" };
}

/** @returns The one `--json` object the command wrote. */
function emitted(): Record<string, unknown> {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0] as string) as Record<string, unknown>;
}

async function caught(fn: () => Promise<unknown>): Promise<CliError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(CliError);
    return err as CliError;
  }
  throw new Error("expected a failure");
}

const page = (path: string) => `${fake.base}${path}`;

// ── crawl ─────────────────────────────────────────────────────────────────

describe("crawl submit", () => {
  it("checks the default sitemap, then submits it", async () => {
    fake.files["/sitemap.xml"] = { body: urlset([page("/"), page("/about")]) };
    fake.answers["nxis_crawl_sitemap:submit"] = { record: "r1", sitemap: page("/sitemap.xml"), state: "QUEUED" };

    await cmdCrawlSubmit(ctx());

    expect(fake.gets).toEqual(["/sitemap.xml"]);
    expect(callsTo(fake, "nxis_crawl_sitemap")).toEqual([
      { tool: "nxis_crawl_sitemap", args: { mode: "submit", url: page("/sitemap.xml"), site: "site-1" } },
    ]);
    expect(emitted()).toEqual({
      ok: true,
      site: "site-1",
      host: "127.0.0.1",
      sitemap: page("/sitemap.xml"),
      found: true,
      state: "QUEUED",
      done: false,
      is_sitemap_index: null,
      error: null,
      record: "r1",
      note: null,
      check: { sitemap: page("/sitemap.xml"), host: "127.0.0.1", is_index: false, sitemaps_checked: 1, urls_checked: 2 },
    });
  });

  it("refuses a sitemap on a generated host, explaining it, and submits nothing", async () => {
    fake.files["/sitemap.xml"] = {
      body: urlset([page("/"), "https://example-shop.netlify.app/", "https://example-shop.netlify.app/about"]),
    };
    const err = await caught(() => cmdCrawlSubmit(ctx()));
    expect(err.reason).toBe("sitemap_off_host");
    expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
    expect(err.message).toContain("example-shop.netlify.app");
    expect(err.message).toContain("URL or DEPLOY_PRIME_URL on Netlify");
    expect(err.details["off_host_count"]).toBe(2);
    expect((err.details["off_host"] as Array<{ generated: string }>)[0]?.generated).toBe("Netlify");
    expect(callsTo(fake, "nxis_crawl_sitemap")).toEqual([]);
  });

  it.each([
    ["my-app.vercel.app", "VERCEL_URL"],
    ["my-app.pages.dev", "CF_PAGES_URL"],
  ])("names the variable for %s", async (host, variable) => {
    fake.files["/sitemap.xml"] = { body: urlset([`https://${host}/`]) };
    const err = await caught(() => cmdCrawlSubmit(ctx()));
    expect(err.reason).toBe("sitemap_off_host");
    expect(err.message).toContain(variable);
  });

  it("refuses any other host too, without the generated-host explanation", async () => {
    fake.files["/sitemap.xml"] = { body: urlset([page("/"), "https://www.example.com/x"]) };
    const err = await caught(() => cmdCrawlSubmit(ctx()));
    expect(err.reason).toBe("sitemap_off_host");
    expect(err.message).toContain("www.example.com");
    expect(err.message).not.toContain("generates for a deploy");
  });

  it("follows a sitemap index into every sitemap, gzipped ones included", async () => {
    fake.files["/sitemap.xml"] = { body: sitemapIndex([page("/pages.xml"), page("/posts.xml.gz")]) };
    fake.files["/pages.xml"] = { body: urlset([page("/"), page("/a")]) };
    fake.files["/posts.xml.gz"] = { body: gzipSync(urlset([page("/p/1")])), type: "application/gzip" };

    await cmdCrawlSubmit(ctx());

    expect(fake.gets).toEqual(["/sitemap.xml", "/pages.xml", "/posts.xml.gz"]);
    expect(emitted()["check"]).toMatchObject({ is_index: true, sitemaps_checked: 3, urls_checked: 3 });
    expect(callsTo(fake, "nxis_crawl_sitemap", "submit")).toHaveLength(1);
  });

  it("finds an off-host URL inside a child sitemap", async () => {
    fake.files["/sitemap.xml"] = { body: sitemapIndex([page("/pages.xml")]) };
    fake.files["/pages.xml"] = { body: urlset([page("/"), "https://shop.netlify.app/x"]) };
    const err = await caught(() => cmdCrawlSubmit(ctx()));
    expect(err.reason).toBe("sitemap_off_host");
    expect((err.details["off_host"] as Array<{ sitemap: string }>)[0]?.sitemap).toBe(page("/pages.xml"));
  });

  it("refuses an index whose child sitemap is on another host, without fetching it", async () => {
    fake.files["/sitemap.xml"] = { body: sitemapIndex(["https://shop.netlify.app/pages.xml"]) };
    const err = await caught(() => cmdCrawlSubmit(ctx()));
    expect(err.reason).toBe("sitemap_off_host");
    expect(fake.gets).toEqual(["/sitemap.xml"]);
  });

  it("stops when there is no sitemap, or it lists nothing", async () => {
    expect((await caught(() => cmdCrawlSubmit(ctx()))).reason).toBe("sitemap_not_found");
    fake.files["/sitemap.xml"] = { body: urlset([]) };
    expect((await caught(() => cmdCrawlSubmit(ctx()))).reason).toBe("sitemap_empty");
    fake.files["/sitemap.xml"] = { body: "<html>not a sitemap</html>" };
    expect((await caught(() => cmdCrawlSubmit(ctx()))).reason).toBe("sitemap_invalid");
    expect(callsTo(fake, "nxis_crawl_sitemap")).toEqual([]);
  });

  it("refuses a gzipped sitemap that inflates past 50 MB, and submits nothing", async () => {
    fake.files["/sitemap.xml"] = { body: gzipSync(Buffer.alloc(MAX_SITEMAP_BYTES + 1)), type: "application/gzip" };
    const err = await caught(() => cmdCrawlSubmit(ctx()));
    expect(err.reason).toBe("sitemap_invalid");
    expect(err.message).toMatch(/decompresses to more than 50 MB/);
    expect(err.details).toMatchObject({ limit_bytes: MAX_SITEMAP_BYTES });
    expect(callsTo(fake, "nxis_crawl_sitemap")).toEqual([]);
  });

  it("refuses a sitemap whose download passes 50 MB, with or without a Content-Length", async () => {
    const big = Buffer.alloc(MAX_SITEMAP_BYTES + 1, 0x20);
    for (const chunked of [false, true]) {
      fake.files["/sitemap.xml"] = { body: big, chunked };
      const err = await caught(() => cmdCrawlSubmit(ctx()));
      expect(err.reason).toBe("sitemap_invalid");
      expect(err.message).toMatch(/larger than 50 MB/);
    }
    expect(callsTo(fake, "nxis_crawl_sitemap")).toEqual([]);
  });

  it("reads a sitemap sent without a Content-Length", async () => {
    fake.files["/sitemap.xml"] = { body: urlset([page("/")]), chunked: true };
    fake.answers["nxis_crawl_sitemap:submit"] = { state: "QUEUED" };
    await cmdCrawlSubmit(ctx());
    expect(emitted()["check"]).toMatchObject({ urls_checked: 1 });
  });

  it("refuses a corrupt gzipped sitemap as invalid", async () => {
    fake.files["/sitemap.xml"] = { body: Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad]) };
    const err = await caught(() => cmdCrawlSubmit(ctx()));
    expect(err.reason).toBe("sitemap_invalid");
    expect(err.message).toMatch(/could not be decompressed/);
  });

  it("takes a sitemap URL, and remembers it for status", async () => {
    fake.files["/site-map.xml"] = { body: urlset([page("/")]) };
    fake.answers["nxis_crawl_sitemap:submit"] = { state: "QUEUED" };
    fake.answers["nxis_crawl_sitemap:status"] = { state: "PROCESSING", found: true, done: false };
    await cmdCrawlSubmit(ctx(), { sitemap: page("/site-map.xml") });
    stdout = [];
    await cmdCrawlStatus(ctx());
    expect(callsTo(fake, "nxis_crawl_sitemap", "status")[0]?.args["url"]).toBe(page("/site-map.xml"));
    expect(emitted()).toMatchObject({ ok: true, state: "PROCESSING", done: false });
  });

  it("--wait polls status until COMPLETE", async () => {
    fake.files["/sitemap.xml"] = { body: urlset([page("/")]) };
    fake.answers["nxis_crawl_sitemap:submit"] = { state: "QUEUED" };
    const states = ["QUEUED", "PROCESSING", "COMPLETE"];
    fake.answers["nxis_crawl_sitemap:status"] = () => {
      const state = states.shift() as string;
      return { state, found: true, done: state === "COMPLETE" };
    };
    await cmdCrawlSubmit(ctx(), { wait: true, intervalMs: 5 });
    expect(callsTo(fake, "nxis_crawl_sitemap", "status")).toHaveLength(3);
    expect(callsTo(fake, "nxis_crawl_sitemap", "submit")).toHaveLength(1);
    expect(emitted()).toMatchObject({ ok: true, state: "COMPLETE", done: true, check: { urls_checked: 1 } });
  });

  it("under --dry-run, checks the sitemap and withholds the submit", async () => {
    setTrace({ dryRun: true });
    fake.files["/sitemap.xml"] = { body: urlset([page("/")]) };
    const err = await caught(() => cmdCrawlSubmit(ctx()));
    expect(err.reason).toBe("dry_run");
    expect(err.details).toMatchObject({ tool: "nxis_crawl_sitemap", check: { urls_checked: 1 } });
    expect(callsTo(fake, "nxis_crawl_sitemap")).toEqual([]);
  });
});

describe("crawl status", () => {
  it("defaults to the site's sitemap.xml", async () => {
    fake.answers["nxis_crawl_sitemap:status"] = { state: "COMPLETE", found: true, done: true };
    await cmdCrawlStatus(ctx());
    expect(callsTo(fake, "nxis_crawl_sitemap")[0]?.args).toEqual({ mode: "status", url: page("/sitemap.xml"), site: "site-1" });
    expect(emitted()).toMatchObject({ ok: true, state: "COMPLETE", done: true, found: true });
  });

  it("reports FAILED with the error, exit 1", async () => {
    fake.answers["nxis_crawl_sitemap:status"] = { state: "FAILED", found: true, done: true, error: "HTTP 500" };
    const err = await caught(() => cmdCrawlStatus(ctx()));
    expect(err.reason).toBe("crawl_failed");
    expect(err.exitCode).toBe(ExitCode.ERROR);
    expect(err.message).toContain("HTTP 500");
  });

  it("reports no crawl as exit 2", async () => {
    fake.answers["nxis_crawl_sitemap:status"] = { found: false, note: "No crawl record" };
    const err = await caught(() => cmdCrawlStatus(ctx()));
    expect(err.reason).toBe("crawl_not_found");
    expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
  });

  it("--wait gives up after --timeout with exit 2, leaving the crawl running", async () => {
    fake.answers["nxis_crawl_sitemap:status"] = { state: "PROCESSING", found: true, done: false };
    const err = await caught(() => cmdCrawlStatus(ctx(), { wait: true, intervalMs: 20, timeoutMinutes: 0.001 }));
    expect(err.reason).toBe("crawl_running");
    expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
  });
});

// ── autofill ──────────────────────────────────────────────────────────────

const PLAN = {
  mode: "plan",
  resource_count: 340,
  site_total: 340,
  by_media: [
    { media_type: "HTML", count: 290 },
    { media_type: "IMAGE", count: 50 },
  ],
  credit_limit: 10000,
  credits_used_this_month: 2500,
  credits_remaining: 7500,
  existing: "import_and_complete",
  quota_exceeded: false,
};

const yes: Asker = { interactive: true, confirm: async () => true };
const no: Asker = { interactive: true, confirm: async () => false };
const nobody: Asker = { interactive: false, confirm: async () => true };

describe("autofill plan", () => {
  it("defaults to import_and_complete, and reports a stable shape", async () => {
    fake.answers["nxis_bulk_autofill:plan"] = PLAN;
    await cmdAutofillPlan(ctx());
    expect(callsTo(fake, "nxis_bulk_autofill")[0]?.args).toEqual({ mode: "plan", existing: "import_and_complete", site: "site-1" });
    expect(emitted()).toEqual({
      ok: true,
      site: "site-1",
      host: "127.0.0.1",
      existing: "import_and_complete",
      media_type: null,
      pattern: null,
      planned_count: 340,
      planned_count_is_upper_bound: false,
      resource_count: 340,
      pattern_count: null,
      site_total: 340,
      by_media: [
        { media_type: "HTML", count: 290 },
        { media_type: "IMAGE", count: 50 },
      ],
      credits_remaining: 7500,
      credit_limit: 10000,
      credits_used_this_month: 2500,
      import_cost_per_resource_milli: null,
      quota_exceeded: false,
      note: null,
      balance_milli: null,
    });
  });

  it("shows the count, breakdown and balance, and no estimated total for a generated mode", async () => {
    fake.answers["nxis_bulk_autofill:plan"] = PLAN;
    await cmdAutofillPlan(ctx(false));
    const out = stdout.join("");
    expect(out).toContain("340");
    expect(out).toContain("HTML 290, IMAGE 50");
    expect(out).toContain("7,500");
    expect(out).toContain("no total is estimated");
    expect(out).not.toMatch(/NXC/);
  });

  it("shows the fixed per-page price for import", async () => {
    fake.answers["nxis_bulk_autofill:plan"] = { ...PLAN, existing: "import", import_cost_per_resource_milli: 2000 };
    await cmdAutofillPlan(ctx(false), { existing: "import" });
    expect(callsTo(fake, "nxis_bulk_autofill")[0]?.args["existing"]).toBe("import");
    expect(stdout.join("")).toContain("2 NXC per page, fixed");
  });

  it("passes the scope, upper-casing the media type", async () => {
    fake.answers["nxis_bulk_autofill:plan"] = { ...PLAN, media_type: "HTML", resource_count: 290 };
    const { flags } = parseArgs(["--media-type", "html", "--pattern", "/products/*", "--existing", "generate"]);
    fake.answers["nxis_bulk_autofill:plan"] = { ...PLAN, media_type: "HTML", pattern: "/products/*", resource_count: 290, pattern_count: 40, existing: "generate" };
    await autofill(ctx(), ["plan"], flags);
    expect(callsTo(fake, "nxis_bulk_autofill")[0]?.args).toEqual({
      mode: "plan",
      existing: "generate",
      media_type: "HTML",
      pattern: "/products/*",
      site: "site-1",
    });
    expect(emitted()).toMatchObject({ planned_count: 40, planned_count_is_upper_bound: true });
  });

  it("refuses a bad --existing or --media-type before calling anything", async () => {
    const bad = await caught(() => autofill(ctx(), ["plan"], parseArgs(["--existing", "all"]).flags));
    expect(bad.reason).toBe("invalid_input");
    const media = await caught(() => autofill(ctx(), ["plan"], parseArgs(["--media-type", "pdf"]).flags));
    expect(media.reason).toBe("invalid_input");
    expect(fake.calls).toEqual([]);
  });

  it("still runs under --dry-run, since it only reads", async () => {
    setTrace({ dryRun: true });
    fake.answers["nxis_bulk_autofill:plan"] = PLAN;
    await cmdAutofillPlan(ctx());
    expect(emitted()).toMatchObject({ ok: true, planned_count: 340 });
  });
});

describe("autofill submit", () => {
  beforeEach(() => {
    fake.answers["nxis_bulk_autofill:plan"] = PLAN;
    fake.answers["nxis_bulk_autofill:submit"] = { mode: "submit", started: true, batch_id: "b-1", job_count: 340, resource_count: 340 };
  });

  it("plans, then submits once with --yes, and remembers the batch", async () => {
    await cmdAutofillSubmit(ctx(), { yes: true });
    expect(callsTo(fake, "nxis_bulk_autofill").map((c) => c.args["mode"])).toEqual(["plan", "submit"]);
    expect(callsTo(fake, "nxis_bulk_autofill", "submit")[0]?.args).toEqual({
      mode: "submit",
      existing: "import_and_complete",
      site: "site-1",
    });
    expect(emitted()).toEqual({
      ok: true,
      site: "site-1",
      host: "127.0.0.1",
      started: true,
      already_running: false,
      batch_id: "b-1",
      job_count: 340,
      resource_count: 340,
      existing: "import_and_complete",
      media_type: null,
      pattern: null,
      planned_count: 340,
      status: null,
      note: null,
    });
    expect(siteJobs(ctx(), ORG, "site-1").batch?.batch_id).toBe("b-1");
  });

  it("asks on a terminal, showing the count and mode, and submits on yes", async () => {
    const questions: string[] = [];
    await cmdAutofillSubmit(ctx(), { asker: { interactive: true, confirm: async (q) => (questions.push(q), true) } });
    expect(questions[0]).toContain("340 resources");
    expect(questions[0]).toContain("import_and_complete");
    expect(callsTo(fake, "nxis_bulk_autofill", "submit")).toHaveLength(1);
  });

  it("submits nothing on no", async () => {
    const err = await caught(() => cmdAutofillSubmit(ctx(), { asker: no }));
    expect(err.reason).toBe("cancelled");
    expect(callsTo(fake, "nxis_bulk_autofill", "submit")).toEqual([]);
  });

  it("without a terminal or --yes, stops with exit 2 and the plan", async () => {
    const err = await caught(() => cmdAutofillSubmit(ctx(), { asker: nobody }));
    expect(err.reason).toBe("confirmation_required");
    expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
    expect(err.toJSON()).toMatchObject({
      ok: false,
      reason: "confirmation_required",
      plan: { planned_count: 340, existing: "import_and_complete", credits_remaining: 7500 },
    });
    expect(callsTo(fake, "nxis_bulk_autofill", "submit")).toEqual([]);
  });

  it("refuses when nothing is planned, the balance is used up, or the pattern has no count", async () => {
    fake.answers["nxis_bulk_autofill:plan"] = { ...PLAN, resource_count: 0, site_total: 0 };
    expect((await caught(() => cmdAutofillSubmit(ctx(), { yes: true }))).reason).toBe("nothing_planned");
    fake.answers["nxis_bulk_autofill:plan"] = { ...PLAN, credits_remaining: 0, quota_exceeded: true };
    expect((await caught(() => cmdAutofillSubmit(ctx(), { yes: true }))).reason).toBe("credits_exhausted");
    fake.answers["nxis_bulk_autofill:plan"] = { ...PLAN, pattern: "/nope/*" };
    expect((await caught(() => cmdAutofillSubmit(ctx(), { yes: true, pattern: "/nope/*" }))).reason).toBe(
      "scope_not_counted",
    );
    expect(callsTo(fake, "nxis_bulk_autofill", "submit")).toEqual([]);
  });

  it("reports started: false as the batch already running, charged nothing", async () => {
    fake.answers["nxis_bulk_autofill:submit"] = {
      mode: "submit",
      started: false,
      batch_id: "b-0",
      status: "RUNNING",
      total: 100,
      done: 40,
      note: "A batch is already running for this site",
    };
    await cmdAutofillSubmit(ctx(), { yes: true });
    expect(emitted()).toMatchObject({ ok: true, started: false, already_running: true, batch_id: "b-0", status: "RUNNING" });
    expect(siteJobs(ctx(), ORG, "site-1").batch?.batch_id).toBe("b-0");
    expect(callsTo(fake, "nxis_bulk_autofill", "submit")).toHaveLength(1);
  });

  it("reports a running batch that is PAUSED as the pause, exit 2", async () => {
    fake.answers["nxis_bulk_autofill:submit"] = { mode: "submit", started: false, batch_id: "b-0", status: "PAUSED" };
    const err = await caught(() => cmdAutofillSubmit(ctx(), { yes: true }));
    expect(err.reason).toBe("autofill_paused");
    expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
    expect(err.details).toMatchObject({ started: false, batch_id: "b-0", buy_credits: "nxis credits packs" });
    expect(callsTo(fake, "nxis_bulk_autofill", "submit")).toHaveLength(1);
  });

  it("on a timeout, never submits again: one submit reaches the server, and status is polled instead", async () => {
    rememberJobs(ctx(), ORG, "site-1", { batch: { batch_id: "b-prev", at: 0 } });
    let release: () => void = () => undefined;
    fake.answers["nxis_bulk_autofill:submit"] = () =>
      new Promise((resolve) => {
        release = () => resolve({ mode: "submit", started: true, batch_id: "b-late" });
      });
    fake.answers["nxis_bulk_autofill:status"] = { found: true, batch_id: "b-prev", status: "RUNNING", terminal: false, total: 10, done: 2 };

    const err = await caught(() => cmdAutofillSubmit(ctx(), { yes: true, submitTimeoutMs: 150 }));
    release();

    expect(err.reason).toBe("submit_unconfirmed");
    expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
    expect(err.message).toContain("Do not submit again");
    expect(callsTo(fake, "nxis_bulk_autofill", "submit")).toHaveLength(1);
    // This server answers a status without a batch_id with no list, as an older one does.
    expect(callsTo(fake, "nxis_bulk_autofill").map((c) => c.args["mode"])).toEqual(["plan", "submit", "status", "status"]);
    expect(callsTo(fake, "nxis_bulk_autofill", "status").map((c) => c.args["batch_id"])).toEqual([undefined, "b-prev"]);
    expect(err.details).toMatchObject({
      cause: "timeout",
      batch_id: null,
      recent_batches: null,
      last_batch: { batch_id: "b-prev", status: "RUNNING" },
    });
  });

  it("on a timeout with no batch to poll, says where to look, still without resubmitting", async () => {
    fake.answers["nxis_bulk_autofill:submit"] = () => new Promise(() => undefined);
    const err = await caught(() => cmdAutofillSubmit(ctx(), { yes: true, submitTimeoutMs: 100 }));
    expect(err.reason).toBe("submit_unconfirmed");
    expect(err.details["last_batch"]).toBeNull();
    expect(err.message).toContain("--batch <id>");
    expect(callsTo(fake, "nxis_bulk_autofill", "submit")).toHaveLength(1);
  });

  describe("on a lost answer, finds the batch by listing the latest ones", () => {
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    /** A submit that never answers, and a status that lists `batches()` when given no batch_id. */
    function lost(batches: () => Array<Record<string, unknown>>): void {
      fake.answers["nxis_bulk_autofill:submit"] = () => new Promise(() => undefined);
      fake.answers["nxis_bulk_autofill:status"] = (a) =>
        a["batch_id"] === undefined
          ? { mode: "status", batches: batches(), note: "The site's latest batches, newest first." }
          : { found: true, batch_id: a["batch_id"], status: "RUNNING", terminal: false };
    }

    it("reports a batch that started after the submit was sent as the one it started, and saves it", async () => {
      rememberJobs(ctx(), ORG, "site-1", { batch: { batch_id: "b-prev", at: 0 } });
      lost(() => [
        { batch_id: "b-old", status: "COMPLETE", total: 5, done: 5, failed: 0, terminal: true, started_at: ago(3_600_000) },
        { batch_id: "b-new", status: "PROCESSING", total: 340, done: 0, failed: 0, terminal: false, started_at: ago(0) },
      ]);
      const err = await caught(() => cmdAutofillSubmit(ctx(), { yes: true, submitTimeoutMs: 100 }));
      expect(err.reason).toBe("submit_unconfirmed");
      expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
      expect(err.message).toContain("b-new");
      expect(err.message).toContain("nxis autofill status --wait");
      expect(err.message).not.toContain("dashboard");
      expect(err.details).toMatchObject({
        batch_id: "b-new",
        batch: { batch_id: "b-new", status: "PROCESSING", terminal: false, total: 340, done: 0 },
        last_batch: null,
      });
      // Sorted newest first, whatever order the server sent.
      expect((err.details["recent_batches"] as Array<{ batch_id: string }>).map((b) => b.batch_id)).toEqual(["b-new", "b-old"]);
      expect(siteJobs(ctx(), ORG, "site-1").batch).toMatchObject({ batch_id: "b-new", existing: "import_and_complete" });
      // One read, with no batch_id, and one submit.
      expect(callsTo(fake, "nxis_bulk_autofill").map((c) => c.args["mode"])).toEqual(["plan", "submit", "status"]);
      expect(callsTo(fake, "nxis_bulk_autofill", "status")[0]?.args).toEqual({ mode: "status", site: "site-1" });
    });

    it("allows a little clock skew, but not an older batch", async () => {
      lost(() => [{ batch_id: "b-skew", status: "PROCESSING", terminal: false, started_at: ago(30_000) }]);
      const skewed = await caught(() => cmdAutofillSubmit(ctx(), { yes: true, submitTimeoutMs: 100 }));
      expect(skewed.details["batch_id"]).toBe("b-skew");

      rmSync(join(dir, "nxis", "jobs.json"));
      fake.calls = [];
      lost(() => [{ batch_id: "b-before", status: "COMPLETE", terminal: true, started_at: ago(5 * 60_000) }]);
      const older = await caught(() => cmdAutofillSubmit(ctx(), { yes: true, submitTimeoutMs: 100 }));
      expect(older.reason).toBe("submit_unconfirmed");
      expect(older.details).toMatchObject({ batch_id: null, batch: null, recent_batches: [{ batch_id: "b-before" }] });
      expect(older.message).toContain("No batch has started since");
      expect(older.message).toContain("nxis autofill status --recent");
      expect(older.message).not.toContain("dashboard");
      expect(siteJobs(ctx(), ORG, "site-1").batch).toBeUndefined();
      expect(callsTo(fake, "nxis_bulk_autofill", "submit")).toHaveLength(1);
    });

    it("takes no batch without a start time, and names one still running from before", async () => {
      lost(() => [
        { batch_id: "b-undated", status: "PENDING", terminal: false },
        { batch_id: "b-running", status: "PROCESSING", terminal: false, started_at: ago(10 * 60_000) },
      ]);
      const err = await caught(() => cmdAutofillSubmit(ctx(), { yes: true, submitTimeoutMs: 100 }));
      expect(err.details["batch_id"]).toBeNull();
      expect(err.message).toContain("--batch b-running --wait");
      expect(callsTo(fake, "nxis_bulk_autofill", "submit")).toHaveLength(1);
    });

    it("falls back to the last saved batch when the server requires a batch_id", async () => {
      rememberJobs(ctx(), ORG, "site-1", { batch: { batch_id: "b-prev", at: 0 } });
      fake.answers["nxis_bulk_autofill:submit"] = () => new Promise(() => undefined);
      fake.answers["nxis_bulk_autofill:status"] = (a) =>
        a["batch_id"] === undefined
          ? { isError: true, text: "`batch_id` is required for status" }
          : { found: true, batch_id: a["batch_id"], status: "COMPLETE", terminal: true };
      const err = await caught(() => cmdAutofillSubmit(ctx(), { yes: true, submitTimeoutMs: 100 }));
      expect(err.reason).toBe("submit_unconfirmed");
      expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
      expect(err.details).toMatchObject({ batch_id: null, recent_batches: null, last_batch: { batch_id: "b-prev" } });
      expect(err.message).toContain("dashboard");
      expect(siteJobs(ctx(), ORG, "site-1").batch?.batch_id).toBe("b-prev");
      expect(callsTo(fake, "nxis_bulk_autofill", "submit")).toHaveLength(1);
    });
  });

  it("reports a tool error as it is, since the server answered", async () => {
    fake.answers["nxis_bulk_autofill:submit"] = { isError: true, text: "Site is not verified" };
    const err = await caught(() => cmdAutofillSubmit(ctx(), { yes: true }));
    expect(err.reason).toBe("tool_error");
    expect(callsTo(fake, "nxis_bulk_autofill", "submit")).toHaveLength(1);
  });

  it("under --dry-run, plans and withholds the submit, reporting the plan", async () => {
    setTrace({ dryRun: true });
    const err = await caught(() => cmdAutofillSubmit(ctx(), { asker: nobody }));
    expect(err.reason).toBe("dry_run");
    expect(err.details).toMatchObject({ tool: "nxis_bulk_autofill", plan: { planned_count: 340 } });
    expect(callsTo(fake, "nxis_bulk_autofill").map((c) => c.args["mode"])).toEqual(["plan"]);
  });

  it("--wait follows the batch it started", async () => {
    const seq = [
      { found: true, status: "RUNNING", terminal: false, total: 340, done: 100 },
      { found: true, status: "COMPLETE", terminal: true, total: 340, done: 340, failed: 0 },
    ];
    fake.answers["nxis_bulk_autofill:status"] = () => seq.shift() as Record<string, unknown>;
    await cmdAutofillSubmit(ctx(), { yes: true, wait: true, intervalMs: 5 });
    const out = emitted();
    expect(out).toMatchObject({ ok: true, started: true, batch_id: "b-1", batch: { status: "COMPLETE", terminal: true } });
    expect(callsTo(fake, "nxis_bulk_autofill", "submit")).toHaveLength(1);
  });
});

describe("autofill status", () => {
  beforeEach(() => {
    rememberJobs(ctx(), ORG, "site-1", { batch: { batch_id: "b-1", at: 0 } });
  });

  it("reads the remembered batch, with a stable shape", async () => {
    fake.answers["nxis_bulk_autofill:status"] = { mode: "status", batch_id: "b-1", found: true, status: "RUNNING", total: 10, done: 3, failed: 0, terminal: false };
    await cmdAutofillStatus(ctx());
    expect(callsTo(fake, "nxis_bulk_autofill")[0]?.args).toEqual({ mode: "status", batch_id: "b-1", site: "site-1" });
    expect(emitted()).toEqual({
      ok: true,
      site: "site-1",
      host: "127.0.0.1",
      batch_id: "b-1",
      found: true,
      status: "RUNNING",
      terminal: false,
      total: 10,
      done: 3,
      failed: 0,
      note: null,
    });
  });

  it("takes --batch", async () => {
    fake.answers["nxis_bulk_autofill:status"] = { found: true, status: "COMPLETE", terminal: true, total: 1, done: 1, failed: 0 };
    await autofill(ctx(), ["status"], parseArgs(["--batch", "b-9"]).flags);
    expect(callsTo(fake, "nxis_bulk_autofill")[0]?.args["batch_id"]).toBe("b-9");
  });

  it("reports PAUSED as exit 2 with how to buy credits, and never resumes it", async () => {
    fake.answers["nxis_bulk_autofill:status"] = { found: true, status: "PAUSED", terminal: false, total: 10, done: 4, failed: 0 };
    const err = await caught(() => cmdAutofillStatus(ctx(), { wait: true, intervalMs: 5 }));
    expect(err.reason).toBe("autofill_paused");
    expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
    expect(err.message).toContain("nxis credits packs");
    expect(err.details).toMatchObject({ status: "PAUSED", terminal: false, buy_credits: "nxis credits packs" });
    // One read: --wait stops on PAUSED rather than waiting on it, and nothing is resubmitted.
    expect(callsTo(fake, "nxis_bulk_autofill").map((c) => c.args["mode"])).toEqual(["status"]);
  });

  it("--wait polls until terminal", async () => {
    const seq = ["RUNNING", "RUNNING", "COMPLETE"];
    fake.answers["nxis_bulk_autofill:status"] = () => {
      const status = seq.shift() as string;
      return { found: true, status, terminal: status === "COMPLETE", total: 5, done: 5, failed: 1 };
    };
    await cmdAutofillStatus(ctx(false), { wait: true, intervalMs: 5 });
    expect(callsTo(fake, "nxis_bulk_autofill", "status")).toHaveLength(3);
    expect(stdout.join("")).toContain("nxis publish");
  });

  it("--wait gives up after --timeout with exit 2", async () => {
    fake.answers["nxis_bulk_autofill:status"] = { found: true, status: "RUNNING", terminal: false };
    const err = await caught(() => cmdAutofillStatus(ctx(), { wait: true, intervalMs: 20, timeoutMinutes: 0.001 }));
    expect(err.reason).toBe("autofill_running");
    expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
  });

  it("reports FAILED as exit 1, and an unknown batch as exit 2", async () => {
    fake.answers["nxis_bulk_autofill:status"] = { found: true, status: "FAILED", terminal: true, total: 5, done: 2 };
    expect((await caught(() => cmdAutofillStatus(ctx()))).exitCode).toBe(ExitCode.ERROR);
    fake.answers["nxis_bulk_autofill:status"] = { found: false, batch_id: "b-1" };
    const missing = await caught(() => cmdAutofillStatus(ctx()));
    expect(missing.reason).toBe("batch_not_found");
    expect(missing.exitCode).toBe(ExitCode.NEEDS_USER);
  });

  it("with no batch started and none given, lists the site's latest batches", async () => {
    rmSync(join(dir, "nxis", "jobs.json"));
    fake.answers["nxis_bulk_autofill:status"] = {
      mode: "status",
      batches: [{ batch_id: "b-7", status: "COMPLETE", total: 3, done: 3, failed: 0, terminal: true, started_at: "2026-11-04T15:02:11Z" }],
    };
    await cmdAutofillStatus(ctx());
    expect(callsTo(fake, "nxis_bulk_autofill")[0]?.args).toEqual({ mode: "status", site: "site-1" });
    expect(emitted()).toEqual({
      ok: true,
      site: "site-1",
      host: "127.0.0.1",
      batches: [
        { batch_id: "b-7", status: "COMPLETE", terminal: true, total: 3, done: 3, failed: 0, started_at: "2026-11-04T15:02:11Z" },
      ],
    });
  });

  it("--recent lists them even with a batch saved", async () => {
    fake.answers["nxis_bulk_autofill:status"] = { mode: "status", batches: [{ batch_id: "b-8", status: "PROCESSING" }] };
    await autofill(ctx(false), ["status"], parseArgs(["--recent"]).flags);
    expect(callsTo(fake, "nxis_bulk_autofill")[0]?.args).toEqual({ mode: "status", site: "site-1" });
    expect(stdout.join("")).toContain("b-8");
  });

  it("with no batch anywhere, or a server that cannot list them, says so", async () => {
    rmSync(join(dir, "nxis", "jobs.json"));
    fake.answers["nxis_bulk_autofill:status"] = { mode: "status", batches: [], note: "This site has no batches." };
    const none = await caught(() => cmdAutofillStatus(ctx()));
    expect(none.reason).toBe("no_batch");
    expect(none.exitCode).toBe(ExitCode.NEEDS_USER);
    expect(none.message).toContain("has no batches");

    fake.answers["nxis_bulk_autofill:status"] = { isError: true, text: "`batch_id` is required for status" };
    const older = await caught(() => cmdAutofillStatus(ctx()));
    expect(older.reason).toBe("no_batch");
    expect(older.message).toContain("has started no batch");
  });
});

// ── publish ───────────────────────────────────────────────────────────────

describe("publish", () => {
  /** Answers the count (dry run) and the publish differently, as the server does. */
  function answerPublish(count: number, already = 0): void {
    fake.answers["nxis_publish_entities"] = (args) =>
      args["dry_run"] === true
        ? { dry_run: true, published_count: count, already_published_count: already, skipped_disabled_count: count }
        : { dry_run: false, published_count: count, already_published_count: already, skipped_disabled_count: count };
  }

  it("publishes with --yes, without counting first, with a stable shape", async () => {
    fake.answers["nxis_publish_entities"] = { dry_run: false, published_count: 290, already_published_count: 0, skipped_disabled_count: 290 };
    await cmdPublish(ctx(), { yes: true });
    expect(callsTo(fake, "nxis_publish_entities").map((c) => c.args)).toEqual([{ site: "site-1" }]);
    expect(emitted()).toEqual({
      ok: true,
      site: "site-1",
      host: "127.0.0.1",
      dry_run: false,
      schema_type: null,
      published_count: 290,
      already_published_count: 0,
      skipped_disabled_count: 290,
      note: null,
    });
  });

  it("--yes from the command line skips the prompt", async () => {
    answerPublish(290);
    await publish(ctx(), [], parseArgs(["--yes"]).flags);
    expect(callsTo(fake, "nxis_publish_entities").map((c) => c.args)).toEqual([{ site: "site-1" }]);
    expect(emitted()).toMatchObject({ ok: true, dry_run: false, published_count: 290 });
  });

  it("counts with the read-only dry run, asks showing the count, and publishes on yes", async () => {
    answerPublish(290, 10);
    const questions: string[] = [];
    await cmdPublish(ctx(), { schemaType: "Product", asker: { interactive: true, confirm: async (q) => (questions.push(q), true) } });
    expect(callsTo(fake, "nxis_publish_entities").map((c) => c.args)).toEqual([
      { site: "site-1", schema_type: "Product", dry_run: true },
      { site: "site-1", schema_type: "Product" },
    ]);
    expect(questions).toEqual(["Publish 290 Product records on 127.0.0.1?"]);
    // The summary, with the breakdown, goes to stderr before the question.
    expect(stderr.join("")).toContain("290 Product records would go live on 127.0.0.1. 10 already live.");
    expect(emitted()).toMatchObject({ ok: true, dry_run: false, published_count: 290, already_published_count: 10 });
  });

  it("publishes nothing on no", async () => {
    answerPublish(290);
    const err = await caught(() => cmdPublish(ctx(), { asker: no }));
    expect(err.reason).toBe("cancelled");
    expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
    expect(err.details["published_count"]).toBe(290);
    expect(callsTo(fake, "nxis_publish_entities").map((c) => c.args)).toEqual([{ site: "site-1", dry_run: true }]);
  });

  it("without a terminal or --yes, stops with exit 2 and the count", async () => {
    answerPublish(290);
    const err = await caught(() => cmdPublish(ctx(), { asker: nobody }));
    expect(err.reason).toBe("confirmation_required");
    expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
    expect(err.message).toContain("290 records would go live");
    expect(err.toJSON()).toMatchObject({
      ok: false,
      reason: "confirmation_required",
      published_count: 290,
      preview: { dry_run: true, published_count: 290, already_published_count: 0, schema_type: null },
    });
    expect(callsTo(fake, "nxis_publish_entities").map((c) => c.args)).toEqual([{ site: "site-1", dry_run: true }]);
  });

  it("with nothing to publish, neither asks nor publishes", async () => {
    answerPublish(0);
    let asked = false;
    await cmdPublish(ctx(false), { asker: { interactive: true, confirm: async () => ((asked = true), true) } });
    expect(asked).toBe(false);
    expect(callsTo(fake, "nxis_publish_entities").map((c) => c.args)).toEqual([{ site: "site-1", dry_run: true }]);
    expect(stdout.join("")).toContain("Nothing to publish");
  });

  it("--dry-run calls the tool's own read-only dry run, which reaches the server", async () => {
    setTrace({ dryRun: true });
    fake.answers["nxis_publish_entities"] = { dry_run: true, published_count: 290 };
    await publish(ctx(), [], parseArgs(["--dry-run", "--type", "Product"]).flags);
    expect(callsTo(fake, "nxis_publish_entities")[0]?.args).toEqual({ site: "site-1", schema_type: "Product", dry_run: true });
    expect(emitted()).toMatchObject({ ok: true, dry_run: true, published_count: 290 });
    // --dry-run also traces, on stderr.
    expect(stderr.join("")).toContain("tools/call");
  });

  it("--dry-run with no key yet reports that issuing one is withheld", async () => {
    setTrace({ dryRun: true });
    rmSync(join(dir, "nxis", "provisioning-keys.json"));
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    process.env.NXIS_TOKEN = `${b64({ alg: "none" })}.${b64({ "https://nxis.ai/user_data": { account: { _id: { value: "acct-1" } } } })}.x`;
    const err = await caught(() => cmdPublish(ctx()));
    expect(err.reason).toBe("dry_run");
    expect(err.exitCode).toBe(ExitCode.OK);
    expect(err.message).toContain("needs a provisioning key");
    expect(err.details["needs_provisioning_key"]).toBe(true);
    expect(fake.calls).toEqual([]);
  });
});

// ── helpers ───────────────────────────────────────────────────────────────

describe("parseSitemap", () => {
  it("reads <loc> with entities and CDATA, ignoring comments and image extensions", () => {
    const xml =
      '<urlset xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">' +
      "<!-- <url><loc>https://old.example/</loc></url> -->" +
      "<url><loc> https://a.example/?x=1&amp;y=2 </loc><image:image><image:loc>https://cdn.example/i.png</image:loc></image:image></url>" +
      "<url><loc><![CDATA[https://a.example/b]]></loc></url></urlset>";
    expect(parseSitemap(xml)).toEqual({ kind: "urlset", locs: ["https://a.example/?x=1&y=2", "https://a.example/b"] });
  });

  it("returns null for something that is not a sitemap", () => {
    expect(parseSitemap("<html></html>")).toBeNull();
  });
});

describe("isYes", () => {
  it("is yes only for y or yes", () => {
    expect(["y", "Y", "yes", " YES "].every(isYes)).toBe(true);
    expect(["", "n", "no", "sure", "yess"].some(isYes)).toBe(false);
  });
});
