import {
  createBashTool,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { DelegationPolicy } from "./types.js";
import { isPathInside } from "../workspace/roots.js";
import { resolve, isAbsolute } from "node:path";

export type ToolDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string };

const DANGEROUS_BASH = [
  /\bgit\s+commit\b/i,
  /\bgit\s+push\b/i,
  /\bgit\s+merge\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bgit\s+checkout\s+--\s+\./i,
  /\bgit\s+restore\b/i,
  /\bnpm\s+publish\b/i,
  /\bbun\s+publish\b/i,
  /\bterraform\s+apply\b/i,
  /\bkubectl\s+delete\b/i,
  /\bsudo\b/i,
  /\brm\s+-rf\s+\/\b/i,
  /curl\s+[^\n|]*\|\s*(ba)?sh/i,
  /wget\s+[^\n|]*\|\s*(ba)?sh/i,
  /\bdeploy\b/i,
];

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

function resolveToolPath(path: string, cwd?: string): string {
  if (isAbsolute(path)) return resolve(path);
  if (cwd) return resolve(cwd, path);
  return resolve(path);
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
    for (const re of DANGEROUS_BASH) {
      if (re.test(cmd)) {
        return {
          kind: "deny",
          reason: `blocked dangerous bash command matching ${re}`,
        };
      }
    }
  }

  if (WRITE_TOOLS.has(name) || name === "read") {
    const raw = pathFromInput(input);
    if (raw) {
      const abs = resolveToolPath(raw, policy.workspace);
      const roots = [
        ...(policy.workspace ? [policy.workspace] : []),
        ...(policy.allowedRoots ?? []),
        ...(policy.artifactRoots ?? []),
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
            abs.startsWith(oAbs + "/")
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
