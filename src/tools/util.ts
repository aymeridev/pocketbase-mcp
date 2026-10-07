import { stableStringify } from "../confirmation.js";

export type Json = Record<string, unknown>;

/** Field-level changes that `data` would apply on top of `current`. */
export function diffFields(current: Json, data: Json): Record<string, { before: unknown; after: unknown }> {
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  for (const [key, after] of Object.entries(data)) {
    const before = current[key];
    if (stableStringify(before) !== stableStringify(after)) {
      changes[key] = { before, after };
    }
  }
  return changes;
}

/** Shortens long strings so previews stay readable. */
export function truncateValues(value: unknown, max = 300): unknown {
  if (typeof value === "string") {
    return value.length > max ? `${value.slice(0, max)}… (${value.length} chars)` : value;
  }
  if (Array.isArray(value)) return value.map((v) => truncateValues(v, max));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncateValues(v, max)]));
  }
  return value;
}
