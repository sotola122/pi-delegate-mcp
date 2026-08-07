import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { ConfigSchema, defaultConfig, migrateConfigV1, type AppConfig, type ConfigV1Input } from "./schema.js";
import { configPath } from "./paths.js";
import { deepMerge } from "./merge.js";

/** Strip line and block comments from JSONC (strings preserved). */
export function stripJsonc(input: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let escape = false;
  while (i < input.length) {
    const c = input[i]!;
    if (inString) {
      out += c;
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && input[i + 1] === "/") {
      i += 2;
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && input[i + 1] === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function normalizeLoadedConfig(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object") return parsed;
  const obj = parsed as Record<string, unknown>;
  if (
    obj.version === 1 ||
    (obj.environment && !obj.shellEnvironment) ||
    (obj.pi &&
      typeof obj.pi === "object" &&
      "executable" in (obj.pi as object) &&
      !("agentDir" in (obj.pi as object)) &&
      obj.version !== 2)
  ) {
    return migrateConfigV1(obj as ConfigV1Input);
  }
  return parsed;
}

export function loadConfig(path = configPath()): AppConfig {
  if (!existsSync(path)) return defaultConfig();
  const raw = readFileSync(path, "utf8");
  const parsed = normalizeLoadedConfig(JSON.parse(stripJsonc(raw)));
  return ConfigSchema.parse(deepMerge(defaultConfig(), parsed as object));
}

export function parseYamlFile<T = unknown>(path: string): T {
  return parseYaml(readFileSync(path, "utf8")) as T;
}
