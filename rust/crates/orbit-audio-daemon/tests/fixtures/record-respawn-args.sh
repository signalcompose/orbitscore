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

# 原子的に publish する: リーダーは `exists()` を「書き終わった」の意味で使うので、
# `> "$args_path"` で直接書くと作成直後の部分内容を読まれる（実測で flake 化した）。
printf '%s\n' "$@" > "${args_path}.tmp"
mv "${args_path}.tmp" "$args_path"
exec sleep 3600
