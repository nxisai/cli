/**
 * Guided setup: the credits check before a billed batch, on a terminal (`nxis autofill submit`)
 * and through `nxis mcp serve` (`nxis_bulk_autofill` submit), over MCP elicitation.
 *
 * The balance is the billing service's (allowance plus top-ups, less usage), never the plan's own
 * `credits_remaining`, which the fake sets to a figure that would mislead.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cmdAutofillPlan, cmdAutofillSubmit } from "../src/commands/autofill.js";
import { endpointKey } from "../src/config.js";
import { saveCredentials } from "../src/credentials.js";
import { terminalGuide } from "../src/guide.js";
import type { Asker } from "../src/prompt.js";
import { capture, cleanFake, fake, resetFake, startFake, stopFake, toolCalls } from "./support/fake-endpoints.js";
import { body, expectNoSecrets, fakeJwt, guidedServe, scriptedTerminal } from "./support/guided.js";

beforeAll(startFake);
afterAll(stopFake);

let stderr: string[] = [];
beforeEach(() => {
  resetFake();
  process.env.NXIS_NO_BROWSER = "1";
  stderr = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => (stderr.push(String(chunk)), true));
  const { ctx } = capture();
  saveCredentials({ accessToken: fakeJwt(), profile: ctx.config.profile, endpoints: endpointKey(ctx.config.endpoints) });
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanFake();
});

/**
 * The autofill plan: 240 pages, and a `credits_remaining` of 1,000 credits whatever the balance,
 * as the plan reports it today. With `existing: import`, a fixed 500 milli-credits a page.
 */
function plan(opts: { quotaExceeded?: boolean } = {}): void {
  fake.responses["nxis_bulk_autofill"] = (a) =>
    a["mode"] === "plan"
      ? {
          mode: "plan",
          resource_count: 240,
          site_total: 240,
          credits_remaining: 1_000_000,
          credit_limit: 1_000_000,
          existing: a["existing"] ?? "generate",
          ...(a["existing"] === "import" ? { import_cost_per_resource_milli: 500 } : {}),
          quota_exceeded: opts.quotaExceeded ?? false,
        }
      : { mode: "submit", started: true, batch_id: "batch-1", resource_count: 240 };
}

/**
 * Billing: an active plan, two packs, and a balance of `remaining` milli-credits; a top-up of
 * 25,000 credits lands on the `landsAfter`th quota read.
 */
function billing(remaining: number, opts: { landsAfter?: number } = {}): void {
  let reads = 0;
  fake.billing = (req) => {
    if (req.url.startsWith("/v1/credits:packs")) {
      return {
        status: 200,
        body: {
          packs: [
            { sku: "small", credits_milli: 5_000_000, price: 10, stripe_link_id: "link_small" },
            { sku: "large", credits_milli: 25_000_000, price: 40, stripe_link_id: "link_large" },
          ],
        },
      };
    }
    if (req.url.endsWith("/subscriptions")) return { status: 200, body: { status: "ACTIVE", tier: "FREE" } };
    if (req.url.endsWith("/quotas")) {
      reads++;
      const landed = opts.landsAfter !== undefined && reads >= opts.landsAfter;
      const topup = landed ? 25_000_000 : 0;
      // The allowance is 1,000 credits; usage makes up the rest of the balance.
      return {
        status: 200,
        body: {
          quotas: [
            {
              metered_resource: { name: "meteredResources/credits" },
              credit_limit_milli: 1_000_000,
              credit_usage_milli: 1_000_000 - remaining,
              credit_topup_milli: topup,
              is_lifetime: true,
            },
          ],
        },
      };
    }
    return { status: 404 };
  };
}

const yes: Asker = { interactive: true, confirm: async () => true };
const submits = () => toolCalls().filter((c) => c.tool === "nxis_bulk_autofill" && c.args["mode"] === "submit");
const quotaReads = () => fake.billingCalls.filter((c) => c.url.endsWith("/quotas")).length;

describe("on a terminal", () => {
  it("autofill plan shows the real balance, not the plan's credits_remaining", async () => {
    plan();
    billing(-30_469);
    const { ctx, out } = capture();
    await cmdAutofillPlan(ctx);
    expect(out.json).toMatchObject({ balance_milli: -30_469, credits_remaining: 1_000_000 });
    expect(out.text).toContain("-30 NXC balance");
    expect(out.text).not.toContain("1,000,000 remaining");
  });

  it("offers the packs for a used-up balance, waits for the payment, then asks and submits once", async () => {
    plan();
    billing(-30_469, { landsAfter: 3 });
    const t = scriptedTerminal(["2"]);
    const { ctx, out } = capture({ guide: t.guide });
    await cmdAutofillSubmit(ctx, { asker: yes });
    expect(t.written()).toContain("Not enough credits for a batch");
    expect(t.written()).toContain("-30 NXC");
    expect(t.written()).toContain("1) Buy 5,000 NXC for $10, one time");
    expect(t.written()).toContain("2) Buy 25,000 NXC for $40, one time");
    expect(t.written()).not.toContain("Submit anyway");
    expect(out.notes.join("\n")).toContain("https://buy.stripe.com/link_large?client_reference_id=org-test");
    // The confirmation shows the real balance after the top-up, not the plan's figure.
    expect(stderr.join("")).toContain("24,970 NXC balance");
    expect(submits()).toHaveLength(1);
    expect(out.json).toMatchObject({ started: true, batch_id: "batch-1" });
    expectNoSecrets([t.written()]);
  });

  it("submits nothing and buys nothing when the user cancels", async () => {
    plan();
    billing(0);
    const t = scriptedTerminal([""]);
    const { ctx } = capture({ guide: t.guide });
    await expect(cmdAutofillSubmit(ctx, { asker: yes })).rejects.toMatchObject({ reason: "cancelled", details: { remaining_milli: 0 } });
    expect(submits()).toHaveLength(0);
    expect(t.written()).not.toContain("buy.stripe.com");
  });

  it("never submits into a used-up balance without a prompt, whatever the plan says", async () => {
    plan();
    billing(-30_469);
    for (const run of [
      () => cmdAutofillSubmit(capture({ guide: terminalGuide({ json: true }) }).ctx, { yes: true }),
      () => cmdAutofillSubmit(capture({ guide: scriptedTerminal(["1"]).guide }).ctx, { yes: true }),
    ]) {
      await expect(run()).rejects.toMatchObject({
        reason: "credits_exhausted",
        exitCode: 2,
        details: { remaining_milli: -30_469, buy_credits: "nxis credits packs", plan: { credits_remaining: 1_000_000 } },
      });
    }
    expect(submits()).toHaveLength(0);
  });

  it("goes by the real balance when the plan says the allowance is used up but top-ups remain", async () => {
    plan({ quotaExceeded: true });
    billing(24_969_500);
    await cmdAutofillSubmit(capture({ guide: terminalGuide({ json: true }) }).ctx, { yes: true });
    expect(submits()).toHaveLength(1);
  });

  it("falls back to the plan's quota_exceeded when the balance can't be read", async () => {
    plan({ quotaExceeded: true });
    fake.billing = () => ({ status: 503 });
    await expect(cmdAutofillSubmit(capture({ guide: terminalGuide({ json: true }) }).ctx, { yes: true })).rejects.toMatchObject({
      reason: "credits_exhausted",
    });
    expect(submits()).toHaveLength(0);
  });

  it("offers the packs beside submitting anyway when the balance is short of an import's estimate", async () => {
    plan();
    billing(50_000);
    const t = scriptedTerminal(["3"]);
    await cmdAutofillSubmit(capture({ guide: t.guide }).ctx, { existing: "import", asker: yes });
    expect(t.written()).toContain("estimated at 120 NXC");
    expect(t.written()).toContain("3) Submit anyway");
    expect(submits()).toHaveLength(1);
    expect(fake.billingCalls.some((c) => c.url.includes("packs"))).toBe(true);
  });

  it("keeps a short but not empty balance non-interactive with --yes, as before", async () => {
    plan();
    billing(50_000);
    await cmdAutofillSubmit(capture({ guide: scriptedTerminal(["1"]).guide }).ctx, { existing: "import", yes: true });
    expect(submits()).toHaveLength(1);
  });

  it("asks nothing about credits when the balance covers the batch", async () => {
    plan();
    billing(500_000);
    const t = scriptedTerminal([]);
    await cmdAutofillSubmit(capture({ guide: t.guide }).ctx, { existing: "import", asker: yes });
    expect(t.written()).toBe("");
    expect(submits()).toHaveLength(1);
    expect(quotaReads()).toBe(1);
  });
});

describe("through nxis mcp serve", () => {
  const submit = { mode: "submit", existing: "generate" };

  it("offers the packs, sends the user to the payment page, then confirms and submits once", async () => {
    plan();
    billing(-30_469, { landsAfter: 3 });
    const s = await guidedServe((params, n) => {
      if (n === 0) return { action: "accept", content: { choice: "0" } };
      if (n === 1) return { action: "accept", content: {} };
      return { action: "accept", content: { confirm: true } };
    });
    try {
      const result = await s.call("nxis_bulk_autofill", submit);
      expect(result.isError).toBeFalsy();
      const choice = s.asked[0]?.requestedSchema as { properties: { choice: { oneOf: Array<{ title: string }> } } };
      expect(choice.properties.choice.oneOf.map((o) => o.title)).toEqual([
        "Buy 5,000 NXC for $10, one time",
        "Buy 25,000 NXC for $40, one time",
      ]);
      expect(s.asked[0]?.message).toContain("-30 NXC");
      expect(s.asked[1]?.message).toContain("https://buy.stripe.com/link_small?client_reference_id=org-test");
      expect(s.asked[2]?.message).toContain("24,970 NXC balance");
      expect(s.asked[2]?.message).not.toContain("1,000 remaining");
      expect(submits()).toHaveLength(1);
      expectNoSecrets(s.asked);
    } finally {
      await s.close();
    }
  });

  it("submits nothing when the user declines the packs", async () => {
    plan();
    billing(0);
    const s = await guidedServe(() => ({ action: "decline" }));
    try {
      const out = body(await s.call("nxis_bulk_autofill", submit));
      expect(out).toMatchObject({ reason: "declined_by_user", remaining_milli: 0 });
      expect(s.asked).toHaveLength(1);
      expect(submits()).toHaveLength(0);
    } finally {
      await s.close();
    }
  });

  it("keeps confirmation_unavailable for a client that can't ask, with the real balance in would_do", async () => {
    plan();
    billing(-30_469);
    const s = await guidedServe(null);
    try {
      const out = body(await s.call("nxis_bulk_autofill", submit));
      expect(out).toMatchObject({ reason: "confirmation_unavailable", terminal_command: "nxis autofill submit" });
      expect(String(out["would_do"])).toContain("-30 NXC balance");
      expect(submits()).toHaveLength(0);
    } finally {
      await s.close();
    }
  });

  it("refuses a used-up balance under --allow-unconfirmed", async () => {
    plan();
    billing(-30_469);
    const s = await guidedServe(null, { allowUnconfirmed: true });
    try {
      expect(body(await s.call("nxis_bulk_autofill", submit))).toMatchObject({ reason: "credits_exhausted" });
      expect(submits()).toHaveLength(0);
    } finally {
      await s.close();
    }
  });
});
