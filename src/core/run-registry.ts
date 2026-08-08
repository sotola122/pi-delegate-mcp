import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config/schema.js";
import {
  runDelegation,
  type DelegateRequest,
} from "./delegate.js";
import type { DelegateResult } from "./result.js";
import { createRunDirs, saveResultJson } from "../artifacts/manager.js";
import { runsDir } from "../config/paths.js";
import { DelegateError } from "./errors.js";
import { assertSafeRunId } from "./ids.js";
import { POLL_HINT, pollAfterSeconds, startedRunPublic } from "./poll.js";
import type { RunProgress } from "./progress.js";

export type { RunProgress, RunProgressPhase } from "./progress.js";

export type RunStatus =
  | "queued"
  | "running"
  | "success"
  | "incomplete"
  | "failed"
  | "cancelled";

export interface RunRecord {
  runId: string;
  batchId?: string;
  roleId?: string;
  status: RunStatus;
  createdAt: number;
  updatedAt: number;
  progress?: RunProgress;
  result?: DelegateResult;
  error?: { code: string; message: string };
  abort: AbortController;
}

interface PersistedStatus {
  runId: string;
  batchId?: string;
  roleId?: string;
  status: RunStatus;
  createdAt: number;
  updatedAt: number;
  progress?: RunProgress;
  error?: { code: string; message: string };
}

const runs = new Map<string, RunRecord>();
const lastHeartbeatMs = new Map<string, number>();

function statusPath(runId: string): string {
  assertSafeRunId(runId);
  return join(runsDir(), runId, "result", "status.json");
}

function persist(record: RunRecord): void {
  const dir = join(runsDir(), record.runId, "result");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const payload: PersistedStatus = {
    runId: record.runId,
    batchId: record.batchId,
    roleId: record.roleId,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    progress: record.progress,
    error: record.error,
  };
  writeFileSync(statusPath(record.runId), JSON.stringify(payload, null, 2) + "\n", {
    mode: 0o600,
  });
}

/**
 * Heartbeat while a run is active.
 * tool_end (phase=tools) always persists; other phases throttle to ≥10s.
 */
export function updateRunProgress(
  runId: string,
  progress: RunProgress,
  opts?: { force?: boolean },
): void {
  assertSafeRunId(runId);
  const mem = runs.get(runId);
  if (!mem || (mem.status !== "running" && mem.status !== "queued")) return;
  const now = Date.now();
  const last = lastHeartbeatMs.get(runId) ?? 0;
  const isToolTick = progress.phase === "tools";
  if (!opts?.force && !isToolTick && now - last < 10_000) return;
  mem.progress = progress;
  mem.updatedAt = now;
  lastHeartbeatMs.set(runId, now);
  persist(mem);
}

export function getRun(runId: string): RunRecord | undefined {
  assertSafeRunId(runId);
  const mem = runs.get(runId);
  if (mem) return mem;
  const p = statusPath(runId);
  if (!existsSync(p)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as PersistedStatus;
    const resultPath = join(runsDir(), runId, "result", "result.json");
    let result: DelegateResult | undefined;
    if (existsSync(resultPath)) {
      result = JSON.parse(readFileSync(resultPath, "utf8")) as DelegateResult;
    }
    return {
      ...raw,
      result,
      abort: new AbortController(),
    };
  } catch {
    return undefined;
  }
}

export function startRun(opts: {
  config: AppConfig;
  request: Omit<DelegateRequest, "config" | "signal" | "onProgress">;
  batchId?: string;
  roleId?: string;
  runId?: string;
}): { runId: string; status: "running" } {
  const dirs = createRunDirs(opts.runId ?? randomUUID());
  const abort = new AbortController();
  const now = Date.now();
  const record: RunRecord = {
    runId: dirs.runId,
    batchId: opts.batchId,
    roleId: opts.roleId,
    status: "running",
    createdAt: now,
    updatedAt: now,
    progress: { phase: "init" },
    abort,
  };
  runs.set(dirs.runId, record);
  lastHeartbeatMs.set(dirs.runId, now);
  persist(record);

  void (async () => {
    try {
      const result = await runDelegation({
        ...opts.request,
        config: opts.config,
        signal: abort.signal,
        runId: dirs.runId,
        onProgress: (progress) => updateRunProgress(dirs.runId, progress),
      });
      record.result = result;
      record.status =
        result.status === "success"
          ? "success"
          : result.status === "cancelled"
            ? "cancelled"
            : result.status === "incomplete"
              ? "incomplete"
              : "failed";
      record.progress = { phase: "done", agentStarted: true };
      record.updatedAt = Date.now();
      saveResultJson(dirs, result);
      persist(record);
    } catch (err) {
      if (abort.signal.aborted) {
        record.status = "cancelled";
      } else if (err instanceof DelegateError) {
        record.status = err.infrastructure ? "failed" : "incomplete";
        record.error = { code: err.code, message: err.message };
      } else {
        record.status = "failed";
        record.error = {
          code: "internal_error",
          message: err instanceof Error ? err.message : String(err),
        };
      }
      record.updatedAt = Date.now();
      persist(record);
    } finally {
      lastHeartbeatMs.delete(dirs.runId);
    }
  })();

  return { runId: dirs.runId, status: "running" };
}

export function cancelRun(runId: string): RunRecord {
  assertSafeRunId(runId);
  const record = getRun(runId);
  if (!record) {
    throw new DelegateError(`Unknown runId: ${runId}`, "run_not_found", true);
  }
  const mem = runs.get(runId);
  if (mem && (mem.status === "running" || mem.status === "queued")) {
    mem.abort.abort();
    mem.status = "cancelled";
    mem.updatedAt = Date.now();
    persist(mem);
    return mem;
  }
  if (record.status === "running" || record.status === "queued") {
    record.status = "cancelled";
    record.updatedAt = Date.now();
    persist(record);
  }
  return record;
}

export type RunPublicView = "status" | "full";

export function runToPublic(
  record: RunRecord,
  view: RunPublicView = "full",
): Record<string, unknown> {
  const elapsedMs = Date.now() - record.createdAt;
  const terminal =
    record.status !== "running" && record.status !== "queued";
  const base: Record<string, unknown> = {
    runId: record.runId,
    batchId: record.batchId,
    roleId: record.roleId,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    elapsedMs,
    progress: record.progress,
    error: record.error,
    poll: "get_run",
    pollAfterSeconds: pollAfterSeconds(record.status, elapsedMs),
  };
  if (!terminal) {
    base.hint = POLL_HINT;
  }
  if (view === "status") {
    return base;
  }
  return {
    ...base,
    result: record.result ?? null,
  };
}

export { startedRunPublic };

/**
 * On MCP server start, mark persisted running/queued runs as failed.
 * In-process sessions cannot survive a restart.
 */
export function reconcileOrphanedRuns(): number {
  if (!existsSync(runsDir())) return 0;
  let count = 0;
  for (const name of readdirSync(runsDir())) {
    const p = statusPath(name);
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, "utf8")) as PersistedStatus;
      if (raw.status === "running" || raw.status === "queued") {
        raw.status = "failed";
        raw.updatedAt = Date.now();
        raw.error = {
          code: "server_restarted",
          message: "MCP server restarted while run was in progress",
        };
        writeFileSync(p, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
        count++;
      }
    } catch {
      // ignore corrupt status
    }
  }
  return count;
}
