# Agent Handoff Design

## Goal

Build an open source CLI that lets Codex and Claude Code recover useful working context when a user switches devices or starts a new session.

## Scope

The MVP is file-protocol first. It does not require MCP, a daemon, a hosted service, browser extensions, or direct access to proprietary chat transcripts.

The project stores handoff state inside the repository so the state can travel through git or any file sync tool:

```text
.agent-handoff/
  project.md
  session.md
  decisions.md
  preferences.md
  index.json
```

It also adds small managed blocks to `AGENTS.md` and `CLAUDE.md` so Codex and Claude Code know to read the handoff files at the start of a new session and update them before pausing work.

## User Flows

### Initialize a repo

```bash
agent-handoff init
```

Creates the handoff directory, seed markdown files, metadata, and instruction blocks for Codex and Claude Code.

### Capture current context

```bash
agent-handoff capture --note "Implementing CLI parser; tests cover init."
```

Appends a timestamped note to `session.md` and refreshes `index.json`.

### Restore in a new session

```bash
agent-handoff restore
```

Prints an ordered restore packet that can be pasted into Codex or Claude Code. The packet points the agent to the project, session, decisions, and preferences files.

### Inspect readiness

```bash
agent-handoff status
agent-handoff doctor
```

Shows which files exist and whether the managed instructions are present.

## Architecture

The CLI is a small Python package with no runtime dependencies. It uses the standard library for argument parsing, file IO, JSON metadata, and timestamps.

The core module owns filesystem operations and pure formatting functions. The CLI module translates command-line arguments into core calls. Tests exercise the core behavior and selected CLI flows using temporary directories.

## Data Model

`index.json` contains:

```json
{
  "version": 1,
  "updated_at": "2026-05-07T12:00:00+08:00",
  "files": {
    "project": ".agent-handoff/project.md",
    "session": ".agent-handoff/session.md",
    "decisions": ".agent-handoff/decisions.md",
    "preferences": ".agent-handoff/preferences.md"
  }
}
```

Markdown files remain human-editable. The tool preserves user-written content and only appends capture notes or updates managed instruction blocks.

## Error Handling

Commands fail with clear messages when the current directory is not writable or handoff files are missing. `doctor` reports problems without mutating files. `init` is idempotent and never overwrites existing handoff markdown content.

## Future MCP Extension

MCP is intentionally outside v0.1. A future MCP server can wrap the same operations as tools:

- `handoff_capture`
- `handoff_restore`
- `handoff_status`
- `handoff_search`

The file protocol remains the source of truth.
