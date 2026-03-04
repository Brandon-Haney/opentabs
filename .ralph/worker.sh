#!/bin/bash
# Ralph Worker Script — runs inside the Docker container.
#
# This script contains the agent execution loop that was previously inlined
# in ralph.sh as the execute_prd_in_worktree function. It runs inside a
# Docker container with the git worktree bind-mounted at /workspace.
#
# Arguments (passed as environment variables by consumer.sh):
#   WORKER_TOOL            — "claude" or "amp"
#   WORKER_PRD_FILE        — basename of the PRD file (e.g., prd-..~running.json)
#   WORKER_RESULT_FILE     — path to result file inside container
#   WORKER_TAG             — worker tag for log prefixing (e.g., "W0:my-feature")
#   WORKER_MODEL_SONNET    — model name for sonnet stories (default: claude-sonnet)
#   WORKER_MODEL_OPUS      — model name for opus stories (default: claude-opus)
#
# The container's /workspace is the git worktree (bind-mounted from host).
# All output goes to stdout/stderr and is captured by `docker logs -f`
# on the host side, where ralph.sh pipes it through ts_prefix/stream_filter.

# NOTE: set -e is intentionally NOT used — same rationale as ralph.sh.

TOOL="${WORKER_TOOL:-claude}"
PRD_BASENAME="${WORKER_PRD_FILE}"
RESULT_FILE="${WORKER_RESULT_FILE:-/tmp/worker-result.txt}"
TAG="${WORKER_TAG:-worker}"

# The worktree is mounted at its original host path (not /workspace) so that
# the .git file's absolute path back to the main repo resolves correctly.
WORKTREE_DIR="${WORKER_WORKTREE_DIR:-/workspace}"

# Current story progress — updated by execute_prd, read by log_prefix.
# Format: "(passed/total)" e.g., "(1/4)". Empty before first iteration.
STORY_PROGRESS=""

# Colors for log output
C_TAG=$'\033[36m'       # cyan — worker tag (W0, W1, ...)
C_SLUG=$'\033[1;34m'    # bold blue — PRD slug (docs-fill-sdk-gaps)
C_PROG=$'\033[33m'      # yellow — story progress (2/4)
C_DIM=$'\033[2m'        # dim — brackets and separators
C_RESET=$'\033[0m'

# Prefixed echo — prepends the worker tag + story progress to every line.
# Format: [W0:docs-fill-sdk-gaps(2/4)] message
wlog() {
  local slot="${TAG%%:*}"
  local slug="${TAG#*:}"
  # STORY_PROGRESS is "(passed/total)" or empty
  local prog=""
  if [ -n "$STORY_PROGRESS" ]; then
    local nums="${STORY_PROGRESS#(}"
    nums="${nums%)}"
    prog="${C_DIM}(${C_RESET}${C_PROG}${nums}${C_RESET}${C_DIM})${C_RESET}"
  fi
  echo "${C_DIM}[${C_RESET}${C_TAG}${slot}${C_RESET}${C_DIM}:${C_RESET}${C_SLUG}${slug}${C_RESET}${prog}${C_DIM}]${C_RESET} $*"
}

# --- Stream filter ---
# Extracts concise progress lines from claude's stream-json output.

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
            wlog "$(printf '\033[32m▸\033[0m \033[1m%-8s\033[0m \033[2m%s\033[0m' "$tool_name" "$tool_detail")"
          done <<< "$tool_uses"
        fi

        local text_content
        text_content=$(echo "$line" | jq -r '
          [.message.content[]? | select(.type == "text") | .text] | join("")
        ' 2>/dev/null)

        if [ -n "$text_content" ] && [ "$text_content" != "null" ]; then
          # Prefix each line separately — text_content can be multi-line
          echo "$text_content" | head -5 | while IFS= read -r tline; do
            wlog "$(printf '\033[35m✦\033[0m %.120s' "$tline")"
          done
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

        wlog "$(printf '\033[33m⏱  %ss  │  %s turns  │  $%s\033[0m' "$duration_s" "$num_turns" "$cost")"
        ;;
    esac
  done
}

# --- Main execution logic (equivalent to execute_prd_in_worktree) ---

execute_prd() {
  local wt_prd="$WORKTREE_DIR/.ralph/$PRD_BASENAME"

  # Sanity check: the worktree PRD must exist (copied by dispatch_prd on host).
  if [ ! -f "$wt_prd" ]; then
    wlog "ERROR: PRD file not found in worktree: $wt_prd"
    return 1
  fi

  # Derive progress file from PRD name
  local clean_base
  clean_base=$(basename "$PRD_BASENAME" .json)
  clean_base="${clean_base/~running/}"
  clean_base="${clean_base/~done/}"
  clean_base="${clean_base/~draft/}"
  local progress_basename="progress-${clean_base#prd-}.txt"
  local wt_progress="$WORKTREE_DIR/.ralph/$progress_basename"

  # Check if this PRD needs E2E safety net (root monorepo without custom qualityChecks).
  local has_quality_checks
  has_quality_checks=$(jq -r '.qualityChecks // ""' "$wt_prd" 2>/dev/null)

  # Safety net: run the full verification suite (including E2E) in the worktree if
  # the last completed story was not an e2eCheckpoint.
  _run_e2e_safety_net() {
    if [ -n "$has_quality_checks" ]; then
      wlog "Safety net: skipped (custom qualityChecks — E2E is not separate)."
      return 0
    fi

    local last_checkpoint
    last_checkpoint=$(jq '
      [.userStories[] | select(.passes == true)]
      | sort_by(.priority)
      | last
      | .e2eCheckpoint // false
    ' "$wt_prd" 2>/dev/null)

    if [ "$last_checkpoint" = "true" ]; then
      wlog "Safety net: skipped (last story was an e2eCheckpoint)."
      return 0
    fi

    wlog ""
    wlog "── E2E Safety Net ──"
    wlog "Last completed story was not an e2eCheckpoint. Running full suite including E2E before merge..."

    if [ ! -d "$WORKTREE_DIR" ]; then
      wlog "ERROR: Worktree directory no longer exists: $WORKTREE_DIR"
      return 1
    fi

    if (cd "$WORKTREE_DIR" && npm run build && npm run type-check && npm run lint && npm run knip && npm run test && npm run test:e2e); then
      wlog "Safety net: full suite passed."
      return 0
    else
      wlog "Safety net: full suite FAILED."
      return 1
    fi
  }

  # Launch a fix iteration for safety net failures.
  _run_e2e_fix_iteration() {
    local fix_num="$1"
    wlog ""
    wlog "── Safety Net Fix Iteration $fix_num ──"

    local E2E_FIX_PROMPT
    E2E_FIX_PROMPT="# Safety Net Fix Task

You are an autonomous coding agent running in a git worktree. The safety net verification failed after all PRD stories were completed. Your ONLY task is to fix the failures.

## Steps

1. Run the full verification suite to reproduce the failures:
   \`\`\`bash
   npm run build && npm run type-check && npm run lint && npm run knip && npm run test && npm run test:e2e
   \`\`\`
2. Read the output carefully to identify which check failed and why
3. Fix the root cause in the source code (not in the tests, unless the tests themselves are wrong)
4. Re-run the full verification suite to confirm everything passes
5. If any check still fails, fix it and re-run again
6. Once all checks pass, commit your fix:
   \`\`\`bash
   git add <changed files>
   git commit -m \"fix: resolve safety net failures\"
   \`\`\`

## Rules

- Do NOT read or modify any PRD files in \`.ralph/\`
- Do NOT pick up or implement any user stories
- Only fix the verification failures — keep changes minimal and focused
- Stage only the specific files you changed (never \`git add .\`)
- Files in \`.ralph/\` must never be committed"

    local FIX_RESULT_FILE
    FIX_RESULT_FILE=$(mktemp)
    local FIX_STDERR
    FIX_STDERR=$(mktemp)

    if [[ "$TOOL" == "amp" ]]; then
      echo "$E2E_FIX_PROMPT" | (cd "$WORKTREE_DIR" && amp --dangerously-allow-all) 2>&1 || true
    else
      # E2E fix iterations always use opus — debugging test failures requires deeper reasoning
      local fix_model="${WORKER_MODEL_OPUS:-claude-opus}"
      CLAUDE_ARGS=(--dangerously-skip-permissions --print --output-format stream-json --verbose)
      CLAUDE_ARGS+=(--model "$fix_model")
      echo "$E2E_FIX_PROMPT" | (cd "$WORKTREE_DIR" && claude "${CLAUDE_ARGS[@]}") \
        2>"$FIX_STDERR" | stream_filter "$FIX_RESULT_FILE" || true
    fi

    rm -f "$FIX_RESULT_FILE" "$FIX_STDERR"
  }

  # Auto-calculate iterations from remaining stories
  local remaining total buffer max_iterations
  remaining=$(jq '[.userStories[] | select(.passes != true)] | length' "$wt_prd" 2>/dev/null || echo "0")
  total=$(jq '.userStories | length' "$wt_prd" 2>/dev/null || echo "?")

  STORY_PROGRESS="($(( total - remaining ))/$total)"

  if [ "$remaining" -eq 0 ]; then
    wlog "All stories already pass."

    if _run_e2e_safety_net; then
      return 0
    fi

    local max_e2e_fixes=3
    for fix_i in $(seq 1 $max_e2e_fixes); do
      _run_e2e_fix_iteration "$fix_i"
      if _run_e2e_safety_net; then
        return 0
      fi
    done

    wlog "ERROR: Safety net still failing after $max_e2e_fixes fix attempts."
    return 1
  fi

  buffer=$(( (remaining + 2) / 3 ))
  [ "$buffer" -lt 1 ] && buffer=1
  max_iterations=$(( remaining + buffer ))

  wlog "Stories: $remaining remaining (of $total total), $max_iterations iterations max"

  # Initialize progress file in worktree
  if [ ! -f "$wt_progress" ]; then
    echo "# Ralph Progress Log" > "$wt_progress"
    echo "PRD: $PRD_BASENAME" >> "$wt_progress"
    echo "Started: $(date)" >> "$wt_progress"
    echo "---" >> "$wt_progress"
  fi

  for i in $(seq 1 $max_iterations); do
    # Check if all stories pass before each iteration
    remaining=$(jq '[.userStories[] | select(.passes != true)] | length' "$wt_prd" 2>/dev/null || echo "0")
    STORY_PROGRESS="($(( total - remaining ))/$total)"

    if [ "$remaining" -eq 0 ]; then
      wlog ""
      wlog "All stories pass! Completed before iteration $i."

      if _run_e2e_safety_net; then
        return 0
      fi

      local max_e2e_fixes=3
      for fix_i in $(seq 1 $max_e2e_fixes); do
        _run_e2e_fix_iteration "$fix_i"
        if _run_e2e_safety_net; then
          return 0
        fi
      done

      wlog "ERROR: Safety net still failing after $max_e2e_fixes fix attempts."
      return 1
    fi

    local passed=$(( total - remaining ))
    wlog ""
    wlog "── Iteration $i/$max_iterations — story ($passed/$total) — $remaining remaining ──"

    # Determine model for the current (first incomplete) story from the PRD.
    # Each story has a "model" field: "sonnet" or "opus". The worker maps these
    # to the actual model names via WORKER_MODEL_SONNET / WORKER_MODEL_OPUS env vars.
    local story_model
    story_model=$(jq -r '[.userStories[] | select(.passes != true)] | sort_by(.priority) | .[0].model // "sonnet"' "$wt_prd" 2>/dev/null || echo "sonnet")
    local iter_model=""
    if [ "$story_model" = "opus" ]; then
      iter_model="${WORKER_MODEL_OPUS:-claude-opus}"
    else
      iter_model="${WORKER_MODEL_SONNET:-claude-sonnet}"
    fi
    wlog "Model: $iter_model (story requests: $story_model)"

    ITER_RESULT_FILE=$(mktemp)
    STDERR_FILE=$(mktemp)

    if [[ "$TOOL" == "amp" ]]; then
      OUTPUT=$(cat "$WORKTREE_DIR/.ralph/RALPH.md" | (cd "$WORKTREE_DIR" && amp --dangerously-allow-all) 2>&1 | tee /dev/stderr) || true
      echo "$OUTPUT" > "$ITER_RESULT_FILE"
    else
      CLAUDE_ARGS=(--dangerously-skip-permissions --print --output-format stream-json --verbose)
      CLAUDE_ARGS+=(--model "$iter_model")
      (cd "$WORKTREE_DIR" && claude "${CLAUDE_ARGS[@]}") \
        < "$WORKTREE_DIR/.ralph/RALPH.md" 2>"$STDERR_FILE" \
        | stream_filter "$ITER_RESULT_FILE" || true
    fi

    # Detect empty iterations
    ITER_RESULT_SIZE=$(wc -c < "$ITER_RESULT_FILE" 2>/dev/null | tr -d ' ')
    if [ "${ITER_RESULT_SIZE:-0}" -eq 0 ]; then
      wlog ""
      wlog "ERROR: Empty iteration — claude produced no output."
      if [ -s "$STDERR_FILE" ]; then
        wlog "stderr:"
        head -20 "$STDERR_FILE" | while IFS= read -r sline; do
          wlog "  $sline"
        done
      fi
      rm -f "$ITER_RESULT_FILE" "$STDERR_FILE"
      wlog "Aborting PRD to avoid burning iterations."
      return 1
    fi

    rm -f "$STDERR_FILE"

    if [ -f "$ITER_RESULT_FILE" ] && grep -q "<promise>COMPLETE</promise>" "$ITER_RESULT_FILE" 2>/dev/null; then
      wlog ""
      wlog "All tasks complete!"
      rm -f "$ITER_RESULT_FILE"

      if _run_e2e_safety_net; then
        return 0
      fi

      local max_e2e_fixes=3
      for fix_i in $(seq 1 $max_e2e_fixes); do
        _run_e2e_fix_iteration "$fix_i"
        if _run_e2e_safety_net; then
          return 0
        fi
      done

      wlog "ERROR: Safety net still failing after $max_e2e_fixes fix attempts."
      return 1
    fi

    rm -f "$ITER_RESULT_FILE"

    # Push new commits to remote after each iteration so work is never lost.
    # The branch is unique to this worker — no conflicts possible.
    local branch_name
    branch_name=$(git -C "$WORKTREE_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null)
    local unpushed
    unpushed=$(git -C "$WORKTREE_DIR" rev-list --count "origin/main..$branch_name" 2>/dev/null || echo "0")
    local remote_exists
    remote_exists=$(git -C "$WORKTREE_DIR" ls-remote --heads origin "$branch_name" 2>/dev/null | wc -l | tr -d ' ')
    # Only count unpushed relative to remote branch if it exists
    if [ "$remote_exists" -gt 0 ]; then
      unpushed=$(git -C "$WORKTREE_DIR" rev-list --count "origin/$branch_name..$branch_name" 2>/dev/null || echo "$unpushed")
    fi
    if [ "$unpushed" -gt 0 ]; then
      if git -C "$WORKTREE_DIR" push origin "$branch_name" --quiet 2>/dev/null; then
        wlog "Pushed $unpushed commit(s) to origin/$branch_name"
      elif git -C "$WORKTREE_DIR" push origin "$branch_name" --force-with-lease --quiet 2>/dev/null; then
        wlog "Force-pushed $unpushed commit(s) to origin/$branch_name (non-fast-forward resolved)"
      else
        wlog "WARNING: Failed to push commits (will retry next iteration)"
      fi
    fi

    sleep 2
  done

  wlog ""
  wlog "Reached max iterations ($max_iterations) without completing all stories."
  return 1
}

# --- Run the worker ---
execute_prd
EXIT_CODE=$?
echo "$EXIT_CODE" > "$RESULT_FILE.exit"
exit $EXIT_CODE
