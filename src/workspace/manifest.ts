import {
  mkdirSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import {
  gitDiff,
  gitNameStatus,
  gitNameStatusZ,
  gitUntracked,
  gitHead,
  gitIsDirty,
  resolveBaseline,
  tryGit,
} from "./git.js";
import { isPathInside, resolveRealPath } from "./roots.js";
import {
  isUnsafeRepoPath,
  matchesScopePattern,
  normalizeRepoPath,
} from "./scope.js";

export interface ChangeManifest {
  baselineSha: string;
  headSha: string | null;
  dirty: boolean;
  nameStatus: string;
  untracked: string[];
  omittedRanges: string[];
  trackedPatchPath: string;
  nameStatusPath: string;
  untrackedDir: string;
  manifestPath: string;
}

/**
 * Archive one untracked path without following symlinks out of the workspace.
 * Returns an omitted-range label when skipped, otherwise null.
 */
export function archiveUntrackedEntry(
  workspace: string,
  rel: string,
  untrackedDir: string,
): string | null {
  const norm = normalizeRepoPath(rel);
  if (isUnsafeRepoPath(norm)) {
    return `unsafe:${rel}`;
  }
  const src = join(workspace, norm);
  const dest = join(untrackedDir, norm);
  let st;
  try {
    st = lstatSync(src);
  } catch {
    return `missing:${rel}`;
  }

  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });

  if (st.isSymbolicLink()) {
    try {
      const target = readlinkSync(src);
      // Resolve relative link targets against the link's directory.
      const resolvedTarget = resolveRealPath(
        target.startsWith("/") ? target : join(dirname(src), target),
      );
      if (!isPathInside(workspace, resolvedTarget)) {
        return `escape:${rel}`;
      }
      symlinkSync(target, dest);
      return null;
    } catch {
      return `symlink:${rel}`;
    }
  }

  if (!st.isFile()) {
    return `nonfile:${rel}`;
  }

  // Regular file: require the real path to stay inside the workspace.
  const real = resolveRealPath(src);
  if (!isPathInside(workspace, real)) {
    return `escape:${rel}`;
  }

  try {
    copyFileSync(src, dest);
    chmodSync(dest, 0o600);
    return null;
  } catch {
    return `unreadable:${rel}`;
  }
}

export function buildChangeManifest(
  workspace: string,
  runInputDir: string,
  baseline?: string,
  inScope?: string[],
): ChangeManifest {
  mkdirSync(runInputDir, { recursive: true, mode: 0o700 });
  const baselineSha = resolveBaseline(workspace, baseline);
  const headSha = gitHead(workspace);
  const dirty = gitIsDirty(workspace);
  const nameStatus = gitNameStatus(workspace, baselineSha);
  let trackedPatch = gitDiff(workspace, baselineSha);
  const untracked = gitUntracked(workspace);

  const trackedPatchPath = join(runInputDir, "tracked.patch");
  const nameStatusPath = join(runInputDir, "name-status.txt");
  const untrackedDir = join(runInputDir, "untracked");
  const manifestPath = join(runInputDir, "manifest.json");

  writeFileSync(trackedPatchPath, trackedPatch, { mode: 0o600 });
  writeFileSync(nameStatusPath, nameStatus + "\n", { mode: 0o600 });

  mkdirSync(untrackedDir, { recursive: true, mode: 0o700 });
  const omittedRanges: string[] = [];
  for (const rel of untracked) {
    const omitted = archiveUntrackedEntry(workspace, rel, untrackedDir);
    if (omitted) omittedRanges.push(omitted);
  }

  if (inScope?.length) {
    const changed = new Set<string>();
    for (const rec of gitNameStatusZ(workspace, baselineSha)) {
      changed.add(rec.path);
      if (rec.from) changed.add(rec.from);
    }
    for (const f of changed) {
      if (!inScope.some((s) => matchesScopePattern(f, s))) {
        omittedRanges.push(f);
      }
    }
    for (const u of untracked) {
      if (!inScope.some((s) => matchesScopePattern(u, s))) {
        if (!omittedRanges.includes(u)) omittedRanges.push(u);
      }
    }
  }

  const submodule = tryGit(workspace, ["submodule", "status"]) ?? "";

  const manifest = {
    baselineSha,
    headSha,
    dirty,
    untracked,
    omittedRanges,
    submoduleStatus: submodule,
    trackedPatchPath,
    nameStatusPath,
    untrackedDir,
    scope: inScope ?? null,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", {
    mode: 0o600,
  });

  return {
    baselineSha,
    headSha,
    dirty,
    nameStatus,
    untracked,
    omittedRanges,
    trackedPatchPath,
    nameStatusPath,
    untrackedDir,
    manifestPath,
  };
}
