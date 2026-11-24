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
import { currentOrg, requireOrg, requireSession } from "../context.js";
import { failed, needsUser } from "../errors.js";
import { bold, plainText } from "../output.js";
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
export function isStub(org: Organization): boolean {
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
  const out = await orgsCreateOp(ctx, args);
  const label = out.name ?? out.org_id;
  ctx.io.emit(out, () =>
    out.reused ? `Reusing your existing organization ${bold(label)} (${out.org_id}).` : `Created ${bold(label)} (${out.org_id}).`,
  );
}

/**
 * `nxis orgs create`, and `nxis_create_org` in `nxis mcp serve`: the organization created (or the
 * placeholder renamed), saved as the current one.
 *
 * @throws CliError `org_name_required` (exit 2) when no name is given.
 */
export async function orgsCreateOp(
  ctx: Ctx,
  args: OrgsCreateArgs,
): Promise<{ ok: true; org_id: string; name: string | null; reused: boolean }> {
  const { config } = ctx;

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
  return { ok: true, org_id: org.id, name: org.name ?? null, reused };
}

/** Runs `nxis orgs list`. */
export async function cmdOrgsList(ctx: Ctx): Promise<void> {
  const out = await orgsListOp(ctx);
  ctx.io.emit(out, () =>
    out.orgs.length === 0
      ? "No organizations yet. Run `nxis orgs create --name \"…\"`."
      : out.orgs.map((o) => `${o.current ? "*" : " "} ${(o.name ?? "(unnamed)").padEnd(24)} ${o.id}`).join("\n"),
  );
}

/**
 * `nxis orgs list`, and `nxis_list_orgs`: the account's organizations, and which one commands act on
 * (`--org`, else the saved one).
 */
export async function orgsListOp(ctx: Ctx): Promise<{
  ok: true;
  current_org_id: string | null;
  orgs: Array<{ id: string; name: string | null; website: string | null; onboarded: boolean; current: boolean }>;
}> {
  const { token, accountId } = await requireSession(ctx);
  const orgs = await listOrganizations(ctx.config, token, accountId);
  const active = currentOrg(ctx);
  return {
    ok: true,
    current_org_id: active,
    orgs: orgs.map((o) => ({ id: o.id, name: o.name ?? null, website: o.website ?? null, onboarded: o.onboarded, current: o.id === active })),
  };
}

/**
 * Runs `nxis orgs use <org-id>`.
 *
 * @throws CliError `org_not_found` when the account is not a member.
 */
export async function cmdOrgsUse(ctx: Ctx, orgId: string): Promise<void> {
  const out = await orgsUseOp(ctx, orgId);
  ctx.io.emit(out, () => `Now using ${bold(out.name ?? out.org_id)}.`);
}

/**
 * `nxis orgs use`, and `nxis_use_org`: saves the organization, by id or by its exact name (any
 * case, when only one has it), as the current one.
 *
 * @throws CliError `org_not_found` (exit 1) when the account is not a member of one;
 * `org_ambiguous` (exit 1) for a name more than one organization has.
 */
export async function orgsUseOp(ctx: Ctx, ref: string): Promise<{ ok: true; org_id: string; name: string | null }> {
  const { token, accountId } = await requireSession(ctx);
  const wanted = ref.trim();
  const orgs = await listOrganizations(ctx.config, token, accountId);
  const byName = orgs.filter((o) => (o.name ?? "").trim().toLowerCase() === wanted.toLowerCase());
  const match = orgs.find((o) => o.id === wanted) ?? (byName.length === 1 ? byName[0] : undefined);
  if (!match && byName.length > 1) {
    throw failed(`More than one of your organizations is called "${plainText(wanted)}"; use its id.`, "org_ambiguous", {
      org: wanted,
      org_ids: byName.map((o) => o.id),
    });
  }
  if (!match) {
    throw failed(`You are not a member of an organization with id ${plainText(wanted)}.`, "org_not_found", { org_id: wanted });
  }
  saveActiveOrg(match.id);
  return { ok: true, org_id: match.id, name: match.name ?? null };
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
