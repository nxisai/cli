/**
 * `nxis plans` — what the API says is sellable, and nothing else.
 *
 * @remarks
 * No plan name or price is compiled in, so plans can change without a CLI release. `--dev`
 * or `NXIS_DEV_MODE=true` lists development plans instead, for environments that offer them.
 */

import { tryGetAccessToken } from "../auth.js";
import { listTiers, sellableTiers, type Tier } from "../api/billing.js";
import type { Ctx } from "../context.js";
import { formatCredits, formatInterval, formatPrice } from "../output.js";

/** Arguments for `nxis plans`. */
export interface PlansArgs {
  dev?: boolean;
}

/** Runs `nxis plans`. */
export async function cmdPlans(ctx: Ctx, args: PlansArgs): Promise<void> {
  const { config, io } = ctx;
  const token = (await tryGetAccessToken(config)) ?? undefined;

  const dev = args.dev ?? process.env.NXIS_DEV_MODE === "true";
  const tiers = sellableTiers(await listTiers(config, token), { dev });

  io.emit(
    {
      ok: true,
      dev_mode: dev,
      plans: tiers.map(toJson),
    },
    () => renderHuman(tiers, dev),
  );
}

/**
 * The `--json` shape of a plan.
 *
 * @remarks
 * `lifetime` is true for free plans, which grant credits once; paid plans grant per period.
 */
function toJson(t: Tier) {
  return {
    tier: t.tier,
    name: t.name,
    price: t.price,
    interval: t.interval,
    interval_count: t.intervalCount,
    credits_milli: t.creditsMilli,
    credits: t.creditsMilli === null ? null : Math.round(t.creditsMilli / 1000),
    lifetime: !t.paid,
    paid: t.paid,
    sites: t.sites,
    features: t.features,
  };
}

/** Renders available plans for a person. */
function renderHuman(tiers: Tier[], dev: boolean): string {
  if (tiers.length === 0) {
    return dev
      ? "No development plans are available in this environment."
      : "No plans are available to buy right now.";
  }
  const lines = tiers.map((t) => {
    const label = t.name ?? t.tier;
    const price = t.paid ? `${formatPrice(t.price)}${formatInterval(t.interval, t.intervalCount)}` : "free";
    const credits = formatCredits(t.creditsMilli);
    const grant = t.paid ? `${credits}/${(t.interval ?? "month").toLowerCase()}` : `${credits} lifetime`;
    return `  ${label.padEnd(12)} ${price.padEnd(16)} ${grant}`;
  });
  const header = dev ? "Development plans:" : "Plans:";
  return [header, ...lines, "", "Subscribe with: nxis subscribe <tier>"].join("\n");
}
