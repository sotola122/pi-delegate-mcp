import { readFileSync } from "node:fs";
import { loadConfig } from "../config/loader.js";
import { runDelegation } from "../core/delegate.js";
import type { ProfileName, Effort, AllowedModel } from "../config/schema.js";
import { EffortSchema, ModelSchema, ProfileNameSchema } from "../config/schema.js";

export interface RunCliArgs {
  profile: ProfileName;
  workspace?: string;
  objective: string;
  manualFile?: string;
  promptMode?: "append" | "replace";
  effort?: Effort;
  model?: AllowedModel;
  delivery?: "patch" | "apply";
  acceptanceChecks?: string[];
  inScope?: string[];
  timeoutSeconds?: number;
  sessionId?: string;
}

export async function runCommand(args: RunCliArgs): Promise<void> {
  const config = loadConfig();
  const manualPrompt = args.manualFile
    ? readFileSync(args.manualFile, "utf8")
    : undefined;

  const result = await runDelegation({
    config,
    profile: args.profile,
    workspace: args.workspace,
    objective: args.objective,
    manualPrompt,
    promptMode: args.promptMode ?? "append",
    effort: args.effort,
    model: args.model,
    delivery: args.delivery,
    acceptanceChecks: args.acceptanceChecks,
    inScope: args.inScope,
    timeoutSeconds: args.timeoutSeconds,
    sessionId: args.sessionId,
  });

  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "success") process.exitCode = 1;
}

export function parseRunArgs(argv: string[]): RunCliArgs {
  const out: Record<string, string | string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const alias = key === "manual" ? "manual-file" : key;
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[alias] = "true";
    } else {
      if (
        alias === "acceptance-check" ||
        alias === "in-scope"
      ) {
        const arr = (out[alias] as string[] | undefined) ?? [];
        arr.push(next);
        out[alias] = arr;
      } else {
        out[alias] = next;
      }
      i++;
    }
  }

  const profile = ProfileNameSchema.parse(out.profile ?? "review");
  const objective = String(out.objective ?? "");
  if (!objective) throw new Error("--objective is required");

  return {
    profile,
    workspace: out.workspace ? String(out.workspace) : undefined,
    objective,
    manualFile: out["manual-file"] ? String(out["manual-file"]) : undefined,
    promptMode:
      out["prompt-mode"] === "replace" ? "replace" : "append",
    effort: out.effort ? EffortSchema.parse(out.effort) : undefined,
    model: out.model ? ModelSchema.parse(out.model) : undefined,
    delivery:
      out.delivery === "apply" || out.delivery === "patch"
        ? out.delivery
        : undefined,
    acceptanceChecks: Array.isArray(out["acceptance-check"])
      ? (out["acceptance-check"] as string[])
      : undefined,
    inScope: Array.isArray(out["in-scope"])
      ? (out["in-scope"] as string[])
      : undefined,
    timeoutSeconds: out["timeout-seconds"]
      ? Number(out["timeout-seconds"])
      : undefined,
    sessionId: out["session-id"] ? String(out["session-id"]) : undefined,
  };
}
