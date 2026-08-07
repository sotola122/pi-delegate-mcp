import { homedir, platform } from "node:os";
import { join } from "node:path";

export function configDir(): string {
  const p = platform();
  if (p === "darwin") {
    return join(homedir(), "Library", "Application Support", "pi-delegate-mcp");
  }
  if (p === "win32") {
    const base = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(base, "pi-delegate-mcp");
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(xdg, "pi-delegate-mcp");
}

export function configPath(): string {
  return join(configDir(), "config.jsonc");
}

export function stateDir(): string {
  const p = platform();
  if (p === "darwin") {
    return join(homedir(), "Library", "Application Support", "pi-delegate-mcp");
  }
  if (p === "win32") {
    const base = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(base, "pi-delegate-mcp");
  }
  const xdg = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(xdg, "pi-delegate-mcp");
}

export function runsDir(): string {
  return join(stateDir(), "runs");
}

export function cursorMcpJsonPath(): string {
  return join(homedir(), ".cursor", "mcp.json");
}
