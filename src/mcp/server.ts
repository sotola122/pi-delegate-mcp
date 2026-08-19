import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config/loader.js";
import { registerAllTools } from "./tools/register.js";
import { reconcileOrphanedRuns } from "../core/run-registry.js";
import { readInstalledVersion } from "../cli/update.js";

function uriToPath(uri: string): string {
  if (uri.startsWith("file://")) {
    let path = decodeURIComponent(uri.slice("file://".length));
    // file:///C:/... on Windows
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    return path;
  }
  return uri;
}

export async function startMcpServer(): Promise<void> {
  const config = loadConfig();
  reconcileOrphanedRuns();
  const server = new McpServer({
    name: "pi-delegate-mcp",
    version: readInstalledVersion(),
  });

  let roots: string[] = [];
  async function getRoots(): Promise<string[]> {
    try {
      const result = await server.server.listRoots();
      if (result.roots.length) {
        roots = result.roots.map((r) => uriToPath(r.uri)).filter(Boolean);
      }
    } catch {
      // Cursor may omit the roots capability. resolveWorkspace then uses cwd.
    }
    return roots;
  }

  registerAllTools(server, { config, getRoots });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  await getRoots();

  console.error("pi-delegate-mcp: listening on stdio");
}
