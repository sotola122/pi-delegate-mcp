# Pi CLI reference (delegate-pi)

Single source for path passing, quoting, and argument assembly. Parent shell differs; child `bash` is always POSIX.

## Path rules

- Resolve to **absolute paths** in the parent before passing to Pi.
- Verify each attachment exists and is **nonempty** (empty files are silently skipped).
- `@path` resolves relative to Pi's cwd (repo root or worktree). Pi expands `~` and normalizes macOS filename variants (NFD, narrow no-break space, curly quotes).
- Images attach as vision input; text files wrap as `<file name="absolute-path">…</file>`.
- Missing file → Pi exits 1. Always preflight in the parent.
- Use `@` only for `cli_attachments` (images, diffs, deliberate text). Put PDF and other filesystem inputs in the task block as `task_input_paths`.

## Parent shell quoting

**PowerShell** (prefer PowerShell 7; Windows PowerShell 5.1 needs the explicit UTF-8 recipe below)

```powershell
# Attachments — quote every @ (bare @path is splat)
pi ... '@C:\path with spaces\file.png'

# Child skills
pi ... --skill 'C:\path\to\skill-dir'

# Comma-separated flags — MUST be one quoted string each.
# Unquoted `a,b,c` is a PowerShell array; argv becomes separate words and
# only the first name reaches --tools / --exclude-tools.
# WRONG:
pi --tools read,grep,find,ls --exclude-tools bash,edit,write
# RIGHT:
pi --tools 'read,grep,find,ls' --exclude-tools 'bash,edit,write'

# Symptom of the WRONG form: child reports no tools, or only the first tool
# name, or hits a stop condition immediately. Fix is re-quote — not "tools broken".

# Assembled prompt — explicit UTF-8 (no BOM); do not use Get-Content -Raw alone
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($promptFile, $prompt, $utf8)
$OutputEncoding = $utf8
[System.IO.File]::ReadAllText($promptFile, [System.Text.Encoding]::UTF8) | pi ... <flags>

# Temp dir
$env:TEMP
```

**bash / zsh**

Comma-joined `--tools` / `--exclude-tools` values do not need quoting for the commas (quote only for spaces/glob).

```bash
pi ... "@$abs_path"
pi ... --skill "$skill_path"
pi ... --tools read,grep,find,ls --exclude-tools bash,edit,write
cat "$prompt_file" | pi ... <flags>
# Temp: ${TMPDIR:-/tmp}
```

## Child commands (POSIX bash)

Pi's `bash` tool runs POSIX bash: Git Bash on Windows, `/bin/bash` on Unix. Commands in prompts and task blocks must be POSIX.

On Windows without Git Bash: `document` (bash backend) and `browser` (bash backend) → **fail closed** — do not delegate. Show the prerequisites Windows → Git Bash install steps to the user.

Record paths in task blocks with forward slashes or Git-Bash `/c/Users/...` form.

## Built-in tools

Pi built-ins: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.

- `--tools a,b,c` — allowlist (required by delegate-pi)
- `--exclude-tools a,b` — denylist (optional belt on review)
- `--no-tools` — disable all (no-tools profile)

Loading a skill does not widen the tool allowlist.

## Skills and extensions

- `--no-skills` — block ambient skill discovery (always pass)
- `--skill <path>` — load explicit skill (repeatable; **works with `--no-skills`**)
- `--no-extensions` — block ambient extension discovery (always pass)
- `-e <path>` — load explicit extension (repeatable; **works with `--no-extensions`**)
- `--mcp-config <path>` — extension-registered flag; put **after** `-e <adapter>` so the adapter can register it
- `--offline` — optional; disables startup network operations only (`PI_OFFLINE=1`). Not a default. Does not isolate MCP/browser runtime networking. Local MCP `argv[0]` prevents package-runner auto-fetch only — not network isolation.

## Argument assembly (smoke and task)

Build from resolved run plan — same procedure for smoke and real tasks.

PowerShell: quote every comma-joined value (`--tools`, `--exclude-tools`) — see Parent shell quoting.

```
pi \
  --print \
  [--mode json] \
  --provider <resolved provider> \
  --model <resolved model> \
  --thinking <resolved thinking> \
  --no-session \
  --no-extensions \
  [-e <abs extension> ...] \
  [--mcp-config <abs> ...] \
  --no-skills \
  [--skill <abs> ...] \
  --no-prompt-templates \
  --no-context-files \
  --no-approve \
  [--offline] \
  <profile tools flag> \
  [--exclude-tools ...] \
  ['@cli_attachments' ...] \
  <prompt via stdin>
```

Smoke omits `--mode json`, attachments, and skills; uses `--no-tools` and inline prompt text.
