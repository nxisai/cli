/**
 * How this nxis was installed, which decides how it updates and what `nxis mcp install` writes.
 *
 * @remarks
 * - **installer**: `install.sh`'s launcher sets `NXIS_LAUNCHER`, `NXIS_INSTALL_DIR` and
 *   `NXIS_RELEASES_URL`. `nxis update` installs the new version in place.
 * - **homebrew**: the formula's wrapper sets `NXIS_INSTALLED_BY=homebrew` and `NXIS_LAUNCHER`
 *   (its `opt` path, which survives upgrades). Homebrew updates it.
 * - **npm**: a global install, or `npx`'s throwaway copy. npm updates it.
 * - **source**: a checkout of the repository.
 */

import { realpathSync } from "node:fs";
import { dirname, sep } from "node:path";
import { assertSecureUrl } from "./release.js";
import { PACKAGE_NAME } from "./self.js";

/** Where releases are when the launcher doesn't say. */
export const DEFAULT_RELEASES_URL = "https://github.com/nxisai/cli/releases";

export type Installation =
  | { kind: "installer"; dir: string; bin: string; url: string }
  | { kind: "homebrew" }
  | { kind: "npm"; npx: boolean }
  | { kind: "source"; path: string };

/** @returns How this nxis was installed, from the environment and the running script's path. */
export function installation(env: NodeJS.ProcessEnv = process.env, script: string = process.argv[1] ?? ""): Installation {
  let path = script;
  try {
    path = realpathSync(script);
  } catch {
    // Keep the path as given.
  }
  // Before the launcher: the formula sets NXIS_LAUNCHER too.
  if (env.NXIS_INSTALLED_BY === "homebrew") return { kind: "homebrew" };
  if (env.NXIS_LAUNCHER && env.NXIS_INSTALL_DIR) {
    return {
      kind: "installer",
      dir: env.NXIS_INSTALL_DIR,
      bin: env.NXIS_LAUNCHER,
      url: (env.NXIS_RELEASES_URL || DEFAULT_RELEASES_URL).replace(/\/$/, ""),
    };
  }
  if (/[\\/](Cellar|homebrew|linuxbrew)[\\/]/.test(path)) return { kind: "homebrew" };
  if (path.includes(`${sep}node_modules${sep}`)) return { kind: "npm", npx: /[\\/](_npx|dlx-[^\\/]+)[\\/]/.test(path) };
  return { kind: "source", path: dirname(path) };
}

/**
 * @returns Where to look for new versions: the installer's URL, else GitHub. `NXIS_RELEASES_URL`
 * overrides it. It has to be https (or http to this machine).
 */
export function releasesUrl(i: Installation, env: NodeJS.ProcessEnv = process.env): string {
  const url = (env.NXIS_RELEASES_URL || (i.kind === "installer" ? i.url : DEFAULT_RELEASES_URL)).replace(/\/$/, "");
  assertSecureUrl(url);
  return url;
}

/** @returns The command that updates this installation, to `latest` when known. */
export function updateHint(i: Installation, latest?: string): string {
  const pkg = latest ? `${PACKAGE_NAME}@${latest}` : `${PACKAGE_NAME}@latest`;
  switch (i.kind) {
    case "installer":
      return "nxis update";
    case "homebrew":
      return "brew upgrade nxis";
    case "npm":
      return i.npx ? `npx -y ${pkg}` : `npm install -g ${pkg}`;
    case "source":
      return "git pull, then `npm ci && npm run build` (this nxis runs from a source checkout)";
  }
}

/** Compares `1.2.3` or `1.2.3-beta.1` versions: negative when `a` is older. A release beats its pre-releases. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const t = v.trim().replace(/^v/, "");
    const dash = t.indexOf("-");
    const main = dash === -1 ? t : t.slice(0, dash);
    const pre = dash === -1 ? undefined : t.slice(dash + 1);
    return { nums: main.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre.localeCompare(y.pre, undefined, { numeric: true });
}
