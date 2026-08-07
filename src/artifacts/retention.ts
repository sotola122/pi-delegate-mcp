import { existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runsDir } from "../config/paths.js";
import type { AppConfig } from "../config/schema.js";

export function cleanupArtifacts(config: AppConfig): number {
  const root = runsDir();
  if (!existsSync(root)) return 0;
  const cutoff = Date.now() - config.artifacts.retentionDays * 86400_000;
  let removed = 0;
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    try {
      const st = statSync(path);
      if (!st.isDirectory()) continue;
      if (st.mtimeMs < cutoff) {
        rmSync(path, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // ignore
    }
  }
  return removed;
}
