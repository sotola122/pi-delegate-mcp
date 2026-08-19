import type { AppConfig, Effort, AllowedModel } from "../config/schema.js";
import { DelegateError } from "./errors.js";
import {
  parseAcceptanceEvidence,
  finalizeStatusFromOutcome,
  type DelegateResult,
  type AttemptRecord,
} from "./result.js";
import { assembleChildPrompt } from "../prompt/child.js";
import {
  detectModalitiesFromAttachments,
  mergeModalities,
  assertVisionCapableModel,
} from "../prompt/multimodal.js";
import {
  resolveWorkspace,
  validateAttachmentPaths,
  assertGitRootAllowed,
} from "../workspace/roots.js";
import { gitRoot } from "../workspace/git.js";
import { acquireLock, type LockHandle } from "../workspace/lock.js";
import {
  createRunDirs,
  saveSdkDiagnostics,
  saveResultJson,
  maybeSavePrompt,
} from "../artifacts/manager.js";
import { redactSecrets } from "../artifacts/redact.js";
import { join } from "node:path";
import { getPiExecutor } from "../pi-sdk/factory.js";
import type { PiExecutor, ThinkingLevel } from "../pi-sdk/types.js";
import type { ProgressCallback } from "./progress.js";
import { prepareRunSession } from "./session-prepare.js";
import type { SessionHandle, SessionLock, SessionMeta } from "../pi-sdk/session-store.js";
import { loadProviderFile } from "./provider.js";
import type { Modality } from "../prompt/assembler.js";
import { validateChildSkills } from "../workspace/child-skills.js";
import { parsePiTools } from "../agents/resolve.js";
import { toolsAreWritable } from "../agents/types.js";

export interface DelegateRequest {
  taskName: string;
  message: string;
  prompt?: string;
  developerInstructions?: string;
  agentsMd?: string;
  tools: string[];
  noTools: boolean;
  provider: string;
  model: string;
  thinking: ThinkingLevel;
  effort?: Effort;
  workspace?: string;
  mcpRoots?: string[];
  attachments?: string[];
  childSkills?: string[];
  timeoutSeconds?: number;
  modalities?: Modality[];
  imageInputPlanned?: boolean;
  signal?: AbortSignal;
  config: AppConfig;
  runId?: string;
  executor?: PiExecutor;
  onProgress?: ProgressCallback;
  sessionId?: string;
  destinationWorkspace?: string;
  sessionHandle?: SessionHandle;
  sessionMeta?: SessionMeta;
  sessionLock?: SessionLock;
  agentType?: string;
  allowedModel?: AllowedModel;
}

function publicSessionId(handle?: SessionHandle): string | undefined {
  if (!handle || handle.kind === "memory") return undefined;
  return handle.sessionId;
}

function defaultTimeout(config: AppConfig): number {
  return config.limits.timeoutSeconds;
}

export async function runDelegation(
  req: DelegateRequest,
): Promise<DelegateResult> {
  const started = Date.now();
  const dirs = createRunDirs(req.runId);
  const artifacts: DelegateResult["artifacts"] = [];
  const attempts: DelegateResult["attempts"] = [];
  let locks: LockHandle[] = [];
  let ownSessionLock: SessionLock | undefined;
  const prepared =
    req.sessionHandle !== undefined
      ? {
          handle: req.sessionHandle,
          meta: req.sessionMeta,
          lock: req.sessionLock,
          destinationWorkspace: req.destinationWorkspace,
        }
      : prepareRunSession({
          config: req.config,
          taskName: req.taskName,
          provider: req.provider,
          model: req.model,
          workspace: req.workspace,
          destinationWorkspace: req.destinationWorkspace,
          mcpRoots: req.mcpRoots,
          sessionId: req.sessionId,
          runId: dirs.runId,
          agentType: req.agentType,
        });
  if (!req.sessionLock) ownSessionLock = prepared.lock;
  const sessionHandle = prepared.handle;
  const sessionId = publicSessionId(sessionHandle);
  const destinationWorkspace = prepared.destinationWorkspace;

  try {
    const tools = parsePiTools(req.tools);
    const noTools = tools.length === 0;
    const writable = toolsAreWritable(tools);
    const needsWorkspace = !noTools;
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
    const childSkills = validateChildSkills(
      req.childSkills,
      req.config,
      workspace,
    );

    const detectedModalities = detectModalitiesFromAttachments(
      attachments,
      req.config,
    );
    const modalities = mergeModalities(req.modalities, detectedModalities);
    const imagePlanned =
      req.imageInputPlanned || modalities.includes("vision");
    if (imagePlanned) {
      assertVisionCapableModel(req.model);
    }

    if (writable) {
      const wsKey = workspace ?? "none";
      locks.push(await acquireLock(`writable:${wsKey}`));
    }

    const repoRoot = workspace ? gitRoot(workspace) : null;
    if (workspace && repoRoot) {
      assertGitRootAllowed(workspace, repoRoot, req.config);
    }

    const prompt = assembleChildPrompt({
      agentsMd: req.agentsMd,
      developerInstructions: [req.developerInstructions, req.prompt]
        .filter(Boolean)
        .join("\n\n"),
      message: req.message,
      resume: sessionHandle.kind === "resume",
      maxBytes: req.config.limits.maxPromptBytes,
    });
    const promptPath = maybeSavePrompt(req.config, dirs, prompt);
    if (promptPath) artifacts.push({ kind: "prompt", path: promptPath });

    const timeoutSec = req.timeoutSeconds ?? defaultTimeout(req.config);
    const onProgress: ProgressCallback = (progress) => {
      (req.sessionLock ?? ownSessionLock)?.heartbeat();
      req.onProgress?.(progress);
    };
    onProgress({ phase: "init" });

    const piExecutor = req.executor ?? (await getPiExecutor(req.config));
    const visionModels = loadProviderFile().vision_capable_models;
    if (imagePlanned && !visionModels.includes(req.model)) {
      assertVisionCapableModel(req.model);
    }

    const outcome = await piExecutor.execute(
      {
        runId: dirs.runId,
        attempt: 0,
        cwd: workspace,
        provider: req.provider,
        model: req.model,
        thinking: req.thinking,
        tools,
        excludeTools: [],
        noTools,
        prompt,
        attachmentPaths: attachments,
        textAttachments: [],
        imageAttachments: [],
        childSkillPaths: childSkills,
        policy: {
          tools,
          noTools,
          workspace,
          destinationWorkspace: destinationWorkspace ?? workspace,
          artifactRoots: [dirs.root, dirs.input, dirs.result],
          allowedRoots: req.config.workspace.allowedRoots,
          skillRoots: childSkills,
        },
        timeoutMs: timeoutSec * 1000,
        config: req.config,
        structuredCompletion: imagePlanned || modalities.includes("vision"),
        onProgress,
        sessionHandle,
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

    const lastOutput = redactSecrets(outcome.finalText);
    const cancelled =
      Boolean(outcome.cancelled) || outcome.completion === "cancelled";
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

    const status = finalizeStatusFromOutcome({
      completion: outcome.completion,
      cancelled,
      output: lastOutput,
      acceptance: parseAcceptanceEvidence(lastOutput, []),
      agentStarted: outcome.agentStarted,
      agentEnded: outcome.agentEnded,
    });

    const resultPath = join(dirs.result, "result.json");
    artifacts.push({ kind: "result", path: resultPath });
    const result: DelegateResult = {
      runId: dirs.runId,
      status,
      agentType: req.agentType,
      taskName: req.taskName,
      provider: req.provider,
      model: req.model,
      thinking: req.thinking,
      workspace,
      workspaceMode: "in-place",
      delivery: "none",
      output: lastOutput,
      acceptance: [],
      sideEffects: [],
      artifacts: [...artifacts],
      attempts,
      durationMs: Date.now() - started,
      sessionId,
    };
    saveResultJson(dirs, result);
    return result;
  } catch (err) {
    if (err instanceof DelegateError && !err.infrastructure) {
      const resultPath = join(dirs.result, "result.json");
      artifacts.push({ kind: "result", path: resultPath });
      const result: DelegateResult = {
        runId: dirs.runId,
        status: "failed",
        agentType: req.agentType,
        taskName: req.taskName,
        provider: req.provider,
        model: req.model,
        thinking: req.thinking,
        output: "",
        acceptance: [],
        sideEffects: [],
        artifacts: [...artifacts],
        attempts,
        durationMs: Date.now() - started,
        sessionId,
        code: err.code,
        message: err.message,
      };
      saveResultJson(dirs, result);
      return result;
    }
    throw err;
  } finally {
    for (const lock of locks) lock.release();
    ownSessionLock?.release();
  }
}
