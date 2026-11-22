/**
 * `nxis login` — device flow by default, loopback PKCE with --web.
 *
 * @remarks
 * The device code is what an agent can safely relay: a URL and eight characters, neither of
 * which is a credential. The agent reads them off stdout and tells the user; the user checks
 * the code on the page matches the one in the terminal, which is what makes this resistant to
 * a relayed-link attack.
 */

import { loginViaBrowser, pollForDeviceToken, requestDeviceCode } from "../auth.js";
import { openUrl } from "../browser.js";
import type { Ctx } from "../context.js";
import { saveCredentials } from "../credentials.js";
import { needsUser } from "../errors.js";
import { bold } from "../output.js";
import { refreshAccessToken } from "../auth.js";
import { accountIdFromClaims, decodeJwt, emailFromClaims } from "../tokens.js";

/** Arguments for `nxis login`. */
export interface LoginArgs {
  web?: boolean;
}

/**
 * Runs `nxis login`.
 *
 * @remarks
 * On a first-ever sign-in the token can be issued before the account claim is attached, so a
 * token without the claim is refreshed once.
 *
 * @throws CliError `no_account_claim` (exit 2) when the claim is still missing after a refresh.
 */
export async function cmdLogin(ctx: Ctx, args: LoginArgs): Promise<void> {
  const { config, io } = ctx;

  let creds = args.web
    ? await loginViaBrowser(config)
    : await deviceLogin(ctx);

  let claims = decodeJwt(creds.accessToken);
  let accountId = accountIdFromClaims(claims);

  let newAccount = false;
  if (!accountId && creds.refreshToken) {
    io.note("Finishing account setup…");
    creds = await refreshAccessToken(config, creds.refreshToken);
    claims = decodeJwt(creds.accessToken);
    accountId = accountIdFromClaims(claims);
    newAccount = accountId !== null;
  }

  saveCredentials(creds);

  if (!accountId) {
    throw needsUser(
      "Signed in, but no NxisAI account is attached to this login. Run `nxis login` again; " +
        "if this keeps happening, contact NxisAI support.",
      "no_account_claim",
    );
  }

  const email = emailFromClaims(claims);

  io.emit(
    { ok: true, account_id: accountId, email, new_account: newAccount },
    () => `Signed in${email ? ` as ${bold(email)}` : ""}.`,
  );
}

/**
 * Signs in with the device flow.
 *
 * @remarks
 * The URL and code are printed before a browser is opened, whether or not opening works. In a
 * container there is no browser, and the URL on screen is the entire mechanism.
 */
async function deviceLogin(ctx: Ctx) {
  const { config, io } = ctx;
  const grant = await requestDeviceCode(config);
  const url = grant.verification_uri_complete ?? grant.verification_uri;

  io.note("");
  io.note(`  Open ${bold(grant.verification_uri)}`);
  io.note(`  Enter the code ${bold(grant.user_code)}`);
  io.note("");
  io.note("Waiting for you to finish in the browser…");

  openUrl(url);

  return pollForDeviceToken(config, grant, (elapsed) => {
    if (elapsed > 0 && Math.round(elapsed / 1000) % 30 === 0) {
      io.note(`Still waiting — the code ${grant.user_code} is good for a few more minutes.`);
    }
  });
}
