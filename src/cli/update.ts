import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { findPackageRoot } from "../prompt/assets.js";

export const PACKAGE_NAME = "@sotola122/pi-delegate-mcp";

export type NpmRunner = (
  args: string[],
  opts?: { stdio?: "inherit" | "pipe" },
) => SpawnSyncReturns<string | Buffer>;

const defaultNpm: NpmRunner = (args, opts) =>
  spawnSync("npm", args, {
    encoding: "utf8",
    shell: false,
    stdio: opts?.stdio ?? "pipe",
  });

/** Installed package version for the running CLI binary. */
export function readInstalledVersion(root = findPackageRoot()): string {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version?: string;
  };
  if (!pkg.version?.trim()) {
    throw new Error(`Missing version in ${join(root, "package.json")}`);
  }
  return pkg.version.trim();
}

export function parseUpdateArgs(argv: string[]): {
  check: boolean;
  versionSpec: string;
} {
  let check = false;
  let versionSpec = "latest";
  for (const a of argv) {
    if (a === "--check") {
      check = true;
      continue;
    }
    if (a.startsWith("-")) {
      throw new Error(`Unknown update flag: ${a}\nUsage: update [--check] [version]`);
    }
    versionSpec = a.startsWith("@") ? a.slice(1) : a;
  }
  return { check, versionSpec };
}

function npmHint(): string {
  return [
    "Hint: ensure ~/.npmrc has:",
    "  @sotola122:registry=https://npm.pkg.github.com",
    "  //npm.pkg.github.com/:_authToken=<GITHUB_TOKEN with read:packages>",
  ].join("\n");
}

export function fetchLatestVersion(npm: NpmRunner = defaultNpm): string {
  const r = npm(["view", PACKAGE_NAME, "version"], { stdio: "pipe" });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const err = String(r.stderr || r.stdout || `npm view exited ${r.status}`);
    throw new Error(`${err.trim()}\n${npmHint()}`);
  }
  const v = String(r.stdout).trim();
  if (!v) throw new Error(`npm view returned empty version\n${npmHint()}`);
  return v;
}

/**
 * Package-only update: npm install -g. Does not touch Cursor mcp.json.
 */
export function updateCommand(
  argv: string[],
  deps: {
    npm?: NpmRunner;
    installedVersion?: () => string;
    setExitCode?: (code: number) => void;
  } = {},
): void {
  const npm = deps.npm ?? defaultNpm;
  const installedVersion = deps.installedVersion ?? readInstalledVersion;
  const setExitCode =
    deps.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });
  const { check, versionSpec } = parseUpdateArgs(argv);
  const current = installedVersion();

  if (check) {
    const latest = fetchLatestVersion(npm);
    console.log(`installed: ${current}`);
    console.log(`latest:    ${latest}`);
    if (current === latest) {
      console.log("up to date");
      return;
    }
    console.log("update available");
    setExitCode(1);
    return;
  }

  const target = `${PACKAGE_NAME}@${versionSpec}`;
  console.log(
    `Updating global package ${target} (does not modify Cursor mcp.json)`,
  );
  console.log(`current CLI version: ${current}`);

  const r = npm(["install", "-g", target], { stdio: "inherit" });
  if (r.error) {
    console.error(r.error.message);
    console.error(npmHint());
    setExitCode(1);
    return;
  }
  if (r.status !== 0) {
    console.error(`npm install failed (exit ${r.status ?? "unknown"})`);
    console.error(npmHint());
    setExitCode(1);
    return;
  }

  let after = current;
  try {
    after = installedVersion();
  } catch {
    // Global install may not replace this process's package root (e.g. local checkout).
  }
  console.log(`done. reported package version at this binary: ${after}`);
  console.log(
    "Note: npm -g updates the global install; restart Cursor to reload the MCP server.",
  );
}
