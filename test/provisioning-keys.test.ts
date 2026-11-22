/**
 * Where the provisioning key is kept.
 *
 * One entry per environment and organization, apart from the sign-in tokens, in the keychain or a
 * 0600 file when there is none. These run against the file (`NXIS_NO_KEYCHAIN=1`) in a throwaway
 * config directory, so they never touch the real keychain.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointKey, PRODUCTION_ENDPOINTS, singleHost } from "../src/config.js";
import {
  clearCredentials,
  clearProvisioningKey,
  clearProvisioningKeys,
  keychainAddCommand,
  loadCredentials,
  loadProvisioningKey,
  provisioningKeyAccount,
  saveCredentials,
  saveProvisioningKey,
  type StoredProvisioningKey,
} from "../src/credentials.js";

const production = endpointKey(PRODUCTION_ENDPOINTS);
const local = endpointKey(singleHost("http://localhost:8787"));

/** A made-up key; the marker keeps the mirror's secret scan from flagging it. */
function key(endpoints: string, orgId: string, apiKey = "nxis_dev_mcp_test_0001"): StoredProvisioningKey { // gitleaks:allow
  return { apiKey, keyId: "k1", preview: "…0001", orgId, endpoints, env: "dev", createdAt: 1 };
}

let dir: string;
const saved = { xdg: process.env.XDG_CONFIG_HOME, nokc: process.env.NXIS_NO_KEYCHAIN, token: process.env.NXIS_TOKEN };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nxis-keys-"));
  process.env.XDG_CONFIG_HOME = dir;
  process.env.NXIS_NO_KEYCHAIN = "1";
  delete process.env.NXIS_TOKEN;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [name, value] of [["XDG_CONFIG_HOME", saved.xdg], ["NXIS_NO_KEYCHAIN", saved.nokc], ["NXIS_TOKEN", saved.token]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("provisioningKeyAccount", () => {
  it("names one entry per environment and organization", () => {
    const a = provisioningKeyAccount(production, "org-1");
    expect(a).toMatch(/^provisioning:[0-9a-f]{12}:org-1$/);
    expect(provisioningKeyAccount(local, "org-1")).not.toBe(a);
    expect(provisioningKeyAccount(production, "org-2")).not.toBe(a);
    expect(provisioningKeyAccount(production, "org-1")).toBe(a);
  });

  it("never collides with the tokens' entry", () => {
    expect(provisioningKeyAccount(production, "default")).not.toBe("default");
  });

  /** `security -i` reads the name unquoted, so a space would split the command. */
  it("contains nothing `security -i` would need quoted", () => {
    const account = provisioningKeyAccount(local, "org with spaces/and\"quotes");
    expect(account).toMatch(/^[A-Za-z0-9:._-]+$/);
    const line = keychainAddCommand("nxis-cli", account, "{}");
    expect(line.split(" ")).toContain(account);
  });
});

describe("the fallback file", () => {
  it("round-trips a key, mode 0600", () => {
    saveProvisioningKey(key(local, "org-1"));
    expect(loadProvisioningKey(local, "org-1")?.apiKey).toBe("nxis_dev_mcp_test_0001"); // gitleaks:allow
    const path = join(dir, "nxis", "provisioning-keys.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("keeps the key out of the tokens' file", () => {
    saveCredentials({ accessToken: "a.b.c" });
    saveProvisioningKey(key(local, "org-1"));
    expect(readFileSync(join(dir, "nxis", "credentials.json"), "utf8")).not.toContain("nxis_dev_mcp");
    expect(loadCredentials()?.accessToken).toBe("a.b.c");
  });

  it("returns a key only for the environment and organization it was minted for", () => {
    saveProvisioningKey(key(local, "org-1"));
    expect(loadProvisioningKey(production, "org-1")).toBeNull();
    expect(loadProvisioningKey(local, "org-2")).toBeNull();
  });

  it("forgets one key without touching another", () => {
    saveProvisioningKey(key(local, "org-1"));
    saveProvisioningKey(key(local, "org-2", "nxis_dev_mcp_test_0002")); // gitleaks:allow
    clearProvisioningKey(local, "org-1");
    expect(loadProvisioningKey(local, "org-1")).toBeNull();
    expect(loadProvisioningKey(local, "org-2")?.apiKey).toBe("nxis_dev_mcp_test_0002"); // gitleaks:allow
  });

  it("replaces a key minted again for the same organization", () => {
    saveProvisioningKey(key(local, "org-1"));
    saveProvisioningKey(key(local, "org-1", "nxis_dev_mcp_test_0003")); // gitleaks:allow
    expect(loadProvisioningKey(local, "org-1")?.apiKey).toBe("nxis_dev_mcp_test_0003"); // gitleaks:allow
  });

  it("forgets every key on logout, and leaves no file behind", () => {
    saveProvisioningKey(key(local, "org-1"));
    saveProvisioningKey(key(production, "org-1"));
    clearProvisioningKeys();
    expect(loadProvisioningKey(local, "org-1")).toBeNull();
    expect(loadProvisioningKey(production, "org-1")).toBeNull();
    expect(existsSync(join(dir, "nxis", "provisioning-keys.json"))).toBe(false);
  });

  it("is independent of signing out of the session", () => {
    saveCredentials({ accessToken: "a.b.c" });
    saveProvisioningKey(key(local, "org-1"));
    clearCredentials();
    expect(loadProvisioningKey(local, "org-1")).not.toBeNull();
  });
});
