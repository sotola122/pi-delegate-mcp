import { describe, it, expect, afterAll } from "vitest";
import { resolveProvider } from "../../src/core/provider.js";
import { defaultConfig } from "../../src/config/schema.js";
import {
  validateAttachmentPaths,
  resolveRealPath,
} from "../../src/workspace/roots.js";
import { validateChildSkills } from "../../src/workspace/child-skills.js";
import { evaluateToolCall } from "../../src/pi-sdk/policy-extension.js";
import { materializeAttachments } from "../../src/pi-sdk/attachments.js";
import { groupTasksForExecution } from "../../src/core/batch.js";
import { DelegateError } from "../../src/core/errors.js";
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
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

function withFakeHome<T>(tmpHome: string, fn: () => T): T {
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  try {
    return fn();
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
  }
}

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

  it("allows Cursor plan attachments under trusted roots", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "pi-home-"));
    const plans = join(tmpHome, ".cursor", "plans");
    mkdirSync(plans, { recursive: true });
    const plan = join(plans, "foo_abcdef12.plan.md");
    writeFileSync(plan, "# plan\n");
    const ws = mkdtempSync(join(tmpdir(), "pi-ws-"));
    writeFileSync(join(ws, "readme.txt"), "ws\n");
    try {
      withFakeHome(tmpHome, () => {
        const out = validateAttachmentPaths(ws, [plan], defaultConfig());
        expect(out[0]).toBe(resolveRealPath(plan));
        const mat = materializeAttachments({
          paths: [plan],
          workspace: ws,
          config: defaultConfig(),
        });
        expect(mat.textAttachments).toHaveLength(1);
      });
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("rejects attachments outside workspace trusted roots and allowedRoots", () => {
    const ws = mkdtempSync(join(tmpdir(), "pi-ws-"));
    const outside = mkdtempSync(join(tmpdir(), "pi-secret-"));
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "nope\n");
    try {
      try {
        validateAttachmentPaths(ws, [secret], defaultConfig());
        expect.unreachable("expected validateAttachmentPaths to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(DelegateError);
        expect((err as DelegateError).code).toBe("attachment_escape");
      }
      try {
        materializeAttachments({
          paths: [secret],
          workspace: ws,
          config: defaultConfig(),
        });
        expect.unreachable("expected materializeAttachments to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(DelegateError);
        expect((err as DelegateError).code).toBe("attachment_escape");
      }
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("allows attachments inside workspace", () => {
    const out = validateAttachmentPaths(dir, [file], defaultConfig());
    expect(out[0]).toBe(resolveRealPath(file));
  });

  it("does not treat trusted attachment roots as writable for implement", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "pi-home-"));
    const plans = join(tmpHome, ".cursor", "plans");
    mkdirSync(plans, { recursive: true });
    const plan = join(plans, "foo_abcdef12.plan.md");
    writeFileSync(plan, "# plan\n");
    const ws = mkdtempSync(join(tmpdir(), "pi-ws-"));
    try {
      withFakeHome(tmpHome, () => {
        expect(validateAttachmentPaths(ws, [plan], defaultConfig())[0]).toBe(
          resolveRealPath(plan),
        );
        const decision = evaluateToolCall(
          { profile: "implement", workspace: ws },
          { name: "write", input: { path: plan, content: "x" } },
        );
        expect(decision.kind).toBe("deny");
      });
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
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
