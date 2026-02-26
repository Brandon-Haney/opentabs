# Ralph — Parallel Task Daemon

## Overview

Ralph (`.ralph/ralph.sh`) is a long-running daemon that processes PRD files in parallel using git worktrees. It dispatches up to N workers (default 2), each in an isolated worktree with its own branch, so agents never interfere with each other's builds, type-checks, or tests.

Each worker runs inside a **Docker container**. Process cleanup is handled by the kernel via cgroups — `docker kill` atomically destroys every process in the container (Chromium, Playwright workers, test servers). No orphaned processes, no pgrep pattern matching, no process tree walking.

## Architecture

```
ralph.sh (daemon on host, polls .ralph/ for ready PRDs)
  ├── Worker 0 → git worktree → Docker container (ralph-worker-0, 5GB/5CPU) → claude --print
  └── Worker 1 → git worktree → Docker container (ralph-worker-1, 5GB/5CPU) → claude --print
```

**Host responsibilities** (ralph.sh): PRD discovery, worktree creation, `bun install` + `bun run build`, container lifecycle, branch merging, PRD state machine.

**Container responsibilities** (worker.sh): Claude agent execution, stream filtering, E2E safety net, iterative story processing.

Each worker lifecycle:
1. *Host*: creates worktree → `bun install` → `bun run build` → builds `plugins/e2e-test` → copies PRD into worktree
2. *Host*: launches Docker container with worktree bind-mounted
3. *Container*: runs worker.sh → claude agent loop → commits to branch
4. *Host*: detects container exit → syncs PRD/progress → merges branch → archives PRD

## Prerequisites

- **Docker** (Docker Desktop or OrbStack)
- **ralph-worker image**: `bash .ralph/docker-build.sh`

## Usage

```bash
# Build the worker image (one-time, or after Dockerfile changes)
bash .ralph/docker-build.sh

# Start daemon (continuous mode, default 2 workers)
nohup bash .ralph/ralph.sh &

# Process current queue and exit
nohup bash .ralph/ralph.sh --once &

# Monitor
tail -f .ralph/ralph.log

# Check running containers
docker ps --filter "name=ralph-worker-"
```

## File Structure

```
.ralph/
├── ralph.sh              # Main daemon (runs on host)
├── worker.sh             # Worker script (runs inside container)
├── Dockerfile            # Docker image definition
├── docker-build.sh       # Image build script
├── RALPH.md              # Agent instructions (injected into workers)
├── CLAUDE.md             # This file
├── ralph.log             # Daemon log output
├── archive/              # Completed PRDs
└── worktrees/            # Git worktrees (ephemeral)
```

## Key Design Decisions and Gotchas

- **Docker containers for process isolation.** Each worker runs in a named Docker container (`ralph-worker-<slot>`). When ralph needs to kill a worker (shutdown, timeout, or if the daemon itself gets killed), `docker kill` sends SIGKILL via cgroups, atomically destroying every process in the container. This solves the fundamental problem that macOS has no kernel-level mechanism to atomically kill a process subtree — Chromium calls `setsid()`, test servers reference temp dirs, and `kill -9` on the daemon bypasses all trap handlers.
- **Worktree mounted at its original host path.** Git worktrees contain a `.git` file with an absolute path back to the main repo's `.git/worktrees/<name>` directory. To make git operations work inside the container, the worktree and the main `.git` directory are both mounted at their original host paths. The container's working directory is set to the worktree path via `docker run -w`.
- **Host network mode.** Containers use `--network host` so the Claude CLI can reach local LLM proxies and any other services on the host network.
- **Self-contained containers — no host pollution.** Containers use `HOME=/tmp/worker` (container-local). All writes — `.opentabs`, `.claude`, node caches, Playwright profiles — stay inside the container and are discarded on exit. The only host mounts are the worktree (read-write), the main `.git` directory (for worktree resolution), and `~/.npmrc` (read-only, for private npm package auth).
- **Worktrees are fully set up before the container starts.** Each worktree gets `bun install` (own `node_modules/`), `bun run build` (fresh `dist/` for all platform packages), and the `plugins/e2e-test` plugin is installed and built. This runs inside a setup container (same image). The resulting files are bind-mounted into the worker container.
- **Official Playwright base image.** The Docker image is based on `mcr.microsoft.com/playwright:v1.58.2-noble`, which includes Chromium and all required system dependencies pre-configured and tested by the Playwright team. Firefox and WebKit are removed to save space.
- **`--ipc=host` is required.** Chromium uses IPC extensively. Without `--ipc=host`, Chrome crashes with SIGTRAP. `--shm-size=2g` is also required (default 64MB is too small for Chromium).
- **Container resource limits prevent OOM kills.** Each container gets `--memory=5g --cpus=5`. During E2E, each Playwright worker (4 per container) spawns an MCP server, a test server, and a Chromium instance (~600 MB each), totaling ~2.5 GB for Playwright alone plus headroom for the Claude CLI and build tools. Without limits, two workers running E2E simultaneously can exhaust Docker's ~12 GB memory allocation, triggering `Killed: 9` (OOM) and cascading test failures. The default of 2 workers × 5 GB = 10 GB leaves ~2 GB for Docker overhead.
- **Dev tooling must ignore worktrees.** ESLint, knip, and prettier will scan `.ralph/worktrees/` and `.claude/worktrees/` unless explicitly excluded. These exclusions are in `eslint.config.ts`, `knip.ts`, and `.prettierignore`. Forgetting this causes ESLint crashes (no tsconfig for worktree files) and knip reporting hundreds of false "unused files."
- **`set -e` is intentionally NOT used.** This is a long-running daemon — a single failed `mv`, `cp`, or `jq` command must not kill the entire process tree. Every failure is handled explicitly with `|| true` or `|| return 1`.
- **Startup orphan cleanup kills leftover containers.** On startup, ralph scans for containers matching `ralph-worker-*` and kills/removes them. This handles the case where the previous daemon was killed with `kill -9` (bypassing the EXIT trap).
- **Merge conflicts leave breadcrumb files.** When a merge fails, ralph writes `.ralph/<slug>.merge-conflict.txt` with the branch name, conflicted files, and resolution instructions. The branch is preserved for manual merge.
- **Never merge a branch that has an active worktree.** Check `docker ps --filter "name=ralph-worker-"` and `git worktree list` before manually merging any `ralph-*` branch — the worker may still be committing to it.
- **`--once` mode drains the full queue.** It doesn't exit after the first batch — it keeps dispatching as slots free up until both active workers AND ready PRDs are zero.
- **Graceful shutdown preserves in-progress work.** When ralph is killed (SIGTERM/EXIT), cleanup kills all containers, syncs PRD and progress files from worktrees back to main `.ralph/`, reverts PRDs from `~running` to ready, and preserves branches that have unmerged commits. Worktrees (ephemeral checkouts) are removed, but the branch refs survive. On restart, `dispatch_prd` detects the preserved branch and creates a new worktree from it instead of starting fresh from HEAD — so the agent resumes where it left off (the PRD tracks which stories already passed).
- **Conditional E2E via `e2eCheckpoint`.** Each story in a PRD has an `e2eCheckpoint` boolean field. When `true`, the agent runs Phase 2 (full suite including `bun run test:e2e`) after that story. When `false`, the agent runs only Phase 1 (fast checks). This avoids running expensive E2E tests after every story — the PRD author places checkpoints at strategic boundaries (after groups of behavioral changes, and always on the final story).
- **E2E safety net.** After all stories complete, worker.sh checks whether the last completed story was an `e2eCheckpoint`. If not, it runs the full verification suite (build, type-check, lint, knip, test, test:e2e) as a safety net. If it fails, it launches up to 3 fix iterations (fresh Claude sessions) to resolve the failures before declaring success. This guarantees E2E tests run at least once per PRD.
- **Claude CLI credentials via environment variables.** No host config files are mounted. Environment variables from `~/.claude/settings.json` (e.g., `ANTHROPIC_BASE_URL`) are extracted on the host and passed as container env vars. The host's `ANTHROPIC_*` env vars are also forwarded. Claude CLI writes session data to `/tmp/worker/.claude/` inside the container (ephemeral).

## Log Format

Every line in `ralph.log` has: `HH:MM:SS [W<slot>:<objective>] <message>`. Worker output is interleaved but clearly distinguishable by tag. Timestamps are PST.
