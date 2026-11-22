/**
 * Opening a URL.
 *
 * @remarks
 * Best-effort by design. The CLI always prints the URL before trying to open it, so a
 * failure to launch a browser is cosmetic rather than fatal — which matters because the
 * places agents run (containers, SSH sessions, CI boxes) frequently have no browser at
 * all, and that must not look like a broken payment.
 *
 * Every URL this CLI opens comes from a service — the device flow's verification page, a
 * payment link — so what may be opened, and how, is decided here and nowhere else. The approach
 * follows the yaaa CLI's, which is in use on Windows 11 and WSL2.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Whether this is Linux running in WSL on Windows.
 *
 * @remarks
 * WSL sets `WSL_DISTRO_NAME` and `WSL_INTEROP`, and its kernel release names Microsoft, which
 * also catches shells started without WSL's environment.
 */
export function isWsl(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
): boolean {
  if (platform !== "linux") return false;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  try {
    return /microsoft/i.test(read("/proc/sys/kernel/osrelease"));
  } catch {
    return false;
  }
}

/**
 * Whether this machine can plausibly open a browser.
 *
 * @remarks
 * False when `NXIS_NO_BROWSER=1`, on Linux without a display (WSL excepted: its browser is
 * Windows'), and in SSH sessions other than on macOS.
 */
export function canOpenBrowser(): boolean {
  if (process.env.NXIS_NO_BROWSER === "1") return false;
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !isWsl()) return false;
  if (process.env.SSH_CONNECTION && process.platform !== "darwin") return false;
  return true;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether a URL may be handed to the browser: https, or http to this machine.
 *
 * @remarks
 * The OS openers accept any scheme, including `file:` and the custom schemes applications
 * register, so the scheme is the line between "show a page" and "launch something". Anything
 * else is never opened, wherever it came from; it stays on screen for the person to judge.
 */
export function openable(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname));
  } catch {
    return false;
  }
}

/**
 * Ways to open a URL, best first.
 *
 * @remarks
 * - **Windows:** `rundll32 url.dll,FileProtocolHandler`, which hands the whole URL, fragment
 *   included, to the default browser and parses nothing. Not `cmd /c start`: cmd parses its
 *   command line, so an `&` in a URL ends the `start` and runs whatever follows. Not
 *   `explorer.exe`: it takes a URL with a query or fragment for a path.
 * - **WSL:** the browser is Windows'. `wslview` when installed (it comes with wslu, which Ubuntu
 *   no longer installs by default); else PowerShell's `Start-Process` with the URL in single
 *   quotes, `'` doubled; else `rundll32`, for when PowerShell is blocked by policy.
 */
export function openers(
  url: string,
  wsl = isWsl(),
  platform: NodeJS.Platform = process.platform,
): Array<{ bin: string; args: string[] }> {
  if (platform === "darwin") return [{ bin: "open", args: [url] }];
  if (platform === "win32") return [{ bin: "rundll32", args: ["url.dll,FileProtocolHandler", url] }];
  if (wsl) {
    return [
      { bin: "wslview", args: [url] },
      {
        bin: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", `Start-Process '${url.replace(/'/g, "''")}'`],
      },
      { bin: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] },
    ];
  }
  return [{ bin: "xdg-open", args: [url] }];
}

/** Whether a command is on the PATH. */
function onPath(bin: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Opens a URL in the default browser. Never throws.
 *
 * @remarks
 * Tries each of {@link openers} that is installed until one succeeds. A URL that is not
 * {@link openable} is not opened; the caller has already printed it.
 *
 * @param url - The URL to open.
 * @returns Whether a browser was opened.
 */
export function openUrl(url: string): boolean {
  if (!canOpenBrowser() || !openable(url)) return false;
  const href = new URL(url).href;
  for (const o of openers(href)) {
    if (!onPath(o.bin)) continue;
    try {
      execFileSync(o.bin, o.args, { stdio: "ignore", timeout: 10_000 });
      return true;
    } catch {
      // Try the next way.
    }
  }
  return false;
}
