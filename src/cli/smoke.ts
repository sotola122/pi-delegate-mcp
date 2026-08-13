import { loadConfig } from "../config/loader.js";
import { resolveProvider } from "../core/provider.js";
import { runSmokeTest } from "../pi-sdk/smoke.js";
import type { Effort, AllowedModel, ProfileName } from "../config/schema.js";
import {
  EffortSchema,
  ModelSchema,
  ProfileNameSchema,
} from "../config/schema.js";

export async function smokeCommand(argv: string[]): Promise<void> {
  let mode: "provider-auth" | "planned-tuple" = "planned-tuple";
  let profile: ProfileName | undefined;
  let effort: Effort | undefined;
  let model: AllowedModel | undefined;
  let timeoutSeconds: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = argv[i + 1];
    if (a === "--mode" && next) {
      if (next !== "provider-auth" && next !== "planned-tuple") {
        throw new Error("--mode must be provider-auth or planned-tuple");
      }
      mode = next;
      i++;
      continue;
    }
    if (a === "--profile" && next) {
      profile = ProfileNameSchema.parse(next);
      i++;
      continue;
    }
    if (a === "--effort" && next) {
      effort = EffortSchema.parse(next);
      i++;
      continue;
    }
    if (a === "--model" && next) {
      model = ModelSchema.parse(next);
      i++;
      continue;
    }
    if (a === "--timeout-seconds" && next) {
      timeoutSeconds = Number(next);
      i++;
      continue;
    }
  }

  const config = loadConfig();
  const resolved =
    mode === "planned-tuple"
      ? resolveProvider({ config, profile, effort, model })
      : undefined;
  const result = await runSmokeTest({
    config,
    mode,
    resolved,
    timeoutSeconds,
  });
  process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
  if (result.stderr.trim()) {
    process.stderr.write(
      result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`,
    );
  }
  if (!result.ok) process.exitCode = 1;
}
