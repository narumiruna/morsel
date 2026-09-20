import argparse
import os
from pathlib import Path
import shlex
import sys
from urllib.parse import urlsplit


CONFIG_NAMES = ("MORSEL_URL", "MORSEL_API_KEY")


def fail(message):
    print(f"Error: {message}", file=sys.stderr)
    raise SystemExit(1)


def add_config_arguments(parser: argparse.ArgumentParser):
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--env-file", type=Path, help="Use only this dotenv file")
    source.add_argument(
        "--environment", action="store_true", help="Use only environment variables"
    )


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
