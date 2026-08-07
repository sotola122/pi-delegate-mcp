import { z } from "zod";

export const EffortSchema = z.enum(["med", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof EffortSchema>;

export const ModelSchema = z.enum(["gpt-5.6-sol", "gpt-5.6-luna"]);
export type AllowedModel = z.infer<typeof ModelSchema>;

export const ProfileNameSchema = z.enum([
  "review",
  "verify",
  "implement",
  "no-tools",
]);
export type ProfileName = z.infer<typeof ProfileNameSchema>;

export const ConfigSchema = z.object({
  version: z.literal(1).default(1),
  pi: z
    .object({
      executable: z.string().default("pi"),
      provider: z.string().default("openai-codex"),
      defaultModel: ModelSchema.default("gpt-5.6-sol"),
      allowedModels: z.array(ModelSchema).default(["gpt-5.6-sol", "gpt-5.6-luna"]),
    })
    .default({}),
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
  manual: z
    .object({
      enabled: z.boolean().default(true),
      allowReplace: z.boolean().default(false),
      allowedProfiles: z
        .array(ProfileNameSchema)
        .default(["review", "no-tools"]),
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
      enabled: z.boolean().default(false),
      allowedRoots: z.array(z.string()).default([]),
    })
    .default({}),
  environment: z
    .object({
      passThrough: z.array(z.string()).default([]),
    })
    .default({}),
  limits: z
    .object({
      timeoutSeconds: z
        .object({
          review: z.number().default(1200),
          verify: z.number().default(1800),
          implement: z.number().default(2400),
          "no-tools": z.number().default(900),
        })
        .default({}),
      maxPromptBytes: z.number().default(262144),
      maxAttachmentCount: z.number().default(32),
      maxAttachmentBytes: z.number().default(52428800),
      maxStdoutBytes: z.number().default(16777216),
      maxStderrBytes: z.number().default(8388608),
    })
    .default({}),
  concurrency: z
    .object({
      global: z.number().default(4),
      review: z.number().default(4),
      judge: z.number().default(4),
      verify: z.number().default(2),
      implement: z.number().default(1),
      perWorkspaceWritable: z.number().default(1),
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
  multimodal: z
    .object({
      imageEnabled: z.boolean().default(true),
      documentEnabled: z.boolean().default(false),
      browserEnabled: z.boolean().default(false),
    })
    .default({}),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function defaultConfig(): AppConfig {
  return ConfigSchema.parse({});
}
