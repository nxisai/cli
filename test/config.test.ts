/**
 * Endpoint resolution: production defaults, the shared base URL, and per-service overrides.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENDPOINT_ENV_VARS, PRODUCTION_ENDPOINTS, endpointKey, isLoopback, resolveConfig, singleHost } from "../src/config.js";

/** Every variable that affects endpoint resolution, cleared before each test. */
const ENDPOINT_VARS = ["NXIS_API", "NXIS_PROFILE", ...Object.values(ENDPOINT_ENV_VARS)];

const BASE = "https://api.example.test";

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  for (const name of ENDPOINT_VARS) delete process.env[name];
});

afterEach(() => {
  for (const name of Object.keys(process.env)) {
    if (!(name in savedEnv)) delete process.env[name];
  }
  Object.assign(process.env, savedEnv);
});

describe("production endpoints", () => {
  it("uses a distinct host per service", () => {
    expect(PRODUCTION_ENDPOINTS.accounts).toBe("https://accounts.nxis.ai");
    expect(PRODUCTION_ENDPOINTS.billing).toBe("https://subscriptions.nxis.ai");
    expect(PRODUCTION_ENDPOINTS.authorization).toBe("https://authorization.nxis.ai");
    expect(PRODUCTION_ENDPOINTS.mcp).toBe("https://mcp.nxis.ai");
    expect(PRODUCTION_ENDPOINTS.sites).toBe("https://sites.nxis.ai");
  });

  it("never shares one host across services", () => {
    expect(new Set(Object.values(PRODUCTION_ENDPOINTS)).size).toBe(5);
  });
});

describe("singleHost", () => {
  it("points every service at one base URL", () => {
    expect(singleHost(BASE)).toEqual({
      accounts: BASE,
      billing: BASE,
      authorization: BASE,
      mcp: BASE,
      sites: BASE,
    });
  });

  it("trims trailing slashes", () => {
    expect(singleHost(`${BASE}//`).billing).toBe(BASE);
  });
});

describe("resolveConfig", () => {
  it("uses production hosts when nothing is set", () => {
    const config = resolveConfig({});
    expect(config.isProduction).toBe(true);
    expect(config.profile).toBe("production");
    expect(config.endpoints).toEqual(PRODUCTION_ENDPOINTS);
  });

  /** `mcp install` chooses live or development keys from `isProduction`, so any override must clear it. */
  it("stops being production when --api is given", () => {
    const config = resolveConfig({ api: BASE });
    expect(config.isProduction).toBe(false);
    expect(config.profile).toBe("custom");
    expect(config.endpoints).toEqual(singleHost(BASE));
  });

  it("uses NXIS_API for every service", () => {
    process.env.NXIS_API = BASE;
    const config = resolveConfig({});
    expect(config.isProduction).toBe(false);
    expect(config.endpoints).toEqual(singleHost(BASE));
  });

  it("prefers --api over NXIS_API, and NXIS_API over the saved setting", () => {
    process.env.NXIS_API = "https://env.example.test";
    expect(resolveConfig({ api: BASE, saved: { api: "https://saved.example.test" } }).endpoints.billing).toBe(BASE);
    expect(resolveConfig({ saved: { api: "https://saved.example.test" } }).endpoints.billing).toBe(
      "https://env.example.test",
    );
  });

  it("uses the saved base URL when nothing else is set", () => {
    const config = resolveConfig({ saved: { api: "https://saved.example.test" } });
    expect(config.isProduction).toBe(false);
    expect(config.endpoints.accounts).toBe("https://saved.example.test");
  });

  it("trims trailing slashes from the shared base URL", () => {
    expect(resolveConfig({ api: `${BASE}/` }).endpoints.mcp).toBe(BASE);
  });
});

describe("per-service overrides", () => {
  it("override only their own service and leave the rest on production", () => {
    process.env.NXIS_BILLING_URL = "https://billing.example.test";
    const { endpoints } = resolveConfig({});
    expect(endpoints.billing).toBe("https://billing.example.test");
    expect(endpoints.accounts).toBe(PRODUCTION_ENDPOINTS.accounts);
    expect(endpoints.authorization).toBe(PRODUCTION_ENDPOINTS.authorization);
    expect(endpoints.mcp).toBe(PRODUCTION_ENDPOINTS.mcp);
  });

  it("take precedence over --api and NXIS_API", () => {
    process.env.NXIS_API = "https://env.example.test";
    process.env.NXIS_ACCOUNTS_URL = "https://accounts.example.test";
    process.env.NXIS_MCP_URL = "https://mcp.example.test";
    const { endpoints } = resolveConfig({ api: BASE });
    expect(endpoints.accounts).toBe("https://accounts.example.test");
    expect(endpoints.mcp).toBe("https://mcp.example.test");
    expect(endpoints.billing).toBe(BASE);
    expect(endpoints.authorization).toBe(BASE);
  });

  it("each map to the matching service", () => {
    process.env.NXIS_ACCOUNTS_URL = "https://a.example.test";
    process.env.NXIS_BILLING_URL = "https://b.example.test";
    process.env.NXIS_AUTHORIZATION_URL = "https://c.example.test";
    process.env.NXIS_MCP_URL = "https://d.example.test";
    process.env.NXIS_SITES_URL = "https://e.example.test";
    expect(resolveConfig({}).endpoints).toEqual({
      accounts: "https://a.example.test",
      billing: "https://b.example.test",
      authorization: "https://c.example.test",
      mcp: "https://d.example.test",
      sites: "https://e.example.test",
    });
  });

  it("trim trailing slashes", () => {
    process.env.NXIS_AUTHORIZATION_URL = "https://authz.example.test/v1///";
    expect(resolveConfig({}).endpoints.authorization).toBe("https://authz.example.test/v1");
  });

  it("clear isProduction even when only one is set", () => {
    process.env.NXIS_MCP_URL = "https://mcp.example.test";
    const config = resolveConfig({});
    expect(config.isProduction).toBe(false);
    expect(config.profile).toBe("custom");
  });

  it("are ignored when set to an empty string", () => {
    process.env.NXIS_ACCOUNTS_URL = "";
    const config = resolveConfig({});
    expect(config.isProduction).toBe(true);
    expect(config.endpoints.accounts).toBe(PRODUCTION_ENDPOINTS.accounts);
  });
});

describe("base URL validation", () => {
  /** A bad value used to surface much later as a failed request against `local/v1alpha/...`. */
  it("rejects a --api value that is not a URL, naming the flag", () => {
    expect(() => resolveConfig({ api: "local" })).toThrow(/--api must be a URL/);
  });

  it("rejects a non-URL NXIS_API, naming the variable", () => {
    process.env.NXIS_API = "local";
    expect(() => resolveConfig({})).toThrow(/NXIS_API must be a URL/);
  });

  /** The value that caused this: saved by an earlier `--api`, so the file is where to look. */
  it("names the settings file when the saved value is bad", () => {
    expect(() => resolveConfig({ saved: { api: "local" } })).toThrow(/saved --api setting/);
  });

  it("rejects a URL that is neither http nor https", () => {
    expect(() => resolveConfig({ api: "ftp://example.test" })).toThrow(/http or https/);
  });

  it("rejects a non-URL per-service override, naming the variable", () => {
    process.env.NXIS_BILLING_URL = "billing";
    expect(() => resolveConfig({})).toThrow(/NXIS_BILLING_URL must be a URL/);
  });

  it("reports the offending value so it can be recognised", () => {
    expect(() => resolveConfig({ api: "local" })).toThrow(/"local"/);
  });

  it("accepts http and https", () => {
    expect(resolveConfig({ api: "http://localhost:8787" }).endpoints.billing).toBe("http://localhost:8787");
    expect(resolveConfig({ api: "https://api.example.test" }).endpoints.billing).toBe("https://api.example.test");
  });
});

describe("plain http", () => {
  // Every request carries a bearer token, so http is only for this machine.
  it("is accepted for loopback hosts", () => {
    for (const api of ["http://localhost:8787", "http://127.0.0.1:8080", "http://[::1]:3000", "http://app.localhost"]) {
      expect(resolveConfig({ api }).endpoints.accounts).toBe(api);
    }
  });

  it("is refused for any other host, from every source", () => {
    expect(() => resolveConfig({ api: "http://api.example.test" })).toThrow(/must use https/);
    process.env["NXIS_API"] = "http://10.0.0.5";
    expect(() => resolveConfig({})).toThrow(/NXIS_API must use https/);
    delete process.env["NXIS_API"];
    process.env["NXIS_BILLING_URL"] = "http://billing.example.test";
    expect(() => resolveConfig({})).toThrow(/NXIS_BILLING_URL must use https/);
  });

  it("does not mistake a lookalike for loopback", () => {
    expect(isLoopback("localhost.example.test")).toBe(false);
    expect(isLoopback("127.0.0.1.example.test")).toBe(false);
  });
});

describe("--api production", () => {
  it("ignores a saved base URL and NXIS_API", () => {
    process.env["NXIS_API"] = "https://env.example.test";
    const config = resolveConfig({ api: "production", saved: { api: BASE, profile: "custom" } });
    expect(config.endpoints).toEqual(PRODUCTION_ENDPOINTS);
    expect(config.isProduction).toBe(true);
    expect(config.profile).toBe("production");
  });
});

describe("endpointKey", () => {
  it("differs between environments and is stable within one", () => {
    expect(endpointKey(PRODUCTION_ENDPOINTS)).toBe(endpointKey({ ...PRODUCTION_ENDPOINTS }));
    expect(endpointKey(singleHost(BASE))).not.toBe(endpointKey(PRODUCTION_ENDPOINTS));
  });

  it("is unchanged by the sites endpoint where a setup puts it by default", () => {
    // The key as it was before the sites endpoint existed: credentials saved then must still match.
    const legacy = (e: typeof PRODUCTION_ENDPOINTS) => [e.accounts, e.billing, e.authorization, e.mcp].join(" ");
    expect(endpointKey(PRODUCTION_ENDPOINTS)).toBe(legacy(PRODUCTION_ENDPOINTS));
    expect(endpointKey(singleHost(BASE))).toBe(legacy(singleHost(BASE)));
    expect(endpointKey(resolveConfig({}).endpoints)).toBe(legacy(PRODUCTION_ENDPOINTS));
    expect(endpointKey(resolveConfig({ api: BASE }).endpoints)).toBe(legacy(singleHost(BASE)));
    // Another service overridden on its own leaves sites on production.
    process.env.NXIS_ACCOUNTS_URL = "https://a.example.test";
    const mixed = resolveConfig({}).endpoints;
    expect(mixed.sites).toBe(PRODUCTION_ENDPOINTS.sites);
    expect(endpointKey(mixed)).toBe(legacy(mixed));
  });

  it("binds credentials to a sites endpoint set anywhere else", () => {
    process.env.NXIS_SITES_URL = "https://sites.example.test";
    const elsewhere = resolveConfig({}).endpoints;
    expect(endpointKey(elsewhere)).not.toBe(endpointKey(PRODUCTION_ENDPOINTS));
    expect(endpointKey(elsewhere)).toContain("https://sites.example.test");
    process.env.NXIS_SITES_URL = BASE;
    expect(endpointKey(resolveConfig({ api: BASE }).endpoints)).toBe(endpointKey(singleHost(BASE)));
  });
});
