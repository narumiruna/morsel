#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

mapfile -d '' -t staged < <(git diff --cached --name-only -z --diff-filter=ACMR)
((${#staged[@]})) || exit 0

if ! git diff --quiet -- "${staged[@]}"; then
  echo "Staged files have unstaged changes; stage or revert them before committing." >&2
  exit 1
fi

git diff --cached --check
npx --no-install biome ci .
