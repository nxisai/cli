/**
 * `nxis autofill plan`, `submit` and `status`: generate structured data for the crawled pages.
 *
 * @remarks
 * This is the step that spends credits, and the rules that follow from that are deliberate:
 *
 *   • `plan` before `submit`. `submit` plans first itself, and asks for a yes showing the count
 *     and the mode. `--yes` says the caller already put that question to the user; without it and
 *     without a terminal, `submit` stops with exit 2 and the plan.
 *   • No estimated total. The price per generated page varies, so the plan shows the count and the
 *     balance, and the fixed per-page price only for a pure `import`.
 *   • Submit once. `submit` is a billed write with no idempotency key. When it does not answer in
 *     time, it may still have started a batch, so the CLI never sends it again: it lists the site's
 *     latest batches, once, and reports one that started after the submit was sent as the batch it
 *     started. `started: false` means a batch was already running, and nothing new was charged.
 *   • `PAUSED` means credits ran out. It is reported (exit 2, with how to buy credits) and never
 *     resumed: resubmitting would duplicate the work and stall again.
 *
 * The default `--existing` is `import_and_complete`: bring in the JSON-LD each page already
 * publishes, and generate only what it lacks.
 */

import { bool, num, str, type Parsed } from "../args.js";
import type { Ctx } from "../context.js";
import { CliError, failed, needsUser } from "../errors.js";
import { rememberJobs, siteJobs } from "../jobs.js";
import { bold, dim, formatCredits } from "../output.js";
import { confirmOrStop, terminalAsker, type Asker } from "../prompt.js";
import { isDryRun } from "../trace.js";
import { guideOf, noGuide, refused } from "../guide.js";
import { chooseScope, siteClusters } from "../guided/scope.js";
import { checkCredits, readBalanceMilli } from "../guided/credits.js";
import { bulkAutofill, type BulkAutofillResult, type RecentBatch } from "../tools/provisioning.js";
import { minutes, orNull, POLL_INTERVAL_MS, waitFor, withSiteSession, type SiteSession } from "./data-shared.js";

/** What to do with structured data a page already publishes. */
export type Existing = "import_and_complete" | "import" | "generate";

/** The default `--existing`: import what pages publish, generate what they lack. */
export const DEFAULT_EXISTING: Existing = "import_and_complete";

/**
 * How long `submit` waits for an answer.
 *
 * @remarks
 * Longer than other calls, because a timeout here leaves it unknown whether a batch started, and
 * that is the one outcome this command cannot resolve by itself.
 */
export const SUBMIT_TIMEOUT_MS = 120_000;

/**
 * How much earlier than the lost submit a batch may have started and still be taken as the one it
 * started.
 *
 * @remarks
 * `started_at` is the server's clock and the time the submit was sent is this machine's, so a
 * batch the submit started can look a little older than the submit when the clocks disagree.
 */
export const LOST_SUBMIT_SKEW_MS = 60_000;

/** How long `--wait` waits for a batch by default, in minutes. */
const DEFAULT_WAIT_MINUTES = 60;

/** What a person types for `--existing`, explained. */
const EXISTING_MEANS: Record<Existing, string> = {
  import_and_complete: "import each page's own structured data, generate only what it lacks",
  import: "import each page's own structured data, no AI, at a fixed price per page",
  generate: "generate all structured data with AI",
};

/** The scope of a batch: which pages, and what to do with their existing data. */
export interface AutofillScope {
  existing?: Existing;
  mediaType?: string;
  pattern?: string;
}

/** Arguments for `nxis autofill submit`. */
export interface AutofillSubmitArgs extends AutofillScope {
  yes?: boolean;
  wait?: boolean;
  timeoutMinutes?: number;
  intervalMs?: number;
  /** How to ask for a yes. The terminal, outside tests. */
  asker?: Asker;
  /** How long the submit may take. {@link SUBMIT_TIMEOUT_MS}, outside tests. */
  submitTimeoutMs?: number;
}

/** Arguments for `nxis autofill status`. */
export interface AutofillStatusArgs {
  batchId?: string;
  /** List the site's latest batches instead of following one. */
  recent?: boolean;
  wait?: boolean;
  timeoutMinutes?: number;
  intervalMs?: number;
}

/** @returns The tool's scope arguments, with the media type in the upper case the server matches. */
function scopeArgs(scope: AutofillScope) {
  return {
    existing: scope.existing ?? DEFAULT_EXISTING,
    ...(scope.mediaType ? { media_type: scope.mediaType.trim().toUpperCase() as "HTML" } : {}),
    ...(scope.pattern ? { pattern: scope.pattern } : {}),
  };
}

/** A plan, as `--json` reports it. Every key is always present. */
export function planShape(s: Pick<SiteSession, "siteId" | "host">, scope: AutofillScope, data: BulkAutofillResult) {
  const sent = scopeArgs(scope);
  const mediaType = data.media_type ?? sent.media_type ?? null;
  const pattern = data.pattern ?? sent.pattern ?? null;
  const resourceCount = orNull(data.resource_count);
  const patternCount = orNull(data.pattern_count);
  // What the batch would cover: the media type's count, else the pattern's, else the site's. With
  // both, the batch covers their intersection, which the plan cannot count: at most the smaller.
  let planned: number | null;
  if (mediaType && pattern) planned = patternCount === null ? null : Math.min(resourceCount ?? 0, patternCount);
  else if (pattern) planned = patternCount;
  else planned = resourceCount;
  return {
    site: s.siteId,
    host: s.host,
    existing: data.existing ?? sent.existing,
    media_type: mediaType,
    pattern,
    planned_count: planned,
    planned_count_is_upper_bound: Boolean(mediaType && pattern),
    resource_count: resourceCount,
    pattern_count: patternCount,
    site_total: orNull(data.site_total),
    by_media: (data.by_media ?? []).map((b) => ({ media_type: b.media_type ?? null, count: b.count ?? 0 })),
    credits_remaining: orNull(data.credits_remaining),
    credit_limit: orNull(data.credit_limit),
    credits_used_this_month: orNull(data.credits_used_this_month),
    import_cost_per_resource_milli: orNull(data.import_cost_per_resource_milli),
    quota_exceeded: data.quota_exceeded ?? false,
    note: orNull(data.note),
  };
}

type Plan = ReturnType<typeof planShape>;

/** A batch's status, as `--json` reports it. Every key is always present. */
function statusShape(s: SiteSession, batchId: string, data: BulkAutofillResult) {
  return {
    site: s.siteId,
    host: s.host,
    batch_id: data.batch_id ?? batchId,
    found: data.found ?? true,
    status: orNull(data.status),
    terminal: data.terminal ?? false,
    total: orNull(data.total),
    done: orNull(data.done),
    failed: orNull(data.failed),
    note: orNull(data.note),
  };
}

type Status = ReturnType<typeof statusShape>;

/** One of the site's latest batches, as `--json` reports it. Every key is always present. */
function recentShape(b: RecentBatch) {
  return {
    batch_id: orNull(b.batch_id),
    status: orNull(b.status),
    terminal: b.terminal ?? false,
    total: orNull(b.total),
    done: orNull(b.done),
    failed: orNull(b.failed),
    started_at: orNull(b.started_at),
  };
}

type Recent = ReturnType<typeof recentShape>;

/** @returns When the batch started, in epoch milliseconds, or null when it has not or it cannot be read. */
function startedMs(b: Recent): number | null {
  if (!b.started_at) return null;
  const ms = Date.parse(b.started_at);
  return Number.isNaN(ms) ? null : ms;
}

/** @returns The scope in words: "all resources", "HTML", "/products/*", "HTML · /products/*". */
function scopeLabel(plan: Plan): string {
  return [plan.media_type, plan.pattern].filter(Boolean).join(" · ") || "all resources";
}

/**
 * @returns What the batch would cost, in milli-credits: only for a pure import, whose price per
 * page is fixed; null otherwise.
 */
export function estimateMilli(plan: Plan): number | null {
  if (plan.import_cost_per_resource_milli === null || plan.planned_count === null) return null;
  return plan.import_cost_per_resource_milli * plan.planned_count;
}

/**
 * @returns The plan in lines, for a person.
 *
 * @param balanceMilli - The organization's real credit balance, as `nxis credits` reads it. Shown
 * in place of the plan's own `credits_remaining` when known.
 */
export function planLines(plan: Plan, balanceMilli: number | null = null): string[] {
  const n = (v: number | null) => (v === null ? "unknown" : v.toLocaleString("en-US"));
  const breakdown = plan.by_media
    .filter((b) => b.count > 0)
    .map((b) => `${b.media_type ?? "?"} ${n(b.count)}`)
    .join(", ");
  const lines = [
    `  Site       ${plan.host}`,
    `  Mode       ${plan.existing} (${EXISTING_MEANS[plan.existing as Existing] ?? plan.existing})`,
    `  Scope      ${scopeLabel(plan)}`,
    `  Resources  ${bold(n(plan.planned_count))}${plan.planned_count_is_upper_bound ? " at most" : ""}` +
      (plan.site_total !== null && plan.planned_count !== plan.site_total ? ` of ${n(plan.site_total)}` : "") +
      (breakdown ? dim(`  (site: ${breakdown})`) : ""),
    balanceMilli !== null
      ? `  Credits    ${bold(formatCredits(balanceMilli))} balance`
      : `  Credits    ${bold(n(plan.credits_remaining))} remaining`,
  ];
  if (plan.import_cost_per_resource_milli !== null) {
    lines.push(`  Price      ${formatCredits(plan.import_cost_per_resource_milli)} per page, fixed`);
    const estimate = estimateMilli(plan);
    if (estimate !== null) lines.push(`  Estimate   ${formatCredits(estimate)}`);
  } else {
    lines.push(`  Price      varies per page, so no total is estimated`);
  }
  if (plan.note) lines.push(dim(`  ${plan.note}`));
  if (plan.quota_exceeded) lines.push(`  ${bold("The credit balance is used up.")} Buy more: \`nxis credits packs\`.`);
  return lines;
}

/** @returns The flags that reproduce this scope, for the next command to suggest. */
function scopeFlags(plan: Plan): string {
  return [
    plan.existing !== DEFAULT_EXISTING ? `--existing ${plan.existing}` : "",
    plan.media_type ? `--media-type ${plan.media_type}` : "",
    plan.pattern ? `--pattern '${plan.pattern}'` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

async function readPlan(ctx: Ctx, s: SiteSession, scope: AutofillScope): Promise<Plan> {
  const out = await bulkAutofill.run(
    ctx,
    { mode: "plan", site: s.siteId, ...scopeArgs(scope) },
    { provisioning: s.provisioning },
  );
  return planShape(s, scope, out.data ?? {});
}

/**
 * The site's latest batches, newest first: `status` with no `batch_id`. A read.
 *
 * @returns The batches, or null when the server answered without a list, as one that requires a
 * `batch_id` does.
 * @throws CliError whatever the call throws, including the `tool_error` of such a server.
 */
async function readRecent(ctx: Ctx, s: SiteSession): Promise<Recent[] | null> {
  const out = await bulkAutofill.run(ctx, { mode: "status", site: s.siteId }, { provisioning: s.provisioning });
  const batches = out.data?.batches;
  if (!Array.isArray(batches)) return null;
  // Newest first, as the server sends them; sorted again so the order never depends on that.
  const recent = batches.map(recentShape);
  return recent.sort((a, b) => (startedMs(b) ?? -Infinity) - (startedMs(a) ?? -Infinity));
}

async function readStatus(ctx: Ctx, s: SiteSession, batchId: string): Promise<Status> {
  const out = await bulkAutofill.run(
    ctx,
    { mode: "status", batch_id: batchId, site: s.siteId },
    { provisioning: s.provisioning },
  );
  return statusShape(s, batchId, out.data ?? {});
}

/**
 * Runs `nxis autofill plan`. Changes nothing.
 */
export async function cmdAutofillPlan(ctx: Ctx, scope: AutofillScope = {}): Promise<void> {
  await withSiteSession(ctx, async (s) => {
    const plan = await readPlan(ctx, s, scope);
    // The balance `nxis credits` reads; the plan's own `credits_remaining` can overstate it.
    const balance = await readBalanceMilli(ctx, s.orgId);
    ctx.io.emit({ ok: true, ...plan, balance_milli: balance }, () => {
      const flags = scopeFlags(plan);
      return [
        bold("Structured data plan"),
        ...planLines(plan, balance),
        "",
        `Narrow it with --media-type HTML|IMAGE|VIDEO|AUDIO or --pattern '/products/*', then run`,
        `\`nxis autofill submit${flags ? ` ${flags}` : ""}\`. It spends credits and asks first.`,
      ].join("\n");
    });
  });
}

/**
 * Whether a failed submit may still have reached the server and started a batch.
 *
 * @remarks
 * A timeout, a dropped connection or a gateway error leaves that unknown. A tool error, a refused
 * key or a bad argument is the server answering, so nothing started.
 */
function maybeLanded(err: unknown): boolean {
  if (!(err instanceof CliError)) return true;
  if (err.reason === "timeout" || err.reason === "network" || err.reason === "error") return true;
  return err.reason === "request_failed" && Number(err.details["status"] ?? 0) >= 500;
}

/**
 * Runs `nxis autofill submit`. Spends credits.
 *
 * @remarks
 * Plans first, refuses what would start nothing useful (no resources, a scope the plan cannot
 * count), then reads the organization's real balance: used up, or short of a known estimate, a
 * terminal offers the credit packs (and waits for the payment) before anything else; without one,
 * a used-up balance stops with `credits_exhausted`. Then it asks for a yes, and calls `submit`
 * exactly once.
 *
 * @throws CliError `confirmation_required` (exit 2, with the plan) without a terminal or `--yes`;
 * `cancelled` (exit 2) on anything but a yes; `nothing_planned`, `scope_not_counted` or
 * `credits_exhausted` (exit 2) before asking; `submit_unconfirmed` (exit 2) when the submit did not
 * answer; `dry_run` (exit 0, with the plan) under `--dry-run`; and the status errors under `--wait`.
 */
export async function cmdAutofillSubmit(ctx: Ctx, args: AutofillSubmitArgs = {}): Promise<void> {
  await withSiteSession(ctx, async (s) => {
    const guide = args.yes ? noGuide("terminal") : guideOf(ctx);
    let scope: AutofillScope = args;
    let plan = await readPlan(ctx, s, scope);
    // No scope given: a terminal offers the site's path clusters, with counts, beside all pages.
    if (!isDryRun() && guide.interactive && !args.pattern && !args.mediaType) {
      const found = await siteClusters(ctx, s.orgId, s.siteId);
      const picked = await chooseScope(
        guide,
        { host: s.host, allCount: plan.planned_count, perPageMilli: plan.import_cost_per_resource_milli },
        found,
      );
      if (!picked.ok) throw refused(guide, picked.why, "Cancelled. Nothing was submitted.", { plan });
      if (picked.value) {
        scope = { ...args, pattern: picked.value };
        plan = await readPlan(ctx, s, scope);
      }
    }
    refuseUnplannable(plan);
    // The real balance, not the plan's: short or used up, the packs are offered before anything is asked.
    const credits = isDryRun()
      ? { balanceMilli: null }
      : await checkCredits(ctx, guide, {
          orgId: s.orgId,
          host: s.host,
          estimateMilli: estimateMilli(plan),
          planQuotaExceeded: plan.quota_exceeded,
          ...(args.timeoutMinutes !== undefined ? { timeoutMinutes: args.timeoutMinutes } : {}),
          details: { plan },
        });
    await confirmSpend(ctx, plan, args, credits.balanceMilli);

    const sent = { mode: "submit" as const, site: s.siteId, ...scopeArgs(scope) };
    const sentAt = Date.now();
    let data: BulkAutofillResult;
    try {
      const out = await bulkAutofill.run(ctx, sent, {
        provisioning: s.provisioning,
        timeoutMs: args.submitTimeoutMs ?? SUBMIT_TIMEOUT_MS,
      });
      data = out.data ?? {};
    } catch (err) {
      if (err instanceof CliError && err.reason === "dry_run") {
        throw new CliError(err.message, { exitCode: err.exitCode, reason: err.reason, details: { ...err.details, plan } });
      }
      if (!maybeLanded(err)) throw err;
      // Never submitted again: report what can be found instead.
      throw await unconfirmed(ctx, s, plan, err, { sentAt, timeoutMs: args.submitTimeoutMs ?? SUBMIT_TIMEOUT_MS });
    }

    const batchId = data.batch_id ?? null;
    if (batchId) rememberBatch(ctx, s, plan, batchId);
    const started = data.started === true;
    const result = {
      site: s.siteId,
      host: s.host,
      started,
      already_running: !started && batchId !== null,
      batch_id: batchId,
      job_count: orNull(data.job_count),
      resource_count: orNull(data.resource_count),
      existing: plan.existing,
      media_type: plan.media_type,
      pattern: plan.pattern,
      planned_count: plan.planned_count,
      status: orNull(data.status),
      note: orNull(data.note),
    };

    if (!started && !batchId) {
      throw failed("The submit started nothing and named no batch. Check `nxis autofill plan`.", "not_started", result);
    }
    if (result.already_running && result.status === "PAUSED") {
      // The batch blocking this one ran out of credits; it is the pause to report, not progress.
      throw needsUser(
        `Nothing new started: batch ${batchId} for ${s.host} is PAUSED, out of credits, and blocks a new one. ` +
          "Nothing was charged. Buy credits with `nxis credits packs` and `nxis credits buy <sku>`; the CLI does " +
          "not resume it. The pages it generated are drafts: `nxis publish` makes them live.",
        "autofill_paused",
        { ...result, buy_credits: "nxis credits packs" },
      );
    }
    if (!args.wait) {
      ctx.io.emit({ ok: true, ...result }, () =>
        result.already_running
          ? `A batch was already running for ${s.host} (${batchId}), so nothing new started and nothing was ` +
            "charged. Follow it with `nxis autofill status --wait`; do not submit again."
          : `${bold("Started")} batch ${batchId} for ${s.host}: ${result.resource_count ?? plan.planned_count ?? "?"} ` +
            "resources. Follow it with `nxis autofill status --wait`.",
      );
      return;
    }
    ctx.io.note(
      result.already_running
        ? `A batch was already running (${batchId}); nothing new was charged. Waiting for it…`
        : `Started batch ${batchId}. Waiting for it…`,
    );
    const batch = await waitForBatch(ctx, s, batchId as string, args, result);
    settleStatus(ctx, batch, { ...result, batch });
  });
}

/** Saves the batch as the site's last, for `autofill status` with no arguments. */
function rememberBatch(ctx: Ctx, s: SiteSession, plan: Plan, batchId: string): void {
  rememberJobs(ctx, s.orgId, s.siteId, {
    batch: {
      batch_id: batchId,
      at: Math.floor(Date.now() / 1000),
      existing: plan.existing,
      ...(plan.media_type ? { media_type: plan.media_type } : {}),
      ...(plan.pattern ? { pattern: plan.pattern } : {}),
    },
  });
}

/** Stops before asking when the submit could start nothing worth paying for. */
function refuseUnplannable(plan: Plan): void {
  if (plan.planned_count === null) {
    throw needsUser(
      `The plan has no count for the pattern ${plan.pattern}, so there is no number to approve. ` +
        "Use a path cluster the site has (e.g. /products/*), or leave --pattern out.",
      "scope_not_counted",
      { plan },
    );
  }
  if (plan.planned_count === 0) {
    throw needsUser(
      `The plan counts no resources for ${scopeLabel(plan)} on ${plan.host}. Has the crawl finished? ` +
        "`nxis crawl status` says.",
      "nothing_planned",
      { plan },
    );
  }
}

/** Asks for a yes, or stops when nobody can give one. A dry run sends nothing, so it does not ask. */
async function confirmSpend(ctx: Ctx, plan: Plan, args: AutofillSubmitArgs, balanceMilli: number | null): Promise<void> {
  if (args.yes || isDryRun()) return;
  const count = plan.planned_count?.toLocaleString("en-US") ?? "?";
  await confirmOrStop(args.asker ?? terminalAsker, {
    summary: [bold("Generate structured data"), ...planLines(plan, balanceMilli)].join("\n"),
    needsYes: "This spends credits, so it needs a yes. Show the user the plan, then run again with --yes.",
    question:
      `Submit ${count} resource${plan.planned_count === 1 ? "" : "s"} (${plan.existing}, ${scopeLabel(plan)})? ` +
      "This spends credits.",
    cancelled: "Cancelled. Nothing was submitted.",
    details: { plan, balance_milli: balanceMilli },
  });
}

/**
 * The report for a submit that did not answer. Always exit 2, and never a second submit.
 *
 * @remarks
 * The CLI lists the site's latest batches once (`status` with no `batch_id`, a read). The newest
 * one that started after the submit was sent, less {@link LOST_SUBMIT_SKEW_MS}, is the batch the
 * submit started: it is reported with its id and saved as the site's last batch, so
 * `autofill status` follows it. A site runs one batch at a time, and a submit while one runs
 * returns that one, so a batch that started in that window is the one this submit would have
 * named. A batch with no start time is not taken, since nothing says when it began.
 *
 * A server that cannot list batches refuses a `status` without a `batch_id`. Then, as before,
 * the CLI reads the last batch it saved for the site, which says whether that one is still
 * running (and so blocking a new one), and points to the dashboard.
 */
async function unconfirmed(
  ctx: Ctx,
  s: SiteSession,
  plan: Plan,
  err: unknown,
  sent: { sentAt: number; timeoutMs: number },
): Promise<CliError> {
  const cause = err instanceof CliError ? err.reason : "error";
  const lines = [
    cause === "timeout"
      ? `The submit did not answer within ${Math.round(sent.timeoutMs / 1000)}s.`
      : `The submit failed in a way that does not say whether it arrived (${(err as Error).message}).`,
  ];
  const report = (details: { batch: Recent | null; recent: Recent[] | null; last: Status | null }) =>
    needsUser(lines.join(" "), "submit_unconfirmed", {
      cause,
      plan,
      batch_id: details.batch?.batch_id ?? null,
      batch: details.batch,
      recent_batches: details.recent,
      last_batch: details.last,
    });

  const recent = await readRecent(ctx, s).catch(() => null);
  if (recent) {
    const since = sent.sentAt - LOST_SUBMIT_SKEW_MS;
    const batch = recent.find((b) => b.batch_id && (startedMs(b) ?? -Infinity) >= since) ?? null;
    if (batch) {
      rememberBatch(ctx, s, plan, batch.batch_id as string);
      lines.push(
        `Batch ${batch.batch_id} started at ${batch.started_at}, after the submit was sent, so it is the batch ` +
          `this submit started: ${batch.status ?? "status unknown"}, ${batch.done ?? 0} of ${batch.total ?? "?"} done. ` +
          "Follow it with `nxis autofill status --wait`. Do not submit again.",
      );
      return report({ batch, recent, last: null });
    }
    lines.push("No batch has started since it was sent, but it may still start. Do not submit again.");
    const running = recent.find((b) => b.batch_id && !b.terminal);
    if (running) {
      lines.push(
        `Batch ${running.batch_id}, started before this submit, is ${running.status}; while it runs, a submit ` +
          `starts nothing new. Follow it with \`nxis autofill status --batch ${running.batch_id} --wait\`.`,
      );
    } else {
      lines.push("In a minute, `nxis autofill status --recent` lists the site's latest batches again.");
    }
    return report({ batch: null, recent, last: null });
  }

  const last = siteJobs(ctx, s.orgId, s.siteId).batch?.batch_id ?? null;
  let lastStatus: Status | null = null;
  if (last) lastStatus = await readStatus(ctx, s, last).catch(() => null);
  lines.push("It may have started a batch, and been charged. Do not submit again.");
  if (lastStatus && !lastStatus.terminal && lastStatus.found) {
    lines.push(
      `The last batch the CLI started here, ${last}, is ${lastStatus.status}: follow it with ` +
        "`nxis autofill status --wait`.",
    );
  } else {
    lines.push(
      "The CLI has no id for a batch this submit started, because it did not answer. Check the site's " +
        "batches in the NxisAI dashboard, then follow one with `nxis autofill status --batch <id> --wait`.",
    );
  }
  return report({ batch: null, recent: null, last: lastStatus });
}

async function waitForBatch(
  ctx: Ctx,
  s: SiteSession,
  batchId: string,
  args: { timeoutMinutes?: number; intervalMs?: number },
  extra: Record<string, unknown> = {},
): Promise<Status> {
  const timeoutMs = minutes(args.timeoutMinutes, DEFAULT_WAIT_MINUTES);
  const { value, settled } = await waitFor({
    read: () => readStatus(ctx, s, batchId),
    // PAUSED is not terminal, but it will not move on its own, so waiting on it would never end.
    settled: (v) => v.terminal || !v.found || v.status === "PAUSED",
    intervalMs: args.intervalMs ?? POLL_INTERVAL_MS,
    timeoutMs,
    onWait: (v) => ctx.io.note(dim(`  ${v.status ?? "…"} ${v.done ?? 0} of ${v.total ?? "?"} done`)),
  });
  if (!settled) {
    throw needsUser(
      `Batch ${batchId} is still ${value.status ?? "running"} after ${Math.round(timeoutMs / 60_000)} minutes. ` +
        "It carries on in the background: `nxis autofill status --wait` picks it up.",
      "autofill_running",
      Object.keys(extra).length > 0 ? { ...extra, batch: value } : value,
    );
  }
  return value;
}

/**
 * Emits a batch's status, or stops for one that needs the user or failed.
 *
 * @remarks
 * `status` and `terminal` are read together. `PAUSED` is not terminal and not progress: credits
 * ran out, and it will not advance on its own. A `COMPLETE` batch with failures is a partial run,
 * not a failed one: the pages that finished are drafts waiting to be published.
 */
function settleStatus(ctx: Ctx, st: Status, payload: Record<string, unknown> = st): void {
  if (!st.found) {
    throw needsUser(`No batch ${st.batch_id} on ${st.host}.`, "batch_not_found", payload);
  }
  const progress = `${st.done ?? 0} of ${st.total ?? "?"} done${st.failed ? `, ${st.failed} failed` : ""}`;
  if (st.status === "PAUSED") {
    throw needsUser(
      `Batch ${st.batch_id} is PAUSED: the credits ran out partway (${progress}). It will not advance on its ` +
        "own, and the CLI does not resume it. Buy credits with `nxis credits packs` and `nxis credits buy <sku>`. " +
        "The pages already generated are drafts: `nxis publish` makes them live.",
      "autofill_paused",
      { ...payload, buy_credits: "nxis credits packs" },
    );
  }
  if (st.terminal && st.status === "FAILED") {
    throw failed(
      `Batch ${st.batch_id} FAILED (${progress}).${st.done ? " What it generated can still be published: `nxis publish`." : ""}`,
      "autofill_failed",
      payload,
    );
  }
  if (st.terminal && st.status === "CANCELLED") {
    throw failed(`Batch ${st.batch_id} was cancelled (${progress}).`, "autofill_cancelled", payload);
  }
  ctx.io.emit({ ok: true, ...payload }, () => {
    if (!st.terminal) {
      return `Batch ${st.batch_id}: ${bold(st.status ?? "RUNNING")}, ${progress}. \`nxis autofill status --wait\` waits for it.`;
    }
    const partial = st.failed
      ? ` ${st.failed} page${st.failed === 1 ? " was" : "s were"} refused, usually for a plan limit; the rest are drafts.`
      : "";
    return `${bold("Done:")} batch ${st.batch_id}, ${progress}.${partial} Next: \`nxis publish\` makes them live.`;
  });
}

/**
 * Runs `nxis autofill status`.
 *
 * @remarks
 * With `--recent`, or with no `--batch` and none saved, it lists the site's latest batches
 * instead of following one. A server that cannot list them leaves `no_batch` as the answer.
 *
 * @throws CliError `no_batch` (exit 2) with no `--batch`, none saved, and no batch on the site
 * (or a server that cannot list them); `batch_not_found` and `autofill_paused` (exit 2);
 * `autofill_failed` and `autofill_cancelled` (exit 1); `autofill_running` (exit 2) when `--wait`
 * runs out of time.
 */
export async function cmdAutofillStatus(ctx: Ctx, args: AutofillStatusArgs = {}): Promise<void> {
  await withSiteSession(ctx, async (s) => {
    const batchId = args.recent ? undefined : (args.batchId ?? siteJobs(ctx, s.orgId, s.siteId).batch?.batch_id);
    if (!batchId) {
      await listRecent(ctx, s);
      return;
    }
    const st = args.wait ? await waitForBatch(ctx, s, batchId, args) : await readStatus(ctx, s, batchId);
    settleStatus(ctx, st);
  });
}

/** Emits the site's latest batches, or stops with `no_batch` when there are none to show. */
async function listRecent(ctx: Ctx, s: SiteSession): Promise<void> {
  let recent: Recent[] | null;
  try {
    recent = await readRecent(ctx, s);
  } catch (err) {
    // The server answered, refusing a status without a batch_id: it cannot list batches.
    if (!(err instanceof CliError) || (err.reason !== "tool_error" && err.reason !== "mcp_error")) throw err;
    recent = null;
  }
  if (!recent || recent.length === 0) {
    throw needsUser(
      `${recent ? `${s.host} has no batches.` : `The CLI has started no batch for ${s.host}.`} Pass one with ` +
        "--batch <id>, or start one with `nxis autofill plan`, then `nxis autofill submit`.",
      "no_batch",
      { site: s.siteId, host: s.host },
    );
  }
  const batches = recent;
  ctx.io.emit({ ok: true, site: s.siteId, host: s.host, batches }, () => {
    const lines = batches.map((b) => {
      const progress = `${b.done ?? 0} of ${b.total ?? "?"} done${b.failed ? `, ${b.failed} failed` : ""}`;
      return `  ${bold(b.batch_id ?? "?")}  ${b.status ?? "?"}  ${progress}  ${dim(b.started_at ?? "not started")}`;
    });
    return [
      `The latest batches for ${s.host}, newest first:`,
      ...lines,
      dim("Follow one with `nxis autofill status --batch <id> --wait`."),
    ].join("\n");
  });
}

/** @returns The scope flags, checked. */
function scopeFrom(flags: Parsed["flags"]): AutofillScope {
  const existing = str(flags, "existing");
  if (existing !== undefined && !["import_and_complete", "import", "generate"].includes(existing)) {
    throw new CliError(`--existing takes import_and_complete, import or generate, not "${existing}".`, {
      reason: "invalid_input",
      details: { field: "existing" },
    });
  }
  const mediaType = str(flags, "media-type");
  if (mediaType !== undefined && !["HTML", "IMAGE", "VIDEO", "AUDIO"].includes(mediaType.trim().toUpperCase())) {
    throw new CliError(`--media-type takes HTML, IMAGE, VIDEO or AUDIO, not "${mediaType}".`, {
      reason: "invalid_input",
      details: { field: "media_type" },
    });
  }
  return {
    ...(existing ? { existing: existing as Existing } : {}),
    ...(mediaType ? { mediaType } : {}),
    ...(str(flags, "pattern") ? { pattern: str(flags, "pattern") as string } : {}),
  };
}

/** Dispatches `nxis autofill <plan|submit|status>`. */
export async function autofill(ctx: Ctx, positional: string[], flags: Parsed["flags"]): Promise<void> {
  const [sub] = positional;
  const timeout = num(flags, "timeout") !== undefined ? { timeoutMinutes: num(flags, "timeout") as number } : {};
  if (sub === "plan") return cmdAutofillPlan(ctx, scopeFrom(flags));
  if (sub === "submit") {
    return cmdAutofillSubmit(ctx, { ...scopeFrom(flags), yes: bool(flags, "yes"), wait: bool(flags, "wait"), ...timeout });
  }
  if (sub === "status") {
    return cmdAutofillStatus(ctx, {
      wait: bool(flags, "wait"),
      recent: bool(flags, "recent"),
      ...(str(flags, "batch") ? { batchId: str(flags, "batch") as string } : {}),
      ...timeout,
    });
  }
  throw new CliError("Try `nxis autofill plan`, `nxis autofill submit` or `nxis autofill status`.", {
    reason: "unknown_command",
  });
}
