/**
 * `nxis update` and how the CLI tells its installations apart (src/installation.ts).
 *
 * The end-to-end tests install a signed test release with install.sh into a temporary HOME, then
 * run that install's own `nxis update` against a newer test release on a local server, the way a
 * user would. The releases are signed with a throwaway key (test/support/release-fixture.ts).
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareVersions, DEFAULT_RELEASES_URL, installation, releasesUrl, updateHint } from "../src/installation.js";
import { isSecureUrl } from "../src/release.js";
import { buildRelease, serve, supported, type Release } from "./support/release-fixture.js";

describe("installation", () => {
  it("is the installer's when its launcher says so", () => {
    const env = { NXIS_LAUNCHER: "/h/.local/bin/nxis", NXIS_INSTALL_DIR: "/h/.nxis", NXIS_RELEASES_URL: "http://127.0.0.1:9/" };
    expect(installation(env, "/h/.nxis/current/app/dist/nxis.mjs")).toEqual({
      kind: "installer",
      dir: "/h/.nxis",
      bin: "/h/.local/bin/nxis",
      url: "http://127.0.0.1:9",
    });
    expect(installation({ NXIS_LAUNCHER: "/h/.local/bin/nxis", NXIS_INSTALL_DIR: "/h/.nxis" }, "/x")).toMatchObject({ url: DEFAULT_RELEASES_URL });
  });

  it("is Homebrew's when the formula says so, or by the path", () => {
    expect(installation({ NXIS_INSTALLED_BY: "homebrew", NXIS_LAUNCHER: "/opt/homebrew/opt/nxis/bin/nxis" }, "/x")).toEqual({ kind: "homebrew" });
    expect(installation({}, "/opt/homebrew/Cellar/nxis/0.2.0/libexec/app/dist/nxis.mjs")).toEqual({ kind: "homebrew" });
  });

  it("is npm's or npx's from node_modules, and a checkout otherwise", () => {
    expect(installation({}, "/usr/local/lib/node_modules/@nxisai/cli/dist/cli.js")).toEqual({ kind: "npm", npx: false });
    expect(installation({}, "/h/.npm/_npx/abc/node_modules/@nxisai/cli/dist/cli.js")).toEqual({ kind: "npm", npx: true });
    expect(installation({}, "/src/cli/dist/cli.js")).toEqual({ kind: "source", path: "/src/cli/dist" });
  });

  it("says how each one updates", () => {
    expect(updateHint({ kind: "installer", dir: "", bin: "", url: "" })).toBe("nxis update");
    expect(updateHint({ kind: "homebrew" })).toBe("brew upgrade nxis");
    expect(updateHint({ kind: "npm", npx: false }, "0.2.0")).toBe("npm install -g @nxisai/cli@0.2.0");
    expect(updateHint({ kind: "npm", npx: false })).toBe("npm install -g @nxisai/cli@latest");
    expect(updateHint({ kind: "npm", npx: true }, "0.2.0")).toBe("npx -y @nxisai/cli@0.2.0");
  });

  it("looks for releases over https, or http to this machine only", () => {
    expect(releasesUrl({ kind: "npm", npx: false }, {})).toBe(DEFAULT_RELEASES_URL);
    expect(releasesUrl({ kind: "npm", npx: false }, { NXIS_RELEASES_URL: "http://localhost:8080/" })).toBe("http://localhost:8080");
    expect(() => releasesUrl({ kind: "npm", npx: false }, { NXIS_RELEASES_URL: "http://example.com" })).toThrow(/https only/);
    expect(isSecureUrl("file:///etc/passwd")).toBe(false);
  });

  it("orders versions, pre-releases before their release", () => {
    expect(compareVersions("0.1.0-beta.2", "0.1.0-beta.10")).toBeLessThan(0);
    expect(compareVersions("0.1.0", "0.1.0-beta.10")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
  });
});

describe.skipIf(!supported)("nxis update, installed by install.sh", () => {
  const NEWER = "99.0.0";
  let release: Release;
  let server: Awaited<ReturnType<typeof serve>>;
  let home: string;

  /** Runs a command without blocking this process, which serves the release meanwhile. */
  const run = (cmd: string, args: string[], env: Record<string, string> = {}) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(cmd, args, {
        env: { HOME: home, PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(":"), SHELL: "/bin/sh", ...env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  const nxis = (...args: string[]) => run(join(home, ".local/bin/nxis"), args);

  beforeAll(async () => {
    release = buildRelease();
    server = await serve(release.out);
    home = mkdtempSync(join(tmpdir(), "nxis-update-home-"));
    // Installed while it is the latest; the newer version is published after.
    const r = await run("sh", [join(release.out, "download", `v${release.version}`, "install.sh")], {
      NXIS_RELEASES_URL: server.url,
      NXIS_NO_MODIFY_PATH: "1",
    });
    if (r.status !== 0) throw new Error(r.stderr);
  }, 240_000);

  afterAll(async () => {
    await server?.close();
    release?.remove();
    rmSync(home, { recursive: true, force: true });
  });

  it("says it is the latest while it is", async () => {
    const r = await nxis("update", "--json");
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ ok: true, installed_by: "installer", current: release.version, latest: release.version, updated: false });
  });

  it("installs a newer signed release in place, keeping the one it replaced", async () => {
    release.buildVersion(NEWER);

    const check = await nxis("update", "--check", "--json");
    expect(JSON.parse(check.stdout)).toMatchObject({ current: release.version, latest: NEWER, update_available: true, how: "nxis update" });

    const r = await nxis("update", "--json");
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ ok: true, installed_by: "installer", previous: release.version, current: NEWER, updated: true });
    expect(readlinkSync(join(home, ".nxis/current"))).toBe(join("versions", NEWER));
    expect(readdirSync(join(home, ".nxis/versions")).sort()).toEqual([release.version, NEWER].sort());
    expect((await nxis("--version")).stdout.trim()).toBe(NEWER);
  }, 120_000);

  it("goes back with --to", async () => {
    const r = await nxis("update", "--to", release.version, "--json");
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ previous: NEWER, current: release.version, updated: true });
    expect((await nxis("--version")).stdout.trim()).toBe(release.version);
  });

  it("refuses a version that isn't released", async () => {
    const r = await nxis("update", "--to", "98.0.0", "--json");
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, reason: "update_failed" });
    expect((await nxis("--version")).stdout.trim()).toBe(release.version);
  });

  it("writes the launcher, not the versioned bundle, into an agent's config", async () => {
    const r = await nxis("mcp", "install", "--agent", "mcp-json", "--print", "--json");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(JSON.stringify(join(home, ".local/bin/nxis")));
    expect(r.stdout).not.toContain("versions/");
  });
});
