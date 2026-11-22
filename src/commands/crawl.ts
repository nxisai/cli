/**
 * `nxis crawl submit` and `nxis crawl status`: ingest the site's pages from its sitemap.
 *
 * @remarks
 * The crawl is free, but autofill bills for every page it finds, so `submit` first checks that
 * every URL in the sitemap is on the site's own host (see `../sitemap.ts`). There is no flag to
 * skip that: a sitemap on another host is fixed in the project, then deployed, then crawled.
 *
 * Crawling runs in the background. `submit` returns once the sitemap is queued; `--wait` (on
 * either command) polls until the crawl is `COMPLETE` or `FAILED`. Wait for it before
 * `nxis autofill plan`, which counts what the crawl found.
 */

import { bool, num, type Parsed } from "../args.js";
import type { Ctx } from "../context.js";
import { CliError, failed, needsUser } from "../errors.js";
import { rememberJobs, siteJobs } from "../jobs.js";
import { bold, dim, plainText } from "../output.js";
import { checkSitemap, type SitemapCheck } from "../sitemap.js";
import { crawlSitemap, type CrawlSitemapResult } from "../tools/provisioning.js";
import {
  minutes,
  orNull,
  POLL_INTERVAL_MS,
  siteOrigin,
  waitFor,
  withSiteSession,
  type SiteSession,
} from "./data-shared.js";

/** How long `--wait` waits for a crawl by default, in minutes. */
const DEFAULT_WAIT_MINUTES = 30;

/** Arguments for `nxis crawl submit` and `nxis crawl status`. */
export interface CrawlArgs {
  /** The sitemap URL. Defaults to the last one submitted for the site, then `<site>/sitemap.xml`. */
  sitemap?: string;
  wait?: boolean;
  timeoutMinutes?: number;
  /** Milliseconds between status reads under `--wait`. */
  intervalMs?: number;
}

/** A crawl's state as `--json` reports it. Every key is always present. */
function crawlShape(s: SiteSession, sitemap: string, data: CrawlSitemapResult) {
  return {
    site: s.siteId,
    host: s.host,
    sitemap: data.sitemap ?? sitemap,
    found: data.found ?? true,
    state: orNull(data.state),
    done: data.done ?? (data.state === "COMPLETE" || data.state === "FAILED"),
    is_sitemap_index: orNull(data.is_sitemap_index),
    error: orNull(data.error),
    record: orNull(data.record),
    note: orNull(data.note),
  };
}

/** @returns The sitemap to act on: as given, the last one submitted, or `<site>/sitemap.xml`. */
function sitemapFor(ctx: Ctx, s: SiteSession, given: string | undefined): string {
  if (given) return given;
  const last = siteJobs(ctx, s.orgId, s.siteId).crawl?.sitemap;
  return last ?? new URL("/sitemap.xml", siteOrigin(s.site, s.host)).toString();
}

/**
 * Runs `nxis crawl submit [<sitemap-url>]`.
 *
 * @throws CliError from the sitemap check (`sitemap_off_host`, `sitemap_not_found`,
 * `sitemap_empty`: exit 2), `crawl_failed` (exit 1), `crawl_running` (exit 2) when `--wait` runs
 * out of time, and `dry_run` (exit 0) under `--dry-run`, after the check.
 */
export async function cmdCrawlSubmit(ctx: Ctx, args: CrawlArgs = {}): Promise<void> {
  await withSiteSession(ctx, async (s) => {
    const sitemap = args.sitemap ?? new URL("/sitemap.xml", siteOrigin(s.site, s.host)).toString();
    ctx.io.note(dim(`Checking every URL in ${sitemap} is on ${s.host}…`));
    const check = await checkSitemap(sitemap, s.host);
    ctx.io.note(
      dim(
        `${check.urls_checked} URL${check.urls_checked === 1 ? "" : "s"} in ${check.sitemaps_checked} ` +
          `sitemap${check.sitemaps_checked === 1 ? "" : "s"}, all on ${s.host}.`,
      ),
    );

    const out = await crawlSitemap
      .run(ctx, { mode: "submit", url: sitemap, site: s.siteId }, { provisioning: s.provisioning })
      .catch((err: unknown) => {
        // A dry run gets as far as the submit, so it reports the check that passed too.
        if (err instanceof CliError && err.reason === "dry_run") {
          throw new CliError(err.message, { exitCode: err.exitCode, reason: err.reason, details: { ...err.details, check } });
        }
        throw err;
      });
    rememberJobs(ctx, s.orgId, s.siteId, { crawl: { sitemap, at: Math.floor(Date.now() / 1000) } });

    const submitted = crawlShape(s, sitemap, out.data ?? {});
    if (!args.wait || submitted.done) {
      settle(ctx, { ...submitted, check }, "submitted");
      return;
    }
    ctx.io.note(`Crawl queued (${submitted.state ?? "QUEUED"}). Waiting for it to finish…`);
    await waitAndSettle(ctx, s, sitemap, args, check);
  });
}

/**
 * Runs `nxis crawl status [<sitemap-url>]`.
 *
 * @throws CliError `crawl_not_found` (exit 2) when the site has no crawl for the sitemap;
 * `crawl_failed` (exit 1); `crawl_running` (exit 2) when `--wait` runs out of time.
 */
export async function cmdCrawlStatus(ctx: Ctx, args: CrawlArgs = {}): Promise<void> {
  await withSiteSession(ctx, async (s) => {
    const sitemap = sitemapFor(ctx, s, args.sitemap);
    if (!args.wait) {
      settle(ctx, await readStatus(ctx, s, sitemap), "status");
      return;
    }
    await waitAndSettle(ctx, s, sitemap, args, null);
  });
}

async function readStatus(ctx: Ctx, s: SiteSession, sitemap: string) {
  const out = await crawlSitemap.run(
    ctx,
    { mode: "status", url: sitemap, site: s.siteId },
    { provisioning: s.provisioning },
  );
  return crawlShape(s, sitemap, out.data ?? {});
}

async function waitAndSettle(
  ctx: Ctx,
  s: SiteSession,
  sitemap: string,
  args: CrawlArgs,
  check: SitemapCheck | null,
): Promise<void> {
  const timeoutMs = minutes(args.timeoutMinutes, DEFAULT_WAIT_MINUTES);
  const { value, settled } = await waitFor({
    read: () => readStatus(ctx, s, sitemap),
    settled: (v) => v.done || !v.found,
    intervalMs: args.intervalMs ?? POLL_INTERVAL_MS,
    timeoutMs,
    onWait: (v, elapsed) => ctx.io.note(dim(`  ${v.state ?? "…"} (${Math.round(elapsed / 1000)}s)`)),
  });
  const shape = check ? { ...value, check } : value;
  if (!settled) {
    throw needsUser(
      `The crawl is still ${value.state ?? "running"} after ${Math.round(timeoutMs / 60_000)} minutes. ` +
        "It carries on in the background: check again with `nxis crawl status --wait`.",
      "crawl_running",
      shape,
    );
  }
  settle(ctx, shape, "status");
}

/** Emits a crawl's state, or fails for one that failed or does not exist. */
function settle(ctx: Ctx, shape: ReturnType<typeof crawlShape> & { check?: SitemapCheck }, from: string): void {
  if (!shape.found) {
    throw needsUser(
      `This site has no crawl for ${shape.sitemap}. Submit one with \`nxis crawl submit\`, or check the URL ` +
        "matches the one submitted.",
      "crawl_not_found",
      shape,
    );
  }
  if (shape.state === "FAILED") {
    const why = shape.error ? `: ${plainText(shape.error)}` : ".";
    throw failed(`The crawl of ${shape.sitemap} failed${why}`, "crawl_failed", shape);
  }
  ctx.io.emit({ ok: true, ...shape }, () => {
    if (shape.state === "COMPLETE") {
      return `${bold("Crawled")} ${shape.sitemap}. Next: \`nxis autofill plan\`.`;
    }
    const verb = from === "submitted" ? "Queued the crawl of" : "Crawling";
    return (
      `${verb} ${shape.sitemap}: ${bold(shape.state ?? "QUEUED")}. It runs in the background; ` +
      "`nxis crawl status --wait` waits for it. Plan autofill only once it is COMPLETE."
    );
  });
}

/** Dispatches `nxis crawl <submit|status> [<sitemap-url>]`. */
export async function crawl(ctx: Ctx, positional: string[], flags: Parsed["flags"]): Promise<void> {
  const [sub, sitemap] = positional;
  const args: CrawlArgs = {
    wait: bool(flags, "wait"),
    ...(sitemap ? { sitemap } : {}),
    ...(num(flags, "timeout") !== undefined ? { timeoutMinutes: num(flags, "timeout") as number } : {}),
  };
  if (sub === "submit") return cmdCrawlSubmit(ctx, args);
  if (sub === "status") return cmdCrawlStatus(ctx, args);
  throw new CliError("Try `nxis crawl submit [<sitemap-url>]` or `nxis crawl status [--wait]`.", {
    reason: "unknown_command",
  });
}
