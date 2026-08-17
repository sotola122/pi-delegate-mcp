import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { defaultConfig } from "../../src/config/schema.js";
import { runDelegation } from "../../src/core/delegate.js";
import { FakePiExecutor } from "../fakes/fake-pi-executor.js";
import { setPiExecutorForTests } from "../../src/pi-sdk/factory.js";
import { buildSanitizedShellEnvironment } from "../../src/pi-sdk/environment.js";
import { mapProfileToSdkTools } from "../../src/pi-sdk/profile-mapper.js";

afterEach(() => {
  setPiExecutorForTests(undefined);
});

describe("fake pi executor", () => {
  it("runs delegation with injected fake executor", async () => {
    const root = join(tmpdir(), `pi-delegate-int-${process.pid}`);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    execSync("git init", { cwd: root });
    execSync('git config user.email "t@t"', { cwd: root });
    execSync('git config user.name "t"', { cwd: root });
    writeFileSync(join(root, "README.md"), "hello\n");
    execSync("git add . && git commit -m init", { cwd: root });

    const fake = new FakePiExecutor(async () => ({
      finalText: "# Review Result\n\nlooks fine\n",
      completion: "completed",
      agentStarted: true,
      agentEnded: true,
    }));
    setPiExecutorForTests(fake);

    const config = defaultConfig();
    config.workspace.allowedRoots = [root];

    const result = await runDelegation({
      profile: "review",
      objective: "review the repo",
      workspace: root,
      config,
      reviewKind: "static-hunt",
    });

    expect(result.status).toBe("success");
    expect(result.output).toContain("# Review Result");
    expect(result.attempts[0]?.backend).toBe("fake");
    expect(result.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    rmSync(root, { recursive: true, force: true });
  });

  it("sanitizes shell env", () => {
    const env = buildSanitizedShellEnvironment(defaultConfig(), {
      PATH: "/usr/bin",
      HOME: "/home/u",
      SECRET_TOKEN: "nope",
      PI_HOME: "/x",
    });
    expect(env.SECRET_TOKEN).toBeUndefined();
    expect(env.PI_HOME).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("maps profiles for sdk", () => {
    expect(mapProfileToSdkTools("verify").tools).toContain("bash");
    expect(mapProfileToSdkTools("verify").tools).not.toContain("edit");
  });
});
