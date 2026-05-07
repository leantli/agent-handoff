# Agent Handoff Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a minimal Python CLI for repo-local agent handoff files shared by Codex and Claude Code.

**Architecture:** Use a zero-dependency Python package. Keep filesystem behavior in `src/agent_handoff/core.py` and CLI parsing in `src/agent_handoff/cli.py`. Test with `unittest` and temporary directories.

**Tech Stack:** Python 3.10+, standard library, `unittest`, `argparse`, `pathlib`, `json`.

---

### Task 1: Project Skeleton

**Files:**
- Create: `pyproject.toml`
- Create: `README.md`
- Create: `LICENSE`
- Create: `src/agent_handoff/__init__.py`

**Steps:**

1. Add package metadata and a console script named `agent-handoff`.
2. Document the problem, install command, and MVP workflow in `README.md`.
3. Add an MIT license.

### Task 2: Core File Protocol

**Files:**
- Create: `src/agent_handoff/core.py`
- Test: `tests/test_core.py`

**Steps:**

1. Write tests for idempotent initialization.
2. Implement handoff directory creation and seed files.
3. Write tests for managed blocks in `AGENTS.md` and `CLAUDE.md`.
4. Implement managed-block insertion/update.

### Task 3: Capture and Restore

**Files:**
- Modify: `src/agent_handoff/core.py`
- Test: `tests/test_core.py`

**Steps:**

1. Write tests for appending timestamped capture notes.
2. Implement `capture_note`.
3. Write tests for restore packet ordering.
4. Implement `build_restore_packet`.

### Task 4: CLI

**Files:**
- Create: `src/agent_handoff/cli.py`
- Create: `src/agent_handoff/__main__.py`
- Test: `tests/test_cli.py`

**Steps:**

1. Write CLI tests for `init`, `capture`, `restore`, `status`, and `doctor`.
2. Implement `argparse` command handlers.
3. Return non-zero exit codes for invalid states.

### Task 5: Verification

**Files:**
- Modify docs as needed.

**Steps:**

1. Run `python -m unittest`.
2. Run `python -m agent_handoff --help`.
3. Initialize a sample temp repo and verify restore output.
