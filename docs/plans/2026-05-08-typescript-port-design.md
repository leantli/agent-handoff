# TypeScript Port Design

## Goal

Move `agent-handoff` from Python to TypeScript so users can install it with npm
while preserving the existing vault-first handoff workflow.

## Product Boundary

This migration does not add native Claude Code session sync, a daemon, or MCP.
It keeps the current product shape:

- user-level vault under `~/.agent-handoff`
- lightweight repo bootstrap via `.agent-handoff.yml`
- managed blocks in `AGENTS.md` and `CLAUDE.md`
- `start`, `checkpoint`, `learn`, and `sync` as the core workflow

## Package Shape

The npm package name should be scoped because `agent-handoff` is already taken
on npm:

```text
@leantli/agent-handoff
```

The installed binary remains:

```text
agent-handoff
```

## Architecture

The TypeScript implementation mirrors the Python split:

```text
src/core.ts      # vault, project id, checkpoint, learn, sync behavior
src/cli.ts       # commander-based CLI
src/index.ts     # public exports
resources/       # packaged skill markdown
tests/           # Vitest behavior tests
```

Use Node built-ins for filesystem, path, process, child process, and OS
interactions. Use `commander` for CLI parsing and `vitest` for tests. Avoid
introducing persistence abstractions or background services during the port.

## Compatibility

The TypeScript port must remain compatible with the Python v0.3 vault:

- `config.json` remains version `2`
- `.agent-handoff.yml` remains version `2`
- project ids normalize the same way
- checkpoint filenames and markdown front matter remain compatible
- scoped `learn` writes to the same files
- `install-skill` writes the same `SKILL.md` contents

## Error Handling

Expose a `HandoffError` for user-facing failures. CLI commands should print the
message to stderr and exit `1`, matching the Python CLI behavior.

## Testing

Port the existing Python tests to Vitest before implementing the TypeScript
core. Keep tests behavior-focused:

- setup creates the vault and config
- sync setup clones an existing remote vault
- init writes bootstrap files and vault project files
- start composes global/project/branch/checkpoint context
- checkpoint filters by branch and rejects likely secrets
- learn supports global/project/branch scopes
- CLI smoke flow matches current output

