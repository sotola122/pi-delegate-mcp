import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  getAgentDir,
  type AgentSession,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { PiAttemptPlan, ThinkingLevel } from "./types.js";
import { createDelegationResourceLoader } from "./resource-loader.js";
import { toolsAreWritable } from "../agents/types.js";

type AnyModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

export interface SessionBundle {
  session: AgentSession;
  dispose: () => void | Promise<void>;
}

function buildSdkSettings(plan: PiAttemptPlan): Record<string, unknown> {
  const retry = plan.config.sdk?.providerRetry;
  return {
    compaction: { enabled: true },
    retry: {
      enabled: retry?.enabled ?? true,
      maxRetries: retry?.maxRetries ?? 2,
    },
  };
}

export async function createDelegationSession(opts: {
  plan: PiAttemptPlan;
  modelRuntime: ModelRuntime;
  model: AnyModel;
}): Promise<SessionBundle> {
  const { plan, modelRuntime, model } = opts;
  const cwd = plan.cwd ?? process.cwd();
  const agentDir = plan.config.pi.agentDir ?? getAgentDir();
  const settingsManager = SettingsManager.inMemory(buildSdkSettings(plan));
  const handle = plan.sessionHandle;
  const sessionManager =
    handle && handle.kind !== "memory"
      ? SessionManager.open(handle.jsonlPath, handle.sessionDir, cwd)
      : SessionManager.inMemory(cwd);
  const resourceLoader = await createDelegationResourceLoader({
    plan,
    settingsManager,
    agentDir,
  });

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model,
    thinkingLevel: plan.thinking as ThinkingLevel,
    tools: plan.noTools ? [] : plan.tools,
    excludeTools: plan.excludeTools,
    noTools: plan.noTools ? "all" : undefined,
    resourceLoader,
    sessionManager,
    settingsManager,
  });

  if (
    plan.config.sdk?.writableToolExecution !== "parallel" &&
    toolsAreWritable(plan.tools)
  ) {
    session.agent.toolExecution = "sequential";
  }

  return {
    session,
    dispose: () => {
      try {
        session.dispose();
      } catch {
        // ignore dispose errors
      }
    },
  };
}
