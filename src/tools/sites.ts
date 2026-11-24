/**
 * Turning what a person types for a site into what the endpoints take.
 *
 * @remarks
 * `--site` and `nxis sites use` accept an id or a domain, because a domain is what people know.
 * The provisioning tools take only the id. And the read tools are not on the provisioning endpoint
 * at all, but on the site's own MCP endpoint, whose URL only the provisioning endpoint knows. Both
 * answers come from `nxis_list_sites`, so both are here.
 */

import { PRODUCTION_ENDPOINTS } from "../config.js";
import type { Ctx } from "../context.js";
import { requireSite } from "../context.js";
import { needsUser } from "../errors.js";
import type { ToolCaller } from "./define.js";
import { listSites, type SiteSummary } from "./provisioning.js";

/** Overrides the site's MCP URL, for a local stack where the site's own host does not resolve. */
export const SITE_MCP_URL_ENV = "NXIS_SITE_MCP_URL";

/**
 * Whether a value names a site by id rather than by domain.
 *
 * @remarks
 * A host has a dot (`example.com`), a port (`localhost:3000`) or a scheme or path when pasted as a
 * URL, or is `localhost`. A site id has none of these. Anything else is taken as an id and sent as
 * it is, so the endpoint's own error applies if it is wrong.
 */
export function looksLikeSiteId(value: string): boolean {
  const v = value.trim();
  return v.length > 0 && !/[.:/]/.test(v) && v.toLowerCase() !== "localhost";
}

/**
 * A domain or URL reduced to the host `nxis_list_sites` reports.
 *
 * @remarks
 * The same reduction the server applies to each site's domain: lowercase, without scheme,
 * credentials, port, path, query or a trailing dot. `www.` is kept, because the server keeps it.
 *
 * @returns The host, or null when nothing is left.
 */
export function hostOf(value: string): string | null {
  const noScheme = value.trim().replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "");
  const authority = noScheme.split(/[/?#]/, 1)[0] ?? "";
  const noUser = authority.slice(authority.lastIndexOf("@") + 1);
  const host = (noUser.split(":", 1)[0] ?? "").toLowerCase().replace(/\.$/, "");
  return host || null;
}

/** @returns The organization's sites, up to the endpoint's maximum. */
async function sitesOf(ctx: Ctx, client: ToolCaller | undefined): Promise<SiteSummary[]> {
  const out = await listSites.run(ctx, { limit: 500 }, client ? { provisioning: client } : {});
  return out.data?.sites ?? [];
}

/** How {@link matchSite} found a site. */
export type SiteMatch = "id" | "host" | "www";

/** @returns The host without a leading `www.`. */
function apexOf(host: string): string {
  return host.startsWith("www.") ? host.slice(4) : host;
}

/**
 * Picks one site out of a list by id or domain.
 *
 * @remarks
 * An id must match exactly. A domain is reduced with {@link hostOf} and matched against each
 * site's `host`, exactly first. Only when no site has that exact host is a leading `www.` ignored
 * on both sides, so `www.example.com` finds a site created as `example.com` and the other way
 * round, reported as `www` so the caller can say so. The exact match always wins: an
 * organization with both `example.com` and `www.example.com` gets the one that was typed.
 *
 * @param sites - The organization's sites, from `nxis_list_sites`.
 * @param value - A site id, a domain, or a URL on the site.
 * @returns The site and how it matched.
 * @throws CliError `site_not_found` (exit 2) when no site matches; `site_ambiguous` (exit 2) when
 * more than one does, with every candidate's id and host.
 */
export function matchSite(sites: SiteSummary[], value: string): { site: SiteSummary; match: SiteMatch } {
  if (looksLikeSiteId(value)) {
    const byId = sites.find((s) => s.site === value.trim());
    if (byId) return { site: byId, match: "id" };
    throw needsUser(`No site with id ${value} in this organization. \`nxis sites list\` shows them.`, "site_not_found", {
      site: value,
    });
  }
  const host = hostOf(value);
  const exact = sites.filter((s) => s.host && s.host === host);
  const loose = exact.length > 0 || !host ? [] : sites.filter((s) => s.host && apexOf(s.host) === apexOf(host));
  const matches = exact.length > 0 ? exact : loose;
  if (matches.length === 1) return { site: matches[0] as SiteSummary, match: exact.length > 0 ? "host" : "www" };
  if (matches.length > 1) {
    throw needsUser(
      `More than one site matches ${host}: ${matches.map((s) => `${s.host} (${s.site})`).join(", ")}. ` +
        "Pass the id instead.",
      "site_ambiguous",
      { host, sites: matches.map((s) => s.site), candidates: matches.map((s) => ({ site: s.site, host: s.host })) },
    );
  }
  throw needsUser(
    `No site for ${host ?? value} in this organization. \`nxis sites list\` shows them; ` +
      "`nxis sites create <url>` adds one.",
    "site_not_found",
    { host: host ?? value },
  );
}

/**
 * Finds one site of the organization by id or domain, as {@link matchSite} does.
 *
 * @param ctx - The command context.
 * @param value - A site id, a domain, or a URL on the site.
 * @param client - A provisioning connection to reuse.
 * @throws CliError as {@link matchSite} does.
 */
export async function findSite(ctx: Ctx, value: string, client?: ToolCaller): Promise<SiteSummary> {
  return matchSite(await sitesOf(ctx, client), value).site;
}

/**
 * The site id the provisioning tools take.
 *
 * @remarks
 * An id is returned as it is, with no call. A domain costs one `nxis_list_sites` call, which is a
 * read and so still runs under `--dry-run`.
 *
 * @param ctx - The command context.
 * @param value - A site id or domain, from `--site`, the saved site or the arguments.
 * @param client - A provisioning connection to reuse.
 * @throws CliError as {@link findSite} does.
 */
export async function resolveSiteId(ctx: Ctx, value: string, client?: ToolCaller): Promise<string> {
  if (looksLikeSiteId(value)) return value.trim();
  const site = await findSite(ctx, value, client);
  return site.site as string;
}

/**
 * The URL of the current site's own MCP endpoint, where `nxis_list_types` and `nxis_query` run.
 *
 * @remarks
 * In order: `NXIS_SITE_MCP_URL`; else the `mcp.endpoint` that `nxis_list_sites` reports for the
 * site (`https://<host>/mcp`). When the CLI points at another stack than production (`--api`,
 * `NXIS_MCP_URL`), that host names the site's server in production, so the read goes to the
 * stack's own route for it instead: `<mcp base>/tenant/<host>/mcp` (see {@link stackMcpUrl}).
 * The CLI sends no key to it, so the site's MCP server has to be enabled and
 * public: a site's own endpoint names a host the CLI did not choose, and the provisioning key is
 * not sent anywhere but the provisioning endpoint.
 *
 * @param ctx - The command context; the site is `--site` or the saved one.
 * @param opts - A provisioning connection to reuse.
 * @throws CliError `no_active_site` (exit 2); `site_not_found` (exit 2); `site_mcp_off` (exit 2)
 * when the site's MCP server has never been set up; `site_mcp_not_public` (exit 2) when it
 * is not public.
 */
export async function siteMcpUrl(ctx: Ctx, opts: { provisioning?: ToolCaller } = {}): Promise<string> {
  const override = process.env[SITE_MCP_URL_ENV]?.trim();
  if (override) return override;

  const site = await findSite(ctx, requireSite(ctx), opts.provisioning);
  const mcp = site.mcp;
  const name = site.host ?? site.domain ?? site.site;
  if (!mcp?.endpoint) {
    throw needsUser(
      `${name} has no MCP server yet. Turn it on with \`nxis mcp public on\`, then try again.`,
      "site_mcp_off",
      { site: site.site },
    );
  }
  if (!mcp.is_public) {
    throw needsUser(
      `${name}'s MCP server is not public, so it cannot be read without a key. ` +
        "Make it public with `nxis mcp public on`, then try again.",
      "site_mcp_not_public",
      { site: site.site, endpoint: mcp.endpoint },
    );
  }
  return stackMcpUrl(ctx.config.endpoints.mcp, mcp.endpoint);
}

/**
 * A site's MCP endpoint, on the stack the CLI points at.
 *
 * @remarks
 * Against production, the endpoint as reported. Against another stack, a site's host
 * (`<name>.mcp.<domain>`) does not reach that stack, which serves each site's server at
 * `<mcp base>/tenant/<host>/mcp` instead. An endpoint already on the stack's origin is kept.
 *
 * @param mcpBase - The MCP base URL the CLI points at.
 * @param endpoint - The endpoint `nxis_list_sites` reports for the site.
 * @returns The URL to read from.
 */
export function stackMcpUrl(mcpBase: string, endpoint: string): string {
  const base = mcpBase.replace(/\/+$/, "");
  if (base === PRODUCTION_ENDPOINTS.mcp) return endpoint;
  let site: URL;
  let stack: URL;
  try {
    site = new URL(endpoint);
    stack = new URL(base);
  } catch {
    return endpoint;
  }
  if (site.origin === stack.origin) return endpoint;
  return `${base}/tenant/${site.hostname}/mcp`;
}
