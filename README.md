# pi-delegate-mcp

Delegate bounded coding tasks from MCP clients (Cursor) to [Pi Coding Agent](https://github.com/earendil-works/pi) over stdio via the official SDK (`@earendil-works/pi-coding-agent`).

The MCP surface follows the Codex-style subagent tools (`spawn` / `wait` / `list` / `read` / `send` / `interrupt`). Child settings come from agent templates under `~/.cursor/pi-delegate/`, not from review/implement **roles**.

**Breaking change:** `delegate_review`, `delegate_verify`, `delegate_implement`, `delegate_judge`, `delegate_manual`, `delegate_batch`, `delegate_roles`, `get_run`, `get_batch`, `cancel_run`, `cancel_batch`, and MCP `smoke_test` are removed. Use `spawn_agent` plus `wait_agent` (or `wait_all_agents`). CLI `pi-delegate-mcp smoke` remains.

## Requirements

- Node.js **22.19+**
- Existing `~/.pi/agent/auth.json` (Codex OAuth) is reused — **no separate Pi binary is required**
- A GitHub token with `read:packages` (GitHub Packages install)

## Install

Point only the `@sotola122` scope at GitHub Packages (do not set a global `--registry`):

```ini
# ~/.npmrc
@sotola122:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=<GITHUB_TOKEN with read:packages>
```

```bash
npm install -g @sotola122/pi-delegate-mcp
pi-delegate-mcp install cursor --scope global
pi-delegate-mcp doctor
pi-delegate-mcp auth status
```

Then restart Cursor. The server registers as `pi-delegate` in `~/.cursor/mcp.json`. `install cursor` seeds `~/.cursor/pi-delegate/` (AGENTS.md, config.toml, empty `agents/`) and does not overwrite files that already exist.

## Update

```bash
pi-delegate-mcp update              # npm install -g @sotola122/pi-delegate-mcp@latest
pi-delegate-mcp update --check      # compare installed vs registry latest
pi-delegate-mcp update 0.2.1        # pin a version
```

Does not modify `~/.cursor/mcp.json`. Restart Cursor afterward so the MCP server reloads.

## Tools

| Tool | Purpose |
| --- | --- |
| `spawn_agent` | Start a Pi subagent. Returns immediately `{name,status:"running"}`. |
| `wait_agent` | Wait briefly for one agent. Still running → compact status + `wait` seconds. |
| `wait_all_agents` | Same short wait until targeted agents are terminal. |
| `list_agents` | List agents in this MCP process / workspace (`name` + `status`). |
| `read_agent_response` | Latest final text only (no intermediate tool calls). |
| `send_message` | Steer a running agent (queued next turn) or start another turn when settled. |
| `interrupt_agent` | Abort the current turn. The session remains for `send_message`. |

`spawn_agent` inputs: `task_name` and `message` (required); optional `prompt`, `skills`, `agent_type`, `model`, `provider`, `effort`, `workspace`. Settings resolve per key: spawn args → `agents/*.toml` → `config.toml` `[agents]` → app defaults. **`tools` has no role default** — the template or `[agents]` must list them, or spawn fails. The parent cannot pass a tool allowlist.

Cursor MCP clients time out on long blocking calls, so `wait_*` never wait forever. Default budget is `limits.waitBudgetMs` (1500ms). Poll again using the returned `wait` seconds.

Responses are minified JSON with short keys (`name`, `status`, `text`, `wait`). Final text is head-truncated; the full artifact path is in `full` when truncated.

Identity is `task_name`. `send_message` reuses that session. Parallel work is multiple `spawn_agent` calls plus `wait_all_agents`.

CLI (sync, for a terminal): `pi-delegate-mcp run --message <text> [--agent-type <name>] [--prompt …] [--skill …]`. Resume with `--session-id <uuid>`. Connectivity check: `pi-delegate-mcp smoke [--mode planned-tuple|provider-auth]`.

Sessions live under `<workspace>/.pi-delegate/sessions/` (gitignored, `0700` / `0600`). Disable with `sessions.enabled: false`. Concurrent follow-ups on the same id fail with `session_busy`.

## Agent home (Codex-format templates)

Layout (`agents.home`, default `~/.cursor/pi-delegate`):

- `config.toml` — `[agents]` defaults (provider / model / reasoning / tools / skills)
- `AGENTS.md` — always-on child context. `AGENTS.override.md` wins if present. Repository `AGENTS.md` is **not** auto-loaded
- `agents/*.toml` — named agent types (`agent_type` is the TOML `name` or file stem)

```toml
name = "reviewer"
description = "Focused read-only review"
provider = "openai-codex"
model = "gpt-5.6-sol"
model_reasoning_effort = "xhigh"
tools = ["read", "grep", "find", "ls"]
developer_instructions = """
Return concise findings with file paths.
"""

[[skills.config]]
path = "~/.agents/skills/code-review"
enabled = true
```

Allowed `tools`: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`. Unknown names are rejected. An empty list is no-tools. `bash` / `edit` / `write` take the existing writable workspace lock. Work is **in-place** (no default worktree). `sandbox_mode` and `mcp_servers` in TOML are ignored.

## Effort

`med` | `high` | `xhigh` | `max` → Pi thinking `medium` | `high` | `xhigh` | `max`.

When spawn omits `model` / `provider` / `effort`, the selected agent TOML then `[agents]` then app defaults (`pi.provider`, `pi.defaultModel`) apply. TOML may use `model_reasoning_effort`, `thinking`, or `reasoning`.

## Child skills

`spawn_agent.skills` (paths or names under `~/.cursor/skills` / `~/.agents/skills`) are **added** to skills declared on the template. Ambient Pi skill discovery stays off. Disable with `childSkills.enabled: false`.

Validated packages are passed through as Pi skill paths; the delegation policy allows reading those selected packages only.

## Safety

- SDK tool allowlist is a **model tool allowlist, not an OS sandbox**. Policy extensions additionally block dangerous commands.
- Child tools come from templates / `[agents]`, not from MCP arguments.
- Default execution is in-place. Writable tools take the workspace lock.
- Ambient Pi skills / extensions / prompt templates / repo `AGENTS.md` are not loaded. Home `AGENTS.md` is injected on purpose.
- No auto commit, push, PR, or deploy.
- Read-only attachments may include files under built-in trusted roots such as `~/.cursor/plans` (Cursor Plan Mode), `~/.cursor/skills`, `~/.agents/skills`, and staged `delegate-pi` / run artifact dirs. These are **not** writable workspaces.

## Config

`pi-delegate-mcp config path` prints the JSONC config location (version 3). `profiles` / `manual` keys are ignored if still present.

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
