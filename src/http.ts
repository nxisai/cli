/**
 * The HTTP layer.
 *
 * @remarks
 * Two things matter here beyond "call the endpoint". First, mapping transport failures onto
 * the exit-code contract, so a 401 becomes "re-authenticate" rather than a generic failure.
 * Second, polling — two of the nine steps end with the CLI waiting on something a human is
 * doing in a browser, and a wait has to stay legible while it happens.
 */

import { CliError, ExitCode, failed, notAuthorized } from "./errors.js";
import { isDryRun, redactBody, traceRequest, traceResponse } from "./trace.js";
import { plainText } from "./output.js";

/**
 * A service's machine-readable reason for an error: the `google.rpc.ErrorInfo` detail in its
 * body.
 *
 * @remarks
 * Through the HTTP transcoder an error body reads
 * `{"code":9,"message":"…","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"CONNECTION_IN_USE","domain":"nxis.ai","metadata":{"agents":"quote,booking"}}]}`.
 * A caller tells refusals apart by `reason`, which stays the same when the message's words change.
 */
export interface ErrorInfo {
  /** UPPER_SNAKE_CASE, stable: `CONNECTION_IN_USE`, `SITE_NOT_VERIFIED` … */
  reason: string;
  /** Who defines the reason: `nxis.ai` for NxisAI's services. */
  domain: string;
  /** Names and ids that go with the reason. Never a secret. */
  metadata: Record<string, string>;
}

/** The domain of NxisAI's own reasons. */
export const ERROR_DOMAIN = "nxis.ai";

/** A reason as the services write them; anything else in the field is ignored. */
const REASON = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * The first `google.rpc.ErrorInfo` in an error body's `details`.
 *
 * @returns The reason, domain and metadata, or undefined when the body has none (an older
 * service, or one that does not send reasons).
 */
export function errorInfoOf(body: string): ErrorInfo | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const details = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>)["details"] : undefined;
  if (!Array.isArray(details)) return undefined;
  for (const d of details) {
    if (!d || typeof d !== "object") continue;
    const entry = d as Record<string, unknown>;
    const type = entry["@type"];
    if (typeof type !== "string" || !type.endsWith("/google.rpc.ErrorInfo")) continue;
    const reason = entry["reason"];
    if (typeof reason !== "string" || !REASON.test(reason)) continue;
    const domain = typeof entry["domain"] === "string" ? plainText(entry["domain"]) : "";
    const raw = entry["metadata"];
    const metadata: Record<string, string> = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === "string") metadata[plainText(k)] = plainText(v);
      }
    }
    return { reason, domain, metadata };
  }
  return undefined;
}

/** Options for {@link request}. */
export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  token?: string;
  timeoutMs?: number;
  /** Treated as success and returned as null rather than throwing. */
  allow404?: boolean;
}

/**
 * Pulls the service's own message out of an error response.
 *
 * @remarks
 * An error body is either `{"code":7,"message":"…"}` or `{"error":{"message":"…"}}`, depending
 * on the failure. Surfacing the service's message matters: "not an owner of this organization"
 * is actionable in a way that "request failed" is not. A non-JSON body is used as-is when short.
 *
 * @param status - The HTTP status.
 * @param body - The raw response body.
 * @returns A human-readable message.
 */
function extractMessage(status: number, body: string): string {
  return plainText(rawMessage(status, body));
}

/**
 * The gRPC status code in an error body, as the HTTP transcoder sends it (`{"code":9,…}`).
 *
 * @remarks
 * Several codes share one HTTP status (INVALID_ARGUMENT and FAILED_PRECONDITION are both 400), so
 * a caller that has to tell them apart reads this.
 */
function rpcCode(body: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    const code = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>)["code"] : undefined;
    return typeof code === "number" && Number.isInteger(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/** The message as the service sent it, before {@link plainText}. */
function rawMessage(status: number, body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj["message"] === "string") return obj["message"];
      const err = obj["error"];
      if (err && typeof err === "object") {
        const msg = (err as Record<string, unknown>)["message"];
        if (typeof msg === "string") return msg;
      }
    }
  } catch {
    return fallbackMessage(status, body);
  }
  return fallbackMessage(status, body);
}

/** @returns The trimmed body when it is short and non-empty, otherwise `HTTP <status>`. */
function fallbackMessage(status: number, body: string): string {
  const trimmed = body.trim();
  return trimmed.length > 0 && trimmed.length < 500 ? trimmed : `HTTP ${status}`;
}

/**
 * Calls a JSON endpoint and maps failures onto the exit-code contract.
 *
 * @param url - The full URL.
 * @param opts - Method, body, bearer token, timeout and 404 handling.
 * @returns The parsed body, or null for an empty body or an allowed 404.
 * @throws CliError `signed_out` or `forbidden` (exit 3) for 401 and 403; `timeout`, `network`,
 * `request_failed` or `bad_response` (exit 1) otherwise.
 */
export async function request<T>(url: string, opts: RequestOptions = {}): Promise<T | null> {
  const { method = "GET", body, token, timeoutMs = 30_000, allow404 = false } = opts;

  const headers: Record<string, string> = {
    ...(token ? { authorization: `bearer ${token}` } : {}),
    ...(body !== undefined ? { "content-type": "application/json" } : {}),
  };

  // A dry run still reads, so a command can get far enough to show the write it would make.
  // Only the write itself is withheld.
  const changesSomething = method !== "GET";
  if (isDryRun() && changesSomething) {
    traceRequest({ method, url, headers, body }, "would send");
    throw new CliError(`Dry run: would ${method} ${url}. Nothing was sent.`, {
      exitCode: ExitCode.OK,
      reason: "dry_run",
      // Redacted as the trace is: the result is printed, and a dry run must not print a secret it would have sent.
      details: { dry_run: true, method, url, ...(body !== undefined ? { body: redactBody(body) } : {}) },
    });
  }

  traceRequest({ method, url, headers, body });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    const reason = controller.signal.aborted ? "timeout" : "network";
    const detail = controller.signal.aborted
      ? `Timed out after ${Math.round(timeoutMs / 1000)}s calling ${url}`
      : `Could not reach ${url}: ${(err as Error).message}`;
    throw failed(detail, reason, { url });
  } finally {
    clearTimeout(timer);
  }

  traceResponse(res.status, url);

  if (res.status === 404 && allow404) return null;

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const message = extractMessage(res.status, text);
    if (res.status === 401) {
      throw notAuthorized(`${message} — run \`nxis login\``, "signed_out", { status: 401 });
    }
    if (res.status === 403) {
      throw notAuthorized(message, "forbidden", { status: 403 });
    }
    const code = rpcCode(text);
    const info = errorInfoOf(text);
    throw failed(message, "request_failed", {
      status: res.status,
      url,
      ...(code !== undefined ? { rpc_code: code } : {}),
      ...(info ? { error_info: info } : {}),
    });
  }

  const text = await res.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw failed(`Expected JSON from ${url} but got something else`, "bad_response", { url });
  }
}

/** Options for {@link pollUntil}. */
export interface PollOptions<T> {
  /** One attempt. Return a value to stop, or null to keep waiting. */
  attempt: () => Promise<T | null>;
  timeoutMs: number;
  /** Called on each tick so a waiting terminal doesn't look hung. */
  onTick?: (elapsedMs: number) => void;
  signal?: AbortSignal;
}

/**
 * Poll with backoff until something shows up or the clock runs out.
 *
 * @remarks
 * The interval grows from 2s to 10s: quick enough that a fast payment feels immediate,
 * slow enough that a fifteen-minute wait isn't four hundred requests. A timeout here is
 * never a failure — the webhook may still land — so callers map it to exit 2.
 */
export async function pollUntil<T>(opts: PollOptions<T>): Promise<T | null> {
  const { attempt, timeoutMs, onTick, signal } = opts;
  const started = Date.now();
  let intervalMs = 2_000;

  for (;;) {
    if (signal?.aborted) return null;

    const found = await attempt();
    if (found !== null) return found;

    const elapsed = Date.now() - started;
    if (elapsed >= timeoutMs) return null;

    onTick?.(elapsed);
    const wait = Math.min(intervalMs, timeoutMs - elapsed);
    await new Promise((resolve) => setTimeout(resolve, wait));
    intervalMs = Math.min(intervalMs * 1.25, 10_000);
  }
}

/** @returns True when the error is a {@link CliError}. */
export function isCliError(err: unknown): err is CliError {
  return err instanceof CliError;
}

export { ExitCode };
