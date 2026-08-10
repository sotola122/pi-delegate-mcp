import { realpathSync, existsSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, normalize, sep } from "node:path";
import { DelegateError } from "../core/errors.js";
import type { AppConfig } from "../config/schema.js";
import { runsDir } from "../config/paths.js";
import { gitRoot } from "./git.js";

export function resolveRealPath(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

export function isPathInside(parent: string, child: string): boolean {
  const p = resolveRealPath(parent);
  const c = resolveRealPath(child);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * Built-in roots for read-only MCP/filesystem attachments (not writable
 * workspaces). Cursor plans/skills and staged delegate-pi / run artifacts.
 */
export function trustedAttachmentRoots(): string[] {
  const home = homedir();
  return [
    join(home, ".cursor", "plans"),
    join(home, ".cursor", "skills"),
    join(home, ".agents", "skills"),
    join(tmpdir(), "delegate-pi"),
    runsDir(),
  ];
}

export function resolveWorkspace(opts: {
  workspace?: string;
  mcpRoots?: string[];
  config: AppConfig;
}): string {
  const candidates: string[] = [];
  if (opts.workspace) candidates.push(opts.workspace);
  else if (opts.mcpRoots?.length === 1) candidates.push(opts.mcpRoots[0]!);
  else if ((opts.mcpRoots?.length ?? 0) > 1) {
    throw new DelegateError(
      "Multiple workspace roots are available. Pass workspace explicitly.",
      "workspace_required",
      false,
    );
  } else {
    throw new DelegateError(
      "workspace is required (pass workspace or configure a single MCP root)",
      "workspace_required",
      false,
    );
  }

  const raw = candidates[0]!;
  if (!existsSync(raw)) {
    throw new DelegateError(`Workspace does not exist: ${raw}`, "workspace_missing", true);
  }
  const ws = resolveRealPath(raw);
  if (!statSync(ws).isDirectory()) {
    throw new DelegateError(`Workspace is not a directory: ${ws}`, "workspace_invalid", true);
  }

  const allowed = opts.config.workspace.allowedRoots;
  if (allowed.length > 0) {
    const ok = allowed.some((root) => isPathInside(root, ws));
    if (!ok) {
      throw new DelegateError(
        `Workspace outside allowedRoots: ${ws}`,
        "workspace_forbidden",
        true,
      );
    }
  }

  // If the workspace sits inside a larger git repo, the git root must also
  // stay inside an authorized root (otherwise sibling dirs leak into worktrees).
  assertGitRootAllowed(ws, undefined, opts.config);

  return ws;
}

/**
 * When `allowedRoots` is configured, require the git toplevel (if any) to
 * lie inside an allowed root. `repoRoot` may be precomputed.
 */
export function assertGitRootAllowed(
  workspace: string,
  repoRoot: string | null | undefined,
  config: AppConfig,
): void {
  const allowed = config.workspace.allowedRoots;
  if (!allowed.length) return;

  const resolved = repoRoot === undefined ? gitRoot(workspace) : repoRoot;
  if (!resolved) return;

  const realRoot = resolveRealPath(resolved);
  const ok = allowed.some((a) => isPathInside(a, realRoot));
  if (!ok) {
    throw new DelegateError(
      `Git root outside allowedRoots: ${realRoot} (workspace ${workspace})`,
      "git_root_forbidden",
      true,
    );
  }
}

function assertAttachmentAllowed(
  abs: string,
  workspace: string | undefined,
  config: AppConfig,
): void {
  if (workspace && isPathInside(workspace, abs)) return;

  const allowed = config.workspace.allowedRoots;
  if (allowed.length > 0 && allowed.some((r) => isPathInside(r, abs))) {
    return;
  }

  if (trustedAttachmentRoots().some((r) => isPathInside(r, abs))) {
    return;
  }

  if (!workspace) {
    throw new DelegateError(
      allowed.length === 0
        ? `Filesystem attachments require workspace.allowedRoots or a trusted attachment root when no workspace is set: ${abs}`
        : `Attachment outside allowedRoots and trusted attachment roots: ${abs}`,
      "attachment_root_required",
      true,
    );
  }

  throw new DelegateError(
    `Attachment outside workspace, allowedRoots, and trusted attachment roots: ${abs}`,
    "attachment_escape",
    true,
  );
}

export function validateAttachmentPaths(
  workspace: string | undefined,
  attachments: string[],
  config: AppConfig,
): string[] {
  if (attachments.length > config.limits.maxAttachmentCount) {
    throw new DelegateError("Too many attachments", "too_many_attachments", true);
  }
  const out: string[] = [];
  for (const a of attachments) {
    const normalized = normalize(a);
    if (normalized.includes("..")) {
      throw new DelegateError(
        `Attachment path traversal rejected: ${a}`,
        "path_traversal",
        true,
      );
    }
    const abs = resolveRealPath(a);
    if (!existsSync(abs)) {
      throw new DelegateError(
        `Attachment does not exist: ${a}`,
        "attachment_missing",
        true,
      );
    }
    const st = statSync(abs);
    if (st.isFile() && st.size > config.limits.maxAttachmentBytes) {
      throw new DelegateError(
        `Attachment exceeds maxAttachmentBytes: ${a}`,
        "attachment_too_large",
        true,
      );
    }
    assertAttachmentAllowed(abs, workspace, config);
    out.push(abs);
  }
  return out;
}
