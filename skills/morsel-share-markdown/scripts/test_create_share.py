"""Run with: uv run --no-project python -m unittest discover -s skills/morsel-share-markdown/scripts -p 'test_*.py'."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("create-share.py")


class ConfigurationTests(unittest.TestCase):
    def test_source_selection(self):
        cases = [
            ("url only", {"MORSEL_URL": "https://env.example"}, [], "MORSEL_API_KEY", None),
            ("key only", {"MORSEL_API_KEY": "env-key"}, [], "MORSEL_URL", None),
            ("empty url", {"MORSEL_URL": ""}, [], "MORSEL_URL", None),
            ("empty key", {"MORSEL_API_KEY": ""}, [], "MORSEL_API_KEY", None),
            ("complete environment", {"MORSEL_URL": "https://env.example", "MORSEL_API_KEY": "env-key"}, [], None, "env.example"),
            ("default dotenv", {}, [], None, "file.example"),
            ("explicit dotenv", {"MORSEL_URL": "https://env.example"}, ["--env-file", ".env"], None, "file.example"),
            ("explicit environment", {}, ["--environment"], "MORSEL_URL", None),
        ]
        for label, config, flags, error, host in cases:
            with self.subTest(label=label), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / "doc.md").write_text("# Test\n")
                (root / ".env").write_text("MORSEL_URL=https://file.example\nMORSEL_API_KEY=file-key\n")
                # A recording curl double prevents any network requests.
                curl = root / "curl"
                curl.write_text("#!/bin/sh\ncat > curl-input\nprintf '%s\\n%s' '{\"id\":\"test\",\"share_url\":\"https://file.example/#/s/test\"}' 201\n")
                curl.chmod(0o755)
                env = {k: v for k, v in os.environ.items() if k not in ("MORSEL_URL", "MORSEL_API_KEY")}
                env.update(config)
                env["PATH"] = str(root) + os.pathsep + env["PATH"]
                result = subprocess.run(
                    [
                        "uv", "run", "--no-config", "--script",
                        str(SCRIPT.resolve()), *flags, "doc.md",
                    ],
                    cwd=root, env=env, capture_output=True, text=True, timeout=30,
                )
                recorded = root / "curl-input"
                if error:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(error, result.stderr)
                    self.assertFalse(recorded.exists(), "curl must not run on incomplete configuration")
                else:
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(json.loads(result.stdout)["id"], "test")
                    self.assertIn(host + "/v1/shares", recorded.read_text())
                    self.assertIn("Bearer " + ("env-key" if host == "env.example" else "file-key"), recorded.read_text())
                self.assertNotIn("env-key", result.stdout + result.stderr)
                self.assertNotIn("file-key", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
