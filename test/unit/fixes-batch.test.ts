import { describe, it, expect, afterAll } from "vitest";
import { resolveProvider } from "../../src/core/provider.js";
import { defaultConfig } from "../../src/config/schema.js";
import {
  validateAttachmentPaths,
  resolveRealPath,
} from "../../src/workspace/roots.js";
import { validateChildSkills } from "../../src/workspace/child-skills.js";
import { evaluateToolCall } from "../../src/pi-sdk/policy-extension.js";
import { groupTasksForExecution } from "../../src/core/batch.js";
import { DelegateError } from "../../src/core/errors.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = join(tmpdir(), `pi-att-${process.pid}`);
mkdirSync(dir, { recursive: true });
const file = join(dir, "a.txt");
writeFileSync(file, "hi");

const skillPkg = join(dir, "demo-skill");
mkdirSync(skillPkg, { recursive: true });
const skillEntry = join(skillPkg, "SKILL.md");
writeFileSync(skillEntry, "# Demo Skill\nDo the demo.\n");
writeFileSync(join(skillPkg, "notes.md"), "helper\n");

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("A5 allowedModels final check", () => {
  it("rejects alternate model outside allowlist", () => {
    const cfg = defaultConfig();
    cfg.pi.allowedModels = ["gpt-5.6-sol"];
    expect(() =>
      resolveProvider({ config: cfg, useImplementAlternate: true }),
    ).toThrow(/not allowed/);
  });
});

describe("A3 attachments", () => {
  it("rejects no-workspace attachments without allowedRoots", () => {
    expect(() =>
      validateAttachmentPaths(undefined, [file], defaultConfig()),
    ).toThrow(DelegateError);
  });

  it("allows no-workspace attachments under allowedRoots", () => {
    const cfg = defaultConfig();
    cfg.workspace.allowedRoots = [dir];
    const out = validateAttachmentPaths(undefined, [file], cfg);
    expect(out[0]).toContain("a.txt");
  });

  it("still rejects traversal", () => {
    expect(() =>
      validateAttachmentPaths(dir, ["../../etc/passwd"], defaultConfig()),
    ).toThrow(/traversal/);
  });
});

describe("A4 childSkills", () => {
  it("is enabled by default so the advertised parameter works", () => {
    expect(defaultConfig().childSkills.enabled).toBe(true);
  });

  it("rejects when explicitly disabled", () => {
    const cfg = defaultConfig();
    cfg.childSkills.enabled = false;
    expect(() => validateChildSkills([skillEntry], cfg)).toThrow(/disabled/);
  });

  it("accepts a SKILL.md path or package directory with no allowlist", () => {
    expect(validateChildSkills([skillEntry], defaultConfig())).toEqual([
      resolveRealPath(skillPkg),
    ]);
    expect(validateChildSkills([skillPkg], defaultConfig())).toEqual([
      resolveRealPath(skillPkg),
    ]);
  });

  it("rejects arbitrary non-skill files", () => {
    expect(() => validateChildSkills([file], defaultConfig())).toThrow(
      /SKILL\.md/,
    );
  });

  it("rejects missing skill paths", () => {
    expect(() =>
      validateChildSkills(
        [join(dir, "missing-skill", "SKILL.md")],
        defaultConfig(),
      ),
    ).toThrow(/not found/);
  });

  it("allows policy read of selected skillRoots only", () => {
    const validated = validateChildSkills([skillPkg], defaultConfig());
    const allow = evaluateToolCall(
      {
        profile: "review",
        workspace: join(dir, "worktree"),
        skillRoots: validated,
      },
      { name: "read", input: { path: skillEntry } },
    );
    expect(allow).toEqual({ kind: "allow" });

    const denySibling = evaluateToolCall(
      {
        profile: "review",
        workspace: join(dir, "worktree"),
        skillRoots: validated,
      },
      { name: "read", input: { path: file } },
    );
    expect(denySibling.kind).toBe("deny");
  });

  it("deduplicates and enforces maxChildSkillCount", () => {
    const cfg = defaultConfig();
    cfg.limits.maxChildSkillCount = 2;
    expect(validateChildSkills([skillEntry, skillPkg], cfg)).toHaveLength(1);
    const other = join(dir, "other-skill");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "SKILL.md"), "# Other\n");
    cfg.limits.maxChildSkillCount = 1;
    expect(() =>
      validateChildSkills([skillPkg, other], cfg),
    ).toThrow(/Too many/);
  });
});

describe("C groupTasksForExecution", () => {
  it("parallels all when execution=parallel", () => {
    const groups = groupTasksForExecution(
      [
        { roleId: "a", profile: "review", objective: "a" },
        { roleId: "b", profile: "implement", objective: "b" },
      ],
      "parallel",
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
  });

  it("groups read-only after writable in sequential", () => {
    const groups = groupTasksForExecution(
      [
        { roleId: "impl", profile: "implement", objective: "i" },
        { roleId: "ver", profile: "verify", objective: "v" },
        { roleId: "r1", profile: "review", objective: "r1" },
        { roleId: "r2", profile: "review", objective: "r2" },
      ],
      "sequential",
    );
    expect(groups.map((g) => g.map((t) => t.roleId))).toEqual([
      ["impl"],
      ["ver"],
      ["r1", "r2"],
    ]);
  });
});
