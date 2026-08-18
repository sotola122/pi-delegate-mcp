import { parse as parseToml } from "smol-toml";
import type { AgentDefinition, AgentsConfigFile, SkillConfigEntry } from "./types.js";
import { DelegateError } from "../core/errors.js";

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/** Missing key → undefined. Present array (including `[]`) is kept so empty tools means no-tools. */
export function stringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return undefined;
}

function pickThinking(raw: Record<string, unknown>): string | undefined {
  const keys = ["model_reasoning_effort", "thinking", "reasoning"] as const;
  for (const key of keys) {
    const v = raw[key];
    if (typeof v === "string" && v.trim()) {
      const t = v.trim().toLowerCase();
      if (t === "ultra") return "max";
      if ((THINKING_LEVELS as readonly string[]).includes(t)) return t;
    }
  }
  return undefined;
}

function pickProvider(raw: Record<string, unknown>): string | undefined {
  for (const key of ["provider", "model_provider"] as const) {
    const v = raw[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function skillEntries(raw: Record<string, unknown>): string[] | undefined {
  const skills = raw.skills;
  if (Array.isArray(skills) && skills.every((s) => typeof s === "string")) {
    return stringList(skills);
  }
  const nested = asRecord(skills).config;
  if (Array.isArray(nested)) {
    const paths: string[] = [];
    for (const entry of nested) {
      const rec = asRecord(entry) as SkillConfigEntry & Record<string, unknown>;
      if (typeof rec.path !== "string" || !rec.path.trim()) continue;
      if (rec.enabled === false) continue;
      paths.push(rec.path.trim());
    }
    return paths.length ? paths : undefined;
  }
  return stringList(skills);
}

export function parseAgentToml(text: string, sourcePath: string): AgentDefinition {
  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch (err) {
    throw new DelegateError(
      `Invalid agent TOML: ${sourcePath}: ${err instanceof Error ? err.message : String(err)}`,
      "agent_toml_invalid",
      true,
    );
  }
  const raw = asRecord(parsed);
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) {
    throw new DelegateError(
      `Agent TOML missing name: ${sourcePath}`,
      "agent_name_required",
      true,
    );
  }
  const description =
    typeof raw.description === "string" ? raw.description.trim() : undefined;
  const developerInstructions =
    typeof raw.developer_instructions === "string"
      ? raw.developer_instructions.trim()
      : undefined;
  return {
    name,
    description: description || undefined,
    developerInstructions: developerInstructions || undefined,
    tools: stringList(raw.tools),
    model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : undefined,
    provider: pickProvider(raw),
    thinking: pickThinking(raw),
    skills: skillEntries(raw),
    sourcePath,
  };
}

export function parseAgentsConfigToml(text: string): AgentsConfigFile {
  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch {
    return {};
  }
  const root = asRecord(parsed);
  const agents = asRecord(root.agents);
  return {
    provider: pickProvider(agents) ?? pickProvider(root),
    model:
      typeof agents.model === "string" && agents.model.trim()
        ? agents.model.trim()
        : typeof root.model === "string" && root.model.trim()
          ? root.model.trim()
          : undefined,
    thinking: pickThinking(agents) ?? pickThinking(root),
    tools: stringList(agents.tools) ?? stringList(root.tools),
    skills: skillEntries(agents) ?? skillEntries(root),
  };
}
