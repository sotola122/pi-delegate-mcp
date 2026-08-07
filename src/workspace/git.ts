import { execFileSync } from "node:child_process";

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 50 * 1024 * 1024,
  }).trimEnd();
}

export function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

export function gitRoot(cwd: string): string | null {
  return tryGit(cwd, ["rev-parse", "--show-toplevel"]);
}

export function gitHead(cwd: string): string | null {
  return tryGit(cwd, ["rev-parse", "HEAD"]);
}

export function gitIsDirty(cwd: string): boolean {
  const status = tryGit(cwd, ["status", "--porcelain"]);
  return status !== null && status.length > 0;
}

export function gitDiff(cwd: string, baseline: string): string {
  return git(cwd, ["diff", "--binary", baseline]);
}

export function gitNameStatus(cwd: string, baseline: string): string {
  // Keep human-readable text for name-status.txt artifact; parsing uses -z helper.
  return git(cwd, [
    "-c",
    "core.quotepath=false",
    "diff",
    "--name-status",
    baseline,
  ]);
}

/** NUL-delimited name-status records for reliable rename/path parsing. */
export function gitNameStatusZ(
  cwd: string,
  baseline: string,
): Array<{ status: string; path: string; from?: string }> {
  const out = tryGit(cwd, [
    "-c",
    "core.quotepath=false",
    "diff",
    "--name-status",
    "-z",
    baseline,
  ]);
  if (!out) return [];
  const parts = out.split("\0").filter((p) => p.length > 0);
  const records: Array<{ status: string; path: string; from?: string }> = [];
  let i = 0;
  while (i < parts.length) {
    const status = parts[i]!;
    i += 1;
    if (i >= parts.length) break;
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = parts[i]!;
      i += 1;
      if (i >= parts.length) break;
      const to = parts[i]!;
      i += 1;
      records.push({ status, path: to, from });
    } else {
      const path = parts[i]!;
      i += 1;
      records.push({ status, path });
    }
  }
  return records;
}

export function gitUntracked(cwd: string): string[] {
  const out = tryGit(cwd, [
    "-c",
    "core.quotepath=false",
    "ls-files",
    "-z",
    "--others",
    "--exclude-standard",
  ]);
  if (!out) return [];
  return out.split("\0").filter(Boolean);
}

export function resolveBaseline(cwd: string, baseline?: string): string {
  if (baseline) {
    const sha = tryGit(cwd, ["rev-parse", baseline]);
    if (!sha) throw new Error(`Cannot resolve baseline: ${baseline}`);
    return sha;
  }
  // Prefer merge-base with main/master, else HEAD~0 (empty vs HEAD for dirty)
  for (const branch of ["origin/main", "main", "origin/master", "master"]) {
    const mb = tryGit(cwd, ["merge-base", "HEAD", branch]);
    if (mb) return mb;
  }
  const head = gitHead(cwd);
  if (!head) throw new Error("Cannot resolve baseline: not a git repo?");
  return head;
}
