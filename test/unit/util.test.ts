import { describe, it, expect } from "vitest";
import { awaitWithAbort } from "../../src/util/abort.js";
import { truncateUtf8 } from "../../src/util/utf8.js";
import { DelegateError } from "../../src/core/errors.js";

describe("awaitWithAbort", () => {
  it("resolves when promise settles before abort", async () => {
    const ac = new AbortController();
    await expect(
      awaitWithAbort(Promise.resolve(42), ac.signal),
    ).resolves.toBe(42);
  });

  it("rejects with cancelled when signal aborts first", async () => {
    const ac = new AbortController();
    const never = new Promise<number>(() => {});
    const pending = awaitWithAbort(never, ac.signal);
    ac.abort();
    await expect(pending).rejects.toMatchObject({
      code: "cancelled",
    });
    await expect(pending).rejects.toBeInstanceOf(DelegateError);
  });

  it("rejects immediately when already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      awaitWithAbort(Promise.resolve(1), ac.signal),
    ).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("truncateUtf8", () => {
  it("does not split a multibyte character", () => {
    // "あ" is 3 bytes in UTF-8
    const { text, truncated } = truncateUtf8("あい", 4);
    expect(truncated).toBe(true);
    expect(text).toBe("あ");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(4);
  });
});
