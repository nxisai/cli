/**
 * The last crawl and autofill batch the CLI started for each site.
 *
 * @remarks
 * `nxis_crawl_sitemap` reports status by sitemap URL, and `nxis_bulk_autofill` by batch id. So
 * `crawl status` and `autofill status` with no arguments read what the last `submit` saved here
 * (or, for a submit whose answer was lost, the batch the CLI found it started). Nothing in this file is a secret: a sitemap URL and a batch id.
 *
 * Each entry is scoped to the environment, organization and site it was started in, so a batch
 * id from the local stack is never polled against production.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, endpointKey } from "./config.js";
import type { Ctx } from "./context.js";
import { writePrivateFile } from "./files.js";

/** What is remembered for one site. */
export interface SiteJobs {
  crawl?: { sitemap: string; at: number };
  batch?: { batch_id: string; at: number; existing?: string; media_type?: string; pattern?: string };
}

type JobsFile = Record<string, SiteJobs>;

/** @returns The path of the file the jobs are kept in. */
export function jobsPath(): string {
  return join(configDir(), "jobs.json");
}

function load(): JobsFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(jobsPath(), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as JobsFile) : {};
  } catch {
    return {};
  }
}

/** @returns The key one site's jobs are kept under. */
function scope(ctx: Ctx, orgId: string, siteId: string): string {
  return [endpointKey(ctx.config.endpoints), orgId, siteId].join("\n");
}

/** @returns What was remembered for the site. */
export function siteJobs(ctx: Ctx, orgId: string, siteId: string): SiteJobs {
  return load()[scope(ctx, orgId, siteId)] ?? {};
}

/** Merges a change into what is remembered for the site. */
export function rememberJobs(ctx: Ctx, orgId: string, siteId: string, patch: SiteJobs): void {
  const all = load();
  const key = scope(ctx, orgId, siteId);
  all[key] = { ...all[key], ...patch };
  writePrivateFile(jobsPath(), `${JSON.stringify(all, null, 2)}\n`, { privateDir: true });
}
