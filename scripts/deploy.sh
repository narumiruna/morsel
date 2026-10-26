#!/usr/bin/env bash
# Use only after backup, legacy ownership, and the maintenance window are verified.
set -euo pipefail

: "${MORSEL_IMAGE:?set MORSEL_IMAGE to the built immutable release image}"

# A failed migration or unhealthy replacement must not restart an old server.
trap 'status=$?; if (( status != 0 )); then docker compose "$@" stop morsel || true; fi; exit "$status"' EXIT

docker compose "$@" stop morsel
docker compose "$@" up --detach --wait --wait-timeout 120 postgres
docker compose "$@" run --rm --no-deps migrate
docker compose "$@" up --detach --no-deps --wait --wait-timeout 120 morsel
