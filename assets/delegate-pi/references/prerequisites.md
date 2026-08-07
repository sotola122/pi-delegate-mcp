# Prerequisites (OS-specific)

Authoritative list of modules required for multimodal backends. **Do not auto-install during delegation** (`install_policy: never`). When a required binary is missing or Pi fails with tool-not-found / browser-missing errors:

1. Identify the missing module from the failure message.
2. Open this file and the matching OS section.
3. Present the user with: missing item, why it is needed, exact install commands, and how to re-verify (`which` / `--version` / `LAUNCH_OK`).
4. Stop until the user installs (or switches backend / preprocesses outside Pi).

Probe with the **same shell Pi's `bash` tool will use** (Git Bash on Windows, `/bin/bash` on Linux/macOS).

## Matrix

| Need | Used by | Windows | Linux | macOS |
| --- | --- | --- | --- | --- |
| Git Bash (POSIX bash) | Pi `bash` tool; document/browser bash backends | **Required** if any bash backend | System bash | System bash |
| PowerShell 7 (recommended) | Parent UTF-8 stdin on Windows | Recommended over 5.1 | n/a | n/a |
| `pdfinfo` | document bash (`page_counter`) only | Poppler | `poppler-utils` | `poppler` (Homebrew) |
| `pdftotext` | document bash (`text_extractor`) | Poppler | `poppler-utils` | `poppler` |
| `pdftoppm` | document bash (`renderer`) | Poppler | `poppler-utils` | `poppler` |
| Project Playwright + matching browsers | browser bash | Project `node_modules` + browser install | same | same |
| System Chrome/Edge (optional) | browser via `browser_channel` only if task allows | Optional | Optional | Optional |
| `pi-pdf` extension (configured path) | document plugin | Absolute `extension_path` | same | same |
| `pi-mcp-adapter` (configured path) | browser mcp | Absolute `adapter_extension_path` | same | same |
| Playwright MCP server binary | browser mcp | Local argv in `mcp_config` (no `npx`) | same | same |
| `pi` CLI | all delegation | On PATH | On PATH | On PATH |

Vision-only (`@` / `read` images) needs no Poppler or Playwright.
Document **plugin** backend does not require Poppler unless that plugin itself depends on it.

## Verify probes

### Poppler (document bash)

```bash
command -v pdfinfo && pdfinfo -v
command -v pdftotext && pdftotext -v
command -v pdftoppm && pdftoppm -v
```

### Playwright (browser bash) — no npx

Failure must exit **nonzero**. Do not use `npx` (may contact the registry; violates `install_policy: never`). Launch with the run plan `browser_channel` (empty = bundled Chromium).

```bash
cd "$repo_root"
test -x node_modules/.bin/playwright || { echo "MISSING: local playwright"; exit 1; }
node_modules/.bin/playwright --version || { echo "MISSING: playwright not runnable"; exit 1; }
PW_CHANNEL="<browser_channel or empty>" node -e '
const { chromium } = require("playwright");
const opts = process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {};
chromium.launch(opts)
  .then(b => b.close())
  .then(() => console.log("LAUNCH_OK"))
  .catch(e => { console.error("MISSING: " + e.message); process.exit(1); });
' || exit 1
```

Require both exit code 0 and the `LAUNCH_OK` marker.

### Plugin / MCP (when configured)

Absolute paths must exist and be readable. `mcp_config` JSON: each server `argv[0]` resolves to a local executable — reject `npx`, `npm exec`, and bare package names. When configured, parent may run a one-shot startup probe (`pi --print --no-extensions -e … [--mcp-config …]`) before the real task; do not install anything during the probe.

Windows (PowerShell) for Git Bash presence:

```powershell
Test-Path "C:\Program Files\Git\bin\bash.exe"
```

---

## Windows

### Git Bash (required for bash backends)

Pi resolves `bash` to Git Bash. Without it, document/browser bash backends fail closed.

1. Install [Git for Windows](https://git-scm.com/download/win) (includes Git Bash).
2. Confirm: `C:\Program Files\Git\bin\bash.exe` exists.
3. Re-run probes **inside Git Bash**, not PowerShell.

### PowerShell 7 (recommended for parent)

UTF-8 stdin is unreliable on Windows PowerShell 5.1. Prefer [PowerShell 7](https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows), or use the explicit .NET UTF-8 recipe in `references/cli.md`.

### Poppler (`pdfinfo`, `pdftotext`, `pdftoppm`) — document bash only

Git for Windows may ship **only** `pdftotext` under `/mingw64/bin` — that is **not** enough. All three are required for the bash backend.

**Option A — Scoop**

```powershell
scoop install poppler
```

**Option B — winget / Chocolatey**

```powershell
winget install --id oschwartz10612.Poppler -e
# or: choco install poppler
```

Add Poppler's `Library\bin` (or package `bin`) to **User PATH**, then open a **new** Git Bash and re-probe.

**Option C — parent preprocess (no Poppler)**

Extract/render outside Pi, then run `review`/`no-tools` + `vision` with produced text/PNG. Or use a configured document **plugin** backend that does not need Poppler.

### Playwright (browser bash)

Fail closed: project-local install; no silent `npx` download.

Pick the package manager from the lockfile (`pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, else npm):

```powershell
# From the target repo root — examples
npm install --save-dev playwright
npx playwright install chromium
# or: pnpm add -D playwright; pnpm exec playwright install chromium
# or: yarn add -D playwright; yarn playwright install chromium
```

Browser binary version must match the Playwright package. Optional fallback only if task block sets `browser_channel` (e.g. `chrome`) and that browser is installed.

### Plugin / MCP

Install and configure outside this skill. Set absolute `extension_path` / `adapter_extension_path` / `mcp_config` with local argv. Present this section when those paths are missing or argv is a package runner.

---

## Linux

### Bash

Usually `/bin/bash`. If missing: install `bash` via the distro package manager.

### Poppler

```bash
# Debian / Ubuntu
sudo apt-get update && sudo apt-get install -y poppler-utils

# Fedora
sudo dnf install -y poppler-utils

# Arch
sudo pacman -S poppler
```

Verify: `command -v pdfinfo pdftotext pdftoppm`.

### Playwright

```bash
cd /path/to/repo
# lockfile chooses: npm | pnpm | yarn
npm install --save-dev playwright
npx playwright install chromium
# Linux OS deps may also be needed (ask user first):
npx playwright install-deps chromium
```

### Plugin / MCP

Same as Windows: absolute configured paths, local argv, no auto-install during delegation.

---

## macOS

### Bash

System `/bin/bash` or Homebrew bash is fine for Pi's bash tool.

### Poppler

```bash
brew install poppler
command -v pdfinfo pdftotext pdftoppm
```

### Playwright

```bash
cd /path/to/repo
npm install --save-dev playwright
npx playwright install chromium
```

### Plugin / MCP

Same absolute-path / local-argv rules as other OSes.

---

## Failure → user message template

```text
Missing: <binary or package>
Needed for: <document|browser> backend <bash|plugin|mcp>
OS: <windows|linux|macos>
Install:
  <paste commands from the matching section above>
Verify:
  <paste probe commands>
Until this is installed, delegation for this modality will fail closed.
Alternatives: <parent preprocess / other backend if any>
```
