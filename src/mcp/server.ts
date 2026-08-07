import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config/loader.js";
import { registerAllTools } from "./tools/register.js";

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
  const server = new McpServer({
    name: "pi-delegate-mcp",
    version: "0.1.0",
  });

  let roots: string[] = [];
  const getRoots = () => roots;

  registerAllTools(server, { config, getRoots });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  try {
    const client = server.server;
    const caps = client.getClientCapabilities?.();
    if (caps?.roots) {
      // listRoots available on Client; on server side use request if present
      const result = await (
        client as unknown as {
          listRoots?: () => Promise<{ roots: Array<{ uri: string }> }>;
        }
      ).listRoots?.();
      if (result?.roots) {
        roots = result.roots.map((r) => uriToPath(r.uri)).filter(Boolean);
      }
    }
  } catch {
    // Roots are optional; tools can require explicit workspace
  }

  console.error("pi-delegate-mcp: listening on stdio");
}
