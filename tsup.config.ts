import { defineConfig } from "tsup";
import { writeFileSync, readFileSync, chmodSync } from "node:fs";

export default defineConfig({
  entry: {
    cli: "src/cli/index.ts",
    index: "src/index.ts",
  },
  format: ["esm"],
  target: "node22",
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  external: ["@earendil-works/pi-coding-agent"],
  async onSuccess() {
    const cliPath = "dist/cli.js";
    const content = readFileSync(cliPath, "utf8");
    if (!content.startsWith("#!")) {
      writeFileSync(cliPath, `#!/usr/bin/env node\n${content}`);
    }
    chmodSync(cliPath, 0o755);
  },
});
