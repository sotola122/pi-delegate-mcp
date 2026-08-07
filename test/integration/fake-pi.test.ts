import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPi, sanitizeEnv } from "../../src/pi/process.js";
import { defaultConfig } from "../../src/config/schema.js";
import { buildPiArgv } from "../../src/pi/argv.js";
import { getProfile } from "../../src/core/profiles.js";

const fakeDir = join(tmpdir(), `pi-delegate-fake-${process.pid}`);
const fakePi = join(fakeDir, "fake-pi");

beforeAll(() => {
  mkdirSync(fakeDir, { recursive: true });
  writeFileSync(
    fakePi,
    `#!/usr/bin/env node
let data='';
process.stdin.on('data',c=>data+=c);
process.stdin.on('end',()=>{
  const mode = process.argv.includes('--mode') ? 'json' : 'text';
  if (process.argv.includes('--fail')) {
    process.stderr.write('boom');
    process.exit(2);
  }
  if (mode === 'json') {
    console.log(JSON.stringify({type:'agent_end',willRetry:false}));
    console.log(JSON.stringify({type:'agent_settled'}));
    console.log(JSON.stringify({type:'message_end',content:'# Review Result\\n\\ntests pass\\n'}));
  } else {
    process.stdout.write('# Review Result\\n\\ntests pass\\n');
  }
});
`,
  );
  chmodSync(fakePi, 0o755);
});

afterAll(() => {
  rmSync(fakeDir, { recursive: true, force: true });
});

describe("fake pi process", () => {
  it("runs without shell and captures stdout", async () => {
    const argv = buildPiArgv({
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinking: "medium",
      profile: getProfile("review"),
    });
    const result = await runPi({
      executable: fakePi,
      argv,
      prompt: "hello",
      env: sanitizeEnv(defaultConfig()),
      timeoutMs: 5000,
      maxStdoutBytes: 1_000_000,
      maxStderrBytes: 1_000_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("# Review Result");
  });

  it("sanitizes env (drops secrets)", () => {
    const env = sanitizeEnv(defaultConfig(), {
      PATH: "/usr/bin",
      HOME: "/home/u",
      SECRET_TOKEN: "nope",
      PI_HOME: "/x",
    });
    expect(env.SECRET_TOKEN).toBeUndefined();
    expect(env.PI_HOME).toBe("/x");
    expect(env.PATH).toBe("/usr/bin");
  });
});
