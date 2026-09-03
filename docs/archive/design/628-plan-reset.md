> 🗄️ **アーカイブ（2026-09-03・#696）。** 本文書は記録として残すが、**現在の正本ではない**。
> **現在の正本**: **#628 CLOSED**（出荷済み・PR #639）/ 現在の計画は `docs/planning/DEVELOPMENT_MAP.md` §4.B
>
> 内容は移動時のまま。**新しい判断の根拠にしないこと**（[[check-the-date-before-trusting-a-doc]]）。

# 計画立て直し: PR #639 の畳み方とスタック境界（#628）

- 起案: Fable（計画・設計担当・2026-08-28）
- 契機: owner 指示「状況を整理して開発プランを立て直す。必要ならゴールをクリアする」
- 入力: `scratchpad/situation-2026-08-28.md`（main の実測）/
  `docs/archive/design/628-rack-chain-implementation-design.md`（§7 Known Decisions は再議論しない）/
  `docs/archive/design/628-gated-e2e-rack-design.md`（承認済み・再議論しない）/
  監査結果（F1〜F11・根 1/3 監査・F-a）
- 本書が出すのは**作業の形と順序**。日程・可否の宣言はしない（owner の領分）。
  品質を薄くする打ち手は 1 つも含めない — 反復を減らす手段はすべて「欠陥クラスの前倒し検出」。

---

## Q1. スコープ — 15(a) Cmd+Click は #633 へ送る（支持）。他に切るものは無い

### 1.1 Cmd+Click（完了条件 15(a)）の #633 送り: **支持**

main の 3 理由（UI 機能で音と直交 / #633 が UI の PR / 実機ゲートの表面が増える）に加えて 2 つ:

1. **いま入れても実機で完結しない。** Cmd+Click の終端は UI open/close 経路で、その close 完了
   （`UI_CLOSED_DONE`）は既知欠陥により**この branch では壊れている**（gated 3 failed の原因・
   #633 の本体）。15(a) の「実機手動確認を PR 本文に記録」は、確認対象の半分が #633 待ちになる。
2. **E10b と同じ束にすると監査面が揃う。** すでに E10b（catalog 要素の UI open/close 実機）と
   `index` 形撤去の owner 判断を #633 へ申し送り済み。Cmd+Click を足すと #633 が
   「UI 起動 3 経路の完成 PR」として一枚岩になり、レビューも実機確認も 1 回で済む。

**送るときの条件（黙って落とさない）**:

- 親設計 `628-rack-chain-implementation-design.md` §1-15(a) に「#633 へ移管（本書）」の注記を
  入れる（設計書の完了条件を黙って満たさない形にしない）。
- core spec の該当箇所（PC.3 / SC.10.10 規範 2 に触れる記述）へ
  「エディタ Cmd+Click は #633 で実装」の現在地 1 行を入れる（spec が正本・乖離を作らない）。
- #633 の issue 本文に 3 項目を明記: Cmd+Click（DocumentLinkProvider + T26）/ E10b /
  `index` 形撤去の owner 判断。
- 🔴 **owner の目に入れる**: SC.10.10 規範 2 は Cmd+Click を UI 起動の**主経路**と定めた
  owner 確定事項である。その主経路の出荷が 1 PR 後ろへ動くのはスコープ判断であり、
  DSL/UX 表面の変更は owner 確認が要る（#625 の教訓）。**確認文はこの 1 問だけでよい**:
  「UI 起動の主経路（Cmd+Click）は #633 で出荷し、本 PR は `ui("名前")` と MCP の 2 経路で
  マージする — 可否」。

### 1.2 残り作業の keep/cut 判定（全件列挙）

| # | 項目 | 判定 | 根拠 |
|---|---|---|---|
| 1 | gated E2E（承認済み設計のブロック 1・2） | **keep（外せない）** | 外すと中心機能が実機未検証のままマージ = #528 の再演。main の見立て 2 に同意 |
| 2 | MCP `open_plugin_ui` の `chain_path`（additive） | **keep** | 本 PR の diff 自身が spec を chain_path 化した（`a83925cf`）。外すと自作の spec/実装乖離を出荷する。UI ウィンドウ非依存（E10a はエラー経路のみ）なので #633 に依存しない。裁定済み |
| 3 | `Gain` CI 3 経路 + `gain_bundle_dir()` env 1 行 | **keep** | 全部で数行 + yml step 1 つ。ubuntu 契約テストは per-PR 自動の唯一の検出器（裁定済み・fallback 条項あり）。なお release.yml は自身が pull_request paths に入っているため、**step 追加はこの PR の CI で 1 回実走して検証される** |
| 4 | Cmd+Click（15(a)） | **cut → #633** | §1.1 |
| 5 | 小修正 3 件（`c13` ID 重複 / `.any()` 回数 / 未使用 `unsafe impl Sync`） | **keep** | 各 1〜数行。issue を書く方が高い（fix-it-if-its-one-line） |
| 6 | WARN 分類の変更（監査 F-a） | **本 PR では変えない（測って owner へ）** | 分類器は横断的関心事で、変えると既存 E2E の ERROR オラクル全部に波及する。本 PR は E2E 実走で「実カタログのプラグインが WARN を出すか」の**実測値**を取り、判断材料付きで owner 判断へ回す（§2.3 の想定欠陥クラスに含めて計画済み） |
| 7 | 監査 F-b / F-c（コメント 2 箇所の事実不一致） | **keep** | docs 各 1 行。コメント契約を実態に合わせる |

他に切れるものは**見つからなかった**。残件はすべて「1 行級」か「完了条件の載荷部材」のどちらか。

---

## Q2. 実機ゲートの反復を減らす — 「回数を減らす」ではなく「1 回を安くし、1 回で全部見る」

前回の 11 回・6 欠陥を**クラス別に検分**すると、6 件全部が既に構造的に閉じている:

| 前回の欠陥 | クラス | 現在の状態 |
|---|---|---|
| serde flatten×deny（daemon / child の 2 回） | wire 型の二重定義 | **閉**: 共有型 1 箇所 + wire 実 payload の pin テスト + round-trip（実測 green） |
| rack child が配布物に無い | 出荷列挙の漏れ | **閉**: SPAWNABLE_CHILD_BINARIES 台帳 + release gate + 列挙コマンド 13 本 |
| PID オラクル不作動（`--plugin`→`--chain`） | ハーネスの前提腐り | **閉**: ログ由来オラクル + その parser の unit（変異済み） |
| ERROR 件数の厳密等価（500 行窓） | 観測の脆さ | **閉**: `<=` イディオムに統一 |
| 台帳 A の漏れ | 同上列挙 | **閉**: #548 ガードが捕捉済み |
| （main）E2E の実行時 ReferenceError | テストコード自体の未検査 | **閉**: `typecheck:e2e` ゲート新設（変異で実証済み） |

つまり**前回の反復を生んだクラスは再発しない**。次の反復を生むのは**新表面の未知**だけで、
そこへの打ち手は次の 3 層:

### 2.1 起動前ゲート（pre-flight・全部ヘッドレス・1 サイクル分の節約が毎回効く）

実機を**一度も起動する前に**、この順で全部通す（1 つでも赤なら起動しない）:

```bash
npm run typecheck:e2e && npm run lint && npm test        # E2E スクリプト自身の欠陥
cd rust && cargo fmt --check \
  && cargo clippy --workspace --all-targets --locked -- -D warnings \
  && cargo clippy --all-targets --features outproc-effect,outproc-instrument -- -D warnings \
  && cargo test --workspace --locked \
  && cargo test --features outproc-effect,outproc-instrument --locked   # 両 feature（§6 の教訓）
bash rust/crates/orbit-std-gain/bundle-macos.sh \
  && cargo test -p orbit-effect-rack-child --lib -- --ignored           # 実 Gain 67 秒
npm run build:clean
ls packages/vscode-extension/engine/bin/darwin-arm64/std-plugins/Gain.clap   # 同梱の実在
ls packages/vscode-extension/engine/bin/darwin-arm64/orbit-effect-rack-child # child の実在
```

最後の 2 つの `ls` は前回の欠陥 3 のクラス（ビルドは通るが配布物に無い）を**起動前**に殺す。

### 2.2 🔴 新設: ゲイン三つ組を**定数 + 純 unit** にする（実機に行く前に数値設計を守る）

E2E 設計 §4-2 の要（三つ組 0.8 / 0.63 / -6dB・部分積の全ペア ≥25% 分離）は、値を 1 つ
いじるだけで静かに崩れる。そこで**期待比率表を 1 つの exported 定数**にし、
**「全 leave-one-out 積が相互かつ full と ≥25% 離れている」「可聴フロア 0.002 の 5 倍以上」を
検査する純 unit** を付けて `npm test` に載せる。E2E は同じ定数を import する。
値の改変・追加は実機を回す前に `npm test` で赤になる。
（このテスト自身の変異検証: 三つ組の 1 値を分離が崩れる値に変えて red → restore green。）

### 2.3 反復 1 回のコストを下げる + 1 回の情報量を上げる

1. **スコープ実行**: 反復中は `npx vitest run tests/e2e/orbitstudio-mcp-gated.spec.ts -t 'R28'`
   で新規 2 ブロックだけ回す（**`-t` の名前フィルタを使う。位置引数は正規表現フィルタで
   worktree 複製を拾った事故があるため使わない**）。1 反復 ≈ 新ブロックの実行時間
   （見積り 2.5〜3 分）で、フル suite（≈15 分超）の**約 1/5**。フル実行は最終 1 回だけ。
2. **全区間の実測を assert より先に出力**（承認済み設計に織り込み済み）+ 出力は tail で
   切らずファイルへ全文保存。**1 回の赤で全欠陥を読む**。
3. **想定欠陥クラスの事前表**（新表面ぶん。起きたら即照合できるよう先に書いておく）:
   - `Gain.clap` 未同梱 → pre-flight の `ls` が起動前に検出
   - 実カタログ plugin の WARN → ERROR 化（F-a）→ 起きたら**その場で回数と行を記録**し
     owner 判断材料にする（ループで直そうとしない — 分類器は本 PR のスコープ外）
   - `registerSavedState` の登記タイミング → E2E 実装時に「project.yaml に B identity が
     現れるまで poll（上限付き）」で待つ（sleep で誤魔化さない）— レビューで私が確認する
   - 区間スキュー → 既存 SEGMENT_GUARD + 実信号待ちを流用（新規待ち定数を作らない）
4. **変異 2 件（TS 層）はスコープ実行で払う**: 各 ≈3 分 × 2。実出力を PR 本文へ。

反復**回数**の約束はしない（それは未知の数で、約束すると品質を削る圧になる）。
約束するのは: **既知クラスは全部閉じている・1 反復は約 1/5 のコスト・1 反復で全情報を取る**。

---

## Q3. 残り作業の順序と委譲（§6 の実測を前提にする）

### 3.1 委譲の原則（§6 から引く制約）

- 発注は **`--prompt-file` + `--write` 明示**・監視は**ログ mtime の生存信号**（idle≠完了）・
  完了は **diff の中身**で判定（自己申告や通知を待たない）。
- **実機が絡む修正は委譲しない**: 反復ループ内の fix は main 直（1 反復 3 分のループに
  委譲の往復を挟むと逆転する。fixer=main の既決とも整合）。
- **受け入れは毎回フル幅**: 両 clippy + workspace テスト + feature 付きテスト（§6 で main 自身も
  狭い受け入れで 1 回落ちている）。
- Codex のフィルタ対策: 本計画の残件は**テストコード・スキーマ・yml** でメモリ安全性の主題を
  含まないため低リスク。万一打ち切られたら規約どおり Sonnet(xhigh) へ切替え、
  **Sonnet の成果物は前科 2 件（未実装 1 行・不等号誤り）を前提に clippy 起点で検収**する。

### 3.2 順序（直列。並行発注はしない — 同一ツリー 2 write の事故実績があるため）

| 順 | 作業 | 担当 | 受け入れ（全部ヘッドレス） |
|---|---|---|---|
| 0 | 根 2 の commit + push + CI | main（進行中） | CI 4 本 green |
| 1 | **発注 A**: MCP `chain_path`（additive・食い違い loud + unit）/ `gain_bundle_dir()` env 尊重 / release.yml step / contract.rs 処理契約テスト（fallback 条項つき）/ 小修正 3 件 / F-b・F-c コメント修正 | Codex | diff 精読 + §2.1 の pre-flight 全コマンド。conflict-loud の unit は変異（優先順を逆にする）まで確認 |
| 2 | **発注 B**: gated E2E ブロック 1・2 + ゲイン定数 + §2.2 の純 unit + states/ ヘルパ（承認済み設計 §3–§4 を brief に添付・触るなリスト付き） | Codex | `typecheck:e2e` / env 無し `npm test` で skip +2 / **Fable（私）が §4 false-green 表 12 行と突き合わせレビュー**（既に受任済みの役割） |
| 3 | pre-flight（§2.1）→ 実機ループ（§2.3 スコープ実行）→ 変異 2 件 → フル gated 1 回 | **main** | Q4 の完了条件 5–6 |
| 4 | レビューラウンド 2: **provenance 縮小**（fix 起因のみ・1 レビュアー + 変異実行）+ 私の E2E レビュー結果の反映 | 既定ワークフロー | ラウンド 1 は消化済みのため縮小形が規約どおり |
| 5 | 列挙 13 本の再実行・WORK_LOG・PR 本文（実測エビデンス一式）・owner 確認 3 点の提示 | main | Q4 の完了条件 7–9 |

発注 A を先にするのは、(a) A の成果（chain_path）が B の E10a の前提であること、
(b) A が全件ヘッドレス検収可能で、B のレビューと main の準備を重ねられること、による。

### 3.3 main が持つもの（委譲しないもの）

実機ループ全体 / 各発注の受け入れ / WORK_LOG / PR 本文 / owner への確認 3 点の提示。

---

## Q4. この PR の完了条件（マージ可の定義・曖昧語なし）

以下が**すべて**満たされたときマージ可（マージ自体は owner 指示）:

1. **コード完備**: 根 2 push 済み。発注 A の全項目（MCP additive chain_path + 食い違い loud の
   unit / `gain_bundle_dir()` env / release.yml step / contract.rs 処理契約テスト**または**
   fallback 発動の PR 本文明記 / 小修正 3 件 / F-b・F-c）が branch に載っている。
2. **静的ゲート全 green（コマンドと期待値）**: `cargo fmt --check` exit 0 /
   clippy **default と outproc 両方** `-D warnings` exit 0 / `cargo test --workspace` と
   `--features outproc-effect,outproc-instrument` 全 pass / `npm run lint` exit 0 /
   `npm run typecheck:e2e` exit 0 / `npm test` 全 pass（**ゲイン定数の純 unit を含む**・
   env 無しで新 E2E 2 ブロックが skip されること）。
3. **実 Gain 3 件**: `bundle-macos.sh` + `cargo test -p orbit-effect-rack-child --lib -- --ignored`
   が 3 passed。実出力を PR 本文に貼る。
4. **E2E 実装がレビュー通過**: 私（Fable）が承認済み設計 §4 の 12 行と突き合わせ、
   「潰したつもり」の行が 0 件（指摘があれば解消まで 4. は未達）。
5. **実機**: `npm run build:clean` + アプリ再起動から**フル gated suite を 1 回**実行し、
   (a) 新規 2 ブロック green、(b) 赤は既知 3 件（`UI_CLOSED_DONE` 起因・テスト名を PR 本文に列挙）
   **のみ**、(c) 全区間 RMS / 窓系列 / onset の JSON と実行ログ全文がファイル保存され
   PR 本文から参照されている。
6. **変異**: TS 層 2 件（enabled 差分欠落 → seg3 red / standard params 欠落 → seg2 or 9 red）
   + ゲイン定数 unit の値変異 red。いずれも restore 後 green。実出力を PR 本文に貼る。
7. **列挙**: 設計書 §7 の 13 コマンドを最終コミットで再実行し件数を PR 本文に記録。
   `chain_path` の grep に `mcp-server.ts` が**含まれる**こと（additive 化の証跡）。
8. **docs**: WORK_LOG 各コミット分 / 親設計 §1-15(a) の移管注記 / core spec の現在地 1 行 /
   #633 issue に 3 項目（Cmd+Click・E10b・index 撤去判断）。
9. **owner へ提示する確認・判断 3 点が PR 本文に明記**され、回答を得ている:
   (i) Cmd+Click の #633 送り（§1.1 の 1 問）、(ii) WARN 分類（E2E 実測の行数付き）、
   (iii) CLAUDE.md マージ前ゲート恒久追加。※(ii)(iii) は「本 PR では変えない」回答でも
   マージ可 — 判断の所在が明示されていることが条件。
10. **スコープ凍結**: 上記以外の新規表面を足さない。作業中の新発見は 1 行級なら直す・
    それ以外は issue 化して PR 本文に列挙する。

---

## Q5. スタック境界 — 本 PR の境界は**移管 2 件を除き正しい**。#634 に決定ゲートを 1 つ置く

### 5.1 本 PR（#639）の境界: 維持 + 移管 2 件

- **維持**: 「直列ラック capability 一式（E2E 込み）を 1 PR」は正しい。分割（core 先行・
  E2E 後追い）は owner ルール「DSL 表面には E2E」に反し却下。#633 の取り込み（拡大）も、
  実機で確かめる表面を増やし Q2 と逆行するため却下。
- **移管**: 15(a) Cmd+Click（§1.1）と `index` 形撤去の owner 判断（裁定済み）を #633 へ。
  移管後の #633 は「**UI 起動 3 経路の完成**」という一貫した輪郭になる。
- **既知 3 red の扱い**: gated は CI 外なので機械的にはマージを塞がない。完了条件 5-(b) が
  「その 3 件**のみ**」を要求することで、これ以上の赤の紛れ込みを塞ぐ。

### 5.2 スタックの次: #633 を先にする（現行順の維持を推奨）

#633 は新機能ではなく**既知欠陥 3 件 + 移管分の返済**で、設計書（711 行）も完成済み。
「壊れているものを直してから積む」の順は変えない。

### 5.3 🔴 #634（PDC 単独 PR）に決定ゲートを置く

現行計画では #634 が「PDC 機構のみ」の PR になる。これは**表面より機構が先**の形
（このプロジェクトで手戻り 5 回を生んだ既知のクラス）で、DSL 経由の E2E で価値を検証できない
PR になる恐れがある。いま決める材料は無いので、**#633 完了時に次の 1 問を判断する
ゲートだけ置く**:

> #634 は (a) #635 に畳んで「layer + PDC」を 1 PR にする（表面と機構が同時に検証される）か、
> (b) 単独 PR のまま、**観測可能な表面**（例: 報告 latency を `get_log` / MCP で読める）を
> 完了条件に含めるか。

推奨は (a)（diff が過大にならない限り）。どちらでも「機構だけの PR に E2E 不能な完了条件」を
作らないことが条件。#635 / #636 の順序と輪郭は現行のまま（再議論しない）。

---

## 6. owner への確認（本計画で新たに要るのは 1 点だけ）

- §1.1 の 1 問（Cmd+Click の #633 送り）。
  ※WARN 分類と CLAUDE.md 恒久追加は既に判断待ちリストにあり、本計画は「実測データを付けて
  提示する」段取りを Q4-9 に組み込んだだけで、新しい質問を増やしていない。

## 7. 触ってはいけないもの（本計画の実行中）

1. 親設計 §7 Known Decisions・承認済み E2E 設計の内容（本書は順序とスコープだけを動かす）
2. WARN 分類器（`isDaemonNonErrorTracingLine`）— 測るだけ。変更は owner 判断後の別 PR
3. 既存 `#618 E1-E6` / `#625 R-E1-R-E7` の it 本体
4. `play()` 意味論・instrument 差し替え一式・quiesce/latch プロトコル（親設計 §8 のまま）
