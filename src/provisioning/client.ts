/**
 * A small MCP client for the NxisAI endpoints the CLI calls itself.
 *
 * @remarks
 * The provisioning tools are served over MCP (Streamable HTTP), not REST, so the CLI speaks the
 * protocol with the SDK's own client rather than imitating it with `request()`. What this module
 * adds on top is what every other call in the CLI already has: failures mapped onto the exit-code
 * contract, `--verbose` showing each JSON-RPC message with its credentials removed, and
 * `--dry-run` withholding anything that could change something.
 *
 * Nothing here knows which endpoint it talks to. The URL and the key are parameters
 * ({@link McpEndpoint}), so the same client serves the organization's provisioning endpoint
 * (`./endpoint.ts`) and, later, a site's own MCP endpoint, which carries the read tools.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { isLoopback } from "../config.js";
import { CliError, ExitCode, failed, notAuthorized } from "../errors.js";
import { packageVersion } from "../self.js";
import { plainText } from "../output.js";
import { isDryRun, redactBody, traceRequest, traceResponse } from "../trace.js";

/** The header that carries the API key, as `nxis mcp install` writes it into an agent's config. */
export const API_KEY_HEADER = "nxis-api-key";

/** How long one call may take before it is reported as a timeout. The SDK's own default. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Where an endpoint's API key comes from, and what to do when the endpoint refuses it.
 *
 * @remarks
 * A refused key is the expected way for a stored key to end: revoked from another machine, or
 * rotated. So the client asks for a new one once, and only reports a failure when the new one is
 * refused too. A source without `renew` makes the first refusal final.
 */
export interface KeySource {
  /** The key to send. May mint one on first use. */
  get(): Promise<string>;
  /** The key was refused: forget it and return a new one. Called at most once per call. */
  renew?(): Promise<string>;
  /** A renewed key was refused as well: forget it, so the next invocation starts clean. */
  discard?(): void | Promise<void>;
}

/** One MCP endpoint, and how to authenticate to it. */
export interface McpEndpoint {
  /** The Streamable HTTP URL. */
  url: string;
  /** Named in error messages, e.g. "the provisioning endpoint". */
  label: string;
  /** The API key, or null for an endpoint that needs none. */
  keys: KeySource | null;
  /**
   * What a 401 or 403 means for this endpoint, in place of `key_refused` and `forbidden`.
   *
   * @remarks
   * For an endpoint called without a key, where those would send the user to sign in again for a
   * key that was never sent.
   */
  refused?: (status: 401 | 403) => CliError;
}

/** A tool as the endpoint lists it. */
export type RemoteTool = Tool;

/** The outcome of a successful tool call. */
export interface ToolOutcome {
  /** The tool's text content, joined with newlines. */
  text: string;
  /**
   * The result as data: `structuredContent` when the tool sent it, else the text parsed as JSON
   * when it is JSON, else null. Most provisioning tools answer with a JSON object as text.
   */
  data: unknown;
  /** The result exactly as the endpoint sent it. */
  raw: CallToolResult;
}

/** Options for {@link McpClient.callTool}. */
export interface CallOptions {
  /**
   * The tool only reads, so it is still called under `--dry-run`.
   *
   * @remarks
   * Every other call is withheld under `--dry-run`, because whether a tool changes something is
   * the tool's business and the safe default is to assume it does. A command that reads first and
   * writes second (plan, then submit) marks the read, so a dry run gets as far as the write.
   */
  readOnly?: boolean;
  /** Milliseconds before the call is reported as a timeout. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** The function the transport uses to send HTTP requests. */
type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** @returns The headers as a plain object. */
function headerRecord(headers: RequestInit["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(headers).forEach((value, name) => {
    out[name] = value;
  });
  return out;
}

/**
 * Wraps fetch so `--verbose` shows every message the transport sends.
 *
 * @remarks
 * At the HTTP layer rather than on the client, so what is printed is what went over the wire:
 * the JSON-RPC body, the session header and the key header (redacted by `traceRequest`).
 */
function tracingFetch(inner: FetchLike): FetchLike {
  return async (url, init) => {
    const target = String(url);
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    traceRequest({ method: init?.method ?? "GET", url: target, headers: headerRecord(init?.headers), body });
    const res = await inner(url, init);
    traceResponse(res.status, target);
    return res;
  };
}

/** @returns True when the error means the endpoint refused the credentials. */
function isUnauthorized(err: unknown): boolean {
  return (err instanceof StreamableHTTPError && err.code === 401) || err instanceof UnauthorizedError;
}

/** @returns The server's message from a transport error, without the SDK's prefix. */
function transportMessage(err: StreamableHTTPError): string {
  const text = err.message.replace(/^Streamable HTTP error:\s*/, "").replace(/^Error POSTing to endpoint:\s*/, "");
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const inner = obj["error"];
      if (typeof obj["message"] === "string") return plainText(obj["message"]);
      if (inner && typeof inner === "object" && typeof (inner as Record<string, unknown>)["message"] === "string") {
        return plainText((inner as Record<string, unknown>)["message"] as string);
      }
      if (typeof inner === "string") return plainText(inner);
    }
  } catch {
    // Not JSON: use the text as it is.
  }
  const plain = plainText(text);
  return plain.length > 0 && plain.length < 500 ? plain : `HTTP ${err.code}`;
}

/** @returns The text content of a tool result, joined with newlines. */
function resultText(result: CallToolResult): string {
  return (result.content ?? [])
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/** @returns The text parsed as JSON, or null when it is not JSON. */
function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

/**
 * The failure for a tool result marked `isError`.
 *
 * @remarks
 * The tool's own words are the message, because they are what says how to fix it ("the site is
 * not verified yet"). When the text is a JSON object, its `message` or `error` is used and the
 * whole object is kept under `tool_error`, so `--json` gives an agent everything the tool said.
 */
export function toolFailure(name: string, result: CallToolResult): CliError {
  const text = resultText(result);
  const parsed = parseJson(text);
  const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  const said = obj
    ? typeof obj["message"] === "string"
      ? obj["message"]
      : typeof obj["error"] === "string"
        ? obj["error"]
        : text
    : text;
  const message = plainText(said) || `${name} failed without saying why.`;
  return failed(message, "tool_error", { tool: name, ...(obj ? { tool_error: obj } : {}) });
}

/**
 * A connection to one MCP endpoint.
 *
 * @remarks
 * Connects on first use, so a dry run that withholds its only call never contacts the endpoint
 * or mints a key. Close it when done; {@link withMcpClient} does that for you.
 */
export class McpClient {
  readonly endpoint: McpEndpoint;
  private readonly fetchImpl: FetchLike;
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;

  /**
   * @param endpoint - Where to connect, and the key to send.
   * @param opts - `fetch` replaces the global fetch, for tests.
   * @throws CliError `insecure_mcp_url` when a key would go over plain http to another machine.
   */
  constructor(endpoint: McpEndpoint, opts: { fetch?: FetchLike } = {}) {
    let parsed: URL;
    try {
      parsed = new URL(endpoint.url);
    } catch {
      throw failed(`${endpoint.label} has no valid URL (got "${endpoint.url}").`, "invalid_mcp_url", { url: endpoint.url });
    }
    if (endpoint.keys && parsed.protocol !== "https:" && !isLoopback(parsed.hostname)) {
      throw failed(
        `Refusing to send an API key to ${endpoint.url} over plain http. Use https.`,
        "insecure_mcp_url",
        { url: endpoint.url },
      );
    }
    this.endpoint = endpoint;
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
  }

  /**
   * Connects and initializes, if not already connected.
   *
   * @throws CliError as {@link McpClient.callTool} does.
   */
  async connect(): Promise<void> {
    await this.authorized(async () => undefined);
  }

  /**
   * Lists every tool the endpoint serves, following pagination.
   *
   * @throws CliError as {@link McpClient.callTool} does.
   */
  async listTools(opts: { timeoutMs?: number } = {}): Promise<RemoteTool[]> {
    return this.authorized(async (client) => {
      const tools: RemoteTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, {
          timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      return tools;
    });
  }

  /**
   * Calls one tool.
   *
   * @param name - The tool's name, e.g. `nxis_verify_site`.
   * @param args - Its arguments. Use `withSite` to fill in the current site.
   * @param opts - Whether the tool only reads, and a timeout.
   * @returns The tool's result.
   * @throws CliError `dry_run` (exit 0) under `--dry-run` unless `readOnly`; `tool_error` (exit 1)
   * when the tool reports a failure; `key_refused` or `forbidden` (exit 3) for 401 and 403, or
   * what the endpoint's `refused` says instead;
   * `signed_out` (exit 3) when a new key is needed and nobody is signed in; `network`, `timeout`,
   * `endpoint_not_found`, `mcp_error` or `request_failed` (exit 1) otherwise.
   */
  async callTool(name: string, args: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<ToolOutcome> {
    if (isDryRun() && !opts.readOnly) {
      const body = { jsonrpc: "2.0", method: "tools/call", params: { name, arguments: args } };
      traceRequest(
        {
          method: "POST",
          url: this.endpoint.url,
          headers: this.endpoint.keys ? { [API_KEY_HEADER]: "<redacted>" } : {},
          body,
        },
        "would send",
      );
      throw new CliError(`Dry run: would call ${name} on ${this.endpoint.url}. Nothing was sent.`, {
        exitCode: ExitCode.OK,
        reason: "dry_run",
        details: { dry_run: true, url: this.endpoint.url, tool: name, arguments: redactBody(args) },
      });
    }

    const raw = await this.authorized(
      async (client) =>
        (await client.callTool({ name, arguments: args }, undefined, {
          timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        })) as CallToolResult,
    );
    if (raw.isError) throw toolFailure(name, raw);

    const text = resultText(raw);
    const data = raw.structuredContent ?? parseJson(text);
    return { text, data, raw };
  }

  /** Ends the session and closes the connection. Never throws. */
  async close(): Promise<void> {
    const { client, transport } = this;
    this.client = null;
    this.transport = null;
    await transport?.terminateSession().catch(() => undefined);
    await client?.close().catch(() => undefined);
  }

  /**
   * Runs one operation, renewing the key once if the endpoint refuses it.
   *
   * @remarks
   * Retrying is safe for every call, writes included: a 401 is the endpoint refusing the request
   * before running it. Once only, so a key the endpoint will never accept cannot loop.
   */
  private async authorized<T>(op: (client: Client) => Promise<T>): Promise<T> {
    try {
      return await op(await this.connected());
    } catch (err) {
      const keys = this.endpoint.keys;
      if (!isUnauthorized(err)) throw this.mapError(err);
      await this.close();
      if (this.endpoint.refused) throw this.endpoint.refused(401);
      if (!keys?.renew) {
        throw notAuthorized(
          `${this.endpoint.label} refused the API key. It may have been revoked; run \`nxis login\`, then try again.`,
          "key_refused",
          { status: 401, url: this.endpoint.url },
        );
      }
      await keys.renew();
      try {
        return await op(await this.connected());
      } catch (again) {
        if (!isUnauthorized(again)) throw this.mapError(again);
        await this.close();
        await keys.discard?.();
        throw notAuthorized(
          `${this.endpoint.label} refused a newly issued API key too. Run \`nxis login\` and try again; ` +
            "the next call issues another key.",
          "key_refused",
          { status: 401, url: this.endpoint.url },
        );
      }
    }
  }

  /** @returns The connected SDK client, connecting first if needed. */
  private async connected(): Promise<Client> {
    if (this.client) return this.client;

    const headers: Record<string, string> = {};
    if (this.endpoint.keys) headers[API_KEY_HEADER] = await this.endpoint.keys.get();

    const transport = new StreamableHTTPClientTransport(new URL(this.endpoint.url), {
      requestInit: { headers },
      fetch: tracingFetch(this.fetchImpl),
    });
    const client = new Client({ name: "nxis-cli", version: packageVersion() });
    try {
      await client.connect(transport, { timeout: DEFAULT_TIMEOUT_MS });
    } catch (err) {
      await client.close().catch(() => undefined);
      throw err;
    }
    this.client = client;
    this.transport = transport;
    return client;
  }

  /** Maps a failure that is not a refused key onto the exit-code contract. */
  private mapError(err: unknown): CliError {
    if (err instanceof CliError) return err;
    const { url, label } = this.endpoint;

    if (err instanceof StreamableHTTPError) {
      // Without its full stop, so it reads as one sentence inside ours.
      const message = transportMessage(err).replace(/[.\s]+$/, "");
      if (err.code === 403) {
        if (this.endpoint.refused) return this.endpoint.refused(403);
        return notAuthorized(
          `${label} refused this request: ${message}. Check --org, and that you own the organization.`,
          "forbidden",
          { status: 403, url },
        );
      }
      if (err.code === 404) {
        return failed(
          `${label} was not found at ${url}. Check NXIS_MCP_URL or --api.`,
          "endpoint_not_found",
          { status: 404, url },
        );
      }
      return failed(`${label} failed: ${message}`, "request_failed", { status: err.code, url });
    }

    if (err instanceof McpError) {
      if (err.code === ErrorCode.RequestTimeout) {
        return failed(`Timed out waiting for ${label} at ${url}.`, "timeout", { url });
      }
      return failed(plainText(err.message.replace(/^MCP error -?\d+:\s*/, "")), "mcp_error", { code: err.code, url });
    }

    const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
    if (err instanceof TypeError || cause?.code) {
      return failed(`Could not reach ${label} at ${url}: ${cause?.message ?? (err as Error).message}`, "network", { url });
    }
    return failed(plainText((err as Error)?.message ?? String(err)), "error", { url });
  }
}

/**
 * Runs `fn` with a client for the endpoint, and closes it afterwards.
 *
 * @param endpoint - Where to connect.
 * @param fn - What to do with the client.
 * @returns What `fn` returns.
 */
export async function withMcpClient<T>(endpoint: McpEndpoint, fn: (client: McpClient) => Promise<T>): Promise<T> {
  const client = new McpClient(endpoint);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}
