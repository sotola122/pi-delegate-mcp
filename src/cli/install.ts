import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { cursorMcpJsonPath } from "../config/paths.js";
import { ensureAgentHome, agentHomePath } from "../agents/home.js";
import { stripJsonc, loadConfig } from "../config/loader.js";
import { assetsRoot, assetExists } from "../prompt/assets.js";
import { warnDeprecatedConfig } from "../config/schema.js";
import { getPiSdkVersion } from "../pi-sdk/version.js";
import { reconcileOrphanedRuns } from "../core/run-registry.js";

const SERVER_KEY = "pi-delegate";

function resolveNodeExecutable(): string {
  return "node";
}

function findOwnCliScript(): string {
  const argv1 = process.argv[1];
  if (argv1 && existsSync(argv1) && argv1.endsWith(".js")) return argv1;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const distCli = `${here}/cli.js`;
    if (existsSync(distCli)) return distCli;
    const nested = `${here}/../cli.js`;
    if (existsSync(nested)) return nested;
  } catch {
    // fall through
  }
  throw new Error("Could not locate pi-delegate-mcp CLI script");
}

export function installCursor(scope: "global" = "global"): void {
  if (scope !== "global") {
    throw new Error("Only --scope global is supported");
  }
  const path = cursorMcpJsonPath();
  mkdirSync(dirname(path), { recursive: true });

  let doc: { mcpServers?: Record<string, unknown> } = { mcpServers: {} };
  if (existsSync(path)) {
    copyFileSync(path, `${path}.bak.${Date.now()}`);
    const raw = readFileSync(path, "utf8");
    doc = JSON.parse(stripJsonc(raw)) as typeof doc;
  }
  if (!doc.mcpServers) doc.mcpServers = {};

  const cliScript = findOwnCliScript();
  try {
    chmodSync(cliScript, 0o755);
  } catch {
    // best-effort
  }

  doc.mcpServers[SERVER_KEY] = {
    command: resolveNodeExecutable(),
    args: [cliScript, "serve"],
  };

  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
  const home = agentHomePath(loadConfig());
  ensureAgentHome(home);
  console.log(`Installed ${SERVER_KEY} into ${path}`);
  console.log(`  command: ${resolveNodeExecutable()}`);
  console.log(`  script:  ${cliScript}`);
  console.log(`  agents:  ${home}`);
}

export function uninstallCursor(scope: "global" = "global"): void {
  if (scope !== "global") {
    throw new Error("Only --scope global is supported");
  }
  const path = cursorMcpJsonPath();
  if (!existsSync(path)) {
    console.log("No mcp.json found; nothing to uninstall");
    return;
  }
  copyFileSync(path, `${path}.bak.${Date.now()}`);
  const raw = readFileSync(path, "utf8");
  const doc = JSON.parse(stripJsonc(raw)) as {
    mcpServers?: Record<string, unknown>;
  };
  if (doc.mcpServers?.[SERVER_KEY]) {
    delete doc.mcpServers[SERVER_KEY];
    writeFileSync(path, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
    console.log(`Removed ${SERVER_KEY} from ${path}`);
  } else {
    console.log(`${SERVER_KEY} was not registered`);
  }
}

export function printConfigCursor(): void {
  const path = cursorMcpJsonPath();
  if (!existsSync(path)) {
    console.log("(no mcp.json)");
    return;
  }
  console.log(readFileSync(path, "utf8"));
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

export function doctorCommand(): void {
  const issues: string[] = [];
  console.log("pi-delegate-mcp doctor");
  console.log("---");

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const nodeOk = nodeMajor >= 22;
  console.log(`node: ${process.version}${nodeOk ? "" : " (requires >=22.19.0)"}`);
  if (!nodeOk) issues.push("Node.js >=22.19.0 required");

  console.log(`pi sdk: @earendil-works/pi-coding-agent@${getPiSdkVersion()}`);

  try {
    const config = loadConfig();
    console.log(`config: ok (version=${config.version})`);
    for (const w of warnDeprecatedConfig(config)) {
      console.log(`warning: ${w}`);
    }
    const agentDir = expandHome(config.pi.agentDir ?? "~/.pi/agent");
    const authPath = config.pi.authPath
      ? expandHome(config.pi.authPath)
      : join(agentDir, "auth.json");
    const modelsPath = config.pi.modelsPath
      ? expandHome(config.pi.modelsPath)
      : join(agentDir, "models.json");
    console.log(`agentDir: ${agentDir}`);
    console.log(`authPath: ${existsSync(authPath) ? authPath : `${authPath} (missing)`}`);
    console.log(
      `modelsPath: ${existsSync(modelsPath) ? modelsPath : `${modelsPath} (missing)`}`,
    );
    console.log(
      `default model: ${config.pi.provider}/${config.pi.defaultModel}`,
    );
    console.log(`allowed models: ${config.pi.allowedModels.join(", ")}`);
    console.log(
      `agent home: ${agentHomePath(config)}`,
    );
  } catch (err) {
    issues.push(err instanceof Error ? err.message : String(err));
  }

  try {
    const root = assetsRoot();
    console.log(`assets: ${root}`);
    if (!assetExists("profiles.yaml") || !assetExists("provider.yaml")) {
      issues.push("Required asset files missing");
    }
  } catch (err) {
    issues.push(err instanceof Error ? err.message : String(err));
  }

  const mcp = cursorMcpJsonPath();
  console.log(`cursor mcp.json: ${existsSync(mcp) ? mcp : "not found"}`);

  if (issues.length) {
    console.log("---");
    console.log("issues:");
    for (const i of issues) console.log(`- ${i}`);
    process.exitCode = 1;
  } else {
    console.log("---");
    console.log(
      "OK (OAuth via ModelRuntime; run: pi-delegate-mcp smoke)",
    );
  }
}

export { reconcileOrphanedRuns };
