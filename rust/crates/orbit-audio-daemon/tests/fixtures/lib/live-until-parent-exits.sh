# 「殺されるまで生きる」child stub の共通の終わり方。`.` で読み込んで最後に呼ぶ。
#
# 🔴 **固定秒数を書かないこと**（#622）。
#
# child stub が生き残らねばならない経路は Rust 側の deadline にゲートされている
# （`SETUP_DEADLINE` 30s / `CHILD_READY_TIMEOUT` 60s）。fixture に固定秒数を書くと、
# その数字は deadline と**独立に**存在するので、deadline が伸びた時に黙って下回る。
# しかも**速いマシンでは表面化しない** — テスト全体がミリ秒で終わるからである。
# 実際 `slow-child.sh` の `exec sleep 20` は両方の deadline より短く、CI が詰まった時だけ
# child が自然死して `child exited before publishing READY` で落ちていた。
#
# 逆に秒数を大きくすると、テストが異常終了した時に**孤児がその時間だけ残る**
# （`record-respawn-args.sh` は `exec sleep 3600` で最大 1 時間残る形だった）。
# このリポジトリでは孤児プロセスが CoreAudio コンテキストを固定する実害が出ている。
#
# したがって数字を増やす方向の修正も採らない。**寿命という概念を持たせず**、
# 親（テストプロセス）の消滅で自分も終わる。これで
# (a) deadline がどれだけ伸びても潜らない (b) 孤児が残らない、の両方が成り立つ。
#
# `sleep infinity` は使えない（GNU coreutils の拡張で、macOS の BSD sleep には無い）。
live_until_parent_exits() {
  parent=$PPID
  while kill -0 "$parent" 2>/dev/null; do
    sleep 1
  done
}
