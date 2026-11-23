/**
 * A hosted agent's settings, from the command line: each flag checked against the agent's own
 * setup block, with the service's rules, before anything is sent.
 *
 * @remarks
 * The flags come from the setup (`flag`, or the setting's name with `_` as `-`), so an agent the
 * CLI has never heard of gets its flags from the service. A refusal names the flag, with reasons
 * built from it: `missing_<flag>`, `<flag>_too_long`, `too_many_<setting>` and `invalid_<flag>`,
 * where `<flag>` has its `-` written as `_` (`invalid_slot_minutes`).
 *
 * Lengths are counted in UTF-16 code units, as the service counts them, so a value the CLI
 * passes is never refused for its length.
 */

import type { AgentSetupSpec, SettingField } from "../api/hosted-agents.js";
import type { Flags } from "../args.js";
import { failed } from "../errors.js";
import { plainText } from "../output.js";

/**
 * The settings of the on-page assistant and the Support Agent that the CLI has always taken, with
 * the service's limits, so these are checked before anything is read or sent, as they always were.
 * Every other setting, and every other agent, is checked against the setup the service sends.
 */
export const KNOWN_SETTINGS: Record<string, SettingField[]> = {
  page: [field({ name: "model", type: "model", label: "Model" })],
  support: [
    field({ name: "model", type: "model", label: "Model" }),
    field({ name: "label", type: "string", label: "Name visitors see", required: true, maxLength: 100 }),
    field({ name: "description", type: "text", label: "Description", maxLength: 300 }),
    field({ name: "examples", type: "string_list", label: "Example questions", maxItems: 10, itemMaxLength: 200, flag: "example" }),
  ],
};

/** A setting field with the defaults filled in. */
function field(f: Partial<SettingField> & Pick<SettingField, "name" | "type" | "label">): SettingField {
  return {
    help: "",
    required: false,
    maxLength: 0,
    maxItems: 0,
    itemMaxLength: 0,
    distinctItems: false,
    min: null,
    max: null,
    zeroIsDefault: false,
    allowedValues: [],
    defaultValue: null,
    flag: f.name.replace(/_/g, "-"),
    group: "",
    ...f,
  };
}

/**
 * Flags every command takes. A setting whose flag is one of these, or one of the command's own
 * (`--connection`, `--clear`), can't be given on the command line.
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

/** @returns The global flags, and these. */
export function reservedWith(...own: string[]): ReadonlySet<string> {
  return new Set([...GLOBAL_FLAGS, ...own]);
}

/** `slot-minutes` as it appears in a reason: `slot_minutes`. */
export function reasonPart(flag: string): string {
  return flag.replace(/-/g, "_");
}

/** Characters a URL never holds unencoded, so a value with any of them is markup or a typo. */
const NOT_IN_URL = /[\s<>"'`\\{}|^\u0000-\u001f\u007f]/;

/** `#rgb` or `#rrggbb`. */
const COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** A line break, which a one-line setting refuses. */
const LINE_BREAK = /[\r\n\u2028\u2029]/;

/** A whole number. */
const INTEGER = /^[+-]?\d+$/;

/** Options for {@link settingsFromFlags}. */
export interface FromFlagsOptions {
  /** Flags that aren't settings for this command. */
  reserved?: ReadonlySet<string>;
  /** Setting flags to return to their default (`--clear <flag>`). */
  clear?: string[];
  /** Skip flags this setup doesn't name, rather than refusing them (a first pass with {@link KNOWN_SETTINGS}). */
  onlyKnown?: boolean;
  /** The settings as stored, so a retired model the agent already has is still taken. */
  stored?: Record<string, unknown>;
  /** Accept http:// URLs too, for a local stack. */
  allowHttp?: boolean;
}

/** @returns Every flag this setup takes, with dashes, for `allowed`. */
export function settingFlags(setup: AgentSetupSpec): string[] {
  return setup.settings.map((f) => `--${f.flag}`);
}

/** @returns The flags given on the command line that aren't reserved. */
export function givenSettingFlags(flags: Flags, reserved: ReadonlySet<string> = GLOBAL_FLAGS): string[] {
  return [...flags.all.keys()].filter((f) => !reserved.has(f));
}

/**
 * The settings the flags set, checked against the setup.
 *
 * @returns Settings by name, as the service takes them: `null` for one cleared.
 * @throws CliError (exit 1, before anything is sent) `unknown_flag`, `conflicting_flags`,
 * `<flag>_too_long`, `too_many_<setting>`, `invalid_<flag>` or `model_retired`.
 */
export function settingsFromFlags(setup: AgentSetupSpec, flags: Flags, opts: FromFlagsOptions = {}): Record<string, unknown> {
  const reserved = opts.reserved ?? GLOBAL_FLAGS;
  const byFlag = new Map(setup.settings.map((f) => [f.flag, f]));
  const unknown = (flag: string, extra = ""): never => {
    throw failed(
      `--${plainText(flag)} isn't a setting of this agent${extra}. It takes ${settingFlags(setup).join(", ") || "no settings"}.`,
      "unknown_flag",
      { flag: `--${flag}`, allowed: settingFlags(setup) },
    );
  };

  const settings: Record<string, unknown> = {};
  for (const flag of givenSettingFlags(flags, reserved)) {
    const f = byFlag.get(flag);
    if (!f) {
      if (opts.onlyKnown) continue;
      unknown(flag);
      continue;
    }
    settings[f.name] = valueOf(f, flags.all.get(flag) ?? [], opts);
  }

  for (const raw of opts.clear ?? []) {
    const flag = raw.replace(/^--/, "").trim();
    const f = byFlag.get(flag);
    if (!f) {
      if (opts.onlyKnown) continue;
      unknown(flag, " to clear");
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(settings, f.name)) {
      throw failed(`--${f.flag} and --clear ${f.flag} were both given; pick one.`, "conflicting_flags", { flag: `--${f.flag}` });
    }
    settings[f.name] = null;
  }
  return settings;
}

/** @returns The value one setting's flag gives, checked. */
function valueOf(f: SettingField, given: Array<string | boolean>, opts: FromFlagsOptions): unknown {
  const flag = `--${f.flag}`;
  const part = reasonPart(f.flag);
  const invalid = (why: string, rule: string, extra: Record<string, unknown> = {}): never => {
    throw failed(`${flag} ${why}.`, `invalid_${part}`, { flag, rule, ...extra });
  };
  const tooLong = (value: string, limit: number): void => {
    if (limit > 0 && value.length > limit) {
      throw failed(`${flag} is at most ${limit} characters (got ${value.length}).`, `${part}_too_long`, {
        flag,
        limit,
        length: value.length,
      });
    }
  };

  if (f.type === "string_list") {
    if (given.some((v) => typeof v !== "string")) invalid("needs a value each time it is given", "type");
    const items = (given as string[]).map((v) => v.trim());
    if (items.some((v) => v.length === 0)) invalid("was given an empty value", "empty_item");
    if (items.some((v) => LINE_BREAK.test(v))) invalid("takes one line each time it is given", "type");
    if (f.maxItems > 0 && items.length > f.maxItems) {
      throw failed(`At most ${f.maxItems} ${flag} values (got ${items.length}).`, `too_many_${f.name}`, {
        flag,
        limit: f.maxItems,
        count: items.length,
      });
    }
    for (const item of items) tooLong(item, f.itemMaxLength);
    if (f.distinctItems) {
      const seen = new Set<string>();
      for (const item of items) {
        // Case is ignored, as the service ignores it.
        const key = item.toLowerCase();
        if (seen.has(key)) invalid(`was given "${plainText(item.slice(0, 80))}" twice`, "duplicate_item");
        seen.add(key);
      }
    }
    return items;
  }

  const last = given[given.length - 1];
  if (f.type === "boolean") {
    if (last === true) return true;
    const v = String(last).trim().toLowerCase();
    if (["true", "yes", "on", "1"].includes(v)) return true;
    if (["false", "no", "off", "0"].includes(v)) return false;
    return invalid("takes true or false", "type", { allowed: ["true", "false"] });
  }
  if (typeof last !== "string") return invalid("needs a value", "type");
  const value = last.trim();

  switch (f.type) {
    case "integer": {
      if (!INTEGER.test(value)) {
        return invalid(`takes a whole number${range(f)} (got "${plainText(value.slice(0, 40))}")`, "type", bounds(f));
      }
      const n = Number(value);
      if (n === 0 && f.zeroIsDefault) return 0;
      if ((f.min !== null && n < f.min) || (f.max !== null && n > f.max)) {
        return invalid(`takes a whole number${range(f)} (got ${n})`, "range", bounds(f));
      }
      return n;
    }
    case "enum": {
      const allowed = f.allowedValues.map((v) => v.value);
      if (allowed.length > 0 && !allowed.includes(value)) {
        return invalid(`takes one of ${allowed.join(", ")} (got "${plainText(value.slice(0, 40))}")`, "allowed_values", { allowed });
      }
      return value;
    }
    case "model": {
      if (!value || f.allowedValues.length === 0) return value;
      const offered = f.allowedValues.filter((v) => !v.retired).map((v) => v.value);
      const match = f.allowedValues.find((v) => v.value === value);
      if (!match) {
        return invalid(`takes one of ${offered.join(", ")} (got "${plainText(value.slice(0, 80))}")`, "allowed_values", {
          allowed: offered,
        });
      }
      if (match.retired && opts.stored?.[f.name] !== value) {
        throw failed(
          `${plainText(value)} is no longer offered. Choose one of ${offered.join(", ")}, or leave ${flag} out for the default.`,
          "model_retired",
          { flag, model: value, allowed: offered },
        );
      }
      return value;
    }
    case "url": {
      if (!value) return invalid("needs a URL; use --clear to remove one", "url");
      tooLong(value, f.maxLength);
      const scheme = opts.allowHttp ? /^https?:\/\/[^/]/i : /^https:\/\/[^/]/i;
      let host = "";
      try {
        host = new URL(value).hostname;
      } catch {
        host = "";
      }
      if (NOT_IN_URL.test(value) || !scheme.test(value) || !host) {
        return invalid(`must be a full https:// URL with the host (got "${plainText(value.slice(0, 200))}")`, "url");
      }
      return value;
    }
    case "color":
      if (!COLOR.test(value)) return invalid(`must be #rgb or #rrggbb, such as #C73A17 (got "${plainText(value.slice(0, 40))}")`, "color");
      return value;
    case "string":
      if (LINE_BREAK.test(value)) return invalid("takes one line", "type");
      tooLong(value, f.maxLength);
      return value;
    default:
      // text, and a type this CLI doesn't know: sent as text.
      tooLong(value, f.maxLength);
      return value;
  }
}

/** " from 15 to 480", for a message. */
function range(f: SettingField): string {
  if (f.min !== null && f.max !== null) return ` from ${f.min} to ${f.max}`;
  if (f.min !== null) return ` of at least ${f.min}`;
  if (f.max !== null) return ` of at most ${f.max}`;
  return "";
}

/** `min` and `max`, for the details. */
function bounds(f: SettingField): Record<string, unknown> {
  return { min: f.min, max: f.max };
}

/** @returns True for a value that counts as unset: missing, null, blank text or an empty list. */
export function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Checks the required settings, as they would be stored once the change is applied.
 *
 * @param agentName - How the agent is named in the message: "Quote".
 * @throws CliError `missing_<flag>` (exit 1) for the first required setting left empty.
 */
export function checkRequired(
  setup: AgentSetupSpec,
  stored: Record<string, unknown>,
  change: Record<string, unknown>,
  agentName: string,
): void {
  for (const f of setup.settings) {
    if (!f.required) continue;
    const value = Object.prototype.hasOwnProperty.call(change, f.name) ? change[f.name] : stored[f.name];
    if (isEmpty(value)) {
      const what = f.label ? ` (${plainText(f.label)})` : "";
      throw failed(
        `${plainText(agentName)} needs --${f.flag}${what}. Pass --${f.flag} <${f.type === "integer" ? "n" : "value"}>.`,
        `missing_${reasonPart(f.flag)}`,
        { flag: `--${f.flag}`, setting: f.name },
      );
    }
  }
}

/** @returns True when every value in the change is what is stored already (null: unset). */
export function changesNothing(stored: Record<string, unknown>, change: Record<string, unknown>): boolean {
  return Object.entries(change).every(([k, v]) => (v === null ? isEmpty(stored[k]) : JSON.stringify(stored[k]) === JSON.stringify(v)));
}
