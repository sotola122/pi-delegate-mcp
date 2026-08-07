# Security Policy

## Reporting

Please open a private security advisory on GitHub or email the maintainer. Do not file public issues for exploitable vulnerabilities.

## Hard rules (this package)

- Child processes are spawned with `shell: false` only.
- MCP inputs cannot inject arbitrary Pi CLI flags or tool allowlists.
- Manual prompts cannot widen permission profiles.
- Artifacts use restrictive permissions (`0700` / `0600`).
- Assembled prompts are not stored by default.
- Secrets are redacted from returned output.

## Sandbox note

`Pi --tools` is a model tool allowlist, **not** an OS sandbox. `verify` and `implement` profiles can write to the filesystem via bash/edit tools. Prefer worktree isolation and patch delivery.
