/**
 * Guided setup: the questions only the user can answer, asked wherever the user is.
 *
 * @remarks
 * Setup has a few decisions that belong to the user and nobody else: signing in, which plan to
 * pay for, whether to buy credits, whether to accept the data processing agreement, and which
 * pages a billed batch covers. Rather than stopping with a reason the user resolves somewhere
 * else, a command puts the decision to them through a {@link Guide}:
 *
 * - On a terminal, {@link terminalGuide} asks on stderr and reads stdin.
 * - Under `nxis mcp serve`, the server's guide asks through the agent, over MCP elicitation: a
 *   form for a choice, and a link (URL elicitation where the client supports it) for the sign-in
 *   and payment pages.
 * - Anywhere else (`--json`, a pipe, CI, a client that cannot elicit), the guide is not
 *   interactive, and the command keeps its non-interactive behavior: it stops with the reason
 *   and the details it always gave.
 *
 * A guide never preselects an answer, never asks for a password, a card number or a secret, and
 * never shows one. Sign-in and payment happen on their own pages; the guide only sends the user
 * there and waits.
 */

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { ElicitRequestFormParams, ElicitRequestURLParams } from "@modelcontextprotocol/sdk/types.js";
import { openUrl } from "./browser.js";
import { CliError, needsUser } from "./errors.js";
import { isYes } from "./prompt.js";

/** How a person said no: by declining, or by dismissing the question. */
export type Refusal = "decline" | "cancel";

/** A person's answer: a value, or a refusal. */
export type Answer<T> = { ok: true; value: T } | { ok: false; why: Refusal };

/** One of the answers a person can choose. */
export interface Option<T> {
  value: T;
  /** What the person reads. One line. */
  label: string;
}

/** A question with a list of answers. Nothing is selected until the person selects it. */
export interface ChoiceQuestion<T> {
  /** What is being decided, and what each answer does. */
  message: string;
  /** The field's name, e.g. "Plan". */
  title: string;
  options: Option<T>[];
}

/** A page the person goes to (sign-in, payment), and what says they are done there. */
export interface Visit<T> {
  /** What the page is for, in a sentence or two. Never a secret. */
  message: string;
  url: string;
  /**
   * Waits for the outcome the page leads to (a token, a subscription, a top-up), or null when
   * the wait ran out. Stops when the signal aborts: the person declined.
   */
  until: (signal: AbortSignal) => Promise<T | null>;
}

/** How a command asks the user. */
export interface Guide {
  /** Where the person is: at this terminal, or behind an agent. Decides the wording of a stop. */
  readonly kind: "terminal" | "agent";
  /** Someone can answer. When false, nothing may be asked: stop with the reason instead. */
  readonly interactive: boolean;
  /** One of the options. */
  choose<T>(q: ChoiceQuestion<T>): Promise<Answer<T>>;
  /** A short line of text that is not a secret, such as a legal entity's name. */
  text(q: { message: string; title: string; maxLength: number }): Promise<Answer<string>>;
  /** An explicit yes. */
  confirm(q: { message: string; question: string }): Promise<Answer<true>>;
  /** Sends the person to a page and waits. `ok` with null when the wait ran out. */
  visit<T>(q: Visit<T>): Promise<Answer<T | null>>;
}

/** @returns A guide that can ask nobody. Its questions throw; check `interactive` first. */
export function noGuide(kind: Guide["kind"]): Guide {
  const nobody = async (): Promise<never> => {
    throw new Error("Nobody can be asked here.");
  };
  return { kind, interactive: false, choose: nobody, text: nobody, confirm: nobody, visit: nobody };
}

/** @returns The guide a command asks with: the one in the context, else the terminal's. */
export function guideOf(ctx: { guide?: Guide; io: { json: boolean } }): Guide {
  return ctx.guide ?? terminalGuide({ json: ctx.io.json });
}

/**
 * The stop for a question the person said no to.
 *
 * @returns `cancelled` (exit 2) on a terminal; `declined_by_user` or `cancelled_by_user` (exit 2)
 * through an agent, which then knows not to ask again unprompted.
 */
export function refused(guide: Guide, why: Refusal, message: string, details: Record<string, unknown> = {}): CliError {
  if (guide.kind === "terminal") return needsUser(message, "cancelled", details);
  return needsUser(
    `${message} Don't repeat the call unless the user asks you to.`,
    why === "cancel" ? "cancelled_by_user" : "declined_by_user",
    details,
  );
}

/**
 * The stop for an agent that cannot ask the person (its client has no elicitation).
 *
 * @returns `confirmation_unavailable` (exit 2), with what the call would do and the terminal
 * command that does it.
 */
export function cannotAsk(wouldDo: string, terminalCommand: string, details: Record<string, unknown> = {}): CliError {
  return needsUser(
    "This needs the user's decision, and this MCP client cannot ask for it (it does not support elicitation). " +
      `Nothing was done. Show the user what it would do, and ask them to run \`${terminalCommand}\` in a terminal ` +
      "themselves.",
    "confirmation_unavailable",
    { ...details, would_do: wouldDo, terminal_command: terminalCommand },
  );
}

// ── The terminal ─────────────────────────────────────────────────────────────

/** Options for {@link terminalGuide}. Streams and the browser are replaced in tests. */
export interface TerminalGuideOptions {
  /** `--json`: stdout is the result's, and nobody is asked. */
  json?: boolean;
  input?: Readable;
  output?: Writable;
  /** Whether a person is there. Defaults to stdin and stderr both being terminals. */
  interactive?: boolean;
  /** `--no-open`: print the link instead of opening a browser. */
  noOpen?: boolean;
  /** Opens a link. The default browser, outside tests. */
  open?: (url: string) => boolean;
  /** Reads the answer to one question. A line from `input`, outside tests. */
  ask?: (question: string) => Promise<string>;
}

/** @returns A guide that asks on stderr and reads stdin, so stdout stays clean. */
export function terminalGuide(opts: TerminalGuideOptions = {}): Guide {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stderr;
  const open = opts.open ?? openUrl;
  const interactive =
    opts.json !== true &&
    (opts.interactive ?? ((process.stdin as { isTTY?: boolean }).isTTY === true && process.stderr.isTTY === true));
  const write = (text: string) => void output.write(text);

  /** Reads one line. Stdin closing before an answer (Ctrl-D) is an empty answer, not a hang. */
  const readLine = async (question: string): Promise<string> => {
    const rl = createInterface({ input, output, terminal: false });
    try {
      return await new Promise<string>((resolve) => {
        rl.once("close", () => resolve(""));
        rl.question(question).then(resolve, () => resolve(""));
      });
    } finally {
      rl.close();
    }
  };
  const ask = async (question: string): Promise<string> => {
    if (!opts.ask) return readLine(question);
    write(question);
    return opts.ask(question);
  };

  return {
    kind: "terminal",
    interactive,
    async choose(q) {
      write(`${q.message}\n\n`);
      q.options.forEach((o, i) => write(`  ${i + 1}) ${o.label}\n`));
      const answer = (await ask(`\n${q.title}: choose 1-${q.options.length}, or press Enter to cancel: `)).trim();
      const n = /^\d+$/.test(answer) ? Number(answer) : NaN;
      const picked = q.options[n - 1];
      return picked && n >= 1 ? { ok: true, value: picked.value } : { ok: false, why: "cancel" };
    },
    async text(q) {
      write(`${q.message}\n`);
      const answer = (await ask(`${q.title}: `)).trim();
      if (!answer) return { ok: false, why: "cancel" };
      return { ok: true, value: answer.slice(0, q.maxLength) };
    },
    async confirm(q) {
      write(`${q.message}\n\n`);
      return isYes(await ask(`${q.question} [y/N] `)) ? { ok: true, value: true } : { ok: false, why: "decline" };
    },
    async visit(q) {
      write(`\n${q.message}\n  ${q.url}\n\n`);
      if (!opts.noOpen) open(q.url);
      write("Waiting for you to finish on that page (Ctrl-C stops waiting)...\n");
      return { ok: true, value: await q.until(new AbortController().signal) };
    },
  };
}

// ── The agent, over MCP elicitation ──────────────────────────────────────────

/** What an MCP guide needs from the server. */
export interface Elicitor {
  /** Sends one elicitation, for the tool call being answered. */
  elicit(
    params: ElicitRequestFormParams | ElicitRequestURLParams,
    signal?: AbortSignal,
  ): Promise<{ action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }>;
  /** The client takes URL elicitation, which opens a page without the link passing through the agent. */
  url: boolean;
  /** Tells the client a URL elicitation finished. Never throws. */
  complete?(elicitationId: string): Promise<void>;
}

/** @returns A failed elicitation as the stop it is: nothing was done. */
function askFailed(err: unknown): CliError {
  return needsUser(
    `The user could not be asked (${(err as Error)?.message ?? String(err)}). Nothing was done.`,
    "confirmation_failed",
  );
}

/** @returns A guide that asks through the agent's client. */
export function mcpGuide(e: Elicitor): Guide {
  const form = async (params: ElicitRequestFormParams, signal?: AbortSignal) => {
    try {
      return await e.elicit(params, signal);
    } catch (err) {
      throw askFailed(err);
    }
  };
  const refusal = (action: string): Answer<never> => ({ ok: false, why: action === "cancel" ? "cancel" : "decline" });

  return {
    kind: "agent",
    interactive: true,
    async choose(q) {
      const answer = await form({
        mode: "form",
        message: q.message,
        requestedSchema: {
          type: "object",
          properties: {
            choice: {
              type: "string",
              title: q.title,
              oneOf: q.options.map((o, i) => ({ const: String(i), title: o.label })),
            },
          },
          required: ["choice"],
        },
      });
      if (answer.action !== "accept") return refusal(answer.action);
      const picked = q.options[Number(answer.content?.["choice"])];
      return picked && typeof answer.content?.["choice"] === "string" ? { ok: true, value: picked.value } : refusal("decline");
    },
    async text(q) {
      const answer = await form({
        mode: "form",
        message: q.message,
        requestedSchema: {
          type: "object",
          properties: { value: { type: "string", title: q.title, minLength: 1, maxLength: q.maxLength } },
          required: ["value"],
        },
      });
      if (answer.action !== "accept") return refusal(answer.action);
      const value = typeof answer.content?.["value"] === "string" ? answer.content["value"].trim() : "";
      return value ? { ok: true, value: value.slice(0, q.maxLength) } : refusal("decline");
    },
    async confirm(q) {
      const answer = await form({
        mode: "form",
        message: `${q.message}\n\n${q.question}`,
        requestedSchema: {
          type: "object",
          properties: {
            confirm: {
              type: "boolean",
              title: "Yes, go ahead",
              description: "Tick to confirm. Declining, or leaving this unticked, changes nothing.",
            },
          },
          required: ["confirm"],
        },
      });
      if (answer.action === "accept" && answer.content?.["confirm"] === true) return { ok: true, value: true };
      return refusal(answer.action === "accept" ? "decline" : answer.action);
    },
    async visit(q) {
      const stopWaiting = new AbortController();
      const waiting = q.until(stopWaiting.signal).then(
        (value) => ({ kind: "done" as const, value }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );
      const settle = async () => {
        const r = await waiting;
        if (r.kind === "error") throw r.error;
        return { ok: true as const, value: r.value };
      };

      if (e.url) {
        const elicitationId = randomUUID();
        let answer;
        try {
          answer = await e.elicit({ mode: "url", message: q.message, url: q.url, elicitationId });
        } catch (err) {
          stopWaiting.abort();
          throw askFailed(err);
        }
        if (answer.action !== "accept") {
          stopWaiting.abort();
          return refusal(answer.action);
        }
        try {
          return await settle();
        } finally {
          await e.complete?.(elicitationId).catch(() => undefined);
        }
      }

      // A form: the link is in the message, and the question stays open while the wait runs.
      // Whichever comes first decides: the page done (the question is withdrawn), or a no.
      const stopAsking = new AbortController();
      const asking = e
        .elicit(
          {
            mode: "form",
            message: `${q.message}\n\n${q.url}`,
            requestedSchema: {
              type: "object",
              properties: {
                done: {
                  type: "boolean",
                  title: "I've opened the page",
                  description: "Accept to keep waiting while you finish there. Declining stops waiting.",
                },
              },
            },
          },
          stopAsking.signal,
        )
        .then(
          (answer) => ({ kind: "answer" as const, answer }),
          (error: unknown) => ({ kind: "ask_error" as const, error }),
        );
      const first = await Promise.race([waiting, asking]);
      if (first.kind === "done" || first.kind === "error") {
        stopAsking.abort();
        void asking;
        return settle();
      }
      if (first.kind === "answer" && first.answer.action !== "accept") {
        stopWaiting.abort();
        return refusal(first.answer.action);
      }
      // Accepted, or the question failed while the page may still be open: keep waiting.
      return settle();
    },
  };
}
