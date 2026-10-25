#!/usr/bin/env bash
set -euo pipefail

root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
hook_script="${HOOK_SCRIPT:-$script_dir/../bin/mcw-session-status}"
proc="$root/proc"
mkdir -p "$proc/${BASHPID}"
printf 'claude\0--resume\0' > "$proc/${BASHPID}/cmdline"
printf '%s (claude) S 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 77 1\n' "$BASHPID" > "$proc/${BASHPID}/stat"
printf 'Name:\tclaude\nState:\tS (sleeping)\nPPid:\t1\n' > "$proc/${BASHPID}/status"
printf '1000.00 0.00\n' > "$proc/uptime"
payload='{"hook_event_name":"UserPromptSubmit"}'
for _ in $(seq 1 16); do
  printf '%s' "$payload" | MCW_STATE_DIR="$root/state" MCW_PROC_ROOT="$proc" ZELLIJ_SESSION_NAME=causal ZELLIJ_PANE_ID=0 bash "$hook_script" busy hook &
done
wait
ledger="$root/state/session-status/causal/0.events.jsonl"
test "$(wc -l < "$ledger")" = 16
jq -s 'map(.sequence) | sort | . == [range(1;17)]' "$ledger" | grep -qx true

# A long-running tool can precede hundreds of completed tools.  Rotation must
# retain its unmatched PreToolUse in the compact checkpoint.
printf '%s' '{"hook_event_name":"PreToolUse","tool_use_id":"long"}' | MCW_STATE_DIR="$root/state" MCW_PROC_ROOT="$proc" ZELLIJ_SESSION_NAME=causal ZELLIJ_PANE_ID=0 bash "$hook_script" busy hook
for number in $(seq 1 70); do
  printf '{"hook_event_name":"PreToolUse","tool_use_id":"done-%s"}' "$number" | MCW_STATE_DIR="$root/state" MCW_PROC_ROOT="$proc" ZELLIJ_SESSION_NAME=causal ZELLIJ_PANE_ID=0 bash "$hook_script" busy hook
  printf '{"hook_event_name":"PostToolUse","tool_use_id":"done-%s"}' "$number" | MCW_STATE_DIR="$root/state" MCW_PROC_ROOT="$proc" ZELLIJ_SESSION_NAME=causal ZELLIJ_PANE_ID=0 bash "$hook_script" idle hook
done
jq -e '[.events[] | select(.eventName == "PreToolUse" and .toolUseId == "long")] | length == 1' "$root/state/session-status/causal/0.events.state.json" >/dev/null

# A delayed duplicate can arrive after far more than the old 64-entry
# tombstone window. It must stay rejected for this prompt's full turn.
printf '%s' '{"hook_event_name":"PreToolUse","tool_use_id":"retired"}' | MCW_STATE_DIR="$root/state" MCW_PROC_ROOT="$proc" ZELLIJ_SESSION_NAME=causal ZELLIJ_PANE_ID=0 bash "$hook_script" busy hook
printf '%s' '{"hook_event_name":"PostToolUse","tool_use_id":"retired"}' | MCW_STATE_DIR="$root/state" MCW_PROC_ROOT="$proc" ZELLIJ_SESSION_NAME=causal ZELLIJ_PANE_ID=0 bash "$hook_script" idle hook
for number in $(seq 1 65); do
  printf '{"hook_event_name":"PreToolUse","tool_use_id":"later-%s"}' "$number" | MCW_STATE_DIR="$root/state" MCW_PROC_ROOT="$proc" ZELLIJ_SESSION_NAME=causal ZELLIJ_PANE_ID=0 bash "$hook_script" busy hook
  printf '{"hook_event_name":"PostToolUse","tool_use_id":"later-%s"}' "$number" | MCW_STATE_DIR="$root/state" MCW_PROC_ROOT="$proc" ZELLIJ_SESSION_NAME=causal ZELLIJ_PANE_ID=0 bash "$hook_script" idle hook
done
printf '%s' '{"hook_event_name":"PreToolUse","tool_use_id":"retired"}' | MCW_STATE_DIR="$root/state" MCW_PROC_ROOT="$proc" ZELLIJ_SESSION_NAME=causal ZELLIJ_PANE_ID=0 bash "$hook_script" busy hook
jq -s -e '[.[] | select(.eventName == "PreToolUse" and .toolUseId == "retired") | .accepted] == [true, false]' "$ledger" >/dev/null

printf '%s' '{"hook_event_name":"PreToolUse","tool_use_id":"old"}' | MCW_STATE_DIR="$root/state" MCW_PROC_ROOT="$proc" ZELLIJ_SESSION_NAME=causal ZELLIJ_PANE_ID=0 bash "$hook_script" busy hook
printf '%s' '{"hook_event_name":"Stop"}' | MCW_STATE_DIR="$root/state" MCW_PROC_ROOT="$proc" ZELLIJ_SESSION_NAME=causal ZELLIJ_PANE_ID=0 bash "$hook_script" idle stop
printf '%s' '{"hook_event_name":"PreToolUse","tool_use_id":"old"}' | MCW_STATE_DIR="$root/state" MCW_PROC_ROOT="$proc" ZELLIJ_SESSION_NAME=causal ZELLIJ_PANE_ID=0 bash "$hook_script" busy hook
printf '%s' '{"hook_event_name":"PreToolUse","tool_use_id":"new"}' | MCW_STATE_DIR="$root/state" MCW_PROC_ROOT="$proc" ZELLIJ_SESSION_NAME=causal ZELLIJ_PANE_ID=0 bash "$hook_script" busy hook
jq -s -e '[.[] | select(.eventName == "PreToolUse" and .toolUseId == "old") | .accepted] == [true, false]' "$ledger" >/dev/null
jq -s -e '[.[] | select(.eventName == "PreToolUse" and .toolUseId == "new") | .accepted] == [true]' "$ledger" >/dev/null

# A crash between append and counter replacement cannot reuse a sequence.
before_sequence="$(jq -s 'map(.sequence) | max' "$ledger")"
rm -f "$root/state/session-status/causal/0.events.sequence"
printf '%s' '{"hook_event_name":"Stop"}' | MCW_STATE_DIR="$root/state" MCW_PROC_ROOT="$proc" ZELLIJ_SESSION_NAME=causal ZELLIJ_PANE_ID=0 bash "$hook_script" idle hook
after_sequence="$(jq -s 'map(.sequence) | max' "$ledger")"
test "$after_sequence" -gt "$before_sequence"

# The checkpoint keeps current-turn completion identities without mirroring
# every completed event.  Delayed duplicate detection therefore has no 64-id
# hole and checkpoint size grows with ids, not full hook records.
checkpoint="$root/state/session-status/causal/0.events.state.json"
jq -e '[.events[] | select(.eventName == "PostToolUse")] | length >= 70' "$checkpoint" >/dev/null
# Completion identities are durable raw PostToolUse observations for this
# prompt. There is no arbitrary tombstone cap.
jq -e '[.events[] | select(.eventName == "PostToolUse" and (.toolUseId | startswith("done-")))] | length == 70' "$checkpoint" >/dev/null

# A renamed session can retain one hook namespace.  Dead PID/start partitions
# are removed, while a different live owner in the same namespace survives.
mkdir -p "$proc/4242"
printf 'claude\0--resume\0' > "$proc/4242/cmdline"
printf '%s (claude) S 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 77 1\n' 4242 > "$proc/4242/stat"
printf 'Name:\tclaude\nState:\tS (sleeping)\nPPid:\t1\n' > "$proc/4242/status"
jq '.events += [
  {eventName:"PreToolUse",pid:9999,pidStartTicks:9,sequence:1,updatedAt:1,toolUseId:"dead"},
  {eventName:"PreToolUse",pid:4242,pidStartTicks:77,sequence:2,updatedAt:1,toolUseId:"other-live"}
]' "$checkpoint" > "$checkpoint.tmp"
mv "$checkpoint.tmp" "$checkpoint"
printf '%s' '{"hook_event_name":"Notification"}' | MCW_STATE_DIR="$root/state" MCW_PROC_ROOT="$proc" ZELLIJ_SESSION_NAME=causal ZELLIJ_PANE_ID=0 bash "$hook_script" idle hook
jq -e '[.events[] | select(.pid == 9999)] | length == 0' "$checkpoint" >/dev/null
jq -e '[.events[] | select(.pid == 4242 and .pidStartTicks == 77)] | length == 1' "$checkpoint" >/dev/null
echo 'hook causal serialization, duplicate rejection, and automatic turn: PASS'
