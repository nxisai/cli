#!/usr/bin/env node
/**
 * Prints one version's section of CHANGELOG.md.
 *
 * @remarks
 * The section is the release's commit message in the public mirror, so a version without one is
 * an error rather than an empty message.
 *
 * @example
 * ```sh
 * node scripts/release-notes.mjs 0.1.0-beta.1
 * ```
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @param {string} changelog - The changelog's text.
 * @param {string} version - A version, without a leading `v`.
 * @returns {string | null} The section's body, trimmed, or null when there is none.
 */
export function releaseNotes(changelog, version) {
  const lines = changelog.split("\n");
  const heading = new RegExp(`^## \\[?${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]?(\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  return body || null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = (process.argv[2] ?? "").replace(/^v/, "");
  if (!version) {
    console.error("usage: release-notes.mjs <version>");
    process.exit(2);
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const notes = releaseNotes(readFileSync(resolve(root, "CHANGELOG.md"), "utf8"), version);
  if (!notes) {
    console.error(`release-notes: CHANGELOG.md has no section for ${version}.`);
    process.exit(1);
  }
  process.stdout.write(`${notes}\n`);
}
