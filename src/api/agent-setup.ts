/**
 * Sites API: a site's hosted-agent setup, and the data processing agreement its agents need before
 * they go live.
 *
 * @remarks
 * `GET …/agentSetup` reads the setup: the agreement's current version (empty while none is
 * published), whether this organization and site has accepted it, and every acceptance, oldest
 * first. `POST …/agentSetup:acceptDpa` accepts one version, which must be the current one: the
 * service refuses any other, so a version published after the user read one is never accepted
 * unread. An acceptance names the person who made it, so a service token can't accept.
 *
 * Each version of the agreement is published at `<base>/<version>`, the base being
 * `https://nxis.ai/dpa` unless `NXIS_DPA_URL` says otherwise ({@link dpaBaseUrl}).
 */

import type { Config } from "../config.js";
import { CliError, failed, needsUser } from "../errors.js";
import { request } from "../http.js";
import { camelKeys } from "./agent-config.js";

/** Where the agreement is published when `NXIS_DPA_URL` is not set. */
export const DEFAULT_DPA_URL = "https://nxis.ai/dpa";

/** One acceptance of the agreement. */
export interface DpaAcceptance {
  version: string;
  /** Who accepted it: the member's account, as the sign-in names it. */
  acceptedBy: string;
  /** RFC 3339, or "" when the service sent none. */
  acceptTime: string;
  /** The legal entity that accepted for the site, when it isn't the organization; "" for the organization's. */
  legalEntity: string;
}

/**
 * Whether the agreement holds the site's agents back, as the service says:
 * - `not_published`: no version is published;
 * - `accepted`: the current version is accepted for the site;
 * - `grace`: an earlier version is accepted; the agents stay live until {@link AgentSetup.graceEnd};
 * - `required`: the current version isn't accepted, so the agents don't answer visitors until it is;
 * - "": a service that doesn't say.
 */
export type DpaStatus = "not_published" | "accepted" | "grace" | "required" | "";

/** A site's hosted-agent setup, as far as the agreement goes. */
export interface AgentSetup {
  /** The agreement's current version; "" while none is published. */
  currentVersion: string;
  /** The current version is accepted for the site, so going live is allowed. */
  current: boolean;
  /** The latest acceptance that counts for the site, of any version; null for none. */
  acceptance: DpaAcceptance | null;
  /** The site's own acceptances, oldest first: a separate legal entity's, or from before the organization accepted. */
  acceptances: DpaAcceptance[];
  /** The organization's acceptances, oldest first. They cover every site of the organization but one of another legal entity. */
  organizationAcceptances: DpaAcceptance[];
  /** The legal entity the site belongs to, when it isn't the organization; "" when the organization accepts for it. */
  legalEntity: string;
  status: DpaStatus;
  /** With `grace`, when it ends (RFC 3339); "" otherwise. */
  graceEnd: string;
}

/**
 * Where the agreement is published: `NXIS_DPA_URL`, or {@link DEFAULT_DPA_URL}.
 *
 * @remarks
 * Nothing is sent there (it is a link for a person to read), so any http or https URL will do, a
 * local or staging copy of the site included. Trailing slashes are removed.
 *
 * @throws CliError `invalid_dpa_url` (exit 1) when the variable is set but not an http(s) URL.
 */
export function dpaBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.NXIS_DPA_URL?.trim();
  if (!value) return DEFAULT_DPA_URL;
  let protocol = "";
  try {
    protocol = new URL(value).protocol;
  } catch {
    protocol = "";
  }
  if (protocol !== "https:" && protocol !== "http:") {
    throw failed(`NXIS_DPA_URL must be an http or https URL (got "${value}").`, "invalid_dpa_url", { value });
  }
  return value.replace(/\/+$/, "");
}

/** @returns Where agreement `version` is published: `<base>/<version>`. */
export function dpaUrl(version: string, base: string = DEFAULT_DPA_URL): string {
  return `${base.replace(/\/+$/, "")}/${encodeURIComponent(version)}`;
}

/** @returns The setup's resource name. */
export function setupName(orgId: string, siteId: string): string {
  return `organizations/${orgId}/sites/${siteId}/agentSetup`;
}

/** @returns The URL of a site's agent setup. */
export function agentSetupUrl(config: Config, orgId: string, siteId: string): string {
  return (
    `${config.endpoints.sites}/v1/organizations/${encodeURIComponent(orgId)}` +
    `/sites/${encodeURIComponent(siteId)}/agentSetup`
  );
}

/** @returns The value when it is a plain object, else undefined. */
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** @returns The value when it is a string, else "". */
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** @returns An acceptance, or null without a version. */
function acceptanceOf(raw: unknown): DpaAcceptance | null {
  const a = object(raw);
  const version = text(a?.["version"]).trim();
  return version
    ? { version, acceptedBy: text(a?.["acceptedBy"]), acceptTime: text(a?.["acceptTime"]), legalEntity: text(a?.["legalEntity"]).trim() }
    : null;
}

const STATUSES: DpaStatus[] = ["", "not_published", "accepted", "grace", "required"];

/** @returns The status, from its enum name (`DPA_GRACE`) or number. */
function statusOf(raw: unknown): DpaStatus {
  if (typeof raw === "number") return STATUSES[raw] ?? "";
  const name = text(raw).replace(/^DPA_/, "").toLowerCase() as DpaStatus;
  return STATUSES.includes(name) ? name : "";
}

function acceptancesOf(raw: unknown): DpaAcceptance[] {
  return (Array.isArray(raw) ? raw : []).map(acceptanceOf).filter((a): a is DpaAcceptance => a !== null);
}

/**
 * Normalizes a setup as the service returned it, in snake_case or lowerCamelCase.
 *
 * @throws CliError `bad_response` (exit 1) when the body is not an object.
 */
export function parseAgentSetup(raw: unknown): AgentSetup {
  const body = object(camelKeys(raw ?? {}));
  if (!body) throw failed("The sites service answered without an agent setup.", "bad_response");
  return {
    currentVersion: text(body["currentDpaVersion"]).trim(),
    current: body["dpaCurrent"] === true,
    acceptance: acceptanceOf(body["dpaAcceptance"]),
    acceptances: acceptancesOf(body["dpaAcceptances"]),
    organizationAcceptances: acceptancesOf(body["organizationDpaAcceptances"]),
    legalEntity: text(body["legalEntity"]).trim(),
    status: statusOf(body["dpaStatus"]),
    graceEnd: text(body["dpaGraceEndTime"]),
  };
}

/** Reads a site's agent setup. */
export async function getAgentSetup(config: Config, token: string, orgId: string, siteId: string): Promise<AgentSetup> {
  return parseAgentSetup(await request<unknown>(agentSetupUrl(config, orgId, siteId), { token }));
}

/** The service's two refusals of an acceptance, by their messages. */
const NOT_PUBLISHED = /no data processing agreement is published/i;
const OTHER_VERSION = /current data processing agreement is version (\S+?),? not /i;

/**
 * Accepts the agreement at `version`, which must be the one the user was shown: for the organization, for all of its
 * sites, or with `legalEntity` for the other legal entity the site belongs to, for that site only.
 *
 * @param base - Where the agreement is published, for the links in a refusal.
 * @returns The setup after accepting.
 * @throws CliError `dpa_not_published` (exit 1) when no version is published;
 * `dpa_version_changed` (exit 2, with the new `version` and its `url`) when `version` is no longer
 * the current one; and whatever {@link request} throws, `dry_run` included.
 */
export async function acceptAgentDpa(
  config: Config,
  token: string,
  orgId: string,
  siteId: string,
  version: string,
  base: string = DEFAULT_DPA_URL,
  legalEntity = "",
): Promise<AgentSetup> {
  const url = `${agentSetupUrl(config, orgId, siteId)}:acceptDpa`;
  const entity = legalEntity.trim();
  const body = { name: setupName(orgId, siteId), version, ...(entity ? { legal_entity: entity } : {}) };
  try {
    return parseAgentSetup(await request<unknown>(url, { method: "POST", token, body }));
  } catch (err) {
    if (!(err instanceof CliError) || err.reason !== "request_failed") throw err;
    if (NOT_PUBLISHED.test(err.message)) throw notPublished();
    const other = OTHER_VERSION.exec(err.message);
    if (other?.[1]) throw versionChanged(version, other[1], base);
    throw err;
  }
}

/** The refusal when no version is published: nothing to accept, and nothing the user can do yet. */
export function notPublished(): CliError {
  return failed(
    "NxisAI hasn't published its data processing agreement for hosted agents yet, so there is nothing to accept. " +
      "Going live waits for it; you can set up and preview your agents meanwhile.",
    "dpa_not_published",
    { version: null, url: null },
  );
}

/** The refusal when a newer version was published after `shown` was read: the user reads the new one first. */
export function versionChanged(shown: string, current: string, base: string): CliError {
  const url = dpaUrl(current, base);
  return needsUser(
    `Version ${shown} is no longer the current data processing agreement: version ${current} replaced it, ` +
      `and it was not accepted. Read version ${current} at ${url}, then run \`nxis agents dpa accept\` again.`,
    "dpa_version_changed",
    { version: current, url, refused_version: shown },
  );
}
