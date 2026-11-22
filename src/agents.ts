/**
 * Writing the MCP server into an agent's configuration.
 *
 * @remarks
 * The key goes into a config file, never onto the terminal. That is the whole point of doing
 * this from the CLI rather than printing instructions: a key printed into an agent's
 * transcript is a key in the conversation history, in any log that captures it, and in
 * whatever the agent later summarizes.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { failed, needsUser } from "./errors.js";
import { writePrivateFile } from "./files.js";

/** The name the MCP server is registered under in an agent's config. */
export const SERVER_NAME = "nxis-onboarding";

/** The agents the CLI knows how to configure. */
export type AgentId = "claude-code" | "mcp-json" | "cursor";

/**
 * What happened to a project `.mcp.json`'s line in `.gitignore`: `added`, `would_add` under
 * `--dry-run`, `already` when git already ignores it, or null when no project file was written or
 * there is no git work tree.
 */
export type Gitignored = "added" | "would_add" | "already" | null;

/** The outcome of {@link installMcpServer}. */
export interface InstallResult {
  agent: AgentId;
  /** Where it ended up, for the human-readable output. */
  location: string;
  /** True when an existing entry was replaced (or, under `dryRun`, would be). */
  replaced: boolean;
  /** For a project `.mcp.json`: what was done about `.gitignore`. */
  gitignored: Gitignored;
  /** The `.gitignore` that was, or would be, changed; null when none. */
  gitignore: string | null;
  /** Things the user should do, such as untracking a committed `.mcp.json`. */
  warnings: string[];
}

/** A remote MCP server entry in an `mcpServers` config block: a URL and the key header. */
export interface RemoteServerEntry {
  url: string;
  headers: Record<string, string>;
}

/**
 * A local (stdio) MCP server entry: the command the agent starts, and its arguments.
 *
 * @remarks
 * It carries no key. The server it starts is `nxis mcp serve`, which uses the CLI's own sign-in
 * and the provisioning key it keeps in the keychain.
 */
export interface StdioServerEntry {
  command: string;
  args: string[];
}

/** One MCP server entry in an `mcpServers` config block. */
export type McpServerEntry = RemoteServerEntry | StdioServerEntry;

/** @returns True when the command is on the PATH. */
function hasCommand(cmd: string): boolean {
  const res = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
  });
  return res.status === 0;
}

/** Best guess at what the user is running, preferring a CLI we can drive directly. */
export function detectAgent(): AgentId {
  if (hasCommand("claude")) return "claude-code";
  if (existsSync(join(process.cwd(), ".cursor", "mcp.json"))) return "cursor";
  return "mcp-json";
}

/**
 * The config file an agent reads MCP servers from, when the CLI writes it itself.
 *
 * @remarks
 * Claude Code normally isn't written here: it is configured through `claude mcp add` at local
 * scope, which keeps the entry in the user's own Claude Code config. `.mcp.json` is the
 * project-scoped file, which is meant to be committed; here it never is, so whenever it is written
 * it is also kept out of git ({@link checkProjectGit}).
 */
function configPathFor(agent: AgentId): string {
  switch (agent) {
    case "cursor":
      return join(homedir(), ".cursor", "mcp.json");
    case "mcp-json":
    case "claude-code":
    default:
      return join(process.cwd(), ".mcp.json");
  }
}

/** How long one git command may take. It only reads the index and the ignore rules. */
const GIT_TIMEOUT_MS = 10_000;

/**
 * Runs git, never through a shell.
 *
 * @returns Its exit status and stdout, or null when git could not run at all (not installed, or
 * timed out).
 */
function git(cwd: string, args: string[]): { status: number; stdout: string } | null {
  try {
    const stdout = execFileSync("git", ["-C", cwd, ...args], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
    });
    return { status: 0, stdout };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: unknown };
    return typeof e.status === "number" ? { status: e.status, stdout: String(e.stdout ?? "") } : null;
  }
}

/**
 * Where a file stands with git: `tracked`, `ignored`, `not_ignored` (a commit would pick it up),
 * or `no_git` outside a work tree or where git is not installed.
 *
 * @remarks
 * A tracked file counts as tracked even when it is also ignored: ignore rules do not apply to it.
 */
export function gitStanding(path: string): "tracked" | "ignored" | "not_ignored" | "no_git" {
  const cwd = dirname(path);
  if (!existsSync(cwd)) return "no_git";
  const inside = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside || inside.status !== 0 || inside.stdout.trim() !== "true") return "no_git";
  if (git(cwd, ["ls-files", "--error-unmatch", "--", path])?.status === 0) return "tracked";
  if (git(cwd, ["check-ignore", "-q", "--", path])?.status === 0) return "ignored";
  return "not_ignored";
}

/**
 * Whether git would publish a file, if it were written.
 *
 * @remarks
 * For a file outside the project that will hold an API key (Cursor's, under HOME, which may be a
 * dotfiles repository). Inside a work tree it must be ignored and not already tracked; a key in a
 * committed config file is a key in the repository's history for good.
 *
 * @returns `tracked` when git already tracks the file, `not_ignored` when a commit would pick
 * it up, or null when it is safe to write.
 */
export function gitExposure(path: string): "tracked" | "not_ignored" | null {
  const standing = gitStanding(path);
  return standing === "tracked" || standing === "not_ignored" ? standing : null;
}

/**
 * Refuses to put a key in a file git would publish.
 *
 * @remarks
 * Only for an entry that holds a key, in a file outside the project. A stdio entry holds a command
 * line and nothing secret; a project `.mcp.json` is handled by {@link checkProjectGit}.
 *
 * @throws CliError `mcp_config_not_ignored` (exit 2) when the file is tracked or not ignored.
 */
function assertNotPublished(path: string): void {
  const exposure = gitExposure(path);
  if (!exposure) return;
  const why =
    exposure === "tracked"
      ? `${path} is tracked by git, so the API key would be committed.`
      : `${path} is not ignored by git, so the API key would be committed with it.`;
  throw needsUser(
    `${why} Add it to .gitignore and run this again, or use --print to configure your agent by hand.`,
    "mcp_config_not_ignored",
    { location: path, exposure },
  );
}

/** What has to happen in git before a project `.mcp.json` is written. */
export interface ProjectGit {
  /** The `.gitignore` next to the file, to append to; null when git already ignores it, or no git. */
  addTo: string | null;
  /** Git already ignores it. */
  ignored: boolean;
  /** Warnings for the output: a tracked file holding no key. */
  warnings: string[];
}

/** The advice for a `.mcp.json` git already tracks. */
const UNTRACK =
  "Untrack it with `git rm --cached .mcp.json` (it is in .gitignore from now on), and rotate any key " +
  "that was ever committed in it.";

/**
 * Checks a project's `.mcp.json` against git, before anything is written.
 *
 * @remarks
 * `.mcp.json` is never to be committed, whatever it holds: a remote entry holds a key, and
 * whatever else is in the file may too. So when git would pick it up, it goes into the
 * `.gitignore` next to it. A file git already tracks is past that: ignore rules do not apply to
 * it, so a key is never written into it, and an entry without a key comes with the advice to
 * untrack it. Outside a work tree, or without git, there is nothing to do.
 *
 * @throws CliError `mcp_json_tracked` (exit 2) when the file is tracked and the entry holds a key.
 */
export function checkProjectGit(path: string, holdsKey: boolean): ProjectGit {
  const standing = gitStanding(path);
  if (standing === "no_git") return { addTo: null, ignored: false, warnings: [] };
  if (standing === "ignored") return { addTo: null, ignored: true, warnings: [] };
  const gitignore = join(dirname(path), ".gitignore");
  if (standing === "not_ignored") return { addTo: gitignore, ignored: false, warnings: [] };

  if (holdsKey) {
    throw needsUser(
      `${path} is tracked by git, and it can hold credentials, so no key is written into it. ${UNTRACK} ` +
        "Then run this again, or use --stdio, whose entry holds no key.",
      "mcp_json_tracked",
      { location: path },
    );
  }
  // Ignore rules skip tracked files unless asked to look at the patterns alone.
  const ignored = git(dirname(path), ["check-ignore", "-q", "--no-index", "--", path])?.status === 0;
  return {
    addTo: ignored ? null : gitignore,
    ignored,
    warnings: [`${path} is tracked by git, and it can hold credentials. ${UNTRACK}`],
  };
}

/** Appends `.mcp.json` to a `.gitignore`, creating it if needed, on its own line. */
function addToGitignore(gitignore: string): void {
  let before = "";
  try {
    const existing = readFileSync(gitignore, "utf8");
    if (existing.length > 0) before = existing.endsWith("\n") ? "\n" : "\n\n";
  } catch {
    // No .gitignore yet: it is created.
  }
  const comment = "# MCP server config: it can hold credentials, so it is never committed.";
  appendFileSync(gitignore, `${before}${comment}\n.mcp.json\n`);
}

/**
 * The `claude mcp add` arguments for the server.
 *
 * @remarks
 * Local scope, not project: local is private to this user and this project, and is never
 * written to `.mcp.json`. The key is an argument here because Claude Code takes headers no
 * other way, so it is visible to `ps` for the length of this one call; `--agent mcp-json` and
 * `--print` avoid that.
 */
export function claudeAddArgs(url: string, apiKey: string): string[] {
  return [
    "mcp", "add",
    "--transport", "http",
    "--scope", "local",
    SERVER_NAME,
    url,
    "--header", `nxis-api-key: ${apiKey}`,
  ];
}

/**
 * The `claude mcp add` arguments for the local server.
 *
 * @remarks
 * Local scope, as for the remote server. Everything after `--` is the command Claude Code starts,
 * so `nxis`'s own flags there are not read as Claude Code's.
 */
export function claudeAddStdioArgs(entry: StdioServerEntry): string[] {
  return ["mcp", "add", "--transport", "stdio", "--scope", "local", SERVER_NAME, "--", entry.command, ...entry.args];
}

/** @returns The parsed JSON object, or an empty object when missing or invalid. */
function readJsonFile(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** @returns True when the file already has an entry named {@link SERVER_NAME}. */
function existingServer(path: string): boolean {
  const doc = readJsonFile(path);
  const servers = doc["mcpServers"];
  return Boolean(servers && typeof servers === "object" && SERVER_NAME in (servers as object));
}

/**
 * Writes the server entry into a config file, keeping other entries.
 *
 * @remarks
 * The file is left at mode 0600, even if it already existed, because it may now contain a live
 * API key, or another server's.
 *
 * @returns True when an existing entry was replaced.
 */
function writeServerEntry(path: string, entry: McpServerEntry): boolean {
  const doc = readJsonFile(path);
  const servers = (doc["mcpServers"] && typeof doc["mcpServers"] === "object"
    ? (doc["mcpServers"] as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  const replaced = SERVER_NAME in servers;
  servers[SERVER_NAME] = entry;
  doc["mcpServers"] = servers;

  writePrivateFile(path, `${JSON.stringify(doc, null, 2)}\n`);
  return replaced;
}

/** What to install: a remote server and its key, or the command for the local one. */
export type InstallTarget = { url: string; apiKey: string } | StdioServerEntry;

/**
 * Install the server.
 *
 * @remarks
 * For Claude Code, `claude mcp add` is preferred because it owns the config format. If that
 * command fails for any reason other than an existing entry, `.mcp.json` is written directly.
 * A project `.mcp.json` is always kept out of git ({@link checkProjectGit}), whatever it holds.
 * Cursor's config, outside the project, is held to the old rule: an entry with a key is never
 * written where git would commit it.
 *
 * Refuses to clobber an existing `nxis-onboarding` entry without `--force`, because the
 * common case for a second run is a user who already has a working connection to a different
 * organization — silently repointing it is how someone ends up publishing to the wrong site.
 * The local and the remote server share the name, so `--force` swaps one for the other.
 *
 * With `dryRun`, nothing is written and nothing is run: the result says what would be.
 *
 * @throws CliError `server_exists` when an entry exists and `force` is false; `mcp_json_tracked`
 * (exit 2) for a key headed into a tracked `.mcp.json`; `mcp_config_not_ignored` (exit 2) when
 * Cursor's file would hold a key and be committed.
 */
export function installMcpServer(
  opts: { agent: AgentId; force: boolean; dryRun?: boolean } & InstallTarget,
): InstallResult {
  const { agent, force } = opts;
  const stdio = "command" in opts;
  const entry: McpServerEntry = stdio
    ? { command: opts.command, args: [...opts.args] }
    : { url: opts.url, headers: { "nxis-api-key": opts.apiKey } };
  const noGit = { gitignored: null, gitignore: null, warnings: [] };

  if (agent === "claude-code" && hasCommand("claude")) {
    const location = "Claude Code (local scope: this project, this user)";
    if (opts.dryRun) return { agent, location, replaced: false, ...noGit };
    let replaced = false;
    if (force) {
      replaced =
        spawnSync("claude", ["mcp", "remove", "--scope", "local", SERVER_NAME], { stdio: "ignore" }).status === 0;
    }
    const addArgs = stdio ? claudeAddStdioArgs(entry as StdioServerEntry) : claudeAddArgs(opts.url, opts.apiKey);
    const res = spawnSync("claude", addArgs, { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
    if (res.status === 0) {
      return { agent, location, replaced, ...noGit };
    }
    if (/already exists/i.test(res.stderr ?? "")) {
      throw failed(
        `An MCP server named "${SERVER_NAME}" is already configured in Claude Code. ` +
          "Re-run with --force to replace it.",
        "server_exists",
        { location },
      );
    }
  }

  const path = configPathFor(agent);
  const inProject = agent !== "cursor";
  const projectGit = inProject ? checkProjectGit(path, !stdio) : null;
  if (!inProject && !stdio) assertNotPublished(path);
  const exists = existingServer(path);
  if (exists && !force) {
    throw failed(
      `An MCP server named "${SERVER_NAME}" is already configured in ${path}. ` +
        "Re-run with --force to replace it.",
      "server_exists",
      { location: path },
    );
  }
  let gitignored: Gitignored = null;
  if (projectGit?.addTo) gitignored = opts.dryRun ? "would_add" : "added";
  else if (projectGit?.ignored) gitignored = "already";
  const git = {
    gitignored,
    gitignore: projectGit?.addTo ?? null,
    warnings: projectGit?.warnings ?? [],
  };
  if (opts.dryRun) return { agent, location: path, replaced: exists, ...git };

  // The ignore line goes in first, so the file is never on disk where a commit would pick it up.
  if (projectGit?.addTo) addToGitignore(projectGit.addTo);
  const replaced = writeServerEntry(path, entry);
  return { agent, location: path, replaced, ...git };
}

/**
 * The project `.mcp.json` an install for this agent will write, or null when it writes elsewhere
 * (Cursor's config, or Claude Code through `claude mcp add`).
 *
 * @remarks
 * For checking git before a key is minted. When `claude mcp add` fails and the install falls back
 * to `.mcp.json`, {@link installMcpServer} checks again.
 */
export function projectConfigTarget(agent: AgentId): string | null {
  if (agent === "mcp-json" || (agent === "claude-code" && !hasCommand("claude"))) return configPathFor(agent);
  return null;
}

/** What to hand someone who asked for `--print` instead of an install. */
export function renderManualConfig(url: string, apiKey: string): string {
  return JSON.stringify(
    { mcpServers: { [SERVER_NAME]: { url, headers: { "nxis-api-key": apiKey } } } },
    null,
    2,
  );
}

/** What to hand someone who asked for `--print` with the local server. */
export function renderStdioConfig(entry: StdioServerEntry): string {
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: entry.command, args: entry.args } } }, null, 2);
}

/** How this agent reloads MCP servers, so the last instruction isn't "figure it out". */
export function reloadHint(agent: AgentId): string {
  switch (agent) {
    case "claude-code":
      return "In Claude Code, run /mcp to reconnect, then the nxis-onboarding tools appear.";
    case "cursor":
      return "In Cursor, reload the window (or toggle the MCP server off and on) to pick it up.";
    default:
      return "Restart your agent, or reload its MCP servers, to pick up the new connection.";
  }
}
