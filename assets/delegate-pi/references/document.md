# Document modality

Use values from the task block: `page_counter`, `text_extractor`, `renderer` (bash), or plugin tool names; plus `max_document_pages`, `max_render_pages`, `page_range`, `render_policy`, `artifact_dir`.

Missing tools: name the missing binary or plugin tool exactly and stop. Installation is the parent's responsibility.

## Pipeline

1. Page count via the configured counter for this backend — fail if missing.
2. If total pages exceed `max_document_pages` and `page_range` does not already limit scope to an approved subset → fail (do not silently shrink).
3. Text extraction via the configured extractor — fail if missing; no auto-install.
4. Validate nonempty text for pages in `page_range`.
5. If extraction is empty or layout-critical **and** `render_policy` is `on_empty_or_layout` — render via the configured renderer into `artifact_dir`, at most `max_render_pages` pages from `page_range`; pass PNG via `read` or `@`. If `render_policy` is `never`, fail instead of rendering.
6. Cite pages under `## Document citations` beneath the base result.

Missing tools, empty extraction without allowed render, or limits exceeded without an approved `page_range` → report failure; do not infer content; do not auto-narrow scope.

Plugin backend: only when extension path and nonempty tool names are in the task block.
