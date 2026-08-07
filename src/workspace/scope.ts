import { DelegateError } from "../core/errors.js";

/** Normalize to forward slashes for stable matching. */
export function normalizeRepoPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Match a repo-relative path against a scope pattern.
 * - exact file: `src/a.ts`
 * - directory prefix: `src` or `src/` matches `src/a.ts`
 * - trailing `*`: `src*` / `src/*` treated as prefix
 */
export function matchesScopePattern(filePath: string, pattern: string): boolean {
  const norm = normalizeRepoPath(filePath);
  let pat = normalizeRepoPath(pattern);
  if (pat.endsWith("*")) {
    pat = pat.slice(0, -1);
  }
  pat = pat.replace(/\/$/, "");
  if (!pat) return true;
  return norm === pat || norm.startsWith(pat + "/");
}

export function isUnsafeRepoPath(filePath: string): boolean {
  const norm = normalizeRepoPath(filePath);
  if (!norm || norm === ".") return true;
  if (norm.startsWith("/") || /^[A-Za-z]:/.test(norm)) return true;
  const parts = norm.split("/");
  return parts.some((p) => p === "..");
}

/**
 * Reject traversal / absolute paths always.
 * When `inScope` is non-empty, every path must match at least one pattern.
 * When `outOfScope` is non-empty, no path may match any pattern.
 */
export function assertPathsAllowed(
  paths: string[],
  inScope?: string[],
  outOfScope?: string[],
): void {
  for (const raw of paths) {
    const p = normalizeRepoPath(raw);
    if (isUnsafeRepoPath(p)) {
      throw new DelegateError(
        `Patch path rejected (unsafe): ${raw}`,
        "path_traversal",
        true,
      );
    }
    if (outOfScope?.some((s) => matchesScopePattern(p, s))) {
      throw new DelegateError(
        `Patch path matches outOfScope: ${raw}`,
        "scope_violation",
        false,
      );
    }
    if (
      inScope &&
      inScope.length > 0 &&
      !inScope.some((s) => matchesScopePattern(p, s))
    ) {
      throw new DelegateError(
        `Patch path not in inScope: ${raw}`,
        "scope_violation",
        false,
      );
    }
  }
}

/** Only apply delivery when the run finalized as success. */
export function canApplyDelivery(
  delivery: "none" | "patch" | "apply",
  status: "success" | "incomplete" | "failed" | "cancelled",
): boolean {
  return delivery === "apply" && status === "success";
}
