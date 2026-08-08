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

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Conventional agent skill directories, used when allowedRoots is unset.
 * Scoped to skill trees so credential files (auth.json, ssh keys) stay out.
 * Intentionally excludes `~/.cursor/plugins` (unpinned third-party trees).
 */
export function defaultChildSkillRoots(): string[] {
  const home = homedir();
  return [
    join(home, ".agents", "skills"),
    join(home, ".cursor", "skills"),
    join(home, ".cursor", "skills-cursor"),
    join(home, ".claude", "skills"),
    join(home, ".codex", "skills"),
  ];
}
