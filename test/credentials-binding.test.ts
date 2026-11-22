/**
 * Stored credentials go only to the endpoints they were obtained for.
 *
 * Before this, one `--api` pointed anywhere sent the stored token there on that command and,
 * because `--api` is saved, on every command after it.
 */

import { describe, expect, it } from "vitest";
import { credentialsMatch } from "../src/auth.js";
import { ENDPOINT_ENV_VARS, endpointKey, PRODUCTION_ENDPOINTS, resolveConfig, singleHost } from "../src/config.js";

/**
 * Resolves with the per-service variables cleared. They override `--api`, so one exported in the
 * shell running the tests (`NXIS_MCP_URL`, say) would otherwise move "production" off production.
 */
function resolveClean(api: string) {
  const saved = Object.values(ENDPOINT_ENV_VARS).map((name) => [name, process.env[name]] as const);
  for (const [name] of saved) delete process.env[name];
  try {
    return resolveConfig({ api });
  } finally {
    for (const [name, value] of saved) if (value !== undefined) process.env[name] = value;
  }
}

const production = resolveClean("production");
const local = resolveClean("http://localhost:8787");

describe("credentialsMatch", () => {
  it("accepts credentials on the endpoints they came from", () => {
    expect(credentialsMatch({ accessToken: "t", endpoints: endpointKey(PRODUCTION_ENDPOINTS) }, production)).toBe(true);
    expect(credentialsMatch({ accessToken: "t", endpoints: endpointKey(singleHost("http://localhost:8787")) }, local)).toBe(true);
  });

  it("refuses production credentials anywhere else", () => {
    expect(credentialsMatch({ accessToken: "t", endpoints: endpointKey(PRODUCTION_ENDPOINTS) }, local)).toBe(false);
  });

  it("accepts credentials saved before the sites endpoint existed", () => {
    // The key those sign-ins stored: four hosts, no sites.
    const before = (e: { accounts: string; billing: string; authorization: string; mcp: string }) =>
      [e.accounts, e.billing, e.authorization, e.mcp].join(" ");
    expect(credentialsMatch({ accessToken: "t", endpoints: before(PRODUCTION_ENDPOINTS) }, production)).toBe(true);
    expect(credentialsMatch({ accessToken: "t", endpoints: before(singleHost("http://localhost:8787")) }, local)).toBe(true);
  });

  it("refuses credentials when the sites endpoint points somewhere else", () => {
    const elsewhere = { ...production, endpoints: { ...PRODUCTION_ENDPOINTS, sites: "https://sites.example.test" } };
    expect(credentialsMatch({ accessToken: "t", endpoints: endpointKey(PRODUCTION_ENDPOINTS) }, elsewhere)).toBe(false);
  });

  it("accepts credentials saved before the binding existed in production only", () => {
    expect(credentialsMatch({ accessToken: "t" }, production)).toBe(true);
    expect(credentialsMatch({ accessToken: "t" }, local)).toBe(false);
  });
});
