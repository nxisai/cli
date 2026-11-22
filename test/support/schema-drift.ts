/**
 * Compares a tool's JSON Schema with the one the server lists.
 *
 * @remarks
 * Only what changes a call: property names, types, the required set, enums, numeric bounds and
 * descriptions, at every level. Not what differs by construction between zod's output and the
 * server's: `$schema`, `additionalProperties` (ours are strict), and zod's safe-integer bounds on an
 * unbounded integer.
 */

/** A JSON Schema, as far as the comparison reads it. */
export interface JsonSchema {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  [key: string]: unknown;
}

/** zod's bounds on an integer with none of its own. */
const SAFE_BOUNDS = new Set([Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]);

/** @returns A bound worth comparing, or undefined. */
function bound(value: number | undefined): number | undefined {
  return value === undefined || SAFE_BOUNDS.has(value) ? undefined : value;
}

/**
 * Every difference between two schemas, one line each, naming the property path.
 *
 * @param ours - Our schema, converted from zod.
 * @param theirs - The server's, from the fixture.
 * @param at - The path so far, for messages.
 * @returns An empty list when they agree.
 */
export function schemaDiff(ours: JsonSchema, theirs: JsonSchema, at = "(input)"): string[] {
  const out: string[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  if (!same(ours.type, theirs.type)) out.push(`${at}: type is ${fmt(ours.type)}, server has ${fmt(theirs.type)}`);
  if (!same(ours.enum, theirs.enum)) out.push(`${at}: enum is ${fmt(ours.enum)}, server has ${fmt(theirs.enum)}`);
  if (ours.description !== theirs.description) {
    out.push(`${at}: description is ${fmt(ours.description)}, server has ${fmt(theirs.description)}`);
  }
  for (const key of ["minimum", "maximum"] as const) {
    if (bound(ours[key]) !== bound(theirs[key])) {
      out.push(`${at}: ${key} is ${fmt(bound(ours[key]))}, server has ${fmt(bound(theirs[key]))}`);
    }
  }

  const required = (s: JsonSchema) => [...(s.required ?? [])].sort();
  if (!same(required(ours), required(theirs))) {
    out.push(`${at}: required is ${fmt(required(ours))}, server has ${fmt(required(theirs))}`);
  }

  const ourProps = ours.properties ?? {};
  const theirProps = theirs.properties ?? {};
  for (const name of Object.keys(theirProps)) {
    if (!(name in ourProps)) out.push(`${at}.${name}: missing here, the server has it`);
  }
  for (const [name, schema] of Object.entries(ourProps)) {
    const other = theirProps[name];
    if (!other) out.push(`${at}.${name}: not on the server`);
    else out.push(...schemaDiff(schema, other, `${at}.${name}`));
  }

  if (ours.items || theirs.items) {
    if (!ours.items || !theirs.items) out.push(`${at}[]: items differ in presence`);
    else out.push(...schemaDiff(ours.items, theirs.items, `${at}[]`));
  }
  return out;
}

function fmt(value: unknown): string {
  return value === undefined ? "nothing" : JSON.stringify(value);
}
