import type {
  PiAttemptOutcome,
  PiAttemptPlan,
  PiExecutor,
  PiSmokeOutcome,
  PiSmokePlan,
} from "./types.js";
import { getSharedRuntimeManager } from "./runtime-manager.js";
import { createDelegationSession } from "./session-factory.js";
import { createEventCollector } from "./event-collector.js";
import { extractFinalAssistantText } from "./result-extractor.js";
import { materializeAttachments } from "./attachments.js";
import { getPiSdkVersion } from "./version.js";
import { DelegateError } from "../core/errors.js";
import { homedir } from "node:os";
import { join } from "node:path";

function expandHome(p: string | undefined | null): string | undefined {
  if (!p) return undefined;
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

function defaultAuthPath(agentDir?: string): string {
  const dir = expandHome(agentDir) ?? join(homedir(), ".pi", "agent");
  return join(dir, "auth.json");
}

function defaultModelsPath(agentDir?: string): string {
  const dir = expandHome(agentDir) ?? join(homedir(), ".pi", "agent");
  return join(dir, "models.json");
}

export class SdkPiExecutor implements PiExecutor {
  async execute(
    plan: PiAttemptPlan,
    signal: AbortSignal,
  ): Promise<PiAttemptOutcome> {
    const startedAt = Date.now();
    const sdkVersion = getPiSdkVersion();
    const modelMeta = {
      provider: plan.provider,
      id: plan.model,
      thinking: plan.thinking,
    };

    const fail = (
      completion: PiAttemptOutcome["completion"],
      message: string,
      code: string,
      extra: Partial<PiAttemptOutcome> = {},
    ): PiAttemptOutcome => {
      const endedAt = Date.now();
      return {
        completion,
        finalText: extra.finalText ?? "",
        model: modelMeta,
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        accepted: false,
        agentStarted: extra.agentStarted ?? false,
        agentEnded: extra.agentEnded ?? false,
        toolCalls: extra.toolCalls ?? [],
        diagnostics: [
          ...(extra.diagnostics ?? []),
          { level: "error", code, message },
        ],
        backend: "sdk",
        sdkVersion,
        cancelled: completion === "cancelled",
        timedOut: completion === "timeout",
        error: { code, message },
        ...extra,
      };
    };

    if (signal.aborted) {
      return fail("cancelled", "aborted before start", "cancelled");
    }

    let prompt = plan.prompt;
    let images = plan.imageAttachments;
    let textAttachments = plan.textAttachments;

    try {
      if (plan.attachmentPaths.length && !textAttachments.length && !images.length) {
        const mat = materializeAttachments({
          paths: plan.attachmentPaths,
          workspace: plan.cwd,
          config: plan.config,
          allowedRoots: plan.policy.allowedRoots,
        });
        textAttachments = mat.textAttachments;
        images = mat.imageAttachments;
        prompt = plan.prompt + mat.promptSuffix;
      } else if (textAttachments.length) {
        // Already materialized — append XML blocks if not already in prompt
        if (!prompt.includes("<attachment path=")) {
          const blocks = textAttachments.map(
            (t) =>
              `<attachment path="${t.path.replace(/"/g, "&quot;")}">\n${t.content}\n</attachment>`,
          );
          prompt += `\n\n## Attachments (untrusted data)\n\n${blocks.join("\n\n")}\n`;
        }
      }
    } catch (err) {
      if (err instanceof DelegateError) {
        return fail("internal_error", err.message, err.code);
      }
      throw err;
    }

    const agentDir = expandHome(plan.config.pi.agentDir);
    const runtimeManager = getSharedRuntimeManager({
      agentDir,
      authPath: expandHome(plan.config.pi.authPath) ?? defaultAuthPath(agentDir),
      modelsPath:
        expandHome(plan.config.pi.modelsPath) ?? defaultModelsPath(agentDir),
      allowModelNetwork: plan.config.pi.allowModelNetwork ?? false,
    });

    let model;
    try {
      if (plan.config.pi.refreshAuthBeforeRun !== false) {
        try {
          await runtimeManager.refreshProvider(plan.provider, signal);
        } catch {
          // refresh is best-effort
        }
      }
      model = await runtimeManager.resolveModel(
        plan.provider,
        plan.model,
        signal,
      );
    } catch (err) {
      if (err instanceof DelegateError) {
        return fail(
          err.code === "auth_required" ? "provider_error" : "internal_error",
          err.message,
          err.code,
        );
      }
      return fail(
        "provider_error",
        err instanceof Error ? err.message : String(err),
        "provider_error",
      );
    }

    const modelRuntime = await runtimeManager.get(signal);
    const bundle = await createDelegationSession({
      plan,
      modelRuntime,
      model,
    });
    const { session } = bundle;
    const { collector, listener } = createEventCollector();
    const unsub = session.subscribe(listener);

    const timeoutController = new AbortController();
    const timer = setTimeout(() => {
      timeoutController.abort(new Error("delegation timeout"));
    }, plan.timeoutMs);

    const onAbort = () => {
      void session.abort();
    };
    const effectiveSignal = AbortSignal.any([signal, timeoutController.signal]);
    if (effectiveSignal.aborted) onAbort();
    else effectiveSignal.addEventListener("abort", onAbort, { once: true });

    let preflightOk = true;
    try {
      const imageContents = images.map((img) => ({
        type: "image" as const,
        data: img.base64,
        mimeType: img.mimeType,
      }));

      await session.prompt(prompt, {
        images: imageContents.length ? imageContents : undefined,
        expandPromptTemplates: false,
        preflightResult: (ok) => {
          preflightOk = ok;
        },
      });
      await session.agent.waitForIdle();
    } catch (err) {
      const timedOut = timeoutController.signal.aborted;
      const cancelled = signal.aborted || timedOut;
      const message = err instanceof Error ? err.message : String(err);
      return fail(
        timedOut ? "timeout" : cancelled ? "cancelled" : "provider_error",
        message,
        timedOut ? "timeout" : cancelled ? "cancelled" : "provider_error",
        {
          agentStarted: collector.agentStarted,
          agentEnded: collector.agentEnded,
          toolCalls: collector.toolCalls,
          diagnostics: collector.diagnostics,
        },
      );
    } finally {
      clearTimeout(timer);
      effectiveSignal.removeEventListener("abort", onAbort);
      unsub();
      if (session.isStreaming) {
        try {
          await session.abort();
        } catch {
          // ignore
        }
      }
      bundle.dispose();
    }

    const endedAt = Date.now();
    if (signal.aborted) {
      return fail("cancelled", "cancelled", "cancelled", {
        agentStarted: collector.agentStarted,
        agentEnded: collector.agentEnded,
        toolCalls: collector.toolCalls,
      });
    }
    if (timeoutController.signal.aborted) {
      return fail("timeout", "delegation timeout", "timeout", {
        agentStarted: collector.agentStarted,
        agentEnded: collector.agentEnded,
        toolCalls: collector.toolCalls,
      });
    }

    const fromMessages = extractFinalAssistantText(
      session.messages as Array<{ role?: string; content?: unknown }>,
    );
    const finalText =
      fromMessages ||
      collector.messageTexts[collector.messageTexts.length - 1] ||
      "";

    const completed =
      preflightOk &&
      collector.agentStarted &&
      collector.agentEnded &&
      !collector.willRetry &&
      finalText.length > 0;

    return {
      completion: completed
        ? "completed"
        : !preflightOk
          ? "incomplete"
          : finalText
            ? "incomplete"
            : "incomplete",
      finalText,
      model: modelMeta,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      accepted: preflightOk,
      agentStarted: collector.agentStarted,
      agentEnded: collector.agentEnded,
      toolCalls: collector.toolCalls,
      diagnostics: collector.diagnostics,
      backend: "sdk",
      sdkVersion,
      eventsJsonl: collector.eventSummary
        .map((e) => JSON.stringify(e))
        .join("\n"),
    };
  }

  async smoke(
    plan: PiSmokePlan,
    signal?: AbortSignal,
  ): Promise<PiSmokeOutcome> {
    const outcome = await this.execute(
      {
        runId: "smoke",
        attempt: 0,
        profile: "no-tools",
        provider: plan.provider,
        model: plan.model,
        thinking: plan.thinking,
        tools: [],
        excludeTools: [],
        noTools: true,
        prompt: plan.prompt,
        attachmentPaths: [],
        textAttachments: [],
        imageAttachments: [],
        childSkillPaths: [],
        policy: { profile: "no-tools" },
        timeoutMs: plan.timeoutMs,
        config: plan.config,
      },
      signal ?? new AbortController().signal,
    );
    const stdout = outcome.finalText.trim();
    const ok = outcome.completion === "completed" && stdout === "OK";
    return {
      ok,
      stdout: outcome.finalText,
      stderr: outcome.error?.message ?? "",
      exitCode: ok ? 0 : 1,
      provider: plan.provider,
      model: plan.model,
      thinking: plan.thinking,
      backend: "sdk",
    };
  }
}
