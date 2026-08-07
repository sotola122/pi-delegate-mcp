import { describe, it, expect } from "vitest";
import { mapProfileToSdkTools } from "../../src/pi-sdk/profile-mapper.js";
import { evaluateToolCall } from "../../src/pi-sdk/policy-extension.js";
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
        { profile: "implement" },
        { name: "bash", input: { command: "npm publish" } },
      ).kind,
    ).toBe("deny");
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
    expect(() => validateChildSkills(["/x"], defaultConfig())).toThrow(
      /disabled/,
    );
  });
});
