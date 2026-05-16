import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, test } from "vitest";

import { main } from "../src/cli.js";

const temps: string[] = [];

function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "agent-handoff-cli-test-"));
  temps.push(path);
  return path;
}

afterEach(() => {
  for (const path of temps.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

class BufferWriter extends Writable {
  chunks: string[] = [];

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(chunk.toString());
    callback();
  }

  text(): string {
    return this.chunks.join("");
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

function writeMinimalVaultFiles(vault: string): void {
  mkdirSync(join(vault, "global"), { recursive: true });
  mkdirSync(join(vault, "projects"), { recursive: true });
  writeFileSync(join(vault, "global", "preferences.md"), "# Global Preferences\n\n");
  writeFileSync(join(vault, "global", "lessons.md"), "# Global Lessons\n\n");
}

function runCli(repo: string, ...args: string[]): { code: number; stdout: string; stderr: string } {
  const stdout = new BufferWriter();
  const stderr = new BufferWriter();
  const oldHome = process.env.HOME;
  const oldUserProfile = process.env.USERPROFILE;
  process.env.HOME = join(repo, ".test-user-home");
  process.env.USERPROFILE = join(repo, ".test-user-home");
  try {
    const code = main(args, { cwd: repo, stdout, stderr });
    return { code, stdout: stdout.text(), stderr: stderr.text() };
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

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ");
}

function optionalGitLines(args: string[]): string[] | null {
  if (!isGitWorktree(gitCommandCwd(args))) {
    return null;
  }
  return gitLines(args);
}

function gitLines(args: string[]): string[] {
  const output = execGit(args, { encoding: "utf8" }).trim();
  return output ? output.split(/\r?\n/) : [];
}

function isGitWorktree(cwd: string): boolean {
  try {
    return gitLines(["-C", cwd, "rev-parse", "--is-inside-work-tree"])[0] === "true";
  } catch {
    return false;
  }
}

function gitCommandCwd(args: string[]): string {
  const index = args.indexOf("-C");
  if (index === -1) return process.cwd();
  return args[index + 1] ?? process.cwd();
}

describe("cli", () => {
  test("cli version is read from package metadata instead of a second literal", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));

    const result = runCli(process.cwd(), "--version");

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(`agent-handoff ${pkg.version}`);
    expect(readFileSync(join(process.cwd(), "src", "cli.ts"), "utf8")).not.toContain(
      `agent-handoff ${pkg.version}`,
    );
  });

  test("package supports GitHub direct install by building on prepare", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));

    expect(pkg.scripts.prepare).toBe("npm run build");
    expect(pkg.scripts.prepack).toBeUndefined();
  });

  test("package exposes a library entrypoint and publish guard", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));

    expect(pkg.main).toBe("dist/index.js");
    expect(pkg.exports).toEqual({
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
    });
    expect(pkg.scripts["smoke:import"]).toContain("import('./dist/index.js')");
    expect(pkg.scripts.prepublishOnly).toBe(
      "npm run typecheck && npm test && npm run build && npm run smoke:import",
    );
  });

  test("git-backed repository checks tolerate source archives without git metadata", () => {
    const tmp = tempDir();

    expect(optionalGitLines(["-C", tmp, "ls-files", "docs/plans"])).toBeNull();
  });

  test("git-backed repository checks surface git command errors inside a checkout", () => {
    const insideWorktree = optionalGitLines(["rev-parse", "--is-inside-work-tree"]);
    if (insideWorktree?.[0] !== "true") return;

    expect(() => optionalGitLines(["definitely-not-a-git-command"])).toThrow();
  });

  test("repository does not keep tracked internal planning docs", () => {
    const trackedPlanningDocs = optionalGitLines(["ls-files", "docs/plans"]);
    if (trackedPlanningDocs) {
      const deletedPlanningDocs = new Set(optionalGitLines(["ls-files", "--deleted", "docs/plans"]) ?? []);
      const trackedPlanningDocsStillInWorktree = trackedPlanningDocs.filter(
        (file) => !deletedPlanningDocs.has(file) && existsSync(join(process.cwd(), file)),
      );

      expect(trackedPlanningDocsStillInWorktree).toEqual([]);
    }
    expect(readFileSync(join(process.cwd(), ".gitignore"), "utf8").split(/\r?\n/)).toContain("docs/plans/");
  });

  test("docs tell users to use a private sync repository without advertising repo creation", () => {
    const readme = normalizeWhitespace(readFileSync(join(process.cwd(), "README.md"), "utf8"));
    const skill = normalizeWhitespace(
      readFileSync(join(process.cwd(), "resources", "agent-handoff.SKILL.md"), "utf8"),
    );

    expect(readme).toContain("private");
    expect(readme).toContain("dedicated private repository");
    expect(readme).toContain("project code repository");
    expect(readme).toContain("agent-handoff sync init");
    expect(readme).toContain("unsynced memory");
    expect(readme).toContain("back up or manually merge");
    expect(readme).not.toContain("agent-handoff sync create");
    expect(skill).toContain("private vault repository");
    expect(skill).toContain("dedicated private vault repository");
    expect(skill).toContain("project code repository");
    expect(skill).toContain("agent-handoff sync init");
    expect(skill).toContain("unsynced memory");
    expect(skill).toContain("back up or manually merge");
    expect(skill).not.toContain("agent-handoff sync create");
  });

  test("docs explain memory boundaries for users and agents", () => {
    const readme = normalizeWhitespace(readFileSync(join(process.cwd(), "README.md"), "utf8"));
    const skill = normalizeWhitespace(
      readFileSync(join(process.cwd(), "resources", "agent-handoff.SKILL.md"), "utf8"),
    );

    expect(readme).toContain("shared handoff notebook");
    expect(readme).toContain("three layers");
    expect(readme).toContain("`global`: who the user is");
    expect(readme).toContain("`project`: what this repository is");
    expect(readme).toContain("`checkpoint`: where the current task stopped");
    expect(readme).toContain("Vault Layout");
    expect(readme).toContain("The vault stores that model as directories and Markdown files");
    expect(readme).toContain("Branch files under");
    expect(readme).toContain("are project-scoped context, not a fourth user-facing layer");
    expect(readme).toContain("Use branch context only for branch-specific work");
    expect(readme).not.toContain("The layers are:");
    expect(readme).not.toContain("project or branch memory");
    expect(readme).not.toContain("global/project/branch memory");

    expect(skill).toContain("shared handoff notebook, not a knowledge base");
    expect(skill).toContain("choose one of three layers");
    expect(skill).toContain("Use `learn` for durable memory and `checkpoint` for temporary task state");
    expect(skill).toContain("Within project memory, use branch scope only");
    expect(skill).toContain("If in doubt between global and project, choose project");
    expect(skill).toContain("Do not store low-value observations");
    expect(skill).not.toContain("Do not use `learn` for temporary task state; use `checkpoint` instead.");
  });

  test("docs explain the canonical skill and registered Codex and Claude Code locations", () => {
    const readme = normalizeWhitespace(readFileSync(join(process.cwd(), "README.md"), "utf8"));

    expect(readme).toContain("under `~/.agent-handoff/skills/agent-handoff`");
    expect(readme).toContain("for Codex under `~/.agents/skills/agent-handoff`");
    expect(readme).toContain("Claude Code under `~/.claude/skills/agent-handoff`");
    expect(readme).not.toContain("installs the packaged skill under `~/.agents/skills/agent-handoff`");
  });

  test("gitignore excludes local handoff and agent files", () => {
    const ignored = readFileSync(join(process.cwd(), ".gitignore"), "utf8").split(/\r?\n/);

    expect(ignored).toContain(".env*");
    expect(ignored).toContain(".DS_Store");
    expect(ignored).toContain(".agents/");
    expect(ignored).toContain(".agent-handoff/");
  });

  test("enable, checkpoint, and start flow without touching instruction files", () => {
    const tmp = tempDir();
    const repo = join(tmp, "repo");
    const home = join(tmp, "home");
    const skillsHome = join(tmp, "skills");
    const claudeSkillsHome = join(tmp, "claude-skills");
    mkdirSync(repo);
    // Write a bootstrap only to pin deterministic project id in this unit test.
    // Normal repos can derive the id from git remote.
    const bootstrapPath = join(repo, ".agent-handoff.yml");

    let result = runCli(
      repo,
      "--home",
      home,
      "enable",
      "--skills-home",
      skillsHome,
      "--claude-skills-home",
      claudeSkillsHome,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Agent handoff enabled");
    expect(result.stdout).toContain(join(skillsHome, "agent-handoff", "SKILL.md"));
    expect(result.stdout).toContain(join(claudeSkillsHome, "agent-handoff", "SKILL.md"));
    const canonicalSkill = join(home, "skills", "agent-handoff");
    expect(existsSync(join(canonicalSkill, "SKILL.md"))).toBe(true);
    expect(existsSync(join(skillsHome, "agent-handoff", "SKILL.md"))).toBe(true);
    expect(existsSync(join(claudeSkillsHome, "agent-handoff", "SKILL.md"))).toBe(true);
    if (process.platform !== "win32") {
      expect(lstatSync(join(skillsHome, "agent-handoff")).isSymbolicLink()).toBe(true);
      expect(lstatSync(join(claudeSkillsHome, "agent-handoff")).isSymbolicLink()).toBe(true);
      expect(realpathSync(join(skillsHome, "agent-handoff"))).toBe(realpathSync(canonicalSkill));
      expect(realpathSync(join(claudeSkillsHome, "agent-handoff"))).toBe(realpathSync(canonicalSkill));
    }

    writeFileSync(bootstrapPath, "version: 2\nproject_id: github.com__owner__repo\n");
    writeFileSync(join(repo, "AGENTS.md"), "# Existing\n");

    result = runCli(repo, "--home", home, "start", "--branch", "main");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("# Agent Handoff Start Packet");
    expect(existsSync(join(repo, ".agent-handoff", "project.md"))).toBe(false);
    expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toBe("# Existing\n");
    expect(existsSync(join(repo, "CLAUDE.md"))).toBe(false);

    result = runCli(
      repo,
      "--home",
      home,
      "checkpoint",
      "--note",
      "Ready for another device.",
      "--agent",
      "codex",
      "--branch",
      "main",
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Wrote checkpoint");

    result = runCli(repo, "--home", home, "start", "--branch", "main");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("# Agent Handoff Start Packet");
    expect(result.stdout).toContain("Ready for another device.");
  });

  test("enable reports when an existing skill registration is backed up", () => {
    const tmp = tempDir();
    const repo = join(tmp, "repo");
    const home = join(tmp, "home");
    const skillsHome = join(tmp, "skills");
    const registrationDir = join(skillsHome, "agent-handoff");
    mkdirSync(repo);
    mkdirSync(registrationDir, { recursive: true });
    writeFileSync(join(registrationDir, "SKILL.md"), "---\nname: custom-agent-handoff\n---\n");

    const result = runCli(repo, "--home", home, "enable", "--skills-home", skillsHome);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("backed up previous registration:");
    expect(result.stdout).toContain("agent-handoff.bak-");
    expect(readFileSync(join(registrationDir, "SKILL.md"), "utf8")).toContain("agent-handoff start");
  });

  test("learn writes global memory", () => {
    const tmp = tempDir();
    const repo = join(tmp, "repo");
    const home = join(tmp, "home");
    mkdirSync(repo);
    runCli(repo, "--home", home, "enable", "--skills-home", join(tmp, "skills"));

    const result = runCli(
      repo,
      "--home",
      home,
      "learn",
      "--kind",
      "preference",
      "--note",
      "Prefer branch-aware session files.",
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Learned preference");
    expect(readFileSync(join(home, "vault", "global", "preferences.md"), "utf8")).toContain(
      "branch-aware",
    );
  });

  test("learn writes project scoped memory", () => {
    const tmp = tempDir();
    const repo = join(tmp, "repo");
    const home = join(tmp, "home");
    mkdirSync(repo);
    runCli(repo, "--home", home, "enable", "--skills-home", join(tmp, "skills"));
    writeFileSync(join(repo, ".agent-handoff.yml"), "version: 2\nproject_id: github.com__owner__repo\n");
    runCli(repo, "--home", home, "start");

    const result = runCli(
      repo,
      "--home",
      home,
      "learn",
      "--scope",
      "project",
      "--kind",
      "decision",
      "--note",
      "Use vault-first storage.",
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Learned project decision");
  });

  test("learn rejects --branch unless scope is branch", () => {
    const tmp = tempDir();
    const repo = join(tmp, "repo");
    const home = join(tmp, "home");
    mkdirSync(repo);
    runCli(repo, "--home", home, "enable", "--skills-home", join(tmp, "skills"));

    const result = runCli(
      repo,
      "--home",
      home,
      "learn",
      "--kind",
      "preference",
      "--branch",
      "main",
      "--note",
      "This branch option should not be ignored.",
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--branch can only be used with --scope branch");
  });

  test("learn rejects branch scope unless kind is context", () => {
    const tmp = tempDir();
    const repo = join(tmp, "repo");
    const home = join(tmp, "home");
    mkdirSync(repo);
    runCli(repo, "--home", home, "enable", "--skills-home", join(tmp, "skills"));

    const result = runCli(
      repo,
      "--home",
      home,
      "learn",
      "--scope",
      "branch",
      "--kind",
      "decision",
      "--note",
      "Branch decisions should be project decisions.",
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("branch learn kind must be 'context'");
  });

  test("status reports not ready before enable and ready after enable", () => {
    const tmp = tempDir();
    const repo = join(tmp, "repo");
    const home = join(tmp, "home");
    mkdirSync(repo);

    const status = runCli(repo, "--home", home, "status");
    expect(status.code).toBe(1);
    expect(status.stdout).toContain("agent-handoff is not enabled");
    expect(status.stderr).toBe("");

    const enable = runCli(repo, "--home", home, "enable", "--skills-home", join(tmp, "skills"));
    expect(enable.code).toBe(0);

    const ready = runCli(repo, "--home", home, "status");
    expect(ready.code).toBe(0);
    expect(ready.stdout).toContain("Agent handoff is ready");
    expect(ready.stdout).toContain("Sync: not configured");
  });

  test("start requires enable", () => {
    const tmp = tempDir();
    const repo = join(tmp, "repo");
    const home = join(tmp, "home");
    mkdirSync(repo);

    const result = runCli(repo, "--home", home, "start");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("agent-handoff is not enabled");
  });

  test("start reports a missing configured vault instead of recreating it", () => {
    const tmp = tempDir();
    const repo = join(tmp, "repo");
    const home = join(tmp, "home");
    mkdirSync(repo);
    runCli(repo, "--home", home, "enable", "--skills-home", join(tmp, "skills"));
    rmSync(join(home, "vault"), { recursive: true, force: true });

    const result = runCli(repo, "--home", home, "start");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("vault directory is missing");
  });

  test("sync init configures cross-device sync", () => {
    const tmp = tempDir();
    const repo = join(tmp, "repo");
    const home = join(tmp, "home");
    const bare = join(tmp, "vault.git");
    mkdirSync(repo);
    execGit(["init", "--bare", bare]);

    const result = runCli(repo, "--home", home, "sync", "init", bare);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Cross-device sync enabled");
    expect(readFileSync(join(home, "config.json"), "utf8")).toContain(bare);

    const status = runCli(repo, "--home", home, "status");
    expect(status.code).toBe(0);
    expect(status.stdout).toContain(`Sync: configured (${bare})`);
  });

  test("sync pushes local vault changes to the configured remote", () => {
    const tmp = tempDir();
    const repo = join(tmp, "repo");
    const home = join(tmp, "home");
    const bare = join(tmp, "vault.git");
    mkdirSync(repo);
    execGit(["init", "--bare", bare]);
    runCli(repo, "--home", home, "sync", "init", bare);
    runCli(
      repo,
      "--home",
      home,
      "learn",
      "--kind",
      "lesson",
      "--note",
      "CLI sync should push this memory.",
    );

    const result = runCli(repo, "--home", home, "sync");

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(execGit(["show", "main:global/lessons.md"], { cwd: bare })).toContain(
      "CLI sync should push this memory.",
    );
  });

  test("sync help does not expose repository creation", () => {
    const tmp = tempDir();
    const repo = join(tmp, "repo");
    mkdirSync(repo);

    const result = runCli(repo, "sync", "--help");

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("init");
    expect(result.stdout).toContain("dedicated private");
    expect(result.stdout).toContain("vault repository");
    expect(result.stdout).not.toContain("create");
  });

  test("sync init fails for an unreachable sync remote", () => {
    const tmp = tempDir();
    const repo = join(tmp, "repo");
    const home = join(tmp, "home");
    const missing = join(tmp, "missing.git");
    mkdirSync(repo);

    const result = runCli(repo, "--home", home, "sync", "init", missing);

    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain("Cross-device sync enabled");
    expect(result.stderr).not.toBe("");
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });

  test("status reports sync misconfigured when sync_url exists but vault is not a git repo", () => {
    const tmp = tempDir();
    const repo = join(tmp, "repo");
    const home = join(tmp, "home");
    const vault = join(home, "vault");
    mkdirSync(repo);
    mkdirSync(vault, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({ version: 2, vault, sync_url: join(tmp, "vault.git") }));

    const result = runCli(repo, "--home", home, "status");

    expect(result.code).toBe(1);
    expect(result.stdout).toContain(`sync is configured for ${join(tmp, "vault.git")}`);
    expect(result.stdout).toContain(`run agent-handoff sync init ${join(tmp, "vault.git")}`);
  });

  test("status redacts credential-bearing sync URLs", () => {
    const tmp = tempDir();
    const repo = join(tmp, "repo");
    const home = join(tmp, "home");
    const vault = join(home, "vault");
    const syncUrl = "https://x-access-token:ghp_secret123@github.com/owner/vault.git";
    mkdirSync(repo);
    mkdirSync(vault, { recursive: true });
    writeMinimalVaultFiles(vault);
    execGit(["init"], { cwd: vault });
    execGit(["remote", "add", "origin", syncUrl], { cwd: vault });
    writeFileSync(join(home, "config.json"), JSON.stringify({ version: 2, vault, sync_url: syncUrl }));

    const result = runCli(repo, "--home", home, "status");

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("https://<redacted>@github.com/owner/vault.git");
    expect(result.stdout).not.toContain("ghp_secret123");
    expect(result.stdout).not.toContain("x-access-token");
  });

  test("sync rejects a git vault when sync_url is not configured", () => {
    const tmp = tempDir();
    const repo = join(tmp, "repo");
    const home = join(tmp, "home");
    const vault = join(home, "vault");
    const remote = join(tmp, "vault.git");
    mkdirSync(repo);
    mkdirSync(vault, { recursive: true });
    execGit(["init", "--bare", remote]);
    execGit(["init"], { cwd: vault });
    execGit(["remote", "add", "origin", remote], { cwd: vault });
    writeFileSync(join(vault, "note.md"), "unsynced memory\n");
    writeFileSync(join(home, "config.json"), JSON.stringify({ version: 2, vault }));

    const result = runCli(repo, "--home", home, "sync");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("sync is not configured");
    expect(execGit(["ls-remote", "--heads", remote], { encoding: "utf8" })).toBe("");
  });

  test("enable reports invalid config without a stack trace", () => {
    const tmp = tempDir();
    const repo = join(tmp, "repo");
    const home = join(tmp, "home");
    mkdirSync(repo);
    mkdirSync(home);
    writeFileSync(join(home, "config.json"), "{not-json");

    const result = runCli(repo, "--home", home, "enable", "--skills-home", join(tmp, "skills"));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("config.json is invalid");
    expect(result.stderr).not.toContain("SyntaxError");
  });

  test("status reports malformed config without undefined paths", () => {
    const tmp = tempDir();
    const repo = join(tmp, "repo");
    const home = join(tmp, "home");
    mkdirSync(repo);
    mkdirSync(home);
    writeFileSync(join(home, "config.json"), "{}");

    const result = runCli(repo, "--home", home, "status");

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("config.json is invalid: vault must be a non-empty string");
    expect(result.stdout).not.toContain("undefined");
  });

  test("checkpoint help uses a generic agent label description", () => {
    const tmp = tempDir();
    const repo = join(tmp, "repo");
    mkdirSync(repo);

    const result = runCli(repo, "checkpoint", "--help");

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Agent/client label for checkpoint metadata.");
    expect(result.stdout).not.toContain("such as codex or claude");
  });

  test("checkpoint without note on tty fails fast", () => {
    const tmp = tempDir();
    const repo = join(tmp, "repo");
    const home = join(tmp, "home");
    mkdirSync(repo);
    runCli(repo, "--home", home, "enable", "--skills-home", join(tmp, "skills"));
    writeFileSync(join(repo, ".agent-handoff.yml"), "version: 2\nproject_id: github.com__owner__repo\n");
    runCli(repo, "--home", home, "start");

    const stdout = new BufferWriter();
    const stderr = new BufferWriter();
    const code = main(["--home", home, "checkpoint"], {
      cwd: repo,
      stdout,
      stderr,
      stdin: { isTTY: true },
    });

    expect(code).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("provide --note");
  });
});
