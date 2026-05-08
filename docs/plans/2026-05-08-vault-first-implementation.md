# Vault-First Agent Handoff Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace repo-local handoff storage with a user-level vault that survives new sessions, fresh clones, worktrees, and device sync.

**Architecture:** Keep the package zero-dependency. Add vault configuration, project identity normalization, vault-backed restore packets, checkpoint/learn commands, and optional git sync. The project repo only receives bootstrap metadata and agent instructions.

**Tech Stack:** Python 3.10+, standard library, `unittest`, `argparse`, `pathlib`, `json`, `subprocess`.

---

### Task 1: Vault Model Tests

**Files:**
- Modify: `tests/test_core.py`

**Steps:**

1. Add tests for `setup_home` creating `config.json` and vault global files.
2. Add tests for `normalize_project_id` handling HTTPS and SSH GitHub remotes.
3. Add tests for `init_repo` writing `.agent-handoff.yml` and no longer creating repo-local `.agent-handoff/` markdown files.

### Task 2: Vault Model Implementation

**Files:**
- Modify: `src/agent_handoff/core.py`

**Steps:**

1. Implement `setup_home`.
2. Implement project id derivation from config, git remote, and directory fallback.
3. Update `init_repo` to create vault project files and repo bootstrap only.

### Task 3: Start, Checkpoint, Learn Tests

**Files:**
- Modify: `tests/test_core.py`

**Steps:**

1. Add tests for `build_start_packet` composing global, project, branch, and checkpoint content.
2. Add tests for `write_checkpoint` writing timestamped checkpoint files under vault project.
3. Add tests for `learn` appending global preferences or lessons.

### Task 4: Start, Checkpoint, Learn Implementation

**Files:**
- Modify: `src/agent_handoff/core.py`

**Steps:**

1. Implement vault restore packet generation.
2. Implement checkpoint creation with `--note`, stdin/file-ready core API.
3. Implement durable global learning.

### Task 5: CLI Tests and Implementation

**Files:**
- Modify: `tests/test_cli.py`
- Modify: `src/agent_handoff/cli.py`

**Steps:**

1. Replace `restore`/`capture` tests with `start`/`checkpoint` tests.
2. Add CLI tests for `setup`, `init`, `learn`, `status`, and `doctor`.
3. Update `argparse` commands and output.

### Task 6: Documentation and Bootstrap

**Files:**
- Modify: `README.md`
- Modify: `.agent-handoff/project.md`
- Modify: `.agent-handoff/session.md`
- Modify: `.agent-handoff/decisions.md`
- Modify: `.agent-handoff/preferences.md`

**Steps:**

1. Rewrite README around the real user workflow.
2. Move design rationale below usage.
3. Update this project's own handoff notes to describe v0.2.

### Task 7: Verification and Release Commit

**Files:**
- All changed files

**Steps:**

1. Run `python -m unittest discover -s tests -v`.
2. Run `env PYTHONPATH=src python -m agent_handoff --help`.
3. Run a temp-dir manual flow: `setup`, `init`, `checkpoint`, `start`.
4. Commit and push.
