import { z } from "zod";
import { EffortSchema, ModelSchema } from "../../config/schema.js";

export const spawnAgentInputSchema = {
  task_name: z.string(),
  message: z.string(),
  prompt: z.string().optional(),
  skills: z.array(z.string()).optional(),
  agent_type: z.string().optional(),
  model: ModelSchema.optional(),
  provider: z.string().optional(),
  effort: EffortSchema.optional(),
  workspace: z.string().optional(),
};

export const waitAgentInputSchema = {
  targets: z.array(z.string()).optional(),
};

export const waitAllAgentsInputSchema = {
  targets: z.array(z.string()).optional(),
};

export const listAgentsInputSchema = {
  path_prefix: z.string().optional(),
};

export const readAgentResponseInputSchema = {
  target: z.string(),
};

export const sendMessageInputSchema = {
  target: z.string(),
  message: z.string(),
};

export const interruptAgentInputSchema = {
  target: z.string(),
};
