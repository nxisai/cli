/**
 * The organization tools, which the CLI answers itself (surface `local`) over the accounts API.
 *
 * @remarks
 * They do what `nxis orgs list|use|create` do, through the same operations, so a guided run that
 * starts from a fresh sign-in needs no shell step to pick or make the organization. The choice is
 * saved as the CLI's current organization, which `nxis mcp serve` reads on every call: the next
 * call acts on it, with no restart. A server started with `--org` keeps acting on that one, so
 * `nxis_use_org` refuses to switch it (`org_pinned`) rather than appear to.
 *
 * Creating one makes an account record, so `nxis mcp serve` confirms it with the user first.
 */

import { z } from "zod";
import type { Ctx } from "../context.js";
import { needsUser } from "../errors.js";
import { defineLocalTool } from "./define.js";

type Result = Record<string, unknown>;

const ops = () => import("../commands/orgs.js");

/** @throws CliError `org_pinned` (exit 2) when the server acts on `--org`, and `org` is another. */
function checkNotPinned(ctx: Ctx, org: string | null): void {
  const pinned = ctx.orgOverride;
  if (pinned && org !== pinned) {
    throw needsUser(
      `This server was started with --org ${pinned}, so it keeps acting on that organization. To act on another, ` +
        "the user restarts it without --org (or with the other one) in the agent's MCP config.",
      "org_pinned",
      { pinned_org_id: pinned, ...(org ? { org_id: org } : {}) },
    );
  }
}

export const listOrgsTool = defineLocalTool<Result>()({
  name: "nxis_list_orgs",
  description:
    "List the user's NxisAI organizations, with current_org_id: the one this server's calls act on. Read-only. " +
    "Call it first in a guided setup; with none, nxis_create_org makes one, and nxis_use_org picks another.",
  input: z.strictObject({}),
  takesSite: false,
  readOnly: true,
  hints: { openWorld: false },
  async call(ctx) {
    const { orgsListOp } = await ops();
    return orgsListOp(ctx);
  },
});

export const useOrgTool = defineLocalTool<Result>()({
  name: "nxis_use_org",
  description:
    "Make one of the user's organizations the current one, by id or by its exact name: this server's later calls " +
    "act on it at once, and so does the CLI. Changes nothing in the account. Use the organization the user chose.",
  input: z.strictObject({
    org: z.string().trim().min(1).max(200).describe("The organization's id, or its exact name (any case) when only one has it."),
  }),
  takesSite: false,
  readOnly: false,
  // Saves a local choice only.
  hints: { destructive: false, idempotent: true, openWorld: false },
  async call(ctx, args) {
    const { orgsUseOp } = await ops();
    if (ctx.orgOverride) {
      // The id the name means, to tell a no-op from a switch.
      const { orgsListOp } = await ops();
      const wanted = args.org.trim().toLowerCase();
      const found = (await orgsListOp(ctx)).orgs.find((o) => o.id === args.org.trim() || (o.name ?? "").trim().toLowerCase() === wanted);
      checkNotPinned(ctx, found?.id ?? args.org.trim());
    }
    return orgsUseOp(ctx, args.org);
  },
});

export const createOrgTool = defineLocalTool<Result>()({
  name: "nxis_create_org",
  description:
    "Create the user's NxisAI organization, named as they say, and make it the current one; this server's later calls " +
    "act on it at once. An unnamed organization left by a sign-up in the browser is reused and named instead " +
    "(reused: true), so the account ends up with one. The server confirms with the user first. Call nxis_list_orgs " +
    "first: don't create one the user already has.",
  input: z.strictObject({
    name: z.string().trim().min(1).max(200).describe("The organization's name, as the user gave it."),
    website: z.string().trim().min(1).max(500).describe("The organization's website.").optional(),
    industry: z.string().trim().min(1).max(200).describe("The organization's industry.").optional(),
  }),
  takesSite: false,
  readOnly: false,
  // Adds an account record (or names a placeholder).
  hints: { destructive: false, idempotent: false, openWorld: false },
  async call(ctx, args) {
    const { orgsCreateOp } = await ops();
    const out = await orgsCreateOp(ctx, args);
    // Saved as current; a server pinned with --org keeps acting on its own, and says so.
    return ctx.orgOverride && ctx.orgOverride !== out.org_id
      ? { ...out, pinned_org_id: ctx.orgOverride, note: `This server keeps acting on ${ctx.orgOverride} (--org) until it is restarted without --org.` }
      : out;
  },
});

/** Every organization tool, in the order a guided setup uses them. */
export const ORG_TOOLS = [listOrgsTool, useOrgTool, createOrgTool] as const;
