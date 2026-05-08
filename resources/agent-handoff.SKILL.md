---
name: agent-handoff
description: Use when starting, resuming, pausing, checkpointing, or transferring Codex/Claude Code work across sessions, clones, worktrees, or devices with the agent-handoff CLI.
---

# Agent Handoff

Use `agent-handoff` to restore and preserve coding-agent context.

## Start Of Session

When beginning work in a repository:

1. Run `agent-handoff status`.
2. If status reports a problem, stop and report it. If the problem is that
   agent-handoff is not enabled, tell the user to run `agent-handoff enable`.
3. If status says `Sync: configured` and the user is switching devices or clones,
   run `agent-handoff sync`.
4. Run `agent-handoff start`.
5. Read the returned packet before changing files.

Do not edit `AGENTS.md`, `CLAUDE.md`, or other instruction files to install
agent-handoff.

## During Work

Use `learn` only for stable facts that should survive future sessions, clones,
worktrees, and devices.

For a durable user preference or recurring correction:

```bash
agent-handoff learn --kind preference --note "<stable preference>"
```

For a durable lesson about project or agent behavior:

```bash
agent-handoff learn --kind lesson --note "<stable lesson>"
```

For project-specific decisions:

```bash
agent-handoff learn --scope project --kind decision --note "<project decision>"
```

For branch-specific current context:

```bash
agent-handoff learn --scope branch --kind context --note "<branch context>"
```

## Before Pausing

Before ending a useful session, switching devices, or handing work to another
agent, write a concise checkpoint:

```bash
agent-handoff checkpoint --note "<current goal, completed work, open questions, next step>"
```

If sync is configured, run:

```bash
agent-handoff sync
```

If sync fails, keep the local checkpoint and report the error.

## Rules

- Do not store secrets, tokens, credentials, or private customer data in handoff notes.
- Keep checkpoints factual and concise.
- Do not use `learn` for temporary task state; use `checkpoint` instead.
- Prefer project or branch scope for project-specific facts instead of global memory.
- Do not modify repository instruction files as part of agent-handoff installation or use.
