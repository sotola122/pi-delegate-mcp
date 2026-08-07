import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { platform } from "node:os";
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

export function sanitizeEnv(
  config: AppConfig,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (
      DEFAULT_PASS.includes(k) ||
      k.startsWith("LC_") ||
      k.startsWith("GIT_") ||
      k.startsWith("PI_") ||
      config.environment.passThrough.includes(k)
    ) {
      out[k] = v;
    }
  }
  return out;
}

export interface RunPiOptions {
  executable: string;
  argv: string[];
  cwd?: string;
  prompt: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  signal?: AbortSignal;
  graceMs?: number;
}

export interface RunPiResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  cancelled: boolean;
  timedOut: boolean;
  durationMs: number;
}

function killTree(child: ChildProcessWithoutNullStreams, sig: NodeJS.Signals): void {
  if (!child.pid) return;
  if (platform() === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      shell: false,
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-child.pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      // ignore
    }
  }
}

export async function runPi(opts: RunPiOptions): Promise<RunPiResult> {
  const started = Date.now();
  let cancelled = false;
  let timedOut = false;
  let stdoutBuf = Buffer.alloc(0);
  let stderrBuf = Buffer.alloc(0);
  let stdoutTruncated = false;
  let stderrTruncated = false;

  const child = spawn(opts.executable, opts.argv, {
    cwd: opts.cwd,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: opts.env,
    detached: platform() !== "win32",
  });

  const graceMs = opts.graceMs ?? 5_000;

  const abortHandler = () => {
    cancelled = true;
    killTree(child, "SIGTERM");
    setTimeout(() => killTree(child, "SIGKILL"), graceMs).unref?.();
  };

  if (opts.signal) {
    if (opts.signal.aborted) abortHandler();
    else opts.signal.addEventListener("abort", abortHandler, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    cancelled = true;
    killTree(child, "SIGTERM");
    setTimeout(() => killTree(child, "SIGKILL"), graceMs).unref?.();
  }, opts.timeoutMs);

  child.stdin.write(opts.prompt, "utf8");
  child.stdin.end();

  child.stdout.on("data", (chunk: Buffer) => {
    if (stdoutTruncated) return;
    if (stdoutBuf.length + chunk.length > opts.maxStdoutBytes) {
      stdoutBuf = Buffer.concat([
        stdoutBuf,
        chunk.subarray(0, Math.max(0, opts.maxStdoutBytes - stdoutBuf.length)),
      ]);
      stdoutTruncated = true;
      return;
    }
    stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
  });

  child.stderr.on("data", (chunk: Buffer) => {
    if (stderrTruncated) return;
    if (stderrBuf.length + chunk.length > opts.maxStderrBytes) {
      stderrBuf = Buffer.concat([
        stderrBuf,
        chunk.subarray(0, Math.max(0, opts.maxStderrBytes - stderrBuf.length)),
      ]);
      stderrTruncated = true;
      return;
    }
    stderrBuf = Buffer.concat([stderrBuf, chunk]);
  });

  const exit = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.on("error", () => resolve({ code: null, signal: null }));
    child.on("close", (code, signal) => resolve({ code, signal }));
  });

  clearTimeout(timer);
  opts.signal?.removeEventListener("abort", abortHandler);

  return {
    exitCode: exit.code,
    signal: exit.signal,
    stdout: stdoutBuf.toString("utf8"),
    stderr: stderrBuf.toString("utf8"),
    cancelled,
    timedOut,
    durationMs: Date.now() - started,
  };
}
