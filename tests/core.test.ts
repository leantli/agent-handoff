import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  HandoffError,
  buildStartPacket,
  enableHandoff,
  enableSync,
  getStatus,
  installSkill,
  learn,
  normalizeProjectId,
  setupHome,
  syncVault,
  writeCheckpoint,
} from "../src/core.js";

const temps: string[] = [];
let oldHome: string | undefined;
let oldUserProfile: string | undefined;

function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "agent-handoff-test-"));
  temps.push(path);
  return path;
}

function withHome<T>(home: string, run: () => T): T {
  const oldHome = process.env.HOME;
  const oldUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return run();
  } finally {
    if (oldHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = oldHome;
    }
    if (oldUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = oldUserProfile;
    }
  }
}

function execGit(args: string[], options: { cwd?: string; encoding?: BufferEncoding } = {}): string {
  return execFileSync("git", args, {
    cwd: options.cwd,
    encoding: options.encoding ?? "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function expectRegisteredSkill(registrationDir: string, canonicalDir: string): void {
  expect(existsSync(join(registrationDir, "SKILL.md"))).toBe(true);
  expect(readFileSync(join(registrationDir, "SKILL.md"), "utf8")).toContain("agent-handoff start");
  if (process.platform !== "win32") {
    expect(lstatSync(registrationDir).isSymbolicLink()).toBe(true);
    expect(realpathSync(registrationDir)).toBe(realpathSync(canonicalDir));
  }
}

beforeEach(() => {
  oldHome = process.env.HOME;
  oldUserProfile = process.env.USERPROFILE;
  const fakeUserHome = tempDir();
  process.env.HOME = fakeUserHome;
  process.env.USERPROFILE = fakeUserHome;
});

afterEach(() => {
  if (oldHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = oldHome;
  }
  if (oldUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = oldUserProfile;
  }
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

  test("setupHome default home follows the current HOME at call time", () => {
    const fakeUserHome = join(tempDir(), "user-home");

    withHome(fakeUserHome, () => {
      const result = setupHome();

      expect(result.home).toBe(resolve(fakeUserHome, ".agent-handoff"));
      expect(existsSync(join(fakeUserHome, ".agent-handoff", "config.json"))).toBe(true);
    });
  });

  test("setupHome with an existing sync remote clones remote vault", () => {
    const tmp = tempDir();
    const bare = join(tmp, "vault.git");
    const homeA = join(tmp, "home-a");
    const homeB = join(tmp, "home-b");
    execGit(["init", "--bare", bare]);

    setupHome({ home: homeA, syncUrl: bare });
    learn("A device learned this.", { home: homeA, kind: "lesson" });
    syncVault({ home: homeA });

    setupHome({ home: homeB, syncUrl: bare });

    const lessons = readFileSync(join(homeB, "vault", "global", "lessons.md"), "utf8");
    expect(lessons).toContain("A device learned this.");
  });

  test("syncVault hides expected empty-remote pull noise on first sync", () => {
    const tmp = tempDir();
    const bare = join(tmp, "vault.git");
    const home = join(tmp, "home");
    execGit(["init", "--bare", bare]);

    setupHome({ home, syncUrl: bare });
    learn("First sync should be quiet about missing remote refs.", { home, kind: "lesson" });

    const output = syncVault({ home }).join("\n");

    expect(output).not.toContain("couldn't find remote ref");
    expect(output).not.toContain("could not find remote ref");
  });

  test("syncVault surfaces git conflicts for concurrent durable memory edits", () => {
    const tmp = tempDir();
    const bare = join(tmp, "vault.git");
    const homeA = join(tmp, "home-a");
    const homeB = join(tmp, "home-b");
    execGit(["init", "--bare", bare]);

    setupHome({ home: homeA, syncUrl: bare });
    learn("Base memory.", { home: homeA, kind: "lesson" });
    syncVault({ home: homeA });
    setupHome({ home: homeB, syncUrl: bare });

    learn("Device A memory.", { home: homeA, kind: "lesson" });
    syncVault({ home: homeA });
    learn("Device B concurrent memory.", { home: homeB, kind: "lesson" });

    const message = `sync conflict in ${join(homeB, "vault")}; resolve conflicts in that vault, finish or abort the active git operation, then run agent-handoff sync again`;
    expect(() => syncVault({ home: homeB })).toThrow(message);
    expect(() => syncVault({ home: homeB })).toThrow(message);
  });

  test("syncVault reports active rebase after conflicts are staged but not continued", () => {
    const tmp = tempDir();
    const bare = join(tmp, "vault.git");
    const homeA = join(tmp, "home-a");
    const homeB = join(tmp, "home-b");
    const vaultB = join(homeB, "vault");
    execGit(["init", "--bare", bare]);

    setupHome({ home: homeA, syncUrl: bare });
    learn("Base memory.", { home: homeA, kind: "lesson" });
    syncVault({ home: homeA });
    setupHome({ home: homeB, syncUrl: bare });

    learn("Device A memory.", { home: homeA, kind: "lesson" });
    syncVault({ home: homeA });
    learn("Device B concurrent memory.", { home: homeB, kind: "lesson" });

    const message = `sync conflict in ${vaultB}; resolve conflicts in that vault, finish or abort the active git operation, then run agent-handoff sync again`;
    expect(() => syncVault({ home: homeB })).toThrow(message);

    const lessons = join(vaultB, "global", "lessons.md");
    const resolved = readFileSync(lessons, "utf8")
      .replace(/^<<<<<<<.*\n/gm, "")
      .replace(/^=======\n/gm, "")
      .replace(/^>>>>>>>.*\n/gm, "");
    writeFileSync(lessons, resolved, "utf8");
    execGit(["add", "global/lessons.md"], { cwd: vaultB });

    expect(() => syncVault({ home: homeB })).toThrow(message);
  });

  test("enableSync replaces a fresh local seed vault with remote memory", () => {
    const tmp = tempDir();
    const bare = join(tmp, "vault.git");
    const homeA = join(tmp, "home-a");
    const homeB = join(tmp, "home-b");
    execGit(["init", "--bare", bare]);

    enableHandoff({ home: homeA, skillsHome: join(tmp, "skills-a") });
    learn("Remote memory should survive device setup order.", { home: homeA, kind: "lesson" });
    enableSync({ home: homeA, syncUrl: bare });
    syncVault({ home: homeA });

    enableHandoff({ home: homeB, skillsHome: join(tmp, "skills-b") });
    enableSync({ home: homeB, syncUrl: bare });

    const lessons = readFileSync(join(homeB, "vault", "global", "lessons.md"), "utf8");
    expect(lessons).toContain("Remote memory should survive");
  });

  test("status reports whether sync is configured", () => {
    const tmp = tempDir();
    const bare = join(tmp, "vault.git");
    const home = join(tmp, "home");
    execGit(["init", "--bare", bare]);

    enableHandoff({ home, skillsHome: join(tmp, "skills") });
    expect(getStatus({ home }).syncConfigured).toBe(false);
    expect(getStatus({ home }).syncUrl).toBeUndefined();

    enableSync({ home, syncUrl: bare });

    const status = getStatus({ home });
    expect(status.syncConfigured).toBe(true);
    expect(status.syncUrl).toBe(bare);
  });

  test("normalizeProjectId handles HTTPS and SSH remotes", () => {
    expect(normalizeProjectId("https://github.com/leantli/agent-handoff.git")).toBe(
      "github.com__leantli__agent-handoff",
    );
    expect(normalizeProjectId("git@github.com:leantli/agent-handoff.git")).toBe(
      "github.com__leantli__agent-handoff",
    );
  });

  test("installSkill writes the canonical skill and registers a user skill symlink", () => {
    const tmp = tempDir();
    const home = join(tmp, "home");
    const skillsHome = join(tmp, "skills");

    const result = installSkill({ home, skillsHome });

    const canonicalDir = join(home, "skills", "agent-handoff");
    const registrationDir = join(skillsHome, "agent-handoff");
    expect(existsSync(join(canonicalDir, "SKILL.md"))).toBe(true);
    expectRegisteredSkill(registrationDir, canonicalDir);
    expect(existsSync(result.path)).toBe(true);
    expect(readFileSync(result.path, "utf8")).toContain("agent-handoff start");
    expect(result.path).toBe(resolve(registrationDir, "SKILL.md"));
  });

  test("enableHandoff creates local memory and registers Codex and Claude Code skills to the same canonical skill", () => {
    const tmp = tempDir();
    const home = join(tmp, "home");
    const skillsHome = join(tmp, "skills");
    const claudeSkillsHome = join(tmp, "claude-skills");

    const result = enableHandoff({ home, skillsHome, claudeSkillsHome });

    expect(result.setup.home).toBe(resolve(home));
    expect(existsSync(join(home, "vault", "global", "preferences.md"))).toBe(true);
    const canonicalDir = join(home, "skills", "agent-handoff");
    expectRegisteredSkill(join(skillsHome, "agent-handoff"), canonicalDir);
    expectRegisteredSkill(join(claudeSkillsHome, "agent-handoff"), canonicalDir);
    expect(result.skills.map((skill) => skill.path)).toEqual([
      resolve(skillsHome, "agent-handoff", "SKILL.md"),
      resolve(claudeSkillsHome, "agent-handoff", "SKILL.md"),
    ]);
  });

  test("enableHandoff still installs the default Claude Code skill when only Codex skills home is overridden", () => {
    const tmp = tempDir();
    const fakeUserHome = join(tmp, "user-home");
    const home = join(tmp, "home");
    const skillsHome = join(tmp, "codex-skills");

    withHome(fakeUserHome, () => {
      const result = enableHandoff({ home, skillsHome });

      const claudeSkill = resolve(fakeUserHome, ".claude", "skills", "agent-handoff", "SKILL.md");
      expect(existsSync(join(skillsHome, "agent-handoff", "SKILL.md"))).toBe(true);
      expect(existsSync(claudeSkill)).toBe(true);
      expect(result.skills.map((skill) => skill.path)).toContain(claudeSkill);
    });
  });

  test("enableHandoff defaults Codex registration to the official ~/.agents skill root", () => {
    const tmp = tempDir();
    const fakeUserHome = join(tmp, "user-home");
    const home = join(tmp, "home");

    withHome(fakeUserHome, () => {
      const result = enableHandoff({ home });

      const codexSkill = resolve(fakeUserHome, ".agents", "skills", "agent-handoff", "SKILL.md");
      const legacyCodexSkill = resolve(fakeUserHome, ".codex", "skills", "agent-handoff", "SKILL.md");
      expect(result.skills.map((skill) => skill.path)).toContain(codexSkill);
      expect(existsSync(codexSkill)).toBe(true);
      expect(existsSync(legacyCodexSkill)).toBe(false);
    });
  });

  test("installSkill backs up an existing user skill directory before registering", () => {
    const tmp = tempDir();
    const home = join(tmp, "home");
    const skillsHome = join(tmp, "skills");
    const registrationDir = join(skillsHome, "agent-handoff");
    mkdirSync(registrationDir, { recursive: true });
    writeFileSync(join(registrationDir, "SKILL.md"), "---\nname: my-custom\n---\n# user skill\n");
    writeFileSync(join(registrationDir, "extra.md"), "user content");

    const result = installSkill({ home, skillsHome });

    expect(result.backupPath).toBeDefined();
    expect(readFileSync(join(result.backupPath!, "SKILL.md"), "utf8")).toContain("my-custom");
    expect(readFileSync(join(result.backupPath!, "extra.md"), "utf8")).toBe("user content");
    expect(readFileSync(result.path, "utf8")).toContain("agent-handoff start");
    if (process.platform !== "win32") {
      expect(lstatSync(registrationDir).isSymbolicLink()).toBe(true);
    }
  });

  test("installSkill backs up a previous plain-directory install before migrating to symlink", () => {
    const tmp = tempDir();
    const home = join(tmp, "home");
    const skillsHome = join(tmp, "skills");
    const registrationDir = join(skillsHome, "agent-handoff");
    mkdirSync(registrationDir, { recursive: true });
    writeFileSync(join(registrationDir, "SKILL.md"), "---\nname: agent-handoff\n---\n# old version\n");

    const result = installSkill({ home, skillsHome });

    expect(result.backupPath).toBeDefined();
    expect(readFileSync(join(result.backupPath!, "SKILL.md"), "utf8")).toContain("# old version");
    expect(readFileSync(result.path, "utf8")).toContain("agent-handoff start");
  });

  test("installSkill does not trust a managed-copy marker from another canonical path", () => {
    const tmp = tempDir();
    const home = join(tmp, "home");
    const skillsHome = join(tmp, "skills");
    const registrationDir = join(skillsHome, "agent-handoff");
    mkdirSync(registrationDir, { recursive: true });
    writeFileSync(join(registrationDir, "SKILL.md"), "---\nname: custom-agent-handoff\n---\n# custom\n");
    writeFileSync(
      join(registrationDir, ".agent-handoff-managed.json"),
      JSON.stringify({ managed_by: "agent-handoff", canonical_path: join(tmp, "other-home", "skills", "agent-handoff") }),
    );

    const result = installSkill({ home, skillsHome });

    expect(result.backupPath).toBeDefined();
    expect(readFileSync(join(result.backupPath!, "SKILL.md"), "utf8")).toContain("# custom");
    expect(readFileSync(result.path, "utf8")).toContain("agent-handoff start");
  });

  test("installSkill backs up a wrong symlink before registering the canonical skill", () => {
    if (process.platform === "win32") return;
    const tmp = tempDir();
    const home = join(tmp, "home");
    const skillsHome = join(tmp, "skills");
    const registrationDir = join(skillsHome, "agent-handoff");
    const otherDir = join(tmp, "other-skill");
    mkdirSync(dirname(registrationDir), { recursive: true });
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(otherDir, "SKILL.md"), "---\nname: other\n---\n");
    symlinkSync(otherDir, registrationDir, "dir");

    const result = installSkill({ home, skillsHome });

    expect(result.backupPath).toBeDefined();
    expect(lstatSync(result.backupPath!).isSymbolicLink()).toBe(true);
    expect(realpathSync(result.backupPath!)).toBe(realpathSync(otherDir));
    expect(realpathSync(registrationDir)).toBe(realpathSync(join(home, "skills", "agent-handoff")));
  });

  test("installSkill is idempotent after registration is already correct", () => {
    const tmp = tempDir();
    const home = join(tmp, "home");
    const skillsHome = join(tmp, "skills");

    const first = installSkill({ home, skillsHome });
    const second = installSkill({ home, skillsHome });

    expect(first.updated).toBe(true);
    expect(second.updated).toBe(false);
    expect(second.backupPath).toBeUndefined();
  });
});

describe("project identity", () => {
  test("start auto-creates project memory from git remote without editing instruction files", () => {
    const tmp = tempDir();
    const root = join(tmp, "repo");
    const home = join(tmp, "home");
    mkdirSync(root);
    execGit(["init"], { cwd: root });
    execGit(["remote", "add", "origin", "git@github.com:leantli/agent-handoff.git"], {
      cwd: root,
    });
    writeFileSync(join(root, "AGENTS.md"), "# Existing Instructions\n\nDo not overwrite this.\n");

    enableHandoff({ home, skillsHome: join(tmp, "skills") });
    const packet = buildStartPacket({
      root,
      home,
      branch: "main",
    });

    expect(packet).toContain("Project: `github.com__leantli__agent-handoff`");
    expect(existsSync(join(root, ".agent-handoff.yml"))).toBe(false);
    expect(existsSync(join(root, ".agent-handoff", "project.md"))).toBe(false);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(
      "# Existing Instructions\n\nDo not overwrite this.\n",
    );
    expect(existsSync(join(root, "CLAUDE.md"))).toBe(false);

    const project = join(home, "vault", "projects", "github.com__leantli__agent-handoff");
    expect(existsSync(join(project, "project.md"))).toBe(true);
    expect(existsSync(join(project, "decisions.md"))).toBe(true);
    expect(existsSync(join(project, "preferences.md"))).toBe(true);
    expect(existsSync(join(project, "branches", "main.md"))).toBe(true);
  });

  test("start can reuse optional project id from bootstrap when present", () => {
    const tmp = tempDir();
    const home = join(tmp, "home");
    const root = join(tmp, "repo");
    mkdirSync(root);
    enableHandoff({ home, skillsHome: join(tmp, "skills") });
    writeFileSync(join(root, ".agent-handoff.yml"), "version: 2\nproject_id: github.com__owner__repo\n");

    const packet = buildStartPacket({ root, home });

    expect(packet).toContain("Project: `github.com__owner__repo`");
    expect(existsSync(join(home, "vault", "projects", "github.com__owner__repo", "project.md"))).toBe(
      true,
    );
  });

  test("bootstrap inline comments do not become part of the project id", () => {
    const tmp = tempDir();
    const home = join(tmp, "home");
    const root = join(tmp, "repo");
    mkdirSync(root);
    enableHandoff({ home, skillsHome: join(tmp, "skills"), claudeSkillsHome: join(tmp, "claude-skills") });
    writeFileSync(join(root, ".agent-handoff.yml"), "version: 2\nproject_id: github.com__owner__repo # local alias\n");

    const packet = buildStartPacket({ root, home });

    expect(packet).toContain("Project: `github.com__owner__repo`");
    expect(packet).not.toContain("github.com__owner__repo__local_alias");
  });
});

describe("start, checkpoint, and learn", () => {
  test("buildStartPacket composes global, project, branch, and checkpoints", () => {
    const tmp = tempDir();
    const root = join(tmp, "repo");
    const home = join(tmp, "home");
    mkdirSync(root);
    enableHandoff({ home, skillsHome: join(tmp, "skills") });
    writeFileSync(join(root, ".agent-handoff.yml"), "version: 2\nproject_id: github.com__owner__repo\n");
    buildStartPacket({ root, home, branch: "main" });
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
    enableHandoff({ home, skillsHome: join(tmp, "skills") });
    writeFileSync(join(root, ".agent-handoff.yml"), "version: 2\nproject_id: github.com__owner__repo\n");
    buildStartPacket({ root, home, branch: "main" });
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
    enableHandoff({ home, skillsHome: join(tmp, "skills") });
    writeFileSync(join(root, ".agent-handoff.yml"), "version: 2\nproject_id: github.com__owner__repo\n");
    buildStartPacket({ root, home });

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
    enableHandoff({ home, skillsHome: join(tmp, "skills") });
    writeFileSync(join(root, ".agent-handoff.yml"), "version: 2\nproject_id: github.com__owner__repo\n");
    buildStartPacket({ root, home });

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
    enableHandoff({ home, skillsHome: join(tmp, "skills") });
    writeFileSync(join(root, ".agent-handoff.yml"), "version: 2\nproject_id: github.com__owner__repo\n");
    buildStartPacket({ root, home, branch: "main" });

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

  test("branch scoped memory does not collide for branch names with the same sanitized form", () => {
    const tmp = tempDir();
    const root = join(tmp, "repo");
    const home = join(tmp, "home");
    mkdirSync(root);
    enableHandoff({ home, skillsHome: join(tmp, "skills"), claudeSkillsHome: join(tmp, "claude-skills") });
    writeFileSync(join(root, ".agent-handoff.yml"), "version: 2\nproject_id: github.com__owner__repo\n");

    const slashBranch = learn("Slash branch context.", {
      home,
      root,
      scope: "branch",
      kind: "context",
      branch: "feature/foo",
    });
    const underscoreBranch = learn("Underscore branch context.", {
      home,
      root,
      scope: "branch",
      kind: "context",
      branch: "feature__foo",
    });

    expect(slashBranch.path).not.toBe(underscoreBranch.path);
    expect(readFileSync(slashBranch.path, "utf8")).toContain("Slash branch context.");
    expect(readFileSync(slashBranch.path, "utf8")).not.toContain("Underscore branch context.");
    expect(readFileSync(underscoreBranch.path, "utf8")).toContain("Underscore branch context.");
  });

  test("branch scoped memory reuses legacy branch files when their header matches the branch", () => {
    const tmp = tempDir();
    const root = join(tmp, "repo");
    const home = join(tmp, "home");
    mkdirSync(root);
    enableHandoff({ home, skillsHome: join(tmp, "skills"), claudeSkillsHome: join(tmp, "claude-skills") });
    writeFileSync(join(root, ".agent-handoff.yml"), "version: 2\nproject_id: github.com__owner__repo\n");
    buildStartPacket({ root, home, branch: "main" });
    const project = join(home, "vault", "projects", "github.com__owner__repo");
    const legacyBranchFile = join(project, "branches", "feature__foo.md");
    writeFileSync(legacyBranchFile, "# Branch Context: feature/foo\n\nLegacy context.\n");

    const packet = buildStartPacket({ root, home, branch: "feature/foo" });
    const learned = learn("Append to legacy file.", {
      home,
      root,
      scope: "branch",
      kind: "context",
      branch: "feature/foo",
    });

    expect(packet).toContain("Legacy context.");
    expect(learned.path).toBe(legacyBranchFile);
    expect(readFileSync(legacyBranchFile, "utf8")).toContain("Append to legacy file.");
  });

  test("branch scoped memory avoids legacy branch files when their header belongs to another branch", () => {
    const tmp = tempDir();
    const root = join(tmp, "repo");
    const home = join(tmp, "home");
    mkdirSync(root);
    enableHandoff({ home, skillsHome: join(tmp, "skills"), claudeSkillsHome: join(tmp, "claude-skills") });
    writeFileSync(join(root, ".agent-handoff.yml"), "version: 2\nproject_id: github.com__owner__repo\n");
    buildStartPacket({ root, home, branch: "main" });
    const project = join(home, "vault", "projects", "github.com__owner__repo");
    const legacyBranchFile = join(project, "branches", "feature__foo.md");
    writeFileSync(legacyBranchFile, "# Branch Context: feature/foo\n\nLegacy slash context.\n");

    const learned = learn("Underscore branch context.", {
      home,
      root,
      scope: "branch",
      kind: "context",
      branch: "feature__foo",
    });

    expect(learned.path).not.toBe(legacyBranchFile);
    expect(readFileSync(legacyBranchFile, "utf8")).not.toContain("Underscore branch context.");
    expect(readFileSync(learned.path, "utf8")).toContain("Underscore branch context.");
  });

  test("enableSync configures cross-device sync separately from local enable", () => {
    const tmp = tempDir();
    const bare = join(tmp, "vault.git");
    const home = join(tmp, "home");
    execGit(["init", "--bare", bare]);

    const result = enableSync({ home, syncUrl: bare });

    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(result.vault).toBe(resolve(home, "vault"));
    expect(config.sync_url).toBe(bare);
    expect(existsSync(join(home, "vault", ".git"))).toBe(true);
  });

  test("enableSync rejects an unreachable sync remote without marking sync configured", () => {
    const tmp = tempDir();
    const home = join(tmp, "home");
    const missing = join(tmp, "missing.git");

    expect(() => enableSync({ home, syncUrl: missing })).toThrow(HandoffError);
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });

  test("enableSync rejects option-like sync URLs before running git", () => {
    const tmp = tempDir();
    const home = join(tmp, "home");

    expect(() => enableSync({ home, syncUrl: "--upload-pack=/tmp/not-git" })).toThrow(
      "sync remote URL must not start with '-'",
    );
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });

  test("enableSync rejects git remote-helper URLs before running git", () => {
    const tmp = tempDir();
    const home = join(tmp, "home");

    expect(() => enableSync({ home, syncUrl: "foo::bar" })).toThrow(
      "sync remote URL uses an unsupported git remote-helper syntax",
    );
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });

  test("status reports an invalid config file without throwing", () => {
    const tmp = tempDir();
    const home = join(tmp, "home");
    mkdirSync(home);
    writeFileSync(join(home, "config.json"), "{not-json");

    const status = getStatus({ home });

    expect(status.initialized).toBe(false);
    expect(status.problems.join("\n")).toContain("config.json is invalid");
  });

  test("status reports a malformed config object without using undefined paths", () => {
    const tmp = tempDir();
    const home = join(tmp, "home");
    mkdirSync(home);
    writeFileSync(join(home, "config.json"), "{}");

    const status = getStatus({ home });

    expect(status.initialized).toBe(false);
    expect(status.problems.join("\n")).toContain("config.json is invalid: vault must be a non-empty string");
    expect(status.problems.join("\n")).not.toContain("undefined");
  });

  test("start fails clearly when config vault has the wrong type", () => {
    const tmp = tempDir();
    const home = join(tmp, "home");
    const root = join(tmp, "repo");
    mkdirSync(home);
    mkdirSync(root);
    writeFileSync(join(home, "config.json"), JSON.stringify({ version: 2, vault: 123 }));

    expect(() => buildStartPacket({ root, home })).toThrow("config.json is invalid: vault must be a non-empty string");
  });

  test("setupHome fails with HandoffError when existing config is invalid", () => {
    const tmp = tempDir();
    const home = join(tmp, "home");
    mkdirSync(home);
    writeFileSync(join(home, "config.json"), "{not-json");

    expect(() => setupHome({ home })).toThrow(HandoffError);
  });

  test("status reports sync misconfigured when sync_url exists but vault is not a git repo", () => {
    const tmp = tempDir();
    const home = join(tmp, "home");
    const vault = join(home, "vault");
    mkdirSync(vault, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({ version: 2, vault, sync_url: join(tmp, "vault.git") }));

    const status = getStatus({ home });

    expect(status.initialized).toBe(false);
    expect(status.syncConfigured).toBe(false);
    expect(status.problems.join("\n")).toContain(`sync is configured for ${join(tmp, "vault.git")}`);
    expect(status.problems.join("\n")).toContain(`run agent-handoff sync init ${join(tmp, "vault.git")}`);
  });

  test("status redacts credentials from sync URLs in problem messages", () => {
    const tmp = tempDir();
    const home = join(tmp, "home");
    const vault = join(home, "vault");
    mkdirSync(vault, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        version: 2,
        vault,
        sync_url: "https://user:secret-token@example.com/owner/vault.git",
      }),
    );

    const status = getStatus({ home });
    const message = status.problems.join("\n");

    expect(message).toContain("https://<redacted>@example.com/owner/vault.git");
    expect(message).not.toContain("secret-token");
    expect(message).not.toContain("user:secret-token");
  });

  test("sync errors redact credential-bearing sync URLs", () => {
    const tmp = tempDir();
    const home = join(tmp, "home");
    const vault = join(home, "vault");
    const expected = "https://x-access-token:ghp_expected@github.com/owner/expected.git";
    const actual = "https://x-access-token:ghp_actual@github.com/owner/actual.git";
    mkdirSync(vault, { recursive: true });
    execGit(["init"], { cwd: vault });
    execGit(["remote", "add", "origin", actual], { cwd: vault });
    writeFileSync(join(home, "config.json"), JSON.stringify({ version: 2, vault, sync_url: expected }));

    expect(() => syncVault({ home })).toThrow("https://<redacted>@github.com/owner/expected.git");
    expect(() => syncVault({ home })).toThrow("https://<redacted>@github.com/owner/actual.git");
    expect(() => syncVault({ home })).not.toThrow("ghp_expected");
    expect(() => syncVault({ home })).not.toThrow("ghp_actual");
  });

  test("status reports sync misconfigured when vault origin is missing", () => {
    const tmp = tempDir();
    const home = join(tmp, "home");
    const vault = join(home, "vault");
    mkdirSync(vault, { recursive: true });
    execGit(["init"], { cwd: vault });
    writeFileSync(join(home, "config.json"), JSON.stringify({ version: 2, vault, sync_url: join(tmp, "vault.git") }));

    const status = getStatus({ home });

    expect(status.initialized).toBe(false);
    expect(status.syncConfigured).toBe(false);
    expect(status.problems.join("\n")).toContain(`sync is configured for ${join(tmp, "vault.git")}`);
    expect(status.problems.join("\n")).toContain(`run agent-handoff sync init ${join(tmp, "vault.git")}`);
  });

  test("status reports sync misconfigured when vault origin differs from config", () => {
    const tmp = tempDir();
    const home = join(tmp, "home");
    const vault = join(home, "vault");
    const expected = join(tmp, "expected.git");
    const actual = join(tmp, "actual.git");
    mkdirSync(vault, { recursive: true });
    execGit(["init"], { cwd: vault });
    execGit(["remote", "add", "origin", actual], { cwd: vault });
    writeFileSync(join(home, "config.json"), JSON.stringify({ version: 2, vault, sync_url: expected }));

    const status = getStatus({ home });

    expect(status.initialized).toBe(false);
    expect(status.syncConfigured).toBe(false);
    expect(status.problems.join("\n")).toContain("sync is configured for");
    expect(status.problems.join("\n")).toContain("but vault origin is");
    expect(status.problems.join("\n")).toContain(`run agent-handoff sync init ${expected}`);
  });

  test("syncVault rejects a vault origin that differs from config before syncing", () => {
    const tmp = tempDir();
    const home = join(tmp, "home");
    const vault = join(home, "vault");
    const expected = join(tmp, "expected.git");
    const actual = join(tmp, "actual.git");
    mkdirSync(vault, { recursive: true });
    execGit(["init", "--bare", expected]);
    execGit(["init", "--bare", actual]);
    execGit(["init"], { cwd: vault });
    execGit(["remote", "add", "origin", actual], { cwd: vault });
    writeFileSync(join(vault, "note.md"), "unsynced memory\n");
    writeFileSync(join(home, "config.json"), JSON.stringify({ version: 2, vault, sync_url: expected }));

    expect(() => syncVault({ home })).toThrow("sync is configured for");
    expect(execGit(["ls-remote", "--heads", actual], { encoding: "utf8" })).toBe("");
  });

  test("syncVault rejects a git vault when sync_url is not configured", () => {
    const tmp = tempDir();
    const home = join(tmp, "home");
    const vault = join(home, "vault");
    const remote = join(tmp, "vault.git");
    mkdirSync(vault, { recursive: true });
    execGit(["init", "--bare", remote]);
    execGit(["init"], { cwd: vault });
    execGit(["remote", "add", "origin", remote], { cwd: vault });
    writeFileSync(join(vault, "note.md"), "unsynced memory\n");
    writeFileSync(join(home, "config.json"), JSON.stringify({ version: 2, vault }));

    expect(() => syncVault({ home })).toThrow("sync is not configured");
    expect(execGit(["ls-remote", "--heads", remote], { encoding: "utf8" })).toBe("");
  });

  test("start fails with a clear error when config is invalid", () => {
    const tmp = tempDir();
    const home = join(tmp, "home");
    const root = join(tmp, "repo");
    mkdirSync(home);
    mkdirSync(root);
    writeFileSync(join(home, "config.json"), "{not-json");

    expect(() => buildStartPacket({ root, home })).toThrow(HandoffError);
  });

  test("enableSync can replace default-only project scaffolding with remote memory", () => {
    const tmp = tempDir();
    const bare = join(tmp, "vault.git");
    const homeA = join(tmp, "home-a");
    const homeB = join(tmp, "home-b");
    const rootB = join(tmp, "repo-b");
    execGit(["init", "--bare", bare]);
    mkdirSync(rootB);

    enableHandoff({ home: homeA, skillsHome: join(tmp, "skills-a") });
    learn("A device already owns the remote vault.", { home: homeA, kind: "lesson" });
    enableSync({ home: homeA, syncUrl: bare });
    syncVault({ home: homeA });

    enableHandoff({ home: homeB, skillsHome: join(tmp, "skills-b") });
    writeFileSync(join(rootB, ".agent-handoff.yml"), "version: 2\nproject_id: github.com__owner__repo\n");
    buildStartPacket({ root: rootB, home: homeB, branch: "main" });

    enableSync({ home: homeB, syncUrl: bare });

    const lessons = readFileSync(join(homeB, "vault", "global", "lessons.md"), "utf8");
    expect(lessons).toContain("A device already owns the remote vault.");
  });

  test("enableSync rejects joining an existing remote when local vault has unsynced memory", () => {
    const tmp = tempDir();
    const bare = join(tmp, "vault.git");
    const homeA = join(tmp, "home-a");
    const homeB = join(tmp, "home-b");
    const rootB = join(tmp, "repo-b");
    execGit(["init", "--bare", bare]);
    mkdirSync(rootB);

    enableHandoff({ home: homeA, skillsHome: join(tmp, "skills-a") });
    learn("A device already owns the remote vault.", { home: homeA, kind: "lesson" });
    enableSync({ home: homeA, syncUrl: bare });
    syncVault({ home: homeA });

    enableHandoff({ home: homeB, skillsHome: join(tmp, "skills-b") });
    writeFileSync(join(rootB, ".agent-handoff.yml"), "version: 2\nproject_id: github.com__owner__repo\n");
    buildStartPacket({ root: rootB, home: homeB, branch: "main" });
    learn("This local decision has not been synced.", {
      home: homeB,
      root: rootB,
      scope: "project",
      kind: "decision",
    });

    expect(() => enableSync({ home: homeB, syncUrl: bare })).toThrow(HandoffError);
    expect(readFileSync(join(homeB, "config.json"), "utf8")).not.toContain("sync_url");
  });

  test("enableSync rejects switching an existing git vault to an unrelated populated remote", () => {
    const tmp = tempDir();
    const firstRemote = join(tmp, "first.git");
    const secondRemote = join(tmp, "second.git");
    const homeA = join(tmp, "home-a");
    const homeB = join(tmp, "home-b");
    execGit(["init", "--bare", firstRemote]);
    execGit(["init", "--bare", secondRemote]);

    enableHandoff({ home: homeA, skillsHome: join(tmp, "skills-a") });
    learn("First remote memory.", { home: homeA, kind: "lesson" });
    enableSync({ home: homeA, syncUrl: firstRemote });
    syncVault({ home: homeA });

    enableHandoff({ home: homeB, skillsHome: join(tmp, "skills-b") });
    learn("Second remote memory.", { home: homeB, kind: "lesson" });
    enableSync({ home: homeB, syncUrl: secondRemote });
    syncVault({ home: homeB });

    expect(() => enableSync({ home: homeA, syncUrl: secondRemote })).toThrow(HandoffError);
  });

  test("buildStartPacket fails when the configured vault is missing", () => {
    const tmp = tempDir();
    const root = join(tmp, "repo");
    const home = join(tmp, "home");
    mkdirSync(root);
    enableHandoff({ home, skillsHome: join(tmp, "skills") });
    rmSync(join(home, "vault"), { recursive: true, force: true });

    expect(() => buildStartPacket({ root, home })).toThrow(HandoffError);
  });

  test("writeCheckpoint keeps multiple checkpoints from the same second", () => {
    const tmp = tempDir();
    const root = join(tmp, "repo");
    const home = join(tmp, "home");
    mkdirSync(root);
    enableHandoff({ home, skillsHome: join(tmp, "skills") });
    writeFileSync(join(root, ".agent-handoff.yml"), "version: 2\nproject_id: github.com__owner__repo\n");
    const now = new Date("2026-05-08T12:00:00Z");

    const first = writeCheckpoint({
      root,
      home,
      note: "First checkpoint.",
      now,
      device: "laptop",
      agent: "codex",
      branch: "main",
    });
    const second = writeCheckpoint({
      root,
      home,
      note: "Second checkpoint.",
      now,
      device: "laptop",
      agent: "codex",
      branch: "main",
    });

    expect(second.path).not.toBe(first.path);
    expect(readFileSync(first.path, "utf8")).toContain("First checkpoint.");
    expect(readFileSync(second.path, "utf8")).toContain("Second checkpoint.");
  });

  test("normalizeProjectId turns malformed URLs into HandoffError", () => {
    expect(() => normalizeProjectId("https://[bad-url")).toThrow(HandoffError);
  });
});
