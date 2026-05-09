import { readFileSync } from "node:fs";
import { Command, CommanderError, Option } from "commander";

import {
  HandoffError,
  buildStartPacket,
  createGitHubSyncRepo,
  enableHandoff,
  enableSync,
  getStatus,
  learn,
  syncVault,
  writeCheckpoint,
} from "./core.js";

export interface MainOptions {
  cwd?: string;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  stdin?: { isTTY?: boolean };
}

export function main(argv = process.argv.slice(2), opts: MainOptions = {}): number {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const program = buildProgram(stdout, stderr, opts.stdin, opts.cwd);

  try {
    program.parse(argv, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    if (error instanceof HandoffError) {
      stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

function buildProgram(
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  stdin?: { isTTY?: boolean },
  cwd?: string,
): Command {
  const program = new Command();
  program
    .name("agent-handoff")
    .description("Shared vault handoff memory for coding agents.")
    .version("agent-handoff 0.5.3")
    .exitOverride()
    .configureOutput({
      writeOut: (str) => stdout.write(str),
      writeErr: (str) => stderr.write(str),
    })
    .option("--home <path>", "Agent handoff home directory. Defaults to ~/.agent-handoff.");

  program
    .command("enable")
    .description("Enable local handoff memory and install the user skill.")
    .option("--vault <path>", "Vault directory. Defaults to HOME/vault.")
    .option("--skills-home <path>", "Skills home directory. Defaults to ~/.agents/skills.")
    .action((options: { vault?: string; skillsHome?: string }) => {
      const result = enableHandoff({
        home: globalHome(program),
        vault: options.vault,
        skillsHome: options.skillsHome,
      });
      stdout.write(`Agent handoff enabled: ${result.setup.home}\n`);
      stdout.write(`Vault: ${result.setup.vault}\n`);
      stdout.write(`Skill: ${result.skill.path}\n`);
    });

  program
    .command("start")
    .description("Print context for a new agent session.")
    .option("--branch <branch>", "Override detected branch.")
    .action((options: { branch?: string }) => {
      stdout.write(`${buildStartPacket({ root: cwd, home: globalHome(program), branch: options.branch })}\n`);
    });

  program
    .command("checkpoint")
    .description("Write a session checkpoint.")
    .option("--note <text>", "Note text. If omitted, stdin is used.")
    .option("--file <path>", "Read note text from a file.")
    .option("--device <name>", "Device name for the checkpoint.")
    .option("--agent <name>", "Agent/client label for checkpoint metadata.")
    .option("--branch <branch>", "Override detected branch.")
    .action((options: NoteOptions & { device?: string; agent?: string; branch?: string }) => {
      const result = writeCheckpoint({
        root: cwd,
        home: globalHome(program),
        note: readNote(options, stdin),
        device: options.device,
        agent: options.agent,
        branch: options.branch,
      });
      stdout.write(`Wrote checkpoint: ${result.path}\n`);
    });

  program
    .command("learn")
    .description("Store durable handoff memory.")
    .option("--note <text>", "Note text. If omitted, stdin is used.")
    .option("--file <path>", "Read note text from a file.")
    .addOption(new Option("--scope <scope>", "Where to store the learned memory.").choices(["global", "project", "branch"]).default("global"))
    .addOption(new Option("--kind <kind>", "Kind of durable memory to write.").choices(["preference", "lesson", "decision", "context"]).default("preference"))
    .option("--branch <branch>", "Branch to use with --scope branch.")
    .action((options: NoteOptions & { scope: "global" | "project" | "branch"; kind: "preference" | "lesson" | "decision" | "context"; branch?: string }) => {
      const result = learn(readNote(options, stdin), {
        root: cwd,
        home: globalHome(program),
        scope: options.scope,
        kind: options.kind,
        branch: options.branch,
      });
      stdout.write(`Learned ${result.kind}: ${result.path}\n`);
    });

  const sync = program.command("sync").description("Sync the handoff vault.");
  sync
    .command("create <repository>")
    .description("Create a private GitHub repository with gh and enable cross-device sync.")
    .option("--vault <path>", "Vault directory. Defaults to HOME/vault.")
    .addOption(new Option("--protocol <protocol>", "Git remote protocol to store in config.").choices(["https", "ssh"]).default("https"))
    .action((repository: string, options: { vault?: string; protocol: "https" | "ssh" }) => {
      const result = createGitHubSyncRepo({
        home: globalHome(program),
        vault: options.vault,
        repository,
        protocol: options.protocol,
      });
      stdout.write(`${result.created ? "Created" : "Using existing"} private GitHub repository: ${result.repository}\n`);
      stdout.write(`Cross-device sync enabled: ${result.syncUrl}\n`);
      stdout.write(`Vault: ${result.setup.vault}\n`);
      stdout.write("Run agent-handoff sync to push local memory.\n");
    });
  sync
    .command("init <git-url>")
    .description("Enable cross-device sync with a private git repository.")
    .option("--vault <path>", "Vault directory. Defaults to HOME/vault.")
    .action((gitUrl: string, options: { vault?: string }) => {
      const result = enableSync({ home: globalHome(program), vault: options.vault, syncUrl: gitUrl });
      stdout.write(`Cross-device sync enabled: ${gitUrl}\n`);
      stdout.write(`Vault: ${result.vault}\n`);
    });
  sync.action(() => {
      for (const output of syncVault({ home: globalHome(program) })) {
        if (output) stdout.write(`${output}\n`);
      }
    });

  program
    .command("status")
    .description("Show whether handoff is ready here.")
    .action(() => {
      const status = getStatus({ root: cwd, home: globalHome(program) });
      if (status.initialized) {
        stdout.write(`Agent handoff is ready for ${status.projectId}.\n`);
        if (status.syncConfigured) {
          stdout.write(`Sync: configured (${status.syncUrl})\n`);
        } else {
          stdout.write("Sync: not configured\n");
        }
      } else {
        printProblems(status.problems, stdout);
        throw new CommanderError(1, "agent-handoff.status", "status failed");
      }
    });

  return program;
}

interface NoteOptions {
  note?: string;
  file?: string;
}

function globalHome(program: Command): string | undefined {
  return program.opts<{ home?: string }>().home;
}

function readNote(options: NoteOptions, stdin?: { isTTY?: boolean }): string {
  if (options.note) return options.note;
  if (options.file) return readFileSync(options.file, "utf8");
  if (stdin?.isTTY ?? process.stdin.isTTY) {
    throw new HandoffError("provide --note or --file, or pipe note text on stdin");
  }
  return readFileSync(0, "utf8");
}

function printProblems(problems: string[], stdout: NodeJS.WritableStream): void {
  for (const problem of problems) {
    stdout.write(`- ${problem}\n`);
  }
}
