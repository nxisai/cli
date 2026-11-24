/**
 * The credits check before a billed batch: the real balance against the estimate, and, when it
 * falls short, the packs to buy.
 *
 * @remarks
 * The balance is the one `nxis credits` reports: the allowance plus top-ups, less what was used,
 * read from the billing service. The autofill plan's own `credits_remaining` is not used for
 * this, because it can report the allowance as if nothing had been spent.
 *
 * - A balance that is used up (zero or less) never gets a batch: it would pause at once and block
 *   the next one. On a terminal or through an agent that can ask, the user is offered the packs;
 *   otherwise the call stops with `credits_exhausted`.
 * - A balance below the estimate (known only for a pure import, whose price per page is fixed)
 *   gets the packs too, beside "submit anyway", since the batch pauses where the credits run out.
 *   Without a prompt the submit goes ahead as it always did, after its own confirmation.
 * - A pack chosen opens its payment page; payment stays there. Once the credits land, the
 *   original call carries on, once.
 *
 * When the balance can't be read (no sign-in beside the provisioning key, or the billing service
 * unreachable), the plan's `quota_exceeded` decides, as it did before.
 */

import { getCredits, listCreditPacks, type CreditPack } from "../api/billing.js";
import type { Ctx } from "../context.js";
import { requireSession } from "../context.js";
import { needsUser } from "../errors.js";
import { refused, type Guide } from "../guide.js";
import { formatCredits } from "../output.js";
import { buyPack, packLabel, remainingOf, requireActivePlan } from "../commands/credits.js";

/** @returns The organization's real balance in milli-credits, or null when it can't be read. */
export async function readBalanceMilli(ctx: Ctx, orgId: string): Promise<number | null> {
  return (await readBalance(ctx, orgId))?.remainingMilli ?? null;
}

/** What the check needs. */
export interface CreditsQuestion {
  orgId: string;
  /** The site's host, for the question. */
  host: string;
  /** What the batch would cost, in milli-credits; null when the price varies per page. */
  estimateMilli: number | null;
  /** The plan's own `quota_exceeded`, used only when the balance can't be read. */
  planQuotaExceeded: boolean;
  noOpen?: boolean;
  timeoutMinutes?: number;
  /** Carried by every stop, e.g. `{ plan }`. */
  details?: Record<string, unknown>;
}

/** What the check found. */
export interface CreditsChecked {
  /** The balance the call goes ahead with, in milli-credits; null when it couldn't be read. */
  balanceMilli: number | null;
  /** A pack bought on the way, by sku. */
  bought: string | null;
}

/** @returns The balance and a token to read more with, or null when it can't be read. */
async function readBalance(ctx: Ctx, orgId: string): Promise<{ token: string; remainingMilli: number } | null> {
  try {
    const { token } = await requireSession(ctx);
    const credits = await getCredits(ctx.config, token, orgId);
    return credits ? { token, remainingMilli: remainingOf(credits) } : null;
  } catch {
    return null;
  }
}

/** @returns The stop for a balance that is used up. */
function exhausted(q: CreditsQuestion, remainingMilli: number | null, extra = ""): Error {
  return needsUser(
    "The organization's credit balance is used up, so a batch would pause at once and block the next one. " +
      `Nothing was submitted.${extra} Buy credits first: \`nxis credits packs\`, then \`nxis credits buy <sku>\`.`,
    "credits_exhausted",
    { ...q.details, remaining_milli: remainingMilli, estimate_milli: q.estimateMilli, buy_credits: "nxis credits packs" },
  );
}

/**
 * Compares the balance with the estimate, and offers the packs when it falls short.
 *
 * @returns The balance to go ahead with.
 * @throws CliError `credits_exhausted` (exit 2) for a used-up balance nobody can top up here;
 * the guide's stop when the user cancels; and what buying throws (`no_active_plan`,
 * `topup_pending` …).
 */
export async function checkCredits(ctx: Ctx, guide: Guide, q: CreditsQuestion): Promise<CreditsChecked> {
  const balance = await readBalance(ctx, q.orgId);
  if (!balance) {
    if (q.planQuotaExceeded) throw exhausted(q, null);
    return { balanceMilli: null, bought: null };
  }

  const empty = balance.remainingMilli <= 0;
  const short = empty || (q.estimateMilli !== null && balance.remainingMilli < q.estimateMilli);
  if (!short) return { balanceMilli: balance.remainingMilli, bought: null };

  const facts =
    `The credit balance is ${formatCredits(balance.remainingMilli)}` +
    (q.estimateMilli !== null ? `, and this batch is estimated at ${formatCredits(q.estimateMilli)}.` : ".");
  if (!guide.interactive) {
    if (!empty) return { balanceMilli: balance.remainingMilli, bought: null };
    throw exhausted(q, balance.remainingMilli);
  }

  const packs = (await listCreditPacks(ctx.config, balance.token)).filter((p) => p.stripeLinkId);
  if (packs.length === 0 && empty) throw exhausted(q, balance.remainingMilli, " No credit packs are on sale right now.");
  if (packs.length === 0) return { balanceMilli: balance.remainingMilli, bought: null };

  type Pick = { pack: CreditPack } | { anyway: true };
  const options: Array<{ value: Pick; label: string }> = packs.map((pack) => ({ value: { pack }, label: `Buy ${packLabel(pack)}` }));
  if (!empty) options.push({ value: { anyway: true }, label: "Submit anyway: the batch pauses where the credits run out" });

  const answer = await guide.choose({
    message:
      `${empty ? "Not enough credits for a batch" : "The credits may not cover this batch"} on ${q.host}. ${facts}` +
      (empty ? " A batch now would pause at once." : "") +
      " Buying opens the pack's payment page; nothing is charged until you pay there.",
    title: "Credits",
    options,
  });
  if (!answer.ok) {
    throw refused(guide, answer.why, "Nothing was submitted and nothing was bought.", {
      ...q.details,
      remaining_milli: balance.remainingMilli,
      estimate_milli: q.estimateMilli,
    });
  }
  if ("anyway" in answer.value) return { balanceMilli: balance.remainingMilli, bought: null };

  await requireActivePlan(ctx, balance.token, q.orgId);
  const bought = await buyPack(ctx, q.orgId, balance.token, answer.value.pack, {
    guide,
    ...(q.noOpen !== undefined ? { noOpen: q.noOpen } : {}),
    ...(q.timeoutMinutes !== undefined ? { timeoutMinutes: q.timeoutMinutes } : {}),
  });
  ctx.io.note(`Paid. The balance is now ${formatCredits(bought.remainingMilli)}; continuing.`);
  if (bought.remainingMilli <= 0) throw exhausted(q, bought.remainingMilli, " The top-up landed, but the balance is still used up.");
  return { balanceMilli: bought.remainingMilli, bought: answer.value.pack.sku };
}
