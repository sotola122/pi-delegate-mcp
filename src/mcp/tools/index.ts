import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./register.js";
import { registerAllTools } from "./register.js";

/** Design-layout entry; all tools register via registerAllTools. */
export function registerTools(server: McpServer, ctx: ToolContext): void {
  registerAllTools(server, ctx);
}

export { registerAllTools } from "./register.js";
export type { ToolContext } from "./register.js";
