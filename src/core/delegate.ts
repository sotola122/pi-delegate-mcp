import type { AppConfig, Effort, AllowedModel, ProfileName } from "../config/schema.js";
import { DelegateError } from "./errors.js";
import { resolveProvider, loadProviderFile } from "./provider.js";
import {
  parseAcceptanceEvidence,
  type DelegateResult,
} from "./result.js";
import { assemblePrompt, type Lens, type Modality } from "../prompt/assembler.js";
import { assertManualAllowed } from "../prompt/manual.js";
import { validateManualPrompt } from "../prompt/validator.js";
import {
  detectModalitiesFromAttachments,
  mergeModalities,
  assertVisionCapableModel,
} from "../prompt/multimodal.js";
import { resolveWorkspace, validateAttachmentPaths, assertGitRootAllowed } from "../workspace/roots.js";
import {
  materializeChildSkills,
  validateChildSkills,
} from "../workspace/child-skills.js";
import { gitRoot, gitIsDirty, gitHead } from "../workspace/git.js";
import { buildChangeManifest } from "../workspace/manifest.js";
import {
  createDetachedWorktree,
  materializeDirtyState,
  removeWorktree,
  captureTreeFingerprint,
  fingerprintsDiffer,
} from "../workspace/worktree.js";
import { diffWorktreeToPatch, applyPatchToWorkspace, snapshotWorktreeTree } from "../workspace/patch.js";
import { canApplyDelivery } from "../workspace/scope.js";
import { acquireLock, type LockHandle } from "../workspace/lock.js";
import {
  createRunDirs,
  saveSdkDiagnostics,
  saveResultJson,
  maybeSavePrompt,
} from "../artifacts/manager.js";
import { redactSecrets } from "../artifacts/redact.js";
import { join, relative } from "node:path";
import { getPiExecutor } from "../pi-sdk/factory.js";
import { mapProfileToSdkTools } from "../pi-sdk/profile-mapper.js";
import type { PiExecutor, ThinkingLevel } from "../pi-sdk/types.js";
import {
  finalizeStatusFromOutcome,
  type AttemptRecord,
} from "./result.js";
import type { ProgressCallback } from "./progress.js";

export interface DelegateRequest {
  profile: ProfileName;
  objective: string;
  workspace?: string;
  mcpRoots?: string[];
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
  modalities?: Modality[];
  imageInputPlanned?: boolean;
  useImplementAlternate?: boolean;
  signal?: AbortSignal;
  config: AppConfig;
  /** Reuse a pre-allocated run directory / id (async MCP). */
  runId?: string;
  /** Test / advanced injection of Pi executor. */
  executor?: PiExecutor;
  /** Heartbeat for async MCP get_run status view. */
  onProgress?: ProgressCallback;
}

function defaultTimeout(config: AppConfig, profile: ProfileName): number {
  return config.limits.timeoutSeconds[profile];
}

export async function runDelegation(
  req: DelegateRequest,
): Promise<DelegateResult> {
  const started = Date.now();
  const dirs = createRunDirs(req.runId);
  const artifacts: DelegateResult["artifacts"] = [];
  const attempts: DelegateResult["attempts"] = [];
  let locks: LockHandle[] = [];
  let cleanupWorktree: { repoRoot: string; path: string } | undefined;
  let retainWorktree = false;

  try {
    // Manual policy
    if (req.manualPrompt !== undefined) {
      assertManualAllowed(req.config, req.profile, req.promptMode ?? "append");
      validateManualPrompt(req.manualPrompt);
    }

    // Profile enabled?
    const profileKey = req.profile === "no-tools" ? "no-tools" : req.profile;
    const profileCfg =
      profileKey === "no-tools"
        ? req.config.profiles["no-tools"]
        : req.config.profiles[profileKey];
    if (!profileCfg.enabled) {
      throw new DelegateError(
        `Profile disabled: ${req.profile}`,
        "profile_disabled",
        true,
      );
    }

    const needsWorkspace = req.profile !== "no-tools";
    let workspace: string | undefined;
    if (needsWorkspace) {
      workspace = resolveWorkspace({
        workspace: req.workspace,
        mcpRoots: req.mcpRoots,
        config: req.config,
      });
    }

    const attachments = validateAttachmentPaths(
      workspace,
      req.attachments ?? [],
      req.config,
    );
    const validatedSkills = validateChildSkills(
      req.childSkills,
      req.config,
      workspace,
    );
    const childSkillsDir = join(dirs.input, "child-skills");
    const childSkills = materializeChildSkills(validatedSkills, childSkillsDir);
    if (childSkills.length) {
      artifacts.push({ kind: "child-skills", path: childSkillsDir });
    }

    const detectedModalities = detectModalitiesFromAttachments(
      attachments,
      req.config,
    );
    if (req.modalities?.includes("browser") && !req.config.multimodal.browserEnabled) {
      throw new DelegateError(
        "Browser modality is disabled (enable multimodal.browserEnabled)",
        "browser_disabled",
        true,
      );
    }
    const modalities = mergeModalities(req.modalities, detectedModalities);
    const imagePlanned =
      req.imageInputPlanned || modalities.includes("vision");

    if (imagePlanned) {
      const preview = resolveProvider({
        config: req.config,
        profile: req.profile,
        effort: req.effort,
        model: req.model,
        imageInputPlanned: true,
        useImplementAlternate: req.useImplementAlternate,
      });
      assertVisionCapableModel(preview.model);
    }

    // Concurrency locks for writable profiles
    if (req.profile === "verify" || req.profile === "implement") {
      const wsKey = workspace ?? "none";
      locks.push(await acquireLock(`writable:${wsKey}`));
      locks.push(await acquireLock(req.profile));
    }

    // Workspace mode
    let workspaceMode: "in-place" | "worktree" = "in-place";
    let execCwd = workspace;
    let worktreePath: string | undefined;
    let baselineSha: string | undefined;
    /** Tree id after dirty materialization — agent-delta baseline. */
    let initialTreeSha: string | undefined;
    const repoRoot = workspace ? gitRoot(workspace) : null;
    if (workspace && repoRoot) {
      assertGitRootAllowed(workspace, repoRoot, req.config);
    }
    const workspaceRel =
      workspace && repoRoot ? relative(repoRoot, workspace) : "";

    if (req.profile === "implement") {
      workspaceMode = "worktree";
    } else if (req.profile === "verify") {
      const mode = req.workspaceMode ?? "auto";
      if (mode === "worktree") workspaceMode = "worktree";
      else if (mode === "in-place") workspaceMode = "in-place";
      else {
        workspaceMode =
          workspace && repoRoot && gitIsDirty(workspace) ? "worktree" : "in-place";
      }
    }

    if (workspaceMode === "worktree") {
      if (!workspace || !repoRoot) {
        throw new DelegateError(
          "Worktree requires a git workspace",
          "worktree_requires_git",
          true,
        );
      }
      baselineSha = gitHead(workspace) ?? undefined;
      try {
        const wt = createDetachedWorktree(repoRoot, dirs.runId, baselineSha);
        worktreePath = wt.path;
        cleanupWorktree = { repoRoot, path: worktreePath };
        if (gitIsDirty(workspace)) {
          materializeDirtyState(workspace, worktreePath);
        }
        initialTreeSha = snapshotWorktreeTree(worktreePath);
        execCwd =
          workspaceRel && workspaceRel !== "."
            ? join(worktreePath, workspaceRel)
            : worktreePath;
      } catch (err) {
        if (worktreePath && repoRoot) {
          try {
            removeWorktree(repoRoot, worktreePath);
          } catch {
            // best-effort cleanup
          }
          worktreePath = undefined;
          cleanupWorktree = undefined;
        }
        const allowFallback =
          req.profile === "verify" &&
          req.config.workspace.allowInPlaceVerifyFallback;
        if (!allowFallback) {
          throw new DelegateError(
            `Worktree materialization failed: ${err instanceof Error ? err.message : String(err)}`,
            "worktree_materialize_failed",
            true,
          );
        }
        workspaceMode = "in-place";
        execCwd = workspace;
      }
    }

    // Change manifest for change-review
    let manifestAttachments: string[] = [];
    if (req.profile === "review" && req.reviewKind === "change-review" && workspace) {
      const manifest = buildChangeManifest(
        workspace,
        dirs.input,
        req.baseline,
        req.inScope,
      );
      artifacts.push({ kind: "manifest", path: manifest.manifestPath });
      artifacts.push({ kind: "tracked.patch", path: manifest.trackedPatchPath });
      manifestAttachments = [manifest.manifestPath, manifest.trackedPatchPath];
      baselineSha = manifest.baselineSha;
    }

    const delivery =
      req.profile === "implement" ? (req.delivery ?? "patch") : "none";
    if (delivery === "apply" && !req.config.profiles.implement.allowApplyToWorkspace) {
      throw new DelegateError(
        "delivery=apply is disabled in config",
        "apply_disabled",
        true,
      );
    }

    const beforeFp =
      req.profile === "verify" && workspace
        ? captureTreeFingerprint(workspace)
        : undefined;

    const providerFile = loadProviderFile();
    const maxAttempts =
      req.profile === "implement" ? providerFile.retry.max_attempts : 1;

    let lastOutput = "";
    let lastResolved = resolveProvider({
      config: req.config,
      profile: req.profile,
      effort: req.effort,
      model: req.model,
      imageInputPlanned: imagePlanned,
      useImplementAlternate: req.useImplementAlternate,
    });
    let cancelled = false;
    let lastCompletion = "completed";
    let lastAgentStarted = true;
    let lastAgentEnded = true;
    const piExecutor =
      req.executor ?? (await getPiExecutor(req.config));
    const toolProfile = mapProfileToSdkTools(req.profile);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const useAlternate =
        attempt > 0 ||
        req.useImplementAlternate ||
        (req.profile === "implement" &&
          !req.model &&
          (req.inScope?.length ?? 0) >= 5);

      // Fresh worktree on retry
      if (attempt > 0 && req.profile === "implement" && workspace && repoRoot) {
        if (worktreePath) removeWorktree(repoRoot, worktreePath);
        const wt = createDetachedWorktree(repoRoot, `${dirs.runId}-r${attempt}`, baselineSha);
        worktreePath = wt.path;
        cleanupWorktree = { repoRoot, path: worktreePath };
        if (gitIsDirty(workspace)) materializeDirtyState(workspace, worktreePath);
        initialTreeSha = snapshotWorktreeTree(worktreePath);
        execCwd =
          workspaceRel && workspaceRel !== "."
            ? join(worktreePath, workspaceRel)
            : worktreePath;
      }

      lastResolved = resolveProvider({
        config: req.config,
        profile: req.profile,
        effort: req.effort,
        model: req.model,
        imageInputPlanned: imagePlanned,
        useImplementAlternate: useAlternate && !req.model,
      });

      const task = {
        objective: req.objective,
        profile: req.profile,
        review_kind: req.reviewKind,
        workspace: execCwd,
        workspace_mode: workspaceMode,
        baseline: baselineSha,
        in_scope: req.inScope,
        out_of_scope: req.outOfScope,
        acceptance_checks: req.acceptanceChecks ?? req.suggestedChecks,
        focus: req.focus,
        allowed_task_side_effects:
          req.profile === "implement"
            ? ["edit", "write", "bash"]
            : req.profile === "verify"
              ? ["bash"]
              : [],
        attachments: [...attachments, ...manifestAttachments],
        cli_attachments: [...attachments, ...manifestAttachments],
        delivery: delivery === "none" ? undefined : delivery,
        modalities,
      };

      const prompt = assemblePrompt({
        profile: req.profile,
        task,
        lenses: req.lenses,
        modalities,
        manualPrompt: req.manualPrompt,
        promptMode: req.promptMode,
        maxBytes: req.config.limits.maxPromptBytes,
      });

      const promptPath = maybeSavePrompt(req.config, dirs, prompt);
      if (promptPath) artifacts.push({ kind: "prompt", path: promptPath });

      const timeoutSec =
        req.timeoutSeconds ?? defaultTimeout(req.config, req.profile);

      req.onProgress?.({ phase: "init" });

      const outcome = await piExecutor.execute(
        {
          runId: dirs.runId,
          attempt,
          cwd: execCwd,
          profile: req.profile,
          provider: lastResolved.provider,
          model: lastResolved.model,
          thinking: lastResolved.thinking as ThinkingLevel,
          tools: toolProfile.tools,
          excludeTools: toolProfile.excludeTools,
          noTools: toolProfile.noTools,
          prompt,
          attachmentPaths: [...attachments, ...manifestAttachments],
          textAttachments: [],
          imageAttachments: [],
          childSkillPaths: childSkills,
          policy: {
            profile: req.profile,
            workspace: execCwd,
            inScope: req.inScope,
            outOfScope: req.outOfScope,
            // Materialized skills live under dirs.input; keep that root readable
            // even when workspace.allowedRoots is empty / narrow.
            artifactRoots: [
              dirs.root,
              dirs.input,
              dirs.result,
              ...(childSkills.length ? [childSkillsDir] : []),
            ],
            allowedRoots: req.config.workspace.allowedRoots,
          },
          timeoutMs: timeoutSec * 1000,
          config: req.config,
          structuredCompletion: imagePlanned || modalities.includes("vision"),
          onProgress: req.onProgress,
        },
        req.signal ?? new AbortController().signal,
      );

      const sdkArts = saveSdkDiagnostics(dirs, {
        eventSummaryJsonl: outcome.eventsJsonl,
        diagnostics: outcome.diagnostics,
        toolSummary: {
          toolCalls: outcome.toolCalls,
          count: outcome.toolCalls.length,
          failures: outcome.toolCalls.filter((t) => t.isError).length,
        },
        finalOutput: outcome.finalText,
        maxEventMetadataBytes: req.config.limits.maxEventMetadataBytes,
        maxFinalOutputBytes: req.config.limits.maxFinalOutputBytes,
      });
      artifacts.push(...sdkArts);

      lastOutput = outcome.finalText;
      cancelled = Boolean(outcome.cancelled) || outcome.completion === "cancelled";
      lastCompletion = outcome.completion;
      lastAgentStarted = outcome.agentStarted;
      lastAgentEnded = outcome.agentEnded;

      const attemptRec: AttemptRecord = {
        backend: outcome.backend,
        sdkVersion: outcome.sdkVersion,
        provider: outcome.model.provider,
        model: outcome.model.id,
        thinking: outcome.model.thinking,
        completion: outcome.completion,
        agentStarted: outcome.agentStarted,
        agentEnded: outcome.agentEnded,
        toolCalls: outcome.toolCalls.length,
        toolFailures: outcome.toolCalls.filter((t) => t.isError).length,
        exitCode: outcome.exitCode ?? null,
        status: outcome.timedOut
          ? "timeout"
          : outcome.cancelled
            ? "cancelled"
            : outcome.completion,
        durationMs: outcome.durationMs,
        error: outcome.error,
      };
      attempts.push(attemptRec);

      // Never retry after cancel / timeout / abort
      if (
        outcome.cancelled ||
        outcome.timedOut ||
        outcome.completion === "cancelled" ||
        outcome.completion === "timeout" ||
        req.signal?.aborted
      ) {
        break;
      }

      if (req.profile === "implement" && attempt + 1 < maxAttempts) {
        const missingHeading = !lastOutput.includes("# Implement Result");
        const retryableFailure =
          outcome.completion === "incomplete" ||
          outcome.completion === "provider_error" ||
          outcome.completion === "tool_error" ||
          (outcome.completion === "completed" && missingHeading);
        if (retryableFailure || missingHeading) {
          continue;
        }
      }
      break;
    }

    lastOutput = redactSecrets(lastOutput);

    const checks = req.acceptanceChecks ?? [];
    const acceptance = parseAcceptanceEvidence(lastOutput, checks);
    let status = finalizeStatusFromOutcome({
      completion: lastCompletion,
      cancelled,
      output: lastOutput,
      profile: req.profile,
      acceptance,
      requireHeading: true,
      agentStarted: lastAgentStarted,
      agentEnded: lastAgentEnded,
    });
    if (
      lastCompletion === "incomplete" &&
      status === "success"
    ) {
      status = "incomplete";
    }

    // Delivery — patch always captured; apply only after successful finalize
    let deliveryResult: DelegateResult["delivery"] =
      delivery === "none" ? "none" : delivery;
    const patchBaseline = initialTreeSha ?? baselineSha;
    if (req.profile === "implement" && worktreePath && patchBaseline) {
      let patchPath: string;
      try {
        patchPath = diffWorktreeToPatch(
          worktreePath,
          dirs.result,
          patchBaseline,
          { inScope: req.inScope, outOfScope: req.outOfScope },
        );
        artifacts.push({ kind: "result.patch", path: patchPath });
      } catch (err) {
        retainWorktree = true;
        const resultPath = join(dirs.result, "result.json");
        const arts = [
          ...artifacts,
          { kind: "worktree", path: worktreePath },
          { kind: "result", path: resultPath },
        ];
        const result: DelegateResult = {
          runId: dirs.runId,
          status: "incomplete",
          profile: req.profile,
          provider: lastResolved.provider,
          model: lastResolved.model,
          thinking: lastResolved.thinking,
          workspace,
          workspaceMode,
          delivery: deliveryResult,
          output: lastOutput,
          acceptance,
          sideEffects: [],
          artifacts: arts,
          attempts,
          durationMs: Date.now() - started,
          code:
            err instanceof DelegateError ? err.code : "incomplete_patch",
          message: err instanceof Error ? err.message : String(err),
        };
        saveResultJson(dirs, result);
        return result;
      }

      if (canApplyDelivery(delivery, status) && workspace) {
        const retainedWorktree = worktreePath;
        try {
          applyPatchToWorkspace(workspace, patchPath);
          if (repoRoot && worktreePath) removeWorktree(repoRoot, worktreePath);
          worktreePath = undefined;
          cleanupWorktree = undefined;
        } catch (err) {
          retainWorktree = true;
          const resultPath = join(dirs.result, "result.json");
          const arts = [
            ...artifacts,
            ...(retainedWorktree
              ? [{ kind: "worktree", path: retainedWorktree }]
              : []),
            { kind: "result", path: resultPath },
          ];
          // Keep worktree; mark incomplete
          const result: DelegateResult = {
            runId: dirs.runId,
            status: "incomplete",
            profile: req.profile,
            provider: lastResolved.provider,
            model: lastResolved.model,
            thinking: lastResolved.thinking,
            workspace,
            workspaceMode,
            delivery: "apply",
            output: lastOutput,
            acceptance,
            sideEffects: [],
            artifacts: arts,
            attempts,
            durationMs: Date.now() - started,
            code: "apply_failed",
            message: err instanceof Error ? err.message : String(err),
          };
          saveResultJson(dirs, result);
          return result;
        }
      } else if (delivery === "apply" && worktreePath) {
        // Failed / cancelled / incomplete — never apply; retain worktree
        retainWorktree = true;
        artifacts.push({ kind: "worktree", path: worktreePath });
      }
    }

    // Verify: compare fingerprints (status + content hashes)
    const sideEffects: string[] = [];
    if (req.profile === "verify" && workspace && beforeFp) {
      const afterFp = captureTreeFingerprint(workspace);
      if (fingerprintsDiffer(beforeFp, afterFp)) {
        sideEffects.push("working_tree_changed");
      }
    }

    // Cleanup worktree for patch delivery / verify (unless deliberately retained)
    if (worktreePath && repoRoot && !retainWorktree && delivery !== "apply") {
      if (req.profile === "verify" || delivery === "patch") {
        try {
          removeWorktree(repoRoot, worktreePath);
          worktreePath = undefined;
          cleanupWorktree = undefined;
        } catch {
          artifacts.push({ kind: "worktree", path: worktreePath! });
          retainWorktree = true;
        }
      }
    }

    const resultPath = join(dirs.result, "result.json");
    artifacts.push({ kind: "result", path: resultPath });
    const result: DelegateResult = {
      runId: dirs.runId,
      status,
      profile: req.profile,
      provider: lastResolved.provider,
      model: lastResolved.model,
      thinking: lastResolved.thinking,
      workspace,
      workspaceMode,
      delivery: deliveryResult,
      output: lastOutput,
      acceptance,
      sideEffects,
      artifacts: [...artifacts],
      attempts,
      durationMs: Date.now() - started,
    };
    saveResultJson(dirs, result);
    return result;
  } catch (err) {
    if (err instanceof DelegateError && !err.infrastructure) {
      const resultPath = join(dirs.result, "result.json");
      artifacts.push({ kind: "result", path: resultPath });
      const result: DelegateResult = {
        runId: dirs.runId,
        status: "incomplete",
        profile: req.profile,
        provider: "",
        model: "",
        thinking: "",
        output: "",
        acceptance: [],
        sideEffects: [],
        artifacts: [...artifacts],
        attempts,
        durationMs: Date.now() - started,
        code: err.code,
        message: err.message,
      };
      saveResultJson(dirs, result);
      return result;
    }
    throw err;
  } finally {
    if (cleanupWorktree && !retainWorktree) {
      try {
        removeWorktree(cleanupWorktree.repoRoot, cleanupWorktree.path);
      } catch {
        // best-effort
      }
    }
    for (const lock of locks) lock.release();
  }
}
