import { DelegateError } from "./errors.js";

/** Canonical UUID (any version) — rejects path separators and `..`. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSafeRunId(id: string): boolean {
  return UUID_RE.test(id);
}

export function assertSafeRunId(id: string, label = "runId"): string {
  if (!isSafeRunId(id)) {
    throw new DelegateError(
      `Invalid ${label}: must be a UUID (got ${JSON.stringify(id)})`,
      "invalid_run_id",
      true,
    );
  }
  return id;
}

export function assertSafeSessionId(id: string): string {
  if (!isSafeRunId(id)) {
    throw new DelegateError(
      `Invalid sessionId: must be a UUID (got ${JSON.stringify(id)})`,
      "invalid_session_id",
      true,
    );
  }
  return id;
}
