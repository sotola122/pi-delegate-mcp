import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { assetsRoot } from "../prompt/assets.js";
import { configPath } from "../config/paths.js";
import { loadConfig } from "../config/loader.js";
import { serveCommand } from "./serve.js";
import {
  installCursor,
  uninstallCursor,
  printConfigCursor,
  doctorCommand,
} from "./install.js";
import { runCommand, parseRunArgs } from "./run.js";
import { cleanupCommand } from "./cleanup.js";
import { updateCommand, readInstalledVersion } from "./update.js";
import { authStatus, authLogin, authLogout } from "../pi-sdk/auth.js";

function packageVersion(): string {
  try {
    return readInstalledVersion();
  } catch {
    return "unknown";
  }
}

function usage(): string {
  return `pi-delegate-mcp ${packageVersion()}

Usage:
  pi-delegate-mcp serve
  pi-delegate-mcp doctor
  pi-delegate-mcp auth status
  pi-delegate-mcp auth login openai-codex
  pi-delegate-mcp auth logout openai-codex
  pi-delegate-mcp install cursor --scope global
  pi-delegate-mcp uninstall cursor --scope global
  pi-delegate-mcp update [--check] [version]
  pi-delegate-mcp print-config cursor
  pi-delegate-mcp config path
  pi-delegate-mcp assets status
  pi-delegate-mcp cleanup
  pi-delegate-mcp run --profile <name> --objective <text> [options]
  pi-delegate-mcp --version
  pi-delegate-mcp --help

Run options:
  --workspace <path>
  --manual-file <path> | --manual <path>
  --prompt-mode append|replace
  --effort med|high|xhigh|max
  --model gpt-5.6-sol|gpt-5.6-luna
  --delivery patch|apply
  --in-scope <path> (repeatable)
  --acceptance-check <text> (repeatable)
  --timeout-seconds <n>
`;
}

function assetsStatus(): void {
  const root = assetsRoot();
  const lockPath = join(root, "upstream-lock.json");
  console.log(`assets root: ${root}`);
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
      ref: string;
      files: Record<string, string>;
    };
    console.log(`upstream ref: ${lock.ref}`);
    console.log(`files: ${Object.keys(lock.files).length}`);
  } else {
    console.log("upstream-lock.json: missing");
    process.exitCode = 1;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const cmd = argv[0];

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(usage());
    return;
  }
  if (cmd === "--version" || cmd === "-V" || cmd === "version") {
    console.log(packageVersion());
    return;
  }

  switch (cmd) {
    case "serve":
      await serveCommand();
      return;
    case "doctor":
      doctorCommand();
      return;
    case "update":
      updateCommand(argv.slice(1));
      return;
    case "auth": {
      const config = loadConfig();
      const sub = argv[1];
      if (sub === "status") {
        await authStatus(config);
        return;
      }
      if (sub === "login") {
        const provider = argv[2] ?? "openai-codex";
        await authLogin(config, provider);
        return;
      }
      if (sub === "logout") {
        const provider = argv[2] ?? "openai-codex";
        await authLogout(config, provider);
        return;
      }
      throw new Error("Usage: auth status | auth login <provider> | auth logout <provider>");
    }
    case "install": {
      if (argv[1] !== "cursor") throw new Error("Usage: install cursor --scope global");
      const scopeIdx = argv.indexOf("--scope");
      const scope = (scopeIdx >= 0 ? argv[scopeIdx + 1] : "global") as "global";
      installCursor(scope);
      return;
    }
    case "uninstall": {
      if (argv[1] !== "cursor") throw new Error("Usage: uninstall cursor --scope global");
      const scopeIdx = argv.indexOf("--scope");
      const scope = (scopeIdx >= 0 ? argv[scopeIdx + 1] : "global") as "global";
      uninstallCursor(scope);
      return;
    }
    case "print-config":
      if (argv[1] !== "cursor") throw new Error("Usage: print-config cursor");
      printConfigCursor();
      return;
    case "config":
      if (argv[1] === "path") {
        console.log(configPath());
        return;
      }
      throw new Error("Usage: config path");
    case "assets":
      if (argv[1] === "status") {
        assetsStatus();
        return;
      }
      throw new Error("Usage: assets status");
    case "cleanup":
      cleanupCommand();
      return;
    case "run":
      await runCommand(parseRunArgs(argv.slice(1)));
      return;
    default:
      console.error(`Unknown command: ${cmd}`);
      console.log(usage());
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
