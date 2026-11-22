/**
 * Sites API: a site's connections, the named addresses on the site's own servers that hosted
 * agents and actions send requests to.
 *
 * @remarks
 * A connection is a name, an address and one signing secret. Many routes can share one: the site
 * default, a kind of action, or a hosted agent's own route (`quote`, `booking`).
 *
 * The raw signing secret is in exactly two answers, creating a connection and rotating its secret,
 * and nowhere else. It is returned here beside the connection ({@link WithSecret}) and never inside
 * it: {@link Connection} has no field that could carry it, so a list, a get or an error built from
 * one cannot show it. The `--verbose` trace prints requests only, and redacts `signing_secret`.
 *
 * Responses may name fields in snake_case or lowerCamelCase, depending on the gateway in front of
 * the service; both are read. Requests are sent in snake_case, which the transcoder accepts.
 */

import type { Config } from "../config.js";
import { CliError, failed, needsUser } from "../errors.js";
import { ERROR_DOMAIN, request, type ErrorInfo } from "../http.js";
import { plainText } from "../output.js";
import { camelKeys } from "./agent-config.js";

/** What routes to a connection now. */
export interface ConnectionUsage {
  /** Hosted agents whose requests go to it: `quote`, `booking`. */
  agents: string[];
  /** Action routes that name it: `default`, or a schema.org action type (`QuoteAction` …). */
  actionTypes: string[];
}

/** A connection as read. It never holds the signing secret. */
export interface Connection {
  /** 24 hex characters. */
  id: string;
  /** `organizations/{org}/sites/{site}/connections/{id}` */
  resourceName: string;
  name: string;
  url: string;
  method: string;
  encoding: string;
  /** Non-secret headers sent with each request. */
  headers: Record<string, string>;
  /** The first 8 characters of the signing secret. */
  secretPreview: string;
  createdAt: string | null;
  secretRotatedAt: string | null;
  isDefault: boolean;
  usedBy: ConnectionUsage;
}

/** A site's connections, oldest first, and which one is its default. */
export interface ConnectionList {
  connections: Connection[];
  /** Empty when the site has no default. */
  defaultConnectionId: string;
}

/** A connection with its new raw signing secret, from a create or a rotation only. */
export interface WithSecret {
  connection: Connection;
  signingSecret: string;
}

/** The service's limits, checked first so the error names the flag. */
export const CONNECTION_LIMITS = { name: 60, url: 500 } as const;

/** gRPC status codes the commands tell apart. */
const RPC = { INVALID_ARGUMENT: 3, NOT_FOUND: 5, ALREADY_EXISTS: 6, FAILED_PRECONDITION: 9 } as const;

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

/** @returns The enum's name; a number (from a gateway that sends enums as integers) by its name. */
function enumName(value: unknown, names: Record<number, string>, fallback: string): string {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number") return names[value] ?? fallback;
  return fallback;
}

/**
 * Normalizes one connection, keeping only the fields {@link Connection} names.
 *
 * @remarks
 * Built field by field from the service's answer, so nothing else it sends (a secret, say) can
 * reach the output.
 *
 * @throws CliError `bad_response` (exit 1) when the body is not a connection.
 */
export function parseConnection(raw: unknown): Connection {
  // Header names are data, not field names: read them from the raw body so they stay as sent.
  const rawHeaders = object(object(raw)?.["headers"]) ?? {};
  const body = object(camelKeys(raw));
  if (!body || !text(body["id"])) throw failed("The sites service answered without a connection.", "bad_response");
  const used = object(body["usedBy"]);
  return {
    id: text(body["id"]),
    resourceName: text(body["resourceName"]),
    name: text(body["name"]),
    url: text(body["url"]),
    method: enumName(body["method"], { 1: "POST", 2: "PUT" }, "POST"),
    encoding: enumName(body["encoding"], { 1: "JSON", 2: "FORM_URLENCODED" }, "JSON"),
    headers: Object.fromEntries(Object.entries(rawHeaders).filter((e): e is [string, string] => typeof e[1] === "string")),
    secretPreview: text(body["secretPreview"]),
    createdAt: text(body["createdAt"]) || null,
    secretRotatedAt: text(body["secretRotatedAt"]) || null,
    isDefault: body["isDefault"] === true,
    usedBy: { agents: strings(used?.["agents"]), actionTypes: strings(used?.["actionTypes"]) },
  };
}

/** @returns The list in an answer shaped as ListConnectionsResponse. */
export function parseConnectionList(raw: unknown): ConnectionList {
  const body = object(raw) ?? {};
  const list = Array.isArray(body["connections"]) ? (body["connections"] as unknown[]) : [];
  return {
    connections: list.map(parseConnection),
    defaultConnectionId: text(body["default_connection_id"] ?? body["defaultConnectionId"]),
  };
}

/** @returns The answer to a create or a rotation: the connection and its new secret. */
function parseWithSecret(raw: unknown): WithSecret {
  const body = object(raw) ?? {};
  const secret = text(body["signing_secret"] ?? body["signingSecret"]);
  if (!secret) throw failed("The sites service answered without the new signing secret.", "bad_response");
  return { connection: parseConnection(body["connection"]), signingSecret: secret };
}

/** @returns The resource name of a site. */
export function siteParent(orgId: string, siteId: string): string {
  return `organizations/${orgId}/sites/${siteId}`;
}

/** @returns The URL of a site's connections collection. */
function collectionUrl(config: Config, orgId: string, siteId: string): string {
  return (
    `${config.endpoints.sites}/v1/organizations/${encodeURIComponent(orgId)}` +
    `/sites/${encodeURIComponent(siteId)}/connections`
  );
}

/** @returns The URL of one connection. */
function connectionUrl(config: Config, orgId: string, siteId: string, id: string): string {
  return `${collectionUrl(config, orgId, siteId)}/${encodeURIComponent(id)}`;
}

/** The way forward from an unverified site, which is the person's to take. */
function notVerified(site: string, details: Record<string, unknown>): CliError {
  return needsUser(
    `${site} is not verified yet, and connections are only set up on a verified site. ` +
      "Run `nxis sites verify --token`, deploy the tag, then `nxis sites verify --check`.",
    "site_not_verified",
    { site, ...details },
  );
}

/** The field an INVALID_ARGUMENT reason names, for `details.field`. */
const INVALID_FIELD: Record<string, string> = {
  INVALID_CONNECTION_NAME: "name",
  INVALID_CONNECTION_URL: "url",
  INVALID_AVAILABILITY_URL: "availability_url",
  INVALID_ROUTE: "route",
};

/** @returns The service's reason, when it sent one of NxisAI's: `CONNECTION_IN_USE` … */
function serviceReason(err: CliError): ErrorInfo | undefined {
  const info = err.details["error_info"] as ErrorInfo | undefined;
  return info && info.domain === ERROR_DOMAIN ? info : undefined;
}

/**
 * Maps a refusal by the reason the service gave in its `google.rpc.ErrorInfo` detail.
 *
 * @returns Nothing for a reason this CLI does not know: the caller maps it by its code.
 */
function byReason(
  info: ErrorInfo,
  message: string,
  site: string,
  details: Record<string, unknown>,
): CliError | undefined {
  switch (info.reason) {
    case "CONNECTION_NAME_TAKEN":
      return failed(message || "A connection with that name already exists on this site.", "connection_name_taken", {
        field: "name",
        ...details,
      });
    case "CONNECTION_NOT_FOUND":
      return needsUser(message || "There is no such connection on this site.", "connection_not_found", { site, ...details });
    case "CONNECTION_IN_USE": {
      const agents = (info.metadata["agents"] ?? "").split(",").map((a) => a.trim()).filter(Boolean);
      return needsUser(message, "connection_in_use", { site, ...details, agents });
    }
    case "SITE_NOT_VERIFIED":
      return notVerified(site, details);
    case "INVALID_CONNECTION_NAME":
    case "INVALID_CONNECTION_URL":
    case "INVALID_AVAILABILITY_URL":
    case "INVALID_ROUTE":
      return failed(message, "invalid_input", { field: INVALID_FIELD[info.reason], ...details });
    case "INVALID_ARGUMENT":
      return failed(message, "invalid_input", details);
    default:
      return undefined;
  }
}

/**
 * Maps the service's refusals onto the CLI's reasons.
 *
 * @remarks
 * The service's reason (its `google.rpc.ErrorInfo` detail) decides. A service that sends none,
 * one older than reasons, is mapped by its status code, and by the words of its message where
 * one code covers several refusals.
 *
 * The service's own sentence is kept as the message: it is written for the person, and it names
 * what to do (the agents a connection is still used by, say). It never contains a secret.
 */
function mapped(
  site: string,
  details: Record<string, unknown>,
  scope: "collection" | "item" = "collection",
): (err: unknown) => never {
  return (err) => {
    if (!(err instanceof CliError) || err.reason !== "request_failed") throw err;
    const code = err.details["rpc_code"];
    const status = err.details["status"];
    const message = plainText(err.message);
    const info = serviceReason(err);
    if (info) {
      const known = byReason(info, message, site, details);
      if (known) throw known;
    }
    if (code === RPC.ALREADY_EXISTS || (code === undefined && status === 409)) {
      throw failed(message || "A connection with that name already exists on this site.", "connection_name_taken", {
        field: "name",
        ...details,
      });
    }
    if (status === 404 && scope === "collection" && !info) {
      // The collection itself is missing: a service that predates connections.
      throw failed(
        "This NxisAI environment doesn't offer connections yet. Update the CLI or try again later; " +
          "`nxis actions bind <action> --self-page` still works.",
        "connections_unavailable",
        { site, ...details },
      );
    }
    if (code === RPC.NOT_FOUND || status === 404) {
      throw needsUser(message || "There is no such connection on this site.", "connection_not_found", { site, ...details });
    }
    if (code === RPC.FAILED_PRECONDITION) {
      // Words are read only when the service gave no reason.
      if (!info && /verif/i.test(message)) throw notVerified(site, details);
      if (!info && /still used|in use/i.test(message)) throw needsUser(message, "connection_in_use", { site, ...details });
      throw needsUser(message, "precondition_failed", { site, ...details });
    }
    if (code === RPC.INVALID_ARGUMENT || (code === undefined && status === 400)) {
      throw failed(message, "invalid_input", details);
    }
    throw err;
  };
}

/** Who is asking, about which site. */
export interface SiteRef {
  config: Config;
  token: string;
  orgId: string;
  siteId: string;
}

/** Lists a site's connections, oldest first. */
export async function listConnections(t: SiteRef): Promise<ConnectionList> {
  const raw = await request<unknown>(collectionUrl(t.config, t.orgId, t.siteId), { token: t.token }).catch(
    mapped(t.siteId, {}),
  );
  return parseConnectionList(raw ?? {});
}

/**
 * Creates a connection. The answer is the only time its signing secret is shown, until a rotation.
 *
 * @throws CliError `connection_name_taken` (exit 1); `invalid_input` (exit 1) for a URL or name the
 * service refuses; `site_not_verified` (exit 2); and whatever {@link request} throws.
 */
export async function createConnection(
  t: SiteRef,
  input: { name: string; url: string; makeDefault?: boolean },
): Promise<WithSecret> {
  const body = {
    parent: siteParent(t.orgId, t.siteId),
    name: input.name,
    url: input.url,
    ...(input.makeDefault ? { make_default: true } : {}),
  };
  const raw = await request<unknown>(collectionUrl(t.config, t.orgId, t.siteId), {
    method: "POST",
    token: t.token,
    body,
  }).catch(mapped(t.siteId, { name: input.name }));
  return parseWithSecret(raw);
}

/**
 * Issues a connection a new signing secret. The old one stops working.
 *
 * @throws CliError `connection_not_found` (exit 2), and whatever {@link request} throws.
 */
export async function rotateConnectionSecret(t: SiteRef, id: string): Promise<WithSecret> {
  const resource = `${siteParent(t.orgId, t.siteId)}/connections/${id}`;
  const raw = await request<unknown>(`${connectionUrl(t.config, t.orgId, t.siteId, id)}:rotateSecret`, {
    method: "POST",
    token: t.token,
    body: { connection: resource },
  }).catch(mapped(t.siteId, { connection_id: id }, "item"));
  return parseWithSecret(raw);
}

/**
 * Deletes a connection.
 *
 * @throws CliError `connection_in_use` (exit 2) while a route still sends through it, with the
 * service's sentence naming the agents; `connection_not_found` (exit 2); and whatever
 * {@link request} throws.
 */
export async function deleteConnection(t: SiteRef, id: string): Promise<{ id: string }> {
  const raw = await request<unknown>(connectionUrl(t.config, t.orgId, t.siteId, id), {
    method: "DELETE",
    token: t.token,
  }).catch(mapped(t.siteId, { connection_id: id }, "item"));
  return { id: text(object(raw)?.["id"]) || id };
}

/** One route to point at a connection. */
export interface RouteInput {
  /** A hosted agent's own route: `quote` or `booking`. Takes the place of `actionType`. */
  agent?: "quote" | "booking";
  /** The action type enum's name (`QUOTE_ACTION` …); neither this nor `agent`: the site default. */
  actionType?: string;
  /** Empty: clear the route, so it falls back to the next one. */
  connectionId: string;
  /** Unset: kept as it was. */
  supportsCheck?: boolean;
  /** Unset: kept as it was; empty: none. */
  availabilityUrl?: string;
}

/**
 * Points one route at a connection: the site default, an action type, or an agent's own route.
 *
 * @returns The site's connections as they now are.
 * @throws CliError `site_not_verified` (exit 2), `invalid_input` (exit 1), and whatever
 * {@link request} throws.
 */
export async function setConnectionRoute(t: SiteRef, route: RouteInput): Promise<ConnectionList> {
  const body: Record<string, unknown> = { parent: siteParent(t.orgId, t.siteId), connection_id: route.connectionId };
  if (route.agent) body["agent"] = route.agent;
  else if (route.actionType) body["action_type"] = route.actionType;
  if (route.supportsCheck !== undefined) body["supports_check"] = route.supportsCheck;
  if (route.availabilityUrl !== undefined) body["availability_url"] = route.availabilityUrl;
  const raw = await request<unknown>(`${collectionUrl(t.config, t.orgId, t.siteId)}:setRoute`, {
    method: "POST",
    token: t.token,
    body,
  }).catch(
    // The id was just read from the list, so a 404 here is that connection, gone since.
    mapped(t.siteId, { connection_id: route.connectionId }, "item"),
  );
  return parseConnectionList(raw ?? {});
}
