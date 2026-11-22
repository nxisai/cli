/**
 * `nxis agents dpa` — the data processing agreement for hosted agents: which version is current,
 * where to read it, and whether this organization and site has accepted it; and `dpa accept`.
 *
 * @remarks
 * Going live needs the current version accepted. Accepting is a legal step a
 * person takes, so `accept` always shows the version and its link first, and then asks on a
 * terminal; anywhere else it stops with `confirmation_required` (exit 2), the version and the
 * link, until `--yes` says the user read it and agreed. It never accepts on its own.
 *
 * It sends exactly the version it showed. If a newer one is published in between, the service
 * refuses it, and the command says which version to read instead (`dpa_version_changed`, exit 2).
 *
 * The organization accepts once, for all of its sites. A site that belongs to a different legal
 * entity is accepted by that entity, for that site only: `--site <id> --entity "<name>"`.
 */

import {
  dpaBaseUrl,
  dpaUrl,
  getAgentSetup,
  acceptAgentDpa,
  notPublished,
  type AgentSetup,
  type DpaAcceptance,
} from "../api/agent-setup.js";
import type { Ctx } from "../context.js";
import { failed, needsUser } from "../errors.js";
import { bold, dim, plainText } from "../output.js";
import { confirmOrStop, terminalAsker, type Asker } from "../prompt.js";
import { isDryRun } from "../trace.js";
import { target, type Target } from "./hosted-agents.js";

/**
 * Where a site stands with the agreement.
 *
 * - `not_published`: no version is published, so none can be accepted, and going live waits.
 * - `accepted`: the current version is accepted.
 * - `newer_version`: an earlier version was accepted; the current one, published since, is not.
 * - `not_accepted`: no version was ever accepted.
 */
export type DpaState = "not_published" | "accepted" | "newer_version" | "not_accepted";

/** @returns Where the site stands with the agreement. */
export function dpaState(setup: AgentSetup): DpaState {
  if (!setup.currentVersion) return "not_published";
  if (setup.current) return "accepted";
  return setup.acceptance && setup.acceptance.version !== setup.currentVersion ? "newer_version" : "not_accepted";
}

/** @returns The acceptance of the current version: the latest one when it is that version, else from the lists. */
function currentAcceptance(setup: AgentSetup): DpaAcceptance | null {
  if (!setup.current) return null;
  if (setup.acceptance?.version === setup.currentVersion) return setup.acceptance;
  return [...setup.organizationAcceptances, ...setup.acceptances].reverse().find((a) => a.version === setup.currentVersion) ?? null;
}

/** An acceptance in `--json` results. */
function acceptanceJson(a: DpaAcceptance | null, base: string): Record<string, unknown> | null {
  return a
    ? {
        version: a.version,
        accepted_by: a.acceptedBy || null,
        accept_time: a.acceptTime || null,
        legal_entity: a.legalEntity || null,
        url: dpaUrl(a.version, base),
      }
    : null;
}

/** @returns Whom the agreement is accepted for, in a sentence. */
export function party(t: Target, entity: string): string {
  return entity
    ? `${plainText(entity)}, the legal entity site ${t.siteId} belongs to (this site only)`
    : `organization ${t.orgId} (all of its sites)`;
}

/** The longest legal entity name the service takes. */
export const ENTITY_MAX = 200;

/**
 * @returns The `--entity` name, trimmed, or "" without the flag.
 * @throws CliError `invalid_entity` (exit 1) for a name that's empty, too long, or holds control characters.
 */
export function entityName(raw: string | boolean | undefined): string {
  if (raw === undefined) return "";
  const name = typeof raw === "string" ? raw.trim() : "";
  // eslint-disable-next-line no-control-regex
  const why = !name ? "needs the legal entity's name" : name.length > ENTITY_MAX ? `takes at most ${ENTITY_MAX} characters` : /[\u0000-\u001f\u007f]/.test(name) ? "can't hold control characters" : "";
  if (why) throw failed(`--entity ${why}: \`--site <id> --entity "<name>"\`.`, "invalid_entity");
  return name;
}

/** The `--json` result for a setup. */
export function dpaJson(t: Target, setup: AgentSetup, base: string): Record<string, unknown> {
  const v = setup.currentVersion;
  return {
    ok: true,
    org: t.orgId,
    site: t.siteId,
    state: dpaState(setup),
    version: v || null,
    url: v ? dpaUrl(v, base) : null,
    accepted: setup.current,
    // Who accepts for this site: the organization, or the other legal entity it belongs to.
    accepted_for: setup.legalEntity ? "legal_entity" : "organization",
    legal_entity: setup.legalEntity || null,
    // With `newer_version`, while the earlier acceptance still applies; null otherwise.
    grace_end: setup.status === "grace" && setup.graceEnd ? setup.graceEnd : null,
    // The latest acceptance that counts for the site, of any version: with `newer_version`, the earlier one.
    acceptance: acceptanceJson(setup.acceptance, base),
    acceptances: setup.acceptances.map((a) => acceptanceJson(a, base)),
    organization_acceptances: setup.organizationAcceptances.map((a) => acceptanceJson(a, base)),
  };
}

/** @returns An RFC 3339 time as a date, `2027-03-31`, or "". */
export function day(ts: string): string {
  const d = ts ? new Date(ts) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : "";
}

/** @returns An RFC 3339 time as `2026-11-16 14:05 UTC`, or "" when there is none. */
export function when(ts: string): string {
  const d = ts ? new Date(ts) : null;
  return d && !Number.isNaN(d.getTime()) ? `${d.toISOString().slice(0, 16).replace("T", " ")} UTC` : "";
}

/** @returns "by <who> on <when>", either part left out when the service sent none. */
function byWhen(a: DpaAcceptance): string {
  return [a.acceptedBy ? `by ${plainText(a.acceptedBy)}` : "", when(a.acceptTime) ? `on ${when(a.acceptTime)}` : ""]
    .filter(Boolean)
    .join(" ");
}

/** The human summary of a setup. */
export function dpaSummary(t: Target, setup: AgentSetup, base: string): string {
  const row = (name: string, value: string) => `  ${name.padEnd(16)} ${value}`;
  const head = `Data processing agreement for hosted agents, site ${bold(t.siteId)}`;
  const state = dpaState(setup);
  if (state === "not_published") {
    return [
      head,
      "  NxisAI hasn't published it yet, so it can't be accepted. Going live waits for it; you can set up and",
      "  preview your agents meanwhile.",
    ].join("\n");
  }
  const v = plainText(setup.currentVersion);
  const lines = [
    head,
    row("Current version", v),
    row("Read it", dpaUrl(setup.currentVersion, base)),
    row("Accepted for", party(t, setup.legalEntity)),
  ];
  if (state === "accepted") {
    const a = currentAcceptance(setup);
    lines.push(row("Accepted", a && byWhen(a) ? `yes, ${byWhen(a)}` : "yes"));
    return lines.join("\n");
  }
  if (state === "newer_version" && setup.acceptance) {
    const prev = setup.acceptance;
    const end = setup.status === "grace" ? day(setup.graceEnd) : "";
    lines.push(
      row("Accepted", `not this version. Version ${plainText(prev.version)} was accepted${byWhen(prev) ? ` ${byWhen(prev)}` : ""};`),
      end
        ? row("", `it keeps applying until ${end}. Accept version ${v} by then, or the agents return to preview.`)
        : row("", `version ${v} replaced it, and the agents need it accepted to answer visitors.`),
    );
  } else {
    lines.push(row("Accepted", "no. The agents need it accepted to answer visitors."));
  }
  const how = setup.legalEntity ? `\`nxis agents dpa accept --entity "${plainText(setup.legalEntity)}"\`` : "`nxis agents dpa accept`";
  lines.push(dim(`  Read it, then accept it with ${how}.`));
  return lines.join("\n");
}

/** Runs `nxis agents dpa`: the current version, its link, and whether it is accepted. */
export async function cmdAgentsDpa(ctx: Ctx): Promise<void> {
  const base = dpaBaseUrl();
  const t = await target(ctx);
  const setup = await getAgentSetup(ctx.config, t.token, t.orgId, t.siteId);
  ctx.io.emit(dpaJson(t, setup, base), () => dpaSummary(t, setup, base));
}

/** Options for `nxis agents dpa accept`. */
export interface AcceptArgs {
  /** The user read the agreement and agreed: don't ask. Only ever from the user's own `--yes`. */
  yes?: boolean;
  /**
   * `--entity`: the site belongs to this legal entity, not the organization, which accepts for the site only. Unset:
   * the organization accepts, for all of its sites.
   */
  entity?: string | boolean;
  asker?: Asker;
}

/**
 * Runs `nxis agents dpa accept`: shows the current version and its link, asks, then accepts that
 * version.
 *
 * @throws CliError `dpa_not_published` (exit 1) when no version is published; `confirmation_required`
 * (exit 2, with `version` and `url`) without a terminal or `--yes`; `cancelled` (exit 2) on anything
 * but a yes; `dpa_version_changed` (exit 2) when a newer version was published in between;
 * `dry_run` with the request that would be sent; and whatever reading and accepting throw.
 */
export async function cmdAgentsDpaAccept(ctx: Ctx, args: AcceptArgs = {}): Promise<void> {
  const base = dpaBaseUrl();
  const entity = entityName(args.entity);
  const t = await target(ctx);
  const setup = await getAgentSetup(ctx.config, t.token, t.orgId, t.siteId);
  const version = setup.currentVersion;
  if (!version) throw notPublished();
  const url = dpaUrl(version, base);

  // A site already another legal entity's is accepted by that entity, never by the organization.
  if (setup.legalEntity && !entity) {
    throw needsUser(
      `Site ${t.siteId} belongs to ${plainText(setup.legalEntity)}, a different legal entity than your organization, so ` +
        `that entity accepts the agreement for it. If you're authorized to bind it, run ` +
        `\`nxis agents dpa accept --entity "${plainText(setup.legalEntity)}"\`.`,
      "dpa_entity_required",
      { legal_entity: setup.legalEntity, site: t.siteId },
    );
  }

  if (setup.current && (!entity || entity === setup.legalEntity)) {
    ctx.io.emit(
      { ...dpaJson(t, setup, base), changed: false },
      () => `Version ${plainText(version)} is already accepted; nothing changed.\n${dpaSummary(t, setup, base)}`,
    );
    return;
  }

  if (!args.yes && !isDryRun()) {
    const prev = setup.acceptance;
    await confirmOrStop(args.asker ?? terminalAsker, {
      summary:
        `${bold("Accept the data processing agreement for hosted agents")}\n` +
        `  Version ${plainText(version)}, for ${party(t, entity)}\n` +
        `  Read it at ${url}\n` +
        `  ${dim(`By accepting, you confirm you're authorized to bind ${entity ? plainText(entity) : "your organization"}.`)}` +
        (prev && prev.version !== version ? `\n  ${dim(`It replaces version ${plainText(prev.version)}, accepted earlier.`)}` : ""),
      needsYes:
        "Accepting the agreement is the user's decision, so it needs a yes. Show the user the version and the link, " +
        "and once they have read it and agree, run again with --yes.",
      question: `Accept the data processing agreement, version ${plainText(version)}?`,
      cancelled: "Cancelled. Nothing was accepted.",
      details: { version, url, site: t.siteId, legal_entity: entity || null },
    });
  }

  // Exactly the version shown: one published since is refused, not accepted unread.
  const after = await acceptAgentDpa(ctx.config, t.token, t.orgId, t.siteId, version, base, entity);
  ctx.io.emit(
    { ...dpaJson(t, after, base), changed: true },
    () => `Accepted the data processing agreement, version ${plainText(version)}, for ${party(t, entity)}.\n${dpaSummary(t, after, base)}`,
  );
}
