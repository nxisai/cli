/**
 * Request-body shapes for the accounts API.
 *
 * @remarks
 * Type-checking cannot catch a body the service rejects, so each body here is pinned to what the
 * service accepts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrganization, updateOrganization } from "../src/api/accounts.js";
import { resolveConfig } from "../src/config.js";

const config = resolveConfig({ api: "https://api.example.test" });

/** A captured fetch call. */
interface Captured {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

/** Stub fetch and hand back whatever the endpoint should return. */
function stubFetch(response: unknown): { calls: Captured[] } {
  const calls: Captured[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      body: init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {},
    });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(response),
    } as unknown as Response;
  });
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createOrganization", () => {
  /** account_id is an id object, so a bare string is silently the wrong shape. */
  it("wraps account_id as an id object", async () => {
    const { calls } = stubFetch({ _id: { value: "org1" }, name: "Acme" });
    await createOrganization(config, "token", "acc1", { name: "Acme" });

    expect(calls[0]?.body["account_id"]).toEqual({ value: "acc1" });
    expect(calls[0]?.body["organization"]).toEqual({ name: "Acme" });
  });

  it("omits the organization block entirely when there is nothing to set", async () => {
    const { calls } = stubFetch({ _id: { value: "org1" } });
    await createOrganization(config, "token", "acc1", {});
    expect(calls[0]?.body).not.toHaveProperty("organization");
  });

  /** onboarded is what makes the web app skip its "name your organization" form after payment. */
  it("sends onboarded with a named organization", async () => {
    const { calls } = stubFetch({ _id: { value: "org1" }, name: "Acme", onboarded: true });
    await createOrganization(config, "token", "acc1", { name: "Acme", onboarded: true });
    expect(calls[0]?.body["organization"]).toEqual({ name: "Acme", onboarded: true });
  });

  /** The service rejects onboarded without a name; never send a request it will refuse. */
  it("never sends onboarded without a name", async () => {
    const { calls } = stubFetch({ _id: { value: "org1" } });
    await createOrganization(config, "token", "acc1", { onboarded: true });
    expect(calls[0]?.body).not.toHaveProperty("organization");
  });

  it("leaves onboarded out unless asked", async () => {
    const { calls } = stubFetch({ _id: { value: "org1" }, name: "Acme" });
    await createOrganization(config, "token", "acc1", { name: "Acme" });
    expect(calls[0]?.body["organization"]).not.toHaveProperty("onboarded");
  });
});

describe("updateOrganization", () => {
  /** The PATCH body repeats the resource name alongside the payload; the service reads both. */
  it("sends the resource name with the payload", async () => {
    const { calls } = stubFetch({ _id: { value: "org1" }, name: "Acme" });
    await updateOrganization(config, "token", "org1", { website: "https://acme.test" });

    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.body["name"]).toBe("organizations/org1");
    expect(calls[0]?.body["organization"]).toEqual({ website: "https://acme.test" });
  });
});
