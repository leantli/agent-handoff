import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_HOME = join(homedir(), ".agent-handoff");
export const CONFIG_FILE = "config.json";
export const BOOTSTRAP_FILE = ".agent-handoff.yml";

const SECRET_PATTERNS = [
  /(api[_-]?key|token|secret|password)\s*[:=]/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{8,}\b/,
];

type LearnScope = "global" | "project" | "branch";
type LearnKind = "preference" | "lesson" | "decision" | "context";

export class HandoffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandoffError";
  }
}

export interface SetupResult {
  home: string;
  vault: string;
  created: number;
  updated: number;
}

export interface EnableResult {
  setup: SetupResult;
  skill: InstallSkillResult;
}

export interface CheckpointResult {
  path: string;
  projectId: string;
  branch: string;
  createdAt: string;
}

export interface LearnResult {
  path: string;
  kind: string;
  createdAt: string;
}

export interface InstallSkillResult {
  path: string;
  updated: boolean;
}

export interface Status {
  initialized: boolean;
  problems: string[];
  root: string;
  projectId: string | null;
}

interface Config {
  version: number;
  vault: string;
  sync_url?: string;
}

export function setupHome(opts: {
  home?: string;
  vault?: string;
  syncUrl?: string;
} = {}): SetupResult {
  const homePath = resolveHome(opts.home);
  const vaultPath = opts.vault ? resolve(opts.vault) : join(homePath, "vault");
  let created = 0;
  let updated = 0;

  if (!existsSync(homePath)) {
    mkdirSync(homePath, { recursive: true });
    created += 1;
  }

  if (opts.syncUrl && cloneVaultIfNeeded(homePath, vaultPath, opts.syncUrl)) {
    created += 1;
  }

  for (const directory of [vaultPath, join(vaultPath, "global"), join(vaultPath, "projects")]) {
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
      created += 1;
    }
  }

  for (const [filename, contents] of Object.entries(globalSeedFiles())) {
    const path = join(vaultPath, "global", filename);
    if (!existsSync(path)) {
      writeFileSync(path, contents, "utf8");
      created += 1;
    }
  }

  const configPath = join(homePath, CONFIG_FILE);
  const desired: Config = { version: 2, vault: vaultPath };
  if (opts.syncUrl) desired.sync_url = opts.syncUrl;

  if (existsSync(configPath)) {
    const existing = JSON.parse(readFileSync(configPath, "utf8")) as Config;
    let changed = false;
    if (existing.version !== 2) {
      existing.version = 2;
      changed = true;
    }
    if (existing.vault !== vaultPath) {
      existing.vault = vaultPath;
      changed = true;
    }
    if (opts.syncUrl && existing.sync_url !== opts.syncUrl) {
      existing.sync_url = opts.syncUrl;
      changed = true;
    }
    if (changed) {
      writeFileSync(configPath, json(existing), "utf8");
      updated += 1;
    }
  } else {
    writeFileSync(configPath, json(desired), "utf8");
    created += 1;
  }

  if (opts.syncUrl) {
    ensureGitRemote(vaultPath, opts.syncUrl);
  }

  return { home: homePath, vault: vaultPath, created, updated };
}

export function normalizeProjectId(value: string): string {
  const raw = value.trim();
  let host = "";
  let path = "";

  if (raw.startsWith("git@") && raw.includes(":")) {
    const [userHost, remotePath] = raw.split(":", 2);
    host = userHost.split("@", 2)[1] ?? "";
    path = remotePath;
  } else if (raw.includes("://")) {
    const parsed = new URL(raw);
    host = parsed.hostname || parsed.host;
    path = parsed.pathname;
  } else {
    return safeProjectId(raw);
  }

  path = path.replace(/^\/+|\/+$/g, "");
  if (path.endsWith(".git")) {
    path = path.slice(0, -4);
  }
  return safeProjectId([host.toLowerCase(), ...path.split("/").filter(Boolean)].join("__"));
}

export function installSkill(opts: { skillsHome?: string } = {}): InstallSkillResult {
  const skillsHome = opts.skillsHome
    ? resolve(opts.skillsHome)
    : resolve(join(homedir(), ".agents", "skills"));
  const skillDir = join(skillsHome, "agent-handoff");
  mkdirSync(skillDir, { recursive: true });
  const path = join(skillDir, "SKILL.md");
  const content = readResource("agent-handoff.SKILL.md");
  const updated = !existsSync(path) || readFileSync(path, "utf8") !== content;
  if (updated) {
    writeFileSync(path, content, "utf8");
  }
  return { path, updated };
}

export function enableHandoff(opts: {
  home?: string;
  vault?: string;
  skillsHome?: string;
} = {}): EnableResult {
  const setup = setupHome({ home: opts.home, vault: opts.vault });
  const skill = installSkill({ skillsHome: opts.skillsHome });
  return { setup, skill };
}

export function enableSync(opts: {
  home?: string;
  vault?: string;
  syncUrl: string;
}): SetupResult {
  return setupHome({ home: opts.home, vault: opts.vault, syncUrl: opts.syncUrl });
}

export function deriveProjectId(root = ".", projectId?: string): string {
  const rootPath = resolve(root);
  if (projectId) return coerceProjectId(projectId);

  const bootstrapPath = join(rootPath, BOOTSTRAP_FILE);
  if (existsSync(bootstrapPath)) {
    const data = readBootstrap(bootstrapPath);
    if (data.project_id) return coerceProjectId(data.project_id);
  }

  const remote = gitOutput(rootPath, ["remote", "get-url", "origin"]);
  if (remote) return normalizeProjectId(remote);

  return safeProjectId(rootPath.split(/[\\/]/).pop() ?? "unknown-project");
}

export function currentBranch(root = "."): string {
  return gitOutput(resolve(root), ["branch", "--show-current"]) ?? "default";
}

export function buildStartPacket(opts: {
  root?: string;
  home?: string;
  branch?: string;
  maxCheckpoints?: number;
} = {}): string {
  const rootPath = resolve(opts.root ?? ".");
  const setup = loadSetup(opts.home);
  const pid = deriveProjectId(rootPath);
  const branchName = opts.branch ?? currentBranch(rootPath);
  const projectPath = vaultProjectPath(setup.vault, pid);
  ensureProjectFiles(projectPath, branchName);
  const branchFile = join(projectPath, "branches", `${safeName(branchName)}.md`);

  const sections: Array<[string, string]> = [
    ["Global Preferences", join(setup.vault, "global", "preferences.md")],
    ["Global Lessons", join(setup.vault, "global", "lessons.md")],
    ["Project Context", join(projectPath, "project.md")],
    ["Project Preferences", join(projectPath, "preferences.md")],
    ["Project Decisions", join(projectPath, "decisions.md")],
    ["Branch Context", branchFile],
  ];

  const lines = [
    "# Agent Handoff Start Packet",
    "",
    `Project: \`${pid}\``,
    `Branch: \`${branchName}\``,
    "",
    "Read this packet before making changes. Use it to recover context from previous Codex and Claude Code sessions.",
  ];

  for (const [title, path] of sections) {
    lines.push(...renderSection(title, path));
  }

  const checkpoints = latestCheckpoints(projectPath, opts.maxCheckpoints ?? 5, branchName);
  if (checkpoints.length > 0) {
    lines.push("", "## Recent Checkpoints");
    for (const path of checkpoints) {
      lines.push(...renderSection(path.split(/[\\/]/).pop() ?? path, path, 3));
    }
  }

  lines.push("");
  return lines.join("\n");
}

export function writeCheckpoint(opts: {
  root?: string;
  note: string;
  home?: string;
  now?: Date;
  device?: string;
  agent?: string;
  branch?: string;
}): CheckpointResult {
  const rootPath = resolve(opts.root ?? ".");
  const cleanedNote = cleanNote(opts.note);
  if (!cleanedNote) throw new HandoffError("checkpoint note cannot be empty");
  rejectLikelySecret(cleanedNote);

  const setup = loadSetup(opts.home);
  const pid = deriveProjectId(rootPath);
  const branchName = opts.branch ?? currentBranch(rootPath);
  const createdAt = timestamp(opts.now);
  const projectPath = vaultProjectPath(setup.vault, pid);
  ensureProjectFiles(projectPath, branchName);
  const checkpoints = join(projectPath, "checkpoints");
  mkdirSync(checkpoints, { recursive: true });
  const deviceLabel = opts.device ?? hostname() ?? "device";
  const agentLabel = opts.agent ?? "agent";
  const filename = `${compactTimestamp(createdAt)}-${safeName(deviceLabel)}-${safeName(agentLabel)}-${safeName(branchName)}.md`;
  const path = join(checkpoints, filename);
  const contents = [
    "# Checkpoint",
    "",
    `created_at: ${createdAt}`,
    `project_id: ${pid}`,
    `branch: ${branchName}`,
    `device: ${deviceLabel}`,
    `agent: ${agentLabel}`,
    "",
    "## Notes",
    "",
    cleanedNote,
    "",
  ].join("\n");
  writeFileSync(path, contents, "utf8");
  return { path, projectId: pid, branch: branchName, createdAt };
}

export function learn(
  note: string,
  opts: {
    home?: string;
    root?: string;
    scope?: LearnScope;
    kind?: LearnKind;
    branch?: string;
    now?: Date;
  } = {},
): LearnResult {
  const clean = cleanNote(note);
  if (!clean) throw new HandoffError("learn note cannot be empty");
  rejectLikelySecret(clean);
  const scope = opts.scope ?? "global";
  const kind = opts.kind ?? "preference";
  if (!["global", "project", "branch"].includes(scope)) {
    throw new HandoffError("learn scope must be 'global', 'project', or 'branch'");
  }
  if (!["preference", "lesson", "decision", "context"].includes(kind)) {
    throw new HandoffError("learn kind must be 'preference', 'lesson', 'decision', or 'context'");
  }

  const setup = loadSetup(opts.home);
  const path = learnTargetPath(setup, resolve(opts.root ?? "."), scope, kind, opts.branch);
  const createdAt = timestamp(opts.now);
  appendFile(path, `\n- ${createdAt}: ${clean}\n`);
  return { path, kind: scope === "global" ? kind : `${scope} ${kind}`, createdAt };
}

export function syncVault(opts: { home?: string } = {}): string[] {
  const setup = loadSetup(opts.home);
  if (!existsSync(join(setup.vault, ".git"))) {
    throw new HandoffError("vault is not a git repository; run agent-handoff sync init <git-url> first");
  }
  const outputs: string[] = [];

  gitChecked(setup.vault, ["add", "-A"]);
  const staged = gitRun(setup.vault, ["diff", "--cached", "--quiet"]).status !== 0;
  if (staged) {
    outputs.push(
      gitChecked(setup.vault, [
        "-c",
        "user.name=agent-handoff",
        "-c",
        "user.email=agent-handoff@local",
        "commit",
        "-m",
        "chore: sync agent handoff vault",
      ]),
    );
  }

  const branch = gitOutput(setup.vault, ["branch", "--show-current"]) ?? "main";
  const pull = gitRun(setup.vault, ["pull", "--rebase", "--autostash", "origin", branch]);
  if (pull.status !== 0 && !isEmptyRemotePull(pull.output)) {
    throw new HandoffError(pull.output.trim() || "git pull failed");
  }
  if (pull.output.trim()) outputs.push(pull.output.trim());

  const push = gitRun(setup.vault, ["push", "-u", "origin", branch]);
  if (push.status !== 0) {
    throw new HandoffError(push.output.trim() || "git push failed");
  }
  if (push.output.trim()) outputs.push(push.output.trim());
  return outputs;
}

export function getStatus(opts: { root?: string; home?: string } = {}): Status {
  const rootPath = resolve(opts.root ?? ".");
  const problems: string[] = [];
  const projectId = deriveProjectId(rootPath);

  const config = readConfig(opts.home);
  if (!config) {
    problems.push("agent-handoff is not enabled; run agent-handoff enable");
  } else if (!existsSync(config.vault)) {
    problems.push(`vault directory is missing: ${config.vault}`);
  }

  return { initialized: problems.length === 0, problems, root: rootPath, projectId };
}

function globalSeedFiles(): Record<string, string> {
  return {
    "preferences.md": "# Global Preferences\n\n",
    "lessons.md": "# Global Lessons\n\n",
  };
}

function projectSeedFiles(): Record<string, string> {
  return {
    "project.md": "# Project Context\n\n",
    "decisions.md": "# Decisions\n\n",
    "preferences.md": "# Project Preferences\n\n",
  };
}

function ensureProjectFiles(projectPath: string, branch: string): number {
  let created = 0;
  for (const directory of [projectPath, join(projectPath, "branches"), join(projectPath, "checkpoints")]) {
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
      created += 1;
    }
  }
  for (const [filename, contents] of Object.entries(projectSeedFiles())) {
    const path = join(projectPath, filename);
    if (!existsSync(path)) {
      writeFileSync(path, contents, "utf8");
      created += 1;
    }
  }
  const branchPath = join(projectPath, "branches", `${safeName(branch)}.md`);
  if (!existsSync(branchPath)) {
    writeFileSync(branchPath, `# Branch Context: ${branch}\n\n`, "utf8");
    created += 1;
  }
  return created;
}

function learnTargetPath(
  setup: SetupResult,
  root: string,
  scope: LearnScope,
  kind: LearnKind,
  branch?: string,
): string {
  if (scope === "global") {
    if (!["preference", "lesson"].includes(kind)) {
      throw new HandoffError("global learn kind must be 'preference' or 'lesson'");
    }
    return join(setup.vault, "global", kind === "preference" ? "preferences.md" : "lessons.md");
  }

  const status = getStatus({ root, home: setup.home });
  if (!status.initialized) {
    throw new HandoffError(statusError(status));
  }
  const pid = deriveProjectId(root);
  const projectPath = vaultProjectPath(setup.vault, pid);
  ensureProjectFiles(projectPath, branch ?? currentBranch(root));

  if (scope === "project") {
    if (kind === "preference") return join(projectPath, "preferences.md");
    if (kind === "decision") return join(projectPath, "decisions.md");
    return join(projectPath, "project.md");
  }

  const branchName = branch ?? currentBranch(root);
  const branchPath = join(projectPath, "branches", `${safeName(branchName)}.md`);
  if (!existsSync(branchPath)) {
    writeFileSync(branchPath, `# Branch Context: ${branchName}\n\n`, "utf8");
  }
  return branchPath;
}

function resolveHome(home?: string): string {
  return resolve(home ? expandHome(home) : DEFAULT_HOME);
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function readConfig(home?: string): Config | null {
  const configPath = join(resolveHome(home), CONFIG_FILE);
  if (!existsSync(configPath)) return null;
  return JSON.parse(readFileSync(configPath, "utf8")) as Config;
}

function loadSetup(home?: string): SetupResult {
  const config = readConfig(home);
  if (!config) throw new HandoffError("agent-handoff is not enabled; run agent-handoff enable");
  return { home: resolveHome(home), vault: resolve(config.vault), created: 0, updated: 0 };
}

function vaultProjectPath(vault: string, projectId: string): string {
  return join(vault, "projects", coerceProjectId(projectId));
}

function coerceProjectId(value: string): string {
  if (value.includes("://") || value.startsWith("git@")) return normalizeProjectId(value);
  return safeProjectId(value);
}

function safeProjectId(value: string): string {
  let normalized = value.trim().replace(/^\/+|\/+$/g, "");
  if (normalized.endsWith(".git")) normalized = normalized.slice(0, -4);
  normalized = normalized.replace(/[/:]/g, "__").replace(/[^A-Za-z0-9._-]+/g, "__");
  normalized = normalized.replace(/__+/g, "__").replace(/^_+|_+$/g, "");
  return normalized || "unknown-project";
}

function safeName(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]+/g, "__").replace(/__+/g, "__").replace(/^_+|_+$/g, "");
  return normalized || "default";
}

function readBootstrap(path: string): Record<string, string> {
  const data: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.includes(":") || line.trimStart().startsWith("#")) continue;
    const index = line.indexOf(":");
    data[line.slice(0, index).trim()] = line.slice(index + 1).trim().replace(/^["']|["']$/g, "");
  }
  return data;
}

function renderSection(title: string, path: string, headingLevel = 2): string[] {
  const heading = "#".repeat(headingLevel);
  if (!existsSync(path)) {
    return ["", `${heading} ${title}`, "", "_Missing._"];
  }
  return ["", `${heading} ${title}`, "", readFileSync(path, "utf8").trimEnd()];
}

function latestCheckpoints(projectPath: string, limit: number, branch?: string): string[] {
  const checkpointDir = join(projectPath, "checkpoints");
  if (!existsSync(checkpointDir)) return [];
  let paths = readdirSync(checkpointDir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => join(checkpointDir, name));
  if (branch !== undefined) {
    paths = paths.filter((path) => checkpointBranch(path) === branch);
  }
  return paths.slice(-limit);
}

function checkpointBranch(path: string): string | null {
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (line.startsWith("branch:")) return line.split(":", 2)[1].trim();
  }
  return null;
}

function timestamp(now?: Date): string {
  const value = now ?? new Date();
  const year = value.getUTCFullYear();
  const month = pad(value.getUTCMonth() + 1);
  const day = pad(value.getUTCDate());
  const hour = pad(value.getUTCHours());
  const minute = pad(value.getUTCMinutes());
  const second = pad(value.getUTCSeconds());
  return `${year}-${month}-${day}T${hour}:${minute}:${second}+00:00`;
}

function compactTimestamp(value: string): string {
  return value.replace("+00:00", "Z").replace(/[:.-]/g, "");
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function cleanNote(note: string): string {
  return note
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function rejectLikelySecret(note: string): void {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(note))) {
    throw new HandoffError("handoff notes look like they contain a secret; remove it and try again");
  }
}

function statusError(status: Status): string {
  return `agent handoff is not ready:\n${status.problems.map((problem) => `- ${problem}`).join("\n")}`;
}

function json(data: unknown): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

function appendFile(path: string, contents: string): void {
  writeFileSync(path, contents, { encoding: "utf8", flag: "a" });
}

function cloneVaultIfNeeded(home: string, vault: string, syncUrl: string): boolean {
  if (existsSync(join(vault, ".git"))) return false;
  if (existsSync(vault)) {
    if (readdirSync(vault).length === 0 || isSeedOnlyVault(vault)) {
      rmSync(vault, { recursive: true, force: true });
    } else {
      return false;
    }
  }
  const clone = gitRun(home, ["clone", syncUrl, vault]);
  return clone.status === 0;
}

function isSeedOnlyVault(vault: string): boolean {
  const entries = readdirSync(vault).sort();
  if (entries.some((entry) => !["global", "projects"].includes(entry))) return false;

  const projects = join(vault, "projects");
  if (existsSync(projects) && readdirSync(projects).length > 0) return false;

  const global = join(vault, "global");
  if (!existsSync(global)) return entries.length === 0 || entries.every((entry) => entry === "projects");

  const seeds = globalSeedFiles();
  for (const entry of readdirSync(global)) {
    if (!(entry in seeds)) return false;
    if (readFileSync(join(global, entry), "utf8") !== seeds[entry]) return false;
  }
  return true;
}

function ensureGitRemote(vault: string, syncUrl: string): void {
  if (!existsSync(join(vault, ".git"))) {
    gitRun(vault, ["init"]);
    gitRun(vault, ["branch", "-M", "main"]);
  }
  const remotes = gitOutput(vault, ["remote"]);
  if (remotes?.split(/\r?\n/).includes("origin")) {
    gitRun(vault, ["remote", "set-url", "origin", syncUrl]);
  } else {
    gitRun(vault, ["remote", "add", "origin", syncUrl]);
  }
}

function gitOutput(root: string, args: string[]): string | null {
  const result = gitRun(root, args);
  if (result.status !== 0) return null;
  const output = result.output.trim();
  return output || null;
}

function gitChecked(root: string, args: string[]): string {
  const result = gitRun(root, args);
  if (result.status !== 0) {
    throw new HandoffError(result.output.trim() || `git ${args.join(" ")} failed`);
  }
  return result.output.trim();
}

function gitRun(root: string, args: string[]): { status: number; output: string } {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function isEmptyRemotePull(output: string): boolean {
  const lowered = output.toLowerCase();
  return lowered.includes("couldn't find remote ref") || lowered.includes("could not find remote ref");
}

function readResource(name: string): string {
  const path = fileURLToPath(new URL(`../resources/${name}`, import.meta.url));
  return readFileSync(path, "utf8");
}
