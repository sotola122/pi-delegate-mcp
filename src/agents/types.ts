import type { Effort } from "../config/schema.js";
import type { ThinkingLevel } from "../pi-sdk/types.js";

export const PI_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

export type PiToolName = (typeof PI_TOOLS)[number];

export const WRITABLE_TOOLS = new Set<PiToolName>(["bash", "edit", "write"]);

export function toolsAreWritable(tools: string[]): boolean {
  return tools.some((t) => WRITABLE_TOOLS.has(t as PiToolName));
}

export interface SkillConfigEntry {
  path: string;
  enabled: boolean;
}

export interface AgentDefinition {
  name: string;
  description?: string;
  developerInstructions?: string;
  tools?: string[];
  model?: string;
  provider?: string;
  thinking?: string;
  skills?: string[];
  sourcePath: string;
}

export interface AgentsConfigFile {
  provider?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  skills?: string[];
}

export interface SpawnOverrides {
  prompt?: string;
  skills?: string[];
  model?: string;
  provider?: string;
  effort?: Effort;
  agentType?: string;
}

export interface ResolvedAgentContext {
  name?: string;
  description?: string;
  developerInstructions: string;
  tools: string[];
  noTools: boolean;
  provider: string;
  model: string;
  thinking: ThinkingLevel;
  effort: Effort;
  skills: string[];
  agentsMd: string;
}
