/**
 * Sites API: a site's hosted agents by catalog id, and the agent catalog.
 *
 * @remarks
 * Each catalog entry that NxisAI hosts carries a setup block: the settings an owner fills in (each
 * with its type, limits and CLI flag) and what the site needs before the agent can be turned on or
 * answer visitors. The CLI reads that block at run time, so an agent NxisAI starts hosting works
 * here without a new release of the CLI.
 *
 * Responses may name fields in snake_case or lowerCamelCase, depending on the gateway in front of
 * the service; both are read. Two kinds of keys are data, not field names, and are read from the
 * raw body so they stay exactly as sent: an agent's `settings` (keyed by setting name) and a
 * prerequisite's `metadata`. Requests are sent in snake_case, which the transcoder accepts.
 */

import type { Config } from "../config.js";
import { CliError, failed, needsUser } from "../errors.js";
import { ERROR_DOMAIN, request, type ErrorInfo } from "../http.js";
import { plainText } from "../output.js";
import { camelKeys } from "./agent-config.js";
import { listConnections } from "./connections.js";
import { num } from "./shapes.js";

/** A setting's type, without its `SETTING_` prefix, lowercased: `string`, `string_list` … */
export type SettingType =
  | "string"
  | "text"
  | "string_list"
  | "integer"
  | "boolean"
  | "enum"
  | "model"
  | "url"
  | "color"
  | "unspecified";

/** One value an ENUM or MODEL setting takes. */
export interface AllowedValue {
  value: string;
  label: string;
  note: string;
  isDefault: boolean;
  /** MODEL only: no longer offered; choosing it anew is refused. */
  retired: boolean;
}

/** One setting of a hosted agent, as its catalog entry describes it. */
export interface SettingField {
  /** The key in the agent's settings. */
  name: string;
  type: SettingType;
  label: string;
  help: string;
  required: boolean;
  /** 0: no limit. In UTF-16 code units, as the service counts. */
  maxLength: number;
  maxItems: number;
  itemMaxLength: number;
  distinctItems: boolean;
  /** Null: no bound. */
  min: number | null;
  max: number | null;
  zeroIsDefault: boolean;
  allowedValues: AllowedValue[];
  /** What the agent uses while it is unset, for display only. */
  defaultValue: unknown;
  /** The CLI flag, without dashes. */
  flag: string;
  group: string;
}

/** A prerequisite's kind, without its `PREREQUISITE_` prefix, lowercased: `connection`, `records` … */
export type PrerequisiteKind = string;

/** One thing the site needs for an agent. */
export interface Prerequisite {
  id: string;
  kind: PrerequisiteKind;
  /** `on_enable`: turning the agent on is refused while unmet; `on_serve`: it is on but doesn't answer. */
  enforcement: "on_enable" | "on_serve" | "unspecified";
  label: string;
  /** CONNECTION: the action types the agent's requests route by, in order. */
  actionTypes: string[];
  recordTypes: string[];
  pricedTypes: string[];
  /** Applies only while a setting has one of these values. */
  when: { setting: string; values: string[] } | null;
}

/** A prerequisite, for one site, now. */
export interface PrerequisiteStatus {
  id: string;
  kind: PrerequisiteKind;
  enforcement: Prerequisite["enforcement"];
  met: boolean;
  /** Lowercased: `connection_required`; empty when met. */
  reason: string;
  message: string;
  metadata: Record<string, string>;
}

/** How an agent is set up. */
export interface AgentSetupSpec {
  settings: SettingField[];
  prerequisites: Prerequisite[];
  pausable: boolean;
}

/** A pause: `agent` refuses every turn, `tools` only actions. Null when not paused. */
export interface KillView {
  scope: "agent" | "tools";
  reason: string;
}

/** Where a hosted agent stands on a site. */
export type HostedAgentState = "off" | "needs_setup" | "preview" | "paused" | "live";

/** One of a site's hosted agents. */
export interface HostedAgentView {
  name: string;
  /** The catalog id. */
  agent: string;
  displayName: string;
  enabled: boolean;
  /** As sent: keyed by setting name, values as JSON. */
  settings: Record<string, unknown>;
  killSwitch: KillView | null;
  effectiveKillSwitch: KillView | null;
  sitePaused: boolean;
  state: HostedAgentState | null;
  /** Lowercased; empty for off and live. */
  stateReason: string;
  stateMessage: string;
  prerequisites: PrerequisiteStatus[];
  setup: AgentSetupSpec | null;
  configVersion: number;
  updateTime: string | null;
}

/** A site's hosted agents. */
export interface HostedAgentList {
  agents: HostedAgentView[];
  configVersion: number;
  live: boolean;
  siteKillSwitch: KillView | null;
}

/** A catalog entry, for one site. */
export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  job: string;
  industries: string[];
  readiness: string;
  hosted: boolean;
  actions: string[];
  fit: number;
  missing: string;
  added: boolean;
  setup: AgentSetupSpec | null;
  prerequisites: PrerequisiteStatus[];
  state: HostedAgentState | null;
}

/** A category and how many entries are in it. */
export interface CategoryCount {
  value: string;
  count: number;
}

/** The catalog for a site. */
export interface CatalogList {
  entries: CatalogEntry[];
  totalSize: number;
  jobs: CategoryCount[];
  industries: CategoryCount[];
  readiness: CategoryCount[];
}

/** gRPC status codes told apart here. */
const RPC = { INVALID_ARGUMENT: 3, NOT_FOUND: 5, FAILED_PRECONDITION: 9, ABORTED: 10 } as const;

/** @returns The value when it is a plain object, else undefined. */
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** @returns The value when it is a string, else "". */
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** @returns The strings in an array; empty for anything else. */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** @returns The objects in an array; empty for anything else. */
function objects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(object).filter((v): v is Record<string, unknown> => v !== undefined) : [];
}

/** @returns `SETTING_STRING_LIST` as `string_list`, `HOSTED_AGENT_NEEDS_SETUP` as `needs_setup`; a number by its name. */
function enumName(value: unknown, prefix: string, names: readonly string[]): string {
  if (typeof value === "number") return names[value] ?? "unspecified";
  const name = text(value);
  if (!name) return "unspecified";
  return (name.startsWith(prefix) ? name.slice(prefix.length) : name).toLowerCase();
}

const SETTING_TYPES = ["unspecified", "string", "text", "string_list", "integer", "boolean", "enum", "model", "url", "color"] as const;
const PREREQUISITE_KINDS = ["unspecified", "connection", "mcp_server", "records", "site_verified", "dpa", "opening_hours"] as const;
const ENFORCEMENTS = ["unspecified", "on_enable", "on_serve"] as const;
const STATES = ["unspecified", "off", "needs_setup", "preview", "paused", "live"] as const;

function settingType(value: unknown): SettingType {
  const name = enumName(value, "SETTING_", SETTING_TYPES);
  return (SETTING_TYPES as readonly string[]).includes(name) ? (name as SettingType) : "unspecified";
}

function enforcement(value: unknown): Prerequisite["enforcement"] {
  const name = enumName(value, "ENFORCED_", ENFORCEMENTS);
  return name === "on_enable" || name === "on_serve" ? name : "unspecified";
}

/** @returns The state, or null when unspecified. */
export function stateOf(value: unknown): HostedAgentState | null {
  const name = enumName(value, "HOSTED_AGENT_", STATES);
  return name === "unspecified" || !(STATES as readonly string[]).includes(name) ? null : (name as HostedAgentState);
}

/** @returns An Int64Value / number / numeric string, or null. */
function bound(value: unknown): number | null {
  return num(value);
}

/** @returns A kill switch, or null when unset or `KILL_SCOPE_UNSPECIFIED`. */
export function killViewOf(raw: unknown): KillView | null {
  const k = object(raw);
  const scope = k?.["scope"];
  const reason = text(k?.["reason"]);
  if (scope === "AGENT" || scope === 1) return { scope: "agent", reason };
  if (scope === "TOOLS" || scope === 2) return { scope: "tools", reason };
  return null;
}

/** @returns The setting field, from a camelCased body; `rawDefault` is the raw `default_value`. */
function parseSettingField(f: Record<string, unknown>, rawDefault: unknown): SettingField {
  const name = text(f["name"]);
  return {
    name,
    type: settingType(f["type"]),
    label: text(f["label"]),
    help: text(f["help"]),
    required: f["required"] === true,
    maxLength: num(f["maxLength"]) ?? 0,
    maxItems: num(f["maxItems"]) ?? 0,
    itemMaxLength: num(f["itemMaxLength"]) ?? 0,
    distinctItems: f["distinctItems"] === true,
    min: bound(f["min"]),
    max: bound(f["max"]),
    zeroIsDefault: f["zeroIsDefault"] === true,
    allowedValues: objects(f["allowedValues"]).map((v) => ({
      value: text(v["value"]),
      label: text(v["label"]),
      note: text(v["note"]),
      isDefault: v["isDefault"] === true,
      retired: v["retired"] === true,
    })),
    defaultValue: rawDefault ?? null,
    flag: text(f["flag"]) || name.replace(/_/g, "-"),
    group: text(f["group"]),
  };
}

/**
 * The setup block, from the camelCased body and the raw one beside it.
 *
 * @returns Null when there is none.
 */
export function parseSetup(body: unknown, raw: unknown): AgentSetupSpec | null {
  const s = object(body);
  if (!s) return null;
  const rawFields = objects(object(raw)?.["settings"]);
  return {
    settings: objects(s["settings"]).map((f, i) =>
      parseSettingField(f, rawFields[i]?.["default_value"] ?? rawFields[i]?.["defaultValue"]),
    ),
    prerequisites: objects(s["prerequisites"]).map((p) => {
      const when = object(p["when"]);
      return {
        id: text(p["id"]),
        kind: enumName(p["kind"], "PREREQUISITE_", PREREQUISITE_KINDS),
        enforcement: enforcement(p["enforcement"]),
        label: text(p["label"]),
        actionTypes: strings(p["actionTypes"]),
        recordTypes: strings(p["recordTypes"]),
        pricedTypes: strings(p["pricedTypes"]),
        when: when ? { setting: text(when["setting"]), values: strings(when["values"]) } : null,
      };
    }),
    pausable: s["pausable"] === true,
  };
}

/** Prerequisite statuses, from the camelCased list and the raw one beside it (for `metadata`). */
function parseStatuses(body: unknown, raw: unknown): PrerequisiteStatus[] {
  const rawList = objects(raw);
  return objects(body).map((p, i) => {
    const rawMeta = object(rawList[i]?.["metadata"]) ?? {};
    return {
      id: text(p["id"]),
      kind: enumName(p["kind"], "PREREQUISITE_", PREREQUISITE_KINDS),
      enforcement: enforcement(p["enforcement"]),
      met: p["met"] === true,
      reason: text(p["reason"]).toLowerCase(),
      message: text(p["message"]),
      metadata: Object.fromEntries(
        Object.entries(rawMeta).filter((e): e is [string, string] => typeof e[1] === "string"),
      ),
    };
  });
}

/**
 * Normalizes a hosted agent as the service returned it.
 *
 * @throws CliError `bad_response` (exit 1) when the body is not a hosted agent.
 */
export function parseHostedAgent(raw: unknown): HostedAgentView {
  const rawBody = object(raw);
  const body = object(camelKeys(raw));
  if (!rawBody || !body) throw failed("The sites service answered without a hosted agent.", "bad_response");
  const name = text(body["name"]);
  const agent = text(body["agent"]) || name.split("/").pop() || "";
  if (!agent) throw failed("The sites service answered without a hosted agent.", "bad_response");
  // Setting names are data: read them as sent.
  const settings = object(rawBody["settings"]) ?? {};
  return {
    name,
    agent,
    displayName: text(body["displayName"]),
    enabled: body["enabled"] === true,
    settings: { ...settings },
    killSwitch: killViewOf(body["killSwitch"]),
    effectiveKillSwitch: killViewOf(body["effectiveKillSwitch"]),
    sitePaused: body["sitePaused"] === true,
    state: stateOf(body["state"]),
    stateReason: text(body["stateReason"]).toLowerCase(),
    stateMessage: text(body["stateMessage"]),
    prerequisites: parseStatuses(body["prerequisites"], rawBody["prerequisites"]),
    setup: parseSetup(body["setup"], rawBody["setup"]),
    configVersion: num(body["configVersion"]) ?? 0,
    updateTime: text(body["updateTime"]) || null,
  };
}

/** Normalizes ListHostedAgentsResponse. */
export function parseHostedAgentList(raw: unknown): HostedAgentList {
  const rawBody = object(raw) ?? {};
  const body = object(camelKeys(raw)) ?? {};
  const list = Array.isArray(rawBody["hosted_agents"])
    ? (rawBody["hosted_agents"] as unknown[])
    : Array.isArray(rawBody["hostedAgents"])
      ? (rawBody["hostedAgents"] as unknown[])
      : [];
  return {
    agents: list.filter((a) => object(a)).map(parseHostedAgent),
    configVersion: num(body["configVersion"]) ?? 0,
    live: body["live"] !== false,
    siteKillSwitch: killViewOf(body["siteKillSwitch"]),
  };
}

/** Normalizes a SiteAgentCatalogEntry. */
export function parseCatalogEntry(raw: unknown): CatalogEntry {
  const rawBody = object(raw) ?? {};
  const body = object(camelKeys(raw)) ?? {};
  const entry = object(body["entry"]) ?? {};
  const rawEntry = object(rawBody["entry"]) ?? {};
  const id = text(entry["id"]);
  if (!id) throw failed("The sites service answered without a catalog entry.", "bad_response");
  return {
    id,
    name: text(entry["name"]),
    description: text(entry["description"]),
    job: text(entry["job"]),
    industries: strings(entry["industries"]),
    readiness: text(entry["readiness"]),
    hosted: entry["hosted"] === true,
    actions: strings(entry["actions"]),
    fit: num(body["fit"]) ?? 0,
    missing: text(body["missing"]),
    added: body["added"] === true,
    setup: parseSetup(entry["setup"], rawEntry["setup"]),
    prerequisites: parseStatuses(body["prerequisites"], rawBody["prerequisites"]),
    state: stateOf(body["state"]),
  };
}

/** Normalizes ListAgentCatalogResponse. */
export function parseCatalogList(raw: unknown): CatalogList {
  const rawBody = object(raw) ?? {};
  const body = object(camelKeys(raw)) ?? {};
  const counts = (v: unknown): CategoryCount[] =>
    objects(v).map((c) => ({ value: text(c["value"]), count: num(c["count"]) ?? 0 }));
  const entries = Array.isArray(rawBody["entries"]) ? (rawBody["entries"] as unknown[]) : [];
  return {
    entries: entries.map(parseCatalogEntry),
    totalSize: num(body["totalSize"]) ?? entries.length,
    jobs: counts(body["jobs"]),
    industries: counts(body["industries"]),
    readiness: counts(body["readiness"]),
  };
}

/** Who is asking, about which site. */
export interface SiteRef {
  config: Config;
  token: string;
  orgId: string;
  siteId: string;
}

/** @returns `/v1/organizations/{org}/sites/{site}`, under the sites endpoint. */
function siteUrl(t: SiteRef): string {
  return `${t.config.endpoints.sites}/v1/organizations/${encodeURIComponent(t.orgId)}/sites/${encodeURIComponent(t.siteId)}`;
}

/** @returns The resource name of one of a site's hosted agents. */
export function hostedAgentName(t: SiteRef, agent: string): string {
  return `organizations/${t.orgId}/sites/${t.siteId}/hostedAgents/${agent}`;
}

/**
 * True for a 404 that comes from a service without the route, not from the service saying the
 * thing is missing: no reason, and no NOT_FOUND status code in the body.
 */
export function isMissingRoute(err: unknown): boolean {
  return (
    err instanceof CliError &&
    err.reason === "request_failed" &&
    err.details["status"] === 404 &&
    err.details["error_info"] === undefined &&
    err.details["rpc_code"] !== RPC.NOT_FOUND
  );
}

/** The service predates hosted agents by catalog id. Thrown so a caller can fall back. */
export class HostedAgentsUnavailable extends Error {
  constructor() {
    super("This service doesn't offer hosted agents by catalog id.");
    this.name = "HostedAgentsUnavailable";
  }
}

/** @returns The service's reason, when it sent one of NxisAI's. */
function serviceReason(err: CliError): ErrorInfo | undefined {
  const info = err.details["error_info"] as ErrorInfo | undefined;
  return info && info.domain === ERROR_DOMAIN ? info : undefined;
}

/** @returns A comma-separated metadata value as a list. */
function listOf(value: string | undefined): string[] {
  return (value ?? "").split(",").map((v) => v.trim()).filter(Boolean);
}

/** What a refusal is about, for the mapped error's details. */
export interface RefusalContext {
  agent: string;
  /** For `connection_required`: who to ask for the site's connections. */
  site?: SiteRef;
  /** The version the write expected, for `version_conflict`. */
  expectedVersion?: number;
}

/** @returns The site's connection names, or an empty list when they can't be read. */
async function connectionNames(site: SiteRef | undefined): Promise<string[]> {
  if (!site) return [];
  try {
    return (await listConnections(site)).connections.map((c) => c.name);
  } catch {
    return [];
  }
}

/**
 * Maps a refusal of the hosted agent RPCs onto the CLI's reasons, by the service's ErrorInfo
 * reason first, then by its status code.
 *
 * @returns The error to throw. {@link HostedAgentsUnavailable} for a service without the routes.
 */
export async function mapRefusal(err: unknown, c: RefusalContext): Promise<Error> {
  if (!(err instanceof CliError) || err.reason !== "request_failed") return err as Error;
  if (isMissingRoute(err)) return new HostedAgentsUnavailable();
  const message = plainText(err.message);
  const info = serviceReason(err);
  const code = err.details["rpc_code"];
  const status = err.details["status"];
  const m = info?.metadata ?? {};
  const agent = m["agent"] || c.agent;
  const unmet = m["unmet"] ? { unmet: listOf(m["unmet"]) } : {};
  switch (info?.reason) {
    case "AGENT_NOT_FOUND":
      return failed(message || `There is no agent called "${plainText(agent)}" in the catalog.`, "unknown_agent", { agent });
    case "AGENT_NOT_HOSTED":
      return failed(
        message || `NxisAI doesn't host "${plainText(agent)}" yet.`,
        "agent_not_hosted",
        { agent, readiness: m["readiness"] || null },
      );
    case "INVALID_SETTING":
      return failed(message, "invalid_input", {
        agent,
        field: m["setting"] ? `settings.${m["setting"]}` : "settings",
        rule: m["rule"] || null,
        ...(m["limit"] ? { limit: num(m["limit"]) ?? m["limit"] } : {}),
        ...(m["settings"] ? { settings: listOf(m["settings"]) } : {}),
      });
    case "MODEL_RETIRED":
      return failed(message, "model_retired", { agent, model: m["model"] || null, allowed: listOf(m["allowed"]) });
    case "CONNECTION_REQUIRED": {
      const connections = await connectionNames(c.site);
      const hint = connections.length
        ? ` Run it again with --connection <name>: ${connections.map((n) => `"${plainText(n)}"`).join(", ")}.`
        : " The site has no connections yet: create one with `nxis connections create --name <name> --url <https url>`, then run this again with --connection <name>.";
      return needsUser((message || `${agent} needs a connection to send requests through.`) + hint, "connection_required", {
        agent,
        action_types: listOf(m["action_types"]),
        connections,
        ...unmet,
      });
    }
    case "CONNECTION_NOT_FOUND":
      return needsUser(message || "There is no such connection on this site.", "connection_not_found", {
        agent,
        connection: m["connection"] || null,
      });
    case "CONNECTION_UNUSABLE":
      return needsUser(message, "connection_unusable", { agent, action_type: m["action_type"] || null, ...unmet });
    case "ACTIONS_OFF":
      return needsUser(message, "actions_off", { agent, ...unmet });
    case "RECORDS_MISSING":
      return needsUser(message, "records_missing", { agent, types: listOf(m["types"]), ...unmet });
    case "OPENING_HOURS_REQUIRED":
      return needsUser(message, "opening_hours_required", { agent, ...unmet });
    case "AGENT_CONFIG_CHANGED":
      return versionConflict(c.expectedVersion);
    case "INVALID_ARGUMENT":
      return failed(message, "invalid_input", { agent, field: m["field"] || null });
    default:
      break;
  }
  if (code === RPC.ABORTED || status === 409) return versionConflict(c.expectedVersion);
  if (!info && (code === RPC.NOT_FOUND || status === 404)) {
    return failed(message || `There is no agent called "${plainText(c.agent)}" in the catalog.`, "unknown_agent", { agent: c.agent });
  }
  if (code === RPC.INVALID_ARGUMENT) return failed(message, "invalid_input", { agent });
  return err;
}

/** The hosted agents' settings changed in between. */
function versionConflict(expected: number | undefined): CliError {
  return failed(
    "The hosted agents' settings were changed by someone else while this ran. Run the command again.",
    "version_conflict",
    { expected_version: expected ?? null },
  );
}

/**
 * Lists a site's hosted agents.
 *
 * @throws {@link HostedAgentsUnavailable} against a service without the route; otherwise as {@link mapRefusal}.
 */
export async function listHostedAgents(t: SiteRef): Promise<HostedAgentList> {
  try {
    return parseHostedAgentList((await request<unknown>(`${siteUrl(t)}/hostedAgents`, { token: t.token })) ?? {});
  } catch (err) {
    throw await mapRefusal(err, { agent: "" });
  }
}

/**
 * Reads one hosted agent, by catalog id.
 *
 * @throws {@link HostedAgentsUnavailable} against a service without the route; `unknown_agent`,
 * `agent_not_hosted` (exit 1); otherwise as {@link mapRefusal}.
 */
export async function getHostedAgent(t: SiteRef, agent: string): Promise<HostedAgentView> {
  try {
    const raw = await request<unknown>(`${siteUrl(t)}/hostedAgents/${encodeURIComponent(agent)}`, { token: t.token });
    return parseHostedAgent(raw ?? {});
  } catch (err) {
    throw await mapRefusal(err, { agent });
  }
}

/** A change to one hosted agent's settings or pause. */
export interface HostedAgentUpdate {
  /** Settings to set, by name; `null` returns one to its default. */
  settings?: Record<string, unknown>;
  /** The agent's own pause; `null` resumes it. */
  killSwitch?: { scope: "AGENT" | "TOOLS"; reason: string } | null;
  expectedVersion: number;
}

/**
 * Changes an agent's settings or its own pause (UpdateHostedAgent).
 *
 * @remarks
 * No update mask is sent: the service then changes each setting sent (`null` clears one) and the
 * pause when it is sent. A gateway may re-case a mask's paths, and setting names are data.
 */
export async function updateHostedAgent(t: SiteRef, agent: string, change: HostedAgentUpdate): Promise<HostedAgentView> {
  const body: Record<string, unknown> = { name: hostedAgentName(t, agent) };
  if (change.settings && Object.keys(change.settings).length > 0) body["settings"] = change.settings;
  if (change.killSwitch !== undefined) body["kill_switch"] = change.killSwitch ?? {};
  const query = new URLSearchParams();
  if (change.expectedVersion > 0) query.set("expected_version", String(change.expectedVersion));
  const qs = query.toString();
  try {
    const raw = await request<unknown>(`${siteUrl(t)}/hostedAgents/${encodeURIComponent(agent)}${qs ? `?${qs}` : ""}`, {
      method: "PATCH",
      token: t.token,
      body,
    });
    return parseHostedAgent(raw ?? {});
  } catch (err) {
    throw await mapRefusal(err, { agent, site: t, expectedVersion: change.expectedVersion });
  }
}

/** Turning one hosted agent on or off. */
export interface HostedAgentSwitch {
  enabled: boolean;
  settings?: Record<string, unknown>;
  /** A connection name or id to route the agent's own action type to first. */
  connection?: string;
  expectedVersion: number;
}

/** Turns an agent on or off (SetHostedAgentEnabled), with any settings in the same save. */
export async function setHostedAgentEnabled(t: SiteRef, agent: string, change: HostedAgentSwitch): Promise<HostedAgentView> {
  const body: Record<string, unknown> = { name: hostedAgentName(t, agent), enabled: change.enabled };
  if (change.settings && Object.keys(change.settings).length > 0) body["settings"] = change.settings;
  if (change.connection) body["connection"] = change.connection;
  if (change.expectedVersion > 0) body["expected_version"] = String(change.expectedVersion);
  try {
    const raw = await request<unknown>(`${siteUrl(t)}/hostedAgents/${encodeURIComponent(agent)}:setEnabled`, {
      method: "POST",
      token: t.token,
      body,
    });
    return parseHostedAgent(raw ?? {});
  } catch (err) {
    throw await mapRefusal(err, { agent, site: t, expectedVersion: change.expectedVersion });
  }
}

/** Filters for the catalog. */
export interface CatalogQuery {
  jobs?: string[];
  industries?: string[];
  readiness?: string[];
  added?: boolean;
  query?: string;
  byFit?: boolean;
}

/** Thrown when the service has no agent catalog. */
function catalogUnavailable(): CliError {
  return failed(
    "This NxisAI environment doesn't offer the agent catalog yet. Update the CLI or try again later.",
    "agent_catalog_unavailable",
  );
}

/** Lists the agent catalog for a site (ListAgentCatalog). */
export async function listAgentCatalog(t: SiteRef, q: CatalogQuery = {}): Promise<CatalogList> {
  const query = new URLSearchParams();
  for (const j of q.jobs ?? []) query.append("job", j);
  for (const i of q.industries ?? []) query.append("industry", i);
  for (const r of q.readiness ?? []) query.append("readiness", r);
  if (q.added !== undefined) query.set("added", String(q.added));
  if (q.query) query.set("query", q.query);
  if (q.byFit) query.set("order_by", "fit");
  const qs = query.toString();
  try {
    const raw = await request<unknown>(`${siteUrl(t)}/agentCatalog${qs ? `?${qs}` : ""}`, { token: t.token });
    return parseCatalogList(raw ?? {});
  } catch (err) {
    if (isMissingRoute(err)) throw catalogUnavailable();
    throw await mapRefusal(err, { agent: "" });
  }
}

/**
 * Reads one catalog entry, for a site (GetAgentCatalogEntry).
 *
 * @throws CliError `unknown_agent` (exit 1) when no entry has the id; `agent_catalog_unavailable`
 * against a service without the catalog.
 */
export async function getAgentCatalogEntry(t: SiteRef, id: string): Promise<CatalogEntry> {
  try {
    const raw = await request<unknown>(`${siteUrl(t)}/agentCatalog/${encodeURIComponent(id)}`, { token: t.token });
    return parseCatalogEntry(raw ?? {});
  } catch (err) {
    if (isMissingRoute(err)) throw catalogUnavailable();
    throw await mapRefusal(err, { agent: id });
  }
}
