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

    def test_setup_init_checkpoint_start_flow(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "repo"
            home = Path(tmp) / "home"
            repo.mkdir()

            code, out, err = self.run_cli(repo, "--home", str(home), "setup")
            self.assertEqual(code, 0, err)
            self.assertIn("Agent handoff home", out)

            code, out, err = self.run_cli(
                repo,
                "--home",
                str(home),
                "init",
                "--project-id",
                "github.com__owner__repo",
                "--branch",
                "main",
            )
            self.assertEqual(code, 0, err)
            self.assertIn("Initialized agent handoff", out)
            self.assertTrue((repo / ".agent-handoff.yml").exists())
            self.assertFalse((repo / ".agent-handoff" / "project.md").exists())

            code, out, err = self.run_cli(
                repo,
                "--home",
                str(home),
                "checkpoint",
                "--note",
                "Ready for another device.",
                "--agent",
                "codex",
                "--branch",
                "main",
            )
            self.assertEqual(code, 0, err)
            self.assertIn("Wrote checkpoint", out)

            code, out, err = self.run_cli(
                repo, "--home", str(home), "start", "--branch", "main"
            )
            self.assertEqual(code, 0, err)
            self.assertIn("# Agent Handoff Start Packet", out)
            self.assertIn("Ready for another device.", out)

    def test_learn_writes_global_memory(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "repo"
            home = Path(tmp) / "home"
            repo.mkdir()
            self.run_cli(repo, "--home", str(home), "setup")

            code, out, err = self.run_cli(
                repo,
                "--home",
                str(home),
                "learn",
                "--kind",
                "preference",
                "--note",
                "Prefer branch-aware session files.",
            )

            self.assertEqual(code, 0, err)
            self.assertIn("Learned preference", out)
            self.assertIn(
                "branch-aware",
                (home / "vault" / "global" / "preferences.md").read_text(),
            )

    def test_status_and_doctor_report_not_ready_before_init(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "repo"
            home = Path(tmp) / "home"
            repo.mkdir()

            status_code, status_out, status_err = self.run_cli(
                repo, "--home", str(home), "status"
            )
            self.assertEqual(status_code, 1)
            self.assertIn(".agent-handoff.yml is missing", status_out)
            self.assertEqual(status_err, "")

            doctor_code, doctor_out, doctor_err = self.run_cli(
                repo, "--home", str(home), "doctor"
            )
            self.assertEqual(doctor_code, 1)
            self.assertIn("vault config is missing", doctor_out)
            self.assertEqual(doctor_err, "")

    def test_restore_and_capture_aliases_still_work(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "repo"
            home = Path(tmp) / "home"
            repo.mkdir()
            self.run_cli(
                repo,
                "--home",
                str(home),
                "init",
                "--project-id",
                "github.com__owner__repo",
            )

            code, out, err = self.run_cli(
                repo,
                "--home",
                str(home),
                "capture",
                "--note",
                "Legacy command still checkpoints.",
            )
            self.assertEqual(code, 0, err)
            self.assertIn("Wrote checkpoint", out)

            code, out, err = self.run_cli(repo, "--home", str(home), "restore")
            self.assertEqual(code, 0, err)
            self.assertIn("Legacy command still checkpoints.", out)


if __name__ == "__main__":
    unittest.main()
