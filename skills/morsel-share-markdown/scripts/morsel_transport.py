"""Fixed curl transport policy for the create and revoke scripts."""

import subprocess

from morsel_config import fail


def quote_curl_config(value):
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def safe_curl_diagnostic(diagnostic, secrets):
    for secret in sorted(set(secrets), key=len, reverse=True):
        if secret.strip():
            diagnostic = diagnostic.replace(secret.strip(), "[REDACTED]")
    return "".join(
        character if character.isprintable() else " " for character in diagnostic
    )[:1024]


def run_curl(curl_config, parsed_url, api_key, configured_keys):
    """Return body, safe HTTP status, exit code, and redacted diagnostic; never retry."""
    command = [
        "curl",
        "--disable",
        "--globoff",
        "--silent",
        "--show-error",
        "--fail-with-body",
        "--connect-timeout",
        "10",
        "--max-time",
        "40",
        "--proto",
        "=http,https",
        "--max-filesize",
        "65536",
    ]
    if parsed_url.scheme == "http":
        command.extend(["--noproxy", "*"])
    command.extend(["--write-out", "\n%{http_code}", "--config", "-"])

    try:
        result = subprocess.run(
            command,
            input=curl_config,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
        )
    except FileNotFoundError:
        fail("curl is required")

    body, _, status = result.stdout.rpartition("\n")
    safe_status = status if status.isdigit() and len(status) == 3 else "unknown"
    diagnostic = safe_curl_diagnostic(
        result.stderr, {api_key, configured_keys, *configured_keys.split(",")}
    )
    return body, safe_status, result.returncode, diagnostic
