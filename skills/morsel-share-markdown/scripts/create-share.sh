#!/usr/bin/env bash
set -euo pipefail

# Python handles data only; curl performs the HTTP request.
exec uv run --isolated --no-project --no-config python - "$@" <<'PY'
import argparse
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
from urllib.parse import urlsplit


def fail(message):
    print(f"Error: {message}", file=sys.stderr)
    sys.exit(1)


parser = argparse.ArgumentParser(description="Create one Morsel share using curl; never retries or consumes a view.")
parser.add_argument("markdown", type=Path, help="UTF-8 Markdown file")
source = parser.add_mutually_exclusive_group()
source.add_argument("--env-file", type=Path, help="Use only this dotenv file")
source.add_argument("--environment", action="store_true", help="Use only environment variables")
parser.add_argument("--expires-in", type=int, help="Lifetime in seconds")
parser.add_argument("--max-views", type=int, help="Maximum successful retrievals")
args = parser.parse_args()
if args.expires_in is not None and not 1 <= args.expires_in <= 315360000:
    parser.error("--expires-in must be between 1 and 315360000")
if args.max_views is not None and args.max_views < 1:
    parser.error("--max-views must be positive")

names = ("MORSEL_URL", "MORSEL_API_KEY")
if args.env_file is None and (args.environment or any(n in os.environ for n in names)):
    config = {n: os.environ.get(n, "") for n in names}
else:
    path = args.env_file or Path(".env")
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError):
        fail("cannot read selected dotenv file")
    config = {}
    for line in lines:
        line = line.strip()
        if line.startswith("export "):
            line = line[7:].lstrip()
        name, sep, value = line.partition("=")
        name = name.strip()
        if not sep or name not in names:
            continue
        # A hash starts a comment only outside quotes at a token boundary.
        quoted = None
        escaped = False
        for index, char in enumerate(value):
            if escaped:
                escaped = False
            elif char == "\\" and quoted != "'":
                escaped = True
            elif quoted:
                if char == quoted:
                    quoted = None
            elif char in "\"'":
                quoted = char
            elif char == "#" and (index == 0 or value[index - 1].isspace()):
                value = value[:index]
                break
        try:
            parts = shlex.split(value, comments=False)
        except ValueError:
            fail(f"invalid dotenv quoting for {name}")
        if len(parts) > 1:
            fail(f"invalid dotenv value for {name}")
        config[name] = parts[0] if parts else ""

missing = [n for n in names if not config.get(n, "").strip()]
if missing:
    fail("missing configuration: " + ", ".join(missing))
url = config["MORSEL_URL"].strip().rstrip("/")
key = next((k.strip() for k in config["MORSEL_API_KEY"].split(",") if k.strip()), "")
if not key:
    fail("missing configuration: MORSEL_API_KEY")
if any(ord(c) < 32 or ord(c) == 127 for c in url + key):
    fail("configuration contains control characters")
try:
    parsed = urlsplit(url)
    valid = (parsed.scheme in ("http", "https") and parsed.hostname
             and not parsed.username and not parsed.password
             and "?" not in url and "#" not in url)
    parsed.port  # Validate the port before passing the URL to curl.
except ValueError:
    valid = False
if not valid:
    fail("MORSEL_URL must be an HTTP(S) URL without credentials, query, or fragment")
if parsed.scheme == "http" and parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
    fail("MORSEL_URL must use HTTPS except for localhost, 127.0.0.1, or ::1")

try:
    content = args.markdown.read_bytes().decode("utf-8")
except (OSError, UnicodeError):
    fail("cannot read UTF-8 Markdown file")
payload = {"content": content}
if args.expires_in is not None:
    payload["expires_in"] = args.expires_in
if args.max_views is not None:
    payload["max_views"] = args.max_views


def quote(value):
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'


curl_config = "\n".join([
    "url = " + quote(url + "/v1/shares"),
    "header = " + quote("Authorization: Bearer " + key),
    'header = "Content-Type: application/json"',
    "data-binary = " + quote(json.dumps(payload, ensure_ascii=False)),
])
try:
    result = subprocess.run(
        ["curl", "--disable", "--globoff", "--silent", "--show-error", "--fail-with-body",
         "--connect-timeout", "10", "--max-time", "40", "--proto", "=http,https",
         "--max-filesize", "65536",
         *(["--noproxy", "*"] if parsed.scheme == "http" else []),
         "--write-out", "\n%{http_code}", "--config", "-"],
        input=curl_config, encoding="utf-8", errors="replace", capture_output=True,
    )
except FileNotFoundError:
    fail("curl is required")
body, _, status = result.stdout.rpartition("\n")
if status != "201" or result.returncode:
    # Do not echo intermediary bodies, which could contain credentials.
    safe_status = status if status.isdigit() and len(status) == 3 else "unknown"
    diagnostic = result.stderr
    for secret in sorted({key, config["MORSEL_API_KEY"], *config["MORSEL_API_KEY"].split(",")}, key=len, reverse=True):
        if secret.strip():
            diagnostic = diagnostic.replace(secret.strip(), "[REDACTED]")
    diagnostic = "".join(c if c.isprintable() else " " for c in diagnostic)
    if diagnostic.strip():
        print("curl: " + diagnostic[:1024], file=sys.stderr)
    fail(f"creation not confirmed (HTTP {safe_status}, curl exit {result.returncode}); not retried; a share may exist if transmission occurred")
try:
    response = json.loads(body)
    if not isinstance(response, dict) or not all(
        isinstance(response.get(n), str) and response[n] for n in ("id", "share_url")
    ):
        raise ValueError()
except (ValueError, TypeError):
    fail("HTTP 201 returned invalid share metadata; not retried")
print(json.dumps(response, ensure_ascii=False))
PY
