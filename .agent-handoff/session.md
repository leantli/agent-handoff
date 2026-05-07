# Session Handoff

Use this file to hand off the current working state between agent sessions and devices.

## Current Goal

- Prepare a first GitHub-ready prototype for `agent-handoff`.

## Latest Notes

- MVP scope is Codex + Claude Code, file protocol first, no required MCP.
- Implemented commands: `init`, `capture`, `restore`, `status`, `doctor`.
- Project has been self-initialized with `agent-handoff init`.
- Next useful work: improve capture ergonomics with stdin/file input, add
  release metadata, and decide whether `.agent-handoff/` should be committed by
  default or generated per consumer repo.

## Capture Log
- 2026-05-07T07:11:22.830218+00:00: Initial prototype implemented and repository handoff files populated.
