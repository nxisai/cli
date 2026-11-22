/**
 * The small amount of state worth remembering between invocations.
 *
 * @remarks
 * Deliberately not secrets — those live in the keychain. This is the active organization and
 * site, and which environment the user pointed at, so an agent running a sequence of commands
 * doesn't have to thread `--org` and `--site` through every one of them.
 */

import { readFileSync } from "node:fs";
import { settingsPath } from "./config.js";
import { writePrivateFile } from "./files.js";

/**
 * The site site-scoped commands act on by default.
 *
 * @remarks
 * Saved with the organization it belongs to, because a site id means nothing in another
 * organization: after switching, the saved site would name a site the provisioning endpoint
 * cannot find, or worse, one with the same domain that belongs to someone else's setup.
 */
export interface SavedSite {
  /** The site's id, as the provisioning tools return it. */
  id: string;
  /** The organization the site belongs to. */
  orgId: string;
  /** The site's domain, for display. */
  domain?: string;
}

/** Settings saved between invocations. */
export interface Settings {
  /** The organization commands act on by default. */
  activeOrg?: string;
  /** The site commands act on by default, within {@link Settings.activeOrg}. */
  activeSite?: SavedSite;
  /** The base URL last passed with `--api`, so later commands keep using it. */
  api?: string;
  /** The profile name last used, for display. */
  profile?: string;
}

/** @returns Saved settings, or an empty object when none are readable. */
export function loadSettings(): Settings {
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath(), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Settings) : {};
  } catch {
    return {};
  }
}

/** Replaces the saved settings. */
export function saveSettings(next: Settings): void {
  writePrivateFile(settingsPath(), `${JSON.stringify(next, null, 2)}\n`, { privateDir: true });
}

/** Merges a patch into the saved settings and returns the result. */
export function updateSettings(patch: Partial<Settings>): Settings {
  const merged = { ...loadSettings(), ...patch };
  saveSettings(merged);
  return merged;
}

/**
 * Saves the organization commands act on by default.
 *
 * @remarks
 * A saved site from any other organization is forgotten in the same write, so switching
 * organizations can never leave a site from the previous one selected.
 */
export function saveActiveOrg(orgId: string): Settings {
  const current = loadSettings();
  const keepSite = current.activeSite?.orgId === orgId;
  return updateSettings({ activeOrg: orgId, activeSite: keepSite ? current.activeSite : undefined });
}

/**
 * Saves the site commands act on by default, for `nxis sites use` and `nxis sites create`.
 *
 * @param site - The site and the organization it belongs to.
 */
export function saveActiveSite(site: SavedSite): Settings {
  return updateSettings({
    activeSite: { id: site.id, orgId: site.orgId, ...(site.domain ? { domain: site.domain } : {}) },
  });
}

/** Forgets the saved site. */
export function clearActiveSite(): Settings {
  return updateSettings({ activeSite: undefined });
}
