#!/bin/bash
# Perfect Loop — Converge the entire codebase to the highest standard
#
# Usage: .ralph/perfect.sh [--tool claude] [--max-rounds N] [--dry-run]
#
# Runs an infinite convergence loop:
#   1. Claude audits the entire codebase (PERFECT.md)
#   2. If PERFECT → exit successfully (codebase is at the highest standard)
#   3. If NEEDS_RALPH → run ralph.sh to execute fixes, then loop back to 1
#
# The loop terminates when the auditor finds nothing left to improve.
# All output (audit + ralph) goes to stdout. To log:
#   nohup .ralph/perfect.sh > /tmp/opentabs-ralph.log 2>&1 &

set -e

# --- Argument Parsing ---

TOOL="claude"
MAX_ROUNDS=""
DRY_RUN=false

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
    --max-rounds)
      MAX_ROUNDS="$2"
      shift 2
      ;;
    --max-rounds=*)
      MAX_ROUNDS="${1#*=}"
      shift
      ;;
    --dry-run)
      DRY_RUN=true
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

# --- Setup ---

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

PERFECT_PROMPT="$SCRIPT_DIR/PERFECT.md"
PRD_FILE="$SCRIPT_DIR/prd.json"

# Colors
RED='\033[31m'
GREEN='\033[32m'
YELLOW='\033[33m'
CYAN='\033[36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# --- Validation ---

if [ ! -f "$PERFECT_PROMPT" ]; then
  echo -e "${RED}Error: No PERFECT.md found at $PERFECT_PROMPT${RESET}"
  exit 1
fi

if [ ! -f "$SCRIPT_DIR/ralph.sh" ]; then
  echo -e "${RED}Error: No ralph.sh found at $SCRIPT_DIR/ralph.sh${RESET}"
  exit 1
fi

# --- Stream Filter ---
# Extracts concise progress lines from claude's stream-json output.

stream_filter() {
  local result_file="$1"
  local DIM='\033[2m'
  local CYAN='\033[36m'
  local GREEN='\033[32m'
  local YELLOW='\033[33m'
  local RESET='\033[0m'

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
            printf "${CYAN}    ▸ %-8s${RESET} ${DIM}%s${RESET}\n" "$tool_name" "$tool_detail"
          done <<< "$tool_uses"
        fi

        local text_content
        text_content=$(echo "$line" | jq -r '
          [.message.content[]? | select(.type == "text") | .text] | join("")
        ' 2>/dev/null)

        if [ -n "$text_content" ] && [ "$text_content" != "null" ]; then
          printf "${GREEN}    ✦ %.120s${RESET}\n" "$text_content"
          # Capture signals from assistant text
          if echo "$text_content" | grep -qE "<promise>(PERFECT|NEEDS_RALPH)</promise>" 2>/dev/null; then
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

        printf "\n${YELLOW}    ⏱  %ss  │  %s turns  │  \$%s${RESET}\n" "$duration_s" "$num_turns" "$cost"
        ;;
    esac
  done
}

# --- Main Loop ---

echo ""
echo -e "${BOLD}╔═══════════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║  Perfect Loop — Converge to the Highest Standard         ║${RESET}"
echo -e "${BOLD}╚═══════════════════════════════════════════════════════════╝${RESET}"
echo ""
echo -e "  Tool:         ${CYAN}${TOOL}${RESET}"
if [ -n "$MAX_ROUNDS" ]; then
  echo -e "  Max rounds:   ${CYAN}${MAX_ROUNDS}${RESET}"
else
  echo -e "  Max rounds:   ${CYAN}unlimited (until PERFECT)${RESET}"
fi
echo ""

ROUND=0
TOTAL_STORIES_FIXED=0

while true; do
  ROUND=$((ROUND + 1))

  # Check max rounds
  if [ -n "$MAX_ROUNDS" ] && [ "$ROUND" -gt "$MAX_ROUNDS" ]; then
    echo ""
    echo -e "${YELLOW}Reached max rounds ($MAX_ROUNDS) without achieving PERFECT.${RESET}"
    echo -e "${YELLOW}Total stories fixed across all rounds: $TOTAL_STORIES_FIXED${RESET}"
    echo -e "${YELLOW}Run again to continue converging.${RESET}"
    exit 1
  fi

  echo ""
  echo -e "${BOLD}┌───────────────────────────────────────────────────────────┐${RESET}"
  echo -e "${BOLD}│  Round $ROUND — Audit Phase                                   ${RESET}"
  echo -e "${BOLD}└───────────────────────────────────────────────────────────┘${RESET}"

  if [ "$DRY_RUN" = true ]; then
    echo -e "${YELLOW}  [DRY RUN] Would run audit. Exiting.${RESET}"
    exit 0
  fi

  # --- Phase 1: Audit ---
  echo -e "\n${CYAN}  Running codebase audit...${RESET}"

  AUDIT_RESULT_FILE=$(mktemp)

  claude --dangerously-skip-permissions \
    --print \
    --output-format stream-json \
    --verbose \
    < "$PERFECT_PROMPT" 2>/dev/null \
    | stream_filter "$AUDIT_RESULT_FILE" || true

  # --- Check audit result ---

  if [ -f "$AUDIT_RESULT_FILE" ] && grep -q "<promise>PERFECT</promise>" "$AUDIT_RESULT_FILE" 2>/dev/null; then
    # Codebase is perfect — we're done
    echo ""
    echo -e "${BOLD}${GREEN}╔═══════════════════════════════════════════════════════════╗${RESET}"
    echo -e "${BOLD}${GREEN}║                                                           ║${RESET}"
    echo -e "${BOLD}${GREEN}║   PERFECT — Codebase is at the highest standard.          ║${RESET}"
    echo -e "${BOLD}${GREEN}║                                                           ║${RESET}"
    echo -e "${BOLD}${GREEN}║   Converged in $ROUND round(s).                                  ${RESET}"
    echo -e "${BOLD}${GREEN}║   Total stories fixed: $TOTAL_STORIES_FIXED                                ${RESET}"
    echo -e "${BOLD}${GREEN}║                                                           ║${RESET}"
    echo -e "${BOLD}${GREEN}╚═══════════════════════════════════════════════════════════╝${RESET}"
    echo ""
    rm -f "$AUDIT_RESULT_FILE"
    exit 0
  fi

  if [ -f "$AUDIT_RESULT_FILE" ] && grep -q "<promise>NEEDS_RALPH</promise>" "$AUDIT_RESULT_FILE" 2>/dev/null; then
    rm -f "$AUDIT_RESULT_FILE"

    # Verify prd.json was generated
    if [ ! -f "$PRD_FILE" ]; then
      echo -e "${RED}  Audit signaled NEEDS_RALPH but did not generate prd.json.${RESET}"
      echo -e "${RED}  This is an auditor error. Retrying next round.${RESET}"
      continue
    fi

    STORY_COUNT=$(jq '.userStories | length' "$PRD_FILE" 2>/dev/null || echo "0")
    echo ""
    echo -e "${CYAN}  Audit found ${STORY_COUNT} issue(s) to fix.${RESET}"

    # --- Phase 2: Ralph execution ---
    echo ""
    echo -e "${BOLD}┌───────────────────────────────────────────────────────────┐${RESET}"
    echo -e "${BOLD}│  Round $ROUND — Ralph Execution ($STORY_COUNT stories)                  ${RESET}"
    echo -e "${BOLD}└───────────────────────────────────────────────────────────┘${RESET}"

    "$SCRIPT_DIR/ralph.sh" --tool "$TOOL" || true

    # Tally results: ralph archives prd.json on completion, so read from
    # the archive if the file was moved, otherwise read in-place.
    if [ -f "$PRD_FILE" ]; then
      TALLY_FILE="$PRD_FILE"
    else
      # prd.json was archived — find the most recent archive
      TALLY_FILE=$(find "$SCRIPT_DIR/archive" -name "prd.json" -type f 2>/dev/null | sort | tail -1)
    fi

    if [ -n "$TALLY_FILE" ] && [ -f "$TALLY_FILE" ]; then
      STORIES_PASSED=$(jq '[.userStories[] | select(.passes == true)] | length' "$TALLY_FILE" 2>/dev/null || echo "0")
      STORIES_TOTAL=$(jq '.userStories | length' "$TALLY_FILE" 2>/dev/null || echo "0")
    else
      STORIES_PASSED="$STORY_COUNT"
      STORIES_TOTAL="$STORY_COUNT"
    fi

    TOTAL_STORIES_FIXED=$((TOTAL_STORIES_FIXED + STORIES_PASSED))

    echo ""
    echo -e "  Round $ROUND results: ${GREEN}${STORIES_PASSED}${RESET}/${STORIES_TOTAL} stories fixed"
    echo -e "  Total fixed so far: ${GREEN}${TOTAL_STORIES_FIXED}${RESET}"

    if [ "$STORIES_PASSED" -lt "$STORIES_TOTAL" ]; then
      echo -e "${YELLOW}  Ralph did not complete all stories. Continuing to next audit round.${RESET}"
    fi

    # Loop back to audit phase
    sleep 2
    continue
  fi

  # No recognized signal — auditor failed to produce a decision
  echo ""
  echo -e "${RED}  Audit did not produce a PERFECT or NEEDS_RALPH signal.${RESET}"
  echo -e "${RED}  This is an auditor error. Retrying next round.${RESET}"
  rm -f "$AUDIT_RESULT_FILE"
  sleep 2
done
