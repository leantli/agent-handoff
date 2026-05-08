# Vault-First Agent Handoff Design

## Problem

The original repo-local design stores handoff state in `.agent-handoff/` inside
the working tree. That does not reliably solve the core user problem:

- A different worktree does not share the same files until git merge/pull.
- A fresh clone starts with stale or missing local session state.
- A second device cannot see the first device's learned preferences unless the
  project repo itself carries that private state.
- Public repositories should not receive personal agent tuning by default.

## Goal

Make long-lived agent context available across Codex and Claude Code sessions,
directories, clones, worktrees, and devices without storing personal memory in
the project repository by default.

## Core Model

`agent-handoff` uses a user-level vault as the source of truth:

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
          feature-name.md
        checkpoints/
          20260508T103000-device-codex.md
```

The project repository only receives bootstrap files:

```text
repo/
  .agent-handoff.yml
  AGENTS.md
  CLAUDE.md
```

`.agent-handoff.yml` contains non-private routing metadata such as
`project_id` and selected clients. `AGENTS.md` and `CLAUDE.md` tell agents to
sync when configured, run `agent-handoff start` before work, and run
`agent-handoff checkpoint` before pausing.

## Project Identity

Project identity is derived in this order:

1. `.agent-handoff.yml` `project_id`
2. `git remote get-url origin`
3. current directory name

Git remote URLs normalize to stable ids:

- `https://github.com/leantli/agent-handoff.git`
- `git@github.com:leantli/agent-handoff.git`

Both become:

```text
github.com__leantli__agent-handoff
```

This lets unrelated directories, fresh clones, and worktrees point at the same
vault project.

## Commands

### `setup`

Creates the user home and vault structure. Optional `--vault PATH` points at an
existing vault directory. Optional `--sync URL` uses a git remote for vault
sync. If the remote already has data, setup clones that remote instead of
creating a conflicting local vault.

### `install-skill`

Installs the packaged `agent-handoff` skill into the user's skills directory so
agents can discover the workflow across repositories.

### `init`

Bootstraps the current project. It writes `.agent-handoff.yml`, updates selected
client files such as `AGENTS.md` and `CLAUDE.md`, and creates the project
directory in the vault. It does not write `.agent-handoff/project.md` into the
business repo. Users can pass `--client codex` or `--client claude` to avoid
creating bootstrap files for clients they do not use.

### `start`

Builds a start packet from the vault:

1. global preferences
2. global lessons
3. project context
4. project preferences
5. project decisions
6. current branch context
7. recent checkpoints for the current branch

### `checkpoint`

Appends or writes a timestamped checkpoint into the vault. It accepts `--note`,
stdin, or `--file`. Checkpoints are session snapshots, not shared mutable state.

### `learn`

Writes durable memory into the vault. Global scope supports preferences and
lessons. Project scope supports preferences, decisions, lessons, and context.
Branch scope writes current branch context.

### `sync`

Commits pending vault changes, pulls/rebases from the configured remote, and
pushes the vault repository. New sessions should sync before `start`; completed
sessions should checkpoint and then sync.

## Worktree and Clone Behavior

Multiple worktrees and clones share global/project context through the same
project id, but branch state is isolated under `branches/<branch>.md`.

This avoids a single shared `session.md` being overwritten by concurrent agents.
The start packet composes stable context with current branch context and the
latest checkpoint snapshots for the current branch.

## Privacy Defaults

The vault is private user state. The project repo only receives bootstrap
metadata and instructions. Users can choose to commit `.agent-handoff.yml`,
`AGENTS.md`, and `CLAUDE.md`, but personal vault contents should live outside
public project repositories.
