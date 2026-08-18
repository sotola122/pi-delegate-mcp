import { describe, it, expect, afterEach } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  acquireSessionLock,
  createPersistedSession,
  openPersistedSession,
  resolveSessionDir,
  sessionsRoot,
  setSessionWorktreePath,
  SESSIONS_REL,
} from "../../src/pi-sdk/session-store.js";
import { DelegateError } from "../../src/core/errors.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const identity = {
  taskName: "reviewer",
  provider: "openai-codex",
  model: "gpt-5.6-sol",
};

function tempWs(name: string): string {
  const dir = join(tmpdir(), `${name}-${process.pid}-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe("session-store containment", () => {
  it("creates gitignore, 0700 dirs, and a jsonl header before return", () => {
    const ws = tempWs("pi-sess-create");
    cleanup.push(ws);
    const created = createPersistedSession({ workspace: ws, identity });
    created.lock.release();
    expect(created.handle.kind).toBe("create");
    expect(existsSync(created.handle.jsonlPath)).toBe(true);
    const header = JSON.parse(
      readFileSync(created.handle.jsonlPath, "utf8").trim(),
    ) as { type: string; id: string };
    expect(header.type).toBe("session");
    expect(header.id).toBe(created.handle.sessionId);
    expect(existsSync(join(sessionsRoot(ws), ".gitignore"))).toBe(true);
    expect(readFileSync(join(sessionsRoot(ws), ".gitignore"), "utf8")).toBe(
      "*\n",
    );
  });

  it("rejects non-UUID session ids before path join", () => {
    const ws = tempWs("pi-sess-id");
    cleanup.push(ws);
    expect(() => resolveSessionDir(ws, "../escape")).toThrow(DelegateError);
    expect(() => resolveSessionDir(ws, "a/../../../tmp")).toThrow(DelegateError);
    expect(() => resolveSessionDir(ws, "..")).toThrow(DelegateError);
    expect(() => resolveSessionDir(ws, "foo\\bar")).toThrow(DelegateError);
  });

  it("rejects a sessions root that symlink-escapes the workspace", () => {
    const root = tempWs("pi-sess-link");
    cleanup.push(root);
    const ws = join(root, "ws");
    const outside = join(root, "outside");
    mkdirSync(ws);
    mkdirSync(outside);
    mkdirSync(join(ws, ".pi-delegate"));
    symlinkSync(outside, join(ws, ".pi-delegate", "sessions"));
    expect(() =>
      createPersistedSession({ workspace: ws, identity }),
    ).toThrow(/escapes workspace/);
  });

  it("open rejects forged jsonl basename that leaves the session dir", () => {
    const ws = tempWs("pi-sess-meta");
    cleanup.push(ws);
    const created = createPersistedSession({ workspace: ws, identity });
    created.lock.release();
    const metaFile = join(created.handle.sessionDir, "meta.json");
    const meta = JSON.parse(readFileSync(metaFile, "utf8")) as {
      jsonlBasename: string;
    };
    meta.jsonlBasename = "../other.jsonl";
    writeFileSync(metaFile, JSON.stringify(meta));
    expect(() =>
      openPersistedSession({
        workspace: ws,
        sessionId: created.handle.sessionId,
        expected: identity,
      }),
    ).toThrow(DelegateError);
  });

  it("tightens existing 0777 session dirs to 0700", () => {
    const ws = tempWs("pi-sess-mode");
    cleanup.push(ws);
    const id = randomUUID();
    const dir = join(ws, SESSIONS_REL, id);
    mkdirSync(dir, { recursive: true, mode: 0o777 });
    chmodSync(dir, 0o777);
    resolveSessionDir(ws, id);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});

describe("session-store identity and resume", () => {
  it("resumes the same sessionId and jsonl", () => {
    const ws = tempWs("pi-sess-open");
    cleanup.push(ws);
    const created = createPersistedSession({ workspace: ws, identity });
    created.lock.release();
    const opened = openPersistedSession({
      workspace: ws,
      sessionId: created.handle.sessionId,
      expected: identity,
    });
    opened.lock.release();
    expect(opened.handle.kind).toBe("resume");
    expect(opened.handle.sessionId).toBe(created.handle.sessionId);
    expect(opened.handle.jsonlPath).toBe(created.handle.jsonlPath);
    const mgr = SessionManager.open(
      opened.handle.jsonlPath,
      opened.handle.sessionDir,
      ws,
    );
    expect(mgr.getSessionId()).toBe(created.handle.sessionId);
  });

  it("rejects taskName, provider, and model mismatch", () => {
    const ws = tempWs("pi-sess-mm");
    cleanup.push(ws);
    const created = createPersistedSession({ workspace: ws, identity });
    created.lock.release();
    expect(() =>
      openPersistedSession({
        workspace: ws,
        sessionId: created.handle.sessionId,
        expected: { ...identity, taskName: "other" },
      }),
    ).toThrow(/Session mismatch/);
    expect(() =>
      openPersistedSession({
        workspace: ws,
        sessionId: created.handle.sessionId,
        expected: { ...identity, provider: "other" },
      }),
    ).toThrow(/Session mismatch/);
    expect(() =>
      openPersistedSession({
        workspace: ws,
        sessionId: created.handle.sessionId,
        expected: { ...identity, model: "gpt-5.6-luna" },
      }),
    ).toThrow(/Session mismatch/);
  });

  it("unknown sessionId is session_not_found", () => {
    const ws = tempWs("pi-sess-miss");
    cleanup.push(ws);
    expect(() =>
      openPersistedSession({
        workspace: ws,
        sessionId: randomUUID(),
        expected: identity,
      }),
    ).toThrow(/Unknown sessionId/);
  });

  it("records worktreePath in meta", () => {
    const ws = tempWs("pi-sess-wt");
    cleanup.push(ws);
    const created = createPersistedSession({ workspace: ws, identity });
    created.lock.release();
    const wt = join(ws, "wt");
    mkdirSync(wt);
    setSessionWorktreePath(created.handle.sessionDir, wt);
    const opened = openPersistedSession({
      workspace: ws,
      sessionId: created.handle.sessionId,
      expected: identity,
    });
    opened.lock.release();
    expect(opened.meta.worktreePath).toBe(wt);
  });
});

describe("session lock", () => {
  it("second acquire is immediately session_busy", () => {
    const ws = tempWs("pi-sess-busy");
    cleanup.push(ws);
    const created = createPersistedSession({ workspace: ws, identity });
    expect(() =>
      openPersistedSession({
        workspace: ws,
        sessionId: created.handle.sessionId,
        expected: identity,
      }),
    ).toThrow(/in use/);
    created.lock.release();
  });

  it("stale lock can be stolen; old owner release is ignored", () => {
    const ws = tempWs("pi-sess-stale");
    cleanup.push(ws);
    const dir = resolveSessionDir(ws, randomUUID());
    const first = acquireSessionLock(dir, "s", { staleMs: 50, now: 0 });
    const second = acquireSessionLock(dir, "s", { staleMs: 50, now: 1000 });
    first.release();
    expect(existsSync(join(dir, "lock.json"))).toBe(true);
    second.release();
    expect(existsSync(join(dir, "lock.json"))).toBe(false);
  });
});
