/**
 * Authorization API: minting the MCP key, minting and listing site keys, and revoking one.
 *
 * @remarks
 * The raw key comes back exactly once and is never stored by the service. The CLI writes it
 * straight into the agent's config and reports only a preview, so the secret never passes
 * through an agent transcript — `--print` is the deliberate exception, for someone wiring a
 * client by hand.
 */

import type { Config } from "../config.js";
import { CliError } from "../errors.js";
import { request } from "../http.js";
import { num, str } from "./shapes.js";

/** live | test | dev. A dev key reads as `nxis_dev_mcp_…` and can't be mistaken for a live one. */
export type KeyEnv = "live" | "test" | "dev";
/** The kind of key to issue. */
export type KeyKind = "pk" | "sk" | "ssr" | "pat" | "mcp";

/**
 * Scopes a site key can be limited to.
 *
 * @remarks
 * A key minted with one of these can do nothing else: every surface that does not ask for the
 * scope refuses it. `content_gaps:report` reports a site's content gaps and helpful counts.
 */
export const SITE_KEY_SCOPES = ["content_gaps:report"] as const;
/** One of {@link SITE_KEY_SCOPES}. */
export type SiteKeyScope = (typeof SITE_KEY_SCOPES)[number];

/** A newly issued key. `rawKey` is the secret and is returned only once. */
export interface IssuedKey {
  rawKey: string;
  keyId: string;
  preview: string;
  /** The scopes the service says it stored; empty for an org-wide key, or from an older service. */
  scopes: string[];
  /** The site the service says it bound the key to; empty for an org-wide key, or from an older service. */
  site: string;
}

/** A stored key as listed: never the secret. */
export interface KeyInfo {
  keyId: string;
  preview: string;
  env: string;
  kind: string;
  scopes: string[];
  /** The site the key is bound to; null for an org-wide key. */
  site: string | null;
  /** Epoch seconds. */
  createdAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

/**
 * Issues an API key for an organization.
 *
 * @throws Error when the service returns no key value.
 */
export async function generateApiKey(
  config: Config,
  token: string,
  orgId: string,
  opts: { env: KeyEnv; kind: KeyKind; accountId: string; scopes?: string[]; site?: string },
): Promise<IssuedKey> {
  const raw = await request<Record<string, unknown>>(
    `${config.endpoints.authorization}/v1/organizations/${encodeURIComponent(orgId)}/apikeys`,
    {
      method: "POST",
      token,
      body: {
        parent: `organizations/${orgId}`,
        env: opts.env,
        kind: opts.kind,
        account_id: opts.accountId,
        scopes: opts.scopes ?? [],
        // Only when asked for: an org-wide mint sends exactly what it always has.
        ...(opts.site ? { site: opts.site } : {}),
      },
    },
  );

  const rawKey = str(raw?.["raw_key"]);
  if (!rawKey) {
    throw new Error("The authorization service issued a key but returned no value for it.");
  }
  return {
    rawKey,
    keyId: str(raw?.["key_id"]) ?? "",
    preview: str(raw?.["preview"]) ?? "",
    scopes: strings(raw?.["scopes"]),
    site: str(raw?.["site"]) ?? "",
  };
}

/** @returns The strings in a JSON array, or none. */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Lists the signed-in account's keys in an organization.
 *
 * @remarks
 * Only the account's own keys: the service lists by account and organization. With `site`, the
 * service returns only keys bound to it, and the result is filtered here as well, so a service
 * that ignores the filter yields no keys rather than every org-wide key.
 *
 * @param opts - `site` to list one site's keys; `includeRevoked` to include revoked ones.
 * @throws CliError as {@link request} maps a failure.
 */
export async function listApiKeys(
  config: Config,
  token: string,
  orgId: string,
  opts: { accountId: string; site?: string; includeRevoked?: boolean },
): Promise<KeyInfo[]> {
  const query = new URLSearchParams({ account_id: opts.accountId });
  if (opts.includeRevoked) query.set("include_revoked", "true");
  if (opts.site) query.set("site", opts.site);
  const raw = await request<Record<string, unknown>>(
    `${config.endpoints.authorization}/v1/organizations/${encodeURIComponent(orgId)}/apikeys:byAccountAndOrg?${query}`,
    { token },
  );
  const keys = Array.isArray(raw?.["keys"]) ? (raw?.["keys"] as Record<string, unknown>[]) : [];
  return keys
    .map(
      (k): KeyInfo => ({
        keyId: str(k["key_id"]) ?? "",
        preview: str(k["preview"]) ?? "",
        env: str(k["env"]) ?? "",
        kind: str(k["kind"]) ?? "",
        scopes: strings(k["scopes"]),
        site: str(k["site"]) || null,
        createdAt: num(k["created_at"]),
        lastUsedAt: num(k["last_used_at"]),
        revokedAt: num(k["revoked_at"]),
      }),
    )
    .filter((k) => !opts.site || k.site === opts.site);
}

/** What revoking a key came to: revoked now, or already gone (unknown, or revoked before). */
export type RevokeOutcome = "revoked" | "already_gone";

/**
 * Revokes an API key of an organization by its id.
 *
 * @remarks
 * A key the service does not know (404), or has already revoked (refused as a failed
 * precondition), is already in the state asked for, so both count as done rather than failing.
 * The service answers 404 for another organization's key too, so this can never revoke one.
 *
 * @param reason - Recorded with the revocation.
 * @throws CliError for any other failure, as {@link request} maps it.
 */
export async function revokeApiKey(
  config: Config,
  token: string,
  orgId: string,
  keyId: string,
  reason: string,
): Promise<RevokeOutcome> {
  const org = encodeURIComponent(orgId);
  try {
    await request(`${config.endpoints.authorization}/v1/organizations/${org}/apikeys/${encodeURIComponent(keyId)}:revoke`, {
      method: "POST",
      token,
      body: { parent: `organizations/${orgId}`, key_id: keyId, reason },
    });
    return "revoked";
  } catch (err) {
    if (err instanceof CliError && err.reason === "request_failed") {
      const status = err.details["status"];
      if (status === 404) return "already_gone";
      if ((status === 400 || status === 409) && /already revoked/i.test(err.message)) return "already_gone";
    }
    throw err;
  }
}

/**
 * Which key environment suits the target.
 *
 * @remarks
 * Non-production environments get `dev` keys, so a test run can never leave a live credential
 * in an agent's config file.
 */
export function keyEnvFor(config: Config): KeyEnv {
  return config.isProduction ? "live" : "dev";
}

/** The MCP server URL an agent will be pointed at. */
export function mcpServerUrl(config: Config, orgId: string): string {
  return `${config.endpoints.mcp}/v1/organizations/${encodeURIComponent(orgId)}/mcp`;
}
