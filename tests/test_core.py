import json
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from agent_handoff import core


class VaultSetupTests(unittest.TestCase):
    def test_setup_home_creates_config_and_global_vault_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / "home"

            result = core.setup_home(home)

            self.assertEqual(result.home, home.resolve())
            self.assertEqual(result.vault, (home / "vault").resolve())
            self.assertTrue((home / "config.json").exists())
            self.assertTrue((home / "vault" / "global" / "preferences.md").exists())
            self.assertTrue((home / "vault" / "global" / "lessons.md").exists())

            config = json.loads((home / "config.json").read_text())
            self.assertEqual(config["version"], 2)
            self.assertEqual(config["vault"], str((home / "vault").resolve()))

    def test_setup_home_with_existing_sync_remote_clones_remote_vault(self):
        with tempfile.TemporaryDirectory() as tmp:
            bare = Path(tmp) / "vault.git"
            home_a = Path(tmp) / "home-a"
            home_b = Path(tmp) / "home-b"
            subprocess.run(["git", "init", "--bare", str(bare)], check=True, stdout=subprocess.PIPE)
            core.setup_home(home_a, sync_url=str(bare))
            core.learn("A device learned this.", home=home_a, kind="lesson")
            core.sync_vault(home_a)

            core.setup_home(home_b, sync_url=str(bare))

            lessons = home_b / "vault" / "global" / "lessons.md"
            self.assertIn("A device learned this.", lessons.read_text())

    def test_normalize_project_id_handles_https_and_ssh_remotes(self):
        self.assertEqual(
            core.normalize_project_id("https://github.com/leantli/agent-handoff.git"),
            "github.com__leantli__agent-handoff",
        )
        self.assertEqual(
            core.normalize_project_id("git@github.com:leantli/agent-handoff.git"),
            "github.com__leantli__agent-handoff",
        )

    def test_install_skill_writes_user_skill(self):
        with tempfile.TemporaryDirectory() as tmp:
            skills_home = Path(tmp) / "skills"

            result = core.install_skill(skills_home)

            self.assertTrue(result.path.exists())
            self.assertIn("agent-handoff start", result.path.read_text())
            self.assertEqual(result.path, (skills_home / "agent-handoff" / "SKILL.md").resolve())


class InitTests(unittest.TestCase):
    def test_init_writes_repo_bootstrap_and_vault_project_not_repo_memory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "repo"
            home = Path(tmp) / "home"
            root.mkdir()

            result = core.init_repo(
                root,
                home=home,
                project_id="github.com__leantli__agent-handoff",
                branch="main",
            )

            self.assertEqual(result.project_id, "github.com__leantli__agent-handoff")
            self.assertTrue((root / ".agent-handoff.yml").exists())
            self.assertFalse((root / ".agent-handoff" / "project.md").exists())

            agents = (root / "AGENTS.md").read_text()
            claude = (root / "CLAUDE.md").read_text()
            self.assertIn("agent-handoff start", agents)
            self.assertIn("agent-handoff checkpoint", agents)
            self.assertIn("agent-handoff start", claude)

            project = (
                home
                / "vault"
                / "projects"
                / "github.com__leantli__agent-handoff"
            )
            self.assertTrue((project / "project.md").exists())
            self.assertTrue((project / "decisions.md").exists())
            self.assertTrue((project / "preferences.md").exists())
            self.assertTrue((project / "branches" / "main.md").exists())

    def test_init_reuses_project_id_from_bootstrap_across_new_directories(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / "home"
            first = Path(tmp) / "first"
            second = Path(tmp) / "second"
            first.mkdir()
            second.mkdir()

            core.init_repo(first, home=home, project_id="github.com__owner__repo")
            (second / ".agent-handoff.yml").write_text(
                "version: 2\nproject_id: github.com__owner__repo\n"
            )

            result = core.init_repo(second, home=home)

            self.assertEqual(result.project_id, "github.com__owner__repo")
            project = home / "vault" / "projects" / "github.com__owner__repo"
            self.assertTrue((project / "project.md").exists())


class StartCheckpointLearnTests(unittest.TestCase):
    def test_start_packet_composes_global_project_branch_and_checkpoints(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "repo"
            home = Path(tmp) / "home"
            root.mkdir()
            core.init_repo(root, home=home, project_id="github.com__owner__repo", branch="main")
            vault_project = home / "vault" / "projects" / "github.com__owner__repo"
            (home / "vault" / "global" / "preferences.md").write_text(
                "# Global Preferences\n\nUse concise answers.\n"
            )
            (vault_project / "project.md").write_text("# Project Context\n\nAPI repo.\n")
            (vault_project / "branches" / "main.md").write_text(
                "# Branch Context\n\nWorking on vault design.\n"
            )
            core.write_checkpoint(
                root,
                "A session learned that repo-local memory is insufficient.",
                home=home,
                now=datetime(2026, 5, 8, 10, 30, tzinfo=timezone.utc),
                agent="codex",
                branch="main",
            )

            packet = core.build_start_packet(root, home=home, branch="main")

            self.assertIn("# Agent Handoff Start Packet", packet)
            self.assertLess(packet.find("Global Preferences"), packet.find("Project Context"))
            self.assertIn("Working on vault design.", packet)
            self.assertIn("repo-local memory is insufficient", packet)

    def test_start_packet_filters_recent_checkpoints_to_current_branch(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "repo"
            home = Path(tmp) / "home"
            root.mkdir()
            core.init_repo(root, home=home, project_id="github.com__owner__repo", branch="main")
            core.write_checkpoint(
                root,
                "Main branch checkpoint.",
                home=home,
                now=datetime(2026, 5, 8, 10, 30, tzinfo=timezone.utc),
                agent="codex",
                branch="main",
            )
            core.write_checkpoint(
                root,
                "Feature branch checkpoint.",
                home=home,
                now=datetime(2026, 5, 8, 10, 31, tzinfo=timezone.utc),
                agent="codex",
                branch="feature/demo",
            )

            packet = core.build_start_packet(root, home=home, branch="main")

            self.assertIn("Main branch checkpoint.", packet)
            self.assertNotIn("Feature branch checkpoint.", packet)

    def test_checkpoint_writes_timestamped_file_in_vault_project(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "repo"
            home = Path(tmp) / "home"
            root.mkdir()
            core.init_repo(root, home=home, project_id="github.com__owner__repo")

            result = core.write_checkpoint(
                root,
                "Current task is green.",
                home=home,
                now=datetime(2026, 5, 8, 12, 0, tzinfo=timezone.utc),
                device="laptop",
                agent="claude",
                branch="feature/demo",
            )

            self.assertEqual(result.project_id, "github.com__owner__repo")
            self.assertEqual(result.branch, "feature/demo")
            self.assertTrue(result.path.exists())
            self.assertIn("Current task is green.", result.path.read_text())
            self.assertIn("branch: feature/demo", result.path.read_text())

    def test_checkpoint_rejects_likely_secret_notes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "repo"
            home = Path(tmp) / "home"
            root.mkdir()
            core.init_repo(root, home=home, project_id="github.com__owner__repo")

            with self.assertRaises(core.HandoffError):
                core.write_checkpoint(root, "OPENAI_API_KEY=sk-secret", home=home)

    def test_learn_appends_global_preferences_and_lessons(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / "home"
            core.setup_home(home)

            pref = core.learn("Prefer TDD for behavior changes.", home=home, kind="preference")
            lesson = core.learn("Repo-local memory does not cross clones.", home=home, kind="lesson")

            self.assertIn("Prefer TDD", pref.path.read_text())
            self.assertIn("Repo-local memory", lesson.path.read_text())

    def test_learn_rejects_likely_secret_notes(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / "home"
            core.setup_home(home)

            with self.assertRaises(core.HandoffError):
                core.learn("password=hunter2", home=home, kind="lesson")

    def test_learn_can_write_project_and_branch_scoped_memory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "repo"
            home = Path(tmp) / "home"
            root.mkdir()
            core.init_repo(root, home=home, project_id="github.com__owner__repo", branch="main")

            project = core.learn(
                "Use vault-first architecture.",
                home=home,
                root=root,
                scope="project",
                kind="decision",
            )
            branch = core.learn(
                "Main is preparing v0.3.",
                home=home,
                root=root,
                scope="branch",
                kind="context",
                branch="main",
            )

            self.assertIn("vault-first", project.path.read_text())
            self.assertIn("v0.3", branch.path.read_text())

    def test_sync_commits_and_pushes_vault_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            bare = Path(tmp) / "vault.git"
            home = Path(tmp) / "home"
            subprocess.run(["git", "init", "--bare", str(bare)], check=True, stdout=subprocess.PIPE)
            core.setup_home(home, sync_url=str(bare))
            core.learn("Sync should commit vault changes.", home=home, kind="lesson")

            core.sync_vault(home)

            log = subprocess.run(
                ["git", "--git-dir", str(bare), "log", "--oneline"],
                check=True,
                text=True,
                stdout=subprocess.PIPE,
            ).stdout
            self.assertIn("sync agent handoff vault", log)


class StatusDoctorTests(unittest.TestCase):
    def test_status_requires_repo_bootstrap_and_vault_project(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "repo"
            home = Path(tmp) / "home"
            root.mkdir()

            status = core.get_status(root, home=home)

            self.assertFalse(status.initialized)
            self.assertIn(".agent-handoff.yml is missing", status.problems)

            core.init_repo(root, home=home, project_id="github.com__owner__repo")
            status = core.get_status(root, home=home)

            self.assertTrue(status.initialized)
            self.assertEqual(status.problems, [])

    def test_doctor_reports_missing_managed_blocks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "repo"
            home = Path(tmp) / "home"
            root.mkdir()
            core.init_repo(root, home=home, project_id="github.com__owner__repo")
            (root / "CLAUDE.md").write_text("# Drifted\n")

            report = core.doctor(root, home=home)

            self.assertFalse(report.ok)
            self.assertIn("CLAUDE.md is missing the managed handoff block", report.problems)


if __name__ == "__main__":
    unittest.main()
