/**
 * `nxis mcp install` — wire NxisAI's onboarding tools into the agent.
 *
 * @remarks
 * Two ways, under the same server name, `nxis-onboarding`:
 *
 * - **Local (`--stdio`, the default).** The agent's config gets a command, `nxis mcp serve`, and
 *   no key. The server it starts uses this CLI's sign-in and the provisioning key the CLI keeps in
 *   the keychain, so nothing secret is written anywhere, and nothing is minted at install time.
 * - **Remote (`--remote`).** A key is minted and written, with the endpoint's URL, into the
 *   agent's config. It is reported only as a preview: an agent running this sees `…Qx4`, which is
 *   enough to confirm it worked and useless to anyone reading the transcript later. `--print` is
 *   the explicit opt-out, for someone configuring a client by hand.
 *
 * A project `.mcp.json` is never committed, in either mode: whenever the install writes one, it
 * adds it to `.gitignore` unless git already ignores it, and refuses to put a key into one git
 * already tracks. Under `--dry-run` nothing is written; the output says what would be.
 */

import {
  checkProjectGit,
  detectAgent,
  installMcpServer,
  projectConfigTarget,
  reloadHint,
  renderManualConfig,
  renderStdioConfig,
  SERVER_NAME,
  type AgentId,
  type InstallResult,
} from "../agents.js";
import { generateApiKey, keyEnvFor, mcpServerUrl } from "../api/apikeys.js";
import type { Ctx } from "../context.js";
import { currentOrg, requireOrg, requireSession } from "../context.js";
import { loadCredentials } from "../credentials.js";
import { bool, str, type Flags } from "../args.js";
import { CliError, failed } from "../errors.js";
import { bold, dim } from "../output.js";
import { localServerEntry, type SelfLocation } from "../self.js";
import { isDryRun } from "../trace.js";

/** Arguments for `nxis mcp install`. */
export interface McpInstallArgs {
  agent?: string;
  force?: boolean;
  print?: boolean;
  /** Install the local server (the default). */
  stdio?: boolean;
  /** Install the remote endpoint with a key, as before the local server existed. */
  remote?: boolean;
  /**
   * Flags given explicitly on this command line (`--org`, `--site`, `--api`, `--read-only`,
   * `--allow-unconfirmed`), passed on to `nxis mcp serve`: see {@link serveFlagsFrom}. Saved
   * settings are not: the server reads them when it runs.
   */
  serveFlags?: string[];
  /** Where this CLI is running from, for tests. */
  self?: SelfLocation;
}

/**
 * @returns The flags of an `nxis mcp install` command line that the installed `nxis mcp serve`
 * command carries: `--org`, `--site` and `--api` with their values, and `--read-only` and
 * `--allow-unconfirmed`, only when given.
 */
export function serveFlagsFrom(flags: Flags): string[] {
  return [
    ...(["org", "site", "api"] as const).flatMap((name) => {
      const value = str(flags, name);
      return value ? [`--${name}`, value] : [];
    }),
    ...(["read-only", "allow-unconfirmed"] as const).filter((name) => bool(flags, name)).map((name) => `--${name}`),
  ];
}

/** Values accepted by `--agent`. */
const KNOWN_AGENTS: AgentId[] = ["claude-code", "cursor", "mcp-json"];

/**
 * Runs `nxis mcp install`.
 *
 * @throws CliError `conflicting_flags` for `--stdio` with `--remote`; `unknown_agent`;
 * `server_exists` without `--force`; and, for `--remote`, `mcp_json_tracked` (exit 2, before
 * minting) and whatever signing in and minting throw.
 */
export async function cmdMcpInstall(ctx: Ctx, args: McpInstallArgs): Promise<void> {
  if (args.stdio && args.remote) {
    throw failed("Pick one of --stdio (the local server) and --remote.", "conflicting_flags", {
      flags: ["--stdio", "--remote"],
    });
  }
  if (args.remote) return installRemote(ctx, args);
  return installStdio(ctx, args);
}

/**
 * Installs the local server: a command, no key.
 *
 * @remarks
 * Nothing is minted and nothing is sent. Signing in and choosing an organization can happen
 * before or after; the server reads both when it runs, so this only warns when they are missing.
 */
async function installStdio(ctx: Ctx, args: McpInstallArgs): Promise<void> {
  const { io } = ctx;
  const agent = resolveAgent(args.agent);
  const server = localServerEntry(args.serveFlags ?? [], args.self);
  const entry = { command: server.command, args: server.args };

  const warnings: string[] = [];
  if (!loadCredentials()) warnings.push("Not signed in: run `nxis login` before your agent uses the tools.");
  if (!currentOrg(ctx)) {
    warnings.push("No organization selected: run `nxis orgs use <id>` (or `nxis orgs create`) first.");
  }

  const common = { ok: true, server: SERVER_NAME, mode: "stdio", command: entry.command, args: entry.args, source: server.source };

  if (args.print) {
    io.emit({ ...common, config: renderStdioConfig(entry) }, () => renderStdioConfig(entry));
    return;
  }

  const dryRun = isDryRun();
  const result = installMcpServer({ agent, ...entry, force: args.force === true, dryRun });
  warnings.push(...result.warnings);
  io.emit(
    {
      ...common,
      agent: result.agent,
      location: result.location,
      replaced: result.replaced,
      gitignored: result.gitignored,
      org_id: currentOrg(ctx),
      ...(dryRun ? { dry_run: true } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    },
    () =>
      [
        dryRun
          ? `Would add ${bold(SERVER_NAME)} to ${result.location}. Nothing written.`
          : `Added ${bold(SERVER_NAME)} to ${result.location}`,
        dim(`  runs ${[entry.command, ...entry.args].join(" ")}`),
        dim("  no key in the config: the server uses this CLI's sign-in"),
        ...gitignoreLines(result),
        ...warnings.map((w) => `  ${w}`),
        ...(dryRun ? [] : ["", reloadHint(result.agent)]),
      ].join("\n"),
  );
}

/** The output's line about `.gitignore`, when the install changed it or would. */
function gitignoreLines(result: InstallResult): string[] {
  if (result.gitignored === "added") {
    return [dim(`  added .mcp.json to ${result.gitignore}: it can hold credentials, so it is never committed`)];
  }
  if (result.gitignored === "would_add") return [dim(`  would add .mcp.json to ${result.gitignore}`)];
  return [];
}

/**
 * Installs the remote endpoint with a newly minted key.
 *
 * @remarks
 * With `--print`, which is an explicit request, the full key goes to stdout and nowhere else.
 */
async function installRemote(ctx: Ctx, args: McpInstallArgs): Promise<void> {
  const { config, io } = ctx;
  const { token, accountId } = await requireSession(ctx);
  const orgId = requireOrg(ctx);

  const agent = resolveAgent(args.agent);
  const env = keyEnvFor(config);
  const url = mcpServerUrl(config, orgId);

  // Refuse a tracked .mcp.json before a key exists, rather than mint one only to throw it away.
  const target = args.print ? null : projectConfigTarget(agent);
  const projectGit = target ? checkProjectGit(target, true) : null;

  let key: Awaited<ReturnType<typeof generateApiKey>>;
  try {
    key = await generateApiKey(config, token, orgId, { env, kind: "mcp", accountId });
  } catch (err) {
    // A dry run stops at the mint; say what the install would also have done to .gitignore.
    if (err instanceof CliError && err.reason === "dry_run" && target) {
      const gitignored = projectGit?.addTo ? "would_add" : projectGit?.ignored ? "already" : null;
      const also = gitignored === "would_add" ? `\nIt would also add .mcp.json to ${projectGit?.addTo}.` : "";
      throw new CliError(`${err.message}${also}`, {
        exitCode: err.exitCode,
        reason: err.reason,
        details: { ...err.details, location: target, gitignored },
      });
    }
    throw err;
  }

  if (args.print) {
    io.emit(
      { ok: true, server: SERVER_NAME, mode: "remote", url, env, config: renderManualConfig(url, key.rawKey) },
      () => renderManualConfig(url, key.rawKey),
    );
    return;
  }

  const result = installMcpServer({ agent, url, apiKey: key.rawKey, force: args.force === true });

  io.emit(
    {
      ok: true,
      server: SERVER_NAME,
      mode: "remote",
      agent: result.agent,
      location: result.location,
      env,
      replaced: result.replaced,
      gitignored: result.gitignored,
      key_preview: key.preview,
      org_id: orgId,
    },
    () =>
      [
        `Added ${bold(SERVER_NAME)} to ${result.location}`,
        dim(`  key ${key.preview}${env === "dev" ? " (dev — not a live key)" : ""}`),
        ...gitignoreLines(result),
        "",
        reloadHint(result.agent),
      ].join("\n"),
  );
}

/**
 * Picks the agent to configure: `--agent` when given, otherwise a best guess.
 *
 * @throws CliError `unknown_agent` for an unsupported name.
 */
function resolveAgent(name: string | undefined): AgentId {
  if (!name) return detectAgent();
  const normalized = name.trim().toLowerCase() as AgentId;
  if (!KNOWN_AGENTS.includes(normalized)) {
    throw failed(
      `Unknown agent "${name}". Supported: ${KNOWN_AGENTS.join(", ")}.`,
      "unknown_agent",
      { requested: name },
    );
  }
  return normalized;
}
