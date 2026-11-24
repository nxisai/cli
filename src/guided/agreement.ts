/**
 * The data processing agreement, offered when going live needs it, instead of a `dpa_not_accepted`
 * the user resolves with `nxis agents dpa accept` elsewhere.
 *
 * @remarks
 * The user is shown the current version and where to read it, and chooses who accepts: the
 * organization, for all of its sites, or the legal entity this site belongs to, for this site
 * only. There is no default: only a choice of one of those accepts, and anything else leaves the
 * agreement unaccepted. The acceptance is recorded as theirs, for exactly the version shown, as
 * `nxis agents dpa accept` records it.
 */

import { acceptAgentDpa, dpaBaseUrl, dpaUrl, getAgentSetup, notPublished, type AgentSetup } from "../api/agent-setup.js";
import type { Ctx } from "../context.js";
import { cannotAsk, guideOf, refused, type Answer, type Guide } from "../guide.js";
import { plainText } from "../output.js";
import { dpaJson, dpaState, ENTITY_MAX, entityName, party } from "../commands/agents-dpa.js";
import { target, type Target } from "../commands/hosted-agents.js";

/** @returns True when the site's agents wait on an agreement that can be accepted now. */
export function agreementNeeded(setup: AgentSetup): boolean {
  const state = dpaState(setup);
  return state === "not_accepted" || state === "newer_version";
}

/** @returns What the user is shown: the version, its link, and what accepting means. */
function agreementMessage(t: Target, setup: AgentSetup, base: string, lead: string): string {
  const v = plainText(setup.currentVersion);
  const prev = setup.acceptance && setup.acceptance.version !== setup.currentVersion ? setup.acceptance.version : "";
  return (
    `${lead} The data processing agreement for hosted agents, version ${v}, is not accepted for site ${t.siteId}. ` +
    `Read it at ${dpaUrl(setup.currentVersion, base)}.` +
    (prev ? ` It replaces version ${plainText(prev)}, accepted earlier.` : "") +
    " Accepting confirms you're authorized to bind the party you choose."
  );
}

/**
 * Asks who accepts the agreement, and accepts it for them.
 *
 * @param lead - What the question is in aid of, in a sentence ("Hosted agents answer visitors once it is accepted.").
 * @returns The setup after accepting, or the user's no.
 * @throws CliError `invalid_entity` (exit 1) for an entity name the service wouldn't take;
 * `dpa_version_changed` (exit 2) when a newer version was published in between; and what
 * accepting throws.
 */
export async function offerAgreement(ctx: Ctx, guide: Guide, t: Target, setup: AgentSetup, lead: string): Promise<Answer<AgentSetup>> {
  const base = dpaBaseUrl();
  const version = setup.currentVersion;
  // A site already another legal entity's is accepted by that entity, never by the organization.
  const options: Array<{ value: string | null; label: string }> = setup.legalEntity
    ? [{ value: setup.legalEntity, label: `Accept for ${party(t, setup.legalEntity)}` }]
    : [
        { value: "", label: `Accept for ${party(t, "")}` },
        { value: null, label: `Accept for the legal entity site ${t.siteId} belongs to, when it isn't the organization (this site only)` },
      ];
  const who = await guide.choose({ message: agreementMessage(t, setup, base, lead), title: "Agreement", options });
  if (!who.ok) return who;

  let entity = who.value;
  if (entity === null) {
    const named = await guide.text({
      message: `The name of the legal entity site ${t.siteId} belongs to, as it is registered.`,
      title: "Legal entity",
      maxLength: ENTITY_MAX,
    });
    if (!named.ok) return named;
    entity = entityName(named.value);
  }
  const after = await acceptAgentDpa(ctx.config, t.token, t.orgId, t.siteId, version, base, entity);
  ctx.io.note(`Accepted the data processing agreement, version ${plainText(version)}, for ${party(t, entity)}.`);
  return { ok: true, value: after };
}

/**
 * On a terminal, before `agents enable`: offers the agreement when the site's agents wait on it.
 *
 * @remarks
 * Nothing is asked with `--yes` or `--json`, without a terminal, under `--dry-run`, or when the
 * setup can't be read: the enable then runs as it always did, and its result says the agreement
 * is what holds the agent back.
 *
 * @throws CliError `cancelled` (exit 2) when the user chooses neither, before anything changes.
 */
export async function agreementBeforeEnable(ctx: Ctx, opts: { yes: boolean; dryRun: boolean }): Promise<void> {
  if (opts.yes || opts.dryRun) return;
  const guide = guideOf(ctx);
  if (!guide.interactive) return;
  let t: Target;
  let setup: AgentSetup;
  try {
    t = await target(ctx);
    setup = await getAgentSetup(ctx.config, t.token, t.orgId, t.siteId);
  } catch {
    return;
  }
  if (!agreementNeeded(setup)) return;
  const answer = await offerAgreement(ctx, guide, t, setup, "The agent answers visitors once the agreement is accepted.");
  if (!answer.ok) {
    throw refused(
      guide,
      answer.why,
      "Nothing was accepted or changed. Accept it later with `nxis agents dpa accept`, or run the enable with --yes " +
        "to turn the agent on in preview without being asked.",
      { version: setup.currentVersion, url: dpaUrl(setup.currentVersion, dpaBaseUrl()) },
    );
  }
}

/**
 * `nxis_accept_dpa`: the agreement for the site, accepted by whoever the user chooses.
 *
 * @returns `agents dpa`'s `--json` object, with `changed`.
 * @throws CliError `dpa_not_published` (exit 1); `confirmation_unavailable` (exit 2, with the
 * version and link) when nobody can be asked; `declined_by_user` or `cancelled_by_user` (exit 2)
 * when the user accepts for neither; and what {@link offerAgreement} throws.
 */
export async function acceptDpaOp(ctx: Ctx, site?: string): Promise<Record<string, unknown>> {
  const base = dpaBaseUrl();
  const t = await target(site ? { ...ctx, siteOverride: site } : ctx);
  const setup = await getAgentSetup(ctx.config, t.token, t.orgId, t.siteId);
  if (!setup.currentVersion) throw notPublished();
  if (!agreementNeeded(setup)) return { ...dpaJson(t, setup, base), changed: false };

  const guide = guideOf(ctx);
  const url = dpaUrl(setup.currentVersion, base);
  if (!guide.interactive) {
    throw cannotAsk(
      `Accept the data processing agreement for hosted agents, version ${plainText(setup.currentVersion)} (${url}), for ` +
        `${setup.legalEntity ? party(t, setup.legalEntity) : `${party(t, "")}, or for the legal entity the site belongs to`}.`,
      setup.legalEntity ? `nxis agents dpa accept --entity "${plainText(setup.legalEntity)}"` : "nxis agents dpa accept",
      { version: setup.currentVersion, url, site: t.siteId, legal_entity: setup.legalEntity || null },
    );
  }
  const answer = await offerAgreement(ctx, guide, t, setup, "Hosted agents answer visitors once it is accepted.");
  if (!answer.ok) {
    throw refused(guide, answer.why, "The agreement was not accepted; going live waits on it.", { version: setup.currentVersion, url });
  }
  return { ...dpaJson(t, answer.value, base), changed: true };
}
