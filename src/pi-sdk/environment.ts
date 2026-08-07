import type { AppConfig } from "../config/schema.js";

const DEFAULT_PASS = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "TERM",
];

/**
 * Build a sanitized environment for bash subprocesses.
 * Does not forward API keys / cloud credentials / PI session vars by default.
 * GIT_* and LC_* are allowed; PI_* is NOT forwarded for SDK bash isolation.
 */
export function buildSanitizedShellEnvironment(
  config: AppConfig,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const passThrough =
    config.shellEnvironment?.passThrough ??
    config.environment?.passThrough ??
    [];
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (
      DEFAULT_PASS.includes(k) ||
      k.startsWith("LC_") ||
      k.startsWith("GIT_") ||
      passThrough.includes(k)
    ) {
      out[k] = v;
    }
  }
  return out;
}

/** @deprecated Prefer buildSanitizedShellEnvironment; kept for CLI backend. */
export function sanitizeEnv(
  config: AppConfig,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const passThrough =
    config.shellEnvironment?.passThrough ??
    config.environment?.passThrough ??
    [];
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (
      DEFAULT_PASS.includes(k) ||
      k.startsWith("LC_") ||
      k.startsWith("GIT_") ||
      k.startsWith("PI_") ||
      passThrough.includes(k)
    ) {
      out[k] = v;
    }
  }
  return out;
}
