import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from agent_handoff import core


class InitTests(unittest.TestCase):
    def test_init_creates_handoff_files_and_agent_instructions(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)

            result = core.init_repo(repo)

            self.assertEqual(result.created, 7)
            handoff = repo / ".agent-handoff"
            self.assertTrue((handoff / "project.md").exists())
            self.assertTrue((handoff / "session.md").exists())
            self.assertTrue((handoff / "decisions.md").exists())
            self.assertTrue((handoff / "preferences.md").exists())

            metadata = json.loads((handoff / "index.json").read_text())
            self.assertEqual(metadata["version"], 1)
            self.assertEqual(
                metadata["files"]["session"], ".agent-handoff/session.md"
            )

            agents = (repo / "AGENTS.md").read_text()
            claude = (repo / "CLAUDE.md").read_text()
            self.assertIn("BEGIN AGENT-HANDOFF", agents)
            self.assertIn(".agent-handoff/session.md", agents)
            self.assertIn("BEGIN AGENT-HANDOFF", claude)
            self.assertIn(".agent-handoff/session.md", claude)

    def test_init_is_idempotent_and_preserves_existing_markdown(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            handoff = repo / ".agent-handoff"
            handoff.mkdir()
            (handoff / "session.md").write_text("# Custom Session\n\nKeep this.\n")
            (repo / "AGENTS.md").write_text("# Existing\n\nDo not remove.\n")

            first = core.init_repo(repo)
            second = core.init_repo(repo)

            self.assertGreater(first.created, 0)
            self.assertEqual(second.created, 0)
            self.assertIn("Keep this.", (handoff / "session.md").read_text())
            agents = (repo / "AGENTS.md").read_text()
            self.assertIn("Do not remove.", agents)
            self.assertEqual(agents.count("BEGIN AGENT-HANDOFF"), 1)


class CaptureRestoreTests(unittest.TestCase):
    def test_capture_appends_timestamped_note_and_refreshes_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            core.init_repo(repo)
            now = datetime(2026, 5, 7, 12, 0, tzinfo=timezone.utc)

            core.capture_note(repo, "Parser implemented; CLI tests next.", now=now)

            session = (repo / ".agent-handoff" / "session.md").read_text()
            self.assertIn("## Capture Log", session)
            self.assertIn(
                "- 2026-05-07T12:00:00+00:00: Parser implemented; CLI tests next.",
                session,
            )
            metadata = json.loads(
                (repo / ".agent-handoff" / "index.json").read_text()
            )
            self.assertEqual(metadata["updated_at"], "2026-05-07T12:00:00+00:00")

    def test_restore_packet_includes_handoff_files_in_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            core.init_repo(repo)
            (repo / ".agent-handoff" / "project.md").write_text("# Project\n\nA\n")
            (repo / ".agent-handoff" / "session.md").write_text("# Session\n\nB\n")
            (repo / ".agent-handoff" / "decisions.md").write_text("# Decisions\n\nC\n")
            (repo / ".agent-handoff" / "preferences.md").write_text(
                "# Preferences\n\nD\n"
            )

            packet = core.build_restore_packet(repo)

            project_pos = packet.find(".agent-handoff/project.md")
            session_pos = packet.find(".agent-handoff/session.md")
            decisions_pos = packet.find(".agent-handoff/decisions.md")
            preferences_pos = packet.find(".agent-handoff/preferences.md")
            self.assertLess(project_pos, session_pos)
            self.assertLess(session_pos, decisions_pos)
            self.assertLess(decisions_pos, preferences_pos)
            self.assertIn("# Project\n\nA", packet)
            self.assertIn("# Session\n\nB", packet)


class StatusDoctorTests(unittest.TestCase):
    def test_status_reports_missing_files_before_init(self):
        with tempfile.TemporaryDirectory() as tmp:
            status = core.get_status(Path(tmp))

            self.assertFalse(status.initialized)
            self.assertIn(".agent-handoff/project.md", status.missing_files)
            self.assertIn("AGENTS.md", status.missing_instruction_files)

    def test_doctor_is_ok_after_init_and_reports_instruction_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            core.init_repo(repo)

            healthy = core.doctor(repo)
            self.assertTrue(healthy.ok)
            self.assertEqual(healthy.problems, [])

            (repo / "CLAUDE.md").write_text("# Claude\n\nNo managed block.\n")

            drifted = core.doctor(repo)
            self.assertFalse(drifted.ok)
            self.assertIn("CLAUDE.md is missing the managed handoff block", drifted.problems)


if __name__ == "__main__":
    unittest.main()
