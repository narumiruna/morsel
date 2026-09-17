# /// script
# requires-python = ">=3.9"
# dependencies = []
# ///

import argparse
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import unicodedata
from urllib.parse import urlsplit


CONFIG_NAMES = ("MORSEL_URL", "MORSEL_API_KEY")
PREVIEW_LIMITS = {"title": 80, "description": 200}


def fail(message):
    print(f"Error: {message}", file=sys.stderr)
    raise SystemExit(1)


def parse_args():
    parser = argparse.ArgumentParser(
        description="Create one Morsel share using curl; never retries or consumes a view."
    )
    parser.add_argument("markdown", type=Path, help="UTF-8 Markdown file")
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--env-file", type=Path, help="Use only this dotenv file")
    source.add_argument(
        "--environment", action="store_true", help="Use only environment variables"
    )
    parser.add_argument("--expires-in", type=int, help="Lifetime in seconds")
    parser.add_argument("--max-views", type=int, help="Maximum successful retrievals")
    parser.add_argument("--preview-title", help="Plain-text Open Graph title")
    parser.add_argument("--preview-description", help="Plain-text Open Graph description")
    args = parser.parse_args()
    if args.expires_in is not None and not 1 <= args.expires_in <= 315360000:
        parser.error("--expires-in must be between 1 and 315360000")
    if args.max_views is not None and args.max_views < 1:
        parser.error("--max-views must be positive")
    if (args.preview_title is None) != (args.preview_description is None):
        parser.error("--preview-title and --preview-description must be provided together")
    for field in PREVIEW_LIMITS:
        option = "--preview-" + field
        raw_value = getattr(args, "preview_" + field)
        value = raw_value.strip() if raw_value is not None else None
        if value is None:
            continue
        if not value:
            parser.error(option + " must not be empty")
        if any(unicodedata.category(character) in ("Cc", "Zl", "Zp") for character in value):
            parser.error(option + " must not contain control or line-separator characters")
        if len(value) > PREVIEW_LIMITS[field]:
            parser.error(f"{option} must not exceed {PREVIEW_LIMITS[field]} characters")
        setattr(args, "preview_" + field, value)
    return args


def read_dotenv(path):
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError):
        fail("cannot read selected dotenv file")

    config = {}
    for line in lines:
        line = line.strip()
        if line.startswith("export "):
            line = line[7:].lstrip()
        name, separator, value = line.partition("=")
        name = name.strip()
        if not separator or name not in CONFIG_NAMES:
            continue

        # A hash starts a comment only outside quotes at a token boundary.
        quoted = None
        escaped = False
        for index, character in enumerate(value):
            if escaped:
                escaped = False
            elif character == "\\" and quoted != "'":
                escaped = True
            elif quoted:
                if character == quoted:
                    quoted = None
            elif character in "\"'":
                quoted = character
            elif character == "#" and (
                index == 0 or value[index - 1].isspace()
            ):
                value = value[:index]
                break
        try:
            parts = shlex.split(value, comments=False)
        except ValueError:
            fail(f"invalid dotenv quoting for {name}")
        if len(parts) > 1:
            fail(f"invalid dotenv value for {name}")
        config[name] = parts[0] if parts else ""
    return config


def load_config(args):
    if args.env_file is None and (
        args.environment or any(name in os.environ for name in CONFIG_NAMES)
    ):
        config = {name: os.environ.get(name, "") for name in CONFIG_NAMES}
    else:
        config = read_dotenv(args.env_file or Path(".env"))

    missing = [name for name in CONFIG_NAMES if not config.get(name, "").strip()]
    if missing:
        fail("missing configuration: " + ", ".join(missing))
    return config


def validate_origin(config):
    url = config["MORSEL_URL"].strip()
    api_key = next(
        (key.strip() for key in config["MORSEL_API_KEY"].split(",") if key.strip()),
        "",
    )
    if not api_key:
        fail("missing configuration: MORSEL_API_KEY")
    if any(ord(character) < 32 or ord(character) == 127 for character in url + api_key):
        fail("configuration contains control characters")

    try:
        parsed = urlsplit(url)
        valid = (
            parsed.scheme in ("http", "https")
            and parsed.hostname
            and parsed.username is None
            and parsed.password is None
            and parsed.path in ("", "/")
            and "?" not in url
            and "#" not in url
        )
        parsed.port
    except ValueError:
        valid = False
    if not valid:
        fail(
            "MORSEL_URL must be an HTTP(S) origin without credentials, path, query, or fragment"
        )
    if parsed.scheme == "http" and parsed.hostname not in (
        "localhost",
        "127.0.0.1",
        "::1",
    ):
        fail("MORSEL_URL must use HTTPS except for localhost, 127.0.0.1, or ::1")
    return url.rstrip("/"), api_key, parsed


def read_payload(args):
    try:
        content = args.markdown.read_bytes().decode("utf-8")
    except (OSError, UnicodeError):
        fail("cannot read UTF-8 Markdown file")

    payload = {"content": content}
    if args.expires_in is not None:
        payload["expires_in"] = args.expires_in
    if args.max_views is not None:
        payload["max_views"] = args.max_views
    if args.preview_title is not None:
        payload["preview"] = {
            "title": args.preview_title,
            "description": args.preview_description,
        }
    return payload


def quote_curl_config(value):
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def create_share(url, api_key, configured_keys, parsed_url, payload):
    curl_config = "\n".join(
        [
            "url = " + quote_curl_config(url + "/v1/shares"),
            "header = " + quote_curl_config("Authorization: Bearer " + api_key),
            'header = "Content-Type: application/json"',
            "data-binary = "
            + quote_curl_config(json.dumps(payload, ensure_ascii=False)),
        ]
    )
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
    if status != "201" or result.returncode:
        # Do not echo intermediary bodies, which could contain credentials.
        safe_status = status if status.isdigit() and len(status) == 3 else "unknown"
        diagnostic = result.stderr
        secrets = {api_key, configured_keys, *configured_keys.split(",")}
        for secret in sorted(secrets, key=len, reverse=True):
            if secret.strip():
                diagnostic = diagnostic.replace(secret.strip(), "[REDACTED]")
        diagnostic = "".join(
            character if character.isprintable() else " " for character in diagnostic
        )
        if diagnostic.strip():
            print("curl: " + diagnostic[:1024], file=sys.stderr)
        fail(
            f"creation not confirmed (HTTP {safe_status}, curl exit {result.returncode}); "
            "not retried; a share may exist if transmission occurred"
        )

    try:
        response = json.loads(body)
        if not isinstance(response, dict) or not all(
            isinstance(response.get(name), str) and response[name]
            for name in ("id", "share_url")
        ):
            raise ValueError
        if "preview" in payload and response.get("preview") != payload["preview"]:
            raise ValueError
    except (ValueError, TypeError):
        fail("HTTP 201 returned invalid share metadata; not retried")
    return response


def main():
    args = parse_args()
    config = load_config(args)
    url, api_key, parsed_url = validate_origin(config)
    payload = read_payload(args)
    response = create_share(
        url, api_key, config["MORSEL_API_KEY"], parsed_url, payload
    )
    print(json.dumps(response, ensure_ascii=False))


if __name__ == "__main__":
    main()
