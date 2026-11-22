/**
 * `nxis discovery files`: the generated documents are merged into the project, never over it.
 *
 * The existing files in `fixtures/discovery/existing` are hand-written the way a person or another
 * tool would have left them. Every test copies them into a fresh directory, runs the command
 * against the fake endpoint, and checks that everything that was there is still there.
 */

import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cmdDiscoveryFiles } from "../src/commands/discovery.js";
import { unifiedDiff } from "../src/diff.js";
import { detectStaticDir, DISCOVERY_PATHS, mergeDocument, targetPath, UnmergeableError } from "../src/discovery.js";
import { CliError, ExitCode } from "../src/errors.js";
import { setTrace } from "../src/trace.js";
import { capture, cleanFake, fake, resetFake, startFake, stopFake, toolCalls } from "./support/fake-endpoints.js";

const ENDPOINT = "https://example.mcp.example.net/mcp";
const FIXTURES = join(import.meta.dirname, "fixtures", "discovery", "existing");

let stamp = 0;

/** The documents as the server generates them; `updatedAt` changes on every call, as it does there. */
function generated(): Record<string, unknown> {
  stamp++;
  const updatedAt = `2026-11-03T10:00:0${stamp % 10}.000Z`;
  const publisher = { identifier: "urn:air:example.com", displayName: "example.com" };
  const aiCatalog = {
    specVersion: "1.0",
    host: publisher,
    entries: [
      {
        identifier: "urn:air:example.com:nxis:example",
        type: "application/mcp-server-card+json",
        displayName: "example.com — Structured Data",
        description: "Typed Schema.org data for example.com, queryable by AI agents over MCP.",
        version: "1.0.0",
        tags: ["mcp", "structured-data", "schema.org", "typed-retrieval"],
        publisher,
        url: `${ENDPOINT}/server-card`,
        updatedAt,
      },
    ],
  };
  const mcpCatalog = {
    specVersion: "draft",
    entries: [
      {
        identifier: "urn:air:example.com:nxis:example",
        displayName: "example.com — Structured Data",
        mediaType: "application/mcp-server-card+json",
        url: `${ENDPOINT}/server-card`,
      },
    ],
  };
  const llms = [
    "# example.com",
    "",
    "> This site is NxisAI-enabled: its content is available to AI agents as",
    "> typed Schema.org data over MCP, and key forms are agent-actionable.",
    "",
    "## Agent access",
    "",
    "- [Agent guide](https://example.com/agents.md): how to connect this site's MCP server",
    `- [MCP endpoint](${ENDPOINT}): Streamable HTTP MCP server (tools: nxis_list_types, nxis_query, nxis_get)`,
    "",
  ].join("\n");
  const agents = [
    "# Agent Guide — example.com",
    "",
    "> This site is NxisAI-enabled.",
    "",
    "- **Site:** example.com",
    "",
    "### Access & rate limits",
    "",
    "- Public access enabled.",
    "",
    "## 1. Connect to the MCP server",
    "",
    "```json",
    `{ "mcpServers": { "example": { "url": "${ENDPOINT}" } } }`,
    "```",
    "",
    "## 2. Read data",
    "",
    "Call `nxis_list_types` first.",
    "",
  ].join("\n");
  return {
    site: "example.com",
    mcp_endpoint: ENDPOINT,
    documents: [
      { path: "llms.txt", content: llms },
      { path: "agents.md", content: agents },
      { path: ".well-known/ai-catalog.json", content: JSON.stringify(aiCatalog, null, 2) },
      { path: ".well-known/mcp/catalog.json", content: JSON.stringify(mcpCatalog, null, 2) },
    ],
    note: "Write these to the site's public root and deploy.",
  };
}

let project: string;

beforeAll(startFake);
afterAll(stopFake);
beforeEach(() => {
  resetFake();
  fake.responses["nxis_aio_files"] = generated;
  project = mkdtempSync(join(tmpdir(), "nxis-project-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanFake();
  rmSync(project, { recursive: true, force: true });
});

const read = (...parts: string[]) => readFileSync(join(project, ...parts), "utf8");
const fixture = (...parts: string[]) => readFileSync(join(FIXTURES, ...parts), "utf8");

/** Copies the hand-written files into `<project>/public`. */
function withExisting(): string {
  const pub = join(project, "public");
  cpSync(FIXTURES, pub, { recursive: true });
  return pub;
}

async function run(args: Parameters<typeof cmdDiscoveryFiles>[1] = {}) {
  const { ctx, out } = capture();
  await cmdDiscoveryFiles(ctx, { cwd: project, ...args });
  return out;
}

async function caught(fn: () => Promise<unknown>): Promise<CliError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(CliError);
    return err as CliError;
  }
  throw new Error("expected a failure");
}

describe("discovery files, without --write", () => {
  it("prints each document with its path, and writes nothing", async () => {
    mkdirSync(join(project, "public"));
    const out = await run();
    expect(toolCalls()).toEqual([
      expect.objectContaining({ endpoint: "provisioning", tool: "nxis_aio_files", args: { site: "site-1" } }),
    ]);
    const docs = out.json["documents"] as Array<{ path: string }>;
    expect(docs.map((d) => d.path)).toEqual(["llms.txt", "agents.md", ".well-known/ai-catalog.json", ".well-known/mcp/catalog.json"]);
    expect(out.json["mcp_endpoint"]).toBe(ENDPOINT);
    expect(out.text).toContain("── .well-known/ai-catalog.json ──");
    expect(existsSync(join(project, "public", "llms.txt"))).toBe(false);
  });
});

describe("discovery files --write, into an empty project", () => {
  it("creates every document under the static folder", async () => {
    mkdirSync(join(project, "public"));
    const out = await run({ write: true });
    const files = out.json["files"] as Array<{ path: string; status: string }>;
    expect(files.map((f) => f.status)).toEqual(["created", "created", "created", "created"]);
    expect(out.json["written"]).toBe(true);
    expect(JSON.parse(read("public", ".well-known", "ai-catalog.json")).entries).toHaveLength(1);
    expect(read("public", "llms.txt")).toMatch(/^# example\.com\n/);
  });

  it("changes nothing on a second run, though the server stamps a new updatedAt", async () => {
    mkdirSync(join(project, "public"));
    await run({ write: true });
    const before = read("public", ".well-known", "ai-catalog.json");
    const out = await run({ write: true });
    const files = out.json["files"] as Array<{ status: string; diff: string }>;
    expect(files.map((f) => f.status)).toEqual(["unchanged", "unchanged", "unchanged", "unchanged"]);
    expect(files.every((f) => f.diff === "")).toBe(true);
    expect(out.json["written"]).toBe(false);
    expect(read("public", ".well-known", "ai-catalog.json")).toBe(before);
    expect(out.text).toContain("Already up to date");
  });
});

describe("discovery files --write, over hand-written files", () => {
  it("keeps llms.txt's title, summary, notes and sections, and adds only the missing links", async () => {
    const pub = withExisting();
    await run({ write: true });
    const after = readFileSync(join(pub, "llms.txt"), "utf8");
    const before = fixture("llms.txt");
    // Every line they wrote is still there, in order.
    expect(after.startsWith(before.slice(0, before.indexOf("## Agent access")))).toBe(true);
    expect(after).toContain("- [Our own API docs](https://example.com/api): for partners");
    expect(after).not.toContain("# example.com\n");
    expect(after.match(/^## Agent access$/gm)).toHaveLength(1);
    expect(after).toBe(
      before +
        "- [Agent guide](https://example.com/agents.md): how to connect this site's MCP server\n" +
        `- [MCP endpoint](${ENDPOINT}): Streamable HTTP MCP server (tools: nxis_list_types, nxis_query, nxis_get)\n`,
    );
  });

  it("appends a missing llms.txt section after theirs", async () => {
    const pub = join(project, "public");
    mkdirSync(pub);
    writeFileSync(join(pub, "llms.txt"), "# Mine\n\n> My summary.\n\n## Docs\n\n- [Docs](https://example.com/docs)\n");
    await run({ write: true });
    const after = read("public", "llms.txt");
    expect(after.startsWith("# Mine\n\n> My summary.\n\n## Docs\n\n- [Docs](https://example.com/docs)\n\n## Agent access\n")).toBe(true);
    expect(after).not.toContain("NxisAI-enabled");
  });

  it("keeps agents.md as it is and appends the guide as one section", async () => {
    const pub = withExisting();
    await run({ write: true });
    const after = readFileSync(join(pub, "agents.md"), "utf8");
    expect(after.startsWith(fixture("agents.md"))).toBe(true);
    expect(after).toContain("\n## Agent Guide — example.com\n");
    expect(after).toContain("\n### 1. Connect to the MCP server\n");
    expect(after).toContain("\n#### Access & rate limits\n");
    expect(after.match(/^# /gm)).toHaveLength(1);
  });

  it("keeps every ai-catalog.json entry and title, and adds the site's", async () => {
    const pub = withExisting();
    await run({ write: true });
    const before = JSON.parse(fixture(".well-known", "ai-catalog.json"));
    const after = JSON.parse(readFileSync(join(pub, ".well-known", "ai-catalog.json"), "utf8"));
    expect(after.host).toEqual(before.host);
    expect(after.entries[0]).toEqual(before.entries[0]);
    expect(after.entries).toHaveLength(2);
    expect(after.entries[1]).toMatchObject({ identifier: "urn:air:example.com:nxis:example", url: `${ENDPOINT}/server-card` });
  });

  it("updates an mcp/catalog.json entry in place: its name kept, its stale URL corrected, no duplicate", async () => {
    const pub = withExisting();
    await run({ write: true });
    const text = readFileSync(join(pub, ".well-known", "mcp", "catalog.json"), "utf8");
    const after = JSON.parse(text);
    expect(after.entries).toHaveLength(1);
    expect(after.entries[0]).toEqual({
      identifier: "urn:air:example.com:nxis:example",
      displayName: "Example Outfitters data (renamed by us)",
      mediaType: "application/mcp-server-card+json",
      url: `${ENDPOINT}/server-card`,
    });
    // Their four-space indentation is kept.
    expect(text).toContain('\n    "specVersion": "draft"');
  });

  it("prints a unified diff of every change before reporting", async () => {
    withExisting();
    const out = await run({ write: true });
    const files = out.json["files"] as Array<{ path: string; status: string; diff: string }>;
    expect(files.map((f) => f.status)).toEqual(["merged", "merged", "merged", "merged"]);
    const llms = files.find((f) => f.path === "llms.txt")?.diff ?? "";
    expect(llms).toMatch(/^--- a\/public\/llms\.txt\n\+\+\+ b\/public\/llms\.txt\n@@ /);
    expect(llms).toContain("+- [Agent guide](https://example.com/agents.md)");
    expect(llms.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"))).toEqual([]);
    expect(out.text.indexOf("+++ b/public/llms.txt")).toBeLessThan(out.text.search(/merged +public\/llms\.txt/));
  });

  it("is idempotent over hand-written files", async () => {
    withExisting();
    await run({ write: true });
    const snapshot = ["llms.txt", "agents.md", ".well-known/ai-catalog.json", ".well-known/mcp/catalog.json"].map((p) =>
      read("public", p),
    );
    const out = await run({ write: true });
    expect((out.json["files"] as Array<{ status: string }>).map((f) => f.status)).toEqual([
      "unchanged",
      "unchanged",
      "unchanged",
      "unchanged",
    ]);
    expect(
      ["llms.txt", "agents.md", ".well-known/ai-catalog.json", ".well-known/mcp/catalog.json"].map((p) => read("public", p)),
    ).toEqual(snapshot);
  });

  it("shows the diff and writes nothing under --dry-run", async () => {
    const pub = withExisting();
    setTrace({ dryRun: true, verbose: false });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const out = await run({ write: true });
    expect(out.json["dry_run"]).toBe(true);
    expect(out.json["written"]).toBe(false);
    expect((out.json["files"] as Array<{ diff: string }>).some((f) => f.diff.includes("+++"))).toBe(true);
    expect(readFileSync(join(pub, "llms.txt"), "utf8")).toBe(fixture("llms.txt"));
    expect(readFileSync(join(pub, ".well-known", "ai-catalog.json"), "utf8")).toBe(fixture(".well-known", "ai-catalog.json"));
    expect(out.text).toContain("Dry run: nothing was written.");
  });

  it("refuses an ai-catalog.json that is not valid JSON, and writes nothing at all", async () => {
    const pub = withExisting();
    writeFileSync(join(pub, ".well-known", "ai-catalog.json"), "{ not json");
    const err = await caught(() => run({ write: true }));
    expect(err.reason).toBe("discovery_unmergeable");
    expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
    expect(err.details["files"]).toEqual([expect.objectContaining({ path: ".well-known/ai-catalog.json" })]);
    expect(readFileSync(join(pub, ".well-known", "ai-catalog.json"), "utf8")).toBe("{ not json");
    expect(readFileSync(join(pub, "llms.txt"), "utf8")).toBe(fixture("llms.txt"));
  });

  it("writes into --out, relative to the project", async () => {
    mkdirSync(join(project, "public"));
    mkdirSync(join(project, "static"));
    await run({ write: true, out: "site/root" });
    expect(existsSync(join(project, "site", "root", ".well-known", "mcp", "catalog.json"))).toBe(true);
  });
});

describe("discovery files --write, for a site with hosted specialists", () => {
  const AGENTS = "https://agents.example.net/v1/s/507f1f77bcf86cd799439012/agents";

  /** The documents with the edge's A2A agent list in ai-catalog.json, as the server adds it for such a site. */
  function withAgentList(): Record<string, unknown> {
    const out = generated();
    const docs = out["documents"] as Array<{ path: string; content: string }>;
    const doc = docs.find((d) => d.path === ".well-known/ai-catalog.json")!;
    const catalog = JSON.parse(doc.content) as { host: unknown; entries: Array<Record<string, unknown>> };
    catalog.entries.push({
      identifier: "urn:air:example.com:nxis:example:agents",
      type: "application/a2a-agent-list+json",
      displayName: "example.com — Agents",
      description: "The specialist agents hosted for example.com, as A2A Agent Cards.",
      version: "1.0.0",
      tags: ["a2a", "agents", "agent-card"],
      publisher: catalog.host,
      url: AGENTS,
      updatedAt: catalog.entries[0]!["updatedAt"],
    });
    doc.content = JSON.stringify(catalog, null, 2);
    return out;
  }

  it("adds the agent list entry to a catalog written before the site had any, and keeps every other entry", async () => {
    await run({ write: true, out: "public" });
    const before = JSON.parse(read("public", ".well-known", "ai-catalog.json"));
    expect(before.entries).toHaveLength(1);

    fake.responses["nxis_aio_files"] = withAgentList;
    await run({ write: true, out: "public" });
    const after = JSON.parse(read("public", ".well-known", "ai-catalog.json"));
    expect(after.entries).toHaveLength(2);
    expect(after.entries[0]).toEqual(before.entries[0]);
    expect(after.entries[1]).toMatchObject({ type: "application/a2a-agent-list+json", url: AGENTS });
  });

  it("changes nothing on a second run, and keeps a site's own agent card entry beside it", async () => {
    const pub = withExisting();
    const own = { identifier: "urn:air:example.com:booking", type: "application/a2a-agent-card+json", url: "https://example.com/.well-known/agent-card.json" };
    const file = join(pub, ".well-known", "ai-catalog.json");
    const existing = JSON.parse(readFileSync(file, "utf8"));
    existing.entries.push(own);
    writeFileSync(file, JSON.stringify(existing, null, 2) + "\n");

    fake.responses["nxis_aio_files"] = withAgentList;
    await run({ write: true });
    const once = read("public", ".well-known", "ai-catalog.json");
    const entries = JSON.parse(once).entries as Array<Record<string, unknown>>;
    expect(entries).toContainEqual(own);
    expect(entries.filter((e) => e["url"] === AGENTS)).toHaveLength(1);

    await run({ write: true });
    expect(read("public", ".well-known", "ai-catalog.json")).toBe(once);
  });
});

describe("where --write writes", () => {
  it("asks for --out when there is no static folder, before calling anything", async () => {
    const err = await caught(() => run({ write: true }));
    expect(err.reason).toBe("out_dir_required");
    expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
    expect(toolCalls()).toEqual([]);
  });

  it("asks for --out when both public/ and static/ exist", async () => {
    mkdirSync(join(project, "public"));
    mkdirSync(join(project, "static"));
    const err = await caught(() => run({ write: true }));
    expect(err.reason).toBe("out_dir_required");
    expect(err.details["candidates"]).toEqual(["public", "static"]);
  });

  it("uses static/ when it is the only one, and never a build folder", () => {
    mkdirSync(join(project, "static"));
    mkdirSync(join(project, "dist"));
    expect(detectStaticDir(project).dir).toBe(join(project, "static"));
    rmSync(join(project, "static"), { recursive: true });
    expect(detectStaticDir(project).dir).toBeNull();
  });

  it("refuses a document path that leaves the output folder", async () => {
    mkdirSync(join(project, "public"));
    fake.responses["nxis_aio_files"] = () => ({ documents: [{ path: "../escape.txt", content: "x" }] });
    const err = await caught(() => run({ write: true }));
    expect(err.reason).toBe("unsafe_path");
    expect(existsSync(join(project, "escape.txt"))).toBe(false);
    expect(targetPath("/a/b", "/etc/passwd")).toBeNull();
    expect(targetPath("/a/b", "x/../../y")).toBeNull();
  });

  it("refuses any path that is not a discovery document, before writing any of them", async () => {
    for (const path of ["index.html", "sw.js", "_headers", ".well-known/security.txt", "public/llms.txt", "LLMS.TXT"]) {
      const pub = join(project, "public");
      mkdirSync(pub, { recursive: true });
      fake.responses["nxis_aio_files"] = () => ({
        ...generated(),
        documents: [...generated().documents, { path, content: "<script>owned()</script>" }],
      });
      const err = await caught(() => run({ write: true }));
      expect(err.reason).toBe("unsafe_path");
      expect(err.message).toContain("Nothing was written.");
      expect(err.details["path"]).toBe(path);
      expect(readdirSync(pub)).toEqual([]);
      rmSync(pub, { recursive: true });
    }
  });

  it("writes only the four discovery documents, wherever the server roots their paths", () => {
    expect([...DISCOVERY_PATHS]).toEqual(["llms.txt", "agents.md", ".well-known/ai-catalog.json", ".well-known/mcp/catalog.json"]);
    expect(targetPath("/a/b", "llms.txt")).toBe(join("/a/b", "llms.txt"));
    expect(targetPath("/a/b", "/.well-known/mcp/catalog.json")).toBe(join("/a/b", ".well-known", "mcp", "catalog.json"));
    expect(targetPath("/a/b", "./agents.md")).toBe(join("/a/b", "agents.md"));
    expect(targetPath("/a/b", ".well-known/../index.html")).toBeNull();
  });
});

describe("mergeDocument", () => {
  const catalog = (entries: unknown[]) => JSON.stringify({ specVersion: "1.0", entries }, null, 2);
  const gen = catalog([{ identifier: "urn:x", url: `${ENDPOINT}/server-card`, displayName: "Generated", updatedAt: "t1" }]);

  it("finds an entry by its URL on the endpoint, whatever its identifier", () => {
    const existing = catalog([{ identifier: "mine", url: `${ENDPOINT}/server-card`, displayName: "Mine" }]);
    const { content } = mergeDocument("ai-catalog.json", existing, gen, { mcpEndpoint: ENDPOINT });
    const entries = JSON.parse(content).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ identifier: "mine", displayName: "Mine", url: `${ENDPOINT}/server-card` });
  });

  it("finds an entry pointing at the bare endpoint, and leaves its URL", () => {
    const existing = catalog([{ url: `${ENDPOINT}/`, displayName: "Mine" }]);
    const { content } = mergeDocument("ai-catalog.json", existing, gen, { mcpEndpoint: ENDPOINT });
    expect(JSON.parse(content).entries).toEqual([
      { url: `${ENDPOINT}/`, displayName: "Mine", identifier: "urn:x", updatedAt: "t1" },
    ]);
  });

  it("leaves a file with nothing to add byte for byte", () => {
    const existing = '{"specVersion":"1.0","entries":[{"identifier":"urn:x","url":"' + ENDPOINT + '/server-card","displayName":"Mine","updatedAt":"t0"}]}';
    expect(mergeDocument("ai-catalog.json", existing, gen, { mcpEndpoint: ENDPOINT })).toEqual({
      content: existing,
      status: "unchanged",
    });
  });

  it("refuses `entries` that is not a list", () => {
    expect(() => mergeDocument("a.json", '{"entries": {}}', gen)).toThrow(UnmergeableError);
  });

  it("keeps CRLF line endings", () => {
    const existing = "# Mine\r\n\r\n## Docs\r\n\r\n- [Docs](https://example.com/docs)\r\n";
    const { content } = mergeDocument("llms.txt", existing, "# G\n\n## Agent access\n\n- [MCP](https://e/mcp)\n");
    expect(content.startsWith(existing)).toBe(true);
    expect(content).not.toMatch(/[^\r]\n/);
  });

  it("does not take a heading inside a code fence for a section", () => {
    const existing = "# Mine\n\n```\n## Agent access\n```\n";
    const { content } = mergeDocument("llms.txt", existing, "# G\n\n## Agent access\n\n- [MCP](https://e/mcp)\n");
    expect(content).toBe(`${existing}\n## Agent access\n\n- [MCP](https://e/mcp)\n`);
  });

  it("leaves an agents.md that already names the endpoint", () => {
    const existing = `# Our guide\n\nConnect to ${ENDPOINT}.\n`;
    expect(mergeDocument("agents.md", existing, "# Agent Guide — x\n", { mcpEndpoint: ENDPOINT }).status).toBe("unchanged");
  });

  it("treats an empty file as nothing to keep", () => {
    expect(mergeDocument("llms.txt", "\n", "# G\n")).toEqual({ content: "# G\n", status: "merged" });
  });
});

describe("unifiedDiff", () => {
  it("is empty for equal texts", () => {
    expect(unifiedDiff("a\n", "a\n", { from: "a", to: "b" })).toBe("");
  });

  it("shows a new file against /dev/null", () => {
    expect(unifiedDiff(null, "x\ny\n", { from: "a/f", to: "b/f" })).toBe("--- /dev/null\n+++ b/f\n@@ -0,0 +1,2 @@\n+x\n+y\n");
  });

  it("numbers hunks as diff -u does", () => {
    const a = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"].join("\n") + "\n";
    const b = a.replace("5\n", "five\n");
    expect(unifiedDiff(a, b, { from: "a", to: "b" })).toBe(
      "--- a\n+++ b\n@@ -2,7 +2,7 @@\n 2\n 3\n 4\n-5\n+five\n 6\n 7\n 8\n",
    );
  });
});
