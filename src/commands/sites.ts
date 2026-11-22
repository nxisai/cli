/**
 * `nxis sites` — the site steps of onboarding: create, pick, verify, name, list in the app.
 *
 * @remarks
 * Each command is one step of the Site Onboarding skill (`agentic-site-onboarding`), run as a
 * command rather than as an agent's tool call, so a script or a CI job can do the same steps and
 * branch on the exit code. The commands are thin: the tool definitions in `src/tools/` validate
 * the arguments, fill in the site and withhold writes under `--dry-run`. What is here is the part
 * a terminal needs on top: which site is current, what the exit code says, and what to print.
 *
 * Every site-scoped command resolves the site once, up front, on the same connection it then
 * calls the tool on, so `--json` can always say which site it acted on, and a domain costs one
 * lookup however many calls follow.
 *
 * The routing for `nxis sites <sub>` is here too ({@link runSites}), so `cli.ts` needs one line.
 */

import { bool, list, str, type Flags } from "../args.js";
import type { Ctx } from "../context.js";
import { currentSite, requireOrg, requireSite } from "../context.js";
import { CliError, ExitCode, failed, needsUser } from "../errors.js";
import { bold, dim, plainText } from "../output.js";
import { withProvisioning } from "../provisioning/endpoint.js";
import { saveActiveSite } from "../state.js";
import {
  createSite,
  hostOf,
  listInApp,
  listSites,
  matchSite,
  resolveSiteId,
  setSiteName,
  siteTag,
  verifySite,
  type ListInAppResult,
  type SiteSummary,
  type SiteTagResult,
  type ToolCaller,
} from "../tools/index.js";

/** The skill the commands mirror, as help and usage errors name it. */
const SKILL = "the Site Onboarding skill";

/** Shown with every created site, because the mistake it prevents cannot be undone. */
const HOST_FIXED =
  "The host is fixed at creation: www and the apex are different sites, and a preview or branch " +
  "host never verifies. If this is the wrong host, the site has to be deleted, not edited.";

/** Why a failed check is usually not a failure, and the one mistake worth ruling out. */
const PREVIEW_NEVER_VERIFIES =
  "The check fetches the site's own URL, so a deploy preview or branch deploy on its own host never " +
  "verifies, however correct the tag in it is. Deploy to production, then check again.";

/** Usage, per subcommand, naming the skill step each one is. */
const USAGE = {
  create: `\`nxis sites create <url> [--name <name>]\` (step 1 of ${SKILL}: create the site).`,
  use: "`nxis sites use <id|domain>` picks the site the other `nxis sites` commands act on.",
  verify:
    `\`nxis sites verify --token\` (step 2 of ${SKILL}: get the META tag) or ` +
    "`nxis sites verify --check` (step 3: check it is live).",
  tag:
    "`nxis sites tag [status|issue] [--domain <host>]... [--webmcp-mode browser|ssr|none]` " +
    `(after ${SKILL}: the site tag, for a verified site).`,
  name: `\`nxis sites name <name>\` (step 9 of ${SKILL}: the name the NxisAI app lists it under).`,
  listInApp: `\`nxis sites list-in-app [--preview] [--off]\` (step 9 of ${SKILL}: list it in the NxisAI app).`,
} as const;

/** The subcommands, for the error when none matches. */
const SUBCOMMANDS = "create, list, use, verify, tag, name or list-in-app";

/**
 * Dispatches `nxis sites <sub> …`.
 *
 * @param ctx - The command context.
 * @param args - The positional arguments after `sites`.
 * @param flags - The parsed flags.
 * @throws CliError `unknown_command` (exit 1) for a subcommand that does not exist, and whatever
 * the subcommand throws.
 */
export async function runSites(ctx: Ctx, args: string[], flags: Flags): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "create": {
      const url = rest[0];
      if (!url) throw failed(`Which URL? ${USAGE.create}`, "missing_url");
      const name = str(flags, "name");
      await cmdSitesCreate(ctx, { url, ...(name !== undefined ? { name } : {}) });
      return;
    }
    case "list":
      await cmdSitesList(ctx);
      return;
    case "use": {
      const value = rest[0];
      if (!value) throw failed(`Which site? ${USAGE.use}`, "missing_site");
      await cmdSitesUse(ctx, value);
      return;
    }
    case "verify": {
      const token = bool(flags, "token");
      const check = bool(flags, "check");
      if (token === check) throw failed(`Pass one of --token or --check. ${USAGE.verify}`, "missing_mode");
      await cmdSitesVerify(ctx, { mode: token ? "token" : "check" });
      return;
    }
    case "tag": {
      const mode = rest[0] ?? "status";
      if (mode !== "status" && mode !== "issue") throw failed(`Unknown mode "${mode}". ${USAGE.tag}`, "unknown_mode");
      const webmcpMode = str(flags, "webmcp-mode");
      await cmdSitesTag(ctx, {
        mode,
        domains: list(flags, "domain"),
        ...(webmcpMode !== undefined ? { webmcpMode } : {}),
      });
      return;
    }
    case "name": {
      const name = rest.join(" ");
      if (!name.trim()) throw failed(`What name? ${USAGE.name}`, "missing_name");
      await cmdSitesName(ctx, name);
      return;
    }
    case "list-in-app":
      await cmdSitesListInApp(ctx, { preview: bool(flags, "preview"), off: bool(flags, "off") });
      return;
    default:
      throw failed(
        sub ? `Unknown sites command "${sub}". Try ${SUBCOMMANDS}.` : `Which sites command? Try ${SUBCOMMANDS}.`,
        "unknown_command",
      );
  }
}

/**
 * Resolves the current site to an id on an open connection, then runs `fn` with both.
 *
 * @throws CliError `no_active_site`, `site_not_found` or `site_ambiguous` (exit 2), and whatever
 * `fn` throws.
 */
async function onSite<T>(ctx: Ctx, fn: (client: ToolCaller, site: string) => Promise<T>): Promise<T> {
  const value = requireSite(ctx);
  return withProvisioning(ctx, async (client) => fn(client, await resolveSiteId(ctx, value, client)));
}

/** @returns Server text, safe to print, or the fallback when there is none. */
function said(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? plainText(value) : fallback;
}

/** @returns The server's `next` notes as a list, whether it sent one string or several. */
function notes(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [plainText(value)] : [];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string").map(plainText);
  return [];
}

// ── create ──────────────────────────────────────────────────────────────────

/** Arguments for `nxis sites create`. */
export interface SitesCreateArgs {
  /** The site's root URL. */
  url: string;
  /** A display name, set with a second call. */
  name?: string;
}

/**
 * Runs `nxis sites create <url> [--name <name>]`: step 1 of the onboarding.
 *
 * @remarks
 * `nxis_create_site` takes only the URL, so `--name` is a second call, `nxis_set_site_name`, on
 * the same connection. The new site is saved as current before it is named: if naming fails, the
 * site exists anyway, and losing track of it would leave the next command acting on the old one.
 *
 * Under `--dry-run` the create is withheld, and the dry-run result also says the name call that
 * would follow, since it needs the id the create would have returned.
 *
 * The warning that the host is fixed is printed every time, and returned as `warning` under
 * `--json`, because a site created on the wrong host (www for apex, a preview host) can only be
 * deleted and the failure shows up two steps later, as a check that never passes.
 *
 * @throws CliError `missing_name` (exit 1) for an empty `--name`; `dry_run` (exit 0) under
 * `--dry-run`; `site_name_failed` (exit as the cause) when the site was created but not named.
 */
export async function cmdSitesCreate(ctx: Ctx, args: SitesCreateArgs): Promise<void> {
  const name = args.name?.trim();
  if (args.name !== undefined && !name) throw failed(`--name is empty. ${USAGE.create}`, "missing_name");
  const orgId = requireOrg(ctx);

  await withProvisioning(ctx, async (provisioning) => {
    let created;
    try {
      created = await createSite.run(ctx, { url: args.url }, { provisioning });
    } catch (err) {
      if (name && err instanceof CliError && err.reason === "dry_run") {
        throw new CliError(err.message, {
          exitCode: ExitCode.OK,
          reason: "dry_run",
          details: { ...err.details, then: { tool: setSiteName.name, arguments: { display_name: name } } },
        });
      }
      throw err;
    }

    const data = created.data ?? {};
    const id = data.site;
    if (!id) throw failed("The site was created but no id came back. `nxis sites list` shows it.", "no_site_id");
    const host = hostOf(data.domain ?? args.url) ?? args.url;
    saveActiveSite({ id, orgId, domain: host });

    let displayName: string | undefined;
    if (name) {
      try {
        const named = await setSiteName.run(ctx, { site: id, display_name: name }, { provisioning });
        displayName = named.data?.display_name ?? name;
      } catch (err) {
        const cause = err instanceof CliError ? err : null;
        throw new CliError(
          `Created ${host} (${id}) and made it current, but naming it failed: ${cause?.message ?? String(err)} ` +
            "Try again with `nxis sites name <name>`.",
          {
            exitCode: cause?.exitCode ?? ExitCode.ERROR,
            reason: "site_name_failed",
            details: { ...(cause?.details ?? {}), site: id, domain: host, cause: cause?.reason ?? "error" },
          },
        );
      }
    }

    ctx.io.emit(
      {
        ok: true,
        ...data,
        site: id,
        org_id: orgId,
        domain: host,
        ...(displayName !== undefined ? { display_name: displayName } : {}),
        current: true,
        warning: HOST_FIXED,
      },
      () =>
        [
          `Created ${bold(displayName ?? host)} (${id}) and made it the current site.`,
          dim(HOST_FIXED),
          `Next: \`nxis sites verify --token\` for the tag to deploy (step 2).`,
        ].join("\n"),
    );
  });
}

// ── list and use ────────────────────────────────────────────────────────────

/** @returns Whether a site is the one `--site` or the saved site names. */
function isCurrent(site: SiteSummary, current: string | null): boolean {
  if (!current) return false;
  if (site.site === current) return true;
  return !!site.host && site.host === hostOf(current);
}

/**
 * Runs `nxis sites list`.
 *
 * @remarks
 * Every field `nxis_list_sites` reports is passed through under `--json`, with `current` added to
 * the one the other commands act on, so a script can pick a site without a second call.
 */
export async function cmdSitesList(ctx: Ctx): Promise<void> {
  const out = await listSites.run(ctx, { limit: 500 });
  const data = out.data ?? {};
  const current = currentSite(ctx);
  const sites = (data.sites ?? []).map((s) => ({ ...s, current: isCurrent(s, current) }));
  const currentId = sites.find((s) => s.current)?.site ?? null;

  ctx.io.emit(
    {
      ok: true,
      organization: data.organization ?? requireOrg(ctx),
      count: data.count ?? sites.length,
      truncated: data.truncated ?? false,
      current: currentId,
      sites,
    },
    () => {
      if (sites.length === 0) return "No sites yet. Run `nxis sites create <url>`.";
      const lines = sites.map((s) => {
        const host = said(s.host ?? s.domain, "(no domain)");
        const name = said(s.display_name);
        const state = s.is_verified ? "verified" : "not verified";
        return `${s.current ? "*" : " "} ${host.padEnd(32)} ${name.padEnd(24)} ${state.padEnd(13)} ${s.site ?? ""}`;
      });
      if (data.truncated) lines.push(dim("More sites exist than were listed."));
      return lines.join("\n");
    },
  );
}

/**
 * Runs `nxis sites use <id|domain>`.
 *
 * @remarks
 * The site is looked up in the organization even when an id is given, so a typo fails here
 * rather than on the next command. A domain matches a site's host exactly first; only when no
 * site has that host is a leading `www.` ignored, and the output says so (`match: "www"`), since
 * www and the apex are separate sites and the user may have meant to create the other one. More
 * than one match is `site_ambiguous` (exit 2), listing the candidates; nothing is saved.
 *
 * @throws CliError `site_not_found` or `site_ambiguous` (exit 2).
 */
export async function cmdSitesUse(ctx: Ctx, value: string): Promise<void> {
  const orgId = requireOrg(ctx);
  const out = await listSites.run(ctx, { limit: 500 });
  const { site, match } = matchSite(out.data?.sites ?? [], value);
  const id = site.site as string;
  const host = site.host ?? hostOf(site.domain ?? "") ?? undefined;
  saveActiveSite({ id, orgId, ...(host ? { domain: host } : {}) });

  const typed = hostOf(value);
  ctx.io.emit(
    {
      ok: true,
      site: id,
      org_id: orgId,
      domain: host ?? null,
      display_name: site.display_name ?? null,
      is_verified: site.is_verified ?? false,
      match,
    },
    () =>
      [
        `Now using ${bold(said(site.display_name) || host || id)} (${id}).`,
        ...(match === "www"
          ? [dim(`No site has the host ${typed}; using ${host}, which differs only by www.`)]
          : []),
      ].join("\n"),
  );
}

// ── verify ──────────────────────────────────────────────────────────────────

/** The parts of a META tag a script needs to write it into a template. */
function metaParts(tag: string | undefined): { name: string | null; content: string | null } {
  const attr = (key: string) => tag?.match(new RegExp(`\\b${key}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1] ?? null;
  return { name: attr("name"), content: attr("content") };
}

/** @returns The verifier's own reason from a failed check's note, or the whole note. */
function verifierReason(note: string): string {
  const at = note.indexOf("Reported reason:");
  return at === -1 ? note : note.slice(at + "Reported reason:".length).trim();
}

/**
 * Runs `nxis sites verify --token` (step 2) or `nxis sites verify --check` (step 3).
 *
 * @remarks
 * `--token` prints the META tag alone on stdout, so `nxis sites verify --token > tag.html` works;
 * `--json` returns it as `tag` with its `name` and `content` attributes split out, for a script
 * that writes the value into a template rather than pasting the tag. It only reads, so it runs
 * under `--dry-run` too.
 *
 * `--check` exits 0 when verified. When not, it exits 2, needs you, with `site_not_verified` and
 * the verifier's reason: the next step is a deploy, which only the user can do, and that is what
 * exit 2 means everywhere in this CLI. It is not exit 1, because a failed check is almost always a
 * deploy that has not landed yet, and an agent should wait and check again rather than treat it
 * as broken. A site the verifier could not reach (an unknown host, a refused connection, a TLS
 * failure) is exit 2 too, as `site_unreachable`: that is also the user's to fix, by deploying the
 * site at its address, but waiting for a deploy to land will not help. A check marks the site
 * verified when it passes, so `--dry-run` withholds it.
 *
 * @throws CliError `site_not_verified` (exit 2) from `--check` when the tag was not found;
 * `site_unreachable` (exit 2) when the site could not be fetched;
 * `dry_run` (exit 0) for `--check` under `--dry-run`.
 */
export async function cmdSitesVerify(ctx: Ctx, args: { mode: "token" | "check" }): Promise<void> {
  await onSite(ctx, async (provisioning, site) => {
    const out = await verifySite.run(ctx, { mode: args.mode, site }, { provisioning });
    const data = out.data ?? {};

    if (args.mode === "token") {
      const tag = data.meta_tag;
      if (!tag) throw failed("The verifier returned no META tag.", "no_meta_tag", { site });
      const { name, content } = metaParts(tag);
      ctx.io.note(dim("Add this to the site's HTML <head>, deploy it to production, then run `nxis sites verify --check`."));
      ctx.io.note(dim(PREVIEW_NEVER_VERIFIES));
      ctx.io.emit({ ok: true, site, tag, name, content, next: said(data.next) || null }, () => tag);
      return;
    }

    if (data.verified !== true && data.reason === "site_unreachable") {
      const note = said(data.note, "The site could not be reached.");
      const reason = verifierReason(note);
      const url = said(data.url) || null;
      throw needsUser(
        `Could not reach ${url ?? "the site"} to look for the tag: ${reason} Check that the site is deployed ` +
          "at that address and publicly reachable, then run `nxis sites verify --check` again.",
        "site_unreachable",
        { site, verified: false, url, verifier_reason: reason, note },
      );
    }

    if (data.verified !== true) {
      const note = said(data.note, "The tag was not found on the live site.");
      const reason = verifierReason(note);
      throw needsUser(
        `Not verified yet: ${reason} This usually means the deploy has not landed; wait for it and check ` +
          `again. ${PREVIEW_NEVER_VERIFIES}`,
        "site_not_verified",
        { site, verified: false, verifier_reason: reason, note },
      );
    }

    ctx.io.emit(
      { ok: true, site, verified: true, url: data.url ?? null },
      () => `Verified${data.url ? ` ${said(data.url)}` : ""}. Next: crawl the sitemap (step 4).`,
    );
  });
}

// ── site tag ────────────────────────────────────────────────────────────────

/** Arguments for `nxis sites tag`. */
export interface SitesTagArgs {
  mode: "status" | "issue";
  /** `issue` only: hosts the tag may run on, beside the site's own. */
  domains?: string[];
  /** `issue` only: `browser`, `ssr` or `none`. */
  webmcpMode?: string;
}

/**
 * Runs `nxis sites tag [status|issue]`: the site tag, the step after onboarding.
 *
 * @remarks
 * Scoped to what `nxis_site_tag` does: `status` reads the current token and its claims, `issue`
 * signs one. Installing it on the site's pages is the Site Tag Installation skill's job, not a
 * command's. The tag is issued only for a verified site; the tool reports a refusal as data
 * (`issued: false`, `reason: site_not_verified`), which is exit 2 here, because the way forward is
 * `nxis sites verify`, not a retry.
 *
 * @throws CliError `invalid_input` (exit 1) for `--domain` or `--webmcp-mode` with `status`, or a
 * mode the tool does not take; `site_not_verified` (exit 2) when `issue` is refused; `dry_run`
 * (exit 0) for `issue` under `--dry-run`.
 */
export async function cmdSitesTag(ctx: Ctx, args: SitesTagArgs): Promise<void> {
  const domains = args.domains ?? [];
  if (args.mode === "status" && (domains.length > 0 || args.webmcpMode !== undefined)) {
    throw failed(`--domain and --webmcp-mode are for \`nxis sites tag issue\`. ${USAGE.tag}`, "invalid_input");
  }
  await onSite(ctx, async (provisioning, site) => {
    const input = {
      mode: args.mode,
      site,
      ...(domains.length > 0 ? { domains } : {}),
      ...(args.webmcpMode !== undefined ? { webmcp_mode: args.webmcpMode } : {}),
    } as Parameters<typeof siteTag.run>[1];
    const out = await siteTag.run(ctx, input, { provisioning });
    const data: SiteTagResult = out.data ?? {};

    if (args.mode === "issue" && data.issued === false) {
      throw needsUser(
        `${said(data.next, "The site tag is issued only for a verified site.")} Run \`nxis sites verify --check\` first.`,
        data.reason ?? "site_not_verified",
        { site, issued: false, next: said(data.next) || null },
      );
    }

    ctx.io.emit({ ok: true, ...data, site }, () => {
      if (data.exists === false && !data.script_tag) return said(data.next, "This site has no site tag yet.");
      const claims = data.claims ?? {};
      return [
        ...(data.script_tag ? [said(data.script_tag)] : []),
        dim(
          [
            claims.domains?.length ? `hosts ${claims.domains.map((d) => plainText(d)).join(", ")}` : null,
            claims.webmcp_mode ? `WebMCP ${plainText(claims.webmcp_mode)}` : null,
            claims.expires_at ? `expires ${plainText(claims.expires_at)}` : null,
          ]
            .filter(Boolean)
            .join(" · "),
        ),
        ...notes(data.next).map((n) => dim(n)),
      ]
        .filter((line) => line.length > 0)
        .join("\n");
    });
  });
}

// ── name and app listing ────────────────────────────────────────────────────

/**
 * Runs `nxis sites name <name>`: step 9's naming, before listing in the app.
 *
 * @throws CliError `dry_run` (exit 0) under `--dry-run`.
 */
export async function cmdSitesName(ctx: Ctx, name: string): Promise<void> {
  const displayName = name.trim();
  await onSite(ctx, async (provisioning, site) => {
    const out = await setSiteName.run(ctx, { site, display_name: displayName }, { provisioning });
    const data = out.data ?? {};
    const shown = data.display_name ?? displayName;
    ctx.io.emit({ ok: true, ...data, site, display_name: shown }, () => `Named the site ${bold(said(shown))}.`);
  });
}

/** Arguments for `nxis sites list-in-app`. */
export interface SitesListInAppArgs {
  /** Report how the app would list it, and change nothing. */
  preview?: boolean;
  /** Remove it from the app. */
  off?: boolean;
}

/** @returns How the app would show the site, as lines for a person. */
function describeListing(data: ListInAppResult): string[] {
  const l = data.as_listed ?? {};
  const join = (xs: string[] | undefined) => (xs?.length ? xs.map((x) => plainText(x)).join(", ") : "none");
  return [
    `  Title         ${said(l.title, "(none)")}`,
    ...(l.description ? [`  Description   ${said(l.description)}`] : []),
    `  Categories    ${join(l.verticals)}`,
    `  Places        ${join(l.places)}`,
    `  Capabilities  ${join(l.capabilities)}`,
    `  Visible to    ${l.public ? "anyone (public MCP server)" : "people signed in to the app"}`,
    `  Discovery     ${l.discovery_files_link_card ? "files link the server" : "files do not link the server yet"}`,
  ];
}

/**
 * Runs `nxis sites list-in-app [--preview] [--off]`: step 9 of the onboarding.
 *
 * @remarks
 * Listing puts the site in front of everyone who uses the NxisAI app, so the skill previews it
 * first: `--preview` passes `preview: true`, changes nothing, and so still runs under
 * `--dry-run`. `--off` passes `listed: false`. The two together are refused rather than guessed
 * at. The server's `next` notes, what still stands between the site and people using it, are
 * printed and returned as they are.
 *
 * @throws CliError `invalid_input` (exit 1) for `--preview` with `--off`; `dry_run` (exit 0) for a
 * listing change under `--dry-run`.
 */
export async function cmdSitesListInApp(ctx: Ctx, args: SitesListInAppArgs): Promise<void> {
  if (args.preview && args.off) {
    throw failed(`Pass --preview or --off, not both. ${USAGE.listInApp}`, "invalid_input");
  }
  await onSite(ctx, async (provisioning, site) => {
    const input = args.preview ? { site, preview: true } : args.off ? { site, listed: false } : { site };
    const out = await listInApp.run(ctx, input, { provisioning });
    const data = out.data ?? {};
    ctx.io.emit({ ok: true, ...data, site, preview: args.preview === true }, () => {
      const head = args.preview
        ? "How the NxisAI app would list it (nothing changed):"
        : data.listed_in_app === false
          ? "Removed from the NxisAI app."
          : "Listed in the NxisAI app. It appears within a few minutes:";
      return [
        head,
        ...(args.off ? [] : describeListing(data)),
        ...notes(data.next).map((n) => `- ${n}`),
      ].join("\n");
    });
  });
}
