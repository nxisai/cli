/**
 * The organization's provisioning endpoint, and the key the CLI keeps for it.
 *
 * @remarks
 * The provisioning endpoint accepts an API key and refuses a sign-in token, so the CLI mints a
 * key for its own use the first time it needs one and keeps it in the OS keychain, one per
 * environment and organization. It is never written into a project, unlike the key
 * `nxis mcp install` hands to an agent. When the endpoint refuses the stored key, because it was
 * revoked or rotated elsewhere, the CLI revokes it, forgets it and mints one more.
 *
 * A command that needs a provisioning tool does this:
 *
 * ```ts
 * const out = await withProvisioning(ctx, (client) =>
 *   client.callTool("nxis_verify_site", withSite(ctx, { mode: "token" })),
 * );
 * ```
 */

import { generateApiKey, keyEnvFor, mcpServerUrl, revokeApiKey } from "../api/apikeys.js";
import { endpointKey } from "../config.js";
import type { Ctx, Session } from "../context.js";
import { requireOrg, requireSession } from "../context.js";
import {
  clearProvisioningKey,
  loadProvisioningKey,
  preview,
  provisioningKeyAccount,
  saveProvisioningKey,
} from "../credentials.js";
import { CliError, needsUser, notAuthorized } from "../errors.js";
import { dim } from "../output.js";
import { traceNote } from "../trace.js";
import { McpClient, type KeySource, type McpEndpoint } from "./client.js";

/** The shortest time between two renewals of the key for one environment and organization. */
export const RENEWAL_INTERVAL_MS = 60_000;

/** Recorded with a revocation, so the service's audit log says why the key went. */
const REVOKE_REASON = "Refused by the provisioning endpoint; replaced by the nxis CLI.";

/** When each key was last renewed in this process, by its key-store account. */
const lastRenewal = new Map<string, number>();

/** Forgets every renewal this process made, so the next one is not limited. For tests. */
export function resetRenewalLimit(): void {
  lastRenewal.clear();
}

/**
 * The provisioning key for one organization in the configured environment.
 *
 * @remarks
 * `get` returns the stored key, or mints and stores one: that needs a signed-in session, and
 * fails with `signed_out` without one. Minting is a write, so under `--dry-run` it is withheld
 * like any other.
 *
 * `renew` is called when the endpoint refused the stored key. It revokes that key first, by its
 * stored id, then forgets it and mints another. A 401 may be transient, or come from a proxy, so
 * the refused key may still be valid; without the revocation it would stay live on the server
 * with nothing tracking it. Revoking is best effort: a key the service no longer knows counts as
 * revoked, and any other failure is noted (in the trace, and as a notice) without stopping the
 * renewal. Under `--dry-run` the revocation is withheld and the key kept.
 *
 * Renewals are limited to one a minute for each environment and organization, within a process,
 * so an endpoint that refuses every key cannot make a long-running `nxis mcp serve` mint one per
 * call. A refusal inside that minute fails with `key_refused` and leaves the stored key alone.
 *
 * `discard`, for a renewed key that was refused as well, revokes and forgets it in the same way.
 *
 * @param ctx - The command context.
 * @param orgId - The organization.
 */
export function provisioningKeySource(ctx: Ctx, orgId: string): KeySource {
  const endpoints = endpointKey(ctx.config.endpoints);
  const slot = provisioningKeyAccount(endpoints, orgId);

  const mint = async (session?: Session): Promise<string> => {
    const { token, accountId } = session ?? (await requireSession(ctx));
    const env = keyEnvFor(ctx.config);
    const issued = await generateApiKey(ctx.config, token, orgId, { env, kind: "mcp", accountId });
    const shown = issued.preview || preview(issued.rawKey);
    saveProvisioningKey({
      apiKey: issued.rawKey,
      keyId: issued.keyId,
      preview: shown,
      orgId,
      endpoints,
      env,
      createdAt: Math.floor(Date.now() / 1000),
    });
    ctx.io.note(dim(`Issued a provisioning key ${shown} for ${orgId}, kept in the keychain.`));
    return issued.rawKey;
  };

  /**
   * Revokes the stored key, best effort, and forgets it.
   *
   * @throws CliError `dry_run` when the revocation was withheld; the key is then kept.
   */
  const retire = async (token: string): Promise<void> => {
    const old = loadProvisioningKey(endpoints, orgId);
    if (old?.keyId) {
      const named = `${old.preview || "key"} (${old.keyId})`;
      try {
        const outcome = await revokeApiKey(ctx.config, token, orgId, old.keyId, REVOKE_REASON);
        traceNote(
          outcome === "revoked"
            ? `Revoked the refused provisioning key ${named}.`
            : `The refused provisioning key ${named} was already revoked, or is unknown to the service.`,
        );
      } catch (err) {
        if (err instanceof CliError && err.reason === "dry_run") throw err;
        const why = err instanceof Error ? err.message : String(err);
        traceNote(`Could not revoke the refused provisioning key ${named}: ${why}. Issuing a new one anyway.`);
        ctx.io.note(
          dim(`Could not revoke the refused provisioning key ${named}; it may still be valid on the server.`),
        );
      }
    } else if (old) {
      traceNote(`The refused provisioning key ${old.preview || ""} has no stored id, so it was not revoked.`);
    }
    clearProvisioningKey(endpoints, orgId);
  };

  return {
    get: async () => loadProvisioningKey(endpoints, orgId)?.apiKey ?? mint(),
    renew: async () => {
      const now = Date.now();
      const last = lastRenewal.get(slot);
      if (last !== undefined && now - last < RENEWAL_INTERVAL_MS) {
        const wait = Math.ceil((RENEWAL_INTERVAL_MS - (now - last)) / 1000);
        traceNote(`Not renewing the provisioning key: it was renewed ${Math.floor((now - last) / 1000)}s ago.`);
        throw notAuthorized(
          "The provisioning endpoint refused the API key, and a new one was issued less than a minute ago. " +
            `Try again in ${wait}s; if it keeps happening, run \`nxis login\`.`,
          "key_refused",
          { status: 401, retry_after_s: wait },
        );
      }
      const session = await requireSession(ctx);
      lastRenewal.set(slot, now);
      await retire(session.token);
      return mint(session);
    },
    discard: async () => {
      try {
        await retire((await requireSession(ctx)).token);
      } catch {
        clearProvisioningKey(endpoints, orgId);
      }
    },
  };
}

/**
 * The provisioning endpoint for the organization being acted on (`--org`, else the saved one).
 *
 * @remarks
 * The URL resolves as `nxis mcp install`'s does: `NXIS_MCP_URL`, else `--api`, `NXIS_API` or the
 * saved environment, else production.
 *
 * @throws CliError `no_active_org` (exit 2) when no organization is selected.
 */
export function provisioningEndpoint(ctx: Ctx): McpEndpoint {
  const orgId = requireOrg(ctx);
  return {
    url: mcpServerUrl(ctx.config, orgId),
    label: "The provisioning endpoint",
    keys: provisioningKeySource(ctx, orgId),
  };
}

/**
 * A site's own MCP endpoint.
 *
 * @remarks
 * The read tools (`nxis_list_types`, `nxis_query`) are not on the provisioning endpoint: they
 * take their tenant from the hostname they are called on, so the CLI calls them on the site's
 * endpoint instead. Resolving that URL from a site is left to the commands that need it; this is
 * where they plug it in. A public endpoint needs no key, so `keys` defaults to none.
 *
 * Called without a key, a 401 or 403 cannot mean a refused key: it means the site's MCP server is
 * not public, whatever the site's settings last said. That is `site_mcp_not_public` (exit 2),
 * the reason `siteMcpUrl` gives when the settings already say so, rather than `key_refused`.
 *
 * @param url - The site's MCP URL.
 * @param keys - The key to send, if the endpoint needs one.
 */
export function siteEndpoint(url: string, keys: KeySource | null = null): McpEndpoint {
  const endpoint: McpEndpoint = { url, label: `The site's MCP endpoint`, keys };
  if (!keys) {
    endpoint.refused = (status) =>
      needsUser(
        `The site's MCP endpoint at ${url} refused a request without a key (HTTP ${status}), so its MCP server ` +
          "is not public. Make it public with `nxis mcp public on`, then try again.",
        "site_mcp_not_public",
        { status, endpoint: url },
      );
  }
  return endpoint;
}

/** @returns A client for the provisioning endpoint. It connects on first use; close it when done. */
export function openProvisioning(ctx: Ctx): McpClient {
  return new McpClient(provisioningEndpoint(ctx));
}

/**
 * Runs `fn` with a client for the provisioning endpoint, and closes it afterwards.
 *
 * @param ctx - The command context.
 * @param fn - What to do with the client.
 * @returns What `fn` returns.
 * @throws CliError `no_active_org` (exit 2) before connecting, and whatever the client throws.
 */
export async function withProvisioning<T>(ctx: Ctx, fn: (client: McpClient) => Promise<T>): Promise<T> {
  const client = openProvisioning(ctx);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}
