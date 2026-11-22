/**
 * `nxis update`: installs the latest standalone release in place, or says how to update.
 *
 * @remarks
 * Only an install from `install.sh` updates itself. It downloads the new version, checks the
 * manifest's signature against the release keys this nxis carries and the tarball against the
 * manifest, unpacks it next to the running one and switches the `current` link in one step: it
 * never runs a downloaded script. The version that ran the update stays, so `--to` goes back.
 * Homebrew, npm and a source checkout are updated by their own tools; for those, and with
 * `--check`, this only says whether a newer version is out and the command that gets it.
 */

import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import type { Ctx } from "../context.js";
import { CliError, ExitCode } from "../errors.js";
import { compareVersions, installation, releasesUrl, updateHint } from "../installation.js";
import { bold, dim } from "../output.js";
import { installRelease, latestRelease, ReleaseError, VERSION_PATTERN, type ReleaseSource } from "../release.js";
import { packageVersion } from "../self.js";

export interface UpdateArgs {
  /** Only say whether a newer version is out. */
  check?: boolean;
  /** Install this version instead, newer or older. */
  to?: string;
  /** A folder holding a release's files (what `gh release download` writes), instead of downloading. */
  from?: string;
}

/** Runs `nxis update`. */
export async function cmdUpdate(ctx: Ctx, args: UpdateArgs): Promise<void> {
  const { io } = ctx;
  const current = packageVersion();
  const inst = installation();
  const wanted = args.to?.replace(/^v/, "");
  if (wanted !== undefined && !VERSION_PATTERN.test(wanted)) {
    throw new CliError(`"${args.to}" isn't a version, such as 0.2.0.`, { reason: "invalid_version" });
  }

  let source: ReleaseSource;
  try {
    source = args.from ? { from: resolve(args.from) } : { url: releasesUrl(inst) };
  } catch (e) {
    throw new CliError((e as Error).message, { reason: "insecure_releases_url" });
  }

  // The latest version, from its signed manifest. For an install nxis doesn't update itself, a
  // lookup that fails still gets the command that updates it.
  let latest = wanted;
  if (latest === undefined) {
    try {
      latest = (await latestRelease(source)).version;
    } catch (e) {
      if (inst.kind === "installer" || args.check) {
        const bad = e instanceof ReleaseError && !e.retryable;
        throw new CliError(`Couldn't check for a new version: ${(e as Error).message}`, {
          reason: bad ? "unverified_release" : "update_check_failed",
        });
      }
    }
  }
  const newer = latest !== undefined && compareVersions(latest, current) > 0;

  if (args.check || inst.kind !== "installer") {
    const how = updateHint(inst, latest);
    io.emit(
      { ok: true, installed_by: inst.kind, current, latest: latest ?? null, update_available: newer, how },
      () => {
        if (latest === undefined) return `nxis ${current}. To update it: ${bold(how)}`;
        if (!newer) return `nxis ${current} is the latest.`;
        return `nxis ${bold(latest)} is out (you have ${current}). Update with: ${bold(how)}`;
      },
    );
    return;
  }
  if (!wanted && !newer) {
    io.emit({ ok: true, installed_by: inst.kind, current, latest, updated: false }, () => `nxis ${current} is the latest.`);
    return;
  }

  const target = latest as string;
  try {
    await installRelease({
      source,
      version: target,
      dir: inst.dir,
      bin: inst.bin,
      url: inst.url,
      keep: [current],
      log: (s) => io.note(s),
    });
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    // A release that fails its checks isn't something to retry into; a failed download is.
    const bad = e instanceof ReleaseError && !e.retryable;
    throw new CliError(`The update to ${target} didn't finish (${why}). nxis ${current} is still installed.`, {
      reason: bad ? "unverified_release" : "update_failed",
    });
  }

  const now = execFileSync(inst.bin, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
  if (now !== target) {
    throw new CliError(`Installed ${target}, but nxis now reports ${now}. Run the installer again to repair it.`, {
      exitCode: ExitCode.ERROR,
      reason: "update_failed",
    });
  }
  io.emit({ ok: true, installed_by: inst.kind, previous: current, current: now, updated: true }, () =>
    [
      `Updated nxis ${current} → ${bold(now)}`,
      dim(`The previous version stays in ${join(inst.dir, "versions", current)}; \`nxis update --to ${current}\` goes back.`),
    ].join("\n"),
  );
}
