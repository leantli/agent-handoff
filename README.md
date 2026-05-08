# agent-handoff

`agent-handoff` gives Codex and Claude Code a shared memory handoff layer across
new sessions, fresh clones, git worktrees, and devices.

A long agent session often accumulates useful context: project background,
current task state, decisions, preferences, and repeated corrections. Without a
handoff layer, a new session or another device starts cold.

`agent-handoff` stores that context in a user-level vault, then lets any clone or
worktree of the same repository recover it by project identity.

```text
~/.agent-handoff/vault/        # private user memory
repo/.agent-handoff.yml        # lightweight project identity
repo/AGENTS.md                 # Codex bootstrap instruction
repo/CLAUDE.md                 # Claude Code bootstrap instruction
```

## Install

From npm:

```bash
npm install -g @leantli/agent-handoff
```

From a checkout:

```bash
npm install
npm run build
npm link
```

## Three-Minute Setup

Create your local vault once:

```bash
agent-handoff setup
agent-handoff install-skill
```

Optional: sync the vault through a private git repo so another device can share
the same handoff memory:

```bash
agent-handoff setup --sync git@github.com:you/agent-handoff-vault.git
```

Bootstrap each coding project once:

```bash
agent-handoff init
```

This writes:

```text
.agent-handoff.yml
AGENTS.md
CLAUDE.md
```

It does not write private memory into the project repository.

## Daily Workflow

At the start of a new Codex or Claude Code session:

```bash
agent-handoff sync     # only if vault sync is configured
agent-handoff start
```

Paste or let the agent read the start packet before it works.

When a useful session is about to end, or before switching devices:

```bash
agent-handoff checkpoint --note "Implemented vault storage; next step is README polish."
agent-handoff sync     # only if vault sync is configured
```

When the user corrects a stable preference or recurring rule:

```bash
agent-handoff learn --kind preference --note "Prefer TDD for behavior changes."
```

For project-specific decisions or branch-specific context:

```bash
agent-handoff learn --scope project --kind decision --note "Use vault-first storage."
agent-handoff learn --scope branch --kind context --note "Main is preparing v0.3."
```

When configured, `sync` commits pending vault changes and pushes them to the
private vault repository.

## Why This Solves Cross-Clone Context

`agent-handoff` identifies a project from `.agent-handoff.yml` or the git
`origin` remote. These all map to the same vault project:

```text
~/code/repo
~/tmp/repo
~/worktrees/repo-feature
another device's ~/projects/repo
```

For example, both remotes below normalize to the same project id:

```text
https://github.com/leantli/agent-handoff.git
git@github.com:leantli/agent-handoff.git

github.com__leantli__agent-handoff
```

That means A session can checkpoint context into the vault, and B session can
recover it from any clone or worktree that resolves to the same project id.

## What Gets Stored

The vault is private user state:

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

The project repository gets only bootstrap files:

```text
.agent-handoff.yml
AGENTS.md
CLAUDE.md
```

## Commands

```bash
agent-handoff setup       # create/configure the user vault
agent-handoff install-skill # install the agent workflow skill
agent-handoff init        # bootstrap the current repo
agent-handoff start       # print the context packet for a new session
agent-handoff checkpoint  # write a session checkpoint
agent-handoff learn       # write durable global/project/branch memory
agent-handoff sync        # git pull/rebase + push the vault
agent-handoff status      # quick readiness check
agent-handoff doctor      # detailed health check
```

## Agent Skill

This repo includes a Codex-compatible skill:

```text
.agents/skills/agent-handoff/SKILL.md
```

The skill tells an agent when to run `start`, `checkpoint`, `learn`, and `sync`.
Install it into your user skills directory to make the workflow available across
all repositories:

```bash
agent-handoff install-skill
```

The repo also keeps a copy at `.agents/skills/agent-handoff/SKILL.md` for
project-local use.

## Status

This is an early prototype. It does not read proprietary chat transcripts or
client-internal state. Agents must still call `start`, `checkpoint`, and `learn`
at the right moments, guided by `AGENTS.md` and `CLAUDE.md`.

## Development

Run tests:

```bash
npm test
```

Run type checking and build:

```bash
npm run typecheck
npm run build
```
