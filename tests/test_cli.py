import io
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from agent_handoff import cli


class CliTests(unittest.TestCase):
    def run_cli(self, repo: Path, *args: str) -> tuple[int, str, str]:
        stdout = io.StringIO()
        stderr = io.StringIO()
        code = cli.main(list(args), cwd=repo, stdout=stdout, stderr=stderr)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_init_and_restore_flow(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)

            code, out, err = self.run_cli(repo, "init")
            self.assertEqual(code, 0, err)
            self.assertIn("Initialized agent handoff", out)

            code, out, err = self.run_cli(repo, "restore")
            self.assertEqual(code, 0, err)
            self.assertIn("# Agent Handoff Restore Packet", out)
            self.assertIn(".agent-handoff/session.md", out)

    def test_capture_requires_note_and_appends_note(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            self.run_cli(repo, "init")

            code, out, err = self.run_cli(repo, "capture", "--note", "Ready to test.")

            self.assertEqual(code, 0, err)
            self.assertIn("Captured handoff note", out)
            session = (repo / ".agent-handoff" / "session.md").read_text()
            self.assertIn("Ready to test.", session)

    def test_status_and_doctor_return_nonzero_when_not_ready(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)

            status_code, status_out, status_err = self.run_cli(repo, "status")
            self.assertEqual(status_code, 1)
            self.assertIn("Missing files", status_out)
            self.assertEqual(status_err, "")

            doctor_code, doctor_out, doctor_err = self.run_cli(repo, "doctor")
            self.assertEqual(doctor_code, 1)
            self.assertIn(".agent-handoff/project.md is missing", doctor_out)
            self.assertEqual(doctor_err, "")

    def test_doctor_reports_drift_after_init(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            self.run_cli(repo, "init")
            (repo / "AGENTS.md").write_text("# Drifted\n")

            code, out, err = self.run_cli(repo, "doctor")

            self.assertEqual(code, 1)
            self.assertIn("AGENTS.md is missing the managed handoff block", out)
            self.assertEqual(err, "")


if __name__ == "__main__":
    unittest.main()
