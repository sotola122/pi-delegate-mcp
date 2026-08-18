import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config/schema.js";
import { expandHome } from "../config/paths.js";
import type { AgentDefinition, AgentsConfigFile } from "./types.js";
import { parseAgentToml, parseAgentsConfigToml } from "./parse.js";

export const DEFAULT_AGENT_HOME = "~/.cursor/pi-delegate";

const DEFAULT_AGENTS_MD = `# pi-delegate

You are a subagent working for a Cursor parent agent.
Work only on the assigned task and follow its scope precisely.
Do not commit, push, open a pull request, or deploy.
`;

const DEFAULT_CONFIG_TOML = `[agents]
provider = "openai-codex"
model = "gpt-5.6-sol"
model_reasoning_effort = "xhigh"
tools = ["read", "grep", "find", "ls"]
`;

export function agentHomePath(config: AppConfig): string {
  return expandHome(config.agents.home || DEFAULT_AGENT_HOME);
}

export function ensureAgentHome(home: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(join(home, "agents"), { recursive: true, mode: 0o700 });
  const agentsMd = join(home, "AGENTS.md");
  if (!existsSync(agentsMd)) {
    try {
      writeFileSync(agentsMd, DEFAULT_AGENTS_MD, { mode: 0o600, flag: "wx" });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
    }
  }
  const configToml = join(home, "config.toml");
  if (!existsSync(configToml)) {
    try {
      writeFileSync(configToml, DEFAULT_CONFIG_TOML, { mode: 0o600, flag: "wx" });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
    }
  }
}

export function loadAgentsMd(home: string): string {
  const override = join(home, "AGENTS.override.md");
  const base = join(home, "AGENTS.md");
  const path = existsSync(override) ? override : base;
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8").trim();
}

export function loadAgentsConfigFile(home: string): AgentsConfigFile {
  const path = join(home, "config.toml");
  if (!existsSync(path)) return {};
  try {
    return parseAgentsConfigToml(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

export function loadAgentDefinitions(home: string): AgentDefinition[] {
  const dir = join(home, "agents");
  if (!existsSync(dir)) return [];
  const out: AgentDefinition[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".toml")) continue;
    const path = join(dir, name);
    try {
      out.push(parseAgentToml(readFileSync(path, "utf8"), path));
    } catch {
      // skip unreadable / invalid files
    }
  }
  return out;
}

export function findAgentDefinition(
  defs: AgentDefinition[],
  agentType: string,
): AgentDefinition | undefined {
  const needle = agentType.trim();
  return (
    defs.find((d) => d.name === needle) ??
    defs.find((d) => d.sourcePath.endsWith(`/${needle}.toml`)) ??
    defs.find((d) => d.sourcePath.endsWith(`/${needle}`))
  );
}

export function loadAgentHome(config: AppConfig): {
  home: string;
  agentsMd: string;
  fileConfig: AgentsConfigFile;
  definitions: AgentDefinition[];
} {
  const home = agentHomePath(config);
  ensureAgentHome(home);
  return {
    home,
    agentsMd: loadAgentsMd(home),
    fileConfig: loadAgentsConfigFile(home),
    definitions: loadAgentDefinitions(home),
  };
}
