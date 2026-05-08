<!-- BEGIN AGENT-HANDOFF -->
Agent handoff is enabled for this repository.

At the start of a new Codex or Claude Code session, run:

```bash
agent-handoff start
```

Read the returned packet before making changes.

Before pausing work, switching devices, or ending a useful session, run:

```bash
agent-handoff checkpoint --note "<current goal, progress, open questions, next step>"
```

When the user corrects a stable preference or recurring rule, run `agent-handoff learn --kind preference --note "..."`.
<!-- END AGENT-HANDOFF -->
