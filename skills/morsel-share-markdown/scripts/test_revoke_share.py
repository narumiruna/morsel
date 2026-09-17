"""Local-only tests for the Morsel revoke script."""

import http.server
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest


SCRIPT = Path(__file__).with_name("revoke-share.py").resolve()
SHARE_ID = "123e4567-e89b-12d3-a456-426614174000"


class RevokeShareTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = {
            key: value
            for key, value in os.environ.items()
            if key not in ("MORSEL_URL", "MORSEL_API_KEY")
        }
        self.env.update(NO_PROXY="127.0.0.1", no_proxy="127.0.0.1")
        self.requests = []
        requests = self.requests

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_DELETE(self):
                requests.append((self.path, self.headers.get("Authorization")))
                status = getattr(self.server, "response_status", 204)
                self.send_response(status)
                self.end_headers()
                if status != 204:
                    self.wfile.write(getattr(self.server, "response_body", b'not found'))

            def log_message(self, *args):
                pass

        self.server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        self.addCleanup(self.server.server_close)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.shutdown)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.key = "test-key-" + "x" * 32
        (self.root / ".env").write_text(
            f"MORSEL_URL={self.url}\nMORSEL_API_KEY={self.key}\n",
            encoding="utf-8",
        )

    def run_script(self, share_id=SHARE_ID, flags=()):
        return subprocess.run(
            [
                "uv",
                "run",
                "--no-config",
                "--script",
                str(SCRIPT),
                *flags,
                share_id,
            ],
            cwd=self.root,
            env=self.env,
            capture_output=True,
            encoding="utf-8",
            timeout=30,
        )

    def test_revokes_by_administrative_uuid(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            self.requests,
            [(f"/v1/shares/{SHARE_ID}", "Bearer " + self.key)],
        )
        self.assertEqual(json.loads(result.stdout), {"id": SHARE_ID, "revoked": True})

    def test_repeated_revoke_is_safe(self):
        for _ in range(2):
            result = self.run_script()
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.requests), 2)

    def test_invalid_uuid_stops_before_configuration_or_curl(self):
        (self.root / ".env").unlink()
        fake = self.root / "curl"
        fake.write_text("#!/bin/sh\ntouch curl-called\nexit 99\n")
        fake.chmod(0o755)
        self.env["PATH"] = str(self.root) + os.pathsep + self.env["PATH"]
        result = self.run_script("not-a-uuid")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("share ID must be a UUID", result.stderr)
        self.assertFalse((self.root / "curl-called").exists())
        self.assertEqual(self.requests, [])

    def test_requires_http_204_without_echoing_response_or_key(self):
        self.server.response_status = 404
        self.server.response_body = (self.key + " secret response").encode()
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("HTTP 404", result.stderr)
        self.assertIn("retrying the same administrative UUID is safe", result.stderr)
        self.assertNotIn(self.key, result.stdout + result.stderr)
        self.assertNotIn("secret response", result.stdout + result.stderr)

    def test_environment_source_and_first_comma_separated_key(self):
        (self.root / ".env").unlink()
        self.env.update(
            MORSEL_URL=self.url,
            MORSEL_API_KEY="first-key, second-key",
        )
        result = self.run_script(flags=("--environment",))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.requests[0][1], "Bearer first-key")


if __name__ == "__main__":
    unittest.main()
