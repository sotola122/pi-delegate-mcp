import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  readFileSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { assetsRoot } from "../../src/prompt/assets.js";
import { archiveUntrackedEntry } from "../../src/workspace/manifest.js";
import {
  snapshotWorktreeTree,
  createResultPatch,
} from "../../src/workspace/patch.js";
import {
  batchToPublic,
  type BatchRecord,
} from "../../src/core/batch.js";
import {
  resolveWorkspace,
  assertGitRootAllowed,
} from "../../src/workspace/roots.js";
import { defaultConfig } from "../../src/config/schema.js";
import { annotations } from "../../src/mcp/annotations.js";
import { serializeTaskBlock, type TaskBlock } from "../../src/prompt/task-block.js";
import { batchTaskSchemaRefine } from "../../src/mcp/tools/schemas.js";
import { DelegateError } from "../../src/core/errors.js";

describe("assetsRoot packaged layout", () => {
  it("resolves package assets without relying on cwd alone", () => {
    const root = assetsRoot();
    expect(existsSync(join(root, "profiles.yaml"))).toBe(true);
    // Must be under this package, not an arbitrary cwd
    const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    expect(realpathSync(root).startsWith(realpathSync(pkgRoot))).toBe(true);
  });
});

describe("archiveUntrackedEntry rejects escaping symlinks", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-sym-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("omits symlink whose target is outside the workspace", () => {
    const secret = join(dir, "secret.txt");
    writeFileSync(secret, "TOP_SECRET\n");
    const ws = join(dir, "ws");
    const out = join(dir, "out");
    mkdirSync(ws);
    mkdirSync(out);
    symlinkSync(secret, join(ws, "leak"));

    const omitted = archiveUntrackedEntry(ws, "leak", out);
    expect(omitted).toMatch(/^escape:/);
    expect(existsSync(join(out, "leak"))).toBe(false);
  });
});

describe("agent-delta patch via snapshot tree", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "pi-delta-"));
    execFileSync("git", ["init"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@example.com"], {
      cwd: repo,
    });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    writeFileSync(join(repo, "a.txt"), "base\n");
    execFileSync("git", ["add", "a.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "i"], { cwd: repo });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("excludes pre-existing dirty changes from the result patch", () => {
    // Simulate materialize: dirty user edit already in worktree
    writeFileSync(join(repo, "a.txt"), "user-dirty\n");
    const initialTree = snapshotWorktreeTree(repo);

    // Simulate Pi agent edit on top
    writeFileSync(join(repo, "a.txt"), "user-dirty\nagent\n");
    writeFileSync(join(repo, "b.txt"), "new\n");

    const out = join(repo, "result.patch");
    createResultPatch(repo, initialTree, out, { inScope: ["a.txt", "b.txt"] });
    const patch = readFileSync(out, "utf8");
    expect(patch).toContain("b.txt");
    expect(patch).toContain("agent");
    // Must not re-introduce the base→user-dirty transition as if it were agent work
    expect(patch).not.toMatch(/^-base$/m);
  });
});

describe("batchToPublic waits for orchestrationComplete", () => {
  it("stays running when later roles are not yet launched", () => {
    const batch: BatchRecord = {
      batchId: randomUUID(),
      execution: "sequential",
      children: [{ roleId: "impl", runId: randomUUID() }],
      plannedRoleIds: ["impl", "ver", "rev"],
      skippedRoleIds: [],
      orchestrationComplete: false,
      createdAt: 0,
      updatedAt: 0,
    };
    const pub = batchToPublic(batch);
    expect(pub.status).toBe("running");
  });

  it("can succeed only after orchestrationComplete with all roles launched", () => {
    const id = randomUUID();
    const batch: BatchRecord = {
      batchId: randomUUID(),
      execution: "parallel",
      children: [{ roleId: "a", runId: id }],
      plannedRoleIds: ["a"],
      skippedRoleIds: [],
      orchestrationComplete: false,
      createdAt: 0,
      updatedAt: 0,
    };
    expect(batchToPublic(batch).status).toBe("running");
    batch.orchestrationComplete = true;
    // Without a live run registry entry, status becomes incomplete (not success)
    const pub = batchToPublic(batch);
    expect(pub.orchestrationComplete).toBe(true);
    expect(pub.status).not.toBe("running");
  });

  it("is terminal after early-stop with skipped roles", () => {
    const batch: BatchRecord = {
      batchId: randomUUID(),
      execution: "sequential",
      children: [{ roleId: "impl", runId: randomUUID() }],
      plannedRoleIds: ["impl", "ver", "rev"],
      skippedRoleIds: ["ver", "rev"],
      orchestrationComplete: true,
      createdAt: 0,
      updatedAt: 0,
    };
    const pub = batchToPublic(batch);
    expect(pub.status).not.toBe("running");
    expect(pub.skippedRoleIds).toEqual(["ver", "rev"]);
    const runs = pub.runs as Array<{ roleId: string; status: string }>;
    expect(runs.some((r) => r.roleId === "ver" && r.status === "skipped")).toBe(
      true,
    );
  });
});

describe("git root must stay inside allowedRoots", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-groot-"));
    execFileSync("git", ["init"], { cwd: root });
    execFileSync("git", ["config", "user.email", "t@example.com"], {
      cwd: root,
    });
    execFileSync("git", ["config", "user.name", "t"], { cwd: root });
    writeFileSync(join(root, "f.txt"), "x\n");
    execFileSync("git", ["add", "f.txt"], { cwd: root });
    execFileSync("git", ["commit", "-m", "i"], { cwd: root });
    mkdirSync(join(root, "public"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects nested workspace whose git root escapes allowedRoots", () => {
    const cfg = defaultConfig();
    cfg.workspace.allowedRoots = [join(root, "public")];
    expect(() =>
      resolveWorkspace({
        workspace: join(root, "public"),
        config: cfg,
      }),
    ).toThrow(/git root|allowedRoots/i);
  });

  it("assertGitRootAllowed accepts matching roots", () => {
    const cfg = defaultConfig();
    cfg.workspace.allowedRoots = [root];
    expect(() => assertGitRootAllowed(root, root, cfg)).not.toThrow();
  });
});

describe("annotations are conservative", () => {
  it("marks provider-using and writable tools openWorld/destructive", () => {
    expect(annotations.verify.destructiveHint).toBe(true);
    expect(annotations.verify.openWorldHint).toBe(true);
    expect(annotations.manual.destructiveHint).toBe(true);
    expect(annotations.manual.openWorldHint).toBe(true);
    expect(annotations.batch.destructiveHint).toBe(true);
    expect(annotations.batch.openWorldHint).toBe(true);
    expect(annotations.review.openWorldHint).toBe(true);
    expect(annotations.implement.openWorldHint).toBe(true);
  });
});

describe("focus appears in task block", () => {
  it("serializes focus field", () => {
    const block: TaskBlock = {
      objective: "o",
      profile: "review",
      focus: ["src/core"],
    };
    const text = serializeTaskBlock(block);
    expect(text).toContain("focus:");
    expect(text).toContain("src/core");
  });
});

describe("batch task profile contracts", () => {
  it("requires acceptanceChecks for verify and inScope+checks for implement", () => {
    expect(() =>
      batchTaskSchemaRefine({
        roleId: "v",
        profile: "verify",
        objective: "o",
      }),
    ).toThrow(/acceptanceChecks/);
    expect(() =>
      batchTaskSchemaRefine({
        roleId: "i",
        profile: "implement",
        objective: "o",
        acceptanceChecks: ["a"],
      }),
    ).toThrow(/inScope/);
    expect(() =>
      batchTaskSchemaRefine({
        roleId: "i",
        profile: "implement",
        objective: "o",
        inScope: ["src"],
        acceptanceChecks: ["a"],
      }),
    ).not.toThrow();
  });
});

describe("pipelineExecCwd preserves nested relative path", () => {
  it("joins subdirectory under worktree root", async () => {
    const { pipelineExecCwd } = await import("../../src/core/batch.js");
    expect(
      pipelineExecCwd("/wt", "/repo/public", "/repo"),
    ).toBe(join("/wt", "public"));
    expect(pipelineExecCwd("/wt", "/repo", "/repo")).toBe("/wt");
  });

  it("advancePipelineWorkspace keeps nested public/ cwd", async () => {
    const {
      advancePipelineWorkspace,
      pipelineExecCwd,
    } = await import("../../src/core/batch.js");
    const { removeWorktree } = await import("../../src/workspace/worktree.js");
    const root = mkdtempSync(join(tmpdir(), "pi-nest-"));
    try {
      execFileSync("git", ["init"], { cwd: root });
      execFileSync("git", ["config", "user.email", "t@example.com"], {
        cwd: root,
      });
      execFileSync("git", ["config", "user.name", "t"], { cwd: root });
      mkdirSync(join(root, "public"), { recursive: true });
      writeFileSync(join(root, "public", "a.txt"), "a\n");
      execFileSync("git", ["add", "public/a.txt"], { cwd: root });
      execFileSync("git", ["commit", "-m", "i"], { cwd: root });
      const baseline = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim();
      writeFileSync(join(root, "public", "a.txt"), "changed\n");
      execFileSync("git", ["add", "-A"], { cwd: root });
      const patch = execFileSync(
        "git",
        ["diff", "--binary", "--cached", baseline],
        { cwd: root, encoding: "utf8" },
      );
      execFileSync("git", ["reset", "--hard", "HEAD"], { cwd: root });
      const patchPath = join(root, "result.patch");
      writeFileSync(patchPath, patch);
      const prev = {
        runId: randomUUID(),
        status: "success" as const,
        createdAt: 0,
        updatedAt: 0,
        abort: new AbortController(),
        result: {
          runId: randomUUID(),
          status: "success" as const,
          profile: "implement" as const,
          provider: "p",
          model: "m",
          thinking: "medium",
          delivery: "patch" as const,
          output: "# Implement Result",
          acceptance: [],
          sideEffects: [],
          artifacts: [{ kind: "result.patch", path: patchPath }],
          attempts: [],
          durationMs: 1,
        },
      };
      const origin = join(root, "public");
      const advanced = advancePipelineWorkspace({
        batchId: randomUUID(),
        originWorkspace: origin,
        currentPipeline: origin,
        pipelineWorktree: undefined,
        prevResults: [prev],
      });
      expect(advanced.pipelineWorktree).toContain(
        join(".git", "pi-delegate-wt"),
      );
      expect(advanced.pipelineWorkspace).toBe(
        pipelineExecCwd(advanced.pipelineWorktree!, origin, root),
      );
      expect(
        readFileSync(join(advanced.pipelineWorkspace!, "a.txt"), "utf8"),
      ).toBe("changed\n");
      if (advanced.pipelineWorktree) {
        removeWorktree(root, advanced.pipelineWorktree);
      }
    } finally {
      try {
        execFileSync("git", ["worktree", "prune"], { cwd: root });
      } catch {
        // ignore
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("createDetachedWorktree lives under repo .git", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "pi-wtloc-"));
    execFileSync("git", ["init"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@example.com"], {
      cwd: repo,
    });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    writeFileSync(join(repo, "a.txt"), "a\n");
    execFileSync("git", ["add", "a.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "i"], { cwd: repo });
  });

  afterEach(() => {
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: repo });
    } catch {
      // ignore
    }
    rmSync(repo, { recursive: true, force: true });
  });

  it("creates under .git/pi-delegate-wt", async () => {
    const { createDetachedWorktree, removeWorktree } = await import(
      "../../src/workspace/worktree.js"
    );
    const wt = createDetachedWorktree(repo, randomUUID());
    expect(wt.path.includes(join(".git", "pi-delegate-wt"))).toBe(true);
    expect(existsSync(wt.path)).toBe(true);
    removeWorktree(repo, wt.path);
  });
});

describe("materializeDirtyState copies without git apply", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "pi-mat-"));
    execFileSync("git", ["init"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@example.com"], {
      cwd: repo,
    });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    writeFileSync(join(repo, "a.txt"), "base\n");
    execFileSync("git", ["add", "a.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "i"], { cwd: repo });
  });

  afterEach(() => {
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: repo });
    } catch {
      // ignore
    }
    rmSync(repo, { recursive: true, force: true });
  });

  it("copies staged new, unstaged edit, and binary", async () => {
    const {
      createDetachedWorktree,
      materializeDirtyState,
      removeWorktree,
    } = await import("../../src/workspace/worktree.js");
    writeFileSync(join(repo, "a.txt"), "edited\n");
    writeFileSync(join(repo, "new.txt"), "staged-new\n");
    execFileSync("git", ["add", "new.txt"], { cwd: repo });
    writeFileSync(join(repo, "bin.dat"), Buffer.from([0, 1, 2, 255]));
    writeFileSync(join(repo, "untracked.txt"), "u\n");

    const wt = createDetachedWorktree(repo, randomUUID());
    materializeDirtyState(repo, wt.path);
    expect(readFileSync(join(wt.path, "a.txt"), "utf8")).toBe("edited\n");
    expect(readFileSync(join(wt.path, "new.txt"), "utf8")).toBe("staged-new\n");
    expect(readFileSync(join(wt.path, "bin.dat"))).toEqual(
      Buffer.from([0, 1, 2, 255]),
    );
    expect(readFileSync(join(wt.path, "untracked.txt"), "utf8")).toBe("u\n");
    removeWorktree(repo, wt.path);
  });
});

describe("omittedRanges includes rename source", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "pi-ren-"));
    execFileSync("git", ["init"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@example.com"], {
      cwd: repo,
    });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    mkdirSync(join(repo, "old"), { recursive: true });
    writeFileSync(join(repo, "old", "x.md"), "x\n");
    execFileSync("git", ["add", "old/x.md"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "i"], { cwd: repo });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("lists out-of-scope rename source path", async () => {
    const { buildChangeManifest } = await import(
      "../../src/workspace/manifest.js"
    );
    mkdirSync(join(repo, "src"), { recursive: true });
    execFileSync("git", ["mv", "old/x.md", "src/x.md"], { cwd: repo });
    const input = join(repo, "input");
    mkdirSync(input, { recursive: true });
    const m = buildChangeManifest(repo, input, undefined, ["src/"]);
    expect(m.omittedRanges).toContain("old/x.md");
    expect(m.omittedRanges).not.toContain("src/x.md");
  });
});

describe("assetsRoot stays inside package", () => {
  it("resolves via package.json name only", async () => {
    const { findPackageRoot, assetsRoot } = await import(
      "../../src/prompt/assets.js"
    );
    const pkg = findPackageRoot();
    expect(JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).name).toBe(
      "@sotola122/pi-delegate-mcp",
    );
    expect(realpathSync(assetsRoot())).toBe(
      realpathSync(join(pkg, "assets", "delegate-pi")),
    );
  });
});

describe("result.json includes result artifact before save", () => {
  it("writes artifact entry into the saved JSON", async () => {
    const { createRunDirs, saveResultJson } = await import(
      "../../src/artifacts/manager.js"
    );
    const dirs = createRunDirs(randomUUID());
    const resultPath = join(dirs.result, "result.json");
    const result = {
      runId: dirs.runId,
      status: "success",
      artifacts: [{ kind: "result", path: resultPath }],
    };
    saveResultJson(dirs, result);
    const saved = JSON.parse(readFileSync(resultPath, "utf8"));
    expect(saved.artifacts.some((a: { kind: string }) => a.kind === "result")).toBe(
      true,
    );
  });
});
