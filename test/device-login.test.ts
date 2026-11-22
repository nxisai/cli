/**
 * The device flow's polling: what a refused sign-in reports.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { pollForDeviceToken } from "../src/auth.js";
import { resolveConfig } from "../src/config.js";

const config = resolveConfig({ api: "https://api.example.test" });
const grant = {
  device_code: "device",
  user_code: "ABCD-EFGH",
  verification_uri: "https://auth.example.test/activate",
  expires_in: 60,
  interval: 0,
};

/** Stub fetch so the token endpoint answers with this Auth0 error body. */
function refuse(body: Record<string, string>): void {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status: 403 }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pollForDeviceToken", () => {
  it("gives Auth0's reason when the sign-in is refused", async () => {
    refuse({ error: "access_denied", error_description: "Email not verified\u001b[2J" });
    await expect(pollForDeviceToken(config, grant)).rejects.toMatchObject({
      reason: "access_denied",
      exitCode: 3,
      message: "Sign-in was declined: Email not verified [2J",
      details: { provider_description: "Email not verified [2J" },
    });
  });

  it("falls back to the plain message when Auth0 gives no description", async () => {
    refuse({ error: "access_denied" });
    await expect(pollForDeviceToken(config, grant)).rejects.toMatchObject({
      reason: "access_denied",
      message: "Sign-in was declined in the browser.",
    });
  });
});
