/**
 * `nxis discovery files` — the site's AI discovery documents, printed or merged into the project.
 *
 * @remarks
 * The documents (`llms.txt`, `agents.md`, `.well-known/ai-catalog.json`,
 * `.well-known/mcp/catalog.json`) come from the server, generated the way the dashboard generates
 * them. Writing them is the CLI's job, because they live in the person's repository. Only those
 * paths are written; any other path the server names is refused before anything is written.
 * Existing files are merged, never replaced (see `../discovery.ts`), and the diff of what changed
 * is printed after writing; `--dry-run` prints it without writing.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { Ctx } from "../context.js";
import { unifiedDiff } from "../diff.js";
import { detectStaticDir, DISCOVERY_PATHS, mergeDocument, targetPath, UnmergeableError, type MergeStatus } from "../discovery.js";
import { failed, needsUser } from "../errors.js";
import { bold, dim, plainText } from "../output.js";
import { aioFiles, type DiscoveryDocument } from "../tools/index.js";
import { isDryRun } from "../trace.js";

/** Arguments for `nxis discovery files`. */
export interface DiscoveryFilesArgs {
  /** Write the documents (merging) rather than print them. */
  write?: boolean;
  /** The site's public root. Defaults to the project's static folder, when there is one. */
  out?: string;
  /** The project directory, for finding the static folder. Defaults to the working directory. */
  cwd?: string;
}

/** One document, as `--write` handled it. */
export interface PlannedFile {
  /** The document's path under the public root, e.g. `.well-known/ai-catalog.json`. */
  path: string;
  /** Where it is written. */
  file: string;
  status: MergeStatus;
  /** A unified diff against the current file; empty when unchanged. */
  diff: string;
}

/**
 * Runs `nxis discovery files`.
 *
 * @throws CliError `out_dir_required` (exit 2) when `--write` has no `--out` and no single static
 * folder is found; `discovery_unmergeable` (exit 2) when an existing file cannot be merged without
 * losing content, in which case nothing is written; `unsafe_path` (exit 1), before anything is
 * written, for a document path that is not a known discovery document; and whatever the tool call
 * throws.
 */
export async function cmdDiscoveryFiles(ctx: Ctx, args: DiscoveryFilesArgs = {}): Promise<void> {
  const { io } = ctx;
  const cwd = args.cwd ?? process.cwd();

  // Resolve where to write before calling anything, so a missing --out fails fast.
  let outDir: string | null = null;
  if (args.write) {
    if (args.out) outDir = resolve(cwd, args.out);
    else {
      const found = detectStaticDir(cwd);
      if (!found.dir) {
        throw needsUser(
          found.candidates.length > 1
            ? `Found ${found.candidates.map((c) => `${c}/`).join(" and ")}; say which serves the site's static files with --out <dir>.`
            : "No static folder (public/ or static/) found here. Pass --out <dir>: the directory your site serves static files from.",
          "out_dir_required",
          { candidates: found.candidates },
        );
      }
      outDir = found.dir;
    }
  }

  const { data } = await aioFiles.run(ctx, {});
  const documents: DiscoveryDocument[] = (data?.documents ?? []).filter(
    (d): d is DiscoveryDocument => typeof d?.path === "string" && typeof d?.content === "string",
  );
  const endpoint = data?.mcp_endpoint;

  if (!outDir) {
    io.emit(
      { ok: true, site: data?.site ?? null, mcp_endpoint: endpoint ?? null, documents, note: data?.note ?? null },
      () =>
        [
          ...documents.flatMap((d) => [bold(`── ${d.path} ──`), d.content.trimEnd(), ""]),
          dim("Write them, merged with any you already have: nxis discovery files --write [--out <dir>]"),
        ].join("\n"),
    );
    return;
  }

  const planned = plan(outDir, documents, endpoint, cwd);
  const changes = planned.filter((p) => p.status !== "unchanged");
  const dryRun = isDryRun();

  if (!dryRun) {
    for (const p of changes) {
      mkdirSync(dirname(p.file), { recursive: true });
      writeFileSync(p.file, p.content, "utf8");
    }
  }

  const files: PlannedFile[] = planned.map(({ path, file, status, diff }) => ({ path, file, status, diff }));
  io.emit(
    { ok: true, out: outDir, mcp_endpoint: endpoint ?? null, dry_run: dryRun, written: !dryRun && changes.length > 0, files },
    () => render(files, outDir as string, cwd, dryRun),
  );
}

/** Merges every document against what is on disk, and fails before writing anything if one cannot be. */
function plan(
  outDir: string,
  documents: DiscoveryDocument[],
  endpoint: string | undefined,
  cwd: string,
): Array<PlannedFile & { content: string }> {
  const out: Array<PlannedFile & { content: string }> = [];
  const problems: Array<{ path: string; error: string }> = [];
  for (const doc of documents) {
    const file = targetPath(outDir, doc.path);
    if (!file) {
      throw failed(
        `The server named a document at ${plainText(doc.path)}, which is not one of the discovery documents ` +
          `(${[...DISCOVERY_PATHS].join(", ")}). Nothing was written.`,
        "unsafe_path",
        { path: doc.path, allowed: [...DISCOVERY_PATHS] },
      );
    }
    const existing = readIfExists(file);
    try {
      const merged = mergeDocument(doc.path, existing, doc.content, endpoint ? { mcpEndpoint: endpoint } : {});
      const shown = relative(cwd, file) || file;
      out.push({
        path: doc.path,
        file,
        status: merged.status,
        content: merged.content,
        diff: unifiedDiff(existing, merged.content, { from: `a/${shown}`, to: `b/${shown}` }),
      });
    } catch (err) {
      if (!(err instanceof UnmergeableError)) throw err;
      problems.push({ path: doc.path, error: err.message });
    }
  }
  if (problems.length > 0) {
    throw needsUser(
      `${problems.map((p) => p.error).join(" ")} Nothing was written.`,
      "discovery_unmergeable",
      { files: problems },
    );
  }
  return out;
}

function readIfExists(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** The diffs, then a line per file. */
function render(files: PlannedFile[], outDir: string, cwd: string, dryRun: boolean): string {
  const lines: string[] = [];
  for (const f of files) if (f.diff) lines.push(f.diff.trimEnd());
  if (lines.length > 0) lines.push("");
  const verb: Record<MergeStatus, string> = dryRun
    ? { created: "would create", merged: "would merge", unchanged: "unchanged" }
    : { created: "created", merged: "merged", unchanged: "unchanged" };
  for (const f of files) lines.push(`  ${verb[f.status].padEnd(12)} ${relative(cwd, f.file) || f.file}`);
  const changed = files.some((f) => f.status !== "unchanged");
  lines.push("");
  if (dryRun) lines.push(dim("Dry run: nothing was written."));
  else if (!changed) lines.push("Already up to date. Nothing was written.");
  else {
    lines.push(
      `Wrote the discovery documents into ${relative(cwd, outDir) || outDir}/, keeping what was already there.`,
      dim("Check that your framework serves .well-known/ from there, then deploy: nothing is discoverable until it is live."),
    );
  }
  return lines.join("\n");
}
