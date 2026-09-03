# 束ブランチ運用 — 小さな PR を束ねて、重いレビューは束ごとに 1 回だけ回す

**対象**: AI エージェント（Codex / Claude）に実装を委譲し、レビューチームと実機検証を人間（main）が回しているリポジトリ。OrbitScore で 2026-09 に決めた運用を、他のリポジトリでもそのまま使える形に切り出したもの。
**一言で**: 「PR は小さく、レビューは束ごとに」。束ごとに統合ブランチを 1 本置き、小さな PR はそこへ軽いゲートで入れ、統合ブランチから main への PR 1 本にフルレビューと実機検証を集約する。

---

## 1. 背景 — なぜ PR ごとのフルレビューが成り立たなかったか

OrbitScore のレビュー手順は 1 PR あたり「`/simplify` → レビューチーム 4 名 + Fable 監査を並行 → fixer 3 回まで → ビルド + 実機 E2E」で、実測で 1 PR に 5 ラウンド・変異検証だけで 80 分以上かかった回がある（`CLAUDE.md` の PR #527 / #633 の記録）。一方、実装プラン（`docs/planning/IMPLEMENTATION_PLAN_2026-09.md`）は 98 PR ある。**PR を小さく切ること**（正しい）と**PR ごとに重いレビューを回すこと**（成り立たない）が衝突していた。

もう一つの前提が、**委譲先の緑は実機の緑ではない**こと。Codex は sandbox で daemon protocol・MCP・実機 E2E が走らないので、Codex の「テスト緑」を根拠にはできない（同 `CLAUDE.md`「検証を委譲先に任せない」）。したがって実機検証は人間の手元でしか回らず、**回数そのものが希少資源**になる。

解くべき問いは「レビューの回数を、PR の数ではなく**意味のある単位の数**に比例させるにはどうするか」。答えが束ブランチ。

## 2. 用語

| 語 | 意味 |
|---|---|
| 束（bundle） | 1 つの設計文書に対応する、まとめてレビューするのが合理的な PR の集合。例: 「出口の一般化」= PR-O3〜O6 |
| 統合ブランチ | 束 1 つにつき 1 本。main から切り、小 PR を受け、最後に main へ 1 本の PR で入る |
| 小 PR | 統合ブランチ向けの PR。実装の単位（1 論理変更） |
| 束 PR | 統合ブランチ → main の PR。フルレビューと実機検証はここで 1 回 |
| 軽いゲート | 小 PR に課すもの: CI + その PR が足した E2E を実機で + 差分の目視 |
| main 直行 | 束を通さず従来どおり単独で main へ入れる PR（仕様だけ・must-fix） |

## 3. 形

```
main ──●────────────────────────────────────────────●──▶
        \                                          / 束 PR（squash 1 回・フルレビュー・実機全件）
         611-output-line（統合ブランチ）●──●──●──●──●
                                       ↑  ↑  ↑  ↑  ↑
                            小 PR（軽いゲート）: O3  O4  O5  O6  fix
```

- 統合ブランチは main から切る。名前は束の先頭 issue 番号で `<issue>-<英語>`（リポジトリの命名規約に従う）
- 小 PR は統合ブランチから切り、統合ブランチへ squash で戻す（統合ブランチには「小 PR 1 = 1 コミット」が残る）
- 束 PR を squash で main へ入れる（main には「束 1 = 1 コミット」）。統合ブランチは消さないので細かい履歴はそこに残る
- レビューの指摘への fix は統合ブランチの**先頭に積む**。小 PR は既に統合ブランチへ入っているので rebase は発生しない

## 4. 手順（1 束の一生）

| 段階 | やること | コマンド |
|---|---|---|
| 束を開く | main から統合ブランチを切って push | `git checkout -b 611-output-line main && git push -u origin 611-output-line` |
| 小 PR を作る | 統合ブランチから切る。base を統合ブランチにして draft で開く | `git checkout -b 611-o4-audio-line 611-output-line` → `gh pr create --base 611-output-line --draft` |
| 小 PR を閉じる | CI 緑 + その PR の E2E を実機で + main が差分を読む → 統合ブランチへ squash | `gh pr merge <n> --squash` |
| 次の小 PR | 統合ブランチを pull してから切る | `git checkout 611-output-line && git pull` |
| main に追従 | 他の束が main に入ったら統合ブランチへ merge。衝突はここで 1 回だけ解く | `git merge origin/main` |
| 束を閉じる | 統合ブランチ → main の PR を開き、フルレビュー → fix → ビルド + 実機全件 → squash | `gh pr create --base main --head 611-output-line` |

## 5. 規則

### 5.1 束の大きさ — 差分 1,500 行以下で切る

束 PR の差分が大きいほどレビューの精度が落ちる。**束は最初から 1,500 行以下で切る**。「途中でチェックポイント」を置くより、設計上の継ぎ目（wire と DSL、記録と再生、実時間とオフライン）で束を分ける方が単純で、継ぎ目は plan の並び順と一致する。旧 wire を併存させる方針なら wire だけの束でも main に入れて壊れない。

一方通行の決定（wire 形式・DSL 表面・ファイル形式）を含む PR は束の先頭か単独に置く。戻せない決定が監査を受けるのは遅くともその束の締めになる。

### 5.2 main 直行にするもの

- **仕様だけの PR**（spec / docs）: 早く見えた方がよい。レビューは advisor 相談で軽く
- **must-fix**: 束を待たせたくない。従来どおり単独でフルレビュー
- 束をまたぐ PR（複数の設計文書に触る）も単独

### 5.3 小 PR の軽いゲート（これ以下にしない）

1. CI（unit / lint / cargo）。安いので小 PR でも回す
2. **その PR が足した E2E だけを実機で**回す（対象を絞る仕組みを持つ。OrbitScore は `ORBIT_GATED_ONLY`）。委譲先の緑を根拠にしないための最低線。ここを省くと束の締めで一気に露見して fix が収束しない
3. main が差分を読む（レビューチームは呼ばない）
4. 任意: 単独レビュアー 1 名の低コストレビュー（`/code-review` low など）

### 5.4 束 PR のフルゲート

`/simplify` → レビューチーム + 設計監査（Fable）を並行 → fixer 3 回まで → ビルド + 実機 E2E 全件 → squash merge。監査には**設計文書と束の差分**を渡す。設計監査の 3 問（不在証明・外部 API の意味論・横断的関心事）は設計文書に対する問いなので、差分単位より束単位の方が精度が上がる。

### 5.5 bot と CI の発火条件

自動レビュー bot（`claude-code-review.yml` 等）が全 PR で走る設定なら、**base が main の PR だけに絞る**（`if: github.base_ref == 'main'`）。そうしないと小 PR でも走って抑制の意味が無くなる。テスト CI は小 PR でも回してよい。

### 5.6 WORK_LOG・issue・コミット

- WORK_LOG は小 PR ごとに書く。並行する小 PR が同じ見出しに追記して衝突しないよう、束の見出しの下に PR ごとの小見出しを置く
- 小 PR の本文は `Part of #<issue>`。束 PR の本文に `Closes #…` を集約。issue が閉じるのは束が main に入った時
- 小 PR は複数同時に開けるが、同じファイルを触るものは plan の順で直列にする

## 6. 他のやり方との比較

| やり方 | レビューの単位 | 履歴の書き換え | main の状態 | 向く場面 |
|---|---|---|---|---|
| PR ごとにフルレビュー | PR | 無し | 常に緑 | PR が少ない・1 PR が大きい |
| 純 stacked PR（手動） | PR（層） | **毎回**（下の層が変わるたび上を rebase）| 層ごとに入る | 1 人の大きな変更を層に割る |
| GitHub stacked PR（2026-07 公開プレビュー・§7）| PR（層） | 自動 cascading rebase（線形履歴が必須）| 層ごとに入る | 同上。ツールが rebase を肩代わり |
| **束ブランチ（本書）** | **束** | **無し**（fix は先頭に積む）| 束ごとに入る・常に緑 | **PR は多いが、重いレビューの回数を絞りたい** |

OrbitScore の見積り: PR ごとなら 27 回のフルレビューが、束ブランチなら 7 回。

## 7. GitHub の stacked pull request との違い

GitHub は 2026-07-30 に stacked pull requests を公開プレビューにした（§11 の参照 1〜4）。同じ「PR を小さくする」話に見えるが、**解いている問題が違う**。

| | GitHub stacked PR | 束ブランチ |
|---|---|---|
| 構造 | 下の PR の**ブランチ**を上の PR の base にする鎖。一番下だけが trunk（main）を向く | 束の統合ブランチ 1 本に小 PR が**並列**に入る。統合ブランチだけが main を向く |
| レビューの粒度 | **層ごと**に独立してレビューする（各層は自分の差分だけを見せる）| **束ごと**に 1 回。小 PR は軽いゲートだけ |
| 目的 | 1 つの大きな変更を、待たずに積み上げながら**層ごとにレビューしてもらう**（レビューを増やす方向）| 多数の小 PR に対して**重いレビューの回数を減らす** |
| マージ | 下から順。「一番上の ready な PR をマージすると下の未マージ層もまとめて入る」。squash なら **n 個の squash コミット**が main に入る | 束 PR を 1 回 squash。main には束 1 コミット |
| 履歴 | **線形履歴が必須**。下の層が変わるか trunk が進むたびに cascading rebase（サーバ側 or `gh stack rebase`）| 書き換えない。fix は統合ブランチの先頭へ |
| CI | 層ごとに全ワークフローが走る（公式 docs は stack のメタデータで「一番下の層だけ重いジョブ」等の条件分岐を推奨）| 小 PR は安い CI だけ、束 PR で全部 |
| 制約 | 同一リポジトリ内のみ（fork 不可）。プレビュー中。コミュニティで squash 時の見かけ上の衝突・rebase 後に署名が外れる報告あり | Git と `gh` の標準機能だけ。プレビュー依存なし |

**結論**: stacked PR は「1 人が大きな変更を層に分けて、層ごとに見てもらう」道具で、レビューの回数は**増える**。束ブランチは「レビューの回数を束の数に固定する」道具。目的が逆なので置き換えにはならない。

**併用**: 束の中で「O4 は O3 のマージを待たずに始めたい」時だけ、統合ブランチを trunk にした stack を組める（`gh stack init` の trunk を統合ブランチにする）。ただし線形履歴の要件と squash 時の衝突報告があるので、OrbitScore ではプレビューが外れるまで使わない。小 PR を plan の順で直列にすれば待ちは短い。

## 8. 他リポジトリへの導入チェックリスト

1. **merge 方式**を確認する。squash 運用なら本書がそのまま使える。merge commit 運用でも成立する（統合ブランチの履歴がそのまま main に入る）
2. **branch protection**: main は保護のまま。統合ブランチは保護しない（main の merge と小 PR の squash を自由に入れるため）
3. **bot の発火条件**: 自動レビュー bot のワークフローに `if: github.base_ref == 'main'` を足す
4. **命名**: 統合ブランチ `<先頭 issue>-<英語>`、小 PR `<issue>-<英語>-<部分>`
5. **軽いゲートの道具**: 「その PR の E2E だけ回す」仕組み（環境変数で対象を絞る等）を用意する
6. **レビュー手順の文書**（`CLAUDE.md` / `PROJECT_RULES.md`）を「単位 = 束」に書き換える。main 直行の条件（仕様だけ・must-fix）も明記
7. **束の切り方**を plan に表で置く（束名・統合ブランチ名・中身・概算行数）
8. **WORK_LOG の書き方**（束の見出し + PR ごとの小見出し）を決める
9. 実装エージェント（Codex 等）への発注テンプレートに「base は統合ブランチ・draft で開く・`Part of #N`」を入れる

## 9. 失敗モード

| 状況 | 何が起きるか | 手当 |
|---|---|---|
| 小 PR の実機 E2E を省く | 束の締めで欠陥が一度に露見し、fix 3 回で収束しない | §5.3 の 2 を省かない |
| 束が 1,500 行を超える | レビューの精度が落ち、指摘が浅くなる | 継ぎ目で束を分ける（§5.1）|
| 統合ブランチが main から離れる | 束 PR で大きな衝突 | チェックポイントごとに `git merge origin/main` |
| bot が小 PR で走る | 抑制の意味が無くなる・ノイズ | §5.5 の `if` |
| 同じファイルを触る小 PR が並行 | 統合ブランチで衝突 | plan の順で直列 |
| 束をまたぐ PR を束に入れる | 片方の束が閉じるまで main に入らない | main 直行（§5.2）|
| must-fix を束に入れる | 修正が束の締めまで出荷されない | main 直行（§5.2）|
| 統合ブランチを消す | 小 PR の履歴が消える（main は束 1 コミット）| 消さない（リポジトリ規則）|

## 10. OrbitScore での割り当て（2026-09 プラン）

| 束 | 統合ブランチ | 中身 | 概算 |
|---|---|---|---|
| O-wire | `611-line-wire` | PR-O3 | 約 800 行（1 本なので実質単独レビュー）|
| O-dsl | `611-output-line` | PR-O4・O5・O6 | 約 1,300 行 |
| L-record | `694-session-log` | PR-L1a・L1b・L2・L3・L7・L8・L9 | 約 1,500 行 |
| L-replay | `241-replay` | PR-L4・L5・L6 | 約 900 行 |
| R-live | `598-render-live` | PR-R1・R2・R3 | 約 1,400 行 |
| R-offline | `598-render-offline` | PR-R4・R5・R6・R7 | 約 1,700 行（R4 は先に main へ入れてよい）|
| R-p3 | `598-render-p3` | PR-R8・R9 | 約 800 行 |

main 直行: PR-O1 / L0 / R0（仕様）、PR-O2 / D0 / V4 / K-A1 / K-A2 / S-T1（must-fix）。

## 11. リファレンス（2026-09-03 確認）

このリポジトリの作業環境はプロキシで `docs.github.com` / `github.blog` / `martinfowler.com` / `trunkbaseddevelopment.com` / `graphite.dev` の本文取得ができないため、これらは**検索エンジンの要約とスニペットで内容を確認**した（URL の実在は確認済み）。`github.com` 上のページは本文を直接確認した。

**GitHub stacked pull requests（公式）**
1. About stacked pull requests — https://docs.github.com/en/pull-requests/get-started/about-stacked-prs （構造・層ごとの差分・下から順のマージ・同一リポジトリ限定）
2. Merging stacked pull requests — https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-stacked-pull-requests （squash / rebase / merge の各方式に対応、squash は n 個のコミット、線形履歴が必須、マージ後の自動 rebase と retarget）
3. Optimizing CI for stacked pull requests — https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/optimizing-ci-for-stacked-pull-requests （ワークフローは層ごとに走る・stack メタデータで重いジョブを絞る）
4. Troubleshooting stacked pull requests — https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-stacked-pull-requests （`gh stack rebase --continue / --abort`・マージ失敗時の挙動）
5. Stacked pull requests CLI commands — https://docs.github.com/en/pull-requests/reference/stacked-prs-cli-commands
6. `github/gh-stack`（CLI 拡張・本文確認）— https://github.com/github/gh-stack （`gh extension install github/gh-stack`、`init / add / rebase / sync / submit / merge / view` 等）
7. 公開プレビューの告知と議論（本文確認）— https://github.com/orgs/community/discussions/201439 （2026-07-30。「一番上の ready な PR をマージすると下の未マージ層もまとめて入る」「部分マージ後、上の PR は自動で rebase と retarget」。コミュニティ報告: squash 時の見かけ上の衝突、rebase 後に署名が外れる、衝突検知の不整合、fork 不可）
8. 告知本文（プロキシで未取得・URL のみ）— https://github.blog/changelog/2026-07-30-stacked-pull-requests-are-now-in-public-preview/

**GitHub のマージ方式・ワークフロー制御**
9. Pull request merges（squash / rebase / merge の定義）— https://docs.github.com/en/pull-requests/reference/pull-request-merges
10. Skipping workflow runs — https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs

**ブランチ戦略の背景**
11. Martin Fowler, *Patterns for Managing Source Code Branches*（2020）— https://martinfowler.com/articles/branching-patterns.html （Feature Branching・Mainline Integration・Continuous Integration。「枝は頻繁に統合し、いつでも出荷できる健全な mainline に集中する」）
12. Trunk Based Development — Short-Lived Feature Branches — https://trunkbaseddevelopment.com/short-lived-feature-branches/ （枝は 2 日程度まで・1 人（ペアなら 2 人）・レビューは分単位が理想）。本書の小 PR はこの「短命な枝」に相当し、統合ブランチは束の間だけ生きる中間 trunk
13. Graphite, *The stacking workflow* / *automatic rebase after merge* — https://graphite.dev/stacking / https://graphite.dev/blog/automatic-rebase-after-merge （stacked diff の定義と、部分マージ後に上の枝を rebase し直す手間が本質的な問題であること）
14. `ezyang/ghstack`（Meta 系の stacked diff ツール・本文確認）— https://github.com/ezyang/ghstack （層ごとに base / head / orig の 3 枝を管理し、GitHub UI ではなく `ghstack land` でマージする設計。「base が main でないので UI からはマージできない」）

**OrbitScore 側の一次情報**
15. `CLAUDE.md`「PR レビューワークフロー」「検証を委譲先に任せない」（PR #527 / #633 の実測）
16. `docs/core/PROJECT_RULES.md`（squash merge・ブランチを消さない・命名規約）
17. `docs/planning/IMPLEMENTATION_PLAN_2026-09.md` §1〜§3（PR 一覧・順序の根拠・段）
