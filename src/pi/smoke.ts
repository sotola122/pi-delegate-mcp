import type { AppConfig } from "../config/schema.js";
import { getProfile } from "../core/profiles.js";
import { smokeThinking, type ResolvedProvider } from "../core/provider.js";
import { smokePrompt } from "../prompt/assembler.js";
import { buildPiArgv } from "./argv.js";
import { resolvePiExecutable } from "./executable.js";
import { runPi, sanitizeEnv } from "./process.js";

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
}> {
  const tuple = smokeThinking(opts.mode, opts.resolved);
  const executable = resolvePiExecutable(opts.config.pi.executable);
  const profile = getProfile("no-tools");
  const argv = buildPiArgv({
    provider: tuple.provider,
    model: tuple.model,
    thinking: tuple.thinking,
    profile,
  });
  const prompt = smokePrompt();
  const result = await runPi({
    executable,
    argv,
    prompt,
    env: sanitizeEnv(opts.config),
    timeoutMs: (opts.timeoutSeconds ?? 60) * 1000,
    maxStdoutBytes: opts.config.limits.maxStdoutBytes,
    maxStderrBytes: opts.config.limits.maxStderrBytes,
    signal: opts.signal,
  });
  const ok = result.exitCode === 0 && result.stdout.trim() === "OK";
  return {
    ok,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    provider: tuple.provider,
    model: tuple.model,
    thinking: tuple.thinking,
  };
}
