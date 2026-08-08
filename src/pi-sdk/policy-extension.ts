import {
  createBashTool,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { DelegationPolicy } from "./types.js";
import { isPathInside, resolveRealPath } from "../workspace/roots.js";
import {
  existsSync,
  lstatSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";

export type ToolDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string };

/** Tokenize a shell-ish command lightly (quotes kept out of tokens). */
function shellTokens(cmd: string): string[] {
  return (
    cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((t) => {
      if (
        (t.startsWith('"') && t.endsWith('"')) ||
        (t.startsWith("'") && t.endsWith("'"))
      ) {
        return t.slice(1, -1);
      }
      return t;
    }) ?? []
  );
}

/** Normalize `/usr/bin/git` / `./git` → `git` for denylist matching. */
export function commandBasename(token: string): string {
  const normalized = token.replace(/\\/g, "/");
  return basename(normalized).toLowerCase();
}

/**
 * True when `git` appears with the given subcommand as the first non-option arg
 * (supports intervening global options like `-C path`, `--git-dir=…`).
 * Path-qualified executables (`/usr/bin/git`) are matched via basename.
 */
export function gitHasSubcommand(cmd: string, subcommand: string): boolean {
  const tokens = shellTokens(cmd);
  for (let i = 0; i < tokens.length; i++) {
    if (commandBasename(tokens[i]!) !== "git") continue;
    let j = i + 1;
    while (j < tokens.length) {
      const t = tokens[j]!;
      if (t.startsWith("-")) {
        const base = t.split("=")[0]!;
        // Options that take a separate value
        if (
          base === "-C" ||
          base === "--git-dir" ||
          base === "--work-tree" ||
          base === "-c"
        ) {
          if (!t.includes("=")) j++;
        }
        j++;
        continue;
      }
      return t.toLowerCase() === subcommand.toLowerCase();
    }
  }
  return false;
}

function isDangerousBash(cmd: string): boolean {
  if (gitHasSubcommand(cmd, "commit")) return true;
  if (gitHasSubcommand(cmd, "push")) return true;
  if (gitHasSubcommand(cmd, "merge")) return true;
  if (gitHasSubcommand(cmd, "restore")) return true;
  // reset --hard / clean -f / checkout -- .
  if (gitHasSubcommand(cmd, "reset") && /--hard\b/i.test(cmd)) return true;
  if (gitHasSubcommand(cmd, "clean") && /-[a-z]*f/i.test(cmd)) return true;
  if (gitHasSubcommand(cmd, "checkout") && /--\s+\./.test(cmd)) return true;

  const OTHER = [
    /\bnpm\s+publish\b/i,
    /\bbun\s+publish\b/i,
    /\bterraform\s+apply\b/i,
    /\bkubectl\s+delete\b/i,
    /\bsudo\b/i,
    /\brm\s+-rf\s+\/\b/i,
    /curl\s+[^\n|]*\|\s*(?:ba)?sh\b/i,
    /wget\s+[^\n|]*\|\s*(?:ba)?sh\b/i,
    /\bdeploy\b/i,
  ];
  return OTHER.some((re) => re.test(cmd));
}

const WRITE_TOOLS = new Set(["edit", "write"]);
const BASH_TOOLS = new Set(["bash"]);
const MUTATING = new Set(["edit", "write", "bash"]);

function asRecord(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object") return input as Record<string, unknown>;
  return {};
}

function commandFromInput(input: Record<string, unknown>): string {
  const c = input.command ?? input.cmd ?? input.script;
  return typeof c === "string" ? c : "";
}

function pathFromInput(input: Record<string, unknown>): string | undefined {
  const p = input.path ?? input.file_path ?? input.filePath ?? input.target;
  return typeof p === "string" ? p : undefined;
}

/** Missing path: walk up to an existing ancestor and rejoin remaining segments. */
function canonicalizeMissing(abs: string): string {
  let dir = dirname(abs);
  const parts: string[] = [];
  parts.unshift(abs.slice(dir.length).replace(/^[/\\]/, "") || "");
  while (dir && !existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) break;
    parts.unshift(dir.slice(parent.length).replace(/^[/\\]/, ""));
    dir = parent;
  }
  let base = dir;
  try {
    if (existsSync(base)) base = realpathSync(base);
  } catch {
    // keep lexical base
  }
  const joined = parts.filter(Boolean).join(sep);
  return joined ? resolve(base, joined) : base;
}

/**
 * Resolve a tool path for policy checks.
 * Symlinks (including dangling) are followed via lstat/readlink so write
 * targets cannot escape by pointing outside allowed roots.
 */
export function resolveToolPath(path: string, cwd?: string): string {
  const abs = isAbsolute(path)
    ? resolve(path)
    : cwd
      ? resolve(cwd, path)
      : resolve(path);
  return resolvePathInternal(abs, 0);
}

function resolvePathInternal(abs: string, depth: number): string {
  if (depth > 32) return abs;
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return canonicalizeMissing(abs);
  }
  if (st.isSymbolicLink()) {
    let target: string;
    try {
      target = readlinkSync(abs);
    } catch {
      return canonicalizeMissing(abs);
    }
    const resolved = isAbsolute(target)
      ? resolve(target)
      : resolve(dirname(abs), target);
    return resolvePathInternal(resolved, depth + 1);
  }
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function canonicalizeRoot(root: string): string {
  return resolveRealPath(root);
}

export function evaluateToolCall(
  policy: DelegationPolicy,
  call: { name: string; input: unknown },
): ToolDecision {
  const name = call.name;
  const input = asRecord(call.input);

  if (policy.profile === "no-tools") {
    return { kind: "deny", reason: "no-tools profile forbids all tools" };
  }

  if (policy.profile === "review" && MUTATING.has(name)) {
    return {
      kind: "deny",
      reason: `review profile forbids tool: ${name}`,
    };
  }

  if (policy.profile === "verify" && WRITE_TOOLS.has(name)) {
    return {
      kind: "deny",
      reason: `verify profile forbids tool: ${name}`,
    };
  }

  if (BASH_TOOLS.has(name)) {
    const cmd = commandFromInput(input);
    if (isDangerousBash(cmd)) {
      return {
        kind: "deny",
        reason: `blocked dangerous bash command`,
      };
    }
  }

  if (WRITE_TOOLS.has(name) || name === "read") {
    const raw = pathFromInput(input);
    if (raw) {
      const abs = resolveToolPath(raw, policy.workspace);
      const roots = [
        ...(policy.workspace ? [canonicalizeRoot(policy.workspace)] : []),
        ...(policy.allowedRoots ?? []).map(canonicalizeRoot),
        ...(policy.artifactRoots ?? []).map(canonicalizeRoot),
        ...(policy.skillRoots ?? []).map(canonicalizeRoot),
      ];
      if (roots.length > 0 && !roots.some((r) => isPathInside(r, abs))) {
        return {
          kind: "deny",
          reason: `path escapes workspace/allowed roots: ${abs}`,
        };
      }
      if (policy.outOfScope?.length) {
        for (const o of policy.outOfScope) {
          const oAbs = resolveToolPath(o, policy.workspace);
          if (
            abs === oAbs ||
            isPathInside(oAbs, abs) ||
            abs.startsWith(oAbs + sep)
          ) {
            return {
              kind: "deny",
              reason: `path is out of scope: ${abs}`,
            };
          }
        }
      }
      if (
        /(?:^|\/)(?:\.env|credentials\.json|id_rsa|id_ed25519|\.pem|\.p12)(?:$|\/)/i.test(
          abs,
        )
      ) {
        return {
          kind: "deny",
          reason: `protected / secret path blocked: ${abs}`,
        };
      }
      // Also reject if an existing symlink target looks like a secret path
      try {
        if (existsSync(abs) && statSync(abs).isFile()) {
          // already realpath'd
        }
      } catch {
        // ignore
      }
    }
  }

  return { kind: "allow" };
}

export function createDelegationPolicyExtension(
  policy: DelegationPolicy,
): InlineExtension {
  return (pi) => {
    pi.on("tool_call", async (event) => {
      const decision = evaluateToolCall(policy, {
        name: event.toolName,
        input: event.input,
      });
      if (decision.kind === "deny") {
        return { block: true, reason: decision.reason };
      }
      return undefined;
    });
  };
}

/** Override built-in bash with sanitized environment (no session env leak). */
export function createSanitizedBashExtension(
  cwd: string,
  env: NodeJS.ProcessEnv,
): InlineExtension {
  return (pi) => {
    const bashTool = createBashTool(cwd, {
      exposeSessionEnvironment: false,
      spawnHook: ({ command, cwd: spawnCwd }) => ({
        command,
        cwd: spawnCwd,
        env,
      }),
    });
    pi.registerTool({
      ...bashTool,
      execute: async (id, params, signal, onUpdate, _ctx) => {
        return bashTool.execute(id, params, signal, onUpdate);
      },
    });
  };
}
