import type { AppConfig } from "../config/schema.js";
import type { ProgressCallback } from "../core/progress.js";
import type { SessionHandle } from "./session-store.js";

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type PiCompletion =
  | "completed"
  | "incomplete"
  | "provider_error"
  | "tool_error"
  | "cancelled"
  | "timeout"
  | "internal_error";

export interface MaterializedTextAttachment {
  path: string;
  content: string;
}

export interface MaterializedImageAttachment {
  path: string;
  mimeType: string;
  base64: string;
}

export interface DelegationPolicy {
  tools: string[];
  noTools?: boolean;
  workspace?: string;
  inScope?: string[];
  outOfScope?: string[];
  artifactRoots?: string[];
  allowedRoots?: string[];
  /** Selected child-skill package roots — readable without widening workspace roots. */
  skillRoots?: string[];
  destinationWorkspace?: string;
}

export interface PiAttemptPlan {
  runId: string;
  attempt: number;
  cwd?: string;
  provider: string;
  model: string;
  thinking: ThinkingLevel;
  tools: string[];
  excludeTools: string[];
  noTools: boolean;
  prompt: string;
  /** Absolute paths still pending materialization (CLI @file / SDK read). */
  attachmentPaths: string[];
  textAttachments: MaterializedTextAttachment[];
  imageAttachments: MaterializedImageAttachment[];
  childSkillPaths: string[];
  policy: DelegationPolicy;
  timeoutMs: number;
  config: AppConfig;
  /** Prefer JSON-mode style completion checks when true (vision etc.). */
  structuredCompletion?: boolean;
  /** Optional heartbeat for MCP poll status. */
  onProgress?: ProgressCallback;
  sessionHandle?: SessionHandle;
}

export interface ToolCallSummary {
  tool: string;
  isError: boolean;
  durationMs?: number;
}

export interface PiDiagnostic {
  level: "info" | "warn" | "error";
  code: string;
  message: string;
}

export interface PiAttemptOutcome {
  completion: PiCompletion;
  finalText: string;
  model: {
    provider: string;
    id: string;
    thinking: string;
  };
  startedAt: number;
  endedAt: number;
  durationMs: number;
  accepted: boolean;
  agentStarted: boolean;
  agentEnded: boolean;
  toolCalls: ToolCallSummary[];
  diagnostics: PiDiagnostic[];
  backend: "cli" | "sdk" | "fake";
  sdkVersion?: string;
  /** CLI parity: process exit code when backend is cli. */
  exitCode?: number | null;
  cancelled?: boolean;
  timedOut?: boolean;
  stdout?: string;
  stderr?: string;
  eventsJsonl?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    cost?: number;
  };
  error?: {
    code: string;
    message: string;
  };
}

export interface PiSmokePlan {
  provider: string;
  model: string;
  thinking: ThinkingLevel;
  prompt: string;
  timeoutMs: number;
  config: AppConfig;
}

export interface PiSmokeOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  provider: string;
  model: string;
  thinking: string;
  backend: "cli" | "sdk" | "fake";
}

export interface PiExecutor {
  execute(plan: PiAttemptPlan, signal: AbortSignal): Promise<PiAttemptOutcome>;
  smoke(plan: PiSmokePlan, signal?: AbortSignal): Promise<PiSmokeOutcome>;
}
