/**
 * A unified diff of two texts, line by line.
 *
 * @remarks
 * Small on purpose: the CLI shows a diff before it changes a file in someone's project, and the
 * files it changes are discovery documents of a few dozen lines. Common leading and trailing lines
 * are set aside first, so what is left to compare is the part that changed, usually a few
 * appended lines.
 */

/** One line of an edit script. */
type Op = { kind: " " | "-" | "+"; line: string };

/** @returns The lines of a text, without a final empty line for a trailing newline. */
function linesOf(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** @returns The edit script turning `a` into `b`, from a longest common subsequence. */
function editScript(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  // lcs[i][j]: the longest common subsequence of midA[i..] and midB[j..].
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i] as Uint32Array;
    const below = lcs[i + 1] as Uint32Array;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = midA[i] === midB[j] ? (below[j + 1] as number) + 1 : Math.max(below[j] as number, row[j + 1] as number);
    }
  }

  const ops: Op[] = a.slice(0, start).map((line) => ({ kind: " ", line }));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) {
      ops.push({ kind: " ", line: midA[i] as string });
      i++;
      j++;
    } else if (i < n && (j === m || ((lcs[i + 1] as Uint32Array)[j] as number) >= ((lcs[i] as Uint32Array)[j + 1] as number))) {
      // Removals before additions, as diff -u prints them.
      ops.push({ kind: "-", line: midA[i] as string });
      i++;
    } else {
      ops.push({ kind: "+", line: midB[j] as string });
      j++;
    }
  }
  for (const line of a.slice(endA)) ops.push({ kind: " ", line });
  return ops;
}

/**
 * A unified diff, as `diff -u` prints it.
 *
 * @param before - The current text, or null for a file that does not exist yet.
 * @param after - The new text.
 * @param names - The names shown on the `---` and `+++` lines.
 * @param context - Unchanged lines shown around each change.
 * @returns The diff, or an empty string when the texts are the same.
 */
export function unifiedDiff(
  before: string | null,
  after: string,
  names: { from: string; to: string },
  context = 3,
): string {
  if (before === after) return "";
  const a = linesOf(before ?? "");
  const b = linesOf(after);
  const ops = editScript(a, b);

  const changed = ops.map((op, k) => (op.kind === " " ? -1 : k)).filter((k) => k >= 0);
  if (changed.length === 0) {
    // Only a trailing newline differs.
    return `--- ${before === null ? "/dev/null" : names.from}\n+++ ${names.to}\n\\ trailing newline changed\n`;
  }

  // Group changes whose context overlaps into one hunk.
  const hunks: Array<[number, number]> = [];
  for (const k of changed) {
    const from = Math.max(0, k - context);
    const to = Math.min(ops.length, k + context + 1);
    const last = hunks[hunks.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else hunks.push([from, to]);
  }

  const out = [`--- ${before === null ? "/dev/null" : names.from}`, `+++ ${names.to}`];
  // Line numbers in each file at each op.
  const posA: number[] = [];
  const posB: number[] = [];
  let lineA = 1;
  let lineB = 1;
  for (const op of ops) {
    posA.push(lineA);
    posB.push(lineB);
    if (op.kind !== "+") lineA++;
    if (op.kind !== "-") lineB++;
  }
  for (const [from, to] of hunks) {
    const slice = ops.slice(from, to);
    const countA = slice.filter((op) => op.kind !== "+").length;
    const countB = slice.filter((op) => op.kind !== "-").length;
    const startA = countA === 0 ? (posA[from] as number) - 1 : (posA[from] as number);
    const startB = countB === 0 ? (posB[from] as number) - 1 : (posB[from] as number);
    out.push(`@@ -${startA},${countA} +${startB},${countB} @@`);
    for (const op of slice) out.push(`${op.kind}${op.line}`);
  }
  return `${out.join("\n")}\n`;
}
