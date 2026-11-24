/**
 * Signing in when a call needs it, instead of stopping with `signed_out`.
 *
 * @remarks
 * The device flow, as `nxis login` runs it: a link and a short code the user checks on the
 * sign-in page. The guide sends them there and waits; the CLI never sees their password, and the
 * device code it polls with is never shown. After the sign-in the original call runs again, once.
 *
 * Without someone to ask (`--json`, `--yes`, a pipe, a client that cannot elicit) nothing changes:
 * the call stops with `signed_out` or `session_expired` (exit 3), as it always has.
 */

import { pollForDeviceToken, requestDeviceCode, type DeviceCodeGrant } from "../auth.js";
import type { Config } from "../config.js";
import type { Ctx } from "../context.js";
import type { StoredCredentials } from "../credentials.js";
import { CliError } from "../errors.js";
import { guideOf, type Answer, type Guide } from "../guide.js";
import { bold } from "../output.js";
import { completeSignIn, type SignedIn } from "../commands/login.js";

/** The reasons a sign-in resolves. */
export const SIGN_IN_REASONS: ReadonlySet<string> = new Set(["signed_out", "session_expired", "sign_in_required"]);

/** @returns True for a failure a sign-in resolves. */
export function needsSignIn(err: unknown): err is CliError {
  return err instanceof CliError && SIGN_IN_REASONS.has(err.reason);
}

/** The device flow's two calls. Replaced in tests. */
export interface DeviceFlow {
  request(config: Config): Promise<DeviceCodeGrant>;
  poll(config: Config, grant: DeviceCodeGrant, signal: AbortSignal): Promise<StoredCredentials>;
}

const DEVICE_FLOW: DeviceFlow = {
  request: requestDeviceCode,
  poll: (config, grant, signal) => pollForDeviceToken(config, grant, undefined, signal),
};

/**
 * Signs the user in through the guide: the sign-in link and code, then a wait for the sign-in.
 *
 * @returns Who signed in, or the user's no.
 * @throws CliError `device_code_expired`, `access_denied` and what `nxis login` throws.
 */
export async function guidedSignIn(ctx: Ctx, guide: Guide, flow: DeviceFlow = DEVICE_FLOW): Promise<Answer<SignedIn | null>> {
  const grant = await flow.request(ctx.config);
  const url = grant.verification_uri_complete ?? grant.verification_uri;
  const answer = await guide.visit({
    message:
      `Sign in to NxisAI to continue. Open the sign-in page and check it shows the code ${grant.user_code}, then ` +
      "confirm there. Your sign-in stays on that page.",
    url,
    until: (signal) => flow.poll(ctx.config, grant, signal),
  });
  if (!answer.ok) return answer;
  if (!answer.value) return { ok: true, value: null };
  return { ok: true, value: await completeSignIn(ctx, answer.value) };
}

/** Commands that never sign in on their own: they are the sign-in, or have nothing to sign in for. */
const NOT_RETRIED = new Set(["login", "logout"]);

/**
 * On a terminal, offers to sign in when a command stopped for want of it.
 *
 * @param command - The command and its first word, e.g. `["mcp", "serve"]`.
 * @param yes - `--yes`: the caller wants no questions.
 * @param flow - The device flow. Auth0's, outside tests.
 * @returns True when the user signed in, so the command can run again (once).
 */
export async function offerSignIn(
  ctx: Ctx,
  err: unknown,
  command: [string | undefined, string | undefined],
  yes: boolean,
  flow: DeviceFlow = DEVICE_FLOW,
): Promise<boolean> {
  if (!needsSignIn(err) || yes) return false;
  const [name, sub] = command;
  if (!name || NOT_RETRIED.has(name) || (name === "mcp" && sub === "serve")) return false;
  const guide = guideOf(ctx);
  if (!guide.interactive) return false;

  const why = err.reason === "session_expired" ? "Your NxisAI session expired." : "You're not signed in to NxisAI.";
  const go = await guide.confirm({ message: why, question: "Sign in now? It opens the sign-in page and waits." });
  if (!go.ok) return false;
  const signed = await guidedSignIn(ctx, guide, flow);
  if (!signed.ok || !signed.value) return false;
  ctx.io.note(`Signed in${signed.value.email ? ` as ${bold(signed.value.email)}` : ""}. Continuing...`);
  return true;
}
