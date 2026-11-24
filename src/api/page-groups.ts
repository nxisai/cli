/**
 * Sites API: a site's crawled pages grouped by path cluster (`/products/*`, `/blog/*`) and by
 * media type, with counts. A read.
 *
 * @remarks
 * The same grouping the autofill plan counts with, so a cluster's `pattern` here is one the plan
 * reports a `pattern_count` for.
 */

import type { Config } from "../config.js";
import { request } from "../http.js";
import { camelKeys } from "./agent-config.js";

/** One path cluster and how many of the site's pages are in it. */
export interface PathCluster {
  pattern: string;
  count: number;
}

/** @returns The site's path clusters, largest first, without empty ones. */
export async function listPathClusters(config: Config, token: string, orgId: string, siteId: string): Promise<PathCluster[]> {
  const parent = `organizations/${orgId}/sites/${siteId}`;
  const raw = await request<unknown>(
    `${config.endpoints.sites}/v1/organizations/${encodeURIComponent(orgId)}/sites/${encodeURIComponent(siteId)}/resources:pageGroups`,
    { method: "POST", token, body: { parent, only_without_entities: false } },
  );
  const body = camelKeys(raw ?? {}) as { byPattern?: unknown };
  const groups = Array.isArray(body.byPattern) ? (body.byPattern as Array<Record<string, unknown>>) : [];
  return groups
    .map((g) => ({ pattern: typeof g["pattern"] === "string" ? g["pattern"].trim() : "", count: Number(g["count"] ?? 0) }))
    .filter((g) => g.pattern && Number.isFinite(g.count) && g.count > 0)
    .sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern));
}
