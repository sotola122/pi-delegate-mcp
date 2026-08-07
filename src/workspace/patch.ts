import { execFileSync } from "node:child_process";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git, tryGit } from "./git.js";
import { DelegateError } from "../core/errors.js";
import { assertPathsAllowed } from "./scope.js";

export type PatchScope = {
  inScope?: string[];
  outOfScope?: string[];
};

/**
 * Stage the current worktree and return its tree object id.
 * Used as the agent-delta baseline after dirty materialization.
 */
export function snapshotWorktreeTree(worktreePath: string): string {
  git(worktreePath, ["add", "-A"]);
  return git(worktreePath, ["write-tree"]);
}

/**
 * Capture tracked + newly added files as a binary patch against baseline.
 * `baseline` may be a commit SHA or a tree object (agent-delta snapshot).
 * Stages everything with `git add -A`, then diffs the index vs baseline.
 * Enforces path safety and optional inScope / outOfScope before writing.
 */
export function createResultPatch(
  worktreePath: string,
  baselineSha: string,
  outPath: string,
  scope?: PatchScope,
): string {
  git(worktreePath, ["add", "-A"]);
  const remaining = tryGit(worktreePath, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  if (remaining && remaining.trim().length > 0) {
    throw new DelegateError(
      `Cannot represent untracked files in patch:\n${remaining}`,
      "incomplete_patch",
      false,
    );
  }
  const names = git(worktreePath, [
    "diff",
    "--cached",
    "--name-only",
    "--diff-filter=ACDMRTUXB",
    baselineSha,
  ])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  assertPathsAllowed(names, scope?.inScope, scope?.outOfScope);
  const patch = git(worktreePath, [
    "diff",
    "--binary",
    "--cached",
    baselineSha,
  ]);
  writeFileSync(outPath, patch, { mode: 0o600 });
  return outPath;
}

export function applyPatchToWorkspace(
  workspace: string,
  patchPath: string,
): void {
  if (!existsSync(patchPath)) {
    throw new DelegateError("Patch file missing", "patch_missing", true);
  }
  const content = readFileSync(patchPath, "utf8");
  if (!content.trim()) return;
  try {
    execFileSync("git", ["apply", "--whitespace=nowarn", patchPath], {
      cwd: workspace,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new DelegateError(
      `Failed to apply patch: ${err instanceof Error ? err.message : String(err)}`,
      "apply_failed",
      false,
    );
  }
}

export function diffWorktreeToPatch(
  worktreePath: string,
  artifactDir: string,
  baselineSha: string,
  scope?: PatchScope,
): string {
  const out = join(artifactDir, "result.patch");
  return createResultPatch(worktreePath, baselineSha, out, scope);
}
