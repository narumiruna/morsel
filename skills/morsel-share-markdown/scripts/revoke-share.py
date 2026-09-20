# /// script
# requires-python = ">=3.9"
# dependencies = []
# ///

import argparse
import json
import sys
import uuid

from morsel_config import (
    add_config_arguments,
    fail,
    load_config,
    validate_origin,
)
from morsel_transport import quote_curl_config, run_curl


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
    _, status, exit_code, diagnostic = run_curl(
        curl_config, parsed_url, api_key, configured_keys
    )
    if status != "204" or exit_code:
        if diagnostic.strip():
            print("curl: " + diagnostic, file=sys.stderr)
        fail(
            f"revocation not confirmed (HTTP {status}, curl exit {exit_code}); "
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
