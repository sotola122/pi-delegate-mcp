import { join } from "node:path";
import { parseYamlFile } from "../config/loader.js";
import type { ProfileName } from "../config/schema.js";
import { assetsRoot } from "../prompt/assets.js";

export interface ProfileDef {
  purpose?: string;
  tools?: string[];
  exclude_tools?: string[];
  writable: boolean;
  no_tools?: boolean;
}

export interface ProfilesFile {
  defaults: Record<string, boolean>;
  profiles: Record<string, ProfileDef>;
}

let cached: ProfilesFile | undefined;

export function loadProfiles(): ProfilesFile {
  if (cached) return cached;
  cached = parseYamlFile<ProfilesFile>(join(assetsRoot(), "profiles.yaml"));
  return cached;
}

export function getProfile(name: ProfileName): ProfileDef {
  const file = loadProfiles();
  const profile = file.profiles[name];
  if (!profile) throw new Error(`Unknown profile: ${name}`);
  return profile;
}

export function profileDefaults(): Record<string, boolean> {
  return loadProfiles().defaults;
}
