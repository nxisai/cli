/**
 * The `login --web` loopback callback, and server text reaching the terminal.
 *
 * The callback port is reachable by anything on this machine, so only the identity provider's
 * redirect — the callback path with this sign-in's state — may end the sign-in.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loginViaBrowser } from "../src/auth.js";
import { resolveConfig } from "../src/config.js";
import { plainText } from "../src/output.js";

describe("plainText", () => {
  it("removes escape sequences and other control characters", () => {
    expect(plainText("bad\u001b[2J\u001b]0;pwned\u0007 request\r\nnext")).toBe("bad [2J ]0;pwned request next");
    expect(plainText("not an owner of this organization")).toBe("not an owner of this organization");
  });
});

describe("loginViaBrowser callback", () => {
  let saved: NodeJS.ProcessEnv;
  let stderr: string[];

  beforeEach(() => {
    saved = { ...process.env };
    process.env["NXIS_NO_BROWSER"] = "1";
    process.env["NXIS_AUTH_CLIENT_ID"] = "test-client-id-0000";
    stderr = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = saved;
  });

  async function start() {
    const pending = loginViaBrowser(resolveConfig({ api: "production" }));
    let settled = false;
    pending.then(() => (settled = true), () => (settled = true));
    await vi.waitFor(() => expect(stderr.join("")).toContain("authorize?"));
    const authorize = new URL(/https:\/\/\S+authorize\?\S+/.exec(stderr.join(""))?.[0] ?? "");
    const redirect = new URL(authorize.searchParams.get("redirect_uri") ?? "");
    const state = authorize.searchParams.get("state") ?? "";
    return { pending, isSettled: () => settled, base: `${redirect.origin}`, state };
  }

  it("ignores requests without this sign-in's state, including ones carrying an error", async () => {
    const { pending, isSettled, base, state } = await start();

    expect((await fetch(`${base}/callback?error=access_denied&state=wrong`)).status).toBe(404);
    expect((await fetch(`${base}/callback?error=access_denied`)).status).toBe(404);
    expect((await fetch(`${base}/elsewhere?error=access_denied&state=${state}`)).status).toBe(404);
    expect(isSettled()).toBe(false);

    // The real redirect still works afterwards.
    const res = await fetch(`${base}/callback?error=access_denied&error_description=${encodeURIComponent("no\u001b[2J")}&state=${state}`);
    expect(res.status).toBe(200);
    await expect(pending).rejects.toMatchObject({ reason: "access_denied", message: "no [2J" });
  });
});
