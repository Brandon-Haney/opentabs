#!/bin/bash
# perfect-backend.sh — Invoke Claude to audit backend code and create PRD(s) to fix bugs and improve quality.
#
# Usage: bash .ralph/perfect-backend.sh
#
# This script launches a single Claude session (default model) that:
#   1. Reads all backend platform source code (non-extension side)
#   2. Identifies bugs, resource leaks, missing guards, dead code, and quality issues
#   3. Uses the ralph skill to generate PRD(s) targeting the root monorepo
#
# The ralph daemon (.ralph/ralph.sh) must be running to pick up the PRDs.
# This script does NOT start ralph — it only creates the PRD files.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

read -r -d '' PROMPT <<'PROMPT_EOF' || true
You are auditing the OpenTabs backend code (everything except the browser extension) to find and fix bugs, resource leaks, missing guards, and code quality issues. Your job is to read the source code thoroughly, identify genuine problems with concrete consequences, then use the ralph skill to create PRD(s) to fix them.

## Step 1: Read the rules and understand the codebase

1. Read CLAUDE.md (root) — overall platform architecture, key concepts, commands, code quality rules
2. Read these package-level CLAUDE.md files for authoritative descriptions of each package:
   - platform/mcp-server/CLAUDE.md
   - platform/plugin-sdk/CLAUDE.md
   - platform/cli/CLAUDE.md
   - platform/plugin-tools/CLAUDE.md

These CLAUDE.md files are the source of truth for architecture, conventions, and expected behavior.

## Step 2: Systematically audit all backend source files

Read through ALL source files in each backend package. Do not skim — read every function, every error path, every cleanup handler.

### Packages to audit (in order):

1. **platform/mcp-server/src/** — the MCP server (highest priority, most complex)
2. **platform/plugin-sdk/src/** — the plugin SDK (runs in browser context)
3. **platform/cli/src/** — the user-facing CLI
4. **platform/plugin-tools/src/** — the plugin developer CLI
5. **platform/create-plugin/src/** — the scaffolding CLI
6. **platform/shared/src/** — shared utilities

### What to look for:

- **Bugs**: Incorrect logic, race conditions, wrong return values, unhandled edge cases
- **Resource leaks**: Uncleaned timers, event listeners, unbounded maps/caches, missing cleanup, file descriptor leaks
- **Missing error handling**: Unguarded operations that could crash, missing null checks on edge cases, unhandled promise rejections
- **Dead/unreachable code**: Unused exports, unreachable branches, code that can never execute
- **Missing defensive guards**: Validation gaps, boundary checks, API version checks, transport-level limits not matching application-level limits
- **Architectural inconsistencies with concrete consequences**: Shared state protected in some paths but not others, cleanup done on one code path but not an equivalent one

### What NOT to report:

- **Style preferences** — "I would have written it differently" is not a bug
- **Equivalent alternative approaches** — two valid approaches to the same problem do not make one of them wrong
- **Naming preferences** — unless the name is actively misleading
- **Module organization preferences** — unless the current structure causes a concrete problem

### Validation criteria for each finding:

For each candidate issue, ask yourself:
1. Is this a real problem or a different opinion?
2. Can I articulate a concrete consequence? (runtime crash, data loss, resource leak, security bypass, corrupted output, silent wrong behavior)
3. Is the existing code following a recognized pattern that works correctly?

**Discard any finding that fails this validation.** Only keep issues with concrete, articulable consequences.

## Step 3: Create PRD(s) using the ralph skill

After completing the audit, use the skill tool to load the "ralph" skill, then follow its instructions to create PRD(s).

Key parameters for backend PRDs:
- Target project: "OpenTabs Platform" (root monorepo)
- Do NOT set workingDirectory or qualityChecks (root monorepo uses defaults)
- Split into multiple PRDs by package boundary to allow parallel execution (e.g., one PRD for mcp-server, one for plugin-sdk + plugin-tools, one for shared + cli)
- Stories that touch the same files must be in the same PRD to avoid merge conflicts
- All stories: e2eCheckpoint: false EXCEPT the final story in a PRD that touches browser-observable behavior
- Always use small stories (1-3 files per story)
- Include repo-root-relative file paths and line numbers in the notes field
- Every story must have concrete, verifiable acceptance criteria

Do NOT create stories for:
- Stylistic preferences or alternative-but-equivalent approaches
- Cosmetic rewording of comments or variable names
- Restructuring that does not fix a concrete problem
- Issues that are already correctly handled by the existing code (even if you would do it differently)

DO create stories for:
- Actual bugs or incorrect behavior
- Resource leaks (unbounded caches, uncleaned timers, leaked file descriptors)
- Missing error handling that causes crashes or unhelpful error messages
- Dead or unreachable code
- Missing defensive guards with concrete consequences
- Inconsistent cleanup (done on one code path but not an equivalent one)
- Security gaps (missing validation, transport limits not enforced)
- Race conditions with observable consequences

Skip clarifying questions — this prompt provides all the context needed.
PROMPT_EOF

echo "=== perfect-backend.sh ==="
echo "Launching Claude to audit backend code and create PRD(s)..."
echo ""

echo "$PROMPT" | bash "$SCRIPT_DIR/run-prompt.sh"
