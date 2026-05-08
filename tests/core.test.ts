import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  HandoffError,
  buildStartPacket,
  initRepo,
  installSkill,
  learn,
  normalizeProjectId,
  setupHome,
  syncVault,
  writeCheckpoint,
} from "../src/core.js";

const temps: string[] = [];

function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "agent-handoff-test-"));
  temps.push(path);
  return path;
}

afterEach(() => {
  for (const path of temps.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("vault setup", () => {
  test("setupHome creates config and global vault files", () => {
    const tmp = tempDir();
    const home = join(tmp, "home");

    const result = setupHome({ home });

    expect(result.home).toBe(resolve(home));
    expect(result.vault).toBe(resolve(home, "vault"));
    expect(existsSync(join(home, "config.json"))).toBe(true);
    expect(existsSync(join(home, "vault", "global", "preferences.md"))).toBe(true);
    expect(existsSync(join(home, "vault", "global", "lessons.md"))).toBe(true);

    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(config.version).toBe(2);
    expect(config.vault).toBe(resolve(home, "vault"));
  });

  test("setupHome with an existing sync remote clones remote vault", () => {
    const tmp = tempDir();
    const bare = join(tmp, "vault.git");
    const homeA = join(tmp, "home-a");
    const homeB = join(tmp, "home-b");
    execFileSync("git", ["init", "--bare", bare]);

    setupHome({ home: homeA, syncUrl: bare });
    learn("A device learned this.", { home: homeA, kind: "lesson" });
    syncVault({ home: homeA });

    setupHome({ home: homeB, syncUrl: bare });

    const lessons = readFileSync(join(homeB, "vault", "global", "lessons.md"), "utf8");
    expect(lessons).toContain("A device learned this.");
  });

  test("normalizeProjectId handles HTTPS and SSH remotes", () => {
    expect(normalizeProjectId("https://github.com/leantli/agent-handoff.git")).toBe(
      "github.com__leantli__agent-handoff",
    );
    expect(normalizeProjectId("git@github.com:leantli/agent-handoff.git")).toBe(
      "github.com__leantli__agent-handoff",
    );
  });

  test("installSkill writes user skill", () => {
    const tmp = tempDir();
    const skillsHome = join(tmp, "skills");

    const result = installSkill({ skillsHome });

    expect(existsSync(result.path)).toBe(true);
    expect(readFileSync(result.path, "utf8")).toContain("agent-handoff start");
    expect(result.path).toBe(resolve(skillsHome, "agent-handoff", "SKILL.md"));
  });
});

describe("init", () => {
  test("initRepo writes repo bootstrap and vault project, not repo memory", () => {
    const tmp = tempDir();
    const root = join(tmp, "repo");
    const home = join(tmp, "home");
    mkdirSync(root);

    const result = initRepo({
      root,
      home,
      projectId: "github.com__leantli__agent-handoff",
      branch: "main",
    });

    expect(result.projectId).toBe("github.com__leantli__agent-handoff");
    expect(existsSync(join(root, ".agent-handoff.yml"))).toBe(true);
    expect(existsSync(join(root, ".agent-handoff", "project.md"))).toBe(false);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("agent-handoff start");
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toContain("agent-handoff start");

    const project = join(home, "vault", "projects", "github.com__leantli__agent-handoff");
    expect(existsSync(join(project, "project.md"))).toBe(true);
    expect(existsSync(join(project, "decisions.md"))).toBe(true);
    expect(existsSync(join(project, "preferences.md"))).toBe(true);
    expect(existsSync(join(project, "branches", "main.md"))).toBe(true);
  });

  test("initRepo reuses project id from bootstrap across new directories", () => {
    const tmp = tempDir();
    const home = join(tmp, "home");
    const first = join(tmp, "first");
    const second = join(tmp, "second");
    mkdirSync(first);
    mkdirSync(second);

    initRepo({ root: first, home, projectId: "github.com__owner__repo" });
    writeFileSync(
      join(second, ".agent-handoff.yml"),
      "version: 2\nproject_id: github.com__owner__repo\n",
    );

    const result = initRepo({ root: second, home });

    expect(result.projectId).toBe("github.com__owner__repo");
    expect(existsSync(join(home, "vault", "projects", "github.com__owner__repo", "project.md"))).toBe(
      true,
    );
  });
});

describe("start, checkpoint, and learn", () => {
  test("buildStartPacket composes global, project, branch, and checkpoints", () => {
    const tmp = tempDir();
    const root = join(tmp, "repo");
    const home = join(tmp, "home");
    mkdirSync(root);
    initRepo({ root, home, projectId: "github.com__owner__repo", branch: "main" });
    const vaultProject = join(home, "vault", "projects", "github.com__owner__repo");
    writeFileSync(join(home, "vault", "global", "preferences.md"), "# Global Preferences\n\nUse concise answers.\n");
    writeFileSync(join(vaultProject, "project.md"), "# Project Context\n\nAPI repo.\n");
    writeFileSync(join(vaultProject, "branches", "main.md"), "# Branch Context\n\nWorking on vault design.\n");
    writeCheckpoint({
      root,
      note: "A session learned that repo-local memory is insufficient.",
      home,
      now: new Date("2026-05-08T10:30:00Z"),
      agent: "codex",
      branch: "main",
    });

    const packet = buildStartPacket({ root, home, branch: "main" });

    expect(packet).toContain("# Agent Handoff Start Packet");
    expect(packet.indexOf("Global Preferences")).toBeLessThan(packet.indexOf("Project Context"));
    expect(packet).toContain("Working on vault design.");
    expect(packet).toContain("repo-local memory is insufficient");
  });

  test("buildStartPacket filters recent checkpoints to current branch", () => {
    const tmp = tempDir();
    const root = join(tmp, "repo");
    const home = join(tmp, "home");
    mkdirSync(root);
    initRepo({ root, home, projectId: "github.com__owner__repo", branch: "main" });
    writeCheckpoint({
      root,
      note: "Main branch checkpoint.",
      home,
      now: new Date("2026-05-08T10:30:00Z"),
      agent: "codex",
      branch: "main",
    });
    writeCheckpoint({
      root,
      note: "Feature branch checkpoint.",
      home,
      now: new Date("2026-05-08T10:31:00Z"),
      agent: "codex",
      branch: "feature/demo",
    });

    const packet = buildStartPacket({ root, home, branch: "main" });

    expect(packet).toContain("Main branch checkpoint.");
    expect(packet).not.toContain("Feature branch checkpoint.");
  });

  test("writeCheckpoint writes timestamped file in vault project", () => {
    const tmp = tempDir();
    const root = join(tmp, "repo");
    const home = join(tmp, "home");
    mkdirSync(root);
    initRepo({ root, home, projectId: "github.com__owner__repo" });

    const result = writeCheckpoint({
      root,
      note: "Current task is green.",
      home,
      now: new Date("2026-05-08T12:00:00Z"),
      device: "laptop",
      agent: "claude",
      branch: "feature/demo",
    });

    expect(result.projectId).toBe("github.com__owner__repo");
    expect(result.branch).toBe("feature/demo");
    expect(existsSync(result.path)).toBe(true);
    expect(readFileSync(result.path, "utf8")).toContain("Current task is green.");
    expect(readFileSync(result.path, "utf8")).toContain("branch: feature/demo");
  });

  test("writeCheckpoint rejects likely secret notes", () => {
    const tmp = tempDir();
    const root = join(tmp, "repo");
    const home = join(tmp, "home");
    mkdirSync(root);
    initRepo({ root, home, projectId: "github.com__owner__repo" });

    expect(() =>
      writeCheckpoint({ root, note: "OPENAI_API_KEY=sk-secret", home }),
    ).toThrow(HandoffError);
  });

  test("learn appends global preferences and lessons", () => {
    const tmp = tempDir();
    const home = join(tmp, "home");
    setupHome({ home });

    const pref = learn("Prefer TDD for behavior changes.", { home, kind: "preference" });
    const lesson = learn("Repo-local memory does not cross clones.", { home, kind: "lesson" });

    expect(readFileSync(pref.path, "utf8")).toContain("Prefer TDD");
    expect(readFileSync(lesson.path, "utf8")).toContain("Repo-local memory");
  });

  test("learn rejects likely secret notes", () => {
    const tmp = tempDir();
    const home = join(tmp, "home");
    setupHome({ home });

    expect(() => learn("password=hunter2", { home, kind: "lesson" })).toThrow(HandoffError);
  });

  test("learn can write project and branch scoped memory", () => {
    const tmp = tempDir();
    const root = join(tmp, "repo");
    const home = join(tmp, "home");
    mkdirSync(root);
    initRepo({ root, home, projectId: "github.com__owner__repo", branch: "main" });

    const project = learn("Use vault-first architecture.", {
      home,
      root,
      scope: "project",
      kind: "decision",
    });
    const branch = learn("Main is preparing v0.3.", {
      home,
      root,
      scope: "branch",
      kind: "context",
      branch: "main",
    });

    expect(readFileSync(project.path, "utf8")).toContain("vault-first");
    expect(readFileSync(branch.path, "utf8")).toContain("v0.3");
  });
});

