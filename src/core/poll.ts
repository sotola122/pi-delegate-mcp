export const POLL_HINT =
  "Wait pollAfterSeconds, then get_run with view=status until terminal; then view=full";

/** Recommended wait before the next get_run while a run is active. */
export function pollAfterSeconds(
  status: string,
  elapsedMs: number,
): number {
  if (status !== "running" && status !== "queued") return 0;
  const elapsedSec = Math.floor(elapsedMs / 1000);
  if (elapsedSec < 30) return 15;
  if (elapsedSec < 90) return 30;
  return 60;
}

export function startedRunPublic(runId: string): Record<string, unknown> {
  return {
    runId,
    status: "running" as const,
    poll: "get_run",
    pollAfterSeconds: 15,
    hint: POLL_HINT,
  };
}
