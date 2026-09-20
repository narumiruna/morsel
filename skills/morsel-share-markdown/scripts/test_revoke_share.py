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
                body = getattr(self.server, "response_body", b'not found')
                if getattr(self.server, "send_length", False):
                    self.send_header("Content-Length", str(len(body)))
                if getattr(self.server, "redirect", False):
                    self.send_header("Location", "/redirected")
                self.end_headers()
                if status != 204:
                    try:
                        self.wfile.write(body)
                    except (BrokenPipeError, ConnectionResetError):
                        pass

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

    def test_loopback_http_bypasses_proxy(self):
        proxy = http.server.HTTPServer(("127.0.0.1", 0), self.server.RequestHandlerClass)
        self.addCleanup(proxy.server_close)
        threading.Thread(target=proxy.serve_forever, daemon=True).start()
        self.addCleanup(proxy.shutdown)
        self.env.update(
            http_proxy=f"http://127.0.0.1:{proxy.server_port}",
            ALL_PROXY=f"http://127.0.0.1:{proxy.server_port}",
            NO_PROXY="", no_proxy="",
        )
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.requests, [(f"/v1/shares/{SHARE_ID}", "Bearer " + self.key)])

    def test_response_size_is_bounded(self):
        self.server.response_status = 200
        self.server.response_body = b"x" * 131072
        for send_length in (True, False):
            with self.subTest(content_length=send_length):
                self.requests.clear()
                self.server.send_length = send_length
                result = self.run_script()
                self.assertEqual(result.returncode, 1)
                self.assertIn("curl exit 63", result.stderr)
                self.assertEqual(result.stdout, "")
                self.assertEqual(len(self.requests), 1)

    def test_redirects_and_failures_are_not_retried(self):
        for status in (302, 503):
            with self.subTest(status=status):
                self.requests.clear()
                self.server.response_status = status
                self.server.redirect = True
                result = self.run_script()
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, "")
                self.assertIn(f"revocation not confirmed (HTTP {status}", result.stderr)
                self.assertIn("retrying the same administrative UUID is safe", result.stderr)
                self.assertEqual(len(self.requests), 1)

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
