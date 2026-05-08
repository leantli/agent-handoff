import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("cli", () => {
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
