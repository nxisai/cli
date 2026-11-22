/**
 * Release notes come from CHANGELOG.md, and become the release's commit message in the public
 * mirror, so a version without a section must be an error.
 */

import { describe, expect, it } from "vitest";
// @ts-expect-error -- a plain .mjs script, without type declarations
import { releaseNotes } from "../scripts/release-notes.mjs";

const changelog = `# Changelog

## [Unreleased]
- next

## [0.1.0-beta.2] - 2026-10-20
### Fixed
- two

## [0.1.0-beta.1] - 2026-10-18
- one
`;

describe("releaseNotes", () => {
  it("returns one version's section, without its heading", () => {
    expect(releaseNotes(changelog, "0.1.0-beta.2")).toBe("### Fixed\n- two");
    expect(releaseNotes(changelog, "0.1.0-beta.1")).toBe("- one");
  });

  it("is null for a version with no section", () => {
    expect(releaseNotes(changelog, "0.2.0")).toBeNull();
  });

  it("does not match a version that only starts the same way", () => {
    expect(releaseNotes(changelog, "0.1.0-beta")).toBeNull();
    expect(releaseNotes(changelog, "0.1.0")).toBeNull();
  });
});
