import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";
import { DelegateError } from "../core/errors.js";
import { awaitWithAbort } from "../util/abort.js";

type AnyModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

export const DEFAULT_RUNTIME_INIT_TIMEOUT_MS = 30_000;

export interface CreateRuntimeOptions {
  authPath?: string;
  modelsPath?: string | null;
  allowModelNetwork: boolean;
  modelRefreshTimeoutMs?: number;
  signal?: AbortSignal;
}

export type CreateRuntimeFn = (
  opts: CreateRuntimeOptions,
) => Promise<ModelRuntime>;

export interface ModelRuntimeManagerOptions {
  agentDir?: string;
  authPath?: string;
  modelsPath?: string | null;
  allowModelNetwork: boolean;
  /** Bound for ModelRuntime.create (default 30s). */
  initTimeoutMs?: number;
  /** Test injection. Defaults to ModelRuntime.create. */
  createRuntime?: CreateRuntimeFn;
}

class AsyncMutex {
  private chain: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    const prev = this.chain;
    this.chain = prev.then(() => next);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  return name === "AbortError" || name === "TimeoutError";
}

export class ModelRuntimeManager {
  private runtimePromise?: Promise<ModelRuntime>;
  private refreshMutex = new AsyncMutex();
  private authFileMtime?: number;

  constructor(private readonly options: ModelRuntimeManagerOptions) {}

  private initTimeoutMs(): number {
    return this.options.initTimeoutMs ?? DEFAULT_RUNTIME_INIT_TIMEOUT_MS;
  }

  private ensureCreate(): Promise<ModelRuntime> {
    if (this.runtimePromise) return this.runtimePromise;

    const timeoutMs = this.initTimeoutMs();
    const initSignal = AbortSignal.timeout(timeoutMs);
    const create =
      this.options.createRuntime ??
      ((opts: CreateRuntimeOptions) => ModelRuntime.create(opts));

    const pending = create({
      authPath: this.options.authPath,
      modelsPath: this.options.modelsPath,
      allowModelNetwork: this.options.allowModelNetwork,
      modelRefreshTimeoutMs: timeoutMs,
      signal: initSignal,
    });

    const tracked: Promise<ModelRuntime> = pending.then(
      (runtime) => runtime,
      (err: unknown) => {
        if (this.runtimePromise === tracked) {
          this.runtimePromise = undefined;
        }
        throw err;
      },
    );
    this.runtimePromise = tracked;
    return tracked;
  }

  async get(signal?: AbortSignal): Promise<ModelRuntime> {
    if (signal?.aborted) {
      throw new DelegateError("cancelled", "cancelled", true);
    }
    let runtime: ModelRuntime;
    try {
      runtime = await awaitWithAbort(this.ensureCreate(), signal);
    } catch (err) {
      if (signal?.aborted) {
        throw new DelegateError("cancelled", "cancelled", true);
      }
      if (isAbortError(err)) {
        throw new DelegateError("runtime init timeout", "timeout", true);
      }
      throw err;
    }
    if (signal?.aborted) {
      throw new DelegateError("cancelled", "cancelled", true);
    }
    await awaitWithAbort(this.maybeRefreshAuth(runtime, signal), signal);
    if (signal?.aborted) {
      throw new DelegateError("cancelled", "cancelled", true);
    }
    return runtime;
  }

  async resolveModel(
    provider: string,
    modelId: string,
    signal?: AbortSignal,
  ): Promise<AnyModel> {
    if (signal?.aborted) {
      throw new DelegateError("cancelled", "cancelled", true);
    }
    const runtime = await this.get(signal);
    const model = runtime.getModel(provider, modelId);
    if (!model) {
      throw new DelegateError(
        `Model not found: ${provider}/${modelId}`,
        "model_not_found",
        true,
      );
    }
    if (!runtime.hasConfiguredAuth(provider)) {
      throw new DelegateError(
        `Auth required for provider ${provider}`,
        "auth_required",
        true,
      );
    }
    const auth = await awaitWithAbort(runtime.getAuth(provider), signal);
    if (!auth) {
      throw new DelegateError(
        `Auth required for provider ${provider}`,
        "auth_required",
        true,
      );
    }
    return model;
  }

  async refreshProvider(provider: string, signal?: AbortSignal): Promise<void> {
    const runtime = await this.get(signal);
    await awaitWithAbort(
      runtime.refresh({ providers: [provider], signal }),
      signal,
    );
  }

  private async maybeRefreshAuth(
    runtime: ModelRuntime,
    signal?: AbortSignal,
  ): Promise<void> {
    const authPath = this.options.authPath;
    if (!authPath) return;
    await this.refreshMutex.run(async () => {
      try {
        const mtime = statSync(authPath).mtimeMs;
        if (this.authFileMtime !== undefined && mtime !== this.authFileMtime) {
          await awaitWithAbort(runtime.refresh({ signal }), signal);
        }
        this.authFileMtime = mtime;
      } catch (err) {
        if (signal?.aborted) throw err;
        // auth file may not exist yet
      }
    });
  }
}

let shared: ModelRuntimeManager | undefined;

export function getSharedRuntimeManager(
  options: ModelRuntimeManagerOptions,
): ModelRuntimeManager {
  if (!shared) {
    shared = new ModelRuntimeManager(options);
  }
  return shared;
}

export function resetSharedRuntimeManagerForTests(): void {
  shared = undefined;
}
