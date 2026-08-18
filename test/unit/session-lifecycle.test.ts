import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { defaultConfig } from "../../src/config/schema.js";
import { startRun, getRun, cancelRun } from "../../src/core/run-registry.js";
import { DelegateError } from "../../src/core/errors.js";
import { FakePiExecutor } from "../fakes/fake-pi-executor.js";
import { setPiExecutorForTests } from "../../src/pi-sdk/factory.js";
import { immutableDelegationSafetyPrompt } from "../../src/pi-sdk/safety-prompt.js";
import { parseRunArgs } from "../../src/cli/run.js";
import { sessionsRoot } from "../../src/pi-sdk/session-store.js";
import type { PiAttemptPlan } from "../../src/pi-sdk/types.js";
import type { DelegateRequest } from "../../src/core/delegate.js";

const cleanup: string[] = [];
let prevStateHome: string | undefined;

beforeEach(() => {
  prevStateHome = process.env.XDG_STATE_HOME;
  const isolated = mkdtempSync(join(tmpdir(), "pi-sess-state-"));
  process.env.XDG_STATE_HOME = isolated;
  cleanup.push(isolated);
});

afterEach(() => {
  setPiExecutorForTests(undefined);
  if (prevStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = prevStateHome;
  for (const d of cleanup.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function initRepo(): string {
  const root = join(
    tmpdir(),
    `pi-sess-life-${process.pid}-${randomUUID().slice(0, 8)}`,
  );
  mkdirSync(root, { recursive: true });
  execSync("git init", { cwd: root });
  execSync('git config user.email "t@t"', { cwd: root });
  execSync('git config user.name "t"', { cwd: root });
  writeFileSync(join(root, "README.md"), "hello\n");
  execSync("git add . && git commit -m init", { cwd: root });
  cleanup.push(root);
  return root;
}

function cfgFor(workspace: string) {
  const config = defaultConfig();
  config.workspace.allowedRoots = [workspace];
  return config;
}

function req(
  partial: Partial<DelegateRequest> & { message: string },
): Omit<DelegateRequest, "config" | "signal" | "onProgress"> {
  return {
    taskName: "task",
    tools: ["read", "grep", "find", "ls"],
    noTools: false,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    thinking: "high",
    ...partial,
  };
}

async function waitRun(runId: string, timeoutMs = 8_000) {
  const start = Date.now();
  for (;;) {
    const r = getRun(runId);
    if (r && r.status !== "running" && r.status !== "queued") return r;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`run ${runId} still ${r?.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("immutableDelegationSafetyPrompt", () => {
  it("uses destination workspace and lists tools", () => {
    const text = immutableDelegationSafetyPrompt({
      tools: ["read", "bash"],
      workspace: "/tmp/wt/run-1",
      destinationWorkspace: "/tmp/origin",
    });
    expect(text).toContain("/tmp/origin");
    expect(text).toContain("read,bash");
    expect(text).not.toContain("/tmp/wt/run-1");
  });
});

describe("parseRunArgs --session-id", () => {
  it("parses a UUID session id", () => {
    const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const args = parseRunArgs([
      "--message",
      "go",
      "--session-id",
      id,
    ]);
    expect(args.sessionId).toBe(id);
  });
});

describe("persistent sessions via startRun", () => {
  it("returns sessionId and resumes with handle.kind === resume", async () => {
    const ws = initRepo();
    const plans: PiAttemptPlan[] = [];
    const fake = new FakePiExecutor(async (plan) => {
      plans.push(plan);
      return { finalText: "done", completion: "completed" };
    });
    const config = cfgFor(ws);
    const first = startRun({
      config,
      request: req({
        taskName: "reviewer",
        message: "first look",
        workspace: ws,
        executor: fake,
      }),
    });
    expect(first.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    const done1 = await waitRun(first.runId);
    expect(done1.status).toBe("success");
    expect(done1.result?.sessionId).toBe(first.sessionId);
    expect(plans[0]?.sessionHandle?.kind).toBe("create");
    expect(plans[0]?.prompt).toMatch(/Do not run `git commit`/);

    const second = startRun({
      config,
      request: req({
        taskName: "reviewer",
        message: "follow up",
        workspace: ws,
        sessionId: first.sessionId,
        executor: fake,
      }),
    });
    expect(second.sessionId).toBe(first.sessionId);
    const done2 = await waitRun(second.runId);
    expect(done2.status).toBe("success");
    expect(plans[1]?.sessionHandle?.kind).toBe("resume");
    expect(plans[1]?.prompt).not.toMatch(/Do not run `git commit`/);
    expect(plans[1]?.prompt).toMatch(/follow up/);
  });

  it("hides sessionId when disabled and rejects resume", async () => {
    const ws = initRepo();
    const config = cfgFor(ws);
    config.sessions.enabled = false;
    const fake = new FakePiExecutor(async () => ({
      finalText: "ok",
      completion: "completed",
    }));
    const first = startRun({
      config,
      request: req({ message: "no persist", workspace: ws, executor: fake }),
    });
    expect(first.sessionId).toBeUndefined();
    await waitRun(first.runId);

    let code: string | undefined;
    try {
      startRun({
        config,
        request: req({
          message: "resume",
          workspace: ws,
          sessionId: randomUUID(),
          executor: fake,
        }),
      });
    } catch (err) {
      expect(err).toBeInstanceOf(DelegateError);
      code = (err as DelegateError).code;
    }
    expect(code).toBe("session_disabled");
  });

  it("rejects a follow-up while the session is running", async () => {
    const ws = initRepo();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fake = new FakePiExecutor(async () => {
      await gate;
      return { finalText: "ok", completion: "completed" };
    });
    const config = cfgFor(ws);
    const first = startRun({
      config,
      request: req({
        taskName: "hold",
        message: "hold lock",
        workspace: ws,
        executor: fake,
      }),
    });
    expect(first.sessionId).toBeTruthy();
    try {
      expect(() =>
        startRun({
          config,
          request: req({
            taskName: "hold",
            message: "too soon",
            workspace: ws,
            sessionId: first.sessionId,
            executor: fake,
          }),
        }),
      ).toThrow(/in use/);
    } finally {
      release();
      cancelRun(first.runId);
      await waitRun(first.runId);
    }
  });

  it("runs in-place and keeps the session dir", async () => {
    const ws = initRepo();
    const fake = new FakePiExecutor(async (plan) => {
      writeFileSync(join(plan.cwd!, "README.md"), "edited\n");
      return { finalText: "ok", completion: "completed" };
    });
    const config = cfgFor(ws);
    const first = startRun({
      config,
      request: req({
        taskName: "writer",
        message: "edit",
        workspace: ws,
        tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
        executor: fake,
      }),
    });
    const done = await waitRun(first.runId);
    expect(done.status).toBe("success");
    expect(existsSync(join(sessionsRoot(ws), first.sessionId!))).toBe(true);
  });
});
