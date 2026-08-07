import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runsDir } from "../config/paths.js";
import type { AppConfig } from "../config/schema.js";
import { redactSecrets } from "./redact.js";
import { assertSafeRunId } from "../core/ids.js";
import { isPathInside } from "../workspace/roots.js";

export interface RunDirs {
  runId: string;
  root: string;
  input: string;
  prompt: string;
  pi: string;
  result: string;
}

export function createRunDirs(runId: string = randomUUID()): RunDirs {
  const id = assertSafeRunId(runId);
  const root = join(runsDir(), id);
  if (!isPathInside(runsDir(), root)) {
    throw new Error(`Run directory escapes runsDir: ${root}`);
  }
  const dirs = {
    runId: id,
    root,
    input: join(root, "input"),
    prompt: join(root, "prompt"),
    pi: join(root, "pi"),
    result: join(root, "result"),
  };
  for (const d of [dirs.root, dirs.input, dirs.prompt, dirs.pi, dirs.result]) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
  }
  return dirs;
}

export function writeArtifact(
  path: string,
  content: string | Buffer,
  redact = true,
): void {
  const data =
    typeof content === "string" && redact ? redactSecrets(content) : content;
  writeFileSync(path, data, { mode: 0o600 });
}

export function savePiOutputs(
  dirs: RunDirs,
  stdout: string,
  stderr: string,
  eventsJsonl?: string,
): Array<{ kind: string; path: string }> {
  const artifacts: Array<{ kind: string; path: string }> = [];
  const stdoutPath = join(dirs.pi, "stdout.txt");
  const stderrPath = join(dirs.pi, "stderr.txt");
  writeArtifact(stdoutPath, stdout);
  writeArtifact(stderrPath, stderr);
  artifacts.push({ kind: "stdout", path: stdoutPath });
  artifacts.push({ kind: "stderr", path: stderrPath });
  if (eventsJsonl !== undefined) {
    const p = join(dirs.pi, "events.jsonl");
    writeArtifact(p, eventsJsonl);
    artifacts.push({ kind: "events", path: p });
  }
  return artifacts;
}

export function saveResultJson(dirs: RunDirs, result: unknown): string {
  const p = join(dirs.result, "result.json");
  writeArtifact(p, JSON.stringify(result, null, 2) + "\n");
  return p;
}

export function maybeSavePrompt(
  config: AppConfig,
  dirs: RunDirs,
  prompt: string,
): string | undefined {
  if (!config.artifacts.storeAssembledPrompt) return undefined;
  const p = join(dirs.prompt, "assembled.md");
  writeArtifact(p, prompt);
  return p;
}
