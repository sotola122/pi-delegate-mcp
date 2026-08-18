import type { AppConfig } from "../config/schema.js";
import { DelegateError } from "./errors.js";
import { resolveWorkspace } from "../workspace/roots.js";
import {
  createPersistedSession,
  MEMORY_SESSION,
  openPersistedSession,
  sessionsEnabled,
  writeSessionMeta,
  type SessionHandle,
  type SessionLock,
  type SessionMeta,
} from "../pi-sdk/session-store.js";

export interface PreparedSession {
  handle: SessionHandle;
  lock?: SessionLock;
  meta?: SessionMeta;
  destinationWorkspace?: string;
}

export function prepareRunSession(opts: {
  config: AppConfig;
  taskName: string;
  provider: string;
  model: string;
  workspace?: string;
  destinationWorkspace?: string;
  mcpRoots?: string[];
  sessionId?: string;
  persist?: boolean;
  runId?: string;
  agentType?: string;
}): PreparedSession {
  const persist = (opts.persist ?? true) && sessionsEnabled(opts.config);
  if (!persist) {
    if (opts.sessionId) {
      throw new DelegateError(
        "Persistent sessions are disabled",
        "session_disabled",
        true,
      );
    }
    return { handle: MEMORY_SESSION };
  }

  let destination = opts.destinationWorkspace;
  if (!destination) {
    try {
      destination = resolveWorkspace({
        workspace: opts.workspace,
        mcpRoots: opts.mcpRoots,
        config: opts.config,
      });
    } catch (err) {
      if (opts.sessionId) {
        throw new DelegateError(
          "sessionId requires a resolvable workspace",
          "session_disabled",
          true,
        );
      }
      if (err instanceof DelegateError && err.code === "workspace_required") {
        return { handle: MEMORY_SESSION };
      }
      throw err;
    }
  }

  const identity = {
    taskName: opts.taskName,
    provider: opts.provider,
    model: opts.model,
  };

  if (opts.sessionId) {
    const opened = openPersistedSession({
      workspace: destination,
      sessionId: opts.sessionId,
      expected: identity,
      lastRunId: opts.runId,
    });
    return {
      handle: opened.handle,
      lock: opened.lock,
      meta: opened.meta,
      destinationWorkspace: destination,
    };
  }

  const created = createPersistedSession({
    workspace: destination,
    identity,
    lastRunId: opts.runId,
  });
  if (opts.agentType) {
    created.meta.agentType = opts.agentType;
    writeSessionMeta(created.handle.sessionDir, created.meta);
  }
  return {
    handle: created.handle,
    lock: created.lock,
    meta: created.meta,
    destinationWorkspace: destination,
  };
}
