import { z } from "zod";
import { EffortSchema, ModelSchema, ProfileNameSchema } from "../../config/schema.js";
import { HARD_MAX_TASKS } from "../../core/batch.js";

export const commonFields = {
  effort: EffortSchema.optional(),
  model: ModelSchema.optional(),
  timeoutSeconds: z.number().int().positive().optional(),
};

const sessionIdField = {
  sessionId: z.string().uuid().optional(),
};

const perspectiveSchema = z.object({
  roleId: z.string(),
  objective: z.string().optional(),
  lenses: z.array(z.enum(["adversarial", "tooling-suggest"])).optional(),
  focus: z.array(z.string()).optional(),
  effort: EffortSchema.optional(),
  model: ModelSchema.optional(),
  ...sessionIdField,
});

export const reviewInputSchema = {
  workspace: z.string().optional(),
  objective: z.string(),
  reviewKind: z.enum(["change-review", "static-hunt"]),
  baseline: z.string().optional(),
  inScope: z.array(z.string()).optional(),
  outOfScope: z.array(z.string()).optional(),
  acceptanceChecks: z.array(z.string()).optional(),
  lenses: z.array(z.enum(["adversarial", "tooling-suggest"])).optional(),
  focus: z.array(z.string()).optional(),
  attachments: z.array(z.string()).optional(),
  childSkills: z.array(z.string()).optional(),
  perspectives: z.array(perspectiveSchema).max(HARD_MAX_TASKS).optional(),
  ...commonFields,
  ...sessionIdField,
};

export const verifyInputSchema = {
  workspace: z.string().optional(),
  objective: z.string(),
  inScope: z.array(z.string()).optional(),
  outOfScope: z.array(z.string()).optional(),
  acceptanceChecks: z.array(z.string()),
  suggestedChecks: z.array(z.string()).optional(),
  attachments: z.array(z.string()).optional(),
  childSkills: z.array(z.string()).optional(),
  workspaceMode: z.enum(["auto", "in-place", "worktree"]).optional(),
  ...commonFields,
  ...sessionIdField,
};

export const implementInputSchema = {
  workspace: z.string().optional(),
  objective: z.string(),
  inScope: z.array(z.string()),
  outOfScope: z.array(z.string()).optional(),
  acceptanceChecks: z.array(z.string()),
  attachments: z.array(z.string()).optional(),
  childSkills: z.array(z.string()).optional(),
  delivery: z.enum(["patch", "apply"]).optional(),
  ...commonFields,
  ...sessionIdField,
};

export const judgeInputSchema = {
  objective: z.string(),
  suppliedMaterial: z.string().optional(),
  attachments: z.array(z.string()).optional(),
  acceptanceChecks: z.array(z.string()).optional(),
  lenses: z.array(z.enum(["adversarial", "tooling-suggest"])).optional(),
  ...commonFields,
  ...sessionIdField,
};

export const manualInputSchema = {
  workspace: z.string().optional(),
  profile: z.enum(["review", "verify", "implement", "no-tools"]),
  prompt: z.string(),
  promptMode: z.enum(["append", "replace"]).optional(),
  objective: z.string(),
  inScope: z.array(z.string()).optional(),
  outOfScope: z.array(z.string()).optional(),
  acceptanceChecks: z.array(z.string()).optional(),
  attachments: z.array(z.string()).optional(),
  childSkills: z.array(z.string()).optional(),
  delivery: z.enum(["patch", "apply"]).optional(),
  ...commonFields,
  ...sessionIdField,
};

export const smokeInputSchema = {
  mode: z.enum(["provider-auth", "planned-tuple"]),
  profile: z.enum(["review", "verify", "implement", "no-tools"]).optional(),
  ...commonFields,
};

export const getRunInputSchema = {
  runId: z.string().uuid(),
  /** status = lightweight poll (default); full = include result payload */
  view: z.enum(["status", "full"]).optional(),
};

export const cancelRunInputSchema = {
  runId: z.string().uuid(),
};

export const getBatchInputSchema = {
  batchId: z.string().uuid(),
};

export const cancelBatchInputSchema = {
  batchId: z.string().uuid(),
};

const batchTaskSchema = z.object({
  roleId: z.string(),
  profile: ProfileNameSchema,
  objective: z.string(),
  reviewKind: z.enum(["change-review", "static-hunt"]).optional(),
  baseline: z.string().optional(),
  inScope: z.array(z.string()).optional(),
  outOfScope: z.array(z.string()).optional(),
  acceptanceChecks: z.array(z.string()).optional(),
  suggestedChecks: z.array(z.string()).optional(),
  lenses: z.array(z.enum(["adversarial", "tooling-suggest"])).optional(),
  focus: z.array(z.string()).optional(),
  attachments: z.array(z.string()).optional(),
  childSkills: z.array(z.string()).optional(),
  workspaceMode: z.enum(["auto", "in-place", "worktree"]).optional(),
  delivery: z.enum(["patch", "apply"]).optional(),
  effort: EffortSchema.optional(),
  model: ModelSchema.optional(),
  timeoutSeconds: z.number().int().positive().optional(),
  manualPrompt: z.string().optional(),
  promptMode: z.enum(["append", "replace"]).optional(),
  ...sessionIdField,
});

/** Profile-specific required fields shared by batch / roles tasks. */
export function batchTaskSchemaRefine(task: {
  roleId: string;
  profile: string;
  objective: string;
  inScope?: string[];
  acceptanceChecks?: string[];
}): void {
  if (task.profile === "verify") {
    if (!task.acceptanceChecks?.length) {
      throw new Error(
        `Batch task ${task.roleId} (verify) requires acceptanceChecks`,
      );
    }
  }
  if (task.profile === "implement") {
    if (!task.inScope?.length) {
      throw new Error(`Batch task ${task.roleId} (implement) requires inScope`);
    }
    if (!task.acceptanceChecks?.length) {
      throw new Error(
        `Batch task ${task.roleId} (implement) requires acceptanceChecks`,
      );
    }
  }
}

export const batchInputSchema = {
  workspace: z.string().optional(),
  execution: z.enum(["parallel", "sequential"]),
  tasks: z
    .array(batchTaskSchema)
    .min(1)
    .max(HARD_MAX_TASKS)
    .superRefine((tasks, ctx) => {
      for (const [i, t] of tasks.entries()) {
        try {
          batchTaskSchemaRefine(t);
        } catch (err) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: err instanceof Error ? err.message : String(err),
            path: [i],
          });
        }
      }
    }),
};

const roleSchema = z.object({
  roleId: z.string(),
  profile: ProfileNameSchema,
  objective: z.string().optional(),
  inScope: z.array(z.string()).optional(),
  outOfScope: z.array(z.string()).optional(),
  acceptanceChecks: z.array(z.string()).optional(),
  lenses: z.array(z.enum(["adversarial", "tooling-suggest"])).optional(),
  focus: z.array(z.string()).optional(),
  attachments: z.array(z.string()).optional(),
  childSkills: z.array(z.string()).optional(),
  delivery: z.enum(["patch", "apply"]).optional(),
  workspaceMode: z.enum(["auto", "in-place", "worktree"]).optional(),
  effort: EffortSchema.optional(),
  model: ModelSchema.optional(),
  timeoutSeconds: z.number().int().positive().optional(),
  ...sessionIdField,
});

export const rolesInputSchema = {
  workspace: z.string(),
  objective: z.string(),
  execution: z.enum(["parallel", "sequential"]).optional(),
  roles: z
    .array(roleSchema)
    .min(1)
    .max(HARD_MAX_TASKS)
    .superRefine((roles, ctx) => {
      for (const [i, r] of roles.entries()) {
        try {
          batchTaskSchemaRefine({
            roleId: r.roleId,
            profile: r.profile,
            objective: r.objective ?? "",
            inScope: r.inScope,
            acceptanceChecks: r.acceptanceChecks,
          });
        } catch (err) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: err instanceof Error ? err.message : String(err),
            path: [i],
          });
        }
      }
    }),
  reviewKind: z.enum(["change-review", "static-hunt"]).optional(),
  baseline: z.string().optional(),
};
