import {
  existsSync,
  mkdirSync,
  rmSync,
  readFileSync,
  cpSync,
  statSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { git, gitIsDirty, gitUntracked, tryGit } from "./git.js";
import { DelegateError } from "../core/errors.js";

export interface WorktreeInfo {
  path: string;
  runId: string;
}

/**
 * Create a detached worktree under `<repo>/.git/pi-delegate-wt/<id>` so it
 * stays inside the authorized git root (not /tmp).
 */
export function createDetachedWorktree(
  repoRoot: string,
  runId: string,
  baseSha?: string,
): WorktreeInfo {
  const safeId = runId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const base = join(repoRoot, ".git", "pi-delegate-wt");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const path = join(base, safeId);
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
  }
  const sha = baseSha ?? git(repoRoot, ["rev-parse", "HEAD"]);
  git(repoRoot, ["worktree", "add", "--detach", path, sha]);
  return { path, runId };
}

/** Parse `git status --porcelain -z` into path operations. */
export function parsePorcelainZ(raw: string): Array<{
  xy: string;
  path: string;
  from?: string;
}> {
  const entries: Array<{ xy: string; path: string; from?: string }> = [];
  const parts = raw.split("\0").filter((p) => p.length > 0);
  let i = 0;
  while (i < parts.length) {
    const rec = parts[i]!;
    if (rec.length < 3) {
      i += 1;
      continue;
    }
    const xy = rec.slice(0, 2);
    const pathPart = rec.slice(3);
    // Rename/copy in porcelain -z: first record has new path, next NUL field is old.
    if (
      (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") &&
      i + 1 < parts.length
    ) {
      entries.push({ xy, path: pathPart, from: parts[i + 1] });
      i += 2;
      continue;
    }
    entries.push({ xy, path: pathPart });
    i += 1;
  }
  return entries;
}

function copyEntry(src: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  if (!existsSync(src)) return;
  const st = lstatSync(src);
  if (st.isSymbolicLink()) {
    if (existsSync(dest) || lstatSync(dest, { throwIfNoEntry: false })) {
      try {
        unlinkSync(dest);
      } catch {
        rmSync(dest, { recursive: true, force: true });
      }
    }
    symlinkSync(readlinkSync(src), dest);
  } else if (st.isDirectory()) {
    cpSync(src, dest, { recursive: true });
  } else {
    if (existsSync(dest)) {
      try {
        unlinkSync(dest);
      } catch {
        // ignore
      }
    }
    cpSync(src, dest);
  }
}

/**
 * Materialize dirty tracked + untracked state into a worktree by copying
 * files (no `git apply`). Handles staged/unstaged/new/binary safely.
 */
export function materializeDirtyState(
  sourceWorkspace: string,
  worktreePath: string,
): void {
  const porcelain =
    tryGit(sourceWorkspace, [
      "-c",
      "core.quotepath=false",
      "status",
      "--porcelain",
      "-z",
    ]) ?? "";
  const entries = parsePorcelainZ(porcelain);
  const toRemove = new Set<string>();
  const toCopy = new Set<string>();

  for (const e of entries) {
    const x = e.xy[0] ?? " ";
    const y = e.xy[1] ?? " ";
    if (e.from) toRemove.add(e.from);
    const deletedInIndex = x === "D";
    const deletedInWt = y === "D";
    const existsInSource =
      existsSync(join(sourceWorkspace, e.path)) ||
      !!lstatSync(join(sourceWorkspace, e.path), { throwIfNoEntry: false });

    if ((deletedInIndex || deletedInWt) && !existsInSource) {
      toRemove.add(e.path);
    } else if (existsInSource) {
      toCopy.add(e.path);
    }
  }

  for (const rel of toRemove) {
    const dest = join(worktreePath, rel);
    if (existsSync(dest) || lstatSync(dest, { throwIfNoEntry: false })) {
      try {
        unlinkSync(dest);
      } catch {
        rmSync(dest, { recursive: true, force: true });
      }
    }
  }

  for (const rel of toCopy) {
    copyEntry(join(sourceWorkspace, rel), join(worktreePath, rel));
  }

  // Untracked files (also appear as ?? in porcelain; copy again is idempotent)
  for (const rel of gitUntracked(sourceWorkspace)) {
    const src = join(sourceWorkspace, rel);
    if (existsSync(src) || lstatSync(src, { throwIfNoEntry: false })) {
      copyEntry(src, join(worktreePath, rel));
    }
  }
}

export function removeWorktree(repoRoot: string, worktreePath: string): void {
  try {
    git(repoRoot, ["worktree", "remove", "--force", worktreePath]);
  } catch {
    rmSync(worktreePath, { recursive: true, force: true });
    tryGit(repoRoot, ["worktree", "prune"]);
  }
}

export function contentHash(path: string): string {
  if (!existsSync(path)) return "";
  const st = statSync(path);
  if (st.isDirectory()) {
    return createHash("sha256").update(`dir:${path}`).digest("hex");
  }
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function captureTreeFingerprint(cwd: string): {
  dirty: boolean;
  head: string | null;
  status: string;
  /** path → fingerprint token (type/mode/hash or symlink target) */
  entries: Record<string, string>;
} {
  const status = tryGit(cwd, ["status", "--porcelain"]) ?? "";
  const paths = new Set<string>();
  for (const line of status.split("\n")) {
    if (!line) continue;
    // porcelain v1: XY PATH | XY ORIG -> PATH
    const renamed = line.slice(3).split(" -> ");
    const pathPart = renamed[renamed.length - 1]!.trim();
    if (pathPart) paths.add(pathPart.replace(/^"|"$/g, ""));
  }
  for (const u of gitUntracked(cwd)) paths.add(u);

  const entries: Record<string, string> = {};
  for (const rel of paths) {
    const abs = join(cwd, rel);
    try {
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
        entries[rel] = `symlink:${readlinkSync(abs)}`;
      } else if (st.isFile()) {
        entries[rel] = `file:${st.mode}:${contentHash(abs)}`;
      } else if (st.isDirectory()) {
        entries[rel] = `dir:${st.mode}`;
      } else {
        entries[rel] = `other:${st.mode}`;
      }
    } catch {
      entries[rel] = "missing";
    }
  }

  return {
    dirty: gitIsDirty(cwd),
    head: tryGit(cwd, ["rev-parse", "HEAD"]),
    status,
    entries,
  };
}

export function fingerprintsDiffer(
  before: ReturnType<typeof captureTreeFingerprint>,
  after: ReturnType<typeof captureTreeFingerprint>,
): boolean {
  if (before.head !== after.head) return true;
  if (before.status !== after.status) return true;
  const keys = new Set([
    ...Object.keys(before.entries),
    ...Object.keys(after.entries),
  ]);
  for (const k of keys) {
    if (before.entries[k] !== after.entries[k]) return true;
  }
  return false;
}

export function assertMaterializeOrFail(
  ok: boolean,
  allowFallback: boolean,
): void {
  if (ok) return;
  if (!allowFallback) {
    throw new DelegateError(
      "Worktree materialization failed; refusing in-place fallback",
      "worktree_materialize_failed",
      true,
    );
  }
}
