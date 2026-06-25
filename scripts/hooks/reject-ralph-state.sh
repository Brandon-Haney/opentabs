#!/usr/bin/env sh
# Block Ralph state files from being committed. Invoked by the lefthook
# pre-commit hook as a standalone script so its quoting survives lefthook's
# command parsing on every platform.
set -e

matches=$(git diff --cached --name-only | grep -E '\.ralph/(prd\.json|progress\.txt)$' || true)
if [ -n "$matches" ]; then
  echo "ERROR: Ralph state files must not be committed:"
  echo "$matches"
  echo ""
  echo "Run: git rm --cached <file> to untrack them."
  exit 1
fi
