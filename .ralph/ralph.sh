#!/bin/bash
# Ralph — Parallel PRD consumer daemon using git worktrees
#
# Usage: .ralph/ralph.sh [--tool amp|claude] [--once] [--poll N] [--workers N]
#
# Watches .ralph/ for PRD files and processes them in parallel using git worktrees.
# Each PRD gets its own worktree so agents run in full isolation — no type-check,
# lint, or build conflicts between concurrent agents.
#
# PRD file name state machine:
#   prd-YYYY-MM-DD-HHMMSS-objective~draft.json    — being written, ignored
#   prd-YYYY-MM-DD-HHMMSS-objective.json           — ready to be picked up
#   prd-YYYY-MM-DD-HHMMSS-objective~running.json   — currently being executed
#   prd-YYYY-MM-DD-HHMMSS-objective~done.json      — completed, pending archive
#   archived to .ralph/archive/                     — final resting place
#
# Multiple PRDs can be ~running simultaneously (one per worker).
#
# Log format — every line in ralph.log:
#   HH:MM:SS [W<slot>:<objective>] <message>
#   e.g. 14:32:05 [W0:fix-bugs] ▸ Read    platform/mcp-server/src/index.ts

# NOTE: set -e is intentionally NOT used. This is a long-running daemon that
# must be resilient to individual command failures (git operations, file copies,
# jq parsing). Each failure is handled explicitly with || guards. Using set -e
# in a daemon causes cascading failures where a single transient error (e.g.,
# a missing temp file) kills the entire process tree.

# --- Argument Parsing ---

TOOL="claude"
MODEL=""
ONCE=false
POLL_INTERVAL=5
MAX_WORKERS=3

while [[ $# -gt 0 ]]; do
  case $1 in
    --tool)
      TOOL="$2"
      shift 2
      ;;
    --tool=*)
      TOOL="${1#*=}"
      shift
      ;;
    --model)
      MODEL="$2"
      shift 2
      ;;
    --model=*)
      MODEL="${1#*=}"
      shift
      ;;
    --once)
      ONCE=true
      shift
      ;;
    --poll)
      POLL_INTERVAL="$2"
      shift 2
      ;;
    --poll=*)
      POLL_INTERVAL="${1#*=}"
      shift
      ;;
    --workers)
      MAX_WORKERS="$2"
      shift 2
      ;;
    --workers=*)
      MAX_WORKERS="${1#*=}"
      shift
      ;;
    *)
      shift
      ;;
  esac
done

if [[ "$TOOL" != "amp" && "$TOOL" != "claude" ]]; then
  echo "Error: Invalid tool '$TOOL'. Must be 'amp' or 'claude'."
  exit 1
fi

if ! [[ "$MAX_WORKERS" =~ ^[0-9]+$ ]] || [ "$MAX_WORKERS" -lt 1 ]; then
  echo "Error: --workers must be a positive integer (got '$MAX_WORKERS')."
  exit 1
fi

if ! [[ "$POLL_INTERVAL" =~ ^[0-9]+$ ]] || [ "$POLL_INTERVAL" -lt 1 ]; then
  echo "Error: --poll must be a positive integer (got '$POLL_INTERVAL')."
  exit 1
fi

# --- Setup ---

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

# Claude Code refuses to launch inside another Claude Code session.
# ralph.sh may be started from within a Claude Code session, so unset
# the environment variable that triggers the nested-session guard.
unset CLAUDECODE

ARCHIVE_DIR="$SCRIPT_DIR/archive"
WORKTREE_BASE="$SCRIPT_DIR/worktrees"
mkdir -p "$ARCHIVE_DIR" "$WORKTREE_BASE"

# --- Auto-Logging ---
# Always tee output to .ralph/ralph.log so diagnostics are never lost,
# regardless of how the script is launched (nohup, /dev/null, foreground).
# The re-exec guard (__RALPH_LOGGING) prevents infinite recursion.

LOG_FILE="$SCRIPT_DIR/ralph.log"

if [ -z "${__RALPH_LOGGING:-}" ]; then
  # Rotate previous log
  [ -f "$LOG_FILE" ] && mv "$LOG_FILE" "$SCRIPT_DIR/ralph.prev.log"

  # Re-exec with output tee'd to log file. Use exec so the PID stays the same.
  export __RALPH_LOGGING=1
  exec > >(tee -a "$LOG_FILE") 2>&1
fi

# --- Single Instance Lock ---
# Prevent multiple ralph.sh daemons from running simultaneously.

PIDFILE="$SCRIPT_DIR/.ralph.pid"

if [ -f "$PIDFILE" ]; then
  EXISTING_PID=$(cat "$PIDFILE")
  if kill -0 "$EXISTING_PID" 2>/dev/null; then
    echo "Error: ralph.sh is already running (PID $EXISTING_PID)."
    echo "Kill it first: kill $EXISTING_PID"
    exit 1
  fi
  # Stale PID file from a crashed process — clean up
  rm -f "$PIDFILE"
fi

echo $$ > "$PIDFILE"

# Colors
RED='\033[31m'
GREEN='\033[32m'
YELLOW='\033[33m'
CYAN='\033[36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# --- Timestamp helper ---
# Short PST timestamp for log lines.
ts() {
  TZ=America/Los_Angeles date +'%H:%M:%S'
}

# Check if there are any remaining ready PRDs to dispatch.
has_ready_prds() {
  local count
  count=$(find "$SCRIPT_DIR" -maxdepth 1 -name 'prd-*.json' -type f \
    ! -name '*~draft*' \
    ! -name '*~running*' \
    ! -name '*~done*' \
    2>/dev/null | wc -l | tr -d ' ')
  [ "$count" -gt 0 ]
}

# --- Worker Tracking ---
# Parallel arrays indexed by slot number (0..MAX_WORKERS-1).
# Empty string means the slot is free.

declare -a WORKER_PIDS=()
declare -a WORKER_PRDS=()
declare -a WORKER_WORKTREES=()
declare -a WORKER_BRANCHES=()
declare -a WORKER_RESULT_FILES=()
declare -a WORKER_TAGS=()

for (( s=0; s<MAX_WORKERS; s++ )); do
  WORKER_PIDS[$s]=""
  WORKER_PRDS[$s]=""
  WORKER_WORKTREES[$s]=""
  WORKER_BRANCHES[$s]=""
  WORKER_RESULT_FILES[$s]=""
  WORKER_TAGS[$s]=""
done

# --- Cleanup ---
# On exit, kill all running workers and remove worktrees.

cleanup() {
  echo ""
  echo -e "$(ts) ${YELLOW}Shutting down ralph...${RESET}"

  # Abort any in-progress git merge on the main worktree.
  # If SIGTERM arrives while reap_workers is running git merge, the main
  # worktree could be left in a partial merge state.
  git merge --abort 2>/dev/null || true

  for (( s=0; s<MAX_WORKERS; s++ )); do
    local pid="${WORKER_PIDS[$s]}"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo -e "$(ts) ${DIM}Killing worker $s (PID $pid) and child processes...${RESET}"
      # Two-phase kill for complete cleanup:
      # 1. PGID kill — catches everything in the same process group (fast)
      # 2. Tree kill — catches processes that escaped via setsid() (e.g., Chromium)
      kill -- -"$pid" 2>/dev/null || true
      kill_tree "$pid"
      wait "$pid" 2>/dev/null || true
    fi

    local wt="${WORKER_WORKTREES[$s]}"
    local br="${WORKER_BRANCHES[$s]}"
    if [ -n "$wt" ] && [ -d "$wt" ]; then
      echo -e "$(ts) ${DIM}Removing worktree: $wt${RESET}"
      remove_worktree "$wt"
    fi
    if [ -n "$br" ]; then
      git branch -D "$br" 2>/dev/null || true
    fi

    # Clean up temp files
    [ -n "${WORKER_RESULT_FILES[$s]}" ] && rm -f "${WORKER_RESULT_FILES[$s]}"
    [ -n "${WORKER_RESULT_FILES[$s]}" ] && rm -f "${WORKER_RESULT_FILES[$s]}.exit"
  done

  # Prune stale worktree references
  git worktree prune 2>/dev/null || true

  rm -f "$PIDFILE"
  echo -e "$(ts) ${GREEN}Ralph stopped.${RESET}"
}

# Use set -m to enable job control so background subshells get their own
# process groups. This allows cleanup to kill entire process trees via
# kill -- -PID (negative PID targets the process group).
set -m

trap cleanup EXIT

# --- Logging helpers ---
# Every log line gets:  HH:MM:SS [W<slot>:<objective>] <message>
# For daemon-level messages (no worker), the tag is omitted.

# Pipe filter: prepends "HH:MM:SS <tag> " to every line read from stdin.
# Usage: some_command 2>&1 | ts_prefix "W0:fix-bugs"
ts_prefix() {
  local tag="$1"
  while IFS= read -r line; do
    printf "%s ${CYAN}[%s]${RESET} %s\n" "$(ts)" "$tag" "$line"
  done
}

# --- Helper Functions ---

# Recursively kill an entire process tree rooted at a given PID.
# Walks the tree bottom-up (children before parent) so orphans don't
# re-parent to init before we reach them. This catches processes that
# escaped the PGID via setsid() (e.g., Chromium) — pgrep -P follows
# the parent-child relationship regardless of process group or session.
kill_tree() {
  local pid="$1"
  local sig="${2:-TERM}"
  [ -z "$pid" ] && return

  # Collect children BEFORE killing the parent (dead parent = no children to find).
  local children
  children=$(pgrep -P "$pid" 2>/dev/null) || true

  for child in $children; do
    kill_tree "$child" "$sig"
  done

  kill -"$sig" "$pid" 2>/dev/null || true
}

# Robustly remove a git worktree directory.
# git worktree remove can fail when node_modules or other large trees have
# open file handles (Spotlight, FSEvents, lingering processes). Fall back to
# rm -rf, retrying once after a short sleep if the first attempt fails.
remove_worktree() {
  local wt="$1"
  [ -z "$wt" ] || [ ! -d "$wt" ] && return 0

  # Try git's own removal first (unregisters from .git/worktrees too).
  git worktree remove --force "$wt" >/dev/null 2>&1 && return 0

  # git failed — force-remove the directory.
  rm -rf "$wt" 2>/dev/null && { git worktree prune 2>/dev/null || true; return 0; }

  # If rm -rf failed (open file handles), wait and retry once.
  sleep 2
  rm -rf "$wt" 2>/dev/null || true
  git worktree prune 2>/dev/null || true
}

# Find ALL ready PRD files (sorted by timestamp, oldest first).
find_ready_prds() {
  find "$SCRIPT_DIR" -maxdepth 1 -name 'prd-*.json' -type f \
    ! -name '*~draft*' \
    ! -name '*~running*' \
    ! -name '*~done*' \
    2>/dev/null | sort
}

# Find all currently running PRD files.
find_running_prds() {
  find "$SCRIPT_DIR" -maxdepth 1 -name 'prd-*~running.json' -type f \
    2>/dev/null | sort
}

# Count active workers.
count_active_workers() {
  local count=0
  for (( s=0; s<MAX_WORKERS; s++ )); do
    [ -n "${WORKER_PIDS[$s]}" ] && count=$((count + 1))
  done
  echo "$count"
}

# Find a free worker slot. Returns slot number or empty string if none.
find_free_slot() {
  for (( s=0; s<MAX_WORKERS; s++ )); do
    if [ -z "${WORKER_PIDS[$s]}" ]; then
      echo "$s"
      return
    fi
  done
  echo ""
}

# Extract a full slug from a PRD filename for use in branch/worktree names.
# prd-2026-02-17-143000-improve-sdk.json -> 2026-02-17-143000-improve-sdk
prd_slug() {
  local prd_file="$1"
  local base
  base=$(basename "$prd_file" .json)
  # Strip state suffixes
  base="${base/~running/}"
  base="${base/~done/}"
  base="${base/~draft/}"
  # Strip "prd-" prefix
  echo "${base#prd-}"
}

# Extract short human-readable objective from a PRD filename.
# prd-2026-02-17-143000-improve-sdk.json -> improve-sdk
prd_objective() {
  local slug
  slug=$(prd_slug "$1")
  # The slug is YYYY-MM-DD-HHMMSS-objective (18 chars of date prefix).
  echo "${slug:18}"
}

# Build the worker tag: W<slot>:<objective>
# e.g. W0:fix-bugs, W2:security-fixes
make_worker_tag() {
  local slot="$1"
  local prd_file="$2"
  local obj
  obj=$(prd_objective "$prd_file")
  # Truncate objective to 20 chars for readability
  echo "W${slot}:${obj:0:20}"
}

# Transition a PRD file to ~running state by renaming it.
# Returns the new path on stdout. Returns 1 if the source file is missing.
mark_running() {
  local prd_file="$1"
  if [ ! -f "$prd_file" ]; then
    echo "$prd_file"
    return 1
  fi
  local base
  base=$(basename "$prd_file" .json)
  local running_file="$SCRIPT_DIR/${base}~running.json"
  mv "$prd_file" "$running_file" || { echo "$prd_file"; return 1; }
  echo "$running_file"
}

# Transition a PRD file from ~running to ~done state.
# Returns the new path on stdout. Returns 1 if the source file is missing.
mark_done() {
  local prd_file="$1"
  local done_file="${prd_file/~running/~done}"
  if [ ! -f "$prd_file" ]; then
    echo "$done_file"
    return 1
  fi
  mv "$prd_file" "$done_file" || { echo "$done_file"; return 1; }
  echo "$done_file"
}

# Strip state suffixes (~running, ~done) from a basename to get the clean name.
clean_name() {
  local name="$1"
  name="${name/~running/}"
  name="${name/~done/}"
  echo "$name"
}

# Derive the progress.txt path from a PRD file (works with any state suffix).
progress_file_for() {
  local prd_file="$1"
  local base
  base=$(basename "$prd_file" .json)
  local cleaned
  cleaned=$(clean_name "$base")
  local progress_name="progress-${cleaned#prd-}"
  echo "$SCRIPT_DIR/${progress_name}.txt"
}

# Archive a ~done PRD and its progress file.
# Tolerates missing files — does not fail if PRD or progress file is gone.
archive_run() {
  local prd_file="$1"
  local progress_file="$2"
  local tag="$3"
  local base
  base=$(basename "$prd_file" .json)
  local archive_folder="$ARCHIVE_DIR/$base"

  mkdir -p "$archive_folder" || return 1

  [ -f "$prd_file" ] && mv "$prd_file" "$archive_folder/${base}.json" 2>/dev/null || true

  if [ -f "$progress_file" ]; then
    mv "$progress_file" "$archive_folder/progress.txt" 2>/dev/null || true
  fi

  echo -e "$(ts) ${CYAN}[${tag}]${RESET} ${GREEN}Archived to: $archive_folder${RESET}"
}

# Stream filter: extracts concise progress lines from claude's stream-json output.
# Outputs plain text lines (no timestamp/tag) — the caller pipes through ts_prefix.
stream_filter() {
  local result_file="$1"

  while IFS= read -r line; do
    [ -z "$line" ] && continue

    local msg_type
    msg_type=$(echo "$line" | jq -r '.type // empty' 2>/dev/null) || continue

    case "$msg_type" in
      assistant)
        local tool_uses
        tool_uses=$(echo "$line" | jq -r '
          .message.content[]? |
          select(.type == "tool_use") |
          .name + "\t" + (
            if .name == "Read" then (.input.file_path // "")
            elif .name == "Write" then (.input.file_path // "")
            elif .name == "Edit" then (.input.file_path // "")
            elif .name == "Bash" then ((.input.description // .input.command // "") | .[0:80])
            elif .name == "Glob" then (.input.pattern // "")
            elif .name == "Grep" then (.input.pattern // "") + " " + (.input.path // "")
            elif .name == "Task" then (.input.description // "")
            elif .name == "Skill" then (.input.skill // "")
            else (.input | tostring | .[0:60])
            end
          )
        ' 2>/dev/null)

        if [ -n "$tool_uses" ]; then
          while IFS=$'\t' read -r tool_name tool_detail; do
            [ -z "$tool_name" ] && continue
            printf "▸ %-8s %s\n" "$tool_name" "$tool_detail"
          done <<< "$tool_uses"
        fi

        local text_content
        text_content=$(echo "$line" | jq -r '
          [.message.content[]? | select(.type == "text") | .text] | join("")
        ' 2>/dev/null)

        if [ -n "$text_content" ] && [ "$text_content" != "null" ]; then
          printf "✦ %.120s\n" "$text_content"
          if echo "$text_content" | grep -q "<promise>COMPLETE</promise>" 2>/dev/null; then
            echo "$text_content" >> "$result_file"
          fi
        fi
        ;;

      result)
        local result_text duration_s cost num_turns
        result_text=$(echo "$line" | jq -r '.result // ""' 2>/dev/null)
        duration_s=$(echo "$line" | jq -r '((.duration_ms // 0) / 1000 | floor)' 2>/dev/null)
        cost=$(echo "$line" | jq -r '.total_cost_usd // 0' 2>/dev/null)
        num_turns=$(echo "$line" | jq -r '.num_turns // 0' 2>/dev/null)

        echo "$result_text" >> "$result_file"

        printf "⏱  %ss  │  %s turns  │  \$%s\n" "$duration_s" "$num_turns" "$cost"
        ;;
    esac
  done
}

# Execute all stories in a single PRD file inside a worktree.
# This runs as the worker's main function (in a subshell / background).
# All output (stdout+stderr) is piped through ts_prefix by the caller,
# so this function just writes plain messages — no timestamps or tags.
# Arguments: prd_file worktree_dir result_file
execute_prd_in_worktree() {
  local prd_file="$1"
  local worktree_dir="$2"
  local result_file="$3"

  local prd_basename
  prd_basename=$(basename "$prd_file")
  local wt_prd="$worktree_dir/.ralph/$prd_basename"

  # Sanity check: the worktree PRD must exist (copied by dispatch_prd).
  if [ ! -f "$wt_prd" ]; then
    echo "ERROR: PRD file not found in worktree: $wt_prd"
    return 1
  fi

  # The progress file lives in the main .ralph/ (canonical location).
  # We copy it into the worktree for the agent, then copy it back when done.
  local progress_file
  progress_file=$(progress_file_for "$prd_file")
  local progress_basename
  progress_basename=$(basename "$progress_file")
  local wt_progress="$worktree_dir/.ralph/$progress_basename"

  # Helper: copy PRD and progress from worktree back to main .ralph/.
  # Called after each iteration and on exit so the canonical state stays current.
  # Uses cp with || true — a failed copy-back is not fatal; the worktree
  # state is still the source of truth until it's removed.
  _sync_back() {
    [ -f "$wt_prd" ] && cp "$wt_prd" "$prd_file" 2>/dev/null || true
    [ -f "$wt_progress" ] && cp "$wt_progress" "$progress_file" 2>/dev/null || true
  }

  # Auto-calculate iterations from remaining stories
  local remaining total buffer max_iterations
  remaining=$(jq '[.userStories[] | select(.passes != true)] | length' "$wt_prd" 2>/dev/null || echo "0")
  total=$(jq '.userStories | length' "$wt_prd" 2>/dev/null || echo "?")

  if [ "$remaining" -eq 0 ]; then
    echo "All stories already pass. Nothing to do."
    return 0
  fi

  buffer=$(( (remaining + 2) / 3 ))
  [ "$buffer" -lt 1 ] && buffer=1
  max_iterations=$(( remaining + buffer ))

  echo "Stories: $remaining remaining (of $total total), $max_iterations iterations max"

  # Initialize progress file in worktree
  if [ ! -f "$wt_progress" ]; then
    echo "# Ralph Progress Log" > "$wt_progress"
    echo "PRD: $prd_basename" >> "$wt_progress"
    echo "Started: $(date)" >> "$wt_progress"
    echo "---" >> "$wt_progress"
  fi

  for i in $(seq 1 $max_iterations); do
    # Check if all stories pass before each iteration
    remaining=$(jq '[.userStories[] | select(.passes != true)] | length' "$wt_prd" 2>/dev/null || echo "0")
    if [ "$remaining" -eq 0 ]; then
      echo ""
      echo "All stories pass! Completed before iteration $i."
      _sync_back
      return 0
    fi

    echo ""
    echo "── Iteration $i/$max_iterations — $remaining stories remaining ──"

    ITER_RESULT_FILE=$(mktemp)
    STDERR_FILE=$(mktemp)

    if [[ "$TOOL" == "amp" ]]; then
      OUTPUT=$(cat "$worktree_dir/.ralph/RALPH.md" | (cd "$worktree_dir" && amp --dangerously-allow-all) 2>&1 | tee /dev/stderr) || true
      echo "$OUTPUT" > "$ITER_RESULT_FILE"
    else
      CLAUDE_ARGS=(--dangerously-skip-permissions --print --output-format stream-json --verbose)
      [ -n "$MODEL" ] && CLAUDE_ARGS+=(--model "$MODEL")
      (cd "$worktree_dir" && claude "${CLAUDE_ARGS[@]}") \
        < "$worktree_dir/.ralph/RALPH.md" 2>"$STDERR_FILE" \
        | stream_filter "$ITER_RESULT_FILE" || true
    fi

    # Detect empty iterations
    ITER_RESULT_SIZE=$(wc -c < "$ITER_RESULT_FILE" 2>/dev/null | tr -d ' ')
    if [ "${ITER_RESULT_SIZE:-0}" -eq 0 ]; then
      echo ""
      echo "ERROR: Empty iteration — claude produced no output."
      if [ -s "$STDERR_FILE" ]; then
        echo "stderr:"
        head -20 "$STDERR_FILE"
      fi
      rm -f "$ITER_RESULT_FILE" "$STDERR_FILE"
      echo "Aborting PRD to avoid burning iterations."
      _sync_back
      return 1
    fi

    rm -f "$STDERR_FILE"

    if [ -f "$ITER_RESULT_FILE" ] && grep -q "<promise>COMPLETE</promise>" "$ITER_RESULT_FILE" 2>/dev/null; then
      echo ""
      echo "All tasks complete!"
      rm -f "$ITER_RESULT_FILE"
      _sync_back
      return 0
    fi

    rm -f "$ITER_RESULT_FILE"

    # Sync progress back after each iteration so the main .ralph/ stays current
    _sync_back

    sleep 2
  done

  echo ""
  echo "Reached max iterations ($max_iterations) without completing all stories."
  _sync_back
  return 1
}

# Dispatch a PRD to a free worker slot.
# Creates a worktree, copies PRD files, installs deps, launches agent.
dispatch_prd() {
  local prd_file="$1"
  local slot="$2"

  local slug
  slug=$(prd_slug "$prd_file")
  local branch_name="ralph-$slug"
  local worktree_dir="$WORKTREE_BASE/$slug"
  local tag
  tag=$(make_worker_tag "$slot" "$prd_file")

  echo ""
  echo -e "$(ts) ${BOLD}┌───────────────────────────────────────────────────────────┐${RESET}"
  echo -e "$(ts) ${BOLD}│  [${tag}] Dispatching: $(basename "$prd_file")${RESET}"
  echo -e "$(ts) ${BOLD}└───────────────────────────────────────────────────────────┘${RESET}"

  # Mark PRD as running
  if ! prd_file=$(mark_running "$prd_file"); then
    echo -e "$(ts) ${CYAN}[${tag}]${RESET} ${RED}Failed to mark PRD as running. File may have been moved.${RESET}"
    return 1
  fi

  local prd_project prd_desc
  prd_project=$(jq -r '.project // "unknown"' "$prd_file" 2>/dev/null)
  prd_desc=$(jq -r '.description // ""' "$prd_file" 2>/dev/null)
  echo -e "$(ts) ${CYAN}[${tag}]${RESET} Project: $prd_project"
  [ -n "$prd_desc" ] && echo -e "$(ts) ${CYAN}[${tag}]${RESET} ${DIM}$prd_desc${RESET}"

  # Clean up any leftover worktree/branch from a previous crashed run
  if [ -d "$worktree_dir" ]; then
    echo -e "$(ts) ${CYAN}[${tag}]${RESET} ${DIM}Cleaning up stale worktree...${RESET}"
    remove_worktree "$worktree_dir"
  fi
  git branch -D "$branch_name" 2>/dev/null || true

  # Create worktree branching from current HEAD
  echo -e "$(ts) ${CYAN}[${tag}]${RESET} ${DIM}Creating worktree...${RESET}"
  if ! git worktree add "$worktree_dir" -b "$branch_name" HEAD >/dev/null 2>&1; then
    echo -e "$(ts) ${CYAN}[${tag}]${RESET} ${RED}Failed to create worktree. Skipping PRD.${RESET}"
    # Revert PRD from ~running back to ready so it can be retried
    mv "$prd_file" "${prd_file/\~running.json/.json}" 2>/dev/null || true
    return 1
  fi

  # Copy PRD and progress files into the worktree's .ralph/ directory.
  # The worktree has .ralph/RALPH.md (tracked) but not the PRD/progress (gitignored).
  mkdir -p "$worktree_dir/.ralph"
  cp "$prd_file" "$worktree_dir/.ralph/"

  local progress_file
  progress_file=$(progress_file_for "$prd_file")
  if [ -f "$progress_file" ]; then
    cp "$progress_file" "$worktree_dir/.ralph/"
  fi

  # Install dependencies in the worktree.
  # bun's global cache makes this fast (seconds, not minutes).
  echo -e "$(ts) ${CYAN}[${tag}]${RESET} ${DIM}Installing dependencies...${RESET}"
  if ! (cd "$worktree_dir" && bun install --frozen-lockfile 2>&1 | tail -1); then
    echo -e "$(ts) ${CYAN}[${tag}]${RESET} ${RED}bun install failed. Aborting worker.${RESET}"
    remove_worktree "$worktree_dir"
    git branch -D "$branch_name" 2>/dev/null || true
    # Revert PRD from ~running back to ready so it can be retried
    mv "$prd_file" "${prd_file/\~running.json/.json}" 2>/dev/null || true
    return 1
  fi

  # Launch the worker in the background.
  # All worker output (stdout+stderr) is piped through ts_prefix so every
  # line in ralph.log gets "HH:MM:SS [W<n>:<objective>] <message>".
  local result_file
  result_file=$(mktemp)

  (
    # Run the worker function and pipe through the timestamp prefixer.
    # PIPESTATUS[0] captures execute_prd_in_worktree's exit code (ts_prefix
    # always exits 0 when its stdin closes, so $? from the pipeline is 0
    # regardless of the worker's exit code — PIPESTATUS is the only way
    # to get the real exit code).
    execute_prd_in_worktree "$prd_file" "$worktree_dir" "$result_file" 2>&1 \
      | ts_prefix "$tag"
    # Capture the worker's exit code. If the subshell is killed before this
    # line runs (e.g., SIGTERM), the .exit file won't exist and reap_workers
    # defaults to exit_code=1 — which is the correct safe fallback.
    echo "${PIPESTATUS[0]}" > "${result_file}.exit"
  ) &

  local pid=$!

  WORKER_PIDS[$slot]="$pid"
  WORKER_PRDS[$slot]="$prd_file"
  WORKER_WORKTREES[$slot]="$worktree_dir"
  WORKER_BRANCHES[$slot]="$branch_name"
  WORKER_RESULT_FILES[$slot]="$result_file"
  WORKER_TAGS[$slot]="$tag"

  echo -e "$(ts) ${CYAN}[${tag}]${RESET} ${GREEN}Launched (PID $pid)${RESET}"
  return 0
}

# Merge a worktree branch into the current branch.
# Returns 0 on success, 1 on conflict.
merge_worktree_branch() {
  local branch="$1"
  local tag="$2"

  # Check if the branch has any commits beyond the fork point
  local commit_count
  commit_count=$(git rev-list --count "HEAD..$branch" 2>/dev/null || echo "0")

  if [ "$commit_count" -eq 0 ]; then
    echo -e "$(ts) ${CYAN}[${tag}]${RESET} ${DIM}No commits to merge.${RESET}"
    return 0
  fi

  echo -e "$(ts) ${CYAN}[${tag}]${RESET} ${DIM}Merging $commit_count commit(s) from $branch...${RESET}"

  if git merge --no-edit "$branch" 2>/dev/null; then
    echo -e "$(ts) ${CYAN}[${tag}]${RESET} ${GREEN}Merge successful.${RESET}"
    return 0
  else
    echo -e "$(ts) ${CYAN}[${tag}]${RESET} ${RED}Merge conflict! Aborting merge.${RESET}"
    git merge --abort 2>/dev/null || true
    return 1
  fi
}

# Check for completed workers, merge results, clean up.
reap_workers() {
  for (( s=0; s<MAX_WORKERS; s++ )); do
    local pid="${WORKER_PIDS[$s]}"
    [ -z "$pid" ] && continue

    # Check if still running
    if kill -0 "$pid" 2>/dev/null; then
      continue
    fi

    # Worker finished — collect results
    wait "$pid" 2>/dev/null || true

    # Two-phase kill for complete cleanup of orphaned child processes:
    # Phase 1: PGID kill — catches everything sharing the worker's process group.
    # Phase 2: Recursive tree kill — walks the parent-child tree to catch processes
    #   that escaped the PGID via setsid() (Chromium does this for isolation).
    # Together these ensure no orphaned Chromium browsers, MCP servers, or test
    # servers survive — only THIS worker's descendants are affected.
    kill -- -"$pid" 2>/dev/null || true
    kill_tree "$pid"
    sleep 1  # Let dying processes (Chromium, test servers) exit before worktree removal

    local prd_file="${WORKER_PRDS[$s]}"
    local worktree_dir="${WORKER_WORKTREES[$s]}"
    local branch_name="${WORKER_BRANCHES[$s]}"
    local result_file="${WORKER_RESULT_FILES[$s]}"
    local tag="${WORKER_TAGS[$s]}"

    # Read exit code (default 1 = failure if file missing or corrupt)
    local exit_code=1
    if [ -f "${result_file}.exit" ]; then
      local raw_exit
      raw_exit=$(cat "${result_file}.exit" 2>/dev/null)
      rm -f "${result_file}.exit"
      # Validate it's a number; fall back to 1 if corrupt
      if [[ "$raw_exit" =~ ^[0-9]+$ ]]; then
        exit_code="$raw_exit"
      fi
    fi

    echo ""
    if [ "$exit_code" -eq 0 ]; then
      echo -e "$(ts) ${CYAN}[${tag}]${RESET} ${GREEN}Worker completed successfully.${RESET}"
    else
      echo -e "$(ts) ${CYAN}[${tag}]${RESET} ${YELLOW}Worker finished with errors (exit $exit_code).${RESET}"
    fi

    # Merge worktree branch into current branch.
    # merge_worktree_branch runs git merge which can fail in two ways:
    # 1. Conflict → abort merge, keep branch for manual resolution
    # 2. No commits → skip (fast path)
    local merge_failed=false
    if ! merge_worktree_branch "$branch_name" "$tag"; then
      merge_failed=true
      echo -e "$(ts) ${CYAN}[${tag}]${RESET} ${RED}Could not merge. Commits remain on branch $branch_name.${RESET}"
      echo -e "$(ts) ${CYAN}[${tag}]${RESET} ${YELLOW}Manual resolution needed: git merge $branch_name${RESET}"
    fi

    # Remove the worktree (always — it's just a checkout, commits live on the branch).
    remove_worktree "$worktree_dir"

    # Delete the branch only if merge succeeded (or had no commits).
    # On merge failure, preserve the branch so the user can resolve manually.
    if [ "$merge_failed" = false ]; then
      git branch -D "$branch_name" 2>/dev/null || true
    fi

    # Transition PRD: ~running -> ~done -> archive
    local progress_file
    progress_file=$(progress_file_for "$prd_file")

    if [ "$exit_code" -eq 0 ]; then
      local done_prd
      done_prd=$(mark_done "$prd_file") || true
      echo -e "$(ts) ${CYAN}[${tag}]${RESET} ${GREEN}Marked done: $(basename "$done_prd")${RESET}"
      archive_run "$done_prd" "$progress_file" "$tag"
    else
      echo -e "$(ts) ${CYAN}[${tag}]${RESET} ${YELLOW}Incomplete — marking done and archiving.${RESET}"
      local done_prd
      done_prd=$(mark_done "$prd_file") || true
      archive_run "$done_prd" "$progress_file" "$tag"
    fi

    # Clean up temp files
    rm -f "$result_file"

    # Free the slot
    WORKER_PIDS[$s]=""
    WORKER_PRDS[$s]=""
    WORKER_WORKTREES[$s]=""
    WORKER_BRANCHES[$s]=""
    WORKER_RESULT_FILES[$s]=""
    WORKER_TAGS[$s]=""
  done
}

# --- Main ---

echo ""
echo -e "$(ts) ${BOLD}╔═══════════════════════════════════════════════════════════╗${RESET}"
echo -e "$(ts) ${BOLD}║  Ralph — Parallel PRD Consumer (worktree isolation)      ║${RESET}"
echo -e "$(ts) ${BOLD}╚═══════════════════════════════════════════════════════════╝${RESET}"
echo ""
echo -e "$(ts)   Tool:     ${CYAN}${TOOL}${RESET}"
[ -n "$MODEL" ] && echo -e "$(ts)   Model:    ${CYAN}${MODEL}${RESET}"
echo -e "$(ts)   Workers:  ${CYAN}${MAX_WORKERS}${RESET}"
echo -e "$(ts)   Mode:     ${CYAN}$([ "$ONCE" = true ] && echo "single batch" || echo "daemon (poll every ${POLL_INTERVAL}s)")${RESET}"
echo -e "$(ts)   Watching: ${CYAN}${SCRIPT_DIR}${RESET}"
echo ""

DISPATCHED_ANY=false

# Recovery: resume any ~running PRDs from a previous crash.
RUNNING_PRDS=$(find_running_prds)
if [ -n "$RUNNING_PRDS" ]; then
  echo -e "$(ts) ${YELLOW}Recovering interrupted PRDs:${RESET}"
  while IFS= read -r rprd; do
    [ -z "$rprd" ] && continue
    echo -e "$(ts) ${YELLOW}  - $(basename "$rprd")${RESET}"
    # dispatch_prd expects a non-running file and calls mark_running itself,
    # so rename ~running back to ready. If a slot is free, dispatch now;
    # otherwise the main loop will pick it up when a slot opens.
    local_ready="${rprd/\~running.json/.json}"
    mv "$rprd" "$local_ready" 2>/dev/null || true
    SLOT=$(find_free_slot)
    if [ -n "$SLOT" ]; then
      dispatch_prd "$local_ready" "$SLOT" && DISPATCHED_ANY=true || true
    else
      echo -e "$(ts) ${YELLOW}  (no free slots — will dispatch when a slot opens)${RESET}"
    fi
  done <<< "$RUNNING_PRDS"
fi

while true; do
  # Reap completed workers first
  reap_workers

  # Count active workers
  ACTIVE=$(count_active_workers)

  # In --once mode, exit only when all workers are done AND no more ready PRDs
  # remain. Without the has_ready_prds check, ralph exits prematurely if all
  # current workers complete in one reap cycle but more PRDs are still queued
  # (e.g., 5 PRDs with 3 workers — when the first 3 finish simultaneously,
  # the exit check would fire before the remaining 2 get dispatched).
  if [ "$ONCE" = true ] && [ "$DISPATCHED_ANY" = true ] && [ "$ACTIVE" -eq 0 ]; then
    if ! has_ready_prds; then
      echo ""
      echo -e "$(ts) ${DIM}--once mode: all PRDs complete. Exiting.${RESET}"
      exit 0
    fi
  fi

  # Dispatch new PRDs to free slots
  if [ "$ACTIVE" -lt "$MAX_WORKERS" ]; then
    READY_PRDS=$(find_ready_prds)

    if [ -n "$READY_PRDS" ]; then
      while IFS= read -r prd; do
        [ -z "$prd" ] && continue

        SLOT=$(find_free_slot)
        [ -z "$SLOT" ] && break  # All slots full

        dispatch_prd "$prd" "$SLOT" && DISPATCHED_ANY=true || true
      done <<< "$READY_PRDS"
    fi
  fi

  # In --once mode with nothing dispatched and no active workers, exit
  if [ "$ONCE" = true ] && [ "$DISPATCHED_ANY" = false ]; then
    ACTIVE=$(count_active_workers)
    if [ "$ACTIVE" -eq 0 ]; then
      echo -e "$(ts) ${DIM}No PRD files found. Exiting (--once mode).${RESET}"
      exit 0
    fi
  fi

  sleep "$POLL_INTERVAL"
done
