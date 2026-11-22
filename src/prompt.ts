/**
 * Asking a person to confirm, when there is a person to ask.
 *
 * @remarks
 * A billed or public write needs an explicit yes. On a terminal the CLI asks; anywhere else (an
 * agent, a pipe, CI) there is nobody to answer, so the command stops with exit 2 and the details
 * instead, and `--yes` is how the caller says the question was already put to the user.
 */

import { createInterface } from "node:readline/promises";
import { needsUser } from "./errors.js";

/** How a command asks. Replaced in tests. */
export interface Asker {
  /** There is a person at a terminal to answer. */
  interactive: boolean;
  /** @returns True for an explicit yes. */
  confirm(question: string): Promise<boolean>;
}

/** @returns True when the answer is an explicit yes. Anything else, including nothing, is no. */
export function isYes(answer: string): boolean {
  return /^\s*(y|yes)\s*$/i.test(answer);
}

/** Asks on the terminal: stdin for the answer, stderr for the question, so stdout stays clean. */
export const terminalAsker: Asker = {
  get interactive() {
    return process.stdin.isTTY === true && process.stderr.isTTY === true;
  },
  async confirm(question) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      // stdin closing before an answer (Ctrl-D) is a no, not a hang.
      const answer = await new Promise<string>((resolve) => {
        rl.once("close", () => resolve(""));
        rl.question(`${question} [y/N] `).then(resolve, () => resolve(""));
      });
      return isYes(answer);
    } finally {
      rl.close();
    }
  },
};

/** What a command shows, and says, when it asks for a yes. */
export interface Confirmation {
  /** What would happen. Shown before the question, and in the stop when nobody can answer. */
  summary: string;
  /** Why it needs a yes and what to do instead, for the stop when nobody can answer. */
  needsYes: string;
  /** The question itself. */
  question: string;
  /** The message on anything but a yes. */
  cancelled: string;
  /** Carried by both stops, so the caller can show the user what was asked (e.g. `{ plan }`). */
  details: Record<string, unknown>;
}

/**
 * Asks for a yes, or stops when nobody can give one.
 *
 * @throws CliError `confirmation_required` (exit 2) without a terminal; `cancelled` (exit 2) on
 * anything but a yes. Both carry `details`.
 */
export async function confirmOrStop(asker: Asker, c: Confirmation): Promise<void> {
  if (!asker.interactive) {
    throw needsUser(`${c.summary}\n\n${c.needsYes}`, "confirmation_required", c.details);
  }
  process.stderr.write(`${c.summary}\n\n`);
  if (!(await asker.confirm(c.question))) throw needsUser(c.cancelled, "cancelled", c.details);
}
