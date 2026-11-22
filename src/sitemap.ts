/**
 * Checking that a sitemap names the site's own host, before it is crawled.
 *
 * @remarks
 * A crawl is free, but what comes after it is not: autofill bills for every resource the crawl
 * found, and publishes every URL in it as a fact about the business. A sitemap listing the
 * deploy's generated host (`example-shop.netlify.app`) instead of the site's own puts that host
 * into everything NxisAI extracts, and fixing it afterwards means paying to generate it all again.
 * Found here, it is a code change and a deploy.
 *
 * So every page URL in the sitemap has to be on the site's host, exactly. A sitemap index is
 * followed into each sitemap it lists. There is no bypass: a sitemap on another host is a defect
 * in the project, not a judgement call.
 *
 * Only the sitemap protocol's own `<loc>` is checked. The image and video extensions'
 * `<image:loc>` and `<video:content_loc>` name media, which is often served from a CDN on another
 * host, legitimately.
 */

import { gunzipSync } from "node:zlib";
import { failed, needsUser } from "./errors.js";
import { plainText } from "./output.js";
import { traceRequest, traceResponse } from "./trace.js";
import { hostOf } from "./tools/sites.js";

/**
 * Hosts a deploy platform generates for a deploy, never the site's canonical one.
 *
 * @remarks
 * A sitemap on one of these means the project reads its origin from the variable that holds the
 * generated URL. Any other host fails the check too; these only get a more specific explanation.
 */
export const GENERATED_HOSTS: ReadonlyArray<{ suffix: string; platform: string; variables: string }> = [
  { suffix: ".netlify.app", platform: "Netlify", variables: "URL or DEPLOY_PRIME_URL" },
  { suffix: ".vercel.app", platform: "Vercel", variables: "VERCEL_URL" },
  { suffix: ".pages.dev", platform: "Cloudflare Pages", variables: "CF_PAGES_URL" },
];

/** How deep a sitemap index is followed: an index of indexes is allowed, a third level is not. */
const MAX_DEPTH = 3;

/** How many sitemaps one check fetches at most. */
const MAX_SITEMAPS = 500;

/**
 * The most one sitemap may be, downloaded or decompressed: the sitemap protocol's own limit.
 *
 * @remarks
 * Both are checked: the download as it streams, so a huge response is never held whole, and the
 * decompressed size, so a small gzip that inflates to gigabytes (a gzip bomb) cannot exhaust memory.
 */
export const MAX_SITEMAP_BYTES = 50 * 1024 * 1024;

/** How long one sitemap fetch may take. */
const FETCH_TIMEOUT_MS = 30_000;

/** How many off-host URLs are listed in the result; the count covers all of them. */
const LISTED = 20;

/** One URL in the sitemap that is not on the site's host. */
export interface OffHost {
  /** The URL as the sitemap lists it. */
  loc: string;
  /** Its host, or null when it has none. */
  host: string | null;
  /** The sitemap that lists it. */
  sitemap: string;
  /** The platform whose generated host it is on, when it is on one. */
  generated: string | null;
}

/** What a passing check looked at. */
export interface SitemapCheck {
  sitemap: string;
  host: string;
  /** The sitemap is an index of other sitemaps. */
  is_index: boolean;
  sitemaps_checked: number;
  urls_checked: number;
}

/** @returns The platform whose generated host this is, or null. */
export function generatedPlatform(host: string | null): (typeof GENERATED_HOSTS)[number] | null {
  if (!host) return null;
  return GENERATED_HOSTS.find((g) => host.endsWith(g.suffix)) ?? null;
}

/** A parsed sitemap: an index of sitemaps, or a set of page URLs. */
export interface ParsedSitemap {
  kind: "index" | "urlset";
  locs: string[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** @returns XML text with its character and entity references decoded. */
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, ref: string) => {
    const lower = ref.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return ENTITIES[lower] ?? whole;
  });
}

/**
 * Reads a sitemap's `<loc>` entries.
 *
 * @remarks
 * A regular expression rather than an XML parser, which the CLI does not otherwise need: the
 * sitemap format is flat, and only `<loc>` matters. Comments are dropped first, so a commented-out
 * URL is not checked, and CDATA is unwrapped.
 *
 * @returns The sitemap's kind and its locations, or null when it is neither an index nor a urlset.
 */
export function parseSitemap(xml: string): ParsedSitemap | null {
  const body = xml.replace(/<!--[\s\S]*?-->/g, "");
  const kind = /<sitemapindex[\s>/]/i.test(body) ? "index" : /<urlset[\s>/]/i.test(body) ? "urlset" : null;
  if (!kind) return null;
  const locs: string[] = [];
  for (const match of body.matchAll(/<loc(?:\s[^>]*)?>([\s\S]*?)<\/loc>/gi)) {
    const raw = (match[1] ?? "").replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");
    const loc = decode(raw).trim();
    if (loc) locs.push(loc);
  }
  return { kind, locs };
}

/** @returns The sitemap's text, decompressed when it is gzipped. */
async function fetchSitemap(url: string): Promise<string> {
  traceRequest({ method: "GET", url });
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: "follow",
      headers: { accept: "application/xml, text/xml;q=0.9, */*;q=0.8" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const cause = (err as { cause?: { message?: string } })?.cause?.message ?? (err as Error)?.message;
    throw failed(`Could not fetch the sitemap at ${url}: ${plainText(String(cause))}`, "sitemap_unreachable", {
      sitemap: url,
    });
  }
  traceResponse(res.status, url);
  if (res.status === 404 || res.status === 410) {
    throw needsUser(
      `There is no sitemap at ${url} (HTTP ${res.status}). NxisAI learns which pages the site has from its ` +
        "sitemap. If the project generates one at another path, pass it: `nxis crawl submit <sitemap-url>`.",
      "sitemap_not_found",
      { sitemap: url, status: res.status },
    );
  }
  if (!res.ok) {
    throw failed(`Fetching the sitemap at ${url} failed with HTTP ${res.status}.`, "sitemap_unreachable", {
      sitemap: url,
      status: res.status,
    });
  }
  const bytes = await readCapped(res, url);
  const gzipped = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (!gzipped) return bytes.toString("utf8");
  try {
    return gunzipSync(bytes, { maxOutputLength: MAX_SITEMAP_BYTES }).toString("utf8");
  } catch (err) {
    const tooLarge = (err as { code?: string })?.code === "ERR_BUFFER_TOO_LARGE" || err instanceof RangeError;
    throw failed(
      tooLarge
        ? `${url} decompresses to more than ${MB} MB, the sitemap protocol's limit. Split it into ` +
            "smaller sitemaps listed in a sitemap index."
        : `${url} looks gzipped but could not be decompressed: ${plainText((err as Error)?.message ?? String(err))}`,
      "sitemap_invalid",
      { sitemap: url, ...(tooLarge ? { limit_bytes: MAX_SITEMAP_BYTES } : {}) },
    );
  }
}

const MB = MAX_SITEMAP_BYTES / (1024 * 1024);

/** @returns The response body, read until it ends or passes {@link MAX_SITEMAP_BYTES}. */
async function readCapped(res: Response, url: string): Promise<Buffer> {
  const tooLarge = (): Error =>
    failed(
      `${url} is larger than ${MB} MB, the sitemap protocol's limit. Split it into smaller sitemaps ` +
        "listed in a sitemap index.",
      "sitemap_invalid",
      { sitemap: url, limit_bytes: MAX_SITEMAP_BYTES },
    );
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_SITEMAP_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_SITEMAP_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

/**
 * Fetches a sitemap, following an index, and checks every page URL is on the site's host.
 *
 * @param sitemapUrl - The sitemap to check.
 * @param siteHost - The site's host, as `nxis_list_sites` reports it.
 * @returns What was checked.
 * @throws CliError `sitemap_off_host` (exit 2) listing what is on another host; `sitemap_not_found`
 * or `sitemap_empty` (exit 2); `sitemap_invalid` or `sitemap_unreachable` (exit 1).
 */
export async function checkSitemap(sitemapUrl: string, siteHost: string): Promise<SitemapCheck> {
  const offHost: OffHost[] = [];
  let offHostCount = 0;
  let urls = 0;
  let fetched = 0;
  let isIndex = false;
  const seen = new Set<string>();

  const note = (loc: string, sitemap: string): boolean => {
    const host = hostOf(loc);
    if (host === siteHost) return true;
    offHostCount++;
    if (offHost.length < LISTED) {
      offHost.push({ loc, host, sitemap, generated: generatedPlatform(host)?.platform ?? null });
    }
    return false;
  };

  const visit = async (url: string, depth: number): Promise<void> => {
    if (seen.has(url)) return;
    seen.add(url);
    if (fetched >= MAX_SITEMAPS) {
      throw failed(
        `The sitemap lists more than ${MAX_SITEMAPS} sitemaps, more than the CLI checks. ` +
          "Check that every URL in them is on the site's host, then submit a smaller sitemap.",
        "sitemap_too_large",
        { sitemap: sitemapUrl },
      );
    }
    fetched++;
    const parsed = parseSitemap(await fetchSitemap(url));
    if (!parsed) {
      throw failed(
        `${url} is not a sitemap: it has neither <urlset> nor <sitemapindex>.`,
        "sitemap_invalid",
        { sitemap: url },
      );
    }
    if (parsed.kind === "urlset") {
      for (const loc of parsed.locs) {
        urls++;
        note(loc, url);
      }
      return;
    }
    if (url === sitemapUrl) isIndex = true;
    if (depth >= MAX_DEPTH) {
      throw failed(`${url} nests sitemap indexes more than ${MAX_DEPTH} deep.`, "sitemap_invalid", { sitemap: url });
    }
    for (const loc of parsed.locs) {
      // A child sitemap on another host is the same defect as a page on one; it is not fetched.
      if (note(loc, url)) await visit(loc, depth + 1);
    }
  };

  await visit(sitemapUrl, 1);

  if (offHostCount > 0) throw offHostError(sitemapUrl, siteHost, offHost, offHostCount);
  if (urls === 0) {
    throw needsUser(
      `The sitemap at ${sitemapUrl} lists no pages, so a crawl would find nothing. Check the project ` +
        "generates it with the site's pages, deploy, then crawl.",
      "sitemap_empty",
      { sitemap: sitemapUrl },
    );
  }
  return { sitemap: sitemapUrl, host: siteHost, is_index: isIndex, sitemaps_checked: fetched, urls_checked: urls };
}

/** The failure for a sitemap that names another host, explaining a generated one. */
function offHostError(sitemap: string, siteHost: string, listed: OffHost[], count: number): Error {
  const hosts = [...new Set(listed.map((o) => o.host ?? "(no host)"))];
  const generated = GENERATED_HOSTS.filter((g) => listed.some((o) => o.host?.endsWith(g.suffix)));
  const lines = [
    `The sitemap lists ${count} URL${count === 1 ? "" : "s"} on ${hosts.join(", ")}, not ${siteHost}. ` +
      `Every URL has to be on ${siteHost}: crawling this would put the wrong address into everything ` +
      "NxisAI extracts, and autofill bills for every page of it.",
  ];
  if (generated.length > 0) {
    const where = generated.map((g) => `${g.variables} on ${g.platform}`).join(", ");
    lines.push(
      `${generated.map((g) => `*${g.suffix}`).join(", ")} is a host the platform generates for a deploy. ` +
        `The project takes its canonical origin from a variable that holds it (${where}). ` +
        `Make the origin a constant, ${siteHost}, that an environment variable can override.`,
    );
  }
  lines.push("Fix the sitemap, deploy to production, then run `nxis crawl submit` again.");
  return needsUser(lines.join("\n"), "sitemap_off_host", {
    sitemap,
    host: siteHost,
    off_host_count: count,
    off_host: listed,
  });
}
