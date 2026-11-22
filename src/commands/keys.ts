/**
 * `nxis keys` — site keys: an API key bound to one site and one scope, for software that runs on
 * the site's own server and needs exactly one narrow write.
 *
 * @remarks
 * The first scope is `content_gaps:report`: a key that can report the site's content gaps and
 * helpful counts and do nothing else. It can't read them, create sites, publish or spend credits,
 * so a key that leaks from a public-facing host can only write gaps for its one site.
 *
 * A new key comes back once. It is shown to the person, clearly labelled, and included in `--json`
 * because the caller asked for the result; the `--verbose` trace prints requests only and never
 * a key, so the secret is never traced. The CLI does not keep it.
 *
 * The site is checked against the organization's own sites before anything is minted, because the
 * authorization service takes the site id as given. After minting, the scopes and site the service
 * says it stored are checked too: a service that predates site keys ignores the site and would
 * hand back a key for the whole organization, so that key is revoked at once and nothing is shown.
 *
 * The routing for `nxis keys <sub>` is here too ({@link runKeys}), so `cli.ts` needs one line.
 */

import {
  generateApiKey,
  keyEnvFor,
  listApiKeys,
  revokeApiKey,
  SITE_KEY_SCOPES,
  type KeyInfo,
  type SiteKeyScope,
} from "../api/apikeys.js";
import { bool, str, type Flags } from "../args.js";
import type { Ctx } from "../context.js";
import { requireOrg, requireSession, requireSite } from "../context.js";
import { CliError, failed } from "../errors.js";
import { bold, dim } from "../output.js";
import { findSite, resolveSiteId } from "../tools/index.js";

/** Recorded with a revocation from `nxis keys revoke`. */
const REVOKE_REASON = "Revoked with nxis keys revoke.";

/** Recorded when a mint came back broader than asked for, and was revoked at once. */
const UNSCOPED_REASON = "Minted without the requested site or scope; revoked by the nxis CLI.";

/** Usage, per subcommand. */
const USAGE = {
  create: "`nxis keys create --scope content_gaps:report [--site <id|domain>]`",
  list: "`nxis keys list [--site <id|domain>] [--all]`",
  revoke: "`nxis keys revoke <key-id>`",
} as const;

/**
 * Dispatches `nxis keys <sub> …`.
 *
 * @throws CliError `unknown_command` for a subcommand that does not exist, `missing_key_id` for
 * `revoke` with no id, and whatever the subcommand throws.
 */
export async function runKeys(ctx: Ctx, args: string[], flags: Flags): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "create": {
      const scope = str(flags, "scope");
      await cmdKeysCreate(ctx, scope !== undefined ? { scope } : {});
      return;
    }
    case "list":
      await cmdKeysList(ctx, { all: bool(flags, "all") });
      return;
    case "revoke": {
      const keyId = rest[0];
      if (!keyId) throw failed(`Which key? ${USAGE.revoke}; \`nxis keys list\` shows the ids.`, "missing_key_id");
      await cmdKeysRevoke(ctx, keyId);
      return;
    }
    default:
      throw new CliError(`Try ${USAGE.create}, ${USAGE.list} or ${USAGE.revoke}.`, { reason: "unknown_command" });
  }
}

/** Arguments for `nxis keys create`. */
export interface KeysCreateArgs {
  scope?: string;
}

/**
 * Runs `nxis keys create`: mints a key for the current site, limited to one scope.
 *
 * @throws CliError `missing_scope` or `unknown_scope` (exit 1, before anything is sent);
 * `no_active_site`, `site_not_found` or `site_ambiguous` (exit 2); `site_keys_unsupported`
 * (exit 1) when the service minted a broader key than asked for, which is then revoked; and
 * whatever signing in and minting throw, `dry_run` included.
 */
export async function cmdKeysCreate(ctx: Ctx, args: KeysCreateArgs): Promise<void> {
  const scope = checkScope(args.scope);
  const orgId = requireOrg(ctx);
  const { token, accountId } = await requireSession(ctx);

  // The service binds whatever id it is given, so confirm the site is this organization's first.
  const summary = await findSite(ctx, requireSite(ctx));
  const site = summary.site as string;
  const env = keyEnvFor(ctx.config);

  const key = await generateApiKey(ctx.config, token, orgId, { env, kind: "mcp", accountId, scopes: [scope], site });

  if (key.site !== site || !key.scopes.includes(scope)) {
    // Never shown: a key for the whole organization must not reach a site's server by mistake.
    const outcome = await revokeApiKey(ctx.config, token, orgId, key.keyId, UNSCOPED_REASON).catch(() => "failed" as const);
    throw failed(
      "The authorization service doesn't support site keys yet: it minted a key for the whole " +
        (outcome === "failed"
          ? `organization, and revoking it failed. Revoke it with \`nxis keys revoke ${key.keyId}\`.`
          : "organization, which has been revoked. Nothing was shown."),
      "site_keys_unsupported",
      { key_id: key.keyId, revoked: outcome !== "failed", org_id: orgId, site },
    );
  }

  const host = summary.host ?? summary.domain ?? null;
  ctx.io.emit(
    {
      ok: true,
      api_key: key.rawKey,
      key_id: key.keyId,
      preview: key.preview,
      scopes: key.scopes,
      site,
      domain: host,
      org_id: orgId,
      env,
    },
    () =>
      [
        `Created a ${bold(scope)} key for ${bold(host ?? site)} (${site}).`,
        dim(`  It can do nothing else. ${env === "dev" ? "A dev key, not a live one. " : ""}Id ${key.keyId}.`),
        "",
        bold("Site key (shown once; it is not shown again and the CLI does not keep it):"),
        `  ${key.rawKey}`,
        "",
        "Store it in the site server's secrets. If it leaks, run `nxis keys revoke " + key.keyId + "` and create another.",
      ].join("\n"),
  );
}

/**
 * @returns The scope, when it is one a site key can have.
 * @throws CliError `missing_scope` or `unknown_scope`.
 */
function checkScope(scope: string | undefined): SiteKeyScope {
  const scopes = SITE_KEY_SCOPES.join(", ");
  if (!scope?.trim()) throw failed(`Which scope? ${USAGE.create}. Scopes: ${scopes}.`, "missing_scope", { scopes: [...SITE_KEY_SCOPES] });
  const trimmed = scope.trim();
  if (!(SITE_KEY_SCOPES as readonly string[]).includes(trimmed)) {
    throw failed(`\`${trimmed}\` is not a site key scope. Use one of: ${scopes}.`, "unknown_scope", {
      scope: trimmed,
      scopes: [...SITE_KEY_SCOPES],
    });
  }
  return trimmed as SiteKeyScope;
}

/** Arguments for `nxis keys list`. */
export interface KeysListArgs {
  /** Include revoked keys. */
  all?: boolean;
}

/**
 * Runs `nxis keys list`: the current site's keys that the signed-in account minted.
 *
 * @throws CliError `no_active_site`, `site_not_found` (exit 2), and whatever listing throws.
 */
export async function cmdKeysList(ctx: Ctx, args: KeysListArgs = {}): Promise<void> {
  const orgId = requireOrg(ctx);
  const { token, accountId } = await requireSession(ctx);
  const site = await resolveSiteId(ctx, requireSite(ctx));
  const keys = await listApiKeys(ctx.config, token, orgId, { accountId, site, includeRevoked: args.all === true });

  ctx.io.emit(
    { ok: true, site, org_id: orgId, count: keys.length, keys: keys.map(keyJson) },
    () =>
      keys.length === 0
        ? `No ${args.all ? "" : "active "}keys for site ${site}. ${USAGE.create} makes one.`
        : [
            `Keys for site ${site}${args.all ? ", revoked included" : ""}:`,
            ...keys.map(
              (k) =>
                `  ${k.keyId}  ${k.preview}  ${k.scopes.join(",") || dim("no scopes")}  ` +
                `${dim(`created ${date(k.createdAt)}, last used ${date(k.lastUsedAt)}`)}` +
                (k.revokedAt ? `  ${dim(`revoked ${date(k.revokedAt)}`)}` : ""),
            ),
          ].join("\n"),
  );
}

/** A listed key as `--json` reports it. */
function keyJson(k: KeyInfo): Record<string, unknown> {
  return {
    key_id: k.keyId,
    preview: k.preview,
    scopes: k.scopes,
    site: k.site,
    env: k.env,
    kind: k.kind,
    created_at: k.createdAt,
    last_used_at: k.lastUsedAt,
    revoked_at: k.revokedAt,
    revoked: k.revokedAt !== null,
  };
}

/** @returns An epoch-seconds time as a date, or "never". */
function date(epochSeconds: number | null): string {
  return epochSeconds ? new Date(epochSeconds * 1000).toISOString().slice(0, 10) : "never";
}

/**
 * Runs `nxis keys revoke <key-id>`.
 *
 * @remarks
 * The service refuses a key of another organization as if it did not exist, so this can only
 * revoke the organization's own keys. A key that is unknown or already revoked is already in the
 * state asked for: `revoked: false` with `outcome: "already_gone"`, exit 0. Revoking takes effect
 * on the key's next use.
 */
export async function cmdKeysRevoke(ctx: Ctx, keyId: string): Promise<void> {
  const orgId = requireOrg(ctx);
  const { token } = await requireSession(ctx);
  const outcome = await revokeApiKey(ctx.config, token, orgId, keyId.trim(), REVOKE_REASON);
  ctx.io.emit(
    { ok: true, key_id: keyId.trim(), org_id: orgId, revoked: outcome === "revoked", outcome },
    () =>
      outcome === "revoked"
        ? `Revoked ${keyId.trim()}. It stops working on its next use.`
        : `${keyId.trim()} was already revoked, or isn't a key of this organization. Nothing changed.`,
  );
}
