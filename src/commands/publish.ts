/**
 * `nxis publish`: make the site's generated structured data live.
 *
 * @remarks
 * Autofill writes drafts, and a draft is stored but not served: `nxis_list_types` does not list
 * it and `nxis_query` does not return it. Publishing is what makes the data answer, and it changes
 * what the site serves publicly, so it asks first, the way `autofill submit` does: it counts what
 * would publish (the same read-only dry run as `--dry-run`), shows the count, and asks. `--yes`
 * says the caller already put that to the user; without it and without a terminal, it stops with
 * exit 2 `confirmation_required` and the count. When the count is zero it asks nothing and
 * publishes nothing.
 *
 * `--dry-run` counts what would publish. That is the tool's own dry run, which reads and writes
 * nothing, so unlike other commands' dry runs it does call the server: the global `--dry-run`
 * still withholds every write, and this call is not one. Like every dry run it also traces the
 * request on stderr.
 */

import { bool, str, type Parsed } from "../args.js";
import type { Ctx } from "../context.js";
import { bold, dim } from "../output.js";
import { confirmOrStop, terminalAsker, type Asker } from "../prompt.js";
import { isDryRun } from "../trace.js";
import { publishEntities, type PublishEntitiesResult } from "../tools/provisioning.js";
import { orNull, withSiteSession, type SiteSession } from "./data-shared.js";

/** Arguments for `nxis publish`. */
export interface PublishArgs {
  /** Only this schema.org type, e.g. `Product`. Every type when absent. */
  schemaType?: string;
  /** Count what would publish, and change nothing. Defaults to the global `--dry-run`. */
  dryRun?: boolean;
  /** The user already agreed: publish without counting or asking. */
  yes?: boolean;
  /** How to ask for a yes. The terminal, outside tests. */
  asker?: Asker;
}

/** A publish, or a count of one, as `--json` reports it. Every key is always present. */
function publishShape(s: SiteSession, args: PublishArgs, dryRun: boolean, data: PublishEntitiesResult) {
  return {
    site: s.siteId,
    host: s.host,
    dry_run: data.dry_run ?? dryRun,
    schema_type: data.schema_type ?? args.schemaType ?? null,
    published_count: data.published_count ?? 0,
    already_published_count: data.already_published_count ?? 0,
    skipped_disabled_count: data.skipped_disabled_count ?? 0,
    note: orNull(data.note),
  };
}

/** @returns "Product records", "record". */
function noun(n: number, schemaType: string | null): string {
  return `${schemaType ? `${schemaType} record` : "record"}${n === 1 ? "" : "s"}`;
}

/** @returns "3 Product records", "1 record". */
function records(n: number, schemaType: string | null): string {
  return `${n.toLocaleString("en-US")} ${noun(n, schemaType)}`;
}

/**
 * Runs `nxis publish [--dry-run] [--type <schema-type>] [--yes]`.
 *
 * @throws CliError as the tool and site lookup do; `confirmation_required` (exit 2, with the count
 * in `preview`) without a terminal or `--yes`; `cancelled` (exit 2) on anything but a yes. A dry
 * run with no provisioning key yet reports `dry_run` (exit 0) without counting, since issuing the
 * key is a write.
 */
export async function cmdPublish(ctx: Ctx, args: PublishArgs = {}): Promise<void> {
  const dryRun = args.dryRun ?? isDryRun();
  await withSiteSession(ctx, async (s) => {
    const call = async (dry: boolean) => {
      const out = await publishEntities.run(
        ctx,
        {
          site: s.siteId,
          ...(args.schemaType ? { schema_type: args.schemaType } : {}),
          ...(dry ? { dry_run: true } : {}),
        },
        { provisioning: s.provisioning },
      );
      return publishShape(s, args, dry, out.data ?? {});
    };

    let result: ReturnType<typeof publishShape>;
    if (dryRun || args.yes) {
      result = await call(dryRun);
    } else {
      // Count first, with the same read-only dry run as --dry-run, then ask.
      const preview = await call(true);
      if (preview.published_count === 0) {
        result = { ...preview, dry_run: false };
      } else {
        const already = preview.already_published_count
          ? ` ${preview.already_published_count.toLocaleString("en-US")} already live.`
          : "";
        await confirmOrStop(args.asker ?? terminalAsker, {
          summary: `${bold("Publish structured data")}
  ${records(preview.published_count, preview.schema_type)} ` +
            `would go live on ${s.host}.${already}` +
            (preview.note ? `\n  ${dim(preview.note)}` : ""),
          needsYes: "This changes what the site serves publicly, so it needs a yes. Show the user the count, " +
            "then run again with --yes.",
          question: `Publish ${records(preview.published_count, preview.schema_type)} on ${s.host}?`,
          cancelled: "Cancelled. Nothing was published.",
          details: { published_count: preview.published_count, preview },
        });
        result = await call(false);
      }
    }

    const n = result.published_count;
    ctx.io.emit({ ok: true, ...result }, () => {
      const already = result.already_published_count ? dim(` (${result.already_published_count} already live)`) : "";
      if (result.dry_run) {
        return `${bold(String(n))} ${noun(n, result.schema_type)} would publish on ${s.host}${already}. ` +
          "Nothing changed; `nxis publish` publishes them.";
      }
      if (n === 0 && result.already_published_count === 0) {
        return "Nothing to publish. If autofill just ran, check it finished and produced records: " +
          "`nxis autofill status`.";
      }
      if (n === 0) return `Nothing new to publish on ${s.host}${already}.`;
      return `${bold("Published")} ${records(n, result.schema_type)} on ${s.host}${already}. They are live.`;
    });
  });
}

/** Dispatches `nxis publish`. */
export async function publish(ctx: Ctx, _positional: string[], flags: Parsed["flags"]): Promise<void> {
  const schemaType = str(flags, "type");
  await cmdPublish(ctx, { ...(schemaType ? { schemaType } : {}), yes: bool(flags, "yes") });
}
