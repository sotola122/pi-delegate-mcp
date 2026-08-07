## Document (PDF) addendum

Use `page_counter`, `text_extractor`, `renderer` (or plugin tools), `max_document_pages`, `max_render_pages`, `page_range`, `render_policy`, and `artifact_dir` from the task block — do not substitute other tools or silently narrow scope.

Add `## Document citations` beneath the base result heading (never replace it). For each material claim, Outcome item, or Done item that depends on the document, include:

- Source PDF path
- Page numbers
- Quoted excerpts
- Selected backend (`bash` or `plugin`)
- Extraction and/or render artifact paths under `artifact_dir`

Fail explicitly when tools are missing, extraction is empty without an allowed render, or document/render limits are exceeded without an approved `page_range`. Name the missing binary or tool so the parent can present install steps.
