import { describe, it, expect } from "vitest";
import { buildPiArgv } from "../../src/pi/argv.js";
import { getProfile } from "../../src/core/profiles.js";
import { validateAttachmentPaths } from "../../src/workspace/roots.js";
import { defaultConfig } from "../../src/config/schema.js";
import { validateManualPrompt } from "../../src/prompt/validator.js";
import { assertManualAllowed } from "../../src/prompt/manual.js";

describe("security", () => {
  it("blocks newline argument injection", () => {
    expect(() =>
      buildPiArgv({
        provider: "p",
        model: "m",
        thinking: "t\n--tools=bash",
        profile: getProfile("review"),
      }),
    ).toThrow();
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
