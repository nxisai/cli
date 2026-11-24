/**
 * Unknown flags are refused, before anything is sent.
 *
 * A flag the CLI didn't know used to be ignored, so `connections create … --write-env .env.local`
 * on a CLI without `--write-env` created the connection and printed the signing secret. Each
 * command now declares its flags in one table, and the `--help` text is read against it both
 * ways: every flag a command's help lines mention is one it takes, and every flag it takes is on
 * its help lines.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseArgs } from "../src/args.js";
import { checkFlags, COMMAND_FLAGS, commandOf, flagDistance, GLOBAL_FLAGS } from "../src/command-flags.js";
import { KNOWN_SETTINGS, settingsFromFlags } from "../src/commands/agent-settings.js";
import { CliError } from "../src/errors.js";
import { HELP } from "../src/help.js";
import { TOOLS } from "../src/tools/index.js";

/** @returns The CliError `checkFlags` throws for this command line, or undefined. */
function refusal(argv: string[]): CliError | undefined {
  const { positional, flags } = parseArgs(argv);
  try {
    checkFlags(positional, flags);
    return undefined;
  } catch (err) {
    if (err instanceof CliError) return err;
    throw err;
  }
}

/** One command's lines in `--help`: the words that name it, and the flags they mention. */
interface HelpEntry {
  section: string;
  first: string;
  paths: string[][];
  flags: Set<string>;
}

/** Sections of `--help` that aren't commands. */
const NOT_COMMANDS = new Set(["Usage", "Options", "Environment", "Exit codes"]);

/** @returns The flags a piece of help text mentions, without `--`; `--<setting>` is not one. */
function mentioned(text: string): string[] {
  return [...text.matchAll(/--([a-z][a-z-]*[a-z])/g)].map((m) => m[1] as string);
}

/**
 * Reads `--help` into entries: a line indented two spaces starts one, a line indented further
 * continues it, and a line not indented starts a section.
 */
function helpEntries(): HelpEntry[] {
  const entries: HelpEntry[] = [];
  let section = "";
  for (const line of HELP.split("\n")) {
    if (!line.trim()) continue;
    if (!line.startsWith(" ")) {
      section = line.trim();
      continue;
    }
    if (/^ {2}\S/.test(line)) {
      // The leading words, with `a|b` read as either: `actions on|off` is `actions on` and `actions off`.
      let paths: string[][] = [[]];
      for (const token of line.trim().split(/\s+/)) {
        if (!/^[a-z][a-z-]*(\|[a-z][a-z-]*)*$/.test(token)) break;
        const alternatives = token.split("|");
        paths = paths.flatMap((p) => alternatives.map((a) => [...p, a]));
      }
      entries.push({ section, first: line.trim(), paths, flags: new Set(mentioned(line)) });
      continue;
    }
    const last = entries[entries.length - 1];
    if (last) for (const f of mentioned(line)) last.flags.add(f);
  }
  return entries;
}

const entries = helpEntries();
const commandEntries = entries.filter((e) => !NOT_COMMANDS.has(e.section));
const shortAliases = new Set(["h", "v"]);

describe("the command table and --help", () => {
  it("names a command for every command line in --help", () => {
    for (const e of commandEntries) {
      for (const path of e.paths) {
        expect(commandOf(path), `"${e.first}" names no command in COMMAND_FLAGS`).toBeDefined();
      }
    }
  });

  it("takes every flag a command's help lines mention", () => {
    for (const e of commandEntries) {
      for (const path of e.paths) {
        const key = commandOf(path) as string;
        const spec = COMMAND_FLAGS[key];
        const settings = spec?.settings ? Object.values(KNOWN_SETTINGS).flat().map((f) => f.flag) : [];
        const takes = new Set([...(spec?.flags ?? []), ...GLOBAL_FLAGS, ...settings]);
        for (const flag of e.flags) expect(takes.has(flag), `\`${key}\` doesn't take --${flag}, which "${e.first}" mentions`).toBe(true);
      }
    }
  });

  it("documents every flag a command takes on its own help lines", () => {
    const documented = new Map<string, Set<string>>();
    for (const e of commandEntries) {
      for (const path of e.paths) {
        const key = commandOf(path) as string;
        const seen = documented.get(key) ?? new Set<string>();
        for (const f of e.flags) seen.add(f);
        documented.set(key, seen);
      }
    }
    for (const [key, spec] of Object.entries(COMMAND_FLAGS)) {
      if (spec.alias) {
        expect(COMMAND_FLAGS[spec.alias], `${key} is an alias of a command that isn't in the table`).toBeDefined();
        expect(spec.flags).toEqual(COMMAND_FLAGS[spec.alias]?.flags);
        continue;
      }
      const seen = documented.get(key);
      expect(seen, `\`nxis ${key}\` has no line in --help`).toBeDefined();
      for (const flag of spec.flags) expect(seen?.has(flag), `--${flag} of \`nxis ${key}\` isn't on its --help lines`).toBe(true);
    }
  });

  it("lists exactly the global flags under Options", () => {
    const options = entries.filter((e) => e.section === "Options").map((e) => mentioned(e.first)[0]);
    expect(new Set(options)).toEqual(new Set([...GLOBAL_FLAGS].filter((f) => !shortAliases.has(f))));
  });
});

describe("checkFlags", () => {
  it("refuses a flag the command doesn't take, closest match first", () => {
    const err = refusal(["connections", "create", "--name", "web", "--url", "https://example.com", "--write-envv", ".env.local"]);
    expect(err?.reason).toBe("unknown_flag");
    expect(err?.exitCode).toBe(1);
    expect(err?.message).toContain("Did you mean --write-env?");
    expect(err?.toJSON()).toMatchObject({
      ok: false,
      reason: "unknown_flag",
      flag: "--write-envv",
      command: "connections create",
    });
    const known = err?.toJSON()["known_flags"] as string[];
    expect(known[0]).toBe("--write-env");
    expect(known).toEqual(expect.arrayContaining(["--name", "--url", "--default", "--env-name", "--json", "--site"]));
    expect(known).not.toContain("--h");
  });

  it("suggests --job for a typo of it on a command where it repeats", () => {
    const err = refusal(["agents", "catalog", "--jobb", "x"]);
    expect(err?.message).toContain("Did you mean --job?");
  });

  it("suggests nothing for a flag nowhere near one the command takes", () => {
    const err = refusal(["orgs", "list", "--frobnicate"]);
    expect(err?.reason).toBe("unknown_flag");
    expect(err?.message).not.toContain("Did you mean");
    expect(err?.message).toContain("no flags of its own");
  });

  it("refuses a real flag of another command", () => {
    // --write-env is a flag of create and rotate, not delete.
    expect(refusal(["connections", "delete", "web", "--write-env", ".env"])?.reason).toBe("unknown_flag");
    // The bare `connections` is `connections list`.
    expect(refusal(["connections", "--name", "web"])?.reason).toBe("unknown_flag");
  });

  it("takes the command's own flags, repeated ones and the global flags", () => {
    expect(refusal(["connections", "create", "--name", "a", "--url", "https://a.test", "--default", "--write-env", ".env", "--env-name", "X"])).toBeUndefined();
    expect(refusal(["agents", "catalog", "--job", "a", "--job", "b", "--industry", "x", "--by-fit"])).toBeUndefined();
    expect(refusal(["agents", "brand", "--clear", "logo", "--clear", "accent"])).toBeUndefined();
    expect(refusal(["query", "Product", "--filter", "a=eq:1", "--filter", "b=eq:2", "--exact"])).toBeUndefined();
    expect(refusal(["orgs", "list", "--json", "--verbose", "--dry-run", "--api", "x", "--profile", "p", "--org", "o", "--site", "s", "--yes", "--no-open", "--timeout", "5"])).toBeUndefined();
    expect(refusal(["actions", "bind", "booking", "--supports-check=false", "--availability-url", ""])).toBeUndefined();
    expect(refusal(["sites", "tag", "issue", "--domain", "a.test", "--domain", "b.test", "--webmcp-mode", "ssr"])).toBeUndefined();
  });

  it("leaves an agent's settings to the agent's setup", () => {
    expect(refusal(["agents", "enable", "booking", "--slot-minutes", "30", "--connection", "web"])).toBeUndefined();
    expect(refusal(["agents", "configure", "support", "--example", "a", "--example", "b", "--clear", "label"])).toBeUndefined();
    // ...which refuses one the agent doesn't have, with today's message, closest first.
    const { flags } = parseArgs(["--exmaple", "a"]);
    let err: CliError | undefined;
    try {
      settingsFromFlags({ settings: KNOWN_SETTINGS["support"] ?? [], prerequisites: [], pausable: true }, flags);
    } catch (e) {
      err = e as CliError;
    }
    expect(err?.reason).toBe("unknown_flag");
    expect(err?.message).toContain("--exmaple isn't a setting of this agent");
    expect(err?.toJSON()).toMatchObject({ flag: "--exmaple", known_flags: expect.arrayContaining(["--example"]) });
    expect((err?.toJSON()["known_flags"] as string[])[0]).toBe("--example");
  });

  it("leaves a command line that names no command to the dispatcher", () => {
    expect(refusal(["frobnicate", "--bogus"])).toBeUndefined();
    expect(refusal(["connections", "frobnicate", "--bogus"])).toBeUndefined();
    expect(refusal(["agents", "--bogus"])).toBeUndefined();
  });

  it("matches the longest command, with arguments after it", () => {
    expect(commandOf(["agents", "transcripts", "webhook", "set", "https://a.test"])).toBe("agents transcripts webhook set");
    expect(commandOf(["agents", "dpa", "accept"])).toBe("agents dpa accept");
    expect(commandOf(["agents", "dpa"])).toBe("agents dpa");
    expect(commandOf(["credits", "buy", "pack-1"])).toBe("credits buy");
    expect(commandOf(["credits"])).toBe("credits");
    expect(commandOf(["mcp", "public", "on"])).toBe("mcp public");
    expect(commandOf(["subscribe", "pro"])).toBe("subscribe");
  });

  it("counts a swap of neighbors as one edit", () => {
    expect(flagDistance("exmaple", "example")).toBe(1);
    expect(flagDistance("write-envv", "write-env")).toBe(1);
    expect(flagDistance("", "abc")).toBe(3);
  });
});

describe("nxis mcp serve tool schemas", () => {
  /** @returns Every object schema inside `schema`, itself included. */
  function objects(schema: z.ZodType): z.ZodObject[] {
    const def = (schema as unknown as { _zod: { def: Record<string, unknown> } })._zod.def;
    const inner = ["innerType", "element", "in", "out"].map((k) => def[k]).filter(Boolean) as z.ZodType[];
    const options = (def["options"] as z.ZodType[] | undefined) ?? [];
    const own = def["type"] === "object" ? [schema as z.ZodObject] : [];
    const fields = def["type"] === "object" ? Object.values((schema as z.ZodObject).shape) : [];
    return [...own, ...[...inner, ...options, ...fields].flatMap((s) => objects(s as z.ZodType))];
  }

  it("refuses an argument a tool doesn't define, at every level", () => {
    for (const tool of TOOLS) {
      for (const o of objects(tool.input)) {
        const catchall = (o._zod.def as { catchall?: { _zod: { def: { type: string } } } }).catchall;
        expect(catchall?._zod.def.type, `${tool.name} has an object that takes unknown keys`).toBe("never");
      }
      const issues = tool.input.safeParse({ not_an_argument: 1 }).error?.issues ?? [];
      expect(issues.some((i) => i.code === "unrecognized_keys"), tool.name).toBe(true);
    }
  });
});
