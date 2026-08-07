import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { finalizeStatusFromOutcome } from "../../src/core/result.js";
import {
  captureTreeFingerprint,
  fingerprintsDiffer,
} from "../../src/workspace/worktree.js";
import { assertSafeRunId, isSafeRunId } from "../../src/core/ids.js";
import { createRunDirs } from "../../src/artifacts/manager.js";
import { buildChangeManifest } from "../../src/workspace/manifest.js";
import { advancePipelineWorkspace } from "../../src/core/batch.js";
import type { RunRecord } from "../../src/core/run-registry.js";
import { DelegateError } from "../../src/core/errors.js";

describe("sdk completion status", () => {
  it("fails when agent did not end", () => {
    expect(
      finalizeStatusFromOutcome({
        completion: "completed",
        output: "# Review Result\nok",
        profile: "review",
        acceptance: [],
        requireHeading: true,
        agentStarted: true,
        agentEnded: false,
      }),
    ).toBe("incomplete");
  });

  it("fails on provider_error", () => {
    expect(
      finalizeStatusFromOutcome({
        completion: "provider_error",
        output: "",
        profile: "review",
        acceptance: [],
        requireHeading: true,
        agentStarted: true,
        agentEnded: false,
      }),
    ).toBe("failed");
  });

  it("succeeds with completed + heading", () => {
    expect(
      finalizeStatusFromOutcome({
        completion: "completed",
        output: "# Review Result\nok",
        profile: "review",
        acceptance: [],
        requireHeading: true,
        agentStarted: true,
        agentEnded: true,
      }),
    ).toBe("success");
  });
});

describe("run id safety", () => {
  it("accepts UUIDs only", () => {
    const id = randomUUID();
    expect(isSafeRunId(id)).toBe(true);
    expect(assertSafeRunId(id)).toBe(id);
    expect(() => assertSafeRunId("../etc/passwd")).toThrow(DelegateError);
    expect(() => assertSafeRunId("not-a-uuid")).toThrow(DelegateError);
  });

  it("createRunDirs rejects traversal ids", () => {
    expect(() => createRunDirs("../escape")).toThrow(DelegateError);
  });
});

describe("tree fingerprint content hashes", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "pi-fp-"));
    execFileSync("git", ["init"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@example.com"], {
      cwd: repo,
    });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    writeFileSync(join(repo, "a.txt"), "one\n");
    execFileSync("git", ["add", "a.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "i"], { cwd: repo });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("detects content change with unchanged porcelain status shape", () => {
    writeFileSync(join(repo, "a.txt"), "two\n");
    const before = captureTreeFingerprint(repo);
    writeFileSync(join(repo, "a.txt"), "three\n");
    const after = captureTreeFingerprint(repo);
    // Both dirty with modified a.txt — status lines look alike
    expect(before.status.trim().endsWith("a.txt")).toBe(true);
    expect(after.status.trim().endsWith("a.txt")).toBe(true);
    expect(fingerprintsDiffer(before, after)).toBe(true);
  });
});

describe("omittedRanges includes untracked", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "pi-om-"));
    execFileSync("git", ["init"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@example.com"], {
      cwd: repo,
    });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    writeFileSync(join(repo, "tracked.txt"), "t\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "i"], { cwd: repo });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("lists out-of-scope untracked paths", () => {
    mkdirSync(join(repo, "docs"), { recursive: true });
    writeFileSync(join(repo, "docs", "x.md"), "x\n");
    writeFileSync(join(repo, "src.ts"), "y\n");
    const input = join(repo, "input");
    mkdirSync(input, { recursive: true });
    const m = buildChangeManifest(repo, input, undefined, ["src.ts"]);
    expect(m.omittedRanges).toContain("docs/x.md");
    expect(m.omittedRanges).not.toContain("src.ts");
  });
});

describe("advancePipelineWorkspace", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "pi-pipe-"));
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
    rmSync(repo, { recursive: true, force: true });
  });

  it("applies implement result.patch into a shared worktree", () => {
    const baseline = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    // Simulate implement worktree edits → patch
    writeFileSync(join(repo, "a.txt"), "changed\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    const patch = execFileSync(
      "git",
      ["diff", "--binary", "--cached", baseline],
      { cwd: repo, encoding: "utf8" },
    );
    // Reset workspace to clean so only pipeline worktree gets the change
    execFileSync("git", ["reset", "--hard", "HEAD"], { cwd: repo });
    const patchPath = join(repo, "result.patch");
    writeFileSync(patchPath, patch);

    const prev: RunRecord = {
      runId: randomUUID(),
      status: "success",
      createdAt: 0,
      updatedAt: 0,
      abort: new AbortController(),
      result: {
        runId: randomUUID(),
        status: "success",
        profile: "implement",
        provider: "p",
        model: "m",
        thinking: "medium",
        delivery: "patch",
        output: "# Implement Result",
        acceptance: [],
        sideEffects: [],
        artifacts: [{ kind: "result.patch", path: patchPath }],
        attempts: [],
        durationMs: 1,
      },
    };

    const advanced = advancePipelineWorkspace({
      batchId: randomUUID(),
      originWorkspace: repo,
      currentPipeline: repo,
      pipelineWorktree: undefined,
      prevResults: [prev],
    });

    expect(advanced.pipelineWorktree).toBeTruthy();
    expect(readFileSync(join(advanced.pipelineWorktree!, "a.txt"), "utf8")).toBe(
      "changed\n",
    );
    // Origin stays clean
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("a\n");
  });
});
