import { getProfile } from "../core/profiles.js";
import type { ProfileName } from "../config/schema.js";

export interface SdkToolProfile {
  tools: string[];
  excludeTools: string[];
  noTools: boolean;
}

export function mapProfileToSdkTools(profile: ProfileName): SdkToolProfile {
  const def = getProfile(profile);
  if (def.no_tools) {
    return { tools: [], excludeTools: [], noTools: true };
  }
  return {
    tools: [...(def.tools ?? [])],
    excludeTools: [...(def.exclude_tools ?? [])],
    noTools: false,
  };
}
