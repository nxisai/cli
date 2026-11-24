/**
 * The checks `nxis mcp serve` makes before a call that spends credits or changes what the public
 * sees.
 *
 * @remarks
 * In a terminal, `nxis autofill submit` and `nxis publish` ask before they act. Over `mcp serve`
 * the agent makes the call, and an agent can be talked into one by text it reads along the way: a
 * crawled page, or a query result. So the server asks the person itself, over MCP elicitation,
 * for the calls where a mistake costs money, makes data live or public, or sends the site's form
 * submissions somewhere else:
 *
 * - `nxis_bulk_autofill` with mode `submit`: spends credits. Before it is asked about, the
 *   organization's real balance is read: used up, or short of the plan's estimate, the user is
 *   offered the credit packs, and the call waits for the payment; a used-up balance nobody can
 *   top up stops the call with `credits_exhausted`.
 * - `nxis_publish_entities` unless `dry_run`: makes generated data live.
 * - `nxis_enable_public_mcp` turning the server on: anyone can query the site's data.
 * - `nxis_bind_mcp_action` with a webhook: the site's form submissions go to that URL.
 * - `nxis_list_in_app` listing the site, unless `preview`: people in the NxisAI app can find it.
 * - `nxis_create_connection`: a new address requests can be sent to, maybe the site default.
 * - `nxis_rotate_connection_secret`: the current secret stops working for everyone using it.
 * - `nxis_delete_connection`: it can't be undone.
 * - `nxis_bind_connection`: a route's requests go to the connection's address.
 * - `nxis_create_org`: it makes an account record (or names the placeholder a browser sign-up left).
 * - `nxis_enable_agent`: the agent answers the site's visitors. Before it is asked about, the
 *   user chooses the connection it sends through (when it needs one and none is given) and is
 *   offered the data processing agreement (when the agents wait on it).
 * - `nxis_configure_agent` on an agent that is on: visitors see the change. An agent that is off
 *   is changed unasked.
 * - `nxis_disable_agent`, `nxis_resume_agents` and `nxis_agents_brand`: what visitors meet changes.
 *   A pause (`nxis_pause_agents`) is never asked about: it is the safe direction.
 *
 * The question names what is at stake: the plan's count and price, how many records would go
 * live, the webhook's host, the site. Only an explicit accept, with the box ticked, lets the call
 * through. A client that cannot ask (it does not declare elicitation) gets a refusal, unless the
 * server was started with `--allow-unconfirmed`; the tools' names and schemas stay the server's,
 * so nothing is added to a call to carry a confirmation.
 */

import type { ElicitRequestFormParams } from "@modelcontextprotocol/sdk/types.js";
import type { Ctx } from "../context.js";
import { requireOrg, withSite } from "../context.js";
import { needsUser } from "../errors.js";
import { plainText } from "../output.js";
import { isDryRun } from "../trace.js";
import type { ToolCaller, ToolDef } from "../tools/define.js";
import { bulkAutofill, publishEntities, type SiteSummary } from "../tools/provisioning.js";
import { findSite, hostOf } from "../tools/sites.js";
import { estimateMilli, planLines, planShape, type Existing } from "./autofill.js";
import { noGuide, refused, type Guide } from "../guide.js";
import { checkCredits, readBalanceMilli } from "../guided/credits.js";
import { chooseScope, siteClusters } from "../guided/scope.js";
import { prepareAgentCall, type AgentPrep, type AgentRiskKind } from "../guided/agents.js";

/** The kinds of call that need a person's yes. */
export type RiskKind =
  | "autofill_submit"
  | "publish"
  | "public_on"
  | "webhook"
  | "app_listing"
  | "connection_create"
  | "connection_rotate"
  | "connection_delete"
  | "connection_route"
  | "org_create"
  | AgentRiskKind;

/** @returns True for the hosted agent calls. */
function isAgentRisk(kind: RiskKind): kind is AgentRiskKind {
  return kind.startsWith("agent_");
}

/** @returns What makes this call risky, or null for one that needs no confirmation. */
export function riskOf(tool: Pick<ToolDef, "name">, args: Record<string, unknown>): RiskKind | null {
  switch (tool.name) {
    case "nxis_bulk_autofill":
      return args["mode"] === "submit" ? "autofill_submit" : null;
    case "nxis_publish_entities":
      return args["dry_run"] === true ? null : "publish";
    case "nxis_enable_public_mcp":
      return args["enabled"] === false ? null : "public_on";
    case "nxis_bind_mcp_action":
      // A webhook URL is only used with the webhook route, but a call naming one is asked about either way.
      return args["route"] === "webhook" || typeof args["webhook_url"] === "string" ? "webhook" : null;
    case "nxis_list_in_app":
      // Removing the site from the app only reduces who can reach it, like turning public MCP off.
      return args["preview"] === true || args["listed"] === false ? null : "app_listing";
    case "nxis_create_connection":
      return "connection_create";
    case "nxis_rotate_connection_secret":
      return "connection_rotate";
    case "nxis_delete_connection":
      return "connection_delete";
    case "nxis_bind_connection":
      return "connection_route";
    case "nxis_create_org":
      return "org_create";
    case "nxis_enable_agent":
      return "agent_enable";
    case "nxis_configure_agent":
      return "agent_configure";
    case "nxis_disable_agent":
      return "agent_disable";
    case "nxis_resume_agents":
      return "agent_resume";
    case "nxis_agents_brand":
      return "agent_brand";
    default:
      return null;
  }
}

/** The CLI command that does the same thing in a terminal, run by the person themselves. */
const TERMINAL_COMMAND: Record<RiskKind, string> = {
  autofill_submit: "nxis autofill submit",
  publish: "nxis publish",
  public_on: "nxis mcp public on",
  webhook: "nxis actions bind",
  app_listing: "nxis sites list-in-app",
  connection_create: "nxis connections create",
  connection_rotate: "nxis connections rotate",
  connection_delete: "nxis connections delete",
  connection_route: "nxis actions bind",
  org_create: "nxis orgs create",
  agent_enable: "nxis agents enable",
  agent_configure: "nxis agents configure",
  agent_disable: "nxis agents disable",
  agent_resume: "nxis agents resume",
  agent_brand: "nxis agents brand",
};

/** @returns The terminal command for this call: the agent's id after an agent command. */
function terminalCommandOf(kind: RiskKind, args: Record<string, unknown>): string {
  const agent = typeof args["agent"] === "string" ? clean(args["agent"].trim()) : "";
  return isAgentRisk(kind) && agent && /^[a-z0-9_-]+$/i.test(agent) ? `${TERMINAL_COMMAND[kind]} ${agent}` : TERMINAL_COMMAND[kind];
}

/** What the person is asked: the question, and the facts it names. */
export interface Confirmation {
  kind: RiskKind;
  /** The question, in lines a person reads. */
  message: string;
  /** The same facts, for the refusal's JSON. */
  details: Record<string, unknown>;
}

/** @returns A line from a server made safe to show: no escape sequences, no control characters. */
function clean(line: string): string {
  // eslint-disable-next-line no-control-regex
  return plainText(line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ""));
}

/** @returns The webhook URL's host, or the URL itself, cleaned, when it has none. */
export function webhookHost(url: unknown): string {
  if (typeof url !== "string" || !url.trim()) return "(no URL given)";
  try {
    return new URL(url).host || clean(url).slice(0, 200);
  } catch {
    return hostOf(url) ?? clean(url).slice(0, 200);
  }
}

/**
 * Builds the question for a risky call, reading what it needs first.
 *
 * @remarks
 * Reads only: `nxis_list_sites` for the site's host, a `plan` for a submit, a `dry_run` for a
 * publish. A read that fails fails the call, before anything is asked or written.
 */
export async function describeRisk(
  ctx: Ctx,
  kind: RiskKind,
  args: Record<string, unknown>,
  provisioning: ToolCaller,
  /** A submit's plan, when already read. */
  readPlan: ReturnType<typeof planShape> | null = null,
  /** An agent call's question, when already read. */
  agentPrep: AgentPrep | null = null,
): Promise<Confirmation> {
  // An organization has no site, and may be the first thing there is.
  if (kind === "org_create") return describeOrgCreate(ctx, args);
  const filled = withSite(ctx, args, { required: true });
  const site: SiteSummary = await findSite(ctx, filled.site as string, provisioning);
  const siteId = site.site ?? (filled.site as string);
  const host = clean(site.host ?? site.domain ?? siteId);
  const sent: Record<string, unknown> = { ...args, site: siteId };
  const base = { tool_kind: kind, site: siteId, host };

  if (isAgentRisk(kind)) {
    const prep = agentPrep ?? (await prepareAgentCall(ctx, kind, args, null));
    const c = prep.describe(host);
    return { kind, message: c.message, details: { ...base, ...c.details } };
  }

  switch (kind) {
    case "autofill_submit": {
      const plan = readPlan ?? (await submitPlan(ctx, args, siteId, host, provisioning));
      const balance = await readBalanceMilli(ctx, requireOrg(ctx));
      const count = plan.planned_count === null ? "an unknown number of" : plan.planned_count.toLocaleString("en-US");
      return {
        kind,
        message: [
          `Start an autofill batch on ${host}? It spends credits.`,
          ...planLines(plan, balance).map((line) => clean(line)),
          `Submit ${count} resource${plan.planned_count === 1 ? "" : "s"}?`,
        ].join("\n"),
        details: { ...base, plan, balance_milli: balance },
      };
    }
    case "publish": {
      const { dry_run: _dry, ...rest } = sent;
      const out = await publishEntities.run(ctx, { ...rest, dry_run: true } as never, { provisioning });
      const count = out.data?.published_count;
      const type = typeof args["schema_type"] === "string" ? clean(args["schema_type"]) : null;
      const what = `${typeof count === "number" ? count.toLocaleString("en-US") : "every"} draft ${type ?? ""} record${count === 1 ? "" : "s"}`.replace(/\s+/g, " ");
      return {
        kind,
        message: `Publish ${what} on ${host}? Published data is served to anyone who queries the site.`,
        details: { ...base, would_publish: typeof count === "number" ? count : null, schema_type: type },
      };
    }
    case "public_on":
      return {
        kind,
        message:
          `Make the MCP server of ${host} public? Anyone, and any agent, can then query the site's published ` +
          "structured data without a key.",
        details: base,
      };
    case "webhook": {
      const target = webhookHost(args["webhook_url"]);
      const action = typeof args["action"] === "string" ? `${clean(args["action"])} submissions` : "every action's submissions";
      return {
        kind,
        message:
          `Send ${action} from ${host} to a webhook at ${target}? The site's visitors' form submissions, ` +
          `with what they enter, will be posted there. Accept only if ${target} is yours or one you trust.`,
        details: { ...base, webhook_host: target },
      };
    }
    case "app_listing":
      return {
        kind,
        message:
          `List ${host} in the NxisAI app for Claude and ChatGPT? People there can find it, browse its records ` +
          "and act on it, and its WebSite record is published.",
        details: { ...base, listed: true },
      };
    case "connection_create": {
      const target = webhookHost(args["url"]);
      const name = clean(String(args["name"] ?? ""));
      return {
        kind,
        message:
          `Create the connection "${name}" on ${host}, sending to ${target}? It gets a new signing secret, returned ` +
          "once in the result." +
          (args["make_default"] === true
            ? ` It becomes the site's default: every action and agent without a connection of its own sends to ${target}.`
            : "") +
          ` Accept only if ${target} is yours or one you trust.`,
        details: { ...base, connection: name, webhook_host: target, make_default: args["make_default"] === true },
      };
    }
    case "connection_rotate":
    case "connection_delete":
    case "connection_route": {
      const [{ listConnections }, { resolveConnection, usageWords }, { getAccessToken }] = await Promise.all([
        import("../api/connections.js"),
        import("./connections.js"),
        import("../auth.js"),
      ]);
      const orgId = requireOrg(ctx);
      const token = await getAccessToken(ctx.config);
      const list = await listConnections({ config: ctx.config, token, orgId, siteId });
      const c = resolveConnection(list, typeof args["connection"] === "string" ? args["connection"] : "", siteId);
      const name = clean(c.name);
      const target = webhookHost(c.url);
      const used = clean(usageWords(c));
      const details = { ...base, connection: name, connection_id: c.id, webhook_host: target };
      if (kind === "connection_rotate") {
        return {
          kind,
          message:
            `Issue a new signing secret for the connection "${name}" (${target}) on ${host}? The current secret stops ` +
            `working at once, so requests to ${target} fail their signature check until the receiving application ` +
            `has the new one. Used by ${used}.`,
          details: { ...details, used_by: used },
        };
      }
      if (kind === "connection_delete") {
        return {
          kind,
          message: `Delete the connection "${name}" (${target}) from ${host}? This can't be undone. Used by ${used}.`,
          details: { ...details, used_by: used },
        };
      }
      const action = clean(String(args["action"] ?? "default"));
      const what =
        action === "default"
          ? "every action's requests"
          : action === "booking"
            ? "the Booking agent's requests"
            : `${action} submissions`;
      return {
        kind,
        message:
          `Send ${what} from ${host} through the connection "${name}" to ${target}? The site's visitors' requests, ` +
          `with what they enter, will be posted there. Accept only if ${target} is yours or one you trust.`,
        details: { ...details, action },
      };
    }
  }
}

/** The question before `nxis_create_org`: the name, and the placeholder it would reuse, if any. */
async function describeOrgCreate(ctx: Ctx, args: Record<string, unknown>): Promise<Confirmation> {
  const [{ requireSession }, { listOrganizations }, { isStub }] = await Promise.all([
    import("../context.js"),
    import("../api/accounts.js"),
    import("./orgs.js"),
  ]);
  const { token, accountId } = await requireSession(ctx);
  const stub = (await listOrganizations(ctx.config, token, accountId)).find(isStub);
  const name = clean(String(args["name"] ?? "")).slice(0, 200);
  const extra = [
    typeof args["website"] === "string" ? `website ${webhookHost(args["website"])}` : "",
    typeof args["industry"] === "string" ? `industry "${clean(args["industry"]).slice(0, 200)}"` : "",
  ].filter(Boolean);
  return {
    kind: "org_create",
    message:
      (stub
        ? `Name your unnamed NxisAI organization (${stub.id}, left by a sign-up in the browser) "${name}"`
        : `Create the NxisAI organization "${name}" in your account`) +
      (extra.length ? `, with ${extra.join(" and ")}` : "") +
      "? It becomes the organization this server and the CLI act on.",
    details: { tool_kind: "org_create", name, reuses_org_id: stub?.id ?? null },
  };
}

/** @returns The plan a submit with these arguments would run, read with `mode: plan` (a read). */
async function submitPlan(
  ctx: Ctx,
  args: Record<string, unknown>,
  siteId: string,
  host: string,
  provisioning: ToolCaller,
): Promise<ReturnType<typeof planShape>> {
  const { mode: _mode, batch_id: _batch, ...scope }: Record<string, unknown> = { ...args, site: siteId };
  const out = await bulkAutofill.run(ctx, { ...scope, mode: "plan" } as never, { provisioning });
  return planShape(
    { siteId, host },
    {
      // The tool's own default, which differs from the terminal command's.
      existing: ((args["existing"] as Existing | undefined) ?? "generate"),
      ...(typeof args["media_type"] === "string" ? { mediaType: args["media_type"] } : {}),
      ...(typeof args["pattern"] === "string" ? { pattern: args["pattern"] } : {}),
    },
    out.data ?? {},
  );
}

/**
 * Before a submit that names no scope: the site's path clusters, with counts, beside all pages.
 *
 * @returns The arguments with the chosen cluster's `pattern`, or as they were for all pages (or
 * when the site has no clusters to choose from).
 * @throws CliError the guide's stop when the user chooses none.
 */
async function scopeBeforeSubmit(
  ctx: Ctx,
  args: Record<string, unknown>,
  provisioning: ToolCaller,
  guide: Guide,
): Promise<Record<string, unknown>> {
  if (typeof args["pattern"] === "string" || typeof args["media_type"] === "string") return args;
  const filled = withSite(ctx, args, { required: true });
  const site = await findSite(ctx, filled.site as string, provisioning);
  const siteId = site.site ?? (filled.site as string);
  const host = clean(site.host ?? site.domain ?? siteId);
  const found = await siteClusters(ctx, requireOrg(ctx), siteId);
  if (found.length === 0) return args;
  const all = await submitPlan(ctx, args, siteId, host, provisioning);
  const picked = await chooseScope(guide, { host, allCount: all.planned_count, perPageMilli: all.import_cost_per_resource_milli }, found);
  if (!picked.ok) {
    throw refused(guide, picked.why, "Nothing was submitted.", { tool_kind: "autofill_submit", site: siteId, host });
  }
  return picked.value ? { ...args, pattern: picked.value } : args;
}

/**
 * Before a submit: the organization's real balance against the plan's estimate. Short or used
 * up, the user is offered the credit packs through the agent and the call waits for the payment;
 * a used-up balance nobody can top up stops the call with `credits_exhausted`.
 */
async function creditsBeforeSubmit(
  ctx: Ctx,
  args: Record<string, unknown>,
  provisioning: ToolCaller,
  guide: Guide,
  opts: { planWithoutBalance: boolean },
): Promise<ReturnType<typeof planShape> | null> {
  // With no balance to read, only the plan's own quota_exceeded is left to go by.
  if (!opts.planWithoutBalance && (await readBalanceMilli(ctx, requireOrg(ctx))) === null) return null;
  const filled = withSite(ctx, args, { required: true });
  const site = await findSite(ctx, filled.site as string, provisioning);
  const siteId = site.site ?? (filled.site as string);
  const host = clean(site.host ?? site.domain ?? siteId);
  const plan = await submitPlan(ctx, args, siteId, host, provisioning);
  await checkCredits(ctx, guide, {
    orgId: requireOrg(ctx),
    host,
    estimateMilli: estimateMilli(plan),
    planQuotaExceeded: plan.quota_exceeded,
    details: { tool_kind: "autofill_submit", site: siteId, host, plan },
  });
  return plan;
}

/** How a person answered, as the elicitation result says. */
export type Answer = "accept" | "decline" | "cancel";

/** Asks the person, and returns their answer. */
export type Ask = (params: ElicitRequestFormParams) => Promise<{ action: Answer; content?: Record<string, unknown> }>;

/** How the server confirms risky calls. */
export interface GuardOptions {
  /** `--read-only`: refuse every call that may write. */
  readOnly?: boolean;
  /** `--allow-unconfirmed`: run a risky call unasked when the client cannot ask the person. */
  allowUnconfirmed?: boolean;
}

/** The form the person answers: one box, which has to be ticked. */
export function confirmationForm(c: Confirmation): ElicitRequestFormParams {
  return {
    mode: "form",
    message: c.message,
    requestedSchema: {
      type: "object",
      properties: {
        confirm: {
          type: "boolean",
          title: "Yes, go ahead",
          description: "Tick to confirm. Declining, or leaving this unticked, changes nothing.",
        },
      },
      required: ["confirm"],
    },
  };
}

/**
 * Asks the person about a risky call, or refuses it.
 *
 * @param ask - Asks over elicitation; null when the client cannot.
 * @returns When the call may go ahead, with the arguments to run it with: a submit with no scope
 * carries the path cluster the user chose.
 * @throws CliError `declined_by_user` or `cancelled_by_user` (exit 2) for any answer but an
 * accept with the box ticked; `confirmation_unavailable` (exit 2) when nobody can be asked and
 * `--allow-unconfirmed` was not given; `confirmation_failed` (exit 2) when asking failed.
 */
export async function confirmRisky(
  ctx: Ctx,
  kind: RiskKind,
  args: Record<string, unknown>,
  provisioning: ToolCaller,
  ask: Ask | null,
  opts: GuardOptions,
): Promise<{ asked: boolean; args?: Record<string, unknown> }> {
  // A dry run withholds the write, so there is nothing to agree to.
  if (isDryRun()) return { asked: false };
  const guide = ctx.guide ?? noGuide("agent");
  // A submit with no scope: the user picks the pages first. The call then runs with their choice.
  if (kind === "autofill_submit" && ask) args = await scopeBeforeSubmit(ctx, args, provisioning, guide);
  // Never a batch into a used-up balance; one that falls short is offered the packs first.
  let plan: ReturnType<typeof planShape> | null = null;
  if (kind === "autofill_submit" && (ask || opts.allowUnconfirmed)) {
    plan = await creditsBeforeSubmit(ctx, args, provisioning, ask ? guide : noGuide("agent"), { planWithoutBalance: Boolean(ask) });
  }
  // An agent call: its arguments checked, and for an enable, the connection and agreement put to the user.
  let agentPrep: AgentPrep | null = null;
  if (isAgentRisk(kind)) {
    agentPrep = await prepareAgentCall(ctx, kind, args, ask ? guide : null);
    args = agentPrep.args;
    if (agentPrep.skip) return { asked: false, args };
  }
  if (!ask && opts.allowUnconfirmed) return { asked: false, args };

  const c = await describeRisk(ctx, kind, args, provisioning, plan, agentPrep);
  const terminal = terminalCommandOf(kind, args);

  if (!ask) {
    throw needsUser(
      `This call needs the user's confirmation, and this MCP client cannot ask for it (it does not support ` +
        `elicitation). Nothing was done. Show the user what it would do, and ask them to run \`${terminal}\` in ` +
        "a terminal themselves; or, if they accept approving such calls in the client alone, to restart this " +
        "server with `nxis mcp serve --allow-unconfirmed`.",
      "confirmation_unavailable",
      { ...c.details, would_do: c.message, terminal_command: terminal },
    );
  }

  let answer: Awaited<ReturnType<Ask>>;
  try {
    answer = await ask(confirmationForm(c));
  } catch (err) {
    throw needsUser(
      `The user could not be asked to confirm this call (${(err as Error)?.message ?? String(err)}). Nothing was ` +
        `done. They can run \`${terminal}\` in a terminal instead.`,
      "confirmation_failed",
      { ...c.details, would_do: c.message, terminal_command: terminal },
    );
  }

  if (answer.action === "accept" && answer.content?.["confirm"] === true) return { asked: true, args };
  const cancelled = answer.action === "cancel";
  throw needsUser(
    cancelled
      ? "The user dismissed the confirmation, so nothing was done. Do not repeat the call unless they ask you to."
      : "The user declined, so nothing was done. Do not repeat the call unless they ask you to.",
    cancelled ? "cancelled_by_user" : "declined_by_user",
    { ...c.details, would_do: c.message },
  );
}

/**
 * Refuses a call that may write, for `--read-only`.
 *
 * @throws CliError `read_only_server` (exit 2).
 */
export function refuseWrite(tool: Pick<ToolDef, "name">): never {
  throw needsUser(
    `${tool.name} with these arguments may change something, and this server was started with --read-only, so ` +
      "nothing was sent. Calls that only read (a plan, a status, a preview, a dry run) still work.",
    "read_only_server",
    { tool: tool.name },
  );
}
