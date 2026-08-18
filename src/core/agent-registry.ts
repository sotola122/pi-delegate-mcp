import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { AppConfig, Effort, AllowedModel } from "../config/schema.js";
import { DelegateError } from "./errors.js";
import { resolveAgentContext } from "../agents/resolve.js";
import { resolveWorkspace } from "../workspace/roots.js";
import { stateDir, runsDir } from "../config/paths.js";
import {
  startRun,
  getRun,
  cancelRun,
  type RunRecord,
  type RunStatus,
} from "./run-registry.js";
import type { DelegateRequest } from "./delegate.js";
import type { ThinkingLevel } from "../pi-sdk/types.js";
import { compactTextField } from "../mcp/compact.js";

export type AgentStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "interrupted";

export interface AgentRecord {
  name: string;
  workspace?: string;
  runId: string;
  sessionId?: string;
  status: AgentStatus;
  agentType?: string;
  tools: string[];
  noTools: boolean;
  provider: string;
  model: string;
  thinking: ThinkingLevel;
  effort?: Effort;
  skillPaths: string[];
  developerInstructions: string;
  agentsMd: string;
  lastMessage: string;
  queuedMessage?: string;
  finalResponse?: string;
  error?: { code: string; message: string };
  createdAt: number;
  updatedAt: number;
}

const live = new Map<string, AgentRecord>();

function scopeKey(workspace: string | undefined): string {
  return createHash("sha256")
    .update(workspace ?? "")
    .digest("hex")
    .slice(0, 24);
}

function nameKey(taskName: string): string {
  return createHash("sha256").update(taskName).digest("hex").slice(0, 24);
}

function agentKey(workspace: string | undefined, taskName: string): string {
  return `${scopeKey(workspace)}:${nameKey(taskName)}`;
}

function indexPath(workspace: string | undefined, taskName: string): string {
  return join(stateDir(), "agents", scopeKey(workspace), `${nameKey(taskName)}.json`);
}

function persistAgent(record: AgentRecord): void {
  const p = indexPath(record.workspace, record.name);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(record) + "\n", { mode: 0o600 });
}

function loadPersisted(
  workspace: string | undefined,
  taskName: string,
): AgentRecord | undefined {
  const p = indexPath(workspace, taskName);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as AgentRecord;
  } catch {
    return undefined;
  }
}

export function normalizeTaskName(name: string): string {
  const normalized = name.trim().replace(/^\/+|\/+$/g, "");
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(normalized)) {
    throw new DelegateError(
      "task_name must use letters, digits, underscores, dashes, and optional slash path separators",
      "invalid_task_name",
      true,
    );
  }
  return normalized;
}

function mapRunStatus(status: RunStatus): AgentStatus {
  if (status === "running" || status === "queued") return "running";
  if (status === "success" || status === "incomplete") return "completed";
  if (status === "cancelled") return "interrupted";
  return "failed";
}

function isActive(status: AgentStatus): boolean {
  return status === "starting" || status === "running";
}

function syncFromRun(record: AgentRecord): AgentRecord {
  const run = getRun(record.runId);
  if (!run) return record;
  record.status = mapRunStatus(run.status);
  record.updatedAt = run.updatedAt;
  if (run.sessionId) record.sessionId = run.sessionId;
  if (run.result?.output !== undefined) record.finalResponse = run.result.output;
  if (run.error) record.error = run.error;
  persistAgent(record);
  return record;
}

export function getAgent(
  taskName: string,
  workspace?: string,
): AgentRecord | undefined {
  const name = normalizeTaskName(taskName);
  const key = agentKey(workspace, name);
  const mem = live.get(key);
  if (mem) return syncFromRun(mem);
  const persisted = loadPersisted(workspace, name);
  if (!persisted || persisted.name !== name) return undefined;
  live.set(key, persisted);
  return syncFromRun(persisted);
}

function listFromDisk(workspace?: string, prefix?: string): AgentRecord[] {
  const seen = new Set<string>();
  const out: AgentRecord[] = [];
  for (const rec of live.values()) {
    if (workspace && rec.workspace !== workspace) continue;
    if (prefix && !rec.name.startsWith(prefix)) continue;
    out.push(syncFromRun(rec));
    seen.add(agentKey(rec.workspace, rec.name));
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export function listAgents(opts: {
  workspace?: string;
  pathPrefix?: string;
}): AgentRecord[] {
  return listFromDisk(opts.workspace, opts.pathPrefix);
}

function maybeFollowUp(record: AgentRecord, config: AppConfig): void {
  const queued = record.queuedMessage;
  if (!queued) return;
  record.queuedMessage = undefined;
  persistAgent(record);
  startFollowUp(record, queued, config);
}

function startFollowUp(
  record: AgentRecord,
  message: string,
  config: AppConfig,
): void {
  const started = startRun({
    config,
    request: toRequest(record, message, config),
  });
  record.runId = started.runId;
  record.sessionId = started.sessionId ?? record.sessionId;
  record.status = "running";
  record.lastMessage = message;
  record.finalResponse = undefined;
  record.error = undefined;
  record.updatedAt = Date.now();
  persistAgent(record);
  live.set(agentKey(record.workspace, record.name), record);
  void watchRun(record, config);
}

function watchRun(record: AgentRecord, config: AppConfig): void {
  const tick = (): void => {
    syncFromRun(record);
    if (isActive(record.status)) {
      setTimeout(tick, 200);
      return;
    }
    maybeFollowUp(record, config);
  };
  setTimeout(tick, 50);
}

function toRequest(
  record: AgentRecord,
  message: string,
  config: AppConfig,
  sessionId?: string,
): Omit<DelegateRequest, "config" | "signal" | "onProgress"> {
  return {
    taskName: record.name,
    message,
    developerInstructions: record.developerInstructions,
    agentsMd: record.agentsMd,
    tools: record.tools,
    noTools: record.noTools,
    provider: record.provider,
    model: record.model,
    thinking: record.thinking,
    effort: record.effort,
    workspace: record.workspace,
    childSkills: record.skillPaths,
    agentType: record.agentType,
    sessionId: sessionId ?? record.sessionId,
  };
}

export function spawnAgent(opts: {
  config: AppConfig;
  taskName: string;
  message: string;
  prompt?: string;
  skills?: string[];
  agentType?: string;
  model?: AllowedModel | string;
  provider?: string;
  effort?: Effort;
  workspace?: string;
  mcpRoots?: string[];
  attachments?: string[];
  timeoutSeconds?: number;
}): { name: string; status: AgentStatus } {
  const name = normalizeTaskName(opts.taskName);
  let workspace: string | undefined;
  try {
    workspace = resolveWorkspace({
      workspace: opts.workspace,
      mcpRoots: opts.mcpRoots,
      config: opts.config,
    });
  } catch (err) {
    if (!(err instanceof DelegateError && err.code === "workspace_required")) {
      throw err;
    }
  }

  const existing = getAgent(name, workspace);
  if (existing && isActive(existing.status)) {
    throw new DelegateError(
      `Agent already running: ${name}`,
      "agent_busy",
      true,
    );
  }
  if (existing) {
    throw new DelegateError(
      `Agent name in use: ${name}. Use send_message.`,
      "agent_exists",
      true,
    );
  }

  const ctx = resolveAgentContext({
    config: opts.config,
    workspace,
    overrides: {
      prompt: opts.prompt,
      skills: opts.skills,
      model: opts.model,
      provider: opts.provider,
      effort: opts.effort,
      agentType: opts.agentType,
    },
  });

  const record: AgentRecord = {
    name,
    workspace,
    runId: "",
    status: "starting",
    agentType: opts.agentType ?? ctx.name,
    tools: ctx.tools,
    noTools: ctx.noTools,
    provider: ctx.provider,
    model: ctx.model,
    thinking: ctx.thinking,
    effort: ctx.effort,
    skillPaths: ctx.skills,
    developerInstructions: ctx.developerInstructions,
    agentsMd: ctx.agentsMd,
    lastMessage: opts.message,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const started = startRun({
    config: opts.config,
    request: {
      ...toRequest(record, opts.message, opts.config),
      mcpRoots: opts.mcpRoots,
      attachments: opts.attachments,
      timeoutSeconds: opts.timeoutSeconds,
      sessionId: undefined,
    },
  });
  record.runId = started.runId;
  record.sessionId = started.sessionId;
  record.status = "running";
  persistAgent(record);
  live.set(agentKey(workspace, name), record);
  void watchRun(record, opts.config);
  return { name, status: "running" };
}

export function sendMessage(opts: {
  config: AppConfig;
  target: string;
  message: string;
  workspace?: string;
  mcpRoots?: string[];
}): { name: string; status: AgentStatus } {
  let workspace = opts.workspace;
  if (!workspace && opts.mcpRoots?.length) {
    try {
      workspace = resolveWorkspace({
        workspace: opts.workspace,
        mcpRoots: opts.mcpRoots,
        config: opts.config,
      });
    } catch {
      // keep undefined
    }
  }
  const record = getAgent(opts.target, workspace);
  if (!record) {
    throw new DelegateError(
      `Unknown agent: ${opts.target}`,
      "agent_not_found",
      true,
    );
  }
  if (isActive(record.status)) {
    record.queuedMessage = opts.message;
    persistAgent(record);
    return { name: record.name, status: "running" };
  }
  startFollowUp(record, opts.message, opts.config);
  return { name: record.name, status: "running" };
}

export async function interruptAgent(opts: {
  target: string;
  workspace?: string;
  mcpRoots?: string[];
  config: AppConfig;
}): Promise<{ name: string; status: AgentStatus }> {
  let workspace = opts.workspace;
  if (!workspace && opts.mcpRoots?.length) {
    try {
      workspace = resolveWorkspace({
        workspace: opts.workspace,
        mcpRoots: opts.mcpRoots,
        config: opts.config,
      });
    } catch {
      // keep undefined
    }
  }
  const record = getAgent(opts.target, workspace);
  if (!record) {
    throw new DelegateError(
      `Unknown agent: ${opts.target}`,
      "agent_not_found",
      true,
    );
  }
  record.queuedMessage = undefined;
  if (isActive(record.status)) {
    try {
      cancelRun(record.runId);
    } catch {
      // already terminal
    }
  }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const run = getRun(record.runId);
    if (!run?.sessionLock) break;
    await sleep(15);
  }
  const synced = syncFromRun(record);
  synced.status = "interrupted";
  persistAgent(synced);
  return { name: synced.name, status: synced.status };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function compactAgent(record: AgentRecord, includeText: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: record.name,
    status: record.status,
  };
  if (record.error) out.err = record.error.code;
  if (!includeText || record.finalResponse === undefined) return out;
  const fullPath = join(runsDir(), record.runId, "result", "output.md");
  const { text, full } = compactTextField(record.finalResponse, fullPath);
  out.text = text;
  if (full) out.full = full;
  return out;
}

export async function waitAgent(opts: {
  config: AppConfig;
  workspace?: string;
  mcpRoots?: string[];
  targets?: string[];
}): Promise<Record<string, unknown>> {
  let workspace = opts.workspace;
  if (!workspace && opts.mcpRoots?.length) {
    try {
      workspace = resolveWorkspace({
        workspace: opts.workspace,
        mcpRoots: opts.mcpRoots,
        config: opts.config,
      });
    } catch {
      // keep undefined
    }
  }
  const budget = opts.config.limits.waitBudgetMs;
  const deadline = Date.now() + budget;
  const names = opts.targets?.map(normalizeTaskName);
  const pick = (): AgentRecord[] => {
    if (names?.length) {
      return names
        .map((n) => getAgent(n, workspace))
        .filter((a): a is AgentRecord => Boolean(a));
    }
    return listAgents({ workspace });
  };

  let agents = pick();
  if (names?.length && agents.length !== names.length) {
    const missing = names.filter((n) => !agents.some((a) => a.name === n));
    throw new DelegateError(
      `Unknown agent: ${missing.join(",")}`,
      "agent_not_found",
      true,
    );
  }
  if (!agents.length) {
    throw new DelegateError("No agents to wait on", "agent_not_found", true);
  }

  while (Date.now() < deadline) {
    agents = pick();
    const done = agents.find((a) => !isActive(a.status));
    if (done) return compactAgent(done, true);
    await sleep(50);
  }
  agents = pick();
  const running = agents.find((a) => isActive(a.status)) ?? agents[0]!;
  return {
    ...compactAgent(running, false),
    wait: pollWait(running),
  };
}

export async function waitAllAgents(opts: {
  config: AppConfig;
  workspace?: string;
  mcpRoots?: string[];
  targets?: string[];
}): Promise<Record<string, unknown>> {
  let workspace = opts.workspace;
  if (!workspace && opts.mcpRoots?.length) {
    try {
      workspace = resolveWorkspace({
        workspace: opts.workspace,
        mcpRoots: opts.mcpRoots,
        config: opts.config,
      });
    } catch {
      // keep undefined
    }
  }
  const budget = opts.config.limits.waitBudgetMs;
  const deadline = Date.now() + budget;
  const names = opts.targets?.map(normalizeTaskName);
  const pick = (): AgentRecord[] => {
    if (names?.length) {
      return names
        .map((n) => getAgent(n, workspace))
        .filter((a): a is AgentRecord => Boolean(a));
    }
    return listAgents({ workspace });
  };
  let agents = pick();
  if (names?.length && agents.length !== names.length) {
    throw new DelegateError("Unknown agent in targets", "agent_not_found", true);
  }
  if (!agents.length) {
    throw new DelegateError("No agents to wait on", "agent_not_found", true);
  }
  while (Date.now() < deadline) {
    agents = pick();
    if (agents.every((a) => !isActive(a.status))) {
      return {
        agents: agents.map((a) => compactAgent(a, true)),
      };
    }
    await sleep(50);
  }
  agents = pick();
  const pending = agents.filter((a) => isActive(a.status));
  return {
    status: pending.length ? "running" : "completed",
    wait: pending.length ? pollWait(pending[0]!) : 0,
    agents: agents.map((a) => compactAgent(a, !isActive(a.status))),
  };
}

function pollWait(record: AgentRecord): number {
  const elapsed = Date.now() - record.createdAt;
  if (!isActive(record.status)) return 0;
  const sec = Math.floor(elapsed / 1000);
  if (sec < 30) return 15;
  if (sec < 90) return 30;
  return 60;
}

export function readAgentResponse(opts: {
  target: string;
  workspace?: string;
  mcpRoots?: string[];
  config: AppConfig;
}): Record<string, unknown> {
  let workspace = opts.workspace;
  if (!workspace && opts.mcpRoots?.length) {
    try {
      workspace = resolveWorkspace({
        workspace: opts.workspace,
        mcpRoots: opts.mcpRoots,
        config: opts.config,
      });
    } catch {
      // keep undefined
    }
  }
  const record = getAgent(opts.target, workspace);
  if (!record) {
    throw new DelegateError(
      `Unknown agent: ${opts.target}`,
      "agent_not_found",
      true,
    );
  }
  syncFromRun(record);
  return compactAgent(record, true);
}

export function listAgentsPublic(opts: {
  workspace?: string;
  mcpRoots?: string[];
  pathPrefix?: string;
  config: AppConfig;
}): Record<string, unknown> {
  let workspace = opts.workspace;
  if (!workspace && opts.mcpRoots?.length) {
    try {
      workspace = resolveWorkspace({
        workspace: opts.workspace,
        mcpRoots: opts.mcpRoots,
        config: opts.config,
      });
    } catch {
      // keep undefined
    }
  }
  const agents = listAgents({
    workspace,
    pathPrefix: opts.pathPrefix,
  }).map((a) => ({ name: a.name, status: a.status }));
  return { agents };
}

/** Test helper */
export function resetAgentsForTests(): void {
  live.clear();
}

export type { RunRecord };
