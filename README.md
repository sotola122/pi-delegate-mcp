# pi-delegate-mcp

Delegate bounded coding tasks from MCP clients (Cursor) to [Pi Coding Agent](https://github.com/earendil-works/pi) over stdio via the official SDK (`@earendil-works/pi-coding-agent`).

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

Then restart Cursor. The server registers as `pi-delegate` in `~/.cursor/mcp.json`.

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
| `delegate_review` | Read-only review / static hunt (async; optional `perspectives`) |
| `delegate_verify` | Build / test / lint (async) |
| `delegate_implement` | Implement in worktree (async; default patch) |
| `delegate_judge` | Judge with no-tools profile (async) |
| `delegate_manual` | Manual prompt under fixed profile (async) |
| `delegate_batch` | Multi-task parallel/sequential batch (max 32 tasks) |
| `delegate_roles` | Role-based pipeline (implement → verify → reviews; max 32 roles) |
| `get_run` / `cancel_run` | Poll / cancel a single run |
| `get_batch` / `cancel_batch` | Poll / cancel a batch |
| `smoke_test` | SDK connectivity / OAuth / provider check (async; poll `get_run`; `stdout` must be `OK`) |

Long-running tools — including `smoke_test` — return `{ status: "running", runId|batchId }` immediately. Poll with `get_run` / `get_batch` until complete (avoids Cursor MCP client timeouts). When sessions are enabled (default), the start payload also includes `sessionId`. Pass that id back on the next **same-role** call (`delegate_review` → `delegate_review`, etc.) so Pi can reuse the conversation cache. Cross-role reuse is rejected. `smoke_test` never persists a session.

Sessions live under `<workspace>/.pi-delegate/sessions/` (gitignored, `0700` / `0600`). Disable with `sessions.enabled: false`. Concurrent follow-ups on the same id fail with `session_busy`.

CLI (sync, for a terminal): `pi-delegate-mcp smoke [--mode planned-tuple|provider-auth]`. Resume a CLI run with `--session-id <uuid>`.

## Effort

`med` | `high` | `xhigh` | `max` → Pi thinking `medium` | `high` | `xhigh` | `max`.

When `model` / `effort` are omitted, per-profile defaults from `assets/delegate-pi/provider.yaml` apply:

| Profile | Default |
| --- | --- |
| `review` / `verify` / `no-tools` | `gpt-5.6-sol` / `xhigh` |
| `implement` | `gpt-5.6-luna` / `max` |

## Child skills

`childSkills` passes explicit skill paths (`SKILL.md` or a directory containing it) to the child agent. Ambient skill discovery stays off. Enabled by default.

Validated packages are passed through as Pi skill paths; the delegation policy allows reading those selected packages only (no copy, no path allowlist). Disable with `childSkills.enabled: false` if needed.

## Safety

- SDK tool allowlist is a **model tool allowlist, not an OS sandbox**. Policy extensions additionally block dangerous commands.
- Implement defaults to worktree + patch (does not modify your tree).
- Manual prompts cannot widen tools.
- Ambient skills / extensions / AGENTS.md are not loaded.
- No auto commit, push, PR, or deploy.
- Read-only attachments may include files under built-in trusted roots such as `~/.cursor/plans` (Cursor Plan Mode), `~/.cursor/skills`, `~/.agents/skills`, and staged `delegate-pi` / run artifact dirs. These are **not** writable workspaces; implement/apply still cannot write outside the resolved workspace / `allowedRoots`.

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
