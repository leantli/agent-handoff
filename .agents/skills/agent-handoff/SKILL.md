---
name: agent-handoff
description: Use when starting, resuming, pausing, checkpointing, or transferring Codex/Claude Code work across sessions, clones, worktrees, or devices with the agent-handoff CLI.
---

# Agent Handoff

Use `agent-handoff` to restore and preserve coding-agent context.

## Start Of Session

When beginning work in a repository:

1. Run `agent-handoff status`.
2. If status says the repo is not ready, run `agent-handoff setup` if the vault is missing, then `agent-handoff init`.
3. Run `agent-handoff start`.
4. Read the returned packet before changing files.

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

## Before Pausing

Before ending a useful session, switching devices, or handing work to another
agent, write a concise checkpoint:

```bash
agent-handoff checkpoint --note "<current goal, completed work, open questions, next step>"
```

If vault sync is configured, run:

```bash
agent-handoff sync
```

If sync fails, keep the local checkpoint and report the error.

## Rules

- Do not store secrets, tokens, credentials, or private customer data in handoff notes.
- Keep checkpoints factual and concise.
- Do not use `learn` for temporary task state; use `checkpoint` instead.
- If `agent-handoff` is not installed, tell the user the CLI is missing and continue without pretending context was saved.
