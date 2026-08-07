import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";
import { DelegateError } from "../core/errors.js";

type AnyModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

export interface ModelRuntimeManagerOptions {
  agentDir?: string;
  authPath?: string;
  modelsPath?: string | null;
  allowModelNetwork: boolean;
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

export class ModelRuntimeManager {
  private runtimePromise?: Promise<ModelRuntime>;
  private refreshMutex = new AsyncMutex();
  private authFileMtime?: number;

  constructor(private readonly options: ModelRuntimeManagerOptions) {}

  async get(_signal?: AbortSignal): Promise<ModelRuntime> {
    if (!this.runtimePromise) {
      this.runtimePromise = ModelRuntime.create({
        authPath: this.options.authPath,
        modelsPath: this.options.modelsPath,
        allowModelNetwork: this.options.allowModelNetwork,
      });
    }
    const runtime = await this.runtimePromise;
    await this.maybeRefreshAuth(runtime);
    return runtime;
  }

  async resolveModel(
    provider: string,
    modelId: string,
    signal?: AbortSignal,
  ): Promise<AnyModel> {
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
    const auth = await runtime.getAuth(provider);
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
    await runtime.refresh({ providers: [provider], signal });
  }

  private async maybeRefreshAuth(runtime: ModelRuntime): Promise<void> {
    const authPath = this.options.authPath;
    if (!authPath) return;
    await this.refreshMutex.run(async () => {
      try {
        const mtime = statSync(authPath).mtimeMs;
        if (this.authFileMtime !== undefined && mtime !== this.authFileMtime) {
          await runtime.refresh();
        }
        this.authFileMtime = mtime;
      } catch {
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
