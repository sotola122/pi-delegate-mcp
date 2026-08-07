import type {
  PiAttemptOutcome,
  PiAttemptPlan,
  PiExecutor,
  PiSmokeOutcome,
  PiSmokePlan,
} from "./types.js";

export type FakePiHandler = (
  plan: PiAttemptPlan,
  signal: AbortSignal,
) => Promise<Partial<PiAttemptOutcome> & { finalText: string }>;

export class FakePiExecutor implements PiExecutor {
  constructor(
    private readonly handler: FakePiHandler = async (plan) => ({
      finalText: `# ${heading(plan.profile)}\n\nOK\n`,
      completion: "completed",
    }),
  ) {}

  async execute(
    plan: PiAttemptPlan,
    signal: AbortSignal,
  ): Promise<PiAttemptOutcome> {
    const startedAt = Date.now();
    if (signal.aborted) {
      return {
        completion: "cancelled",
        finalText: "",
        model: {
          provider: plan.provider,
          id: plan.model,
          thinking: plan.thinking,
        },
        startedAt,
        endedAt: Date.now(),
        durationMs: 0,
        accepted: false,
        agentStarted: false,
        agentEnded: false,
        toolCalls: [],
        diagnostics: [],
        backend: "fake",
        cancelled: true,
        exitCode: null,
      };
    }
    const partial = await this.handler(plan, signal);
    const endedAt = Date.now();
    return {
      completion: partial.completion ?? "completed",
      finalText: partial.finalText,
      model: {
        provider: plan.provider,
        id: plan.model,
        thinking: plan.thinking,
      },
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      accepted: partial.accepted ?? true,
      agentStarted: partial.agentStarted ?? true,
      agentEnded: partial.agentEnded ?? true,
      toolCalls: partial.toolCalls ?? [],
      diagnostics: partial.diagnostics ?? [],
      backend: "fake",
      exitCode: partial.exitCode ?? 0,
      cancelled: partial.cancelled,
      timedOut: partial.timedOut,
      stdout: partial.stdout ?? partial.finalText,
      stderr: partial.stderr ?? "",
    };
  }

  async smoke(
    plan: PiSmokePlan,
    _signal?: AbortSignal,
  ): Promise<PiSmokeOutcome> {
    return {
      ok: true,
      stdout: "OK\n",
      stderr: "",
      exitCode: 0,
      provider: plan.provider,
      model: plan.model,
      thinking: plan.thinking,
      backend: "fake",
    };
  }
}

function heading(profile: string): string {
  switch (profile) {
    case "review":
      return "Review Result";
    case "verify":
      return "Verify Result";
    case "implement":
      return "Implement Result";
    case "no-tools":
      return "Judgment Result";
    default:
      return "Result";
  }
}
