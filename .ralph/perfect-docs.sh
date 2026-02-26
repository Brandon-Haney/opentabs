#!/bin/bash
# perfect-docs.sh — Invoke Claude to audit docs/ and create PRD(s) to sync them with the codebase.
#
# Usage: bash .ralph/perfect-docs.sh
#
# This script launches a single Claude session (default model) that:
#   1. Reads the current platform source code and docs content
#   2. Identifies docs that are outdated, inaccurate, or missing coverage
#   3. Uses the ralph skill to generate PRD(s) targeting the docs project
#
# The ralph daemon (.ralph/ralph.sh) must be running to pick up the PRDs.
# This script does NOT start ralph — it only creates the PRD files.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

read -r -d '' PROMPT <<'PROMPT_EOF' || true
You are auditing the OpenTabs documentation site (docs/) to ensure it accurately reflects the current codebase. Your job is to identify gaps, inaccuracies, and outdated content, then use the ralph skill to create PRDs to fix them.

## Step 1: Read the rules and understand the codebase

1. Read docs/CLAUDE.md — docs project conventions, tech stack, design rules
2. Read CLAUDE.md (root) — overall platform architecture, key concepts, commands
3. Read these package-level CLAUDE.md files for authoritative descriptions of each package's public API, conventions, and architecture:
   - platform/plugin-sdk/CLAUDE.md
   - platform/mcp-server/CLAUDE.md
   - platform/browser-extension/CLAUDE.md
   - platform/cli/CLAUDE.md
   - platform/plugin-tools/CLAUDE.md

These CLAUDE.md files are the source of truth. If the docs contradict a CLAUDE.md, the docs are wrong.

## Step 2: Discover all documentation pages

List all .mdx files under docs/content/docs/ to find every documentation page. Do NOT assume a fixed list — discover them dynamically so you catch any new pages that need auditing or any pages that may have been removed but are still linked.

## Step 3: Audit the documentation against the source code

Systematically compare what the docs say against what the code actually does. For each documentation page, read the corresponding source code and check for:

- **Outdated API signatures** — tool parameters, resource URIs, prompt schemas that have changed in the source but not in the docs
- **Missing features** — new tools, resources, prompts, CLI commands, config options, SDK utilities that exist in the code but are not documented
- **Incorrect behavior descriptions** — docs that describe how something works but the implementation has changed
- **Stale code examples** — example code that would not work against the current API
- **Missing pages** — entire features or concepts that have no documentation page at all
- **Broken cross-references** — links to pages, sections, or code that no longer exist

### Audit priority order (highest-churn pages first):

1. **SDK Reference** (sdk/*.mdx) — compare every documented function signature, parameter, return type, and example against platform/plugin-sdk/src/ exports. These go stale the fastest.
2. **CLI Reference** (reference/cli.mdx) — compare every documented command, flag, and example against platform/cli/src/commands/. Also check platform/plugin-tools/src/ for the plugin developer CLI.
3. **Configuration** (reference/configuration.mdx) — compare documented config schema against platform/mcp-server/src/config.ts and platform/cli/src/config.ts.
4. **Guides** (guides/*.mdx) — check code examples and described behavior against the actual implementation.
5. **Architecture and MCP server** (contributing/architecture.mdx, reference/mcp-server.mdx) — compare against platform/mcp-server/src/ structure and the root CLAUDE.md architecture description.
6. **Browser tools** (reference/browser-tools.mdx) — compare against platform/mcp-server/src/browser-tools/ and platform/browser-extension/src/.
7. **Root pages and install** (index.mdx, quick-start.mdx, first-plugin.mdx, install/index.mdx) — check that installation steps, quick start flow, and first plugin tutorial still work.
8. **Contributing** (contributing/*.mdx) — compare dev-setup instructions against root package.json scripts and CLAUDE.md commands.

### Source code to read:

For each docs page, read the actual source files it documents. Key entry points:

- platform/plugin-sdk/src/index.ts — all SDK exports (the public API surface)
- platform/plugin-sdk/src/*.ts — individual module implementations (errors, dom, fetch, storage, timing, log, page-state)
- platform/mcp-server/src/config.ts — config schema and defaults
- platform/mcp-server/src/browser-tools/ — browser tool implementations
- platform/mcp-server/src/mcp-setup.ts — MCP tool/resource/prompt registration
- platform/mcp-server/src/mcp-tool-dispatch.ts — tool dispatch pipeline
- platform/cli/src/cli.ts — CLI command definitions
- platform/cli/src/commands/ — individual CLI command implementations
- platform/plugin-tools/src/cli.ts — plugin developer CLI commands
- platform/create-plugin/src/index.ts — scaffolding CLI

Read the actual function signatures, exported types, and Zod schemas to compare against what the docs claim.

## Step 4: Create PRD(s) using the ralph skill

After completing the audit, use the skill tool to load the "ralph" skill, then follow its instructions to create PRD(s) for the docs project.

Key parameters for docs PRDs:
- Target project: "OpenTabs Docs"
- workingDirectory: "docs"
- qualityChecks: "cd docs && bun run build && bun run type-check && bun run lint && bun run knip && bun run format:check"
- All stories: e2eCheckpoint: false (docs has no E2E tests)
- Always use small stories (1-3 files per story)
- Include repo-root-relative file paths in the notes field
- Every story must have concrete, verifiable acceptance criteria
- Skip clarifying questions — this prompt provides all the context needed

Do NOT create stories for:
- Cosmetic preferences or stylistic rewording that does not fix an inaccuracy
- Content that is already correct and up-to-date
- Adding documentation for internal implementation details that users/plugin developers do not need

DO create stories for:
- Incorrect or outdated API documentation
- Missing documentation for public features
- Code examples that would fail against the current API
- Stale configuration options or CLI flags
- Architectural descriptions that no longer match reality
PROMPT_EOF

echo "=== perfect-docs.sh ==="
echo "Launching Claude to audit docs/ and create PRD(s)..."
echo ""

echo "$PROMPT" | bash "$SCRIPT_DIR/run-prompt.sh"
