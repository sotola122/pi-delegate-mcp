import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, ProfileName } from "../../config/schema.js";
import { runSmokeTest } from "../../pi-sdk/smoke.js";
import { resolveProvider } from "../../core/provider.js";
import {
  startRun,
  getRun,
  cancelRun,
  runToPublic,
  startedRunPublic,
} from "../../core/run-registry.js";
import {
  startBatch,
  getBatch,
  cancelBatch,
  batchToPublic,
  type BatchTaskSpec,
} from "../../core/batch.js";
import { annotations } from "../annotations.js";
import { jsonToMcpContent, errorToMcpContent } from "../adapter.js";
import {
  reviewInputSchema,
  verifyInputSchema,
  implementInputSchema,
  judgeInputSchema,
  manualInputSchema,
  smokeInputSchema,
  getRunInputSchema,
  cancelRunInputSchema,
  getBatchInputSchema,
  cancelBatchInputSchema,
  batchInputSchema,
  rolesInputSchema,
} from "./schemas.js";

export interface ToolContext {
  config: AppConfig;
  getRoots: () => string[];
}

const POLL_CONTRACT =
  "Async: returns runId + pollAfterSeconds. Wait that many seconds, then call get_run with view=status until status is terminal; finally get_run with view=full for the result. Do not busy-poll.";

function hasWritable(roles: Array<{ profile: ProfileName }>): boolean {
  return roles.some((r) => r.profile === "verify" || r.profile === "implement");
}

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "delegate_review",
    {
      title: "Delegate Review",
      description: `Start a read-only review (async). ${POLL_CONTRACT} Perspectives return batchId; poll with get_batch.`,
      inputSchema: reviewInputSchema,
      annotations: annotations.review,
    },
    async (args) => {
      try {
        const roots = ctx.getRoots();
        if (args.perspectives?.length) {
          const tasks: BatchTaskSpec[] = args.perspectives.map((p) => ({
            roleId: p.roleId,
            profile: "review",
            objective: p.objective ?? `${args.objective} [${p.roleId}]`,
            reviewKind: args.reviewKind,
            baseline: args.baseline,
            inScope: args.inScope,
            outOfScope: args.outOfScope,
            acceptanceChecks: args.acceptanceChecks,
            lenses: p.lenses ?? args.lenses,
            focus: p.focus ?? args.focus,
            effort: p.effort ?? args.effort,
            model: p.model ?? args.model,
            attachments: args.attachments,
            childSkills: args.childSkills,
            timeoutSeconds: args.timeoutSeconds,
          }));
          const batch = startBatch({
            config: ctx.config,
            workspace: args.workspace,
            mcpRoots: roots,
            execution: "parallel",
            tasks,
          });
          return jsonToMcpContent(batch);
        }

        const started = startRun({
          config: ctx.config,
          request: {
            profile: "review",
            objective: args.objective,
            workspace: args.workspace,
            mcpRoots: roots,
            reviewKind: args.reviewKind,
            baseline: args.baseline,
            inScope: args.inScope,
            outOfScope: args.outOfScope,
            acceptanceChecks: args.acceptanceChecks,
            lenses: args.lenses,
            focus: args.focus,
            effort: args.effort,
            model: args.model,
            attachments: args.attachments,
            childSkills: args.childSkills,
            timeoutSeconds: args.timeoutSeconds,
          },
        });
        return jsonToMcpContent(startedRunPublic(started.runId));
      } catch (err) {
        return errorToMcpContent(err);
      }
    },
  );

  server.registerTool(
    "delegate_verify",
    {
      title: "Delegate Verify",
      description: `Start verification (async). ${POLL_CONTRACT}`,
      inputSchema: verifyInputSchema,
      annotations: annotations.verify,
    },
    async (args) => {
      try {
        const started = startRun({
          config: ctx.config,
          request: {
            profile: "verify",
            objective: args.objective,
            workspace: args.workspace,
            mcpRoots: ctx.getRoots(),
            inScope: args.inScope,
            outOfScope: args.outOfScope,
            acceptanceChecks: args.acceptanceChecks,
            suggestedChecks: args.suggestedChecks,
            effort: args.effort,
            model: args.model,
            attachments: args.attachments,
            childSkills: args.childSkills,
            workspaceMode: args.workspaceMode,
            timeoutSeconds: args.timeoutSeconds,
          },
        });
        return jsonToMcpContent(startedRunPublic(started.runId));
      } catch (err) {
        return errorToMcpContent(err);
      }
    },
  );

  server.registerTool(
    "delegate_implement",
    {
      title: "Delegate Implement",
      description: `Start implement in a worktree (async). Default delivery is patch. ${POLL_CONTRACT}`,
      inputSchema: implementInputSchema,
      annotations: annotations.implement,
    },
    async (args) => {
      try {
        const started = startRun({
          config: ctx.config,
          request: {
            profile: "implement",
            objective: args.objective,
            workspace: args.workspace,
            mcpRoots: ctx.getRoots(),
            inScope: args.inScope,
            outOfScope: args.outOfScope,
            acceptanceChecks: args.acceptanceChecks,
            effort: args.effort,
            model: args.model,
            attachments: args.attachments,
            childSkills: args.childSkills,
            delivery: args.delivery,
            timeoutSeconds: args.timeoutSeconds,
          },
        });
        return jsonToMcpContent(startedRunPublic(started.runId));
      } catch (err) {
        return errorToMcpContent(err);
      }
    },
  );

  server.registerTool(
    "delegate_judge",
    {
      title: "Delegate Judge",
      description: `Start a no-tools judgment (async). ${POLL_CONTRACT}`,
      inputSchema: judgeInputSchema,
      annotations: annotations.judge,
    },
    async (args) => {
      try {
        const objective = args.suppliedMaterial
          ? `${args.objective}\n\n---\nSupplied material:\n${args.suppliedMaterial}`
          : args.objective;
        const started = startRun({
          config: ctx.config,
          request: {
            profile: "no-tools",
            objective,
            attachments: args.attachments,
            acceptanceChecks: args.acceptanceChecks,
            lenses: args.lenses,
            effort: args.effort,
            model: args.model,
            timeoutSeconds: args.timeoutSeconds,
          },
        });
        return jsonToMcpContent(startedRunPublic(started.runId));
      } catch (err) {
        return errorToMcpContent(err);
      }
    },
  );

  server.registerTool(
    "delegate_manual",
    {
      title: "Delegate Manual",
      description: `Start a manual-prompt delegation under a fixed profile (async). ${POLL_CONTRACT}`,
      inputSchema: manualInputSchema,
      annotations: annotations.manual,
    },
    async (args) => {
      try {
        const started = startRun({
          config: ctx.config,
          request: {
            profile: args.profile,
            objective: args.objective,
            workspace: args.workspace,
            mcpRoots: args.profile === "no-tools" ? undefined : ctx.getRoots(),
            inScope: args.inScope,
            outOfScope: args.outOfScope,
            acceptanceChecks: args.acceptanceChecks,
            effort: args.effort,
            model: args.model,
            attachments: args.attachments,
            childSkills: args.childSkills,
            delivery: args.delivery,
            manualPrompt: args.prompt,
            promptMode: args.promptMode ?? "append",
            timeoutSeconds: args.timeoutSeconds,
          },
        });
        return jsonToMcpContent(startedRunPublic(started.runId));
      } catch (err) {
        return errorToMcpContent(err);
      }
    },
  );

  server.registerTool(
    "delegate_batch",
    {
      title: "Delegate Batch",
      description:
        "Start multiple delegated tasks (parallel or sequential). Returns batchId; poll with get_batch.",
      inputSchema: batchInputSchema,
      annotations: annotations.batch,
    },
    async (args) => {
      try {
        const batch = startBatch({
          config: ctx.config,
          workspace: args.workspace,
          mcpRoots: ctx.getRoots(),
          execution: args.execution,
          tasks: args.tasks,
        });
        return jsonToMcpContent(batch);
      } catch (err) {
        return errorToMcpContent(err);
      }
    },
  );

  server.registerTool(
    "delegate_roles",
    {
      title: "Delegate Roles",
      description:
        "Role-based multi-delegate (e.g. implementer → verifier → parallel reviewers). Returns batchId; poll with get_batch.",
      inputSchema: rolesInputSchema,
      annotations: annotations.roles,
    },
    async (args) => {
      try {
        const execution =
          args.execution ??
          (hasWritable(args.roles) ? "sequential" : "parallel");
        const tasks: BatchTaskSpec[] = args.roles.map((r) => ({
          roleId: r.roleId,
          profile: r.profile,
          objective: r.objective ?? `${args.objective} [${r.roleId}]`,
          reviewKind:
            r.profile === "review" ? (args.reviewKind ?? "static-hunt") : undefined,
          baseline: args.baseline,
          inScope: r.inScope,
          outOfScope: r.outOfScope,
          acceptanceChecks: r.acceptanceChecks,
          lenses: r.lenses,
          focus: r.focus,
          delivery: r.delivery,
          workspaceMode: r.workspaceMode,
          effort: r.effort,
          model: r.model,
          timeoutSeconds: r.timeoutSeconds,
        }));
        const batch = startBatch({
          config: ctx.config,
          workspace: args.workspace,
          mcpRoots: ctx.getRoots(),
          execution,
          tasks,
        });
        return jsonToMcpContent(batch);
      } catch (err) {
        return errorToMcpContent(err);
      }
    },
  );

  server.registerTool(
    "get_run",
    {
      title: "Get Run",
      description:
        "Poll an async delegation. Prefer view=status while running (no result payload; honor pollAfterSeconds). Use view=full only after status is terminal to fetch result/output.",
      inputSchema: getRunInputSchema,
      annotations: annotations.getRun,
    },
    async (args) => {
      try {
        const record = getRun(args.runId);
        if (!record) {
          return jsonToMcpContent(
            { status: "failed", code: "run_not_found", runId: args.runId },
            true,
          );
        }
        const view =
          args.view ??
          (record.status === "running" || record.status === "queued"
            ? "status"
            : "full");
        return jsonToMcpContent(runToPublic(record, view));
      } catch (err) {
        return errorToMcpContent(err);
      }
    },
  );

  server.registerTool(
    "cancel_run",
    {
      title: "Cancel Run",
      description: "Cancel a running async delegation.",
      inputSchema: cancelRunInputSchema,
      annotations: annotations.cancelRun,
    },
    async (args) => {
      try {
        return jsonToMcpContent(runToPublic(cancelRun(args.runId)));
      } catch (err) {
        return errorToMcpContent(err);
      }
    },
  );

  server.registerTool(
    "get_batch",
    {
      title: "Get Batch",
      description: "Poll status/results of a multi-task batch.",
      inputSchema: getBatchInputSchema,
      annotations: annotations.getRun,
    },
    async (args) => {
      try {
        const batch = getBatch(args.batchId);
        if (!batch) {
          return jsonToMcpContent(
            { status: "failed", code: "batch_not_found", batchId: args.batchId },
            true,
          );
        }
        return jsonToMcpContent(batchToPublic(batch));
      } catch (err) {
        return errorToMcpContent(err);
      }
    },
  );

  server.registerTool(
    "cancel_batch",
    {
      title: "Cancel Batch",
      description: "Cancel all runs in a batch.",
      inputSchema: cancelBatchInputSchema,
      annotations: annotations.cancelRun,
    },
    async (args) => {
      try {
        const batch = cancelBatch(args.batchId);
        return jsonToMcpContent(batchToPublic(batch));
      } catch (err) {
        return errorToMcpContent(err);
      }
    },
  );

  server.registerTool(
    "smoke_test",
    {
      title: "Smoke Test",
      description:
        "Synchronous SDK connectivity check (stdout OK). Prefer mode=planned-tuple; provider-auth can hit MCP client timeouts. For long work use async delegate_* tools instead of smoke_test.",
      inputSchema: smokeInputSchema,
      annotations: annotations.smoke,
    },
    async (args, extra) => {
      try {
        const resolved =
          args.mode === "planned-tuple"
            ? resolveProvider({
                config: ctx.config,
                effort: args.effort,
                model: args.model,
              })
            : undefined;
        const smoke = await runSmokeTest({
          config: ctx.config,
          mode: args.mode,
          resolved,
          timeoutSeconds: args.timeoutSeconds,
          signal: extra.signal,
        });
        return jsonToMcpContent(
          { status: smoke.ok ? "success" : "failed", ...smoke },
          !smoke.ok,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const looksTimedOut = /abort|timeout|timed out/i.test(message);
        return jsonToMcpContent(
          {
            status: "failed",
            ok: false,
            error: message,
            ...(looksTimedOut
              ? {
                  timed_out_client_hint:
                    "MCP client may have cut a long sync smoke_test. Prefer mode=planned-tuple with a shorter timeout, or use async delegate_* tools.",
                }
              : {}),
          },
          true,
        );
      }
    },
  );
}
