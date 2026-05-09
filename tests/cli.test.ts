import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function runCli(repo: string, ...args: string[]): { code: number; stdout: string; stderr: string } {
  const stdout = new BufferWriter();
  const stderr = new BufferWriter();
  const code = main(args, { cwd: repo, stdout, stderr });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

function withFakeGh(tmp: string): { path: string; log: string; remote: string } {
  const bin = join(tmp, "bin");
  const log = join(tmp, "gh.log");
  const remote = join(tmp, "vault.git");
  const state = join(tmp, "repo-created");
  mkdirSync(bin, { recursive: true });
  const gh = join(bin, "gh");
  writeFileSync(
    gh,
    [
      "#!/bin/sh",
      `echo "$@" >> "${log}"`,
      'if [ "$1" = "repo" ] && [ "$2" = "view" ]; then',
      `  if [ -f "${state}" ]; then`,
      `    printf '{"isPrivate":true,"nameWithOwner":"leantli/agent-handoff-vault","url":"file://${remote}","sshUrl":"file://${remote}"}'`,
      "    exit 0",
      "  fi",
      "  echo 'repository not found' >&2",
      "  exit 1",
      "fi",
      'if [ "$1" = "repo" ] && [ "$2" = "create" ]; then',
      `  touch "${state}"`,
      `  git init --bare "${remote}" >/dev/null 2>&1`,
      "  exit 0",
      "fi",
      "exit 2",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(gh, 0o755);
  return { path: `${bin}:${process.env.PATH ?? ""}`, log, remote };
}

function withPath<T>(path: string, fn: () => T): T {
  const oldPath = process.env.PATH;
  process.env.PATH = path;
  try {
    return fn();
  } finally {
    process.env.PATH = oldPath;
  }
}

describe("cli", () => {
  test("package supports GitHub direct install by building on prepare", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));

    expect(pkg.scripts.prepare).toBe("npm run build");
    expect(pkg.scripts.prepack).toBeUndefined();
  });

  test("enable, checkpoint, and start flow without touching instruction files", () => {
    const tmp = tempDir();
    const repo = join(tmp, "repo");
    const home = join(tmp, "home");
    const skillsHome = join(tmp, "skills");
    mkdirSync(repo);
    // Write a bootstrap only to pin deterministic project id in this unit test.
    // Normal repos can derive the id from git remote.
    const bootstrapPath = join(repo, ".agent-handoff.yml");

    let result = runCli(repo, "--home", home, "enable", "--skills-home", skillsHome);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Agent handoff enabled");
    expect(existsSync(join(skillsHome, "agent-handoff", "SKILL.md"))).toBe(true);

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
    execFileSync("git", ["init", "--bare", bare]);

    const result = runCli(repo, "--home", home, "sync", "init", bare);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Cross-device sync enabled");
    expect(readFileSync(join(home, "config.json"), "utf8")).toContain(bare);

    const status = runCli(repo, "--home", home, "status");
    expect(status.code).toBe(0);
    expect(status.stdout).toContain(`Sync: configured (${bare})`);
  });

  test("sync create creates a private GitHub repository and configures sync", () => {
    const tmp = tempDir();
    const repo = join(tmp, "repo");
    const home = join(tmp, "home");
    mkdirSync(repo);
    const fakeGh = withFakeGh(tmp);

    const result = withPath(fakeGh.path, () =>
      runCli(repo, "--home", home, "sync", "create", "leantli/agent-handoff-vault"),
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Created private GitHub repository: leantli/agent-handoff-vault");
    expect(result.stdout).toContain(`Cross-device sync enabled: file://${fakeGh.remote}`);
    expect(readFileSync(fakeGh.log, "utf8")).toContain(
      "repo create leantli/agent-handoff-vault --private",
    );
    expect(readFileSync(join(home, "config.json"), "utf8")).toContain(`file://${fakeGh.remote}`);
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

  test("sync rejects a git vault when sync_url is not configured", () => {
    const tmp = tempDir();
    const repo = join(tmp, "repo");
    const home = join(tmp, "home");
    const vault = join(home, "vault");
    const remote = join(tmp, "vault.git");
    mkdirSync(repo);
    mkdirSync(vault, { recursive: true });
    execFileSync("git", ["init", "--bare", remote]);
    execFileSync("git", ["init"], { cwd: vault });
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: vault });
    writeFileSync(join(vault, "note.md"), "unsynced memory\n");
    writeFileSync(join(home, "config.json"), JSON.stringify({ version: 2, vault }));

    const result = runCli(repo, "--home", home, "sync");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("sync is not configured");
    expect(execFileSync("git", ["ls-remote", "--heads", remote], { encoding: "utf8" })).toBe("");
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
