# POST-2.0: OrbitStudio 実装計画（cutover → VSCodium 版・Opus 実行可能）

- **Issue**: #373（OrbitStudio 本体 = #301・Epic #292）
- **作成**: 2026-07-04（Fable セッション・Sonnet 5 workflow で 4並列読込 → 起草 → 批評 → 改訂の 2 周を経て確定）
- **起点**: main = cutover #369 マージ済み（`57c780f`・native Rust daemon が既定音声エンジン・SC は `ORBITSCORE_ENGINE=sc` opt-out）
- **目的**: この文書だけを起点に、コールドスタートの Opus セッションが OrbitStudio（VSCodium 版）を段階実装できる状態にする

## この計画の使い方（Opus セッション向け）

1. 各フェーズは自己完結（読むべき doc・触る file:line・ゲート条件を含む）。**フェーズゲートを通過するまで次に進まない**。
2. **owner-decision 項目（§owner 決定事項）は勝手に確定しない** — 該当タスクに着いたら選択肢と推奨を添えて owner に確認する。
3. コード変更を含む PR は CLAUDE.md 必須ワークフロー（`/simplify` + `/code:pr-review-team` 収束）に従う。
4. 確定済み決定（MASTER_PLAN §4/§6・PLUGIN_STRATEGY §1-9）を再設計しない。委譲した Sonnet が再設計を試みたら該当表を提示して却下する。

### ⚠️ provenance 注意（2026-07-04 時点）

- **`POST_2.0_PLUGIN_STRATEGY.html` は main 未マージ**（PR #363 OPEN・branch `362-post2-plugin-strategy-doc` の commit `3e6e876` にのみ存在）。決定自体は owner 確定済みで WORK_LOG/MASTER_PLAN で裏付け可能。#363 マージ後はこの注記は不要。
- **issue #301 の body は engine-first pivot（#302）前の古い内容**（SC 既定・engine 非依存の框）。**Phase 0 の最初のタスクで body を現行決定に更新する**（正 = MASTER_PLAN §4 Track B: native の上・cutover 後・CLI+Claude 拡張必須・**scsynth は載せない**）。

## 全体構成（5 フェーズ）

```
Phase 0 (spike・stock VSCodium) ──┐ 並行可
Phase 1 (#366 landmine + #306)  ──┴→ Phase 2 (B1 リブランド rebuild + parity smoke)
                                        → Phase 3 (署名/notarize/.dmg)
Phase 4 (WCTM ガード + housekeeping) — Phase 1 後いつでも並行可
```

B2（patch 付き rebuild）/B3（hard fork）へのエスカレーションは **Phase 2 ゲートで #278 チェックリストの具体的 FAIL 項目が出た場合のみ**の条件付き判断（前倒しスパイクしない）。

---

## Phase 0: spike — 未検証仮説を潰す（editor 非依存・stock VSCodium）

**GOAL**: VSCodium が現行 .vsix を marketplace 非依存で load/activate できるか、CLI + Claude 拡張（専用アプリ化の必須条件）が動くかを、実装投資前に実機確認する。

**TASKS**:
1. 読む: issue #301 body（古い記述と自覚した上で）/ `docs/development/POST_2.0_MASTER_PLAN.html` §4 Track B（現行の正）/ `docs/research/NATIVE_ENGINE_TRACKTION_VSCODIUM.md` §6 スパイク S3 + §5 open question 2/3
2. **issue #301 body を MASTER_PLAN Track B の決定に合わせて今すぐ更新**（「scsynth は載せない」の一文を明記。古い body のまま他フェーズが進む誤読リスクを断つ）
3. github.com/VSCodium/vscodium の GitHub Release（macOS arm64）から **stock VSCodium バイナリ**を取得（リブランドは Phase 2）
4. 現行 main の packages/vscode-extension を `vsce package` で .vsix 化（#366 修正は不要 — audio 起動が通らなくてもこの検証には影響しない）
5. VSCodium へ `--install-extension` で side-load。**MS Marketplace へのネットワーク到達なし**で完了するか確認
6. activation 確認: .orbs を開いて TextMate ハイライト / command palette に contributes.commands 7 件 / cmd+enter キーバインド
7. **STOP gate A**: marketplace 非依存で side-load・activate できなければ即 STOP・報告（Open VSX 登録 / bundling 方式の再検討が必要）
8. Claude 拡張の意味を切り分け: (i) 統合ターミナルで claude CLI が動くか (ii) marketplace 型の Claude Code VS Code 拡張なら Open VSX 収載有無 → 無ければ .vsix 直接 side-load を試す
9. **STOP gate B**: Claude 拡張が MS Marketplace 限定機能に依存し Open VSX / side-load でも到達不能なら STOP・報告（VSCodium 選定根拠が崩れるため editor ベース再検討）

**GATE**: STOP gate A・B の両方を通過。いずれか STOP なら選択肢と推奨付きで報告し Phase 2 に進まない。
**委譲**: Opus 直列（「Claude 拡張」の解釈判断と STOP/継続の意思決定。単発コールドスタートセッションで完結可能な粒度）。
**依存**: なし（Phase 1 と並行可）。
**トークン**: 読むのは 2 doc + issue 1 件 + 手順実行のみ。VSCodium インストール手順が不明な場合のみ公式 README を WebFetch。リポジトリ全体探索は不要。

---

## Phase 1: #366 landmine + #306 daemon bundle + `resolveScsynthForUI()` 全 4 箇所の engine-kind 分岐

**GOAL**: .vsix が単体で scsynth 非依存に native Rust daemon を解決・起動できる状態にし、**(A) OrbitStudio 向け成果物（scsynth 非同梱）と (B) 通常 .vsix（Marketplace 向け・SC opt-out 用に scsynth 維持）を同一コードベース上の engine-kind 分岐で両立**させる（2 系統のコードベースは作らない）。

**TASKS**:
1. 読む: PR #366（branch `306-vsix-daemon-bundle`）body/コメント / `packages/engine/src/audio/create-audio-engine.ts`（`resolveEngineKind` の契約）/ MASTER_PLAN L181（「scsynth は載せない」の確定文言）
2. ビルド対象 (A)/(B) の 2 系統を明示宣言（上記 GOAL のとおり）
3. branch `306-vsix-daemon-bundle` を main に rebase（既知衝突 = WORK_LOG.md の追記競合のみ・コード overlap なし。**着手が遅れるほど rebase コスト増**）
4. **extension.ts の `resolveScsynthForUI()` 全 4 箇所を「scsynth の物理的有無」でなく「engine kind」で分岐**（#136 strict mode 原則 = silent fallback を作らない）:
   - (i) **L149-174** `updateBundleStatus()`（status bar）— rust kind 時は scsynth 解決を呼ばず rust 向け non-error 表示
   - (ii) **L184-201** `maybeShowBundleNotice()` — rust kind 時は通知抑制
   - (iii) **L699-708** `startEngine()` pre-check — rust ならスキップし engine 種別に応じた env 設定へ
   - (iv) **L836-862** `selectAudioDevice()` — SC 専用実装（`execFile(scPath, ['-u','57199'])` の boot log パース）。rust kind 時は **「Rust エンジンはデバイス選択に未対応」の明示メッセージに置換を必須実施**（device-enum API 実装可否の owner 判断と独立 — 壊れたコマンドを黙って出荷しない）
5. package.json contributes.configuration に **`orbitscore.engine`**（enum: rust 既定 / sc）を新設。`orbitscore.scsynthPath` は sc opt-out 用に残す
6. `.github/workflows/release.yml` に `cargo build --release`（orbit-audio-daemon）ステップを追加し、成果物を extension の `engine/bin/` へコピー（既存 build:copy-engine の scsynth コピーパターン踏襲）。`.vscodeignore` に `!engine/bin/**`
7. `packages/engine/src/audio/rust-engine/daemon-client.ts` の `resolveDaemonBinary()`（**L501-517**）にインストール済み拡張の `__dirname` 相対候補を追加（**既存 4 候補の順序・当落は無改変・末尾追記のみ**。packages/engine に及ぶため Phase 4 の確認は grep でなく CLI 実行テストで行う）
8. device enumeration API 本体（list_devices 等 + cpal enumeration + TS 配線）の実装要否は **owner 確認待ち**（タスク 4-(iv) の代替メッセージは要否に関わらず必須）
9. 孤立ファイル `syntaxes/orbitscore.tmLanguage.json`（contributes.grammars から未参照）の参照有無を全体 grep → 無ければ削除
10. `/simplify` + `/code:pr-review-team` 収束 → merge は owner 指示

**GATE**: 既存テスト全 green + (A) 成果物で 4 箇所全てが engine-kind 分岐で機能する実機 smoke + (B) で SC opt-out 時の既存挙動無改変 + device-enum gap が明示的に決着済み（silent に残さない）。
**委譲**: 4 箇所の分岐実装・env flip・release.yml・resolveDaemonBinary 追記・tmLanguage 掃除 = **Sonnet 並列可**（ただし「engine kind による分岐」契約を Opus が先に確定してから渡す）。device-enum プロトコル設計（実装する場合）と resolveDaemonBinary 影響評価 = Opus。
**依存**: なし（Phase 0 と並行可）。
**トークン**: file:line anchor が判明済みのため範囲限定で読む（extension.ts 全 1392 行を読まない）: L124-140/L149-174/L184-201/L699-708/L747/L836-862 + create-audio-engine.ts + daemon-client.ts L501-517 + rust-engine-player.ts L423-433 + PR #366 本文。

---

## Phase 2: B1 リブランド rebuild scaffold + 2.0.0 parity smoke

**GOAL**: VSCodium 公式 rebuild スクリプト群で OrbitStudio 名のリブランド build を作り、Phase 1 修正済み .vsix を side-load して「2.0.0 相当の体験が VSCodium 上で動く」を実証。

**TASKS**:
1. **軽量 STOP ゲート（spike）**: VSCodium 公式ビルドスクリプトを**最小構成（リブランドなし）でこの開発マシンで一度完走**させる（Phase 0 の公式バイナリ DL とは別物 — ツールチェーン自体の検証）。完走しなければ STOP → 代替（VSCodium の CI 公開ビルド成果物流用 + リブランド後付け / 別マシンビルド）を検討してから進む
2. Phase 0 の 2 チェック（gate A/B）を**リブランド build に対して再実施**（リブランド固有リグレッションの検出。失敗は個別バグ潰しでなく spike 失敗 = STOP・報告として扱う）
3. github.com/VSCodium/vscodium を clone、公式 pipeline で macOS arm64 向けに product 名/icon をリブランド（署名なしローカル build でまず可）
4. Phase 1 修正済み .vsix を side-load
5. smoke: .orbs REPL 実行 → **scsynth 未インストール環境**で Rust daemon 起動・発音 / `node cli-audio.js repl` がリブランド build 内ターミナルから単体動作 / selectAudioDevice が rust 向け代替メッセージ表示
6. **Gatekeeper 確認**: 未署名の同梱 daemon が quarantine でブロックされないか。**ブロック時の一時対処（`xattr -d com.apple.quarantine` / ad-hoc 署名）は owner 許可を得てから採用・文書化**（Phase 3 正式署名の代替ではない）。⚠️ ブロックは「音が出ない」偽陰性として現れるので原因誤認に注意

**GATE**: **2.0.0 QA Epic #278 の実機 E2E チェックリストを「2.0.0 parity」の定義としてそのまま転用**し、各項目を VSCodium 上で実行して PASS/FAIL 記録。全 PASS で Phase 3 へ。1 項目でも (a) VSCodium 固有かつ (b) B1 範囲で解決不能なら、その項目を添えて **B2/B3 エスカレーション判断パケットを起票**し Phase 3 に進まない。
**委譲**: 公式 build script 追従の機械作業・ツールチェーン spike 実行 = Sonnet 可。spike go/no-go・#278 PASS/FAIL 判定・B2/B3 エスカレーション要否 = Opus。
**依存**: Phase 0（gate 通過）+ Phase 1（修正済み .vsix）。
**トークン**: 本計画で最重量（VSCodium ビルド手順は外部知識）。公式 docs を WebFetch で読む。**記憶からビルド手順を再現しない**。

---

## Phase 3: 署名 / notarize / 配布パイプライン

**GOAL**: Phase 2 のローカル build を Gatekeeper 通過の notarize 済み .dmg として配布可能に（確定チャネル = Steam + Developer ID notarize 直接 .dmg）。署名対象 = VSCodium.app バンドル本体 + 同梱 orbit-audio-daemon（scsynth は (A) 成果物に無いため対象外）。

**TASKS**:
1. 読む: `POST_2.0_ENGINE_AND_DISTRIBUTION.md` §5 / `docs/research/CODESIGN_PIPELINE.md`「Fallback plan」節 — **転用可能なのは `codesign --options runtime --timestamp --entitlements` の構文パターンのみ**。同 doc はフラットな Mach-O 群（scsynth+dylib+plugins）前提で、**Electron/.app バンドル全体（ネストしたヘルパー・内→外の署名順・hardened runtime entitlements）は別カテゴリの作業**として扱う
2. **軽量 STOP ゲート（spike）**: VSCodium/Code-OSS 公式パイプラインの署名スクリプト有無を先に調査。有ればそれに従う（工数大幅圧縮）。無ければ Electron 公式 code signing guide ベースの独自スクリプトが要る旨を owner に報告し見積り更新してから進む
3. **owner action（代行不可・ブロッキング）**: Apple Developer Program 加入・Developer ID Application 証明書取得・CI への secret 提供
4. 証明書取得後: .app バンドル全体 + 同梱 daemon に内→外の順で `codesign --options runtime --timestamp --entitlements <plist>`
5. entitlements plist: **engine 自体は CLAP プラグイン拡張が完成済み**（in-process #341 + out-of-process sandboxed effect γ M1 #360・scsynth に無かった能力）だが、**Studio 出荷範囲では DSL/UI からのプラグイン利用が未公開**（TS 配線 = follow-up #361・EQ-from-DSL 等は post-cutover）のため entitlements は最小限で開始できる。ただし **CLAP 公開時点（δ VST3/AU を待たず）**で hardened runtime 例外（disable-library-validation / allow-jit 等 — daemon が 3rd-party dylib を dlopen するため）が必要になる前提を明記
6. `xcrun notarytool submit <dmg> --wait` + staple
7. Steam 配布は骨組み（manifest 等）のみ・SDK 統合は配布が現実的になるまで scope 外

**GATE**: notarize 済み .dmg がクリーンな別マシンで `spctl --assess` を通過。
**委譲**: 証明書/アカウント = owner 専管。署名スクリプト有無調査 = Sonnet 可（go/no-go は Opus）。CI 配線・entitlements・notarytool = 証明書後に Sonnet 可。
**依存**: Phase 2 ゲート通過。

---

## Phase 4: WCTM 非依存ガード + housekeeping（Phase 1 後いつでも並行可）

**GOAL**: Phase 1-3 の変更が WCTM 本番の依存（CLI/評価経路・.orbslog・耳デーモン想定）を汚していないことを確認・記録（実装はしない）。

**TASKS**:
1. 回帰確認: daemon-client.ts の resolveDaemonBinary 追記を含め、**CLI（`node cli-audio.js repl` 等）経由の実行テスト**で .orbslog writer・daemon 起動の実行時挙動が不変であることを確認（ディレクトリ境界 grep でなく実行で裏付け）。extension.ts/package.json の他変更が packages/vscode-extension 配下に閉じることは grep で併確認
2. 4 ガードレールを issue #301 か相当 doc に短く記録: (a) Bridge 3 ツールが消費する CLI/評価経路の非汚染（CLI 実行確認ベース）(b) .orbslog v1.1 の安定維持（OrbitStudio は所有・改変しない）(c) 耳デーモン（実装案7）は別プロセスサイドカーで editor プロセスと結合しない (d) **pi SDK の OrbitStudio 埋め込みは本番後に据え置き**（保全するのはモジュール境界「データ源アダプタ ↔ agent-run コア ↔ eval/log」のみ）
3. issue #301 body が Phase 0 更新内容のまま正確かを再確認

**GATE**: CLI 単体テスト suite green + 4 ガードレール文書化済み。
**委譲**: 全面 Sonnet 可（アーキ判断なし）。

---

## WCTM との関係（誤結合防止）

**この計画は WCTM 本番（2026-08-07）の依存グラフに入らない。** 本番ランタイム = pi 専用ハーネス + 脳なし Bridge + CLI/engine 評価経路であり、OrbitStudio（IDE 本体）は本番のいかなる経路にも登場しない（WCTM_SYSTEM_SPEC §4.3/§7）。どのフェーズも本番締切をブロックせず、本番も OrbitStudio の完成を待たない。土台として保全するのは Phase 4 の 4 ガードレールのみ。

## 機能組み込みレジストリ

**実際の組み込み可否は owner 判断**。status: `prerequisite` = 計画本文に組込済 / `owner-decision` = owner 確認まで着手しない / `post-beta` = OrbitStudio β 後 / `out-of-scope` = 本計画外（別トラック）。

| 機能 | 出典 | 配置 | status |
|---|---|---|---|
| #366 landmine 修正（4 箇所分岐） | PR #366 + code 実態調査 | Phase 1 | prerequisite |
| #306 daemon bundle（release.yml cargo build 含む） | issue #306 / PR #366 | Phase 1 | prerequisite |
| 孤立 tmLanguage.json 削除 | code 実態調査 | Phase 1 | prerequisite |
| Rust daemon device-enum API 本体 | rust-engine-player.ts L423-433 スタブ | Phase 1（条件付き） | **owner-decision** |
| MLTS 譜面表示パネル（VexFlow） | NOTATION_DSL_DESIGN | home 未決（.vsix vs Studio パネル） | **owner-decision** |
| per-track recording | PLUGIN_STRATEGY §6（未マージ #363） | 未定 | **owner-decision** |
| REPL 構造化プロトコル刷新 | code 実態調査 | 未定 | **owner-decision** |
| capture seam realtime（#307/#365） | PLUGIN_STRATEGY §0/§4 | 独立 engine PR（#365）・依存なし | post-beta |
| capture seam 経由 render/bounce | MIXER_DSL_DESIGN §10 | β 後（master chain 前提） | post-beta |
| buffer knob #368 | ローカル branch（PR 未作成・要 rebase） | 独立 PR・依存なし | post-beta |
| LinkAudio の Studio UI 露出 | PLUGIN_STRATEGY §5 | β/改良層（engine 側実装済み） | post-beta |
| mixer/routing の Studio-era 項目 | MIXER_DSL_DESIGN §11 | β 後（routing model 確定が先） | post-beta |
| EQ-from-DSL | PLUGIN_STRATEGY §8 | post-cutover・M2 param path | post-beta |
| VST3/AU（δ）/ M2 instrument IPC | PLUGIN_STRATEGY §7/§3 | Track A engine プラン | out-of-scope |
| #342 残 2 項目 / .orbslog v2 再設計 / pi SDK 埋め込み | 各 issue/doc | 別トラック（pi SDK = 本番後） | out-of-scope |
| VST GUI Electron 共存スパイク（B8） | VSCODIUM research §5 Q2 | **B2 エスカレーション直前のみ**（前倒ししない） | 条件付き |

## owner 決定事項（この計画が確定しない点）

1. **B2/B3 エスカレーション判断** — Phase 2 ゲートの #278 チェックリスト FAIL 項目が出た場合のみ判断（前倒しスパイクしない）
2. **device-enum API を Phase 1 で実装するか documented gap として先送りか**（いずれでも代替メッセージは必須実施）
3. **Apple Developer Program 加入**（Phase 3 前提・費用/クレデンシャルは owner 専管）
4. MLTS 譜面パネルの home（2.1.0 .vsix vs Studio パネル）
5. per-track recording の着手基準
6. REPL 構造化プロトコル刷新の要否
7. #342 残 2 項目のタイミング
8. **「OrbitStudio」名称は依然候補**（MASTER_PLAN §6）— 確定名称ではない
9. Phase 2 の Gatekeeper 一時回避（xattr 除去 / ad-hoc 署名）をローカル開発ループ限定で許容するか
10. **scsynth 退役の実行タイミング**（方向は owner 確定 2026-07-04: **「新エンジンに載せ替えて退役させて消す」— 消すこと自体は決定事項であり選択肢ではない**。#108 の「default 切替 → scsynth 退役」どおり。cutover での opt-out 温存は恒久方針でなく移行期の安全網。owner 判断は以下 2 段のタイミングのみ）:
    - **(b) 同梱退役**（先行・軽い）: .vsix から scsynth bundle を落とす。`resolveScsynthPath` は explicit→env→bundle の strict 解決なので、移行期の SC 起動は `ORBIT_SCSYNTH_PATH`（自前 scsynth）で可能なまま配布だけ軽くなる（bundle コピー・署名対象・build:copy-engine 重複が消える）。**Phase 1 と同時実施可** — 実施すれば Phase 1 の (B) 系統は「scsynth 非同梱・env 指定でのみ SC」に簡素化される
    - **(c) コード削除 = 完全退役**（後段・重い）: SuperColliderPlayer/OSC 経路・SC 依存テスト・LinkAudio SynthDef 等の SC 資産を削除する**別 issue**。推奨タイミング = Phase 2 ゲート（#278 チェックリストで Rust 経路の実地証明）通過後。これをもって scsynth 退役完了
    - 本計画の (A)/(B) 2 系統は (c) 完了までの**移行期の姿**であり、終着は「(A) のみ = scsynth を知らないコードベース」

## 委譲プロファイル（Opus/Sonnet）

- **Opus 直列**: 各フェーズの gate 判定・STOP/継続・アーキ選択（Phase 0 の Claude 拡張解釈、Phase 1 の「engine kind 分岐」契約確定、Phase 2 の B1→B2/B3 判定と build spike go/no-go、Phase 3 の署名カテゴリ判断、device-enum の owner 確認取り纏め）
- **Sonnet 並列可**: file:line 特定済みの機械的修正（Phase 1 の 4 箇所分岐〔契約確定後〕・release.yml・resolveDaemonBinary 追記・tmLanguage 掃除）、Phase 2 の公式 script 追従ビルド、Phase 3 の CI 配線/entitlements/notarytool（証明書後）、Phase 4 全部
- 委譲時の入力 = 該当 file:line 範囲 + cited doc § のみに限定。確定済み決定の再設計は該当表を提示して却下

## リスク（要注意順）

1. リブランド build が拡張を load できない → B1 前提が崩れ早期 B2/B3（Phase 0/2 の 2 段 spike で事前検知）
2. 未署名 daemon の Gatekeeper ブロックが Phase 2 smoke の**「音が出ない」偽陰性**として現れる（原因誤認注意）
3. PR #366 の rebase コストは時間経過で増大（衝突は現状 WORK_LOG のみ）
4. `resolveScsynthForUI()` 4 箇所のうち 1 つでも見落とすと、(A) 成果物で**毎回確実に**エラー表示/機能停止（稀なエッジケースではない — scsynth が物理的に無いため）
5. VSCodium ビルドツールチェーンがこのマシンで完走する保証なし（Phase 2 冒頭 spike で検知）
6. device-enum gap を暗黙先送りすると scsynth 時代より機能退行した Studio になる（代替メッセージ必須化で対処済み）
7. Claude tooling の VSCodium/Open VSX 動作は**一次調査未確認**（Phase 0 gate B がこのための STOP）
8. issue #301 の古い body を放置するとコールドスタート Opus が古いスコープで実装する（Phase 0 で即修正）
