import type { AppConfig, ProfileName } from "../config/schema.js";
import { DelegateError } from "../core/errors.js";

export function assertManualAllowed(
  config: AppConfig,
  profile: ProfileName,
  promptMode: "append" | "replace",
): void {
  if (!config.manual.enabled) {
    throw new DelegateError("Manual mode is disabled", "manual_disabled", true);
  }
  if (!config.manual.allowedProfiles.includes(profile)) {
    throw new DelegateError(
      `Manual profile not allowed: ${profile}`,
      "manual_profile_forbidden",
      true,
    );
  }
  if (promptMode === "replace" && !config.manual.allowReplace) {
    throw new DelegateError(
      "Manual replace is disabled in config",
      "manual_replace_disabled",
      true,
    );
  }
}
