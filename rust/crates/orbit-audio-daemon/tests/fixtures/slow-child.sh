#!/bin/sh
# 引数（--shm / --plugin / --sample-rate ...）を無視して「親が生きている限り生き続ける」
# child の代役。READY は publish しない。
#
# 🔴 **固定秒数にしてはいけない**（#622）。
#
# この fixture が生き残らなければならない経路は `SETUP_DEADLINE`(30s) と
# `CHILD_READY_TIMEOUT`(60s) にゲートされている。固定秒数はその下に潜っても**誰にも
# 気づかれない** — 速いマシンではテスト全体がミリ秒で終わるので表面化しないからである。
# 実際 `exec sleep 20` は両方の deadline より短く、CI が詰まってセットアップが 20 秒を
# 超えると child が自然死し、READY poll が early-exit 分岐へ落ちて
# `child exited before publishing READY` で fail していた（#622 の flake の正体）。
#
# 逆に秒数を大きくすると、テストが異常終了した時に**孤児プロセスがその時間だけ残る**
# （このリポジトリでは実害がある）。したがって数字を増やす方向の修正も採らない。
#
# そこで**寿命という概念を持たせず**、親（テストプロセス）の消滅で自分も終わる形にする。
# これで (a) どれだけ deadline が伸びても潜らない (b) 孤児が残らない、の両方が成り立つ。
#
# 経緯: 元は `sleep 0.2` で自己終了しており、watchdog がそれを異常終了と見なして
# **cascading respawn** を起こしていた（#573）。そこで秒数を伸ばしたが、
# 「**生き続ける**」がこの fixture の契約であって、秒数はその近似にすぎなかった。
#
# `sleep infinity` は使えない（GNU coreutils の拡張で、macOS の BSD sleep には無い）。
parent=$PPID
while kill -0 "$parent" 2>/dev/null; do
  sleep 1
done
