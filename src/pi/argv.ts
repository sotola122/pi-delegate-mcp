import type { ProfileDef } from "../core/profiles.js";
import { profileDefaults } from "../core/profiles.js";

export interface ArgvOptions {
  provider: string;
  model: string;
  thinking: string;
  profile: ProfileDef;
  attachments?: string[];
  childSkills?: string[];
  jsonMode?: boolean;
  extraArgs?: string[];
}

function assertSafeArg(arg: string, label: string): void {
  if (arg.includes("\0") || arg.includes("\n") || arg.includes("\r")) {
    throw new Error(`Unsafe ${label}: contains newline or NUL`);
  }
}

export function buildPiArgv(opts: ArgvOptions): string[] {
  const defaults = profileDefaults();
  const argv: string[] = [];

  if (defaults.print !== false) argv.push("--print");
  if (opts.jsonMode) argv.push("--mode", "json");

  assertSafeArg(opts.provider, "provider");
  assertSafeArg(opts.model, "model");
  assertSafeArg(opts.thinking, "thinking");

  argv.push("--provider", opts.provider);
  argv.push("--model", opts.model);
  argv.push("--thinking", opts.thinking);

  if (defaults.no_session !== false) argv.push("--no-session");
  if (defaults.no_extensions !== false) argv.push("--no-extensions");
  if (defaults.no_skills !== false) argv.push("--no-skills");
  if (defaults.no_prompt_templates !== false) argv.push("--no-prompt-templates");
  if (defaults.no_context_files !== false) argv.push("--no-context-files");
  if (defaults.no_approve !== false) argv.push("--no-approve");

  if (opts.profile.no_tools) {
    argv.push("--no-tools");
  } else if (opts.profile.tools?.length) {
    argv.push("--tools", opts.profile.tools.join(","));
  }

  for (const skill of opts.childSkills ?? []) {
    assertSafeArg(skill, "skill");
    argv.push("--skill", skill);
  }

  for (const att of opts.attachments ?? []) {
    assertSafeArg(att, "attachment");
    argv.push(`@${att}`);
  }

  for (const extra of opts.extraArgs ?? []) {
    assertSafeArg(extra, "extra");
    argv.push(extra);
  }

  return argv;
}
