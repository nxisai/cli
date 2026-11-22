/**
 * Storing credentials without putting them on a command line.
 *
 * Arguments are visible to every user on the machine through `ps`, so the keychain write sends the
 * payload on stdin, hex-encoded, instead of with `-w`.
 */

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { keychainAddCommand } from "../src/credentials.js";

const payload = JSON.stringify({ accessToken: "eyJ.a\"b'c d", refreshToken: "r$x`y" });

describe("keychainAddCommand", () => {
  it("carries the payload only as hex", () => {
    const line = keychainAddCommand("svc", "acct", payload);
    expect(line).not.toContain("eyJ");
    const hex = /-X ([0-9a-f]+)\n$/.exec(line)?.[1] ?? "";
    expect(Buffer.from(hex, "hex").toString("utf8")).toBe(payload);
  });
});

// The real keychain, on a throwaway entry. Only on a Mac, and never in CI.
describe.skipIf(process.platform !== "darwin" || Boolean(process.env.CI))("security -i round trip", () => {
  it("stores and reads back the payload exactly", () => {
    const service = `nxis-cli-test-${process.pid}`;
    try {
      spawnSync("security", ["-i"], { input: keychainAddCommand(service, "default", payload) });
      const out = spawnSync("security", ["find-generic-password", "-s", service, "-a", "default", "-w"], { encoding: "utf8" });
      expect(out.stdout.trim()).toBe(payload);
    } finally {
      spawnSync("security", ["delete-generic-password", "-s", service, "-a", "default"]);
    }
  });
});
