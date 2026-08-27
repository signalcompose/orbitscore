#!/bin/sh
# 引数（--shm / --plugin / --sample-rate ...）を無視して、殺されるまで生き続ける child の
# 代役。READY は publish しない。
#
# 寿命を持たない理由は `lib/live-until-parent-exits.sh` の冒頭を参照（#622）。
#
# 経緯: 元は `sleep 0.2` で自己終了しており、watchdog がそれを異常終了と見なして
# **cascading respawn** を起こしていた（#573）。そこで `sleep 20` へ伸ばしたが、
# 「**生き続ける**」がこの fixture の契約であって、秒数はその近似にすぎなかった。
. "$(dirname "$0")/lib/live-until-parent-exits.sh"
live_until_parent_exits
