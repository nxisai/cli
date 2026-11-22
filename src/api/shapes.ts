/**
 * Decoding API response values.
 *
 * @remarks
 * The API's JSON has three traps, each of which produces a plausible wrong answer rather than a
 * crash:
 *
 * - An id arrives as an object, `{"value":"abc"}`, not a string. Reading `org._id` directly
 *   yields "[object Object]".
 * - A 64-bit integer arrives as a string, so credits arrive as `"1000000"`. Arithmetic on it
 *   silently concatenates.
 * - Optional strings and booleans arrive as bare values, so `name` really is a string. The
 *   nesting is not uniform, which is why each kind has its own reader.
 */

/** An id as the API may send it: a `{ value }` object, a bare string, or absent. */
export type Uid = { value?: string } | string | null | undefined;

/**
 * Reads an id however it arrived.
 *
 * @param value - A `{ value }` object or a bare string.
 * @returns The id, or null when absent or empty.
 */
export function uid(value: Uid): string | null {
  if (!value) return null;
  if (typeof value === "string") return value || null;
  return typeof value.value === "string" && value.value ? value.value : null;
}

/**
 * Reads a number that may arrive as a number, a numeric string, or a `{ value }` object.
 *
 * @param value - The raw value.
 * @returns The number, or null when absent or not a finite number.
 */
export function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "object" && "value" in (value as Record<string, unknown>)) {
    return num((value as Record<string, unknown>)["value"]);
  }
  return null;
}

/**
 * Reads a string that may arrive bare or as a `{ value }` object.
 *
 * @param value - The raw value.
 * @returns The string, or null.
 */
export function str(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "value" in (value as Record<string, unknown>)) {
    const inner = (value as Record<string, unknown>)["value"];
    return typeof inner === "string" ? inner : null;
  }
  return null;
}

/**
 * Reads a boolean that may arrive bare or as a `{ value }` object.
 *
 * @param value - The raw value.
 * @returns The boolean; absent is false.
 */
export function bool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (value && typeof value === "object" && "value" in (value as Record<string, unknown>)) {
    return (value as Record<string, unknown>)["value"] === true;
  }
  return false;
}

/**
 * Reads a list that may arrive as a bare array or as a named field of an object.
 *
 * @param payload - The response body.
 * @param field - The field that holds the list when the body is an object.
 * @returns The list, or an empty list when neither shape matches.
 */
export function list<T>(payload: unknown, field: string): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object") {
    const inner = (payload as Record<string, unknown>)[field];
    if (Array.isArray(inner)) return inner as T[];
  }
  return [];
}
