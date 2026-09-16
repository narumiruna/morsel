"""Local-only regression tests for curl transport and dotenv values."""

import http.server
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest

SCRIPT = Path(__file__).with_name("create-share.sh").resolve()


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = {k: v for k, v in os.environ.items() if k not in ("MORSEL_URL", "MORSEL_API_KEY")}
        self.env.update(NO_PROXY="127.0.0.1", no_proxy="127.0.0.1")
        self.requests = []
        requests = self.requests

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                requests.append((self.path, self.headers["Authorization"], body))
                self.send_response(201 if len(body) <= 1114112 else 413)
                response = getattr(self.server, "response", b'{"id":"test","share_url":"https://example.com/#/s/test"}')
                if getattr(self.server, "send_length", False):
                    self.send_header("Content-Length", str(len(response)))
                self.end_headers()
                try:
                    self.wfile.write(response)
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

    def run_script(self, content="# Test", suffix="", key_value=None):
        (self.root / "doc.md").write_text(content, encoding="utf-8")
        (self.root / ".env").write_text(
            f"MORSEL_URL={self.url}{suffix}\nMORSEL_API_KEY={key_value or self.key}\n", encoding="utf-8"
        )
        return subprocess.run([str(SCRIPT), "doc.md"], cwd=self.root, env=self.env,
                              capture_output=True, encoding="utf-8", timeout=30)

    def test_loopback_http_bypasses_proxy(self):
        proxy = http.server.HTTPServer(("127.0.0.1", 0), self.server.RequestHandlerClass)
        self.addCleanup(proxy.server_close)
        threading.Thread(target=proxy.serve_forever, daemon=True).start()
        self.addCleanup(proxy.shutdown)
        self.env.update(http_proxy=f"http://127.0.0.1:{proxy.server_port}",
                        ALL_PROXY=f"http://127.0.0.1:{proxy.server_port}",
                        NO_PROXY="", no_proxy="")
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        # A proxy gets an absolute request target; the origin gets a path.
        self.assertEqual([r[0] for r in self.requests], ["/v1/shares"])

    def test_response_size_is_bounded(self):
        self.server.response = json.dumps({"id": "test", "share_url": "https://example.com/#/s/test", "padding": "x" * 131072}).encode()
        for send_length in (True, False):
            with self.subTest(content_length=send_length):
                self.server.send_length = send_length
                result = self.run_script()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("curl exit 63", result.stderr)
                self.assertEqual(result.stdout, "")

    def test_empty_query_and_fragment_are_rejected(self):
        for suffix in ("?", "#", "/?", "/#"):
            with self.subTest(suffix=suffix):
                self.requests.clear()
                result = self.run_script(suffix=suffix)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("query, or fragment", result.stderr)
                self.assertEqual(self.requests, [])

    def test_line_endings_are_preserved(self):
        content = "# Test\r\n```text\rfirst\r\nsecond\n```\r"
        result = self.run_script(content)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(self.requests[0][2])["content"], content)

    def test_checkout_virtualenv_is_not_used(self):
        # Build a harmless environment whose curl records whether it was selected.
        self.env.pop("VIRTUAL_ENV", None)
        venv = self.root / ".venv"
        subprocess.run(["uv", "venv", "--no-config", str(venv)], check=True,
                       capture_output=True, env=self.env, timeout=30)
        fake = venv / "bin" / "curl"
        fake.write_text("#!/bin/sh\ncat > stolen-config\nexit 99\n")
        fake.chmod(0o755)
        result = self.run_script()
        self.assertFalse((self.root / "stolen-config").exists())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.requests), 1)

    def test_nonlocal_http_is_rejected_before_curl(self):
        fake = self.root / "curl"
        fake.write_text("#!/bin/sh\ncat > unexpected-config\nexit 99\n")
        fake.chmod(0o755)
        self.env["PATH"] = str(self.root) + os.pathsep + self.env["PATH"]
        for host in ("example.com", "192.0.2.1", "localhost.example.com"):
            with self.subTest(host=host):
                self.url = "http://" + host
                result = self.run_script()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("HTTPS", result.stderr)
                self.assertFalse((self.root / "unexpected-config").exists())

    def test_unicode_document_fits_request_limit(self):
        content = "中" * 300000
        result = self.run_script(content)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.requests), 1)
        body = self.requests[0][2]
        self.assertLess(len(body), 1114112)
        self.assertEqual(json.loads(body)["content"], content)

    def test_root_urls_create_only_one_request(self):
        for suffix in ("", "/"):
            with self.subTest(suffix=suffix):
                self.requests.clear()
                result = self.run_script(suffix=suffix)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(len(self.requests), 1)
                self.assertEqual(self.requests[0][0], "/v1/shares")

    def test_non_origin_urls_are_rejected_before_transport(self):
        fake = self.root / "curl"
        fake.write_text("#!/bin/sh\ntouch curl-called\nexit 1\n")
        fake.chmod(0o755)
        self.env["PATH"] = str(self.root) + os.pathsep + self.env["PATH"]
        for suffix in ("/api", "/api/", "//", "/{one,two}", "/[1-2]", "?query=1", "#fragment", "?", "#"):
            with self.subTest(suffix=suffix):
                result = self.run_script(suffix=suffix)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("HTTP(S) origin", result.stderr)
                self.assertFalse((self.root / "curl-called").exists())
                self.assertEqual(self.requests, [])

    def test_dotenv_hash_and_comments(self):
        for value, expected in (
            (self.key + "#suffix", self.key + "#suffix"),
            (self.key + "#suffix # comment", self.key + "#suffix"),
            ('"' + self.key + '#suffix" # comment', self.key + "#suffix"),
            ("'" + self.key + "#suffix' # comment", self.key + "#suffix"),
            (self.key + " # comment", self.key),
        ):
            with self.subTest(value=value):
                result = self.run_script(key_value=value)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.requests[-1][1], "Bearer " + expected)

    def test_transport_error_is_bounded_and_redacted(self):
        # A curl double supplies hostile stderr without contacting a remote host.
        fake = self.root / "curl"
        fake.write_text("#!/bin/sh\ncat >/dev/null\nprintf '%s' \"$FAKE_ERROR\" >&2\nprintf 'secret-response-body\\n000'\nexit 60\n")
        fake.chmod(0o755)
        self.env["PATH"] = str(self.root) + os.pathsep + self.env["PATH"]
        self.env["FAKE_ERROR"] = "TLS certificate failed " + self.key + "\x1b[31m\n" + "x" * 2000
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("TLS certificate failed", result.stderr)
        self.assertIn("[REDACTED]", result.stderr)
        self.assertNotIn(self.key, result.stderr)
        self.assertNotIn("\x1b", result.stderr)
        self.assertNotIn("secret-response-body", result.stderr + result.stdout)
        self.assertLess(len(result.stderr), 1300)
        self.assertEqual(self.requests, [])


if __name__ == "__main__":
    unittest.main()
