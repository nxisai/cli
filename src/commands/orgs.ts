/**
 * `nxis orgs` — create, list, switch, finish.
 *
 * @remarks
 * Named up front, because by the time an agent runs this it already knows the project and the
 * site. The web app creates an unnamed stub first and collects the name after payment; this
 * reuses such a stub rather than leaving a second empty organization behind, which is what
 * happens if you just always create.
 */

import { createOrganization, listOrganizations, updateOrganization, type Organization } from "../api/accounts.js";
import type { Ctx } from "../context.js";
import { requireOrg, requireSession } from "../context.js";
import { failed, needsUser } from "../errors.js";
import { bold } from "../output.js";
import { saveActiveOrg } from "../state.js";

/** Arguments for `nxis orgs create`. */
export interface OrgsCreateArgs {
  name?: string;
  website?: string;
  industry?: string;
}

/**
 * An organization the web app created as a placeholder: never finished onboarding and
 * carrying none of the details a real one would have. Reusing it keeps the account tidy and
 * means a user who started in the browser and finished in the terminal ends up with one org.
 */
function isStub(org: Organization): boolean {
  return !org.onboarded && !org.website && !org.industry;
}

/**
 * Runs `nxis orgs create`.
 *
 * @remarks
 * The name is required, and checked before anything touches the network. An organization
 * created here is marked onboarded, which makes the web app skip its "name your organization"
 * form after payment, so it has to have a name. When a placeholder exists it is renamed
 * instead; the service marks any updated organization onboarded.
 *
 * @throws CliError `org_name_required` (exit 2) when no name is given.
 */
export async function cmdOrgsCreate(ctx: Ctx, args: OrgsCreateArgs): Promise<void> {
  const { config, io } = ctx;

  const name = args.name?.trim();
  if (!name) {
    throw needsUser(
      'What should the organization be called? Run `nxis orgs create --name "Your Company"`.',
      "org_name_required",
    );
  }

  const { token, accountId } = await requireSession(ctx);

  const existing = await listOrganizations(config, token, accountId);
  const stub = existing.find(isStub);

  let org: Organization;
  let reused = false;

  if (stub) {
    reused = true;
    org = await updateOrganization(config, token, stub.id, {
      name,
      ...(args.website ? { website: args.website } : {}),
      ...(args.industry ? { industry: args.industry } : {}),
    });
  } else {
    org = await createOrganization(config, token, accountId, { ...args, name, onboarded: true });
  }

  saveActiveOrg(org.id);

  io.emit(
    { ok: true, org_id: org.id, name: org.name, reused },
    () =>
      reused
        ? `Reusing your existing organization ${bold(org.name ?? org.id)} (${org.id}).`
        : `Created ${bold(org.name ?? org.id)} (${org.id}).`,
  );
}

/** Runs `nxis orgs list`. */
export async function cmdOrgsList(ctx: Ctx): Promise<void> {
  const { config, io } = ctx;
  const { token, accountId } = await requireSession(ctx);
  const orgs = await listOrganizations(config, token, accountId);
  const active = ctx.orgOverride ?? null;

  io.emit(
    {
      ok: true,
      orgs: orgs.map((o) => ({
        id: o.id,
        name: o.name,
        website: o.website,
        onboarded: o.onboarded,
      })),
    },
    () =>
      orgs.length === 0
        ? "No organizations yet. Run `nxis orgs create --name \"…\"`."
        : orgs
            .map((o) => `${o.id === active ? "*" : " "} ${(o.name ?? "(unnamed)").padEnd(24)} ${o.id}`)
            .join("\n"),
  );
}

/**
 * Runs `nxis orgs use <org-id>`.
 *
 * @throws CliError `org_not_found` when the account is not a member.
 */
export async function cmdOrgsUse(ctx: Ctx, orgId: string): Promise<void> {
  const { config, io } = ctx;
  const { token, accountId } = await requireSession(ctx);

  const orgs = await listOrganizations(config, token, accountId);
  const match = orgs.find((o) => o.id === orgId);
  if (!match) {
    throw failed(
      `You are not a member of an organization with id ${orgId}.`,
      "org_not_found",
      { org_id: orgId },
    );
  }

  saveActiveOrg(match.id);
  io.emit({ ok: true, org_id: match.id, name: match.name }, () => `Now using ${bold(match.name ?? match.id)}.`);
}

/** Arguments for `nxis orgs update`. */
export interface OrgsUpdateArgs {
  name?: string;
  website?: string;
  industry?: string;
}

/**
 * Rename or fill in the organization.
 *
 * @remarks
 * The accounts service marks the organization onboarded on any update, so one request is
 * enough, and this is also how a placeholder created in the web app is finished from the
 * terminal.
 *
 * @throws CliError `no_fields` when nothing is given to update.
 */
export async function cmdOrgsUpdate(ctx: Ctx, args: OrgsUpdateArgs): Promise<void> {
  const { config, io } = ctx;
  const { token } = await requireSession(ctx);
  const orgId = requireOrg(ctx);

  if (!args.name && !args.website && !args.industry) {
    throw failed("Nothing to update. Pass --name, --website or --industry.", "no_fields");
  }

  const org = await updateOrganization(config, token, orgId, args);

  io.emit(
    { ok: true, org_id: org.id, name: org.name, website: org.website, onboarded: org.onboarded },
    () => `Updated ${bold(org.name ?? org.id)}.`,
  );
}
