/**
 * `nxis agents transcripts …`: a site's hosted transcripts and their webhook, against an in-process
 * sites service that answers TranscriptService's HTTP routes as the gateway does (snake_case or
 * lowerCamelCase, counts as strings), and the agent config as AgentConfigService does.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/args.js";
import { camelKeys } from "../src/api/agent-config.js";
import { csvField, CSV_BOM, generateSecret, transcriptsCsv, type Transcript } from "../src/api/transcripts.js";
import { runTranscripts } from "../src/commands/transcripts.js";
import { runHostedAgents } from "../src/commands/hosted-agents.js";
import { CliError } from "../src/errors.js";
import type { Asker } from "../src/prompt.js";
import { setTrace } from "../src/trace.js";
import { capture, cleanFake, fake, ORG, resetFake, startFake, stopFake } from "./support/fake-endpoints.js";

const SITE = "0123456789abcdef01234567";
const PARENT = `/v1/organizations/${ORG}/sites/${SITE}`;
const NAME = (id: string) => `organizations/${ORG}/sites/${SITE}/transcripts/${id}`;

/** The fake's conversations, in lowerCamelCase, newest first. */
let conversations: Record<string, unknown>[];
/** The fake's agent config, in lowerCamelCase. */
let stored: Record<string, unknown>;
/** The secret the edge holds, by ref. */
let edgeSecrets: Map<string, string>;
let style: "snake" | "camel";
/** Export page size. */
let exportPageSize: number;

function snakeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), snakeKeys(v)]),
    );
  }
  return value;
}
const styled = (body: unknown) => (style === "snake" ? snakeKeys(body) : body);

function conversation(id: string, i: number, messages: Record<string, unknown>[]): Record<string, unknown> {
  return {
    name: NAME(id),
    agent: i % 2 ? "support" : "page",
    startTime: `2026-11-1${i}T09:00:00Z`,
    lastTime: `2026-11-1${i}T09:05:00Z`,
    expireTime: `2026-12-1${i}T09:05:00Z`,
    messageCount: String(messages.length),
    preview: (messages[0]?.["text"] as string | undefined) ?? "",
    messages,
  };
}

const withoutMessages = ({ messages: _m, ...rest }: Record<string, unknown>) => rest;

function service(): void {
  fake.sites = (req) => {
    const [path = "", q = ""] = req.url.split("?");
    const params = new URLSearchParams(q);
    const offset = Number(params.get("page_token") || 0);
    if (path === `${PARENT}/agentConfig`) {
      if (req.method === "GET") return { status: 200, body: styled({ ...stored, version: String(stored["version"]) }) };
      if (req.method === "PATCH") {
        const expected = Number(new URLSearchParams(q).get("expectedVersion"));
        if (expected !== stored["version"]) return { status: 409, body: { message: "version mismatch" } };
        const body = camelKeys(req.body) as Record<string, unknown>;
        const t = (body["transcripts"] ?? {}) as Record<string, unknown>;
        const keep = (stored["transcripts"] ?? {}) as Record<string, unknown>;
        // UpdateAgentConfig keeps the webhook fields as stored, whatever is sent.
        stored = {
          ...body,
          transcripts: { ...t, webhookUrl: keep["webhookUrl"] ?? "", webhookSecretId: keep["webhookSecretId"] ?? "" },
          version: (stored["version"] as number) + 1,
        };
        return { status: 200, body: styled(stored) };
      }
    }
    if (path === `${PARENT}/agentConfig:setTranscriptWebhook` && req.method === "POST") {
      const body = camelKeys(req.body) as Record<string, string>;
      const t = { ...((stored["transcripts"] ?? {}) as Record<string, unknown>) };
      if (!body["webhookUrl"]) {
        t["webhookUrl"] = "";
        t["webhookSecretId"] = "";
      } else if (body["secret"]) {
        const ref = `wh_${edgeSecrets.size + 1}`;
        edgeSecrets.set(ref, body["secret"]);
        t["webhookUrl"] = body["webhookUrl"];
        t["webhookSecretId"] = ref;
      } else if (t["webhookSecretId"]) {
        t["webhookUrl"] = body["webhookUrl"];
      } else {
        return { status: 400, body: { message: "a first webhook needs a secret" } };
      }
      stored = { ...stored, transcripts: t, version: (stored["version"] as number) + 1 };
      return { status: 200, body: styled(stored) };
    }
    if (path === `${PARENT}/transcripts` && req.method === "GET") {
      const size = Number(params.get("page_size") || 25);
      const page = conversations.slice(offset, offset + size).map(withoutMessages);
      const next = offset + size < conversations.length ? String(offset + size) : "";
      return { status: 200, body: styled({ transcripts: page, ...(next ? { nextPageToken: next } : {}) }) };
    }
    if (path === `${PARENT}/transcripts:export` && req.method === "GET") {
      const page = conversations.slice(offset, offset + exportPageSize);
      const next = offset + exportPageSize < conversations.length ? String(offset + exportPageSize) : "";
      return { status: 200, body: styled({ transcripts: page, nextPageToken: next, exportTime: "2026-11-15T10:00:00Z" }) };
    }
    if (path === `${PARENT}/transcripts:deleteAll` && req.method === "POST") {
      const n = conversations.length;
      conversations = [];
      return { status: 200, body: styled({ deletedCount: n }) };
    }
    if (path === `${PARENT}/transcripts:webhookStatus` && req.method === "GET") {
      const t = (stored["transcripts"] ?? {}) as Record<string, unknown>;
      return {
        status: 200,
        body: styled({
          webhookUrl: t["webhookUrl"] ?? "",
          secretSet: Boolean(t["webhookSecretId"]),
          deliveredCount: "41",
          failedCount: "1",
          deadLetters: [
            { eventId: "ev-1", transcript: NAME("t-1"), time: "2026-11-14T09:00:00Z", attempts: 5, lastStatus: 502, error: "Bad gateway" },
          ],
        }),
      };
    }
    const one = /\/transcripts\/([^/]+)$/.exec(path);
    if (one && path.startsWith(`${PARENT}/transcripts/`)) {
      const id = decodeURIComponent(one[1] as string);
      const found = conversations.find((c) => c["name"] === NAME(id));
      if (!found) return { status: 404, body: { code: 5, message: "transcript not found" } };
      if (req.method === "GET") return { status: 200, body: styled(found) };
      if (req.method === "DELETE") {
        conversations = conversations.filter((c) => c !== found);
        return { status: 200, body: {} };
      }
    }
    return { status: 404 };
  };
}

function seed(): void {
  conversations = [
    conversation("t-1", 1, [
      { id: "m1", role: "visitor", text: "Reach me at [email]", time: "2026-11-11T09:00:00Z", turn: "u1" },
      { id: "m2", role: "agent", text: 'Sure, "noted", thanks\nBye', time: "2026-11-11T09:00:05Z", turn: "u1", toolCall: "lookup" },
    ]),
    conversation("t-2", 2, [{ id: "m3", role: "visitor", text: "=HYPERLINK(\"x\")", time: "2026-11-12T09:00:00Z", refusal: "input/lockdown" }]),
    conversation("t-3", 3, []),
  ];
  stored = {
    name: `organizations/${ORG}/sites/${SITE}/agentConfig`,
    version: 4,
    page: { enabled: true, model: "" },
    support: { enabled: false, label: "Help" },
    policy: "",
    transcripts: { doNotStore: false, retentionDays: 0, webhookUrl: "", webhookSecretId: "" },
  };
}

/** An asker that answers each question as told, and counts them. */
function asker(answer: boolean, interactive = true): Asker & { asked: string[] } {
  const asked: string[] = [];
  return { interactive, asked, confirm: async (q) => (asked.push(q), answer) };
}

async function run(argv: string[], ask: Asker = asker(false, false), json = true) {
  const { positional, flags } = parseArgs(argv);
  const { ctx, out } = capture({ siteOverride: SITE });
  if (!json) ctx.io = { ...ctx.io, json: false };
  await runTranscripts(ctx, positional, flags, ask);
  return out;
}

async function fails(argv: string[], reason: string, ask?: Asker): Promise<CliError> {
  const err = await run(argv, ask).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CliError);
  expect((err as CliError).reason).toBe(reason);
  return err as CliError;
}

const calls = (method: string, part: string) => fake.sitesCalls.filter((c) => c.method === method && c.url.includes(part));

let dir = "";
beforeAll(startFake);
afterAll(stopFake);
beforeEach(() => {
  resetFake();
  process.env.NXIS_TOKEN = "header.payload.sig";
  edgeSecrets = new Map();
  style = "snake";
  exportPageSize = 2;
  seed();
  service();
  dir = mkdtempSync(join(tmpdir(), "nxis-export-"));
});
afterEach(() => {
  cleanFake();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("list and show", () => {
  it.each(["snake", "camel"] as const)("lists a page from a %s_case answer, without messages", async (s) => {
    style = s;
    const out = await run(["list", "--limit", "2"]);
    expect(calls("GET", "/transcripts?")[0]?.url).toContain("page_size=2");
    expect(out.json["next_page_token"]).toBe("2");
    const list = out.json["transcripts"] as Record<string, unknown>[];
    expect(list.map((t) => t["id"])).toEqual(["t-1", "t-2"]);
    expect(list[0]).toEqual({
      id: "t-1",
      name: NAME("t-1"),
      agent: "support",
      start_time: "2026-11-11T09:00:00Z",
      last_time: "2026-11-11T09:05:00Z",
      expire_time: "2026-12-11T09:05:00Z",
      message_count: 2,
      preview: "Reach me at [email]",
    });
    expect(out.text).toContain("--page-token 2");
  });

  it("passes the page token on, and says when there are no more", async () => {
    const out = await run(["list", "--page-token", "3"]);
    expect(calls("GET", "/transcripts?")[0]?.url).toContain("page_token=3");
    expect(out.json["next_page_token"]).toBeNull();
    expect(out.text).toBe("No more transcripts.");
  });

  it.each([["0"], ["101"], ["ten"]])("refuses --limit %s before anything is sent", async (n) => {
    await fails(["list", "--limit", n], "invalid_limit");
    expect(fake.sitesCalls).toHaveLength(0);
  });

  it("shows one conversation with its messages, by id or by name", async () => {
    const out = await run(["show", NAME("t-1")]);
    const t = out.json["transcript"] as Transcript;
    expect(t.messages.map((m) => [m.id, m.role, m.tool_call])).toEqual([
      ["m1", "visitor", ""],
      ["m2", "agent", "lookup"],
    ]);
    expect(out.text).toContain("Visitor");
    expect(out.text).toContain("called lookup");
    expect(out.text).toContain("thanks\n    Bye");
  });

  it("strips terminal control characters from message text", async () => {
    conversations[0] = conversation("t-1", 1, [{ id: "m1", role: "visitor", text: "hi\u001b]0;pwned\u0007 there" }]);
    const out = await run(["show", "t-1"]);
    expect(out.text).not.toContain("\u001b");
    expect(out.text).not.toContain("\u0007");
  });

  it("reports a missing transcript, and refuses an id the service would", async () => {
    await fails(["show", "t-9"], "transcript_not_found");
    await fails(["show", "../x"], "invalid_transcript_id");
    await fails(["show"], "missing_transcript");
  });
});

describe("export", () => {
  it("reads every page into one JSON document", async () => {
    const out = await run(["export"]);
    expect(calls("GET", "transcripts:export")).toHaveLength(2);
    expect(calls("GET", "transcripts:export")[1]?.url).toContain("page_token=2");
    expect(out.json["site"]).toBe(SITE);
    expect(out.json["exported_at"]).toBe("2026-11-15T10:00:00Z");
    expect((out.json["transcripts"] as Transcript[]).map((t) => t.id)).toEqual(["t-1", "t-2", "t-3"]);
    expect((out.json["transcripts"] as Transcript[])[0]?.messages).toHaveLength(2);
    expect(out.notes.at(-1)).toContain("3 conversations");
  });

  it("stops on a page token that repeats", async () => {
    fake.sites = () => ({ status: 200, body: { transcripts: [], next_page_token: "same" } });
    await run(["export"]);
    // The first page, then "same" once; the same token again ends it.
    expect(fake.sitesCalls).toHaveLength(2);
  });

  it("writes a JSON file readable by its owner only, and won't replace one without --force", async () => {
    const file = join(dir, "t.json");
    const out = await run(["export", "--out", file]);
    expect(out.json).toMatchObject({ file, format: "json", transcript_count: 3, message_count: 3 });
    const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect((doc["transcripts"] as unknown[]).length).toBe(3);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    await fails(["export", "--out", file], "file_exists");
    await run(["export", "--out", file, "--force"]);
  });

  it("writes a CSV with the dashboard's columns, one row per message", async () => {
    const file = join(dir, "t.csv");
    await run(["export", "--out", file, "--format", "csv"]);
    const csv = readFileSync(file, "utf8");
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe(
      "transcript_id,agent,conversation_start,conversation_last,message_count,message_id,message_time,role,text,refusal,tool_call,turn",
    );
    // The line break inside a quoted field stays a bare LF; records end with CRLF.
    expect(lines[2]).toBe(
      't-1,support,2026-11-11T09:00:00Z,2026-11-11T09:05:00Z,2,m2,2026-11-11T09:00:05Z,agent,"Sure, ""noted"", thanks\nBye",,lookup,u1',
    );
    expect(csv).toContain(`,"'=HYPERLINK(""x"")",input/lockdown,,`);
    // A conversation with no messages still gets a row.
    expect(csv).toContain("t-3,support,2026-11-13T09:00:00Z,2026-11-13T09:05:00Z,0,,,,,,,\r\n");
  });

  it("writes a CSV to stdout without --out, and needs --out under --json", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await run(["export", "--format", "csv"], undefined, false);
    expect(String(write.mock.calls[0]?.[0])).toContain("transcript_id,agent");
    write.mockRestore();
    await fails(["export", "--format", "csv"], "missing_out");
    await fails(["export", "--format", "xml"], "invalid_format");
  });
});

describe("csvField", () => {
  it.each([
    ["plain", "plain"],
    ["a,b", '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ["two\nlines", '"two\nlines"'],
    ["cr\rhere", '"cr\rhere"'],
    ["=1+1", "'=1+1"],
    ["+1", "'+1"],
    ["-1", "'-1"],
    ["@SUM(A1)", "'@SUM(A1)"],
    ["\tx", "'\tx"],
    ["=a,b", `"'=a,b"`],
    [null, ""],
    [undefined, ""],
    [3, "3"],
  ])("%j → %j", (input, want) => {
    expect(csvField(input)).toBe(want);
  });

  it("matches transcriptsCsv's message count", () => {
    expect(transcriptsCsv([]).messageCount).toBe(0);
  });
});

describe("delete", () => {
  it("asks on a terminal, showing which conversation, and deletes on a yes", async () => {
    const yes = asker(true);
    const out = await run(["delete", "t-1"], yes);
    expect(yes.asked[0]).toContain("t-1");
    expect(calls("DELETE", "/transcripts/t-1")).toHaveLength(1);
    expect(out.json).toMatchObject({ ok: true, deleted: "t-1" });
  });

  it("deletes nothing on a no", async () => {
    await fails(["delete", "t-1"], "cancelled", asker(false));
    expect(calls("DELETE", "/transcripts/")).toHaveLength(0);
  });

  it("stops with confirmation_required (exit 2) when nobody can answer", async () => {
    const err = await fails(["delete", "--all"], "confirmation_required", asker(true, false));
    expect(err.exitCode).toBe(2);
    expect(calls("POST", "transcripts:deleteAll")).toHaveLength(0);
  });

  it("deletes without asking with --yes", async () => {
    const ask = asker(false, false);
    const out = await run(["delete", "--all", "--yes"], ask);
    expect(ask.asked).toHaveLength(0);
    expect(out.json).toMatchObject({ ok: true, deleted_count: 3 });
    expect(calls("POST", "transcripts:deleteAll")[0]?.body).toEqual({});
  });

  it("reports a missing transcript before asking, and with --yes", async () => {
    const ask = asker(true);
    await fails(["delete", "t-9"], "transcript_not_found", ask);
    expect(ask.asked).toHaveLength(0);
    await fails(["delete", "t-9", "--yes"], "transcript_not_found");
  });

  it("refuses an id with --all, and sends nothing under --dry-run", async () => {
    await fails(["delete", "t-1", "--all"], "conflicting_flags");
    setTrace({ verbose: false, dryRun: true });
    await fails(["delete", "--all"], "dry_run", asker(false, false));
    expect(calls("POST", "transcripts:deleteAll")).toHaveLength(0);
  });
});

describe("settings", () => {
  it("shows the settings without an option", async () => {
    const out = await run(["settings"]);
    expect(out.json["transcripts"]).toEqual({ store: true, retention_days: 30, webhook_url: null, webhook_secret_id: null });
    expect(calls("PATCH", "agentConfig")).toHaveLength(0);
  });

  it("sets retention and don't store through the agent config, at the version read", async () => {
    const out = await run(["settings", "--retention-days", "7", "--dont-store"]);
    const patch = calls("PATCH", "agentConfig")[0];
    expect(patch?.url).toContain("expectedVersion=4");
    expect((patch?.body as Record<string, unknown>)["transcripts"]).toMatchObject({ retentionDays: 7, doNotStore: true });
    // Every other setting is sent back as it was.
    expect((patch?.body as Record<string, unknown>)["page"]).toEqual({ enabled: true, model: "" });
    expect(out.json).toMatchObject({ changed: true, transcripts: { store: false, retention_days: 7 } });
  });

  it("sends nothing when it is already so", async () => {
    const out = await run(["settings", "--retention-days", "30", "--store"]);
    expect(out.json["changed"]).toBe(false);
    expect(calls("PATCH", "agentConfig")).toHaveLength(0);
  });

  it.each([["0"], ["3651"], ["1.5"]])("refuses --retention-days %s", async (n) => {
    await fails(["settings", "--retention-days", n], "invalid_retention");
    expect(fake.sitesCalls).toHaveLength(0);
  });

  it("refuses --store with --dont-store", async () => {
    await fails(["settings", "--store", "--dont-store"], "conflicting_flags");
  });

  it("shows up in `nxis agents status`", async () => {
    const { positional, flags } = parseArgs(["status"]);
    const { ctx, out } = capture({ siteOverride: SITE });
    await runHostedAgents(ctx, positional, flags);
    expect(out.json["transcripts"]).toMatchObject({ store: true, retention_days: 30 });
    expect(out.text).toContain("Transcripts");
  });
});

describe("webhook", () => {
  it("makes a whsk_ secret, sends it once, and prints it once", async () => {
    const out = await run(["webhook", "set", "https://hooks.example.com/t"]);
    const post = calls("POST", "setTranscriptWebhook")[0];
    const sent = (post?.body as Record<string, string>)["secret"] as string;
    expect(sent).toMatch(/^whsk_[A-Za-z0-9_-]{43}$/);
    expect(edgeSecrets.get("wh_1")).toBe(sent);
    expect(out.json).toMatchObject({
      ok: true,
      webhook_url: "https://hooks.example.com/t",
      webhook_secret_id: "wh_1",
      secret: sent,
      rotated: false,
      changed: true,
    });
    expect(out.text).toContain(sent);
    expect(out.text.split(sent)).toHaveLength(2);
  });

  it("never writes the secret to the CLI's settings, and redacts it from --verbose", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    setTrace({ verbose: true, dryRun: false });
    const out = await run(["webhook", "set", "https://hooks.example.com/t"]);
    const secret = out.json["secret"] as string;
    const traced = err.mock.calls.map((c) => String(c[0])).join("");
    err.mockRestore();
    expect(traced).toContain("setTranscriptWebhook");
    expect(traced).toContain("<redacted>");
    expect(traced).not.toContain(secret);
    const home = process.env.XDG_CONFIG_HOME as string;
    const files = readdirSync(home, { recursive: true }) as string[];
    for (const f of files) {
      const p = join(home, f);
      if (statSync(p).isFile()) expect(readFileSync(p, "utf8")).not.toContain(secret);
    }
  });

  it("redacts the secret from a --dry-run result", async () => {
    setTrace({ verbose: false, dryRun: true });
    const err = await fails(["webhook", "set", "https://hooks.example.com/t"], "dry_run");
    expect((err.details["body"] as Record<string, unknown>)["secret"]).toBe("<redacted>");
    expect(JSON.stringify(err.details)).not.toMatch(/whsk_/);
  });

  it("rotates the secret on a webhook that has one, and says so", async () => {
    await run(["webhook", "set", "https://hooks.example.com/t"]);
    const out = await run(["webhook", "set", "https://hooks.example.com/t"]);
    expect(out.json).toMatchObject({ rotated: true, webhook_secret_id: "wh_2" });
    expect(out.text).toContain("previous signing secret no longer works");
  });

  it("changes the URL only with --keep-secret", async () => {
    await run(["webhook", "set", "https://hooks.example.com/t"]);
    const out = await run(["webhook", "set", "https://hooks.example.com/new", "--keep-secret"]);
    const last = calls("POST", "setTranscriptWebhook").at(-1);
    expect(last?.body).toEqual({ webhookUrl: "https://hooks.example.com/new" });
    expect(out.json).toMatchObject({ webhook_url: "https://hooks.example.com/new", webhook_secret_id: "wh_1", changed: true });
    expect(out.json).not.toHaveProperty("secret");
    expect(out.text).not.toMatch(/whsk_/);
  });

  it("refuses --keep-secret with no webhook, and sends nothing for the same URL", async () => {
    await fails(["webhook", "set", "https://hooks.example.com/t", "--keep-secret"], "no_webhook_secret");
    await run(["webhook", "set", "https://hooks.example.com/t"]);
    const out = await run(["webhook", "set", "https://hooks.example.com/t", "--keep-secret"]);
    expect(out.json["changed"]).toBe(false);
    expect(calls("POST", "setTranscriptWebhook")).toHaveLength(1);
  });

  it.each([["ftp://x.example.com"], ["not a url"], [`https://x.example.com/${"a".repeat(500)}`]])(
    "refuses %s before anything is sent",
    async (url) => {
      await fails(["webhook", "set", url], "invalid_webhook_url");
      expect(fake.sitesCalls).toHaveLength(0);
    },
  );

  it("removes the webhook with an empty URL, and does nothing without one", async () => {
    let out = await run(["webhook", "remove"]);
    expect(out.json["changed"]).toBe(false);
    await run(["webhook", "set", "https://hooks.example.com/t"]);
    out = await run(["webhook", "remove"]);
    expect(calls("POST", "setTranscriptWebhook").at(-1)?.body).toEqual({ webhookUrl: "" });
    expect(out.json).toMatchObject({ changed: true, webhook_url: null, webhook_secret_id: null });
  });

  it.each(["snake", "camel"] as const)("shows the delivery status from a %s_case answer", async (s) => {
    style = s;
    await run(["webhook", "set", "https://hooks.example.com/t"]);
    const out = await run(["webhook", "status"]);
    expect(out.json).toMatchObject({
      webhook_url: "https://hooks.example.com/t",
      secret_set: true,
      delivered_count: 41,
      failed_count: 1,
      dead_letters: [{ event_id: "ev-1", transcript: "t-1", attempts: 5, last_status: 502, error: "Bad gateway" }],
    });
    expect(out.text).toContain("HTTP 502");
  });
});

describe("generateSecret", () => {
  it("is whsk_ and 32 random bytes as unpadded base64url", () => {
    const a = generateSecret();
    expect(a).toHaveLength(48);
    expect(Buffer.from(a.slice(5), "base64url")).toHaveLength(32);
    expect(generateSecret()).not.toBe(a);
  });
});

describe("routing", () => {
  it("is reached through `nxis agents transcripts`", async () => {
    const { positional, flags } = parseArgs(["transcripts", "list"]);
    const { ctx, out } = capture({ siteOverride: SITE });
    await runHostedAgents(ctx, positional, flags);
    expect(out.json["transcripts"]).toHaveLength(3);
  });

  it("names the subcommands for an unknown one", async () => {
    const err = await fails(["nope"], "unknown_command");
    expect(err.message).toContain("webhook set");
    await fails(["webhook", "nope"], "unknown_command");
  });
});
