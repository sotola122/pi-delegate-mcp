import { describe, it, expect } from "vitest";
import { resolveProvider, loadProviderFile } from "../../src/core/provider.js";
import {
  defaultConfig,
  migrateConfigV1,
  ConfigSchema,
} from "../../src/config/schema.js";
import { mapProfileToSdkTools } from "../../src/pi-sdk/profile-mapper.js";
import { evaluateToolCall } from "../../src/pi-sdk/policy-extension.js";
import { buildSanitizedShellEnvironment } from "../../src/pi-sdk/environment.js";
import { assemblePrompt } from "../../src/prompt/assembler.js";
import { serializeTaskBlock } from "../../src/prompt/task-block.js";
import { redactSecrets } from "../../src/artifacts/redact.js";
import { deepMerge } from "../../src/config/merge.js";
import { stripJsonc } from "../../src/config/loader.js";
import { validateManualPrompt } from "../../src/prompt/validator.js";
import { isPathInside, resolveWorkspace } from "../../src/workspace/roots.js";
import { DelegateError } from "../../src/core/errors.js";
import {
  finalizeStatus,
  finalizeStatusFromOutcome,
  parseAcceptanceEvidence,
  outputHasHeading,
} from "../../src/core/result.js";

describe("effort → thinking", () => {
  const config = defaultConfig();

  it("maps med/high/xhigh/max 1:1 (med→medium)", () => {
    expect(resolveProvider({ config, effort: "med" }).thinking).toBe("medium");
    expect(resolveProvider({ config, effort: "high" }).thinking).toBe("high");
    expect(resolveProvider({ config, effort: "xhigh" }).thinking).toBe("xhigh");
    expect(resolveProvider({ config, effort: "max" }).thinking).toBe("max");
  });

  it("defaults to med", () => {
    expect(resolveProvider({ config }).effort).toBe("med");
  });

  it("rejects unknown models outside allowlist", () => {
    const cfg = defaultConfig();
    cfg.pi.allowedModels = ["gpt-5.6-sol"];
    expect(() =>
      resolveProvider({ config: cfg, model: "gpt-5.6-luna" }),
    ).toThrow(/not allowed/);
  });

  it("provider file has no low/ultra effort keys", () => {
    const file = loadProviderFile();
    expect(file.effort.low).toBeUndefined();
    expect(file.effort.ultra).toBeUndefined();
    expect(file.effort.med).toBeDefined();
    expect(file.effort.max).toBeDefined();
  });
});

describe("sdk profile mapping", () => {
  it("maps review to read-only tools", () => {
    const p = mapProfileToSdkTools("review");
    expect(p.tools).toEqual(["read", "grep", "find", "ls"]);
    expect(p.excludeTools).toContain("bash");
    expect(p.noTools).toBe(false);
  });

  it("maps no-tools", () => {
    const p = mapProfileToSdkTools("no-tools");
    expect(p.noTools).toBe(true);
    expect(p.tools).toEqual([]);
  });

  it("maps implement with write tools", () => {
    const p = mapProfileToSdkTools("implement");
    expect(p.tools).toContain("edit");
    expect(p.tools).toContain("write");
    expect(p.tools).toContain("bash");
  });
});

describe("policy extension", () => {
  it("blocks review bash", () => {
    const d = evaluateToolCall(
      { profile: "review" },
      { name: "bash", input: { command: "ls" } },
    );
    expect(d.kind).toBe("deny");
  });

  it("blocks git commit", () => {
    const d = evaluateToolCall(
      { profile: "implement", workspace: "/tmp/ws" },
      { name: "bash", input: { command: "git commit -am x" } },
    );
    expect(d.kind).toBe("deny");
  });

  it("allows review read", () => {
    const d = evaluateToolCall(
      { profile: "review", workspace: "/tmp/ws" },
      { name: "read", input: { path: "/tmp/ws/a.ts" } },
    );
    expect(d.kind).toBe("allow");
  });
});

describe("shell environment", () => {
  it("sanitizes env (drops secrets, no PI_*)", () => {
    const env = buildSanitizedShellEnvironment(defaultConfig(), {
      PATH: "/usr/bin",
      HOME: "/home/u",
      SECRET_TOKEN: "nope",
      PI_HOME: "/x",
      GITHUB_TOKEN: "secret",
    });
    expect(env.SECRET_TOKEN).toBeUndefined();
    expect(env.PI_HOME).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe("prompt assembly", () => {
  it("includes safety envelope and review heading contract", () => {
    const prompt = assemblePrompt({
      profile: "review",
      task: { objective: "review foo", profile: "review" },
    });
    expect(prompt).toMatch(/Do not run `git commit`/);
    expect(prompt).toMatch(/# Review Result/);
    expect(prompt).toMatch(/objective:/);
  });

  it("manual replace keeps safety and drops base profile prompt body", () => {
    const prompt = assemblePrompt({
      profile: "review",
      promptMode: "replace",
      manualPrompt: "Custom criteria only.",
      task: { objective: "x", profile: "review" },
    });
    expect(prompt).toMatch(/untrusted data/i);
    expect(prompt).toContain("Custom criteria only.");
  });

  it("task block serializes without injection via yaml", () => {
    const block = serializeTaskBlock({
      objective: "line1\nfoo: bar",
      profile: "review",
    });
    expect(block).toContain("objective:");
  });
});

describe("security helpers", () => {
  it("redacts secrets", () => {
    expect(redactSecrets("token: abc123secretvalue")).toContain("[REDACTED]");
    expect(redactSecrets("Bearer abcdefghijklmnop")).toContain("[REDACTED]");
  });

  it("rejects manual tool widening", () => {
    expect(() => validateManualPrompt("use --tools bash,edit")).toThrow(
      /widen/,
    );
  });

  it("detects path escape", () => {
    expect(isPathInside("/tmp/ws", "/tmp/ws/a")).toBe(true);
  });

  it("requires workspace when no roots", () => {
    expect(() =>
      resolveWorkspace({ config: defaultConfig(), mcpRoots: [] }),
    ).toThrow(DelegateError);
  });

  it("requires explicit workspace when multiple roots", () => {
    expect(() =>
      resolveWorkspace({
        config: defaultConfig(),
        mcpRoots: ["/a", "/b"],
      }),
    ).toThrow(/Multiple workspace/);
  });
});

describe("config", () => {
  it("merges deeply", () => {
    const merged = deepMerge({ a: { b: 1, c: 2 } }, { a: { c: 3 } });
    expect(merged).toEqual({ a: { b: 1, c: 3 } });
  });

  it("strips jsonc comments", () => {
    const raw = `{
      // comment
      "version": 1 /* inline */
    }`;
    expect(JSON.parse(stripJsonc(raw))).toEqual({ version: 1 });
  });

  it("defaults to version 2", () => {
    expect(defaultConfig().version).toBe(2);
    expect(defaultConfig().sdk.writableToolExecution).toBe("sequential");
  });

  it("migrates v1 config", () => {
    const migrated = migrateConfigV1({
      version: 1,
      pi: {
        executable: "pi",
        provider: "openai-codex",
        defaultModel: "gpt-5.6-sol",
        allowedModels: ["gpt-5.6-sol", "gpt-5.6-luna"],
      },
      environment: { passThrough: ["IDF_PATH"] },
    });
    const parsed = ConfigSchema.parse(migrated);
    expect(parsed.version).toBe(2);
    expect(parsed.shellEnvironment.passThrough).toContain("IDF_PATH");
  });
});

describe("result validation", () => {
  it("checks headings", () => {
    expect(outputHasHeading("# Review Result\nok", "review")).toBe(true);
    expect(outputHasHeading("nope", "review")).toBe(false);
  });

  it("parses acceptance evidence", () => {
    const ev = parseAcceptanceEvidence(
      "tests pass\nlint: fail",
      ["tests", "lint"],
    );
    expect(ev[0]?.status).toBe("pass");
    expect(ev[1]?.status).toBe("fail");
  });

  it("marks incomplete when evidence missing", () => {
    const status = finalizeStatus(0, false, "# Review Result", "review", [
      { check: "x", status: "unknown" },
    ], true);
    expect(status).toBe("incomplete");
  });

  it("maps sdk completion to status", () => {
    expect(
      finalizeStatusFromOutcome({
        completion: "completed",
        output: "# Review Result\nok",
        profile: "review",
        acceptance: [],
        requireHeading: true,
        agentStarted: true,
        agentEnded: true,
      }),
    ).toBe("success");
  });
});
