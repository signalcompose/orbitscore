#!/bin/sh
previous=
shm_path=
slow_at=
for argument do
  if [ "$previous" = "--shm" ]; then
    shm_path=$argument
  elif [ "$previous" = "--plugin" ]; then
    slow_at=$argument
  elif [ "$previous" = "--chain" ]; then
    slow_at=$(sed -n 's/.*"path":"\([0-9][0-9]*\)".*/\1/p' "$argument")
  fi
  previous=$argument
done

case "$slow_at" in
  ''|*[!0-9]*) exit 64 ;;
esac
if [ -z "$shm_path" ]; then
  exit 64
fi

count_file="${shm_path}.invocation-count"
n=$(cat "$count_file" 2>/dev/null || echo 0)
n=$((n + 1))
printf '%s' "$n" > "$count_file"

if [ "$n" -eq "$slow_at" ]; then
  exec sleep 2.2
fi
exit 0
