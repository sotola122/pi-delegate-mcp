import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { AppConfig } from "../config/schema.js";
import { defaultChildSkillRoots, expandHome } from "../config/paths.js";
import { DelegateError } from "../core/errors.js";
import { isPathInside, resolveRealPath } from "./roots.js";

const SKILL_ENTRY = "SKILL.md";

/**
 * Roots a child skill may be selected from. Empty `allowedRoots` falls back to
 * conventional skill directories. The workspace is appended only for that
 * fallback so an explicit admin allowlist stays authoritative.
 */
export function resolveChildSkillRoots(
  config: AppConfig,
  workspace?: string,
): string[] {
  const configured = config.childSkills.allowedRoots.map(expandHome);
  if (configured.length > 0) return configured.map((r) => resolve(r));
  const roots = defaultChildSkillRoots().map((r) => resolve(r));
  if (workspace) roots.push(resolve(workspace));
  return roots;
}

function lexicalInside(root: string, candidate: string): boolean {
  const r = resolve(expandHome(root));
  const c = resolve(expandHome(candidate));
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
}

function isUnderAnyRoot(roots: string[], candidate: string): boolean {
  return roots.some((root) => lexicalInside(root, candidate));
}

function skillPackageRoot(abs: string): string {
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) {
    throw new DelegateError(
      "Child skill outside allowed roots",
      "child_skill_forbidden",
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
      "Child skill outside allowed roots",
      "child_skill_forbidden",
      true,
    );
  }
}

export function validateChildSkills(
  skills: string[] | undefined,
  config: AppConfig,
  workspace?: string,
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

  const allowed = resolveChildSkillRoots(config, workspace);
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

    const expanded = expandHome(skill);
    const absGuess = resolve(expanded);

    // Containment before any existence probe (uniform outside response).
    if (!isUnderAnyRoot(allowed, absGuess)) {
      throw new DelegateError(
        "Child skill outside allowed roots",
        "child_skill_forbidden",
        true,
      );
    }

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

    // Re-check after realpath so symlink escapes are rejected.
    if (!allowed.some((root) => isPathInside(root, abs))) {
      throw new DelegateError(
        "Child skill outside allowed roots",
        "child_skill_forbidden",
        true,
      );
    }

    const packageRoot = skillPackageRoot(abs);
    if (!allowed.some((root) => isPathInside(root, packageRoot))) {
      throw new DelegateError(
        "Child skill outside allowed roots",
        "child_skill_forbidden",
        true,
      );
    }
    assertSkillEntry(packageRoot);

    const key = resolveRealPath(packageRoot);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * Copy validated skill packages into a run-owned directory as regular files
 * only (symlinks are skipped). Returns materialized package directories for
 * Pi `additionalSkillPaths`.
 */
export function materializeChildSkills(
  validatedPackageRoots: string[],
  destRoot: string,
): string[] {
  if (!validatedPackageRoots.length) return [];
  mkdirSync(destRoot, { recursive: true, mode: 0o700 });

  return validatedPackageRoots.map((pkg, index) => {
    const realPkg = resolveRealPath(pkg);
    const slot = join(
      destRoot,
      `${String(index).padStart(2, "0")}-${basename(realPkg)}`,
    );
    mkdirSync(slot, { recursive: true, mode: 0o700 });
    copySkillTree(realPkg, slot, realPkg);
    if (!existsSync(join(slot, SKILL_ENTRY))) {
      throw new DelegateError(
        `Failed to materialize ${SKILL_ENTRY} for ${pkg}`,
        "child_skill_invalid",
        true,
      );
    }
    return slot;
  });
}

function copySkillTree(
  srcDir: string,
  destDir: string,
  packageRoot: string,
): void {
  for (const name of readdirSync(srcDir)) {
    const src = join(srcDir, name);
    const dest = join(destDir, name);
    let st;
    try {
      st = lstatSync(src);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      // Skip — closes nested symlink escapes into the materialization.
      continue;
    }
    if (st.isDirectory()) {
      const real = resolveRealPath(src);
      if (
        !isPathInside(packageRoot, real) &&
        real !== resolveRealPath(packageRoot)
      ) {
        continue;
      }
      mkdirSync(dest, { recursive: true, mode: 0o700 });
      copySkillTree(src, dest, packageRoot);
      continue;
    }
    if (!st.isFile()) continue;
    const real = resolveRealPath(src);
    if (!isPathInside(packageRoot, real)) continue;
    writeFileSync(dest, readFileSync(src), { mode: 0o600 });
  }
}
