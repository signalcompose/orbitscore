#!/bin/sh
sleep 60 &
descendant_pid=$!
if [ -n "${ORBIT_SCAN_TEST_PID_FILE:-}" ]; then
  printf '%s\n' "$descendant_pid" > "$ORBIT_SCAN_TEST_PID_FILE"
fi
wait
