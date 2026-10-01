#!/usr/bin/env bash
# Build the aincode-sandbox image.
#   ainize/sandbox/build.sh [--rebuild-binary] [tag]
# Without --rebuild-binary it uses packages/opencode/dist/opencode-linux-x64/bin/opencode as built last.
# The binary stays on channel "ainize" (it names the database file in every workspace volume); the web UI is
# built as the release ("prod") UI, so it shows no DEV badge.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
tag="aincode-sandbox:latest"
rebuild=0
for a in "$@"; do
  case "$a" in
    --rebuild-binary) rebuild=1 ;;
    *) tag="$a" ;;
  esac
done
bin="$repo/packages/opencode/dist/opencode-linux-x64/bin/opencode"
if [ "$rebuild" = 1 ] || [ ! -x "$bin" ]; then
  (cd "$repo/packages/opencode" && OPENCODE_CHANNEL=ainize OPENCODE_APP_CHANNEL=prod OPENCODE_VERSION="0.0.0-ainize-$(date -u +%Y%m%d%H%M)" bun run script/build.ts --single)
fi
ctx="$(mktemp -d)"
trap 'rm -rf "$ctx"' EXIT
cp "$bin" "$ctx/aincode"
cp "$here"/{Dockerfile,opencode.json,AGENTS.md,entrypoint.mjs,ainize-agents.mjs,gallery-cli.mjs} "$ctx/"
docker build -t "$tag" --label "ainize.aincode.version=$("$bin" --version)" "$ctx"
echo "built $tag ($("$bin" --version))"
