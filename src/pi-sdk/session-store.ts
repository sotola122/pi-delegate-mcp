import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../config/schema.js";
import { DelegateError } from "../core/errors.js";
import { assertSafeSessionId } from "../core/ids.js";
import { isPathInside, resolveRealPath } from "../workspace/roots.js";

export const SESSIONS_REL = join(".pi-delegate", "sessions");

export type SessionHandle =
  | { kind: "memory" }
  | { kind: "create"; sessionId: string; jsonlPath: string; sessionDir: string }
  | { kind: "resume"; sessionId: string; jsonlPath: string; sessionDir: string };

export interface SessionMeta {
  sessionId: string;
  jsonlBasename: string;
  taskName: string;
  agentType?: string;
  provider: string;
  model: string;
  destinationWorkspace: string;
  worktreePath?: string;
  lastRunId?: string;
}

export interface SessionLock {
  sessionId: string;
  nonce: string;
  path: string;
  release: () => void;
  heartbeat: () => void;
}

export interface SessionIdentity {
  taskName: string;
  provider: string;
  model: string;
}

interface LockPayload {
  nonce: string;
  pid: number;
  at: number;
}

const DEFAULT_STALE_MS = (3 * 60 * 60 + 10 * 60) * 1000;

export function sessionsEnabled(config: AppConfig): boolean {
  return config.sessions.enabled !== false;
}

export function sessionsRoot(workspace: string): string {
  return resolve(workspace, SESSIONS_REL);
}

function ensureMode(path: string, dir: boolean): void {
  try {
    chmodSync(path, dir ? 0o700 : 0o600);
  } catch {
    // best-effort
  }
}

function assertInside(parent: string, child: string, code: string, message: string): void {
  if (!isPathInside(parent, child)) {
    throw new DelegateError(message, code, true);
  }
}

export function resolveSessionDir(workspace: string, sessionId: string): string {
  assertSafeSessionId(sessionId);
  const ws = resolveRealPath(workspace);
  const root = sessionsRoot(ws);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  ensureMode(root, true);
  const gitignore = join(root, ".gitignore");
  if (!existsSync(gitignore)) {
    writeFileSync(gitignore, "*\n", { mode: 0o600 });
  }
  ensureMode(gitignore, false);

  const realRoot = resolveRealPath(root);
  assertInside(
    ws,
    realRoot,
    "session_path_escape",
    `Sessions root escapes workspace: ${realRoot}`,
  );

  const dir = join(root, sessionId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  ensureMode(dir, true);
  const realDir = resolveRealPath(dir);
  assertInside(
    realRoot,
    realDir,
    "session_path_escape",
    `Session dir escapes sessions root: ${realDir}`,
  );
  return realDir;
}

function metaPath(sessionDir: string): string {
  return join(sessionDir, "meta.json");
}

function lockPath(sessionDir: string): string {
  return join(sessionDir, "lock.json");
}

function assertJsonlInSessionDir(sessionDir: string, jsonlBasename: string): string {
  if (
    !jsonlBasename ||
    jsonlBasename !== basename(jsonlBasename) ||
    jsonlBasename.includes("..") ||
    jsonlBasename.includes(sep) ||
    jsonlBasename.includes("/") ||
    jsonlBasename.includes("\\")
  ) {
    throw new DelegateError(
      `Invalid session jsonl name: ${JSON.stringify(jsonlBasename)}`,
      "session_path_escape",
      true,
    );
  }
  const jsonl = join(sessionDir, jsonlBasename);
  const real = existsSync(jsonl) ? resolveRealPath(jsonl) : resolve(jsonl);
  assertInside(
    sessionDir,
    real,
    "session_path_escape",
    `Session jsonl escapes session dir: ${real}`,
  );
  return jsonl;
}

export function readSessionMeta(sessionDir: string): SessionMeta {
  const p = metaPath(sessionDir);
  if (!existsSync(p)) {
    throw new DelegateError("Session metadata missing", "session_not_found", true);
  }
  const meta = JSON.parse(readFileSync(p, "utf8")) as SessionMeta;
  assertJsonlInSessionDir(sessionDir, meta.jsonlBasename);
  return meta;
}

export function writeSessionMeta(sessionDir: string, meta: SessionMeta): void {
  assertJsonlInSessionDir(sessionDir, meta.jsonlBasename);
  const p = metaPath(sessionDir);
  const tmp = `${p}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(meta, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, p);
  ensureMode(p, false);
}

export function setSessionWorktreePath(
  sessionDir: string,
  worktreePath: string,
): void {
  const meta = readSessionMeta(sessionDir);
  meta.worktreePath = worktreePath;
  writeSessionMeta(sessionDir, meta);
}

function readLock(path: string): LockPayload | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LockPayload;
  } catch {
    return undefined;
  }
}

export function acquireSessionLock(
  sessionDir: string,
  sessionId: string,
  opts?: { staleMs?: number; now?: number },
): SessionLock {
  const path = lockPath(sessionDir);
  const staleMs = opts?.staleMs ?? DEFAULT_STALE_MS;
  const now = opts?.now ?? Date.now();
  const nonce = randomUUID();
  const payload: LockPayload = { nonce, pid: process.pid, at: now };

  const writeWx = (): boolean => {
    try {
      writeFileSync(path, JSON.stringify(payload) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      return true;
    } catch {
      return false;
    }
  };

  if (!writeWx()) {
    const existing = readLock(path);
    if (existing && now - existing.at <= staleMs) {
      throw new DelegateError(
        `Session is in use: ${sessionId}`,
        "session_busy",
        true,
      );
    }
    const again = readLock(path);
    if (again && existing && again.nonce !== existing.nonce) {
      throw new DelegateError(
        `Session is in use: ${sessionId}`,
        "session_busy",
        true,
      );
    }
    writeFileSync(path, JSON.stringify(payload) + "\n", { mode: 0o600 });
  }
  ensureMode(path, false);

  return {
    sessionId,
    nonce,
    path,
    heartbeat: () => {
      const cur = readLock(path);
      if (!cur || cur.nonce !== nonce) return;
      writeFileSync(
        path,
        JSON.stringify({ ...cur, at: Date.now() }) + "\n",
        { mode: 0o600 },
      );
    },
    release: () => {
      const cur = readLock(path);
      if (!cur || cur.nonce !== nonce) return;
      try {
        unlinkSync(path);
      } catch {
        // ignore
      }
    },
  };
}

function forceWriteHeader(mgr: SessionManager): string {
  const jsonl = mgr.getSessionFile();
  if (!jsonl) {
    throw new DelegateError(
      "SessionManager did not produce a session file",
      "session_create_failed",
      true,
    );
  }
  mkdirSync(dirname(jsonl), { recursive: true, mode: 0o700 });
  if (!existsSync(jsonl) || statSync(jsonl).size === 0) {
    const header = mgr.getHeader();
    writeFileSync(jsonl, `${JSON.stringify(header)}\n`, { mode: 0o600 });
  }
  ensureMode(jsonl, false);
  return jsonl;
}

export function createPersistedSession(opts: {
  workspace: string;
  sessionId?: string;
  identity: SessionIdentity;
  lastRunId?: string;
  staleMs?: number;
}): { handle: Extract<SessionHandle, { kind: "create" }>; meta: SessionMeta; lock: SessionLock } {
  const sessionId = assertSafeSessionId(opts.sessionId ?? randomUUID());
  const sessionDir = resolveSessionDir(opts.workspace, sessionId);
  const mgr = SessionManager.create(opts.workspace, sessionDir, { id: sessionId });
  const jsonlPath = forceWriteHeader(mgr);
  const jsonlBasename = basename(jsonlPath);
  assertJsonlInSessionDir(sessionDir, jsonlBasename);
  const meta: SessionMeta = {
    sessionId,
    jsonlBasename,
    taskName: opts.identity.taskName,
    provider: opts.identity.provider,
    model: opts.identity.model,
    destinationWorkspace: resolveRealPath(opts.workspace),
    lastRunId: opts.lastRunId,
  };
  writeSessionMeta(sessionDir, meta);
  const lock = acquireSessionLock(sessionDir, sessionId, { staleMs: opts.staleMs });
  return {
    handle: { kind: "create", sessionId, jsonlPath, sessionDir },
    meta,
    lock,
  };
}

export function openPersistedSession(opts: {
  workspace: string;
  sessionId: string;
  expected: SessionIdentity;
  lastRunId?: string;
  staleMs?: number;
}): { handle: Extract<SessionHandle, { kind: "resume" }>; meta: SessionMeta; lock: SessionLock } {
  const sessionId = assertSafeSessionId(opts.sessionId);
  const sessionDir = resolveSessionDir(opts.workspace, sessionId);
  if (!existsSync(metaPath(sessionDir))) {
    throw new DelegateError(
      `Unknown sessionId: ${sessionId}`,
      "session_not_found",
      true,
    );
  }
  const meta = readSessionMeta(sessionDir);
  if (
    meta.taskName !== opts.expected.taskName ||
    meta.provider !== opts.expected.provider ||
    meta.model !== opts.expected.model
  ) {
    throw new DelegateError(
      `Session mismatch: stored ${meta.taskName}/${meta.provider}/${meta.model} vs requested ${opts.expected.taskName}/${opts.expected.provider}/${opts.expected.model}`,
      "session_mismatch",
      true,
    );
  }
  const jsonlPath = assertJsonlInSessionDir(sessionDir, meta.jsonlBasename);
  if (!existsSync(jsonlPath)) {
    throw new DelegateError(
      `Session file missing: ${meta.jsonlBasename}`,
      "session_not_found",
      true,
    );
  }
  if (opts.lastRunId) {
    meta.lastRunId = opts.lastRunId;
    writeSessionMeta(sessionDir, meta);
  }
  const lock = acquireSessionLock(sessionDir, sessionId, { staleMs: opts.staleMs });
  return {
    handle: { kind: "resume", sessionId, jsonlPath, sessionDir },
    meta,
    lock,
  };
}

export const MEMORY_SESSION: SessionHandle = { kind: "memory" };
