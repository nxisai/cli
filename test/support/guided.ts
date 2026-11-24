/**
 * What the guided setup tests share: a scripted terminal, an MCP client that answers each
 * elicitation as a test says, a fake device flow, and the check that no prompt asks for or shows
 * a secret.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type CallToolResult, type ElicitRequest } from "@modelcontextprotocol/sdk/types.js";
import { expect } from "vitest";
import { endpointKey, type Config } from "../../src/config.js";
import type { Ctx } from "../../src/context.js";
import type { DeviceCodeGrant } from "../../src/auth.js";
import { createServeServer, ProvisioningConnection, type ServeServerOptions } from "../../src/commands/mcp-serve.js";
import { terminalGuide, type Guide } from "../../src/guide.js";
import type { DeviceFlow } from "../../src/guided/sign-in.js";
import { capture } from "./fake-endpoints.js";

/** The device code the CLI polls with. It must never reach a prompt. */
export const DEVICE_CODE = "device-code-never-shown-0123456789";
export const USER_CODE = "WXYZ-1234";

/** A terminal guide that answers from a script, and records what it wrote. */
export function scriptedTerminal(answers: string[]): { guide: Guide; written: () => string; opened: string[] } {
  let out = "";
  const opened: string[] = [];
  const guide = terminalGuide({
    interactive: true,
    output: { write: (chunk: string) => ((out += chunk), true) } as never,
    ask: async () => answers.shift() ?? "",
    open: (url) => (opened.push(url), true),
  });
  return { guide, written: () => out, opened };
}

/** A JWT the CLI reads as signed in, as account `acct-1`. Unsigned: the CLI only decodes it. */
export function fakeJwt(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({
    sub: "user-1",
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://nxis.ai/user_data": { account: { _id: { value: "acct-1" } }, email: "owner@example.com" },
  })}.sig`;
}

/** A device flow that signs in as soon as it is polled, unless told to wait for the signal. */
export function fakeDeviceFlow(opts: { hang?: boolean } = {}): DeviceFlow & { polls: number; aborted: boolean } {
  const flow = {
    polls: 0,
    aborted: false,
    async request(): Promise<DeviceCodeGrant> {
      return {
        device_code: DEVICE_CODE,
        user_code: USER_CODE,
        verification_uri: "https://login.example.test/activate",
        verification_uri_complete: `https://login.example.test/activate?user_code=${USER_CODE}`,
        expires_in: 600,
      };
    },
    async poll(config: Config, _grant: DeviceCodeGrant, signal: AbortSignal) {
      flow.polls++;
      if (opts.hang) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        flow.aborted = true;
        throw new Error("aborted");
      }
      return { accessToken: fakeJwt(), profile: config.profile, endpoints: endpointKey(config.endpoints) };
    },
  };
  return flow;
}

type Reply = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };

/** A client connected to a new `nxis mcp serve`, and every question it was asked. */
export interface GuidedSession {
  asked: ElicitRequest["params"][];
  call: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
  close: () => Promise<void>;
}

/**
 * Connects a client to a new server.
 *
 * @param answer - How the person answers each question, in order; null for a client that cannot elicit.
 * @param opts - `url`: the client takes URL elicitation too.
 */
export async function guidedServe(
  answer: ((params: ElicitRequest["params"], n: number) => Reply) | null,
  opts: ServeServerOptions & { url?: boolean; ctx?: Partial<Ctx> } = {},
): Promise<GuidedSession> {
  const { ctx } = capture({ io: { json: false, note: () => undefined, emit: () => undefined }, ...opts.ctx });
  const connection = new ProvisioningConnection(ctx);
  const server = createServeServer(ctx, connection, opts);
  const capabilities = answer ? { elicitation: opts.url ? { form: {}, url: {} } : { form: {} } } : {};
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities });
  const asked: ElicitRequest["params"][] = [];
  if (answer) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked.push(req.params);
      return answer(req.params, asked.length - 1);
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

/** @returns The JSON object in a tool result's first text part. */
export function body(result: CallToolResult): Record<string, unknown> {
  const text = result.content.find((part) => part.type === "text") as { text: string };
  return JSON.parse(text.text) as Record<string, unknown>;
}

/** Fails when any question asks for, or shows, a password, card details, a secret or the device code. */
export function expectNoSecrets(questions: unknown[]): void {
  for (const q of questions) {
    const text = typeof q === "string" ? q : JSON.stringify(q);
    expect(text).not.toMatch(/password|passcode|card number|cvc|cvv|secret|api key|token/i);
    expect(text).not.toContain(DEVICE_CODE);
    expect(text).not.toMatch(/"format":"password"/);
  }
}
