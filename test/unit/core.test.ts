import { describe, it, expect } from "vitest";
import { resolveProvider, loadProviderFile } from "../../src/core/provider.js";
import { defaultConfig } from "../../src/config/schema.js";
import { buildPiArgv } from "../../src/pi/argv.js";
import { getProfile } from "../../src/core/profiles.js";
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
  parseAcceptanceEvidence,
  outputHasHeading,
} from "../../src/core/result.js";
import { parseJsonlEvents, jsonModeSucceeded } from "../../src/pi/json-events.js";

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

describe("pi argv", () => {
  it("never uses shell and includes safety flags", () => {
    const argv = buildPiArgv({
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinking: "medium",
      profile: getProfile("review"),
    });
    expect(argv).toContain("--print");
    expect(argv).toContain("--no-session");
    expect(argv).toContain("--no-extensions");
    expect(argv).toContain("--no-skills");
    expect(argv).toContain("--no-approve");
    expect(argv).toContain("--tools");
    expect(argv.join(" ")).not.toMatch(/bash/);
  });

  it("rejects newline injection in args", () => {
    expect(() =>
      buildPiArgv({
        provider: "openai-codex\n--evil",
        model: "gpt-5.6-sol",
        thinking: "medium",
        profile: getProfile("review"),
      }),
    ).toThrow(/Unsafe/);
  });

  it("uses --no-tools for judge profile", () => {
    const argv = buildPiArgv({
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinking: "medium",
      profile: getProfile("no-tools"),
    });
    expect(argv).toContain("--no-tools");
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
});

describe("json events", () => {
  it("parses jsonl and success signals", () => {
    const stdout = [
      '{"type":"agent_end","willRetry":false}',
      '{"type":"agent_settled"}',
      '{"type":"message_end","content":"hello"}',
    ].join("\n");
    const events = parseJsonlEvents(stdout);
    expect(jsonModeSucceeded(events, 0)).toBe(true);
  });

  it("rejects missing agent_end even if settled present", () => {
    const events = parseJsonlEvents('{"type":"agent_settled"}');
    expect(jsonModeSucceeded(events, 0)).toBe(false);
  });
});
