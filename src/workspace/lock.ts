import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { stateDir } from "../config/paths.js";

export interface LockHandle {
  key: string;
  path: string;
  release: () => void;
}

const STALE_MS = 2 * 60 * 60 * 1000;

function lockDir(): string {
  const d = join(stateDir(), "locks");
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

function lockPath(key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(lockDir(), `${safe}.lock`);
}

export async function acquireLock(
  key: string,
  opts?: { timeoutMs?: number; staleMs?: number },
): Promise<LockHandle> {
  const path = lockPath(key);
  const timeoutMs = opts?.timeoutMs ?? 120_000;
  const staleMs = opts?.staleMs ?? STALE_MS;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as {
          pid: number;
          at: number;
        };
        if (Date.now() - raw.at > staleMs) {
          unlinkSync(path);
        } else {
          await new Promise((r) => setTimeout(r, 100));
          continue;
        }
      } catch {
        try {
          unlinkSync(path);
        } catch {
          // continue
        }
      }
    }
    try {
      writeFileSync(
        path,
        JSON.stringify({ pid: process.pid, at: Date.now(), key }) + "\n",
        { flag: "wx", mode: 0o600 },
      );
      return {
        key,
        path,
        release: () => {
          try {
            unlinkSync(path);
          } catch {
            // ignore
          }
        },
      };
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`Timed out acquiring lock: ${key}`);
}

export function clearAllLocks(): void {
  const d = lockDir();
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true, mode: 0o700 });
}
