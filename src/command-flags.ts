/**
 * The flags each command takes, and the check that refuses any other before anything is sent.
 *
 * @remarks
 * A flag the CLI doesn't know used to be ignored, which turns a typo, or a flag from a newer
 * release run on an older one, into a different command: `connections create … --write-env
 * .env.local` on a CLI without `--write-env` creates the connection and prints the signing secret.
 * So every command declares its flags here, in one table, and {@link checkFlags} refuses the rest
 * with `unknown_flag` before the command runs. A test reads the `--help` text against this table,
 * both ways, so the two can't drift.
 *
 * `agents enable` and `agents configure` also take the agent's own settings as flags, which come
 * from the service and differ per agent. Those are checked against the agent's setup by
 * `settingsFromFlags`, which refuses one the agent doesn't have.
 */

import type { Flags } from "./args.js";
import { failed } from "./errors.js";
import { plainText } from "./output.js";

/**
 * Flags every command takes. A hosted agent's setting can't use one of these as its flag either.
 *
 * @remarks
 * `h` and `v` are the short spellings of `--help` and `--version`, kept for anyone who typed them.
 */
export const GLOBAL_FLAGS: ReadonlySet<string> = new Set([
  "json",
  "verbose",
  "dry-run",
  "api",
  "profile",
  "org",
  "site",
  "no-open",
  "timeout",
  "yes",
  "h",
  "help",
  "v",
  "version",
]);

/** Global flags that are only spellings of another, left out of what a refusal lists. */
const ALIASES: ReadonlySet<string> = new Set(["h", "v"]);

/** One command's flags. */
export interface CommandSpec {
  /** The flags it takes, besides the global ones, without the leading `--`. */
  readonly flags: readonly string[];
  /**
   * The command also takes a hosted agent's settings as flags (`--label`, `--slot-minutes` …),
   * which are checked against that agent's setup once it is read.
   */
  readonly settings?: boolean;
  /** The command is another spelling of this one, and has no line of its own in `--help`. */
  readonly alias?: string;
}

/** The `autofill` scope flags, which `plan` and `submit` share. */
const AUTOFILL_SCOPE = ["existing", "media-type", "pattern"] as const;

/** `--write-env <file>` and `--env-name <var>`, for the commands that make a signing secret. */
const WRITE_ENV = ["write-env", "env-name"] as const;

/**
 * Every command, by the words that name it, and the flags it takes.
 *
 * @remarks
 * A command line is matched to the longest entry its leading words name: `sites tag issue` is
 * `sites tag`, `agents enable booking` is `agents enable`. Adding a flag to a command means adding
 * it here and to its line in `--help`, or the help test fails.
 */
export const COMMAND_FLAGS: Readonly<Record<string, CommandSpec>> = {
  signup: { flags: ["name", "website", "dev"] },
  login: { flags: ["web"] },
  logout: { flags: [] },
  whoami: { flags: [] },
  status: { flags: [] },
  plans: { flags: ["dev"] },
  subscribe: { flags: [] },
  update: { flags: ["check", "to", "from"] },

  credits: { flags: [] },
  "credits packs": { flags: [] },
  "credits buy": { flags: [] },

  "orgs create": { flags: ["name", "website", "industry"] },
  "orgs list": { flags: [] },
  "orgs use": { flags: [] },
  "orgs update": { flags: ["name", "website", "industry"] },

  "sites create": { flags: ["name"] },
  "sites list": { flags: [] },
  "sites use": { flags: [] },
  "sites verify": { flags: ["token", "check"] },
  "sites name": { flags: [] },
  "sites list-in-app": { flags: ["preview", "off"] },
  "sites tag": { flags: ["domain", "webmcp-mode"] },

  "keys create": { flags: ["scope"] },
  "keys list": { flags: ["all"] },
  "keys revoke": { flags: [] },

  "mcp install": { flags: ["agent", "stdio", "remote", "force", "print", "read-only", "allow-unconfirmed"] },
  "mcp serve": { flags: ["read-only", "allow-unconfirmed"] },
  "mcp public": { flags: [] },
  "mcp settings": { flags: ["set"] },

  "crawl submit": { flags: ["wait"] },
  "crawl status": { flags: ["wait"] },
  "autofill plan": { flags: [...AUTOFILL_SCOPE] },
  "autofill submit": { flags: [...AUTOFILL_SCOPE, "wait"] },
  "autofill status": { flags: ["batch", "wait", "recent"] },
  publish: { flags: ["type"] },

  "actions bind": { flags: ["connection", "webhook", "gateway", "self-page", "supports-check", "availability-url"] },
  "actions on": { flags: [] },
  "actions off": { flags: [] },

  connections: { flags: [], alias: "connections list" },
  "connections list": { flags: [] },
  "connections create": { flags: ["name", "url", "default", ...WRITE_ENV] },
  "connections rotate": { flags: [...WRITE_ENV] },
  "connections delete": { flags: [] },
  "connections test": { flags: ["action", "turn-on-checks"] },

  "discovery files": { flags: ["write", "out"] },
  types: { flags: ["limit"] },
  query: { flags: ["text", "filter", "limit", "exact", "page-token"] },

  "agents status": { flags: [] },
  "agents catalog": { flags: ["job", "industry", "readiness", "added", "not-added", "query", "by-fit"] },
  "agents enable": { flags: ["connection"], settings: true },
  "agents configure": { flags: ["clear"], settings: true },
  "agents disable": { flags: [] },
  "agents pause": { flags: ["tools", "reason"] },
  "agents resume": { flags: [] },
  "agents brand": { flags: ["name", "logo", "accent", "privacy-url", "clear"] },
  "agents policy set": { flags: [] },
  "agents policy show": { flags: ["instructions"] },
  "agents dpa": { flags: [] },
  "agents dpa accept": { flags: ["entity"] },
  "agents transcripts list": { flags: ["limit", "page-token"] },
  "agents transcripts show": { flags: [] },
  "agents transcripts export": { flags: ["out", "format", "force"] },
  "agents transcripts delete": { flags: ["all"] },
  "agents transcripts settings": { flags: ["retention-days", "dont-store", "store"] },
  "agents transcripts webhook set": { flags: ["keep-secret"] },
  "agents transcripts webhook remove": { flags: [] },
  "agents transcripts webhook status": { flags: [] },
};

/**
 * The command a command line runs, by the longest entry of {@link COMMAND_FLAGS} its leading words
 * name.
 *
 * @returns The entry's key, or undefined when none matches, or when the words go on past an entry
 * that has subcommands (`connections frobnicate`): the command then fails as unknown, which says
 * more than a refused flag would.
 */
export function commandOf(positional: readonly string[]): string | undefined {
  for (let n = positional.length; n > 0; n--) {
    const key = positional.slice(0, n).join(" ");
    if (!Object.prototype.hasOwnProperty.call(COMMAND_FLAGS, key)) continue;
    if (n < positional.length && Object.keys(COMMAND_FLAGS).some((k) => k.startsWith(`${key} `))) return undefined;
    return key;
  }
  return undefined;
}

/**
 * The edit distance between two flags, counting a swap of two neighbors as one edit, so
 * `--exmaple` is one away from `--example`.
 */
export function flagDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const row = d[i] as number[];
      const prev = d[i - 1] as number[];
      row[j] = Math.min((prev[j] as number) + 1, (row[j - 1] as number) + 1, (prev[j - 1] as number) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        row[j] = Math.min(row[j] as number, ((d[i - 2] as number[])[j - 2] as number) + 1);
      }
    }
  }
  return (d[a.length] as number[])[b.length] as number;
}

/** @returns The flag a typo most likely meant, when one is close enough to suggest. */
function closest(given: string, known: readonly string[]): string | undefined {
  const best = known[0];
  if (best === undefined) return undefined;
  const distance = flagDistance(given, best);
  const close = distance <= Math.max(1, Math.floor(given.length / 3));
  return close || best.startsWith(given) || given.startsWith(best) ? best : undefined;
}

/** @returns The flags, closest to `given` first; ties keep their order. */
export function byCloseness(given: string, known: readonly string[]): string[] {
  return known
    .map((flag, i) => ({ flag, i, d: flagDistance(given, flag) }))
    .sort((x, y) => x.d - y.d || x.i - y.i)
    .map((x) => x.flag);
}

/**
 * Refuses a flag the command doesn't take, before the command runs.
 *
 * @remarks
 * A command line that names no command is left alone: the dispatcher refuses it as
 * `unknown_command`. For `agents enable` and `agents configure`, a flag that isn't one of theirs is
 * left for the agent's settings to take or refuse.
 *
 * @throws CliError `unknown_flag` (exit 1), with `flag`, the command's `known_flags` (closest match
 * first, then the global flags) and the command.
 */
export function checkFlags(positional: readonly string[], flags: Flags): void {
  const command = commandOf(positional);
  if (command === undefined) return;
  const spec = COMMAND_FLAGS[command] as CommandSpec;
  const own = new Set(spec.flags);
  for (const flag of flags.all.keys()) {
    if (GLOBAL_FLAGS.has(flag) || own.has(flag) || spec.settings) continue;
    throw unknownFlag(command, flag);
  }
}

/** @returns The `unknown_flag` refusal for `flag` on `command`. */
function unknownFlag(command: string, flag: string): Error {
  const spec = COMMAND_FLAGS[command] as CommandSpec;
  const globals = [...GLOBAL_FLAGS].filter((g) => !ALIASES.has(g));
  const known = byCloseness(flag, [...spec.flags, ...globals]).map((f) => `--${f}`);
  const shown = `--${plainText(flag)}`;
  const guess = closest(flag, byCloseness(flag, [...spec.flags, ...globals]));
  const takes = spec.flags.length > 0 ? `It takes ${spec.flags.map((f) => `--${f}`).join(", ")}` : "It takes no flags of its own";
  return failed(
    `\`nxis ${command}\` has no ${shown} flag.${guess ? ` Did you mean --${guess}?` : ""} ` +
      `${takes}, besides the global ones (\`nxis --help\`). Nothing was sent.`,
    "unknown_flag",
    { flag: shown, known_flags: known, command },
  );
}
