/**
 * The API JSON decoding traps.
 *
 * @remarks
 * Each of these produces a plausible wrong answer rather than a crash, which is why they are
 * tested directly: an id that stringifies to "[object Object]" and a credit total that
 * concatenates instead of adding both look like working code right up until they don't.
 */

import { describe, expect, it } from "vitest";
import { bool, list, num, str, uid } from "../src/api/shapes.js";

describe("uid", () => {
  it("unwraps an id object", () => {
    expect(uid({ value: "org123" })).toBe("org123");
  });

  it("accepts a bare string, since not every field is wrapped", () => {
    expect(uid("abc")).toBe("abc");
  });

  it("treats an empty wrapper as absent rather than an empty id", () => {
    expect(uid({})).toBeNull();
    expect(uid({ value: "" })).toBeNull();
    expect(uid(null)).toBeNull();
  });
});

describe("num", () => {
  /** 1000000 credits arrives as "1000000", and "1000000" + 1 is "10000001". */
  it("parses a 64-bit integer, which arrives as a string", () => {
    expect(num("1000000")).toBe(1_000_000);
  });

  it("passes through plain numbers", () => {
    expect(num(24.99)).toBe(24.99);
  });

  it("distinguishes absent from zero", () => {
    expect(num(undefined)).toBeNull();
    expect(num(null)).toBeNull();
    expect(num(0)).toBe(0);
  });

  it("rejects values that are not numbers", () => {
    expect(num("not-a-number")).toBeNull();
  });
});

describe("str and bool", () => {
  it("reads a bare string", () => {
    expect(str("Acme")).toBe("Acme");
  });

  it("still unwraps when a value happens to be wrapped", () => {
    expect(str({ value: "Acme" })).toBe("Acme");
  });

  it("treats a missing boolean as false", () => {
    expect(bool(undefined)).toBe(false);
    expect(bool(true)).toBe(true);
    expect(bool({ value: true })).toBe(true);
  });
});

describe("list", () => {
  it("reads a list from a named field", () => {
    expect(list<{ a: number }>({ tiers: [{ a: 1 }] }, "tiers")).toEqual([{ a: 1 }]);
  });

  it("reads a bare array", () => {
    expect(list<{ a: number }>([{ a: 1 }], "organizations")).toEqual([{ a: 1 }]);
  });

  it("returns empty rather than throwing when the field is missing", () => {
    expect(list({}, "tiers")).toEqual([]);
    expect(list(null, "tiers")).toEqual([]);
  });
});
