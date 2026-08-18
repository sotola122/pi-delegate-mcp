# Security Policy

## Reporting

Please open a private security advisory on GitHub or email the maintainer. Do not file public issues for exploitable vulnerabilities.

## Hard rules (this package)

- Pi runs in-process via `@earendil-works/pi-coding-agent` (no external Pi binary).
- Bash subprocesses use a sanitized environment (secrets / `PI_*` not forwarded by default; only a narrow `GIT_*` allowlist plus explicit `shellEnvironment.passThrough`).
- MCP inputs cannot inject a child tool allowlist. Tools come from `~/.cursor/pi-delegate` templates / `[agents]`; unknown tool names are rejected. Policy extensions still block dangerous commands (including `git -C … push` style invocations).
- `read` / `edit` / `write` paths are canonicalized (`realpath`) before workspace / secret checks to reduce symlink escape.
- Ambient Pi skills, extensions, and prompt templates are not loaded. Repository `AGENTS.md` is not auto-loaded. Home `~/.cursor/pi-delegate/AGENTS.md` (or `AGENTS.override.md`) is injected as child context.
- Explicit `skills` on spawn or in TOML must resolve to a `SKILL.md` package; those package roots are readable without widening workspace roots.
- Default execution is in-place. `bash` / `edit` / `write` take the existing writable workspace lock. Worktree isolation is not the default.
- Artifacts use restrictive permissions (`0700` / `0600`).
- Assembled prompts are not stored by default.
- Secrets are redacted from returned output.
- Persistent Pi sessions are stored under the destination workspace at `.pi-delegate/sessions/<sessionId>/` (directory `0700`, files `0600`, a `*` gitignore in the sessions root). Session ids must be UUIDs; resolved paths must stay under the sessions root. Symlink escapes are rejected.

## Sandbox note

SDK tool allowlists are a **model tool allowlist, not an OS sandbox**. The `bash` tool can still reach the ambient filesystem and network; policy denylists and fingerprint checks are defense-in-depth, not a jail. Prefer read-only tool lists in agent templates unless the task must write.
