import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { AppConfig } from "../config/schema.js";
import { expandHome } from "../config/paths.js";
import { DelegateError } from "../core/errors.js";
import { isPathInside, resolveRealPath } from "./roots.js";

const SKILL_ENTRY = "SKILL.md";

function skillPackageRoot(abs: string): string {
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) {
    throw new DelegateError(
      `Child skill ${SKILL_ENTRY} must be a regular file or directory`,
      "child_skill_invalid",
      true,
    );
  }
  if (st.isDirectory()) return abs;
  if (st.isFile() && basename(abs) === SKILL_ENTRY) return dirname(abs);
  throw new DelegateError(
    `Child skill must be a ${SKILL_ENTRY} file or a directory containing it`,
    "child_skill_invalid",
    true,
  );
}

function assertSkillEntry(packageRoot: string): void {
  const entry = join(packageRoot, SKILL_ENTRY);
  if (!existsSync(entry)) {
    throw new DelegateError(
      `Child skill package missing ${SKILL_ENTRY}: ${packageRoot}`,
      "child_skill_invalid",
      true,
    );
  }
  const entryStat = lstatSync(entry);
  if (entryStat.isSymbolicLink() || !entryStat.isFile()) {
    throw new DelegateError(
      `Child skill ${SKILL_ENTRY} must be a regular file`,
      "child_skill_invalid",
      true,
    );
  }
  const realEntry = realpathSync(entry);
  const realPkg = resolveRealPath(packageRoot);
  if (!isPathInside(realPkg, realEntry)) {
    throw new DelegateError(
      `Child skill ${SKILL_ENTRY} escapes its package directory`,
      "child_skill_invalid",
      true,
    );
  }
}

/**
 * Validate child skill packages. Returns package directories containing SKILL.md
 * for Pi `additionalSkillPaths`. No allowlist — callers pick paths explicitly.
 */
export function validateChildSkills(
  skills: string[] | undefined,
  config: AppConfig,
  _workspace?: string,
): string[] {
  if (!skills?.length) return [];

  if (!config.childSkills.enabled) {
    throw new DelegateError(
      "childSkills are disabled in config (set childSkills.enabled to true)",
      "child_skills_disabled",
      true,
    );
  }

  const max = config.limits.maxChildSkillCount;
  if (skills.length > max) {
    throw new DelegateError(
      `Too many childSkills (max ${max})`,
      "too_many_child_skills",
      true,
    );
  }

  const out: string[] = [];
  const seen = new Set<string>();

  for (const skill of skills) {
    if (skill.includes("\0") || skill.includes("\n") || skill.includes("\r")) {
      throw new DelegateError(
        "Unsafe child skill path",
        "child_skill_unsafe",
        true,
      );
    }

    const absGuess = resolve(expandHome(skill));
    if (!existsSync(absGuess)) {
      throw new DelegateError(
        `Child skill not found: ${skill}`,
        "child_skill_missing",
        true,
      );
    }

    let abs: string;
    try {
      abs = realpathSync(absGuess);
    } catch {
      throw new DelegateError(
        `Child skill not found: ${skill}`,
        "child_skill_missing",
        true,
      );
    }

    const packageRoot = skillPackageRoot(abs);
    assertSkillEntry(packageRoot);

    const key = resolveRealPath(packageRoot);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}
