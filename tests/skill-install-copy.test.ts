import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

// This file intentionally mocks symlink creation for every test so it can
// exercise the copy fallback path deterministically. Put tests that need real
// symlink behavior in core.test.ts or another unmocked test file.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    symlinkSync: vi.fn(() => {
      throw Object.assign(new Error("symlink unavailable"), { code: "EPERM" });
    }),
  };
});

const temps: string[] = [];

function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "agent-handoff-copy-test-"));
  temps.push(path);
  return path;
}

afterEach(() => {
  for (const path of temps.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
  vi.resetModules();
});

describe("skill install copy fallback", () => {
  test("installSkill falls back to an idempotent managed copy when symlinks are unavailable", async () => {
    const { installSkill } = await import("../src/core.js");
    const tmp = tempDir();
    const home = join(tmp, "home");
    const skillsHome = join(tmp, "skills");
    const registrationDir = join(skillsHome, "agent-handoff");

    const first = installSkill({ home, skillsHome });
    const second = installSkill({ home, skillsHome });

    expect(first.registration).toBe("copy");
    expect(first.updated).toBe(true);
    expect(first.backupPath).toBeUndefined();
    expect(second.registration).toBe("copy");
    expect(second.updated).toBe(false);
    expect(second.backupPath).toBeUndefined();
    expect(lstatSync(registrationDir).isSymbolicLink()).toBe(false);
    expect(existsSync(join(registrationDir, ".agent-handoff-managed.json"))).toBe(true);
    expect(readFileSync(join(registrationDir, "SKILL.md"), "utf8")).toContain("agent-handoff start");
  });
});
