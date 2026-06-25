#!/usr/bin/env sh
# Auto-stage any dirty package-lock.json whose sibling package.json is staged,
# keeping lockfiles in sync with their manifests. Invoked by the lefthook
# pre-commit hook as a standalone script so its quoting survives lefthook's
# command parsing on every platform.
set -e

git diff --cached --name-only | grep 'package\.json$' | while IFS= read -r pkg; do
  lockfile="$(dirname "$pkg")/package-lock.json"
  if [ -f "$lockfile" ] && git diff --name-only -- "$lockfile" | grep -q .; then
    git add "$lockfile"
  fi
done
