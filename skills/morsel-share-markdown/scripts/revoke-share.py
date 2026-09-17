# /// script
# requires-python = ">=3.9"
# dependencies = []
# ///

import argparse
import json
import subprocess
import sys
import uuid

from morsel_config import (
    add_config_arguments,
    fail,
    load_config,
    quote_curl_config,
    safe_curl_diagnostic,
    validate_origin,
)


def administrative_id(value):
    try:
        share_id = uuid.UUID(value)
    except (AttributeError, ValueError):
        raise argparse.ArgumentTypeError("share ID must be a UUID") from None
    if value.lower() != str(share_id):
        raise argparse.ArgumentTypeError("share ID must be a canonical UUID")
    return str(share_id)


def parse_args():
    parser = argparse.ArgumentParser(
        description="Idempotently revoke one Morsel share by its administrative UUID."
    )
    parser.add_argument("share_id", type=administrative_id, help="Administrative share UUID")
    add_config_arguments(parser)
    return parser.parse_args()


def revoke_share(url, api_key, configured_keys, parsed_url, share_id):
    curl_config = "\n".join(
        [
            "url = " + quote_curl_config(url + "/v1/shares/" + share_id),
            "header = " + quote_curl_config("Authorization: Bearer " + api_key),
            'request = "DELETE"',
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

    _, _, status = result.stdout.rpartition("\n")
    if status != "204" or result.returncode:
        safe_status = status if status.isdigit() and len(status) == 3 else "unknown"
        diagnostic = safe_curl_diagnostic(
            result.stderr,
            {api_key, configured_keys, *configured_keys.split(",")},
        )
        if diagnostic.strip():
            print("curl: " + diagnostic, file=sys.stderr)
        fail(
            f"revocation not confirmed (HTTP {safe_status}, curl exit {result.returncode}); "
            "retrying the same administrative UUID is safe"
        )


def main():
    args = parse_args()
    config = load_config(args)
    url, api_key, parsed_url = validate_origin(config)
    revoke_share(
        url,
        api_key,
        config["MORSEL_API_KEY"],
        parsed_url,
        args.share_id,
    )
    print(json.dumps({"id": args.share_id, "revoked": True}))


if __name__ == "__main__":
    main()
