/**
 * `nxis agents transcripts` — a site's hosted transcripts: list, read, export and delete them, set
 * how long they are kept, and the webhook each message is sent to.
 *
 * @remarks
 * Reads and deletes go to the sites service's transcript routes, which read and delete them where
 * they are stored. Retention and "don't store" are agent config fields, changed the way every
 * `nxis agents` change is: read, change one thing, write back whole at the version read
 * ({@link write}).
 *
 * Deletes cannot be undone, so they ask first, on a terminal, and stop with
 * `confirmation_required` (exit 2) anywhere else until `--yes` says the user was asked.
 *
 * `webhook set` makes the signing secret here, sends it once, and prints it once: the service never
 * returns it, and the CLI writes it nowhere else (not its settings, not the `--verbose` trace).
 */

import { writeFileSync } from "node:fs";
import { getAgentConfig, transcriptsOf } from "../api/agent-config.js";
import {
  deleteAllTranscripts,
  deleteTranscript,
  exportAll,
  generateSecret,
  getTranscript,
  getWebhookStatus,
  listTranscripts,
  PAGE_SIZE_MAX,
  setTranscriptWebhook,
  TRANSCRIPT_ID,
  transcriptsCsv,
  WEBHOOK_URL_MAX,
  type Transcript,
  type WebhookStatus,
} from "../api/transcripts.js";
import { bool, str, type Flags } from "../args.js";
import type { Ctx } from "../context.js";
import { CliError, failed } from "../errors.js";
import { bold, dim, plainText } from "../output.js";
import { confirmOrStop, terminalAsker, type Asker } from "../prompt.js";
import { isDryRun } from "../trace.js";
import { target, transcriptsJson, transcriptsLine, write, type Target } from "./hosted-agents.js";

/** `organizations/{org}/sites/{site}/transcripts/{id}`, with the id captured. */
const RESOURCE_NAME = /^organizations\/[^/]+\/sites\/[^/]+\/transcripts\/([^/]+)$/;

/** Retention limits, as the service checks them. */
export const RETENTION = { min: 1, max: 3650 } as const;

/** Usage, per subcommand. */
const USAGE = {
  list: "`nxis agents transcripts list [--limit <n>] [--page-token <t>]`",
  show: "`nxis agents transcripts show <id>`",
  export: "`nxis agents transcripts export [--out <file>] [--format json|csv] [--force]`",
  delete: "`nxis agents transcripts delete <id> | --all [--yes]`",
  settings: "`nxis agents transcripts settings [--retention-days <n>] [--dont-store | --store]`",
  webhook: "`nxis agents transcripts webhook set <url> [--keep-secret]`, `webhook remove` or `webhook status`",
} as const;

/**
 * Dispatches `nxis agents transcripts <sub> …`.
 *
 * @param asker - Who answers a delete's confirmation; the terminal unless a test passes one.
 * @throws CliError `unknown_command` for a subcommand that does not exist, and whatever the
 * subcommand throws.
 */
export async function runTranscripts(ctx: Ctx, args: string[], flags: Flags, asker: Asker = terminalAsker): Promise<void> {
  const [sub, arg, third] = args;
  switch (sub) {
    case "list": {
      const limit = limitOf(flags);
      const pageToken = str(flags, "page-token");
      await cmdTranscriptsList(ctx, { ...(limit !== undefined ? { limit } : {}), ...(pageToken ? { pageToken } : {}) });
      return;
    }
    case "show":
      await cmdTranscriptsShow(ctx, transcriptIdOf(arg, "show"));
      return;
    case "export": {
      const format = str(flags, "format") ?? "json";
      if (format !== "json" && format !== "csv") {
        throw failed(`--format is json or csv (got "${plainText(format)}").`, "invalid_format", { format });
      }
      const out = str(flags, "out");
      if (flags.has("out") && !out) throw failed(`Which file? ${USAGE.export}.`, "missing_out");
      await cmdTranscriptsExport(ctx, { format, force: bool(flags, "force"), ...(out ? { out } : {}) });
      return;
    }
    case "delete": {
      const yes = bool(flags, "yes");
      if (bool(flags, "all")) {
        if (arg !== undefined) throw failed(`Either one id or --all, not both. ${USAGE.delete}.`, "conflicting_flags");
        await cmdTranscriptsDeleteAll(ctx, { yes, asker });
        return;
      }
      await cmdTranscriptsDelete(ctx, transcriptIdOf(arg, "delete"), { yes, asker });
      return;
    }
    case "settings": {
      const days = retentionOf(flags);
      const dontStore = bool(flags, "dont-store");
      const store = bool(flags, "store");
      if (dontStore && store) throw failed("Either --dont-store or --store, not both.", "conflicting_flags");
      await cmdTranscriptsSettings(ctx, {
        ...(days !== undefined ? { retentionDays: days } : {}),
        ...(dontStore ? { store: false } : store ? { store: true } : {}),
      });
      return;
    }
    case "webhook": {
      if (arg === "set") {
        if (!third) throw failed(`Which URL? ${USAGE.webhook}.`, "missing_webhook_url");
        await cmdWebhookSet(ctx, third, { keepSecret: bool(flags, "keep-secret") });
        return;
      }
      if (arg === "remove") {
        await cmdWebhookRemove(ctx);
        return;
      }
      if (arg === "status") {
        await cmdWebhookStatus(ctx);
        return;
      }
      throw new CliError(`Try ${USAGE.webhook}.`, { reason: "unknown_command" });
    }
    default:
      throw new CliError(
        `Try ${USAGE.list}, ${USAGE.show}, ${USAGE.export}, ${USAGE.delete}, ${USAGE.settings} or ${USAGE.webhook}.`,
        { reason: "unknown_command" },
      );
  }
}

/** @returns An integer flag's value, or undefined when absent. @throws CliError `reason` when it is not a whole number. */
function intFlag(flags: Flags, name: string, reason: string, usage: string): number | undefined {
  if (!flags.has(name)) return undefined;
  const raw = str(flags, name);
  if (raw === undefined || !/^\d+$/.test(raw.trim())) {
    throw failed(`--${name} takes a whole number. ${usage}.`, reason, { [name.replace(/-/g, "_")]: raw ?? null });
  }
  return Number(raw.trim());
}

/** @returns `--limit`, 1 to 100. @throws CliError `invalid_limit` (exit 1) otherwise. */
function limitOf(flags: Flags): number | undefined {
  const n = intFlag(flags, "limit", "invalid_limit", USAGE.list);
  if (n !== undefined && (n < 1 || n > PAGE_SIZE_MAX)) {
    throw failed(`--limit is 1 to ${PAGE_SIZE_MAX} (got ${n}).`, "invalid_limit", { limit: n });
  }
  return n;
}

/** @returns `--retention-days`, 1 to 3650. @throws CliError `invalid_retention` (exit 1) otherwise. */
function retentionOf(flags: Flags): number | undefined {
  const n = intFlag(flags, "retention-days", "invalid_retention", USAGE.settings);
  if (n !== undefined && (n < RETENTION.min || n > RETENTION.max)) {
    throw failed(`--retention-days is ${RETENTION.min} to ${RETENTION.max} (got ${n}).`, "invalid_retention", {
      retention_days: n,
    });
  }
  return n;
}

/**
 * @returns The transcript id: as given, or the last part of its resource name.
 * @throws CliError `missing_transcript` without one, `invalid_transcript_id` (exit 1) for one the
 * service would refuse.
 */
function transcriptIdOf(arg: string | undefined, sub: "show" | "delete"): string {
  if (!arg) throw failed(`Which transcript? ${USAGE[sub]}; \`nxis agents transcripts list\` lists them.`, "missing_transcript");
  // A resource name works too, as `list --json` prints it.
  const id = arg.includes("/") ? (RESOURCE_NAME.exec(arg)?.[1] ?? "") : arg;
  if (!TRANSCRIPT_ID.test(id)) {
    throw failed(`"${plainText(arg)}" is not a transcript id.`, "invalid_transcript_id", { transcript: plainText(arg) });
  }
  return id;
}

/** Options for `nxis agents transcripts list`. */
export interface ListArgs {
  /** 1 to 100; the service's default (25) when omitted. */
  limit?: number;
  pageToken?: string;
}

/** Runs `nxis agents transcripts list`: one page of conversations, newest first. */
export async function cmdTranscriptsList(ctx: Ctx, args: ListArgs = {}): Promise<void> {
  const t = await target(ctx);
  const page = await listTranscripts(ctx.config, t.token, t.orgId, t.siteId, {
    ...(args.limit !== undefined ? { pageSize: args.limit } : {}),
    ...(args.pageToken ? { pageToken: args.pageToken } : {}),
  });
  ctx.io.emit(
    {
      ok: true,
      org: t.orgId,
      site: t.siteId,
      transcripts: page.transcripts.map(({ messages: _messages, ...rest }) => rest),
      next_page_token: page.next_page_token || null,
    },
    () => {
      if (!page.transcripts.length) {
        return args.pageToken ? "No more transcripts." : `No transcripts stored for site ${bold(t.siteId)}.`;
      }
      const rows = page.transcripts.map(
        (x) =>
          `  ${x.id.padEnd(26)} ${x.agent.padEnd(8)} ${when(x.last_time).padEnd(17)} ${String(x.message_count).padStart(4)}  ` +
          (x.preview ? plainText(x.preview) : dim("(no visitor message)")),
      );
      const more = page.next_page_token
        ? `\n${dim(`More: nxis agents transcripts list --page-token ${page.next_page_token}`)}`
        : "";
      return [
        `Transcripts for site ${bold(t.siteId)}, newest first`,
        dim(`  ${"ID".padEnd(26)} ${"Agent".padEnd(8)} ${"Last message".padEnd(17)} ${"Msgs".padStart(4)}  Preview`),
        ...rows,
      ].join("\n") + more;
    },
  );
}

/** Runs `nxis agents transcripts show <id>`: one conversation, every message in order. */
export async function cmdTranscriptsShow(ctx: Ctx, id: string): Promise<void> {
  const t = await target(ctx);
  const transcript = await getTranscript(ctx.config, t.token, t.orgId, t.siteId, id);
  ctx.io.emit({ ok: true, org: t.orgId, site: t.siteId, transcript }, () => showText(transcript));
}

/** A conversation, for a person. */
function showText(x: Transcript): string {
  const head = [
    `Transcript ${bold(x.id)} ${dim(`(${x.agent || "unknown agent"})`)}`,
    `  Started ${when(x.start_time)}, last message ${when(x.last_time)}, ${x.message_count} message${x.message_count === 1 ? "" : "s"}`,
    `  Deleted after ${when(x.expire_time)}`,
    "",
  ];
  const lines = x.messages.map((m) => {
    const notes = [m.tool_call ? `called ${plainText(m.tool_call)}` : "", m.refusal ? `refused: ${plainText(m.refusal)}` : ""]
      .filter(Boolean)
      .join(", ");
    return `${dim(when(m.time))} ${bold(roleLabel(m.role))}${notes ? dim(` (${notes})`) : ""}\n    ${multiline(m.text)}`;
  });
  return [...head, ...(lines.length ? lines : [dim("No messages.")])].join("\n");
}

/** Options for `nxis agents transcripts export`. */
export interface ExportArgs {
  format?: "json" | "csv";
  /** A file to write; stdout without one. */
  out?: string;
  /** Replace the file when it exists. */
  force?: boolean;
}

/**
 * Runs `nxis agents transcripts export`: every conversation with its messages, every page, as one
 * JSON document (`{ site, exported_at, transcripts }`) or a CSV with one row per message.
 *
 * @remarks
 * A file is created readable by its owner only, since it holds what visitors wrote. Without
 * `--out`, the document goes to stdout; under `--json` that is the JSON document with `ok: true`,
 * and a CSV needs `--out`, so stdout stays one JSON object.
 *
 * @throws CliError `missing_out` (exit 1) for `--format csv --json` without `--out`;
 * `file_exists` (exit 1) for a file that exists, without `--force`; `write_failed` (exit 1).
 */
export async function cmdTranscriptsExport(ctx: Ctx, args: ExportArgs = {}): Promise<void> {
  const format = args.format ?? "json";
  if (format === "csv" && ctx.io.json && !args.out) {
    throw failed("A CSV export with --json needs --out <file>, so stdout stays one JSON object.", "missing_out");
  }
  const t = await target(ctx);
  const { transcripts, exportTime } = await exportAll(ctx.config, t.token, t.orgId, t.siteId, (n) =>
    ctx.io.note(`Exported ${n.toLocaleString("en-US")} conversation${n === 1 ? "" : "s"} so far…`),
  );
  const exportedAt = exportTime || new Date().toISOString();
  const document = { site: t.siteId, exported_at: exportedAt, transcripts };
  const messageCount = transcripts.reduce((n, x) => n + x.messages.length, 0);

  if (!args.out) {
    if (format === "csv") {
      process.stdout.write(transcriptsCsv(transcripts).csv);
      return;
    }
    ctx.io.emit({ ok: true, ...document }, () => JSON.stringify(document, null, 2));
    return;
  }

  const content = format === "csv" ? transcriptsCsv(transcripts).csv : `${JSON.stringify(document, null, 2)}\n`;
  try {
    writeFileSync(args.out, content, { encoding: "utf8", mode: 0o600, flag: args.force ? "w" : "wx" });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw failed(`${args.out} already exists. Pass --force to replace it, or pick another --out.`, "file_exists", {
        file: args.out,
      });
    }
    throw failed(`Could not write ${args.out}: ${(err as Error).message}`, "write_failed", { file: args.out });
  }
  ctx.io.emit(
    {
      ok: true,
      org: t.orgId,
      site: t.siteId,
      file: args.out,
      format,
      exported_at: exportedAt,
      transcript_count: transcripts.length,
      message_count: messageCount,
    },
    () =>
      `Exported ${conversations(transcripts.length)} (${messageCount.toLocaleString("en-US")} message${messageCount === 1 ? "" : "s"}) ` +
      `to ${args.out}.`,
  );
}

/** Options for a delete. */
export interface DeleteArgs {
  /** The user has already said yes. */
  yes?: boolean;
  asker?: Asker;
}

/**
 * Runs `nxis agents transcripts delete <id>`: deletes one conversation, after a yes.
 *
 * @throws CliError `confirmation_required` or `cancelled` (exit 2) without a yes;
 * `transcript_not_found` (exit 1); `dry_run` with the delete that would be sent.
 */
export async function cmdTranscriptsDelete(ctx: Ctx, id: string, args: DeleteArgs = {}): Promise<void> {
  const t = await target(ctx);
  if (!args.yes && !isDryRun()) {
    // Read it first, so the question says which conversation, and a wrong id fails before asking.
    const x = await getTranscript(ctx.config, t.token, t.orgId, t.siteId, id);
    await confirmOrStop(args.asker ?? terminalAsker, {
      summary:
        `${bold("Delete a transcript")}\n  ${x.id}: ${x.agent || "unknown agent"}, ${x.message_count} message` +
        `${x.message_count === 1 ? "" : "s"}, last ${when(x.last_time)}` +
        (x.preview ? `\n  ${dim(`"${plainText(x.preview)}"`)}` : ""),
      needsYes:
        "This deletes the conversation for good, so it needs a yes. Show the user which one, then run again with --yes.",
      question: `Delete transcript ${x.id}? This cannot be undone.`,
      cancelled: "Cancelled. Nothing was deleted.",
      details: { transcript: x.id, site: t.siteId },
    });
  }
  await deleteTranscript(ctx.config, t.token, t.orgId, t.siteId, id);
  ctx.io.emit({ ok: true, org: t.orgId, site: t.siteId, deleted: id }, () => `Deleted transcript ${id}.`);
}

/**
 * Runs `nxis agents transcripts delete --all`: deletes every conversation of the site, after a yes.
 *
 * @throws CliError `confirmation_required` or `cancelled` (exit 2) without a yes; `dry_run` with
 * the delete that would be sent.
 */
export async function cmdTranscriptsDeleteAll(ctx: Ctx, args: DeleteArgs = {}): Promise<void> {
  const t = await target(ctx);
  if (!args.yes && !isDryRun()) {
    await confirmOrStop(args.asker ?? terminalAsker, {
      summary: `${bold("Delete every transcript")}\n  Every stored conversation of site ${t.siteId}, from both hosted agents.`,
      needsYes:
        "This deletes every stored conversation of the site for good, so it needs a yes. Ask the user, then run " +
        "again with --yes.",
      question: `Delete every transcript of site ${t.siteId}? This cannot be undone.`,
      cancelled: "Cancelled. Nothing was deleted.",
      details: { site: t.siteId, all: true },
    });
  }
  const count = await deleteAllTranscripts(ctx.config, t.token, t.orgId, t.siteId);
  ctx.io.emit(
    { ok: true, org: t.orgId, site: t.siteId, deleted_count: count },
    () => `Deleted ${conversations(count)} from site ${t.siteId}.`,
  );
}

/** Options for `nxis agents transcripts settings`. */
export interface SettingsArgs {
  /** 1 to 3650. */
  retentionDays?: number;
  /** False: NxisAI stores none ("don't store"); the webhook, if set, is then the only copy. */
  store?: boolean;
}

/**
 * Runs `nxis agents transcripts settings`: with no option, shows them; with one, changes it
 * through the agent config, keeping every other setting.
 */
export async function cmdTranscriptsSettings(ctx: Ctx, args: SettingsArgs = {}): Promise<void> {
  if (args.retentionDays === undefined && args.store === undefined) {
    const t = await target(ctx);
    const config = await getAgentConfig(ctx.config, t.token, t.orgId, t.siteId);
    ctx.io.emit(
      { ok: true, org: t.orgId, site: t.siteId, version: config.version, transcripts: transcriptsJson(config.settable) },
      () => `Transcripts for site ${bold(t.siteId)}: ${transcriptsLine(config.settable)}.`,
    );
    return;
  }
  await write(ctx, (s) => ({
    ...s,
    transcripts: {
      ...s.transcripts,
      ...(args.retentionDays !== undefined ? { retentionDays: args.retentionDays } : {}),
      ...(args.store !== undefined ? { doNotStore: !args.store } : {}),
    },
  }));
}

/** @throws CliError `invalid_webhook_url` (exit 1) for a URL the service would refuse. */
function checkWebhookUrl(url: string): void {
  let protocol = "";
  try {
    protocol = new URL(url).protocol;
  } catch {
    protocol = "";
  }
  if (protocol !== "https:" && protocol !== "http:") {
    throw failed(`The webhook must be an https URL (got "${plainText(url)}").`, "invalid_webhook_url", { webhook_url: plainText(url) });
  }
  if (url.length > WEBHOOK_URL_MAX) {
    throw failed(`The webhook URL is at most ${WEBHOOK_URL_MAX} characters (got ${url.length}).`, "invalid_webhook_url", {
      limit: WEBHOOK_URL_MAX,
      length: url.length,
    });
  }
}

/**
 * Runs `nxis agents transcripts webhook set <url>`: sets the webhook with a new signing secret,
 * and prints the secret, once. With `--keep-secret`, changes the URL only.
 *
 * @remarks
 * Setting a new secret on a webhook that has one replaces it: the receiver must switch to the new
 * one, and the result says `rotated: true`.
 *
 * @throws CliError `invalid_webhook_url` (exit 1, before anything is sent); `no_webhook_secret`
 * (exit 1) for `--keep-secret` with no webhook to keep one from; `dry_run` with the request that
 * would be sent, its secret redacted.
 */
export async function cmdWebhookSet(ctx: Ctx, rawUrl: string, args: { keepSecret?: boolean } = {}): Promise<void> {
  const url = rawUrl.trim();
  checkWebhookUrl(url);
  const t = await target(ctx);
  const before = transcriptsOf((await getAgentConfig(ctx.config, t.token, t.orgId, t.siteId)).settable);

  if (args.keepSecret) {
    if (!before.webhookSecretId) {
      throw failed(
        "There is no webhook yet, so no secret to keep. Run without --keep-secret to set one with a new secret.",
        "no_webhook_secret",
      );
    }
    if (before.webhookUrl === url) {
      ctx.io.emit(webhookJson(t, before.webhookUrl, before.webhookSecretId, { changed: false }), () =>
        `Already set; nothing changed. Webhook ${plainText(url)}.`,
      );
      return;
    }
    const saved = transcriptsOf((await setTranscriptWebhook(ctx.config, t.token, t.orgId, t.siteId, url)).settable);
    ctx.io.emit(webhookJson(t, saved.webhookUrl, saved.webhookSecretId, { changed: true }), () =>
      `Webhook moved to ${plainText(saved.webhookUrl)}; its signing secret is unchanged.`,
    );
    return;
  }

  const secret = generateSecret();
  const saved = transcriptsOf((await setTranscriptWebhook(ctx.config, t.token, t.orgId, t.siteId, url, secret)).settable);
  const rotated = Boolean(before.webhookSecretId);
  ctx.io.emit(webhookJson(t, saved.webhookUrl, saved.webhookSecretId, { changed: true, rotated, secret }), () =>
    [
      `Webhook set: each message is sent to ${plainText(saved.webhookUrl)}, signed.`,
      ...(rotated ? ["The previous signing secret no longer works; switch the receiver to this one."] : []),
      "",
      "Signing secret (shown once; it cannot be read back):",
      `  ${secret}`,
    ].join("\n"),
  );
}

/** Runs `nxis agents transcripts webhook remove`: removes the webhook and its secret. */
export async function cmdWebhookRemove(ctx: Ctx): Promise<void> {
  const t = await target(ctx);
  const before = transcriptsOf((await getAgentConfig(ctx.config, t.token, t.orgId, t.siteId)).settable);
  if (!before.webhookUrl && !before.webhookSecretId) {
    ctx.io.emit(webhookJson(t, "", "", { changed: false }), () => "No webhook is set; nothing changed.");
    return;
  }
  await setTranscriptWebhook(ctx.config, t.token, t.orgId, t.siteId, "");
  ctx.io.emit(webhookJson(t, "", "", { changed: true }), () => "Webhook removed, with its signing secret.");
}

/** Runs `nxis agents transcripts webhook status`: the webhook, and how its deliveries are going. */
export async function cmdWebhookStatus(ctx: Ctx): Promise<void> {
  const t = await target(ctx);
  const status = await getWebhookStatus(ctx.config, t.token, t.orgId, t.siteId);
  ctx.io.emit({ ok: true, org: t.orgId, site: t.siteId, ...status }, () => statusText(status));
}

/** The webhook status, for a person. */
function statusText(s: WebhookStatus): string {
  if (!s.webhook_url) return "No webhook is set. `nxis agents transcripts webhook set <url>` sets one.";
  const lines = [
    `Webhook ${bold(plainText(s.webhook_url))}`,
    `  Signing secret  ${s.secret_set ? "set" : "missing: run `webhook set <url>` for a new one"}`,
    `  Delivered       ${s.delivered_count.toLocaleString("en-US")}`,
    `  Gave up         ${s.failed_count.toLocaleString("en-US")}`,
  ];
  if (s.dead_letters.length) {
    lines.push("", "Deliveries that gave up, newest first:");
    for (const d of s.dead_letters) {
      lines.push(
        `  ${when(d.time)}  ${d.transcript}  ${d.attempts} attempt${d.attempts === 1 ? "" : "s"}, ` +
          `${d.last_status ? `HTTP ${d.last_status}` : "unreachable"}${d.error ? `: ${plainText(d.error)}` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

/** The `--json` result of a webhook change. `secret` only when one was just made. */
function webhookJson(
  t: Target,
  url: string,
  secretId: string,
  extra: { changed: boolean; rotated?: boolean; secret?: string },
): Record<string, unknown> {
  return {
    ok: true,
    org: t.orgId,
    site: t.siteId,
    webhook_url: url || null,
    webhook_secret_id: secretId || null,
    ...extra,
  };
}

/** @returns A time as `2026-11-14 09:30 UTC`, or `—` when unset or unreadable. */
function when(ts: string): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "—" : `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** @returns A role as it reads: `visitor` → `Visitor`. */
function roleLabel(role: string): string {
  const r = plainText(role);
  return r ? r.charAt(0).toUpperCase() + r.slice(1) : "Unknown";
}

/** @returns Message text safe to print, its line breaks kept and indented. */
function multiline(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trimEnd())
    .join("\n    ");
}

/** @returns `1 conversation`, `3 conversations`. */
function conversations(n: number): string {
  return `${n.toLocaleString("en-US")} conversation${n === 1 ? "" : "s"}`;
}
