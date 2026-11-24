/**
 * The guided setup tools, which the CLI answers itself (surface `local`) with its own sign-in.
 *
 * @remarks
 * Each one is a decision only the user can make, put to them by `nxis mcp serve` over MCP
 * elicitation: the agent calls the tool, the user answers in the prompt, and the tool does what
 * they chose. The agent never chooses for them. A client that cannot elicit gets
 * `confirmation_unavailable`, with what the call would do and the terminal command that does it.
 */

import { z } from "zod";
import { defineLocalTool } from "./define.js";

type Result = Record<string, unknown>;

export const choosePlanTool = defineLocalTool<Result>()({
  name: "nxis_choose_plan",
  description:
    "Put the organization on a plan, chosen by the user. When it already has one, says which and changes " +
    "nothing. Otherwise the user is shown the plans (price, interval and credit grant) in a prompt and picks " +
    "one: a free plan starts at once; a paid plan opens its payment page, and this waits until the payment " +
    "clears. Never choose a plan for the user, and don't call this unless setup needs a plan.",
  input: z.strictObject({}),
  takesSite: false,
  readOnly: false,
  // Subscribing again is a no-op; a paid plan is a charge, which the user makes on the payment page.
  hints: { destructive: false, idempotent: true, openWorld: false },
  async call(ctx) {
    const { choosePlanOp } = await import("../guided/plan.js");
    return choosePlanOp(ctx);
  },
});

export const acceptDpaTool = defineLocalTool<Result>()({
  name: "nxis_accept_dpa",
  description:
    "Have the user accept the data processing agreement that hosted agents need before they answer visitors. " +
    "When the current version is already accepted, says so and changes nothing. Otherwise the user is shown the " +
    "version and its link in a prompt, and chooses who accepts: the organization (all of its sites) or the legal " +
    "entity the site belongs to (that site only). The acceptance is recorded as the user's. Never accept for the " +
    "user, and call this only when they want their agents to go live.",
  input: z.strictObject({
    site: z.string().describe("Site id or domain. Defaults to the site saved in the CLI.").optional(),
  }),
  takesSite: true,
  readOnly: false,
  // Records an acceptance; the same version accepted again changes nothing.
  hints: { destructive: false, idempotent: true, openWorld: false },
  async call(ctx, args) {
    const { acceptDpaOp } = await import("../guided/agreement.js");
    return acceptDpaOp(ctx, args.site);
  },
});

/** Every guided setup tool. */
export const SETUP_TOOLS = [choosePlanTool, acceptDpaTool] as const;
