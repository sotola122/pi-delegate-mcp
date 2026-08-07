# Contributing

## Setup

```bash
bun install
bun run test
bun run typecheck
bun run build
```

## Assets

Upstream prompts/profiles live in `sotola122/agents` (`skills/delegate-pi`).

```bash
bun run sync:delegate-pi -- --source <path-to-delegate-pi> --ref <sha>
bun run check:delegate-pi-assets
```

Runtime never fetches from GitHub; only vendored `assets/delegate-pi` is used.

## Style

- TypeScript, ESM, Node 20+
- Core delegation must not import `@modelcontextprotocol/sdk` (keep SDK in `src/mcp/`)
- Prefer `spawn`/`execFile` with `shell: false`

## PRs

Include tests for provider resolution, argv construction, and security boundaries when touching those areas.
