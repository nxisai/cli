/**
 * `nxis whoami` and `nxis logout`.
 */

import { getAccount } from "../api/accounts.js";
import type { Ctx } from "../context.js";
import { requireSession } from "../context.js";
import { clearCredentials, clearProvisioningKeys } from "../credentials.js";
import { bold } from "../output.js";

/**
 * Runs `nxis whoami`.
 *
 * @remarks
 * The token's claim is enough to answer, but the profile call confirms the account exists in
 * the environment the CLI is pointed at, which is the useful check when switching.
 */
export async function cmdWhoami(ctx: Ctx): Promise<void> {
  const { config, io } = ctx;
  const { token, accountId, email } = await requireSession(ctx);

  const profile = await getAccount(config, token, accountId).catch(() => null);

  io.emit(
    {
      ok: true,
      account_id: accountId,
      email: profile?.email ?? email,
      name: profile?.fullName ?? null,
      profile: config.profile,
    },
    () => `${bold(profile?.email ?? email ?? accountId)} (${accountId})`,
  );
}

/**
 * Runs `nxis logout`.
 *
 * @remarks
 * Forgets the provisioning keys as well as the session. A key outlives the session that minted
 * it, so leaving it behind would let the next person at this terminal provision sites in the
 * previous user's organization without signing in.
 */
export async function cmdLogout(ctx: Ctx): Promise<void> {
  clearCredentials();
  clearProvisioningKeys();
  ctx.io.emit({ ok: true, signed_out: true }, () => "Signed out.");
}
