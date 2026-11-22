/**
 * The argument parser: repeatable flags, without changing what a single-value flag means.
 *
 * `--set a=1 --set b=2` and `--filter …` are given more than once and every value counts, while
 * `--org a --org b` has always meant the last one. Both have to hold at once.
 */

import { describe, expect, it } from "vitest";
import { BOOLEAN_FLAGS, bool, list, num, parseArgs, str } from "../src/args.js";

describe("parseArgs", () => {
  it("keeps every value of a repeated flag, in order", () => {
    const { flags } = parseArgs(["mcp", "settings", "--set", "a=1", "--set", "b=2", "--set=c=3"]);
    expect(list(flags, "set")).toEqual(["a=1", "b=2", "c=3"]);
  });

  it("still reads the last value for a single-value flag", () => {
    const { flags } = parseArgs(["--org", "first", "--org", "second"]);
    expect(str(flags, "org")).toBe("second");
    expect(list(flags, "org")).toEqual(["first", "second"]);
  });

  it("gives an empty list for an absent flag, and one value for a flag given once", () => {
    const { flags } = parseArgs(["query", "Product", "--filter", "price=lt:10"]);
    expect(list(flags, "set")).toEqual([]);
    expect(list(flags, "filter")).toEqual(["price=lt:10"]);
  });

  it("keeps positional arguments apart from repeated flags", () => {
    const { positional } = parseArgs(["query", "--filter", "a=eq:1", "Product", "--filter", "b=eq:2"]);
    expect(positional).toEqual(["query", "Product"]);
  });

  it("leaves bare booleans out of a flag's values", () => {
    const { flags } = parseArgs(["--set", "--json"]);
    expect(list(flags, "set")).toEqual([]);
    expect(bool(flags, "set")).toBe(true);
  });

  it("reads numbers as before", () => {
    const { flags } = parseArgs(["--limit", "5", "--timeout", "soon"]);
    expect(num(flags, "limit")).toBe(5);
    expect(num(flags, "timeout")).toBeUndefined();
  });

  /** The flags the site, data and MCP commands take bare. Any of them eating the next word is a bug. */
  it.each(["yes", "wait", "check", "token", "off", "on", "write", "stdio", "remote", "self-page", "preview", "all"])(
    "treats --%s as boolean, so it never swallows the next word",
    (name) => {
      expect(BOOLEAN_FLAGS.has(name)).toBe(true);
      const { positional, flags } = parseArgs([`--${name}`, "sites", "verify"]);
      expect(bool(flags, name)).toBe(true);
      expect(positional).toEqual(["sites", "verify"]);
    },
  );

  it("takes --site as a value", () => {
    const { flags, positional } = parseArgs(["--site", "example.com", "sites", "verify"]);
    expect(str(flags, "site")).toBe("example.com");
    expect(positional).toEqual(["sites", "verify"]);
  });
});
