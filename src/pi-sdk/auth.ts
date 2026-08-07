import { createInterface } from "node:readline";
import { stdin as input, stdout as output, stderr } from "node:process";
import { homedir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../config/schema.js";
import { getPiSdkVersion } from "./version.js";

function expandHome(p: string | undefined | null): string | undefined {
  if (!p) return undefined;
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

function authPaths(config: AppConfig): {
  authPath: string;
  modelsPath: string;
  agentDir: string;
} {
  const agentDir =
    expandHome(config.pi.agentDir) ?? join(homedir(), ".pi", "agent");
  return {
    agentDir,
    authPath: expandHome(config.pi.authPath) ?? join(agentDir, "auth.json"),
    modelsPath:
      expandHome(config.pi.modelsPath) ?? join(agentDir, "models.json"),
  };
}

async function createRuntime(config: AppConfig): Promise<ModelRuntime> {
  const paths = authPaths(config);
  return ModelRuntime.create({
    authPath: paths.authPath,
    modelsPath: paths.modelsPath,
    allowModelNetwork: config.pi.allowModelNetwork ?? false,
  });
}

function promptTerminal(message: string, secret = false): Promise<string> {
  return new Promise((resolve) => {
    if (secret && typeof input.setRawMode === "function") {
      // Minimal secret input: readline still echoes on some terminals;
      // prefer not logging the value.
      stderr.write(`${message}`);
    }
    const rl = createInterface({ input, output: secret ? undefined : output });
    rl.question(secret ? message : `${message}`, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export async function authStatus(config: AppConfig): Promise<void> {
  const paths = authPaths(config);
  console.log(`sdk: @earendil-works/pi-coding-agent@${getPiSdkVersion()}`);
  console.log(`agentDir: ${paths.agentDir}`);
  console.log(`authPath: ${paths.authPath}`);
  console.log(`modelsPath: ${paths.modelsPath}`);
  const runtime = await createRuntime(config);
  for (const provider of runtime.getProviders()) {
    const check = await runtime.checkAuth(provider.id);
    const configured = runtime.hasConfiguredAuth(provider.id);
    console.log(
      `${provider.id}: configured=${configured}` +
        (check ? ` type=${check.type} source=${check.source ?? "-"}` : ""),
    );
  }
}

export async function authLogin(
  config: AppConfig,
  providerId: string,
): Promise<void> {
  const runtime = await createRuntime(config);
  await runtime.login(providerId, "oauth", {
    notify(event) {
      if (event.type === "auth_url") {
        console.log(`Open URL: ${event.url}`);
        if (event.instructions) console.log(event.instructions);
      } else if (event.type === "device_code") {
        console.log(`Verification URI: ${event.verificationUri}`);
        console.log(`User code: ${event.userCode}`);
      } else if (event.type === "progress" && event.message) {
        console.log(event.message);
      } else if (event.type === "info" && event.message) {
        console.log(event.message);
      }
    },
    async prompt(prompt) {
      if (prompt.type === "select") {
        console.log(prompt.message);
        for (const opt of prompt.options) {
          console.log(`  ${opt.id}: ${opt.label}`);
        }
        return promptTerminal("Select id: ");
      }
      if (prompt.type === "secret") {
        return promptTerminal(`${prompt.message} `, true);
      }
      return promptTerminal(`${prompt.message} `);
    },
  });
  console.log(`Logged in: ${providerId}`);
}

export async function authLogout(
  config: AppConfig,
  providerId: string,
): Promise<void> {
  const runtime = await createRuntime(config);
  await runtime.logout(providerId);
  console.log(`Logged out: ${providerId}`);
}
