from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import TextIO

from . import __version__
from .core import HandoffError, build_restore_packet, capture_note, doctor, get_status
from .core import init_repo


def main(
    argv: list[str] | None = None,
    *,
    cwd: Path | str | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
) -> int:
    out = stdout or sys.stdout
    err = stderr or sys.stderr
    root = Path(cwd or ".")
    parser = _build_parser()

    try:
        args = parser.parse_args(argv)
        if args.command == "init":
            result = init_repo(root)
            print(
                "Initialized agent handoff "
                f"({result.created} created, {result.updated} updated).",
                file=out,
            )
            return 0

        if args.command == "capture":
            result = capture_note(root, args.note)
            print(f"Captured handoff note in {result.session_file}.", file=out)
            return 0

        if args.command == "restore":
            print(build_restore_packet(root), file=out)
            return 0

        if args.command == "status":
            status = get_status(root)
            if status.initialized:
                print("Agent handoff is ready.", file=out)
                return 0
            _print_status_problems(status.missing_files, status.missing_instruction_files, out)
            return 1

        if args.command == "doctor":
            report = doctor(root)
            if report.ok:
                print("Agent handoff is healthy.", file=out)
                return 0
            for problem in report.problems:
                print(f"- {problem}", file=out)
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
        description="Repo-local handoff files for Codex and Claude Code.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    subparsers = parser.add_subparsers(dest="command")

    subparsers.add_parser("init", help="Create handoff files and agent instructions.")

    capture = subparsers.add_parser("capture", help="Append a handoff note.")
    capture.add_argument("--note", required=True, help="Context note to append.")

    subparsers.add_parser("restore", help="Print a restore packet for a new session.")
    subparsers.add_parser("status", help="Show whether handoff files are ready.")
    subparsers.add_parser("doctor", help="Check handoff health and instruction drift.")
    return parser


def _print_status_problems(
    missing_files: list[str],
    missing_instruction_files: list[str],
    out: TextIO,
) -> None:
    if missing_files:
        print("Missing files:", file=out)
        for path in missing_files:
            print(f"- {path}", file=out)
    if missing_instruction_files:
        print("Missing instruction blocks:", file=out)
        for path in missing_instruction_files:
            print(f"- {path}", file=out)
