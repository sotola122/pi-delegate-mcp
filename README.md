# pi-delegate-mcp

Delegate bounded coding tasks from MCP clients (Cursor) to [Pi Coding Agent](https://github.com/earendil-works/pi) over stdio via the official SDK (`@earendil-works/pi-coding-agent`).

## Requirements

- Node.js **22.19+**
- Existing `~/.pi/agent/auth.json` (Codex OAuth) is reused — **no separate Pi binary is required**

## Install

```bash
npm install -g pi-delegate-mcp
pi-delegate-mcp install cursor --scope global
pi-delegate-mcp doctor
pi-delegate-mcp auth status
```

Then restart Cursor. The server registers as `pi-delegate` in `~/.cursor/mcp.json`.

## Tools

| Tool | Purpose |
| --- | --- |
| `delegate_review` | Read-only review / static hunt (async; optional `perspectives`) |
| `delegate_verify` | Build / test / lint (async) |
| `delegate_implement` | Implement in worktree (async; default patch) |
| `delegate_judge` | Judge with no-tools profile (async) |
| `delegate_manual` | Manual prompt under fixed profile (async) |
| `delegate_batch` | Multi-task parallel/sequential batch |
| `delegate_roles` | Role-based pipeline (implement → verify → reviews) |
| `get_run` / `cancel_run` | Poll / cancel a single run |
| `get_batch` / `cancel_batch` | Poll / cancel a batch |
| `smoke_test` | SDK connectivity / OAuth / provider check (`stdout` must be `OK`) |

Long-running tools return `{ status: "running", runId|batchId }` immediately. Poll with `get_run` / `get_batch` until complete (avoids Cursor MCP client timeouts).

## Effort

`med` | `high` | `xhigh` | `max` → Pi thinking `medium` | `high` | `xhigh` | `max`.

When `model` / `effort` are omitted, per-profile defaults from `assets/delegate-pi/provider.yaml` apply:

| Profile | Default |
| --- | --- |
| `review` / `verify` / `no-tools` | `gpt-5.6-sol` / `xhigh` |
| `implement` | `gpt-5.6-luna` / `max` |

## Child skills

`childSkills` passes explicit skill paths (`SKILL.md` or a directory containing it) to the child agent. Ambient skill discovery stays off. Enabled by default.

Selected packages are **copied into the run directory** before execution; the child reads only that materialization (symlinks are not followed). Paths must resolve inside an allowed root, otherwise the run fails with `child_skill_forbidden`.

Default roots (when `allowedRoots` is empty): `~/.agents/skills`, `~/.cursor/skills`, `~/.cursor/skills-cursor`, `~/.claude/skills`, `~/.codex/skills`, plus the resolved workspace. An explicit `allowedRoots` list is authoritative and does **not** auto-append the workspace.

```jsonc
{
  "version": 2,
  "childSkills": {
    "enabled": true,
    "allowedRoots": ["~/.agents/skills"]
  }
}
```

`pi-delegate-mcp doctor` prints the effective state and roots.

## Safety

- SDK tool allowlist is a **model tool allowlist, not an OS sandbox**. Policy extensions additionally block dangerous commands.
- Implement defaults to worktree + patch (does not modify your tree).
- Manual prompts cannot widen tools.
- Ambient skills / extensions / AGENTS.md are not loaded.
- No auto commit, push, PR, or deploy.

## Config

`pi-delegate-mcp config path` prints the JSONC config location (version 2).

Auth:

```bash
pi-delegate-mcp auth status
pi-delegate-mcp auth login openai-codex
pi-delegate-mcp auth logout openai-codex
```

## Development

```bash
bun install
bun run test
bun run build
bun run check:delegate-pi-assets
```
