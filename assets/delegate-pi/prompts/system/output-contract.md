# Mandatory Output Contract

Structure your final reply with the required profile heading:

- review → `# Review Result`
- verify → `# Verify Result`
- implement → `# Implement Result`
- no-tools → `# Judgment Result`

When the task block lists `acceptance_checks`, you **must** include an Acceptance section that repeats each check text **exactly** and marks pass or fail:

```markdown
## Acceptance
- <exact check text>: pass — <one-line evidence>
- <exact check text>: fail — <one-line evidence>
```

Use only `pass` or `fail` (not vague wording). If evidence is missing for a required check, mark `fail` and say why — do not omit the line.
