/**
 * `nxis orgs create` requires a name, because what it creates is marked onboarded.
 */

import { describe, expect, it } from "vitest";
import { cmdOrgsCreate } from "../src/commands/orgs.js";
import { resolveConfig } from "../src/config.js";
import type { Ctx } from "../src/context.js";
import { CliError, ExitCode } from "../src/errors.js";
import { createIo } from "../src/output.js";

const ctx: Ctx = { config: resolveConfig({ api: "https://api.example.test" }), io: createIo(true) };

/** Runs `orgs create` and returns what it threw, or null. */
async function reasonFor(name: string | undefined) {
  try {
    await cmdOrgsCreate(ctx, name === undefined ? {} : { name });
    return null;
  } catch (err) {
    return err;
  }
}

describe("orgs create without a name", () => {
  it("asks the user for one — exit 2, not a failure", async () => {
    const err = await reasonFor(undefined);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).reason).toBe("org_name_required");
    expect((err as CliError).exitCode).toBe(ExitCode.NEEDS_USER);
  });

  it("treats a blank name as missing", async () => {
    expect(((await reasonFor("   ")) as CliError).reason).toBe("org_name_required");
  });

  /** Checked before sign-in, so it fails fast and never touches the network. */
  it("refuses before looking for a session", async () => {
    const err = (await reasonFor(undefined)) as CliError;
    expect(err.reason).not.toBe("signed_out");
  });
});
