/**
 * `nxis subscribe <tier>` — free activates directly, paid goes through Stripe.
 *
 * @remarks
 * The paid path is one of the two places the CLI waits on a human in a browser. Three things
 * follow from that and are deliberate:
 *
 *   • The amount and interval are stated before the link opens. Nobody should discover the
 *     price on the payment page.
 *   • A timeout is exit 2, not failure. The webhook may still land; the right next move is
 *     `nxis status`, never a second `subscribe`.
 *   • The org id is in the timeout payload, so a later status call can pick up where this
 *     left off.
 */

import { openUrl } from "../browser.js";
import { listTiers, createSubscription, getSubscription, paymentLinkUrl, LIVE_STATUSES, type Tier } from "../api/billing.js";
import type { Ctx } from "../context.js";
import { requireOrg, requireSession } from "../context.js";
import { CliError, failed, needsUser } from "../errors.js";
import { guideOf, refused, type Guide } from "../guide.js";
import { pollUntil } from "../http.js";
import { bold, formatCredits, formatInterval, formatPrice, plainText } from "../output.js";

/** Arguments for `nxis subscribe`. */
export interface SubscribeArgs {
  /** The plan. Without one, a person is offered the plans to choose from. */
  tier?: string;
  noOpen?: boolean;
  timeoutMinutes?: number;
  dev?: boolean;
}

/** What subscribing did: the `--json` result and its line for a person. */
export interface Subscribed {
  payload: Record<string, unknown>;
  human: string;
}

/**
 * Runs `nxis subscribe [<tier>]`.
 *
 * @throws CliError `missing_tier` (exit 1) with no tier and nobody to choose one; `unknown_tier`,
 * `tier_inactive` or `tier_not_purchasable` (exit 1); `payment_pending` (exit 2); `cancelled`
 * (exit 2) when the person chose no plan.
 */
export async function cmdSubscribe(ctx: Ctx, args: SubscribeArgs): Promise<void> {
  const { config, io } = ctx;
  if (!args.tier) {
    const guide = guideOf(ctx);
    if (!guide.interactive) throw new CliError("Which plan? Try `nxis plans` first.", { reason: "missing_tier" });
    const { token } = await requireSession(ctx);
    const orgId = requireOrg(ctx);
    const { guidedPlan } = await import("../guided/plan.js");
    const out = await guidedPlan(ctx, guide, { token, orgId, ...args });
    if (!out.ok) throw refused(guide, out.why, "No plan was chosen; nothing changed.", { org_id: orgId });
    io.emit(out.value.payload, () => out.value.human);
    return;
  }

  const { token } = await requireSession(ctx);
  const orgId = requireOrg(ctx);

  const tiers = await listTiers(config, token);
  const wanted = args.tier.trim().toLowerCase();
  const tier = tiers.find(
    (t) => t.tier.toLowerCase() === wanted || (t.name ?? "").toLowerCase() === wanted,
  );

  if (!tier) {
    const available = tiers.filter((t) => t.isActive).map((t) => t.tier).join(", ");
    throw failed(
      `No plan called "${args.tier}". Available: ${available || "none"}.`,
      "unknown_tier",
      { requested: args.tier },
    );
  }
  if (!tier.isActive) {
    throw failed(`The ${tier.tier} plan is not open for new subscriptions.`, "tier_inactive");
  }

  const out = await subscribeTo(ctx, orgId, tier, token, args);
  io.emit(out.payload, () => out.human);
}

/**
 * Puts the organization on a plan: a free one at once, a paid one through its payment page.
 *
 * @param guide - Sends the person to the payment page and waits, through the agent. Without one,
 * the page is announced on stderr and opened in a browser.
 * @throws CliError `tier_not_purchasable` (exit 1); `payment_pending` (exit 2) when the wait ran
 * out; and, through an agent, the guide's stop when the person declined the page.
 */
export async function subscribeTo(
  ctx: Ctx,
  orgId: string,
  tier: Tier,
  token: string,
  args: Omit<SubscribeArgs, "tier"> & { guide?: Guide },
): Promise<Subscribed> {
  return tier.paid ? payForTier(ctx, orgId, tier, token, args) : activateFree(ctx, orgId, tier, token);
}

/**
 * Activates a free plan.
 *
 * @remarks
 * Idempotent on the service: an existing subscription comes back untouched, and a previously
 * cancelled free one is reactivated in place with its quotas intact.
 */
async function activateFree(ctx: Ctx, orgId: string, tier: Tier, token: string): Promise<Subscribed> {
  const sub = await createSubscription(ctx.config, token, orgId, tier.tier);
  return {
    payload: {
      ok: true,
      status: sub?.status ?? "ACTIVE",
      tier: tier.tier,
      org_id: orgId,
      credits_milli: tier.creditsMilli,
    },
    human: `${bold(tier.name ?? tier.tier)} is active — ${formatCredits(tier.creditsMilli)} lifetime credits.`,
  };
}

/**
 * Opens the payment page for a paid plan and waits for the subscription to become active.
 *
 * @remarks
 * A timeout is not a failure: the payment may still be processing, or the person may still be
 * typing. Running `subscribe` again would open a second checkout and risk a double charge, so
 * the message says to check `nxis status` instead.
 */
async function payForTier(
  ctx: Ctx,
  orgId: string,
  tier: Tier,
  token: string,
  args: Omit<SubscribeArgs, "tier"> & { guide?: Guide },
): Promise<Subscribed> {
  const { config, io } = ctx;

  if (!tier.stripeLinkId) {
    throw failed(
      `The ${tier.tier} plan has no payment link configured, so it cannot be bought yet.`,
      "tier_not_purchasable",
      { tier: tier.tier },
    );
  }

  const url = paymentLinkUrl(tier.stripeLinkId, orgId);
  const price = `${formatPrice(tier.price)}${formatInterval(tier.interval, tier.intervalCount)}`;
  const timeoutMs = (args.timeoutMinutes ?? 15) * 60_000;
  const wait = (signal?: AbortSignal) =>
    pollUntil({
      timeoutMs,
      ...(signal ? { signal } : {}),
      attempt: async () => {
        const sub = await getSubscription(config, token, orgId).catch(() => null);
        return sub && LIVE_STATUSES.has(sub.status) ? sub : null;
      },
      onTick: (elapsed) => {
        const mins = Math.floor(elapsed / 60_000);
        if (mins > 0 && elapsed % 60_000 < 10_000) {
          io.note(`Still waiting for Stripe (${mins}m). Leave this running, or check later with \`nxis status\`.`);
        }
      },
    });

  let found;
  if (args.guide?.kind === "agent") {
    const answer = await args.guide.visit({
      message:
        `Pay for the ${plainText(tier.name ?? tier.tier)} plan: ${price}, ${formatCredits(tier.creditsMilli)} per period. ` +
        "Open the payment page and pay there; nothing you enter on it reaches the agent. This waits until the " +
        "payment clears.",
      url,
      until: wait,
    });
    if (!answer.ok) {
      throw refused(args.guide, answer.why, "The payment page was declined, so nothing was charged.", { tier: tier.tier });
    }
    found = answer.value;
  } else {
    io.note("");
    io.note(`  ${bold(tier.name ?? tier.tier)} — ${bold(price)}, ${formatCredits(tier.creditsMilli)} per period`);
    io.note(`  Pay at: ${url}`);
    io.note("");
    io.note("Card details go to Stripe only. Waiting for the payment to clear…");

    if (!args.noOpen) openUrl(url);
    found = await wait();
  }

  if (!found) {
    throw needsUser(
      `Payment hasn't come through yet. If you completed it, run \`nxis status\` in a moment — ` +
        `it may still be processing. Do not re-run subscribe, which would start a second checkout.`,
      "payment_pending",
      { org_id: orgId, tier: tier.tier, payment_url: url },
    );
  }

  return {
    payload: {
      ok: true,
      status: found.status,
      tier: tier.tier,
      org_id: orgId,
      credits_milli: tier.creditsMilli,
    },
    human: `Paid — ${bold(tier.name ?? tier.tier)} is active (${formatCredits(tier.creditsMilli)} per period).`,
  };
}
