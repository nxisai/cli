/**
 * Writing a connection's signing secret into an env file, so it never has to be shown.
 *
 * @remarks
 * `nxis connections create|rotate --write-env <file>` and the matching MCP tools put the secret
 * straight into the receiving application's env file. The file must be one git ignores, or sit
 * outside a git repository: a secret written into a tracked or unignored file is one commit away
 * from being published. The check runs before the secret is issued, so a refusal leaves nothing
 * to clean up.
 *
 * The file is created readable by its owner only (mode 600), and an existing one is made so. The
 * variable's line is replaced when present, else appended; every other line is kept as it was.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { failed } from "./errors.js";
import { plainText } from "./output.js";

/** The variable a secret is written to when no other is named. */
export const DEFAULT_ENV_NAME = "NXIS_ACTION_SECRET";

/** A variable name an env file and a shell both take. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Why the file may hold a secret: git ignores it, or it isn't in a git repository. */
export type EnvFileGit = "ignored" | "not_a_repository";

/** An env file checked for a secret, before the secret exists. */
export interface EnvTarget {
  /** The file, absolute. */
  path: string;
  /** The variable. */
  name: string;
  git: EnvFileGit;
}

/** @returns The result of running git in `dir`, or null when git can't be run. */
function git(dir: string, args: string[]): { status: number | null } | null {
  const r = spawnSync("git", ["-C", dir, ...args], { stdio: "ignore", timeout: 10_000 });
  if (r.error) return null;
  return { status: r.status };
}

/** @returns True when `dir` or a parent holds `.git`, for when git itself can't be run. */
function hasGitDir(dir: string): boolean {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return true;
    if (dirname(d) === d) return false;
  }
}

/**
 * Checks where a secret is to be written, before it is issued.
 *
 * @param file - The env file, as given; relative to the working directory.
 * @param name - The variable; {@link DEFAULT_ENV_NAME} when not given.
 * @returns The file and variable, and why git allows it.
 * @throws CliError (exit 1) `invalid_input` for an empty file or an invalid variable name;
 * `env_dir_missing` when the file's directory doesn't exist; `env_file_not_regular` for a
 * directory, a link or another non-file; `env_file_tracked` when git tracks the file;
 * `env_file_not_ignored` when it is in a repository and git doesn't ignore it; `git_unavailable`
 * when it is in a repository and git can't be run to check.
 */
export function checkEnvTarget(file: string | undefined, name: string | undefined, cwd = process.cwd()): EnvTarget {
  const given = (file ?? "").trim();
  if (!given) {
    throw failed("--write-env needs the env file to write the secret to, such as --write-env .env.local.", "invalid_input", {
      field: "write_env",
    });
  }
  const variable = (name ?? DEFAULT_ENV_NAME).trim();
  if (!ENV_NAME.test(variable)) {
    throw failed(
      `--env-name takes a variable name: letters, digits and underscores, not starting with a digit (got "${plainText(variable.slice(0, 80))}").`,
      "invalid_input",
      { field: "env_name" },
    );
  }
  const path = resolve(cwd, given);
  const dir = dirname(path);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw failed(`The directory of ${plainText(path)} doesn't exist. Create it first, or name a file in a directory that does.`, "env_dir_missing", {
      path,
    });
  }
  if (existsSync(path) || isLink(path)) {
    const st = lstatSync(path);
    if (!st.isFile()) {
      throw failed(`${plainText(path)} isn't a regular file (a link or a directory, say), so the secret isn't written there.`, "env_file_not_regular", {
        path,
      });
    }
  }

  const inside = git(dir, ["rev-parse", "--is-inside-work-tree"]);
  if (inside === null) {
    if (!hasGitDir(dir)) return { path, name: variable, git: "not_a_repository" };
    throw failed(
      `${plainText(path)} is in a git repository, and git can't be run to check that it ignores the file. ` +
        "Install git, or name a file outside the repository.",
      "git_unavailable",
      { path },
    );
  }
  if (inside.status !== 0) return { path, name: variable, git: "not_a_repository" };

  const tracked = git(dir, ["ls-files", "--error-unmatch", "--", basename(path)]);
  if (tracked?.status === 0) {
    throw failed(
      `${plainText(path)} is tracked by git, so a secret written there would be committed. ` +
        `Name an ignored file instead, such as .env.local listed in .gitignore.`,
      "env_file_tracked",
      { path },
    );
  }
  const ignored = git(dir, ["check-ignore", "-q", "--", basename(path)]);
  if (ignored?.status !== 0) {
    throw failed(
      `${plainText(path)} isn't ignored by git, so a secret written there could be committed. ` +
        `Add it to .gitignore first, or name a file that is ignored.`,
      "env_file_not_ignored",
      { path },
    );
  }
  return { path, name: variable, git: "ignored" };
}

/** @returns True for a symbolic link, dangling or not. */
function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** @returns The value as an env file writes it: bare when it is plain, else double-quoted. */
function envValue(value: string): string {
  if (/^[A-Za-z0-9_\-.+/=:@]*$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/\n/g, "\\n")}"`;
}

/**
 * The file's text with the variable set: its line replaced when present (the first; any later
 * ones are dropped, since they would win), else appended. Every other line, the line endings and
 * a trailing newline are kept; the result always ends with one.
 */
export function setEnvLine(text: string, name: string, value: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.length > 0 ? text.split(/\r?\n/) : [];
  // A trailing newline leaves an empty last item, which is the newline, not a line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const pattern = new RegExp(`^(\\s*)(export\\s+)?${name}\\s*=`);
  const out: string[] = [];
  let set = false;
  for (const line of lines) {
    const m = pattern.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    if (set) continue;
    out.push(`${m[1] ?? ""}${m[2] ?? ""}${name}=${envValue(value)}`);
    set = true;
  }
  if (!set) out.push(`${name}=${envValue(value)}`);
  return out.join(eol) + eol;
}

/**
 * Writes the secret into the file checked by {@link checkEnvTarget}, readable by its owner only.
 *
 * @throws Error from the file system; the caller says what was and wasn't done.
 */
export function writeEnvSecret(target: EnvTarget, secret: string): void {
  const existing = existsSync(target.path) ? readFileSync(target.path, "utf8") : "";
  // Made private before the secret is in it.
  if (existsSync(target.path)) chmodSync(target.path, 0o600);
  writeFileSync(target.path, setEnvLine(existing, target.name, secret), { encoding: "utf8", mode: 0o600 });
  chmodSync(target.path, 0o600);
}
