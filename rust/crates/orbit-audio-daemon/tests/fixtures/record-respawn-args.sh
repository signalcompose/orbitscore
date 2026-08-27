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
# 引数を記録したあとは、殺されるまで生き続ける。
#
# 🔴 元は `exec sleep 3600` だった（#622 で是正）。固定秒数は deadline と独立に腐るうえ、
# テストが異常終了した時に**孤児が最大 1 時間残る**。理由は
# `lib/live-until-parent-exits.sh` の冒頭を参照。
. "$(dirname "$0")/lib/live-until-parent-exits.sh"
live_until_parent_exits
