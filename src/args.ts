/**
 * Argument parsing.
 *
 * @remarks
 * Hand-rolled rather than pulled from a package. The grammar is small — positional words,
 * `--name value`, `--name=value`, bare boolean flags, and a few flags that may be repeated — and a
 * parser this size can be read in one sitting.
 */

/** Flag values from the command line. The last occurrence of a flag wins; {@link list} reads every one. */
export class Flags extends Map<string, string | boolean> {
  /** Every value each flag was given, in order. */
  readonly all = new Map<string, Array<string | boolean>>();

  /** Records one occurrence of a flag. */
  add(name: string, value: string | boolean): void {
    this.set(name, value);
    const seen = this.all.get(name);
    if (seen) seen.push(value);
    else this.all.set(name, [value]);
  }
}

/** Positional arguments and `--flag` values from the command line. */
export interface Parsed {
  positional: string[];
  flags: Flags;
}

/**
 * Flags that never take a value.
 *
 * @remarks
 * Without this list `--json orgs list` reads `orgs` as the value of `--json`, turns JSON output
 * off, and then fails on `list` as an unknown command — the flag silently doing the opposite of
 * what was asked. Only trailing flags worked. A parser this small has no other way to tell
 * `--json orgs` from `--org acme`, so every new boolean flag has to be added here.
 */
export const BOOLEAN_FLAGS = new Set([
  "added",
  "all",
  "allow-unconfirmed",
  "by-fit",
  "check",
  "default",
  "dev",
  "dont-store",
  "dry-run",
  "exact",
  "force",
  "gateway",
  "h",
  "help",
  "instructions",
  "json",
  "keep-secret",
  "no-open",
  "not-added",
  "off",
  "on",
  "preview",
  "print",
  "read-only",
  "recent",
  "remote",
  "self-page",
  "stdio",
  "store",
  "supports-check",
  "token",
  "tools",
  "v",
  "verbose",
  "version",
  "wait",
  "web",
  "write",
  "yes",
]);

/**
 * Splits argv into positional arguments and flags.
 *
 * @remarks
 * `--name=value` and `--name value` both set a value. A flag followed by another flag, or by
 * nothing, is boolean. A flag given more than once keeps every value, for the flags that are
 * meant to repeat (`--set a=1 --set b=2`); {@link str} still reads only the last.
 *
 * @param argv - Arguments after the executable and script path.
 * @returns The parsed arguments.
 */
export function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Flags();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      flags.add(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (!BOOLEAN_FLAGS.has(body) && next !== undefined && !next.startsWith("--")) {
      flags.add(body, next);
      i++;
    } else {
      flags.add(body, true);
    }
  }
  return { positional, flags };
}

/** @returns The flag's string value — the last one, when given more than once — or undefined when absent or boolean. */
export function str(flags: Flags, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

/** @returns Every string value the flag was given, in order; empty when absent. */
export function list(flags: Flags, name: string): string[] {
  return (flags.all.get(name) ?? []).filter((value): value is string => typeof value === "string");
}

/** @returns True when the flag was given bare or as `true`. */
export function bool(flags: Flags, name: string): boolean {
  return flags.get(name) === true || flags.get(name) === "true";
}

/** @returns The flag's numeric value, or undefined when absent or not a finite number. */
export function num(flags: Flags, name: string): number | undefined {
  const value = str(flags, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
