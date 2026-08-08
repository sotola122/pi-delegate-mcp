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

/** Safe Git metadata only — not credential helpers / config overrides / SSH. */
const GIT_ALLOWLIST = new Set([
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_TERMINAL_PROMPT",
]);

/**
 * Build a sanitized environment for bash subprocesses.
 * Does not forward API keys / cloud credentials / PI session vars by default.
 * Only an explicit GIT_* allowlist is forwarded; use shellEnvironment.passThrough for more.
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
      GIT_ALLOWLIST.has(k) ||
      passThrough.includes(k)
    ) {
      out[k] = v;
    }
  }
  return out;
}

/** @deprecated Prefer buildSanitizedShellEnvironment. */
export function sanitizeEnv(
  config: AppConfig,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return buildSanitizedShellEnvironment(config, base);
}
