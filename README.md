# agent-handoff

`agent-handoff` is a small CLI for carrying coding-agent context across devices
and sessions.

It targets a narrow problem: a long Codex or Claude Code session often learns a
lot about a repository, the current task, and the user's preferences. When the
user switches machines or starts a fresh session, that context is easy to lose.

This project stores the handoff in repo-local files that can travel through git
or a normal file sync tool.

## Install

From a checkout:

```bash
pip install -e .
```

## Quick Start

Initialize a repository:

```bash
agent-handoff init
```

This creates:

```text
.agent-handoff/
  project.md
  session.md
  decisions.md
  preferences.md
  index.json
```

It also adds managed instruction blocks to `AGENTS.md` and `CLAUDE.md`, telling
Codex and Claude Code to read the handoff files before work and update
`.agent-handoff/session.md` before pausing or switching sessions.

Capture a note from the current session:

```bash
agent-handoff capture --note "Parser is implemented; CLI tests are next."
```

Restore context in a new session:

```bash
agent-handoff restore
```

Check readiness:

```bash
agent-handoff status
agent-handoff doctor
```

## Why Files First?

The MVP intentionally does not require MCP, a daemon, or a hosted memory service.
Files are easy to audit, edit, commit, sync, and recover. MCP can be added later
as an optional automation layer over the same file protocol.

## Intended Workflow

1. Run `agent-handoff init` once per repository.
2. Keep stable project background in `.agent-handoff/project.md`.
3. Keep current working state in `.agent-handoff/session.md`.
4. Keep durable decisions in `.agent-handoff/decisions.md`.
5. Keep user preferences and repeated corrections in `.agent-handoff/preferences.md`.
6. At the start of a new Codex or Claude Code session, run
   `agent-handoff restore` and paste the restore packet.

## Status

This is an early prototype. It solves the basic handoff loop, but it does not
try to read private chat transcripts or synchronize proprietary client state.

## Development

Run tests:

```bash
python -m unittest discover -s tests -v
```
