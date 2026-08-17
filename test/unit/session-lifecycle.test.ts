import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { defaultConfig } from "../../src/config/schema.js";
import { startRun, getRun, cancelRun } from "../../src/core/run-registry.js";
import { startBatch, getBatch, batchToPublic } from "../../src/core/batch.js";
import { DelegateError } from "../../src/core/errors.js";
import { FakePiExecutor } from "../fakes/fake-pi-executor.js";
import { setPiExecutorForTests } from "../../src/pi-sdk/factory.js";
import { immutableDelegationSafetyPrompt } from "../../src/pi-sdk/safety-prompt.js";
import { parseRunArgs } from "../../src/cli/run.js";
import { sessionsRoot } from "../../src/pi-sdk/session-store.js";
import type { PiAttemptPlan } from "../../src/pi-sdk/types.js";

const cleanup: string[] = [];
let prevStateHome: string | undefined;

beforeEach(() => {
  // Isolate run/lock dirs so live MCP verify/implement locks cannot stall these tests.
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

async function waitBatch(batchId: string, timeoutMs = 12_000) {
  const start = Date.now();
  for (;;) {
    const b = getBatch(batchId);
    if (!b) throw new Error(`missing batch ${batchId}`);
    const pub = batchToPublic(b);
    if (pub.status !== "running") return pub;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`batch ${batchId} still running`);
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

describe("immutableDelegationSafetyPrompt", () => {
  it("uses destination workspace and omits inScope / worktree path", () => {
    const text = immutableDelegationSafetyPrompt({
      profile: "implement",
      workspace: "/tmp/wt/run-1",
      destinationWorkspace: "/tmp/origin",
      inScope: ["src"],
      outOfScope: ["secrets"],
    });
    expect(text).toContain("/tmp/origin");
    expect(text).not.toContain("/tmp/wt/run-1");
    expect(text).not.toContain("inScope");
    expect(text).not.toContain("- src");
  });
});

describe("parseRunArgs --session-id", () => {
  it("parses a UUID session id", () => {
    const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const args = parseRunArgs([
      "--profile",
      "review",
      "--objective",
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
      return {
        finalText: "# Review Result\n\n## Acceptance\n- ok: pass — done\n",
        completion: "completed",
      };
    });
    const config = cfgFor(ws);
    const first = startRun({
      config,
      request: {
        profile: "review",
        objective: "first look",
        workspace: ws,
        reviewKind: "static-hunt",
        executor: fake,
      },
    });
    expect(first.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    const done1 = await waitRun(first.runId);
    expect(done1.status).toBe("success");
    expect(done1.result?.sessionId).toBe(first.sessionId);
    expect(plans[0]?.sessionHandle?.kind).toBe("create");
    expect(plans[0]?.prompt).toMatch(/independent second opinion/);

    const second = startRun({
      config,
      request: {
        profile: "review",
        objective: "follow up",
        workspace: ws,
        reviewKind: "static-hunt",
        sessionId: first.sessionId,
        executor: fake,
      },
    });
    expect(second.sessionId).toBe(first.sessionId);
    const done2 = await waitRun(second.runId);
    expect(done2.status).toBe("success");
    expect(plans[1]?.sessionHandle?.kind).toBe("resume");
    expect(plans[1]?.sessionHandle).toMatchObject({
      sessionId: first.sessionId,
    });
    expect(plans[1]?.prompt).not.toMatch(/independent second opinion/);
    expect(plans[1]?.prompt).toMatch(/follow up/);
  });

  it("hides sessionId when disabled and rejects resume", async () => {
    const ws = initRepo();
    const config = cfgFor(ws);
    config.sessions.enabled = false;
    const fake = new FakePiExecutor(async () => ({
      finalText: "# Review Result\n\n## Acceptance\n- ok: pass — done\n",
      completion: "completed",
    }));
    const first = startRun({
      config,
      request: {
        profile: "review",
        objective: "no persist",
        workspace: ws,
        reviewKind: "static-hunt",
        executor: fake,
      },
    });
    expect(first.sessionId).toBeUndefined();
    await waitRun(first.runId);

    let code: string | undefined;
    try {
      startRun({
        config,
        request: {
          profile: "review",
          objective: "resume",
          workspace: ws,
          reviewKind: "static-hunt",
          sessionId: randomUUID(),
          executor: fake,
        },
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
      return {
        finalText: "# Review Result\n\n## Acceptance\n- ok: pass — done\n",
        completion: "completed",
      };
    });
    const config = cfgFor(ws);
    const first = startRun({
      config,
      request: {
        profile: "review",
        objective: "hold lock",
        workspace: ws,
        reviewKind: "static-hunt",
        executor: fake,
      },
    });
    expect(first.sessionId).toBeTruthy();
    try {
      expect(() =>
        startRun({
          config,
          request: {
            profile: "review",
            objective: "too soon",
            workspace: ws,
            reviewKind: "static-hunt",
            sessionId: first.sessionId,
            executor: fake,
          },
        }),
      ).toThrow(/in use/);
    } finally {
      release();
      cancelRun(first.runId);
      await waitRun(first.runId);
    }
  });

  it("reuses the implement worktree on attempt 2 and on resume", async () => {
    const ws = initRepo();
    const cwds: string[] = [];
    const fake = new FakePiExecutor(async (plan) => {
      cwds.push(plan.cwd ?? "");
      const target = join(plan.cwd!, "README.md");
      if (plan.attempt === 0 && plan.sessionHandle?.kind === "create") {
        writeFileSync(target, "v1\n");
        return { finalText: "missing heading", completion: "incomplete" };
      }
      expect(readFileSync(target, "utf8")).toMatch(/v[12]/);
      writeFileSync(target, `${readFileSync(target, "utf8").trim()}+edit\n`);
      return {
        finalText:
          "# Implement Result\n\n## Acceptance\n- ok: pass — done\n",
        completion: "completed",
      };
    });
    const config = cfgFor(ws);
    const first = startRun({
      config,
      request: {
        profile: "implement",
        objective: "edit readme",
        workspace: ws,
        inScope: ["README.md"],
        acceptanceChecks: ["ok"],
        executor: fake,
      },
    });
    const done1 = await waitRun(first.runId);
    expect(done1.status).toBe("success");
    expect(cwds.length).toBeGreaterThanOrEqual(2);
    expect(cwds[0]).toBe(cwds[1]);
    expect(existsSync(cwds[0]!)).toBe(true);
    expect(readFileSync(join(cwds[0]!, "README.md"), "utf8")).toContain("v1");

    const second = startRun({
      config,
      request: {
        profile: "implement",
        objective: "continue",
        workspace: ws,
        inScope: ["README.md"],
        acceptanceChecks: ["ok"],
        sessionId: first.sessionId,
        executor: fake,
      },
    });
    const done2 = await waitRun(second.runId);
    expect(done2.status).toBe("success");
    const resumePlan = cwds[cwds.length - 1];
    expect(resumePlan).toBe(cwds[0]);
    expect(readFileSync(join(resumePlan!, "README.md"), "utf8")).toContain(
      "edit",
    );
  });
});

describe("batch sessions stay on destination workspace", () => {
  it("returns per-child sessionId and does not delete origin sessions with the pipeline", async () => {
    const ws = initRepo();
    const fake = new FakePiExecutor(async (plan) => {
      if (plan.profile === "verify") {
        return {
          finalText:
            "# Verify Result\n\n## Acceptance\n- ok: pass — done\n",
          completion: "completed",
        };
      }
      return {
        finalText: "# Review Result\n\n## Acceptance\n- ok: pass — done\n",
        completion: "completed",
      };
    });
    setPiExecutorForTests(fake);
    const config = cfgFor(ws);
    const started = startBatch({
      config,
      workspace: ws,
      execution: "sequential",
      tasks: [
        {
          roleId: "ver",
          profile: "verify",
          objective: "verify",
          acceptanceChecks: ["ok"],
        },
        {
          roleId: "rev",
          profile: "review",
          objective: "review",
          reviewKind: "static-hunt",
        },
      ],
    });
    expect(started.runs[0]?.sessionId).toBeTruthy();
    const done = await waitBatch(started.batchId);
    expect(done.status).toBe("success");
    const runs = done.runs as Array<{ roleId: string; sessionId?: string }>;
    expect(runs.find((r) => r.roleId === "ver")?.sessionId).toBeTruthy();
    expect(runs.find((r) => r.roleId === "rev")?.sessionId).toBeTruthy();
    expect(getBatch(started.batchId)?.pipelineWorktree).toBeUndefined();
    const verId = runs.find((r) => r.roleId === "ver")!.sessionId!;
    const revId = runs.find((r) => r.roleId === "rev")!.sessionId!;
    expect(existsSync(join(sessionsRoot(ws), verId))).toBe(true);
    expect(existsSync(join(sessionsRoot(ws), revId))).toBe(true);
  });
});
