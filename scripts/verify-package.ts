#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const distCli = join(ROOT, "dist", "cli.js");
const assets = join(ROOT, "assets", "delegate-pi");

const errors: string[] = [];

if (!existsSync(distCli)) {
  errors.push("dist/cli.js missing — run build first");
} else {
  const content = readFileSync(distCli, "utf8");
  if (!content.startsWith("#!")) {
    errors.push("dist/cli.js missing shebang");
  }
}

if (!existsSync(join(assets, "profiles.yaml"))) {
  errors.push("assets/delegate-pi/profiles.yaml missing");
}
if (!existsSync(join(assets, "provider.yaml"))) {
  errors.push("assets/delegate-pi/provider.yaml missing");
}
if (!existsSync(join(assets, "upstream-lock.json"))) {
  errors.push("assets/delegate-pi/upstream-lock.json missing");
}

// Package size soft limit: 50MB unpacked assets+dist estimate
function dirSize(dir: string): number {
  let total = 0;
  if (!existsSync(dir)) return 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    total += st.isDirectory() ? dirSize(p) : st.size;
  }
  return total;
}

const size = dirSize(join(ROOT, "dist")) + dirSize(assets);
const limit = 50 * 1024 * 1024;
if (size > limit) {
  errors.push(`Package contents too large: ${size} > ${limit}`);
}

if (errors.length) {
  for (const e of errors) console.error(e);
  process.exit(1);
}
console.log("verify-package: OK");
