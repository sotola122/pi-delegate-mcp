# Multimodal reference (shared)

Leading word: **multimodal**. Parent materializes this text into the prompt when any modality is active.

## Core rules

- Pass images with `@path` or `read`. Supported formats come from the task block `image_formats` field. Convert BMP to PNG first.
- PDF bytes are not vision input. Document paths arrive as `task_input_paths`; extract or render first.
- Preserve the selected base output contract; modality appends add evidence sections only.
- Do not put secrets, API keys, auth cookies, or `.env` contents in prompts or artifacts.
- Missing OS modules (Poppler, Playwright, Git Bash, plugin/MCP paths): name the missing item exactly and stop. Installation is the parent's responsibility — do not invent install commands.

## Profile × modality

Modalities validate the chosen profile (`upgrade_policy: never`). The parent already verified backend compatibility and the effective tool allowlist before launch. Do not request tools outside the allowlist you were given.

## Provider / model

The parent resolved `--provider`, `--model`, and `--thinking` before launch. Do not switch models mid-run.

## Vision evidence

Authoritative completion criteria for visual judgment. Distinguish **run inputs** from **generated outputs**.

**Run inputs** (images supplied before launch via `@` in `cli_attachments`):

- Path exists with nonzero size, and
- Delivery proven by the initial `@` attachment in the run (visible in the JSON event log when `--mode json`)

**Generated outputs** (screenshots / PDF page renders produced during this run):

- Path is under this run's `artifact_dir` from the task block (paths outside it are invalid as generated evidence), and
- File exists with nonzero size, and
- Capture command exit code is recorded as 0 in the reply, and
- JSON event log shows a **successful** image delivery result for that path (a `read` that returned image content — not merely a tool-call attempt or a failed read)

Do not copy pre-existing fixtures into `artifact_dir` and treat them as fresh captures.

**Retained evidence** stays on disk until parent handoff. **Disposable temps** may be cleaned after the run.

## Output addenda

Named sections sit beneath base headings: `# Review Result`, `# Verify Result`, `# Implement Result`, `# Judgment Result`.
