/**
 * Merging the generated discovery documents into the ones a project already has.
 *
 * @remarks
 * `llms.txt`, `agents.md`, `.well-known/ai-catalog.json` and `.well-known/mcp/catalog.json` are
 * files the person, or other tools, may already have written. `ai-catalog.json` in particular is
 * designed to hold entries from several tools. So nothing here replaces a file: it keeps what is
 * there and adds what is missing, and running it twice changes nothing the second time.
 *
 * - **JSON catalogs** keep every existing entry and top-level field. Each generated entry is added
 *   when no entry already has its identifier or points where it does (for the MCP server card,
 *   anywhere on the site's MCP endpoint; for the hosted agents' list, its own URL). When one
 *   does, it is updated in place: fields it lacks are added, and its `url` is corrected only when
 *   it points somewhere else. Its own titles and descriptions are kept.
 * - **`llms.txt`** (and any other text or markdown document) keeps its title, summary and
 *   sections exactly. A generated `##` section it lacks is appended; a section it has gains only
 *   the links it is missing, after its last list item.
 * - **`agents.md`** keeps its content and gains the generated guide, as one section with its
 *   headings moved down a level, when it does not already have it.
 *
 * A file that cannot be merged safely (a catalog that is not valid JSON, or whose `entries` is not
 * a list) is reported rather than touched.
 */

import { statSync } from "node:fs";
import { join, posix } from "node:path";

/** A file that cannot be merged without losing what is in it. */
export class UnmergeableError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "UnmergeableError";
  }
}

/** What merging did to one document. */
export type MergeStatus = "created" | "merged" | "unchanged";

/** What merging needs to know about the site. */
export interface MergeContext {
  /** The site's MCP endpoint, e.g. `https://example.com/mcp`. */
  mcpEndpoint?: string;
}

/**
 * Merges one generated document into what is already there.
 *
 * @param path - The document's path under the public root, e.g. `.well-known/ai-catalog.json`.
 * @param existing - The file's current content, or null when it does not exist.
 * @param generated - The generated document.
 * @param ctx - The site's MCP endpoint, to recognise an entry that already points at it.
 * @returns The content to write, and whether it was created, merged or left unchanged.
 * @throws UnmergeableError when the existing file cannot be merged without losing content.
 */
export function mergeDocument(
  path: string,
  existing: string | null,
  generated: string,
  ctx: MergeContext = {},
): { content: string; status: MergeStatus } {
  const fresh = withFinalNewline(generated);
  if (existing === null || existing.trim() === "") {
    // A missing file, or an empty one: there is nothing to keep.
    return { content: fresh, status: existing === null ? "created" : existing === fresh ? "unchanged" : "merged" };
  }

  const crlf = existing.includes("\r\n");
  const current = crlf ? existing.replace(/\r\n/g, "\n") : existing;
  const name = path.split("/").pop()?.toLowerCase() ?? path;

  let merged: string;
  if (name.endsWith(".json")) merged = mergeJson(path, current, generated, ctx);
  else if (name === "agents.md") merged = mergeAgentsMd(current, generated, ctx);
  else merged = mergeSections(current, generated);

  const out = crlf ? merged.replace(/\n/g, "\r\n") : merged;
  return { content: out, status: out === existing ? "unchanged" : "merged" };
}

function withFinalNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

// ── JSON catalogs ─────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @returns Whether two JSON values are equal, regardless of key order. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => sameJson(v, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && sameJson(a[k], b[k]));
  }
  return false;
}

/** @returns The indentation the file uses: its first indented line's, else two spaces. */
function indentOf(text: string): string | number {
  const m = /\n([ \t]+)\S/.exec(text);
  return m ? (m[1] as string) : 2;
}

function trimSlash(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** @returns Whether an entry already points at this MCP endpoint, or is the generated one. */
function sameEntry(entry: Json, generated: Json, ctx: MergeContext): boolean {
  if (typeof entry["identifier"] === "string" && entry["identifier"] === generated["identifier"]) return true;
  return typeof entry["url"] === "string" && pointsAt(entry["url"], generated, ctx);
}

/** @returns Whether a URL is on this MCP endpoint: the endpoint itself or anything under it. */
function onEndpoint(url: string, ctx: MergeContext): boolean {
  if (!ctx.mcpEndpoint) return false;
  const u = trimSlash(url);
  const endpoint = trimSlash(ctx.mcpEndpoint);
  return u === endpoint || u.startsWith(`${endpoint}/`);
}

/**
 * @returns Whether a URL is the generated entry's, or, for a generated entry on the MCP endpoint (the server card),
 * anything on that endpoint. Another generated entry (the hosted agents' list) is matched by its own URL only, so
 * it is never taken for the MCP entry already there.
 */
function pointsAt(url: string, generated: Json, ctx: MergeContext): boolean {
  const own = typeof generated["url"] === "string" ? generated["url"] : null;
  if (own !== null && trimSlash(url) === trimSlash(own)) return true;
  return (own === null || onEndpoint(own, ctx)) && onEndpoint(url, ctx);
}

/** Merges the generated entry into one that already describes it. */
function updateEntry(entry: Json, generated: Json, ctx: MergeContext): Json {
  const out: Json = { ...entry };
  let changed = false;
  for (const [key, value] of Object.entries(generated)) {
    if (key === "updatedAt") continue;
    if (!(key in out)) {
      out[key] = value;
      changed = true;
    }
  }
  // An entry found by its identifier whose URL points elsewhere advertises a server that is not
  // this one, which is the one thing worse than no entry.
  if (typeof generated["url"] === "string" && !(typeof out["url"] === "string" && pointsAt(out["url"], generated, ctx))) {
    out["url"] = generated["url"];
    changed = true;
  }
  if (changed && "updatedAt" in generated) out["updatedAt"] = generated["updatedAt"];
  else if (!("updatedAt" in out) && "updatedAt" in generated) out["updatedAt"] = generated["updatedAt"];
  return out;
}

function mergeJson(path: string, current: string, generated: string, ctx: MergeContext): string {
  let have: unknown;
  try {
    have = JSON.parse(current);
  } catch {
    throw new UnmergeableError(path, `${path} is not valid JSON, so it cannot be merged. Fix or move it, then run again.`);
  }
  const gen = JSON.parse(generated) as unknown;
  if (!isObject(have)) throw new UnmergeableError(path, `${path} is not a JSON object, so it cannot be merged.`);
  if (!isObject(gen)) return current;

  const out: Json = { ...have };
  for (const [key, value] of Object.entries(gen)) {
    if (key === "entries" || key in out) continue;
    out[key] = value;
  }

  if (Array.isArray(gen["entries"])) {
    if ("entries" in have && !Array.isArray(have["entries"])) {
      throw new UnmergeableError(path, `${path} has an \`entries\` field that is not a list, so it cannot be merged.`);
    }
    const entries = [...((have["entries"] as unknown[] | undefined) ?? [])];
    for (const g of gen["entries"]) {
      if (!isObject(g)) continue;
      const at = entries.findIndex((e) => isObject(e) && sameEntry(e, g, ctx));
      if (at === -1) entries.push(g);
      else entries[at] = updateEntry(entries[at] as Json, g, ctx);
    }
    out["entries"] = entries;
  }

  // Unchanged content keeps the file byte for byte, formatting included.
  if (sameJson(out, have)) return current;
  const text = JSON.stringify(out, null, indentOf(current));
  return current.endsWith("\n") ? `${text}\n` : text;
}

// ── Markdown and text ─────────────────────────────────────────────────────────

interface Section {
  /** The heading's text, normalized, or null for what comes before the first heading. */
  key: string | null;
  /** The lines, heading included. */
  lines: string[];
}

function headingKey(text: string): string {
  return text
    .replace(/\s+#+\s*$/, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** Splits a markdown document at its `##` headings, ignoring any inside code fences. */
function sections(text: string): Section[] {
  const out: Section[] = [{ key: null, lines: [] }];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (f) {
      const mark = (f[1] as string).slice(0, 3);
      if (fence === null) fence = mark;
      else if (mark === fence) fence = null;
    }
    const h = fence === null ? /^##\s+(.*)$/.exec(line) : null;
    if (h) out.push({ key: headingKey(h[1] as string), lines: [line] });
    else (out[out.length - 1] as Section).lines.push(line);
  }
  return out;
}

/** @returns The URL of a markdown link on a list item, or null. */
function linkOf(line: string): string | null {
  const m = /^\s*[-*+]\s+.*?\[[^\]]*\]\(([^)\s]+)[^)]*\)/.exec(line);
  return m ? (m[1] as string) : null;
}

/** @returns The lines with trailing blank lines dropped. */
function trimEnd(lines: string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && (out[out.length - 1] as string).trim() === "") out.pop();
  return out;
}

/**
 * Merges by `##` section: keeps every existing section as it is, adds the missing links to a
 * section both have, and appends sections only the generated document has.
 */
function mergeSections(current: string, generated: string): string {
  const have = sections(current);
  const gen = sections(generated.replace(/\r\n/g, "\n"));
  const appended: string[][] = [];

  for (const g of gen) {
    if (g.key === null) continue; // The generated title and summary never replace theirs.
    const match = have.find((s) => s.key === g.key);
    if (!match) {
      appended.push(trimEnd(g.lines));
      continue;
    }
    const text = match.lines.join("\n");
    const missing = g.lines.filter((line) => {
      const url = linkOf(line);
      return url !== null && !text.includes(url);
    });
    if (missing.length === 0) continue;
    // After the section's last list item, or after its last non-blank line.
    let at = -1;
    match.lines.forEach((line, i) => {
      if (/^\s*[-*+]\s+/.test(line)) at = i;
    });
    if (at === -1) at = trimEnd(match.lines).length - 1;
    match.lines.splice(at + 1, 0, ...missing);
  }

  let out = have.map((s) => s.lines.join("\n")).join("\n");
  if (appended.length > 0) {
    out = trimEnd(out.split("\n")).join("\n");
    for (const block of appended) out += `\n\n${block.join("\n")}`;
    out += "\n";
  }
  return out;
}

/** Moves every heading down one level, outside code fences. */
function demoteHeadings(text: string): string {
  let fence: string | null = null;
  return text
    .split("\n")
    .map((line) => {
      const f = /^\s*(```+|~~~+)/.exec(line);
      if (f) {
        const mark = (f[1] as string).slice(0, 3);
        if (fence === null) fence = mark;
        else if (mark === fence) fence = null;
        return line;
      }
      return fence === null && /^#{1,5}\s/.test(line) ? `#${line}` : line;
    })
    .join("\n");
}

/** Appends the generated guide, unless the file already has it or already names the endpoint. */
function mergeAgentsMd(current: string, generated: string, ctx: MergeContext): string {
  const gen = generated.replace(/\r\n/g, "\n");
  const title = /^#\s+(.*)$/m.exec(gen)?.[1];
  const titleKey = title ? headingKey(title) : null;
  const hasTitle =
    titleKey !== null &&
    current.split("\n").some((line) => {
      const h = /^#{1,6}\s+(.*)$/.exec(line);
      return h !== null && headingKey(h[1] as string) === titleKey;
    });
  const namesEndpoint = ctx.mcpEndpoint ? current.includes(trimSlash(ctx.mcpEndpoint)) : false;
  if (hasTitle || namesEndpoint) return current;
  return `${trimEnd(current.split("\n")).join("\n")}\n\n${withFinalNewline(demoteHeadings(gen).trimEnd())}`;
}

// ── Where the files go ────────────────────────────────────────────────────────

/** Directories a project serves as static files, as most frameworks name them. */
export const STATIC_DIRS = ["public", "static"] as const;

/**
 * The project's static folder, when there is exactly one candidate.
 *
 * @remarks
 * Conservative on purpose: `public/` (Next.js, Vite, Astro, Nuxt) or `static/` (SvelteKit,
 * Docusaurus), when exactly one exists. Build output (`dist/`, `build/`, `out/`) is never chosen,
 * because the next build replaces it. With both or neither, the caller must say.
 *
 * @param cwd - The project directory.
 * @returns The directory, and the candidates found.
 */
export function detectStaticDir(cwd: string): { dir: string | null; candidates: string[] } {
  const candidates = STATIC_DIRS.filter((name) => {
    try {
      return statSync(join(cwd, name)).isDirectory();
    } catch {
      return false;
    }
  });
  return { dir: candidates.length === 1 ? join(cwd, candidates[0] as string) : null, candidates: [...candidates] };
}

/**
 * The discovery documents `--write` may write, by their path under the public root.
 *
 * @remarks
 * Exactly the ones `nxis_aio_files` generates. The server names each document's path, and a
 * server that is wrong (or compromised) must not be able to write `index.html`, `sw.js` or
 * `_headers` into the site: anything else is refused, before any file is written.
 */
export const DISCOVERY_PATHS: ReadonlySet<string> = new Set([
  "llms.txt",
  "agents.md",
  ".well-known/ai-catalog.json",
  ".well-known/mcp/catalog.json",
]);

/**
 * Where a document goes under the output directory.
 *
 * @returns The file's path, or null when the document's path is not one of
 * {@link DISCOVERY_PATHS} (a path that would leave the directory never is).
 */
export function targetPath(outDir: string, docPath: string): string | null {
  const rel = posix.normalize(docPath.replace(/\\/g, "/").replace(/^\/+/, ""));
  if (!DISCOVERY_PATHS.has(rel)) return null;
  return join(outDir, ...rel.split("/"));
}
