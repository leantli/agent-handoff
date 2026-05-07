from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


HANDOFF_DIR = ".agent-handoff"
PROJECT_FILE = "project.md"
SESSION_FILE = "session.md"
DECISIONS_FILE = "decisions.md"
PREFERENCES_FILE = "preferences.md"
INDEX_FILE = "index.json"

MANAGED_BEGIN = "<!-- BEGIN AGENT-HANDOFF -->"
MANAGED_END = "<!-- END AGENT-HANDOFF -->"


@dataclass(frozen=True)
class InitResult:
    created: int
    updated: int
    root: Path


@dataclass(frozen=True)
class CaptureResult:
    session_file: Path
    updated_at: str


@dataclass(frozen=True)
class Status:
    initialized: bool
    missing_files: list[str]
    missing_instruction_files: list[str]
    root: Path


@dataclass(frozen=True)
class DoctorReport:
    ok: bool
    problems: list[str]
    root: Path


class HandoffError(RuntimeError):
    pass


def init_repo(root: Path | str = ".") -> InitResult:
    root_path = Path(root).resolve()
    handoff_path = root_path / HANDOFF_DIR
    created = 0
    updated = 0

    if not handoff_path.exists():
        handoff_path.mkdir(parents=True)

    for filename, contents in _seed_files().items():
        path = handoff_path / filename
        if not path.exists():
            path.write_text(contents, encoding="utf-8")
            created += 1

    index_path = handoff_path / INDEX_FILE
    if not index_path.exists():
        index_path.write_text(
            json.dumps(_metadata(), indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        created += 1

    for filename in ("AGENTS.md", "CLAUDE.md"):
        path = root_path / filename
        changed = _ensure_managed_block(path)
        if changed and path.exists():
            if path.read_text(encoding="utf-8").strip() == _managed_block().strip():
                created += 1
            else:
                updated += 1

    return InitResult(created=created, updated=updated, root=root_path)


def capture_note(
    root: Path | str = ".",
    note: str = "",
    *,
    now: datetime | None = None,
) -> CaptureResult:
    root_path = Path(root).resolve()
    _require_initialized(root_path)
    clean_note = " ".join(note.strip().split())
    if not clean_note:
        raise HandoffError("capture note cannot be empty")

    timestamp = _timestamp(now)
    session_path = root_path / HANDOFF_DIR / SESSION_FILE
    original = session_path.read_text(encoding="utf-8")
    if "## Capture Log" not in original:
        original = original.rstrip() + "\n\n## Capture Log\n\n"
    updated = original.rstrip() + f"\n- {timestamp}: {clean_note}\n"
    session_path.write_text(updated, encoding="utf-8")
    _write_metadata(root_path, timestamp)
    return CaptureResult(session_file=session_path, updated_at=timestamp)


def build_restore_packet(root: Path | str = ".") -> str:
    root_path = Path(root).resolve()
    _require_initialized(root_path)

    sections = [
        ("Project Context", PROJECT_FILE),
        ("Session Handoff", SESSION_FILE),
        ("Decisions", DECISIONS_FILE),
        ("Agent Preferences", PREFERENCES_FILE),
    ]
    lines = [
        "# Agent Handoff Restore Packet",
        "",
        "Use this packet to recover context for this repository. Read the "
        "sections in order before making changes.",
    ]
    for title, filename in sections:
        relative = f"{HANDOFF_DIR}/{filename}"
        contents = (root_path / relative).read_text(encoding="utf-8").rstrip()
        lines.extend(
            [
                "",
                f"## {relative}",
                "",
                f"<!-- {title} -->",
                "",
                contents,
            ]
        )
    lines.append("")
    return "\n".join(lines)


def get_status(root: Path | str = ".") -> Status:
    root_path = Path(root).resolve()
    missing_files = [
        path
        for path in _required_relative_files()
        if not (root_path / path).exists()
    ]
    missing_instruction_files = [
        filename
        for filename in ("AGENTS.md", "CLAUDE.md")
        if not _has_managed_block(root_path / filename)
    ]
    return Status(
        initialized=not missing_files and not missing_instruction_files,
        missing_files=missing_files,
        missing_instruction_files=missing_instruction_files,
        root=root_path,
    )


def doctor(root: Path | str = ".") -> DoctorReport:
    status = get_status(root)
    problems = [f"{path} is missing" for path in status.missing_files]
    problems.extend(
        f"{path} is missing the managed handoff block"
        for path in status.missing_instruction_files
    )
    return DoctorReport(ok=not problems, problems=problems, root=status.root)


def _seed_files() -> dict[str, str]:
    return {
        PROJECT_FILE: (
            "# Project Context\n\n"
            "Write stable project background here: architecture, important paths, "
            "local setup, and recurring constraints.\n"
        ),
        SESSION_FILE: (
            "# Session Handoff\n\n"
            "Use this file to hand off the current working state between agent "
            "sessions and devices.\n\n"
            "## Current Goal\n\n"
            "- TBD\n\n"
            "## Latest Notes\n\n"
        ),
        DECISIONS_FILE: (
            "# Decisions\n\n"
            "Record durable implementation and product decisions here.\n"
        ),
        PREFERENCES_FILE: (
            "# Agent Preferences\n\n"
            "Record user preferences, repeated corrections, and agent behavior "
            "rules here.\n"
        ),
    }


def _metadata() -> dict[str, object]:
    return _metadata_at(_timestamp(None))


def _metadata_at(timestamp: str) -> dict[str, object]:
    return {
        "version": 1,
        "updated_at": timestamp,
        "files": {
            "project": f"{HANDOFF_DIR}/{PROJECT_FILE}",
            "session": f"{HANDOFF_DIR}/{SESSION_FILE}",
            "decisions": f"{HANDOFF_DIR}/{DECISIONS_FILE}",
            "preferences": f"{HANDOFF_DIR}/{PREFERENCES_FILE}",
        },
    }


def _managed_block() -> str:
    return (
        f"{MANAGED_BEGIN}\n"
        "Agent handoff is enabled for this repository.\n\n"
        "Before starting work, read these files in order:\n"
        f"1. `{HANDOFF_DIR}/{PROJECT_FILE}`\n"
        f"2. `{HANDOFF_DIR}/{SESSION_FILE}`\n"
        f"3. `{HANDOFF_DIR}/{DECISIONS_FILE}`\n"
        f"4. `{HANDOFF_DIR}/{PREFERENCES_FILE}`\n\n"
        "Before pausing work or switching sessions, update "
        f"`{HANDOFF_DIR}/{SESSION_FILE}` with the current goal, progress, "
        "open questions, and next action.\n"
        f"{MANAGED_END}\n"
    )


def _required_relative_files() -> list[str]:
    return [
        f"{HANDOFF_DIR}/{PROJECT_FILE}",
        f"{HANDOFF_DIR}/{SESSION_FILE}",
        f"{HANDOFF_DIR}/{DECISIONS_FILE}",
        f"{HANDOFF_DIR}/{PREFERENCES_FILE}",
        f"{HANDOFF_DIR}/{INDEX_FILE}",
    ]


def _require_initialized(root: Path) -> None:
    status = get_status(root)
    if not status.initialized:
        missing = status.missing_files + status.missing_instruction_files
        raise HandoffError(
            "handoff is not initialized; run `agent-handoff init` first "
            f"(missing: {', '.join(missing)})"
        )


def _timestamp(now: datetime | None) -> str:
    value = now or datetime.now(timezone.utc)
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


def _write_metadata(root: Path, timestamp: str) -> None:
    index_path = root / HANDOFF_DIR / INDEX_FILE
    index_path.write_text(
        json.dumps(_metadata_at(timestamp), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def _has_managed_block(path: Path) -> bool:
    if not path.exists():
        return False
    contents = path.read_text(encoding="utf-8")
    return MANAGED_BEGIN in contents and MANAGED_END in contents


def _ensure_managed_block(path: Path) -> bool:
    block = _managed_block()
    if not path.exists():
        path.write_text(block, encoding="utf-8")
        return True

    original = path.read_text(encoding="utf-8")
    if MANAGED_BEGIN in original and MANAGED_END in original:
        before, remainder = original.split(MANAGED_BEGIN, 1)
        _, after = remainder.split(MANAGED_END, 1)
        prefix = before.rstrip()
        suffix = after.lstrip()
        parts = []
        if prefix:
            parts.append(prefix)
        parts.append(block.rstrip())
        if suffix:
            parts.append(suffix)
        updated = "\n\n".join(parts) + "\n"
    else:
        updated = original.rstrip() + "\n\n" + block

    if updated != original:
        path.write_text(updated, encoding="utf-8")
        return True
    return False
