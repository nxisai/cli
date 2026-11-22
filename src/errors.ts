/**
 * The exit-code contract.
 *
 * @remarks
 * This is the agent-facing API as much as `--json` is. An agent driving the CLI is blind
 * for the two browser steps, so it needs to tell three outcomes apart without seeing them:
 * "I am waiting on the human", "the human needs to fix something", and "this failed".
 * Conflating the first with the last is what makes an agent retry a payment.
 */
export const ExitCode = {
  /** Done. */
  OK: 0,
  /** Anything else, with the service's own message. */
  ERROR: 1,
  /** Needs the user: sign-in pending, payment pending, a choice to make. Never a failure. */
  NEEDS_USER: 2,
  /** Signed out, expired, or not permitted. Re-authenticate rather than retry. */
  NOT_AUTHORIZED: 3,
} as const;

/** One of the {@link ExitCode} values. */
export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/** An error with an exit code and a stable, machine-readable reason. */
export class CliError extends Error {
  readonly exitCode: ExitCodeValue;
  /** Machine-readable reason, stable across releases — agents branch on this. */
  readonly reason: string;
  /** Extra fields merged into the `--json` output, so a wait is actionable. */
  readonly details: Record<string, unknown>;

  constructor(
    message: string,
    opts: { exitCode?: ExitCodeValue; reason?: string; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "CliError";
    this.exitCode = opts.exitCode ?? ExitCode.ERROR;
    this.reason = opts.reason ?? "error";
    this.details = opts.details ?? {};
  }

  /** @returns The `--json` failure object. */
  toJSON(): Record<string, unknown> {
    return { ok: false, reason: this.reason, error: this.message, ...this.details };
  }
}

/** The user has to do something. Exit 2 — not a failure, and never worth retrying blindly. */
export function needsUser(
  message: string,
  reason: string,
  details: Record<string, unknown> = {},
): CliError {
  return new CliError(message, { exitCode: ExitCode.NEEDS_USER, reason, details });
}

/** Signed out, token expired, or not an owner of the organization. */
export function notAuthorized(
  message: string,
  reason = "not_authorized",
  details: Record<string, unknown> = {},
): CliError {
  return new CliError(message, { exitCode: ExitCode.NOT_AUTHORIZED, reason, details });
}

/** A plain failure. Exit 1. */
export function failed(
  message: string,
  reason = "error",
  details: Record<string, unknown> = {},
): CliError {
  return new CliError(message, { exitCode: ExitCode.ERROR, reason, details });
}
