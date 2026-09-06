#!/usr/bin/env sh
# PostToolUse hook: `git push` の後、**それが本当に入ったか**を機械が確認する（#742）。
#
# ## なぜ要るか（2026-09-04 に 2 回踏んだ）
#
# `git commit ... ; git push ... && echo pushed` と書くと、
# **commit が husky の pre-commit で落ちても push は走る**。
# リモートは既に最新なので「Everything up-to-date」で **exit 0 = 成功**になり、
# `echo pushed` が出る。結果、**ブランチに何も入っていないのに「push した」と報告**していた。
#
# 同じ日にもう 1 回、衝突解消中に `git checkout origin/main -- WORK_LOG.md` で
# **その PR の記録 49 行を丸ごと消した**まま commit しかけた。
# どちらも **「やったつもり」と「実際」のずれ**である。
#
# ## 何をするか
#
# push の直後に **ローカル HEAD とリモート追跡ブランチの SHA を突き合わせる**。
# 一致しなければ stderr に出して exit 2（Claude に見せる）。
#
# 🔴 **ブロックはしない。** push 自体は済んでいるので止めても意味がなく、
# **「入っていない」ことを見えるようにする**のが目的
# （既存方針: hook による強制は weak-form へ倒す・`README.md` 参照）。

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || exit 0
[ "$branch" = "HEAD" ] && exit 0

local_sha=$(git rev-parse HEAD 2>/dev/null) || exit 0
remote_sha=$(git rev-parse --verify --quiet "refs/remotes/origin/$branch" 2>/dev/null)

# リモートにまだ無いブランチ（初回 push 前・push 失敗直後）は対象外。
# ここで鳴らすと「これから作る」正常系にも出てしまう。
[ -z "$remote_sha" ] && exit 0

if [ "$local_sha" != "$remote_sha" ]; then
  cat >&2 <<EOF
🔴 push 後の不一致を検出しました（#742）。

  ブランチ : $branch
  ローカル : $local_sha
  リモート : $remote_sha

考えられる原因:
  - commit が pre-commit フックで失敗していた
    （\`git commit ... ; git push ...\` と続けて書くと commit が落ちても push は走り、
     「Everything up-to-date」で成功に見える）
  - push が別のリモート / 別のブランチへ向いていた

**「push した」と報告する前に、次の 2 つが一致することを確認してください:**

  git log --oneline -1
  git log origin/$branch --oneline -1
EOF
  exit 2
fi

exit 0
