# agent-handoff

`agent-handoff` gives coding agents a small shared memory layer for new sessions,
fresh clones, git worktrees, and devices.

Long agent sessions accumulate useful context: project background, current task
state, decisions, preferences, and repeated corrections. Without a handoff
layer, the next session starts cold.

`agent-handoff` stores that context under `~/.agent-handoff` by default. It does
not modify `AGENTS.md`, `CLAUDE.md`, or other project instruction files.

## Install

```bash
npm install -g @leantli/agent-handoff
agent-handoff enable
```

`enable` creates local memory and installs the user skill that tells compatible
agents when to run `start`, `checkpoint`, and `learn`.

`agent-handoff status` also tells agents whether cross-device sync is configured.

## Daily Workflow

At the start of a coding session:

```bash
agent-handoff start
```

Before switching sessions, tasks, clones, or devices:

```bash
agent-handoff checkpoint --note "Current goal, completed work, open questions, next step."
```

When the user gives a stable preference or recurring correction:

```bash
agent-handoff learn --kind preference --note "Prefer small focused diffs."
```

For project-specific decisions or branch-specific context:

```bash
agent-handoff learn --scope project --kind decision --note "Use vault-first storage."
agent-handoff learn --scope branch --kind context --note "This branch is testing v0.5."
```

## Cross-Device Sync

Local cross-session memory works without any git repository. To share memory
across devices, create a private git repository for the vault, then run:

```bash
agent-handoff sync init git@github.com:you/agent-handoff-vault.git
agent-handoff sync
```

Run `agent-handoff sync init <same-git-url>` once on each device that should
share the vault. After that, run `agent-handoff sync` before starting on another
device and after writing useful checkpoints.

## How Projects Are Identified

By default, `agent-handoff` identifies the current project from the git `origin`
remote. Different clones, sibling checkouts, or worktrees of the same repository
map to the same project memory:

```text
https://github.com/p1cn/loop.git
git@github.com:p1cn/loop.git

github.com__p1cn__loop
```

If `.agent-handoff.yml` exists, its `project_id` is used as an override. The
tool does not require this file for normal git repositories.

## What Gets Stored

```text
~/.agent-handoff/
  config.json
  vault/
    global/
      preferences.md
      lessons.md
    projects/
      github.com__owner__repo/
        project.md
        decisions.md
        preferences.md
        branches/
          main.md
          feature-demo.md
        checkpoints/
          20260508T103000Z-laptop-codex-main.md
```

The layers are:

- `global`: preferences and lessons that apply across projects.
- `project`: durable background, decisions, and preferences for one repository.
- `branch`: task or branch-specific context.
- `checkpoints`: recent session handoff notes.

## Commands

```bash
agent-handoff enable      # create local memory and install the user skill
agent-handoff start       # print context for the current project and branch
agent-handoff checkpoint  # write a session checkpoint
agent-handoff learn       # store durable global/project/branch memory
agent-handoff sync init   # enable optional cross-device sync
agent-handoff sync        # pull/rebase and push the vault
agent-handoff status      # quick readiness and sync-state check
```

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```
