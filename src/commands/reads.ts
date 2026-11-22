/**
 * `nxis types` and `nxis query` — reading the site's published records from its own MCP server.
 *
 * @remarks
 * Both tools run on the site's own endpoint, not the provisioning one, and the CLI calls it
 * without a key. So they need the site's MCP server to be public (`nxis mcp public on`), and
 * answering is itself the check that the site is discoverable. Only published records are served:
 * generated drafts do not show up until they are published.
 *
 * A filter value's JSON type matters to the server. `EQUALS`, `NOT_EQUALS` and `IN` match only a
 * stored value of the same kind, so the number `48067` never matches a ZIP code stored as the text
 * `"48067"`, and JSON-LD stores numbers as text about as often as not. So for those operators, an
 * unquoted value that looks like a number or a boolean is sent as whatever the field holds: one
 * read of a few records that have the field decides. The range operators match both spellings
 * already, and a quoted value is always text.
 */

import type { Ctx } from "../context.js";
import { failed } from "../errors.js";
import { bold, dim, plainText } from "../output.js";
import { isVerbose } from "../trace.js";
import { FILTER_OPERATORS, listTypes, query, siteMcpUrl } from "../tools/index.js";

type Operator = (typeof FILTER_OPERATORS)[number];

/** Short names for the filter operators, beside the full ones. */
const OPERATOR_ALIASES: Record<string, Operator> = {
  eq: "EQUALS",
  "=": "EQUALS",
  ne: "NOT_EQUALS",
  neq: "NOT_EQUALS",
  "!=": "NOT_EQUALS",
  gt: "GREATER_THAN",
  ">": "GREATER_THAN",
  gte: "GREATER_THAN_OR_EQUAL",
  ge: "GREATER_THAN_OR_EQUAL",
  ">=": "GREATER_THAN_OR_EQUAL",
  lt: "LESS_THAN",
  "<": "LESS_THAN",
  lte: "LESS_THAN_OR_EQUAL",
  le: "LESS_THAN_OR_EQUAL",
  "<=": "LESS_THAN_OR_EQUAL",
  contains: "CONTAINS",
  in: "IN",
  exists: "EXISTS",
};

function operatorOf(raw: string): Operator | null {
  const upper = raw.trim().toUpperCase();
  if ((FILTER_OPERATORS as readonly string[]).includes(upper)) return upper as Operator;
  return OPERATOR_ALIASES[raw.trim().toLowerCase()] ?? null;
}

/** A filter value: quoted text stays text; otherwise `true`/`false`, a number, or text. */
function scalar(raw: string): unknown {
  const v = raw.trim();
  const quoted = /^"(.*)"$|^'(.*)'$/.exec(v);
  if (quoted) return quoted[1] ?? quoted[2];
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  if (v !== "" && Number.isFinite(Number(v))) return Number(v);
  return v;
}

/** @returns True for an unquoted value {@link scalar} turns into a number or a boolean. */
function looksTyped(raw: string): boolean {
  const v = scalar(raw);
  return typeof v === "number" || typeof v === "boolean";
}

/** The operators that match only a stored value of the same JSON type. */
const EXACT_KIND: readonly Operator[] = ["EQUALS", "NOT_EQUALS", "IN"];

/** One `field_filters` entry. */
export interface FieldFilter {
  path: string;
  operator: Operator;
  value?: unknown;
}

/** A parsed filter, with what the field's stored type still has to decide. */
interface ParsedFilter {
  filter: FieldFilter;
  /**
   * For `EQUALS`, `NOT_EQUALS` and `IN`: each value's text as typed, when some value is unquoted
   * and looks like a number or a boolean. Null when nothing is left to decide.
   */
  undecided: string[] | null;
}

/**
 * Parses `--filter path=op:value`.
 *
 * @remarks
 * `op` is an operator name (`EQUALS`, `GREATER_THAN` …) or a short one (`eq`, `ne`, `gt`, `gte`,
 * `lt`, `lte`, `contains`, `in`, `exists`). `exists` takes no value. `in` takes a comma-separated
 * list. Comparisons take a number. Otherwise `true`/`false` and numbers are read as such; quote a
 * value to keep it text (`postalCode=eq:"48067"`). For `EQUALS`, `NOT_EQUALS` and `IN`, `cmdQuery`
 * then sends an unquoted number or boolean as the field is stored.
 *
 * @throws CliError `invalid_input` (exit 1), naming the filter.
 */
export function parseFilter(raw: string): FieldFilter {
  return parseFilterParts(raw).filter;
}

/** {@link parseFilter}, keeping the text of the values the field's stored type decides. */
function parseFilterParts(raw: string): ParsedFilter {
  const eq = raw.indexOf("=");
  const bad = (why: string) =>
    failed(`--filter ${raw}: ${why} Expected path=op:value, e.g. aggregateRating.ratingValue=gte:4.`, "invalid_input", {
      field: "filter",
      filter: raw,
    });
  if (eq <= 0) throw bad("no path.");
  const path = raw.slice(0, eq).trim();
  const rest = raw.slice(eq + 1);
  const colon = rest.indexOf(":");
  const opText = colon === -1 ? rest : rest.slice(0, colon);
  const operator = operatorOf(opText);
  if (!operator) throw bad(`\`${opText}\` is not an operator.`);
  const done = (filter: FieldFilter): ParsedFilter => ({ filter, undecided: null });
  if (operator === "EXISTS") {
    return done(colon === -1 ? { path, operator } : { path, operator, value: scalar(rest.slice(colon + 1)) });
  }
  if (colon === -1) throw bad("no value.");
  const valueText = rest.slice(colon + 1);
  const texts = operator === "IN" ? valueText.split(",") : [valueText];
  const undecided = EXACT_KIND.includes(operator) && texts.some(looksTyped) ? texts.map((t) => t.trim()) : null;
  if (operator === "IN") return { filter: { path, operator, value: texts.map(scalar) }, undecided };
  if (operator === "CONTAINS") return done({ path, operator, value: String(scalar(valueText)) });
  const value = scalar(valueText);
  if (operator.startsWith("GREATER") || operator.startsWith("LESS")) {
    if (typeof value !== "number" && !/^\d{4}-\d{2}-\d{2}/.test(String(value))) {
      throw bad(`${operator} compares numbers or dates.`);
    }
  }
  return { filter: { path, operator, value }, undecided };
}

/**
 * How a field is stored, from a sample of records: `number` or `boolean` when every sampled value
 * is one, `string` when any is text, `unknown` when nothing was sampled or the sample mixes numbers
 * and booleans.
 */
export type StoredType = "string" | "number" | "boolean" | "unknown";

/** How many records the probe reads. */
const PROBE_LIMIT = 5;

/**
 * @returns The values at a dot-path in a record. An array along the way, or at the end,
 * contributes its elements; a JSON-LD value object (`{"@value": …}`) its value.
 */
export function valuesAt(record: unknown, path: string): unknown[] {
  let current: unknown[] = [record];
  for (const key of path.split(".")) {
    current = current
      .flatMap((v) => (Array.isArray(v) ? v : [v]))
      .flatMap((v) => (v && typeof v === "object" && key in v ? [(v as Record<string, unknown>)[key]] : []));
  }
  return current
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .map((v) => (v && typeof v === "object" && "@value" in v ? (v as Record<string, unknown>)["@value"] : v));
}

/** @returns The stored type of the values sampled, by the rule in {@link StoredType}. */
export function storedType(values: unknown[]): StoredType {
  const kinds = new Set(values.map((v) => typeof v).filter((k) => k === "string" || k === "number" || k === "boolean"));
  if (kinds.has("string")) return "string";
  if (kinds.size === 1) return [...kinds][0] as StoredType;
  return "unknown";
}

/**
 * @returns A value's text, typed the way the field is stored: text for a `string` field, else as
 * {@link scalar} reads it.
 */
function typedAs(text: string, type: StoredType): unknown {
  return type === "string" && looksTyped(text) ? text : scalar(text);
}

/**
 * Settles the value types of the filters that need it, one probe per field.
 *
 * @remarks
 * The probe is a typed lookup on the same endpoint (no `--text`, so nothing is billed): the same
 * type, the field `EXISTS`, and {@link PROBE_LIMIT} records. A field with no sample keeps the
 * number or boolean as typed.
 *
 * @returns The filters to send, and the stored type found for each probed path.
 */
async function settleTypes(
  ctx: Ctx,
  endpoint: string,
  baseFilter: Record<string, unknown>,
  parsed: ParsedFilter[],
): Promise<{ filters: FieldFilter[]; types: Record<string, StoredType> }> {
  const cache = new Map<string, StoredType>();
  const filters: FieldFilter[] = [];
  for (const { filter, undecided } of parsed) {
    if (!undecided) {
      filters.push(filter);
      continue;
    }
    let type = cache.get(filter.path);
    if (type === undefined) {
      const { data } = await query.run(
        ctx,
        {
          filter: { ...baseFilter, field_filters: [{ path: filter.path, operator: "EXISTS" }] },
          limit: PROBE_LIMIT,
        } as Parameters<typeof query.run>[1],
        { siteUrl: endpoint },
      );
      const records = data?.results ?? [];
      type = storedType(records.flatMap((r) => valuesAt(r, filter.path)));
      cache.set(filter.path, type);
      const sampled = `${records.length} ${String(baseFilter["schema_type"])} record${records.length === 1 ? "" : "s"}`;
      verbose(
        type === "unknown"
          ? `${filter.path}: ${sampled} sampled, none settles how it is stored; sending the value as typed.`
          : `${filter.path}: stored as ${type} in the ${sampled} sampled; ` +
              `sending the value as ${type === "string" ? "text" : `a ${type}`}.`,
      );
    }
    const values = undecided.map((t) => typedAs(t, type));
    filters.push({ ...filter, value: filter.operator === "IN" ? values : values[0] });
  }
  return { filters, types: Object.fromEntries(cache) };
}

/** A line on stderr under `--verbose`, beside the request trace. */
function verbose(line: string): void {
  if (isVerbose()) process.stderr.write(`filter ${line}\n`);
}

/** Runs `nxis types`. */
export async function cmdTypes(ctx: Ctx, args: { limit?: number } = {}): Promise<void> {
  const endpoint = await siteMcpUrl(ctx);
  const { data } = await listTypes.run(ctx, args.limit !== undefined ? { limit: args.limit } : {}, { siteUrl: endpoint });
  const types = data?.types ?? [];
  ctx.io.emit(
    { ok: true, endpoint, types, total: data?.total ?? types.length, truncated: data?.truncated ?? false },
    () => {
      if (types.length === 0) {
        return [
          `${endpoint} answers, but serves no records yet.`,
          dim("Generated structured data is a draft until it is published; publish it, then try again."),
        ].join("\n");
      }
      const width = Math.max(...types.map((t) => (t.name ?? "").length), 4);
      return [
        dim(endpoint),
        ...types.map((t) => `  ${(t.name ?? "?").padEnd(width)}  ${String(t.count ?? "")}`.trimEnd()),
        ...(data?.truncated ? [dim(`  … ${data.total ?? "more"} types in all; raise --limit to see more.`)] : []),
      ].join("\n");
    },
  );
}

/** Arguments for `nxis query`. */
export interface QueryArgs {
  type?: string;
  text?: string;
  filters?: string[];
  limit?: number;
  exact?: boolean;
  pageToken?: string;
}

/**
 * Runs `nxis query <type>`.
 *
 * @remarks
 * `--text` runs a semantic search, which the site's organization is billed for; without it, the
 * query is a plain typed lookup.
 *
 * @throws CliError `invalid_input` (exit 1) for a missing type or a bad filter, before anything
 * is sent; `site_mcp_off` or `site_mcp_not_public` (exit 2) when the site's server cannot be read.
 */
export async function cmdQuery(ctx: Ctx, args: QueryArgs): Promise<void> {
  const type = args.type?.trim();
  if (!type) {
    throw failed("Which type? `nxis query <type>`; `nxis types` lists them.", "invalid_input", { field: "type" });
  }
  const parsed = (args.filters ?? []).map(parseFilterParts);
  const filter: Record<string, unknown> = { schema_type: type };
  if (args.exact) filter["exact_type_match"] = true;

  const endpoint = await siteMcpUrl(ctx);
  const { filters, types: filterTypes } = await settleTypes(ctx, endpoint, { ...filter }, parsed);
  if (filters.length > 0) filter["field_filters"] = filters;

  const input: Record<string, unknown> = { filter };
  if (args.text) {
    input["text"] = args.text;
    ctx.io.note(dim("--text runs a semantic search, billed to the site's organization."));
  }
  if (args.limit !== undefined) input["limit"] = args.limit;
  if (args.pageToken) input["page_token"] = args.pageToken;

  const { data } = await query.run(ctx, input as Parameters<typeof query.run>[1], { siteUrl: endpoint });
  const results = data?.results ?? [];
  ctx.io.emit(
    {
      ok: true,
      endpoint,
      type,
      total: data?.total ?? results.length,
      results,
      matched_types: data?.matched_types ?? [],
      next_page_token: data?.next_page_token ?? null,
      filter_types: filterTypes,
    },
    () => {
      if (results.length === 0) return `No ${type} records${filters.length > 0 || args.text ? " match" : " yet"}.`;
      const lines = results.map((r) => {
        const t = Array.isArray(r["@type"]) ? (r["@type"] as unknown[]).join(",") : String(r["@type"] ?? type);
        const label = r["name"] ?? r["headline"] ?? r["title"] ?? "";
        return `  ${bold(plainText(String(label)) || "(unnamed)")}  ${dim(t)}  ${dim(String(r["@id"] ?? ""))}`;
      });
      const total = data?.total;
      return [
        `${results.length}${typeof total === "number" && total > results.length ? ` of ${total}` : ""} ${type} record${results.length === 1 ? "" : "s"}`,
        ...lines,
        ...(data?.next_page_token ? [dim(`More: --page-token ${data.next_page_token}`)] : []),
      ].join("\n");
    },
  );
}
