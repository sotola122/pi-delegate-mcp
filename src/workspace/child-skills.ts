import { existsSync, statSync } from "node:fs";
import type { AppConfig } from "../config/schema.js";
import { DelegateError } from "../core/errors.js";
import { isPathInside, resolveRealPath } from "./roots.js";

export function validateChildSkills(
  skills: string[] | undefined,
  config: AppConfig,
): string[] {
  if (!skills?.length) return [];

  if (!config.childSkills.enabled) {
    throw new DelegateError(
      "childSkills are disabled in config",
      "child_skills_disabled",
      true,
    );
  }

  const allowed = config.childSkills.allowedRoots;
  if (allowed.length === 0) {
    throw new DelegateError(
      "childSkills.allowedRoots is empty; refusing skill paths",
      "child_skills_no_roots",
      true,
    );
  }

  const out: string[] = [];
  for (const skill of skills) {
    if (skill.includes("\0") || skill.includes("\n") || skill.includes("\r")) {
      throw new DelegateError(
        "Unsafe child skill path",
        "child_skill_unsafe",
        true,
      );
    }
    const abs = resolveRealPath(skill);
    if (!existsSync(abs)) {
      throw new DelegateError(
        `Child skill not found: ${skill}`,
        "child_skill_missing",
        true,
      );
    }
    const st = statSync(abs);
    if (!st.isFile() && !st.isDirectory()) {
      throw new DelegateError(
        `Child skill is not a file or directory: ${skill}`,
        "child_skill_invalid",
        true,
      );
    }
    if (!allowed.some((root) => isPathInside(root, abs))) {
      throw new DelegateError(
        `Child skill outside allowedRoots: ${skill}`,
        "child_skill_forbidden",
        true,
      );
    }
    out.push(abs);
  }
  return out;
}
