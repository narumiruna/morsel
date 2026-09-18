# /// script
# requires-python = ">=3.9"
# dependencies = []
# ///

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
import unicodedata
from urllib.parse import urlsplit

from morsel_config import (
    add_config_arguments,
    fail,
    load_config,
    quote_curl_config,
    safe_curl_diagnostic,
    validate_origin,
)


PREVIEW_LIMITS = {"title": 80, "description": 200}
PREVIEW_IMAGE_LIMIT = 2048
PREVIEW_LOCALE_PATTERN = re.compile(r"[a-z]{2,3}_[A-Z]{2}\Z")


def parse_args():
    parser = argparse.ArgumentParser(
        description="Create one Morsel share using curl; never retries or consumes a view."
    )
    parser.add_argument("markdown", type=Path, help="UTF-8 Markdown file")
    add_config_arguments(parser)
    parser.add_argument("--expires-in", type=int, help="Lifetime in seconds")
    parser.add_argument("--max-views", type=int, help="Maximum successful retrievals")
    parser.add_argument("--preview-title", help="Plain-text Open Graph title")
    parser.add_argument("--preview-description", help="Plain-text Open Graph description")
    parser.add_argument("--preview-image", help="Optional absolute HTTP(S) Open Graph image URL")
    parser.add_argument("--preview-locale", help="Optional Open Graph locale, such as zh_TW")
    args = parser.parse_args()
    if args.expires_in is not None and not 1 <= args.expires_in <= 315360000:
        parser.error("--expires-in must be between 1 and 315360000")
    if args.max_views is not None and args.max_views < 1:
        parser.error("--max-views must be positive")
    if (args.preview_title is None) != (args.preview_description is None):
        parser.error("--preview-title and --preview-description must be provided together")
    if args.preview_title is None and (args.preview_image is not None or args.preview_locale is not None):
        parser.error("--preview-image and --preview-locale require title and description")
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
    if args.preview_image is not None:
        args.preview_image = args.preview_image.strip()
        if not args.preview_image:
            parser.error("--preview-image must not be empty")
        if len(args.preview_image) > PREVIEW_IMAGE_LIMIT:
            parser.error(f"--preview-image must not exceed {PREVIEW_IMAGE_LIMIT} characters")
        if any(character.isspace() or unicodedata.category(character) in ("Cc", "Zl", "Zp") for character in args.preview_image):
            parser.error("--preview-image must not contain whitespace or control characters")
        try:
            parsed_image = urlsplit(args.preview_image)
            has_credentials = parsed_image.username is not None or parsed_image.password is not None
        except ValueError:
            parsed_image = None
            has_credentials = False
        if parsed_image is None or parsed_image.scheme not in ("http", "https") or not parsed_image.netloc or has_credentials:
            parser.error("--preview-image must be an absolute HTTP(S) URL without credentials")
    if args.preview_locale is not None:
        args.preview_locale = args.preview_locale.strip()
        if not PREVIEW_LOCALE_PATTERN.fullmatch(args.preview_locale):
            parser.error("--preview-locale must use language_TERRITORY format")
    return args


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
        if args.preview_image is not None:
            payload["preview"]["image"] = args.preview_image
        if args.preview_locale is not None:
            payload["preview"]["locale"] = args.preview_locale
    return payload


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
        diagnostic = safe_curl_diagnostic(
            result.stderr,
            {api_key, configured_keys, *configured_keys.split(",")},
        )
        if diagnostic.strip():
            print("curl: " + diagnostic, file=sys.stderr)
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
