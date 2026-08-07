import { describe, it, expect } from "vitest";
import {
  detectModalitiesFromAttachments,
  mergeModalities,
} from "../../src/prompt/multimodal.js";
import { defaultConfig } from "../../src/config/schema.js";
import { DelegateError } from "../../src/core/errors.js";

describe("multimodal", () => {
  it("detects vision from image attachments", () => {
    const m = detectModalitiesFromAttachments(
      ["/tmp/a.png", "/tmp/note.txt"],
      defaultConfig(),
    );
    expect(m).toEqual(["vision"]);
  });

  it("rejects pdf when document disabled", () => {
    expect(() =>
      detectModalitiesFromAttachments(["/tmp/a.pdf"], defaultConfig()),
    ).toThrow(DelegateError);
  });

  it("merges modalities in canonical order", () => {
    expect(mergeModalities(["browser", "vision"], ["document"])).toEqual([
      "vision",
      "document",
      "browser",
    ]);
  });
});
