#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

npx biome migrate --write
npx biome format --write
npx biome check --write
