import { loadConfig } from "../config/loader.js";
import { cleanupArtifacts } from "../artifacts/retention.js";

export function cleanupCommand(): void {
  const config = loadConfig();
  const n = cleanupArtifacts(config);
  console.log(`Removed ${n} expired run artifact directories`);
}
