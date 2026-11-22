/**
 * Boolean flags must not swallow the word after them.
 *
 * `--json orgs list` used to set `json` to `"orgs"`, which turned JSON output off and left
 * `list` as the command, so it failed as unknown. Only flags written after the positional
 * arguments worked. Exercised through the built binary, since the parser is internal.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

/** Runs the built CLI, returning stdout and the exit code. */
function run(args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      env: { ...process.env, NXIS_API: "https://api.invalid.test" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { out: e.stdout ?? "", code: e.status ?? 1 };
  }
}

describe.skipIf(!existsSync(cli))("boolean flags before the command", () => {
  it("keeps --json as a flag rather than eating the command", () => {
    // Signed out is fine — what matters is that it parsed as JSON and reached a command.
    const { out } = run(["--json", "whoami"]);
    expect(out.trim().startsWith("{")).toBe(true);
    expect(out).not.toContain("Unknown command");
  });

  it("keeps --verbose as a flag", () => {
    const { out } = run(["--verbose", "--json", "whoami"]);
    expect(out).not.toContain("Unknown command");
  });

  it("still accepts a value flag written the same way", () => {
    const { out } = run(["--api", "not-a-url", "--json", "whoami"]);
    expect(out).toContain("invalid_api_url");
  });
});

describe.skipIf(!existsSync(cli))("--version", () => {
  it("prints the package version, not the help, when given without a command", () => {
    const { out, code } = run(["--version"]);
    expect(code).toBe(0);
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
  });
});
