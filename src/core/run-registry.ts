import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AppConfig, Effort, AllowedModel, ProfileName } from "../config/schema.js";
import {
  runDelegation,
  type DelegateRequest,
} from "./delegate.js";
import type { DelegateResult } from "./result.js";
import { createRunDirs, saveResultJson, writeArtifact } from "../artifacts/manager.js";
import { runsDir } from "../config/paths.js";
import { DelegateError } from "./errors.js";
import { assertSafeRunId } from "./ids.js";
import { pollAfterSeconds, startedRunPublic } from "./poll.js";
import type { RunProgress } from "./progress.js";
import { resolveProvider } from "./provider.js";
import { runSmokeTest } from "../pi-sdk/smoke.js";
import { prepareRunSession } from "./session-prepare.js";
import type { SessionLock } from "../pi-sdk/session-store.js";

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
  sessionId?: string;
  status: RunStatus;
  createdAt: number;
  updatedAt: number;
  progress?: RunProgress;
  result?: DelegateResult;
  error?: { code: string; message: string };
  abort: AbortController;
  sessionLock?: SessionLock;
}

interface PersistedStatus {
  runId: string;
  batchId?: string;
  roleId?: string;
  sessionId?: string;
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
    sessionId: record.sessionId,
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
  mem.sessionLock?.heartbeat();
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
}): { runId: string; status: "running"; sessionId?: string } {
  const runId = assertSafeRunId(opts.runId ?? randomUUID());
  const prepared =
    opts.request.sessionHandle !== undefined
      ? {
          handle: opts.request.sessionHandle,
          meta: opts.request.sessionMeta,
          lock: opts.request.sessionLock,
          destinationWorkspace: opts.request.destinationWorkspace,
        }
      : prepareRunSession({
          config: opts.config,
          taskName: opts.request.taskName,
          provider: opts.request.provider,
          model: opts.request.model,
          workspace: opts.request.workspace,
          destinationWorkspace: opts.request.destinationWorkspace,
          mcpRoots: opts.request.mcpRoots,
          sessionId: opts.request.sessionId,
          runId,
          agentType: opts.request.agentType,
        });
  const dirs = createRunDirs(runId);
  const sessionId =
    prepared.handle.kind === "memory" ? undefined : prepared.handle.sessionId;
  const abort = new AbortController();
  const now = Date.now();
  const record: RunRecord = {
    runId: dirs.runId,
    batchId: opts.batchId,
    roleId: opts.roleId,
    sessionId,
    status: "running",
    createdAt: now,
    updatedAt: now,
    progress: { phase: "init" },
    abort,
    sessionLock: prepared.lock,
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
        sessionHandle: prepared.handle,
        sessionMeta: prepared.meta,
        sessionLock: prepared.lock,
        destinationWorkspace: prepared.destinationWorkspace,
        onProgress: (progress) => {
          prepared.lock?.heartbeat();
          updateRunProgress(dirs.runId, progress);
        },
      });
      record.result = result;
      if (result.sessionId) record.sessionId = result.sessionId;
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
      try {
        prepared.lock?.release();
      } catch {
        // ignore
      }
      record.sessionLock = undefined;
    }
  })();

  return {
    runId: dirs.runId,
    status: "running",
    ...(sessionId ? { sessionId } : {}),
  };
}

export function startSmoke(opts: {
  config: AppConfig;
  mode: "provider-auth" | "planned-tuple";
  profile?: ProfileName;
  effort?: Effort;
  model?: AllowedModel;
  timeoutSeconds?: number;
  runId?: string;
}): { runId: string; status: "running" } {
  const dirs = createRunDirs(opts.runId ?? randomUUID());
  const abort = new AbortController();
  const now = Date.now();
  const record: RunRecord = {
    runId: dirs.runId,
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
    const startedAt = Date.now();
    try {
      const resolved =
        opts.mode === "planned-tuple"
          ? resolveProvider({
              config: opts.config,
              profile: opts.profile,
              effort: opts.effort,
              model: opts.model,
            })
          : undefined;
      const smoke = await runSmokeTest({
        config: opts.config,
        mode: opts.mode,
        resolved,
        timeoutSeconds: opts.timeoutSeconds,
        signal: abort.signal,
      });
      const durationMs = Date.now() - startedAt;
      const cancelled =
        abort.signal.aborted || record.status === "cancelled";
      const outputPath = join(dirs.result, "output.md");
      writeArtifact(outputPath, smoke.stdout ?? "");
      const resultPath = join(dirs.result, "result.json");
      const result: DelegateResult = {
        runId: dirs.runId,
        status: cancelled
          ? "cancelled"
          : smoke.ok
            ? "success"
            : "failed",
        taskName: "smoke",
        provider: smoke.provider,
        model: smoke.model,
        thinking: smoke.thinking,
        delivery: "none",
        output: smoke.stdout,
        acceptance: [
          {
            check: "stdout is exactly OK",
            status: cancelled ? "unknown" : smoke.ok ? "pass" : "fail",
            evidence: smoke.stdout.trim(),
          },
        ],
        sideEffects: [],
        artifacts: [
          { kind: "output", path: outputPath },
          { kind: "result", path: resultPath },
        ],
        attempts: [
          {
            backend:
              smoke.backend === "sdk" || smoke.backend === "fake"
                ? smoke.backend
                : "sdk",
            provider: smoke.provider,
            model: smoke.model,
            thinking: smoke.thinking,
            completion: cancelled
              ? "cancelled"
              : smoke.ok
                ? "completed"
                : "failed",
            agentStarted: !cancelled && smoke.ok,
            agentEnded: !cancelled && smoke.ok,
            toolCalls: 0,
            toolFailures: 0,
            exitCode: smoke.exitCode,
            status: cancelled
              ? "cancelled"
              : smoke.ok
                ? "completed"
                : "failed",
            durationMs,
            ...(smoke.ok || cancelled
              ? {}
              : {
                  error: {
                    code: "smoke_failed",
                    message: smoke.stderr.trim() || "stdout was not OK",
                  },
                }),
          },
        ],
        durationMs,
      };
      saveResultJson(dirs, result);
      record.result = result;
      record.status = result.status;
      record.progress = {
        phase: "done",
        agentStarted: !cancelled && smoke.ok,
      };
      record.updatedAt = Date.now();
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
    poll: "wait_agent",
    wait: pollAfterSeconds(record.status, elapsedMs),
  };
  if (record.sessionId) base.sessionId = record.sessionId;
  if (!terminal) {
    base.wait = pollAfterSeconds(record.status, elapsedMs);
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
