/** Flags checked against a setup block, with the service's rules. */

import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { parseSetup } from "../src/api/hosted-agents.js";
import { camelKeys } from "../src/api/agent-config.js";
import { reservedWith, settingsFromFlags } from "../src/commands/agent-settings.js";
import { CliError } from "../src/errors.js";

const RAW = {
  settings: [
    { name: "chat_name", type: "SETTING_STRING", max_length: 60, flag: "chat-name" },
    { name: "logo_url", type: "SETTING_URL", max_length: 2048 },
    { name: "accent_color", type: "SETTING_COLOR" },
    { name: "suggestions", type: "SETTING_STRING_LIST", max_items: 6, item_max_length: 80, distinct_items: true, flag: "suggestion" },
    { name: "open_late", type: "SETTING_BOOLEAN" },
    { name: "mood", type: 99 },
  ],
  prerequisites: [],
  pausable: true,
};
const setup = parseSetup(camelKeys(RAW), RAW)!;

function from(argv: string[], opts = {}) {
  return settingsFromFlags(setup, parseArgs(argv).flags, opts);
}

function reason(argv: string[]): string {
  try {
    from(argv);
  } catch (e) {
    return (e as CliError).reason;
  }
  return "ok";
}

describe("settingsFromFlags", () => {
  it("names flags from the setup, or the setting name with dashes", () => {
    expect(from(["--chat-name", " Ava ", "--logo-url", "https://example.com/l.svg", "--accent-color", "#C73A17"])).toEqual({
      chat_name: "Ava",
      logo_url: "https://example.com/l.svg",
      accent_color: "#C73A17",
    });
  });

  it("checks URLs, colors, lists and booleans", () => {
    expect(reason(["--logo-url", "http://example.com/l.svg"])).toBe("invalid_logo_url");
    expect(reason(["--logo-url", "/l.svg"])).toBe("invalid_logo_url");
    expect(reason(["--logo-url", 'https://example.com/"><script>'])).toBe("invalid_logo_url");
    expect(reason(["--accent-color", "red"])).toBe("invalid_accent_color");
    expect(reason(["--suggestion", "a", "--suggestion", "a "])).toBe("invalid_suggestion");
    // Case is ignored, as the service ignores it; a one-line value refuses a line break.
    expect(reason(["--suggestion", "Hours?", "--suggestion", "hours?"])).toBe("invalid_suggestion");
    expect(reason(["--suggestion", "a\nb"])).toBe("invalid_suggestion");
    expect(reason(["--chat-name", "Ava\nBot"])).toBe("invalid_chat_name");
    expect(reason(Array.from({ length: 7 }, (_, i) => ["--suggestion", `s${i}`]).flat())).toBe("too_many_suggestions");
    expect(reason(["--suggestion", "x".repeat(81)])).toBe("suggestion_too_long");
    expect(reason(["--open-late", "maybe"])).toBe("invalid_open_late");
    expect(reason(["--chat-name"])).toBe("invalid_chat_name");
    expect(reason(["--color", "#fff"])).toBe("unknown_flag");
    expect(from(["--open-late", "false"])).toEqual({ open_late: false });
    expect(from(["--open-late"])).toEqual({ open_late: true });
    // A type this CLI doesn't know is sent as text.
    expect(from(["--mood", "calm"])).toEqual({ mood: "calm" });
  });

  it("takes http URLs on a local stack", () => {
    expect(from(["--logo-url", "http://localhost:8080/l.svg"], { allowHttp: true })).toEqual({ logo_url: "http://localhost:8080/l.svg" });
  });

  it("clears with null, and ignores the global flags", () => {
    expect(from(["--clear", "suggestion", "--json", "--site", "x"], { clear: ["suggestion"], reserved: reservedWith("clear") })).toEqual({ suggestions: null });
  });

  it("clears by the setting's name as well as its flag", () => {
    expect(from([], { clear: ["suggestions"] })).toEqual({ suggestions: null });
    expect(from([], { clear: ["chat_name", "logo-url"] })).toEqual({ chat_name: null, logo_url: null });
    expect(() => from([], { clear: ["suggestionz"] })).toThrow(CliError);
  });
});
