import type { AppConfig } from "../config/schema.js";
import { smokeThinking, type ResolvedProvider } from "../core/provider.js";
import { smokePrompt } from "../prompt/assembler.js";
import { getPiExecutor } from "./factory.js";

export interface SmokeOptions {
  config: AppConfig;
  mode: "provider-auth" | "planned-tuple";
  resolved?: ResolvedProvider;
  timeoutSeconds?: number;
  signal?: AbortSignal;
}

export async function runSmokeTest(opts: SmokeOptions): Promise<{
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  provider: string;
  model: string;
  thinking: string;
  backend: string;
}> {
  const tuple = smokeThinking(opts.mode, opts.resolved);
  const executor = await getPiExecutor(opts.config);
  const result = await executor.smoke(
    {
      provider: tuple.provider,
      model: tuple.model,
      thinking: tuple.thinking as
        | "off"
        | "minimal"
        | "low"
        | "medium"
        | "high"
        | "xhigh"
        | "max",
      prompt: smokePrompt(),
      timeoutMs: (opts.timeoutSeconds ?? 60) * 1000,
      config: opts.config,
    },
    opts.signal,
  );
  return {
    ok: result.ok,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    provider: result.provider,
    model: result.model,
    thinking: result.thinking,
    backend: result.backend,
  };
}
