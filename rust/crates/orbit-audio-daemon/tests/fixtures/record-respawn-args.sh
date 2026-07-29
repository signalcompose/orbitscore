#!/bin/sh
previous=
args_path=
for argument do
  if [ "$previous" = "--shm" ]; then
    args_path="${argument}.respawn-args"
    break
  fi
  previous=$argument
done

if [ -z "$args_path" ]; then
  exit 64
fi

printf '%s\n' "$@" > "$args_path"
exec sleep 3600
