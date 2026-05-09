# agent-handoff

`agent-handoff` gives coding agents a small shared memory layer for new
sessions, fresh clones, git worktrees, and devices.

Long agent sessions accumulate useful context: project background, current task
state, decisions, preferences, and repeated corrections. Without a handoff
layer, the next session starts cold.

`agent-handoff` stores that context under `~/.agent-handoff` by default. It does
not modify `AGENTS.md`, `CLAUDE.md`, or other project instruction files.

## Quick Start

```bash
npm install -g @leantli/agent-handoff
agent-handoff enable
```

GitHub direct install is also supported:

```bash
npm install -g github:leantli/agent-handoff
agent-handoff enable
```

`enable` does two things:

- creates local memory under `~/.agent-handoff`
- installs the packaged skill under `~/.agents/skills/agent-handoff`

Agents that load user-level skills can then discover when to run
`agent-handoff start`, `checkpoint`, `learn`, and `sync`. Existing agent
sessions may need to be restarted before they see the new skill.

The tool never edits `AGENTS.md`, `CLAUDE.md`, or project instruction files.

## Daily Workflow

Run project-aware commands from inside the real project repository, not from a
parent workspace that contains many repositories.

At the start of a coding session in a repo:

```bash
agent-handoff status
agent-handoff start
```

If `status` says sync is configured and you are switching devices or clones, run
`agent-handoff sync` before `start`.

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
agent-handoff learn --scope project --kind decision --note "Use TypeScript for the CLI."
agent-handoff learn --scope branch --kind context --note "This branch is testing v0.5."
```

## Cross-Device Sync

Local cross-session memory works immediately after `agent-handoff enable`. No
git repository is needed for the vault.

Cross-device sync is optional. The vault repository should be private because it
can contain project background, preferences, decisions, and handoff notes.

If GitHub CLI (`gh`) is installed and authenticated, let `agent-handoff` create
the private repository:

```bash
agent-handoff sync create you/agent-handoff-vault
agent-handoff sync
```

`sync create` always uses `gh repo create --private`. If the repository already
exists and is public, `agent-handoff` refuses to use it.

If you create the repository manually, make it private, then run:

```bash
agent-handoff sync init git@github.com:you/agent-handoff-vault.git
agent-handoff sync
```

Run `agent-handoff sync init <same-git-url>` once on each device that should
share the vault. After that, run `agent-handoff sync` before starting on another
device and after writing useful checkpoints.

By default the vault lives at `~/.agent-handoff/vault`. Use `--home` or
`--vault` when you need a different location. `agent-handoff sync` commits local
vault changes, pulls/rebases remote vault changes, then pushes the result.

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

In a workspace like this:

```text
~/workspace/
  app-one/
  app-two/
  app-three/
```

run `agent-handoff start`, `checkpoint`, and project or branch `learn` commands
from `~/workspace/app-one`, `~/workspace/app-two`, or whichever repository is
actually being edited. Global preferences can be written from anywhere.

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
agent-handoff sync create # create a private GitHub vault repo with gh
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
