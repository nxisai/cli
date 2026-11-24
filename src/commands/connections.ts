/**
 * `nxis connections` — a site's connections — and binding an action to one.
 *
 * @remarks
 * A connection is a name, an address on the site's own servers and one signing secret. Routes
 * send through it: the site default, a kind of action, or a hosted agent's own route. Many routes
 * can share one connection, so rotating its secret or changing its address touches all of them.
 *
 * The signing secret is shown once, in the answer to `create` and to `rotate`, as
 * `signing_secret`. It is in no other output: not in `list`, not in an error, not in the
 * `--verbose` trace (which redacts `signing_secret`), and the CLI never keeps it. With
 * `--write-env <file>` it isn't shown at all: it goes into that env file (which git must ignore),
 * and the answer says where, as `written_to`, `env_name` and `secret_preview`.
 *
 * The work is done by the `*Op` functions, which return the `--json` payload. The commands emit it;
 * `nxis mcp serve` returns it as the tool result, so the two cannot drift apart.
 */

import {
  CONNECTION_LIMITS,
  createConnection,
  deleteConnection,
  listConnections,
  rotateConnectionSecret,
  setConnectionRoute,
  testConnection,
  type Connection,
  type ConnectionTest,
  type ConnectionList,
  type RouteInput,
  type SiteRef,
} from "../api/connections.js";
import { bool, str, type Flags } from "../args.js";
import type { Ctx } from "../context.js";
import { checkEnvTarget, writeEnvSecret, type EnvTarget } from "../env-file.js";
import { CliError, failed, needsUser } from "../errors.js";
import { bold, dim, plainText } from "../output.js";
import { confirmOrStop, terminalAsker, type Asker } from "../prompt.js";
import { ACTION_NAMES } from "../tools/provisioning.js";
import { isDryRun } from "../trace.js";
import { target } from "./hosted-agents.js";

/** What a connection route can be bound for: an action, `booking` (the Booking agent), or `default`. */
export const BIND_TARGETS = [...ACTION_NAMES, "booking", "default"] as const;
export type BindTarget = (typeof BIND_TARGETS)[number];

/** Targets that take Booking's free-times address (`--availability-url`). */
const BOOKING_TARGETS: ReadonlySet<string> = new Set(["booking", "reserve", "schedule"]);

/** What `--json` shows of a connection. Never the secret: only its first characters. */
export function connectionJson(c: Connection): Record<string, unknown> {
  return {
    id: c.id,
    name: c.name,
    url: c.url,
    method: c.method,
    encoding: c.encoding,
    headers: c.headers,
    secret_preview: c.secretPreview,
    created_at: c.createdAt,
    secret_rotated_at: c.secretRotatedAt,
    is_default: c.isDefault,
    used_by: { agents: c.usedBy.agents, action_types: c.usedBy.actionTypes },
    answers_checks: c.answersChecks,
  };
}

/** @returns The list as `--json` shows it. */
function listJson(list: ConnectionList): Record<string, unknown> {
  return {
    connections: list.connections.map(connectionJson),
    default_connection_id: list.defaultConnectionId || null,
  };
}

/** @returns The host of a URL, or the URL cleaned when it has none. */
export function hostOfUrl(url: string): string {
  try {
    return new URL(url).host || plainText(url).slice(0, 200);
  } catch {
    return plainText(url).slice(0, 200);
  }
}

/** @returns Who uses a connection, in words: "the Quote and Booking agents, and the default route". */
export function usageWords(c: Connection): string {
  const agents = c.usedBy.agents.map((a) => a.charAt(0).toUpperCase() + a.slice(1));
  const parts: string[] = [];
  if (agents.length > 0) {
    const names = agents.length === 1 ? agents[0] : `${agents.slice(0, -1).join(", ")} and ${agents[agents.length - 1]}`;
    parts.push(`the ${names} agent${agents.length === 1 ? "" : "s"}`);
  }
  const routes = c.usedBy.actionTypes.filter((t) => t !== "default");
  if (c.usedBy.actionTypes.includes("default") || c.isDefault) parts.push("the site's default route");
  if (routes.length > 0 && agents.length === 0) parts.push(`the ${routes.join(", ")} route${routes.length === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(", and ") : "nothing yet";
}

/** @returns True when anything routes to the connection. */
function inUse(c: Connection): boolean {
  return c.isDefault || c.usedBy.agents.length > 0 || c.usedBy.actionTypes.length > 0;
}

/** The organization, site and token, with `site` (an id or a domain) in place of `--site` when given. */
export async function siteRefOf(ctx: Ctx, site?: string): Promise<SiteRef> {
  const scoped: Ctx = site?.trim() ? { ...ctx, siteOverride: site.trim() } : ctx;
  const t = await target(scoped);
  return { config: ctx.config, ...t };
}

/** A connection id: 24 hex characters. */
const CONNECTION_ID = /^[0-9a-f]{24}$/i;

/**
 * Finds a connection by id, or by name ignoring case.
 *
 * @throws CliError `connection_not_found` (exit 2), with the names there are.
 */
export function resolveConnection(list: ConnectionList, ref: string | undefined, site: string): Connection {
  const wanted = (ref ?? "").trim();
  if (!wanted) {
    throw failed("Which connection? Give its name or id.", "invalid_input", { field: "connection" });
  }
  const byId = CONNECTION_ID.test(wanted) ? list.connections.find((c) => c.id.toLowerCase() === wanted.toLowerCase()) : undefined;
  const found = byId ?? list.connections.find((c) => c.name.toLowerCase() === wanted.toLowerCase());
  if (found) return found;
  const names = list.connections.map((c) => c.name);
  throw needsUser(
    `There is no connection called "${plainText(wanted)}" on this site. ` +
      (names.length > 0
        ? `It has ${names.map((n) => `"${plainText(n)}"`).join(", ")}. `
        : "It has none yet. ") +
      "`nxis connections create --name <name> --url <url>` adds one.",
    "connection_not_found",
    { site, connection: wanted, connections: names },
  );
}

/** Checks a connection name before it is sent. */
function checkName(name: string | undefined): string {
  const value = (name ?? "").trim();
  if (!value) throw failed("Give the connection a name with --name.", "invalid_input", { field: "name" });
  if (value.length > CONNECTION_LIMITS.name) {
    throw failed(`--name is at most ${CONNECTION_LIMITS.name} characters.`, "invalid_input", { field: "name" });
  }
  return value;
}

/**
 * Checks an address before it is sent.
 *
 * @remarks
 * https, or http for a local stack (the service decides which it accepts), with no user name or
 * password in it: a credential in the address would be shown wherever the address is.
 */
export function checkUrl(url: string | undefined, flag: string): string {
  const value = (url ?? "").trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw failed(`${flag} ${plainText(value) || "''"} is not a URL.`, "invalid_input", { field: "url" });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw failed(`${flag} takes an https URL.`, "invalid_input", { field: "url" });
  }
  if (parsed.username || parsed.password) {
    throw failed(`${flag} can't hold a user name or password. Put credentials in the receiving application.`, "invalid_input", {
      field: "url",
    });
  }
  if (value.length > CONNECTION_LIMITS.url) {
    throw failed(`${flag} is at most ${CONNECTION_LIMITS.url} characters.`, "invalid_input", { field: "url" });
  }
  return value;
}

/** @returns The URL in one canonical spelling, for telling whether two addresses are the same. */
function sameAddress(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a.trim() === b.trim();
  }
}

/** What to tell the person to do with a new secret. */
const STORE_SECRET =
  "Store it where the receiving application reads its configuration (for example NXIS_ACTION_SECRET), " +
  "and check each request's signature with it. It is not shown again.";

/** Where to write a new signing secret instead of showing it: an env file, and the variable. */
export interface WriteEnv {
  /** The env file, relative to the working directory. */
  file: string;
  /** The variable; `NXIS_ACTION_SECRET` when not given. */
  name?: string;
}

/** @returns The env file checked, before the secret is issued; null when none was asked for. */
function envTargetOf(writeEnv: WriteEnv | undefined): EnvTarget | null {
  return writeEnv ? checkEnvTarget(writeEnv.file, writeEnv.name) : null;
}

/**
 * Writes the new secret into the env file, and says where without showing it.
 *
 * @param done - What was done, for the message when the write fails: "Created the connection".
 * @param retry - What to run then.
 * @throws CliError `env_write_failed` (exit 1) when the file can't be written; it holds no secret.
 */
function secretToEnv(env: EnvTarget, secret: string, c: Connection, done: string, retry: string): Record<string, unknown> {
  try {
    writeEnvSecret(env, secret);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "error";
    throw failed(
      `${done} "${plainText(c.name)}", but couldn't write its signing secret to ${plainText(env.path)} (${code}), and it isn't shown. ` +
        `Fix that, then run \`${retry}\` for a new one.`,
      "env_write_failed",
      { connection_id: c.id, connection: c.name, path: env.path, error_code: code },
    );
  }
  return {
    written_to: env.path,
    env_name: env.name,
    secret_preview: c.secretPreview,
    git: env.git,
    next:
      `The signing secret is in ${env.path} as ${env.name}; it isn't shown, and the CLI doesn't keep it. ` +
      "Have the receiving application read it from there and check each request's signature with it.",
  };
}

/** @returns The `--write-env` command to issue a secret again, for a message. */
function rotateWithEnv(c: Connection, env: EnvTarget): string {
  return `nxis connections rotate "${plainText(c.name)}" --write-env ${plainText(env.path)} --env-name ${env.name} --yes`;
}

// ── operations ──────────────────────────────────────────────────────────────

/** `nxis connections list`. */
export async function listOp(t: SiteRef): Promise<Record<string, unknown>> {
  const list = await listConnections(t);
  return { ok: true, site: t.siteId, ...listJson(list) };
}

/** Arguments for {@link createOp}. */
export interface CreateArgs {
  name?: string;
  url?: string;
  makeDefault?: boolean;
  /** Write the secret into this env file instead of returning it. */
  writeEnv?: WriteEnv;
}

/**
 * `nxis connections create`: the new connection, and its signing secret, once; or, with
 * `writeEnv`, the secret written into that env file and not returned.
 *
 * @throws CliError the env file's refusals of {@link checkEnvTarget}, before anything is sent;
 * `env_write_failed` after the connection is created.
 */
export async function createOp(t: SiteRef, args: CreateArgs): Promise<Record<string, unknown>> {
  const name = checkName(args.name);
  const url = checkUrl(args.url, "--url");
  const env = envTargetOf(args.writeEnv);
  const created = await createConnection(t, { name, url, makeDefault: args.makeDefault === true });
  const base = { ok: true, site: t.siteId, connection: connectionJson(created.connection) };
  if (env) {
    return { ...base, ...secretToEnv(env, created.signingSecret, created.connection, "Created the connection", rotateWithEnv(created.connection, env)) };
  }
  return { ...base, signing_secret: created.signingSecret, next: STORE_SECRET };
}

/**
 * `nxis connections rotate`: a new signing secret, once, and who it affects; or, with
 * `writeEnv`, the secret written into that env file and not returned.
 *
 * @throws CliError the env file's refusals of {@link checkEnvTarget}, before anything is sent;
 * `env_write_failed` after the secret is rotated.
 */
export async function rotateOp(t: SiteRef, ref: string | undefined, writeEnv?: WriteEnv): Promise<Record<string, unknown>> {
  const env = envTargetOf(writeEnv);
  const c = resolveConnection(await listConnections(t), ref, t.siteId);
  const rotated = await rotateConnectionSecret(t, c.id);
  const base = { ok: true, site: t.siteId, connection: connectionJson(rotated.connection), affected: usageWords(rotated.connection) };
  if (env) {
    const written = secretToEnv(env, rotated.signingSecret, rotated.connection, "Rotated the signing secret of", rotateWithEnv(rotated.connection, env));
    return { ...base, ...written, next: `The previous secret no longer works. ${String(written["next"])}` };
  }
  return {
    ...base,
    signing_secret: rotated.signingSecret,
    next:
      "The previous secret no longer works. " +
      STORE_SECRET.replace("Store it", "Give the new one to the receiving application now: store it"),
  };
}

/** `nxis connections delete`. */
export async function deleteOp(t: SiteRef, ref: string | undefined): Promise<Record<string, unknown>> {
  const c = resolveConnection(await listConnections(t), ref, t.siteId);
  try {
    await deleteConnection(t, c.id);
  } catch (err) {
    if (err instanceof CliError && err.reason === "connection_in_use") {
      // The service's own list of agents, when it gave one, is as of the refusal; the read before it may be older.
      const told = err.details["agents"];
      const agents = Array.isArray(told) && told.length > 0 ? (told as string[]) : c.usedBy.agents;
      const { agents: _omit, ...rest } = err.details;
      throw needsUser(err.message, err.reason, {
        ...rest,
        connection: c.name,
        used_by: { agents, action_types: c.usedBy.actionTypes },
      });
    }
    throw err;
  }
  return { ok: true, site: t.siteId, deleted: { id: c.id, name: c.name } };
}

/** Arguments for {@link bindOp}. */
export interface BindArgs {
  action: BindTarget;
  /** A connection's name or id. */
  connection?: string;
  /** An address: a connection with it is reused, or one is created, named from its host. */
  webhook?: string;
  supportsCheck?: boolean;
  /** Empty: none. */
  availabilityUrl?: string;
}

/** @returns The route a target names. */
export function routeOf(action: BindTarget): Pick<RouteInput, "agent" | "actionType"> {
  if (action === "default") return {};
  if (action === "booking") return { agent: "booking" };
  return { actionType: `${action.toUpperCase()}_ACTION` };
}

/** @returns A name for a new connection to this address: its host, made unique on the site. */
export function nameForAddress(url: string, list: ConnectionList): string {
  const host = hostOfUrl(url).slice(0, CONNECTION_LIMITS.name - 4) || "Connection";
  const taken = new Set(list.connections.map((c) => c.name.toLowerCase()));
  if (!taken.has(host.toLowerCase())) return host;
  for (let n = 2; ; n++) {
    const name = `${host} ${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/**
 * Checks the route's options. `--supports-check` goes with any route (the Quote agent checks the
 * service area, Booking checks times); the free-times address only with a booking route.
 */
function checkBookingOptions(args: BindArgs): void {
  if (args.availabilityUrl === undefined) return;
  if (!BOOKING_TARGETS.has(args.action)) {
    throw failed(
      "--availability-url is a Booking option: bind `booking` (or `schedule`, `reserve`) to use it.",
      "invalid_input",
      { field: "availability_url" },
    );
  }
  if (args.availabilityUrl) checkUrl(args.availabilityUrl, "--availability-url");
}

/**
 * `nxis actions bind <action> --connection <name|id>`, and `--webhook <url>`.
 *
 * @remarks
 * `--webhook` keeps working as it did: a connection with the same address is reused (its secret
 * stays as it is, so nothing has to change on the site), or one is created, named from the host,
 * and its new secret is returned once.
 *
 * When creating worked and routing did not, the error says so and names the connection, without
 * its secret: `nxis connections rotate` issues one that can be stored.
 */
export async function bindOp(t: SiteRef, args: BindArgs): Promise<Record<string, unknown>> {
  checkBookingOptions(args);
  const list = await listConnections(t);
  let connection: Connection;
  let secret: string | null = null;

  if (args.webhook !== undefined) {
    const url = checkUrl(args.webhook, "--webhook");
    const same = list.connections.find((c) => sameAddress(c.url, url));
    if (same) {
      connection = same;
    } else {
      const created = await createConnection(t, { name: nameForAddress(url, list), url });
      connection = created.connection;
      secret = created.signingSecret;
    }
  } else {
    connection = resolveConnection(list, args.connection, t.siteId);
  }

  const route: RouteInput = { ...routeOf(args.action), connectionId: connection.id };
  if (args.supportsCheck !== undefined) route.supportsCheck = args.supportsCheck;
  if (args.availabilityUrl !== undefined) route.availabilityUrl = args.availabilityUrl.trim();

  let after: ConnectionList;
  try {
    after = await setConnectionRoute(t, route);
  } catch (err) {
    if (secret === null || !(err instanceof CliError) || err.reason === "dry_run") throw err;
    throw new CliError(
      `Created the connection "${plainText(connection.name)}", but could not route ${args.action} to it: ${err.message} ` +
        `Fix that, then run \`nxis actions bind ${args.action} --connection "${plainText(connection.name)}"\`, and ` +
        `\`nxis connections rotate "${plainText(connection.name)}"\` for a signing secret to store.`,
      { exitCode: err.exitCode, reason: err.reason, details: { ...err.details, connection_id: connection.id, connection_created: true } },
    );
  }
  const now = after.connections.find((c) => c.id === connection.id) ?? connection;

  const payload: Record<string, unknown> = {
    ok: true,
    site: t.siteId,
    action: args.action,
    route: args.webhook !== undefined ? "webhook" : "connection",
    connection: connectionJson(now),
    connection_created: secret !== null,
    webhook_host: hostOfUrl(now.url),
    binding: {
      connection_id: now.id,
      connection_name: now.name,
      url: now.url,
      method: now.method,
      ...(args.supportsCheck !== undefined ? { supports_check: args.supportsCheck } : {}),
      ...(args.availabilityUrl !== undefined ? { availability_url: args.availabilityUrl.trim() || null } : {}),
    },
    ...listJson(after),
  };
  if (secret !== null) {
    payload["signing_secret"] = secret;
    payload["secret_is_new"] = true;
    payload["next"] = STORE_SECRET;
  }
  return payload;
}

/** What `--action` takes for a test: an action name, `booking`, `default`, or a schema.org action type. */
export const TEST_ACTIONS = [...ACTION_NAMES, "booking", "default"] as const;

/**
 * The action type a test's example arguments are for, from `--action`.
 *
 * @returns `QuoteAction` for `quote`, `ScheduleAction` for `booking`, `default`, a schema.org
 * action type as given (`QuoteAction`), or undefined when none was given: the service then uses
 * the connection's own route.
 * @throws CliError `invalid_input` (exit 1) for anything else.
 */
export function testActionType(action: string | undefined): string | undefined {
  const a = (action ?? "").trim();
  if (!a) return undefined;
  if (a === "default") return "default";
  if (a === "booking") return "ScheduleAction";
  if ((ACTION_NAMES as readonly string[]).includes(a)) return `${a.charAt(0).toUpperCase()}${a.slice(1)}Action`;
  if (/^[A-Z][A-Za-z]{1,40}Action$/.test(a)) return a;
  throw failed(
    `--action takes ${TEST_ACTIONS.join(", ")}, or an action type such as QuoteAction.`,
    "invalid_input",
    { field: "action" },
  );
}

/** How a test's head line names who answered, when it wasn't the receiver. */
const ANSWERED_BY_WORDS: Record<string, string> = { tunnel: "the tunnel", proxy: "a proxy", cdn: "the CDN" };

/** @returns Whether a tunnel, proxy or CDN in front of the receiver answered, not the receiver. */
function answeredInFront(r: ConnectionTest): boolean {
  return r.answeredBy !== "" && r.answeredBy !== "receiver";
}

/** @returns Whether the answer came from an ngrok tunnel, by the service's words or the address. */
function viaNgrok(r: ConnectionTest): boolean {
  return /ngrok/i.test(r.detail) || /(^|\.)ngrok(-free)?\.(app|dev|io)$/i.test(hostOfUrl(r.url));
}

/** @returns The next step when a tunnel, proxy or CDN answered instead of the receiver. */
function inFrontNextStep(r: ConnectionTest): string {
  const said = r.detail ? `${plainText(r.detail)} ` : "";
  const what = r.answeredBy === "tunnel" ? "tunnel" : "host";
  const target =
    r.answeredBy === "tunnel"
      ? "the port the tunnel points at" +
        (viaNgrok(r) ? " (for ngrok, http://127.0.0.1:4040/api/tunnels lists each tunnel's target)" : "")
      : `the address and port the ${r.answeredBy === "cdn" ? "CDN" : "proxy"} forwards to (its origin or upstream)`;
  return (
    `${said}The ${what} at ${hostOfUrl(r.url)} is up, but it isn't reaching your server, so the receiver never got ` +
    `the call. Check that the server is running and listening on ${target}, then test again.`
  );
}

/** @returns The next step for a verdict, in words a person (or their agent) can act on. */
export function testNextStep(r: ConnectionTest): string {
  switch (r.verdict) {
    case "ok":
      return "The receiver accepted the signed check. Agents and actions routed to this connection can reach it.";
    case "signature_rejected":
      return (
        `The receiver answered ${r.httpStatus}: it got the call and refused its signature. Either it reads a different ` +
        "secret than this connection's (check the variable it reads, such as NXIS_ACTION_SECRET, and that it was " +
        "restarted or redeployed since the secret was last set or rotated), or it verifies a parsed and re-serialized " +
        "body instead of the raw request bytes: compute the HMAC over the exact body received, before parsing it."
      );
    case "unreachable":
      if (answeredInFront(r)) return inFrontNextStep(r);
      return (
        `${r.detail ? `${plainText(r.detail)} ` : ""}Nothing answered at ${hostOfUrl(r.url)}: the receiver is not ` +
        "deployed at that address, or the tunnel to a local receiver is down. Check it is running there, or point " +
        "the connection at the address it runs at."
      );
    case "timeout":
      return (
        `${r.detail ? `${plainText(r.detail)} ` : ""}The receiver took too long to answer. A check should answer at ` +
        "once, without committing anything: check that it isn't waiting on something before it replies, or starting cold."
      );
    case "bad_response":
      return r.httpStatus >= 300 && r.httpStatus < 400
        ? `The receiver answered ${r.httpStatus}, a redirect, which is not followed. Use the final address for the connection.`
        : `The receiver answered ${r.httpStatus}: it got the call and didn't accept it. A check (X-Nxis-Mode: check, ` +
            '"nxis:mode": "check" in the body) should answer 2xx, with a boolean "available" for a booking. ' +
            (r.bodyExcerpt ? "Its answer began as shown." : "Its answer had no body.");
    default:
      return `The service answered "${plainText(r.verdict)}", which this CLI doesn't know yet. Update the CLI.`;
  }
}

/**
 * `nxis connections test`: one signed check call from NxisAI to the connection's address.
 *
 * @remarks
 * Never throws for what the receiver did: the verdict is the answer, with `ok` false for every
 * verdict but `ok`. The command turns a failing verdict into exit 2.
 */
export async function testOp(
  t: SiteRef,
  ref: string | undefined,
  action?: string,
  opts: { turnOnChecks?: boolean } = {},
): Promise<Record<string, unknown>> {
  const actionType = testActionType(action);
  const c = resolveConnection(await listConnections(t), ref, t.siteId);
  const r = await testConnection(t, c.id, actionType, opts.turnOnChecks ? { turnOnChecks: true } : {});
  const checks = checksNextStep(r, c.name, opts.turnOnChecks === true);
  return {
    ok: r.verdict === "ok",
    site: t.siteId,
    connection: { id: c.id, name: c.name },
    verdict: r.verdict,
    http_status: r.httpStatus,
    latency_ms: r.latencyMs,
    url: r.url || c.url,
    action_type: r.actionType || actionType || null,
    tested_at: r.testedAt,
    body_excerpt: r.bodyExcerpt,
    ...(r.detail ? { detail: r.detail } : {}),
    ...(r.answeredBy ? { answered_by: r.answeredBy } : {}),
    answers_checks: r.answersChecks,
    returned_windows: r.returnedWindows,
    returned_hold: r.returnedHold,
    check_support_off: r.checkSupportOff,
    check_support_turned_on: r.checkSupportTurnedOn,
    next: checks ? `${testNextStep(r)} ${checks}` : testNextStep(r),
  };
}

/** A route on a connection, in plain words: "the site's default route", "quote requests" … */
export function routeWords(route: string): string {
  switch (route) {
    case "default":
      return "the site's default route";
    case "QuoteAction":
      return "quote requests";
    case "AskAction":
      return "questions";
    case "ScheduleAction":
      return "bookings";
    case "ReserveAction":
      return "reservations";
    default: {
      const name = plainText(route).replace(/Action$/, "");
      return `${name ? name.toLowerCase() : plainText(route)} requests`;
    }
  }
}

/** @returns Several routes in words: "quote requests and bookings". */
export function routesWords(routes: string[]): string {
  const words = routes.map(routeWords);
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** @returns A route name as SetConnectionRoute takes it: `default` the site default, `QuoteAction` as QUOTE_ACTION. */
export function routeInputOf(route: string): Pick<RouteInput, "actionType"> {
  if (route === "default") return {};
  return { actionType: route.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase() };
}

/** @returns The command that tests a connection and turns check support on. */
function turnOnCommand(name: string): string {
  return `\`nxis connections test "${plainText(name)}" --turn-on-checks\``;
}

/**
 * What a test found about availability checks, in words, for `next`; empty when there is nothing
 * to say (no answer from the receiver, or a service that doesn't report it).
 */
export function checksNextStep(r: ConnectionTest, name: string, asked: boolean): string {
  if (r.verdict !== "ok" || r.answersChecks === null) return "";
  if (!r.answersChecks) {
    return (
      "It didn't answer as an availability check, though (a check's answer is JSON with \"available\": true or " +
      "false), so agents that use this connection send requests without checking first: Booking takes visit " +
      "requests for you to confirm, and Quote doesn't check the service area. To have them check first, make the " +
      "receiver answer a check (X-Nxis-Mode: check, or \"nxis:mode\": \"check\" in the body) with " +
      "{\"available\": true|false}, and for bookings the open \"windows\", as the receiver template does, then " +
      `run ${turnOnCommand(name)}.`
    );
  }
  const parts = [
    "It answers availability checks" +
      (r.returnedWindows ? `, with open times${r.returnedHold ? " and a hold" : ""}.` : "."),
  ];
  if (r.checkSupportTurnedOn.length > 0) {
    parts.push(`Check support is now on for ${routesWords(r.checkSupportTurnedOn)}; the agents use it within seconds.`);
  }
  if (r.checkSupportOff.length > 0) {
    parts.push(
      `Check support is still off for ${routesWords(r.checkSupportOff)}, so agents there don't check first. ` +
        (asked ? "Turn it on with `nxis actions bind <route> --connection <name> --supports-check`." : `Turn it on: ${turnOnCommand(name)}.`),
    );
  } else if (r.checkSupportTurnedOn.length === 0) {
    parts.push("Agents and actions routed to this connection check with it before they send.");
  }
  return parts.join(" ");
}

/**
 * Turns check support on for routes on a connection, one SetConnectionRoute each: no second call
 * to the receiver, so the test's rate limit doesn't apply.
 *
 * @returns The routes turned on.
 */
export async function turnOnChecksOp(t: SiteRef, connectionId: string, routes: string[]): Promise<string[]> {
  const done: string[] = [];
  for (const route of routes) {
    await setConnectionRoute(t, { ...routeInputOf(route), connectionId, supportsCheck: true });
    done.push(route);
  }
  return done;
}

// ── commands ────────────────────────────────────────────────────────────────

/** @returns One connection in a line or two, for a person. */
function describe(c: Record<string, unknown>): string {
  const used = c["used_by"] as { agents: string[]; action_types: string[] };
  const tags = [c["is_default"] ? "default" : "", ...used.agents].filter(Boolean);
  return (
    `${bold(plainText(String(c["name"])))}${tags.length ? ` (${tags.join(", ")})` : ""}  ${plainText(String(c["url"]))}\n` +
    `  ${dim(`id ${String(c["id"])}  secret ${plainText(String(c["secret_preview"]))}…`)}`
  );
}

/** @returns The secret, said once, for a person; or where it was written, without it. */
function secretLines(payload: Record<string, unknown>): string[] {
  if (payload["written_to"]) {
    return [
      "",
      `Wrote the signing secret to ${bold(plainText(String(payload["written_to"])))} as ${String(payload["env_name"])} ` +
        dim(`(it starts ${plainText(String(payload["secret_preview"]))}…; it isn't shown, and the CLI doesn't keep it).`),
      "",
      String(payload["next"]),
    ];
  }
  return [
    "",
    bold("Signing secret (shown once; it is not shown again and the CLI does not keep it):"),
    `  ${String(payload["signing_secret"])}`,
    "",
    String(payload["next"]),
  ];
}

/** Runs `nxis connections list`. */
export async function cmdConnectionsList(ctx: Ctx): Promise<void> {
  const payload = await listOp(await siteRefOf(ctx));
  ctx.io.emit(payload, () => {
    const list = payload["connections"] as Record<string, unknown>[];
    if (list.length === 0) {
      return "No connections yet. `nxis connections create --name <name> --url <url>` adds one.";
    }
    return list.map(describe).join("\n");
  });
}

/** Runs `nxis connections create --name <name> --url <url> [--default]`. */
export async function cmdConnectionsCreate(ctx: Ctx, args: CreateArgs): Promise<void> {
  // Checked before signing in, so a typo fails at once.
  checkName(args.name);
  checkUrl(args.url, "--url");
  envTargetOf(args.writeEnv);
  const payload = await createOp(await siteRefOf(ctx), args);
  ctx.io.emit(payload, () =>
    [`Created ${describe(payload["connection"] as Record<string, unknown>)}`, ...secretLines(payload)].join("\n"),
  );
}

/** Arguments for rotate and delete. */
export interface ConfirmArgs {
  /** The person already agreed. */
  yes?: boolean;
  /** For tests. */
  asker?: Asker;
  /** Rotate only: write the new secret into this env file instead of showing it. */
  writeEnv?: WriteEnv;
}

/**
 * Runs `nxis connections rotate <name|id>`.
 *
 * @remarks
 * The old secret stops working at once, so every route through the connection fails its
 * signature check until the receiving application has the new one. It asks first, naming them;
 * `--yes` says the person already agreed.
 *
 * @throws CliError `confirmation_required` or `cancelled` (exit 2), `connection_not_found` (exit 2).
 */
export async function cmdConnectionsRotate(ctx: Ctx, ref: string | undefined, args: ConfirmArgs = {}): Promise<void> {
  // Checked before asking, so a refused file costs nothing.
  envTargetOf(args.writeEnv);
  const t = await siteRefOf(ctx);
  if (!args.yes && !isDryRun()) {
    const c = resolveConnection(await listConnections(t), ref, t.siteId);
    await confirmOrStop(args.asker ?? terminalAsker, {
      summary:
        `${bold(`Rotate the signing secret of "${plainText(c.name)}"`)} (${plainText(c.url)})\n` +
        `  The current secret stops working at once. Used by ${usageWords(c)}.`,
      needsYes:
        "Rotating breaks signature checks until the receiving application has the new secret, so it needs a yes. " +
        "Tell the user, and once they agree, run again with --yes.",
      question: `Rotate the secret of "${plainText(c.name)}"?`,
      cancelled: "Cancelled. The secret is unchanged.",
      details: { site: t.siteId, connection: c.name, connection_id: c.id },
    });
  }
  const payload = await rotateOp(t, ref, args.writeEnv);
  ctx.io.emit(payload, () =>
    [
      `New signing secret for ${describe(payload["connection"] as Record<string, unknown>)}`,
      dim(`Used by ${String(payload["affected"])}.`),
      ...secretLines(payload),
    ].join("\n"),
  );
}

/**
 * Runs `nxis connections delete <name|id>`. Asks first; the service refuses one still in use.
 *
 * @throws CliError `connection_in_use` (exit 2), `connection_not_found` (exit 2), and
 * `confirmation_required` or `cancelled` (exit 2).
 */
export async function cmdConnectionsDelete(ctx: Ctx, ref: string | undefined, args: ConfirmArgs = {}): Promise<void> {
  const t = await siteRefOf(ctx);
  if (!args.yes && !isDryRun()) {
    const c = resolveConnection(await listConnections(t), ref, t.siteId);
    await confirmOrStop(args.asker ?? terminalAsker, {
      summary:
        `${bold(`Delete the connection "${plainText(c.name)}"`)} (${plainText(c.url)})` +
        (inUse(c) ? `\n  It is used by ${usageWords(c)}; choose another connection for them first.` : ""),
      needsYes: "Deleting a connection can't be undone, so it needs a yes. Once the user agrees, run again with --yes.",
      question: `Delete "${plainText(c.name)}"?`,
      cancelled: "Cancelled. Nothing was deleted.",
      details: { site: t.siteId, connection: c.name, connection_id: c.id },
    });
  }
  const payload = await deleteOp(t, ref);
  const deleted = payload["deleted"] as { name: string };
  ctx.io.emit(payload, () => `Deleted the connection "${plainText(deleted.name)}".`);
}

/** @returns A test's outcome in lines, for a person. */
function testLines(payload: Record<string, unknown>): string {
  const status = Number(payload["http_status"]);
  const c = payload["connection"] as { name: string };
  const by = typeof payload["answered_by"] === "string" ? payload["answered_by"] : "";
  const head =
    `${bold(String(payload["verdict"]))}  ${status > 0 ? `HTTP ${status}` : "no answer"}` +
    `${by && by !== "receiver" ? ` from ${ANSWERED_BY_WORDS[by] ?? `the ${plainText(by)}`}` : ""}  ${String(payload["latency_ms"])} ms  ` +
    `${plainText(String(payload["url"]))}`;
  const lines = [head, dim(`Connection "${plainText(c.name)}", ${String(payload["action_type"] ?? "default")} example.`)];
  const excerpt = String(payload["body_excerpt"] ?? "");
  if (excerpt) lines.push(`${dim("Answer:")} ${plainText(excerpt)}`);
  lines.push("", String(payload["next"]));
  return lines.join("\n");
}

/**
 * Runs `nxis connections test <name|id> [--action <type>] [--turn-on-checks]`.
 *
 * @remarks
 * When the receiver answers availability checks and some routes on the connection have check
 * support off, a person at a terminal is asked whether to turn it on; anywhere else `next` says
 * so and gives the command. `--turn-on-checks` turns it on without asking.
 *
 * @throws CliError `connection_test_failed` (exit 2) for every verdict but `ok`, carrying the
 * result; `rate_limited` (exit 1); `connection_not_found` (exit 2).
 */
export async function cmdConnectionsTest(
  ctx: Ctx,
  ref: string | undefined,
  action?: string,
  opts: { turnOnChecks?: boolean; asker?: Asker } = {},
): Promise<void> {
  // Checked before signing in, so a typo fails at once.
  testActionType(action);
  const t = await siteRefOf(ctx);
  let payload = await testOp(t, ref, action, opts.turnOnChecks ? { turnOnChecks: true } : {});
  const off = (payload["check_support_off"] as string[] | undefined) ?? [];
  const asker = opts.asker ?? terminalAsker;
  if (payload["ok"] === true && payload["answers_checks"] === true && off.length > 0 && !opts.turnOnChecks && !ctx.io.json && !isDryRun() && asker.interactive) {
    const c = payload["connection"] as { id: string; name: string };
    process.stderr.write(`${testLines(payload)}\n\n`);
    const yes = await asker.confirm(
      `Your receiver answers availability checks, but check support is off for ${routesWords(off)}. Turn it on?`,
    );
    if (yes) {
      const turned = await turnOnChecksOp(t, c.id, off);
      const r: ConnectionTest = {
        verdict: "ok",
        httpStatus: Number(payload["http_status"]),
        latencyMs: Number(payload["latency_ms"]),
        bodyExcerpt: String(payload["body_excerpt"] ?? ""),
        url: String(payload["url"]),
        testedAt: (payload["tested_at"] as string | null) ?? null,
        actionType: String(payload["action_type"] ?? ""),
        detail: "",
        answeredBy: String(payload["answered_by"] ?? ""),
        answersChecks: true,
        returnedWindows: payload["returned_windows"] === true,
        returnedHold: payload["returned_hold"] === true,
        checkSupportOff: off.filter((x) => !turned.includes(x)),
        checkSupportTurnedOn: turned,
      };
      payload = {
        ...payload,
        check_support_off: r.checkSupportOff,
        check_support_turned_on: turned,
        next: `${testNextStep(r)} ${checksNextStep(r, c.name, true)}`,
      };
    }
    // The test's lines are shown above the question; after it, only what changed.
    const after = payload;
    ctx.io.emit(after, () => String(after["next"]));
    return;
  }
  if (payload["ok"] !== true) {
    const { ok: _ok, ...details } = payload;
    throw needsUser(testLines(payload), "connection_test_failed", details);
  }
  ctx.io.emit(payload, () => testLines(payload));
}

/** @returns The bind payload in words, for a person. */
export function bindLines(payload: Record<string, unknown>): string {
  const action = String(payload["action"]);
  const c = payload["connection"] as Record<string, unknown>;
  const who = action === "default" ? "Every action" : action === "booking" ? "The Booking agent" : bold(action);
  const lines = [
    `${who} now sends to ${payload["connection_created"] ? "the new " : ""}connection "${plainText(String(c["name"]))}" ` +
      `(${plainText(String(c["url"]))}).`,
  ];
  const shared = (c["used_by"] as { agents: string[] }).agents;
  if (shared.length > 1) lines.push(dim(`It is shared by the ${shared.join(", ")} agents.`));
  if (payload["signing_secret"]) lines.push(...secretLines(payload));
  else lines.push(dim("Its signing secret is unchanged."));
  return lines.join("\n");
}

/** Runs `nxis actions bind <action> --connection <name|id>` or `--webhook <url>`. */
export async function cmdBindConnection(ctx: Ctx, args: BindArgs): Promise<void> {
  checkBookingOptions(args);
  if (args.webhook !== undefined) checkUrl(args.webhook, "--webhook");
  const payload = await bindOp(await siteRefOf(ctx), args);
  ctx.io.emit(payload, () => bindLines(payload));
}

/** @returns Whether a string names a bind target. */
export function isBindTarget(value: string): value is BindTarget {
  return (BIND_TARGETS as readonly string[]).includes(value);
}

/**
 * Reads `--supports-check`: bare or `=true` turns it on, `=false` off, absent keeps it as it is.
 *
 * @throws CliError `invalid_input` (exit 1) for any other value.
 */
export function supportsCheckFlag(flags: Flags): boolean | undefined {
  const value = flags.get("supports-check");
  if (value === undefined) return undefined;
  if (value === true || value === "true") return true;
  if (value === "false") return false;
  throw failed("--supports-check takes no value, or =true or =false.", "invalid_input", { field: "supports_check" });
}

/**
 * Reads `--write-env <file>` and `--env-name <name>`.
 *
 * @throws CliError `missing_value` (exit 1) for either given without a value; `invalid_input` for
 * `--env-name` without `--write-env`.
 */
export function writeEnvFlags(flags: Flags): WriteEnv | undefined {
  const name = flags.has("env-name") ? str(flags, "env-name")?.trim() : undefined;
  if (flags.has("env-name") && !name) {
    throw failed("--env-name needs the variable to write the secret to, such as --env-name NXIS_ACTION_SECRET.", "missing_value", {
      flag: "--env-name",
    });
  }
  if (!flags.has("write-env")) {
    if (name !== undefined) throw failed("--env-name goes with --write-env <file>.", "invalid_input", { field: "env_name" });
    return undefined;
  }
  const file = str(flags, "write-env")?.trim();
  if (!file) {
    throw failed("--write-env needs the env file to write the secret to, such as --write-env .env.local.", "missing_value", {
      flag: "--write-env",
    });
  }
  return { file, ...(name !== undefined ? { name } : {}) };
}

/** @returns `{ writeEnv }` when `--write-env` was given, else nothing. */
function writeEnvArg(flags: Flags): { writeEnv?: WriteEnv } {
  const writeEnv = writeEnvFlags(flags);
  return writeEnv ? { writeEnv } : {};
}

/** How to call `nxis connections`. */
const CONNECTIONS_USAGE =
  "Try `nxis connections list`, `nxis connections create --name <name> --url <url> [--default] [--write-env <file>]`, " +
  "`nxis connections rotate <name|id> [--write-env <file>]`, `nxis connections test <name|id> [--action <type>] [--turn-on-checks]` " +
  "or `nxis connections delete <name|id>`.";

/** Routes `nxis connections <sub>`. */
export async function runConnections(ctx: Ctx, positional: string[], flags: Flags): Promise<void> {
  const [sub, ref] = positional;
  switch (sub) {
    case "list":
    case undefined:
      return cmdConnectionsList(ctx);
    case "create":
      return cmdConnectionsCreate(ctx, {
        ...(str(flags, "name") !== undefined ? { name: str(flags, "name") as string } : {}),
        ...(str(flags, "url") !== undefined ? { url: str(flags, "url") as string } : {}),
        makeDefault: bool(flags, "default"),
        ...writeEnvArg(flags),
      });
    case "rotate":
      return cmdConnectionsRotate(ctx, ref, { yes: bool(flags, "yes"), ...writeEnvArg(flags) });
    case "delete":
      return cmdConnectionsDelete(ctx, ref, { yes: bool(flags, "yes") });
    case "test":
      return cmdConnectionsTest(ctx, ref, str(flags, "action"), { turnOnChecks: bool(flags, "turn-on-checks") });
    default:
      throw new CliError(CONNECTIONS_USAGE, { reason: "unknown_command" });
  }
}
