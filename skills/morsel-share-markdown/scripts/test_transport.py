"""Local-only regression tests for curl transport and dotenv values."""

from contextlib import redirect_stderr
import http.server
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit

SCRIPT = Path(__file__).with_name("create-share.py").resolve()


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
                status = getattr(self.server, "response_status", 201 if len(body) <= 1114112 else 413)
                self.send_response(status)
                if getattr(self.server, "redirect", False):
                    self.send_header("Location", "/redirected")
                response = getattr(self.server, "response", None)
                if response is None:
                    payload = json.loads(body)
                    metadata = {"id": "test", "share_url": "https://example.com/#/s/test"}
                    if "preview" in payload:
                        metadata["preview"] = payload["preview"]
                    response = json.dumps(metadata).encode()
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

    def run_script(self, content="# Test", suffix="", key_value=None, flags=()):
        (self.root / "doc.md").write_text(content, encoding="utf-8")
        (self.root / ".env").write_text(
            f"MORSEL_URL={self.url}{suffix}\nMORSEL_API_KEY={key_value or self.key}\n", encoding="utf-8"
        )
        return subprocess.run(
            [
                "uv", "run", "--no-config", "--script",
                str(SCRIPT), *flags, "doc.md",
            ],
            cwd=self.root, env=self.env, capture_output=True, encoding="utf-8", timeout=30,
        )

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

    def test_redirects_and_failures_are_not_retried(self):
        for status in (302, 503):
            with self.subTest(status=status):
                self.requests.clear()
                self.server.response_status = status
                self.server.redirect = True
                result = self.run_script()
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, "")
                self.assertIn(f"creation not confirmed (HTTP {status}", result.stderr)
                self.assertIn("not retried; a share may exist", result.stderr)
                self.assertEqual(len(self.requests), 1)

    def test_empty_query_and_fragment_are_rejected(self):
        for suffix in ("?", "#", "/?", "/#"):
            with self.subTest(suffix=suffix):
                self.requests.clear()
                result = self.run_script(suffix=suffix)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("query, or fragment", result.stderr)
                self.assertEqual(self.requests, [])

    def test_preview_metadata_is_normalized_and_serialized(self):
        result = self.run_script(flags=(
            "--preview-title", "  分享標題  ",
            "--preview-description", "  Safe <summary> & details.  ",
            "--preview-image", "  https://cdn.example/preview.png?a=1&b=2  ",
            "--preview-locale", "  zh_TW  ",
        ))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(self.requests[0][2])["preview"], {
            "title": "分享標題",
            "description": "Safe <summary> & details.",
            "image": "https://cdn.example/preview.png?a=1&b=2",
            "locale": "zh_TW",
        })

    def test_preview_response_must_echo_metadata(self):
        self.server.response = b'{"id":"test","share_url":"https://example.com/s/test"}'
        result = self.run_script(flags=(
            "--preview-title", "title",
            "--preview-description", "description",
        ))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("invalid share metadata", result.stderr)

    def test_invalid_preview_metadata_stops_before_transport(self):
        cases = (
            ("unpaired", ("--preview-title", "title")),
            ("blank", ("--preview-title", " ", "--preview-description", "description")),
            ("control", ("--preview-title", "title", "--preview-description", "line\nline")),
            ("line separator", ("--preview-title", "title\u2028line", "--preview-description", "description")),
            ("long title", ("--preview-title", "界" * 81, "--preview-description", "description")),
            ("long description", ("--preview-title", "title", "--preview-description", "界" * 201)),
            ("image without preview", ("--preview-image", "https://cdn.example/preview.png")),
            ("relative image", ("--preview-title", "title", "--preview-description", "description", "--preview-image", "/preview.png")),
            ("image without hostname", ("--preview-title", "title", "--preview-description", "description", "--preview-image", "https://:443/preview.png")),
            ("image credentials", ("--preview-title", "title", "--preview-description", "description", "--preview-image", "https://user:secret@example.com/preview.png")),
            ("image zero port", ("--preview-title", "title", "--preview-description", "description", "--preview-image", "https://example.com:0/preview.png")),
            ("image out-of-range port", ("--preview-title", "title", "--preview-description", "description", "--preview-image", "https://example.com:99999/preview.png")),
            ("image whitespace", ("--preview-title", "title", "--preview-description", "description", "--preview-image", "https://example.com/a b.png")),
            ("invalid locale", ("--preview-title", "title", "--preview-description", "description", "--preview-locale", "zh-tw")),
        )
        for name, flags in cases:
            with self.subTest(name=name):
                self.requests.clear()
                result = self.run_script(flags=flags)
                self.assertNotEqual(result.returncode, 0)
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


class CurlInvocationTests(unittest.TestCase):
    """Characterize the same security policy through both CLI operations."""

    @classmethod
    def setUpClass(cls):
        cls.operations = {
            "create": runpy.run_path(str(SCRIPT))["create_share"],
            "revoke": runpy.run_path(str(SCRIPT.with_name("revoke-share.py")))["revoke_share"],
        }

    def invoke(self, operation, url="https://morsel.example"):
        argument = (
            {"content": "# 文\r\n"} if operation == "create"
            else "123e4567-e89b-12d3-a456-426614174000"
        )
        return self.operations[operation](
            url, "first-key", "first-key, second-key", urlsplit(url), argument
        )

    def test_fixed_options_and_stdin_credentials(self):
        for operation in self.operations:
            for url in ("http://127.0.0.1:1234", "https://morsel.example"):
                with self.subTest(operation=operation, url=url):
                    output = (
                        '{"id":"id","share_url":"https://morsel.example/#/s/token"}\n201'
                        if operation == "create" else "\n204"
                    )
                    result = subprocess.CompletedProcess([], 0, output, "ignored success diagnostic")
                    stderr = io.StringIO()
                    with patch("subprocess.run", return_value=result) as run, redirect_stderr(stderr):
                        self.invoke(operation, url)
                    expected = [
                        "curl", "--disable", "--globoff", "--silent", "--show-error",
                        "--fail-with-body", "--connect-timeout", "10", "--max-time", "40",
                        "--proto", "=http,https", "--max-filesize", "65536",
                    ]
                    if url.startswith("http:"):
                        expected.extend(["--noproxy", "*"])
                    expected.extend(["--write-out", "\n%{http_code}", "--config", "-"])
                    run.assert_called_once()
                    self.assertEqual(run.call_args.args, (expected,))
                    options = run.call_args.kwargs.copy()
                    config = options.pop("input")
                    self.assertEqual(
                        options, {"encoding": "utf-8", "errors": "replace", "capture_output": True}
                    )
                    self.assertIn('header = "Authorization: Bearer first-key"', config)
                    self.assertNotIn("second-key", config)
                    if operation == "create":
                        self.assertIn('header = "Content-Type: application/json"', config)
                        self.assertIn('data-binary = ', config)
                    else:
                        self.assertIn('request = "DELETE"', config)
                        self.assertNotIn("data-binary", config)
                    self.assertEqual(stderr.getvalue(), "")

    def test_missing_curl(self):
        for operation in self.operations:
            with self.subTest(operation=operation):
                stderr = io.StringIO()
                with patch("subprocess.run", side_effect=FileNotFoundError) as run:
                    with redirect_stderr(stderr), self.assertRaises(SystemExit) as raised:
                        self.invoke(operation)
                self.assertEqual(raised.exception.code, 1)
                self.assertEqual(stderr.getvalue(), "Error: curl is required\n")
                run.assert_called_once()

    def test_failed_status_diagnostics(self):
        for operation in self.operations:
            success_status = "201" if operation == "create" else "204"
            cases = (
                ("invalid", 0, "unknown"), ("", 60, "unknown"),
                ("503", 22, "503"), (success_status, 63, success_status),
            )
            for status, exit_code, safe_status in cases:
                with self.subTest(operation=operation, status=status, exit_code=exit_code):
                    result = subprocess.CompletedProcess(
                        [], exit_code, "secret-response-body\n" + status,
                        "TLS failed first-key, second-key\x1b[31m\n" + "x" * 2000,
                    )
                    stderr = io.StringIO()
                    with patch("subprocess.run", return_value=result) as run:
                        with redirect_stderr(stderr), self.assertRaises(SystemExit) as raised:
                            self.invoke(operation)
                    self.assertEqual(raised.exception.code, 1)
                    run.assert_called_once()
                    diagnostic = stderr.getvalue()
                    self.assertIn(f"HTTP {safe_status}, curl exit {exit_code}", diagnostic)
                    self.assertIn("[REDACTED]", diagnostic)
                    for secret in ("first-key", "second-key", "secret-response-body", "\x1b"):
                        self.assertNotIn(secret, diagnostic)
                    self.assertLess(len(diagnostic), 1300)
                    message = (
                        "not retried; a share may exist if transmission occurred"
                        if operation == "create" else "retrying the same administrative UUID is safe"
                    )
                    self.assertIn(message, diagnostic)


if __name__ == "__main__":
    unittest.main()
