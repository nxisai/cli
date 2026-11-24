/**
 * `nxis signup` — the whole first run, up to the point where a choice is required.
 *
 * @remarks
 * It does every step that needs no decision, then stops and reports what it needs. It deliberately
 * never picks a plan: choosing is enumerated consent, and "set me up" is not consent to be
 * charged.
 *
 * Stopping is signalled with exit 2 and a `reason`, so an agent can tell "your turn" from
 * "this broke" without reading prose.
 */

import { tryGetAccessToken } from "../auth.js";
import { listOrganizations } from "../api/accounts.js";
import { listTiers, sellableTiers, getSubscription, LIVE_STATUSES } from "../api/billing.js";
import type { Ctx } from "../context.js";
import { currentOrg } from "../context.js";
import { needsUser } from "../errors.js";
import { formatCredits, formatInterval, formatPrice } from "../output.js";
import { accountIdFromClaims, decodeJwt } from "../tokens.js";
import { updateSettings } from "../state.js";
import { cmdOrgsCreate } from "./orgs.js";
import { guideOf } from "../guide.js";
import { guidedPlan } from "../guided/plan.js";

/** Arguments for `nxis signup`. */
export interface SignupArgs {
  name?: string;
  website?: string;
  dev?: boolean;
}

/**
 * Runs `nxis signup`.
 *
 * @remarks
 * An existing organization is reused rather than creating another. An organization already on
 * a plan only needs `mcp install`. Otherwise, on a terminal, it offers the plans to choose from
 * (price, interval and credit grant) and subscribes to the one chosen; anywhere else, or when
 * none is chosen, it stops with `choose_plan` and three options:
 * the free plan, the free plan plus a credit top-up (two commands, because a top-up needs an
 * active plan), and the cheapest paid plan.
 *
 * @throws CliError `sign_in_required`, `org_name_required`, `no_active_org` or `choose_plan`
 * (exit 2).
 */
export async function cmdSignup(ctx: Ctx, args: SignupArgs): Promise<void> {
  const { config, io } = ctx;

  const token = await tryGetAccessToken(config);
  const accountId = accountIdFromClaims(token ? decodeJwt(token) : null);

  if (!token || !accountId) {
    throw needsUser(
      "You need to sign in first: run `nxis login`. It prints a URL and a short code to enter " +
        "in your browser.",
      "sign_in_required",
    );
  }

  let orgId = currentOrg(ctx);
  if (!orgId) {
    const existing = await listOrganizations(config, token, accountId);
    const first = existing[0];
    if (first) {
      orgId = first.id;
      updateSettings({ activeOrg: first.id });
    } else if (args.name) {
      await cmdOrgsCreate(ctx, {
        name: args.name,
        ...(args.website ? { website: args.website } : {}),
      });
      orgId = currentOrg(ctx);
    } else {
      throw needsUser(
        "What should the organization be called? Run `nxis orgs create --name \"Your Company\"`.",
        "org_name_required",
      );
    }
  }

  if (!orgId) {
    throw needsUser("No organization is selected.", "no_active_org");
  }

  const sub = await getSubscription(config, token, orgId).catch(() => null);
  if (sub && LIVE_STATUSES.has(sub.status)) {
    io.emit(
      { ok: true, org_id: orgId, subscription: { status: sub.status, tier: sub.tier }, next: "mcp install" },
      () => `You're on ${sub.tier ?? "a plan"} already. Next: \`nxis mcp install\`.`,
    );
    return;
  }

  const dev = args.dev ?? process.env.NXIS_DEV_MODE === "true";
  const tiers = sellableTiers(await listTiers(config, token), { dev });
  const free = tiers.find((t) => !t.paid);
  const cheapestPaid = tiers.find((t) => t.paid);

  const options = [
    free && {
      choice: 1,
      label: `${free.name ?? free.tier} — free, ${formatCredits(free.creditsMilli)} lifetime`,
      run: `nxis subscribe ${free.tier.toLowerCase()}`,
    },
    free && {
      choice: 2,
      label: `${free.name ?? free.tier} plus a credit top-up`,
      run: `nxis subscribe ${free.tier.toLowerCase()} && nxis credits buy <sku>`,
    },
    cheapestPaid && {
      choice: 3,
      label:
        `${cheapestPaid.name ?? cheapestPaid.tier} — ${formatPrice(cheapestPaid.price)}` +
        `${formatInterval(cheapestPaid.interval, cheapestPaid.intervalCount)}, ` +
        `${formatCredits(cheapestPaid.creditsMilli)} per period`,
      run: `nxis subscribe ${cheapestPaid.tier.toLowerCase()}`,
    },
  ].filter(Boolean) as Array<{ choice: number; label: string; run: string }>;

  const choosePlan = {
    org_id: orgId,
    dev_mode: dev,
    options,
    plans: tiers.map((t) => ({
      tier: t.tier,
      name: t.name,
      price: t.price,
      credits_milli: t.creditsMilli,
      paid: t.paid,
    })),
  };

  // On a terminal, the choice is offered here; anywhere else, the options are the answer.
  const guide = guideOf(ctx);
  if (guide.interactive && tiers.length > 0) {
    const out = await guidedPlan(ctx, guide, { token, orgId, dev, plans: tiers });
    if (out.ok) {
      io.emit({ ...out.value.payload, next: "mcp install" }, () => `${out.value.human}\nNext: \`nxis mcp install\`.`);
      return;
    }
    throw needsUser("No plan was chosen; nothing changed. Pick one to continue.", "choose_plan", choosePlan);
  }
  throw needsUser("Pick a plan to continue.", "choose_plan", choosePlan);
}
