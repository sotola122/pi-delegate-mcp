import {
  DefaultResourceLoader,
  SettingsManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { PiAttemptPlan } from "./types.js";
import { immutableDelegationSafetyPrompt } from "./safety-prompt.js";
import {
  createDelegationPolicyExtension,
  createSanitizedBashExtension,
} from "./policy-extension.js";
import { buildSanitizedShellEnvironment } from "./environment.js";

export async function createDelegationResourceLoader(opts: {
  plan: PiAttemptPlan;
  settingsManager: SettingsManager;
  agentDir?: string;
}): Promise<DefaultResourceLoader> {
  const { plan, settingsManager } = opts;
  const agentDir = opts.agentDir ?? getAgentDir();
  const cwd = plan.cwd ?? process.cwd();
  const needsBash = !plan.noTools && plan.tools.includes("bash");

  const extensionFactories = [
    createDelegationPolicyExtension(plan.policy),
    ...(needsBash
      ? [
          createSanitizedBashExtension(
            cwd,
            buildSanitizedShellEnvironment(plan.config),
          ),
        ]
      : []),
  ];

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalSkillPaths: plan.childSkillPaths,
    appendSystemPrompt: [immutableDelegationSafetyPrompt(plan.policy)],
    extensionFactories,
  });
  await loader.reload();
  return loader;
}
