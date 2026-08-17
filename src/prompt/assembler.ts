import type { ProfileName } from "../config/schema.js";
import { DelegateError } from "../core/errors.js";
import { readAsset, assetExists } from "./assets.js";
import { serializeTaskBlock, type TaskBlock } from "./task-block.js";

export type Lens = "adversarial" | "tooling-suggest";
export type Modality = "vision" | "document" | "browser";

export interface AssembleOptions {
  profile: ProfileName;
  task: TaskBlock;
  lenses?: Lens[];
  modalities?: Modality[];
  manualPrompt?: string;
  promptMode?: "append" | "replace";
  maxBytes?: number;
  /** Skip static profile/safety bodies; keep per-run deltas. */
  resume?: boolean;
}

const PROFILE_PROMPT: Record<ProfileName, string> = {
  review: "prompts/review.md",
  verify: "prompts/verify.md",
  implement: "prompts/implement.md",
  "no-tools": "prompts/no-tools.md",
};

const LENS_ORDER: Lens[] = ["adversarial", "tooling-suggest"];
const MODALITY_ORDER: Modality[] = ["vision", "document", "browser"];

export function assemblePrompt(opts: AssembleOptions): string {
  const safety = readAsset("prompts/system/safety.md").trim();
  const outputContract = readAsset("prompts/system/output-contract.md").trim();
  const resume = Boolean(opts.resume);
  const parts: string[] = resume ? [] : [safety];

  const mode = opts.promptMode ?? "append";

  if (mode === "replace") {
    if (!opts.manualPrompt?.trim()) {
      throw new DelegateError(
        "Manual replace requires prompt text",
        "manual_prompt_required",
        true,
      );
    }
    parts.push(opts.manualPrompt.trim());
    parts.push(outputContract);
  } else {
    if (!resume) {
      parts.push(readAsset(PROFILE_PROMPT[opts.profile]).trim());
    }

    if (assetExists("references/multimodal.md") && (opts.modalities?.length ?? 0) > 0) {
      parts.push(readAsset("references/multimodal.md").trim());
    }

    for (const m of MODALITY_ORDER) {
      if (!opts.modalities?.includes(m)) continue;
      const ref = `references/${m}.md`;
      const append = `prompts/append/${m}.md`;
      if (assetExists(ref)) parts.push(readAsset(ref).trim());
      if (assetExists(append)) parts.push(readAsset(append).trim());
    }

    for (const lens of LENS_ORDER) {
      if (!opts.lenses?.includes(lens)) continue;
      parts.push(readAsset(`prompts/append/${lens}.md`).trim());
    }

    if (opts.manualPrompt?.trim()) {
      parts.push(opts.manualPrompt.trim());
    }

    parts.push(outputContract);
  }

  parts.push(serializeTaskBlock(opts.task));

  const prompt = parts.filter(Boolean).join("\n\n");
  const max = opts.maxBytes ?? 262144;
  const bytes = Buffer.byteLength(prompt, "utf8");
  if (bytes > max) {
    throw new DelegateError(
      `Prompt exceeds maxPromptBytes (${bytes} > ${max})`,
      "prompt_too_large",
      true,
    );
  }
  return prompt;
}

export function smokePrompt(): string {
  return readAsset("prompts/smoke.md").trim();
}
