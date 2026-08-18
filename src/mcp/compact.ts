import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { redactSecrets } from "../artifacts/redact.js";

export const COMPACT_MAX_BYTES = 4096;
export const COMPACT_MAX_LINES = 48;

export function compactJson(value: unknown): string {
  return redactSecrets(JSON.stringify(value));
}

export function truncateHead(
  text: string,
  maxBytes = COMPACT_MAX_BYTES,
  maxLines = COMPACT_MAX_LINES,
): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  let truncated = false;
  let sliced = text;
  if (lines.length > maxLines) {
    sliced = lines.slice(0, maxLines).join("\n");
    truncated = true;
  }
  if (Buffer.byteLength(sliced, "utf8") > maxBytes) {
    let lo = 0;
    let hi = sliced.length;
    let best = "";
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const cand = sliced.slice(0, mid);
      if (Buffer.byteLength(cand, "utf8") <= maxBytes) {
        best = cand;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    sliced = best;
    truncated = true;
  }
  return { text: sliced, truncated };
}

export function writeFullOutput(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { mode: 0o600 });
}

export function compactTextField(
  text: string,
  fullPath?: string,
): { text: string; full?: string } {
  const { text: sliced, truncated } = truncateHead(text);
  if (!truncated) return { text: sliced };
  if (fullPath) writeFullOutput(fullPath, text);
  return { text: sliced, ...(fullPath ? { full: fullPath } : {}) };
}
