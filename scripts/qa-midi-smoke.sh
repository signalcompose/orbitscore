#!/usr/bin/env bash
#
# qa-midi-smoke.sh — parse/schedule health smoke for MIDI .orbs examples (Epic #278, Phase B).
#
# Runs each example through the REAL engine path via `npm run midi-run` (parser →
# degree resolution → MidiScheduler → MidiOutput → IAC) WITHOUT SuperCollider, then
# checks that it reached the running state without a parse/degree/schedule error.
#
# This is a SMOKE, not a correctness check: it proves the DSL parses, degrees resolve,
# and events schedule to IAC without crashing. The musical *content* (are the right
# notes sounding?) is a human observation — see docs/testing/QA_2.0.0.md (P/H matrix).
#
# Requirements:
#   - macOS with an "IAC" CoreMIDI output port online (Audio MIDI Setup → MIDI Studio).
#   - Run from the repo root.
#
# Usage:
#   scripts/qa-midi-smoke.sh                 # smoke examples/11..18 (the MIDI pillars)
#   scripts/qa-midi-smoke.sh examples/12_chords_stacks.orbs   # smoke specific files
#
# Exit code: 0 if every file passed, 1 otherwise.

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2

# How long to let each file run before stopping it (seconds). One bar at the slowest
# example tempo (~96 bpm, 4/4) is ~2.5s; 5s comfortably covers a RUN one-shot.
DWELL="${QA_SMOKE_DWELL:-5}"

LOGDIR="${TMPDIR:-/tmp}/orbitscore-qa-smoke"
mkdir -p "$LOGDIR"

# Default file set: the new MIDI pillars authored for 2.0.0-dev QA.
if [ "$#" -gt 0 ]; then
  FILES=("$@")
else
  FILES=()
  for f in examples/1[1-8]_*.orbs; do
    [ -e "$f" ] && FILES+=("$f")
  done
fi

pass=0
fail=0
fail_names=()

echo "OrbitScore MIDI smoke — ${#FILES[@]} file(s), dwell=${DWELL}s"
echo "─────────────────────────────────────────────"

for f in "${FILES[@]}"; do
  base="$(basename "$f")"
  log="$LOGDIR/${base}.log"

  npm run midi-run -- "$f" > "$log" 2>&1 &
  bg=$!
  perl -e "sleep ${DWELL}"
  kill -INT "$bg" 2>/dev/null
  perl -e 'sleep 1'
  kill "$bg" 2>/dev/null
  wait "$bg" 2>/dev/null

  # A truthful PASS needs FOUR things, because "→ IAC" prints AFTER the statement
  # loop and BEFORE any scheduler tick — degree resolution to a MIDI note happens at
  # tick time (final output stage), and the engine deliberately SWALLOWS a failed
  # tick action ("scheduler resilience") via `console.error("MidiScheduler: action
  # failed …")` so playback survives a mid-loop port drop. So "→ IAC" alone, or even
  # "→ IAC + no parse error", can mask a swallowed tick-time failure or a file that
  # scheduled nothing. We therefore also require: no swallowed-failure token, and
  # positive evidence that at least one sequence actually scheduled.
  TICK_FAIL='MidiScheduler: action failed|scheduler not running|✗'
  SCHEDULED='\(one-shot\)|loop queued'

  if grep -q "midi-run error:" "$log"; then
    echo "  ✗ FAIL  $base   — $(grep -m1 "midi-run error:" "$log")   (parse/statement error)"
    fail=$((fail + 1)); fail_names+=("$base")
  elif ! grep -q "→ IAC" "$log"; then
    echo "  ✗ FAIL  $base   — never reached running state (see $log)"
    fail=$((fail + 1)); fail_names+=("$base")
  elif grep -qE "$TICK_FAIL" "$log"; then
    echo "  ✗ FAIL  $base   — swallowed tick-time failure: $(grep -m1 -E "$TICK_FAIL" "$log")"
    fail=$((fail + 1)); fail_names+=("$base")
  elif ! grep -qE "$SCHEDULED" "$log"; then
    echo "  ✗ FAIL  $base   — reached IAC but no sequence scheduled (no one-shot / loop queued)"
    fail=$((fail + 1)); fail_names+=("$base")
  else
    sched="$(grep -cE "$SCHEDULED" "$log")"
    echo "  ✓ PASS  $base   (${sched} sequence schedule event(s))"
    pass=$((pass + 1))
  fi
done

echo "─────────────────────────────────────────────"
echo "smoke: ${pass} passed, ${fail} failed   (logs: $LOGDIR)"
if [ "$fail" -gt 0 ]; then
  printf 'failed: %s\n' "${fail_names[*]}"
  exit 1
fi
exit 0
