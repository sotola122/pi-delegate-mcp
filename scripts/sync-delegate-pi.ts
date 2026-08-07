#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  rmSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DEST = join(ROOT, "assets", "delegate-pi");

function sha256File(path: string): string {
  const h = createHash("sha256");
  h.update(readFileSync(path));
  return `sha256:${h.digest("hex")}`;
}

function walkFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walkFiles(p, base));
    else if (name !== "upstream-lock.json") out.push(relative(base, p));
  }
  return out.sort();
}

function parseArgs(argv: string[]): { ref?: string; source?: string } {
  const out: { ref?: string; source?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--ref") out.ref = argv[++i];
    if (argv[i] === "--source") out.source = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const source =
  args.source ??
  join(process.env.HOME ?? "", ".agents", "skills", "delegate-pi");

if (!existsSync(source)) {
  console.error(`Source not found: ${source}`);
  console.error("Pass --source <path> to an upstream delegate-pi skill directory");
  process.exit(1);
}

mkdirSync(DEST, { recursive: true });

// Copy known assets (preserve local system prompts if present)
const preserve = new Set([
  "prompts/system/safety.md",
  "prompts/system/output-contract.md",
  "provider.yaml", // may have local effort ladder edits
]);

const preserved: Record<string, Buffer> = {};
for (const rel of preserve) {
  const p = join(DEST, rel);
  if (existsSync(p)) preserved[rel] = readFileSync(p);
}

for (const name of [
  "profiles.yaml",
  "provider.yaml",
  "modalities.yaml",
  "prompts",
  "references",
]) {
  const src = join(source, name);
  const dst = join(DEST, name);
  if (!existsSync(src)) continue;
  if (statSync(src).isDirectory()) {
    rmSync(dst, { recursive: true, force: true });
    cpSync(src, dst, { recursive: true });
  } else {
    cpSync(src, dst);
  }
}

mkdirSync(join(DEST, "prompts", "system"), { recursive: true });
for (const [rel, buf] of Object.entries(preserved)) {
  writeFileSync(join(DEST, rel), buf);
}

const files: Record<string, string> = {};
for (const rel of walkFiles(DEST)) {
  files[rel.replace(/\\/g, "/")] = sha256File(join(DEST, rel));
}

const lock = {
  repository: "sotola122/agents",
  path: "skills/delegate-pi",
  ref: args.ref ?? "local-sync",
  syncedAt: new Date().toISOString(),
  files,
};

writeFileSync(join(DEST, "upstream-lock.json"), JSON.stringify(lock, null, 2) + "\n");
console.log(`Synced from ${source}`);
console.log(`Locked ${Object.keys(files).length} files (ref=${lock.ref})`);
