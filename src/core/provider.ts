import { join } from "node:path";
import { parseYamlFile } from "../config/loader.js";
import type {
  AppConfig,
  Effort,
  AllowedModel,
  ProfileName,
} from "../config/schema.js";
import { assetsRoot } from "../prompt/assets.js";
import { DelegateError } from "./errors.js";

export interface ProfileDefault {
  model: string;
  effort: Effort;
}

export interface ProviderFile {
  provider: string;
  default_model: string;
  smoke: {
    provider_auth: { model: string; thinking: string };
    planned_tuple: { thinking: string };
  };
  profile_defaults?: Partial<Record<ProfileName, ProfileDefault>>;
  effort: Record<string, { thinking: string; when?: string }>;
  thinking_rank: string[];
  implement_alternate: {
    model: string;
    thinking: string;
    when: string[];
  };
  multimodal: {
    provider: string;
    model: string;
    supports_image_input: boolean;
    image_formats: string[];
  };
  vision_capable_models: string[];
  retry: { max_attempts: number };
}

export interface ResolvedProvider {
  provider: string;
  model: string;
  thinking: string;
  effort: Effort;
  usedAlternate: boolean;
}

let cached: ProviderFile | undefined;

export function loadProviderFile(): ProviderFile {
  if (cached) return cached;
  cached = parseYamlFile<ProviderFile>(join(assetsRoot(), "provider.yaml"));
  return cached;
}

/** Test helper — clears the cached provider.yaml parse. */
export function clearProviderCache(): void {
  cached = undefined;
}

function thinkingRank(file: ProviderFile, thinking: string): number {
  const idx = file.thinking_rank.indexOf(thinking);
  return idx < 0 ? 0 : idx;
}

function maxThinking(file: ProviderFile, a: string, b: string): string {
  return thinkingRank(file, a) >= thinkingRank(file, b) ? a : b;
}

export interface ResolveInput {
  config: AppConfig;
  profile?: ProfileName;
  effort?: Effort;
  model?: AllowedModel;
  imageInputPlanned?: boolean;
  useImplementAlternate?: boolean;
  thinkingOverride?: string;
}

export function resolveProvider(input: ResolveInput): ResolvedProvider {
  const file = loadProviderFile();
  const profileDefault =
    input.profile !== undefined
      ? file.profile_defaults?.[input.profile]
      : undefined;
  const effort: Effort = input.effort ?? profileDefault?.effort ?? "med";
  const effortEntry = file.effort[effort];
  if (!effortEntry) {
    throw new DelegateError(`Unknown effort: ${effort}`, "invalid_effort", true);
  }

  let provider = file.provider;
  let model = file.default_model;
  let thinking = effortEntry.thinking;
  let usedAlternate = false;

  if (input.imageInputPlanned) {
    provider = file.multimodal.provider;
    model = file.multimodal.model;
  }

  if (input.useImplementAlternate && !input.model) {
    model = file.implement_alternate.model;
    thinking = maxThinking(file, thinking, file.implement_alternate.thinking);
    usedAlternate = true;
  }

  if (input.model) {
    model = input.model;
  }

  if (input.config.pi.provider) {
    provider = input.config.pi.provider;
  }
  if (!input.model && !input.useImplementAlternate && !input.imageInputPlanned) {
    model = profileDefault?.model ?? input.config.pi.defaultModel;
  }

  if (input.thinkingOverride) {
    thinking = input.thinkingOverride;
  }

  if (
    !input.config.pi.allowedModels.includes(
      model as (typeof input.config.pi.allowedModels)[number],
    )
  ) {
    throw new DelegateError(
      `Model not allowed: ${model}`,
      "model_not_allowed",
      true,
    );
  }

  return { provider, model, thinking, effort, usedAlternate };
}

export function smokeThinking(
  mode: "provider-auth" | "planned-tuple",
  resolved?: ResolvedProvider,
): { provider: string; model: string; thinking: string } {
  const file = loadProviderFile();
  if (mode === "provider-auth") {
    return {
      provider: file.provider,
      model: file.smoke.provider_auth.model,
      thinking: file.smoke.provider_auth.thinking,
    };
  }
  return {
    provider: resolved?.provider ?? file.provider,
    model: resolved?.model ?? file.default_model,
    thinking: file.smoke.planned_tuple.thinking,
  };
}
