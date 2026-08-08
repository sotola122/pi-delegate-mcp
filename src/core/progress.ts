export type RunProgressPhase =
  | "init"
  | "prompting"
  | "tools"
  | "finalizing"
  | "done";

export interface RunProgress {
  phase: RunProgressPhase;
  toolCalls?: number;
  lastTool?: string;
  agentStarted?: boolean;
}

export type ProgressCallback = (progress: RunProgress) => void;
