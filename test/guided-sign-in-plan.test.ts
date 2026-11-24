/**
 * Guided setup: the terminal guide, signing in when a call needs it, and choosing a plan, on a
 * terminal and through `nxis mcp serve` over MCP elicitation.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCredentials } from "../src/credentials.js";
import { notAuthorized } from "../src/errors.js";
import { terminalGuide } from "../src/guide.js";
import { offerSignIn } from "../src/guided/sign-in.js";
import { cmdSubscribe } from "../src/commands/subscribe.js";
import { cmdSignup } from "../src/commands/signup.js";
import { saveCredentials } from "../src/credentials.js";
import { endpointKey } from "../src/config.js";
import { capture, cleanFake, fake, ORG, resetFake, startFake, stopFake } from "./support/fake-endpoints.js";
import {
  body,
  DEVICE_CODE,
  expectNoSecrets,
  fakeDeviceFlow,
  fakeJwt,
  guidedServe,
  scriptedTerminal,
  USER_CODE,
} from "./support/guided.js";

beforeAll(startFake);
afterAll(stopFake);
beforeEach(() => {
  resetFake();
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanFake();
});

const TIERS = {
  tiers: [
    { tier: "FREE", tier_name: "Free", price: 0, credits: 1_000_000, is_active: true },
    {
      tier: "STARTER",
      tier_name: "Starter",
      price: 39,
      credits: 10_000_000,
      billing_interval: "MONTH",
      interval_count: 1,
      stripe_price_id: "price_1",
      stripe_link_id: "link_starter",
      is_active: true,
    },
  ],
};

/** Billing with no plan yet; `afterSubscribe` is what the subscription reads as once one is made. */
function billing(opts: { liveAfter?: number } = {}): void {
  let reads = 0;
  fake.billing = (req) => {
    if (req.url.startsWith("/v1/tiers")) return { status: 200, body: TIERS };
    if (req.url.endsWith("/subscriptions") && req.method === "POST") {
      return { status: 200, body: { status: "ACTIVE", tier: (req.body as { tier: string }).tier } };
    }
    if (req.url.endsWith("/subscriptions")) {
      reads++;
      return opts.liveAfter !== undefined && reads > opts.liveAfter ? { status: 200, body: { status: "ACTIVE", tier: "STARTER" } } : { status: 404 };
    }
    return { status: 404 };
  };
}

function signIn(): void {
  saveCredentials({ accessToken: fakeJwt(), profile: capture().ctx.config.profile, endpoints: endpointKey(capture().ctx.config.endpoints) });
}

const posts = () => fake.billingCalls.filter((c) => c.method === "POST");

describe("the terminal guide", () => {
  it("numbers the options, selects none by default, and returns the one picked", async () => {
    const t = scriptedTerminal(["2"]);
    const answer = await t.guide.choose({ message: "Pick", title: "Plan", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] });
    expect(answer).toEqual({ ok: true, value: "b" });
    expect(t.written()).toContain("  1) A\n  2) B\n");
  });

  it("treats Enter, or anything that isn't one of the numbers, as a cancel", async () => {
    for (const typed of ["", "3", "yes", "0", "1.5"]) {
      const t = scriptedTerminal([typed]);
      const answer = await t.guide.choose({ message: "Pick", title: "Plan", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] });
      expect(answer, typed).toEqual({ ok: false, why: "cancel" });
    }
  });

  it("says no unless the answer is an explicit yes", async () => {
    expect(await scriptedTerminal([""]).guide.confirm({ message: "m", question: "q?" })).toEqual({ ok: false, why: "decline" });
    expect(await scriptedTerminal(["y"]).guide.confirm({ message: "m", question: "q?" })).toEqual({ ok: true, value: true });
  });

  it("asks nobody under --json", () => {
    expect(terminalGuide({ json: true, interactive: true }).interactive).toBe(false);
  });
});

describe("sign-in on a terminal", () => {
  const expired = notAuthorized("You are not signed in. Run `nxis login`.", "signed_out");

  it("offers the device flow, shows the link and code, and signs in", async () => {
    const t = scriptedTerminal(["y"]);
    const { ctx } = capture({ guide: t.guide });
    const flow = fakeDeviceFlow();
    expect(await offerSignIn(ctx, expired, ["autofill", "submit"], false, flow)).toBe(true);
    expect(t.written()).toContain(USER_CODE);
    expect(t.written()).toContain("https://login.example.test/activate?user_code=");
    expect(t.opened).toHaveLength(1);
    expect(loadCredentials()?.accessToken).toBeTruthy();
    expectNoSecrets([t.written()]);
  });

  it("does nothing on a no, and asks nothing with --yes, --json, or for login itself", async () => {
    const flow = fakeDeviceFlow();
    expect(await offerSignIn(capture({ guide: scriptedTerminal(["n"]).guide }).ctx, expired, ["status", undefined], false, flow)).toBe(false);
    expect(await offerSignIn(capture({ guide: scriptedTerminal(["y"]).guide }).ctx, expired, ["status", undefined], true, flow)).toBe(false);
    expect(await offerSignIn(capture({ guide: terminalGuide({ json: true }) }).ctx, expired, ["status", undefined], false, flow)).toBe(false);
    expect(await offerSignIn(capture({ guide: scriptedTerminal(["y"]).guide }).ctx, expired, ["login", undefined], false, flow)).toBe(false);
    expect(await offerSignIn(capture({ guide: scriptedTerminal(["y"]).guide }).ctx, expired, ["mcp", "serve"], false, flow)).toBe(false);
    expect(flow.polls).toBe(0);
    expect(loadCredentials()).toBeNull();
  });

  it("only answers a failure a sign-in fixes", async () => {
    const flow = fakeDeviceFlow();
    const other = notAuthorized("Not an owner.", "forbidden");
    expect(await offerSignIn(capture({ guide: scriptedTerminal(["y"]).guide }).ctx, other, ["status", undefined], false, flow)).toBe(false);
  });
});

describe("sign-in through nxis mcp serve", () => {
  it("shows the link and code over elicitation, waits, then runs the call once", async () => {
    billing();
    const flow = fakeDeviceFlow();
    const s = await guidedServe((_p, n) => (n === 0 ? { action: "accept", content: {} } : { action: "decline" }), { deviceFlow: flow });
    try {
      const result = await s.call("nxis_choose_plan");
      // Signed in, then the plan choice was put to the user, who declined it.
      expect(body(result)).toMatchObject({ reason: "declined_by_user" });
      expect(s.asked[0]).toMatchObject({ mode: "form" });
      expect(s.asked[0]?.message).toContain(USER_CODE);
      expect(s.asked[0]?.message).toContain("https://login.example.test/activate");
      expect(s.asked[1]?.message).toContain("Choose a plan");
      expect(loadCredentials()).not.toBeNull();
      expectNoSecrets(s.asked);
    } finally {
      await s.close();
    }
  });

  it("uses URL elicitation where the client takes it", async () => {
    billing();
    const s = await guidedServe((_p, n) => (n === 0 ? { action: "accept" } : { action: "cancel" }), { deviceFlow: fakeDeviceFlow(), url: true });
    try {
      expect(body(await s.call("nxis_choose_plan"))).toMatchObject({ reason: "cancelled_by_user" });
      expect(s.asked[0]).toMatchObject({ mode: "url", url: `https://login.example.test/activate?user_code=${USER_CODE}` });
      expect(JSON.stringify(s.asked[0])).not.toContain(DEVICE_CODE);
    } finally {
      await s.close();
    }
  });

  it("stops waiting and does nothing when the user declines the sign-in", async () => {
    billing();
    const flow = fakeDeviceFlow({ hang: true });
    const s = await guidedServe(() => ({ action: "decline" }), { deviceFlow: flow });
    try {
      const result = await s.call("nxis_choose_plan");
      expect(result.isError).toBe(true);
      expect(body(result)).toMatchObject({ reason: "declined_by_user" });
      await vi.waitFor(() => expect(flow.aborted).toBe(true));
      expect(loadCredentials()).toBeNull();
      expect(s.asked).toHaveLength(1);
    } finally {
      await s.close();
    }
  });

  it("keeps signed_out, with its hint, for a client that cannot elicit", async () => {
    const flow = fakeDeviceFlow();
    const s = await guidedServe(null, { deviceFlow: flow });
    try {
      const result = await s.call("nxis_choose_plan");
      expect(body(result)).toMatchObject({ reason: "signed_out" });
      expect(String(body(result)["hint"])).toContain("nxis login");
      expect(flow.polls).toBe(0);
    } finally {
      await s.close();
    }
  });
});

describe("choosing a plan through nxis mcp serve", () => {
  beforeEach(signIn);

  it("offers every plan with its price, interval and credit grant, and subscribes to the one chosen", async () => {
    billing();
    const s = await guidedServe(() => ({ action: "accept", content: { choice: "0" } }));
    try {
      const result = await s.call("nxis_choose_plan");
      expect(body(result)).toMatchObject({ ok: true, changed: true, tier: "FREE", org_id: ORG });
      const schema = s.asked[0]?.requestedSchema as { properties: { choice: { oneOf: Array<{ title: string }> } }; required: string[] };
      expect(schema.properties.choice.oneOf.map((o) => o.title)).toEqual(["Free: free, 1,000 NXC once", "Starter: $39/month, 10,000 NXC per month"]);
      expect(schema.required).toEqual(["choice"]);
      expect(JSON.stringify(schema)).not.toContain('"default"');
      expect(posts().map((c) => c.body)).toEqual([{ parent: `organizations/${ORG}`, tier: "FREE" }]);
      expectNoSecrets(s.asked);
    } finally {
      await s.close();
    }
  });

  it("sends a paid plan to its payment page and waits for the payment, never charging in the CLI", async () => {
    billing({ liveAfter: 1 });
    const s = await guidedServe((_p, n) => (n === 0 ? { action: "accept", content: { choice: "1" } } : { action: "accept", content: {} }));
    try {
      const result = await s.call("nxis_choose_plan");
      expect(body(result)).toMatchObject({ ok: true, changed: true, tier: "STARTER", status: "ACTIVE" });
      expect(s.asked[1]?.message).toContain("https://buy.stripe.com/link_starter?client_reference_id=org-test");
      expect(s.asked[1]?.message).toContain("$39/month");
      expect(posts()).toHaveLength(0);
      expectNoSecrets(s.asked);
    } finally {
      await s.close();
    }
  });

  it("subscribes to nothing when the user declines or dismisses the choice", async () => {
    billing();
    for (const action of ["decline", "cancel"] as const) {
      const s = await guidedServe(() => ({ action }));
      try {
        expect(body(await s.call("nxis_choose_plan"))).toMatchObject({ reason: action === "decline" ? "declined_by_user" : "cancelled_by_user" });
      } finally {
        await s.close();
      }
    }
    expect(posts()).toHaveLength(0);
  });

  it("refuses with the plans and the terminal command when the client cannot elicit", async () => {
    billing();
    const s = await guidedServe(null);
    try {
      const out = body(await s.call("nxis_choose_plan"));
      expect(out).toMatchObject({ reason: "confirmation_unavailable", terminal_command: "nxis signup" });
      expect(String(out["would_do"])).toContain("Starter: $39/month, 10,000 NXC per month");
      expect(posts()).toHaveLength(0);
    } finally {
      await s.close();
    }
  });

  it("changes nothing for an organization already on a plan", async () => {
    fake.billing = (req) => (req.url.endsWith("/subscriptions") ? { status: 200, body: { status: "ACTIVE", tier: "FREE" } } : { status: 404 });
    const s = await guidedServe(() => ({ action: "accept", content: { choice: "1" } }));
    try {
      expect(body(await s.call("nxis_choose_plan"))).toMatchObject({ ok: true, changed: false, subscription: { tier: "FREE" } });
      expect(s.asked).toHaveLength(0);
    } finally {
      await s.close();
    }
  });
});

describe("choosing a plan on a terminal", () => {
  beforeEach(signIn);

  it("subscribe with no tier offers the plans", async () => {
    billing();
    const t = scriptedTerminal(["1"]);
    const { ctx, out } = capture({ guide: t.guide });
    await cmdSubscribe(ctx, {});
    expect(out.json).toMatchObject({ ok: true, tier: "FREE" });
    expect(t.written()).toContain("2) Starter: $39/month, 10,000 NXC per month");
    expectNoSecrets([t.written()]);
  });

  it("subscribe with no tier and nobody to ask keeps missing_tier", async () => {
    billing();
    const { ctx } = capture({ guide: terminalGuide({ json: true }) });
    await expect(cmdSubscribe(ctx, {})).rejects.toMatchObject({ reason: "missing_tier" });
    expect(posts()).toHaveLength(0);
  });

  it("signup offers the choice in place of choose_plan, and keeps choose_plan on a cancel or under --json", async () => {
    billing();
    const chosen = capture({ guide: scriptedTerminal(["1"]).guide });
    await cmdSignup(chosen.ctx, {});
    expect(chosen.out.json).toMatchObject({ ok: true, tier: "FREE", next: "mcp install" });

    await expect(cmdSignup(capture({ guide: scriptedTerminal([""]).guide }).ctx, {})).rejects.toMatchObject({ reason: "choose_plan" });
    await expect(cmdSignup(capture({ guide: terminalGuide({ json: true }) }).ctx, {})).rejects.toMatchObject({
      reason: "choose_plan",
      details: { options: expect.any(Array) },
    });
    expect(posts()).toHaveLength(1);
  });
});
