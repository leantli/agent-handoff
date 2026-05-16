---
name: agent-handoff
description: Use when starting, resuming, pausing, checkpointing, or transferring coding-agent work across sessions, clones, worktrees, or devices with the agent-handoff CLI.
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

## Cross-Device Sync Setup

Use a dedicated private vault repository for sync. Do not use a project code
repository as the vault. The vault can contain project context, preferences,
decisions, and handoff notes.

If the user asks you to set up cross-device sync, make sure the vault repository
they created is private, then run:

```bash
agent-handoff sync init <private-git-url>
agent-handoff sync
```

On another device, install and enable the CLI, then run `sync init` with the same
private git URL, `agent-handoff sync`, and `agent-handoff start`.

If `sync init` says the local vault has unsynced memory and the remote already
has data, keep the local files and report it. The user or agent should back up
or manually merge the local vault before joining that remote.

If sync fails because git reports a conflict or active operation, keep the local
files and report the conflict. The user or agent should resolve it inside the
vault, finish or abort the active git operation, then run `agent-handoff sync`
again.

## During Work

Treat `agent-handoff` as a shared handoff notebook, not a knowledge base.
Use `learn` for durable memory and `checkpoint` for temporary task state.
Before writing memory, choose one of three layers:

- Global: user preferences or recurring corrections that should apply across
  projects. Usually write these with `learn --kind preference` or
  `learn --kind lesson`.
- Project: durable repo background, conventions, decisions, and project-specific
  preferences. Usually write these with `learn --scope project`.
- Checkpoint: temporary task state for the next session. Use `checkpoint`, not
  `learn`.

Within project memory, use branch scope only for branch-specific context that
should survive a restart but should not apply to the whole project. Branch scope
only accepts `--kind context`; store decisions and preferences at project scope.
If in doubt between global and project, choose project. Do not store low-value
observations, one-off command output, secrets, tokens, credentials, or private
customer data.

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
- Prefer project or branch scope for project-specific facts instead of global memory.
- Do not modify repository instruction files as part of agent-handoff installation or use.
