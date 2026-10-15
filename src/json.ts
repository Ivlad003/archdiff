// JSON values at I/O boundaries: what `JSON.parse` returns, named so callers
// branch on a known contract instead of `unknown`.
// Used wherever external JSON enters: config, index, LLM replies, LSP/MCP messages.
// Entry points: `parseJson` plus the `isJson*` narrowing guards.

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

export type JsonObject = { [key: string]: JsonValue };

/** Parses JSON text; throws `SyntaxError` like `JSON.parse`. */
export function parseJson(text: string): JsonValue {
  // SAFETY: JSON.parse without a reviver yields only JSON primitives, arrays and plain objects.
  return JSON.parse(text) as JsonValue;
}

/** True for a plain JSON object; arrays and `null` are excluded although `typeof` says "object". */
export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Narrows a JSON value to a string. */
export function isJsonString(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

/** Narrows a JSON value to a number. */
export function isJsonNumber(value: JsonValue | undefined): value is number {
  return typeof value === "number";
}

/** Narrows a JSON value to a boolean. */
export function isJsonBoolean(value: JsonValue | undefined): value is boolean {
  return typeof value === "boolean";
}
