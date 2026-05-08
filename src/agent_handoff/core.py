from __future__ import annotations

import json
import re
import socket
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from importlib import resources
from pathlib import Path
from urllib.parse import urlparse


DEFAULT_HOME = Path.home() / ".agent-handoff"
CONFIG_FILE = "config.json"
BOOTSTRAP_FILE = ".agent-handoff.yml"

MANAGED_BEGIN = "<!-- BEGIN AGENT-HANDOFF -->"
MANAGED_END = "<!-- END AGENT-HANDOFF -->"
SECRET_PATTERNS = (
    re.compile(r"(?i)(api[_-]?key|token|secret|password)\s*[:=]"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{8,}\b"),
)


@dataclass(frozen=True)
class SetupResult:
    home: Path
    vault: Path
    created: int
    updated: int


@dataclass(frozen=True)
class InitResult:
    created: int
    updated: int
    root: Path
    project_id: str
    vault_project: Path
    clients: tuple[str, ...]


@dataclass(frozen=True)
class CheckpointResult:
    path: Path
    project_id: str
    branch: str
    created_at: str


@dataclass(frozen=True)
class LearnResult:
    path: Path
    kind: str
    created_at: str


@dataclass(frozen=True)
class InstallSkillResult:
    path: Path
    updated: bool


@dataclass(frozen=True)
class Status:
    initialized: bool
    problems: list[str]
    root: Path
    project_id: str | None


@dataclass(frozen=True)
class DoctorReport:
    ok: bool
    problems: list[str]
    root: Path
    project_id: str | None


class HandoffError(RuntimeError):
    pass


def setup_home(
    home: Path | str | None = None,
    *,
    vault: Path | str | None = None,
    sync_url: str | None = None,
) -> SetupResult:
    home_path = _resolve_home(home)
    vault_path = Path(vault).expanduser().resolve() if vault else home_path / "vault"
    created = 0
    updated = 0

    if not home_path.exists():
        home_path.mkdir(parents=True)
        created += 1

    if sync_url:
        cloned = _clone_vault_if_needed(home_path, vault_path, sync_url)
        if cloned:
            created += 1

    for directory in (vault_path, vault_path / "global", vault_path / "projects"):
        if not directory.exists():
            directory.mkdir(parents=True)
            created += 1

    for filename, contents in _global_seed_files().items():
        path = vault_path / "global" / filename
        if not path.exists():
            path.write_text(contents, encoding="utf-8")
            created += 1

    config_path = home_path / CONFIG_FILE
    config = {"version": 2, "vault": str(vault_path)}
    if sync_url:
        config["sync_url"] = sync_url

    if config_path.exists():
        existing = json.loads(config_path.read_text(encoding="utf-8"))
        changed = False
        if existing.get("version") != 2:
            existing["version"] = 2
            changed = True
        if str(existing.get("vault")) != str(vault_path):
            existing["vault"] = str(vault_path)
            changed = True
        if sync_url and existing.get("sync_url") != sync_url:
            existing["sync_url"] = sync_url
            changed = True
        if changed:
            config_path.write_text(_json(existing), encoding="utf-8")
            updated += 1
    else:
        config_path.write_text(_json(config), encoding="utf-8")
        created += 1

    if sync_url:
        _ensure_git_remote(vault_path, sync_url)

    return SetupResult(home=home_path, vault=vault_path, created=created, updated=updated)


def normalize_project_id(value: str) -> str:
    raw = value.strip()
    host = ""
    path = ""

    if raw.startswith("git@") and ":" in raw:
        user_host, path = raw.split(":", 1)
        host = user_host.split("@", 1)[1]
    elif "://" in raw:
        parsed = urlparse(raw)
        host = parsed.hostname or parsed.netloc
        path = parsed.path
    else:
        parsed = urlparse(raw)
        if parsed.scheme and parsed.netloc:
            host = parsed.netloc
            path = parsed.path
        else:
            return _safe_project_id(raw)

    path = path.strip("/")
    if path.endswith(".git"):
        path = path[:-4]
    parts = [host.lower(), *[part for part in path.split("/") if part]]
    return _safe_project_id("__".join(parts))


def install_skill(skills_home: Path | str | None = None) -> InstallSkillResult:
    home_path = (
        Path(skills_home).expanduser().resolve()
        if skills_home
        else (Path.home() / ".agents" / "skills").resolve()
    )
    skill_dir = home_path / "agent-handoff"
    skill_dir.mkdir(parents=True, exist_ok=True)
    path = skill_dir / "SKILL.md"
    content = resources.files("agent_handoff.resources").joinpath(
        "agent-handoff.SKILL.md"
    ).read_text(encoding="utf-8")
    updated = not path.exists() or path.read_text(encoding="utf-8") != content
    if updated:
        path.write_text(content, encoding="utf-8")
    return InstallSkillResult(path=path, updated=updated)


def init_repo(
    root: Path | str = ".",
    *,
    home: Path | str | None = None,
    project_id: str | None = None,
    branch: str | None = None,
    clients: list[str] | tuple[str, ...] | None = None,
) -> InitResult:
    root_path = Path(root).resolve()
    setup = setup_home(home)
    pid = derive_project_id(root_path, project_id=project_id)
    branch_name = branch or current_branch(root_path)
    selected_clients = _normalize_clients(clients)
    created = 0
    updated = 0

    bootstrap_path = root_path / BOOTSTRAP_FILE
    bootstrap_contents = (
        f"version: 2\nproject_id: {pid}\nclients: {','.join(selected_clients)}\n"
    )
    if not bootstrap_path.exists():
        bootstrap_path.write_text(bootstrap_contents, encoding="utf-8")
        created += 1
    else:
        data = _read_bootstrap(bootstrap_path)
        existing_clients = _clients_from_bootstrap(data)
        if (
            data.get("project_id") != pid
            or data.get("version") != "2"
            or existing_clients != selected_clients
        ):
            bootstrap_path.write_text(bootstrap_contents, encoding="utf-8")
            updated += 1

    for filename in _client_instruction_files(selected_clients):
        changed, was_created = _ensure_managed_block(root_path / filename)
        if changed:
            if was_created:
                created += 1
            else:
                updated += 1

    project_path = _vault_project_path(setup.vault, pid)
    project_created = _ensure_project_files(project_path, branch_name)
    created += project_created

    return InitResult(
        created=created,
        updated=updated,
        root=root_path,
        project_id=pid,
        vault_project=project_path,
        clients=selected_clients,
    )


def derive_project_id(root: Path | str = ".", *, project_id: str | None = None) -> str:
    root_path = Path(root).resolve()
    if project_id:
        return _coerce_project_id(project_id)

    bootstrap_path = root_path / BOOTSTRAP_FILE
    if bootstrap_path.exists():
        data = _read_bootstrap(bootstrap_path)
        if data.get("project_id"):
            return _coerce_project_id(data["project_id"])

    remote = _git_output(root_path, ["remote", "get-url", "origin"])
    if remote:
        return normalize_project_id(remote)

    return _safe_project_id(root_path.name)


def current_branch(root: Path | str = ".") -> str:
    branch = _git_output(Path(root).resolve(), ["branch", "--show-current"])
    return branch or "default"


def build_start_packet(
    root: Path | str = ".",
    *,
    home: Path | str | None = None,
    branch: str | None = None,
    max_checkpoints: int = 5,
) -> str:
    root_path = Path(root).resolve()
    status = get_status(root_path, home=home)
    if not status.initialized:
        raise HandoffError(_status_error(status))

    setup = _load_setup(home)
    pid = status.project_id or derive_project_id(root_path)
    branch_name = branch or current_branch(root_path)
    project_path = _vault_project_path(setup.vault, pid)
    branch_file = project_path / "branches" / f"{_safe_name(branch_name)}.md"

    sections = [
        ("Global Preferences", setup.vault / "global" / "preferences.md"),
        ("Global Lessons", setup.vault / "global" / "lessons.md"),
        ("Project Context", project_path / "project.md"),
        ("Project Preferences", project_path / "preferences.md"),
        ("Project Decisions", project_path / "decisions.md"),
        ("Branch Context", branch_file),
    ]

    lines = [
        "# Agent Handoff Start Packet",
        "",
        f"Project: `{pid}`",
        f"Branch: `{branch_name}`",
        "",
        "Read this packet before making changes. Use it to recover context from "
        "previous Codex and Claude Code sessions.",
    ]
    for title, path in sections:
        lines.extend(_render_section(title, path))

    checkpoint_paths = _latest_checkpoints(project_path, max_checkpoints, branch=branch_name)
    if checkpoint_paths:
        lines.extend(["", "## Recent Checkpoints"])
        for path in checkpoint_paths:
            lines.extend(_render_section(path.name, path, heading_level=3))

    lines.append("")
    return "\n".join(lines)


def write_checkpoint(
    root: Path | str = ".",
    note: str = "",
    *,
    home: Path | str | None = None,
    now: datetime | None = None,
    device: str | None = None,
    agent: str | None = None,
    branch: str | None = None,
) -> CheckpointResult:
    root_path = Path(root).resolve()
    status = get_status(root_path, home=home)
    if not status.initialized:
        raise HandoffError(_status_error(status))
    clean_note = _clean_note(note)
    if not clean_note:
        raise HandoffError("checkpoint note cannot be empty")
    _reject_likely_secret(clean_note)

    setup = _load_setup(home)
    pid = status.project_id or derive_project_id(root_path)
    branch_name = branch or current_branch(root_path)
    created_at = _timestamp(now)
    project_path = _vault_project_path(setup.vault, pid)
    checkpoints = project_path / "checkpoints"
    checkpoints.mkdir(parents=True, exist_ok=True)
    device_name = _safe_name(device or socket.gethostname() or "device")
    agent_name = _safe_name(agent or "agent")
    filename = (
        f"{_compact_timestamp(created_at)}-{device_name}-{agent_name}-"
        f"{_safe_name(branch_name)}.md"
    )
    path = checkpoints / filename
    contents = (
        "# Checkpoint\n\n"
        f"created_at: {created_at}\n"
        f"project_id: {pid}\n"
        f"branch: {branch_name}\n"
        f"device: {device or socket.gethostname() or 'device'}\n"
        f"agent: {agent or 'agent'}\n\n"
        "## Notes\n\n"
        f"{clean_note}\n"
    )
    path.write_text(contents, encoding="utf-8")
    return CheckpointResult(path=path, project_id=pid, branch=branch_name, created_at=created_at)


def learn(
    note: str,
    *,
    home: Path | str | None = None,
    root: Path | str = ".",
    scope: str = "global",
    kind: str = "preference",
    branch: str | None = None,
    now: datetime | None = None,
) -> LearnResult:
    clean_note = _clean_note(note)
    if not clean_note:
        raise HandoffError("learn note cannot be empty")
    _reject_likely_secret(clean_note)
    if scope not in {"global", "project", "branch"}:
        raise HandoffError("learn scope must be 'global', 'project', or 'branch'")
    if kind not in {"preference", "lesson", "decision", "context"}:
        raise HandoffError("learn kind must be 'preference', 'lesson', 'decision', or 'context'")

    setup = setup_home(home)
    path = _learn_target_path(setup, Path(root).resolve(), scope, kind, branch)
    created_at = _timestamp(now)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(f"\n- {created_at}: {clean_note}\n")
    display_kind = kind if scope == "global" else f"{scope} {kind}"
    return LearnResult(path=path, kind=display_kind, created_at=created_at)


def sync_vault(home: Path | str | None = None) -> list[str]:
    setup = _load_setup(home)
    if not (setup.vault / ".git").exists():
        raise HandoffError("vault is not a git repository; run setup --sync first")
    outputs: list[str] = []

    _git_checked(setup.vault, ["add", "-A"])
    staged = subprocess.run(
        ["git", "diff", "--cached", "--quiet"],
        cwd=setup.vault,
        check=False,
    ).returncode != 0
    if staged:
        commit = _git_checked(
            setup.vault,
            [
                "-c",
                "user.name=agent-handoff",
                "-c",
                "user.email=agent-handoff@local",
                "commit",
                "-m",
                "chore: sync agent handoff vault",
            ],
        )
        outputs.append(commit)

    branch = _git_output(setup.vault, ["branch", "--show-current"]) or "main"
    pull = _git_run(setup.vault, ["pull", "--rebase", "--autostash", "origin", branch])
    if pull.returncode != 0 and not _is_empty_remote_pull(pull.stdout):
        raise HandoffError(pull.stdout.strip() or "git pull failed")
    if pull.stdout.strip():
        outputs.append(pull.stdout.strip())

    push = _git_run(setup.vault, ["push", "-u", "origin", branch])
    if push.returncode != 0:
        raise HandoffError(push.stdout.strip() or "git push failed")
    if push.stdout.strip():
        outputs.append(push.stdout.strip())
    return outputs


def get_status(root: Path | str = ".", *, home: Path | str | None = None) -> Status:
    root_path = Path(root).resolve()
    problems: list[str] = []
    project_id: str | None = None

    bootstrap_path = root_path / BOOTSTRAP_FILE
    if not bootstrap_path.exists():
        problems.append(f"{BOOTSTRAP_FILE} is missing")
    else:
        data = _read_bootstrap(bootstrap_path)
        project_id = data.get("project_id")
        if not project_id:
            problems.append(f"{BOOTSTRAP_FILE} is missing project_id")
        clients = _clients_from_bootstrap(data)

    for filename in _client_instruction_files(clients if bootstrap_path.exists() else ("codex", "claude")):
        if not _has_managed_block(root_path / filename):
            problems.append(f"{filename} is missing the managed handoff block")

    config = _read_config(home)
    if not config:
        problems.append("vault config is missing; run agent-handoff setup")
    else:
        vault = Path(config["vault"])
        if not vault.exists():
            problems.append(f"vault directory is missing: {vault}")
        elif project_id:
            project_path = _vault_project_path(vault, project_id)
            if not project_path.exists():
                problems.append(f"vault project is missing: {project_id}")

    return Status(
        initialized=not problems,
        problems=problems,
        root=root_path,
        project_id=project_id,
    )


def doctor(root: Path | str = ".", *, home: Path | str | None = None) -> DoctorReport:
    status = get_status(root, home=home)
    return DoctorReport(
        ok=status.initialized,
        problems=status.problems,
        root=status.root,
        project_id=status.project_id,
    )


def _global_seed_files() -> dict[str, str]:
    return {
        "preferences.md": "# Global Preferences\n\n",
        "lessons.md": "# Global Lessons\n\n",
    }


def _project_seed_files() -> dict[str, str]:
    return {
        "project.md": "# Project Context\n\n",
        "decisions.md": "# Decisions\n\n",
        "preferences.md": "# Project Preferences\n\n",
    }


def _ensure_project_files(project_path: Path, branch: str) -> int:
    created = 0
    for directory in (project_path, project_path / "branches", project_path / "checkpoints"):
        if not directory.exists():
            directory.mkdir(parents=True)
            created += 1
    for filename, contents in _project_seed_files().items():
        path = project_path / filename
        if not path.exists():
            path.write_text(contents, encoding="utf-8")
            created += 1
    branch_path = project_path / "branches" / f"{_safe_name(branch)}.md"
    if not branch_path.exists():
        branch_path.write_text(f"# Branch Context: {branch}\n\n", encoding="utf-8")
        created += 1
    return created


def _learn_target_path(
    setup: SetupResult,
    root: Path,
    scope: str,
    kind: str,
    branch: str | None,
) -> Path:
    if scope == "global":
        if kind not in {"preference", "lesson"}:
            raise HandoffError("global learn kind must be 'preference' or 'lesson'")
        filename = "preferences.md" if kind == "preference" else "lessons.md"
        return setup.vault / "global" / filename

    status = get_status(root, home=setup.home)
    if not status.initialized:
        raise HandoffError(_status_error(status))
    pid = status.project_id or derive_project_id(root)
    project_path = _vault_project_path(setup.vault, pid)

    if scope == "project":
        if kind == "preference":
            return project_path / "preferences.md"
        if kind == "decision":
            return project_path / "decisions.md"
        return project_path / "project.md"

    branch_name = branch or current_branch(root)
    branch_path = project_path / "branches" / f"{_safe_name(branch_name)}.md"
    if not branch_path.exists():
        branch_path.write_text(f"# Branch Context: {branch_name}\n\n", encoding="utf-8")
    return branch_path


def _normalize_clients(clients: list[str] | tuple[str, ...] | None) -> tuple[str, ...]:
    selected = tuple(clients or ("codex", "claude"))
    invalid = [client for client in selected if client not in {"codex", "claude"}]
    if invalid:
        raise HandoffError(f"unsupported client(s): {', '.join(invalid)}")
    deduped: list[str] = []
    for client in selected:
        if client not in deduped:
            deduped.append(client)
    return tuple(deduped)


def _clients_from_bootstrap(data: dict[str, str]) -> tuple[str, ...]:
    raw = data.get("clients")
    if not raw:
        return ("codex", "claude")
    return _normalize_clients(tuple(client.strip() for client in raw.split(",") if client.strip()))


def _client_instruction_files(clients: tuple[str, ...]) -> tuple[str, ...]:
    files: list[str] = []
    if "codex" in clients:
        files.append("AGENTS.md")
    if "claude" in clients:
        files.append("CLAUDE.md")
    return tuple(files)


def _resolve_home(home: Path | str | None) -> Path:
    return Path(home).expanduser().resolve() if home else DEFAULT_HOME.expanduser().resolve()


def _read_config(home: Path | str | None) -> dict[str, object] | None:
    config_path = _resolve_home(home) / CONFIG_FILE
    if not config_path.exists():
        return None
    return json.loads(config_path.read_text(encoding="utf-8"))


def _load_setup(home: Path | str | None) -> SetupResult:
    config = _read_config(home)
    if not config:
        return setup_home(home)
    return SetupResult(
        home=_resolve_home(home),
        vault=Path(str(config["vault"])).expanduser().resolve(),
        created=0,
        updated=0,
    )


def _vault_project_path(vault: Path, project_id: str) -> Path:
    return vault / "projects" / _coerce_project_id(project_id)


def _coerce_project_id(value: str) -> str:
    if "://" in value or value.startswith("git@"):
        return normalize_project_id(value)
    return _safe_project_id(value)


def _safe_project_id(value: str) -> str:
    normalized = value.strip().strip("/")
    if normalized.endswith(".git"):
        normalized = normalized[:-4]
    normalized = normalized.replace("/", "__").replace(":", "__")
    normalized = re.sub(r"[^A-Za-z0-9._-]+", "__", normalized)
    normalized = re.sub(r"__+", "__", normalized).strip("_")
    return normalized or "unknown-project"


def _safe_name(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9._-]+", "__", value.strip())
    normalized = re.sub(r"__+", "__", normalized).strip("_")
    return normalized or "default"


def _read_bootstrap(path: Path) -> dict[str, str]:
    data: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if ":" not in line or line.lstrip().startswith("#"):
            continue
        key, value = line.split(":", 1)
        data[key.strip()] = value.strip().strip("'\"")
    return data


def _managed_block() -> str:
    return (
        f"{MANAGED_BEGIN}\n"
        "Agent handoff is enabled for this repository.\n\n"
        "At the start of a new Codex or Claude Code session, run `agent-handoff sync` "
        "if vault sync is configured, then run:\n\n"
        "```bash\n"
        "agent-handoff start\n"
        "```\n\n"
        "Read the returned packet before making changes.\n\n"
        "Before pausing work, switching devices, or ending a useful session, run:\n\n"
        "```bash\n"
        "agent-handoff checkpoint --note \"<current goal, progress, open questions, next step>\"\n"
        "```\n\n"
        "Then run `agent-handoff sync` if vault sync is configured.\n\n"
        "When the user corrects a stable preference or recurring rule, run "
        "`agent-handoff learn --kind preference --note \"...\"`.\n"
        f"{MANAGED_END}\n"
    )


def _ensure_managed_block(path: Path) -> tuple[bool, bool]:
    block = _managed_block()
    if not path.exists():
        path.write_text(block, encoding="utf-8")
        return True, True

    original = path.read_text(encoding="utf-8")
    if MANAGED_BEGIN in original and MANAGED_END in original:
        before, remainder = original.split(MANAGED_BEGIN, 1)
        _, after = remainder.split(MANAGED_END, 1)
        parts = []
        if before.rstrip():
            parts.append(before.rstrip())
        parts.append(block.rstrip())
        if after.lstrip():
            parts.append(after.lstrip())
        updated = "\n\n".join(parts) + "\n"
    else:
        updated = original.rstrip() + "\n\n" + block

    if updated != original:
        path.write_text(updated, encoding="utf-8")
        return True, False
    return False, False


def _has_managed_block(path: Path) -> bool:
    if not path.exists():
        return False
    contents = path.read_text(encoding="utf-8")
    return MANAGED_BEGIN in contents and MANAGED_END in contents


def _render_section(title: str, path: Path, *, heading_level: int = 2) -> list[str]:
    heading = "#" * heading_level
    if not path.exists():
        return ["", f"{heading} {title}", "", "_Missing._"]
    return ["", f"{heading} {title}", "", path.read_text(encoding="utf-8").rstrip()]


def _latest_checkpoints(project_path: Path, limit: int, *, branch: str | None = None) -> list[Path]:
    checkpoint_dir = project_path / "checkpoints"
    if not checkpoint_dir.exists():
        return []
    paths = sorted(checkpoint_dir.glob("*.md"), key=lambda path: path.name)
    if branch is not None:
        paths = [path for path in paths if _checkpoint_branch(path) == branch]
    return paths[-limit:]


def _checkpoint_branch(path: Path) -> str | None:
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("branch:"):
            return line.split(":", 1)[1].strip()
    return None


def _timestamp(now: datetime | None) -> str:
    value = now or datetime.now(timezone.utc)
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


def _compact_timestamp(timestamp: str) -> str:
    value = timestamp.replace("+00:00", "Z").replace(":", "").replace("-", "")
    return value.replace(".", "")


def _clean_note(note: str) -> str:
    return "\n".join(line.rstrip() for line in note.strip().splitlines()).strip()


def _reject_likely_secret(note: str) -> None:
    if any(pattern.search(note) for pattern in SECRET_PATTERNS):
        raise HandoffError("handoff notes look like they contain a secret; remove it and try again")


def _status_error(status: Status) -> str:
    return "agent handoff is not ready:\n" + "\n".join(f"- {p}" for p in status.problems)


def _json(data: dict[str, object]) -> str:
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n"


def _git_output(root: Path, args: list[str]) -> str | None:
    process = _git_run(root, args, stderr=subprocess.DEVNULL)
    if process.returncode != 0:
        return None
    return process.stdout.strip() or None


def _clone_vault_if_needed(home: Path, vault: Path, sync_url: str) -> bool:
    if (vault / ".git").exists():
        return False
    if vault.exists():
        try:
            next(vault.iterdir())
        except StopIteration:
            vault.rmdir()
        else:
            return False

    clone = _git_run(home, ["clone", sync_url, str(vault)])
    return clone.returncode == 0


def _ensure_git_remote(vault: Path, sync_url: str) -> None:
    if not (vault / ".git").exists():
        subprocess.run(["git", "init"], cwd=vault, check=False, stdout=subprocess.DEVNULL)
        subprocess.run(["git", "branch", "-M", "main"], cwd=vault, check=False, stdout=subprocess.DEVNULL)
    remotes = _git_output(vault, ["remote"])
    if remotes and "origin" in remotes.splitlines():
        subprocess.run(["git", "remote", "set-url", "origin", sync_url], cwd=vault, check=False)
    else:
        subprocess.run(["git", "remote", "add", "origin", sync_url], cwd=vault, check=False)


def _git_run(
    root: Path,
    args: list[str],
    *,
    stderr: int | None = subprocess.STDOUT,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=root,
        text=True,
        stdout=subprocess.PIPE,
        stderr=stderr,
        check=False,
    )


def _git_checked(root: Path, args: list[str]) -> str:
    process = _git_run(root, args)
    if process.returncode != 0:
        raise HandoffError(process.stdout.strip() or f"git {' '.join(args)} failed")
    return process.stdout.strip()


def _is_empty_remote_pull(output: str) -> bool:
    lowered = output.lower()
    return "couldn't find remote ref" in lowered or "could not find remote ref" in lowered
