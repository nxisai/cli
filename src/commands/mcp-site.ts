/**
 * `nxis mcp public on|off` and `nxis mcp settings` — the site's own MCP server.
 *
 * @remarks
 * `nxis_mcp_settings` only reads. Each setting `--set` changes is written by the tool that owns
 * it, so the CLI changes exactly what the dashboard's toggles change:
 *
 * | `--set` key | Tool |
 * |---|---|
 * | `public` (`is_public`) | `nxis_enable_public_mcp` |
 * | `listed_in_app` (`listed`) | `nxis_list_in_app` |
 * | `on_page_agent` | `nxis_on_page_agent` |
 *
 * Action routing is `nxis actions bind`; it is not a `--set` key, because the tool that writes it
 * also resets the default route.
 */

import { list, type Flags } from "../args.js";
import type { Ctx } from "../context.js";
import { requireSite } from "../context.js";
import { CliError, failed } from "../errors.js";
import { bold, dim } from "../output.js";
import { withProvisioning } from "../provisioning/endpoint.js";
import {
  enablePublicMcp,
  listInApp,
  mcpSettings,
  onPageAgent,
  type ActionRoute,
  type McpSettingsResult,
  type ToolCaller,
} from "../tools/index.js";

/**
 * Dispatches the `nxis mcp` subcommands defined here.
 *
 * @returns False when `sub` is not one of them, so the caller can try its own.
 */
export async function mcpSiteCommand(ctx: Ctx, sub: string | undefined, third: string | undefined, flags: Flags): Promise<boolean> {
  if (sub === "public") {
    if (third !== "on" && third !== "off") {
      throw failed("On or off? `nxis mcp public on` or `nxis mcp public off`.", "invalid_input", { field: "state" });
    }
    await cmdMcpPublic(ctx, third === "on");
    return true;
  }
  if (sub === "settings") {
    await cmdMcpSettings(ctx, { set: list(flags, "set") });
    return true;
  }
  return false;
}

/** Runs `nxis mcp public on|off`. */
export async function cmdMcpPublic(ctx: Ctx, on: boolean): Promise<void> {
  const site = requireSite(ctx);
  const { data } = await enablePublicMcp.run(ctx, { enabled: on });
  const name = data?.domain ?? site;
  const isPublic = data?.is_public ?? on;
  ctx.io.emit(
    { ok: true, site, domain: data?.domain ?? null, is_public: isPublic, endpoint: data?.endpoint ?? null },
    () =>
      isPublic
        ? [
            `${bold(name)}'s MCP server is public.`,
            data?.endpoint ? `  Endpoint  ${data.endpoint}` : "",
            dim("Next: nxis discovery files --write, so agents can find it."),
          ]
            .filter(Boolean)
            .join("\n")
        : `${bold(name)}'s MCP server is no longer public. Agents need a key to read it.`,
  );
}

/** A setting `--set` can change, and the tool that writes it. */
interface Writable {
  /** The field in `nxis_mcp_settings`' result. */
  field: keyof McpSettingsResult;
  tool: string;
  call: (ctx: Ctx, value: boolean, provisioning: ToolCaller) => Promise<unknown>;
}

const WRITABLE: Record<string, Writable> = {
  public: {
    field: "is_public",
    tool: enablePublicMcp.name,
    call: (ctx, value, provisioning) => enablePublicMcp.run(ctx, { enabled: value }, { provisioning }),
  },
  listed_in_app: {
    field: "listed_in_app",
    tool: listInApp.name,
    call: (ctx, value, provisioning) => listInApp.run(ctx, { listed: value }, { provisioning }),
  },
  on_page_agent: {
    field: "on_page_agent",
    tool: onPageAgent.name,
    call: (ctx, value, provisioning) => onPageAgent.run(ctx, { enabled: value }, { provisioning }),
  },
};

const ALIASES: Record<string, string> = { is_public: "public", listed: "listed_in_app" };

/** The keys `--set` takes, for messages and help. */
export const SETTABLE_KEYS = Object.keys(WRITABLE);

/**
 * A `--set` value: `true`/`false` (also `on`/`off`, `yes`/`no`, `1`/`0`), a number, or text.
 */
export function parseSettingValue(raw: string): boolean | number | string {
  const v = raw.trim();
  const lower = v.toLowerCase();
  if (["true", "on", "yes", "1"].includes(lower)) return true;
  if (["false", "off", "no", "0"].includes(lower)) return false;
  if (v !== "" && Number.isFinite(Number(v))) return Number(v);
  return v;
}

/** One parsed `--set`. */
interface Change {
  key: string;
  value: boolean;
  writable: Writable;
}

/** Parses every `--set key=value`, refusing unknown keys and non-boolean values before anything is sent. */
export function parseSets(sets: string[]): Change[] {
  const out = new Map<string, Change>();
  for (const item of sets) {
    const eq = item.indexOf("=");
    if (eq <= 0) {
      throw failed(`\`--set ${item}\`: expected key=value, e.g. --set public=true.`, "invalid_input", { field: item });
    }
    const given = item.slice(0, eq).trim();
    const key = ALIASES[given] ?? given;
    const writable = WRITABLE[key];
    if (!writable) {
      throw failed(
        `\`${given}\` is not a setting --set can change. It takes ${SETTABLE_KEYS.join(", ")}` +
          (given.includes("action") || given.includes("route") ? "; action routing is `nxis actions bind`." : "."),
        "invalid_input",
        { field: given, settable: SETTABLE_KEYS },
      );
    }
    const value = parseSettingValue(item.slice(eq + 1));
    if (typeof value !== "boolean") {
      throw failed(`\`${given}\` is true or false.`, "invalid_input", { field: given });
    }
    out.set(key, { key, value, writable });
  }
  return [...out.values()];
}

/** Runs `nxis mcp settings [--set key=value …]`. */
export async function cmdMcpSettings(ctx: Ctx, args: { set?: string[] } = {}): Promise<void> {
  const changes = parseSets(args.set ?? []);
  const site = requireSite(ctx);

  const result = await withProvisioning(ctx, async (provisioning) => {
    const before = (await mcpSettings.run(ctx, {}, { provisioning })).data ?? {};
    if (changes.length === 0) return { settings: before, applied: [], unchanged: [], dryRun: [] };

    const applied: Array<{ key: string; value: boolean; tool: string }> = [];
    const unchanged: Array<{ key: string; value: boolean }> = [];
    const dryRun: Array<Record<string, unknown>> = [];
    for (const change of changes) {
      // Change only what differs: a rerun is a no-op, and nothing is toggled off and on again.
      if (before[change.writable.field] === change.value) {
        unchanged.push({ key: change.key, value: change.value });
        continue;
      }
      try {
        await change.writable.call(ctx, change.value, provisioning);
        applied.push({ key: change.key, value: change.value, tool: change.writable.tool });
      } catch (err) {
        if (err instanceof CliError && err.reason === "dry_run") {
          dryRun.push({ key: change.key, value: change.value, tool: change.writable.tool, arguments: err.details["arguments"] });
          continue;
        }
        throw err;
      }
    }
    const settings = applied.length > 0 ? ((await mcpSettings.run(ctx, {}, { provisioning })).data ?? {}) : before;
    return { settings, applied, unchanged, dryRun };
  });

  const payload: Record<string, unknown> = { ok: true, site, settings: result.settings };
  if (changes.length > 0) {
    payload["changed"] = result.applied;
    payload["unchanged"] = result.unchanged;
  }
  if (result.dryRun.length > 0) {
    payload["dry_run"] = true;
    payload["would_change"] = result.dryRun;
  }
  ctx.io.emit(payload, () => renderSettings(site, result));
}

function renderRoute(route: ActionRoute | undefined): string {
  if (!route?.route) return "unset";
  if (route.route === "browser") return "the page that hosts the action";
  if (route.route === "webhook") {
    const secret = route.signing_secret_preview ? `, signed with ${route.signing_secret_preview}` : "";
    return `webhook ${route.method ?? "POST"} ${route.url ?? "?"}${secret}`;
  }
  if (route.route === "gateway") return `gateway${route.provider ? ` (${route.provider})` : ""}`;
  return route.route;
}

function renderSettings(
  site: string,
  result: {
    settings: McpSettingsResult;
    applied: Array<{ key: string; value: boolean }>;
    unchanged: Array<{ key: string; value: boolean }>;
    dryRun: Array<Record<string, unknown>>;
  },
): string {
  const s = result.settings;
  const yes = (v: boolean | undefined) => (v ? "yes" : "no");
  const lines = [
    bold(`MCP settings for ${s.domain ?? site}`),
    `  Endpoint         ${s.endpoint ?? "—"}`,
    `  Enabled          ${yes(s.enabled)}`,
    `  Public           ${yes(s.is_public)}`,
    `  Listed in app    ${yes(s.listed_in_app)}`,
    `  On-page agent    ${yes(s.on_page_agent)}`,
    `  Actions          ${s.actions_enabled ? "on" : "off"}`,
    `  Default route    ${renderRoute(s.default_route)}`,
  ];
  for (const [action, route] of Object.entries(s.overrides ?? {})) {
    lines.push(`    ${action.padEnd(14)} ${renderRoute(route)}`);
  }
  if (s.api_key_preview) lines.push(`  Site key         ${s.api_key_preview}`);
  if (s.configured === false) {
    lines.push(dim("Not set up yet, so these are the defaults. `nxis mcp public on` sets it up."));
  }
  for (const c of result.applied) lines.push(`Set ${c.key} to ${c.value}.`);
  for (const c of result.unchanged) lines.push(dim(`${c.key} was already ${c.value}.`));
  for (const c of result.dryRun) lines.push(dim(`Dry run: would set ${String(c["key"])} to ${String(c["value"])}.`));
  return lines.join("\n");
}
