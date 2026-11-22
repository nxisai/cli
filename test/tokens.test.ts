/**
 * Reading claims and expiry from an access token.
 */

import { describe, expect, it } from "vitest";
import { accountIdFromClaims, decodeJwt, emailFromClaims, isExpired } from "../src/tokens.js";

/** Builds an unsigned JWT with the given payload. */
function makeToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature-not-checked`;
}

describe("decodeJwt", () => {
  it("reads the payload", () => {
    expect(decodeJwt(makeToken({ sub: "auth0|1" }))?.sub).toBe("auth0|1");
  });

  it("returns null for something that is not a token", () => {
    expect(decodeJwt("nonsense")).toBeNull();
    expect(decodeJwt("")).toBeNull();
  });
});

describe("accountIdFromClaims", () => {
  /**
   * The claim is nested three deep and the id is itself an object. Reading any shorter path
   * yields an object, which stringifies into a URL that 404s.
   */
  it("reads the nxis.ai namespace", () => {
    const payload = decodeJwt(
      makeToken({ "https://nxis.ai/user_data": { account: { _id: { value: "acc123" } } } }),
    );
    expect(accountIdFromClaims(payload)).toBe("acc123");
  });

  it("falls back to the legacy codified.dev namespace", () => {
    const payload = decodeJwt(
      makeToken({ "https://codified.dev/user_data": { account: { _id: { value: "legacy1" } } } }),
    );
    expect(accountIdFromClaims(payload)).toBe("legacy1");
  });

  it("prefers the current namespace when both are present", () => {
    const payload = decodeJwt(
      makeToken({
        "https://nxis.ai/user_data": { account: { _id: { value: "current" } } },
        "https://codified.dev/user_data": { account: { _id: { value: "legacy" } } },
      }),
    );
    expect(accountIdFromClaims(payload)).toBe("current");
  });

  /** A brand-new signup can arrive without the claim; that is a refresh, not a crash. */
  it("returns null when the claim has not been added yet", () => {
    expect(accountIdFromClaims(decodeJwt(makeToken({ sub: "auth0|1" })))).toBeNull();
    expect(accountIdFromClaims(decodeJwt(makeToken({ "https://nxis.ai/user_data": {} })))).toBeNull();
  });
});

describe("emailFromClaims", () => {
  it("prefers a top-level email claim", () => {
    expect(emailFromClaims(decodeJwt(makeToken({ email: "a@example.com" })))).toBe("a@example.com");
  });

  it("falls back to the profile inside user_data", () => {
    const payload = decodeJwt(
      makeToken({ "https://nxis.ai/user_data": { account: { profile: { email: "c@example.com" } } } }),
    );
    expect(emailFromClaims(payload)).toBe("c@example.com");
  });
});

describe("isExpired", () => {
  it("treats a token without an expiry as expired", () => {
    expect(isExpired(decodeJwt(makeToken({})))).toBe(true);
  });

  it("refreshes slightly early rather than serving one doomed request", () => {
    const almostGone = Math.floor(Date.now() / 1000) + 30;
    expect(isExpired(decodeJwt(makeToken({ exp: almostGone })))).toBe(true);
  });

  it("accepts a token with real time left", () => {
    const later = Math.floor(Date.now() / 1000) + 3600;
    expect(isExpired(decodeJwt(makeToken({ exp: later })))).toBe(false);
  });
});
