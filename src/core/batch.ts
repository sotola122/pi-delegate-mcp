import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import type { AppConfig, ProfileName, Effort, AllowedModel } from "../config/schema.js";
import type { Lens } from "../prompt/assembler.js";
import { DelegateError } from "./errors.js";
import { assertSafeRunId } from "./ids.js";
import { startRun, getRun, cancelRun, type RunRecord } from "./run-registry.js";
import { runsDir } from "../config/paths.js";
import { gitRoot } from "../workspace/git.js";
import {
  createDetachedWorktree,
  materializeDirtyState,
  removeWorktree,
} from "../workspace/worktree.js";
import { applyPatchToWorkspace } from "../workspace/patch.js";

export interface BatchTaskSpec {
  roleId: string;
  profile: ProfileName;
  objective: string;
  reviewKind?: "change-review" | "static-hunt";
  baseline?: string;
  inScope?: string[];
  outOfScope?: string[];
  acceptanceChecks?: string[];
  suggestedChecks?: string[];
  lenses?: Lens[];
  focus?: string[];
  effort?: Effort;
  model?: AllowedModel;
  attachments?: string[];
  childSkills?: string[];
  workspaceMode?: "auto" | "in-place" | "worktree";
  delivery?: "patch" | "apply";
  timeoutSeconds?: number;
  manualPrompt?: string;
  promptMode?: "append" | "replace";
}

export interface BatchSpec {
  batchId?: string;
  workspace?: string;
  mcpRoots?: string[];
  execution: "parallel" | "sequential";
  tasks: BatchTaskSpec[];
  config: AppConfig;
}

export interface BatchChild {
  roleId: string;
  runId: string;
}

export interface BatchRecord {
  batchId: string;
  execution: "parallel" | "sequential";
  workspace?: string;
  children: BatchChild[];
  /** All roleIds declared at start — used to detect incomplete launch waves. */
  plannedRoleIds: string[];
  /** Roles never launched because orchestration stopped early. */
  skippedRoleIds: string[];
  /** True once the coordinator finished launching (or stopped) every planned role. */
  orchestrationComplete: boolean;
  createdAt: number;
  updatedAt: number;
  /** Shared worktree used to chain implement → later roles (if any). */
  pipelineWorktree?: string;
}

function markSkippedRoles(batch: BatchRecord): void {
  const launched = new Set(batch.children.map((c) => c.roleId));
  const skipped = (batch.plannedRoleIds ?? []).filter((id) => !launched.has(id));
  batch.skippedRoleIds = [...new Set([...(batch.skippedRoleIds ?? []), ...skipped])];
}

function cleanupPipelineWorktree(batch: BatchRecord): void {
  if (!batch.pipelineWorktree || !batch.workspace) return;
  const root = gitRoot(batch.workspace);
  if (root) {
    try {
      removeWorktree(root, batch.pipelineWorktree);
    } catch {
      // best-effort
    }
  }
  batch.pipelineWorktree = undefined;
}

/** Map origin workspace to the corresponding path inside a repo-root worktree. */
export function pipelineExecCwd(
  worktreeRoot: string,
  originWorkspace: string,
  repoRoot: string,
): string {
  const rel = relative(repoRoot, originWorkspace);
  if (!rel || rel === ".") return worktreeRoot;
  if (rel.startsWith("..")) return worktreeRoot;
  return join(worktreeRoot, rel);
}

const batches = new Map<string, BatchRecord>();
const HARD_MAX_TASKS = 8;

function isWritableProfile(profile: ProfileName): boolean {
  return profile === "verify" || profile === "implement";
}

/** Split sequential roles: writable barriers; consecutive read-only → parallel groups. */
export function groupTasksForExecution(
  tasks: BatchTaskSpec[],
  execution: "parallel" | "sequential",
): BatchTaskSpec[][] {
  if (execution === "parallel") return [tasks];
  const groups: BatchTaskSpec[][] = [];
  let readOnlyBuf: BatchTaskSpec[] = [];
  const flush = () => {
    if (readOnlyBuf.length) {
      groups.push(readOnlyBuf);
      readOnlyBuf = [];
    }
  };
  for (const t of tasks) {
    if (isWritableProfile(t.profile)) {
      flush();
      groups.push([t]);
    } else {
      readOnlyBuf.push(t);
    }
  }
  flush();
  return groups;
}

function batchPath(batchId: string): string {
  assertSafeRunId(batchId, "batchId");
  return join(runsDir(), batchId, "batch.json");
}

function persistBatch(batch: BatchRecord): void {
  const dir = join(runsDir(), batch.batchId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(batchPath(batch.batchId), JSON.stringify(batch, null, 2) + "\n", {
    mode: 0o600,
  });
}

export function getBatch(batchId: string): BatchRecord | undefined {
  assertSafeRunId(batchId, "batchId");
  const mem = batches.get(batchId);
  if (mem) return mem;
  const p = batchPath(batchId);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as BatchRecord;
  } catch {
    return undefined;
  }
}

function maxTasks(config: AppConfig): number {
  return Math.min(HARD_MAX_TASKS, config.concurrency.global);
}

function launchTask(
  batchId: string,
  task: BatchTaskSpec,
  spec: BatchSpec,
  workspaceOverride?: string,
): BatchChild {
  const started = startRun({
    config: spec.config,
    batchId,
    roleId: task.roleId,
    request: {
      profile: task.profile,
      objective: task.objective,
      workspace: workspaceOverride ?? spec.workspace,
      mcpRoots: spec.mcpRoots,
      reviewKind: task.reviewKind,
      baseline: task.baseline,
      inScope: task.inScope,
      outOfScope: task.outOfScope,
      acceptanceChecks: task.acceptanceChecks,
      suggestedChecks: task.suggestedChecks,
      lenses: task.lenses,
      focus: task.focus,
      effort: task.effort,
      model: task.model,
      attachments: task.attachments,
      childSkills: task.childSkills,
      workspaceMode: task.workspaceMode,
      delivery: task.delivery,
      timeoutSeconds: task.timeoutSeconds,
      manualPrompt: task.manualPrompt,
      promptMode: task.promptMode,
    },
  });
  return { roleId: task.roleId, runId: started.runId };
}

async function waitRunTerminal(runId: string): Promise<RunRecord> {
  for (;;) {
    const r = getRun(runId);
    if (!r) {
      throw new DelegateError(`Run disappeared: ${runId}`, "run_not_found", true);
    }
    if (
      r.status === "success" ||
      r.status === "incomplete" ||
      r.status === "failed" ||
      r.status === "cancelled"
    ) {
      return r;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/**
 * After a successful implement, point subsequent roles at a workspace that
 * includes the implement result (apply already mutated original; patch →
 * shared worktree with patch applied).
 */
export function advancePipelineWorkspace(opts: {
  batchId: string;
  originWorkspace: string | undefined;
  currentPipeline: string | undefined;
  pipelineWorktree: string | undefined;
  prevResults: RunRecord[];
}): { pipelineWorkspace: string | undefined; pipelineWorktree: string | undefined } {
  let pipelineWorkspace = opts.currentPipeline ?? opts.originWorkspace;
  let pipelineWorktree = opts.pipelineWorktree;

  for (const r of opts.prevResults) {
    if (r.status !== "success" || r.result?.profile !== "implement") continue;
    const result = r.result;
    if (result.delivery === "apply") {
      // Original workspace already has the edits.
      pipelineWorkspace = opts.originWorkspace;
      continue;
    }
    const patchArt = result.artifacts.find((a) => a.kind === "result.patch");
    if (!patchArt?.path || !opts.originWorkspace) continue;

    const repoRoot = gitRoot(opts.originWorkspace);
    if (!repoRoot) {
      throw new DelegateError(
        "Cannot chain implement→next without a git workspace",
        "pipeline_no_git",
        true,
      );
    }

    if (!pipelineWorktree) {
      const wt = createDetachedWorktree(
        repoRoot,
        `${opts.batchId}-pipeline`,
      );
      materializeDirtyState(opts.originWorkspace, wt.path);
      pipelineWorktree = wt.path;
    }

    applyPatchToWorkspace(pipelineWorktree, patchArt.path);
    pipelineWorkspace = pipelineExecCwd(
      pipelineWorktree,
      opts.originWorkspace,
      repoRoot,
    );
  }

  return { pipelineWorkspace, pipelineWorktree };
}

function validateBatchSpec(spec: BatchSpec): void {
  if (!spec.tasks.length) {
    throw new DelegateError("Batch requires at least one task", "batch_empty", true);
  }
  const limit = maxTasks(spec.config);
  if (spec.tasks.length > limit) {
    throw new DelegateError(
      `Batch exceeds max tasks (${spec.tasks.length} > ${limit})`,
      "batch_too_large",
      true,
    );
  }
  const roleIds = new Set<string>();
  for (const t of spec.tasks) {
    if (!t.roleId.trim()) {
      throw new DelegateError("roleId is required", "role_id_required", true);
    }
    if (roleIds.has(t.roleId)) {
      throw new DelegateError(
        `Duplicate roleId: ${t.roleId}`,
        "duplicate_role_id",
        true,
      );
    }
    roleIds.add(t.roleId);
    if (t.profile === "verify" && !(t.acceptanceChecks?.length)) {
      throw new DelegateError(
        `Batch task ${t.roleId} (verify) requires acceptanceChecks`,
        "batch_contract",
        true,
      );
    }
    if (t.profile === "implement") {
      if (!(t.inScope?.length)) {
        throw new DelegateError(
          `Batch task ${t.roleId} (implement) requires inScope`,
          "batch_contract",
          true,
        );
      }
      if (!(t.acceptanceChecks?.length)) {
        throw new DelegateError(
          `Batch task ${t.roleId} (implement) requires acceptanceChecks`,
          "batch_contract",
          true,
        );
      }
    }
  }
}

/**
 * Launch batch immediately. First wave starts now; later sequential groups
 * wait for prior wave. Consecutive read-only roles in sequential mode run in parallel.
 * After successful implement (patch delivery), later roles use a shared worktree
 * with the result patch applied.
 */
export function startBatch(spec: BatchSpec): {
  batchId: string;
  status: "running";
  runs: BatchChild[];
  poll: "get_batch";
} {
  validateBatchSpec(spec);
  const batchId = assertSafeRunId(spec.batchId ?? randomUUID(), "batchId");
  const now = Date.now();
  const batch: BatchRecord = {
    batchId,
    execution: spec.execution,
    workspace: spec.workspace,
    children: [],
    plannedRoleIds: spec.tasks.map((t) => t.roleId),
    skippedRoleIds: [],
    orchestrationComplete: false,
    createdAt: now,
    updatedAt: now,
  };
  batches.set(batchId, batch);

  const groups = groupTasksForExecution(spec.tasks, spec.execution);
  const first = groups[0] ?? [];
  for (const task of first) {
    batch.children.push(launchTask(batchId, task, spec));
  }
  const remaining = groups.slice(1);
  if (!remaining.length) {
    batch.orchestrationComplete = true;
  }
  persistBatch(batch);

  if (remaining.length) {
    void (async () => {
      let prevIds = batch.children.map((c) => c.runId);
      let pipelineWorkspace: string | undefined = spec.workspace;
      let pipelineWorktree: string | undefined;
      try {
        for (const group of remaining) {
          const prevResults = await Promise.all(
            prevIds.map((id) => waitRunTerminal(id)),
          );
          const stop = prevResults.some((r) => {
            if (r.status === "failed" || r.status === "cancelled") return true;
            const child = batch.children.find((c) => c.runId === r.runId);
            const task = spec.tasks.find((t) => t.roleId === child?.roleId);
            return (
              r.status === "incomplete" &&
              !!task &&
              isWritableProfile(task.profile)
            );
          });
          if (stop) {
            markSkippedRoles(batch);
            break;
          }

          const advanced = advancePipelineWorkspace({
            batchId,
            originWorkspace: spec.workspace,
            currentPipeline: pipelineWorkspace,
            pipelineWorktree,
            prevResults,
          });
          pipelineWorkspace = advanced.pipelineWorkspace;
          pipelineWorktree = advanced.pipelineWorktree;
          batch.pipelineWorktree = pipelineWorktree;

          const launched = group.map((task) =>
            launchTask(batchId, task, spec, pipelineWorkspace),
          );
          batch.children.push(...launched);
          batch.updatedAt = Date.now();
          persistBatch(batch);
          prevIds = launched.map((c) => c.runId);
        }
      } finally {
        markSkippedRoles(batch);
        batch.orchestrationComplete = true;
        // Wait for any still-running children before cleanup, then drop pipeline WT.
        try {
          await Promise.all(
            batch.children.map((c) => waitRunTerminal(c.runId).catch(() => undefined)),
          );
        } catch {
          // ignore
        }
        cleanupPipelineWorktree(batch);
        batch.updatedAt = Date.now();
        persistBatch(batch);
      }
    })();
  }

  return {
    batchId,
    status: "running",
    runs: [...batch.children],
    poll: "get_batch",
  };
}

export function cancelBatch(batchId: string): BatchRecord {
  const batch = getBatch(batchId);
  if (!batch) {
    throw new DelegateError(`Unknown batchId: ${batchId}`, "batch_not_found", true);
  }
  for (const child of batch.children) {
    try {
      cancelRun(child.runId);
    } catch {
      // ignore
    }
  }
  markSkippedRoles(batch);
  cleanupPipelineWorktree(batch);
  batch.orchestrationComplete = true;
  batch.updatedAt = Date.now();
  persistBatch(batch);
  return batch;
}

export function batchToPublic(batch: BatchRecord): Record<string, unknown> {
  const skipped = batch.skippedRoleIds ?? [];
  const runs: Array<Record<string, unknown>> = batch.children.map((c) => {
    const r = getRun(c.runId);
    return {
      roleId: c.roleId,
      runId: c.runId,
      status: r?.status ?? "unknown",
      result: r?.result,
      error: r?.error,
    };
  });
  for (const roleId of skipped) {
    if (!runs.some((r) => r.roleId === roleId)) {
      runs.push({ roleId, status: "skipped" });
    }
  }
  const childStatuses = batch.children.map((c) => getRun(c.runId)?.status ?? "unknown");
  const planned = batch.plannedRoleIds ?? [];
  // Once the coordinator has finished (launched all or stopped early), derive a
  // terminal status from launched children — do not require launchedAll.
  const orchestrationDone = batch.orchestrationComplete === true;

  let status = "running";
  if (!orchestrationDone) {
    status = "running";
  } else if (childStatuses.some((s) => s === "running" || s === "queued")) {
    status = "running";
  } else if (childStatuses.length === 0) {
    status = "incomplete";
  } else if (
    childStatuses.every((s) => s === "success") &&
    skipped.length === 0
  ) {
    status = "success";
  } else if (childStatuses.some((s) => s === "failed")) {
    status = "failed";
  } else if (childStatuses.some((s) => s === "cancelled")) {
    status = "cancelled";
  } else {
    status = "incomplete";
  }

  return {
    batchId: batch.batchId,
    status,
    execution: batch.execution,
    workspace: batch.workspace,
    pipelineWorktree: batch.pipelineWorktree,
    plannedRoleIds: planned,
    skippedRoleIds: skipped,
    orchestrationComplete: orchestrationDone,
    runs,
    poll: "get_batch",
  };
}
