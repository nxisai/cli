/**
 * The hosted agents, through `nxis mcp serve`: what the agent tools run, the next step each
 * refusal or state points to, and what the server asks the user before turning an agent on.
 *
 * @remarks
 * Every tool runs the same code as its `nxis agents` command and returns the object that
 * command's `--json` prints, so a terminal and an agent see the same facts. Settings come by name
 * (`{ "label": "Help desk" }`) rather than as flags, and are checked against the agent's own setup
 * with the same rules and reasons as the flags.
 *
 * What differs is `next`: a tool result says the next step as the tool call that takes it
 * (`nxis_accept_dpa`, `nxis_enable_agent` with `connection` …), where the command says the command.
 *
 * Before an enable, when the user can be asked, the server puts the decisions that are theirs to
 * them, in the order the enable needs them: which of the site's connections the agent sends
 * through (or none yet, to create one first), then the data processing agreement, as
 * `nxis agents enable` offers it on a terminal. Only then is the enable itself confirmed.
 */

import type { HostedAgentView, SiteRef } from "../api/hosted-agents.js";
import { listConnections } from "../api/connections.js";
import { dpaBaseUrl, dpaUrl, getAgentSetup } from "../api/agent-setup.js";
import { Flags } from "../args.js";
import type { Ctx } from "../context.js";
import { CliError, failed, needsUser } from "../errors.js";
import type { Io } from "../output.js";
import { plainText } from "../output.js";
import { refused, type Guide } from "../guide.js";
import { settingsFromValues, type SettingValue } from "../commands/agent-settings.js";
import type { BrandArgs, BrandField } from "../commands/hosted-agents.js";

type Result = Record<string, unknown>;

/** How the tools name an agent nobody knows, in a refusal. */
const FALLBACK = { unknownReason: "unknown_agent", usage: "nxis_agents_catalog lists the agents by id" } as const;

/** @returns The context, for the site the tool names (or the CLI's own). */
function scoped(ctx: Ctx, site: string | undefined): Ctx {
  return site?.trim() ? { ...ctx, siteOverride: site.trim() } : ctx;
}

/**
 * Runs a command and returns the object it emits, its `--json` result, instead of printing it.
 *
 * @throws CliError `bad_response` when the command emits nothing; what the command throws, with
 * `next` added to its details where there is a step that meets it.
 */
async function emitted(ctx: Ctx, agent: string | null, run: (ctx: Ctx) => Promise<void>): Promise<Result> {
  let payload: Result | null = null;
  const io: Io = { json: true, note: ctx.io.note, emit: (p) => void (payload = p) };
  try {
    await run({ ...ctx, io });
  } catch (err) {
    throw withNext(err, agent);
  }
  if (!payload) throw failed("The command finished without a result.", "bad_response");
  return payload;
}

/** @returns The error with `next` in its details, for a refusal that has a step meeting it. */
function withNext(err: unknown, agent: string | null): unknown {
  if (!(err instanceof CliError) || err.details["next"] !== undefined) return err;
  const next = nextFor(err.reason, agent ?? "", err.details);
  if (!next) return err;
  return new CliError(err.message, { exitCode: err.exitCode, reason: err.reason, details: { ...err.details, next } });
}

/** @returns `"A", "B"`, for a message. */
function quoted(names: unknown): string {
  return Array.isArray(names) ? names.map((n) => `"${plainText(String(n))}"`).join(", ") : "";
}

/** The step for a site with no connection yet: the user names the address; the agent never invents one. */
const CREATE_CONNECTION =
  "Ask the user for the https address of the receiver on their own servers, create a connection there with " +
  "nxis_create_connection (pass write_env so the signing secret goes straight into their app's env file), then " +
  "call nxis_enable_agent again with connection set to it.";

/**
 * The next step for a refusal or an agent's state, as the tool call that takes it.
 *
 * @param reason - A refusal's reason, or an agent's `state_reason`.
 * @returns Null when there is no step to take.
 */
export function nextFor(reason: string, agent: string, details: Record<string, unknown> = {}): string | null {
  const id = agent ? `"${plainText(agent)}"` : "the agent";
  const settings = `nxis_agents_catalog with agent ${id} lists its settings, their limits and allowed values.`;
  switch (reason) {
    case "connection_required": {
      const names = Array.isArray(details["connections"]) ? (details["connections"] as unknown[]) : [];
      return names.length > 0
        ? `Call nxis_enable_agent again with connection set to one of the site's connections: ${quoted(names)}. Ask the user which, or create a new one at an address they give.`
        : CREATE_CONNECTION;
    }
    case "connection_not_found":
      return "nxis_list_connections shows the site's connections; call nxis_enable_agent again with one of them.";
    case "connection_unusable":
      return "Check the connection with nxis_test_connection, or call nxis_enable_agent again with another connection.";
    case "actions_off":
      return "Turn the site's actions on with nxis_bind_mcp_action, sending only enabled: true (the routes are kept), then call nxis_enable_agent again.";
    case "records_missing": {
      const types = Array.isArray(details["types"]) && details["types"].length ? ` (${(details["types"] as unknown[]).map((t) => plainText(String(t))).join(", ")})` : "";
      return (
        `The agent needs records on the site${types}: crawl it (nxis_crawl_sitemap), fill the records in ` +
        "(nxis_bulk_autofill, with the user's consent) and publish them (nxis_publish_entities), then call nxis_enable_agent again."
      );
    }
    case "opening_hours_required":
      return "Add the business's opening hours to its published records (nxis_bulk_autofill, then nxis_publish_entities), or choose an availability setting that doesn't need them, then call nxis_enable_agent again.";
    case "dpa_not_accepted":
      return "The agent answers visitors once the data processing agreement is accepted: nxis_accept_dpa puts it to the user.";
    case "dpa_not_published":
      return "Going live waits for NxisAI to publish its data processing agreement; the agent answers visitors once it is accepted.";
    case "site_not_verified":
      return "Verify the site: nxis_verify_site with mode token, deploy the tag, then mode check.";
    case "mcp_server_not_set_up":
      return "Set up the site's MCP server, which this agent answers from: nxis_mcp_settings shows it, and nxis_enable_public_mcp turns it on.";
    case "preview":
      return "The site is in preview: the user goes live from the dashboard's Agents page.";
    case "agent_paused":
      return `It is paused on its own: nxis_resume_agents with agent ${id} resumes it.`;
    case "site_paused":
      return "Every hosted agent on the site is paused: nxis_resume_agents with no agent resumes them.";
    case "unknown_agent":
      return "nxis_agents_catalog lists the agents by id.";
    case "connection_not_taken":
      return `${settings} This agent sends no requests, so leave connection out.`;
    case "agent_not_hosted":
      return "NxisAI doesn't host this agent yet; nxis_agents_catalog shows which agents are available.";
    case "hosted_agents_unavailable":
      return "This NxisAI environment can't turn this agent on from here yet: the user can use the dashboard's Agents page.";
    case "agent_not_pausable":
      return "nxis_pause_agents with no agent pauses every hosted agent on the site.";
    case "version_conflict":
      return "The settings were changed by someone else meanwhile: call the tool again.";
    case "unknown_setting":
    case "conflicting_settings":
    case "missing_settings":
    case "model_retired":
    case "invalid_input":
      return settings;
    default:
      if (/^(invalid|missing)_|_too_long$|^too_many_/.test(reason) && (details["setting"] !== undefined || details["field"] !== undefined)) return settings;
      return null;
  }
}

/**
 * Puts `next` on a write's result as the tool call that takes it, from the agent's state.
 *
 * @remarks
 * The command's own `next` names commands; a tool result names tools. Nothing holds the agent
 * back: no `next`.
 */
function withStateNext(out: Result): Result {
  const { next: _command, ...rest } = out;
  const agent = rest["agent"] as Record<string, unknown> | undefined;
  const reason = typeof agent?.["state_reason"] === "string" ? (agent["state_reason"] as string) : "";
  const state = agent?.["state"];
  if (!agent || agent["enabled"] !== true || state === "live" || state === "off" || !state) return rest;
  const next = nextFor(reason, String(agent["id"] ?? ""), {}) ?? (typeof agent["state_message"] === "string" ? plainText(agent["state_message"]) : null);
  return next ? { ...rest, next } : rest;
}

const ops = () => import("../commands/agents-by-id.js");
const legacyOps = () => import("../commands/hosted-agents.js");

/** @returns Settings by name as the shared checks read them. */
function fromValues(values: Record<string, SettingValue> | undefined, clear: string[] = []) {
  return (setup: Parameters<typeof settingsFromValues>[0], stored: Record<string, unknown>, allowHttp: boolean) =>
    settingsFromValues(setup, values ?? {}, { stored, allowHttp, clear });
}

/** `nxis_agents_status`: `nxis agents status --json`. */
export async function agentsStatusOp(ctx: Ctx, site?: string): Promise<Result> {
  const { cmdAgentsStatus } = await legacyOps();
  return emitted(scoped(ctx, site), null, cmdAgentsStatus);
}

/** Filters for {@link agentsCatalogOp}. */
export interface CatalogArgs {
  site?: string | undefined;
  agent?: string | undefined;
  job?: string[] | undefined;
  industry?: string[] | undefined;
  readiness?: string[] | undefined;
  added?: boolean | undefined;
  query?: string | undefined;
  by_fit?: boolean | undefined;
}

/**
 * `nxis_agents_catalog`: `nxis agents catalog [<id>] --json`.
 *
 * @remarks
 * One agent's result adds `unmet`, the ids of the prerequisites not met, and `enable_with`, the
 * shortest `nxis_enable_agent` arguments that turn it on: its required settings (to fill in) and a
 * connection, when it sends requests through one.
 */
export async function agentsCatalogOp(ctx: Ctx, args: CatalogArgs): Promise<Result> {
  const { cmdAgentsCatalog, cmdAgentsCatalogEntry } = await ops();
  const c = scoped(ctx, args.site);
  if (args.agent !== undefined) {
    const id = args.agent.trim();
    const out = await emitted(c, id, (x) => cmdAgentsCatalogEntry(x, id));
    const flags = Array.isArray(out["flags"]) ? (out["flags"] as Array<Record<string, unknown>>) : [];
    const prerequisites = Array.isArray(out["prerequisites"]) ? (out["prerequisites"] as Array<Record<string, unknown>>) : [];
    const needsConnection = prerequisites.some((p) => p["kind"] === "connection");
    const required = Object.fromEntries(flags.filter((f) => f["required"] === true).map((f) => [String(f["setting"]), `<${String(f["label"] ?? f["setting"])}>`]));
    return {
      ...out,
      unmet: prerequisites.filter((p) => p["met"] === false).map((p) => p["id"]),
      ...(out["hosted"] === true
        ? { enable_with: { agent: id, ...(Object.keys(required).length ? { settings: required } : {}), ...(needsConnection ? { connection: "<name|id>" } : {}) } }
        : {}),
    };
  }
  const flags = new Flags();
  for (const j of args.job ?? []) flags.add("job", j);
  for (const i of args.industry ?? []) flags.add("industry", i);
  for (const r of args.readiness ?? []) flags.add("readiness", r);
  if (args.added === true) flags.add("added", true);
  if (args.added === false) flags.add("not-added", true);
  if (args.query !== undefined) flags.add("query", args.query);
  if (args.by_fit === true) flags.add("by-fit", true);
  return emitted(c, null, (x) => cmdAgentsCatalog(x, flags));
}

/** Arguments for {@link enableAgentOp}. */
export interface EnableArgs {
  site?: string | undefined;
  agent: string;
  settings?: Record<string, SettingValue> | undefined;
  connection?: string | undefined;
}

/** `nxis_enable_agent`: `nxis agents enable <id> --json`, with settings by name. */
export async function enableAgentOp(ctx: Ctx, args: EnableArgs): Promise<Result> {
  const { enableAgent } = await ops();
  const id = args.agent.trim();
  const connection = args.connection?.trim() || undefined;
  return withStateNext(
    await emitted(scoped(ctx, args.site), id, (x) =>
      enableAgent(x, id, { settings: fromValues(args.settings), connection, naming: "settings" }, FALLBACK),
    ),
  );
}

/** Arguments for {@link configureAgentOp}. */
export interface ConfigureArgs {
  site?: string | undefined;
  agent: string;
  settings?: Record<string, SettingValue> | undefined;
  clear?: string[] | undefined;
}

/**
 * `nxis_configure_agent`: `nxis agents configure <id> --json`, with settings by name.
 *
 * @throws CliError `missing_settings` (exit 1) when neither settings nor clear is given.
 */
export async function configureAgentOp(ctx: Ctx, args: ConfigureArgs): Promise<Result> {
  const id = args.agent.trim();
  if (Object.keys(args.settings ?? {}).length === 0 && (args.clear ?? []).length === 0) {
    throw withNext(failed("Nothing to change. Give the settings to set, or the settings to clear.", "missing_settings", { agent: id }), id);
  }
  const { configureAgent } = await ops();
  return withStateNext(
    await emitted(scoped(ctx, args.site), id, (x) => configureAgent(x, id, fromValues(args.settings, args.clear), FALLBACK, "settings")),
  );
}

/** `nxis_disable_agent`: `nxis agents disable <id> --json`. */
export async function disableAgentOp(ctx: Ctx, args: { site?: string | undefined; agent: string }): Promise<Result> {
  const { cmdAgentDisable } = await ops();
  const id = args.agent.trim();
  return withStateNext(await emitted(scoped(ctx, args.site), id, (x) => cmdAgentDisable(x, id, FALLBACK)));
}

/** Arguments for {@link pauseAgentsOp}. */
export interface PauseArgs {
  site?: string | undefined;
  agent?: string | undefined;
  tools?: boolean | undefined;
  reason?: string | undefined;
}

/** `nxis_pause_agents`: `nxis agents pause [<id>] --json`; with no agent, every hosted agent on the site. */
export async function pauseAgentsOp(ctx: Ctx, args: PauseArgs): Promise<Result> {
  const pause = { tools: args.tools === true, ...(args.reason !== undefined ? { reason: args.reason } : {}) };
  const c = scoped(ctx, args.site);
  if (args.agent === undefined) {
    const { cmdAgentsPause } = await legacyOps();
    return emitted(c, null, (x) => cmdAgentsPause(x, pause));
  }
  const { cmdAgentPause } = await ops();
  const id = args.agent.trim();
  return withStateNext(await emitted(c, id, (x) => cmdAgentPause(x, id, pause, FALLBACK)));
}

/** `nxis_resume_agents`: `nxis agents resume [<id>] --json`; with no agent, the site-wide pause. */
export async function resumeAgentsOp(ctx: Ctx, args: { site?: string | undefined; agent?: string | undefined }): Promise<Result> {
  const c = scoped(ctx, args.site);
  if (args.agent === undefined) {
    const { cmdAgentsResume } = await legacyOps();
    return emitted(c, null, (x) => cmdAgentsResume(x));
  }
  const { cmdAgentResume } = await ops();
  const id = args.agent.trim();
  return withStateNext(await emitted(c, id, (x) => cmdAgentResume(x, id, FALLBACK)));
}

/** A part of the branding by the name a tool takes. */
export type BrandPart = "name" | "logo" | "accent" | "privacy_url";

/** Arguments for {@link brandAgentsOp}. */
export interface BrandToolArgs {
  site?: string | undefined;
  name?: string | undefined;
  logo?: string | undefined;
  accent?: string | undefined;
  privacy_url?: string | undefined;
  clear?: BrandPart[] | undefined;
}

/** @returns The brand command's options, from a tool's arguments. */
export function brandArgsOf(args: BrandToolArgs): BrandArgs {
  return {
    ...(args.name !== undefined ? { name: args.name } : {}),
    ...(args.logo !== undefined ? { logo: args.logo } : {}),
    ...(args.accent !== undefined ? { accent: args.accent } : {}),
    ...(args.privacy_url !== undefined ? { privacyUrl: args.privacy_url } : {}),
    ...(args.clear ? { clear: args.clear.map((c): BrandField => (c === "privacy_url" ? "privacy-url" : c)) } : {}),
  };
}

/** `nxis_agents_brand`: `nxis agents brand --json`. */
export async function brandAgentsOp(ctx: Ctx, args: BrandToolArgs): Promise<Result> {
  const { cmdAgentsBrand } = await legacyOps();
  return emitted(scoped(ctx, args.site), null, (x) => cmdAgentsBrand(x, brandArgsOf(args)));
}

// ── Before a call: what the server asks the user ─────────────────────────────

/** The agent calls the server confirms with the user. */
export type AgentRiskKind = "agent_enable" | "agent_configure" | "agent_disable" | "agent_resume" | "agent_brand";

/** What {@link prepareAgentCall} found: the arguments to run with, and what to ask, if anything. */
export interface AgentPrep {
  args: Record<string, unknown>;
  /** Nothing to confirm: the call changes nothing the visitors see (an agent that is off), or nothing at all. */
  skip: boolean;
  /** The question and its facts, for the site's host. */
  describe: (host: string) => { message: string; details: Record<string, unknown> };
}

/** @returns A line from a server, safe to show: no escape sequences, no control characters. */
function clean(line: string): string {
  // eslint-disable-next-line no-control-regex
  return plainText(line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ""));
}

/** @returns `label "Help desk", examples (3)`: what a change of settings sets, for the question. */
function settingsWords(settings: Record<string, unknown>): string {
  return Object.entries(settings)
    .map(([k, v]) => {
      const name = clean(k);
      if (v === null) return `${name} cleared`;
      if (Array.isArray(v)) return `${name} (${v.length} item${v.length === 1 ? "" : "s"}: ${v.slice(0, 3).map((i) => `"${clean(String(i)).slice(0, 60)}"`).join(", ")}${v.length > 3 ? ", …" : ""})`;
      if (typeof v === "string") return `${name} "${clean(v).slice(0, 120)}"`;
      return `${name} ${clean(JSON.stringify(v) ?? "")}`;
    })
    .join("; ");
}

/** @returns The host of a connection's address, or the address, cleaned. */
function hostOf(url: string): string {
  try {
    return new URL(url).host || clean(url).slice(0, 200);
  } catch {
    return clean(url).slice(0, 200);
  }
}

/** @returns The agent's name for a question. */
function nameOf(view: HostedAgentView | null, id: string): string {
  return clean(view?.displayName || id);
}

/**
 * Reads what a call needs before it is confirmed, checks its arguments, and, for an enable with
 * someone to ask, puts the connection and the agreement to the user.
 *
 * @param guide - Asks the user; null when nobody can be asked (the call is then refused, or runs
 * on the client's approval, and the service's refusal says what is missing).
 * @throws CliError the setting reasons and `unknown_agent` before anything is asked;
 * `connection_required` (with `next`) when the user wants a new connection first;
 * `declined_by_user` or `cancelled_by_user` when they choose no connection or accept the
 * agreement for nobody; and what accepting throws.
 */
export async function prepareAgentCall(
  ctx: Ctx,
  kind: AgentRiskKind,
  args: Record<string, unknown>,
  guide: Guide | null,
): Promise<AgentPrep> {
  const c = scoped(ctx, typeof args["site"] === "string" ? args["site"] : undefined);
  const id = typeof args["agent"] === "string" ? args["agent"].trim() : "";

  if (kind === "agent_brand") {
    const { brandChange } = await legacyOps();
    const brand = brandArgsOf(args as BrandToolArgs);
    brandChange(brand);
    const set = Object.entries({ name: brand.name, logo: brand.logo, accent: brand.accent, "privacy page": brand.privacyUrl })
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k} ${k === "logo" || k === "privacy page" ? hostOf(String(v)) : `"${clean(String(v)).slice(0, 120)}"`}`);
    const cleared = (brand.clear ?? []).map((f) => (f === "privacy-url" ? "privacy page" : f));
    return {
      args,
      skip: false,
      describe: (host) => ({
        message:
          `Change how the on-page chat looks to visitors on ${host}? ` +
          [set.length ? `Set: ${set.join(", ")}.` : "", cleared.length ? `Back to the default: ${cleared.join(", ")}.` : ""].filter(Boolean).join(" "),
        details: { set, cleared },
      }),
    };
  }

  if (kind === "agent_resume" && !id) {
    return {
      args,
      skip: false,
      describe: (host) => ({
        message:
          `Resume every hosted agent on ${host}? The site-wide pause is lifted, so the agents that are on answer ` +
          "visitors again. An agent paused on its own stays paused.",
        details: { agent: null },
      }),
    };
  }

  const { readAgent, siteRef, checkEnable, checkConfigure, needsConnection } = await ops();
  const ref = await siteRef(c);
  const view = await readAgent(ref, id).catch((err: unknown) => {
    throw withNext(err, id);
  });
  const name = nameOf(view, id);
  // A service without hosted agents by id: the call itself says so.
  if (!view) return { args, skip: kind !== "agent_enable", describe: (host) => ({ message: `Turn on ${name} on ${host}?`, details: { agent: id } }) };
  const base = { agent: id, agent_name: name };

  switch (kind) {
    case "agent_disable":
      return {
        args,
        skip: !view.enabled,
        describe: (host) => ({
          message: `Turn off ${name} on ${host}? It stops answering the site's visitors. Its settings are kept, so turning it on again brings it back as it was.`,
          details: base,
        }),
      };
    case "agent_resume":
      return {
        args,
        skip: !view.killSwitch,
        describe: (host) => ({
          message:
            `Resume ${name} on ${host}? ${view.enabled ? "It answers the site's visitors again" : "It is off, so it answers nobody until it is turned on"}` +
            (view.sitePaused ? ", once the site-wide pause is lifted too." : "."),
          details: base,
        }),
      };
    case "agent_configure": {
      const values = args["settings"] as Record<string, SettingValue> | undefined;
      const clear = (args["clear"] as string[] | undefined) ?? [];
      if (Object.keys(values ?? {}).length === 0 && clear.length === 0) return { args, skip: true, describe: () => ({ message: "", details: base }) };
      const { settings, unchanged } = (() => {
        try {
          return checkConfigure(c, view, fromValues(values, clear), "settings");
        } catch (err) {
          throw withNext(err, id);
        }
      })();
      return {
        args,
        // An agent that is off answers nobody, so its settings change nothing visitors see yet.
        skip: !view.enabled || unchanged,
        describe: (host) => ({
          message: `Change the settings of ${name}, which is on and answering visitors on ${host}? They see the change within seconds. ${settingsWords(settings)}.`,
          details: { ...base, settings: Object.keys(settings) },
        }),
      };
    }
    case "agent_enable": {
      let connection = typeof args["connection"] === "string" && args["connection"].trim() ? args["connection"].trim() : undefined;
      const values = args["settings"] as Record<string, SettingValue> | undefined;
      const checked = (() => {
        try {
          return checkEnable(c, view, { settings: fromValues(values), connection, naming: "settings" });
        } catch (err) {
          throw withNext(err, id);
        }
      })();
      if (checked.unchanged) return { args, skip: true, describe: () => ({ message: "", details: base }) };

      if (guide?.interactive && view.setup && connection === undefined && needsConnection(view.setup)) {
        connection = await chooseConnection(guide, ref, view, name);
      }
      if (guide?.interactive) await agreementBefore(c, guide, ref, view);
      const next = connection !== undefined ? { ...args, connection } : args;
      return {
        args: next,
        skip: false,
        describe: (host) => ({
          message:
            `Turn on ${name} on ${host}? Once on, it answers the site's visitors` +
            (connection !== undefined ? ` and sends their requests, with what they enter, through the connection "${clean(connection)}"` : "") +
            "." +
            (Object.keys(checked.settings).length ? ` Settings: ${settingsWords(checked.settings)}.` : ""),
          details: { ...base, settings: Object.keys(checked.settings), connection: connection ?? null },
        }),
      };
    }
  }
}

/**
 * The connection an agent sends through, chosen by the user among the site's, when it needs one
 * and has none yet.
 *
 * @returns The connection's name, or undefined when its route is already set (or can't be told).
 * @throws CliError `connection_required` (exit 2, with `next`) when the site has none, or the user
 * wants a new one first; the guide's stop when they choose nothing.
 */
async function chooseConnection(guide: Guide, ref: SiteRef, view: HostedAgentView, name: string): Promise<string | undefined> {
  const status = view.prerequisites.find((p) => p.kind === "connection");
  // Only an unmet connection is asked about: a route already set keeps its connection.
  if (!status || status.met) return undefined;
  let list;
  try {
    list = (await listConnections(ref)).connections;
  } catch {
    return undefined;
  }
  const details = { agent: view.agent, connections: list.map((c) => c.name), unmet: [status.id] };
  if (list.length === 0) {
    throw needsUser(
      `${name} sends visitors' requests to the site's own servers through a connection, and the site has none yet. Nothing was changed.`,
      "connection_required",
      { ...details, next: CREATE_CONNECTION },
    );
  }
  const picked = await guide.choose<string | null>({
    message:
      `${name} sends visitors' requests, with what they enter, to the site's own servers through a connection. ` +
      "Which connection should it use?",
    title: "Connection",
    options: [
      ...list.map((c) => ({ value: c.name, label: `"${clean(c.name)}" (${hostOf(c.url)})` })),
      { value: null, label: "None of these: create a new connection first" },
    ],
  });
  if (!picked.ok) throw refused(guide, picked.why, "No connection was chosen, so nothing was changed.", details);
  if (picked.value === null) {
    throw needsUser(
      "The user wants a new connection for this agent first, so nothing was changed.",
      "connection_required",
      { ...details, next: CREATE_CONNECTION },
    );
  }
  return picked.value;
}

/**
 * The agreement, offered as `nxis agents enable` offers it on a terminal, when the site's agents
 * wait on it. Nothing is asked when it can't be read: the enable then says what holds it back.
 */
async function agreementBefore(ctx: Ctx, guide: Guide, ref: SiteRef, view: HostedAgentView): Promise<void> {
  const { agreementNeeded, offerAgreement } = await import("./agreement.js");
  const t = { orgId: ref.orgId, siteId: ref.siteId, token: ref.token };
  let setup;
  try {
    setup = await getAgentSetup(ctx.config, t.token, t.orgId, t.siteId);
  } catch {
    return;
  }
  if (!agreementNeeded(setup)) return;
  const answer = await offerAgreement(ctx, guide, t, setup, "The agent answers visitors once the agreement is accepted.");
  if (!answer.ok) {
    throw refused(
      guide,
      answer.why,
      "Nothing was accepted or changed, and the agent is still off. The agreement can be accepted later with nxis_accept_dpa.",
      { agent: view.agent, version: setup.currentVersion, url: dpaUrl(setup.currentVersion, dpaBaseUrl()) },
    );
  }
}
