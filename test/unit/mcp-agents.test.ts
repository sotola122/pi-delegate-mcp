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
import { FakePiExecutor } from "../fakes/fake-pi-executor.js";
import { setPiExecutorForTests } from "../../src/pi-sdk/factory.js";
import { DelegateError } from "../../src/core/errors.js";
import { ensureAgentHome } from "../../src/agents/home.js";
import type { PiAttemptPlan } from "../../src/pi-sdk/types.js";
import {
  spawnAgent,
  waitAgent,
  waitAllAgents,
  listAgentsPublic,
  readAgentResponse,
  sendMessage,
  interruptAgent,
  resetAgentsForTests,
} from "../../src/core/agent-registry.js";
import { COMPACT_MAX_LINES } from "../../src/mcp/compact.js";

const cleanup: string[] = [];
let prevStateHome: string | undefined;

beforeEach(() => {
  prevStateHome = process.env.XDG_STATE_HOME;
  const isolated = mkdtempSync(join(tmpdir(), "pi-agent-state-"));
  process.env.XDG_STATE_HOME = isolated;
  cleanup.push(isolated);
});

afterEach(() => {
  resetAgentsForTests();
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
    `pi-mcp-ag-${process.pid}-${randomUUID().slice(0, 8)}`,
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

function setupHome(): string {
  const home = mkdtempSync(join(tmpdir(), "pi-mcp-home-"));
  cleanup.push(home);
  ensureAgentHome(home);
  writeFileSync(
    join(home, "agents", "reviewer.toml"),
    `
name = "reviewer"
description = "Focused review"
provider = "openai-codex"
model = "gpt-5.6-sol"
model_reasoning_effort = "xhigh"
tools = ["read", "grep", "find", "ls"]
developer_instructions = """
Stay brief.
"""
`,
  );
  return home;
}

function cfg(workspace: string, home: string) {
  const config = defaultConfig();
  config.workspace.allowedRoots = [workspace];
  config.agents.home = home;
  config.limits.waitBudgetMs = 2500;
  return config;
}

describe("spawn/wait/read compact contract", () => {
  it("acks spawn, omits text while running, then returns truncated text", async () => {
    const ws = initRepo();
    const home = setupHome();
    const config = cfg(ws, home);
    config.limits.waitBudgetMs = 250;

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const long = Array.from({ length: COMPACT_MAX_LINES + 20 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    const plans: PiAttemptPlan[] = [];
    setPiExecutorForTests(
      new FakePiExecutor(async (plan) => {
        plans.push(plan);
        await gate;
        return { finalText: long, completion: "completed" };
      }),
    );

    const started = spawnAgent({
      config,
      taskName: "reviewer",
      message: "review src",
      agentType: "reviewer",
      workspace: ws,
    });
    expect(started).toEqual({ name: "reviewer", status: "running" });
    expect(Object.keys(started)).toEqual(["name", "status"]);

    const running = await waitAgent({
      config,
      workspace: ws,
      targets: ["reviewer"],
    });
    expect(running.status).toBe("running");
    expect(running.name).toBe("reviewer");
    expect(running.text).toBeUndefined();
    expect(running.wait).toBeGreaterThan(0);

    release();
    config.limits.waitBudgetMs = 4000;
    let done: Record<string, unknown> | undefined;
    const start = Date.now();
    while (Date.now() - start < 5000) {
      done = await waitAgent({
        config,
        workspace: ws,
        targets: ["reviewer"],
      });
      if (done.status !== "running") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(done?.status).toBe("completed");
    expect(typeof done?.text).toBe("string");
    expect(String(done?.text).split("\n").length).toBeLessThanOrEqual(
      COMPACT_MAX_LINES,
    );
    expect(done?.full).toBeTruthy();
    expect(existsSync(String(done?.full))).toBe(true);

    expect(plans[0]?.tools).toEqual(["read", "grep", "find", "ls"]);
    expect(plans[0]?.model).toBe("gpt-5.6-sol");
    expect(plans[0]?.provider).toBe("openai-codex");
    expect(plans[0]?.thinking).toBe("xhigh");
    expect(plans[0]?.prompt).toContain("Stay brief.");
    expect(plans[0]?.prompt).toContain("review src");
    expect(plans[0]?.prompt).not.toMatch(/# Review Result/);

    const listed = listAgentsPublic({ config, workspace: ws });
    expect(listed.agents).toEqual([{ name: "reviewer", status: "completed" }]);
  });

  it("passes template skills through to Pi childSkillPaths", async () => {
    const ws = initRepo();
    const home = setupHome();
    const skill = mkdtempSync(join(tmpdir(), "pi-spawn-skill-"));
    cleanup.push(skill);
    writeFileSync(join(skill, "SKILL.md"), "# Spawn skill\n");
    writeFileSync(
      join(home, "agents", "reviewer.toml"),
      `
name = "reviewer"
tools = ["read", "grep", "find", "ls"]
[[skills.config]]
path = "${skill}"
enabled = true
`,
    );
    const config = cfg(ws, home);
    const plans: PiAttemptPlan[] = [];
    setPiExecutorForTests(
      new FakePiExecutor(async (plan) => {
        plans.push(plan);
        return { finalText: "ok", completion: "completed" };
      }),
    );
    spawnAgent({
      config,
      taskName: "with-skill",
      message: "go",
      agentType: "reviewer",
      workspace: ws,
    });
    await waitUntil("with-skill", ws, config, "completed");
    expect(plans[0]?.childSkillPaths.some((p) => p.includes("pi-spawn-skill-"))).toBe(
      true,
    );
  });
});

describe("send_message and interrupt", () => {
  it("resumes a settled session with send_message", async () => {
    const ws = initRepo();
    const home = setupHome();
    const config = cfg(ws, home);
    const prompts: string[] = [];
    setPiExecutorForTests(
      new FakePiExecutor(async (plan) => {
        prompts.push(plan.prompt);
        return { finalText: `ok:${prompts.length}`, completion: "completed" };
      }),
    );

    spawnAgent({
      config,
      taskName: "follow",
      message: "first",
      agentType: "reviewer",
      workspace: ws,
    });
    const first = await waitUntil("follow", ws, config, "completed");
    expect(first.text).toBe("ok:1");

    const sent = sendMessage({
      config,
      target: "follow",
      message: "second",
      workspace: ws,
    });
    expect(sent.status).toBe("running");
    const second = await waitUntil("follow", ws, config, "completed");
    expect(second.text).toBe("ok:2");
    expect(prompts[1]).toContain("second");
  });

  it("interrupts the current turn and keeps the session for send_message", async () => {
    const ws = initRepo();
    const home = setupHome();
    const config = cfg(ws, home);

    setPiExecutorForTests(
      new FakePiExecutor(async (_plan, signal) => {
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) {
            reject(new DelegateError("cancelled", "cancelled", true));
            return;
          }
          signal.addEventListener(
            "abort",
            () => reject(new DelegateError("cancelled", "cancelled", true)),
            { once: true },
          );
        });
        return { finalText: "should-not", completion: "completed" };
      }),
    );

    spawnAgent({
      config,
      taskName: "held",
      message: "hold",
      agentType: "reviewer",
      workspace: ws,
    });
    const stopped = await interruptAgent({
      target: "held",
      workspace: ws,
      config,
    });
    expect(stopped.status).toBe("interrupted");

    const read = readAgentResponse({ target: "held", workspace: ws, config });
    expect(read.status).toBe("interrupted");

    setPiExecutorForTests(
      new FakePiExecutor(async () => ({
        finalText: "after-interrupt",
        completion: "completed",
      })),
    );
    sendMessage({
      config,
      target: "held",
      message: "continue",
      workspace: ws,
    });
    const resumed = await waitUntil("held", ws, config, "completed");
    expect(resumed.text).toBe("after-interrupt");
  });

  it("keeps interrupted even if the run later reports success", async () => {
    const ws = initRepo();
    const home = setupHome();
    const config = cfg(ws, home);
    setPiExecutorForTests(
      new FakePiExecutor(async () => {
        await new Promise((r) => setTimeout(r, 80));
        return { finalText: "late-success", completion: "completed" };
      }),
    );
    spawnAgent({
      config,
      taskName: "late",
      message: "hold",
      agentType: "reviewer",
      workspace: ws,
    });
    const stopped = await interruptAgent({
      target: "late",
      workspace: ws,
      config,
    });
    expect(stopped.status).toBe("interrupted");
    await new Promise((r) => setTimeout(r, 150));
    const read = readAgentResponse({ target: "late", workspace: ws, config });
    expect(read.status).toBe("interrupted");
    expect(read.text).not.toBe("late-success");
  });

  it("surfaces run errors as failed with code/err", async () => {
    const ws = initRepo();
    const home = setupHome();
    const config = cfg(ws, home);
    setPiExecutorForTests(
      new FakePiExecutor(async () => {
        throw new DelegateError("blocked by policy", "policy_denied", false);
      }),
    );
    spawnAgent({
      config,
      taskName: "boom",
      message: "go",
      agentType: "reviewer",
      workspace: ws,
    });
    const done = await waitUntil("boom", ws, config, "failed");
    expect(done.status).toBe("failed");
    expect(done.code).toBe("policy_denied");
    expect(done.err).toBe("blocked by policy");
  });

  it("queues send_message while running", async () => {
    const ws = initRepo();
    const home = setupHome();
    const config = cfg(ws, home);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let n = 0;
    setPiExecutorForTests(
      new FakePiExecutor(async () => {
        n += 1;
        const turn = n;
        if (turn === 1) await gate;
        return { finalText: `turn${turn}`, completion: "completed" };
      }),
    );

    spawnAgent({
      config,
      taskName: "steer",
      message: "one",
      agentType: "reviewer",
      workspace: ws,
    });
    const queued = sendMessage({
      config,
      target: "steer",
      message: "two",
      workspace: ws,
    });
    expect(queued.status).toBe("running");
    release();

    const start = Date.now();
    let rec = readAgentResponse({ target: "steer", workspace: ws, config });
    while (Date.now() - start < 5000 && rec.text !== "turn2") {
      await new Promise((r) => setTimeout(r, 20));
      rec = readAgentResponse({ target: "steer", workspace: ws, config });
    }
    expect(rec.text).toBe("turn2");
  });
});

describe("wait_all_agents", () => {
  it("returns compact rows once both agents finish", async () => {
    const ws = initRepo();
    const home = setupHome();
    const config = cfg(ws, home);
    setPiExecutorForTests(
      new FakePiExecutor(async (plan) => ({
        finalText: plan.prompt.includes("alpha") ? "A" : "B",
        completion: "completed",
      })),
    );
    spawnAgent({
      config,
      taskName: "a1",
      message: "alpha",
      agentType: "reviewer",
      workspace: ws,
    });
    spawnAgent({
      config,
      taskName: "b1",
      message: "beta",
      agentType: "reviewer",
      workspace: ws,
    });
    const all = await waitAllAgents({
      config,
      workspace: ws,
      targets: ["a1", "b1"],
    });
    const agents = all.agents as Array<{ name: string; status: string; text?: string }>;
    expect(agents).toHaveLength(2);
    expect(agents.every((a) => a.status === "completed")).toBe(true);
    expect(agents.map((a) => a.text).sort()).toEqual(["A", "B"]);
  });
});

describe("wait_agent", () => {
  it("returns the first specified agent that finishes", async () => {
    const ws = initRepo();
    const home = setupHome();
    const config = cfg(ws, home);
    config.limits.waitBudgetMs = 2500;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    setPiExecutorForTests(
      new FakePiExecutor(async (plan) => {
        if (plan.prompt.includes("slow")) await gate;
        return {
          finalText: plan.prompt.includes("slow") ? "SLOW" : "FAST",
          completion: "completed",
        };
      }),
    );
    spawnAgent({
      config,
      taskName: "slow",
      message: "slow",
      agentType: "reviewer",
      workspace: ws,
    });
    spawnAgent({
      config,
      taskName: "fast",
      message: "fast",
      agentType: "reviewer",
      workspace: ws,
    });
    const first = await waitAgent({
      config,
      workspace: ws,
      targets: ["slow", "fast"],
    });
    expect(first.name).toBe("fast");
    expect(first.status).toBe("completed");
    expect(first.text).toBe("FAST");
    release();
    await waitUntil("slow", ws, config, "completed");
  });
});

describe("call-root workspace default", () => {
  it("spawn without workspace uses mcpRoots so wait/read find the agent", async () => {
    const ws = initRepo();
    const home = setupHome();
    const config = cfg(ws, home);
    setPiExecutorForTests(
      new FakePiExecutor(async () => ({
        finalText: "from-root",
        completion: "completed",
      })),
    );
    spawnAgent({
      config,
      taskName: "via-root",
      message: "go",
      agentType: "reviewer",
      mcpRoots: [ws],
    });
    const done = await waitUntil("via-root", undefined, config, "completed", [ws]);
    expect(done.text).toBe("from-root");
    const read = readAgentResponse({
      target: "via-root",
      config,
      mcpRoots: [ws],
    });
    expect(read.text).toBe("from-root");
  });
});

async function waitUntil(
  name: string,
  workspace: string | undefined,
  config: ReturnType<typeof cfg>,
  status: string,
  mcpRoots?: string[],
): Promise<Record<string, unknown>> {
  const start = Date.now();
  for (;;) {
    const rec = await waitAgent({
      config,
      workspace,
      mcpRoots,
      targets: [name],
    });
    if (rec.status === status) return rec;
    if (Date.now() - start > 5000) {
      throw new Error(`agent ${name} still ${String(rec.status)}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}
