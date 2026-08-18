import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultConfig } from "../../src/config/schema.js";
import { parseAgentToml, parseAgentsConfigToml } from "../../src/agents/parse.js";
import { ensureAgentHome, loadAgentsMd } from "../../src/agents/home.js";
import { resolveAgentContext } from "../../src/agents/resolve.js";
import { toolsAreWritable } from "../../src/agents/types.js";
import { assembleChildPrompt } from "../../src/prompt/child.js";
import { DelegateError } from "../../src/core/errors.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-agent-home-"));
  cleanup.push(dir);
  return dir;
}

function cfg(home: string) {
  const config = defaultConfig();
  config.agents.home = home;
  return config;
}

describe("agent TOML parse", () => {
  it("reads Codex keys including tools provider reasoning skills", () => {
    const def = parseAgentToml(
      `
name = "reviewer"
description = "Focused review"
provider = "openai-codex"
model = "gpt-5.6-sol"
model_reasoning_effort = "xhigh"
tools = ["read", "grep", "find", "ls"]
developer_instructions = """
Stay read-only.
"""

[[skills.config]]
path = "~/.agents/skills/code-review"
enabled = true

[[skills.config]]
path = "~/.agents/skills/skip-me"
enabled = false
`,
      "/tmp/reviewer.toml",
    );
    expect(def.name).toBe("reviewer");
    expect(def.provider).toBe("openai-codex");
    expect(def.model).toBe("gpt-5.6-sol");
    expect(def.thinking).toBe("xhigh");
    expect(def.tools).toEqual(["read", "grep", "find", "ls"]);
    expect(def.developerInstructions).toContain("Stay read-only");
    expect(def.skills).toEqual(["~/.agents/skills/code-review"]);
  });

  it("keeps explicit empty tools as no-tools", () => {
    const def = parseAgentToml(
      `
name = "judge"
tools = []
`,
      "/tmp/judge.toml",
    );
    expect(def.tools).toEqual([]);
  });

  it("accepts model_provider and thinking aliases", () => {
    const def = parseAgentToml(
      `
name = "w"
model_provider = "openai-codex"
thinking = "high"
tools = "read,bash"
`,
      "/tmp/w.toml",
    );
    expect(def.provider).toBe("openai-codex");
    expect(def.thinking).toBe("high");
    expect(def.tools).toEqual(["read", "bash"]);
  });
});

describe("agents config.toml", () => {
  it("reads [agents] defaults", () => {
    const cfgFile = parseAgentsConfigToml(`
[agents]
provider = "openai-codex"
model = "gpt-5.6-luna"
model_reasoning_effort = "max"
tools = ["read", "bash", "edit", "write", "grep", "find", "ls"]
`);
    expect(cfgFile.model).toBe("gpt-5.6-luna");
    expect(cfgFile.thinking).toBe("max");
    expect(cfgFile.tools).toContain("bash");
  });
});

describe("resolveAgentContext", () => {
  it("uses template tools/model/provider/reasoning", () => {
    const home = tempHome();
    ensureAgentHome(home);
    mkdirSync(join(home, "agents"), { recursive: true });
    writeFileSync(
      join(home, "agents", "reviewer.toml"),
      `
name = "reviewer"
provider = "openai-codex"
model = "gpt-5.6-sol"
model_reasoning_effort = "xhigh"
tools = ["read", "grep", "find", "ls"]
developer_instructions = "Review only."
`,
    );
    const resolved = resolveAgentContext({
      config: cfg(home),
      overrides: { agentType: "reviewer" },
    });
    expect(resolved.tools).toEqual(["read", "grep", "find", "ls"]);
    expect(resolved.model).toBe("gpt-5.6-sol");
    expect(resolved.thinking).toBe("xhigh");
    expect(resolved.developerInstructions).toContain("Review only");
  });

  it("falls back to config.toml tools when no template", () => {
    const home = tempHome();
    ensureAgentHome(home);
    const resolved = resolveAgentContext({
      config: cfg(home),
      overrides: {},
    });
    expect(resolved.tools).toEqual(["read", "grep", "find", "ls"]);
  });

  it("rejects missing tools", () => {
    const home = tempHome();
    mkdirSync(join(home, "agents"), { recursive: true });
    writeFileSync(join(home, "config.toml"), "[agents]\nmodel = \"gpt-5.6-sol\"\n");
    expect(() =>
      resolveAgentContext({ config: cfg(home), overrides: {} }),
    ).toThrow(DelegateError);
  });

  it("rejects unknown tools", () => {
    const home = tempHome();
    mkdirSync(join(home, "agents"), { recursive: true });
    writeFileSync(
      join(home, "config.toml"),
      `[agents]\ntools = ["read", "explode"]\n`,
    );
    expect(() =>
      resolveAgentContext({ config: cfg(home), overrides: {} }),
    ).toThrow(/Unknown tool/);
  });

  it("spawn model/effort override the template", () => {
    const home = tempHome();
    ensureAgentHome(home);
    writeFileSync(
      join(home, "agents", "reviewer.toml"),
      `
name = "reviewer"
model = "gpt-5.6-sol"
model_reasoning_effort = "high"
tools = ["read"]
`,
    );
    const resolved = resolveAgentContext({
      config: cfg(home),
      overrides: { agentType: "reviewer", model: "gpt-5.6-luna", effort: "max" },
    });
    expect(resolved.model).toBe("gpt-5.6-luna");
    expect(resolved.thinking).toBe("max");
  });

  it("prefers AGENTS.override.md", () => {
    const home = tempHome();
    ensureAgentHome(home);
    writeFileSync(join(home, "AGENTS.md"), "base guidance\n");
    writeFileSync(join(home, "AGENTS.override.md"), "override guidance\n");
    expect(loadAgentsMd(home)).toBe("override guidance");
  });

  it("does not load a repository AGENTS.md", () => {
    const home = tempHome();
    ensureAgentHome(home);
    writeFileSync(join(home, "AGENTS.md"), "home guidance\n");
    const repo = mkdtempSync(join(tmpdir(), "pi-repo-agents-"));
    cleanup.push(repo);
    writeFileSync(join(repo, "AGENTS.md"), "REPO_AGENTS_MUST_NOT_LOAD\n");
    const resolved = resolveAgentContext({
      config: cfg(home),
      workspace: repo,
      overrides: {},
    });
    expect(resolved.agentsMd).toContain("home guidance");
    expect(resolved.agentsMd).not.toContain("REPO_AGENTS_MUST_NOT_LOAD");
  });

  it("merges spawn skills onto template skills", () => {
    const home = tempHome();
    ensureAgentHome(home);
    const skillA = mkdtempSync(join(tmpdir(), "pi-skill-a-"));
    const skillB = mkdtempSync(join(tmpdir(), "pi-skill-b-"));
    cleanup.push(skillA, skillB);
    writeFileSync(join(skillA, "SKILL.md"), "# A\n");
    writeFileSync(join(skillB, "SKILL.md"), "# B\n");
    writeFileSync(
      join(home, "agents", "reviewer.toml"),
      `
name = "reviewer"
tools = ["read"]
[[skills.config]]
path = "${skillA}"
enabled = true
`,
    );
    const resolved = resolveAgentContext({
      config: cfg(home),
      overrides: { agentType: "reviewer", skills: [skillB] },
    });
    expect(resolved.skills.some((p) => p.includes("pi-skill-a-"))).toBe(true);
    expect(resolved.skills.some((p) => p.includes("pi-skill-b-"))).toBe(true);
  });

  it("does not inherit config tools when template tools is empty", () => {
    const home = tempHome();
    ensureAgentHome(home);
    writeFileSync(
      join(home, "agents", "judge.toml"),
      `
name = "judge"
tools = []
`,
    );
    const resolved = resolveAgentContext({
      config: cfg(home),
      overrides: { agentType: "judge" },
    });
    expect(resolved.tools).toEqual([]);
    expect(resolved.noTools).toBe(true);
  });

  it("treats bash/edit/write as writable tools", () => {
    expect(toolsAreWritable(["read", "grep", "find", "ls"])).toBe(false);
    expect(toolsAreWritable([])).toBe(false);
    expect(toolsAreWritable(["read", "bash"])).toBe(true);
    expect(toolsAreWritable(["edit"])).toBe(true);
    expect(toolsAreWritable(["write"])).toBe(true);
  });

  it("enforces maxChildSkillCount on the merged skill list", () => {
    const home = tempHome();
    ensureAgentHome(home);
    const skillA = mkdtempSync(join(tmpdir(), "pi-skill-max-a-"));
    const skillB = mkdtempSync(join(tmpdir(), "pi-skill-max-b-"));
    const skillC = mkdtempSync(join(tmpdir(), "pi-skill-max-c-"));
    cleanup.push(skillA, skillB, skillC);
    for (const d of [skillA, skillB, skillC]) {
      writeFileSync(join(d, "SKILL.md"), "# S\n");
    }
    writeFileSync(
      join(home, "agents", "reviewer.toml"),
      `
name = "reviewer"
tools = ["read"]
[[skills.config]]
path = "${skillA}"
enabled = true
`,
    );
    const config = cfg(home);
    config.limits.maxChildSkillCount = 2;
    expect(() =>
      resolveAgentContext({
        config,
        overrides: { agentType: "reviewer", skills: [skillB, skillC] },
      }),
    ).toThrow(/Too many/);
  });
});

describe("assembleChildPrompt", () => {
  it("includes safety, agents md, instructions, and message", () => {
    const prompt = assembleChildPrompt({
      agentsMd: "Repo rules.",
      developerInstructions: "Be brief.",
      message: "Review src/foo.ts",
    });
    expect(prompt).toMatch(/Do not run `git commit`/);
    expect(prompt).toContain("Repo rules.");
    expect(prompt).toContain("Be brief.");
    expect(prompt).toContain("Review src/foo.ts");
    expect(prompt).not.toMatch(/# Review Result/);
  });

  it("omits safety on resume", () => {
    const prompt = assembleChildPrompt({
      resume: true,
      message: "Continue",
    });
    expect(prompt).not.toMatch(/Do not run `git commit`/);
    expect(prompt).toContain("Continue");
  });
});
