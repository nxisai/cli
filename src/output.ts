/**
 * Two audiences, one command.
 *
 * @remarks
 * With `--json` the CLI emits one object on stdout and nothing else, so an agent can parse
 * it without stripping prose. Without it, a person gets short lines on stderr and the same
 * facts. Keeping progress on stderr means `nxis plans --json | jq` works while the waiting
 * messages still reach a human watching the terminal.
 */

/** Output for one command, in human or `--json` form. */
export interface Io {
  json: boolean;
  /** Progress and status, for a person. Suppressed under --json. */
  note: (line: string) => void;
  /** The result. Exactly one per command. */
  emit: (payload: Record<string, unknown>, human: () => string) => void;
}

/** Creates the output helper for this invocation. */
export function createIo(json: boolean): Io {
  return {
    json,
    note: (line: string) => {
      if (!json) process.stderr.write(`${line}\n`);
    },
    emit: (payload, human) => {
      if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      else process.stdout.write(`${human()}\n`);
    },
  };
}

/** 1,000,000 milli-NXC → "1,000 NXC". Credits are integers; never show a fraction. */
export function formatCredits(milli: number | null | undefined): string {
  if (milli === null || milli === undefined) return "—";
  return `${Math.round(milli / 1000).toLocaleString("en-US")} NXC`;
}

/** Formats a price in dollars, dropping `.00`. */
export function formatPrice(price: number | null | undefined): string {
  if (!price) return "$0";
  return `$${price.toFixed(2).replace(/\.00$/, "")}`;
}

/** Formats a billing interval as `/month`, or `every 3 months` for multi-unit intervals. */
export function formatInterval(interval: string | null | undefined, count?: number | null): string {
  const unit = (interval ?? "month").toLowerCase();
  if (count && count > 1) return `every ${count} ${unit}s`;
  return `/${unit}`;
}

const BOLD = "[1m";
const DIM = "[2m";
const RESET = "[0m";

/** Wraps text in an ANSI style when color is on. */
function styled(on: boolean, code: string, text: string): string {
  return on ? `${code}${text}${RESET}` : text;
}

/** Bold text, when color is on. */
export function bold(text: string): string {
  return styled(useColor(), BOLD, text);
}

/** Dim text, when color is on. */
export function dim(text: string): string {
  return styled(useColor(), DIM, text);
}

/** Color is on unless `NO_COLOR` is set; `FORCE_COLOR` forces it; otherwise only on a TTY. */
export function useColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return process.stderr.isTTY === true;
}

/**
 * Text from a server, safe to print.
 *
 * @remarks
 * Messages from the services and the identity provider reach the terminal, so a response could
 * carry escape sequences that move the cursor, rewrite earlier lines or set the window title.
 * Every control character becomes a space, and runs of whitespace collapse to one.
 */
export function plainText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s{2,}/g, " ").trim();
}
