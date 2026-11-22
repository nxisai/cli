/**
 * The Auth0 client id is embedded at build time, and a build without one must never be published.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AUTH_CLIENT_ID, resolveConfig } from "../src/config.js";

const script = fileURLToPath(new URL("../scripts/build-config.mjs", import.meta.url));
const VALID = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";

/** Runs the build-config script into a temporary file. */
function run(args: string[], clientId: string | undefined) {
  const out = join(mkdtempSync(join(tmpdir(), "nxis-build-")), "build-config.ts");
  const env = { ...process.env };
  // Both names, or a legacy value in the developer's shell would leak into every case.
  delete env.NXIS_AUTH_CLIENT_ID;
  delete env.NXIS_AUTH0_CLIENT_ID;
  if (clientId !== undefined) env.NXIS_AUTH_CLIENT_ID = clientId;
  const res = spawnSync(process.execPath, [script, "--out", out, ...args], { env, encoding: "utf8" });
  return { status: res.status, out };
}

describe("build-config script", () => {
  it("embeds the client id from the build environment", () => {
    const { status, out } = run([], VALID);
    expect(status).toBe(0);
    expect(readFileSync(out, "utf8")).toContain(`BUILD_CLIENT_ID = "${VALID}"`);
  });

  it("still builds without one, for development", () => {
    const { status, out } = run([], undefined);
    expect(status).toBe(0);
    expect(readFileSync(out, "utf8")).toContain('BUILD_CLIENT_ID = ""');
  });

  /** The publish guard: a package that can't sign anyone in must not ship. */
  it("refuses under --require when the id is missing", () => {
    expect(run(["--require"], undefined).status).toBe(1);
    expect(run(["--require"], "   ").status).toBe(1);
  });

  it("rejects something that isn't a client id", () => {
    expect(run([], "not a client id!").status).toBe(1);
  });

  /**
   * The variable was renamed off the provider's name, so a build does not have to change if the
   * provider does. The old name keeps working until CI and shells are updated.
   */
  it("still accepts the old NXIS_AUTH0_CLIENT_ID, and says it is deprecated", () => {
    const out = join(mkdtempSync(join(tmpdir(), "nxis-build-")), "build-config.ts");
    const env = { ...process.env };
    delete env.NXIS_AUTH_CLIENT_ID;
    env.NXIS_AUTH0_CLIENT_ID = VALID;
    const res = spawnSync(process.execPath, [script, "--out", out], { env, encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(readFileSync(out, "utf8")).toContain(`BUILD_CLIENT_ID = "${VALID}"`);
    expect(res.stderr).toContain("deprecated");
  });

  it("prefers the new name when both are set", () => {
    const out = join(mkdtempSync(join(tmpdir(), "nxis-build-")), "build-config.ts");
    const env = { ...process.env };
    env.NXIS_AUTH_CLIENT_ID = VALID;
    env.NXIS_AUTH0_CLIENT_ID = "ZzZzZzZzZzZzZzZzZzZzZzZzZzZzZzZz";
    const res = spawnSync(process.execPath, [script, "--out", out], { env, encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(readFileSync(out, "utf8")).toContain(`BUILD_CLIENT_ID = "${VALID}"`);
  });
});

describe("runtime override", () => {
  const saved = process.env.NXIS_AUTH_CLIENT_ID;
  afterEach(() => {
    if (saved === undefined) delete process.env.NXIS_AUTH_CLIENT_ID;
    else process.env.NXIS_AUTH_CLIENT_ID = saved;
  });

  it("lets NXIS_AUTH_CLIENT_ID point a build at another client", () => {
    process.env.NXIS_AUTH_CLIENT_ID = VALID;
    expect(resolveConfig({}).auth.clientId).toBe(VALID);
  });

  it("ignores an exported-but-empty variable instead of erasing the embedded id", () => {
    process.env.NXIS_AUTH_CLIENT_ID = "";
    expect(resolveConfig({}).auth.clientId).toBe(AUTH_CLIENT_ID);
  });
});
