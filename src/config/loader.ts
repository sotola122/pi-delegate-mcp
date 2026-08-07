import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { ConfigSchema, defaultConfig, type AppConfig } from "./schema.js";
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

export function loadConfig(path = configPath()): AppConfig {
  if (!existsSync(path)) return defaultConfig();
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(stripJsonc(raw)) as unknown;
  return ConfigSchema.parse(deepMerge(defaultConfig(), parsed));
}

export function parseYamlFile<T = unknown>(path: string): T {
  return parseYaml(readFileSync(path, "utf8")) as T;
}
