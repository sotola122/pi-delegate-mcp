import { describe, it, expect, afterAll } from "vitest";
import { resolveProvider } from "../../src/core/provider.js";
import { defaultConfig } from "../../src/config/schema.js";
import {
  validateAttachmentPaths,
  resolveRealPath,
} from "../../src/workspace/roots.js";
import {
  validateChildSkills,
  resolveChildSkillRoots,
  materializeChildSkills,
} from "../../src/workspace/child-skills.js";
import { evaluateToolCall } from "../../src/pi-sdk/policy-extension.js";
import { groupTasksForExecution } from "../../src/core/batch.js";
import { DelegateError } from "../../src/core/errors.js";
import {
  writeFileSync,
  mkdirSync,
  rmSync,
  readFileSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

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

  it("falls back to conventional skill roots when allowedRoots is unset", () => {
    const cfg = defaultConfig();
    expect(cfg.childSkills.allowedRoots).toEqual([]);
    expect(resolveChildSkillRoots(cfg)).toContain(
      join(homedir(), ".agents", "skills"),
    );
    expect(resolveChildSkillRoots(cfg)).not.toContain(
      join(homedir(), ".cursor", "plugins"),
    );
  });

  it("accepts a SKILL.md package under a configured root", () => {
    const cfg = defaultConfig();
    cfg.childSkills.allowedRoots = [dir];
    expect(validateChildSkills([skillEntry], cfg)).toEqual([
      resolveRealPath(skillPkg),
    ]);
  });

  it("expands ~ in allowedRoots", () => {
    const cfg = defaultConfig();
    cfg.childSkills.allowedRoots = ["~/skills"];
    expect(resolveChildSkillRoots(cfg)).toEqual([
      join(homedir(), "skills"),
    ]);
  });

  it("appends workspace only for default roots, not explicit allowlists", () => {
    const cfg = defaultConfig();
    const withWs = resolveChildSkillRoots(cfg, dir);
    expect(withWs.some((r) => resolveRealPath(r) === resolveRealPath(dir))).toBe(
      true,
    );
    cfg.childSkills.allowedRoots = [join(homedir(), ".agents", "skills")];
    const explicit = resolveChildSkillRoots(cfg, dir);
    expect(
      explicit.some((r) => resolveRealPath(r) === resolveRealPath(dir)),
    ).toBe(false);
  });

  it("accepts a workspace skill when using default roots", () => {
    expect(validateChildSkills([skillPkg], defaultConfig(), dir)).toEqual([
      resolveRealPath(skillPkg),
    ]);
  });

  it("rejects arbitrary non-skill files", () => {
    const cfg = defaultConfig();
    cfg.childSkills.allowedRoots = [dir];
    expect(() => validateChildSkills([file], cfg)).toThrow(/SKILL\.md/);
  });

  it("still rejects a skill outside every allowed root without existence oracle", () => {
    const cfg = defaultConfig();
    cfg.childSkills.allowedRoots = [join(dir, "nested")];
    expect(() => validateChildSkills([skillEntry], cfg)).toThrow(/outside/);
    // Outside paths must not leak whether they exist.
    expect(() =>
      validateChildSkills(["/etc/passwd"], defaultConfig()),
    ).toThrow(/outside/);
    expect(() =>
      validateChildSkills(["/tmp/definitely-missing-pi-skill-xyz"], defaultConfig()),
    ).toThrow(/outside/);
  });

  it("still rejects a missing skill path inside an allowed root", () => {
    expect(() =>
      validateChildSkills(
        [join(dir, "missing-skill", "SKILL.md")],
        defaultConfig(),
        dir,
      ),
    ).toThrow(/not found/);
  });

  it("materializes packages under the run dir without following symlinks", () => {
    const cfg = defaultConfig();
    cfg.childSkills.allowedRoots = [dir];
    const outside = join(dir, "secret.txt");
    writeFileSync(outside, "secret\n");
    const link = join(skillPkg, "leak.md");
    try {
      symlinkSync(outside, link);
    } catch {
      // platforms without symlink permission — still exercise materialize
    }
    const validated = validateChildSkills([skillPkg], cfg);
    const dest = join(dir, "materialized");
    const out = materializeChildSkills(validated, dest);
    expect(out).toHaveLength(1);
    const matEntry = join(out[0]!, "SKILL.md");
    expect(readFileSync(matEntry, "utf8")).toContain("Demo Skill");
    expect(existsSync(join(out[0]!, "leak.md"))).toBe(false);

    const decision = evaluateToolCall(
      {
        profile: "review",
        workspace: join(dir, "worktree"),
        artifactRoots: [dest],
      },
      { name: "read", input: { path: matEntry } },
    );
    expect(decision).toEqual({ kind: "allow" });
  });

  it("deduplicates and enforces maxChildSkillCount", () => {
    const cfg = defaultConfig();
    cfg.childSkills.allowedRoots = [dir];
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
