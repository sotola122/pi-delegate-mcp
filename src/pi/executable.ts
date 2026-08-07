import { accessSync, constants } from "node:fs";
import { delimiter, dirname, join, isAbsolute } from "node:path";
import { DelegateError } from "../core/errors.js";

export function resolvePiExecutable(configured: string): string {
  if (isAbsolute(configured) || configured.includes("/") || configured.includes("\\")) {
    try {
      accessSync(configured, constants.X_OK);
      return configured;
    } catch {
      throw new DelegateError(
        `Pi executable not found or not executable: ${configured}`,
        "pi_not_found",
        true,
      );
    }
  }

  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, configured);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
    // Windows may need .cmd / .exe
    for (const ext of [".cmd", ".exe", ".bat"]) {
      const win = candidate + ext;
      try {
        accessSync(win, constants.F_OK);
        return win;
      } catch {
        // continue
      }
    }
  }

  throw new DelegateError(
    `Pi executable "${configured}" not found on PATH`,
    "pi_not_found",
    true,
  );
}

export function whichDir(executable: string): string | undefined {
  try {
    return dirname(resolvePiExecutable(executable));
  } catch {
    return undefined;
  }
}
