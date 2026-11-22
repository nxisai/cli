/**
 * `nxis credits` — balance, packs, and buying a top-up.
 *
 * @remarks
 * A top-up is added to the organization's credit balance, which only exists once the
 * organization has a plan (including Free). Paying without one would charge the customer
 * without crediting anything, so `credits buy` refuses when there is no active plan.
 *
 * Polling watches the purchased-credits total rather than the subscription, because a pack is a
 * one-time payment that creates no subscription.
 */

import { openUrl } from "../browser.js";
import { getCredits, getSubscription, listCreditPacks, paymentLinkUrl, LIVE_STATUSES } from "../api/billing.js";
import type { Ctx } from "../context.js";
import { requireOrg, requireSession } from "../context.js";
import { failed, needsUser } from "../errors.js";
import { pollUntil } from "../http.js";
import { bold, formatCredits, formatPrice } from "../output.js";

/**
 * Runs `nxis credits`.
 *
 * @throws CliError `no_credits_quota` (exit 2) when the organization has no balance yet.
 */
export async function cmdCredits(ctx: Ctx): Promise<void> {
  const { config, io } = ctx;
  const { token } = await requireSession(ctx);
  const orgId = requireOrg(ctx);

  const credits = await getCredits(config, token, orgId);
  if (!credits) {
    throw needsUser(
      "This organization has no credit balance yet — activate a plan first with `nxis subscribe free`.",
      "no_credits_quota",
      { org_id: orgId },
    );
  }

  const remaining = credits.limitMilli + credits.topupMilli - credits.usageMilli;
  io.emit(
    {
      ok: true,
      org_id: orgId,
      remaining_milli: remaining,
      allowance_milli: credits.limitMilli,
      used_milli: credits.usageMilli,
      topup_milli: credits.topupMilli,
      lifetime: credits.lifetime,
    },
    () =>
      [
        `Remaining  ${bold(formatCredits(remaining))}${credits.lifetime ? " (lifetime)" : ""}`,
        `Allowance  ${formatCredits(credits.limitMilli)}`,
        `Purchased  ${formatCredits(credits.topupMilli)}`,
        `Used       ${formatCredits(credits.usageMilli)}`,
      ].join("\n"),
  );
}

/**
 * Runs `nxis credits packs`.
 *
 * @remarks
 * Packs without a payment link are filtered out by the service, so anything listed is buyable.
 */
export async function cmdCreditsPacks(ctx: Ctx): Promise<void> {
  const { config, io } = ctx;
  const { token } = await requireSession(ctx);

  const packs = await listCreditPacks(config, token);

  io.emit(
    {
      ok: true,
      packs: packs.map((p) => ({
        sku: p.sku,
        credits_milli: p.creditsMilli,
        credits: Math.round(p.creditsMilli / 1000),
        price: p.price,
      })),
    },
    () =>
      packs.length === 0
        ? "No credit packs are available right now."
        : [
            "Credit packs:",
            ...packs.map(
              (p) => `  ${p.sku.padEnd(12)} ${formatCredits(p.creditsMilli).padEnd(14)} ${formatPrice(p.price)}`,
            ),
            "",
            "Buy with: nxis credits buy <sku>",
          ].join("\n"),
  );
}

/** Arguments for `nxis credits buy`. */
export interface CreditsBuyArgs {
  sku: string;
  noOpen?: boolean;
  timeoutMinutes?: number;
}

/**
 * Runs `nxis credits buy <sku>`.
 *
 * @remarks
 * The active-plan check runs first, before a price is shown or a page is opened. A timeout
 * exits 2 with the payment URL, because the payment may still be processing.
 *
 * @throws CliError `no_active_plan` or `topup_pending` (exit 2); `unknown_pack` or
 * `pack_not_purchasable` (exit 1).
 */
export async function cmdCreditsBuy(ctx: Ctx, args: CreditsBuyArgs): Promise<void> {
  const { config, io } = ctx;
  const { token } = await requireSession(ctx);
  const orgId = requireOrg(ctx);

  const sub = await getSubscription(config, token, orgId).catch(() => null);
  if (!sub || !LIVE_STATUSES.has(sub.status)) {
    throw needsUser(
      "This organization has no active plan, and a credit top-up can only be added to one that " +
        "does. Run `nxis subscribe free` first, then buy the pack.",
      "no_active_plan",
      { org_id: orgId, subscription_status: sub?.status ?? null },
    );
  }

  const packs = await listCreditPacks(config, token);
  const pack = packs.find((p) => p.sku.toLowerCase() === args.sku.trim().toLowerCase());
  if (!pack) {
    throw failed(
      `No credit pack called "${args.sku}". Available: ${packs.map((p) => p.sku).join(", ") || "none"}.`,
      "unknown_pack",
      { requested: args.sku },
    );
  }
  if (!pack.stripeLinkId) {
    throw failed(`The ${pack.sku} pack has no payment link configured.`, "pack_not_purchasable");
  }

  const before = await getCredits(config, token, orgId);
  const baseline = before?.topupMilli ?? 0;

  const url = paymentLinkUrl(pack.stripeLinkId, orgId);
  io.note("");
  io.note(`  ${bold(formatCredits(pack.creditsMilli))} for ${bold(formatPrice(pack.price))}, one time`);
  io.note(`  Pay at: ${url}`);
  io.note("");
  io.note("Waiting for the credits to land…");

  if (!args.noOpen) openUrl(url);

  const timeoutMs = (args.timeoutMinutes ?? 15) * 60_000;
  const landed = await pollUntil({
    timeoutMs,
    attempt: async () => {
      const now = await getCredits(config, token, orgId).catch(() => null);
      return now && now.topupMilli > baseline ? now : null;
    },
    onTick: (elapsed) => {
      const mins = Math.floor(elapsed / 60_000);
      if (mins > 0 && elapsed % 60_000 < 10_000) {
        io.note(`Still waiting for Stripe (${mins}m).`);
      }
    },
  });

  if (!landed) {
    throw needsUser(
      "The credits haven't arrived yet. If you completed the payment it may still be processing — " +
        "check with `nxis credits` shortly. Don't buy again, or you'll be charged twice.",
      "topup_pending",
      { org_id: orgId, sku: pack.sku, payment_url: url },
    );
  }

  const remaining = landed.limitMilli + landed.topupMilli - landed.usageMilli;
  io.emit(
    {
      ok: true,
      sku: pack.sku,
      credits_added_milli: landed.topupMilli - baseline,
      topup_milli: landed.topupMilli,
      remaining_milli: remaining,
      org_id: orgId,
    },
    () => `Paid — balance is now ${bold(formatCredits(remaining))}.`,
  );
}
