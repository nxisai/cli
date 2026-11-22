/**
 * The connection tools, which the CLI answers itself (surface `local`) over the sites API.
 *
 * @remarks
 * They do what `nxis connections` and `nxis actions bind --connection` do, through the same
 * operations, so a tool result is the command's `--json` object. A create or a rotation returns
 * the new signing secret once, as `signing_secret`; no other result carries it.
 *
 * The operations are imported when a tool runs, so importing the registry loads zod alone.
 */

import { z } from "zod";
import { defineLocalTool } from "./define.js";
import { ACTION_NAMES } from "./provisioning.js";

/** The `site` argument: an id or a domain, defaulting to the CLI's current site. */
const site = z.string().describe("Site id or domain. Defaults to the site saved in the CLI.").optional();

/** A connection, by name or id. */
const connection = z.string().min(1).describe("The connection's name (any case) or its 24-character id.");

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
    "read again. Give it to the user, or store it where they tell you (the receiving application's configuration). " +
    "Use an address the user named; never invent one. make_default makes it the site's default connection.",
  input: z.strictObject({
    site,
    name: z.string().min(1).max(60).describe("1 to 60 characters, unique on the site ignoring case."),
    url: z.string().describe("https address that receives the requests. No user name or password in it."),
    make_default: z.boolean().describe("Make it the site's default connection. Defaults to false.").optional(),
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
    });
  },
});

export const rotateConnectionTool = defineLocalTool<Result>()({
  name: "nxis_rotate_connection_secret",
  description:
    "Issue a connection a new signing secret. The previous secret stops working at once, for every agent and " +
    "action that uses the connection, until the receiving application has the new one. The result has the new " +
    "secret as signing_secret, once. Only rotate when the user asks.",
  input: z.strictObject({ site, connection }),
  takesSite: true,
  readOnly: false,
  hints: { destructive: true, idempotent: false, openWorld: false },
  async call(ctx, args) {
    const { rotateOp, siteRefOf } = await ops();
    return rotateOp(await siteRefOf(ctx, args.site), args.connection);
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

/** What a connection route can be bound for. */
const BIND_TARGETS = [...ACTION_NAMES, "booking", "default"] as const;

export const bindConnectionTool = defineLocalTool<Result>()({
  name: "nxis_bind_connection",
  description:
    "Send one route's requests through a connection: an action's submissions (reserve, quote ...), the Booking " +
    "agent's requests (booking), or the site default (default). Many routes can share one connection. " +
    "supports_check and availability_url are Booking options, for booking, schedule or reserve. Call " +
    "nxis_list_connections first; create a connection only at an address the user named.",
  input: z.strictObject({
    site,
    action: z.enum(BIND_TARGETS).describe("The route: an action name, booking, or default."),
    connection,
    supports_check: z
      .boolean()
      .describe("Booking only: check availability before booking. Omit to keep it as it is.")
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
  rotateConnectionTool,
  deleteConnectionTool,
] as const;
