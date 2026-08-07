import { stringify } from "yaml";

export interface TaskBlock {
  objective: string;
  profile: string;
  review_kind?: string;
  workspace?: string;
  workspace_mode?: string;
  baseline?: string;
  in_scope?: string[];
  out_of_scope?: string[];
  acceptance_checks?: string[];
  allowed_task_side_effects?: string[];
  orchestration_artifacts?: string[];
  stop_conditions?: string[];
  cli_attachments?: string[];
  /** Backend-neutral attachment paths (preferred over cli_attachments). */
  attachments?: string[];
  task_input_paths?: string[];
  delivery?: string;
  modalities?: string[];
  focus?: string[];
}

/** Serialize task block as YAML embedded at prompt end (injection-safe). */
export function serializeTaskBlock(block: TaskBlock): string {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(block)) {
    if (v === undefined) continue;
    cleaned[k] = v;
  }
  return [
    "",
    "---",
    "# Task Block",
    stringify(cleaned, { lineWidth: 0 }).trimEnd(),
    "---",
    "",
  ].join("\n");
}
