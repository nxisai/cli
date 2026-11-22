/**
 * The read tools on a site's own MCP endpoint.
 *
 * @remarks
 * `nxis_list_types` and `nxis_query` are not on the provisioning endpoint. They take their tenant
 * from the hostname they are called on, so `run` calls them on the site's endpoint, whose URL
 * comes from `siteMcpUrl` (`./sites.ts`). That endpoint refuses a `site` argument, and these
 * schemas have none. It is called without a key, which is why the site's MCP server must be public.
 *
 * Names, descriptions and input schemas are the server's, word for word, and are checked against
 * the recorded fixture like the provisioning tools.
 */

import { z } from "zod";
import { defineTool } from "./define.js";

/** One type in the site's corpus. */
export interface TypeCount extends Record<string, unknown> {
  name?: string;
  group?: string;
  count?: number;
  /** Only with `include_ancestors`. */
  ancestors?: string[];
}

/** `nxis_list_types`. */
export interface ListTypesResult extends Record<string, unknown> {
  types?: TypeCount[];
  /** Every type in the corpus, even when `types` was capped. */
  total?: number;
  truncated?: boolean;
}

export const listTypes = defineTool<ListTypesResult>()({
  name: "nxis_list_types",
  description:
    "Lists all schema.org types present in this site's corpus, with counts and hierarchy info. Use this to " +
    "discover what types of entities are available before querying.",
  input: z.strictObject({
    limit: z
      .int()
      .describe(
        "Maximum types to return, ordered by count descending (default 200). The response carries `total` for " +
          "the full corpus count and `truncated: true` when capped.",
      )
      .optional(),
    include_ancestors: z
      .boolean()
      .describe(
        "Include each type's schema.org ancestor chain (default false — ancestors dominate the payload; request " +
          "them only when hierarchy matters).",
      )
      .optional(),
  }),
  surface: "site",
  readOnly: true,
  hints: { openWorld: false },
});

/** The operators a field filter takes. */
export const FILTER_OPERATORS = [
  "EQUALS",
  "NOT_EQUALS",
  "GREATER_THAN",
  "GREATER_THAN_OR_EQUAL",
  "LESS_THAN",
  "LESS_THAN_OR_EQUAL",
  "CONTAINS",
  "IN",
  "EXISTS",
] as const;

/** `nxis_query`: matching records, as JSON-LD. */
export interface QueryResult extends Record<string, unknown> {
  /** JSON-LD entities, each with `@id` and `@type`, and `nxis:pageCount` when repeated across pages. */
  results?: Array<Record<string, unknown>>;
  total?: number;
  matched_types?: string[];
  /** Null or absent on the last page. */
  next_page_token?: string | null;
}

export const query = defineTool<QueryResult>()({
  name: "nxis_query",
  description:
    "Queries typed records in the site corpus by schema.org type, with optional semantic text search, field " +
    "filters, sorting, and pagination. Entities repeated across pages of the site — footer and sidebar content, " +
    "for example — are returned once and annotated with nxis:pageCount, so a page of results can be shorter " +
    "than `limit` without the corpus being exhausted. Results come back, and are shown, in the order returned: " +
    "when the person asks for the best, top-rated, cheapest or newest, sort in the query (filter.sort_option, " +
    "e.g. aggregateRating.ratingValue DESCENDING) instead of ranking the results yourself. Use nxis_list_types " +
    "first to discover available types.",
  input: z.strictObject({
    text: z.string().describe("Optional natural-language query for semantic search").optional(),
    limit: z.int().describe("Max results to return (1-100)").optional(),
    page_token: z.string().describe("Pagination token from a previous response").optional(),
    filter: z
      .strictObject({
        schema_type: z
          .string()
          .describe(
            "Schema.org type to filter by (e.g. 'Plumber', 'LocalBusiness', 'Product'). Parent types match " +
              "subtypes unless exact_type_match is true.",
          ),
        exact_type_match: z
          .boolean()
          .describe("If true, match only the exact type; do not expand to subtypes")
          .optional(),
        field_filters: z
          .array(
            z.strictObject({
              path: z
                .string()
                .describe(
                  "Dot-path into JSON-LD data (e.g. 'areaServed.postalCode', 'aggregateRating.ratingValue')",
                ),
              operator: z.enum(FILTER_OPERATORS),
              value: z.unknown().describe("Value to compare against (not needed for EXISTS)").optional(),
            }),
          )
          .describe("Structured field filters on the JSON-LD data")
          .optional(),
        sort_option: z
          .strictObject({
            property: z
              .string()
              .describe("Field path to sort by, e.g. aggregateRating.ratingValue or offers.price"),
            order: z.enum(["ASCENDING", "DESCENDING"]),
          })
          .optional(),
      })
      .describe("Type and field filter configuration"),
  }),
  surface: "site",
  // A read. With `text` it runs a semantic search, which the site's organization is billed for.
  readOnly: true,
  hints: { openWorld: false },
});
