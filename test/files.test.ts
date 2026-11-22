/**
 * Files holding secrets end up readable by their owner only, even when they already existed.
 *
 * `writeFileSync`'s `mode` only applies when it creates a file, so a pre-existing `0644` file used
 * to keep its permissions after a key or tokens were written into it.
 */

import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveCredentials } from "../src/credentials.js";
import { writePrivateFile } from "../src/files.js";
import { saveSettings } from "../src/state.js";

const mode = (path: string) => statSync(path).mode & 0o777;

let saved: NodeJS.ProcessEnv;
let dir = "";

beforeEach(() => {
  saved = { ...process.env };
  dir = mkdtempSync(join(tmpdir(), "nxis-files-"));
  process.env["XDG_CONFIG_HOME"] = dir;
  process.env["NXIS_NO_KEYCHAIN"] = "1";
});

afterEach(() => {
  process.env = saved;
});

describe("writePrivateFile", () => {
  it("tightens a file that already existed with looser permissions", () => {
    const path = join(dir, "mcp.json");
    writeFileSync(path, "{}\n", { mode: 0o644 });
    chmodSync(path, 0o644);
    writePrivateFile(path, '{"key":"secret"}\n');
    expect(mode(path)).toBe(0o600);
  });

  it("leaves a directory it does not own alone", () => {
    const project = join(dir, "project");
    mkdirSync(project, { mode: 0o755 });
    chmodSync(project, 0o755);
    writePrivateFile(join(project, ".mcp.json"), "{}\n");
    expect(mode(project)).toBe(0o755);
  });
});

describe("the CLI's own files", () => {
  it("credentials and settings are 0600, in a 0700 directory, even if both existed", () => {
    const config = join(dir, "nxis");
    mkdirSync(config, { mode: 0o755 });
    chmodSync(config, 0o755);
    writeFileSync(join(config, "credentials.json"), "{}", { mode: 0o644 });
    writeFileSync(join(config, "config.json"), "{}", { mode: 0o644 });

    saveCredentials({ accessToken: "t" });
    saveSettings({ activeOrg: "o" });

    expect(mode(config)).toBe(0o700);
    expect(mode(join(config, "credentials.json"))).toBe(0o600);
    expect(mode(join(config, "config.json"))).toBe(0o600);
  });
});
