import type {
  PiAttemptOutcome,
  PiAttemptPlan,
  PiExecutor,
  PiSmokeOutcome,
  PiSmokePlan,
} from "./types.js";
import { getSharedRuntimeManager } from "./runtime-manager.js";
import { createDelegationSession } from "./session-factory.js";
import {
  createEventCollector,
  truncateUtf8,
} from "./event-collector.js";
import { extractFinalAssistantText } from "./result-extractor.js";
import { materializeAttachments } from "./attachments.js";
import { getPiSdkVersion } from "./version.js";
import { DelegateError } from "../core/errors.js";
import { awaitWithAbort } from "../util/abort.js";
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

function abortKind(
  runSignal: AbortSignal,
  timeoutSignal: AbortSignal,
): "cancelled" | "timeout" | null {
  if (timeoutSignal.aborted) return "timeout";
  if (runSignal.aborted) return "cancelled";
  return null;
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

    const timeoutController = new AbortController();
    const timer = setTimeout(() => {
      timeoutController.abort(new Error("delegation timeout"));
    }, plan.timeoutMs);
    const effectiveSignal = AbortSignal.any([
      signal,
      timeoutController.signal,
    ]);

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

    const checkAbort = (): PiAttemptOutcome | null => {
      const kind = abortKind(signal, timeoutController.signal);
      if (!kind) return null;
      return fail(
        kind,
        kind === "timeout" ? "delegation timeout" : "cancelled",
        kind,
      );
    };

    try {
      const early = checkAbort();
      if (early) return early;

      let prompt = plan.prompt;
      let images = plan.imageAttachments;
      let textAttachments = plan.textAttachments;

      try {
        if (
          plan.attachmentPaths.length &&
          !textAttachments.length &&
          !images.length
        ) {
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

      const abortedAfterAttach = checkAbort();
      if (abortedAfterAttach) return abortedAfterAttach;

      const agentDir = expandHome(plan.config.pi.agentDir);
      const runtimeManager = getSharedRuntimeManager({
        agentDir,
        authPath:
          expandHome(plan.config.pi.authPath) ?? defaultAuthPath(agentDir),
        modelsPath:
          expandHome(plan.config.pi.modelsPath) ?? defaultModelsPath(agentDir),
        allowModelNetwork: plan.config.pi.allowModelNetwork ?? false,
      });

      let model;
      try {
        if (plan.config.pi.refreshAuthBeforeRun !== false) {
          try {
            await runtimeManager.refreshProvider(
              plan.provider,
              effectiveSignal,
            );
          } catch {
            // refresh is best-effort unless aborted
            const a = checkAbort();
            if (a) return a;
          }
        }
        const a1 = checkAbort();
        if (a1) return a1;
        model = await runtimeManager.resolveModel(
          plan.provider,
          plan.model,
          effectiveSignal,
        );
      } catch (err) {
        const a = checkAbort();
        if (a) return a;
        if (err instanceof DelegateError) {
          if (err.code === "cancelled") {
            return fail("cancelled", err.message, "cancelled");
          }
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

      const a2 = checkAbort();
      if (a2) return a2;

      let bundle;
      try {
        const modelRuntime = await runtimeManager.get(effectiveSignal);
        const a3 = checkAbort();
        if (a3) return a3;

        bundle = await awaitWithAbort(
          createDelegationSession({
            plan,
            modelRuntime,
            model,
          }),
          effectiveSignal,
        );
      } catch (err) {
        const a = checkAbort();
        if (a) return a;
        if (err instanceof DelegateError) {
          return fail(
            err.code === "cancelled" ? "cancelled" : "internal_error",
            err.message,
            err.code,
          );
        }
        return fail(
          "internal_error",
          err instanceof Error ? err.message : String(err),
          "internal_error",
        );
      }

      const { session } = bundle;

      const afterSession = checkAbort();
      if (afterSession) {
        try {
          if (session.isStreaming) await session.abort();
        } catch {
          // ignore
        }
        bundle.dispose();
        return afterSession;
      }

      const maxEventBytes =
        plan.config.limits.maxEventMetadataBytes ?? 4_194_304;
      const maxFinalBytes =
        plan.config.limits.maxFinalOutputBytes ?? 8_388_608;
      const { collector, listener } = createEventCollector({
        maxEventMetadataBytes: maxEventBytes,
      });
      const unsub = session.subscribe(listener);

      const onAbort = () => {
        void session.abort();
      };
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
          diagnostics: collector.diagnostics,
        });
      }
      if (timeoutController.signal.aborted) {
        return fail("timeout", "delegation timeout", "timeout", {
          agentStarted: collector.agentStarted,
          agentEnded: collector.agentEnded,
          toolCalls: collector.toolCalls,
          diagnostics: collector.diagnostics,
        });
      }

      const fromMessages = extractFinalAssistantText(
        session.messages as Array<{ role?: string; content?: unknown }>,
      );
      let finalText =
        fromMessages ||
        collector.messageTexts[collector.messageTexts.length - 1] ||
        "";

      const trunc = truncateUtf8(finalText, maxFinalBytes);
      const diagnostics = [...collector.diagnostics];
      if (trunc.truncated) {
        finalText = trunc.text;
        diagnostics.push({
          level: "warn",
          code: "final_output_truncated",
          message: `final output truncated to ${maxFinalBytes} bytes`,
        });
      }

      const completed =
        preflightOk &&
        collector.agentStarted &&
        collector.agentEnded &&
        !collector.willRetry &&
        finalText.length > 0;

      return {
        completion: completed ? "completed" : "incomplete",
        finalText,
        model: modelMeta,
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        accepted: preflightOk,
        agentStarted: collector.agentStarted,
        agentEnded: collector.agentEnded,
        toolCalls: collector.toolCalls,
        diagnostics,
        backend: "sdk",
        sdkVersion,
        eventsJsonl: collector.eventSummary
          .map((e) => JSON.stringify(e))
          .join("\n"),
      };
    } finally {
      clearTimeout(timer);
    }
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
