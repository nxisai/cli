/**
 * Reading the `google.rpc.ErrorInfo` detail out of an error body, as the HTTP transcoder sends it.
 */

import { describe, expect, it } from "vitest";
import { errorInfoOf } from "../src/http.js";

const info = (extra: Record<string, unknown> = {}) => ({
  "@type": "type.googleapis.com/google.rpc.ErrorInfo",
  reason: "CONNECTION_IN_USE",
  domain: "nxis.ai",
  metadata: { agents: "quote,booking" },
  ...extra,
});

describe("errorInfoOf", () => {
  it("reads the reason, domain and metadata, after other details", () => {
    const body = JSON.stringify({
      code: 9,
      message: "This connection is still used by the Quote and Booking agents.",
      details: [{ "@type": "type.googleapis.com/google.protobuf.StringValue", value: "more" }, info()],
    });
    expect(errorInfoOf(body)).toEqual({ reason: "CONNECTION_IN_USE", domain: "nxis.ai", metadata: { agents: "quote,booking" } });
  });

  it("is undefined for a body with no ErrorInfo, or not JSON", () => {
    expect(errorInfoOf(JSON.stringify({ code: 9, message: "x" }))).toBeUndefined();
    expect(errorInfoOf(JSON.stringify({ code: 9, message: "x", details: [] }))).toBeUndefined();
    expect(errorInfoOf("upstream connect error")).toBeUndefined();
    expect(errorInfoOf("")).toBeUndefined();
  });

  it("skips a reason that is not UPPER_SNAKE_CASE, and metadata that is not a string", () => {
    expect(errorInfoOf(JSON.stringify({ details: [info({ reason: "in use\u001b[31m" })] }))).toBeUndefined();
    expect(errorInfoOf(JSON.stringify({ details: [info({ metadata: { agents: ["quote"], n: 1, ok: "yes" } })] }))).toEqual({
      reason: "CONNECTION_IN_USE",
      domain: "nxis.ai",
      metadata: { ok: "yes" },
    });
  });
});
