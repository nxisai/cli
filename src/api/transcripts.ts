/**
 * Sites API: a site's hosted transcripts, and the webhook each message is sent to.
 *
 * @remarks
 * What the site's hosted agents' visitors said and what the agents answered, redacted before it is
 * stored, and kept for the site's retention period (`transcripts.retentionDays` in the agent
 * config). The service reads and deletes them where they are stored; nothing here caches them.
 *
 * Responses may name fields in snake_case or lowerCamelCase, and 64-bit counts may arrive as
 * strings, as in `agent-config.ts`. Both are read. Each transcript is normalized to the proto's
 * snake_case field names, which is also how `--json` and the export file name them.
 *
 * The webhook's signing secret is write-only: it is sent once, in the body of
 * `setTranscriptWebhook`, and the service never returns it. The request tracer already redacts a
 * body field named `secret`.
 */

import { randomBytes } from "node:crypto";
import type { Config } from "../config.js";
import { CliError, failed } from "../errors.js";
import { request } from "../http.js";
import { camelKeys, parseAgentConfig, resourceName, type AgentConfig } from "./agent-config.js";
import { num } from "./shapes.js";

/** One message of a conversation, redacted as stored. */
export interface TranscriptMessage {
  id: string;
  /** `visitor`, `agent` or `tool`. */
  role: string;
  text: string;
  time: string;
  /** The guardrail rule that refused the turn; empty otherwise. */
  refusal: string;
  /** The tool the agent called; empty otherwise. */
  tool_call: string;
  /** A visitor message and the agent's answer share one. */
  turn: string;
}

/** One conversation. `messages` is empty in a list. */
export interface Transcript {
  /** The last part of `name`. */
  id: string;
  /** `organizations/{org}/sites/{site}/transcripts/{id}` */
  name: string;
  /** `page` or `support`. */
  agent: string;
  start_time: string;
  last_time: string;
  expire_time: string;
  message_count: number;
  /** The first visitor message, redacted, cut to 120 characters. */
  preview: string;
  messages: TranscriptMessage[];
}

/** A page of a list or an export. */
export interface TranscriptPage {
  transcripts: Transcript[];
  /** Empty on the last page. */
  next_page_token: string;
  /** Export pages only; empty otherwise. */
  export_time: string;
}

/** A webhook delivery that gave up after its retries. Never the message text. */
export interface DeadLetter {
  event_id: string;
  /** The transcript's id. */
  transcript: string;
  time: string;
  attempts: number;
  /** The receiver's last HTTP status, or 0 when it couldn't be reached. */
  last_status: number;
  error: string;
}

/** How the webhook's deliveries are going. */
export interface WebhookStatus {
  webhook_url: string;
  /** Whether the edge holds the secret the config names. */
  secret_set: boolean;
  delivered_count: number;
  failed_count: number;
  /** Newest first, at most 50. */
  dead_letters: DeadLetter[];
}

/** The list's page size limits: 0 means the service's default (25), at most 100. */
export const PAGE_SIZE_MAX = 100;

/** A transcript id, as the service accepts it. */
export const TRANSCRIPT_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** At most this many export pages: a page token that never ends stops here rather than looping. */
export const EXPORT_MAX_PAGES = 1000;

/** The prefix of a signing secret made here, so it is recognizable where it is pasted. */
export const SECRET_PREFIX = "whsk_";

/** The webhook URL's length limit. */
export const WEBHOOK_URL_MAX = 500;

/** @returns The value when it is a plain object, else undefined. */
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** @returns The value as a string: "" for null and undefined. */
function text(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

/** @returns The last part of a resource name. */
export function idOf(name: string): string {
  return name.split("/").pop() ?? "";
}

/** @returns One message, from either field naming. */
function parseMessage(raw: unknown): TranscriptMessage {
  const m = object(raw) ?? {};
  return {
    id: text(m["id"]),
    role: text(m["role"]),
    text: text(m["text"]),
    time: text(m["time"]),
    refusal: text(m["refusal"]),
    tool_call: text(m["toolCall"]),
    turn: text(m["turn"]),
  };
}

/** @returns One conversation, from either field naming (already camelCased). */
function parseTranscriptBody(t: Record<string, unknown>): Transcript {
  const name = text(t["name"]);
  return {
    id: idOf(name),
    name,
    agent: text(t["agent"]),
    start_time: text(t["startTime"]),
    last_time: text(t["lastTime"]),
    expire_time: text(t["expireTime"]),
    message_count: num(t["messageCount"]) ?? 0,
    preview: text(t["preview"]),
    messages: Array.isArray(t["messages"]) ? t["messages"].map(parseMessage) : [],
  };
}

/** @returns A conversation as the service answered it, normalized. */
export function parseTranscript(raw: unknown): Transcript {
  return parseTranscriptBody(object(camelKeys(raw)) ?? {});
}

/** @returns A page of a list or export, normalized. */
export function parsePage(raw: unknown): TranscriptPage {
  const r = object(camelKeys(raw)) ?? {};
  const list = Array.isArray(r["transcripts"]) ? r["transcripts"] : [];
  return {
    transcripts: list.map((t) => parseTranscriptBody(object(t) ?? {})),
    next_page_token: text(r["nextPageToken"]),
    export_time: text(r["exportTime"]),
  };
}

/** @returns The webhook status, normalized. */
export function parseWebhookStatus(raw: unknown): WebhookStatus {
  const r = object(camelKeys(raw)) ?? {};
  const dead = Array.isArray(r["deadLetters"]) ? r["deadLetters"] : [];
  return {
    webhook_url: text(r["webhookUrl"]),
    secret_set: r["secretSet"] === true,
    delivered_count: num(r["deliveredCount"]) ?? 0,
    failed_count: num(r["failedCount"]) ?? 0,
    dead_letters: dead.map((d) => {
      const x = object(d) ?? {};
      return {
        event_id: text(x["eventId"]),
        transcript: idOf(text(x["transcript"])),
        time: text(x["time"]),
        attempts: num(x["attempts"]) ?? 0,
        last_status: num(x["lastStatus"]) ?? 0,
        error: text(x["error"]),
      };
    }),
  };
}

/** @returns `…/v1/organizations/{org}/sites/{site}`, the parent of a site's transcripts. */
function siteUrl(config: Config, orgId: string, siteId: string): string {
  return `${config.endpoints.sites}/v1/organizations/${encodeURIComponent(orgId)}/sites/${encodeURIComponent(siteId)}`;
}

/** @returns A query string from the values that are set, or "". */
function query(params: Record<string, string | number | undefined>): string {
  const set = Object.entries(params).filter(([, v]) => v !== undefined && v !== "" && v !== 0);
  return set.length ? `?${set.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&")}` : "";
}

/**
 * Maps a 404 on one transcript to `transcript_not_found`.
 *
 * @throws CliError `transcript_not_found` (exit 1) for a 404, and the error as it was otherwise.
 */
function notFound(err: unknown, id: string): never {
  if (err instanceof CliError && err.reason === "request_failed" && err.details["status"] === 404) {
    throw failed(
      `There is no transcript ${id} on this site: it was deleted, is past its retention, or the id is wrong. ` +
        "`nxis agents transcripts list` lists them.",
      "transcript_not_found",
      { transcript: id },
    );
  }
  throw err;
}

/**
 * A page of the site's conversations, newest first, without their messages.
 *
 * @param opts.pageSize - 1 to 100; omitted for the service's default (25).
 */
export async function listTranscripts(
  config: Config,
  token: string,
  orgId: string,
  siteId: string,
  opts: { pageSize?: number; pageToken?: string } = {},
): Promise<TranscriptPage> {
  const url = `${siteUrl(config, orgId, siteId)}/transcripts${query({ page_size: opts.pageSize, page_token: opts.pageToken })}`;
  return parsePage(await request<unknown>(url, { token }));
}

/**
 * One conversation, with its messages in order.
 *
 * @throws CliError `transcript_not_found` (exit 1) once it is deleted or past its retention.
 */
export async function getTranscript(config: Config, token: string, orgId: string, siteId: string, id: string): Promise<Transcript> {
  try {
    return parseTranscript(await request<unknown>(`${siteUrl(config, orgId, siteId)}/transcripts/${encodeURIComponent(id)}`, { token }));
  } catch (err) {
    notFound(err, id);
  }
}

/** One page of the export: conversations with their messages. */
export async function exportPage(
  config: Config,
  token: string,
  orgId: string,
  siteId: string,
  pageToken = "",
): Promise<TranscriptPage> {
  return parsePage(await request<unknown>(`${siteUrl(config, orgId, siteId)}/transcripts:export${query({ page_token: pageToken })}`, { token }));
}

/**
 * Every conversation with its messages: every export page, in order.
 *
 * @param onPage - Called after each page, with the count so far, for progress.
 * @returns The conversations, and the export time of the last page.
 */
export async function exportAll(
  config: Config,
  token: string,
  orgId: string,
  siteId: string,
  onPage?: (count: number) => void,
): Promise<{ transcripts: Transcript[]; exportTime: string }> {
  const transcripts: Transcript[] = [];
  let pageToken = "";
  let exportTime = "";
  for (let i = 0; i < EXPORT_MAX_PAGES; i++) {
    const page = await exportPage(config, token, orgId, siteId, pageToken);
    transcripts.push(...page.transcripts);
    exportTime = page.export_time || exportTime;
    onPage?.(transcripts.length);
    if (!page.next_page_token || page.next_page_token === pageToken) break;
    pageToken = page.next_page_token;
  }
  return { transcripts, exportTime };
}

/**
 * Deletes one conversation.
 *
 * @throws CliError `transcript_not_found` (exit 1) when there is none by that id.
 */
export async function deleteTranscript(config: Config, token: string, orgId: string, siteId: string, id: string): Promise<void> {
  try {
    await request<unknown>(`${siteUrl(config, orgId, siteId)}/transcripts/${encodeURIComponent(id)}`, { method: "DELETE", token });
  } catch (err) {
    notFound(err, id);
  }
}

/** Deletes every conversation of the site. @returns How many were deleted. */
export async function deleteAllTranscripts(config: Config, token: string, orgId: string, siteId: string): Promise<number> {
  const raw = await request<unknown>(`${siteUrl(config, orgId, siteId)}/transcripts:deleteAll`, { method: "POST", token, body: {} });
  return num(object(camelKeys(raw))?.["deletedCount"]) ?? 0;
}

/**
 * Sets, changes or removes the webhook.
 *
 * @param url - The webhook URL; empty removes the webhook and its secret.
 * @param secret - A new signing secret; omitted with a webhook already set keeps its secret.
 * @returns The agent config as saved.
 */
export async function setTranscriptWebhook(
  config: Config,
  token: string,
  orgId: string,
  siteId: string,
  url: string,
  secret?: string,
): Promise<AgentConfig> {
  const body: Record<string, string> = { webhookUrl: url };
  if (url && secret) body["secret"] = secret;
  const raw = await request<unknown>(`${siteUrl(config, orgId, siteId)}/agentConfig:setTranscriptWebhook`, {
    method: "POST",
    token,
    body,
  });
  return parseAgentConfig(raw ?? {}, resourceName(orgId, siteId));
}

/** How the webhook's deliveries are going. */
export async function getWebhookStatus(config: Config, token: string, orgId: string, siteId: string): Promise<WebhookStatus> {
  return parseWebhookStatus(await request<unknown>(`${siteUrl(config, orgId, siteId)}/transcripts:webhookStatus`, { token }));
}

/**
 * A new signing secret, made here and never by NxisAI: `whsk_` and 32 random bytes as unpadded
 * base64url, 48 characters in all, as the dashboard makes them.
 */
export function generateSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
}

// ── The CSV export ──────────────────────────────────────────────────────
// Built from the same export pages as the JSON, with the dashboard's columns and escaping, so a
// file from either opens the same way.

/** The first characters a spreadsheet reads as a formula (OWASP's CSV injection list). */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One CSV field.
 *
 * @remarks
 * null and undefined are empty. A field starting with `=`, `+`, `-`, `@`, a tab or a CR gets a `'`
 * in front, so a spreadsheet shows it as text rather than running it. Then a field holding a `"`,
 * `,`, CR or LF is quoted, its quotes doubled (RFC 4180).
 */
export function csvField(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One CSV record: its fields escaped, joined by commas, ended by CRLF. */
export const csvRow = (fields: unknown[]): string => `${fields.map(csvField).join(",")}\r\n`;

/** The header: the conversation's columns, repeated on each of its messages, then the message's. */
export const CSV_COLUMNS = [
  "transcript_id",
  "agent",
  "conversation_start",
  "conversation_last",
  "message_count",
  "message_id",
  "message_time",
  "role",
  "text",
  "refusal",
  "tool_call",
  "turn",
] as const;

/** A UTF-8 byte order mark, first in the file, so Excel reads it as UTF-8. */
export const CSV_BOM = "﻿";

/**
 * The CSV: the BOM, the header, then one row per message in order. A conversation with no
 * messages still gets a row, its message columns empty.
 */
export function transcriptsCsv(transcripts: Transcript[]): { csv: string; messageCount: number } {
  let csv = CSV_BOM + csvRow([...CSV_COLUMNS]);
  let messageCount = 0;
  for (const t of transcripts) {
    const conv = [t.id, t.agent, t.start_time, t.last_time, t.message_count];
    if (!t.messages.length) csv += csvRow([...conv, "", "", "", "", "", "", ""]);
    for (const m of t.messages) {
      csv += csvRow([...conv, m.id, m.time, m.role, m.text, m.refusal, m.tool_call, m.turn]);
      messageCount++;
    }
  }
  return { csv, messageCount };
}
