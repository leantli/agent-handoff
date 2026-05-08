# TypeScript Port Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the Python implementation with a clean TypeScript npm CLI while preserving v0.3 behavior.

**Architecture:** Keep the current core/CLI split. Implement vault behavior in `src/core.ts`, CLI parsing in `src/cli.ts`, and package the skill markdown from `resources/`.

**Tech Stack:** TypeScript, Node 18+, Commander, Vitest, npm package scripts.

---

### Task 1: Create TS Package Skeleton

**Files:**
- Modify: `package.json`
- Add: `tsconfig.json`
- Add: `vitest.config.ts`
- Modify: `.gitignore`

**Steps:**
1. Replace the temporary package metadata with `@leantli/agent-handoff`.
2. Add scripts for `build`, `test`, and `typecheck`.
3. Ignore `node_modules`, `coverage`, and `dist`.

### Task 2: Port Tests First

**Files:**
- Add: `tests/core.test.ts`
- Add: `tests/cli.test.ts`
- Delete later: `tests/test_core.py`
- Delete later: `tests/test_cli.py`

**Steps:**
1. Write Vitest equivalents for the Python behavior tests.
2. Run `npm test` and confirm the tests fail because the TS implementation is missing.

### Task 3: Implement Core

**Files:**
- Add: `src/core.ts`
- Add: `src/index.ts`
- Add: `resources/agent-handoff.SKILL.md`

**Steps:**
1. Implement setup, init, start, checkpoint, learn, sync, status, and doctor.
2. Keep vault and bootstrap formats compatible with Python v0.3.
3. Run `npm test` after each major behavior group.

### Task 4: Implement CLI

**Files:**
- Add: `src/cli.ts`
- Add: `src/bin.ts`

**Steps:**
1. Wire Commander commands to core functions.
2. Preserve command names, flags, and user-facing output.
3. Verify `node dist/bin.js --help` after build.

### Task 5: Remove Python Project

**Files:**
- Delete: `pyproject.toml`
- Delete: `src/agent_handoff/**`
- Delete: `tests/test_core.py`
- Delete: `tests/test_cli.py`

**Steps:**
1. Remove Python packaging and tests.
2. Keep docs and handoff bootstrap files.

### Task 6: Update Docs and Verify

**Files:**
- Modify: `README.md`
- Modify: `.agents/skills/agent-handoff/SKILL.md`

**Steps:**
1. Update install instructions to npm.
2. Run `npm install`, `npm run typecheck`, `npm test`, and `npm run build`.
3. Run built CLI smoke commands.
4. Commit and push.

