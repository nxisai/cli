/**
 * `nxis connections test` and `nxis mcp serve`'s `nxis_test_connection`, against an in-process sites
 * service that answers TestConnection as it does through the HTTP transcoder.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/args.js";
import { COMMAND_FLAGS } from "../src/command-flags.js";
import { cmdConnectionsTest, routeInputOf, routesWords, runConnections, testActionType } from "../src/commands/connections.js";
import { createServeServer, ProvisioningConnection } from "../src/commands/mcp-serve.js";
import { CliError, ExitCode } from "../src/errors.js";
import { TOOLS } from "../src/tools/index.js";
import { capture, cleanFake, fake, ORG, resetFake, startFake, stopFake, type AuthSeen } from "./support/fake-endpoints.js";

const SITE = "site-1";
const BASE = `/v1/organizations/${ORG}/sites/${SITE}/connections`;
const ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
const URL_ = "https://api.example.com/nxis";

/** The next TestConnection answer, and how the fake names its fields. */
let answer: { status: number; body?: unknown };
let style: "snake" | "camel";

function verdict(v: string, extra: Record<string, unknown> = {}): { status: number; body: unknown } {
  const snake: Record<string, unknown> = {
    verdict: v,
    http_status: 200,
    latency_ms: "42",
    body_excerpt: "",
    url: URL_,
    tested_at: "2026-11-23T12:00:00Z",
    action_type: "QuoteAction",
    detail: "",
    ...extra,
  };
  if (style === "snake") return { status: 200, body: snake };
  return {
    status: 200,
    body: Object.fromEntries(Object.entries(snake).map(([k, val]) => [k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), val])),
  };
}

function service(req: AuthSeen): { status: number; body?: unknown } {
  const path = req.url.split("?")[0] ?? "";
  if (path === BASE && req.method === "GET") {
    return {
      status: 200,
      body: {
        connections: [
          {
            id: ID,
            resource_name: `organizations/${ORG}/sites/${SITE}/connections/${ID}`,
            name: "Website",
            url: URL_,
            secret_preview: "abcd1234",
            used_by: { agents: ["quote"], action_types: ["QuoteAction"] },
          },
        ],
      },
    };
  }
  if (path === `${BASE}/${ID}:test` && req.method === "POST") return answer;
  if (path === `${BASE}:setRoute` && req.method === "POST") return { status: 200, body: { connections: [] } };
  return { status: 404 };
}

const testCalls = () => fake.sitesCalls.filter((c) => c.method === "POST" && c.url.split("?")[0]!.endsWith(":test"));

async function run(argv: string[]) {
  const { positional, flags } = parseArgs(argv);
  const { ctx, out } = capture({});
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

beforeAll(startFake);
afterAll(stopFake);
beforeEach(() => {
  resetFake();
  process.env.NXIS_TOKEN = "header.payload.sig";
  style = "snake";
  answer = verdict("ok", { body_excerpt: '{"available":true}' });
  fake.sites = service;
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanFake();
});

describe("connections test", () => {
  it.each(["snake", "camel"] as const)("ok: exit 0, with the verdict, status, latency and address (%s answers)", async (s) => {
    style = s;
    answer = verdict("ok", { body_excerpt: '{"available":true}' });
    const out = await run(["test", "website", "--action", "quote"]);
    expect(testCalls()[0]?.body).toEqual({ connection: `organizations/${ORG}/sites/${SITE}/connections/${ID}`, action_type: "QuoteAction" });
    expect(out.json).toMatchObject({
      ok: true,
      site: SITE,
      connection: { id: ID, name: "Website" },
      verdict: "ok",
      http_status: 200,
      latency_ms: 42,
      url: URL_,
      action_type: "QuoteAction",
      body_excerpt: '{"available":true}',
    });
    expect(out.text).toContain("ok  HTTP 200  42 ms  https://api.example.com/nxis");
    expect(out.text).toContain("accepted the signed check");
  });

  it("without --action, lets the service choose; by id too", async () => {
    await run(["test", ID]);
    expect(testCalls()[0]?.body).toEqual({ connection: `organizations/${ORG}/sites/${SITE}/connections/${ID}` });
  });

  it("signature_rejected: exit 2, naming the two usual causes", async () => {
    answer = verdict("signature_rejected", { http_status: 401, body_excerpt: '{"message":"Signature does not match."}' });
    const err = await caught(() => run(["test", "Website"]));
    expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
    expect(err.reason).toBe("connection_test_failed");
    expect(err.details).toMatchObject({ verdict: "signature_rejected", http_status: 401, url: URL_ });
    expect(err.message).toContain("different secret");
    expect(err.message).toContain("raw request bytes");
    expect(err.message).toContain("Signature does not match.");
    expect(err.toJSON()).toMatchObject({ ok: false, reason: "connection_test_failed", verdict: "signature_rejected" });
  });

  it("unreachable: not deployed there, or the tunnel is down", async () => {
    answer = verdict("unreachable", { http_status: 0, detail: "Nothing accepted the connection at that address." });
    const err = await caught(() => run(["test", "Website"]));
    expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
    expect(err.message).toContain("no answer");
    expect(err.message).toContain("Nothing accepted the connection at that address.");
    expect(err.message).toContain("not deployed at that address, or the tunnel");
  });

  const NGROK_PAGE =
    '<!DOCTYPE html>\n<html class="h-full" lang="en-US" dir="ltr">\n  <head>\n    <meta charset="utf-8">\n' +
    '    <link rel="preload" href="https://assets.ngrok.com/fonts/euclid-square/EuclidSquare-Regular-WebS.woff" as="font"';

  it.each(["snake", "camel"] as const)(
    "unreachable, answered by an ngrok tunnel: up but not reaching the server, with where to look (%s answers)",
    async (s) => {
      style = s;
      answer = verdict("unreachable", {
        http_status: 502,
        body_excerpt: NGROK_PAGE,
        detail: "The ngrok tunnel answered 502 (ERR_NGROK_8012), but it isn't reaching your server: the call didn't get to it.",
        answered_by: "tunnel",
      });
      const err = await caught(() => run(["test", "Website"]));
      expect(err.exitCode).toBe(ExitCode.NEEDS_USER);
      expect(err.details).toMatchObject({ verdict: "unreachable", http_status: 502, answered_by: "tunnel" });
      expect(err.message).toContain("unreachable  HTTP 502 from the tunnel");
      expect(err.message).toContain("The ngrok tunnel answered 502 (ERR_NGROK_8012)");
      expect(err.message).toContain("The tunnel at api.example.com is up, but it isn't reaching your server");
      expect(err.message).toContain("listening on the port the tunnel points at");
      expect(err.message).toContain("http://127.0.0.1:4040/api/tunnels");
      expect(err.message).toContain("then test again");
      expect(err.message).not.toContain("it got the call");
      expect(err.message).not.toContain("Nothing answered");
    },
  );

  it("unreachable, answered by a CDN or proxy: the host is up, check what it forwards to", async () => {
    answer = verdict("unreachable", {
      http_status: 522,
      detail: "Cloudflare answered 522, but it isn't reaching your server: the call didn't get to it.",
      answered_by: "cdn",
    });
    const cdn = await caught(() => run(["test", "Website"]));
    expect(cdn.details).toMatchObject({ answered_by: "cdn" });
    expect(cdn.message).toContain("HTTP 522 from the CDN");
    expect(cdn.message).toContain("The host at api.example.com is up, but it isn't reaching your server");
    expect(cdn.message).toContain("the address and port the CDN forwards to");
    expect(cdn.message).not.toContain("4040");

    answer = verdict("unreachable", {
      http_status: 504,
      detail: "A proxy (nginx) answered 504, but it isn't reaching your server: the call didn't get to it.",
      answered_by: "proxy",
    });
    const proxy = await caught(() => run(["test", "Website"]));
    expect(proxy.message).toContain("A proxy (nginx) answered 504");
    expect(proxy.message).toContain("the address and port the proxy forwards to");
  });

  it("a receiver's own answer says so, and a service that doesn't send answered_by is read as before", async () => {
    answer = verdict("bad_response", { http_status: 502, body_excerpt: '{"status":"error"}', answered_by: "receiver" });
    const own = await caught(() => run(["test", "Website"]));
    expect(own.details).toMatchObject({ answered_by: "receiver" });
    expect(own.message).toContain("The receiver answered 502: it got the call");
    expect(own.message).not.toContain("from the receiver");

    answer = verdict("unreachable", { http_status: 0, detail: "Nothing accepted the connection at that address." });
    const none = await caught(() => run(["test", "Website"]));
    expect(none.details).not.toHaveProperty("answered_by");
    expect(none.message).toContain("Nothing answered at api.example.com");
  });

  it("timeout and bad_response, with the excerpt shown", async () => {
    answer = verdict("timeout", { http_status: 0, latency_ms: "10000", detail: "No answer within 10 seconds." });
    const slow = await caught(() => run(["test", "Website"]));
    expect(slow.details).toMatchObject({ verdict: "timeout", latency_ms: 10000 });
    expect(slow.message).toContain("took too long");

    answer = verdict("bad_response", { http_status: 422, body_excerpt: '{"status":"rejected","message":"Add ?action=quote"}' });
    const bad = await caught(() => run(["test", "Website"]));
    expect(bad.exitCode).toBe(ExitCode.NEEDS_USER);
    expect(bad.message).toContain("answered 422");
    expect(bad.message).toContain('Answer: {"status":"rejected","message":"Add ?action=quote"}');

    answer = verdict("bad_response", { http_status: 302 });
    expect((await caught(() => run(["test", "Website"]))).message).toContain("a redirect, which is not followed");
  });

  it("the rate limit is rate_limited, exit 1, with when to retry", async () => {
    answer = {
      status: 429,
      body: {
        code: 8,
        message: "This connection was tested moments ago. Try again in 4 seconds.",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "CONNECTION_TEST_RATE_LIMITED",
            domain: "nxis.ai",
            metadata: { retry_after_seconds: "4" },
          },
        ],
      },
    };
    const err = await caught(() => run(["test", "Website"]));
    expect(err.exitCode).toBe(ExitCode.ERROR);
    expect(err.reason).toBe("rate_limited");
    expect(err.details).toMatchObject({ retry_after_seconds: 4 });
  });

  it("an unknown connection or --action is refused before anything is sent", async () => {
    const missing = await caught(() => run(["test", "Nope"]));
    expect(missing.reason).toBe("connection_not_found");
    const badAction = await caught(() => run(["test", "Website", "--action", "launch"]));
    expect(badAction.reason).toBe("invalid_input");
    expect(testCalls()).toEqual([]);
  });

  it("maps --action names onto action types", () => {
    expect(testActionType(undefined)).toBeUndefined();
    expect(testActionType("quote")).toBe("QuoteAction");
    expect(testActionType("booking")).toBe("ScheduleAction");
    expect(testActionType("reserve")).toBe("ReserveAction");
    expect(testActionType("default")).toBe("default");
    expect(testActionType("ScheduleAction")).toBe("ScheduleAction");
    expect(() => testActionType("quote_action")).toThrow(CliError);
  });

  it("reports a receiver that answers checks, and how to turn check support on where it is off", async () => {
    answer = verdict("ok", {
      body_excerpt: '{"available":true,"windows":[]}',
      answers_checks: true,
      returned_windows: true,
      check_support_off: ["QuoteAction", "ScheduleAction"],
    });
    const out = await run(["test", "Website", "--action", "booking"]);
    expect(out.json).toMatchObject({
      ok: true,
      answers_checks: true,
      returned_windows: true,
      returned_hold: false,
      check_support_off: ["QuoteAction", "ScheduleAction"],
      check_support_turned_on: [],
    });
    const next = String(out.json["next"]);
    expect(next).toContain("It answers availability checks, with open times.");
    expect(next).toContain("Check support is still off for quote requests and bookings");
    expect(next).toContain('`nxis connections test "Website" --turn-on-checks`');
    // Nothing changed without the flag or a yes.
    expect(fake.sitesCalls.filter((c) => c.url.includes(":setRoute"))).toEqual([]);
  });

  it("--turn-on-checks asks the service to turn it on, and says what it turned on", async () => {
    answer = verdict("ok", { body_excerpt: '{"available":true}', answers_checks: true, check_support_turned_on: ["default"] });
    const out = await run(["test", "Website", "--turn-on-checks"]);
    expect(testCalls()[0]?.body).toEqual({ connection: `organizations/${ORG}/sites/${SITE}/connections/${ID}`, turn_on_checks: true });
    expect(out.json).toMatchObject({ answers_checks: true, check_support_turned_on: ["default"], check_support_off: [] });
    expect(String(out.json["next"])).toContain("Check support is now on for the site's default route");
  });

  it("a 2xx that isn't a check answer says the agents won't check first, and how to fix it", async () => {
    answer = verdict("ok", { body_excerpt: '{"status":"confirmed","confirmation_id":"r1"}' });
    const out = await run(["test", "Website"]);
    expect(out.json).toMatchObject({ ok: true, answers_checks: false });
    const next = String(out.json["next"]);
    expect(next).toContain("didn't answer as an availability check");
    expect(next).toContain("Booking takes visit requests for you to confirm");
    expect(next).toContain("--turn-on-checks");
  });

  it("reads a check answer from the excerpt when the service doesn't say", async () => {
    answer = verdict("ok", { body_excerpt: '{"available":false,"reason":"Closed"}' });
    const out = await run(["test", "Website"]);
    expect(out.json).toMatchObject({ answers_checks: true, check_support_off: [] });
    expect(String(out.json["next"])).toContain("check with it before they send");
    // A failing verdict says nothing about checks.
    answer = verdict("bad_response", { http_status: 500, body_excerpt: '{"available":true}' });
    const err = await caught(() => run(["test", "Website"]));
    expect(err.details).toMatchObject({ answers_checks: null });
  });

  it("on a terminal, asks before turning check support on, then sets each route", async () => {
    answer = verdict("ok", { body_excerpt: '{"available":true}', answers_checks: true, check_support_off: ["QuoteAction", "default"] });
    const questions: string[] = [];
    const { ctx, out } = capture({});
    const human = { ...ctx, io: { ...ctx.io, json: false } };
    await cmdConnectionsTest(human, "Website", undefined, {
      asker: { interactive: true, confirm: async (q) => (questions.push(q), true) },
    });
    expect(questions).toEqual([
      "Your receiver answers availability checks, but check support is off for quote requests and the site's default route. Turn it on?",
    ]);
    const routed = fake.sitesCalls.filter((c) => c.url.includes(":setRoute")).map((c) => c.body);
    expect(routed).toEqual([
      { parent: `organizations/${ORG}/sites/${SITE}`, connection_id: ID, action_type: "QUOTE_ACTION", supports_check: true },
      { parent: `organizations/${ORG}/sites/${SITE}`, connection_id: ID, supports_check: true },
    ]);
    expect(testCalls()).toHaveLength(1);
    expect(out.json).toMatchObject({ check_support_off: [], check_support_turned_on: ["QuoteAction", "default"] });
    expect(String(out.json["next"])).toContain("Check support is now on for quote requests and the site's default route");
  });

  it("on a terminal, a no changes nothing and still says how", async () => {
    answer = verdict("ok", { body_excerpt: '{"available":true}', answers_checks: true, check_support_off: ["ScheduleAction"] });
    const { ctx, out } = capture({});
    await cmdConnectionsTest({ ...ctx, io: { ...ctx.io, json: false } }, "Website", undefined, {
      asker: { interactive: true, confirm: async () => false },
    });
    expect(fake.sitesCalls.filter((c) => c.url.includes(":setRoute"))).toEqual([]);
    expect(String(out.json["next"])).toContain("--turn-on-checks");
  });

  it("after enabling an agent, says when its route could check first", async () => {
    const { checkSupportOf } = await import("../src/commands/agents-by-id.js");
    const { ctx } = capture({});
    const ref = { config: ctx.config, token: "header.payload.sig", orgId: ORG, siteId: SITE };
    const listing = (answers: unknown, supports: boolean) => () => ({
      status: 200,
      body: {
        connections: [{ id: ID, name: "Website", url: URL_, secret_preview: "abcd1234", answers_checks: answers }],
        routes: [{ action_type: "ScheduleAction", connection_id: ID, supports_check: supports, agents: ["booking"] }],
      },
    });
    fake.sites = listing({ value: true }, false);
    const off = await checkSupportOf(ref, "booking");
    expect(off).toMatchObject({ on: false, answers_checks: true, connection: "Website" });
    expect(off?.note).toContain('`nxis connections test "Website" --turn-on-checks`');
    fake.sites = listing(undefined, false);
    expect((await checkSupportOf(ref, "booking"))?.note).toContain("hasn't been tested");
    fake.sites = listing(true, true);
    expect(await checkSupportOf(ref, "booking")).toEqual({ on: true, answers_checks: true, connection: "Website" });
    expect(await checkSupportOf(ref, "quote")).toBeNull();
    expect(await checkSupportOf(ref, "support")).toBeNull();
  });

  it("names routes in words, and as SetConnectionRoute takes them", () => {
    expect(routesWords(["default"])).toBe("the site's default route");
    expect(routesWords(["QuoteAction", "ScheduleAction", "ReserveAction"])).toBe("quote requests, bookings and reservations");
    expect(routeInputOf("default")).toEqual({});
    expect(routeInputOf("ScheduleAction")).toEqual({ actionType: "SCHEDULE_ACTION" });
  });

  it("takes --action and --turn-on-checks, and nothing else", () => {
    expect(COMMAND_FLAGS["connections test"]).toEqual({ flags: ["action", "turn-on-checks"] });
  });
});

describe("mcp serve: nxis_test_connection", () => {
  async function connect() {
    const { ctx } = capture({ io: { json: false, note: () => undefined, emit: () => undefined } });
    const connection = new ProvisioningConnection(ctx);
    const server = createServeServer(ctx, connection, {});
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: { elicitation: {} } });
    const asked: unknown[] = [];
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked.push(req.params);
      return { action: "accept", content: { confirm: true } };
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    return {
      asked,
      call: async (args: Record<string, unknown>) =>
        (await client.callTool({ name: "nxis_test_connection", arguments: args })) as CallToolResult,
      close: async () => {
        await client.close();
        await server.close();
        await connection.drop();
      },
    };
  }

  it("is listed, read-only unless it turns checks on, and takes site, connection, action and turn_on_checks", () => {
    const tool = TOOLS.find((t) => t.name === "nxis_test_connection");
    expect(tool?.surface).toBe("local");
    const readOnly = tool?.readOnly as (a: Record<string, unknown>) => boolean;
    expect(readOnly({ connection: "Website" })).toBe(true);
    expect(readOnly({ connection: "Website", turn_on_checks: true })).toBe(false);
    expect(Object.keys(tool!.input.shape).sort()).toEqual(["action", "connection", "site", "turn_on_checks"]);
  });

  it("runs without asking, and returns the verdict with the next step, failing or not", async () => {
    const s = await connect();
    let ok: CallToolResult;
    let rejected: CallToolResult;
    try {
      ok = await s.call({ connection: "Website", action: "booking" });
      answer = verdict("signature_rejected", { http_status: 403 });
      rejected = await s.call({ connection: "Website" });
    } finally {
      await s.close();
    }
    expect(s.asked).toEqual([]);
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent).toMatchObject({ ok: true, verdict: "ok", http_status: 200 });
    expect(testCalls()[0]?.body).toMatchObject({ action_type: "ScheduleAction" });
    expect(rejected.isError).toBeFalsy();
    expect(rejected.structuredContent).toMatchObject({ ok: false, verdict: "signature_rejected", http_status: 403 });
    expect(String((rejected.structuredContent as Record<string, unknown>)["next"])).toContain("different secret");
  });

  it("carries answered_by and the tunnel's next step", async () => {
    answer = verdict("unreachable", {
      http_status: 502,
      detail: "The ngrok tunnel answered 502 (ERR_NGROK_8012), but it isn't reaching your server: the call didn't get to it.",
      answered_by: "tunnel",
    });
    const s = await connect();
    let r: CallToolResult;
    try {
      r = await s.call({ connection: "Website" });
    } finally {
      await s.close();
    }
    expect(r.structuredContent).toMatchObject({ ok: false, verdict: "unreachable", http_status: 502, answered_by: "tunnel" });
    const next = String((r.structuredContent as Record<string, unknown>)["next"]);
    expect(next).toContain("isn't reaching your server");
    expect(next).toContain("http://127.0.0.1:4040/api/tunnels");
  });
});
