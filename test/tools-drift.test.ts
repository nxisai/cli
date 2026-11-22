/**
 * The tool definitions against the server's recorded `tools/list`.
 *
 * The fixture is what the endpoints listed when it was recorded (`scripts/record-tools.mjs`). When
 * the server changes a tool, re-recording changes the fixture and these tests fail until the
 * definition in `src/tools/` matches again. The last block proves the comparison can fail.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TOOLS, getTool, type ToolDef } from "../src/tools/index.js";
import { schemaDiff, type JsonSchema } from "./support/schema-drift.js";

interface RecordedTool {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
}

interface Fixture {
  provisioning: { tools: RecordedTool[] };
  site: { tools: RecordedTool[] };
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/provisioning-tools.json", import.meta.url), "utf8"),
) as Fixture;

/** @returns Our input schema as JSON Schema, the way the SDK converts it for `tools/list`. */
function ours(tool: ToolDef): JsonSchema {
  return z.toJSONSchema(tool.input, { io: "input", target: "draft-7" }) as JsonSchema;
}

/** @returns Every difference between a definition and a recorded tool. */
function drift(tool: ToolDef, recorded: RecordedTool): string[] {
  const out = schemaDiff(ours(tool), recorded.inputSchema);
  if (tool.description !== recorded.description) out.unshift("description differs from the server's");
  return out;
}

/** @returns The recorded tool for a definition, on its own surface. */
function recordedFor(tool: ToolDef): RecordedTool | undefined {
  if (tool.surface === "local") return undefined;
  return fixture[tool.surface].tools.find((t) => t.name === tool.name);
}

describe("the recorded fixture", () => {
  it("has every tool we define, on the surface we call it on", () => {
    // The CLI's own tools (surface `local`) have no remote counterpart to record.
    const missing = TOOLS.filter((tool) => tool.surface !== "local" && !recordedFor(tool)).map((t) => `${t.surface}: ${t.name}`);
    expect(missing).toEqual([]);
  });

  it("has no provisioning tool we do not define", () => {
    // A new provisioning tool is something the CLI and `nxis mcp serve` should offer.
    const extra = fixture.provisioning.tools.map((t) => t.name).filter((name) => getTool(name)?.surface !== "provisioning");
    expect(extra).toEqual([]);
  });
});

describe.each(TOOLS.filter((t) => t.surface !== "local").map((tool) => [tool.name, tool] as const))("%s", (_name, tool) => {
  it("matches the server's input schema and description", () => {
    const recorded = recordedFor(tool);
    expect(recorded).toBeDefined();
    expect(drift(tool, recorded as RecordedTool)).toEqual([]);
  });

  it("takes `site` exactly when it is a site-scoped provisioning tool", () => {
    const props = Object.keys(ours(tool).properties ?? {});
    expect(props.includes("site")).toBe(tool.takesSite);
    if (tool.surface === "site") expect(tool.takesSite).toBe(false);
  });
});

describe("the drift check", () => {
  /** A copy of one recorded tool, changed by `edit`. */
  function edited(name: string, edit: (schema: JsonSchema) => void): RecordedTool {
    const tool = getTool(name) as ToolDef;
    const copy = structuredClone(recordedFor(tool)) as RecordedTool;
    edit(copy.inputSchema);
    return copy;
  }

  const autofill = () => getTool("nxis_bulk_autofill") as ToolDef;
  const props = (s: JsonSchema) => s.properties as Record<string, JsonSchema>;

  it("fails when the server renames a property", () => {
    const changed = edited("nxis_bulk_autofill", (s) => {
      props(s)["media"] = props(s)["media_type"] as JsonSchema;
      delete props(s)["media_type"];
    });
    expect(drift(autofill(), changed)).toEqual(
      expect.arrayContaining([
        "(input).media: missing here, the server has it",
        "(input).media_type: not on the server",
      ]),
    );
  });

  it("fails when the server adds a value to an enum", () => {
    const changed = edited("nxis_bulk_autofill", (s) => {
      (props(s)["existing"] as JsonSchema).enum?.push("replace");
    });
    expect(drift(autofill(), changed).join("\n")).toMatch(/\(input\)\.existing: enum/);
  });

  it("fails when the server changes a type or the required set", () => {
    const changed = edited("nxis_bulk_autofill", (s) => {
      (props(s)["partial_ok"] as JsonSchema).type = "string";
      s.required = ["mode", "batch_id"];
    });
    const diff = drift(autofill(), changed).join("\n");
    expect(diff).toMatch(/\(input\)\.partial_ok: type/);
    expect(diff).toMatch(/\(input\): required/);
  });

  it("fails on a change inside a nested object or array", () => {
    const changed = edited("nxis_query", (s) => {
      const filter = props(s)["filter"] as JsonSchema;
      const items = props(filter)["field_filters"]?.items as JsonSchema;
      (props(items)["operator"] as JsonSchema).enum = ["EQUALS"];
    });
    expect(drift(getTool("nxis_query") as ToolDef, changed).join("\n")).toMatch(
      /\(input\)\.filter\.field_filters\[\]\.operator: enum/,
    );
  });

  it("fails when the server rewords a description", () => {
    const tool = getTool("nxis_verify_site") as ToolDef;
    const changed = { ...(recordedFor(tool) as RecordedTool), description: "Something else." };
    expect(drift(tool, changed)).toContain("description differs from the server's");
  });
});

describe("the recorder", () => {
  it("keeps name, description and input schema, sorted, and the old site tools when the site was not recorded", async () => {
    const { toFixture } = (await import("../scripts/record-tools.mjs")) as {
      toFixture: (listed: unknown, previous: unknown, now: Date) => Fixture & { source: string; recorded_at: string };
    };
    const listed = {
      provisioning: [
        { name: "b", description: "B", inputSchema: { type: "object" }, _meta: { x: 1 }, annotations: {} },
        { name: "a", inputSchema: { type: "object", properties: {} } },
      ],
      site: null,
    };
    const out = toFixture(listed, fixture, new Date("2026-01-02T03:04:05Z"));
    expect(out.provisioning.tools).toEqual([
      { name: "a", description: null, inputSchema: { type: "object", properties: {} } },
      { name: "b", description: "B", inputSchema: { type: "object" } },
    ]);
    expect(out.site).toEqual(fixture.site);
    expect(out.source).toBe("recorded");
    expect(out.recorded_at).toBe("2026-01-02");
  });
});
