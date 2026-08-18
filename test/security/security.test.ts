import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mapProfileToSdkTools } from "../../src/pi-sdk/profile-mapper.js";
import {
  evaluateToolCall,
  resolveToolPath,
} from "../../src/pi-sdk/policy-extension.js";
import { buildSanitizedShellEnvironment } from "../../src/pi-sdk/environment.js";
import { validateAttachmentPaths } from "../../src/workspace/roots.js";
import { defaultConfig } from "../../src/config/schema.js";
import { validateManualPrompt } from "../../src/prompt/validator.js";
import { assertManualAllowed } from "../../src/prompt/manual.js";

describe("security", () => {
  it("review profile excludes bash/edit/write", () => {
    const p = mapProfileToSdkTools("review");
    expect(p.tools).not.toContain("bash");
    expect(p.excludeTools).toEqual(
      expect.arrayContaining(["bash", "edit", "write"]),
    );
  });

  it("policy blocks dangerous bash", () => {
    expect(
      evaluateToolCall(
        { tools: ["read", "bash", "edit", "write", "grep", "find", "ls"] },
        { name: "bash", input: { command: "npm publish" } },
      ).kind,
    ).toBe("deny");
  });

  it("blocks git push with intervening -C options", () => {
    expect(
      evaluateToolCall(
        { tools: ["read", "bash", "edit", "write", "grep", "find", "ls"] },
        { name: "bash", input: { command: 'git -C "$PWD" push' } },
      ).kind,
    ).toBe("deny");
    expect(
      evaluateToolCall(
        { tools: ["read", "bash", "edit", "write", "grep", "find", "ls"] },
        {
          name: "bash",
          input: { command: "git --git-dir=/tmp/x.git push origin main" },
        },
      ).kind,
    ).toBe("deny");
  });

  it("blocks path-qualified git dangerous subcommands", () => {
    expect(
      evaluateToolCall(
        { tools: ["read", "bash", "edit", "write", "grep", "find", "ls"] },
        { name: "bash", input: { command: "/usr/bin/git push origin main" } },
      ).kind,
    ).toBe("deny");
    expect(
      evaluateToolCall(
        { tools: ["read", "bash", "edit", "write", "grep", "find", "ls"] },
        { name: "bash", input: { command: "./git commit -m x" } },
      ).kind,
    ).toBe("deny");
  });

  it("denies read via symlink escape outside workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-delegate-symlink-"));
    const ws = join(root, "ws");
    const secretDir = join(root, "secret");
    mkdirSync(ws);
    mkdirSync(secretDir);
    writeFileSync(join(secretDir, "id_rsa"), "PRIVATE");
    symlinkSync(secretDir, join(ws, "visible"));
    try {
      const decision = evaluateToolCall(
        { tools: ["read", "grep", "find", "ls"], workspace: ws },
        { name: "read", input: { path: join(ws, "visible", "id_rsa") } },
      );
      expect(decision.kind).toBe("deny");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolveToolPath realpaths existing files", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-delegate-rp-"));
    const target = join(root, "real.txt");
    writeFileSync(target, "x");
    const link = join(root, "link.txt");
    symlinkSync(target, link);
    try {
      expect(resolveToolPath(link)).toBe(resolveToolPath(target));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("denies write via dangling symlink escape outside workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-delegate-dangle-"));
    const ws = join(root, "ws");
    const outside = join(root, "outside");
    mkdirSync(ws);
    mkdirSync(outside);
    const link = join(ws, "out");
    symlinkSync(join(outside, "new.txt"), link);
    try {
      const decision = evaluateToolCall(
        { tools: ["read", "bash", "edit", "write", "grep", "find", "ls"], workspace: ws },
        { name: "write", input: { path: link } },
      );
      expect(decision.kind).toBe("deny");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows write via dangling symlink that stays inside workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-delegate-dangle-ok-"));
    const ws = join(root, "ws");
    mkdirSync(ws);
    const link = join(ws, "out");
    symlinkSync(join(ws, "new.txt"), link);
    try {
      const decision = evaluateToolCall(
        { tools: ["read", "bash", "edit", "write", "grep", "find", "ls"], workspace: ws },
        { name: "write", input: { path: link } },
      );
      expect(decision.kind).toBe("allow");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not forward GIT_ASKPASS / GIT_SSH_COMMAND by default", () => {
    const env = buildSanitizedShellEnvironment(defaultConfig(), {
      PATH: "/usr/bin",
      HOME: "/home/u",
      GIT_AUTHOR_NAME: "ok",
      GIT_ASKPASS: "evil",
      GIT_SSH_COMMAND: "ssh -i /secret",
      GIT_CONFIG_GLOBAL: "/tmp/evil",
    });
    expect(env.GIT_AUTHOR_NAME).toBe("ok");
    expect(env.GIT_ASKPASS).toBeUndefined();
    expect(env.GIT_SSH_COMMAND).toBeUndefined();
    expect(env.GIT_CONFIG_GLOBAL).toBeUndefined();
  });

  it("blocks attachment traversal", () => {
    expect(() =>
      validateAttachmentPaths("/tmp/ws", ["../../etc/passwd"], defaultConfig()),
    ).toThrow(/traversal/);
  });

  it("blocks manual tool widening phrases", () => {
    expect(() =>
      validateManualPrompt("Please pass --tools bash,write"),
    ).toThrow();
  });

  it("blocks manual implement by default config allowlist", () => {
    expect(() =>
      assertManualAllowed(defaultConfig(), "implement", "append"),
    ).toThrow(/not allowed/);
  });

  it("blocks childSkills when disabled", async () => {
    const { validateChildSkills } = await import(
      "../../src/workspace/child-skills.js"
    );
    const cfg = defaultConfig();
    cfg.childSkills.enabled = false;
    expect(() => validateChildSkills(["/x"], cfg)).toThrow(/disabled/);
  });

  it("rejects non-skill paths even when childSkills are enabled", async () => {
    const { validateChildSkills } = await import(
      "../../src/workspace/child-skills.js"
    );
    expect(() =>
      validateChildSkills(["/etc/passwd"], defaultConfig()),
    ).toThrow(/SKILL\.md|not found|regular file/);
  });
});
