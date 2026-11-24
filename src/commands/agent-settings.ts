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
import { byCloseness, GLOBAL_FLAGS } from "../command-flags.js";

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

/** Flags every command takes, from the command table. A setting can't use one of them as its flag. */
export { GLOBAL_FLAGS };

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
  /** Settings to return to their default (`--clear <flag>`), by flag or by setting name. */
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
      {
        flag: `--${flag}`,
        allowed: settingFlags(setup),
        known_flags: byCloseness(`--${flag}`, settingFlags(setup)),
      },
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
    settings[f.name] = valueOf(f, flags.all.get(flag) ?? [], opts, flagNaming(f));
  }

  // `--clear` takes the flag (`example`) or the setting's name as `agents status` shows it (`examples`).
  const byName = new Map(setup.settings.flatMap((f) => [[f.name, f] as const, [f.name.replace(/_/g, "-"), f] as const]));
  for (const raw of opts.clear ?? []) {
    const flag = raw.replace(/^--/, "").trim();
    const f = byFlag.get(flag) ?? byName.get(flag);
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

/** A setting's value as a tool takes it: text, a number, true or false, or a list of text. */
export type SettingValue = string | number | boolean | string[];

/**
 * The settings a tool's arguments set, by setting name, checked against the setup with the same
 * rules as {@link settingsFromFlags}.
 *
 * @remarks
 * Each value is checked as its flag's value would be: a list for a `string_list`, a whole number
 * for an `integer`, true or false for a `boolean`, and text for the rest (a number or a boolean is
 * taken as its text where text is expected only for `integer` and `boolean`). A refusal names
 * `settings.<name>` and has the same reason as the flag's, so `invalid_slot_minutes` means the same
 * thing from a terminal and from an agent. `clear` takes setting names (or flags).
 *
 * @returns Settings by name, as the service takes them: `null` for one cleared.
 * @throws CliError (exit 1, before anything is sent) `unknown_setting`, `conflicting_settings`,
 * and the value reasons of {@link settingsFromFlags}.
 */
export function settingsFromValues(
  setup: AgentSetupSpec,
  values: Record<string, SettingValue>,
  opts: Omit<FromFlagsOptions, "reserved" | "onlyKnown"> = {},
): Record<string, unknown> {
  const names = setup.settings.map((f) => f.name);
  const byName = new Map(
    setup.settings.flatMap((f) => [[f.name, f] as const, [f.name.replace(/_/g, "-"), f] as const, [f.flag, f] as const]),
  );
  const unknown = (key: string, extra = ""): never => {
    throw failed(
      `"${plainText(key)}" isn't a setting of this agent${extra}. It takes ${names.join(", ") || "no settings"}.`,
      "unknown_setting",
      { field: `settings.${key}`, setting: key, allowed: names, known_settings: byCloseness(key, names) },
    );
  };

  const settings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const f = byName.get(key.trim());
    if (!f) return unknown(key);
    if (Object.prototype.hasOwnProperty.call(settings, f.name)) {
      throw failed(`settings.${f.name} was given twice.`, "conflicting_settings", { field: `settings.${f.name}`, setting: f.name });
    }
    settings[f.name] = valueOf(f, givenOf(f, value), opts, settingNaming(f));
  }
  for (const raw of opts.clear ?? []) {
    const key = raw.replace(/^--/, "").trim();
    const f = byName.get(key);
    if (!f) return unknown(key, " to clear");
    if (Object.prototype.hasOwnProperty.call(settings, f.name)) {
      throw failed(`settings.${f.name} was both set and cleared; pick one.`, "conflicting_settings", {
        field: `settings.${f.name}`,
        setting: f.name,
      });
    }
    settings[f.name] = null;
  }
  return settings;
}

/** @returns A value by name as the flag values {@link valueOf} checks; refused when its type can't be the setting's. */
function givenOf(f: SettingField, value: SettingValue): Array<string | boolean> {
  const label = `settings.${f.name}`;
  const wrongType = (wants: string): never => {
    throw failed(`${label} takes ${wants}.`, `invalid_${reasonPart(f.flag)}`, { field: label, setting: f.name, rule: "type" });
  };
  if (f.type === "string_list") {
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value;
    return wrongType("a list of text");
  }
  if (Array.isArray(value)) return wrongType(f.type === "integer" ? "a whole number" : f.type === "boolean" ? "true or false" : "text");
  if (f.type === "boolean") {
    if (typeof value === "boolean") return [value ? true : "false"];
    return typeof value === "string" ? [value] : wrongType("true or false");
  }
  if (f.type === "integer") {
    if (typeof value === "number") return Number.isInteger(value) ? [String(value)] : wrongType(`a whole number${range(f)}`);
    return typeof value === "string" ? [value] : wrongType(`a whole number${range(f)}`);
  }
  return typeof value === "string" ? [value] : wrongType("text");
}

/** How a refusal names the setting it is about: the flag on the command line, or the field in a tool's arguments. */
interface Naming {
  /** `--slot-minutes`, or `settings.slot_minutes`. */
  label: string;
  /** Says where to look in the refusal's details: `{ flag }`, or `{ field, setting }`. */
  details: Record<string, unknown>;
  /** How to put a value back to the default: "use --clear to remove one". */
  clearHint: string;
}

/** @returns The naming for a flag. */
function flagNaming(f: SettingField): Naming {
  const flag = `--${f.flag}`;
  return { label: flag, details: { flag }, clearHint: "use --clear to remove one" };
}

/** @returns The naming for a setting given by name, as a tool takes it. */
function settingNaming(f: SettingField): Naming {
  const field = `settings.${f.name}`;
  return { label: field, details: { field, setting: f.name }, clearHint: `put "${f.name}" in clear to remove one` };
}

/** @returns The value one setting's flag gives, checked. */
function valueOf(f: SettingField, given: Array<string | boolean>, opts: FromFlagsOptions, naming: Naming): unknown {
  const flag = naming.label;
  const part = reasonPart(f.flag);
  const invalid = (why: string, rule: string, extra: Record<string, unknown> = {}): never => {
    throw failed(`${flag} ${why}.`, `invalid_${part}`, { ...naming.details, rule, ...extra });
  };
  const tooLong = (value: string, limit: number): void => {
    if (limit > 0 && value.length > limit) {
      throw failed(`${flag} is at most ${limit} characters (got ${value.length}).`, `${part}_too_long`, {
        ...naming.details,
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
        ...naming.details,
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
          { ...naming.details, model: value, allowed: offered },
        );
      }
      return value;
    }
    case "url": {
      if (!value) return invalid(`needs a URL; ${naming.clearHint}`, "url");
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
  /** `settings`: the refusal names the setting as a tool takes it, rather than the flag. */
  naming: "flags" | "settings" = "flags",
): void {
  for (const f of setup.settings) {
    if (!f.required) continue;
    const value = Object.prototype.hasOwnProperty.call(change, f.name) ? change[f.name] : stored[f.name];
    if (isEmpty(value)) {
      const what = f.label ? ` (${plainText(f.label)})` : "";
      if (naming === "settings") {
        throw failed(
          `${plainText(agentName)} needs the setting "${f.name}"${what}. Pass it in settings.`,
          `missing_${reasonPart(f.flag)}`,
          { field: `settings.${f.name}`, setting: f.name },
        );
      }
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
