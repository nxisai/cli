/**
 * What every command needs: where to point, how to talk, and who is talking.
 */

import { getAccessToken } from "./auth.js";
import type { Config } from "./config.js";
import type { Guide } from "./guide.js";
import { notAuthorized, needsUser } from "./errors.js";
import type { Io } from "./output.js";
import { loadSettings } from "./state.js";
import { accountIdFromClaims, decodeJwt, emailFromClaims } from "./tokens.js";

/** The context passed to every command. */
export interface Ctx {
  config: Config;
  io: Io;
  /** --org, when given, overrides the saved active organization. */
  orgOverride?: string;
  /** --site, when given, overrides the saved active site. An id or a domain. */
  siteOverride?: string;
  /**
   * How to put a decision to the user. `nxis mcp serve` sets it to ask through the agent (or to
   * nobody, when the client cannot be asked); unset, a command asks on the terminal, when there is one.
   */
  guide?: Guide;
}

/** A signed-in user. */
export interface Session {
  token: string;
  accountId: string;
  email: string | null;
}

/**
 * A signed-in session.
 *
 * @remarks
 * The account id comes from a custom claim added at sign-in. When a brand-new user signs in,
 * that claim can be missing from the very first token, because the account is created during
 * the login. `login` refreshes once to pick it up; by the time any other command runs, a missing
 * claim is reported rather than retried.
 *
 * @throws CliError `signed_out`, `session_expired` or `no_account_claim` (exit 3).
 */
export async function requireSession(ctx: Ctx): Promise<Session> {
  const token = await getAccessToken(ctx.config);
  const claims = decodeJwt(token);
  const accountId = accountIdFromClaims(claims);
  if (!accountId) {
    throw notAuthorized(
      "Signed in, but no NxisAI account is attached to this login. Run `nxis login` again; " +
        "if this keeps happening, contact NxisAI support.",
      "no_account_claim",
    );
  }
  return { token, accountId, email: emailFromClaims(claims) };
}

/** The organization to act on: `--org`, else the saved one, else ask the caller to pick. */
export function requireOrg(ctx: Ctx): string {
  const org = ctx.orgOverride ?? loadSettings().activeOrg;
  if (!org) {
    throw needsUser(
      "No organization selected. Run `nxis orgs create --name \"…\"` or `nxis orgs use <id>`.",
      "no_active_org",
    );
  }
  return org;
}

/** The organization to act on, or null when none is selected. */
export function currentOrg(ctx: Ctx): string | null {
  return ctx.orgOverride ?? loadSettings().activeOrg ?? null;
}

/**
 * The site to act on, or null when none is selected.
 *
 * @remarks
 * `--site` wins. Otherwise the saved site, but only when it belongs to the organization being
 * acted on: with `--org` pointing elsewhere, the saved site belongs to another organization and
 * is not used. The value is passed as the provisioning tools' `site` argument, which takes an id
 * or a domain.
 */
export function currentSite(ctx: Ctx): string | null {
  if (ctx.siteOverride) return ctx.siteOverride;
  const saved = loadSettings().activeSite;
  if (!saved) return null;
  return saved.orgId === currentOrg(ctx) ? saved.id : null;
}

/**
 * The site to act on: `--site`, else the saved one, else ask the caller to pick.
 *
 * @throws CliError `no_active_site` (exit 2) when none is selected.
 */
export function requireSite(ctx: Ctx): string {
  const site = currentSite(ctx);
  if (!site) {
    throw needsUser(
      "No site selected. Run `nxis sites create <url>` or `nxis sites use <id|domain>`, or pass --site.",
      "no_active_site",
    );
  }
  return site;
}

/**
 * Tool arguments with `site` filled in from `--site` or the saved site.
 *
 * @remarks
 * The provisioning tools that act on a site take an optional `site` argument. An explicit
 * `site` in the arguments wins; otherwise the current site is added when there is one, and left
 * out when there is not, so the endpoint's own default (or its error) applies. With `required`,
 * a missing site is the caller's to resolve before anything is sent.
 *
 * @param ctx - The command context.
 * @param args - The tool arguments.
 * @param opts - `required` throws `no_active_site` rather than leaving `site` out.
 * @returns A copy of the arguments.
 */
export function withSite<T extends Record<string, unknown>>(
  ctx: Ctx,
  args: T,
  opts: { required?: boolean } = {},
): T & { site?: string } {
  if (typeof args["site"] === "string" && args["site"]) return { ...args };
  const site = opts.required ? requireSite(ctx) : currentSite(ctx);
  return site ? { ...args, site } : { ...args };
}
