/**
 * `nxis agents catalog`, and `enable|configure|disable|pause|resume <id>` for any hosted agent, by
 * its catalog id.
 *
 * @remarks
 * Every command reads the agent first: its settings, its pause, the version of the site's agent
 * config, and its setup block, which says which flags it takes and with what limits. Flags are
 * checked against that block before anything is written, so a newly hosted agent works without a
 * new CLI. A write carries the version it read; when someone else changed the config in between,
 * it is read again and retried once, then reported as `version_conflict`.
 *
 * Against a service that predates hosted agents by id, `page` and `support` fall back to writing
 * the whole agent config, as these commands always did; any other id fails with
 * `hosted_agents_unavailable`.
 */

import { getAgentConfig } from "../api/agent-config.js";
import {
  getAgentCatalogEntry,
  getHostedAgent,
  HostedAgentsUnavailable,
  listAgentCatalog,
  setHostedAgentEnabled,
  updateHostedAgent,
  type AgentSetupSpec,
  type CatalogEntry,
  type HostedAgentView,
  type KillView,
  type PrerequisiteStatus,
  type SettingField,
  type SiteRef,
} from "../api/hosted-agents.js";
import { bool, list, str, type Flags } from "../args.js";
import type { Ctx } from "../context.js";
import { CliError, failed } from "../errors.js";
import { bold, dim, plainText } from "../output.js";
import {
  changesNothing,
  checkRequired,
  givenSettingFlags,
  KNOWN_SETTINGS,
  reservedWith,
  settingFlags,
  settingsFromFlags,
} from "./agent-settings.js";
import { statusJson, summary, target } from "./hosted-agents.js";

/** What `pause` refuses: `--reason` longer than this, in UTF-16 code units. */
const REASON_LIMIT = 200;

/** The ids the CLI has always known, which keep their older path against an older service. */
export const LEGACY_AGENTS: ReadonlySet<string> = new Set(["page", "support"]);

/** What a command does against a service without hosted agents by id. */
export interface Fallback {
  /** For `page` and `support`: the older path. */
  legacy?: () => Promise<void>;
  /** The reason for any other id there, which older releases gave (`missing_agent`, `unknown_agent`). */
  unknownReason: string;
  /** The usage line, for that message. */
  usage: string;
}

/** @returns The site and token, as the hosted agent calls take them. */
async function siteRef(ctx: Ctx): Promise<SiteRef> {
  const t = await target(ctx);
  return { config: ctx.config, token: t.token, orgId: t.orgId, siteId: t.siteId };
}

/** @returns True when http:// URLs are fine: the CLI points at a local stack. */
function localStack(ctx: Ctx): boolean {
  return /^http:\/\//i.test(ctx.config.endpoints.sites);
}

/**
 * Against a service without hosted agents by id: the older path for `page` and `support`, and for
 * any other id, `hosted_agents_unavailable` when the catalog knows it, or the reason older
 * releases gave when it doesn't.
 */
async function fallBack(ref: SiteRef, id: string, fallback: Fallback): Promise<void> {
  if (fallback.legacy) {
    await fallback.legacy();
    return;
  }
  let known = false;
  try {
    known = (await getAgentCatalogEntry(ref, id)).id === id;
  } catch {
    known = false;
  }
  if (known) {
    throw failed(
      `This NxisAI environment can't turn "${plainText(id)}" on from the CLI yet; use the dashboard's Agents page, or try again later.`,
      "hosted_agents_unavailable",
      { agent: id },
    );
  }
  throw failed(`There is no hosted agent called "${plainText(id)}". ${fallback.usage}.`, fallback.unknownReason, { agent: id });
}

/** @returns The agent, or null against a service without hosted agents by id. */
async function readAgent(ref: SiteRef, id: string): Promise<HostedAgentView | null> {
  try {
    return await getHostedAgent(ref, id);
  } catch (err) {
    if (err instanceof HostedAgentsUnavailable) return null;
    throw err;
  }
}

/** @returns The agent's setup; `agent_not_hosted` when it has none. */
function setupOf(view: HostedAgentView): AgentSetupSpec {
  if (!view.setup) {
    throw failed(`NxisAI doesn't host "${plainText(view.agent)}" yet.`, "agent_not_hosted", { agent: view.agent, readiness: null });
  }
  return view.setup;
}

/** @returns True when the setup routes the agent's requests through a connection. */
function needsConnection(setup: AgentSetupSpec): boolean {
  return setup.prerequisites.some((p) => p.kind === "connection");
}

/**
 * Runs a write, retrying once against the agent as it now is when the config changed in between.
 *
 * @param plan - Given the agent as read: the write to make, or null when there is nothing to change.
 */
async function writeAgent(
  ctx: Ctx,
  ref: SiteRef,
  id: string,
  fallback: Fallback,
  plan: (view: HostedAgentView) => (() => Promise<HostedAgentView>) | null,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const before = await readAgent(ref, id);
    if (!before) {
      await fallBack(ref, id, fallback);
      return;
    }
    const send = plan(before);
    if (!send) {
      await emitAgent(ctx, ref, before, before, false);
      return;
    }
    try {
      const after = await send();
      const changed = before.configVersion <= 0 || after.configVersion !== before.configVersion;
      await emitAgent(ctx, ref, before, after, changed);
      return;
    } catch (err) {
      if (attempt === 0 && err instanceof CliError && err.reason === "version_conflict") {
        ctx.io.note("The settings changed while this ran; reading them again and retrying once.");
        continue;
      }
      throw err;
    }
  }
}

/** @returns The `--connection` value, when given. */
function connectionFlag(flags: Flags): string | undefined {
  if (!flags.has("connection")) return undefined;
  const value = str(flags, "connection")?.trim();
  if (!value) {
    throw failed("--connection needs a connection's name or id; `nxis connections list` shows them.", "missing_value", {
      flag: "--connection",
    });
  }
  return value;
}

/**
 * Checks the flags `page` and `support` have always taken before anything is read or sent, and,
 * against an older service, refuses the ones it has no place for.
 */
function precheck(id: string, flags: Flags, reserved: ReadonlySet<string>, clear: string[] = []): void {
  const known = KNOWN_SETTINGS[id];
  if (!known) return;
  settingsFromFlags({ settings: known, prerequisites: [], pausable: true }, flags, { reserved, onlyKnown: true, clear });
}

/** @returns The checks for the older path: every flag must be one it knows. */
function strictLegacy(id: string, flags: Flags, reserved: ReadonlySet<string>, clear: string[] = []): void {
  const known = KNOWN_SETTINGS[id];
  if (!known) return;
  settingsFromFlags({ settings: known, prerequisites: [], pausable: true }, flags, { reserved, clear });
}

/**
 * Runs `nxis agents enable <id> [--<flag> <value>]... [--connection <name|id>]`.
 *
 * @throws CliError the flag reasons of {@link settingsFromFlags} and `missing_<flag>` (exit 1,
 * before anything is sent); the service's refusals as {@link mapRefusal} maps them:
 * `connection_required`, `records_missing`, `actions_off`, `opening_hours_required` … (exit 2).
 */
export async function cmdAgentEnable(ctx: Ctx, id: string, flags: Flags, fallback: Fallback): Promise<void> {
  const reserved = reservedWith("connection");
  precheck(id, flags, reserved);
  const connection = connectionFlag(flags);
  const ref = await siteRef(ctx);
  await writeAgent(ctx, ref, id, {
    ...fallback,
    ...(fallback.legacy
      ? {
          legacy: async () => {
            strictLegacy(id, flags, reserved);
            if (connection !== undefined) {
              throw failed("--connection isn't a setting of this agent.", "unknown_flag", { flag: "--connection", allowed: settingFlags({ settings: KNOWN_SETTINGS[id] ?? [], prerequisites: [], pausable: true }) });
            }
            await fallback.legacy?.();
          },
        }
      : {}),
  }, (view) => {
    const setup = setupOf(view);
    const settings = settingsFromFlags(setup, flags, { reserved, stored: view.settings, allowHttp: localStack(ctx) });
    if (connection !== undefined && !needsConnection(setup)) {
      throw failed(`${plainText(view.displayName || id)} doesn't send requests through a connection, so it takes no --connection.`, "unknown_flag", {
        flag: "--connection",
        allowed: settingFlags(setup),
      });
    }
    checkRequired(setup, view.settings, settings, view.displayName || id);
    if (view.enabled && connection === undefined && changesNothing(view.settings, settings)) return null;
    return () =>
      setHostedAgentEnabled(ref, id, {
        enabled: true,
        settings,
        ...(connection !== undefined ? { connection } : {}),
        expectedVersion: view.configVersion,
      });
  });
}

/**
 * Runs `nxis agents configure <id> [--<flag> <value>]... [--clear <flag>]...`: settings, without
 * turning the agent on or off.
 *
 * @throws CliError `missing_settings` (exit 1) when nothing is given; the flag reasons; and the
 * service's refusals.
 */
export async function cmdAgentConfigure(ctx: Ctx, id: string, flags: Flags, fallback: Fallback): Promise<void> {
  const reserved = reservedWith("clear");
  const clear = clearFlags(flags);
  if (givenSettingFlags(flags, reserved).length === 0 && clear.length === 0) {
    throw failed(`Nothing to change. Give the settings to set, or --clear <flag>; \`nxis agents catalog ${plainText(id)}\` lists them.`, "missing_settings", {
      agent: id,
    });
  }
  precheck(id, flags, reserved, clear);
  const ref = await siteRef(ctx);
  await writeAgent(ctx, ref, id, {
    ...fallback,
    ...(fallback.legacy
      ? {
          legacy: async () => {
            strictLegacy(id, flags, reserved, clear);
            await fallback.legacy?.();
          },
        }
      : {}),
  }, (view) => {
    const setup = setupOf(view);
    const settings = settingsFromFlags(setup, flags, { reserved, clear, stored: view.settings, allowHttp: localStack(ctx) });
    if (view.enabled) checkRequired(setup, view.settings, settings, view.displayName || id);
    if (changesNothing(view.settings, settings)) return null;
    return () => updateHostedAgent(ref, id, { settings, expectedVersion: view.configVersion });
  });
}

/** @returns The `--clear` values. */
export function clearFlags(flags: Flags): string[] {
  const values = flags.all.get("clear") ?? [];
  if (values.some((v) => typeof v !== "string" || !v.trim())) {
    throw failed("--clear needs the flag of the setting to clear, such as --clear description.", "missing_value", { flag: "--clear" });
  }
  return values.map((v) => String(v).trim().replace(/^--/, ""));
}

/** Runs `nxis agents disable <id>`. Its settings are kept. */
export async function cmdAgentDisable(ctx: Ctx, id: string, fallback: Fallback): Promise<void> {
  const ref = await siteRef(ctx);
  await writeAgent(ctx, ref, id, fallback, (view) => {
    if (!view.enabled) return null;
    return () => setHostedAgentEnabled(ref, id, { enabled: false, expectedVersion: view.configVersion });
  });
}

/** Options for `nxis agents pause <id>`. */
export interface AgentPauseArgs {
  tools?: boolean;
  reason?: string;
}

/**
 * Runs `nxis agents pause <id> [--tools] [--reason <text>]`: the agent's own pause. Without
 * `--reason`, a message already set is kept.
 *
 * @throws CliError `reason_too_long` (exit 1, before anything is sent); `agent_not_pausable`
 * (exit 1) for an agent whose setup has no pause of its own.
 */
export async function cmdAgentPause(ctx: Ctx, id: string, args: AgentPauseArgs, fallback: Fallback): Promise<void> {
  const reason = args.reason?.trim();
  if (reason !== undefined && reason.length > REASON_LIMIT) {
    throw failed(`--reason is at most ${REASON_LIMIT} characters (got ${reason.length}).`, "reason_too_long", {
      limit: REASON_LIMIT,
      length: reason.length,
    });
  }
  const scope = args.tools ? "tools" : "agent";
  const ref = await siteRef(ctx);
  await writeAgent(ctx, ref, id, fallback, (view) => {
    const setup = setupOf(view);
    if (!setup.pausable) {
      throw failed(
        `${plainText(view.displayName || id)} has no pause of its own; \`nxis agents pause\` pauses every hosted agent on the site.`,
        "agent_not_pausable",
        { agent: id },
      );
    }
    const next = { scope, reason: reason ?? view.killSwitch?.reason ?? "" };
    if (view.killSwitch && view.killSwitch.scope === next.scope && view.killSwitch.reason === next.reason) return null;
    return () =>
      updateHostedAgent(ref, id, {
        killSwitch: { scope: scope === "tools" ? "TOOLS" : "AGENT", reason: next.reason },
        expectedVersion: view.configVersion,
      });
  });
}

/** Runs `nxis agents resume <id>`: the agent's own pause off. The site-wide one is left as it is. */
export async function cmdAgentResume(ctx: Ctx, id: string, fallback: Fallback): Promise<void> {
  const ref = await siteRef(ctx);
  await writeAgent(ctx, ref, id, fallback, (view) => {
    if (!view.killSwitch) return null;
    return () => updateHostedAgent(ref, id, { killSwitch: null, expectedVersion: view.configVersion });
  });
}

/** A pause in `--json` results. */
function killJson(k: KillView | null): KillView | null {
  return k ? { scope: k.scope, reason: k.reason } : null;
}

/** A prerequisite's status in `--json` results. */
function statusOfJson(p: PrerequisiteStatus): Record<string, unknown> {
  return { id: p.id, met: p.met, reason: p.reason || null, ...(p.met ? {} : { message: p.message || null }) };
}

/** A hosted agent in `--json` results. */
export function agentJson(v: HostedAgentView): Record<string, unknown> {
  return {
    id: v.agent,
    name: v.displayName || null,
    enabled: v.enabled,
    state: v.state,
    state_reason: v.stateReason || null,
    state_message: v.stateMessage || null,
    settings: v.settings,
    kill_switch: killJson(v.killSwitch),
    effective_kill_switch: killJson(v.effectiveKillSwitch),
    site_paused: v.sitePaused,
    prerequisites: v.prerequisites.map(statusOfJson),
    config_version: v.configVersion,
  };
}

/**
 * What to do next, for an agent that is on but doesn't answer visitors yet; null when nothing
 * holds it back.
 */
export function nextStep(v: HostedAgentView): string | null {
  const id = v.agent;
  if (!v.enabled || v.state === "live" || v.state === "off" || v.state === null) return null;
  switch (v.stateReason) {
    case "connection_required":
      return `Choose a connection for it: \`nxis agents enable ${id} --connection <name|id>\` (\`nxis connections list\` shows them).`;
    case "connection_unusable":
      return `Its connection can't be sent through: check it with \`nxis connections list\`, or choose another with \`nxis agents enable ${id} --connection <name|id>\`.`;
    case "actions_off":
      return "The site's actions are off: `nxis actions on` turns them on.";
    case "site_not_verified":
      return "Verify the site: `nxis sites verify --token`, deploy the tag, then `nxis sites verify --check`.";
    case "mcp_server_not_set_up":
      return "Set up the site's MCP server, which this agent answers from: `nxis mcp settings` shows it.";
    case "dpa_not_accepted":
    case "dpa_not_published":
      return "It answers visitors once the data processing agreement is accepted: `nxis agents dpa`.";
    case "preview":
      return "The site is in preview: go live from the dashboard's Agents page.";
    case "agent_paused":
      return `It is paused: \`nxis agents resume ${id}\` resumes it.`;
    case "site_paused":
      return "Every hosted agent on the site is paused: `nxis agents resume` resumes them.";
    default:
      return v.stateMessage ? plainText(v.stateMessage) : null;
  }
}

/** The agent, in a few lines for a person. */
export function agentText(v: HostedAgentView): string {
  const name = plainText(v.displayName || v.agent);
  const row = (label: string, value: string) => `  ${label.padEnd(14)} ${value}`;
  const state = v.state ? v.state.replace(/_/g, " ") : v.enabled ? "on" : "off";
  const lines = [`${bold(name)} ${dim(`(${plainText(v.agent)}, version ${v.configVersion})`)}`, row("State", state + (v.stateMessage && v.state !== "live" ? `: ${plainText(v.stateMessage)}` : ""))];
  const names = Object.keys(v.settings);
  for (const key of names) lines.push(row(plainText(key), valueText(v.settings[key])));
  if (v.killSwitch) lines.push(row("Paused", `${v.killSwitch.scope === "agent" ? "every turn" : "tools only"}${v.killSwitch.reason ? ` ("${plainText(v.killSwitch.reason)}")` : ""}`));
  const unmet = v.prerequisites.filter((p) => !p.met);
  if (unmet.length) lines.push(row("Needs", unmet.map((p) => plainText(p.message || p.id)).join("; ")));
  return lines.join("\n");
}

/** A setting's value, in one line. */
function valueText(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => `"${plainText(String(v))}"`).join(", ") || "none";
  if (typeof value === "string") return `"${plainText(value)}"`;
  return plainText(JSON.stringify(value) ?? "");
}

/** Prints the result of a write. `page` and `support` keep every key their commands always printed. */
async function emitAgent(ctx: Ctx, ref: SiteRef, before: HostedAgentView, after: HostedAgentView, changed: boolean): Promise<void> {
  void before;
  const next = nextStep(after);
  const lead = changed ? "Saved. The change reaches the site within seconds." : "Already set; nothing changed.";
  let base: Record<string, unknown> = { ok: true, org: ref.orgId, site: ref.siteId };
  let extra = "";
  if (LEGACY_AGENTS.has(after.agent)) {
    try {
      const config = await getAgentConfig(ctx.config, ref.token, ref.orgId, ref.siteId);
      const t = { orgId: ref.orgId, siteId: ref.siteId, token: ref.token };
      base = statusJson(t, config);
      extra = `\n\n${summary(t, config)}`;
    } catch {
      // The write is done; the older keys are extra.
    }
  }
  ctx.io.emit(
    { ...base, changed, agent: agentJson(after), ...(next ? { next } : {}) },
    () => `${lead}\n${agentText(after)}${next ? `\n\nNext: ${next}` : ""}${extra}`,
  );
}

// ── The catalog ──────────────────────────────────────────────────────────────

const READINESS = ["available", "early_access", "coming_soon"] as const;

/** Runs `nxis agents catalog [--job <job>]... [--industry <name>]... [--readiness <r>]... [--added|--not-added] [--query <words>] [--by-fit]`. */
export async function cmdAgentsCatalog(ctx: Ctx, flags: Flags): Promise<void> {
  const readiness = list(flags, "readiness").map((r) => r.trim().toLowerCase().replace(/-/g, "_"));
  for (const r of readiness) {
    if (!(READINESS as readonly string[]).includes(r)) {
      throw failed(`--readiness takes ${READINESS.join(", ")} (got "${plainText(r)}").`, "invalid_readiness", {
        flag: "--readiness",
        allowed: [...READINESS],
      });
    }
  }
  const added = bool(flags, "added");
  const notAdded = bool(flags, "not-added");
  if (added && notAdded) throw failed("--added and --not-added were both given; pick one.", "conflicting_flags", { flag: "--added" });
  const query = str(flags, "query")?.trim();
  const ref = await siteRef(ctx);
  const catalog = await listAgentCatalog(ref, {
    jobs: list(flags, "job").map((j) => j.trim()).filter(Boolean),
    industries: list(flags, "industry").map((i) => i.trim()).filter(Boolean),
    readiness,
    ...(added ? { added: true } : notAdded ? { added: false } : {}),
    ...(query ? { query } : {}),
    byFit: bool(flags, "by-fit"),
  });
  ctx.io.emit(
    {
      ok: true,
      org: ref.orgId,
      site: ref.siteId,
      total: catalog.totalSize,
      entries: catalog.entries.map(catalogRowJson),
      jobs: catalog.jobs,
      industries: catalog.industries,
      readiness: catalog.readiness,
    },
    () => catalogText(catalog.entries),
  );
}

/** One row of the catalog in `--json` results. */
function catalogRowJson(e: CatalogEntry): Record<string, unknown> {
  return {
    id: e.id,
    name: e.name,
    job: e.job,
    readiness: e.readiness,
    hosted: e.hosted,
    fit: e.fit,
    missing: e.missing || null,
    added: e.added,
    state: e.state,
    unmet: e.prerequisites.filter((p) => !p.met).map((p) => p.id),
  };
}

/** The catalog as a table. */
function catalogText(entries: CatalogEntry[]): string {
  if (!entries.length) return "No agents match.";
  const rows = entries.map((e) => [
    plainText(e.id),
    plainText(e.name),
    plainText(e.job),
    plainText(e.readiness.replace(/_/g, " ")),
    `${e.fit}`,
    e.added ? (e.state ?? "on").replace(/_/g, " ") : e.hosted ? "not added" : "not hosted",
    plainText([e.missing, ...e.prerequisites.filter((p) => !p.met).map((p) => p.message || p.id)].filter(Boolean).join("; ")),
  ]);
  const head = ["ID", "NAME", "JOB", "READINESS", "FIT", "STATE", "NEEDS"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] ?? 0))).join("  ").trimEnd();
  return [dim(line(head)), ...rows.map(line), "", "`nxis agents catalog <id>` shows one agent's settings, what it needs, and how to turn it on."].join("\n");
}

/** A setting, as `catalog <id>` lists it: the flag first. */
export function flagJson(f: SettingField): Record<string, unknown> {
  return {
    flag: `--${f.flag}`,
    setting: f.name,
    type: f.type,
    label: f.label || null,
    help: f.help || null,
    required: f.required,
    repeats: f.type === "string_list",
    max_length: f.maxLength || null,
    max_items: f.maxItems || null,
    item_max_length: f.itemMaxLength || null,
    distinct_items: f.distinctItems,
    min: f.min,
    max: f.max,
    zero_is_default: f.zeroIsDefault,
    allowed: f.allowedValues.length ? f.allowedValues.filter((v) => !v.retired).map((v) => v.value) : null,
    default: f.defaultValue ?? null,
    group: f.group || null,
  };
}

/** @returns The value a flag takes, for a usage line: `<text>`, `<n>`, `a|b`. */
function placeholder(f: SettingField): string {
  switch (f.type) {
    case "integer":
      return f.min !== null && f.max !== null ? `<${f.min}-${f.max}>` : "<n>";
    case "boolean":
      return "true|false";
    case "enum":
    case "model":
      return f.allowedValues.length ? f.allowedValues.filter((v) => !v.retired).map((v) => v.value).join("|") : "<id>";
    case "url":
      return "<https url>";
    case "color":
      return "<#rrggbb>";
    default:
      return "<text>";
  }
}

/** @returns The shortest `enable` line that works: the required flags, and a connection when the agent needs one. */
export function enableLine(id: string, setup: AgentSetupSpec): string {
  const parts = [`nxis agents enable ${id}`];
  for (const f of setup.settings) if (f.required) parts.push(`--${f.flag} ${f.type === "string" || f.type === "text" ? `"${f.label || f.name}"` : placeholder(f)}`);
  if (needsConnection(setup)) parts.push("--connection <name|id>");
  return parts.join(" ");
}

/** Runs `nxis agents catalog <id>`: the entry, its settings as flags, what it needs, and how to turn it on. */
export async function cmdAgentsCatalogEntry(ctx: Ctx, id: string): Promise<void> {
  const ref = await siteRef(ctx);
  const entry = await getAgentCatalogEntry(ref, id);
  let agent: HostedAgentView | null = null;
  if (entry.hosted && entry.setup) {
    try {
      agent = await getHostedAgent(ref, id);
    } catch (err) {
      if (!(err instanceof HostedAgentsUnavailable) && !(err instanceof CliError && err.reason === "agent_not_hosted")) throw err;
    }
  }
  const setup = agent?.setup ?? entry.setup;
  const prerequisites = agent?.prerequisites.length ? agent.prerequisites : entry.prerequisites;
  const labels = new Map((setup?.prerequisites ?? []).map((p) => [p.id, p]));
  const enable = entry.hosted && setup ? enableLine(entry.id, setup) : null;
  ctx.io.emit(
    {
      ok: true,
      org: ref.orgId,
      site: ref.siteId,
      id: entry.id,
      name: entry.name,
      description: entry.description,
      job: entry.job,
      industries: entry.industries,
      readiness: entry.readiness,
      hosted: entry.hosted,
      fit: entry.fit,
      missing: entry.missing || null,
      added: entry.added,
      state: agent?.state ?? entry.state,
      enabled: agent ? agent.enabled : entry.added,
      settings: agent?.settings ?? null,
      flags: (setup?.settings ?? []).map(flagJson),
      prerequisites: prerequisites.length
        ? prerequisites.map((p) => ({ ...statusOfJson(p), kind: p.kind, enforcement: p.enforcement, label: labels.get(p.id)?.label || null }))
        : (setup?.prerequisites ?? []).map((p) => ({ id: p.id, kind: p.kind, enforcement: p.enforcement, label: p.label || null, met: null, reason: null })),
      pausable: setup?.pausable ?? false,
      enable,
    },
    () => entryText(entry, agent, setup, prerequisites, enable),
  );
}

/** One catalog entry, for a person. */
function entryText(
  entry: CatalogEntry,
  agent: HostedAgentView | null,
  setup: AgentSetupSpec | null,
  prerequisites: PrerequisiteStatus[],
  enable: string | null,
): string {
  const lines = [`${bold(plainText(entry.name || entry.id))} ${dim(`(${plainText(entry.id)})`)}`];
  if (entry.description) lines.push(plainText(entry.description));
  lines.push(
    `  ${"Readiness".padEnd(12)} ${plainText(entry.readiness.replace(/_/g, " "))}${entry.hosted ? "" : ", not hosted yet"}`,
    `  ${"Fit".padEnd(12)} ${entry.fit}${entry.missing ? ` (${plainText(entry.missing)})` : ""}`,
  );
  const state = agent?.state ?? entry.state;
  if (state) lines.push(`  ${"State".padEnd(12)} ${state.replace(/_/g, " ")}`);
  if (setup?.settings.length) {
    lines.push("", "Settings");
    for (const f of setup.settings) {
      const limits = [
        f.required ? "required" : "",
        f.maxLength ? `at most ${f.maxLength} characters` : "",
        f.maxItems ? `repeats, at most ${f.maxItems}` : f.type === "string_list" ? "repeats" : "",
        f.itemMaxLength ? `each at most ${f.itemMaxLength} characters` : "",
        f.min !== null && f.max !== null ? `${f.min} to ${f.max}` : "",
      ].filter(Boolean);
      const current = agent && Object.prototype.hasOwnProperty.call(agent.settings, f.name) ? `, now ${valueText(agent.settings[f.name])}` : "";
      lines.push(`  --${f.flag} ${placeholder(f)}`.padEnd(36) + ` ${plainText(f.label || f.name)}${limits.length ? ` (${limits.join(", ")})` : ""}${current}`);
    }
  }
  if (prerequisites.length || setup?.prerequisites.length) {
    lines.push("", "Needs");
    const labels = new Map((setup?.prerequisites ?? []).map((p) => [p.id, p.label]));
    if (prerequisites.length) {
      for (const p of prerequisites) {
        lines.push(`  ${p.met ? "done" : "to do"}  ${plainText(labels.get(p.id) || p.id)}${!p.met && p.message ? `: ${plainText(p.message)}` : ""}`);
      }
    } else {
      for (const p of setup?.prerequisites ?? []) lines.push(`  ${plainText(p.label || p.id)}`);
    }
  }
  if (enable) lines.push("", `Turn it on: ${enable}`);
  return lines.join("\n");
}
