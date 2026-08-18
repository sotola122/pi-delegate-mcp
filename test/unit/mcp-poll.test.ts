import { describe, it, expect, afterEach } from "vitest";
import { pollAfterSeconds, startedRunPublic, POLL_HINT } from "../../src/core/poll.js";
import { parseAcceptanceEvidence } from "../../src/core/result.js";
import {
  startRun,
  startSmoke,
  getRun,
  runToPublic,
  updateRunProgress,
  cancelRun,
} from "../../src/core/run-registry.js";
import { defaultConfig } from "../../src/config/schema.js";
import { FakePiExecutor } from "../fakes/fake-pi-executor.js";
import { setPiExecutorForTests } from "../../src/pi-sdk/factory.js";
import { DelegateError } from "../../src/core/errors.js";

describe("pollAfterSeconds", () => {
  it("stages 15 → 30 → 60 while running", () => {
    expect(pollAfterSeconds("running", 0)).toBe(15);
    expect(pollAfterSeconds("running", 29_000)).toBe(15);
    expect(pollAfterSeconds("running", 30_000)).toBe(30);
    expect(pollAfterSeconds("running", 89_000)).toBe(30);
    expect(pollAfterSeconds("running", 90_000)).toBe(60);
    expect(pollAfterSeconds("queued", 45_000)).toBe(30);
  });

  it("returns 0 for terminal statuses", () => {
    expect(pollAfterSeconds("success", 120_000)).toBe(0);
    expect(pollAfterSeconds("incomplete", 5_000)).toBe(0);
    expect(pollAfterSeconds("failed", 5_000)).toBe(0);
  });
});

describe("startedRunPublic", () => {
  it("includes poll contract fields", () => {
    const p = startedRunPublic("00000000-0000-4000-8000-000000000001");
    expect(p.pollAfterSeconds).toBe(15);
    expect(p.hint).toBe(POLL_HINT);
    expect(p.poll).toBe("get_run");
    expect(p.sessionId).toBeUndefined();
  });

  it("includes sessionId when provided", () => {
    const p = startedRunPublic(
      "00000000-0000-4000-8000-000000000001",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(p.sessionId).toBe("11111111-1111-4111-8111-111111111111");
  });
});

describe("parseAcceptanceEvidence structured", () => {
  it("parses Acceptance bullets with exact check text", () => {
    const out = `# Verify Result

## Acceptance
- bun run typecheck exits 0: pass — tsc ok
- bun run test exits 0: fail — 2 failed
`;
    const ev = parseAcceptanceEvidence(out, [
      "bun run typecheck exits 0",
      "bun run test exits 0",
    ]);
    expect(ev[0]?.status).toBe("pass");
    expect(ev[1]?.status).toBe("fail");
  });

  it("parses em-dash form", () => {
    const ev = parseAcceptanceEvidence(
      "- build succeeds — pass — logs clean",
      ["build succeeds"],
    );
    expect(ev[0]?.status).toBe("pass");
  });
});

describe("runToPublic views and heartbeat", () => {
  it("status view omits result; tools progress advances updatedAt", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fake = new FakePiExecutor(async (plan) => {
      plan.onProgress?.({ phase: "prompting", agentStarted: true });
      await gate;
      return {
        finalText: "# Review Result\n\n## Acceptance\n- ok: pass — done\n",
        completion: "completed",
      };
    });

    const started = startRun({
      config: defaultConfig(),
      request: {
        taskName: "poll",
        message: "poll test",
        tools: ["read", "grep", "find", "ls"],
        noTools: false,
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        thinking: "high",
        executor: fake,
      },
    });

    // Wait until the fake is blocked on the gate (still running)
    let before = getRun(started.runId);
    for (let i = 0; i < 50 && before?.status !== "running"; i++) {
      await new Promise((r) => setTimeout(r, 10));
      before = getRun(started.runId);
    }
    expect(before?.status).toBe("running");
    const t0 = before!.updatedAt;

    updateRunProgress(started.runId, {
      phase: "tools",
      toolCalls: 2,
      lastTool: "bash",
      agentStarted: true,
    });

    const after = getRun(started.runId)!;
    expect(after.updatedAt).toBeGreaterThanOrEqual(t0);
    expect(after.progress?.phase).toBe("tools");
    expect(after.progress?.lastTool).toBe("bash");

    const statusView = runToPublic(after, "status");
    expect(statusView.result).toBeUndefined();
    expect(statusView.wait).toBe(15);
    expect(statusView.poll).toBe("wait_agent");

    const fullWhileRunning = runToPublic(after, "full");
    expect(fullWhileRunning.result).toBeNull();

    release!();
    cancelRun(started.runId);
  });
});

describe("startSmoke", () => {
  afterEach(() => {
    setPiExecutorForTests(undefined);
  });

  it("returns immediately and reports success via get_run", async () => {
    setPiExecutorForTests(new FakePiExecutor());
    const started = startSmoke({
      config: defaultConfig(),
      mode: "planned-tuple",
    });
    expect(started.status).toBe("running");
    const running = getRun(started.runId);
    expect(running?.status).toBe("running");
    const statusView = runToPublic(running!, "status");
    expect(statusView.result).toBeUndefined();
    expect(statusView.poll).toBe("wait_agent");
    expect(statusView.wait).toBe(15);

    let done = getRun(started.runId);
    for (let i = 0; i < 50 && done?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 10));
      done = getRun(started.runId);
    }
    expect(done?.status).toBe("success");
    const full = runToPublic(done!, "full");
    const result = full.result as { output: string; status: string };
    expect(result.status).toBe("success");
    expect(result.output.trim()).toBe("OK");
  });

  it("cancel while smoke is running marks the run cancelled", async () => {
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    setPiExecutorForTests(
      new FakePiExecutor(undefined, async (_plan, signal) => {
        entered = true;
        if (signal.aborted) {
          throw new DelegateError("cancelled", "cancelled", true);
        }
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            reject(new DelegateError("cancelled", "cancelled", true));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          void gate.then(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          });
        });
        return { ok: true, stdout: "OK\n" };
      }),
    );

    const started = startSmoke({
      config: defaultConfig(),
      mode: "provider-auth",
    });
    for (let i = 0; i < 50 && !entered; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(entered).toBe(true);

    cancelRun(started.runId);
    let done = getRun(started.runId);
    for (let i = 0; i < 50 && done?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 10));
      done = getRun(started.runId);
    }
    expect(done?.status).toBe("cancelled");
    release();
  });
});
