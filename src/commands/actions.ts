/**
 * `nxis actions bind` — where a site's action submissions go — and `nxis actions on|off`.
 *
 * @remarks
 * Mirrors the dashboard's Server-Side Action Routing: the default route for every action, or an
 * override for one kind (`reserve`, `quote` …), or the Booking agent's own route (`booking`), sent
 * through a connection (`--connection <name|id>`), to a webhook (`--webhook <url>`), to the page
 * that hosts the action (`--self-page`), or to a gateway (`--gateway`, which is configured in the
 * dashboard, so the server says where to go).
 *
 * `--connection` and `--webhook` go through the site's connections (see `connections.ts`).
 * `--webhook` reuses the connection with that address, or creates one named from its host, whose
 * new signing secret is shown once, clearly labelled, and included in `--json` because the caller
 * asked for the result. The `--verbose` trace prints requests only, and redacts a `signing_secret`
 * field wherever one appears, so the secret is never traced.
 *
 * `on` and `off` send `enabled` and no route, which switches actions alone: every route, override
 * and connection is kept.
 */

import type { Ctx } from "../context.js";
import { requireSite } from "../context.js";
import { CliError, failed, needsUser } from "../errors.js";
import { bold, dim, plainText } from "../output.js";
import { ACTION_NAMES, bindMcpAction, type ActionRoute } from "../tools/index.js";
import { BIND_TARGETS, cmdBindConnection, isBindTarget } from "./connections.js";

/** Arguments for `nxis actions bind`. */
export interface ActionsBindArgs {
  /** An action name (`reserve`, `quote` …) or `default`. */
  action?: string;
  /** A connection's name or id. */
  connection?: string;
  webhook?: string;
  gateway?: boolean;
  selfPage?: boolean;
  /** Booking only: the route takes availability checks. Unset keeps it as it is. */
  supportsCheck?: boolean;
  /** Booking only: a separate free-times address on the connection's host. Empty clears it. */
  availabilityUrl?: string;
}

/** @returns The route for the one destination flag given. */
function routeOf(args: ActionsBindArgs): "browser" | "webhook" | "gateway" | "connection" {
  const given = [
    args.connection !== undefined,
    args.webhook !== undefined,
    args.gateway === true,
    args.selfPage === true,
  ].filter(Boolean).length;
  if (given !== 1) {
    throw failed(
      "Where should submissions go? Pass exactly one of --connection <name|id>, --webhook <url>, --gateway or --self-page.",
      "invalid_input",
      { field: "route" },
    );
  }
  if (args.connection !== undefined) return "connection";
  if (args.webhook !== undefined) return "webhook";
  return args.gateway ? "gateway" : "browser";
}

/**
 * The machine-readable reason in a refusal, when the server gave one: `SITE_NOT_VERIFIED` …
 *
 * @remarks
 * Read from the tool's structured answer (`reason`, or its `error_info.reason`), or from the
 * `google.rpc.ErrorInfo` of an HTTP error. Undefined when there is none, from an older server.
 */
function reasonOf(err: CliError): string | undefined {
  const pick = (v: unknown): string | undefined => (typeof v === "string" && v ? v.toUpperCase() : undefined);
  const info = err.details["error_info"];
  if (info && typeof info === "object") return pick((info as Record<string, unknown>)["reason"]);
  const said = err.details["tool_error"];
  if (said && typeof said === "object") {
    const obj = said as Record<string, unknown>;
    const nested = obj["error_info"];
    return pick(obj["reason"]) ?? (nested && typeof nested === "object" ? pick((nested as Record<string, unknown>)["reason"]) : undefined);
  }
  return undefined;
}

/**
 * Maps the server's refusal of an unverified site onto `site_not_verified`.
 *
 * @remarks
 * The server refuses an unverified site with an error rather than a result. The way forward is
 * the person's (deploy the tag, then `nxis sites verify --check`), so it is "needs you".
 *
 * The server's reason decides; the words of its message are read only when it gave none.
 */
function unverified(site: string, details: Record<string, unknown>): (err: unknown) => never {
  return (err) => {
    if (!(err instanceof CliError) || !["mcp_error", "tool_error", "request_failed"].includes(err.reason)) throw err;
    const reason = reasonOf(err);
    const isUnverified =
      reason !== undefined ? reason === "SITE_NOT_VERIFIED" : err.reason !== "request_failed" && /must be verified/i.test(err.message);
    if (isUnverified) {
      throw needsUser(
        `${site} is not verified yet, and actions are only bound on a verified site. ` +
          "Run `nxis sites verify --token`, deploy the tag, then `nxis sites verify --check`.",
        "site_not_verified",
        { site, ...details },
      );
    }
    throw err;
  };
}

/**
 * Runs `nxis actions bind <action|booking|default> --connection <name|id> | --webhook <url> |
 * --gateway | --self-page`.
 *
 * @throws CliError `invalid_input` (exit 1) for an unknown action, no destination or several, a
 * bad URL, or Booking's options on another route; `connection_not_found` (exit 2); `bind_incomplete` (exit 2) when the server changed nothing and says what it needs
 * (a gateway, for one, is set up in the dashboard); `site_not_verified` (exit 2) when the site has
 * not been verified, since actions are only bound on a site whose ownership is proven; and
 * whatever else the tool call throws.
 */
export async function cmdActionsBind(ctx: Ctx, args: ActionsBindArgs): Promise<void> {
  const name = args.action?.trim().toLowerCase();
  if (!name) {
    throw failed(`Which action? \`nxis actions bind <${ACTION_NAMES.join("|")}|booking|default> …\`.`, "invalid_input", {
      field: "action",
    });
  }
  if (!isBindTarget(name)) {
    throw failed(`\`${plainText(name)}\` is not an action. Use one of ${ACTION_NAMES.join(", ")}, booking, or default.`, "invalid_input", {
      field: "action",
      actions: [...BIND_TARGETS],
    });
  }
  const route = routeOf(args);
  const bookingOptions = args.supportsCheck !== undefined || args.availabilityUrl !== undefined;
  if (route === "connection" || route === "webhook") {
    await cmdBindConnection(ctx, {
      action: name,
      ...(route === "connection" ? { connection: args.connection ?? "" } : { webhook: args.webhook ?? "" }),
      ...(args.supportsCheck !== undefined ? { supportsCheck: args.supportsCheck } : {}),
      ...(args.availabilityUrl !== undefined ? { availabilityUrl: args.availabilityUrl } : {}),
    });
    return;
  }
  if (bookingOptions) {
    throw failed("--supports-check and --availability-url go with --connection or --webhook.", "invalid_input", {
      field: args.supportsCheck !== undefined ? "supports_check" : "availability_url",
    });
  }
  if (name === "booking") {
    throw failed("The Booking agent sends through a connection: use --connection <name|id> or --webhook <url>.", "invalid_input", {
      field: "route",
    });
  }
  const input: Parameters<typeof bindMcpAction.run>[1] = { route };
  if (name !== "default") input.action = name;

  const site = requireSite(ctx);
  const { data } = await bindMcpAction.run(ctx, input).catch(unverified(site, { action: name, route }));

  if (data?.changed === false) {
    throw needsUser(plainText(data.next ?? "The server did not change the binding."), "bind_incomplete", {
      action: name,
      route,
      next: data.next ?? null,
    });
  }

  const bound: ActionRoute | undefined = name === "default" ? data?.default_route : data?.overrides?.[name];
  const payload: Record<string, unknown> = {
    ok: true,
    site,
    action: name,
    route,
    binding: bound ?? null,
    actions_enabled: data?.actions_enabled ?? null,
    default_route: data?.default_route ?? null,
    overrides: data?.overrides ?? null,
    note: data?.note ?? null,
  };

  ctx.io.emit(payload, () => {
    const target = route === "gateway" ? "the gateway" : "the page that hosts the action";
    const lines = [
      `${name === "default" ? "Every action" : bold(name)} now goes to ${target}.`,
      ...(data?.note ? [dim(plainText(data.note))] : []),
    ];
    return lines.join("\n");
  });
}

/**
 * Runs `nxis actions on` or `nxis actions off`: turns the site's action tools on or off, and
 * changes nothing else.
 *
 * @remarks
 * It sends `enabled` with no route, so the server keeps every route, override and webhook secret.
 * Off on a site with no MCP settings is already off, and creates nothing. On needs somewhere to
 * send submissions, so with nothing bound the server refuses it and says what to bind.
 *
 * A server that predates switching actions alone treats a call with no route as binding the
 * default route to the page that hosts the action. Its answer has no `changed`, so the CLI can
 * tell, and says the default route may have been replaced.
 *
 * @throws CliError `nothing_bound` (exit 2, with the server's `next`) for `on` with no route bound;
 * `site_not_verified` (exit 2); `route_reset` (exit 2) from an older server; `dry_run` (exit 0)
 * under `--dry-run`; and whatever else the tool call throws.
 */
export async function cmdActionsSwitch(ctx: Ctx, on: boolean): Promise<void> {
  const site = requireSite(ctx);
  const { data } = await bindMcpAction.run(ctx, { enabled: on }).catch(unverified(site, { enabled: on }));
  const word = on ? "on" : "off";

  if (data?.changed === false && data.next) {
    // The server's `next` is written for an agent calling the tool. Say it as the commands that do
    // it, and keep the server's words in `next` for a caller that wants them.
    throw needsUser(
      `No route is bound for ${site} yet, so there is nowhere to send submissions. Bind one first: ` +
        "`nxis actions bind default --self-page` (the page that hosts the action) or " +
        "`nxis actions bind default --webhook <url>`, then run `nxis actions on`.",
      "nothing_bound",
      { site, enabled: on, next: data.next },
    );
  }
  if (data?.changed === undefined) {
    throw needsUser(
      `Actions are ${word} for ${site}, but this server cannot switch them alone yet: it also set the default ` +
        "route to the page that hosts the action. If the default was a webhook or a gateway, check " +
        "`nxis mcp settings` and bind it again with `nxis actions bind default …`.",
      "route_reset",
      { site, enabled: on, actions_enabled: data?.actions_enabled ?? null, default_route: data?.default_route ?? null },
    );
  }

  const payload = {
    ok: true,
    site,
    enabled: on,
    changed: data.changed,
    configured: data.configured !== false,
    actions_enabled: data.actions_enabled ?? on,
    default_route: data.default_route ?? null,
    overrides: data.overrides ?? null,
    note: data.note ?? null,
  };
  ctx.io.emit(payload, () => {
    const head = !payload.configured
      ? `${site} has no MCP settings, so its actions are already off.`
      : data.changed
        ? `Actions are ${bold(word)} for ${site}. Routes are unchanged.`
        : `Actions were already ${word} for ${site}; nothing changed.`;
    return [head, ...(!on && payload.configured ? [dim("`nxis actions on` turns them back on, with the same routes.")] : [])].join(
      "\n",
    );
  });
}
