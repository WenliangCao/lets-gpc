#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
output_dir="$project_dir/dist"
archive="$output_dir/lets-gpc.zip"
verify_dir=$(mktemp -d "${TMPDIR:-/tmp}/lets-gpc-package.XXXXXX")
trap 'rm -rf "$verify_dir"' EXIT HUP INT TERM

mkdir -p "$output_dir"
rm -f "$archive"
cd "$project_dir/extension"
find . -type f -print | LC_ALL=C sort | zip -q -X "$archive" -@
unzip -tq "$archive" >/dev/null
unzip -q "$archive" -d "$verify_dir"

archive_bytes=$(wc -c < "$archive" | tr -d ' ')
if [ "$archive_bytes" -gt 50000 ]; then
  printf 'Package exceeds 50,000 bytes: %s\n' "$archive_bytes" >&2
  exit 1
fi

for script in "$verify_dir"/*.js; do
  node --check "$script"
done
cd "$project_dir"
PACKAGE_EXTENSION_DIR="$verify_dir" node --test tests/manifest.test.js >/dev/null

printf '%s\n' "$archive"
