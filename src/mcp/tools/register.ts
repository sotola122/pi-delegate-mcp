import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../config/schema.js";
import { DelegateError } from "../../core/errors.js";
import { annotations } from "../annotations.js";
import { jsonToMcpContent, errorToMcpContent } from "../adapter.js";
import {
  spawnAgent,
  waitAgent,
  waitAllAgents,
  listAgentsPublic,
  readAgentResponse,
  sendMessage,
  interruptAgent,
} from "../../core/agent-registry.js";
import {
  spawnAgentInputSchema,
  waitAgentInputSchema,
  waitAllAgentsInputSchema,
  listAgentsInputSchema,
  readAgentResponseInputSchema,
  sendMessageInputSchema,
  interruptAgentInputSchema,
} from "./schemas.js";

export interface ToolContext {
  config: AppConfig;
  getRoots: () => string[];
}

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "spawn_agent",
    {
      title: "Spawn Agent",
      description:
        "Start a Pi subagent. Returns immediately. Settings come from ~/.cursor/pi-delegate/agents/*.toml plus prompt/skills. Use wait_agent for the result.",
      inputSchema: spawnAgentInputSchema,
      annotations: annotations.spawn,
    },
    async (args) => {
      try {
        const started = spawnAgent({
          config: ctx.config,
          taskName: args.task_name,
          message: args.message,
          prompt: args.prompt,
          skills: args.skills,
          agentType: args.agent_type,
          model: args.model,
          provider: args.provider,
          effort: args.effort,
          workspace: args.workspace,
          mcpRoots: ctx.getRoots(),
        });
        return jsonToMcpContent(started);
      } catch (err) {
        return errorToMcpContent(err);
      }
    },
  );

  server.registerTool(
    "wait_agent",
    {
      title: "Wait Agent",
      description:
        "Wait briefly for one agent. If still running, returns status and wait seconds.",
      inputSchema: waitAgentInputSchema,
      annotations: annotations.wait,
    },
    async (args) => {
      try {
        return jsonToMcpContent(
          await waitAgent({
            config: ctx.config,
            mcpRoots: ctx.getRoots(),
            targets: args.targets,
          }),
        );
      } catch (err) {
        return errorToMcpContent(err);
      }
    },
  );

  server.registerTool(
    "wait_all_agents",
    {
      title: "Wait All Agents",
      description:
        "Wait briefly until targeted agents finish. If still running, returns status and wait seconds.",
      inputSchema: waitAllAgentsInputSchema,
      annotations: annotations.wait,
    },
    async (args) => {
      try {
        return jsonToMcpContent(
          await waitAllAgents({
            config: ctx.config,
            mcpRoots: ctx.getRoots(),
            targets: args.targets,
          }),
        );
      } catch (err) {
        return errorToMcpContent(err);
      }
    },
  );

  server.registerTool(
    "list_agents",
    {
      title: "List Agents",
      description: "List agents in the current workspace.",
      inputSchema: listAgentsInputSchema,
      annotations: annotations.list,
    },
    async (args) => {
      try {
        return jsonToMcpContent(
          listAgentsPublic({
            config: ctx.config,
            mcpRoots: ctx.getRoots(),
            pathPrefix: args.path_prefix,
          }),
        );
      } catch (err) {
        return errorToMcpContent(err);
      }
    },
  );

  server.registerTool(
    "read_agent_response",
    {
      title: "Read Agent Response",
      description: "Read one agent's latest final text.",
      inputSchema: readAgentResponseInputSchema,
      annotations: annotations.list,
    },
    async (args) => {
      try {
        return jsonToMcpContent(
          readAgentResponse({
            target: args.target,
            config: ctx.config,
            mcpRoots: ctx.getRoots(),
          }),
        );
      } catch (err) {
        return errorToMcpContent(err);
      }
    },
  );

  server.registerTool(
    "send_message",
    {
      title: "Send Message",
      description:
        "Steer a running agent (queued next turn) or start another turn when settled.",
      inputSchema: sendMessageInputSchema,
      annotations: annotations.send,
    },
    async (args) => {
      try {
        return jsonToMcpContent(
          sendMessage({
            config: ctx.config,
            target: args.target,
            message: args.message,
            mcpRoots: ctx.getRoots(),
          }),
        );
      } catch (err) {
        return errorToMcpContent(err);
      }
    },
  );

  server.registerTool(
    "interrupt_agent",
    {
      title: "Interrupt Agent",
      description: "Abort the current turn. The session remains for send_message.",
      inputSchema: interruptAgentInputSchema,
      annotations: annotations.interrupt,
    },
    async (args) => {
      try {
        return jsonToMcpContent(
          await interruptAgent({
            config: ctx.config,
            target: args.target,
            mcpRoots: ctx.getRoots(),
          }),
        );
      } catch (err) {
        return errorToMcpContent(err);
      }
    },
  );
}

export { DelegateError };
