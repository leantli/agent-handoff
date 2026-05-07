# Project Context

`agent-handoff` is a zero-dependency Python CLI that stores repo-local
handoff context for CLI coding agents.

The core user problem is loss of accumulated agent context when switching
devices or starting a new Codex/Claude Code session.

Important paths:

- `src/agent_handoff/core.py`: file protocol, managed instruction blocks,
  capture, restore, status, and doctor behavior.
- `src/agent_handoff/cli.py`: `argparse` command handlers.
- `tests/`: `unittest` coverage for core and CLI flows.
- `docs/plans/`: design and implementation notes.

Verification command:

```bash
python -m unittest discover -s tests -v
```
