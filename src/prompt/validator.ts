import { DelegateError } from "../core/errors.js";

const FORBIDDEN_IN_MANUAL =
  /(?:--tools\b|--skill\b|--extension\b|-e\s|shell:\s*true|exec\s*\()/i;

export function validateManualPrompt(prompt: string): void {
  if (FORBIDDEN_IN_MANUAL.test(prompt)) {
    throw new DelegateError(
      "Manual prompt must not attempt to widen tools or inject CLI flags",
      "manual_tool_widening",
      true,
    );
  }
}
