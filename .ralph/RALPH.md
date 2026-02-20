# Ralph Agent Instructions

You are an autonomous coding agent. Your work targets a specific project within the OpenTabs repository. The PRD file tells you which project and how to verify your work.

## Your Task

1. Find the active PRD: look for the file in `.ralph/` whose name matches `prd-*~running.json` — there is exactly one at any time
2. Find the matching progress file: replace the `prd-` prefix with `progress-`, strip `~running`, and change the extension to `.txt` (e.g., `prd-2026-02-17-143000-improve-sdk~running.json` → `progress-2026-02-17-143000-improve-sdk.txt`)
3. Read the progress file's Codebase Patterns section first (if it exists)
4. **Read the PRD and determine the target project** (see "Determining Your Target Project" below)
5. **Read the target project's CLAUDE.md** (if one exists) for project-specific conventions and patterns
6. Work on the current branch (do NOT create or switch branches)
7. Pick the **highest priority** user story where `passes: false` — you will implement **only this one story** and then stop
8. Implement that single user story (do NOT continue to the next story after this one)
9. **Run ALL quality checks using the PRD's verification command** (see "Quality Checks" below)
10. **If ANY check fails, fix it before proceeding** — even pre-existing failures. See "Own the Codebase" below.
11. Update CLAUDE.md files if you discover reusable patterns (see below)
12. **Only if ALL checks exit 0**, commit code changes (see Git Rules below)
13. **After committing**, update the PRD to set `passes: true` for the completed story
14. **After committing**, append your progress to the matching progress file
15. **STOP.** Do not pick up another story. Your invocation is done. End your response.

## Determining Your Target Project

This repository contains multiple projects with different build systems and verification suites. The PRD tells you which project you are working on:

### PRD Fields

- **`qualityChecks`** (string, optional): The shell command to run for verification. If present, use this **exactly** instead of any default. Example: `"cd docs && bun run build && bun run type-check && bun run lint && bun run knip"`
- **`workingDirectory`** (string, optional): The subdirectory containing the target project, relative to the repo root. Example: `"docs"` or `"plugins/slack"`

### How to Use These Fields

1. **Read the PRD first.** Before doing any work, read the PRD JSON and check for `qualityChecks` and `workingDirectory`.
2. **If `workingDirectory` is set**, the story targets a standalone subproject. Read that directory's `CLAUDE.md`, `package.json`, and any project-specific configuration to understand its conventions. File paths in story notes are relative to the repo root (e.g., `docs/mdx-components.tsx`), but the project's own tooling runs from within the subdirectory.
3. **If `qualityChecks` is set**, use that command for verification instead of the default suite.
4. **If neither is set**, the story targets the root monorepo. Use the default verification suite and the root `CLAUDE.md` for conventions.

### Known Project Types

| Target                    | `workingDirectory` | Default `qualityChecks`                                                                                   |
| ------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------- |
| Root monorepo (platform/) | _(not set)_        | `bun run build && bun run type-check && bun run lint && bun run knip && bun run test && bun run test:e2e` |
| Docs site                 | `docs`             | `cd docs && bun run build && bun run type-check && bun run lint && bun run knip`                          |
| Plugins                   | `plugins/<name>`   | `cd plugins/<name> && bun run build && bun run type-check && bun run lint`                                |

These are examples. Always trust the PRD's `qualityChecks` field over this table. If the PRD specifies a command, use it verbatim.

## Finding Your Files

The PRD and progress files use a naming convention based on the file name state machine:

```
.ralph/prd-YYYY-MM-DD-HHMMSS-objective~running.json    ← your PRD (read/update this)
.ralph/progress-YYYY-MM-DD-HHMMSS-objective.txt         ← your progress log (append to this)
```

Use a glob pattern to find the active PRD: `.ralph/prd-*~running.json`

## Quality Checks

**The PRD is the source of truth for verification.** Do not assume which commands to run.

1. Read the PRD's `qualityChecks` field
2. If `qualityChecks` is set: run that exact command
3. If `qualityChecks` is NOT set: run the default root monorepo suite:
   ```bash
   bun run build && bun run type-check && bun run lint && bun run knip && bun run test && bun run test:e2e
   ```

**Critical:** Do NOT run the root monorepo's `bun run build` / `bun run type-check` / etc. when working on a standalone subproject. These commands do not cover standalone subprojects and will give you a false green. Conversely, do NOT run a subproject's commands when working on the root monorepo. Always match the verification to the target project as specified in the PRD.

## Progress Report Format

APPEND to the progress file (never replace, always append):

```
## [Date/Time] - [Story ID]
- What was implemented
- Files changed
- **Learnings for future iterations:**
  - Patterns discovered (e.g., "this codebase uses X for Y")
  - Gotchas encountered (e.g., "don't forget to update Z when changing W")
  - Useful context (e.g., "the plugin SDK exports types from X")
---
```

The learnings section is critical — it helps future iterations avoid repeating mistakes and understand the codebase better.

## Consolidate Patterns

If you discover a **reusable pattern** that future iterations should know, add it to the `## Codebase Patterns` section at the TOP of the progress file (create it if it doesn't exist). This section should consolidate the most important learnings:

```
## Codebase Patterns
- Example: Platform packages are in platform/, plugins in plugins/
- Example: Use tsconfig.build.json for each package's build config
- Example: Export types from the package's public API barrel file
```

Only add patterns that are **general and reusable**, not story-specific details.

## Update CLAUDE.md Files

Before committing, check if any edited files have learnings worth preserving in nearby CLAUDE.md files:

1. **Identify directories with edited files** — look at which directories you modified
2. **Check for existing CLAUDE.md** — look for CLAUDE.md in those directories or parent directories
3. **Add valuable learnings** — if you discovered something future developers/agents should know:
   - API patterns or conventions specific to that module
   - Gotchas or non-obvious requirements
   - Dependencies between files
   - Testing approaches for that area
   - Configuration or environment requirements

**Examples of good CLAUDE.md additions:**

- "When modifying X, also update Y to keep them in sync"
- "This module uses pattern Z for all API calls"
- "Field names must match the template exactly"

**Do NOT add:**

- Story-specific implementation details
- Temporary debugging notes
- Information already in the progress file

Only update CLAUDE.md if you have **genuinely reusable knowledge** that would help future work in that directory.

## Own the Codebase — Hard Gate

**You MUST NOT commit code unless ALL quality checks exit 0.** This is a hard gate, not a suggestion.

If quality checks fail — even on code you did not write — you MUST fix them before committing anything. There are NO exceptions:

- "Pre-existing" is not an excuse. Fix it.
- "Flaky test" is not an excuse. Fix the flakiness or make the test deterministic.
- "Timing-related" is not an excuse. Add proper waits, retries, or fix the race condition.
- "Not related to my story" is not an excuse. Fix it in a separate commit before your story commit.
- "Works on re-run" is not an excuse. If it fails once, it's broken. Fix the root cause.

If you cannot fix the failing check within your iteration, do NOT commit your story. Leave it as `passes: false` and document what's blocking in the progress file. A committed story with failing checks is worse than an uncommitted story — it poisons the codebase for all future iterations.

**The verification command must exit 0 end-to-end.** Use the PRD's `qualityChecks` field if set, otherwise use the default:

```bash
bun run build && bun run type-check && bun run lint && bun run knip && bun run test && bun run test:e2e
```

Run this BEFORE committing. If any command fails, do not commit.

## Browser Testing (If Available)

For any story that changes UI, verify it works in the browser if you have browser testing tools configured (e.g., via MCP):

1. Navigate to the relevant page
2. Verify the UI changes work as expected
3. Take a screenshot if helpful for the progress log

If no browser tools are available, note in your progress report that manual browser verification is needed.

## Git Rules

**PRD files and progress files in `.ralph/` must NEVER be committed.** They are ephemeral working files that are gitignored. The pre-commit hook will reject any commit that includes them.

When committing, **never use `git add .` or `git add -A`** — these can accidentally stage gitignored files that were previously tracked. Instead, stage only the specific files you changed:

```bash
git add path/to/file1.ts path/to/file2.ts
git commit -m "feat: [Story ID] - [Story Title]"
```

Steps 12 and 13 (updating the PRD and progress file) must happen **after** the commit, so these files are never in the staging area during a commit.

## Stop Condition — CRITICAL

**You MUST stop after completing exactly ONE user story.** Do not continue to the next story. Do not loop. One story per invocation, then stop.

After completing your one story, check if ALL stories now have `passes: true`.

If ALL stories are complete and passing, reply with:
<promise>COMPLETE</promise>

If there are still stories with `passes: false`, **STOP IMMEDIATELY. Do not work on them.** End your response. Another iteration will be launched to pick up the next story.

## Important

- **ONE story per invocation — then STOP.** This is the most important rule. Never implement more than one story.
- Commit frequently
- Keep builds green
- Read the Codebase Patterns section in the progress file before starting
- All file paths are relative to the project root
