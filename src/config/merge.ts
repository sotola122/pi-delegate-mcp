/** Deep-merge plain objects; arrays and primitives from `override` win. */
export function deepMerge<T>(base: T, override: unknown): T {
  if (override === null || override === undefined) return base;
  if (Array.isArray(override)) return override as T;
  if (typeof override !== "object" || typeof base !== "object" || base === null) {
    return override as T;
  }
  const out: Record<string, unknown> = {
    ...(base as Record<string, unknown>),
  };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    if (k in out) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}
