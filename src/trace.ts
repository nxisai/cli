/**
 * Showing what the CLI sends.
 *
 * @remarks
 * This exists because the source being readable is only half an answer. Someone deciding whether
 * to hand this tool their credentials should be able to watch one request rather than read the
 * whole repository, so `--verbose` prints every request as it is made and `--dry-run` stops
 * before any of them changes anything.
 *
 * Two rules hold throughout. Nothing that could authenticate anyone is ever printed, whatever
 * `--verbose` is set to. And the trace goes to stderr, because stdout carries the `--json`
 * object and an agent parsing it must not receive this as well.
 */

/** Header names whose values are never printed. */
const SECRET_HEADERS = new Set(["authorization", "cookie", "set-cookie", "nxis-api-key", "x-api-key"]);

/**
 * Body and form fields whose values are never printed.
 *
 * @remarks
 * The auth endpoints carry most of these: a refresh token or a device code is a credential in
 * its own right, and a PKCE verifier is one for the length of the exchange.
 */
const SECRET_FIELDS = new Set([
  "access_token",
  "api_key",
  "apiKey",
  "auth_token",
  "client_secret",
  "code_verifier",
  "device_code",
  "id_token",
  "key",
  "password",
  "raw_key",
  "refresh_token",
  "secret",
  "signing_secret",
]);

/** How the CLI traces requests for this invocation. */
interface TraceSettings {
  /** Print every request before it is sent. */
  verbose: boolean;
  /** Print what would be sent, and send nothing that changes anything. */
  dryRun: boolean;
}

let settings: TraceSettings = { verbose: false, dryRun: false };

/** Sets tracing for this invocation. Called once, from the command line. */
export function setTrace(next: Partial<TraceSettings>): void {
  settings = { ...settings, ...next };
  // Seeing nothing while nothing happens would be a strange way to dry run.
  if (settings.dryRun) settings.verbose = true;
}

/** @returns True when requests that change something must not be sent. */
export function isDryRun(): boolean {
  return settings.dryRun;
}

/** @returns True when requests are being printed. */
export function isVerbose(): boolean {
  return settings.verbose;
}

/** @returns The headers with every secret value replaced. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = SECRET_HEADERS.has(name.toLowerCase()) ? redactedLike(value) : value;
  }
  return out;
}

/**
 * @returns The value with every secret field replaced, at any depth.
 *
 * @remarks
 * Structure is preserved so the shape of a request stays legible — the point is to show what is
 * sent, not to withhold it. Only values that could be replayed are removed.
 */
export function redactBody(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactBody);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_FIELDS.has(key) ? "<redacted>" : redactBody(inner);
    }
    return out;
  }
  return value;
}

/**
 * @returns A placeholder that keeps the shape of a credential without its content.
 *
 * @remarks
 * `bearer <redacted>` rather than `<redacted>` alone, so a reader can still tell a bearer token
 * from an API key without seeing either.
 */
function redactedLike(value: string): string {
  const scheme = /^(bearer|basic)\s/i.exec(value);
  return scheme ? `${scheme[1]} <redacted>` : "<redacted>";
}

/** One traced request. */
export interface TracedRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** A form body, for the auth endpoints. */
  form?: Record<string, string>;
}

/**
 * Prints a request to stderr, secrets removed.
 *
 * @param req - What is about to be sent.
 * @param note - Shown in place of the arrow when the request will not be sent.
 */
export function traceRequest(req: TracedRequest, note?: string): void {
  if (!settings.verbose) return;

  const lines: string[] = [`${note ?? "→"} ${req.method} ${req.url}`];

  for (const [name, value] of Object.entries(redactHeaders(req.headers ?? {}))) {
    lines.push(`    ${name}: ${value}`);
  }

  const body = req.form ? redactBody(req.form) : req.body !== undefined ? redactBody(req.body) : undefined;
  if (body !== undefined) {
    lines.push(`    ${JSON.stringify(body)}`);
  }

  process.stderr.write(`${lines.join("\n")}\n`);
}

/** Prints a response status to stderr. */
export function traceResponse(status: number, url: string): void {
  if (!settings.verbose) return;
  process.stderr.write(`← ${status} ${url}\n`);
}

/**
 * Prints a note about what the CLI did between requests to stderr, under `--verbose`.
 *
 * @remarks
 * For a step whose outcome a reader of the trace would otherwise have to infer, such as a refused
 * key being revoked before another is minted. Never pass it a secret.
 */
export function traceNote(line: string): void {
  if (!settings.verbose) return;
  process.stderr.write(`· ${line}\n`);
}
