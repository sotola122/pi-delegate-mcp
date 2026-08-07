#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DEST = join(ROOT, "assets", "delegate-pi");
const lockPath = join(DEST, "upstream-lock.json");

if (!existsSync(lockPath)) {
  console.error("upstream-lock.json missing");
  process.exit(1);
}

const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
  files: Record<string, string>;
};

let failed = 0;
for (const [rel, expected] of Object.entries(lock.files)) {
  const path = join(DEST, rel);
  if (!existsSync(path)) {
    console.error(`MISSING ${rel}`);
    failed++;
    continue;
  }
  const actual = `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
  if (actual !== expected) {
    console.error(`HASH MISMATCH ${rel}`);
    console.error(`  expected ${expected}`);
    console.error(`  actual   ${actual}`);
    failed++;
  }
}

if (failed) {
  console.error(`${failed} asset check(s) failed`);
  process.exit(1);
}
console.log(`OK: ${Object.keys(lock.files).length} assets verified`);
