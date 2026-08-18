import { describe, it, expect } from "vitest";
import {
  compactJson,
  compactTextField,
  truncateHead,
  COMPACT_MAX_LINES,
} from "../../src/mcp/compact.js";

describe("compactJson", () => {
  it("minifies and redacts", () => {
    expect(compactJson({ name: "a", status: "running" })).toBe(
      '{"name":"a","status":"running"}',
    );
    expect(compactJson({ msg: "token: abc123secretvalue" })).toContain("[REDACTED]");
  });
});

describe("truncateHead", () => {
  it("caps line count", () => {
    const text = Array.from({ length: COMPACT_MAX_LINES + 10 }, (_, i) => `L${i}`).join(
      "\n",
    );
    const { text: sliced, truncated } = truncateHead(text);
    expect(truncated).toBe(true);
    expect(sliced.split("\n")).toHaveLength(COMPACT_MAX_LINES);
  });
});

describe("compactTextField", () => {
  it("omits full when the text fits", () => {
    expect(compactTextField("short")).toEqual({ text: "short" });
  });
});
