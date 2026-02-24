# Ralph — Parallel Task Daemon

## Overview

Ralph (`.ralph/ralph.sh`) is a long-running daemon that processes PRD files in parallel using git worktrees. It dispatches up to N workers (default 3), each in an isolated worktree with its own branch, so agents never interfere with each other's builds, type-checks, or tests.

## Architecture

```
ralph.sh (daemon, polls .ralph/ for ready PRDs)
  ├── Worker 0 → git worktree .ralph/worktrees/<slug>/ → claude --print
  ├── Worker 1 → git worktree .ralph/worktrees/<slug>/ → claude --print
  └── Worker 2 → git worktree .ralph/worktrees/<slug>/ → claude --print
```

Each worker: creates worktree → `bun install` → `bun run build` → builds `plugins/e2e-test` → copies PRD into worktree → launches claude → syncs PRD/progress back after each iteration → on completion: kills process group → merges branch into main → archives PRD.

## Usage

```bash
# Start daemon (continuous mode, 3 workers)
nohup bash .ralph/ralph.sh --workers 3 &

# Process current queue and exit
nohup bash .ralph/ralph.sh --workers 3 --once &

# Monitor
tail -f .ralph/ralph.log
```

## Key Design Decisions and Gotchas

- **Worktrees are fully set up before the agent starts.** Each worktree gets `bun install` (own `node_modules/`), `bun run build` (fresh `dist/` for all platform packages), and the `plugins/e2e-test` plugin is installed and built (needed by `platform/plugin-tools` unit tests). Bun's global cache makes install fast (~1-2 seconds), and the build adds ~10-15 seconds. This eliminates agents wasting time debugging stale or missing build artifacts.
- **Dev tooling must ignore worktrees.** ESLint, knip, and prettier will scan `.ralph/worktrees/` and `.claude/worktrees/` unless explicitly excluded. These exclusions are in `eslint.config.ts`, `knip.ts`, and `.prettierignore`. Forgetting this causes ESLint crashes (no tsconfig for worktree files) and knip reporting hundreds of false "unused files."
- **`set -e` is intentionally NOT used.** This is a long-running daemon — a single failed `mv`, `cp`, or `jq` command must not kill the entire process tree. Every failure is handled explicitly with `|| true` or `|| return 1`.
- **Process group isolation for e2e cleanup.** `set -m` gives each worker its own process group (PGID). On completion, ralph does a two-phase kill: `kill -- -PID` (PGID kill for most processes) then `kill_tree` (recursive walk via `pgrep -P` for processes that escaped via `setsid()`, like Chromium).
- **Merge conflicts leave breadcrumb files.** When a merge fails, ralph writes `.ralph/<slug>.merge-conflict.txt` with the branch name, conflicted files, and resolution instructions. The branch is preserved for manual merge.
- **Never merge a branch that has an active worktree.** Check `git worktree list` before manually merging any `ralph-*` branch — the worker may still be committing to it.
- **`--once` mode drains the full queue.** It doesn't exit after the first batch — it keeps dispatching as slots free up until both active workers AND ready PRDs are zero.
- **Recovery on restart.** Any `~running` PRDs from a crash are renamed back to ready and re-dispatched. Stale worktrees and branches from the previous run are cleaned up by `dispatch_prd`.
- **Conditional E2E via `e2eCheckpoint`.** Each story in a PRD has an `e2eCheckpoint` boolean field. When `true`, the agent runs Phase 2 (full suite including `bun run test:e2e`) after that story. When `false`, the agent runs only Phase 1 (fast checks). This avoids running expensive E2E tests after every story — the PRD author places checkpoints at strategic boundaries (after groups of behavioral changes, and always on the final story).
- **E2E safety net in ralph.sh.** After all stories complete, `execute_prd_in_worktree` checks whether the last completed story was an `e2eCheckpoint`. If not, ralph runs the full verification suite (build, type-check, lint, knip, test, test:e2e) in the worktree as a safety net. If it fails, ralph launches up to 3 fix iterations (fresh Claude sessions with standalone prompts) to resolve the failures before declaring success. This guarantees E2E tests run at least once per PRD.

## Log Format

Every line in `ralph.log` has: `HH:MM:SS [W<slot>:<objective>] <message>`. Worker output is interleaved but clearly distinguishable by tag. Timestamps are PST.
