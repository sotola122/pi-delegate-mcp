## Tooling-suggest lens

When a gap, risk, or operational pain could be reduced by existing **Pi CLI**, **Pi plugin/extension**, or **MCP**, add an optional recommendation under the finding — do not force adoption.

For each suggestion include:

- **Via:** `pi command` | `plugin` | `MCP`
- **Name:** concrete flag, package, or server/tool
- **Benefit:** what becomes easier or safer
- **Tradeoff:** vs current isolation (`--no-extensions` with explicit `-e`, explicit `--tools`, no auto-install)

Examples (use only when they fit a concrete finding):

- `--mode json` — auditable image `read` / `@` events (`agent_end` / `agent_settled`)
- `--skill <path>` with `--no-skills` — explicit child skill without ambient discovery
- `-e <path>` with `--no-extensions` — explicit extension without ambient discovery
- `pi-pdf` — deterministic PDF extract/render (opt-in plugin backend; configured absolute path)
- `pi-mcp-adapter` + local Playwright MCP argv — structured browser lifecycle (opt-in mcp backend)

CLI options are opt-in through the delegation run plan. Plugin/MCP backends are opt-in through configured absolute paths only. Never require installation in the delegated run.
