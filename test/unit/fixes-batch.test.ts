import { describe, it, expect, afterAll } from "vitest";
import { resolveProvider } from "../../src/core/provider.js";
import { defaultConfig } from "../../src/config/schema.js";
import { validateAttachmentPaths } from "../../src/workspace/roots.js";
import { validateChildSkills } from "../../src/workspace/child-skills.js";
import { groupTasksForExecution } from "../../src/core/batch.js";
import { DelegateError } from "../../src/core/errors.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = join(tmpdir(), `pi-att-${process.pid}`);
mkdirSync(dir, { recursive: true });
const file = join(dir, "a.txt");
writeFileSync(file, "hi");

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
  it("rejects when disabled", () => {
    expect(() => validateChildSkills(["/tmp/x"], defaultConfig())).toThrow(
      /disabled/,
    );
  });

  it("rejects when enabled but no roots", () => {
    const cfg = defaultConfig();
    cfg.childSkills.enabled = true;
    expect(() => validateChildSkills(["/tmp/x"], cfg)).toThrow(/allowedRoots/);
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
