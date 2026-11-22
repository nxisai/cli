/**
 * Plan selection and payment links.
 */

import { describe, expect, it } from "vitest";
import { paymentLinkUrl, sellableTiers, type Tier } from "../src/api/billing.js";

/** Builds a plan with sensible defaults. */
function tier(over: Partial<Tier> = {}): Tier {
  return {
    tier: "FREE",
    name: "Free",
    price: 0,
    creditsMilli: 1_000_000,
    interval: "MONTH",
    intervalCount: 1,
    isActive: true,
    isDevelopment: false,
    stripeLinkId: null,
    sites: 1,
    features: [],
    paid: false,
    ...over,
  };
}

describe("sellableTiers", () => {
  const tiers = [
    tier({ tier: "FREE", price: 0 }),
    tier({ tier: "STARTER", price: 39, paid: true, stripeLinkId: "abc" }),
    tier({ tier: "DEV", price: 24.99, paid: true, isDevelopment: true, stripeLinkId: "def" }),
    tier({ tier: "PRO", price: 50, paid: true, isActive: false }),
  ];

  it("hides inactive plans", () => {
    expect(sellableTiers(tiers).map((t) => t.tier)).not.toContain("PRO");
  });

  it("hides development plans by default", () => {
    expect(sellableTiers(tiers).map((t) => t.tier)).not.toContain("DEV");
  });

  /** Development plans replace the regular list rather than joining it. */
  it("shows only development plans in dev mode", () => {
    const dev = sellableTiers(tiers, { dev: true }).map((t) => t.tier);
    expect(dev).toEqual(["DEV"]);
  });

  it("orders by price so the cheapest option is first", () => {
    expect(sellableTiers(tiers).map((t) => t.tier)).toEqual(["FREE", "STARTER"]);
  });
});

describe("paymentLinkUrl", () => {
  it("tags the link with the organization the payment is for", () => {
    expect(paymentLinkUrl("link123", "org123")).toBe(
      "https://buy.stripe.com/link123?client_reference_id=org123",
    );
  });

  it("escapes the organization id rather than trusting it", () => {
    expect(paymentLinkUrl("abc", "a b&c")).toBe("https://buy.stripe.com/abc?client_reference_id=a%20b%26c");
  });
});
