import { describe, it, expect } from "vitest";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  ModelRuntimeManager,
  type CreateRuntimeFn,
} from "../../src/pi-sdk/runtime-manager.js";
import { DelegateError } from "../../src/core/errors.js";

function fakeRuntime(): ModelRuntime {
  return {} as ModelRuntime;
}

describe("ModelRuntimeManager", () => {
  it("passes a signal into createRuntime", async () => {
    const seen: AbortSignal[] = [];
    const runtime = fakeRuntime();
    const createRuntime: CreateRuntimeFn = async (opts) => {
      if (opts.signal) seen.push(opts.signal);
      return runtime;
    };
    const mgr = new ModelRuntimeManager({
      allowModelNetwork: false,
      createRuntime,
    });
    await expect(mgr.get()).resolves.toBe(runtime);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });

  it("keeps in-flight create when a waiter aborts; second waiter reuses it", async () => {
    let createCalls = 0;
    let release!: (runtime: ModelRuntime) => void;
    const createRuntime: CreateRuntimeFn = ({ signal }) => {
      createCalls += 1;
      expect(signal).toBeInstanceOf(AbortSignal);
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const mgr = new ModelRuntimeManager({
      allowModelNetwork: false,
      createRuntime,
      initTimeoutMs: 5_000,
    });

    const ac1 = new AbortController();
    const first = mgr.get(ac1.signal);
    await Promise.resolve();
    expect(createCalls).toBe(1);

    ac1.abort();
    await expect(first).rejects.toMatchObject({ code: "cancelled" });
    await expect(first).rejects.toBeInstanceOf(DelegateError);
    expect(createCalls).toBe(1);

    const runtime = fakeRuntime();
    const second = mgr.get();
    release(runtime);
    await expect(second).resolves.toBe(runtime);
    expect(createCalls).toBe(1);
  });

  it("clears the slot when create rejects so the next get retries", async () => {
    let createCalls = 0;
    const runtime = fakeRuntime();
    const createRuntime: CreateRuntimeFn = async () => {
      createCalls += 1;
      if (createCalls === 1) throw new Error("boom");
      return runtime;
    };
    const mgr = new ModelRuntimeManager({
      allowModelNetwork: false,
      createRuntime,
    });
    await expect(mgr.get()).rejects.toThrow("boom");
    await expect(mgr.get()).resolves.toBe(runtime);
    expect(createCalls).toBe(2);
  });

  it("clears the slot on init timeout and retries", async () => {
    let createCalls = 0;
    const createRuntime: CreateRuntimeFn = async ({ signal }) => {
      createCalls += 1;
      if (signal?.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      await new Promise<never>((_, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          },
          { once: true },
        );
      });
    };
    const mgr = new ModelRuntimeManager({
      allowModelNetwork: false,
      createRuntime,
      initTimeoutMs: 20,
    });
    await expect(mgr.get()).rejects.toMatchObject({ code: "timeout" });
    await expect(mgr.get()).rejects.toMatchObject({ code: "timeout" });
    expect(createCalls).toBe(2);
  });
});
