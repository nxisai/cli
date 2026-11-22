/**
 * `nxis status` — the one call that tells an agent which steps to skip.
 *
 * @remarks
 * This never throws for "not signed in" or "no organization". Those are answers, not errors:
 * the whole point is that an agent can ask where the user is before deciding what to do, and
 * a returning user may need nothing but `mcp install`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tryGetAccessToken } from "../auth.js";
import { SERVER_NAME } from "../agents.js";
import { listOrganizations } from "../api/accounts.js";
import { getCredits, getSubscription, LIVE_STATUSES } from "../api/billing.js";
import type { Ctx } from "../context.js";
import { currentOrg, currentSite } from "../context.js";
import { formatCredits } from "../output.js";
import { accountIdFromClaims, decodeJwt, emailFromClaims } from "../tokens.js";

/** Runs `nxis status`. */
export async function cmdStatus(ctx: Ctx): Promise<void> {
  const { config, io } = ctx;

  const token = await tryGetAccessToken(config);
  const claims = token ? decodeJwt(token) : null;
  const accountId = accountIdFromClaims(claims);

  const state: Record<string, unknown> = {
    ok: true,
    signed_in: Boolean(token && accountId),
    account_id: accountId,
    email: emailFromClaims(claims),
    profile: config.profile,
    api: config.endpoints.billing,
    orgs: [],
    active_org: currentOrg(ctx),
    // The saved value only; it is not checked against the provisioning endpoint here.
    active_site: currentSite(ctx),
    subscription: null,
    credits: null,
    mcp_installed: mcpInstalled(),
  };

  if (token && accountId) {
    const orgs = await listOrganizations(config, token, accountId).catch(() => []);
    state["orgs"] = orgs.map((o) => ({ id: o.id, name: o.name, onboarded: o.onboarded }));

    const active = currentOrg(ctx) ?? orgs[0]?.id ?? null;
    state["active_org"] = active;

    if (active) {
      const sub = await getSubscription(config, token, active).catch(() => null);
      state["subscription"] = sub
        ? { status: sub.status, tier: sub.tier, live: LIVE_STATUSES.has(sub.status) }
        : null;

      const credits = await getCredits(config, token, active).catch(() => null);
      state["credits"] = credits
        ? {
            remaining_milli: credits.limitMilli + credits.topupMilli - credits.usageMilli,
            limit_milli: credits.limitMilli,
            usage_milli: credits.usageMilli,
            topup_milli: credits.topupMilli,
            lifetime: credits.lifetime,
          }
        : null;
    }
  }

  io.emit(state, () => renderHuman(state));
}

/** Whether this project's `.mcp.json` already has the NxisAI MCP server. */
function mcpInstalled(): boolean {
  const path = join(process.cwd(), ".mcp.json");
  if (!existsSync(path)) return false;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const servers = (parsed as Record<string, unknown> | null)?.["mcpServers"];
    return Boolean(servers && typeof servers === "object" && SERVER_NAME in (servers as object));
  } catch {
    return false;
  }
}

/** Renders the status for a person. */
function renderHuman(state: Record<string, unknown>): string {
  const lines: string[] = [];
  if (!state["signed_in"]) {
    lines.push("Not signed in. Run `nxis login`.");
    return lines.join("\n");
  }
  lines.push(`Signed in as ${state["email"] ?? state["account_id"]}`);

  const orgs = state["orgs"] as Array<{ id: string; name: string | null }>;
  if (orgs.length === 0) {
    lines.push("No organization yet. Run `nxis orgs create --name \"…\"`.");
  } else {
    const active = state["active_org"];
    for (const org of orgs) {
      const marker = org.id === active ? "*" : " ";
      lines.push(`${marker} ${org.name ?? "(unnamed)"}  ${org.id}`);
    }
  }

  const site = state["active_site"];
  lines.push(site ? `Site: ${site}` : "Site: none selected");

  const sub = state["subscription"] as { status: string; tier: string | null } | null;
  lines.push(sub ? `Plan: ${sub.tier ?? "unknown"} (${sub.status})` : "Plan: none yet");

  const credits = state["credits"] as { remaining_milli: number; lifetime: boolean } | null;
  if (credits) {
    lines.push(`Credits: ${formatCredits(credits.remaining_milli)}${credits.lifetime ? " (lifetime)" : ""}`);
  }

  lines.push(state["mcp_installed"] ? "MCP: configured in this project" : "MCP: not installed here");
  return lines.join("\n");
}
