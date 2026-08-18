import { readFileSync } from "node:fs";
import { loadConfig } from "../config/loader.js";
import { runDelegation } from "../core/delegate.js";
import { resolveAgentContext } from "../agents/resolve.js";
import type { Effort, AllowedModel } from "../config/schema.js";
import { EffortSchema, ModelSchema } from "../config/schema.js";

export interface RunCliArgs {
  workspace?: string;
  message: string;
  prompt?: string;
  agentType?: string;
  effort?: Effort;
  model?: AllowedModel;
  provider?: string;
  skills?: string[];
  timeoutSeconds?: number;
  sessionId?: string;
}

export async function runCommand(args: RunCliArgs): Promise<void> {
  const config = loadConfig();
  const ctx = resolveAgentContext({
    config,
    workspace: args.workspace,
    overrides: {
      prompt: args.prompt,
      skills: args.skills,
      model: args.model,
      provider: args.provider,
      effort: args.effort,
      agentType: args.agentType,
    },
  });
  const result = await runDelegation({
    config,
    taskName: "cli",
    message: args.message,
    prompt: args.prompt,
    developerInstructions: ctx.developerInstructions,
    agentsMd: ctx.agentsMd,
    tools: ctx.tools,
    noTools: ctx.noTools,
    provider: ctx.provider,
    model: ctx.model,
    thinking: ctx.thinking,
    effort: ctx.effort,
    workspace: args.workspace,
    childSkills: ctx.skills,
    timeoutSeconds: args.timeoutSeconds,
    sessionId: args.sessionId,
    agentType: args.agentType ?? ctx.name,
  });

  console.log(JSON.stringify(result));
  if (result.status !== "success") process.exitCode = 1;
}

export function parseRunArgs(argv: string[]): RunCliArgs {
  const out: Record<string, string | string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = "true";
    } else {
      if (key === "skill") {
        const arr = (out[key] as string[] | undefined) ?? [];
        arr.push(next);
        out[key] = arr;
      } else {
        out[key] = next;
      }
      i++;
    }
  }

  const message = String(out.message ?? out.objective ?? "");
  if (!message) throw new Error("--message is required");

  return {
    workspace: out.workspace ? String(out.workspace) : undefined,
    message,
    prompt: out.prompt
      ? String(out.prompt)
      : out["prompt-file"]
        ? readFileSync(String(out["prompt-file"]), "utf8")
        : undefined,
    agentType: out["agent-type"] ? String(out["agent-type"]) : undefined,
    effort: out.effort ? EffortSchema.parse(out.effort) : undefined,
    model: out.model ? ModelSchema.parse(out.model) : undefined,
    provider: out.provider ? String(out.provider) : undefined,
    skills: Array.isArray(out.skill) ? (out.skill as string[]) : undefined,
    timeoutSeconds: out["timeout-seconds"]
      ? Number(out["timeout-seconds"])
      : undefined,
    sessionId: out["session-id"] ? String(out["session-id"]) : undefined,
  };
}
