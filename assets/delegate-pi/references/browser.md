# Browser modality

Backend is in the task block (`bash` or `mcp`). Requirements below are **backend-specific**.

## Fail closed — bash backend

Use an already-installed project Playwright executable and browser binary matching the task block `browser_channel` (empty channel = bundled Chromium). No `npx` fetch, browser download, or package install unless the user authorized it outside this skill.

On missing Playwright/browser or Windows without Git Bash: name the missing item exactly and stop. Installation is the parent's responsibility.

Parent must have obtained `LAUNCH_OK` from the prerequisite probe before launch.

## Fail closed — mcp backend

Do **not** require project-local Playwright or Git Bash. Use only the configured adapter, `mcp_config` local server executable, and tool names from the task block. On missing adapter/config/tools: name the missing item and stop.

## Preflight (from task block)

Required fields:

- `target_url`
- `server` — `none`, or `{ owner, argv, cwd }` where `owner` is `parent` | `child` | `external`
- `readiness` — `{ kind, value }` where `kind` is `http_status` | `shell` | `log_line`
- `timeout_ms` — milliseconds
- `teardown_owner` — `parent` | `child` | `external`
- `browser_channel`
- `artifact_dir` — absolute
- `visual_check` — boolean

Do not invent a URL or server command. If `server.owner` is `child`, start `argv` from `cwd` yourself; if `parent` or `external`, assume the parent already started it (or it is external). Always tear down what you started before exit; parent tears down what it started unconditionally after the run.

## Evidence

Primary: DOM / console / network. For `visual_check: true`, write screenshots under `artifact_dir`, then `read` them. Satisfy Vision evidence rules for generated outputs.

Keep **retained evidence** until parent handoff; clean **disposable temps** and spawned processes after the run.

MCP backend: only when extension path, mcp config, and tool names are in the task block.
