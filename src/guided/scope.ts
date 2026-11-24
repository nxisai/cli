/**
 * Which pages a billed batch covers: all of them, or one of the site's path clusters, chosen by
 * the user before anything is billed.
 *
 * @remarks
 * Offered only when the call names no scope of its own (no `pattern`, no media type). Each choice
 * carries its count, and an estimate where the price per page is fixed. The count the batch is
 * then confirmed with is the narrowed plan's own `planned_count` (its `pattern_count`), never the
 * site-wide `resource_count`.
 */

import { listPathClusters, type PathCluster } from "../api/page-groups.js";
import type { Ctx } from "../context.js";
import { requireSession } from "../context.js";
import type { Answer, Guide } from "../guide.js";
import { formatCredits, plainText } from "../output.js";

/** At most this many clusters are offered, the largest first. */
export const MAX_CLUSTERS = 12;

/** What the scope question needs. */
export interface ScopeQuestion {
  host: string;
  /** Every page the plan counts, for "all pages". */
  allCount: number | null;
  /** The fixed price per page, for an estimate beside each choice; null when it varies. */
  perPageMilli: number | null;
}

/** @returns The site's largest path clusters, or none when they can't be read. */
export async function siteClusters(ctx: Ctx, orgId: string, siteId: string): Promise<PathCluster[]> {
  try {
    const { token } = await requireSession(ctx);
    return (await listPathClusters(ctx.config, token, orgId, siteId)).slice(0, MAX_CLUSTERS);
  } catch {
    return [];
  }
}

/** @returns True when the clusters give the user a real choice: more than one, or one short of every page. */
export function worthAsking(found: PathCluster[], allCount: number | null): boolean {
  return found.length > 1 || (found.length === 1 && found[0]?.count !== allCount);
}

/** @returns "240 pages", with an estimate when the price per page is fixed. */
function countLabel(count: number | null, perPageMilli: number | null): string {
  if (count === null) return "count unknown";
  const pages = `${count.toLocaleString("en-US")} page${count === 1 ? "" : "s"}`;
  return perPageMilli === null ? pages : `${pages}, about ${formatCredits(perPageMilli * count)}`;
}

/**
 * Asks which pages the batch covers.
 *
 * @param found - The site's clusters, from {@link siteClusters}.
 * @returns The chosen cluster's pattern, null for all pages, or the user's no. `ok` with null,
 * asking nothing, when the clusters are no real choice ({@link worthAsking}).
 */
export async function chooseScope(guide: Guide, q: ScopeQuestion, found: PathCluster[]): Promise<Answer<string | null>> {
  if (!worthAsking(found, q.allCount)) return { ok: true, value: null };
  return guide.choose<string | null>({
    message:
      `Which pages of ${q.host} should the batch cover? It spends credits for each page it covers.` +
      (q.perPageMilli === null ? " The price per generated page varies, so only an import has an estimate." : ""),
    title: "Pages",
    options: [
      { value: null, label: `All pages (${countLabel(q.allCount, q.perPageMilli)})` },
      ...found.map((c) => ({ value: c.pattern, label: `${plainText(c.pattern)} (${countLabel(c.count, q.perPageMilli)})` })),
    ],
  });
}
