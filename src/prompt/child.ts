import { readAsset } from "./assets.js";
import { DelegateError } from "../core/errors.js";

export function assembleChildPrompt(opts: {
  agentsMd?: string;
  developerInstructions?: string;
  message: string;
  resume?: boolean;
  maxBytes?: number;
}): string {
  const parts: string[] = [];
  if (!opts.resume) {
    parts.push(readAsset("prompts/system/safety.md").trim());
    if (opts.agentsMd?.trim()) parts.push(opts.agentsMd.trim());
  }
  if (opts.developerInstructions?.trim()) {
    parts.push(opts.developerInstructions.trim());
  }
  parts.push(opts.message.trim());
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
