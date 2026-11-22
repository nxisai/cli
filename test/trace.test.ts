/**
 * What `--verbose` is allowed to print, and what `--dry-run` refuses to send.
 *
 * The redaction cases are the ones that matter: this feature exists so someone can watch what
 * the CLI does with their credentials, and it would be a poor answer if watching leaked them.
 */

import { afterEach, describe, expect, it } from "vitest";
import { isDryRun, isVerbose, redactBody, redactHeaders, setTrace } from "../src/trace.js";

afterEach(() => setTrace({ verbose: false, dryRun: false }));

describe("redactHeaders", () => {
  it("removes a bearer token but keeps the scheme", () => {
    expect(redactHeaders({ authorization: "bearer eyJhbGciOi.secret.parts" })).toEqual({
      authorization: "bearer <redacted>",
    });
  });

  it("removes an API key header entirely", () => {
    // A made-up key; the marker keeps the mirror's secret scan from flagging it.
    expect(redactHeaders({ "nxis-api-key": "nxis_live_abc123" })).toEqual({ // gitleaks:allow
      "nxis-api-key": "<redacted>",
    });
  });

  it("is not fooled by capitalisation", () => {
    expect(redactHeaders({ Authorization: "Bearer abc" })).toEqual({ Authorization: "Bearer <redacted>" });
  });

  it("leaves ordinary headers alone, because the point is to show the request", () => {
    expect(redactHeaders({ "content-type": "application/json" })).toEqual({
      "content-type": "application/json",
    });
  });
});

describe("redactBody", () => {
  it("removes the credentials the auth endpoints carry", () => {
    const form = {
      grant_type: "refresh_token",
      client_id: "public-client-id",
      refresh_token: "a-real-refresh-token",
      code_verifier: "pkce-verifier",
    };
    expect(redactBody(form)).toEqual({
      grant_type: "refresh_token",
      // A public client id is not a secret, and hiding it would misrepresent the request.
      client_id: "public-client-id",
      refresh_token: "<redacted>",
      code_verifier: "<redacted>",
    });
  });

  it("reaches secrets nested inside a body", () => {
    expect(redactBody({ organization: { name: "Acme", api_key: "nxis_live_x" } })).toEqual({
      organization: { name: "Acme", api_key: "<redacted>" },
    });
  });

  it("keeps the shape of a request that has nothing to hide", () => {
    const body = { organization: { name: "Acme", website: "https://acme.test", onboarded: true } };
    expect(redactBody(body)).toEqual(body);
  });

  it("handles arrays and primitives without losing them", () => {
    expect(redactBody({ roles: ["OWNER"], count: 2, nothing: null })).toEqual({
      roles: ["OWNER"],
      count: 2,
      nothing: null,
    });
  });
});

describe("setTrace", () => {
  it("is off until asked", () => {
    expect(isVerbose()).toBe(false);
    expect(isDryRun()).toBe(false);
  });

  it("turns verbose on for a dry run, since watching nothing happen is the point", () => {
    setTrace({ dryRun: true });
    expect(isDryRun()).toBe(true);
    expect(isVerbose()).toBe(true);
  });

  it("allows verbose without a dry run", () => {
    setTrace({ verbose: true });
    expect(isVerbose()).toBe(true);
    expect(isDryRun()).toBe(false);
  });
});
