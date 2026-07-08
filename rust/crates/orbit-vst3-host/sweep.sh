#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workspace_root="$(cd "$here/../.." && pwd)"
cd "$workspace_root"

cargo build -p orbit-vst3-host --bin vst3_probe --locked >/dev/null
probe="$workspace_root/target/debug/vst3_probe"
out="$workspace_root/target/vst3-sweep-results.txt"
tmp="$workspace_root/target/vst3-sweep-results.tmp"

pass=0
fail=0
crash=0
hang=0
total=0

: > "$tmp"
while IFS= read -r plugin; do
  total=$((total + 1))
  name="$(basename "$plugin")"
  set +e
  line="$(python3 - "$probe" "$plugin" <<'PY' 2>&1
import subprocess
import sys

probe = sys.argv[1]
plugin = sys.argv[2]
try:
    completed = subprocess.run(
        [probe, plugin],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=20,
    )
    print(completed.stdout, end="")
    raise SystemExit(completed.returncode)
except subprocess.TimeoutExpired as exc:
    if exc.stdout:
        print(exc.stdout, end="")
    raise SystemExit(124)
PY
)"
  code=$?
  set -e
  line="${line//$'\n'/\\n}"
  if [ "$code" -eq 0 ]; then
    pass=$((pass + 1))
    printf 'pass\t%s\t%s\n' "$name" "$line" >> "$tmp"
  elif [ "$code" -eq 124 ]; then
    hang=$((hang + 1))
    printf 'hang\t%s\t%s\n' "$name" "$line" >> "$tmp"
  elif [ "$code" -gt 128 ]; then
    crash=$((crash + 1))
    printf 'crash\t%s\texit=%s %s\n' "$name" "$code" "$line" >> "$tmp"
  else
    fail=$((fail + 1))
    printf 'fail\t%s\texit=%s %s\n' "$name" "$code" "$line" >> "$tmp"
  fi
done < <(find /Library/Audio/Plug-Ins/VST3 -maxdepth 1 -name '*.vst3' -print 2>/dev/null | sort)

{
  printf 'total=%s pass=%s fail=%s crash=%s hang=%s\n' "$total" "$pass" "$fail" "$crash" "$hang"
  cat "$tmp"
} > "$out"
rm -f "$tmp"
echo "$out"
