#!/usr/bin/env bash
#
# qa-midi-smoke.sh — parse/schedule health smoke for MIDI .orbs examples (Epic #278, Phase B).
#
# Runs each example through the REAL engine path via the midi-run CLI (parser →
# degree resolution → MidiScheduler → MidiOutput → IAC) WITHOUT SuperCollider, then
# checks that it reached the running state AND actually scheduled its sequences AND
# emitted no swallowed engine error.
#
# This is a SMOKE, not a correctness check: it proves the DSL parses, degrees resolve,
# and events schedule to IAC without crashing or silently dropping a sequence. The
# musical *content* (are the right notes sounding?) is a human observation — see
# docs/testing/QA_2.0.0.md (P/H matrix).
#
# Requirements:
#   - macOS with an "IAC" CoreMIDI output port online (Audio MIDI Setup → MIDI Studio).
#   - Run from the repo root.
#
# Usage:
#   scripts/qa-midi-smoke.sh                 # smoke examples/11..18 (the MIDI pillars)
#   scripts/qa-midi-smoke.sh examples/12_chords_stacks.orbs   # smoke specific files
#
# Exit code: 0 if every file passed, 1 if any failed, 2 on a usage/setup error.

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

# Guard: expanding an empty array under `set -u` aborts on macOS system bash 3.2
# (< 4.4), which `#!/usr/bin/env bash` may resolve to. Fail with a clear message.
if [ "${#FILES[@]}" -eq 0 ]; then
  echo "qa-midi-smoke: no matching .orbs files found" >&2
  exit 2
fi

# Expected number of sequences that should schedule per example — the count of
# sequences named in its RUN()/LOOP(). The smoke asserts the observed schedule
# count is not LESS than this, so a silently-dropped sequence (a name typo in
# RUN(), or a method error that no-ops one sequence while a sibling still plays)
# is caught even though the file otherwise looks healthy. 0 = unknown file →
# fall back to the generic ">= 1 scheduled" check.
expected_count() {
  case "$1" in
    11_midi_degrees.orbs)        echo 1 ;;
    12_chords_stacks.orbs)       echo 1 ;;
    13_scope_chains.orbs)        echo 2 ;;
    14_ties_legato.orbs)         echo 2 ;;
    15_repetition_sections.orbs) echo 2 ;;
    16_expression.orbs)          echo 1 ;;
    17_voicing_random.orbs)      echo 2 ;;
    18_voicelead_comp.orbs)      echo 2 ;;
    *)                           echo 0 ;;
  esac
}

pass=0
fail=0
fail_names=()

echo "OrbitScore MIDI smoke — ${#FILES[@]} file(s), dwell=${DWELL}s"
echo "─────────────────────────────────────────────"

for f in "${FILES[@]}"; do
  base="$(basename "$f")"
  log="$LOGDIR/${base}.log"

  # Invoke ts-node directly (NOT via `npm run`) so $bg IS the signal-handling
  # node process (nodenv's shim execs in place, preserving the PID): `kill -INT`
  # then reaches midi-run's graceful shutdown (clean note-offs — no stuck MIDI
  # notes or orphaned node processes), and `wait` lets the 80ms shutdown flush
  # complete before we grep the log (so a late error token isn't missed).
  node node_modules/.bin/ts-node --transpile-only \
    packages/engine/src/cli/midi-run.ts "$f" > "$log" 2>&1 &
  bg=$!
  perl -e 'sleep $ARGV[0]' -- "${DWELL}"
  kill -INT "$bg" 2>/dev/null
  perl -e 'sleep 1'
  kill "$bg" 2>/dev/null
  wait "$bg" 2>/dev/null

  # A truthful PASS needs more than "→ IAC" — that line prints AFTER the statement
  # loop and BEFORE any scheduler tick, so on its own it proves almost nothing.
  # Two traps the criteria below close:
  #  (a) The engine SWALLOWS many failures and keeps running: the MidiScheduler
  #      logs a failed tick action and continues; the interpreter `console.error`s
  #      a missing var/sequence/global, an unknown method, or a RUN/LOOP naming a
  #      non-existent sequence, then returns WITHOUT throwing. None of these reach
  #      "midi-run error:". So a partially-broken file (one healthy sequence + one
  #      broken) would otherwise read PASS. We FAIL on any of those error strings.
  #  (b) "→ IAC" can print with nothing — or too little — scheduled. We require the
  #      observed schedule-event count to be >= the example's expected sequence count.
  ENGINE_FAIL='MidiScheduler: action failed|scheduler not running|loop scheduling error:|do not exist and will be ignored|Variable not found:|Sequence instance not found:|Global instance not found:|Method not found:|Transport target not found:|No global instance available|requires a global'
  SCHEDULED='\(one-shot\)|loop queued|loop started'

  if grep -q "midi-run error:" "$log"; then
    echo "  ✗ FAIL  $base   — $(grep -m1 "midi-run error:" "$log")   (parse/statement error)"
    fail=$((fail + 1)); fail_names+=("$base")
  elif ! grep -q "→ IAC" "$log"; then
    echo "  ✗ FAIL  $base   — never reached running state (see $log)"
    fail=$((fail + 1)); fail_names+=("$base")
  elif grep -qE "$ENGINE_FAIL" "$log"; then
    echo "  ✗ FAIL  $base   — swallowed engine error: $(grep -m1 -E "$ENGINE_FAIL" "$log")"
    fail=$((fail + 1)); fail_names+=("$base")
  elif ! grep -qE "$SCHEDULED" "$log"; then
    echo "  ✗ FAIL  $base   — reached IAC but no sequence scheduled"
    fail=$((fail + 1)); fail_names+=("$base")
  else
    sched="$(grep -cE "$SCHEDULED" "$log")"
    exp="$(expected_count "$base")"
    if [ "$exp" -gt 0 ] && [ "$sched" -lt "$exp" ]; then
      echo "  ✗ FAIL  $base   — only ${sched}/${exp} expected sequences scheduled (one silently dropped)"
      fail=$((fail + 1)); fail_names+=("$base")
    else
      echo "  ✓ PASS  $base   (${sched} sequence schedule event(s))"
      pass=$((pass + 1))
    fi
  fi
done

echo "─────────────────────────────────────────────"
echo "smoke: ${pass} passed, ${fail} failed   (logs: $LOGDIR)"
if [ "$fail" -gt 0 ]; then
  printf 'failed: %s\n' "${fail_names[@]}"
  exit 1
fi
exit 0
