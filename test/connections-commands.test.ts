/**
 * `nxis connections …` and `nxis actions bind --connection | --webhook`, against an in-process
 * sites service that behaves as the connection RPCs do through the HTTP transcoder; and the same
 * through `nxis mcp serve`'s connection tools.
 *
 * The signing secret must appear in the one-time create or rotate field and nowhere else: not in
 * a list, an error, the `--verbose` trace, a note or the server's log. Every secret the fake issues
 * is recorded, and the tests look for each of them where it must not be.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type CallToolResult, type ElicitRequest } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/args.js";
import { cmdActionsBind } from "../src/commands/actions.js";
import { nameForAddress, runConnections, supportsCheckFlag } from "../src/commands/connections.js";
import type { GuardOptions } from "../src/commands/mcp-guard.js";
import { createServeServer, ProvisioningConnection } from "../src/commands/mcp-serve.js";
import { CliError, ExitCode } from "../src/errors.js";
import type { Asker } from "../src/prompt.js";
import { TOOLS } from "../src/tools/index.js";
import { setTrace } from "../src/trace.js";
import { capture, cleanFake, fake, ORG, resetFake, startFake, stopFake, type AuthSeen } from "./support/fake-endpoints.js";

const SITE = "site-1";
const BASE = `/v1/organizations/${ORG}/sites/${SITE}/connections`;
const QUOTE_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
const SPARE_ID = "bbbbbbbbbbbbbbbbbbbbbbbb";

interface Stored {
  id: string;
  name: string;
  url: string;
  secret: string;
  agents: string[];
  actionTypes: string[];
}

/** The fake's connections. */
let conns: Stored[];
let defaultId: string;
/** Every raw secret the fake has handed out (or holds). */
let secrets: string[];
let issued: number;
/** How the fake names fields: as the transcoder does (snake), or in lowerCamelCase. */
let style: "snake" | "camel";
/** Answers the next request matching the method instead, when set. */
let override: { method: string; path?: string; answer: { status: number; body?: unknown } } | null;

function newSecret(): string {
  issued++;
  const s = `whsec_fake_${issued}_${"x".repeat(24)}`; // gitleaks:allow
  secrets.push(s);
  return s;
}

/** A connection as the service answers it. A stray `signing_secret` is included, which must never be shown. */
function wire(c: Stored): Record<string, unknown> {
  const isDefault = c.id === defaultId;
  const snake = {
    id: c.id,
    resource_name: `organizations/${ORG}/sites/${SITE}/connections/${c.id}`,
    name: c.name,
    url: c.url,
    method: "POST",
    encoding: "JSON",
    headers: { "X-Site-Env": "prod" },
    secret_preview: c.secret.slice(0, 8),
    created_at: "2026-11-20T00:00:00Z",
    secret_rotated_at: "2026-11-20T00:00:00Z",
    is_default: isDefault,
    used_by: { agents: c.agents, action_types: [...(isDefault ? ["default"] : []), ...c.actionTypes] },
    // A service bug must not leak through: the CLI reads only the fields it names.
    signing_secret: c.secret,
  };
  if (style === "snake") return snake;
  return {
    id: snake.id,
    resourceName: snake.resource_name,
    name: snake.name,
    url: snake.url,
    method: 1,
    encoding: 1,
    headers: snake.headers,
    secretPreview: snake.secret_preview,
    createdAt: snake.created_at,
    secretRotatedAt: snake.secret_rotated_at,
    isDefault,
    usedBy: { agents: snake.used_by.agents, actionTypes: snake.used_by.action_types },
    signingSecret: c.secret,
  };
}

function listBody(): Record<string, unknown> {
  return { connections: conns.map(wire), default_connection_id: defaultId };
}

/** The sites service's connection routes. */
function service(req: AuthSeen): { status: number; body?: unknown } {
  const path = req.url.split("?")[0] ?? "";
  if (override && override.method === req.method && (!override.path || path.endsWith(override.path))) {
    const answer = override.answer;
    override = null;
    return answer;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (path === BASE && req.method === "GET") return { status: 200, body: listBody() };
  if (path === BASE && req.method === "POST") {
    const name = String(body["name"]);
    if (conns.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      return { status: 409, body: { code: 6, message: `A connection named ${name} already exists on this site.` } };
    }
    const c: Stored = { id: (issued + 1).toString(16).padStart(24, "c"), name, url: String(body["url"]), secret: newSecret(), agents: [], actionTypes: [] };
    conns.push(c);
    if (body["make_default"] === true) defaultId = c.id;
    return { status: 200, body: { connection: wire(c), signing_secret: c.secret } };
  }
  if (path === `${BASE}:setRoute` && req.method === "POST") {
    const id = String(body["connection_id"]);
    const c = conns.find((x) => x.id === id);
    if (!c) return { status: 404, body: { code: 5, message: "Connection not found." } };
    if (body["agent"]) c.agents = [...new Set([...c.agents, String(body["agent"])])];
    else if (body["action_type"]) c.actionTypes.push(String(body["action_type"]));
    else defaultId = id;
    return { status: 200, body: listBody() };
  }
  const m = /\/connections\/([0-9a-f]{24})(:rotateSecret)?$/.exec(path);
  const c = m ? conns.find((x) => x.id === m[1]) : undefined;
  if (m && !c) return { status: 404, body: { code: 5, message: "Connection not found." } };
  if (c && m?.[2] && req.method === "POST") {
    c.secret = newSecret();
    return { status: 200, body: { connection: wire(c), signing_secret: c.secret } };
  }
  if (c && req.method === "DELETE") {
    if (c.agents.length > 0 || c.id === defaultId) {
      return {
        status: 400,
        body: { code: 9, message: "This connection is still used by the Quote agent. Choose another connection for them first." },
      };
    }
    conns = conns.filter((x) => x !== c);
    return { status: 200, body: { id: c.id } };
  }
  return { status: 404 };
}

const calls = (method?: string, suffix?: string) =>
  fake.sitesCalls.filter((c) => (!method || c.method === method) && (!suffix || c.url.split("?")[0]!.endsWith(suffix)));

/** Captures stderr, where the trace and the server's log go. */
let stderrLines: string[];
function captureStderr(): void {
  stderrLines = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderrLines.push(String(chunk));
    return true;
  });
}

/** Runs `nxis connections <argv>`. */
async function connections(argv: string[], ctxOverrides: Parameters<typeof capture>[0] = {}) {
  const { positional, flags } = parseArgs(argv);
  const { ctx, out } = capture(ctxOverrides);
  await runConnections(ctx, positional, flags);
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

/** Expects no issued secret anywhere in the text. */
function expectNoSecret(text: string): void {
  for (const s of secrets) expect(text).not.toContain(s);
}

beforeAll(startFake);
afterAll(stopFake);
beforeEach(() => {
  resetFake();
  process.env.NXIS_TOKEN = "header.payload.sig";
  secrets = [];
  issued = 0;
  style = "snake";
  override = null;
  conns = [
    { id: QUOTE_ID, name: "Quotes API", url: "https://api.example.com/quotes", secret: newSecret(), agents: ["quote"], actionTypes: ["QuoteAction"] },
    { id: SPARE_ID, name: "Spare", url: "https://spare.example.com/in", secret: newSecret(), agents: [], actionTypes: [] },
  ];
  defaultId = "";
  fake.sites = service;
  captureStderr();
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanFake();
});

describe("connections list", () => {
  it.each(["snake", "camel"] as const)("shows each connection without its secret (%s answers)", async (s) => {
    style = s;
    const out = await connections(["list"]);
    expect(out.json).toMatchObject({ ok: true, site: SITE, default_connection_id: null });
    const list = out.json["connections"] as Record<string, unknown>[];
    expect(list.map((c) => c["name"])).toEqual(["Quotes API", "Spare"]);
    expect(list[0]).toEqual({
      id: QUOTE_ID,
      name: "Quotes API",
      url: "https://api.example.com/quotes",
      method: "POST",
      encoding: "JSON",
      headers: { "X-Site-Env": "prod" },
      secret_preview: conns[0]!.secret.slice(0, 8),
      created_at: "2026-11-20T00:00:00Z",
      secret_rotated_at: "2026-11-20T00:00:00Z",
      is_default: false,
      used_by: { agents: ["quote"], action_types: ["QuoteAction"] },
      answers_checks: null,
    });
    expectNoSecret(JSON.stringify(out.json));
    expectNoSecret(out.text);
    expect(out.text).toContain("Quotes API (quote)");
  });

  it("is what `nxis connections` alone runs", async () => {
    const out = await connections([]);
    expect((out.json["connections"] as unknown[]).length).toBe(2);
  });

  it("a service without connections is connections_unavailable, not a missing connection", async () => {
    override = { method: "GET", answer: { status: 404, body: { code: 5, message: "Not Found" } } };
    const err = await caught(() => connections(["list"]));
    expect(err.reason).toBe("connections_unavailable");
    expect(err.exitCode).toBe(ExitCode.ERROR);
  });

  it("a refusal to an account that isn't an owner is exit 3", async () => {
    override = { method: "GET", answer: { status: 403, body: { code: 7, message: "Not an owner of this organization." } } };
    const err = await caught(() => connections(["list"]));
    expect(err.reason).toBe("forbidden");
    expect(err.exitCode).toBe(ExitCode.NOT_AUTHORIZED);
  });
});

describe("connections create", () => {
  it("shows the new secret once, labelled, and never traces it", async () => {
    setTrace({ verbose: true });
    const out = await connections(["create", "--name", "Bookings", "--url", "https://book.example.com/hook", "--default"]);
    const secret = secrets[secrets.length - 1]!;
    expect(calls("POST", "/connections")[0]?.body).toEqual({
      parent: `organizations/${ORG}/sites/${SITE}`,
      name: "Bookings",
      url: "https://book.example.com/hook",
      make_default: true,
    });
    expect(out.json).toMatchObject({ ok: true, signing_secret: secret, connection: { name: "Bookings", is_default: true } });
    expect(out.json["connection"]).not.toHaveProperty("signing_secret");
    expect(out.text).toContain("Signing secret (shown once");
    expect(out.text.split(secret)).toHaveLength(2);
    expect(stderrLines.join("")).toContain("/connections");
    expectNoSecret(stderrLines.join(""));
    expectNoSecret(out.notes.join(""));
  });

  it("a name already used on the site is connection_name_taken, exit 1", async () => {
    const err = await caught(() => connections(["create", "--name", "spare", "--url", "https://x.example.com"]));
    expect(err.reason).toBe("connection_name_taken");
    expect(err.exitCode).toBe(ExitCode.ERROR);
    expect(err.details).toMatchObject({ field: "name" });
  });

  it("refuses a bad name or URL before signing in or sending", async () => {
    for (const argv of [
      ["create", "--url", "https://x.example.com"],
      ["create", "--name", "x".repeat(61), "--url", "https://x.example.com"],
      ["create", "--name", "A"],
      ["create", "--name", "A", "--url", "ftp://x.example.com"],
      ["create", "--name", "A", "--url", "https://user:pw@x.example.com/hook"],
    ]) {
      const err = await caught(() => connections(argv));
      expect(err.reason, argv.join(" ")).toBe("invalid_input");
    }
    expect(fake.sitesCalls).toEqual([]);
  });

  it("an unverified site is site_not_verified, exit 2", async () => {
    override = {
      method: "POST",
      answer: { status: 400, body: { code: 9, message: "The site must be verified before connections are created." } },
    };
    const err = await caught(() => connections(["create", "--name", "A", "--url", "https://a.example.com"]));
    expect(err.reason).toBe("site_not_verified");
    expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
    expect(err.message).toContain("nxis sites verify --check");
  });

  it("the service's refusal of an address is invalid_input, with its sentence", async () => {
    override = { method: "POST", answer: { status: 400, body: { code: 3, message: "The address must use https." } } };
    const err = await caught(() => connections(["create", "--name", "A", "--url", "http://a.example.com"]));
    expect(err.reason).toBe("invalid_input");
    expect(err.message).toBe("The address must use https.");
  });

  it("is withheld under --dry-run", async () => {
    setTrace({ dryRun: true });
    const err = await caught(() => connections(["create", "--name", "A", "--url", "https://a.example.com"]));
    expect(err.reason).toBe("dry_run");
    expect(err.exitCode).toBe(ExitCode.OK);
    expect(calls("POST")).toEqual([]);
  });
});

describe("connections rotate", () => {
  const yes: Asker = { interactive: true, confirm: async () => true };

  it("needs a yes without a terminal, and rotates nothing", async () => {
    const err = await caught(() => connections(["rotate", "Quotes API"]));
    expect(err.reason).toBe("confirmation_required");
    expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
    expect(err.message).toContain("Quote agent");
    expect(calls("POST")).toEqual([]);
  });

  it("with --yes, shows the new secret once and who it affects", async () => {
    const before = conns[0]!.secret;
    const out = await connections(["rotate", "quotes api", "--yes"]);
    const secret = conns[0]!.secret;
    expect(secret).not.toBe(before);
    expect(calls("POST", ":rotateSecret")[0]?.body).toEqual({ connection: `organizations/${ORG}/sites/${SITE}/connections/${QUOTE_ID}` });
    expect(out.json).toMatchObject({ ok: true, signing_secret: secret, affected: "the Quote agent" });
    expect(JSON.stringify(out.json)).not.toContain(before);
    expect(out.text.split(secret)).toHaveLength(2);
  });

  it("asks at a terminal, by id, and a no changes nothing", async () => {
    const { cmdConnectionsRotate } = await import("../src/commands/connections.js");
    const { ctx } = capture();
    const no: Asker = { interactive: true, confirm: async () => false };
    expect((await caught(() => cmdConnectionsRotate(ctx, QUOTE_ID, { asker: no }))).reason).toBe("cancelled");
    expect(calls("POST")).toEqual([]);
    await cmdConnectionsRotate(ctx, QUOTE_ID, { asker: yes });
    expect(calls("POST", ":rotateSecret")).toHaveLength(1);
  });

  it("an unknown connection is connection_not_found, exit 2, with the names there are", async () => {
    const err = await caught(() => connections(["rotate", "Nope", "--yes"]));
    expect(err.reason).toBe("connection_not_found");
    expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
    expect(err.details).toMatchObject({ connections: ["Quotes API", "Spare"] });
  });
});

describe("connections delete", () => {
  it("deletes one nothing uses", async () => {
    const out = await connections(["delete", "Spare", "--yes"]);
    expect(out.json).toEqual({ ok: true, site: SITE, deleted: { id: SPARE_ID, name: "Spare" } });
    expect(calls("DELETE")).toHaveLength(1);
  });

  it("one still in use is connection_in_use, exit 2, naming the agents, with no secret in the error", async () => {
    const err = await caught(() => connections(["delete", "Quotes API", "--yes"]));
    expect(err.reason).toBe("connection_in_use");
    expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
    expect(err.message).toContain("still used by the Quote agent");
    expect(err.details).toMatchObject({ connection: "Quotes API", used_by: { agents: ["quote"] } });
    expectNoSecret(JSON.stringify(err.toJSON()));
  });
});

describe("actions bind --connection", () => {
  it("routes an action to a connection by name, ignoring case", async () => {
    const { ctx, out } = capture();
    await cmdActionsBind(ctx, { action: "Reserve", connection: "spare" });
    expect(calls("POST", ":setRoute")[0]?.body).toEqual({
      parent: `organizations/${ORG}/sites/${SITE}`,
      connection_id: SPARE_ID,
      action_type: "RESERVE_ACTION",
    });
    expect(out.json).toMatchObject({
      ok: true,
      action: "reserve",
      route: "connection",
      connection_created: false,
      webhook_host: "spare.example.com",
      binding: { connection_id: SPARE_ID, connection_name: "Spare", url: "https://spare.example.com/in" },
    });
    expect(out.json).not.toHaveProperty("signing_secret");
    expectNoSecret(JSON.stringify(out.json));
    expect(out.text).toContain('now sends to connection "Spare"');
  });

  it("turns check support on for the Quote route too", async () => {
    const { ctx } = capture();
    await cmdActionsBind(ctx, { action: "quote", connection: "Spare", supportsCheck: true });
    expect(calls("POST", ":setRoute")[0]?.body).toEqual({
      parent: `organizations/${ORG}/sites/${SITE}`,
      connection_id: SPARE_ID,
      action_type: "QUOTE_ACTION",
      supports_check: true,
    });
  });

  it("binds the Booking agent with its options, and the site default", async () => {
    const { ctx } = capture();
    await cmdActionsBind(ctx, { action: "booking", connection: QUOTE_ID, supportsCheck: true, availabilityUrl: "https://api.example.com/free" });
    await cmdActionsBind(ctx, { action: "default", connection: "Spare" });
    const [booking, dflt] = calls("POST", ":setRoute").map((c) => c.body);
    expect(booking).toEqual({
      parent: `organizations/${ORG}/sites/${SITE}`,
      connection_id: QUOTE_ID,
      agent: "booking",
      supports_check: true,
      availability_url: "https://api.example.com/free",
    });
    expect(dflt).toEqual({ parent: `organizations/${ORG}/sites/${SITE}`, connection_id: SPARE_ID });
  });

  it("refuses the free-times address elsewhere, and booking without a connection, before sending", async () => {
    const { ctx } = capture();
    for (const args of [
      { action: "quote", connection: "Spare", availabilityUrl: "/free" },
      { action: "default", connection: "Spare", availabilityUrl: "" },
      { action: "schedule", selfPage: true, supportsCheck: false },
      { action: "booking", selfPage: true },
      { action: "booking", connection: "Spare", availabilityUrl: "not a url" },
      { action: "booking", connection: "Spare", webhook: "https://x.example.com" },
    ]) {
      expect((await caught(() => cmdActionsBind(ctx, args))).reason, JSON.stringify(args)).toBe("invalid_input");
    }
    expect(fake.sitesCalls).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it("an unknown connection is connection_not_found, and nothing is routed", async () => {
    const { ctx } = capture();
    const err = await caught(() => cmdActionsBind(ctx, { action: "quote", connection: "Nope" }));
    expect(err.reason).toBe("connection_not_found");
    expect(calls("POST")).toEqual([]);
  });

  it("reads --supports-check as on, =false as off, and absent as unchanged", () => {
    expect(supportsCheckFlag(parseArgs(["--supports-check"]).flags)).toBe(true);
    expect(supportsCheckFlag(parseArgs(["--supports-check=false"]).flags)).toBe(false);
    expect(supportsCheckFlag(parseArgs([]).flags)).toBeUndefined();
    expect(() => supportsCheckFlag(parseArgs(["--supports-check=maybe"]).flags)).toThrow(CliError);
  });
});

describe("actions bind --webhook", () => {
  it("creates a connection named from the host, routes to it, and shows its secret once", async () => {
    setTrace({ verbose: true });
    const { ctx, out } = capture();
    await cmdActionsBind(ctx, { action: "quote", webhook: "https://hooks.example.com/in" });
    const secret = secrets[secrets.length - 1]!;
    expect(calls("POST", "/connections")[0]?.body).toMatchObject({ name: "hooks.example.com", url: "https://hooks.example.com/in" });
    expect(calls("POST", ":setRoute")[0]?.body).toMatchObject({ action_type: "QUOTE_ACTION" });
    expect(out.json).toMatchObject({
      route: "webhook",
      connection_created: true,
      signing_secret: secret,
      secret_is_new: true,
      binding: { url: "https://hooks.example.com/in", connection_name: "hooks.example.com" },
    });
    expect(out.text.split(secret)).toHaveLength(2);
    expectNoSecret(stderrLines.join(""));
  });

  it("reuses the connection with the same address, keeping its secret", async () => {
    const { ctx, out } = capture();
    await cmdActionsBind(ctx, { action: "default", webhook: "https://spare.example.com/in" });
    expect(calls("POST", "/connections")).toEqual([]);
    expect(calls("POST", ":setRoute")[0]?.body).toMatchObject({ connection_id: SPARE_ID });
    expect(out.json).toMatchObject({ connection_created: false, connection: { name: "Spare" } });
    expect(out.json).not.toHaveProperty("signing_secret");
    expectNoSecret(JSON.stringify(out.json));
    expect(out.text).toContain("Its signing secret is unchanged.");
  });

  it("names it apart from a connection that already has the host's name", () => {
    const list = {
      connections: [{ name: "hooks.example.com" }, { name: "Hooks.example.com 2" }] as never,
      defaultConnectionId: "",
    };
    expect(nameForAddress("https://hooks.example.com/other", list)).toBe("hooks.example.com 3");
    expect(nameForAddress("https://new.example.com", list)).toBe("new.example.com");
  });

  it("when routing fails after creating, says what was created, without the secret", async () => {
    override = { method: "POST", path: ":setRoute", answer: { status: 400, body: { code: 3, message: "The route is not valid." } } };
    const { ctx } = capture();
    const err = await caught(() => cmdActionsBind(ctx, { action: "quote", webhook: "https://new.example.com/in" }));
    expect(err.reason).toBe("invalid_input");
    expect(err.message).toContain('Created the connection "new.example.com"');
    expect(err.message).toContain("nxis connections rotate");
    expect(err.details).toMatchObject({ connection_created: true });
    expectNoSecret(JSON.stringify(err.toJSON()));
  });
});

// ── Reasons: the service's google.rpc.ErrorInfo decides, the message's words only without one ──

/** An error body as the HTTP transcoder sends one with an ErrorInfo detail. */
function refusal(
  status: number,
  code: number,
  message: string,
  reason: string,
  metadata: Record<string, string> = {},
  domain = "nxis.ai",
): { status: number; body: unknown } {
  return {
    status,
    body: {
      code,
      message,
      details: [
        { "@type": "type.googleapis.com/google.protobuf.StringValue", value: "Another problem." },
        { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain, metadata },
      ],
    },
  };
}

describe("reasons from the service", () => {
  it("CONNECTION_IN_USE is connection_in_use, exit 2, whatever the message says, with the agents it names", async () => {
    override = {
      method: "DELETE",
      answer: refusal(400, 9, "Pick another connection for those agents first.", "CONNECTION_IN_USE", { agents: "quote,booking" }),
    };
    const err = await caught(() => connections(["delete", "Spare", "--yes"]));
    expect(err.reason).toBe("connection_in_use");
    expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
    expect(err.message).toBe("Pick another connection for those agents first.");
    expect(err.details).toMatchObject({ connection: "Spare", used_by: { agents: ["quote", "booking"] } });
    expect(err.details).not.toHaveProperty("agents");
    expectNoSecret(JSON.stringify(err.toJSON()));
  });

  it("SITE_NOT_VERIFIED is site_not_verified, exit 2, though the message never says 'verified'", async () => {
    override = { method: "POST", answer: refusal(400, 9, "Prove you own the domain first.", "SITE_NOT_VERIFIED") };
    const err = await caught(() => connections(["create", "--name", "A", "--url", "https://a.example.com"]));
    expect(err.reason).toBe("site_not_verified");
    expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
    expect(err.message).toContain("nxis sites verify --check");
  });

  it("with a reason, the message's words are not read: another precondition stays precondition_failed", async () => {
    override = {
      method: "POST",
      answer: refusal(400, 9, "Set up the site's MCP server first; it is still used in setup and must be verified.", "MCP_SERVER_NOT_SET_UP"),
    };
    const err = await caught(() => connections(["create", "--name", "A", "--url", "https://a.example.com", "--default"]));
    expect(err.reason).toBe("precondition_failed");
    expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
  });

  it("CONNECTION_NAME_TAKEN is connection_name_taken, exit 1", async () => {
    override = { method: "POST", answer: refusal(409, 6, "That name is used.", "CONNECTION_NAME_TAKEN") };
    const err = await caught(() => connections(["create", "--name", "Fresh", "--url", "https://a.example.com"]));
    expect(err.reason).toBe("connection_name_taken");
    expect(err.exitCode).toBe(ExitCode.ERROR);
    expect(err.details).toMatchObject({ field: "name" });
  });

  it("CONNECTION_NOT_FOUND is connection_not_found, exit 2, even on an INVALID_ARGUMENT", async () => {
    override = { method: "POST", path: ":setRoute", answer: refusal(400, 3, "That connection doesn't exist on this site.", "CONNECTION_NOT_FOUND") };
    const { ctx } = capture();
    const err = await caught(() => cmdActionsBind(ctx, { action: "quote", connection: "Spare" }));
    expect(err.reason).toBe("connection_not_found");
    expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
  });

  it.each([
    ["INVALID_CONNECTION_URL", "url"],
    ["INVALID_CONNECTION_NAME", "name"],
    ["INVALID_AVAILABILITY_URL", "availability_url"],
    ["INVALID_ROUTE", "route"],
  ])("%s is invalid_input, exit 1, naming the field", async (reason, field) => {
    override = { method: "POST", path: ":setRoute", answer: refusal(400, 3, "Not like that.", reason) };
    const { ctx } = capture();
    const err = await caught(() => cmdActionsBind(ctx, { action: "booking", connection: "Spare" }));
    expect(err.reason).toBe("invalid_input");
    expect(err.exitCode).toBe(ExitCode.ERROR);
    expect(err.message).toBe("Not like that.");
    expect(err.details).toMatchObject({ field });
  });

  it("INVALID_ARGUMENT is invalid_input, exit 1", async () => {
    override = { method: "POST", answer: refusal(400, 3, "The X-Nxis-Signature header is set by NxisAI and can't be changed.", "INVALID_ARGUMENT") };
    const err = await caught(() => connections(["create", "--name", "A", "--url", "https://a.example.com"]));
    expect(err.reason).toBe("invalid_input");
    expect(err.exitCode).toBe(ExitCode.ERROR);
  });

  it("a 404 with a reason comes from a service that has connections: not connections_unavailable", async () => {
    override = { method: "GET", answer: refusal(404, 5, "No site found.", "NOT_FOUND") };
    const err = await caught(() => connections(["list"]));
    expect(err.reason).not.toBe("connections_unavailable");
  });

  it("an older server without reasons: the message's words still decide", async () => {
    override = { method: "DELETE", answer: { status: 400, body: { code: 9, message: "This connection is still used by the Booking agent." } } };
    const inUse = await caught(() => connections(["delete", "Spare", "--yes"]));
    expect(inUse.reason).toBe("connection_in_use");
    override = { method: "POST", answer: { status: 400, body: { code: 9, message: "Site must be verified before its actions can be bound." } } };
    const unverified = await caught(() => connections(["create", "--name", "A", "--url", "https://a.example.com"]));
    expect(unverified.reason).toBe("site_not_verified");
  });

  it("a reason in another domain is not NxisAI's: the words decide", async () => {
    override = { method: "DELETE", answer: refusal(400, 9, "This connection is still used by the Quote agent.", "SITE_NOT_VERIFIED", {}, "example.com") };
    const err = await caught(() => connections(["delete", "Spare", "--yes"]));
    expect(err.reason).toBe("connection_in_use");
  });
});

// ── nxis mcp serve ──────────────────────────────────────────────────────────

type Reply = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };

interface Session {
  asked: ElicitRequest["params"][];
  call: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
  close: () => Promise<void>;
}

async function connect(reply: Reply | null, opts: GuardOptions = {}): Promise<Session> {
  const { ctx } = capture({ io: { json: false, note: () => undefined, emit: () => undefined } });
  const connection = new ProvisioningConnection(ctx);
  const server = createServeServer(ctx, connection, opts);
  const client = new Client({ name: "test", version: "0.0.0" }, reply ? { capabilities: { elicitation: {} } } : {});
  const asked: ElicitRequest["params"][] = [];
  if (reply) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked.push(req.params);
      return reply;
    });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    asked,
    call: async (name, args = {}) => (await client.callTool({ name, arguments: args })) as CallToolResult,
    close: async () => {
      await client.close();
      await server.close();
      await connection.drop();
    },
  };
}

/** @returns Every text part of a result, joined. */
const textOf = (r: CallToolResult) => r.content.map((p) => (p as { text?: string }).text ?? "").join("\n");
const yesReply: Reply = { action: "accept", content: { confirm: true } };

describe("mcp serve: connection tools", () => {
  it("are listed with the CLI's annotations, and take `site`", () => {
    const connectionTools = TOOLS.filter((t) => t.surface === "local" && t.name.includes("connection"));
    const local = connectionTools.map((t) => t.name);
    expect(local).toEqual([
      "nxis_list_connections",
      "nxis_create_connection",
      "nxis_bind_connection",
      "nxis_test_connection",
      "nxis_rotate_connection_secret",
      "nxis_delete_connection",
    ]);
    for (const tool of connectionTools) {
      expect(tool.takesSite, tool.name).toBe(true);
      expect(Object.keys(tool.input.shape)).toContain("site");
    }
  });

  it("list doesn't ask, and carries no secret", async () => {
    const s = await connect(yesReply);
    let result: CallToolResult;
    try {
      result = await s.call("nxis_list_connections", {});
    } finally {
      await s.close();
    }
    expect(s.asked).toEqual([]);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ connections: [{ name: "Quotes API" }, { name: "Spare" }] });
    expectNoSecret(JSON.stringify(result));
  });

  it("create asks with the name and host, then returns the secret once, and the log never has it", async () => {
    const s = await connect(yesReply);
    let result: CallToolResult;
    try {
      result = await s.call("nxis_create_connection", { name: "Bookings", url: "https://book.example.com/hook", make_default: true });
    } finally {
      await s.close();
    }
    expect(s.asked[0]?.message).toContain('Create the connection "Bookings" on example.com, sending to book.example.com?');
    expect(s.asked[0]?.message).toContain("becomes the site's default");
    const secret = secrets[secrets.length - 1]!;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ signing_secret: secret, connection: { name: "Bookings" } });
    expectNoSecret(stderrLines.join(""));
    expectNoSecret(JSON.stringify(s.asked));
  });

  it("rotate without elicitation is refused, and rotates nothing", async () => {
    const s = await connect(null);
    let result: CallToolResult;
    try {
      result = await s.call("nxis_rotate_connection_secret", { connection: "Quotes API" });
    } finally {
      await s.close();
    }
    expect(result.isError).toBe(true);
    const body = JSON.parse(textOf(result)) as Record<string, unknown>;
    expect(body).toMatchObject({ reason: "confirmation_unavailable", terminal_command: "nxis connections rotate" });
    expect(String(body["would_do"])).toContain("stops working at once");
    expect(String(body["would_do"])).toContain("Quote agent");
    expect(calls("POST")).toEqual([]);
    expectNoSecret(textOf(result));
  });

  it("rotate on an accept returns the new secret once", async () => {
    const s = await connect(yesReply);
    let result: CallToolResult;
    try {
      result = await s.call("nxis_rotate_connection_secret", { connection: QUOTE_ID });
    } finally {
      await s.close();
    }
    expect(result.structuredContent).toMatchObject({ signing_secret: conns[0]!.secret });
  });

  it("delete declined deletes nothing", async () => {
    const s = await connect({ action: "decline" });
    let result: CallToolResult;
    try {
      result = await s.call("nxis_delete_connection", { connection: "Spare" });
    } finally {
      await s.close();
    }
    expect(s.asked[0]?.message).toContain('Delete the connection "Spare" (spare.example.com) from example.com?');
    expect(JSON.parse(textOf(result))).toMatchObject({ reason: "declined_by_user" });
    expect(calls("DELETE")).toEqual([]);
  });

  it("bind asks, naming the host, and states it in the result", async () => {
    const s = await connect(yesReply);
    let result: CallToolResult;
    try {
      result = await s.call("nxis_bind_connection", { action: "booking", connection: "Spare", supports_check: false });
    } finally {
      await s.close();
    }
    expect(s.asked[0]?.message).toContain(
      'Send the Booking agent\'s requests from example.com through the connection "Spare" to spare.example.com?',
    );
    expect(result.isError).toBeFalsy();
    expect(calls("POST", ":setRoute")[0]?.body).toMatchObject({ agent: "booking", supports_check: false });
    expect(textOf(result)).toContain("Connection target host: spare.example.com");
  });

  it("--read-only refuses the writes and still lists", async () => {
    const s = await connect(yesReply, { readOnly: true });
    try {
      for (const [name, args] of [
        ["nxis_create_connection", { name: "A", url: "https://a.example.com" }],
        ["nxis_rotate_connection_secret", { connection: "Spare" }],
        ["nxis_delete_connection", { connection: "Spare" }],
        ["nxis_bind_connection", { action: "default", connection: "Spare" }],
      ] as const) {
        expect(JSON.parse(textOf(await s.call(name, args)))).toMatchObject({ reason: "read_only_server" });
      }
      expect((await s.call("nxis_list_connections", {})).isError).toBeFalsy();
    } finally {
      await s.close();
    }
    expect(s.asked).toEqual([]);
    expect(calls("POST")).toEqual([]);
  });
});
