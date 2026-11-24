/**
 * The connection tools, which the CLI answers itself (surface `local`) over the sites API.
 *
 * @remarks
 * They do what `nxis connections` and `nxis actions bind --connection` do, through the same
 * operations, so a tool result is the command's `--json` object. A create or a rotation returns
 * the new signing secret once, as `signing_secret`; no other result carries it. Given `write_env`,
 * it writes the secret into that env file instead and returns only where (`written_to`,
 * `env_name`, `secret_preview`), so the secret never enters the conversation.
 *
 * The operations are imported when a tool runs, so importing the registry loads zod alone.
 */

import { z } from "zod";
import { failed } from "../errors.js";
import { defineLocalTool } from "./define.js";
import { ACTION_NAMES } from "./provisioning.js";

/** The `site` argument: an id or a domain, defaulting to the CLI's current site. */
const site = z.string().describe("Site id or domain. Defaults to the site saved in the CLI.").optional();

/** A connection, by name or id. */
const connection = z.string().min(1).describe("The connection's name (any case) or its 24-character id.");

/** Where to write a new secret instead of returning it. */
const writeEnv = z
  .string()
  .min(1)
  .describe(
    "Write the new signing secret into this env file (such as .env.local) instead of returning it, so it never " +
      "enters the conversation. Relative to the directory `nxis mcp serve` runs in. Refused unless git ignores the " +
      "file or it is outside a git repository. Prefer this whenever the user's app reads its secrets from an env file.",
  )
  .optional();

/** The variable `write_env` sets. */
const envName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .describe("With write_env: the variable to set. Defaults to NXIS_ACTION_SECRET.")
  .optional();

/** @returns `{ writeEnv }` for the operations, when `write_env` was given. */
function writeEnvOf(args: { write_env?: string | undefined; env_name?: string | undefined }) {
  if (args.write_env === undefined) {
    if (args.env_name !== undefined) throw failed("env_name goes with write_env.", "invalid_input", { field: "env_name" });
    return {};
  }
  return { writeEnv: { file: args.write_env, ...(args.env_name !== undefined ? { name: args.env_name } : {}) } };
}

type Result = Record<string, unknown>;

/** @returns The operations, loaded on first use. */
const ops = () => import("../commands/connections.js");

export const listConnectionsTool = defineLocalTool<Result>()({
  name: "nxis_list_connections",
  description:
    "List the site's connections: the named addresses on the site's own servers that hosted agents and actions " +
    "send requests to. Each has a name, an address, the first characters of its signing secret (never the secret), " +
    "whether it is the site default, and what uses it. Read-only.",
  input: z.strictObject({ site }),
  takesSite: true,
  readOnly: true,
  hints: { openWorld: false },
  async call(ctx, args) {
    const { listOp, siteRefOf } = await ops();
    return listOp(await siteRefOf(ctx, args.site));
  },
});

export const createConnectionTool = defineLocalTool<Result>()({
  name: "nxis_create_connection",
  description:
    "Create a connection: a name and an https address on the site's own servers that agents and actions can " +
    "send requests to, signed with a new secret. The result has the secret as signing_secret, once: it cannot be " +
    "read again. Give it to the user, or store it where they tell you (the receiving application's configuration); " +
    "better, pass write_env so it is written to the app's env file and never returned. " +
    "Use an address the user named; never invent one. make_default makes it the site's default connection.",
  input: z.strictObject({
    site,
    name: z.string().min(1).max(60).describe("1 to 60 characters, unique on the site ignoring case."),
    url: z.string().describe("https address that receives the requests. No user name or password in it."),
    make_default: z.boolean().describe("Make it the site's default connection. Defaults to false.").optional(),
    write_env: writeEnv,
    env_name: envName,
  }),
  takesSite: true,
  readOnly: false,
  // Adds a connection; with make_default, replaces where the default route sends.
  hints: { destructive: true, idempotent: false, openWorld: false },
  async call(ctx, args) {
    const { createOp, siteRefOf } = await ops();
    return createOp(await siteRefOf(ctx, args.site), {
      name: args.name,
      url: args.url,
      makeDefault: args.make_default === true,
      ...writeEnvOf(args),
    });
  },
});

export const rotateConnectionTool = defineLocalTool<Result>()({
  name: "nxis_rotate_connection_secret",
  description:
    "Issue a connection a new signing secret. The previous secret stops working at once, for every agent and " +
    "action that uses the connection, until the receiving application has the new one. The result has the new " +
    "secret as signing_secret, once, or, with write_env, writes it into that env file and returns only where. " +
    "Only rotate when the user asks.",
  input: z.strictObject({ site, connection, write_env: writeEnv, env_name: envName }),
  takesSite: true,
  readOnly: false,
  hints: { destructive: true, idempotent: false, openWorld: false },
  async call(ctx, args) {
    const { rotateOp, siteRefOf } = await ops();
    return rotateOp(await siteRefOf(ctx, args.site), args.connection, writeEnvOf(args).writeEnv);
  },
});

export const deleteConnectionTool = defineLocalTool<Result>()({
  name: "nxis_delete_connection",
  description:
    "Delete a connection. It is refused while any agent or action still sends through it (connection_in_use): " +
    "bind them to another connection first.",
  input: z.strictObject({ site, connection }),
  takesSite: true,
  readOnly: false,
  hints: { destructive: true, idempotent: true, openWorld: false },
  async call(ctx, args) {
    const { deleteOp, siteRefOf } = await ops();
    return deleteOp(await siteRefOf(ctx, args.site), args.connection);
  },
});

export const testConnectionTool = defineLocalTool<Result>()({
  name: "nxis_test_connection",
  description:
    "Check a connection's receiver: NxisAI sends one signed check call (X-Nxis-Mode: check, \"nxis:mode\": \"check\") " +
    "to its address, signed with its secret as real requests are, and says how the receiver answered. verdict is ok, " +
    "signature_rejected (401 or 403), unreachable, timeout or bad_response, with http_status, latency_ms, the start " +
    "of the answer's body and `next`, the step that fixes it. answered_by says who answered: receiver, or tunnel, " +
    "proxy or cdn when one in front of the receiver answered with its own error page (verdict unreachable: the " +
    "call never got to the receiver). answers_checks says whether the receiver answered as an availability check " +
    "(JSON with a boolean available; null when it can't be told), returned_windows and returned_hold what a booking " +
    "check carried, and check_support_off the routes on the connection (default, QuoteAction, ScheduleAction ...) " +
    "whose check support is off: agents there don't check first (Booking takes requests to confirm instead of " +
    "offering open times, Quote skips the service area). When answers_checks is true and check_support_off is not " +
    "empty, turn it on by calling again with turn_on_checks: true (ask the user first, unless they asked you to set " +
    "the site up); check_support_turned_on then lists the routes turned on. A connection tested before its agents " +
    "are enabled needs nothing more: routes made later start with check support on when the receiver answered " +
    "checks. A check commits nothing, so the test needs no confirmation. Run it after building or changing a " +
    "receiver, before turning on agents that send to it, and again after enabling them. One test per connection " +
    "every few seconds.",
  input: z.strictObject({
    site,
    connection,
    action: z
      .string()
      .describe(
        "The action the example arguments are for: quote, booking, schedule, reserve, ask, …, default, or an action " +
          "type such as QuoteAction. Omit to use the connection's own route.",
      )
      .optional(),
    turn_on_checks: z
      .boolean()
      .describe(
        "When the receiver answers availability checks, turn check support on for every route on this connection " +
          "that has it off. Nothing changes when it doesn't answer checks. Defaults to false.",
      )
      .optional(),
  }),
  takesSite: true,
  // A plain test only reads; turn_on_checks may turn check support on for the connection's routes.
  readOnly: (args) => args.turn_on_checks !== true,
  // Sends one request to the site's own receiver, which commits nothing for a check. Turning checks on adds a
  // check before each send; it removes nothing.
  hints: { destructive: false, idempotent: true, openWorld: true },
  async call(ctx, args) {
    const { testOp, siteRefOf } = await ops();
    return testOp(await siteRefOf(ctx, args.site), args.connection, args.action, args.turn_on_checks === true ? { turnOnChecks: true } : {});
  },
});

/** What a connection route can be bound for. */
const BIND_TARGETS = [...ACTION_NAMES, "booking", "default"] as const;

export const bindConnectionTool = defineLocalTool<Result>()({
  name: "nxis_bind_connection",
  description:
    "Send one route's requests through a connection: an action's submissions (reserve, quote ...), the Booking " +
    "agent's requests (booking), or the site default (default). Many routes can share one connection. " +
    "supports_check says the receiver answers availability checks, for any route: Booking then offers open times " +
    "and holds, and Quote checks the service area, before sending. availability_url is Booking's, for booking, " +
    "schedule or reserve. Call " +
    "nxis_list_connections first; create a connection only at an address the user named.",
  input: z.strictObject({
    site,
    action: z.enum(BIND_TARGETS).describe("The route: an action name, booking, or default."),
    connection,
    supports_check: z
      .boolean()
      .describe("The receiver answers availability checks, so agents check before they send. Omit to keep it as it is.")
      .optional(),
    availability_url: z
      .string()
      .describe("Booking only: where free times are read, on the connection's host. Empty clears it; omit to keep it.")
      .optional(),
  }),
  takesSite: true,
  readOnly: false,
  // Replaces where the route sends; the requests are then posted to the connection's address.
  hints: { destructive: true, idempotent: true, openWorld: true },
  async call(ctx, args) {
    const { bindOp, siteRefOf } = await ops();
    return bindOp(await siteRefOf(ctx, args.site), {
      action: args.action,
      connection: args.connection,
      ...(args.supports_check !== undefined ? { supportsCheck: args.supports_check } : {}),
      ...(args.availability_url !== undefined ? { availabilityUrl: args.availability_url } : {}),
    });
  },
});

/** Every connection tool, in the order an agent uses them. */
export const CONNECTION_TOOLS = [
  listConnectionsTool,
  createConnectionTool,
  bindConnectionTool,
  testConnectionTool,
  rotateConnectionTool,
  deleteConnectionTool,
] as const;
