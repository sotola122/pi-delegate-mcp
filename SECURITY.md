# Security Policy

## Reporting

Please open a private security advisory on GitHub or email the maintainer. Do not file public issues for exploitable vulnerabilities.

## Hard rules (this package)

- Pi runs in-process via `@earendil-works/pi-coding-agent` (no external Pi binary).
- Bash subprocesses use a sanitized environment (secrets / `PI_*` not forwarded by default).
- MCP inputs cannot inject arbitrary tool allowlists; policy extensions block dangerous commands.
- Manual prompts cannot widen permission profiles.
- Ambient skills, extensions, prompt templates, and AGENTS.md are not loaded.
- Artifacts use restrictive permissions (`0700` / `0600`).
- Assembled prompts are not stored by default.
- Secrets are redacted from returned output.

## Sandbox note

SDK tool allowlists are a **model tool allowlist, not an OS sandbox**. `verify` and `implement` profiles can write to the filesystem via bash/edit tools. Prefer worktree isolation and patch delivery.
