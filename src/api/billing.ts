/**
 * Billing API: plans, subscriptions, quotas and credit packs.
 *
 * @remarks
 * No plan name, price or pack is compiled in. The CLI shows exactly what the API marks
 * sellable, so plans can change without a CLI release, and development plans need no
 * special case.
 */

import type { Config } from "../config.js";
import { request } from "../http.js";
import { bool, list, num, str, uid, type Uid } from "./shapes.js";

/** A plan, normalized from the API's response. */
export interface Tier {
  /** Enum name, e.g. "FREE", "DEV", "STARTER". The value `subscribe` takes. */
  tier: string;
  name: string | null;
  price: number;
  creditsMilli: number | null;
  interval: string | null;
  intervalCount: number | null;
  isActive: boolean;
  isDevelopment: boolean;
  stripeLinkId: string | null;
  sites: number | null;
  features: string[];
  /** A tier with no Stripe price is provisioned directly; anything else goes through Checkout. */
  paid: boolean;
}

/** A plan as the API returns it. */
interface RawTier {
  tier?: unknown;
  tier_name?: unknown;
  price?: unknown;
  credits?: unknown;
  sites?: unknown;
  features?: unknown;
  stripe_link_id?: unknown;
  stripe_price_id?: unknown;
  is_active?: unknown;
  is_development?: unknown;
  billing_interval?: unknown;
  interval_count?: unknown;
}

/** @returns The normalized plan, or null when it has no tier name. */
function toTier(raw: RawTier): Tier | null {
  const tier = typeof raw.tier === "string" ? raw.tier : str(raw.tier);
  if (!tier) return null;
  const price = num(raw.price) ?? 0;
  const stripePriceId = str(raw.stripe_price_id);
  return {
    tier,
    name: str(raw.tier_name),
    price,
    creditsMilli: num(raw.credits),
    interval: typeof raw.billing_interval === "string" ? raw.billing_interval : str(raw.billing_interval),
    intervalCount: num(raw.interval_count),
    isActive: bool(raw.is_active),
    isDevelopment: bool(raw.is_development),
    stripeLinkId: str(raw.stripe_link_id),
    sites: num(raw.sites),
    features: Array.isArray(raw.features) ? (raw.features as string[]) : [],
    paid: Boolean(stripePriceId && stripePriceId.trim()),
  };
}

/** Lists every plan the billing service knows about. */
export async function listTiers(config: Config, token?: string): Promise<Tier[]> {
  const payload = await request<unknown>(`${config.endpoints.billing}/v1/tiers`, { token });
  return list<RawTier>(payload, "tiers")
    .map(toTier)
    .filter((t): t is Tier => t !== null);
}

/**
 * What a user may actually buy.
 *
 * @remarks
 * In dev mode this returns only development plans rather than adding them to the regular
 * list, so a development plan is never offered alongside real ones.
 *
 * @param tiers - Every plan.
 * @param opts - `dev` selects development plans instead of regular ones.
 * @returns Active plans of the selected kind, cheapest first.
 */
export function sellableTiers(tiers: Tier[], opts: { dev?: boolean } = {}): Tier[] {
  const dev = opts.dev === true;
  return tiers
    .filter((t) => t.isActive && (dev ? t.isDevelopment : !t.isDevelopment))
    .sort((a, b) => a.price - b.price);
}

/** An organization's subscription. */
export interface Subscription {
  id: string | null;
  status: string;
  tier: string | null;
  organizationId: string | null;
}

/** A subscription as the API returns it. */
interface RawSubscription {
  _id?: Uid;
  status?: unknown;
  tier?: unknown;
  organization?: Uid;
}

/** Normalizes a subscription. */
function toSubscription(raw: RawSubscription): Subscription {
  return {
    id: uid(raw._id),
    status: (typeof raw.status === "string" ? raw.status : str(raw.status)) ?? "STATUS_UNSPECIFIED",
    tier: typeof raw.tier === "string" ? raw.tier : (uid(raw.tier as Uid) ?? str(raw.tier)),
    organizationId: uid(raw.organization),
  };
}

/** Subscription statuses that mean a plan is usable: ACTIVE and TRIALING. */
export const LIVE_STATUSES = new Set(["ACTIVE", "TRIALING"]);

/** Fetches the organization's subscription, or null when it has none. */
export async function getSubscription(
  config: Config,
  token: string,
  orgId: string,
): Promise<Subscription | null> {
  const raw = await request<RawSubscription>(
    `${config.endpoints.billing}/v1/organizations/${encodeURIComponent(orgId)}/subscriptions`,
    { token, allow404: true },
  );
  return raw ? toSubscription(raw) : null;
}

/**
 * Provisions a free plan directly.
 *
 * @remarks
 * The service refuses any plan that carries a Stripe price, so this is only ever the free
 * path. A paid plan goes through Stripe Checkout.
 */
export async function createSubscription(
  config: Config,
  token: string,
  orgId: string,
  tier: string,
): Promise<Subscription | null> {
  const raw = await request<RawSubscription>(
    `${config.endpoints.billing}/v1/organizations/${encodeURIComponent(orgId)}/subscriptions`,
    {
      method: "POST",
      token,
      body: { parent: `organizations/${orgId}`, tier },
    },
  );
  return raw ? toSubscription(raw) : null;
}

export interface CreditBalance {
  /** The recurring or lifetime grant. */
  limitMilli: number;
  usageMilli: number;
  /** Purchased credits, kept separate from the grant so a period roll doesn't wipe them. */
  topupMilli: number;
  lifetime: boolean;
}

/** A quota row as the API returns it. */
interface RawQuota {
  metered_resource?: { name?: unknown };
  credit_limit_milli?: unknown;
  credit_usage_milli?: unknown;
  credit_topup_milli?: unknown;
  is_lifetime?: unknown;
}

/**
 * Fetches the organization's credit balance.
 *
 * @remarks
 * The credits row is matched on the last path segment of the metered-resource name rather than
 * the whole string, so a namespace change does not silently return "no credits".
 *
 * @returns The balance, or null when the organization has no credits row.
 */
export async function getCredits(
  config: Config,
  token: string,
  orgId: string,
): Promise<CreditBalance | null> {
  const payload = await request<unknown>(
    `${config.endpoints.billing}/v1/organizations/${encodeURIComponent(orgId)}/quotas`,
    { token, allow404: true },
  );
  const quotas = list<RawQuota>(payload, "quotas");
  const credits = quotas.find(
    (q) => (str(q.metered_resource?.name) ?? "").split("/").pop() === "credits",
  );
  if (!credits) return null;
  return {
    limitMilli: num(credits.credit_limit_milli) ?? 0,
    usageMilli: num(credits.credit_usage_milli) ?? 0,
    topupMilli: num(credits.credit_topup_milli) ?? 0,
    lifetime: bool(credits.is_lifetime),
  };
}

/** A one-time credit top-up. */
export interface CreditPack {
  sku: string;
  creditsMilli: number;
  price: number;
  stripeLinkId: string | null;
}

/** Lists the credit packs available to buy. */
export async function listCreditPacks(config: Config, token: string): Promise<CreditPack[]> {
  const payload = await request<unknown>(`${config.endpoints.billing}/v1/credits:packs`, { token });
  return list<Record<string, unknown>>(payload, "packs")
    .map((p) => ({
      sku: (str(p["sku"]) ?? "").trim(),
      creditsMilli: num(p["credits_milli"]) ?? 0,
      price: num(p["price"]) ?? 0,
      stripeLinkId: str(p["stripe_link_id"]),
    }))
    .filter((p) => p.sku.length > 0);
}

/**
 * Builds the Stripe payment URL for a plan or pack.
 *
 * @remarks
 * `client_reference_id` tells the billing service which organization the payment is for. The
 * pack itself is identified by the payment link, not by anything the CLI sends.
 *
 * @param stripeLinkId - The payment link id.
 * @param orgId - The organization to credit.
 * @returns The payment URL.
 */
export function paymentLinkUrl(stripeLinkId: string, orgId: string): string {
  // Encoded: the id comes from the service, and must stay one path segment of buy.stripe.com.
  return `https://buy.stripe.com/${encodeURIComponent(stripeLinkId)}?client_reference_id=${encodeURIComponent(orgId)}`;
}
