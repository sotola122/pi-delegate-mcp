import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
} from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cursorMcpJsonPath } from "../config/paths.js";
import { resolvePiExecutable } from "../pi/executable.js";
import { stripJsonc, loadConfig } from "../config/loader.js";
import { assetsRoot, assetExists } from "../prompt/assets.js";

const SERVER_KEY = "pi-delegate";

function resolveNodeExecutable(): string {
  // Use PATH-resolved "node" rather than pinning process.execPath, which may
  // point at an ephemeral Cursor Agent runtime that IDEs do not share.
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
    throw new Error("Only --scope global is supported in v0.1");
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
    // best-effort; node invocation does not require +x
  }

  doc.mcpServers[SERVER_KEY] = {
    command: resolveNodeExecutable(),
    args: [cliScript, "serve"],
  };

  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
  console.log(`Installed ${SERVER_KEY} into ${path}`);
  console.log(`  command: ${resolveNodeExecutable()}`);
  console.log(`  script:  ${cliScript}`);
}

export function uninstallCursor(scope: "global" = "global"): void {
  if (scope !== "global") {
    throw new Error("Only --scope global is supported in v0.1");
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

export function doctorCommand(): void {
  const issues: string[] = [];
  console.log("pi-delegate-mcp doctor");
  console.log("---");

  try {
    const config = loadConfig();
    console.log(`config: ok (pi.executable=${config.pi.executable})`);
    try {
      const exe = resolvePiExecutable(config.pi.executable);
      console.log(`pi executable: ${exe}`);
    } catch (err) {
      issues.push(err instanceof Error ? err.message : String(err));
      console.log("pi executable: MISSING");
    }
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
      "OK (OAuth is managed by Pi; run smoke_test to verify connectivity)",
    );
  }
}
