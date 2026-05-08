from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import TextIO

from . import __version__
from .core import HandoffError
from .core import build_restore_packet, build_start_packet, capture_note, doctor, get_status
from .core import init_repo, learn, setup_home, sync_vault, write_checkpoint


def main(
    argv: list[str] | None = None,
    *,
    cwd: Path | str | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
    stdin: TextIO | None = None,
) -> int:
    out = stdout or sys.stdout
    err = stderr or sys.stderr
    inp = stdin or sys.stdin
    root = Path(cwd or ".")
    parser = _build_parser()

    try:
        args = parser.parse_args(argv)
        home = Path(args.home) if args.home else None

        if args.command == "setup":
            result = setup_home(home, vault=args.vault, sync_url=args.sync)
            print(f"Agent handoff home: {result.home}", file=out)
            print(f"Vault: {result.vault}", file=out)
            return 0

        if args.command == "init":
            result = init_repo(
                root,
                home=home,
                project_id=args.project_id,
                branch=args.branch,
            )
            print(f"Initialized agent handoff for {result.project_id}.", file=out)
            print(f"Vault project: {result.vault_project}", file=out)
            return 0

        if args.command in {"start", "restore"}:
            print(
                build_start_packet(root, home=home, branch=getattr(args, "branch", None)),
                file=out,
            )
            return 0

        if args.command in {"checkpoint", "capture"}:
            note = _read_note(args, inp)
            result = write_checkpoint(
                root,
                note,
                home=home,
                device=args.device,
                agent=args.agent,
                branch=args.branch,
            )
            print(f"Wrote checkpoint: {result.path}", file=out)
            return 0

        if args.command == "learn":
            note = _read_note(args, inp)
            result = learn(note, home=home, kind=args.kind)
            print(f"Learned {result.kind}: {result.path}", file=out)
            return 0

        if args.command == "sync":
            outputs = sync_vault(home)
            for output in outputs:
                if output:
                    print(output, file=out)
            return 0

        if args.command == "status":
            status = get_status(root, home=home)
            if status.initialized:
                print(f"Agent handoff is ready for {status.project_id}.", file=out)
                return 0
            _print_problems(status.problems, out)
            return 1

        if args.command == "doctor":
            report = doctor(root, home=home)
            if report.ok:
                print(f"Agent handoff is healthy for {report.project_id}.", file=out)
                return 0
            _print_problems(report.problems, out)
            return 1

        parser.print_help(out)
        return 0
    except HandoffError as exc:
        print(str(exc), file=err)
        return 1
    except SystemExit as exc:
        return int(exc.code)


def entrypoint() -> None:
    raise SystemExit(main())


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="agent-handoff",
        description="Shared vault handoff memory for Codex and Claude Code.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    parser.add_argument(
        "--home",
        help="Agent handoff home directory. Defaults to ~/.agent-handoff.",
    )
    subparsers = parser.add_subparsers(dest="command")

    setup = subparsers.add_parser("setup", help="Create or configure the user vault.")
    setup.add_argument("--vault", help="Vault directory. Defaults to HOME/vault.")
    setup.add_argument("--sync", help="Optional git remote URL for vault sync.")

    init = subparsers.add_parser("init", help="Bootstrap this repo for agent handoff.")
    init.add_argument("--project-id", help="Override detected project id.")
    init.add_argument("--branch", help="Override detected branch.")

    start = subparsers.add_parser("start", help="Print context for a new agent session.")
    start.add_argument("--branch", help="Override detected branch.")

    restore = subparsers.add_parser("restore", help="Alias for start.")
    restore.add_argument("--branch", help="Override detected branch.")

    checkpoint = subparsers.add_parser("checkpoint", help="Write a session checkpoint.")
    _add_note_args(checkpoint)
    checkpoint.add_argument("--device", help="Device name for the checkpoint.")
    checkpoint.add_argument("--agent", help="Agent/client name, such as codex or claude.")
    checkpoint.add_argument("--branch", help="Override detected branch.")

    capture = subparsers.add_parser("capture", help="Alias for checkpoint.")
    _add_note_args(capture)
    capture.add_argument("--device", help="Device name for the checkpoint.")
    capture.add_argument("--agent", help="Agent/client name, such as codex or claude.")
    capture.add_argument("--branch", help="Override detected branch.")

    learn_parser = subparsers.add_parser("learn", help="Store a durable preference or lesson.")
    _add_note_args(learn_parser)
    learn_parser.add_argument(
        "--kind",
        choices=["preference", "lesson"],
        default="preference",
        help="Kind of durable memory to write.",
    )

    subparsers.add_parser("sync", help="Pull and push the vault git repository.")
    subparsers.add_parser("status", help="Show whether handoff is ready here.")
    subparsers.add_parser("doctor", help="Check bootstrap and vault health.")
    return parser


def _add_note_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--note", help="Note text. If omitted, stdin is used.")
    parser.add_argument("--file", help="Read note text from a file.")


def _read_note(args: argparse.Namespace, stdin: TextIO) -> str:
    if getattr(args, "note", None):
        return args.note
    if getattr(args, "file", None):
        return Path(args.file).read_text(encoding="utf-8")
    return stdin.read()


def _print_problems(problems: list[str], out: TextIO) -> None:
    for problem in problems:
        print(f"- {problem}", file=out)
