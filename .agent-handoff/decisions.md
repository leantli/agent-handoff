# Decisions

- v0.1 uses repo-local files as the source of truth.
- MCP is not required for the MVP. A future MCP server can wrap the same core
  operations.
- The CLI does not try to read proprietary chat transcripts or private client
  state.
- Generated markdown files are human-editable. The tool should preserve user
  content and only manage explicit instruction blocks or append capture notes.
- Runtime dependencies are intentionally avoided for portability.
