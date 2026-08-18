import { z } from "zod";

export const EffortSchema = z.enum(["med", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof EffortSchema>;

export const ModelSchema = z.enum(["gpt-5.6-sol", "gpt-5.6-luna"]);
export type AllowedModel = z.infer<typeof ModelSchema>;

/** @deprecated Role profiles are no longer used at runtime. */
export const ProfileNameSchema = z.enum([
  "review",
  "verify",
  "implement",
  "no-tools",
]);
export type ProfileName = z.infer<typeof ProfileNameSchema>;

/** Wall-clock cap for a delegated Pi run (3h). Safety kill for hung children, not a duration estimate. */
export const DEFAULT_TIMEOUT_SECONDS = 3 * 60 * 60;

const TimeoutSecondsSchema = z.preprocess((raw) => {
  if (typeof raw === "number") return raw;
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    for (const key of ["default", "implement", "verify", "review", "no-tools"]) {
      if (typeof o[key] === "number") return o[key];
    }
  }
  return DEFAULT_TIMEOUT_SECONDS;
}, z.number().default(DEFAULT_TIMEOUT_SECONDS));

const ConfigSchemaInner = z.object({
  version: z.union([z.literal(2), z.literal(3)]).default(3),
  pi: z
    .object({
      /** @deprecated Ignored in SDK mode; warning only during migration. */
      executable: z.string().optional(),
      agentDir: z.string().default("~/.pi/agent"),
      authPath: z.string().nullable().optional(),
      modelsPath: z.string().nullable().optional(),
      provider: z.string().default("openai-codex"),
      defaultModel: ModelSchema.default("gpt-5.6-sol"),
      allowedModels: z
        .array(ModelSchema)
        .default(["gpt-5.6-sol", "gpt-5.6-luna"]),
      allowModelNetwork: z.boolean().default(false),
      refreshAuthBeforeRun: z.boolean().default(true),
      /** Development-only; not a supported release path. */
      backend: z.enum(["sdk", "legacy-cli"]).optional(),
    })
    .default({}),
  sdk: z
    .object({
      resourceIsolation: z.enum(["strict"]).default("strict"),
      writableToolExecution: z
        .enum(["sequential", "parallel"])
        .default("sequential"),
      providerRetry: z
        .object({
          enabled: z.boolean().default(true),
          maxRetries: z.number().default(2),
        })
        .default({}),
    })
    .default({}),
  shellEnvironment: z
    .object({
      passThrough: z.array(z.string()).default([]),
    })
    .default({}),
  /** @deprecated Migrated to shellEnvironment.passThrough */
  environment: z
    .object({
      passThrough: z.array(z.string()).default([]),
    })
    .optional(),
  /** @deprecated Ignored at runtime; roles were replaced by agent templates. */
  profiles: z
    .object({
      review: z.object({ enabled: z.boolean().default(true) }).default({}),
      verify: z.object({ enabled: z.boolean().default(true) }).default({}),
      implement: z
        .object({
          enabled: z.boolean().default(true),
          allowApplyToWorkspace: z.boolean().default(false),
        })
        .default({}),
      "no-tools": z.object({ enabled: z.boolean().default(true) }).default({}),
    })
    .default({}),
  /** @deprecated Ignored at runtime. */
  manual: z
    .object({
      enabled: z.boolean().default(true),
      allowReplace: z.boolean().default(false),
      allowedProfiles: z
        .array(ProfileNameSchema)
        .default(["review", "no-tools"]),
    })
    .default({}),
  agents: z
    .object({
      home: z.string().default("~/.cursor/pi-delegate"),
    })
    .default({}),
  workspace: z
    .object({
      allowedRoots: z.array(z.string()).default([]),
      allowInPlaceVerifyFallback: z.boolean().default(false),
    })
    .default({}),
  childSkills: z
    .object({
      enabled: z.boolean().default(true),
    })
    .default({}),
  limits: z
    .object({
      timeoutSeconds: TimeoutSecondsSchema,
      waitBudgetMs: z.number().int().positive().default(1500),
      maxPromptBytes: z.number().default(262144),
      maxAttachmentCount: z.number().default(32),
      maxChildSkillCount: z.number().default(16),
      maxAttachmentBytes: z.number().default(52428800),
      maxFinalOutputBytes: z.number().default(8388608),
      maxEventMetadataBytes: z.number().default(4194304),
      /** @deprecated CLI-only; ignored in SDK mode */
      maxStdoutBytes: z.number().optional(),
      /** @deprecated CLI-only; ignored in SDK mode */
      maxStderrBytes: z.number().optional(),
    })
    .default({}),
  concurrency: z
    .object({
      global: z.number().default(4),
      perWorkspaceWritable: z.number().default(1),
      review: z.number().optional(),
      judge: z.number().optional(),
      verify: z.number().optional(),
      implement: z.number().optional(),
    })
    .default({}),
  artifacts: z
    .object({
      retentionDays: z.number().default(7),
      keepSuccessfulRuns: z.boolean().default(true),
      keepFailedRuns: z.boolean().default(true),
      storeAssembledPrompt: z.boolean().default(false),
    })
    .default({}),
  sessions: z
    .object({
      enabled: z.boolean().default(true),
    })
    .default({}),
  multimodal: z
    .object({
      imageEnabled: z.boolean().default(true),
      documentEnabled: z.boolean().default(false),
      browserEnabled: z.boolean().default(false),
    })
    .default({}),
});

export type AppConfig = z.infer<typeof ConfigSchemaInner>;

export interface ConfigV1Input {
  version?: 1;
  pi?: {
    executable?: string;
    provider?: string;
    defaultModel?: AllowedModel;
    allowedModels?: AllowedModel[];
  };
  environment?: { passThrough?: string[] };
  [key: string]: unknown;
}

export function migrateConfigV1(input: ConfigV1Input): Record<string, unknown> {
  const { environment, pi, version: _v, ...rest } = input;
  const migrated: Record<string, unknown> = {
    ...rest,
    version: 3,
    pi: {
      provider: pi?.provider ?? "openai-codex",
      defaultModel: pi?.defaultModel ?? "gpt-5.6-sol",
      allowedModels: pi?.allowedModels ?? ["gpt-5.6-sol", "gpt-5.6-luna"],
      ...(pi?.executable ? { executable: pi.executable } : {}),
    },
    shellEnvironment: {
      passThrough: environment?.passThrough ?? [],
    },
  };
  return migrated;
}

export const ConfigSchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== "object") return raw;
  const obj = raw as Record<string, unknown>;
  if (obj.version === 1) {
    return migrateConfigV1(obj as ConfigV1Input);
  }
  if (
    obj.version === undefined &&
    obj.pi &&
    typeof obj.pi === "object" &&
    "executable" in (obj.pi as object) &&
    !("agentDir" in (obj.pi as object))
  ) {
    return migrateConfigV1(obj as ConfigV1Input);
  }
  if (obj.version === 2) {
    return { ...obj, version: 2 };
  }
  if (obj.version === undefined) {
    return { ...obj, version: 3 };
  }
  return obj;
}, ConfigSchemaInner);

export function defaultConfig(): AppConfig {
  return ConfigSchema.parse({ version: 3 });
}

export function warnDeprecatedConfig(config: AppConfig): string[] {
  const warnings: string[] = [];
  if (config.pi.executable) {
    warnings.push(
      "config.pi.executable is ignored in SDK mode. Remove it from the config.",
    );
  }
  if (config.environment?.passThrough?.length) {
    warnings.push(
      "config.environment.passThrough is deprecated; use shellEnvironment.passThrough.",
    );
  }
  return warnings;
}
