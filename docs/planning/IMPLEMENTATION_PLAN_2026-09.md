# 実装プラン 2026-09 — PR 戦略（設計文書 `docs/design/` の実装順）

**状態**: 計画（実装しない）・2026-09-03・main `ca176f0` 起点
**前提**: `docs/planning/DEVELOPMENT_MAP.md` §3（リリースまでの筋・締切は無い・順序だけ）/ §9（未決は埋めない）/ `docs/core/PROJECT_RULES.md` §1b-§1d / CLAUDE.md「テストの積み上げ規律」（① 仕様 → ② MCP 経由 E2E → ③ 機能テスト → ④ 変異は最後の手段）
**設計文書（本プランが順序づけるもの）**:

| 文書 | 束 | PR 接頭辞 |
|---|---|---|
| `docs/design/611-output-line-design.md` | 出口の一般化（#611/#649/#543-a/#409/#647） | PR-O |
| `docs/design/694-session-log-editor-path-design.md` | セッションログ → リプレイ（#694/#695/#241） | PR-L |
| `docs/design/598-render-endpoint-design.md` | render エンドポイント・実時間 stem・オフライン（#598 P2/P3・#241 `--render`） | PR-R |
| `docs/design/672-plugin-boundaries-design.md` | プラグイン境界・DSL Plugin（#672/#671/#674/#321/#497） | PR-P |
| `docs/design/634-pdc-layer-instrument-rack-design.md` | リリースゲート連鎖（#606/#634/#635/#636/#669） | PR-K |
| `docs/design/428-timed-event-queue-design.md` | 時刻付きイベント queue（#428/#680/#674/#460） | PR-Q |
| `docs/design/610-diagnostics-applicability-design.md` | 診断の整合（#610/#644/#280/#255/#583/#609/#665A/#620/#645） | PR-D |
| `docs/design/662-performance-and-visibility-design.md` | 可視化・設定・性能（#662 A-E/#661/#660/#667/#663/#368/#156） | PR-V |
| `docs/design/656-release-design.md` | 配布（#659/#656/#385/#138/#498） | PR-S |
| `docs/design/668-e2e-foundation-design.md` | E2E 基盤（#668-A/#650/#630/#543-b/#624/#640/#684） | PR-E |
| `docs/design/679-input-consistency-check.md` | 入力（#679・**着手しない**・整合確認のみ） | — |

🔴 **各 PR の共通規約**（CLAUDE.md・PROJECT_RULES）: 1 PR = 1 論理変更・各 commit で build + test 緑・spec を先に直す（運用規則 6）・DSL 表面を足したら gated E2E を足す（ラチェット）・capture するなら数値で判定・`ok` に assert しない・ERROR 件数は `<=`・変異テストは PR に載せない・横断的関心事（診断ポリシー・ガード方針・エラー封じ込め）は**先にポリシー 1 段落**を書いてから一括適用・issue のチェックリストは PR 本文で `[x] — PR #NNN` を付ける（§1d）。

---

## 0. 🔴 一方通行の判断（先に洗い出す・戻せないもの）

| # | 判断 | どこで確定するか | 戻せない理由 | 裁定の状態 |
|---|---|---|---|---|
| W-1 | wire `SetBusLine`（全置換・`line[]`）と `SetBusRouting` の退役 | PR-O3 / PR-O6 | daemon と TS の契約。旧 daemon × 新 TS が動かなくなる（同梱なので実害は小） | 設計済み（doc 611 §4）|
| W-2 | `OutputDest` の宛先集合（master / bus / device / render / link → tap）| PR-O4 / PR-P5 | DSL 表面と wire の両方 | 設計済み・`Tap` 統合は doc 672 §18 (6) |
| W-3 | `output(dest, thru: false, db: 0)` の**既定** = `thru:false`・`send` は dB | PR-O4 | 既存譜面の意味（`send` の線形 amount → dB は**破壊的**・MX.3 改訂）| 🔴 裁定済み（①②）。**golden（PR-O0）で差分ゼロを先に固定** |
| W-4 | 数値 `output(n)` の退役と §4.4.1 の失効 | PR-R1（PR-O4 と同 PR でも可） | DSL 表面 | ✅ **裁定 A 撤回（owner 2026-09-03）**。糖衣として復活できる形は保つ |
| W-5 | `mix.render("<path>")` 宣言・`%n` `%v` `%d`・合算 = 解決後パス | PR-R1 | DSL 表面 | ✅ 裁定済み（語彙も 2026-09-03 に確定）|
| W-6 | `.orbslog` **v2**（`logVersion: 2`・相対 `sourceFile`・`transport.global`・`code` 純度）| PR-L1 | ファイル形式。ただし**今日 `.orbslog` は 0 本**なので実害なし | 設計済み（doc 694 §6）|
| W-7 | ログの置き場 `orbslog/`（譜面の隣） | PR-L1 | ディレクトリ名は後から変えにくい | ✅ **裁定 `orbslog/`（owner 2026-09-03）** |
| W-8 | フレーム `//#evalBegin/End` = **1 選択 1 execute**（構文エラーで全体棄却）| PR-L2 | 評価の意味論 | 設計済み（doc 694 §4.2）|
| W-9 | `orbitscore replay` / `render` の CLI 引数 | PR-L4 / PR-R7 | ユーザーの手順 | 設計済み |
| W-10 | `RenderScore` v2（`renders[]`・bus 名の数値廃止・`out_dir` 廃止）| PR-R6 | wire。**P1 の消費者は 0** | 設計済み（doc 598 §6.2）|
| W-11 | render / arm の wire（`DeclareRender` / `ArmRenders` / `DisarmRenders`）と stem の命名 | PR-R2 / PR-R3 | wire + ファイル名 | 設計済み・語彙のみ未決 |
| W-12 | 時刻付きイベント queue の wire（`ScheduleEvents[]` + `CancelScheduledEvents`）| PR-Q-A / Q-D / Q-F | wire | ✅ 設計済み。`PluginNoteOn/Off` は残す（owner 2026-09-03: Rust engine を単体公開するため）|
| W-13 | env prefix の境界規則（TS = `ORBITSCORE_` / daemon = `ORBIT_`）+ 例外 3 個の改名（#156）| PR-V2（PR-V7 の前）| env の名前 = ユーザーの設定 | ✅ **裁定 C（owner 2026-09-03）**: 改名は 3 個だけ |
| W-14 | 配布物 = dmg・bundle id は VSCodium 既定・バージョンの正本 = 拡張の `version`（tag と一致を強制）| PR-S-R3 / R4 / R5 | 配布物 | ✅ **裁定（owner 2026-09-03）**。署名 identity は手元の Developer ID |
| W-15 | DSL Plugin 登録 API（`DslModule` / `HostContext`）| PR-P1 / PR-P4 | 拡張 API（外部公開後は変えにくい）| ✅ A4 = 混在（owner 2026-09-03）。公開は段階的（first-party のみで出す版から）|
| W-16 | `TapSink` クラスと `OutputDest::Tap` | PR-P5 | wire | doc 672 §5 |
| W-17 | `orbitscore.sessionLog` 設定（既定 on）・CLI は opt-in のまま | PR-L1 | ユーザー設定 | ✅ 裁定（owner 2026-09-03）|

| W-18 | `pan` をライン要素に（`LineOp::Pan`）・同一宛先の複数 `output` は 2 要素・mono 宛先は L+R マージ | PR-O4 / PR-O3 | DSL 意味論 + wire（`pan` op）| ✅ **裁定（owner 2026-09-03 Q-611-3/4/5）**。`pan` を含む譜面の golden は再ベースライン |
| W-19 | OSC = メッセージ値 `var flash = osc(...)` を `play()` に置く | PR-P6 | DSL 表面 | ✅ 裁定（owner 2026-09-03 Q-672-3）|
| W-20 | `seq.root()` が note-name を受ける・`[...]@v` per-voice 分配・`chop(n>1)` の tie が伸ばす | PR-D7 / PR-D5 / #665 | DSL 表面（加算）| ✅ 裁定（owner 2026-09-03 Q-610-2/6/7）|
| W-21 | replay `--verify` の sidecar `<log>.events.jsonl` + `meta.assets` の sha256 | PR-L6 | ファイル形式 | ✅ 裁定（owner 2026-09-03 Q-694-4）|
| W-22 | node を `.app` に同梱 | PR-S-C2 | 署名対象 +1 | ✅ 裁定（owner 2026-09-03 Q-656-8）|
| W-23 | `.orbslog` の `transport` を**音楽時間**にする（`TransportTimeline`・tempo/beat 変更で逆行しない）| PR-L8 | ログの `transport` の意味。**今日 `.orbslog` は 0 本**なので実害なし。LOOP quantize も乗せる | ✅ **裁定 A（owner 2026-09-03 夕 Q-694-8）**・実測で必要性を確認（doc 694 §2b）|
| W-24 | プラグイン状態を `orbslog/<log>.states/` へ start / stop で写す | PR-L9 | ファイル配置・セッションごとに状態ファイルが増える | ✅ **裁定 A（owner 2026-09-03 夕 Q-694-9）**|
| W-25 | N ch render（`mix.render(path, channels)`・`output(at:, mono:)`）| PR-R9 | DSL 表面 + wire（加算）| ✅ **裁定 B-lite（owner 2026-09-03 Q-598-2）** |

**方針**: 一方通行のものは **(a) golden で現状を固定してから**（W-3/W-4）、**(b) 消費者が 0 のうちに**（W-6/W-10）、**(c) 定数 1 箇所で裁定を吸収して**（W-7）進める。裁定待ちの項目は**その PR だけ**が止まる形に分割してある。

---

## 1. PR 一覧

記法: **依存** = 先にマージが要る PR（理由）/ **検証** = 追加する E2E と実機 MCP 手順 / **⟂** = 並行可能（同じ列の PR と順序を持たない）/ 🔴 = 一方通行（§0）

### 1.1 出口の一般化 — PR-O（doc 611 §12）

| PR | 件名 | 対象（issue・チェックリスト） | 触るファイル（概算行） | 依存 | 検証 | 一方通行 |
|---|---|---|---|---|---|---|
| PR-O0 ⟂ | `test(e2e): capture goldens for existing scores (#543-a)` | #543 (a) 回帰の固定 | `tests/e2e/orbitstudio-mcp-gated.spec.ts`（+150）・`tests/e2e/rack-chain-gain-expectations.ts`（+40）・fixture 4 譜面 | PR-E0（helper） | 4 譜面の窓 RMS を式で固定。実機: `npm run test:e2e:gated` | — |
| PR-O1 ⟂ | `docs(spec): output as a line element — MX.2/2.1/3/4/5, SC.2.1/4, #649 §10` | #611 spec 改訂項目・#649 §7.3/§10-12・#643 §1.5/§12 | core spec（±120）・`SIGNAL_CHAIN_DSL_SPEC`（±40）・`649-audio-line-design.md`（±30）| — | docs のみ（advisor レビュー）| — |
| PR-O2 | `fix(engine): stereo-internal engine + master line (fader position, 8ch@2048 silence)` | **#649 must-fix**・#611 本文の 8ch 無音・E2E-0/1/8/11 | `output.rs`（±200: `MasterLine`・post-loop 置換・`Engine::new(sr,2)`）・`engine_wrap.rs`（±40）・`session.rs` `SetGlobalGain`（±20）| PR-O0（golden で bit 一致を確認するため）・PR-O1 | E2E-0 bit 一致・E2E-1 **red-first**・E2E-8・E2E-11。実機: `global.gain(-6)` + instrument で RMS 半減 | — |
| PR-O3 🔴 | `feat(daemon): LineProgram + SetBusLine (full-replacement bus line wire)` | #611 wire・#647 shm 拡張 | `output.rs`（+350: `OutputDest`/`LineOp`/`LineSlot`・RT 実行）・`session.rs`（+180 検証）・`protocol-types.ts` `daemon-client.ts`（+60）・cargo test（+200）| PR-O2 | cargo: forward-only 検証・thru:false で break・ramp。実機: 既存譜面が `SetBusRouting` 経路のまま同音（両 wire 併存）| W-1 |
| PR-O4 🔴 | `feat(dsl): output(dest, thru, db) / send in dB / pan as a line element — AudioLine on Sequence and master` | #611 DSL・#649 実装 B・**#543-a 差分ゼロ（`pan` 譜面は再ベースライン）**・同一宛先の複数 `output`（2 要素）・mono 宛先 | `core/sequence/audio-line.ts`（新 +240）・`sequence.ts`（±130）・`global.ts`（+40）・`mixer-manager.ts`（±60）・`runtime.ts`（±30）・`evaluate-method.ts`（+40）・`repl-mode.ts`（+20）・tests（+320）| PR-O3・**PR-L2（フレーム）**・PR-O1 | E2E-2〜7・E2E-10 + `pan` の L/R（PR-E3 の後）。実機: `kick.output(verb, thru:true, db:-12).output(master)` を評価して aux の RMS 比 | W-2 / W-3 / W-18 |
| PR-O5 | `feat(engine): instrument outs: — per-unit passthrough stages` | #409 `outs:`・#647 | `sequence.ts` `instrument()`（+60）・`engine_wrap.rs` `SetSourceRouting` 緩和（+40）・`outproc_instrument.rs` shm（+30）| PR-O4 | E2E-9。実機: `outs: {"kick": bd}` で bd バスの RMS > 0 | — |
| PR-O6 | `refactor(daemon): retire SetBusRouting / routing_override / send_gain_overrides` | #611 cleanup | `output.rs`（−150）・`session.rs`（−80）・TS（−60）| PR-O4 | 既存全件 + gated 全件 | W-1 |

### 1.2 セッションログ → リプレイ — PR-L（doc 694 §10）

| PR | 件名 | 対象 | 触るファイル（概算行） | 依存 | 検証 | 一方通行 |
|---|---|---|---|---|---|---|
| PR-L0 ⟂ | `docs(spec): session log v2 — directory, frame, code purity, replay CLI` | #694 spec §2 改訂・#695 §3.1・#241 §4 | `SESSION_LOG_SPEC_v1.md`（±80）・core spec `:62-64`（±5）・doc 611 §3.9（±5）| — | docs | — |
| PR-L1a | `feat(session-log): <DIR>/ placement, //#sourceFile, code purity, logVersion 2` | #694 (2)(3)・純度 | `session-log-writer.ts`（±60）・`repl-mode.ts`（+80: `//#sourceFile`・`stripMetaLines`・単独メタ行）・`interpreter-v2.ts`（±30）・`tests/session-log/*`（+120）| PR-L0 | integration test（ディレクトリ・相対 `sourceFile`・純度）| W-6 / W-7 |
| PR-L1b | `feat(extension): enable the session log from OrbitStudio (setting + env + //#sourceFile)` | **#694 (A) 受け入れ** | `package.json`（+8）・`extension.ts`（±40: env・`writeCodeToEngine` の 3 引数・注入廃止）・gated E2E（+180: S1/S2/S4/S5/S6）| PR-L1a | **E2E-S1**（ファイル実在 + 中身）・S4（off）・S5（untitled）・S6（純度）。実機: `open_file` → `run_selection` → `<DIR>/` を `ls` | W-17 |
| PR-L2 🔴 | `feat(repl): //#evalBegin / //#evalEnd frame — one selection, one execute` | **#695 (1)**・doc 611 §3.9 の前提 | `repl-mode.ts`（+90）・`extension.ts` `writeCodeToEngine`（+6）・unit（+80）・gated E2E-S3（+40）| PR-L1a | E2E-S3（1 選択 = 1 レコード）・unit `execute` 1 回 | W-8 |
| PR-L3 ⟂ | `feat(session-log): hook every GLOBAL; transport.global` | #695 (2) | `interpreter-v2.ts`（±40）・`session-log-writer.ts`（±40）・integration（+60）| PR-L1a | integration（2 GLOBAL・開閉規則）| 形式（加算）|
| PR-L4 | `feat(cli): orbitscore replay <log> — faithful, transport-driven` | **#241 忠実リプレイ**・**#694 (B) の実測**（doc 694 §2b: 今日のログは再現に使えない → L7/L8 の後）| `cli/replay-mode.ts`（新 +200）・`parse-arguments.ts` `execute-command.ts`（+40）・`global.ts` `msUntilTransportPosition`（+25）・gated E2E-R1/R2/R3（+200）| PR-L2（フレーム粒度）・**PR-L7（result/import）・PR-L8（timeline）**| **E2E-R1**（ライブ capture と replay capture の窓 RMS 一致 ±15%）。実機: `orbitscore replay <log>` を `ORBIT_CAPTURE_WAV` 付きで | W-9 |
| PR-L5 | `feat(cli): replay --until — fast-forward fold, then hand over to the REPL` | #241 `--until`（2 相: 仮想畳み込み → 宣言の再生 + `Global.startAt(until)` + LOOP 再発行・doc 694 §7.4）| `replay-mode.ts`（+120）・`global.ts` `startAt`（+30）・`transport-clock.ts`（+10）| PR-L4・**PR-R4（Clock DI）・PR-R5（評価列 driver）** | unit（`until` 時点の状態が Phase A と一致）+ E2E: `--until 3:1` から続けた capture の 3 小節目以降がライブと一致 | ログに `at`（加算）|
| PR-L6 | `feat(session-log): event sidecar + assets hash for replay --verify` | #241 `--verify`（doc 694 §7.5）| `session-log/event-sidecar.ts`（新 +120）・`session-log-writer.ts`（+40・assets 非同期）・`replay-mode.ts`（+60）| PR-L4 | E2E-R4: 同一セッションの replay で `--verify` 差分 0 | sidecar 形式 |
| PR-L7 | `feat(session-log): result / import records; agent provenance from the MCP path` | doc 694 §2b G4/G5/G8・§6b | `session-log-writer.ts`（+40）・`repl-mode.ts`（+30: `//#evalMark` の `ok`/`diagnostics` を `result` へ・フレーム属性）・`process-file-import.ts`（+20）・`extension.ts` `evaluateForAgent`（+3）・integration（+80）| PR-L2 | integration: 失敗 eval に `result.ok:false`・MCP 経路の eval が `evalSource:"agent"`・import 本文がログにある。E2E-S7（MCP で評価 → `orbslog/` の `evalSource`）| 形式（加算）|
| PR-L8 | `feat(core): TransportTimeline — bar:beat as musical time across tempo/beat changes` | doc 694 §2b **G6**（実測: `1:3.000` の 10 ms 後が `1:2.010`）・§7.2 | `core/global/transport-timeline.ts`（新 +80 pure）・`global.ts`（±40: `getTransportPosition` / `getQuantizedEffectPosition` / `msUntilTransportPosition`・`tempo()`/`beat()` で `change`）・unit（+100）・integration（+40）| PR-L1a | unit: 120→60 の 10 ms 後が `1:3.010`・`barBeatToMs(msToBarBeat(x)) === x`。**E2E-L8**: tempo 変更直後の LOOP が次の小節頭で入る（capture で onset 位置）| W-23（裁定 A）|
| PR-L9 | `feat(session-log): snapshot plugin states into orbslog/ at start and stop` | doc 694 §2b **G7**・§6b `pluginState` | `session-log-writer.ts`（+40）・`global.ts`（+40: start/stop hook から `savePluginState` を `orbslog/<log>.states/` へ）・`effect-slot.ts`（+10: 解決順の先頭に override）・`replay-mode.ts`（+20）・integration（+60）・gated E2E（+80）| PR-L1a・**PR-R8 の前提** | E2E-L9: instrument を載せて start → `orbslog/<log>.states/` に state 実在 → stop 後に別状態で replay → RMS がライブ capture と一致 | W-24（裁定 A）|

### 1.3 render — PR-R（doc 598 §14）

| PR | 件名 | 対象 | 触るファイル（概算行） | 依存 | 検証 | 一方通行 |
|---|---|---|---|---|---|---|
| PR-R0 ⟂ | `docs(spec): render endpoints — mix.render, %n template, merge rule; retire MX.2.1 numeric` | #598 spec・MX.2.1・SC.2.1・`outs:` | core spec（±80）・`SIGNAL_CHAIN_DSL_SPEC`（±10）・`MULTICHANNEL_RENDERING_DESIGN_598.md` §4.3/4.4（±60）| PR-O1 | docs | — |
| PR-R4 ⟂ | `refactor(core): inject Clock (Date.now / setTimeout) — behaviour-preserving` | doc 598 §10.1 の core 17 箇所 | `global.ts` `transport-clock.ts` `sequence.ts` `loop-sequence.ts` `run-sequence.ts` `prepare-playback.ts` `interpreter-v2.ts`（±80）| — | 既存全件 + gated 全件（既定 `Date.now` で bit 同一）| — |
| PR-R1 🔴 | `feat(dsl): mix.render(<path>) endpoint declaration + %n template; retire output(n)` | #598 チェックリスト「エンドポイント宣言」「`%n`」「合算」「相対」・W-4 | `parse-statement.ts`（+30）・`parser/types.ts`（+5）・`runtime.ts`（+30）・`core/global/render-endpoint-manager.ts`（新 +150）・`render-endpoint.ts`（新 +60 pure）・`sequence.ts`（−40）・unit（+150）| PR-O4・**W-4 の裁定** | unit（展開・合算 key）。DSL 表面は E2E-R1（PR-R3）で押さえる | W-4 / W-5 |
| PR-R2 🔴 | `feat(daemon): DeclareRender / ArmRenders / DisarmRenders + RenderInstance pool` | #598 実時間 stem の wire・地図 §7 (7)(11) | `output.rs`（+200）・`engine_wrap.rs`（+150）・`session.rs`（+120）・`protocol-types.ts` `daemon-client.ts`（+50）・cargo test（+150）| PR-O3 | cargo: no-op 未 arm / commit / retire / drop 計上 | W-11 |
| PR-R3 | `feat(render): realtime stems end-to-end (arm on start, disarm on stop)` | #598「MCP 経由 E2E で render 宣言を評価しファイル生成」 | `global.ts`（+40）・`render-endpoint-manager.ts`（+60）・gated E2E-R1/R2/R3/R4/R7/R9（+300）| PR-R1・PR-R2 | **E2E-R1**（stem 実在・RMS・`dropped_samples: 0`）・R3（pre/post）・R4（版）。実機: `mix.render("stems/%n_%v.wav")` → `global.start()` → `ls stems/` | 命名 |
| PR-R5 | `feat(render): score driver — evals × virtual clock → RenderScore v2` | #598 P2 TS driver・#241 前提「transport 順の評価列」 | `render/score-driver.ts`（新 +300）・`CollectingEngine`（新 +120）・`render-score.ts` v2（±100）・unit（+200）| PR-R4・PR-L4（`.orbslog` 読み）・**PR-L8（音楽時間）**・PR-R1 | unit: `.orbs` 1 本と同内容の 1 eval ログが**同一 manifest** | W-10（TS 側）|
| PR-R6 🔴 | `feat(daemon): OfflineRenderSession (P2) — RenderScore v2 renders stems + master` | **#598 P2**（driver・per-bus WAV + master・`load_with_process_mode` 配線・#606 と同じ終端）| `engine_wrap.rs`（+250）・`session.rs`（±150）・`tests/fixtures/render-score-manifest.json` v2・cargo（+200）| PR-R2 | cargo: 同一 manifest 2 回で bit 一致・8 バス bleed 無し | W-10 |
| PR-R7 | `feat(cli): orbitscore render <orbs> --duration / replay --render` | #598 P2 CLI・**#241 `--render`** | `execute-command.ts` `parse-arguments.ts`（+60）・`replay-mode.ts`（+30）・gated E2E-R5/R6（+150）| PR-R5・PR-R6 | **E2E-R5**（bit 一致・実時間比を記録）・**E2E-R6**（ライブ capture と一致）。実機: `orbitscore replay <log> --render` | W-9 |
| PR-R8 | `feat(render): P3 — plugins + instruments offline (offline process mode, sync adapter)` | **#598 P3**（必須） | `engine_wrap.rs`（+300）・`orbit-audio-sandbox` adapter（+150）・manifest `instruments[]`（+60）・E2E-R8 | PR-R6・PR-K4（#636 instrument rack・doc 598 §16 (8)）・**PR-L9（状態の写し）**| **E2E-R8**（streaming instrument で realtime capture と一致・`process_errors == 0`）| wire（加算）|
| PR-R9 | `feat(render): N-channel render endpoints — mix.render(path, channels) and output(at:, mono:)` | **#598 サラウンド B-lite**（doc 598 §3.6・owner Q-598-2）| `output.rs`（+60）・`engine_wrap.rs`（+30）・`parse-statement.ts` `runtime.ts`（+50）・`render-endpoint-manager.ts`（+20）・`render-score.ts` `channels`（+10）・gated E2E-R10（+80）| PR-R3・PR-E3（チャンネル別解析）| **E2E-R10**（4 ch WAV・ch 1-2 に kick・ch 3-4 に pad・交差 < -40 dB）| W-25 |

### 1.4 プラグイン境界 — PR-P（doc 672 §16）

| PR | 件名 | 対象 | 触るファイル（概算行） | 依存 | 検証 | 一方通行 |
|---|---|---|---|---|---|---|
| PR-P8 ⟂ | `spike(daemon): in-process WASM process() latency probe` | 地図 §7 (2)・doc 672 §6.2 | `rust/crates/orbit-wasm-spike/`（新・+300・workspace 外）| — | 実測レポート（数値目標なし）| — |
| PR-P0 | `docs(spec): DSL Plugin / DSP Plugin contracts v1` | **#672 全項目** | `docs/specs-v2/DSL_PLUGIN_SPEC_v1.md`（新 +300）・`DSP_PLUGIN_SPEC_v1.md`（新 +250）| **PR-E（#668 基盤）が先**（裁定 6）| docs | — |
| PR-P1 | `refactor(dsl): derive vocabulary sets from module registration (behaviour-preserving)` | #671 段階 1 | `dsl-plugin/module.ts`（新 +120）・first-party 6 モジュール（+400 移動）・`runtime.ts`（−50）・`signal-chain-dispatch.spec.ts`（±60）| PR-P0・**#668 網羅 E2E が緑** | E2E-P1（gated 全件緑）+ unit 集合等価 | W-15 |
| PR-P2 ⟂ | `feat(docs): generate reference/methods.md from module declarations` | #671 段階 2・#668 C | `scripts/gen-reference.ts`（新 +120）・`docs:check` 拡張 | PR-P1 | `npm run docs:check` | — |
| PR-P3 ⟂ | `feat(test): derive DSL E2E coverage from registered modules` | #671 段階 3・#668 A | `dsl-e2e-coverage.spec.ts`（±80）| PR-P1 | ラチェット red の再現 | — |
| PR-P4 | `feat(dsl): HostContext extension points (transport read, events.intercept, line.registerElement, timedEvents)` | #671 段階 4・#408 統合 | `dsl-plugin/host-context.ts`（新 +150）・`global.ts`（+40）| PR-P1・PR-Q（queue）・PR-O4 | unit + E2E-P3（`list_dsl_vocabulary`）| W-15 |
| PR-P5 🔴 | `feat(daemon): TapSink class — OutputDest::Tap and tap placement for out-of-process CLAP` | doc 672 §5・LinkAudio CLAP 化の土台 | `output.rs`（+80）・`engine_wrap.rs`（+120）・fixture tap CLAP（+150）| PR-O3・PR-R2 | E2E-P4 | W-16 |
| PR-P6 | `feat(dsl-plugin): OSC output as the first kind-B module (message values in play())` | #674（doc 672 §7.1b: `global.oscTarget` / `var flash = osc(...)` / `seq.osc(target)` / `play(flash, 0, (dim, flash))`）| `parse-statement.ts`（message 束縛 +40）・`dsl-plugin/modules/osc.ts`（新 +220）・UDP スタブ E2E（+120）| PR-P4・PR-Q-E | E2E-P2（UDP で時刻・アドレス・値・ネストの時刻差）| DSL |
| PR-P7 | `feat(dsl-plugin): Link tempo as a kind-B module (engine knows no Link)` | #321 PR3 の行き先・#670 | `dsl-plugin/modules/link-tempo.ts`（新）・`orbit-link-audio` の依存移動 | PR-P4・**transport write の裁定** | E2E-P6（headless readback）| — |

### 1.5 リリースゲート連鎖 — PR-K（doc 634 §13・番号は同文書の A/C/D/G/I に対応）

| PR | 件名 | 対象 | 触るファイル（概算行） | 依存 | 検証 | 一方通行 |
|---|---|---|---|---|---|---|
| PR-K-A0 ⟂ | `docs(spec): add RUN termination and offline render to the note-off firing cases` | #606・#598 コメント 6 | `PITCH_DSL_SPEC_v1.1.md`・core spec（+30）| — | docs | — |
| PR-K-A1 | `fix(engine): hold the RUN tail timer and align its origin with the scheduled events` | **#606 must-fix**（H1 タイマ未保持 / H2 原点 100ms ずれ。🔴 地図 §4.B「flush が無い」は誤り — `run-sequence.ts:61 → sequence.ts:1019 → midi-scheduler.ts:213 → plugin-note-output.ts:51` は実在）| `run-sequence.ts` `sequence.ts`（+60）| PR-K-A0 | T1 | — |
| PR-K-A2 🔴 | `feat(daemon): add PluginAllNotesOff so a dying engine cannot leave notes sounding` | #606（H3 note-off の silent drop `rust-engine-player.ts:1286-1303` / H4 daemon 側の砦 = `active_plugin_notes` を読む・読み手 0 件）| `engine_wrap.rs` `session.rs` `protocol-types.ts` `daemon-client.ts` `rust-engine-player.ts` `plugin-note-output.ts` `global.ts` `shutdown.ts`（+300）| PR-K-A1 | T1/T2・cfg 4 象限 | wire（新 RPC）|
| PR-K-C0 ⟂ | `docs(spec): state the v1 non-goals of plugin delay compensation` | #634-2 | `SIGNAL_CHAIN_DSL_SPEC_v1.md`（+20）| — | docs | — |
| PR-K-C1 🔴 | `feat(engine): report and compensate plugin latency inside the rack child` | #634-1/2（(a) プラグイン申告レイテンシ・`latency` を扱うコードは workspace に 0 行・測る側 2 crate も対象）| `orbit-clap-host` `orbit-vst3-host` rack-child `rack_wire.rs`（+450）| PR-K-C0 | T3（並列 2 枝の逆相で無音）・cfg 4 象限・`bundle-macos.sh` + rack-child `--ignored` | wire（`ChainReport`）|
| PR-K-C2 | `fix(engine): compensate the pipeline depth difference between mixer legs` | #634-2 (b) OOP stage の +1 block・**#588 全項を統合** | `output.rs` `engine_wrap.rs`（+250）| PR-K-C1 | 直行 leg と send leg の合算 RMS | — |
| PR-K-D0 ⟂ | `docs(spec): define how layer racks are matched on re-evaluation` | #635 | `SIGNAL_CHAIN_DSL_SPEC_v1.md`（+20）| — | docs | — |
| PR-K-D1 🔴 | `feat(dsl): run layer() branches in parallel` | **#635 全項** | `rack.ts` `effect-slot.ts` `rack_wire.rs` rack-child `session.rs` `daemon-client.ts`（+700）| PR-K-C1・PR-K-D0 | T4・cfg 4 象限 | wire（`StageSpec::Layer`・`chain_path` ネスト）|
| PR-K-G0 ⟂ | `docs(spec): state that standard plugins never appear in the catalog` | #669 段階 2 | `SIGNAL_CHAIN_DSL_SPEC_v1.md`（+15）| — | docs | — |
| PR-K-G1 🔴 | `refactor(dsl): drop compressor/limiter/normalizer from the vocabulary` | #669 段階 1（実使用は `test-all-features.orbs` の 6 行のみ・core spec `:1873-1876` の記載も削除）| `runtime.ts` `global.ts` `effects-manager.ts` `rust-engine-player.ts` `dsl-e2e-coverage.spec.ts` core spec（−250）| — | T5 | DSL 表面（削除）|
| PR-K-G2 | `feat(engine): add the standard compressor/limiter/normalizer plugins` | #669 段階 2 機構。🔴 **owner 2026-09-03: 実装形式は in-process WASM（unworklet）のスパイク結果を見てから**（使えるなら標準プラグインは全部 WASM）。Patina は汎用 VST/CLAP として別導入 | 形式確定後に見積もる | PR-K-G1・**PR-P8（スパイク）** | T6 + contract テスト | — |
| PR-K-G3 🔴 | `feat(dsl): expose the standard dynamics plugins` | #669 段階 2 表面 = `effect([Compressor(...)])`（好きな位置に挿せる・owner 2026-09-03）| `rack.ts`（+40）| PR-K-G2 | 表面に応じた E2E | DSL 表面 |
| PR-K-I1 | `feat(dsl): instrument racks driven by one pattern` | **#636 全項**（1 ブランチ = 1 insert bus・doc 634 §15 (3)）| `rack.ts` `plugin-instrument-manager.ts` `sequence.ts` `plugin-note-output.ts`（+500）| PR-K-A2・PR-K-D1 | T7/T8・cfg 4 象限 | — |

🔴 doc 428 との接点: `PluginAllNotesOff`（PR-K-A2・**鳴っている**ノートを落とす）と `CancelScheduledEvents`（PR-Q-F・**まだ渡していない未来**を取り消す）は別の仕事。PR-Q-E/F が先に入ると RUN 終端の flush は「未来の取り消し + 鳴っているノートの all-notes-off」の 2 段になる。両方とも #606 のチェック項目に紐づける。
🔴 CLAUDE.md マージ前ゲート（無条件）: `npm run build` → `bundle-macos.sh` → `cargo test -p orbit-effect-rack-child --lib -- --ignored`。PR-K-G2 以降は新 3 crate の `bundle-macos.sh` も同じ行に足す。

### 1.6 時刻付きイベント queue — PR-Q（doc 428 §9）

| PR | 件名 | 対象 | 触るファイル（概算行） | 依存 | 検証 | 一方通行 |
|---|---|---|---|---|---|---|
| PR-Q-A ⟂ | `docs(protocol): specify ScheduleEvents / CancelScheduledEvents` | #428 wire の形（汎用 `ScheduleEvents[]` + `CancelScheduledEvents`・`PluginNoteAt` 案は棄却）| `ENGINE_DAEMON_PROTOCOL.md`（+80）・core spec PH.6（+10）| — | docs | **wire** |
| PR-Q-B ⟂ | `fix(engine): mirror the scheduler transport cursor for block sources` | 🔴 `PlayAt` の時計と `BlockTransport.cursor_frames` が try_lock 競合で乖離する（doc 428 §3.3・記録の無かった危険）| `engine.rs`（+25）・`scheduler.rs`（+15）・`output.rs`（+5）| PR-Q-A | unit（競合時に進まない・ミラー一致）| — |
| PR-Q-C ⟂ | `feat(sandbox): add a fixed-capacity timed event queue` | #428 RT queue（`EventBackingRing` の前段・別物）| `orbit-audio-sandbox/src/timed_event_queue.rs`（新 +220）| — | unit（`drain_due` offset・drop-newest・sticky flush）| — |
| PR-Q-D 🔴 | `feat(engine): schedule instrument events at a transport time` | #428 daemon 側 | `session.rs`（+120）・`engine_wrap.rs`（+90）・`outproc_instrument.rs`（+60）| Q-A/B/C | unit + 実機 `get_log` ERROR なし | wire |
| PR-Q-E | `feat(engine): send notes with their intended transport time` | #428 TS 側（5ms poll = キャンセル可能な発火ゲート・anchor 写像は `RustEnginePlayer` に 1 本化・`onTime − leadMs` 前倒し）| `midi-scheduler.ts` `plugin-note-output.ts` `rust-engine-player.ts` `daemon-client.ts` ほか（+160）| PR-Q-D | **E2E-T1**（red-first）・E2E-T3 | — |
| PR-Q-F 🔴 | `feat(engine): cancel scheduled instrument events` | 🔴 チェックリストに**無いが必須**（lookahead を作った瞬間に取り消し手段が要る: mute / LOOP 外し / #606 RUN 終端）| `session.rs`（+50）・`engine_wrap.rs`（+40）・`plugin-note-output.ts`（+15）| PR-Q-D（**E と同時にマージ**）| E2E-T3 | wire |
| PR-Q-G | `feat(dsl): drive plugin parameters from a sequence` | **#680 本体**（VST3 instrument は param 0 個・effect ラックは v1 ブロック粒度据え置き）| `rack.ts` `sequence.ts` VST3 host・instrument child・catalog | Q-E/F・**#680 表面の裁定**（doc 428 §11 (1)・推奨 B）| **E2E-T2**（小節頭の窓 RMS 落下位置）| DSL |

🔴 doc 634 との接点: #606（RUN 終端の note-off flush）は PR-Q-F の `CancelScheduledEvents` を使う経路が自然（doc 634 側の記述と突き合わせる）。#674 種 B は doc 672 §7.3 `timedEvents.subscribe` の consumer。#460 は本 queue の消費者（層①の breakpoint 列）。

### 1.7 診断の整合 — PR-D（doc 610 §13）

| PR | 件名 | 対象 | 触るファイル（概算行） | 依存 | 検証 | 一方通行 |
|---|---|---|---|---|---|---|
| PR-D0 ⟂ | `fix(engine): contain the two playback-path throws and log the skip` | **#645 must-fix**（`resolveDispatchChannel` を `DispatchTarget = hardware \| link \| skip` の tagged union に・throw を無音スキップ + `[ERROR]`）| `sequence.ts`（+60/−20）・`event-scheduler.ts`（+20/−8）・unit | なし | E2E-645-A/B（linkAudio 譜面 → `run_selection` → `get_log`）| 内部 API |
| PR-D1 ⟂ | `docs(spec): one applicability table for receivers and methods` | #644 表の仕様側・#280 の spec 1 本化・#255-1 の明記 | core spec・`PITCH_DSL_SPEC_v1.1.md` | — | docs | — |
| PR-D2 | `fix(diagnostics): run the engine parser behind the editor diagnostics` | **#610**（`ParseError` に span・文言不変・拡張が engine の `analyze-source` を require）| `parser/parse-error.ts`（新 20）・`parser-utils.ts`（+10）・`diagnostics/analyze-source.ts`（新 60）・`extension.ts`（+40）| PR-D1 | E2E-D1/D2 | 診断の増加 |
| PR-D3 | `feat(diagnostics): applicability table drives the editor warnings` | #644 全項・#665 (A)（`diagnostics/applicability.ts` 受け手 9 種 × メソッド・4 値・`render-node`/`master-line` 行を先置き）| `parser/types.ts` + `parse-statement.ts` 4 箇所（span）・`applicability.ts`（新 200）・`analyze-source.ts`（+90）・`signal-chain-dispatch.spec.ts`（+120）| PR-D2 | E2E-D3/D4/D5・全数照合テスト | 診断の増加 |
| PR-D4 | `fix(interpreter): loud diagnostics for name collisions and aux output` | #583 | `global.ts` `mixer-manager.ts` `sequence.ts`（+37）・`analyze-source.ts`（+20）| PR-D3・doc 610 §15 (5) | E2E-D6 | 挙動変更 |
| PR-D5 | `feat(dsl): distribute stack-level @v to voices; empty pattern binding guidance` | #255-2・**#609（owner 2026-09-03: 足す）**| `parse-expression.ts`（+50）・`analyze-source.ts`（+15）・`PITCH_DSL_SPEC` §2.5 | PR-D3 | E2E: `[1,5,9]@v+10` と per-voice 展開の capture RMS 一致 | DSL（加算）|
| PR-D7 | `feat(dsl): accept note names in seq.root()` | **#280（owner 2026-09-03: 実装を spec に）** | `sequence.ts:906-920`（+20）・core spec `:953-955` | PR-D1 | E2E: `seq.root(C)` / `seq.root(b6)` で `estimateFundamentalHz` が期待値 | DSL（加算）|
| PR-D6 | `fix(engine): attribute diagnostics to the submission that caused them` | #620（先に E2E-620-A で再現）| `repl-mode.ts` `extension.ts` | **PR-L2（フレーム）** | E2E-620-A | — |

🔴 doc 611 との接点: `seq.gain`/`pan` が midi・instrument で効かない事実は表で `warn`（doc 610 §15 (3) 推奨 A）。PR-O4 で `LineOp::Gain` が入ったら表の行を `ok` に更新する（PR-O4 のチェック項目に含める）。

### 1.8 可視化・設定・性能 — PR-V（doc 662 §15・番号は同文書の PR-1〜12 に対応）

| PR | 件名 | 対象 | 触るファイル（概算行） | 依存 | 検証 | 一方通行 |
|---|---|---|---|---|---|---|
| PR-V1 ⟂ | `chore(env): read env vars through one aliasing resolver` | #156 の機構（改名は含まない）| Rust 1 ヘルパ + TS 1 ヘルパ + 読み出し 32 箇所（+150/−80）| — | 迂回すると red になる grep テスト | — |
| PR-V2 | `chore(env): unify the env prefix` | #156 の改名 | alias 渡し（±40）| PR-V1・**doc 662 §17 (3) の裁定**（推奨 C = 境界規則 + 例外 3 個だけ改名）| 旧名 / 新名の両方で起動する unit | 🔴 W-13 |
| PR-V3 ⟂ | `feat(daemon): report the real stream config and callback liveness in GetStatus` | バッチ A 土台（`StreamStats.callbacks`/`last_frames`・`device_name`・config snapshot・停止検知）| `output.rs` `engine_wrap.rs` `session.rs`（+400/−60）| PR-V1（裁定前なら先に着手可）| cargo + 実機 `get_log` | 加算のみ |
| PR-V4 | `fix(daemon): make --audio-device produce a live stream` | **#661 must-fix**（原因は C1/C2/C3 の 3 候補・それぞれ潰す実験・切替は pause→play→確認→ロールバック）| `main.rs`（typed 引数）・`output.rs`・`engine_wrap.rs`（+250/−80）| PR-V3 | **E-1/E-2/E-9**（起動時指定なら capture RMS > 0・走行中切替は `callback.count` の前進）| — |
| PR-V5 | `fix(mcp): list audio devices through the daemon on the rust path` | #660 + `get_engine_state` 拡張 + child 一覧 | `extension.ts` `mcp-server.ts` `repl-mode.ts` `rust-engine-player.ts`・新 `engine-status-bridge.ts`（+350/−40）| PR-V3 | E-3/E-4/E-5 | — |
| PR-V6 | `feat(orbitstudio): show device, headroom, dropouts and children in the Engine view` | バッチ B 本体（closes #483・%CPU/RSS は拡張の `ps`・identity は `GetStatus.children`）| `engine-view.ts` `extension.ts`・user docs 日英（+450/−60）| PR-V5 | E-4（MCP で同値）| — |
| PR-V7 | `feat(orbitstudio): list engine settings with their scope` | 32 変数表（`ORBITSCORE_DSL` は env ではないので 33 → 32）| `engine-settings-table.ts`（新・単一の表）（+300）| PR-V6・**§17 (1) の裁定**（推奨 A 全部出す・テスト用 6 個は折りたたみ）| 表と `GetStatus.config` の不一致で red | — |
| PR-V8a ⟂ | `perf(spike): measure cross-process wake latency for the child audio loop` | #667 の計測だけ | `orbit-sandbox-spike`（+200）| — | 実測を doc 662 §9.4 へ | — |
| PR-V8b | `perf(child): replace the busy-wait with a hybrid park; raise audio thread to TIME_CONSTRAINT` | **#667**（共有ヘルパ 1 本・waiters フラグ + タイムアウト安全網・**QoS を TIME_CONSTRAINT へ**〔owner 2026-09-03〕。上げる前後で CPU / wake / daemon callback p99 を測る）| `transport.rs` + 5 child + `orbit-child-runtime`（+280/−50）| PR-V8a・PR-V3 | **E-6** + `ps` 実測 5 種 | — |
| PR-V9 | `docs(perf): record the measured thread and memory breakdown` | 地図 §7 (12) の答え（`ps -M`）| doc 662 §10 追記 | PR-V6・PR-V8b | 出力を貼る | — |
| PR-V10 | `feat(orbitstudio): wire MIDI panic and live device selection` | バッチ C（closes #484 のデバイス部分・`panic()` は実装済み・配線のみ）| `extension.ts` `mcp-server.ts`（+200）| PR-V5 | E-8/E-9 | — |
| PR-V11 | `feat(engine): grow the slot pools off-thread` | **#663**（バッチ D・さらに分割）| `output.rs` `outproc_instrument.rs`（+600/−200）| PR-V6・PR-V8b | E-7 + #663 受け入れ 5 項目 | 🔴 設定項目の消滅 |
| PR-V12 | `feat(orbitstudio): rework the Engine view as a WebviewView` | バッチ E（closes #503）| 新 webview（+500/−300）| V7・V10・V11 | 既存 E2E 全件 | — |

**最短経路（must-fix）**: PR-V3 → PR-V4。#156 の裁定を待たずに V3 は着手できる。

### 1.9 配布 — PR-S（doc 656 §14・番号は同文書の PR-T/R/C に対応）

| PR | 件名 | 対象 | 触るファイル（概算行） | 依存 | 検証 | 一方通行 |
|---|---|---|---|---|---|---|
| PR-S-T1 ⟂ | `fix(studio): declare untrusted-workspace capability and refuse loudly` | **#385 must-fix** | `package.json`（+12）・`extension.ts`（+25）・gated spec（+60）| なし | E2E-D1/D2・実機: 新しいフォルダを初めて開いて評価 | `supported` の値（裁定 (1)）|
| PR-S-T2 | `feat(studio): default workspace trust off in the OrbitStudio build` | #385 層 2 | `product.overrides.json`（新 +8）・`build_orbitstudio.sh`（+3）| PR-S-T1 | 実機: 焼き直して loose-file 起動 | product.json キー |
| PR-S-R1 ⟂ | `refactor(release): extract the vsix content gate into a shared script` | #659 ③（`verify-vsix.sh`・`release.yml:116-207` のインライン shell を共有化）| 新 +90・`release.yml` −75+2 | なし | CI の PR smoke 緑 | — |
| PR-S-R2 | `ci(release): run the smoke lane for rust and scripts changes` | `release.yml` の `paths` に `rust/**` `scripts/**` | `release.yml`（+2）| PR-S-R1 | 自分で発火する | — |
| PR-S-R3 | `feat(build): script the local release end to end` | **#659**（🔴 `make-local-release.sh` は repo に存在しない — 新規に書く・12 段・成果物・preflight）| 新 +260・`README.md` +30 | PR-S-R1 | 手元で 1 回通す + 成果物に E2E-D3 | 🔴 成果物の名前・退避先 |
| PR-S-R4 | `feat(release): sign and notarize OrbitStudio.app` | **#656** 署名・公証（entitlements は実測後・`disable-library-validation` の記述は repo に無い）| `make-local-release.sh` +90・plist・`CODESIGN_PIPELINE.md` | PR-S-R3 | E2E-D4（署名済み `.app` で 3rd-party が鳴る）・停止条件あり | 🔴 W-14 |
| PR-S-R5 | `ci(release): publish the signed app on tag push` | #656 CI（app ジョブを足す）| `release.yml`（+45）| PR-S-R4・裁定 (3) | tag で 1 回通す | 配布物名 |
| PR-S-C1 | `test(e2e): run the gated suite against the release artifact` | **#138**（`ORBIT_GATED_EXT_MODE=installed`・既存アサーションをそのまま成果物へ）| gated spec（+80）| PR-S-R3 | E2E-D3（PATH を絞って落ちるか）| — |
| PR-S-C2 | `feat(studio): bundle node with the app and spawn the engine with it` | #138 の新規基準（owner 2026-09-03: **node を同梱**。PATH の node にはフォールバック + 警告）| `extension.ts`（+40）・`make-local-release.sh`（同梱 + 署名対象 +1）| PR-S-R3 | E2E-D3（PATH を絞っても起動する）| W-22 |

**先に着手できる**: PR-S-T1 / R1 / R2（裁定待ち 0）。

### 1.10 E2E 基盤 — PR-E（doc 668 §20）

| PR | 件名 | 対象 | 触るファイル（概算行） | 依存 | 検証 | 一方通行 |
|---|---|---|---|---|---|---|
| PR-E0 ⟂ | `docs(testing): E2E harness spec — ledger placement, observation kinds, mutation off the critical path` | doc 668 §19 | `docs/testing/E2E_HARNESS_SPEC.md`（+80/−20）| — | docs | — |
| PR-E1 ⟂ | `test(e2e): one source list for the gated suite` | 🔴 ラチェット / 衛生検査が gated spec のパスを**決め打ち**（`dsl-e2e-coverage.spec.ts:39` / `gated-assertion-hygiene.spec.ts:18`）→ 分割前に `GATED_SOURCE_FILES` へ | `tests/e2e/gated-sources.ts`（新 +60）・既存 3 本（±40）| — | `npm test` 緑のまま | — |
| PR-E2 | `test(e2e): shared harness helpers (session, runScore, log, file, cli)` | 共通 helper 5 モジュール（`GatedSession` / `ScoreSource` / `CaptureWindows` / `ScoreRunContext`・`countErrors` 7 重定義の統合・CLI 子プロセス helper）。**既存 20 本は書き換えない** | `tests/e2e/helpers/*.ts`（新 +400）・gated spec（−60）| PR-E1 | 実機 gated 全通し | — |
| PR-E3 🔴 | `feat(mcp): per-channel WAV analysis` | 🔴 `analyzeWavBuffer` は全 ch を加算平均して mono に潰す（`wav-analysis.ts:127-132`）→ **doc 611 E2E-4/5・doc 598 E2E-R2/R5/R9・#650 `pan` は現状では原理的に書けない**。`analyze_audio(per_channel: true)` + helper | engine/extension（+120）| PR-E2 | 実機: mono 値との突き合わせ | MCP 表面（追加）|
| PR-E4 | `test: syntax surface source of truth + coverage ratchet` | #668-A（`dsl-surface.ts`・`KEYWORDS` export・A-1〜A-5）| engine（+80）・tests（+200）| PR-E1 | `npm test`（baseline を現状で記録して緑で入る）| — |
| PR-E5 | `test(docs): reference coverage for ja and en` | #668-C（🔴 未記載は ja 8 語 / **en 12 語**・en の検査が無い）| `tests/docs/reference-coverage.spec.ts`（+180）| PR-E4 | `npm test` | — |
| PR-E6 | `test(e2e): import runs from the editor path` | #630 I-1〜I-4 | fixtures 2 本 + gated（+150）| PR-E2 | 実機 gated + `get_log` | — |
| PR-E7 | `test(e2e): mute, unmute, loop, pan on real hardware` | #668-B（baseline を 5 語減らす。残りの語は同型で束ごと 1 PR）| gated（+200）| PR-E3・PR-E4 | 実機 gated（capture の数値）| — |
| PR-E8 | `test(e2e): assert at most one daemon at every phase boundary` | #624（孤児 daemon の二重出力は capture に写らない）| `helpers/daemon-census.ts`（+80）・gated（+30）| PR-E2 | 実機 gated | — |
| PR-E9 ⟂ | `test: report load average when a child deadline expires` | #640-A | `host_child_integration.rs`（+30）| — | 負荷下で cargo test | — |
| PR-E10 ⟂ | `fix(daemon): log the startup stages and surface DaemonStartupError.stderr` | #640-B（🔴 `DaemonStartupError.stderr`/`.exitCode` を読む箇所が 0・ready 前 3 段にログ無し）| `main.rs`（+25）・`daemon-client.ts`（+20）| — | 実機で engine 再起動 → `get_log` に段マーカー | — |
| PR-E11 ⟂ | `test: skip DAC-dependent cases when running as root` | #684（root で必ず落ちる 3 件）| `tests/helpers/privileges.ts`（+25）・2 spec | — | root / 非 root で `npm test` | — |
| PR-E12 | `test: dual ledger — spec sections must be classified` | #543-(b) 台帳 1（仕様 ↔ テスト・#671 と独立に先に入れられる）| `tests/e2e/dsl-coverage-ledger.ts`（+250）| PR-E4 | `npm test` | — |

🔴 **段 0 の実体は PR-E1 → E2 → E3 → E4（+ PR-O0 golden）**。PR-E3（per-channel）が無いと doc 611 / 598 のチャンネル判定 E2E は緑のまま嘘をつく。

---

## 2. 順序の根拠

### 2.1 wire を先に、DSL を後に（両側を同じ PR で・消費者の切替は次の PR で）

- wire を変える PR（PR-O3・PR-R2・PR-R6・PR-Q・PR-P5）は **Rust 側 + `protocol-types.ts` / `daemon-client.ts` + fixture** を同じ PR に入れ、**旧 wire を併存**させる（`SetBusRouting` は PR-O6 まで残る）。TS の消費者（DSL）は次の PR で切り替える。理由: 同梱配布なので互換期間は要らないが、**1 PR で wire と DSL の両方を変えると golden の差分がどちら由来か分からない**。
- `RenderScore` v2（PR-R6）は消費者が 0 なので併存させない（W-10）。

### 2.2 互換の順序 — golden → 意味論の変更 → 退役

1. **PR-O0（golden）を最初に**: 裁定 ①②③ はすべて「評価は成功するのに音が変わる」形（地図 §4.G.1）。固定してから触る。
2. **PR-O4 で `send` を dB に**: 既存譜面の `send(verb, 0.5)` は意味が変わる（W-3）。**同じ PR で MX.3 を改訂し、golden の差分が「dB 化の期待どおり」だけであることを式で示す**。
3. **数値 `output(n)` の退役（W-4）は `mix.render` と同じ PR**（PR-R1）: ユーザーの移行が 1 回で済む。裁定待ちなら PR-R1 を止め、PR-R2/R4/R6（wire・Clock・offline）は進む。

### 2.3 二度手間の罠（避ける順序）

| 罠 | 避け方 |
|---|---|
| `send` が線形のまま新しい譜面（golden・E2E）を書く | PR-O0 の golden は**式**で持つ（`rack-chain-gain-expectations.ts` 方式）。dB 化後は式を差し替えるだけ |
| 数値 `output(n)` に E2E を足す | 足さない（退役予定）。render の E2E は `mix.render` で書く |
| Link テンポリーダーを engine 内に実装する（#321 PR3） | 裁定 7。PR-P7 まで待つ |
| 実時間 stem をライン模型の前に作る | PR-R2/R3 は PR-O3/O4 の後。stem の pre/post はライン模型が無いと表現できない |
| `.orbslog` のディレクトリ名を決めずに v2 を出す | 定数 1 箇所（W-7）。**0 本**なので後から変えても移行は無い |
| フレーム（PR-L2）を doc 611 と doc 694 で二重に作る | 1 本（PR-L2）。PR-O4 はそれに依存 |
| 語彙 Set の導出（PR-P1）を #668 の E2E 無しでやる | 裁定 6。PR-E が先 |
| `//#sourceFile` 無しで replay を試す | PR-L1 → L2 → L4 の順（B の実測は L4 で初めて可能）|
| offline driver を `.orbs` 専用に作ってから `.orbslog` 対応を足す | PR-R5 は最初から評価列（doc 598 §6.3）|
| 設定変数を一覧化してから prefix を改名する | #156 を PR-V の最初に（W-13）|

### 2.4 並行可能なもの（⟂・順序を持たない）

- **最初の週に同時に出せる**: PR-O0 / PR-O1 / PR-L0 / PR-R0 / PR-R4 / PR-P8 / PR-E（基盤）/ PR-V の #156 / docs 系
- **wire と DSL は独立**: PR-R2（wire）と PR-R1（DSL）/ PR-P5 と PR-P4
- **doc 間で独立**: PR-L*（ログ）は PR-O*（出口）と独立（交点は PR-L2 → PR-O4 のみ）。PR-V（可視化）は他と独立（交点は #661 → 入力、#663 → render pool）。PR-K（PDC）は PR-Q と独立、PR-R8 が両方を待つ

---

### 2.5 束の割り当て（束ブランチ運用・owner 合意 2026-09-03・#703）

レビューの単位は PR ではなく**束**。小 PR は束の統合ブランチへ軽いゲート（CI + その PR が足した E2E を実機で + 目視）で入れ、統合ブランチ → main の束 PR で `/simplify` → `/code:pr-review-team` + Fable → 実機 E2E 全件を 1 回だけ回す。手引きは [`BUNDLE_BRANCH_WORKFLOW.md`](../development/BUNDLE_BRANCH_WORKFLOW.md)。束は差分 1,500 行以下で継ぎ目（wire / DSL・記録 / 再生・実時間 / オフライン）で切る。

| 束 | 統合ブランチ | 中身 | 概算 |
|---|---|---|---|
| O-wire | `611-line-wire` | PR-O3 | 約 800 行（1 本なので実質単独レビュー）|
| O-dsl | `611-output-line` | PR-O4・O5・O6 | 約 1,300 行 |
| L-record | `694-session-log` | PR-L1a・L1b・L2・L3・L7・L8・L9 | 約 1,500 行 |
| L-replay | `241-replay` | PR-L4・L5・L6 | 約 900 行 |
| R-live | `598-render-live` | PR-R1・R2・R3 | 約 1,400 行 |
| R-offline | `598-render-offline` | PR-R4・R5・R6・R7 | 約 1,700 行（R4 は先に main へ入れてよい）|
| R-p3 | `598-render-p3` | PR-R8・R9 | 約 800 行 |

**main 直行**（束を通さず従来どおり単独でフルレビュー）: 仕様だけの PR-O1 / L0 / R0 / P0 / K-*0 / Q-A / D1 / E0、must-fix の PR-O2 / D0 / V4 / K-A1 / K-A2 / S-T1、束をまたぐ PR。PR-P / K / Q / D / V / S / E の束割りは着手時に同じ規則（1,500 行・継ぎ目）で決める。


## 3. 段（マイルストーン）

各段: **ユーザーに見える結果（1 文）** / **MCP 実機確認の手順** / **閉じるチェックリスト項目**。順序は地図 §3（リリースまでの筋）に、owner の順序（ログ → リプレイ → レンダ）を組み込んだもの。**日程は書かない。**

### 段 0 — 安全網（PR-E1 → E2 → E3 → E4・PR-O0・PR-L0・PR-O1・PR-R0・PR-P8）

- **結果**: 「既存の譜面が同じ音のまま」が capture の数値で固定され、以降のすべての変更が退行を機械で検出できる。
- **確認**: `npm run test:e2e:gated` → golden 4 譜面が緑。`get_log` に `[ERROR]` 増加なし（`<=`）。
- **閉じる**: #543 (a)(b 台帳 1) / #668 A・C / #650・#630・#624・#640・#684 の該当項目（doc 668 §20）。

### 段 1 — must-fix（PR-O2・PR-D の #645・PR-V の #661・PR-K の #606・PR-S の #385）

- **結果**: 演奏が壊れる 5 件（#649 フェーダー / #645 演奏中 throw / #661 無音 / #606 note-off / #385 trust）が直り、**`global.gain(-6)` が instrument に効く**。
- **確認**: `start_engine({capture_wav})` → instrument 譜面 → `evaluate_orbitscore('global.gain(-6)')` → 窓 RMS が半減（E2E-1）。`select_audio_device` 後に音が出る（doc 662 の手順）。RUN 終端で音が止まる（doc 634）。
- **閉じる**: #649 全項目 / #645 / #661 / #606 / #385。

### 段 2 — 出口の一般化（PR-O3〜O6）

- **結果**: `kick.output(verb, thru: true, db: -12).output(master)` が書け、master も aux も物理アウトも同じ軸。`send` は dB。`outs:` でマルチアウト。
- **確認**: E2E-2〜10 の手順を `evaluate_orbitscore` で再現し capture の RMS 比を見る。daemon respawn 後に routing が復元（E2E-10）。
- **閉じる**: #611 / #409 / #647 / #649 残り / #543 (a) の差分ゼロ確認。

### 段 3 — ログ → リプレイ（PR-L1a/L1b/L2/L3/L7/L8/L9 → L4/L5/L6）

- **結果**: OrbitStudio で演奏すると `<DIR>/<basename>.<stamp>.orbslog` が出て、`orbitscore replay <log>` が**同じ音**を鳴らす（840 / 1260 型の演奏を後から再生できる）。
- **確認**: `open_file` → `run_selection`（`global.start()`）→ `ls <scoreDir>/<DIR>/` → `readOrbsLog` で meta/eval/transport → `stop_engine` → `orbitscore replay <log>` を capture 付きで → 窓 RMS がライブと一致（E2E-R1）。
- **閉じる**: #694 全項目（B 含む）/ #695 (1)(2) / #241 忠実リプレイ・`--until` v1。

### 段 4 — render（PR-R1〜R7・P2・R9）

- **結果**: `var stems = mix.render("stems/%n_%v.wav")` で**演奏しながら stem が書け**、`orbitscore replay <log> --render` / `render <orbs> --duration T` が実時間より速く同じファイル群を作る。
- **確認**: E2E-R1（実時間 stem）・R5（offline bit 一致・実時間比を記録）・R6（replay --render がライブ capture と一致）。
- **閉じる**: #598 P2 全項目 + エンドポイント宣言 / `%n` / 合算 / 相対 / `outs:` / #241 `--render` / 地図 §7 (7)(11)(8) のうち `%n`。

### 段 5 — 可視化・設定・性能（PR-V: #156 → A → B → #667 → #663）

- **結果**: エンジンが掴んでいるデバイス・レート・バッファ・callback 統計・設定の実効値が `get_engine_state` / Engine view に出る。child がアイドルで CPU を食わない。プール上限が off-thread で伸びる。
- **確認**: `get_engine_state` に device / sample_rate / buffer / callback 統計 / children が実在（E-4）。`ps` で 5 child のアイドル CPU（E-6）。`select_audio_device` 後に capture RMS > 0（E-2）。
- **閉じる**: #662 バッチ A〜D の項目 / #661 / #660 / #667 / #663 / #483 / #484（デバイス部分）/ #503 / #156（裁定後）。

### 段 6 — リリースゲート連鎖（PR-Q → PR-K: #634 → #635 → #636 → #669）

- **結果**: 並列ラック（PDC 補償済み）・レイヤー・instrument ラック・標準プラグイン（compressor 等）が使える。
- **確認**: E2E-T1（note の到着が transport 時刻）・E2E-T2（小節頭の param 変化が窓 RMS に出る）・doc 634 の E2E（PDC: 並列 2 枝の逆相で無音 / RUN 終端で音が止まる）。
- **閉じる**: #428 / #680 / #606 / #634 / #635 / #636 / #669（表面の裁定後）/ #460（前提の確認）。

### 段 7 — プラグイン境界（PR-P0〜P7）→ render P3（PR-R8）

- **結果**: 語彙の登録から reference と E2E カバレッジが導出される。OSC（種 B）が送れる。Link テンポが engine の外に出る。オフラインレンダにプラグインと instrument が乗る（**#598 完了**）。
- **確認**: E2E-P1〜P6・E2E-R8。
- **閉じる**: #672 / #671 段階 1-4 / #674 / #321 PR3 / #598 P3 / #497 の受け皿。

### 段 8 — 配布（PR-S: #659 → #656 → #138）

- **結果**: 署名・公証済み OrbitStudio.app と `.vsix` が GitHub Releases に置かれ、新規環境で起動して音が出る。
- **確認**: E2E-D1/D2（trust）・E2E-D3（成果物に対する gated suite・PATH を絞って node pre-check が落ちる）・E2E-D4（署名済み `.app` で 3rd-party が鳴る）。
- **閉じる**: #659 / #656 / #138 / #498。

### 着手しない（裁定）

#679（入力）/ #413（受け口の裁定待ち）/ #197・#184（Marketplace 未決）/ ICLC・WCTM 本体。

---

## 4. 裁定待ちが止める PR（一覧）— 2026-09-03 owner 回答後

| 裁定 | 状態 | 止まる PR |
|---|---|---|
| W-4 数値 `output(n)` の退役 | ✅ A 撤回 | なし |
| W-7 `<DIR>/` の名前 | ✅ `orbslog/` | なし |
| プレースホルダ語彙 | ✅ `%n` `%v` `%d` | なし |
| CLI の既定 on | ✅ opt-in のまま | なし |
| A4 実行形態 | ✅ 混在 | なし（段階 5 は「段階的に公開」）|
| transport write 競合 | ✅ 単一 leader | なし |
| #674 表面 | ✅ メッセージ値を `play()` に | なし |
| #669 表面 / 中身 | ✅ `effect([...])` に統一・**実装は WASM スパイク後** | **PR-K-G2 / G3 は PR-P8 の後** |
| #138 吸収先 | ✅ 独立のまま（リリース系は段 8 = 別ライン）| なし |
| 32 変数の線 / #156 の方向 | ✅ 全部出す / 境界規則 + 例外 3 個 | なし |
| #680 表面 / `PluginNoteOn/Off` | ✅ B / 残す | なし |
| `untrustedWorkspaces.supported` | ✅ `true`（DAW の挙動に合わせる）| なし |
| bundle id・バージョン付け | ✅ VSCodium 既定 / 拡張の `version` | なし |
| `--until` 境界ちょうど（doc 694 §13 (3)）| ✅ A 適用済み（owner 2026-09-03 夕）| なし |
| #583 (i) 同名衝突（doc 610 §15 (5)）| ✅ 赤線 + その文だけスキップ | なし |
| 3ch 以上を 1 ファイル（doc 598 §16 (2)）| ✅ B-lite（N ch の器 + `at:` 配置・エンコードは Logic）→ PR-R9 | なし |
| #694 dormant の根拠（doc 694 §13 (7)）| ✅ 実測で確定（ログが出ていても再現に使えない形・§2b）| なし |
| LOOP quantize を `TransportTimeline` に乗せるか（doc 694 §13 (8)）| ✅ A 乗せる（owner 2026-09-03 夕）| なし |
| プラグイン状態の写し方（doc 694 §13 (9)）| ✅ A ファイルを写す（owner 2026-09-03 夕）| なし |

**裁定待ちは 0 件**（2026-09-03 夕・66 問すべて回答済み）。以後の未決は新しい issue / 設計文書の §13 相当に足す。

---

## 5. 更新履歴

| 日付 | 内容 |
|---|---|
| 2026-09-03 | 初版（設計文書 11 本の PR を統合・一方通行 17 件・段 0〜8）|
| 2026-09-03 | §2.5 束の割り当て（束ブランチ運用・#703）を追加 |
| 2026-09-03 | 残り 3 問（Q-694-3/8/9）が **A** で確定 → W-23/24 ✅・PR-L8/L9 の 🔴 を外す・§4「裁定待ち 0 件」|
| 2026-09-03 | Q-694-7 の実測（doc 694 §2b: 今日のログは再現に使えない）→ PR-L7/L8/L9 追加・PR-L4/R5/R8 の依存を更新・W-23/24/25。Q-598-2 → B-lite（PR-R9）。Q-610-5 / Q-656-1 / Q-656-2 確定。§4 を「相談中 4 件」に更新 |
| 2026-09-03 | owner 回答（裁定シート 66 問中 50 問）を反映: W-4/5/7/12/13/14/15/17 確定・W-18〜22 追加・PR-O4 に `pan` と 2 要素 / PR-L5 を高速畳み込みへ・PR-L6 / PR-D7 追加・PR-K-G2 を WASM スパイク後へ・PR-P6 をメッセージ値へ・PR-V8b に QoS・PR-S-C2 を node 同梱へ。§4 を「相談中 6 件」に更新 |
