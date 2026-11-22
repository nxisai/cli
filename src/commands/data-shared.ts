/**
 * What `nxis crawl`, `nxis autofill` and `nxis publish` share: the site they act on, one
 * connection for all their calls, and waiting on a background job.
 */

import type { Ctx } from "../context.js";
import { requireOrg, requireSite } from "../context.js";
import { CliError, ExitCode } from "../errors.js";
import { withProvisioning } from "../provisioning/endpoint.js";
import type { ToolCaller } from "../tools/define.js";
import type { SiteSummary } from "../tools/provisioning.js";
import { findSite } from "../tools/sites.js";

/** The site a data command acts on, and the connection it uses. */
export interface SiteSession {
  provisioning: ToolCaller;
  orgId: string;
  /** The site's id, which the tools take as `site`. */
  siteId: string;
  /** The site's host, e.g. `example.com`. */
  host: string;
  site: SiteSummary;
}

/**
 * Runs `fn` with the current site looked up and one provisioning connection open.
 *
 * @remarks
 * The site is looked up with `nxis_list_sites` (a read) so commands can name its host and default
 * its sitemap, and every call after that passes the id, so none of them looks it up again.
 *
 * Under `--dry-run` with no provisioning key stored yet, even the reads cannot run: issuing a key
 * is a write, and a dry run withholds it. That is reported as a dry run that says so, rather than
 * as the key request it withheld.
 *
 * @throws CliError `no_active_org` or `no_active_site` (exit 2) before connecting;
 * `site_not_found` (exit 2); whatever the tools throw.
 */
export async function withSiteSession<T>(ctx: Ctx, fn: (s: SiteSession) => Promise<T>): Promise<T> {
  const orgId = requireOrg(ctx);
  const wanted = requireSite(ctx);
  try {
    return await withProvisioning(ctx, async (provisioning) => {
      const site = await findSite(ctx, wanted, provisioning);
      const siteId = site.site as string;
      const host = site.host ?? site.domain ?? siteId;
      return fn({ provisioning, orgId, siteId, host, site });
    });
  } catch (err) {
    throw explainWithheldKey(err);
  }
}

/**
 * A dry run that stopped at issuing the provisioning key, reported as that.
 *
 * @remarks
 * A withheld tool call carries the tool's name; a withheld key request does not.
 */
export function explainWithheldKey(err: unknown): unknown {
  if (!(err instanceof CliError) || err.reason !== "dry_run" || "tool" in err.details) return err;
  return new CliError(
    "Dry run: this needs a provisioning key, and issuing one is a write, so nothing was sent. " +
      "Run any data command once without --dry-run (`nxis autofill plan` changes nothing) to issue it, " +
      "then dry-run again.",
    { exitCode: ExitCode.OK, reason: "dry_run", details: { ...err.details, needs_provisioning_key: true } },
  );
}

/** @returns The site's origin, e.g. `https://example.com`, from its domain. */
export function siteOrigin(site: SiteSummary, host: string): string {
  const domain = site.domain?.trim();
  if (domain && /^https?:\/\//i.test(domain)) {
    try {
      return new URL(domain).origin;
    } catch {
      // Fall through to the host.
    }
  }
  return `https://${host}`;
}

/** Options for {@link waitFor}. */
export interface WaitOptions<T> {
  /** One status read. */
  read: () => Promise<T>;
  /** Whether the status means there is nothing more to wait for. */
  settled: (value: T) => boolean;
  intervalMs: number;
  timeoutMs: number;
  /** Called after each unsettled read, before sleeping. */
  onWait?: (value: T, elapsedMs: number) => void;
}

/**
 * Reads a status until it settles or the time runs out.
 *
 * @remarks
 * A fixed interval rather than a backoff: the jobs this waits on take minutes, and the onboarding
 * guidance is to poll every 20 to 30 seconds, no faster.
 *
 * @returns The last status read, and whether it settled.
 */
export async function waitFor<T>(opts: WaitOptions<T>): Promise<{ value: T; settled: boolean }> {
  const started = Date.now();
  for (;;) {
    const value = await opts.read();
    if (opts.settled(value)) return { value, settled: true };
    const elapsed = Date.now() - started;
    if (elapsed + opts.intervalMs > opts.timeoutMs) return { value, settled: false };
    opts.onWait?.(value, elapsed);
    await new Promise((resolve) => setTimeout(resolve, opts.intervalMs));
  }
}

/** How often `--wait` polls by default: the onboarding guidance's 20 seconds. */
export const POLL_INTERVAL_MS = 20_000;

/** @returns Minutes as milliseconds, or the default when not given. */
export function minutes(value: number | undefined, fallback: number): number {
  return (value !== undefined && value > 0 ? value : fallback) * 60_000;
}

/** @returns The value, or null when absent, so `--json` keeps the same keys every time. */
export function orNull<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}
