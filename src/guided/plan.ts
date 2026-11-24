/**
 * Choosing a plan, instead of stopping with `choose_plan`.
 *
 * @remarks
 * The plans come from the billing service, each with its price, interval and credit grant. The
 * user picks one; nothing is picked for them, and "set me up" is never taken as consent to be
 * charged. A free plan is activated at once. A paid one goes to its payment page, and the guide
 * waits for the payment to clear: card details stay on that page.
 */

import { getSubscription, listTiers, LIVE_STATUSES, sellableTiers, type Tier } from "../api/billing.js";
import { requireOrg, requireSession, type Ctx } from "../context.js";
import { failed } from "../errors.js";
import { cannotAsk, guideOf, refused, type Answer, type Guide } from "../guide.js";
import { formatCredits, formatInterval, formatPrice, plainText } from "../output.js";
import { subscribeTo, type Subscribed } from "../commands/subscribe.js";

/** @returns A plan in one line: its name, price and interval, and its credit grant. */
export function planLabel(t: Tier): string {
  const name = plainText(t.name ?? t.tier);
  if (!t.paid) return `${name}: free, ${formatCredits(t.creditsMilli)} once`;
  const unit = (t.interval ?? "month").toLowerCase();
  return `${name}: ${formatPrice(t.price)}${formatInterval(t.interval, t.intervalCount)}, ${formatCredits(t.creditsMilli)} per ${unit}`;
}

/** @returns The plans a person can choose from, cheapest first. */
export async function choosablePlans(ctx: Ctx, token: string, dev?: boolean): Promise<Tier[]> {
  return sellableTiers(await listTiers(ctx.config, token), { dev: dev ?? process.env.NXIS_DEV_MODE === "true" });
}

/** What {@link guidedPlan} needs. */
export interface PlanArgs {
  token: string;
  orgId: string;
  dev?: boolean;
  noOpen?: boolean;
  timeoutMinutes?: number;
  /** The plans, when already read. */
  plans?: Tier[];
}

/**
 * Asks the user to choose a plan, then subscribes to it.
 *
 * @returns What subscribing did, or the user's no.
 * @throws CliError `no_plans` (exit 1) when there is nothing to choose; what subscribing throws,
 * including `payment_pending` (exit 2) when the payment didn't clear in time.
 */
export async function guidedPlan(ctx: Ctx, guide: Guide, args: PlanArgs): Promise<Answer<Subscribed>> {
  const plans = args.plans ?? (await choosablePlans(ctx, args.token, args.dev));
  if (plans.length === 0) throw failed("No plans are available to choose from right now.", "no_plans");
  const answer = await guide.choose({
    message:
      `Choose a plan for organization ${args.orgId}. A free plan starts at once. A paid plan opens its payment ` +
      "page, and nothing is charged until you pay there.",
    title: "Plan",
    options: plans.map((t) => ({ value: t, label: planLabel(t) })),
  });
  if (!answer.ok) return answer;
  return {
    ok: true,
    value: await subscribeTo(ctx, args.orgId, answer.value, args.token, {
      guide,
      ...(args.noOpen !== undefined ? { noOpen: args.noOpen } : {}),
      ...(args.timeoutMinutes !== undefined ? { timeoutMinutes: args.timeoutMinutes } : {}),
    }),
  };
}

/** @returns The plans as `choose_plan` lists them, for a stop when nobody can choose. */
export function plansJson(plans: Tier[]): Array<Record<string, unknown>> {
  return plans.map((t) => ({
    tier: t.tier,
    name: t.name,
    price: t.price,
    interval: t.interval,
    interval_count: t.intervalCount,
    credits_milli: t.creditsMilli,
    paid: t.paid,
  }));
}

/**
 * `nxis_choose_plan`: the organization's plan, or the user's choice of one.
 *
 * @returns The plan it already has (`changed: false`), or what subscribing did (`changed: true`).
 * @throws CliError `confirmation_unavailable` (exit 2, with the plans) when nobody can be asked;
 * `declined_by_user` or `cancelled_by_user` (exit 2) when no plan was chosen; and what
 * {@link guidedPlan} throws.
 */
export async function choosePlanOp(ctx: Ctx): Promise<Record<string, unknown>> {
  const { token } = await requireSession(ctx);
  const orgId = requireOrg(ctx);
  const sub = await getSubscription(ctx.config, token, orgId).catch(() => null);
  if (sub && LIVE_STATUSES.has(sub.status)) {
    return { ok: true, changed: false, org_id: orgId, subscription: { status: sub.status, tier: sub.tier } };
  }
  const guide = guideOf(ctx);
  const plans = await choosablePlans(ctx, token);
  if (!guide.interactive) {
    throw cannotAsk(
      `Choose a plan for organization ${orgId}: ${plans.map(planLabel).join("; ") || "none available"}.`,
      "nxis signup",
      { org_id: orgId, plans: plansJson(plans) },
    );
  }
  const out = await guidedPlan(ctx, guide, { token, orgId, plans });
  if (!out.ok) throw refused(guide, out.why, "No plan was chosen; nothing changed.", { org_id: orgId });
  return { ...out.value.payload, changed: true };
}
