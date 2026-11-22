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
 * `--verbose` trace (which redacts `signing_secret`), and the CLI never keeps it.
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
  type Connection,
  type ConnectionList,
  type RouteInput,
  type SiteRef,
} from "../api/connections.js";
import { bool, str, type Flags } from "../args.js";
import type { Ctx } from "../context.js";
import { CliError, failed, needsUser } from "../errors.js";
import { bold, dim, plainText } from "../output.js";
import { confirmOrStop, terminalAsker, type Asker } from "../prompt.js";
import { ACTION_NAMES } from "../tools/provisioning.js";
import { isDryRun } from "../trace.js";
import { target } from "./hosted-agents.js";

/** What a connection route can be bound for: an action, `booking` (the Booking agent), or `default`. */
export const BIND_TARGETS = [...ACTION_NAMES, "booking", "default"] as const;
export type BindTarget = (typeof BIND_TARGETS)[number];

/** Targets that take Booking's options (`--supports-check`, `--availability-url`). */
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
}

/** `nxis connections create`: the new connection, and its signing secret, once. */
export async function createOp(t: SiteRef, args: CreateArgs): Promise<Record<string, unknown>> {
  const name = checkName(args.name);
  const url = checkUrl(args.url, "--url");
  const created = await createConnection(t, { name, url, makeDefault: args.makeDefault === true });
  return {
    ok: true,
    site: t.siteId,
    connection: connectionJson(created.connection),
    signing_secret: created.signingSecret,
    next: STORE_SECRET,
  };
}

/** `nxis connections rotate`: a new signing secret, once, and who it affects. */
export async function rotateOp(t: SiteRef, ref: string | undefined): Promise<Record<string, unknown>> {
  const c = resolveConnection(await listConnections(t), ref, t.siteId);
  const rotated = await rotateConnectionSecret(t, c.id);
  return {
    ok: true,
    site: t.siteId,
    connection: connectionJson(rotated.connection),
    signing_secret: rotated.signingSecret,
    affected: usageWords(rotated.connection),
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

/** Checks Booking's options, which only a connection route for booking takes. */
function checkBookingOptions(args: BindArgs): void {
  if (args.supportsCheck === undefined && args.availabilityUrl === undefined) return;
  if (!BOOKING_TARGETS.has(args.action)) {
    throw failed(
      "--supports-check and --availability-url are Booking options: bind `booking` (or `schedule`, `reserve`) to use them.",
      "invalid_input",
      { field: args.supportsCheck !== undefined ? "supports_check" : "availability_url" },
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

/** @returns The secret, said once, for a person. */
function secretLines(payload: Record<string, unknown>): string[] {
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
  const payload = await rotateOp(t, ref);
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

/** How to call `nxis connections`. */
const CONNECTIONS_USAGE =
  "Try `nxis connections list`, `nxis connections create --name <name> --url <url> [--default]`, " +
  "`nxis connections rotate <name|id>` or `nxis connections delete <name|id>`.";

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
      });
    case "rotate":
      return cmdConnectionsRotate(ctx, ref, { yes: bool(flags, "yes") });
    case "delete":
      return cmdConnectionsDelete(ctx, ref, { yes: bool(flags, "yes") });
    default:
      throw new CliError(CONNECTIONS_USAGE, { reason: "unknown_command" });
  }
}
