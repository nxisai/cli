/**
 * `nxis agents` — a site's hosted agents: the on-page assistant and the Support Agent.
 *
 * @remarks
 * Each write reads the site's agent config, changes one thing, and writes the whole config back
 * with the version it read, so every setting the command does not touch stays exactly as it was.
 * When the config already says what was asked, nothing is sent and the result says
 * `changed: false`. When someone else changed it in between, the write is refused; the command
 * reads it again and retries once, then reports `version_conflict`.
 *
 * Inputs are checked against the service's own limits before anything is sent, so a too-long
 * label fails with a message that names the flag rather than a service error.
 *
 * Signing in goes through {@link getAccessToken}, so `NXIS_TOKEN` works; the site is `--site` or
 * the saved one, and a domain is resolved to the site's id the way `nxis keys` resolves it.
 *
 * The routing for `nxis agents <sub>` is here too ({@link runHostedAgents}), so `cli.ts` needs one
 * line. (The file is not `agents.ts`: that one detects coding agents for `nxis mcp install`.)
 */

import { readFileSync } from "node:fs";
import {
  brandingOf,
  getAgentConfig,
  getAgentInstructions,
  hasSystemPrompt,
  killOf,
  listAgentNotices,
  killSwitchOf,
  pageOf,
  parsePolicy,
  policyVersionOf,
  supportOf,
  systemPromptNotSettable,
  transcriptsOf,
  updateAgentConfig,
  PAGE_LIMITS,
  type AgentConfig,
  type AgentInstructions,
  type AgentNotice,
  type KillScope,
  type KillSwitchView,
  type SettableConfig,
} from "../api/agent-config.js";
import { bool, list, str, type Flags } from "../args.js";
import { getAccessToken } from "../auth.js";
import type { Ctx } from "../context.js";
import { requireOrg, requireSite } from "../context.js";
import { CliError, failed } from "../errors.js";
import { bold, dim, plainText } from "../output.js";
import { findSite } from "../tools/index.js";
import { getAgentSetup, dpaBaseUrl, dpaUrl, type AgentSetup } from "../api/agent-setup.js";
import { cmdAgentsDpa, cmdAgentsDpaAccept, dpaState } from "./agents-dpa.js";
import { terminalAsker, type Asker } from "../prompt.js";
import { runTranscripts } from "./transcripts.js";

/** The service's limits, checked here first so the error names the flag. */
export const LIMITS = {
  label: 100,
  description: 300,
  examples: 10,
  example: 200,
  reason: 200,
} as const;

/** Usage, per subcommand. */
const USAGE = {
  status: "`nxis agents status`",
  enable: "`nxis agents enable page|support [--label <text>] [--description <text>] [--example <q>]... [--model <id>]`",
  disable: "`nxis agents disable page|support`",
  pause: "`nxis agents pause [page|support] [--tools] [--reason <text>]`",
  resume: "`nxis agents resume [page|support]`",
  brand:
    "`nxis agents brand [--name <text>] [--logo <https url>] [--accent <#rrggbb>] [--privacy-url <https url>] " +
    "[--clear name|logo|accent|privacy-url]...`",
  policy: "`nxis agents policy set <file.json | ->` or `nxis agents policy show [--instructions]`",
  transcripts: "`nxis agents transcripts list|show|export|delete|settings|webhook`",
  dpa: "`nxis agents dpa` or `nxis agents dpa accept [--entity <name>] [--yes]`",
} as const;

/** Which hosted agent a subcommand acts on. */
export type HostedAgent = "page" | "support";

/**
 * Dispatches `nxis agents <sub> …`.
 *
 * @throws CliError `unknown_command` for a subcommand that does not exist, `missing_agent` for
 * `enable` or `disable` without `page` or `support`, `unknown_agent` for `pause` or `resume`
 * naming another agent, `missing_policy_file` for `policy set` with no file, and whatever the
 * subcommand throws.
 */
export async function runHostedAgents(ctx: Ctx, args: string[], flags: Flags, asker: Asker = terminalAsker): Promise<void> {
  const [sub, target] = args;
  switch (sub) {
    case "status":
      await cmdAgentsStatus(ctx);
      return;
    case "enable":
    case "disable": {
      if (target !== "page" && target !== "support") {
        throw failed(`Which agent? ${USAGE[sub]}.`, "missing_agent");
      }
      if (sub === "disable") {
        await cmdAgentsDisable(ctx, target);
        return;
      }
      const label = str(flags, "label");
      const description = str(flags, "description");
      const model = str(flags, "model");
      const examples = list(flags, "example");
      await cmdAgentsEnable(ctx, target, {
        ...(label !== undefined ? { label } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(examples.length > 0 ? { examples } : {}),
      });
      return;
    }
    case "pause": {
      const agent = optionalAgent(sub, target);
      const reason = str(flags, "reason");
      await cmdAgentsPause(ctx, {
        tools: bool(flags, "tools"),
        ...(reason !== undefined ? { reason } : {}),
        ...(agent ? { agent } : {}),
      });
      return;
    }
    case "resume":
      await cmdAgentsResume(ctx, optionalAgent(sub, target));
      return;
    case "brand":
      await cmdAgentsBrand(ctx, brandArgs(flags));
      return;
    case "policy": {
      if (target === "show") {
        await cmdAgentsPolicyShow(ctx, { instructions: bool(flags, "instructions") });
        return;
      }
      if (target === "set") {
        const file = args[2];
        if (!file) throw failed(`Which policy file? ${USAGE.policy}; \`-\` reads it from stdin.`, "missing_policy_file");
        await cmdAgentsPolicySet(ctx, file);
        return;
      }
      throw new CliError(`Try ${USAGE.policy}.`, { reason: "unknown_command" });
    }
    case "transcripts":
      await runTranscripts(ctx, args.slice(1), flags);
      return;
    case "dpa": {
      if (target === undefined) {
        await cmdAgentsDpa(ctx);
        return;
      }
      if (target === "accept") {
        await cmdAgentsDpaAccept(ctx, { yes: bool(flags, "yes"), entity: flags.get("entity"), asker });
        return;
      }
      throw new CliError(`Try ${USAGE.dpa}.`, { reason: "unknown_command" });
    }
    default:
      throw new CliError(
        `Try ${USAGE.status}, ${USAGE.enable}, ${USAGE.disable}, ${USAGE.pause}, ${USAGE.resume}, ${USAGE.brand}, ${USAGE.policy}, ` +
          `${USAGE.transcripts} or ${USAGE.dpa}.`,
        { reason: "unknown_command" },
      );
  }
}

/**
 * @returns The agent `pause` or `resume` names, or undefined for the whole site.
 * @throws CliError `unknown_agent` (exit 1) for anything but `page` or `support`.
 */
function optionalAgent(sub: "pause" | "resume", target: string | undefined): HostedAgent | undefined {
  if (target === undefined) return undefined;
  if (target === "page" || target === "support") return target;
  throw failed(`There is no hosted agent called "${plainText(target)}". ${USAGE[sub]}.`, "unknown_agent");
}

/** The organization, site and token a command acts with. */
export interface Target {
  orgId: string;
  siteId: string;
  token: string;
}

/** A 24-hex site id, used as it is; anything else is looked up among the organization's sites. */
const SITE_ID = /^[0-9a-f]{24}$/i;

/**
 * The organization, the site by id, and a token.
 *
 * @throws CliError `no_active_org`, `no_active_site`, `site_not_found` (exit 2), and whatever
 * signing in throws.
 */
export async function target(ctx: Ctx): Promise<Target> {
  const orgId = requireOrg(ctx);
  const site = requireSite(ctx).trim();
  const token = await getAccessToken(ctx.config);
  const siteId = SITE_ID.test(site) ? site : ((await findSite(ctx, site)).site as string);
  return { orgId, siteId, token };
}

/**
 * Runs `nxis agents status`: the site's hosted agents, as the edge will run them, and the
 * organization's notices about them that haven't been dismissed.
 *
 * @remarks
 * Notices are extra: when they can't be read (a service without them, say), the status is shown
 * without them and `notices` is null.
 */
export async function cmdAgentsStatus(ctx: Ctx): Promise<void> {
  const t = await target(ctx);
  const config = await getAgentConfig(ctx.config, t.token, t.orgId, t.siteId);
  const notices = await listAgentNotices(ctx.config, t.token, t.orgId)
    .then((all) => all.filter((n) => n.sites.length === 0 || n.sites.includes(t.siteId)))
    .catch(() => null);
  // The agreement, for what holds back going live. Status still answers when the setup can't be read.
  let setup: AgentSetup | null = null;
  try {
    setup = await getAgentSetup(ctx.config, t.token, t.orgId, t.siteId);
  } catch {
    setup = null;
  }
  const base = dpaBaseUrl();
  const blocker = goLiveBlocker(config, setup);
  const waiting = waitingOnDpa(config, setup);
  const graceEnd = config.live !== false && setup?.status === "grace" && setup.graceEnd ? setup.graceEnd : null;
  ctx.io.emit(
    {
      ...statusJson(t, config),
      // Whether visitors reach the agents: not while the site is in preview, or waits on the agreement.
      live: config.live !== false && !waiting,
      waiting_on_dpa: waiting,
      dpa: setup
        ? {
            state: dpaState(setup),
            version: setup.currentVersion || null,
            url: setup.currentVersion ? dpaUrl(setup.currentVersion, base) : null,
            accepted: setup.current,
            accepted_for: setup.legalEntity ? "legal_entity" : "organization",
            legal_entity: setup.legalEntity || null,
            grace_end: graceEnd,
          }
        : null,
      go_live_blocked_by: blocker,
      notices: notices?.map(noticeJson) ?? null,
    },
    () => `${summary(t, config)}\n${goLiveLine(config, setup, blocker, base)}` + noticesText(notices),
  );
}

/** A notice in `--json` results. */
function noticeJson(n: AgentNotice): Record<string, unknown> {
  return { name: n.name, kind: n.kind, title: n.title, message: n.message, create_time: n.createTime };
}

/** The notices' titles, under the status; nothing when there are none. */
function noticesText(notices: AgentNotice[] | null): string {
  if (!notices?.length) return "";
  return "\n\nNotices\n" + notices.map((n) => `  - ${plainText(n.title || n.message)}`).join("\n");
}

/**
 * The site asks to be live, but the current data processing agreement isn't accepted and no grace
 * applies, so the service keeps its agents in preview until it is: a site set up before preview
 * existed, or one past the 30 days a new version allows.
 */
export function waitingOnDpa(config: AgentConfig, setup: AgentSetup | null): boolean {
  return config.live !== false && setup?.status === "required";
}

/**
 * What holds the site back from answering visitors: `dpa_not_published` or `dpa_not_accepted` for a
 * site in preview (the service refuses going live until the current agreement is accepted),
 * `dpa_not_accepted` for a site that waits on it; null when nothing does, or the setup couldn't be read.
 */
export function goLiveBlocker(config: AgentConfig, setup: AgentSetup | null): "dpa_not_published" | "dpa_not_accepted" | null {
  if (!setup) return null;
  if (waitingOnDpa(config, setup)) return "dpa_not_accepted";
  if (config.live !== false) return null;
  if (!setup.currentVersion) return "dpa_not_published";
  return setup.current ? null : "dpa_not_accepted";
}

/** The status line about going live. */
function goLiveLine(config: AgentConfig, setup: AgentSetup | null, blocker: string | null, base: string): string {
  const row = (name: string, value: string) => `  ${name.padEnd(18)} ${value}`;
  const accept = setup?.legalEntity ? `\`nxis agents dpa accept --entity "${plainText(setup.legalEntity)}"\`` : "`nxis agents dpa accept`";
  if (setup && waitingOnDpa(config, setup)) {
    return [
      row("Visitors", `not reached: waiting on the data processing agreement (version ${plainText(setup.currentVersion)}).`),
      row("", `The agents answer visitors once it's accepted: read it at ${dpaUrl(setup.currentVersion, base)}, then ${accept}`),
    ].join("\n");
  }
  if (config.live !== false) {
    const on = pageOf(config.settable).enabled || supportOf(config.settable).enabled;
    if (on && setup?.status === "grace") {
      const end = setup.graceEnd ? setup.graceEnd.slice(0, 10) : "the grace period ends";
      return [
        row("Visitors", `reached until ${end}, on the earlier data processing agreement.`),
        row("", `Accept version ${plainText(setup.currentVersion)} by then to stay live: read it at ${dpaUrl(setup.currentVersion, base)}, then ${accept}`),
      ].join("\n");
    }
    return row("Visitors", on ? "reached: the agents are live" : "none reached: no agent is on");
  }
  if (blocker === "dpa_not_published") {
    return row("Visitors", "not yet: in preview. Going live waits for NxisAI's data processing agreement, not published yet");
  }
  if (blocker === "dpa_not_accepted" && setup) {
    return [
      row("Visitors", `not yet: in preview. Going live needs the data processing agreement (version ${plainText(setup.currentVersion)}) accepted:`),
      row("", `read it at ${dpaUrl(setup.currentVersion, base)}, then ${accept}`),
    ].join("\n");
  }
  return row("Visitors", "not yet: in preview. Go live from the dashboard's Agents page");
}

/** Options for `nxis agents enable`. */
export interface EnableArgs {
  label?: string;
  description?: string;
  /** Replace the example questions with these. */
  examples?: string[];
  /** A model id; empty for the default. */
  model?: string;
}

/**
 * Runs `nxis agents enable page|support`.
 *
 * @throws CliError `label_too_long`, `description_too_long`, `too_many_examples` or
 * `example_too_long` (exit 1, before anything is sent); `missing_label` (exit 1, before anything
 * is written) when the Support Agent would have no label; and whatever {@link write} throws.
 */
export async function cmdAgentsEnable(ctx: Ctx, agent: HostedAgent, args: EnableArgs = {}): Promise<void> {
  if (agent === "page") {
    await write(ctx, (s) => ({
      ...s,
      page: { ...s.page, enabled: true, ...(args.model !== undefined ? { model: args.model.trim() } : {}) },
    }));
    return;
  }

  const label = args.label?.trim();
  const description = args.description?.trim();
  const examples = args.examples?.map((e) => e.trim()).filter((e) => e.length > 0);
  checkLength("--label", label, LIMITS.label, "label_too_long");
  checkLength("--description", description, LIMITS.description, "description_too_long");
  if (examples && examples.length > LIMITS.examples) {
    throw failed(`At most ${LIMITS.examples} --example questions (got ${examples.length}).`, "too_many_examples", {
      limit: LIMITS.examples,
      count: examples.length,
    });
  }
  for (const example of examples ?? []) checkLength("--example", example, LIMITS.example, "example_too_long");

  await write(ctx, (s) => {
    const current = supportOf(s);
    const finalLabel = label || current.label;
    if (!finalLabel.trim()) {
      throw failed(
        "The Support Agent needs a label, the name a visitor reads. Pass --label <text>.",
        "missing_label",
      );
    }
    return {
      ...s,
      support: {
        ...s.support,
        enabled: true,
        label: finalLabel,
        ...(description !== undefined ? { description } : {}),
        ...(examples !== undefined ? { examples } : {}),
        ...(args.model !== undefined ? { model: args.model.trim() } : {}),
      },
    };
  });
}

/** @throws CliError with `reason` when the value is longer than `limit` characters. */
function checkLength(flag: string, value: string | undefined, limit: number, reason: string): void {
  if (value !== undefined && [...value].length > limit) {
    throw failed(`${flag} is at most ${limit} characters (got ${[...value].length}).`, reason, {
      limit,
      length: [...value].length,
    });
  }
}

/**
 * Runs `nxis agents disable page|support`. The agent's other settings are kept, so enabling it
 * again brings it back as it was.
 */
export async function cmdAgentsDisable(ctx: Ctx, agent: HostedAgent): Promise<void> {
  await write(ctx, (s) => ({ ...s, [agent]: { ...s[agent], enabled: false } }));
}

/** Options for `nxis agents pause`. */
export interface PauseArgs {
  /** Actions only: tools that change something are refused; answers and read-only lookups go on. */
  tools?: boolean;
  /** What a visitor is told. Without it, a message already set is kept. */
  reason?: string;
  /** Pause this agent only. Without it, the site-wide kill switch: every hosted agent. */
  agent?: HostedAgent;
}

/**
 * Runs `nxis agents pause [page|support]`: turns on a kill switch, for every turn or, with
 * `--tools`, for actions only (tools that change something). Naming an agent pauses that one only, and leaves the
 * site-wide switch as it is; naming none is the site-wide switch, for every hosted agent.
 *
 * @throws CliError `reason_too_long` (exit 1, before anything is sent), and whatever
 * {@link write} throws.
 */
export async function cmdAgentsPause(ctx: Ctx, args: PauseArgs = {}): Promise<void> {
  const reason = args.reason?.trim();
  checkLength("--reason", reason, LIMITS.reason, "reason_too_long");
  const scope: KillScope = args.tools ? "TOOLS" : "AGENT";
  const agent = args.agent;
  if (agent) {
    await write(ctx, (s) => {
      const current = s[agent];
      const held = killOf(object(current?.["killSwitch"]));
      return { ...s, [agent]: { ...current, killSwitch: { scope, reason: reason ?? held?.reason ?? "" } } };
    });
    return;
  }
  await write(ctx, (s) => ({
    ...s,
    killSwitch: { ...s.killSwitch, scope, reason: reason ?? killSwitchOf(s)?.reason ?? "" },
  }));
}

/**
 * Runs `nxis agents resume [page|support]`: turns that agent's own pause off, or, naming none,
 * the site-wide kill switch. Each one is resumed on its own: resuming the site leaves an agent
 * paused by name paused, and `status` shows which.
 */
export async function cmdAgentsResume(ctx: Ctx, agent?: HostedAgent): Promise<void> {
  const off = { scope: "KILL_SCOPE_UNSPECIFIED", reason: "" };
  if (agent) {
    await write(ctx, (s) =>
      killOf(object(s[agent]?.["killSwitch"])) ? { ...s, [agent]: { ...s[agent], killSwitch: off } } : s,
    );
    return;
  }
  await write(ctx, (s) => (killSwitchOf(s) ? { ...s, killSwitch: off } : s));
}

/** A part of the chat's branding `nxis agents brand` sets or clears, by its flag. */
export type BrandField = "name" | "logo" | "accent" | "privacy-url";

const BRAND_FIELDS: readonly BrandField[] = ["name", "logo", "accent", "privacy-url"];

/** Where each part is kept: in `page.branding`, or (the privacy link) in `page`. */
const BRAND_KEYS: Record<BrandField, string> = { name: "name", logo: "logoUrl", accent: "accentColor", "privacy-url": "privacyUrl" };

/** Options for `nxis agents brand`. Each one given is set; each one left out stays as it is. */
export interface BrandArgs {
  /** The agent's name, on the chat button and in the chat. */
  name?: string;
  /** The mark: an https image URL. */
  logo?: string;
  /** `#rgb` or `#rrggbb`. */
  accent?: string;
  /** The site's privacy page, an https URL, linked from the chat's notice. */
  privacyUrl?: string;
  /** Parts to reset to the default (for the privacy link: no link). */
  clear?: BrandField[];
}

/**
 * The options `nxis agents brand` was given.
 *
 * @throws CliError `missing_value` (exit 1) for a flag given without a value, and `invalid_clear`
 * for a `--clear` that names no part of the branding.
 */
function brandArgs(flags: Flags): BrandArgs {
  const args: BrandArgs = {};
  for (const [flag, key] of [
    ["name", "name"],
    ["logo", "logo"],
    ["accent", "accent"],
    ["privacy-url", "privacyUrl"],
  ] as const) {
    if (!flags.has(flag)) continue;
    const value = str(flags, flag);
    if (value === undefined) throw failed(`--${flag} needs a value. ${USAGE.brand}.`, "missing_value", { flag: `--${flag}` });
    args[key] = value;
  }
  if (flags.has("clear")) {
    const clear: BrandField[] = [];
    for (const v of flags.all.get("clear") ?? []) {
      const field = typeof v === "string" ? v.trim() : "";
      if (!(BRAND_FIELDS as readonly string[]).includes(field)) {
        throw failed(
          `--clear takes one of ${BRAND_FIELDS.join(", ")}${field ? ` (got "${plainText(field)}")` : ""}.`,
          "invalid_clear",
          { allowed: [...BRAND_FIELDS] },
        );
      }
      clear.push(field as BrandField);
    }
    args.clear = clear;
  }
  return args;
}

/** Characters a URL never holds unencoded, so a value with any of them is markup or a typo, not a URL. */
const NOT_IN_URL = /[\s<>"'`\\{}|^\u0000-\u001f\u007f]/;

/** An accent color, as the service accepts it. */
const ACCENT = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * @returns The URL, trimmed, when the service would take it for `page.branding.logo_url` or
 * `page.privacy_url`: `https://` with a host, at most {@link PAGE_LIMITS.url} characters, never markup.
 * The service needs a host, so an origin-relative path such as `/logo.svg` is refused too.
 * @throws CliError `invalid_url` (exit 1) naming the flag otherwise.
 */
function checkPageUrl(flag: string, raw: string): string {
  const value = raw.trim();
  const refuse = (why: string): never => {
    throw failed(`${flag} ${why} (got "${plainText(value.slice(0, 200))}").`, "invalid_url", { flag });
  };
  if (!value) refuse("needs a URL; use --clear to remove one");
  if (value.length > PAGE_LIMITS.url) refuse(`is at most ${PAGE_LIMITS.url} characters`);
  if (NOT_IN_URL.test(value)) refuse("must be a plain https URL, never markup or text with spaces or quotes");
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (!url || !/^https:\/\/[^/]/i.test(value) || !url.hostname) {
    refuse("must be a full https:// URL with the host (a path such as /logo.svg is not enough)");
  }
  return value;
}

/**
 * Runs `nxis agents brand`: the on-page chat's name, logo, accent color and privacy link
 * (`page.branding` and `page.privacy_url`).
 *
 * @remarks
 * Only the parts given change; the rest of the branding, the page agent and every other setting
 * stay as they were. `--clear` resets a part to the default. Without branding the chat shows the
 * default look.
 *
 * @throws CliError `missing_branding` when nothing is given, `conflicting_flags` for a part both set
 * and cleared, `invalid_name`, `name_too_long`, `invalid_url` or `invalid_accent` (each exit 1,
 * before anything is sent), and whatever {@link write} throws.
 */
export async function cmdAgentsBrand(ctx: Ctx, args: BrandArgs): Promise<void> {
  const clear = new Set(args.clear ?? []);
  const given: Record<BrandField, string | undefined> = {
    name: args.name,
    logo: args.logo,
    accent: args.accent,
    "privacy-url": args.privacyUrl,
  };
  if (BRAND_FIELDS.every((f) => given[f] === undefined) && clear.size === 0) {
    throw failed(`Nothing to change. ${USAGE.brand}.`, "missing_branding");
  }
  for (const f of clear) {
    if (given[f] !== undefined) {
      throw failed(`--${f} and --clear ${f} were both given; pick one.`, "conflicting_flags", { flag: `--${f}` });
    }
  }

  const name = args.name?.trim();
  if (name !== undefined) {
    if (!name) throw failed("--name needs the name visitors will see; --clear name restores the default.", "invalid_name");
    // UTF-16 code units, as the service counts.
    if (name.length > PAGE_LIMITS.brandingName) {
      throw failed(`--name is at most ${PAGE_LIMITS.brandingName} characters (got ${name.length}).`, "name_too_long", {
        limit: PAGE_LIMITS.brandingName,
        length: name.length,
      });
    }
  }
  const logo = args.logo !== undefined ? checkPageUrl("--logo", args.logo) : undefined;
  const privacyUrl = args.privacyUrl !== undefined ? checkPageUrl("--privacy-url", args.privacyUrl) : undefined;
  const accent = args.accent?.trim();
  if (accent !== undefined && !ACCENT.test(accent)) {
    throw failed(`--accent must be #rgb or #rrggbb, such as #C73A17 (got "${plainText(accent.slice(0, 40))}").`, "invalid_accent");
  }

  const values: Record<BrandField, string | undefined> = { name, logo, accent, "privacy-url": privacyUrl };
  const part = (field: BrandField): Record<string, string> => {
    const value = values[field] ?? (clear.has(field) ? "" : undefined);
    return value !== undefined ? { [BRAND_KEYS[field]]: value } : {};
  };

  await write(ctx, (s) => {
    const page = s.page ?? {};
    const branding = { ...object(page["branding"]), ...part("name"), ...part("logo"), ...part("accent") };
    return { ...s, page: { ...page, branding, ...part("privacy-url") } };
  });
}

/** @returns The value when it is a plain object, else undefined. */
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Runs `nxis agents policy set <file | ->`: replaces the guardrails policy document.
 *
 * @remarks
 * The document is sent as compact JSON text. The service sets its `version` to `v<version>`,
 * so a `version` in the file is not kept, and is ignored when deciding whether anything changed.
 *
 * The hosted agents' instructions are NxisAI's, so a document with `systemPrompt` is refused
 * here, and by the service with the same reason if it gets there.
 *
 * @param file - A path, or `-` for stdin.
 * @throws CliError `invalid_policy` (exit 1, before anything is sent) when the file can't be
 * read or isn't a JSON object; `system_prompt_not_settable` (exit 2, before anything is sent)
 * when it has `systemPrompt`; and whatever {@link write} throws.
 */
export async function cmdAgentsPolicySet(ctx: Ctx, file: string): Promise<void> {
  const document = readPolicy(file);
  if (hasSystemPrompt(document)) throw systemPromptNotSettable();
  const policy = JSON.stringify(document);
  await write(ctx, (s) => ({ ...s, policy }));
}

/** @returns The policy document in the file, or stdin for `-`. */
function readPolicy(file: string): Record<string, unknown> {
  const from = file === "-" ? "stdin" : file;
  let raw: string;
  try {
    raw = readFileSync(file === "-" ? 0 : file, "utf8");
  } catch (err) {
    throw failed(`Could not read the policy from ${from}: ${(err as Error).message}`, "invalid_policy", { file: from });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw failed(`The policy in ${from} is not JSON: ${(err as Error).message}`, "invalid_policy", { file: from });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw failed(`The policy in ${from} must be a JSON object.`, "invalid_policy", { file: from });
  }
  return parsed as Record<string, unknown>;
}

/** Options for `nxis agents policy show`. */
export interface PolicyShowArgs {
  /** Also print the on-page assistant's instructions in full, as it uses them. */
  instructions?: boolean;
}

/**
 * Runs `nxis agents policy show`: the guardrails policy document, as stored, and which version of
 * NxisAI's instructions the on-page assistant follows.
 *
 * @remarks
 * Without `--instructions`, the instructions are extra: when they can't be read, the policy is
 * still shown and `instructions` is null. With it, they were asked for, so a failure is reported.
 *
 * @throws CliError whatever reading the config throws, and with `--instructions`, whatever
 * reading the instructions throws.
 */
export async function cmdAgentsPolicyShow(ctx: Ctx, args: PolicyShowArgs = {}): Promise<void> {
  const t = await target(ctx);
  const config = await getAgentConfig(ctx.config, t.token, t.orgId, t.siteId);
  const reading = getAgentInstructions(ctx.config, t.token, t.orgId, t.siteId, "page");
  const instructions = args.instructions ? await reading : await reading.catch(() => null);
  const text = config.settable.policy ?? "";
  const parsed = parsePolicy(text);
  const policyText = text.trim()
    ? parsed !== null
      ? JSON.stringify(parsed, null, 2)
      : plainText(text)
    : "No policy set: the hosted agents use the built-in defaults. `nxis agents policy set <file.json>` sets one.";
  ctx.io.emit(
    {
      ok: true,
      org: t.orgId,
      site: t.siteId,
      version: config.version,
      policy_version: policyVersionOf(text),
      policy: text.trim() ? (parsed ?? text) : null,
      instructions: instructions
        ? {
            type: instructions.type,
            version: instructions.version,
            publish_time: instructions.publishTime,
            ...(args.instructions ? { text: instructions.text } : {}),
          }
        : null,
    },
    () =>
      [policyText, ...(instructions ? ["", instructionsLine(instructions)] : [])]
        .concat(instructions && args.instructions ? ["", multilineText(instructions.text)] : [])
        .join("\n"),
  );
}

/** "Instructions: NxisAI, version 3, published 2026-11-14", for the on-page assistant. */
export function instructionsLine(i: AgentInstructions): string {
  const date = i.publishTime && !Number.isNaN(new Date(i.publishTime).getTime()) ? new Date(i.publishTime).toISOString().slice(0, 10) : null;
  return `Instructions: NxisAI, version ${i.version}${date ? `, published ${date}` : ""}`;
}

/**
 * Text from a server with its lines kept, safe to print.
 *
 * @remarks
 * Like {@link plainText}, every other control character becomes a space, so the text can't move
 * the cursor or rewrite earlier lines; unlike it, line breaks and indentation stay.
 */
function multilineText(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trimEnd())
    .join("\n");
}

/**
 * Reads the config, applies a change, and writes it back when it changed anything.
 *
 * @remarks
 * A refused write (someone else changed the config in between) is retried once against the
 * config as it now is, with the same change; a second refusal is reported.
 *
 * @param change - The config as it should be, given the config as read. May throw to refuse.
 * @throws CliError `version_conflict` (exit 1) after the retry; `dry_run` with the write that
 * would be sent; and whatever reading and writing throw.
 */
export async function write(ctx: Ctx, change: (settable: SettableConfig) => SettableConfig): Promise<void> {
  const t = await target(ctx);
  for (let attempt = 0; ; attempt++) {
    const before = await getAgentConfig(ctx.config, t.token, t.orgId, t.siteId);
    const after = change(before.settable);
    if (effective(after) === effective(before.settable)) {
      ctx.io.emit({ ...statusJson(t, before), changed: false }, () => `Already set; nothing changed.\n${summary(t, before)}`);
      return;
    }
    try {
      const stored = await updateAgentConfig(ctx.config, t.token, t.orgId, t.siteId, before.version, after);
      ctx.io.emit(
        { ...statusJson(t, stored), changed: true },
        () => `Saved. The change reaches the site within seconds.\n${summary(t, stored)}`,
      );
      return;
    } catch (err) {
      if (attempt === 0 && err instanceof CliError && err.reason === "version_conflict") {
        ctx.io.note("The settings changed while this ran; reading them again and retrying once.");
        continue;
      }
      throw err;
    }
  }
}

/**
 * What a config means for the fields these commands change, as one comparable string.
 *
 * @remarks
 * Unset and default are the same thing here (no `page` is a page agent that is off), and the
 * policy's own `version` and key order don't count, since the service sets the one and may not
 * keep the other.
 */
function effective(s: SettableConfig): string {
  const policy = parsePolicy(s.policy);
  const policyBody =
    policy && typeof policy === "object" && !Array.isArray(policy)
      ? stable(Object.fromEntries(Object.entries(policy as Record<string, unknown>).filter(([k]) => k !== "version")))
      : (s.policy ?? "");
  const t = transcriptsOf(s);
  return stable({
    page: pageOf(s),
    support: supportOf(s),
    killSwitch: killSwitchOf(s),
    policy: policyBody,
    transcripts: { store: t.store, retentionDays: t.retentionDays },
  });
}

/** @returns JSON with object keys sorted, so key order does not count as a difference. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/** A kill switch in `--json` results. */
function killJson(kill: KillSwitchView | null): { scope: "agent" | "tools"; reason: string } | null {
  return kill ? { scope: kill.scope === "AGENT" ? "agent" : "tools", reason: kill.reason } : null;
}

/** The `--json` result for a config. */
function statusJson(t: Target, config: AgentConfig): Record<string, unknown> {
  const page = pageOf(config.settable);
  const support = supportOf(config.settable);
  const kill = killSwitchOf(config.settable);
  return {
    ok: true,
    org: t.orgId,
    site: t.siteId,
    version: config.version,
    page: {
      enabled: page.enabled,
      model: page.model || null,
      kill_switch: killJson(page.killSwitch),
      branding: brandingJson(config.settable),
      privacy_url: page.privacyUrl || null,
    },
    support: {
      enabled: support.enabled,
      label: support.label,
      description: support.description,
      examples: support.examples,
      model: support.model || null,
      kill_switch: killJson(support.killSwitch),
    },
    kill_switch: killJson(kill),
    policy_version: policyVersionOf(config.settable.policy),
    transcripts: transcriptsJson(config.settable),
    mcp_server: config.mcpServer
      ? { url: config.mcpServer.url, public: config.mcpServer.public, api_key_id: config.mcpServer.apiKeyId }
      : null,
    verified_hosts: config.verifiedHosts,
  };
}

/** The chat's branding in `--json` results; each part null for the default. */
function brandingJson(s: SettableConfig): Record<string, string | null> {
  const b = brandingOf(s);
  return { name: b.name || null, logo_url: b.logoUrl || null, accent_color: b.accentColor || null };
}

/** The chat's branding, in one line for a person. */
function brandingLine(s: SettableConfig): string {
  const b = brandingOf(s);
  const parts = [
    b.name ? `name "${plainText(b.name)}"` : "",
    b.logoUrl ? `logo ${plainText(b.logoUrl)}` : "",
    b.accentColor ? `accent ${plainText(b.accentColor)}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "default look";
}

/** The transcript settings in `--json` results. The secret's id is a reference, never the secret. */
export function transcriptsJson(s: SettableConfig): Record<string, unknown> {
  const t = transcriptsOf(s);
  return {
    store: t.store,
    retention_days: t.retentionDays,
    webhook_url: t.webhookUrl || null,
    webhook_secret_id: t.webhookSecretId || null,
  };
}

/** The transcript settings, in one line for a person. */
export function transcriptsLine(s: SettableConfig): string {
  const t = transcriptsOf(s);
  const kept = t.store ? `stored, kept ${t.retentionDays} day${t.retentionDays === 1 ? "" : "s"}` : "not stored";
  return kept + (t.webhookUrl ? `, webhook ${plainText(t.webhookUrl)}` : ", no webhook");
}

/** The human summary of a config. */
function summary(t: Target, config: AgentConfig): string {
  const page = pageOf(config.settable);
  const support = supportOf(config.settable);
  const kill = killSwitchOf(config.settable);
  const policyVersion = policyVersionOf(config.settable.policy);
  const model = (m: string) => (m ? `model ${plainText(m)}` : "default model");
  const mcp = config.mcpServer
    ? `MCP server ${plainText(config.mcpServer.url)}${config.mcpServer.public ? " (public)" : " (private, with a key)"}`
    : "no MCP server: the Support Agent stays off at the edge";
  const killText = (k: KillSwitchView) =>
    `${k.scope === "AGENT" ? "every turn refused" : "tools only, turns without tools still answered"}` +
    (k.reason ? ` ("${plainText(k.reason)}")` : "");
  const killLine = kill ? `on for every hosted agent: ${killText(kill)}` : "off";
  const paused = (k: KillSwitchView | null) => (k ? `, paused: ${killText(k)}` : "");

  const row = (name: string, value: string) => `  ${name.padEnd(18)} ${value}`;
  return [
    `Hosted agents for site ${bold(t.siteId)} ${dim(`(version ${config.version})`)}`,
    row("On-page assistant", (page.enabled ? `on, ${model(page.model)}` : "off") + paused(page.killSwitch)),
    row("", `chat ${brandingLine(config.settable)}`),
    row("", page.privacyUrl ? `privacy page ${plainText(page.privacyUrl)}` : "no privacy page linked"),
    row(
      "Support Agent",
      (support.enabled ? `on, ${model(support.model)}` : "off") +
        (support.label ? `, label "${plainText(support.label)}"` : "") +
        paused(support.killSwitch),
    ),
    row("", mcp),
    row("Kill switch", killLine),
    row("Policy", policyVersion ?? (config.settable.policy?.trim() ? "set, no version" : "built-in defaults")),
    row("Transcripts", transcriptsLine(config.settable)),
    row("Verified hosts", config.verifiedHosts.length ? config.verifiedHosts.map(plainText).join(", ") : "none"),
  ].join("\n");
}
