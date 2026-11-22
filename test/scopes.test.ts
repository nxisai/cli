/**
 * The resource scopes the services authorize on.
 *
 * @remarks
 * A token without these still signs in and still passes `status`, so a missing scope only
 * surfaces when a command such as `orgs list` hits an ownership check.
 */

import { describe, expect, it } from "vitest";
import { SCOPES } from "../src/auth.js";

describe("requested scopes", () => {
  const scopes = SCOPES.split(" ");

  it("keeps the OIDC scopes and offline access for silent refresh", () => {
    expect(scopes).toEqual(expect.arrayContaining(["openid", "profile", "email", "offline_access"]));
  });

  it("requests the ownership scopes the accounts and billing services check", () => {
    expect(scopes).toEqual(
      expect.arrayContaining([
        "READ_OWN:account",
        "WRITE_OWN:account",
        "READ_OWN:organization",
        "WRITE_OWN:organization",
        "READ_OWN:subscription",
      ]),
    );
  });
});
