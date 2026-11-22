/**
 * Which site a command acts on: `--site`, else the saved site, but only within its organization.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { currentSite, requireSite, withSite, type Ctx } from "../src/context.js";
import { CliError, ExitCode } from "../src/errors.js";
import { createIo } from "../src/output.js";
import { loadSettings, saveActiveOrg, saveActiveSite, updateSettings } from "../src/state.js";

let dir: string;
const savedXdg = process.env.XDG_CONFIG_HOME;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nxis-site-"));
  process.env.XDG_CONFIG_HOME = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
});

/** A context, with optional `--org` and `--site`. */
function ctx(overrides: Partial<Pick<Ctx, "orgOverride" | "siteOverride">> = {}): Ctx {
  return { config: resolveConfig({ api: "https://api.example.test" }), io: createIo(true), ...overrides };
}

describe("currentSite", () => {
  it("is null with nothing saved", () => {
    expect(currentSite(ctx())).toBeNull();
  });

  it("uses the saved site in its own organization", () => {
    saveActiveOrg("org-1");
    saveActiveSite({ id: "site-1", orgId: "org-1", domain: "example.com" });
    expect(currentSite(ctx())).toBe("site-1");
  });

  it("lets --site win", () => {
    saveActiveOrg("org-1");
    saveActiveSite({ id: "site-1", orgId: "org-1" });
    expect(currentSite(ctx({ siteOverride: "other.example" }))).toBe("other.example");
  });

  it("ignores the saved site when --org points at another organization", () => {
    saveActiveOrg("org-1");
    saveActiveSite({ id: "site-1", orgId: "org-1" });
    expect(currentSite(ctx({ orgOverride: "org-2" }))).toBeNull();
  });
});

describe("switching organization", () => {
  it("forgets a saved site from the previous organization", () => {
    saveActiveOrg("org-1");
    saveActiveSite({ id: "site-1", orgId: "org-1" });
    saveActiveOrg("org-2");
    expect(loadSettings().activeSite).toBeUndefined();
    expect(loadSettings().activeOrg).toBe("org-2");
  });

  it("keeps it when the organization does not change", () => {
    saveActiveOrg("org-1");
    saveActiveSite({ id: "site-1", orgId: "org-1" });
    saveActiveOrg("org-1");
    expect(loadSettings().activeSite?.id).toBe("site-1");
  });

  it("leaves other settings alone", () => {
    updateSettings({ api: "http://localhost:8787" });
    saveActiveOrg("org-1");
    expect(loadSettings().api).toBe("http://localhost:8787");
  });
});

describe("requireSite", () => {
  it("asks the user to pick one — exit 2, not a failure", () => {
    try {
      requireSite(ctx());
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).reason).toBe("no_active_site");
      expect((err as CliError).exitCode).toBe(ExitCode.NEEDS_USER);
    }
  });
});

describe("withSite", () => {
  it("fills in the current site", () => {
    expect(withSite(ctx({ siteOverride: "example.com" }), { mode: "token" })).toEqual({ mode: "token", site: "example.com" });
  });

  it("keeps a site given explicitly", () => {
    expect(withSite(ctx({ siteOverride: "example.com" }), { site: "other.example" })).toEqual({ site: "other.example" });
  });

  it("leaves site out when there is none, so the endpoint's own default applies", () => {
    expect(withSite(ctx(), { mode: "token" })).toEqual({ mode: "token" });
  });

  it("throws when a site is required and there is none", () => {
    expect(() => withSite(ctx(), {}, { required: true })).toThrow(CliError);
  });
});
