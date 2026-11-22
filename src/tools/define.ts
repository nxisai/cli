/**
 * What a tool definition is, and the one function that runs any of them.
 *
 * @remarks
 * Each NxisAI tool the CLI uses is defined once, here in `src/tools/`, and used twice: by the CLI
 * commands, and by `nxis mcp serve`, which registers the same definitions on a local MCP server.
 * Defining them once is what keeps the two from drifting apart, and the recorded `tools/list`
 * fixture keeps both from drifting away from the server.
 *
 * This module imports zod and nothing from the MCP SDK. The SDK is loaded the first time a tool
 * actually runs, so a command that only imports the registry (to print help, say) does not pay for
 * it, and neither do `nxis status` or `nxis login`.
 */

import { z } from "zod";
import type { Ctx } from "../context.js";
import { withSite } from "../context.js";
import { failed } from "../errors.js";
import type { CallOptions, McpClient, ToolOutcome } from "../provisioning/client.js";

/**
 * Which endpoint serves a tool.
 *
 * @remarks
 * `provisioning` is the organization's endpoint, authenticated with the CLI's provisioning key.
 * `site` is the site's own MCP endpoint, which takes its tenant from its hostname; the CLI calls it
 * without a key, so the site's MCP server has to be public. `local` is a tool the CLI itself
 * implements over the NxisAI HTTP APIs, with the CLI's sign-in: it has no remote counterpart, so
 * `nxis mcp serve` is the only server that lists it.
 */
export type Surface = "provisioning" | "site" | "local";

/** Anything that can call a tool: an {@link McpClient}, or a stand-in in tests. */
export type ToolCaller = Pick<McpClient, "callTool">;

/** A tool's input schema: always a zod object, so `McpServer.registerTool` takes it as it is. */
export type InputSchema = z.ZodObject;

/** The outcome of a tool call, with `data` typed as the tool's result. */
export interface ToolResult<Out> extends Omit<ToolOutcome, "data"> {
  /**
   * The tool's structured result.
   *
   * @remarks
   * Typed from what the server sends, not checked at run time: the server owns its output, and a
   * field it adds should reach `--json` rather than fail the call. Treat every field as possibly
   * absent; the server drops the ones it has no value for.
   */
  data: Out;
}

/** Options for {@link ToolDef.run}. */
export interface RunOptions {
  /**
   * An open connection to the provisioning endpoint, to reuse.
   *
   * @remarks
   * Without one, `run` opens a connection for the one call and closes it. A command that makes
   * several calls (create a site, then name it) or a server that proxies many should pass one.
   */
  provisioning?: ToolCaller;
  /** An open connection to the site's endpoint, to reuse. Site tools only. */
  site?: ToolCaller;
  /**
   * The site's MCP URL. Site tools only.
   *
   * @remarks
   * Skips resolving it, which costs a call to the provisioning endpoint. See `siteMcpUrl` for the
   * order the URL is otherwise looked up in.
   */
  siteUrl?: string;
  /** Milliseconds before the call is reported as a timeout. */
  timeoutMs?: number;
}

/**
 * One tool, as the CLI and `nxis mcp serve` both see it.
 *
 * @typeParam I - The input schema.
 * @typeParam Out - The shape of the tool's structured result.
 */
export interface ToolDef<I extends InputSchema = InputSchema, Out = unknown> {
  /** The tool's name on the server, e.g. `nxis_verify_site`. */
  readonly name: string;
  /** The server's own description of the tool, word for word. */
  readonly description: string;
  /**
   * The server's input schema, as zod.
   *
   * @remarks
   * Strict: an argument the server does not define is refused here with `invalid_input`, rather
   * than silently dropped by the server. Pass it straight to `McpServer.registerTool` as
   * `inputSchema`; the SDK accepts a zod object as well as a raw shape.
   */
  readonly input: I;
  /** Which endpoint serves it. */
  readonly surface: Surface;
  /**
   * The tool takes a `site` argument, which `run` fills from `--site` or the saved site.
   *
   * @remarks
   * Only on the provisioning surface. A site endpoint refuses `site`, because its hostname
   * already names the site.
   */
  readonly takesSite: boolean;
  /**
   * Whether a call only reads: `true`, `false`, or decided by the input (a tool with a `plan` or
   * `status` mode beside a write). Use {@link isReadOnly} to evaluate it.
   *
   * @remarks
   * A read-only call still goes through under `--dry-run`, so a command can show the plan for a
   * write it withholds. `nxis mcp serve` lists `readOnly === true` as `readOnlyHint`: see {@link annotationsOf}.
   */
  readonly readOnly: boolean | ((input: z.output<I>) => boolean);
  /** What a call may do beyond reading, for the MCP annotations `nxis mcp serve` lists. */
  readonly hints: ToolHints;
  /**
   * Validates the input, fills in the site, and calls the tool on its endpoint.
   *
   * @param ctx - The command context: organization, site, output and flags.
   * @param input - The tool's arguments. `site` may be left out, and may be a domain.
   * @param opts - Connections to reuse, the site's URL, a timeout.
   * @returns The tool's result.
   * @throws CliError `invalid_input` (exit 1) for arguments the schema refuses, naming the field;
   * `no_active_site` (exit 2) when a site is needed and none is selected; `site_not_found` (exit 2)
   * for a domain no site in the organization has; `dry_run` (exit 0) for a write under
   * `--dry-run`; and whatever {@link McpClient.callTool} throws.
   */
  run(ctx: Ctx, input: z.input<I>, opts?: RunOptions): Promise<ToolResult<Out>>;
}

/**
 * What a tool may do, as the MCP tool annotations describe it.
 *
 * @remarks
 * Hints for the agent, not guarantees; the server enforces nothing with them. `destructive` and
 * `idempotent` describe the tool's writes, so they are left out for a tool that only reads:
 *
 * - `destructive`: a write may replace, remove, expose or spend something, rather than only add.
 * - `idempotent`: the same call again, with the same arguments, changes nothing more.
 * - `openWorld`: a call reaches beyond NxisAI, such as fetching the live site or posting to a
 *   webhook.
 */
export interface ToolHints {
  destructive?: boolean;
  idempotent?: boolean;
  openWorld: boolean;
}

/** A tool's MCP annotations, in the protocol's names. */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint: boolean;
}

/**
 * @returns The tool's MCP annotations.
 *
 * @remarks
 * `readOnlyHint` is true only for a tool that never writes. One whose mode decides between reading
 * and writing (a `plan` beside a `submit`) is not read-only, and carries the hints of its writes.
 */
export function annotationsOf(tool: Pick<ToolDef, "readOnly" | "hints">): ToolAnnotations {
  if (tool.readOnly === true) return { readOnlyHint: true, openWorldHint: tool.hints.openWorld };
  return {
    readOnlyHint: false,
    destructiveHint: tool.hints.destructive ?? true,
    idempotentHint: tool.hints.idempotent ?? false,
    openWorldHint: tool.hints.openWorld,
  };
}

/** @returns Whether this call of the tool only reads. */
export function isReadOnly<I extends InputSchema>(tool: ToolDef<I, unknown>, input: z.output<I>): boolean {
  return typeof tool.readOnly === "function" ? tool.readOnly(input) : tool.readOnly;
}

/**
 * Validates tool arguments against a schema.
 *
 * @remarks
 * Done before anything is sent, so a typo in a command (or an agent's call through
 * `nxis mcp serve`) fails here with the field named, rather than as the server's error after a
 * round trip, or not at all when the server ignores an argument it does not know.
 *
 * @throws CliError `invalid_input` (exit 1), with `tool`, `field` and every `issues` entry.
 */
export function parseInput<I extends InputSchema>(name: string, schema: I, input: unknown): z.output<I> {
  const parsed = schema.safeParse(input ?? {});
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) => ({
    field: fieldOf(issue),
    message: issue.message,
  }));
  const first = issues[0];
  const where = first?.field ? `\`${first.field}\`: ` : "";
  return failInvalid(name, `${where}${first?.message ?? "invalid input"}`, first?.field ?? null, issues);
}

/** @returns The dotted path of the argument an issue is about, including an unknown key's name. */
function fieldOf(issue: z.core.$ZodIssue): string {
  const path = issue.path.map(String);
  if (issue.code === "unrecognized_keys" && issue.keys.length > 0) path.push(issue.keys[0] as string);
  return path.join(".");
}

function failInvalid(
  name: string,
  message: string,
  field: string | null,
  issues: Array<{ field: string; message: string }>,
): never {
  throw failed(`Invalid input for ${name}: ${message}.`, "invalid_input", { tool: name, field, issues });
}

/** What {@link defineTool} needs beyond the definition itself. */
interface ToolSpec<I extends InputSchema> {
  name: string;
  description: string;
  input: I;
  surface: Surface;
  takesSite?: boolean;
  readOnly: boolean | ((input: z.output<I>) => boolean);
  hints: ToolHints;
}

/**
 * Builds a tool definition whose `run` validates, fills in the site, and calls the right endpoint.
 *
 * @typeParam Out - The tool's result, as the server sends it.
 */
export function defineTool<Out>() {
  return <I extends InputSchema>(spec: ToolSpec<I>): ToolDef<I, Out> => {
    const tool: ToolDef<I, Out> = {
      name: spec.name,
      description: spec.description,
      input: spec.input,
      surface: spec.surface,
      takesSite: spec.takesSite ?? false,
      readOnly: spec.readOnly,
      hints: spec.hints,
      async run(ctx, input, opts = {}) {
        const args = parseInput(spec.name, spec.input, input);
        const call: CallOptions = { readOnly: isReadOnly(tool, args) };
        if (opts.timeoutMs !== undefined) call.timeoutMs = opts.timeoutMs;
        const outcome =
          spec.surface === "site"
            ? await callOnSite(ctx, spec.name, args, call, opts)
            : await callOnProvisioning(ctx, spec.name, args, call, opts, tool.takesSite);
        return outcome as ToolResult<Out>;
      },
    };
    return tool;
  };
}

/** Calls a provisioning tool, with the site filled in and resolved to an id. */
async function callOnProvisioning(
  ctx: Ctx,
  name: string,
  args: Record<string, unknown>,
  call: CallOptions,
  opts: RunOptions,
  takesSite: boolean,
): Promise<ToolOutcome> {
  const { openProvisioning } = await import("../provisioning/endpoint.js");
  const own = opts.provisioning ? null : openProvisioning(ctx);
  const client: ToolCaller = opts.provisioning ?? (own as McpClient);
  try {
    let sent = args;
    if (takesSite) {
      const { resolveSiteId } = await import("./sites.js");
      const filled = withSite(ctx, args, { required: true });
      sent = { ...filled, site: await resolveSiteId(ctx, filled.site as string, client) };
    }
    return await client.callTool(name, sent, call);
  } finally {
    await own?.close();
  }
}

/** Calls a tool on the site's own endpoint, which takes no `site` argument and no key. */
async function callOnSite(
  ctx: Ctx,
  name: string,
  args: Record<string, unknown>,
  call: CallOptions,
  opts: RunOptions,
): Promise<ToolOutcome> {
  if (opts.site) return opts.site.callTool(name, args, call);
  const [{ McpClient }, { siteEndpoint }, { siteMcpUrl }] = await Promise.all([
    import("../provisioning/client.js"),
    import("../provisioning/endpoint.js"),
    import("./sites.js"),
  ]);
  const url = opts.siteUrl ?? (await siteMcpUrl(ctx, opts.provisioning ? { provisioning: opts.provisioning } : {}));
  const client = new McpClient(siteEndpoint(url));
  try {
    return await client.callTool(name, args, call);
  } finally {
    await client.close();
  }
}

/** What {@link defineLocalTool} needs: a definition, and the CLI code that answers it. */
interface LocalToolSpec<I extends InputSchema, Out> extends Omit<ToolSpec<I>, "surface"> {
  /** Answers a call, with arguments already validated. */
  call(ctx: Ctx, args: z.output<I>): Promise<Out>;
}

/**
 * Builds a tool the CLI answers itself (surface `local`).
 *
 * @remarks
 * Its result is a JSON object, sent as both the text and the structured content, as the remote
 * tools send theirs. Writes go through the HTTP layer, so `--dry-run` withholds them there.
 *
 * @typeParam Out - The tool's result.
 */
export function defineLocalTool<Out extends Record<string, unknown>>() {
  return <I extends InputSchema>(spec: LocalToolSpec<I, Out>): ToolDef<I, Out> => ({
    name: spec.name,
    description: spec.description,
    input: spec.input,
    surface: "local",
    takesSite: spec.takesSite ?? false,
    readOnly: spec.readOnly,
    hints: spec.hints,
    async run(ctx, input) {
      const args = parseInput(spec.name, spec.input, input);
      const data = await spec.call(ctx, args);
      const text = JSON.stringify(data);
      return { data, text, raw: { content: [{ type: "text", text }], structuredContent: data } };
    },
  });
}
