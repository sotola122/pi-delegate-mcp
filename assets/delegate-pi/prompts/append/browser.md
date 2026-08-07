## Browser addendum

Use preflight values from the task block (`target_url`, `server`, `readiness`, `timeout_ms`, `teardown_owner`, `browser_channel`, `artifact_dir`, `visual_check`) — do not invent a URL or server command.

Fail closed per backend: `bash` → project-local Playwright only, launch with `browser_channel` (name package vs browser binary mismatches); `mcp` → configured adapter/tools only (no Playwright/Git Bash requirement). For `visual_check: true`, write screenshots under `artifact_dir`, then `read` them; record capture exit codes.

Add `## Browser artifacts` beneath the base result with:

- Commands run and exit status
- Outcome (pass/fail with evidence)
- Exact artifact paths (retained evidence under `artifact_dir`)

Clean disposable temps and processes you started; leave retained evidence for the parent handoff.
