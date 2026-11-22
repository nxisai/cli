/**
 * Sites API: a site's hosted agent settings, the on-page assistant and the Support Agent.
 *
 * @remarks
 * One document per site, read whole and written whole. An update replaces every field the caller
 * can set, so a change is always read, modified, and written back in full, with the version it was
 * read at: a write against a version someone else has since moved past is refused (HTTP 409)
 * rather than overwriting their change unseen.
 *
 * Responses may name fields in snake_case or lowerCamelCase, depending on the gateway in front of
 * the service, and `version` is a 64-bit integer, so it may arrive as a string. Both are read;
 * writes are sent in lowerCamelCase, which every gateway accepts.
 */

import type { Config } from "../config.js";
import { CliError, failed, needsUser } from "../errors.js";
import { request } from "../http.js";
import { num } from "./shapes.js";

/**
 * Who a kill switch silences: every turn, or only actions (tools that change something; read-only lookups go on).
 *
 * @remarks
 * There is one for the whole site (`killSwitch`) and one for each agent (`page.killSwitch`,
 * `support.killSwitch`). An agent is held to the stricter of its own and the site's.
 */
export type KillScope = "AGENT" | "TOOLS";

/**
 * The fields of a config the caller can set, as they are sent back.
 *
 * @remarks
 * Each is kept exactly as read (keys in lowerCamelCase), so a command that changes one field
 * leaves every other one as it was, including fields this version of the CLI does not know.
 */
export interface SettableConfig {
  name: string;
  page?: Record<string, unknown>;
  support?: Record<string, unknown>;
  policy?: string;
  killSwitch?: Record<string, unknown>;
  monthlySpendCapNxc?: unknown;
  bookingDestination?: Record<string, unknown>;
  transcripts?: Record<string, unknown>;
}

/** A site's hosted agent settings, as read. */
export interface AgentConfig {
  /** Goes up by one on every change; 0 for a site that has never had any. */
  version: number;
  /** What a write sends back, with one or more fields changed. */
  settable: SettableConfig;
  /** The site's MCP server, which the Support Agent reads; null when there is none. */
  mcpServer: { url: string; public: boolean; apiKeyId: string | null } | null;
  /** The hosts the agents answer on: the site's origins, while it is verified. */
  verifiedHosts: string[];
  updateTime: string | null;
  /**
   * Whether visitors reach the agents: false while the site is in preview, true once it is live, and
   * null when unset (a site set up before preview existed, which is live). Read only: a write never
   * sends it, and the service keeps it as stored. Going live is refused until the current data
   * processing agreement is accepted.
   */
  live: boolean | null;
}

/** The on-page assistant's settings. */
export interface PageView {
  enabled: boolean;
  /** Empty: the default model. */
  model: string;
  /** This agent's own pause; null when it is not paused. */
  killSwitch: KillSwitchView | null;
  /** How the chat looks on the site; each part empty for the default. */
  branding: PageBrandingView;
  /** The site's privacy page, linked from the chat's hosted-agent notice; empty for no link. */
  privacyUrl: string;
}

/**
 * The on-page chat's branding (`page.branding`): what visitors see on the chat button and in the chat.
 *
 * @remarks
 * Each part empty means the default look. Read by the site's script config, never by the edge.
 */
export interface PageBrandingView {
  /** The agent's name, at most {@link PAGE_LIMITS.brandingName} characters. */
  name: string;
  /** The mark: an https image URL. */
  logoUrl: string;
  /** `#rgb` or `#rrggbb`. */
  accentColor: string;
}

/**
 * The service's limits on `page.branding` and `page.privacy_url` (its `AgentConfigRules`:
 * `MaxBrandingName`, `MaxPageUrl`), so a value it would refuse is refused before anything is sent.
 */
export const PAGE_LIMITS = {
  /** `page.branding.name`, in UTF-16 code units, as the service counts. */
  brandingName: 60,
  /** `page.branding.logo_url` and `page.privacy_url`. */
  url: 2048,
} as const;

/** The Support Agent's settings. */
export interface SupportView {
  enabled: boolean;
  model: string;
  label: string;
  description: string;
  examples: string[];
  /** This agent's own pause; null when it is not paused. */
  killSwitch: KillSwitchView | null;
}

/** What is kept of the hosted agents' conversations, and where each message is sent. */
export interface TranscriptsView {
  /** False with "don't store": NxisAI keeps none, and the webhook (if any) is the only copy. */
  store: boolean;
  /** Days a transcript is kept; the default when unset. */
  retentionDays: number;
  /** Empty: no webhook. */
  webhookUrl: string;
  /** The id (`wh_…`) of the webhook's signing secret, never the secret; empty without one. */
  webhookSecretId: string;
}

/** Days a transcript is kept when the config sets none. */
export const DEFAULT_RETENTION_DAYS = 30;

/** The kill switch; null when it is off. */
export interface KillSwitchView {
  scope: KillScope;
  reason: string;
}

/** @returns The key in lowerCamelCase: `kill_switch` → `killSwitch`. */
function camel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * A JSON value with every object key in lowerCamelCase.
 *
 * @remarks
 * Only keys change. Values, strings inside arrays included, are kept as they are.
 */
export function camelKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [camel(k), camelKeys(v)]));
  }
  return value;
}

/** @returns The value when it is a plain object, else undefined. */
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** @returns The value when it is a string, else "". */
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The URL of a site's agent config.
 *
 * @param config - Where the CLI points.
 * @param orgId - The organization.
 * @param siteId - The site, by id.
 */
export function agentConfigUrl(config: Config, orgId: string, siteId: string): string {
  return (
    `${config.endpoints.sites}/v1/organizations/${encodeURIComponent(orgId)}` +
    `/sites/${encodeURIComponent(siteId)}/agentConfig`
  );
}

/**
 * Normalizes a config as the service returned it.
 *
 * @param raw - The response body, in snake_case or lowerCamelCase.
 * @param fallbackName - The resource name, for a site that has no config yet and so none in it.
 * @throws CliError `bad_response` (exit 1) when the body is not an object.
 */
export function parseAgentConfig(raw: unknown, fallbackName: string): AgentConfig {
  const body = object(camelKeys(raw));
  if (!body) throw failed("The sites service answered without an agent config.", "bad_response");

  const settable: SettableConfig = { name: text(body["name"]) || fallbackName };
  for (const key of ["page", "support", "killSwitch", "bookingDestination", "transcripts"] as const) {
    const value = object(body[key]);
    if (value) settable[key] = value;
  }
  if (typeof body["policy"] === "string") settable.policy = body["policy"];
  if (body["monthlySpendCapNxc"] !== undefined && body["monthlySpendCapNxc"] !== null) {
    settable.monthlySpendCapNxc = body["monthlySpendCapNxc"];
  }

  const mcp = object(body["mcpServer"]);
  const mcpUrl = text(mcp?.["url"]);
  const hosts = Array.isArray(body["verifiedHosts"]) ? body["verifiedHosts"] : [];
  return {
    version: num(body["version"]) ?? 0,
    settable,
    mcpServer: mcp && mcpUrl ? { url: mcpUrl, public: mcp["public"] === true, apiKeyId: text(mcp["apiKeyId"]) || null } : null,
    verifiedHosts: hosts.filter((h): h is string => typeof h === "string"),
    updateTime: text(body["updateTime"]) || null,
    live: typeof body["live"] === "boolean" ? body["live"] : null,
  };
}

/** @returns The on-page assistant's settings in a config. */
export function pageOf(settable: SettableConfig): PageView {
  return {
    enabled: settable.page?.["enabled"] === true,
    model: text(settable.page?.["model"]),
    killSwitch: killOf(object(settable.page?.["killSwitch"])),
    branding: brandingOf(settable),
    privacyUrl: text(settable.page?.["privacyUrl"]),
  };
}

/** @returns The on-page chat's branding in a config, each part empty when unset. */
export function brandingOf(settable: SettableConfig): PageBrandingView {
  const b = object(settable.page?.["branding"]);
  return { name: text(b?.["name"]), logoUrl: text(b?.["logoUrl"]), accentColor: text(b?.["accentColor"]) };
}

/** @returns The Support Agent's settings in a config. */
export function supportOf(settable: SettableConfig): SupportView {
  const s = settable.support;
  const examples = Array.isArray(s?.["examples"]) ? (s["examples"] as unknown[]) : [];
  return {
    enabled: s?.["enabled"] === true,
    model: text(s?.["model"]),
    label: text(s?.["label"]),
    description: text(s?.["description"]),
    examples: examples.filter((e): e is string => typeof e === "string"),
    killSwitch: killOf(object(s?.["killSwitch"])),
  };
}

/** @returns The transcript settings in a config. */
export function transcriptsOf(settable: SettableConfig): TranscriptsView {
  const t = settable.transcripts;
  const days = num(t?.["retentionDays"]);
  return {
    store: t?.["doNotStore"] !== true,
    retentionDays: days && days > 0 ? days : DEFAULT_RETENTION_DAYS,
    webhookUrl: text(t?.["webhookUrl"]),
    webhookSecretId: text(t?.["webhookSecretId"]),
  };
}

/** @returns The site-wide kill switch in a config, or null when it is off. */
export function killSwitchOf(settable: SettableConfig): KillSwitchView | null {
  return killOf(settable.killSwitch);
}

/**
 * @returns A kill switch, the site's or an agent's, or null when it is off.
 *
 * @remarks
 * The scope arrives as the enum's name, or as its number from a gateway that sends enums as
 * integers. Unset and `KILL_SCOPE_UNSPECIFIED` both mean off.
 */
export function killOf(raw: Record<string, unknown> | undefined): KillSwitchView | null {
  const scope = raw?.["scope"];
  const reason = text(raw?.["reason"]);
  if (scope === "AGENT" || scope === 1) return { scope: "AGENT", reason };
  if (scope === "TOOLS" || scope === 2) return { scope: "TOOLS", reason };
  return null;
}

/**
 * The policy document's own `version`, which the service sets to `v<version>` when it changes.
 *
 * @returns The version, or null for no policy, one without a version, or text that isn't JSON.
 */
export function policyVersionOf(policy: string | undefined): string | null {
  const parsed = parsePolicy(policy);
  const version = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>)["version"] : undefined;
  return typeof version === "string" && version ? version : typeof version === "number" ? String(version) : null;
}

/** @returns The policy text parsed, or null when it is empty or not JSON. */
export function parsePolicy(policy: string | undefined): unknown {
  if (!policy?.trim()) return null;
  try {
    return JSON.parse(policy) as unknown;
  } catch {
    return null;
  }
}

/**
 * Reads a site's agent config.
 *
 * @remarks
 * A site that has never had one answers an empty config at version 0.
 */
export async function getAgentConfig(config: Config, token: string, orgId: string, siteId: string): Promise<AgentConfig> {
  const raw = await request<unknown>(agentConfigUrl(config, orgId, siteId), { token });
  return parseAgentConfig(raw ?? {}, resourceName(orgId, siteId));
}

/** @returns The config's resource name. */
export function resourceName(orgId: string, siteId: string): string {
  return `organizations/${orgId}/sites/${siteId}/agentConfig`;
}

/**
 * Replaces a site's agent config, if it is still at the version it was read at.
 *
 * @param expectedVersion - The version the config was read at.
 * @param settable - Every settable field, as it should be stored.
 * @returns The config as stored, at its new version.
 * @throws CliError `version_conflict` (exit 1) when the config changed since it was read; and
 * whatever {@link request} throws, `dry_run` included.
 */
export async function updateAgentConfig(
  config: Config,
  token: string,
  orgId: string,
  siteId: string,
  expectedVersion: number,
  settable: SettableConfig,
): Promise<AgentConfig> {
  const url = `${agentConfigUrl(config, orgId, siteId)}?expectedVersion=${encodeURIComponent(String(expectedVersion))}`;
  let raw: unknown;
  try {
    raw = await request<unknown>(url, { method: "PATCH", token, body: settable });
  } catch (err) {
    if (isSystemPromptRefusal(err)) throw systemPromptNotSettable();
    if (err instanceof CliError && err.reason === "request_failed" && err.details["status"] === 409) {
      throw failed(
        "The hosted agents' settings were changed by someone else while this ran. Run the command again.",
        "version_conflict",
        { expected_version: expectedVersion },
      );
    }
    throw err;
  }
  return parseAgentConfig(raw ?? {}, resourceName(orgId, siteId));
}

/** The policy key hosted agents' instructions would be set with, which owners can't set. */
export const SYSTEM_PROMPT_KEY = "systemPrompt";

/**
 * The refusal of a policy that sets the hosted agents' instructions.
 *
 * @remarks
 * Exit 2: the owner has something to fix (take the key out), and nothing was saved. The same
 * error is raised before sending, when the file has the key, and when the service refuses it.
 */
export function systemPromptNotSettable(): CliError {
  return needsUser(
    `Hosted agents use NxisAI's instructions, so the policy can't set them. ` +
      `Remove "${SYSTEM_PROMPT_KEY}" from the policy to save the rest.`,
    "system_prompt_not_settable",
    { field: SYSTEM_PROMPT_KEY },
  );
}

/** @returns True when the policy document has a top-level `systemPrompt` key, of any value. */
export function hasSystemPrompt(policy: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(policy, SYSTEM_PROMPT_KEY);
}

/** @returns True for the service's refusal of a policy with `systemPrompt` (HTTP 400 naming the field). */
function isSystemPromptRefusal(err: unknown): boolean {
  return (
    err instanceof CliError &&
    err.reason === "request_failed" &&
    err.details["status"] === 400 &&
    err.message.includes(`${SYSTEM_PROMPT_KEY} can't be set`)
  );
}

/** A hosted agent's instructions, as it uses them: NxisAI's, filled in with the site's details. */
export interface AgentInstructions {
  /** `organizations/{org}/sites/{site}/agentInstructions/{agent}` */
  name: string;
  /** The hosted agent: `page`. */
  agent: string;
  /** The instructions' type: `onpage`. */
  type: string;
  /** From 1. */
  version: number;
  /** The text as the agent uses it, placeholders filled in. */
  text: string;
  /** What each placeholder was filled with (`site`, `label`). */
  values: Record<string, string>;
  /** When this version was published; null when not given. */
  publishTime: string | null;
}

/** @returns The URL of a hosted agent's instructions. */
export function agentInstructionsUrl(config: Config, orgId: string, siteId: string, agent: string): string {
  return (
    `${config.endpoints.sites}/v1/organizations/${encodeURIComponent(orgId)}` +
    `/sites/${encodeURIComponent(siteId)}/agentInstructions/${encodeURIComponent(agent)}`
  );
}

/**
 * Normalizes instructions as the service returned them.
 *
 * @throws CliError `bad_response` (exit 1) when the body is not an object.
 */
export function parseAgentInstructions(raw: unknown): AgentInstructions {
  const body = object(camelKeys(raw));
  if (!body) throw failed("The sites service answered without the agent's instructions.", "bad_response");
  // Map keys are data, not field names: read `values` from the raw body so they stay as sent.
  const rawValues = object(object(raw)?.["values"]) ?? {};
  const values = Object.fromEntries(
    Object.entries(rawValues).filter((e): e is [string, string] => typeof e[1] === "string"),
  );
  return {
    name: text(body["name"]),
    agent: text(body["agent"]),
    type: text(body["type"]),
    version: num(body["version"]) ?? 0,
    text: text(body["text"]),
    values,
    publishTime: text(body["publishTime"]) || null,
  };
}

/**
 * Reads a hosted agent's instructions as it uses them.
 *
 * @param agent - `page` today; the service answers FAILED_PRECONDITION for agents with no fixed instructions.
 * @throws whatever {@link request} throws.
 */
export async function getAgentInstructions(
  config: Config,
  token: string,
  orgId: string,
  siteId: string,
  agent = "page",
): Promise<AgentInstructions> {
  const raw = await request<unknown>(agentInstructionsUrl(config, orgId, siteId, agent), { token });
  return parseAgentInstructions(raw ?? {});
}

/** A notice for an organization's owners about its hosted agents. */
export interface AgentNotice {
  /** `organizations/{org}/agentNotices/{id}` */
  name: string;
  kind: string;
  title: string;
  message: string;
  /** The site ids it concerns (the last part of each `organizations/{org}/sites/{site}`). */
  sites: string[];
  createTime: string | null;
  /** Null until dismissed. */
  dismissTime: string | null;
}

/**
 * Lists an organization's hosted agent notices that haven't been dismissed, newest first.
 *
 * @throws whatever {@link request} throws.
 */
export async function listAgentNotices(config: Config, token: string, orgId: string): Promise<AgentNotice[]> {
  const url = `${config.endpoints.sites}/v1/organizations/${encodeURIComponent(orgId)}/agentNotices`;
  const body = object(camelKeys(await request<unknown>(url, { token })));
  const notices = Array.isArray(body?.["notices"]) ? (body["notices"] as unknown[]) : [];
  return notices
    .map((n) => object(n))
    .filter((n): n is Record<string, unknown> => n !== undefined)
    .map((n) => ({
      name: text(n["name"]),
      kind: text(n["kind"]),
      title: text(n["title"]),
      message: text(n["message"]),
      sites: (Array.isArray(n["sites"]) ? (n["sites"] as unknown[]) : [])
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.split("/").pop() ?? s),
      createTime: text(n["createTime"]) || null,
      dismissTime: text(n["dismissTime"]) || null,
    }))
    .filter((n) => !n.dismissTime);
}
