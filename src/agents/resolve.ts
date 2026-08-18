import { existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { AppConfig, Effort } from "../config/schema.js";
import { DelegateError } from "../core/errors.js";
import { loadProviderFile } from "../core/provider.js";
import type { ThinkingLevel } from "../pi-sdk/types.js";
import { expandHome } from "../config/paths.js";
import { validateChildSkills } from "../workspace/child-skills.js";
import { loadAgentHome, findAgentDefinition } from "./home.js";
import type {
  PiToolName,
  ResolvedAgentContext,
  SpawnOverrides,
} from "./types.js";
import { PI_TOOLS } from "./types.js";

const PI_TOOL_SET = new Set<string>(PI_TOOLS);

function thinkingToEffort(thinking: string): Effort {
  if (thinking === "max") return "max";
  if (thinking === "xhigh") return "xhigh";
  if (thinking === "high") return "high";
  return "med";
}

function effortToThinking(effort: Effort): ThinkingLevel {
  if (effort === "med") return "medium";
  return effort;
}

function asThinking(value: string | undefined): ThinkingLevel | undefined {
  if (!value) return undefined;
  if (value === "ultra") return "max";
  const allowed: ThinkingLevel[] = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ];
  return allowed.includes(value as ThinkingLevel)
    ? (value as ThinkingLevel)
    : undefined;
}

export function parsePiTools(tools: string[] | undefined): string[] {
  if (!tools) {
    throw new DelegateError(
      "Agent tools are required in the selected template or ~/.cursor/pi-delegate/config.toml [agents]",
      "tools_required",
      true,
    );
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tools) {
    const name = raw.trim();
    if (!name) continue;
    if (!PI_TOOL_SET.has(name)) {
      throw new DelegateError(
        `Unknown tool: ${name}`,
        "unknown_tool",
        true,
      );
    }
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name as PiToolName);
  }
  return out;
}

function looksLikePath(value: string): boolean {
  return (
    value.startsWith("~") ||
    value.startsWith(".") ||
    value.startsWith("/") ||
    value.includes("/") ||
    value.includes("\\")
  );
}

export function expandSkillRef(ref: string): string[] {
  const trimmed = ref.trim();
  if (!trimmed) return [];
  if (looksLikePath(trimmed)) return [trimmed];
  return [
    join(homedir(), ".cursor", "skills", trimmed),
    join(homedir(), ".agents", "skills", trimmed),
  ];
}

function firstExistingSkill(ref: string): string | undefined {
  for (const candidate of expandSkillRef(ref)) {
    const abs = resolve(expandHome(candidate));
    if (!existsSync(abs)) continue;
    try {
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) continue;
      if (st.isFile() && basename(abs) === "SKILL.md") return abs;
      if (st.isDirectory() && existsSync(join(abs, "SKILL.md"))) return abs;
    } catch {
      continue;
    }
  }
  return undefined;
}

function resolveSkillList(
  refs: string[],
  config: AppConfig,
  workspace?: string,
): string[] {
  if (!refs.length) return [];
  const picked: string[] = [];
  const errors: string[] = [];
  for (const ref of refs) {
    const found = firstExistingSkill(ref);
    if (!found) {
      errors.push(ref);
      continue;
    }
    picked.push(found);
  }
  if (errors.length) {
    throw new DelegateError(
      `Child skill not found: ${errors.join(", ")}`,
      "child_skill_missing",
      true,
    );
  }
  return validateChildSkills(picked, config, workspace);
}

export function resolveAgentContext(opts: {
  config: AppConfig;
  overrides: SpawnOverrides;
  workspace?: string;
}): ResolvedAgentContext {
  const loaded = loadAgentHome(opts.config);
  const def = opts.overrides.agentType
    ? findAgentDefinition(loaded.definitions, opts.overrides.agentType)
    : undefined;
  if (opts.overrides.agentType && !def) {
    throw new DelegateError(
      `Unknown agent_type: ${opts.overrides.agentType}`,
      "agent_type_unknown",
      true,
    );
  }

  const tools = parsePiTools(def?.tools ?? loaded.fileConfig.tools);
  const noTools = tools.length === 0;

  const providerFile = loadProviderFile();
  const provider =
    opts.overrides.provider ||
    def?.provider ||
    loaded.fileConfig.provider ||
    opts.config.pi.provider ||
    providerFile.provider;

  const model =
    opts.overrides.model ||
    def?.model ||
    loaded.fileConfig.model ||
    opts.config.pi.defaultModel ||
    providerFile.default_model;

  if (
    !opts.config.pi.allowedModels.includes(
      model as (typeof opts.config.pi.allowedModels)[number],
    )
  ) {
    throw new DelegateError(`Model not allowed: ${model}`, "model_not_allowed", true);
  }

  let effort: Effort = opts.overrides.effort ?? "med";
  let thinking: ThinkingLevel = effortToThinking(effort);

  const tomlThinking = asThinking(def?.thinking ?? loaded.fileConfig.thinking);
  if (!opts.overrides.effort && tomlThinking) {
    thinking = tomlThinking;
    effort = thinkingToEffort(thinking);
  } else if (opts.overrides.effort) {
    const mapped = providerFile.effort[opts.overrides.effort];
    thinking = (mapped?.thinking as ThinkingLevel) ?? effortToThinking(opts.overrides.effort);
  } else {
    const mapped = providerFile.effort[effort];
    thinking = (mapped?.thinking as ThinkingLevel) ?? thinking;
  }

  const mergedSkills = [
    ...(def?.skills ?? loaded.fileConfig.skills ?? []),
    ...(opts.overrides.skills ?? []),
  ];
  const skills = resolveSkillList(mergedSkills, opts.config, opts.workspace);

  const developerInstructions = [
    def?.developerInstructions,
    opts.overrides.prompt?.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    name: def?.name,
    description: def?.description,
    developerInstructions,
    tools,
    noTools,
    provider,
    model,
    thinking,
    effort,
    skills,
    agentsMd: loaded.agentsMd,
  };
}
