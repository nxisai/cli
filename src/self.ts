/**
 * How an agent should start this CLI's local MCP server.
 *
 * @remarks
 * `nxis mcp install` writes a command into the agent's config, and the agent runs it later, from
 * its own working directory and with its own `PATH`. So the command is an absolute path whenever
 * there is a lasting one: the `nxis` the user installed, globally or in a project. A copy that
 * `npx` (or another package runner) unpacked into its cache is not lasting, since the cache is
 * pruned, so then the entry runs `npx -y @nxisai/cli@<version> mcp serve` instead, which fetches
 * it again when it has to. The version is the one doing the installing, so the entry keeps
 * running what was set up and tested rather than whatever is published next.
 *
 * The standalone install (`install.sh`, or Homebrew) runs the bundle on its own Node.js through a
 * launcher, and says where that launcher is in `NXIS_LAUNCHER`: `~/.local/bin/nxis`, or
 * Homebrew's `opt` path. That launcher is the lasting command, since the bundle's own path is
 * inside a versioned folder that an update removes.
 */

import { accessSync, constants, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, resolve, sep } from "node:path";
import type { StdioServerEntry } from "./agents.js";

/** The package name, for the `npx` fallback. */
export const PACKAGE_NAME = "@nxisai/cli";

/** @returns This package's version, or `0.0.0` when it cannot be read. */
export function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** The arguments that start the local server. */
export const SERVE_ARGS = ["mcp", "serve"] as const;

/** Where this CLI is running from, for {@link localServerEntry}. Defaults to this process. */
export interface SelfLocation {
  /** The script node is running: `process.argv[1]`. */
  script?: string | undefined;
  /** The node binary: `process.execPath`. */
  execPath?: string;
  /** `process.platform`. */
  platform?: NodeJS.Platform;
  /** The npm cache directory, when known: `npm_config_cache`. */
  npmCache?: string | undefined;
  /** This CLI's version, which the `npx` fallback pins: {@link packageVersion}. */
  version?: string;
  /** The standalone install's launcher: `NXIS_LAUNCHER`. */
  launcher?: string | undefined;
}

/** The local server's command, and how it was chosen. */
export interface LocalServer extends StdioServerEntry {
  /**
   * `installed` when the command is this installation's own path; `npx` when it is the
   * `npx -y @nxisai/cli@<version>` fallback.
   */
  source: "installed" | "npx";
}

/**
 * Directory names that only a package runner's throwaway cache has: npm's `_npx`, pnpm's and
 * yarn's `dlx-…`, bun's `bunx-…`.
 */
const EPHEMERAL_SEGMENT = /^(_npx|dlx-.+|bunx-.+|xfs-.+)$/;

/**
 * @returns True when the path is inside a package runner's cache rather than an installation.
 *
 * @param path - A path to the running script, as given or resolved.
 * @param npmCache - npm's cache directory, when known.
 */
export function isEphemeralPath(path: string, npmCache?: string): boolean {
  const segments = path.split(/[\\/]+/);
  if (segments.some((segment) => EPHEMERAL_SEGMENT.test(segment))) return true;
  if (npmCache && isAbsolute(npmCache)) {
    const root = resolve(npmCache);
    if (path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) return true;
  }
  return false;
}

/** @returns The real path, or the path itself when it cannot be resolved. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** @returns True when the file can be executed directly. */
function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The command that starts this CLI's local MCP server, for an agent's config.
 *
 * @remarks
 * - A standalone install's launcher ({@link SelfLocation.launcher}) when there is one, it is an
 *   absolute path, and it can be executed.
 * - The running script is the installed `nxis` unless it, or the file it links to, is inside a
 *   package runner's cache. Its path is kept as given rather than resolved, so a global install's
 *   `bin/nxis` link keeps working when an upgrade moves what it points to.
 * - The script is run directly where it can be (`#!/usr/bin/env node`). On Windows, or when it is
 *   not executable, the entry runs it with this node binary instead.
 * - Otherwise, `npx -y @nxisai/cli@<version> mcp serve` (through `cmd /c` on Windows). A version
 *   that cannot be read (`0.0.0`) is left off, since no such release exists to pin to.
 *
 * @param extra - Arguments to append after `mcp serve`, such as `--org`.
 * @param self - Where this CLI is running from; this process by default.
 */
export function localServerEntry(extra: readonly string[] = [], self: SelfLocation = {}): LocalServer {
  const script = "script" in self ? self.script : process.argv[1];
  const execPath = self.execPath ?? process.execPath;
  const platform = self.platform ?? process.platform;
  const npmCache = "npmCache" in self ? self.npmCache : process.env.npm_config_cache;
  const args = [...SERVE_ARGS, ...extra];
  const launcher = "launcher" in self ? self.launcher : process.env.NXIS_LAUNCHER;

  if (launcher && isAbsolute(launcher) && platform !== "win32" && executable(launcher)) {
    return { command: launcher, args, source: "installed" };
  }

  if (script) {
    const given = resolve(script);
    const target = real(given);
    if (!isEphemeralPath(given, npmCache) && !isEphemeralPath(target, npmCache)) {
      if (platform !== "win32" && executable(given)) {
        return { command: given, args, source: "installed" };
      }
      return { command: execPath, args: [target, ...args], source: "installed" };
    }
  }
  const version = self.version ?? packageVersion();
  const pkg = version === "0.0.0" ? PACKAGE_NAME : `${PACKAGE_NAME}@${version}`;
  const npx = ["-y", pkg, ...args];
  // On Windows `npx` is a batch file, which an agent cannot spawn without a shell.
  if (platform === "win32") return { command: "cmd", args: ["/c", "npx", ...npx], source: "npx" };
  return { command: "npx", args: npx, source: "npx" };
}
