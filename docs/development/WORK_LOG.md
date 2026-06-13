# OrbitScore Development Work Log

## Project Overview

A design and implementation project for a new music DSL (Domain Specific Language) independent of LilyPond. Supports TidalCycles-style selective execution and polyrhythm/polymeter expression.

## Development Environment

- **OS**: macOS (darwin 24.6.0)
- **Language**: TypeScript
- **Testing Framework**: vitest
- **Project Structure**: monorepo (packages/engine, packages/vscode-extension)
- **Version Control**: Git
- **Code Quality**: ESLint + Prettier with pre-commit hooks

---

## Recent Work

### 6.106 Issue #230 — Phase 2: `.root()`/`.mode()`/`.oct()` グループスコープ — パーサー層 (Jun 13, 2026)

**Date**: 2026-06-13
**Status**: 🚧 IN PROGRESS (パーサー層完了。dispatch のスコープ解決は後続コミット)
**Issue**: signalcompose/orbitscore#230
**Branch**: `230-phase-2-root-group-chains`

**設計**: code-architect で blueprint を策定（PlayScoped 新ノード、スコープは calculateEventTiming のツリー walk で捕捉しフラット dispatch では per-event descriptor で消費、共有 run ヘルパで no-chain 並置の splice を保全、build sequence B0-B8）。spec §2.3/§3 正本。

**本コミット（パーサー層 B1-B4 のパーサー部分）**:
- `parser/types.ts`: `PlayScoped`/`ScopeRoot`/`ScopeMode` を追加、PlayElement union に。スコープチェーンが有る時だけ生成（no-chain 並置は従来通り別 sibling）
- `parser/parse-expression.ts`: `parseScopeChain`（root/mode/oct、重複・root+mode 衝突を diagnostic エラー、last-wins 不採用）、`parseRootArg`（音名 F#/Bb/C をトークンから再構成 + 度数 3/b6、`noteNameToPitchClass` 再利用）、`parseModeArg`（mode 予約＝raw 捕捉、dispatch で throw 予定）、`assertChainClosesRun`（チェーン直後カンマなし `(` = エラー §3）、`collapseScopedRun`（並置 run を1スコープに集約）
- `parser/parse-statement.ts`: `parseArguments` に run 集約（`(A)(B).root(X)` を1ノードに、カンマが run 境界）

**テスト**: `tests/audio-parser/scope-chain-parsing.spec.ts` 20件（音名/度数 root、oct、mode 予約、重複/衝突/chain-closes エラー、並置 run 集約、§3 入れ子 override 例、no-chain 並置の回帰ガード）。全体 848 passed / 23 skipped。

**追加コミット (B5-B6: dispatch スコープ解決)**:
- `timing/calculation/types.ts`: `TimedEvent.scope`（TimedEventScope: root/mode/groupOct）追加
- `timing/calculation/calculate-event-timing.ts`: scope スタックをツリー walk でスレッド、PlayScoped は timing 透過（並置と同じスロット）+ frame push、各リーフに inner→outer 解決した scope を付与
- `core/sequence.ts`: `resolveScopeToContext(scope, getSeqDefault)` を追加し scheduleMidiEvents / validateMidiDispatch で per-event 解決。音名 root は key 不要・度数 root は key 必須（未宣言はエラー）・mode は throw。seq 既定は遅延算出（音名 root のみのシーケンスが key を要求されないように）
- テスト: `scope-timing.spec.ts` 4件（timing 透過 + inner→outer + groupOct）、`sequence-scope-dispatch.spec.ts` 8件（音名/度数 root、並置共有、入れ子 override、key 有無、mode 拒否）。全体 860 passed。

**追加コミット (B7: `.oct()`×`^N` 合成)**: 大和確認で **additive** に決定。`effectiveOctave = runningRange + groupOct`（§9.3 直交＝足し合わせ）。`^N` は `.oct()` グループを抜けても持続（§9.4 linear）、groupOct は running range にフィードバックしない。テスト3件追加（加算合成 / oct 単独 / `^N` 持続）。全体 863 passed。

**B8 core spec 反映**: Phase 1 の前例に倣い、core spec (`INSTRUCTION_ORBITSCORE_DSL.md`) は line 12 の「v1.1 は specs-v2 が正本」ポインタで反映済みとする（§2.3/§3 を core spec に複製すると specs-v2 と二重保守＝乖離リスク。operating rule #7 の眼目「乖離を作らない」はポインタで満たす）。v1.1 安定後にまとめて fold-in する方針。

**VS Code エディタ支援**（Sonnet subagent、§5「拡張側に閉じる」、main がレビュー）:
- `syntaxes/orbitscore-audio.tmLanguage.json`: `.root()`/`.mode()`/`.oct()` チェーンの TextMate ハイライト（begin/end で引数内の `F#` を保護）+ 音名/度数/整数の引数ハイライト
- `src/extension.ts`: root/mode/oct の hover + play() 引数内 `).` 文脈での補完（paren balance ガードで `play(...).` の誤発火を回避）
- **main レビューで修正**: (1) grammar の legacy `#.*$` コメント規則を**削除**（OrbitScore のコメントは `//`、`#` は ACCIDENTAL。この規則が `#5`/`F#`/`##1` を全域でコメント誤認していた＝Phase 1 シャープ表示のバグ。agent の begin/end 回避の根本原因を除去）。(2) hover 例の `(1 2 3)` → `(1, 2, 3)`（OrbitScore はカンマ区切り）
- **span レベルのセマンティックハイライト（並置 run の可視化）は見送り**: `PlayScoped` ノードにソース位置(offset)が無く、実装には engine パーサー拡張（PlayScoped に startOffset/endOffset）+ `DocumentSemanticTokensProvider` + package.json の semanticTokenTypes が必要。「`.root()`+カンマ両忘れ→静かな併合」緩和の本命だが engine 変更を伴うため follow-up（chain-closes/重複のパースエラーで多くは既に検出される）。

**Phase 2 完了**: パーサー + timing + dispatch + エディタ支援。テスト 863 passed / 23 skipped。core spec はポインタ規約で反映。

**Phase 2 PR**: #247 作成済み。

**/simplify パス (2026-06-13)**: 4観点で Phase 2 production code (787行) をレビュー。適用4件: (A) 共有 `collapseScopedRun` で parser の run-collapse 重複を統合（pre/post-push の drift 解消、3 agent が指摘）、(B) 共有 `degreeRootToPitchClass` で度数解決カーネル統合、(D) `resolveScope` 空スタック早期 return、(E) `.mode()` エラーが `ScopeMode.raw` を使用（dead field 解消）。スキップ: 条件スプレッド・timing/dispatch 分離（正しい層）、microopt、diff 外の paren ループ。863 passed 維持。

**次**: `/code:pr-review-team` で #247 をレビュー（critical/important=0 まで）→ マージ判断。follow-up: span レベルハイライト（PlayScoped offset 要）、Phase 3 (#231 `[ ]` スタック + chord 値)。

---

### 6.105 Issue #228 — Phase 1: 度数記法の再設計 (pitch range / スティッキー `^N`) (Jun 13, 2026)

**Date**: 2026-06-13
**Status**: 🚧 IN PROGRESS (PR #245 に同梱)
**Issue**: signalcompose/orbitscore#228
**Branch**: `228-phase-1-midi-output`

**動機**: Phase 1 実機検証 (6.103) で2オクターブスケールを度数 `1..15` で鳴らしたところ、大和さんが「度数仕様が想定と違う」と指摘。`8,10,12,14` はバークリーで使わない非音楽的な数字で、メロディはルート上のコード度数 (1-7 + テンション 9/11/13) で書く。第四議論を経て **pitch range (音域状態) モデル**に収束 (DESIGN_DISCUSSION_RECORD §9、決定ログ #33-38)。

**確定した仕様 (spec が正本)**:

- **度数 = 和声的位置**: `1-7` (スケール) + テンション `9/11/13` (メロディでも明示可、`2/4/6` の +1オクターブ)。
- **`^N` = スティッキー pitch range**: 音/休符に付き、その地点から running range を base+N に設定。play() 内で読み順に持続、各 play() 先頭でリセット、`^0` で戻る。`0^N` = 無音で音域変更。独立 `^` マーカーは無し。3オクターブ上 = `3^3` 一発。
- **range は全度数に効く (統一ルール、linear)**。`^N`(linear/persistent) と `.oct()`(lexical/group、Phase 2) は別軸の道具。
- **度数受理 = {1-9, 11, 13}**。`8` = オクターブ上ルート (8va、`1^1` 等価)。`10/12/14/15+` は**エラー** (`^N` を案内)。後方互換は取らない (未リリース機能ゆえ)。

**変更内容**:

- `docs/specs-v2/DESIGN_DISCUSSION_RECORD.md` + `.html`: §9 第四議論を追記 (9.1-9.7、決定ログ #33-38)。`.html` は直接編集で同期 (pandoc 不使用 — 仕様 HTML は手書き保守が方針、`.md` のテーマを壊さないため)
- `docs/specs-v2/PITCH_DSL_SPEC_v1.1.html` §2.1 (度数受理 / `o`=running range)、§2.4 (`^N` スティッキー pitch range)
- `docs/specs-v2/IMPLEMENTATION_INSTRUCTIONS.html`: テスト網羅項を新ルールに
- `midi/degree-resolution.ts`: 受理度数 {1-9,11,13} 検証 (10/12/14/15+ は throw)
- `parser/types.ts` + `parse-expression.ts`: PlayPitch に `rangeSet` (「`^` を書いたか」=スティッキー set point)
- `midi/types.ts`: SymbolicPitch に `rangeSet?` (出力段の running range スレッド用)
- `timing/calculation/calculate-event-timing.ts`: `rangeSet` を pitch に伝播
- `core/sequence.ts` `scheduleMidiEvents`: 読み順で **running range をスレッド** (rangeSet で更新、以降の全度数に effective range を適用)

**テスト (821 passed / 23 skipped)**: degree 受理 {1-9,11,13} / 拒否 {10,12,14,15+}、スティッキー range の持続 (`play(1, 3^1, 5)` → C4 E5 **G5** で +1 が残る ≠ one-shot の G4)、`^0` リセット / `0^N` 無音音域変更、parser の `rangeSet` (`3^1`=true / `b3`=false / `1^0`=true)。

**未決/確認済**: `^N` × `.root()` グループの相互作用は **linear で確定** (大和さん、グループを抜けても range 持続)。chord 値内の `^N` (§6 ヴォイシング) は Phase 2+ で別途確認。

**/code:pr-review-team イテレーション1 (2026-06-13)**: 4 専門レビュアー (code-reviewer / silent-failure-hunter / pr-test-analyzer / comment-analyzer) で PR #245 をレビュー。Critical 2 + Important 6 を修正:
- **(Critical) 度数拒否が run() に伝播していなかった**: bad degree (10/12/14/15+) は fire-and-forget の scheduleEventsFn callback 内で throw され unhandled rejection になっていた (eager 検証は root だけだった)。`validateMidiDispatch()` を追加し、run()/loop() の eager ブロックで root + 全度数を事前解決 → 拒否度数が awaited チェーンで reject するように。テストで実証 (`play(10)`/`play(15)` → run() rejects)。
- **(Critical) README**: 「Ctrl+C = パニック」を graceful LOOP() に訂正。
- **(Important) MidiScheduler ピッチベンド残留**: detune≠0 の note の後、ベンドが中央に戻らず次の note を detune させていた → offTime に `pitchBend(…, 0)` reset を追加 + テスト。
- **(Important) MidiScheduler.tick() の throw 耐性**: `action.run()` が throw すると queue cleanup がスキップされ double-send / hanging note → try/catch + log で継続。
- **(Important) seq.root(0) のサイレント fallback**: 0 は休符で root 不正 → 正の整数を検証 (throw)。
- **(Important) テスト追加**: テンション 9/11/13 + range 継承、変化記号 + range 継承 (`3^1, b5`)、度数拒否の dispatch 伝播。
- **(Important) comment**: parsePitchModifiers docstring を sticky pitch range に更新。
- minor: degree-resolution 式コメントを `range o` に、dev-server `do_GET` の `/pattern` を exact match に。
- テスト 827 passed / 23 skipped。

**/code:pr-review-team イテレーション2 (2026-06-13)**: 再レビュー (code-reviewer / silent-failure-hunter) でイテレーション1の修正が正しく、新規問題なしを確認 (Critical 0 / Important 0)。surface された Minor を1件修正:
- **ループ中 play(不正度数) の crash 防止**: deferred (setTimeout) の scheduleEventsFn は awaited チェーン外なので、ループ中に不正度数を play() すると次サイクルで throw → Node>=22 で unhandled rejection / 未捕捉例外 = プロセス crash。イテレーション1の eager 検証は run()/loop() 入口だけ救済しており mid-loop は crash する非対称があった。`loop-sequence.ts` に `safeSchedule` ラッパを追加し deferred 呼び出しを catch+log、ループは last good schedule で継続。`tests/core/loop-sequence-resilience.spec.ts` で実証。
- セキュリティチェックリスト: secrets/injection/XSS なし。dev-server が 0.0.0.0 bind + 無認証だが localhost dev ツール (機微データなし、cross-machine 共同検証用途) ゆえ pass (信頼ネットワーク限定の注記つき)。
- 完了条件達成: **Critical 0 / Important 0 / security pass**。テスト 828 passed / 23 skipped。

**次**: PR #245 レビュー/マージ。その後 Phase 2 (#230) / L1 (#229)。

---

### 6.104 Issue #246 — MIDI モニターに「Now playing (DSL)」パターン表示 (`/pattern`) (Jun 13, 2026)

**Date**: 2026-06-13
**Status**: 🚧 IN PROGRESS (PR #245 に同梱)
**Issue**: signalcompose/orbitscore#246
**Branch**: `228-phase-1-midi-output`

**動機**: 大和さん「テストツールで今どの DSL パターンが実行されているか見たい」「ログ的に見れるといい」。手作り MIDI と表示の食い違いを防ぎ、共同検証で「今鳴っている DSL」を一目で確認するため。

**変更内容**:

- `tools/midi-monitor/dev-server.py`: `POST /pattern` (送信側が実行中の DSL を `{source,label}` で報告、`latest_pattern` に保持) + `GET /pattern` (最新を返す) を追加
- `tools/midi-monitor/index.html`: 「Now playing (DSL)」パネル — `/pattern` をポーリングして実評価ソースを表示 (`replaceChildren`/`createElement` で XSS 回避)

**経緯メモ**: headless runner (6.103、コミット `2bd34ef`) は `POST /pattern` を呼ぶが、**endpoint 側 (本変更) が未コミットだった**。本エントリで endpoint を確定し、midi-run.ts の `/pattern` 報告が実際に機能する。表示=エンジンが評価した実ソースなので、音と表示が原理的に一致する。

**/simplify パス (2026-06-13)**: 4 観点 (reuse/simplification/efficiency/altitude) で session 変更 (`2bd34ef..HEAD` の code) をレビュー。適用: `dev-server.py` の `/pattern` で `datetime.now()` を2回呼んでいたのを1回に集約。スキップ: index.html の meta DOM (textContent 化は `.label` のスタイルを落とすため)、`SymbolicPitch.rangeSet`/dual `octaveShift` の altitude (spec §9.4 で現レイヤを是認済・#240 score rendering 向けの tracked smell)。reuse/efficiency は実所見ゼロ。

---

### 6.103 Issue #228 — Phase 1: headless MIDI CLI runner (実エンジン .orbs → IAC) (Jun 13, 2026)

**Date**: 2026-06-13
**Status**: 🚧 IN PROGRESS (Phase 1 実機検証ツール。 commit hash: `a9a350b`)
**Issue**: signalcompose/orbitscore#228
**Branch**: `228-phase-1-midi-output`

**動機**: 大和さんの指摘「手で MIDI を作るのでなく、 DSL を CLI で実行してロジックを通過させて MIDI を送れ」。 これが Phase 1 の本当の実機検証。 TransportClock 分離 (6.102) により audio engine なしで MIDI を走らせられるようになった。

**変更内容**:

- `packages/engine/src/cli/midi-run.ts`: `.orbs` を実エンジン経路で評価する headless ランナー。 `parseAudioDSL` + `processGlobalInit/SequenceInit/Statement` (InterpreterV2 を迂回、 SC ブートを回避)、 no-op audio engine + デフォルト MidiManager (実 RtMidiOutput → IAC)。 評価した DSL ソースを monitor の `/pattern` に報告 (表示=真実)。 SIGINT で panic 停止
- `package.json`: `npm run midi-run -- <file.orbs>` スクリプト追加 (ts-node)
- `tools/midi-monitor/README.md`: headless runner の使い方を追記

**実機検証 (end-to-end)**: `npm run midi-run -- tools/midi-monitor/example.orbs` で、 `piano.play(1, 2, 3, 4, 5, 6, 7, 1^+1)` を**エンジンが度数解決**して C4-C5 (60,62,64,65,67,69,71,72) を IAC に送出 → ブラウザ Web MIDI で受信・発音をログ確認。 `/pattern` に `label: example.orbs` + 実ソースが報告され、 表示=エンジン評価ソースで音と一致 (以前の手作り MIDI の食い違い問題を原理的に解消)。 **SC は一切ブートせず**。

**意義**: DSL → パーサー → 度数解決 (§7-0 出力最終段) → MidiOutput → IAC の Phase 1 全経路を実機で確証。 WCTM の実機テスト基盤にもなる。

**追記 (graceful stop + REPL)**: 大和さんの指摘「パニックでなく LOOP() で止めたい」を反映。 Ctrl+C / SIGTERM は `global.stop()` のパニック (CC123/120) ではなく **`LOOP()` を評価して正規の per-sequence note-off** で停止 (§7-2、 実機でブラウザ受信が note-off のみ・panic 無しを確認)。 加えて **stdin live-coding REPL** を追加 — 実行中に DSL 行 (`LOOP()` / `LOOP(piano)` / `piano.play(...)`) を評価できる (OrbitScore のライブコーディング)。

**次**: PR #245 レビュー/マージ判断。 その後 Phase 2 (#230) / L1 (#229)。

---

### 6.102 Issue #228 — Phase 1: TransportClock で MIDI を SC から分離 (同期維持) (Jun 13, 2026)

**Date**: 2026-06-13
**Status**: 🚧 IN PROGRESS (Phase 1 改善。 commit hash: `312e73e`)
**Issue**: signalcompose/orbitscore#228
**Branch**: `228-phase-1-midi-output`

**動機**: 大和さんの指摘「IAC 経由は SC を絡ませない方がすっきり」。 ただし audio/MIDI を同時に使うとき**同期が壊れてはいけない**。 調査の結論: audio スケジューラも MIDI スケジューラも `Date.now()` ポーリングで、 同期は**共有する時刻原点 (`startTime`)** で実現されている。 従来は MIDI が audio scheduler オブジェクトから startTime を読んでいた (= コード結合だが、 これが同期の源)。

**設計判断**: 共有「トランスポート時計」に巻き上げる。 audio も MIDI も同一の `Date.now()` 原点を参照し、 MIDI は audio engine を参照しない。

**変更内容**:

- `core/global/transport-clock.ts`: `TransportClock` (startTime/running、 `global.start()` で一度だけ `Date.now()` をスタンプ) = 唯一のクロック原点
- `core/global/midi-transport-scheduler.ts`: `MidiTransportScheduler implements Scheduler` — TransportClock backed、 audio メソッドは no-op。 MIDI シーケンスはこれを使い **audio scheduler を一切参照しない**
- `core/global.ts`: TransportClock 所有、 `start()` で原点スタンプ (audio scheduler 始動より先) → 同期維持、 `stop()` で停止。 `getMidiTransport()`/`isTransportRunning()` 追加
- `core/sequence.ts`: `activeScheduler()` = MIDI なら MidiTransport、 audio なら SC scheduler。 seamlessParameterUpdate / run / loop / unmute の per-sequence scheduler を振り替え。 **audio 経路は無変更**
- `tests/core/transport-clock.spec.ts`: 5件 (原点スタンプ・冪等・**no-op audio engine でも MIDI 動作** = 分離実証)。 MIDI dispatch / hanging-note テストは `global.start()` 追加で更新

**同期の保証**: audio scheduler と MidiTransport は同じ `global.start()` の `Date.now()` 原点を共有 → 同音楽時刻のイベントは同 `Date.now()` 発火。 下流レイテンシ差は `midiLatency()` + ポート lead で補正 (§9、 既存)。 MIDI 専用セッションは SC を一切ブートしない。

**テスト結果**: 878 passed / 23 skipped (901 total)。 +5、 audio 回帰なし。

**次**: headless MIDI CLI ランナー (ts-node)。 TransportClock のおかげで audio engine 不要の綺麗な実装に。

---

### 6.101 Issue #246 — ブラウザ MIDI モニター + シンセ (.orbs 検証ツール) (Jun 13, 2026)

**Date**: 2026-06-13
**Status**: 🚧 IN PROGRESS (Phase 1 ブランチに同梱。 commit hash: `8217af3`)
**Issue**: signalcompose/orbitscore#246
**Branch**: `228-phase-1-midi-output` (PR #245 に同梱)

**動機**: Phase 1 の MIDI 出力を DAW やソフトシンセのセットアップなしで確認するため (大和さん提案)。 Phase 1 と同じブランチに入れることで、 同じ PR のレビュー/テストで早速使える。

**変更内容 (`tools/midi-monitor/`)**:

- `index.html`: 単一静的ページ (ビルド不要・依存なし・vanilla JS)。 Web MIDI で IAC 受信 + Web Audio でポリフォニックシンセ (osc + ADSR + lowpass)。 velocity→音量、 pitch bend→±2半音 (エンジンの bend range に一致)、 CC123/120→全 note-off、 MIDI モニターログ + 発音中ノート表示、 MIDI 無しの Test tone。 `innerHTML` は使わず `replaceChildren`/`createElement` (XSS 回避)
- `example.orbs`: IAC へ C メジャースケールを送る最小例。 port は substring `"IAC"` で日英両環境対応
- `README.md`: 使い方 + IAC オンライン化手順

**位置づけ**: 人間/リハ用の検証ハーネス (CI 自動化用ではない)。 WCTM のソフトピアノ代替 (WCTM_SYSTEM_SPEC §9 / #232) にも転用可。

**検証**: localhost 配信で HTTP 200、 主要要素・コード存在確認、 inline JS の `node --check` 構文OK。 実 IAC→発音は Chrome での人手確認 (Web MIDI は secure context 必須)。

**追記 (commit `7ff89e2`)**: 楽器選択 (Piano / Organ / Synth) + 任意のイベントレポート (`?report=1`) + `dev-server.py` (静的配信 + POST /events を stdout) を追加。 **実機 end-to-end 検証済み**: CLI (`@julusian/midi`) → `IACドライバ バス1` → ブラウザ Web MIDI で C メジャースケール + 和音をビット単位一致で受信・発音、 ピッチ正常を人手確認。 先頭音落ちはタブ非フォーカス時の AudioContext スロットルが原因 (README 明記)。 `dev-server.py` 経由でブラウザ受信イベントを観測しながら人間/エージェント連携でテストできることを実証。

---

### 6.100 Issue #228 — Phase 1 増分5d: hanging note 不変条件 + `[ ]` 予約 (Phase 1 機能完成) (Jun 13, 2026)

**Date**: 2026-06-13
**Status**: 🚧 IN PROGRESS (Phase 1 機能完成。 commit hash: `d8d0dd3`)
**Issue**: signalcompose/orbitscore#228
**Branch**: `228-phase-1-midi-output`

**動機**: Phase 1 のゲート条件 (hanging note ゼロ) の受け入れテストと、 audio `[ ]` の diagnostic 予約 (§10-5)。 これで Phase 1 の機能が出揃う。

**変更内容**:

- `tests/core/midi-hanging-note-invariant.spec.ts`: 実 RtMidiOutput (recording backend) + fake timers で 3 件:
  - **LOOP play() 差し替え100回で hanging note ゼロ** (Phase 1 ゲート条件)
  - MUTE で sounding note 全解放
  - global.stop() で panic (CC123+CC120 全ch、 active note ゼロ)
- `[ ]` 予約 (§10-5): `tokenizer` に LBRACKET/RBRACKET 追加 (従来は default で黙って破棄)。 `parse-expression` でパースエラー (「v1.1 では未対応・予約」)。 黙って無視せずエラーにすることで将来の開放 (Phase 3 の MIDI chord / audio レイヤリング) を純粋な追加変更にする
- `tests/audio-parser/pitch-parsing.spec.ts`: `[ ]` 予約テスト 3 件追加

**テスト結果**: 873 passed / 23 skipped (896 total)。 +6、 回帰なし。

**Phase 1 機能チェックリスト (受け入れ基準)**:
- ✅ `seq.midi(port, ch)` + ポート名ロケール対応 (`/iac/i`)
- ✅ root スコープ度数解決 (§2.1)、 `seq.root()`/global.key()/octave
- ✅ §7-0 シンボリックピッチ保持 (番号化は出力最終段のみ)
- ✅ active note tracking + パニック CC123/120
- ✅ **LOOP 差し替え100回で hanging note ゼロ**
- ✅ hanging note 不変条件 (note-on = note-off)
- ✅ 度数解決の網羅テスト (326件)
- ✅ detune (pitch bend ±2)、 gate/vel/octave、 midiLatency + ポート lead
- ✅ audio `[ ]` の diagnostic 予約
- ✅ 既存テストグリーン (回帰なし)
- ⏭ L1 ログ同乗 (#229)、 VS Code ハイライト (Phase 2)、 core spec 反映 (#237) は別 Issue

**Phase 1 コミット**: 増分1 `38b3040` / 2a `f7ee68b` / 2b `f275b45` / 3 `2e23104` / 4 `876cec7` / 5a `c849119` / 5b `4c3f50b` / 5c `0c36eb6` / 5d (本コミット)。 全 9 コミット、 MIDI 関連テスト +445。

**次**: PR 作成 (#228 Closes) → レビュー → マージ。 その後 Phase 2 (#230 `.root()` グループチェーン)。

---

### 6.99 Issue #228 — Phase 1 増分5c: MIDI ディスパッチ配線 (発音つながる) (Jun 13, 2026)

**Date**: 2026-06-13
**Status**: 🚧 IN PROGRESS (Phase 1 増分5c。 commit hash: `ba12399`)
**Issue**: signalcompose/orbitscore#228
**Branch**: `228-phase-1-midi-output`

**動機**: パイプライン最後の配線。 MIDI シーケンスの play() を実際に発音させる。 これで DSL `b3` → パーサー → timing → **度数解決 (出力最終段) → MidiScheduler → MidiOutput → 🔊** がつながる。

**設計判断**: 既存の audio 中心 `loop-sequence`/`run-sequence`/`prepare-playback` はコールバック駆動で audio/MIDI 非依存だったため**そのまま再利用**。MIDI 固有部分だけを Sequence 側のコールバックで差し替える (最小の中枢変更)。 時刻基底は audio scheduler の startTime を共有 (併走同期)。

**変更内容 (`core/sequence.ts`)**:

- `scheduleMidiEvents()`: TimedEvent → `resolveDegree(symbolic, rootContext)` → `ScheduledMidiNote` → MidiScheduler。 §7-0 の番号化を**ここ (出力最終段) で**実施。 rest (度数0) はスキップ、 detune は pitch bend へ、 onTime = `schedulerStartTime + baseTime + ev.startTime + sendDelay`
- `resolveRootContext()`: global.key() + seq.root(degree) + seq.octave から RootContext。 key 未宣言 + 度数ありはエラー (§2.3)。 run()/loop() で eager 検証 (resolveDispatchChannel と同じ理由で early throw)
- `clearEvents()`: MIDI は `MidiScheduler.clearOwner` (pending 除去 + sounding note 解放、 §7-2)、 audio は従来通り。 run/loop/stop/mute/unmute/play差し替え の全クリア経路を振り替え
- `scheduleEvents`/`scheduleEventsFromTime` に MIDI 分岐 (従来は `!_audioFilePath` で早期 return していた箇所)
- `tests/core/sequence-midi-dispatch.spec.ts`: fake timers + mock 出力で 6 件 (度数→MIDI番号 end-to-end、 b3→Eb4、 octave、 gate の note-off 対、 stop で releaseOwner、 key 未宣言エラー)

**テスト結果**: 867 passed / 23 skipped (890 total)。 +6、 回帰なし。

**次**: 増分5d (hanging note 不変条件: LOOP差し替え100回でゼロ — Phase 1 ゲート条件)。 残: audio `[ ]` の diagnostic 予約 (§10-5、 `[ ]` トークンは Phase 3 で導入のため要検討)。

---

### 6.98 Issue #228 — Phase 1 増分5b: Sequence MIDI 設定面 + audio排他 (Jun 13, 2026)

**Date**: 2026-06-13
**Status**: 🚧 IN PROGRESS (Phase 1 増分5b。 commit hash: `3289c01`)
**Issue**: signalcompose/orbitscore#228
**Branch**: `228-phase-1-midi-output`

**動機**: Sequence のユーザー向け MIDI 設定メソッド。 これで MIDI シーケンスの宣言面が揃う (実際の発音配線は 5c)。

**変更内容 (`core/sequence.ts`)**:

- `midi(portName, channel)`: MIDI モード宣言。 ポートを eager 解決 (ローカライズ substring、 未知ポートは宣言時エラー)。 channel 1..16 検証。 `audio()` 済みなら排他エラー
- `gate(v)` (0..1)、 `vel(v)` (1..127)、 `octave(v)`、 `root(degree)` セッター。 既定 gate=0.8/vel=96/octave=4 (§1)
- `isMidi()`、 `audio()`/`chop()` に MIDI 排他チェック
- `getState()` に midiPort/midiChannel/gate/vel/octave/rootDegree を追加
- `tests/core/sequence-midi-config.spec.ts`: 10 件 (ポート解決・channel検証・排他双方向・clamp・既定値)

**テスト結果**: 861 passed / 23 skipped (884 total)。 +10、 回帰なし。

**次**: 増分5c (MIDI ディスパッチ配線: run/loop/play/stop/mute → MidiScheduler、 TimedEvent → 度数解決 → ScheduledMidiNote)、 5d (hanging note 不変条件 100回)。

---

### 6.97 Issue #228 — Phase 1 増分5a: Global MIDI インフラ + key/midiLatency (Jun 13, 2026)

**Date**: 2026-06-13
**Status**: 🚧 IN PROGRESS (Phase 1 増分5a。 commit hash: `a0e999f`)
**Issue**: signalcompose/orbitscore#228
**Branch**: `228-phase-1-midi-output`

**動機**: Sequence MIDI 統合 (増分5) の土台。 全 MIDI シーケンスが共有する MidiOutput + MidiScheduler を Global が lazy に所有し、 グローバル key と midiLatency を提供する。

**変更内容**:

- `midi/note-name.ts`: 音名 → ピッチクラス解析 (`"C"`/`"F#"`/`"Bb"`/`"C##"`、 octave 境界 wrap、 case-insensitive)。 §1/§2.3
- `core/global/midi-manager.ts`: `MidiManager` — lazy な MidiOutput+MidiScheduler 所有 (audio-only セッションは CoreMIDI に触れない)、 グローバル key、 midiLatency、 ポート単位 lead オフセット (Disklavier 機構レイテンシ、 §9)。 出力は注入可能 (テストで mock)
- `core/global.ts`: `key(name)`、 `midiLatency(ms)`、 `getMidiManager()` を追加。 `start()`/`stop()` で scheduler を起動/停止。 constructor に MidiManager 注入口
- `tests/midi/note-name.spec.ts` (5件)、 `tests/midi/midi-manager.spec.ts` (5件)

**確認**: インタプリタは動的ディスパッチ (`obj[method].apply`) なので `global.key()`/`global.midiLatency()` は自動的に届く (whitelist なし)。

**テスト結果**: 851 passed / 23 skipped (874 total)。 +10、 回帰なし。

**次**: 増分5b (Sequence の midi()/gate/vel/octave/root + audio排他)、 5c (MIDI ディスパッチ配線 + 度数解決)、 5d (hanging note 不変条件)。

---

### 6.96 Issue #228 — Phase 1 増分4: MidiScheduler (TS lookahead) (Jun 13, 2026)

**Date**: 2026-06-13
**Status**: 🚧 IN PROGRESS (Phase 1 増分4。 commit hash: `b866454`)
**Issue**: signalcompose/orbitscore#228
**Branch**: `228-phase-1-midi-output`

**動機**: RtMidi は即時送信のみのため、 TS 側で note タイミングを駆動する lookahead スケジューラ。 §5 に従い Sonnet に実装委譲、 契約 (型) と統合レビューは main。

**設計判断**: §7-0 のシンボリックピッチ→MIDI番号の解決はディスパッチ層 (増分5、 出力最終段) で行うため、 MidiScheduler は **解決済みノート** (`ScheduledMidiNote`) を受け取る。 時刻は `Date.now()` 基準の絶対 epoch ms (audio スケジューラと同一クロック基底で併走可)。

**変更内容**:

- `midi-scheduler.ts`: 契約 (main 作成) — `ScheduledMidiNote` (owner/port/channel/note/velocity/detune/onTime/offTime)、 `MidiSchedulerOptions`。 `MidiScheduler` クラス (Sonnet 実装) — `setInterval(tickMs=5)` ポーリング、 各 tick で `Date.now()` をスナップして `time <= now` のアクションを `(time,seq)` 順に発火 (ドリフト補正は tick 毎の壁時計比較)。 detune は note-on 直前に pitch bend。 `start`(冪等)/`stop`(panic)/`clearOwner`(pending除去 + releaseOwner)
- `tests/midi/midi-scheduler.spec.ts`: fake timers + mock MidiOutput で 21 件 (発火タイミング、 順序、 detune→bend、 clearOwner、 stop→panic、 過去時刻の翌tick発火、 start冪等)

**テスト結果**: 841 passed / 23 skipped (864 total)。 midi-scheduler +21、 回帰なし。

**次**: 増分5 (Sequence MIDI 統合: midi() + ディスパッチ + 値=度数解釈 + 排他 + パラメータ + audio[]予約 + hanging note 不変条件) [main 直列]。

---

### 6.95 Issue #228 — Phase 1 増分3: MidiOutput (@julusian/midi ラッパー) (Jun 13, 2026)

**Date**: 2026-06-13
**Status**: 🚧 IN PROGRESS (Phase 1 増分3。 commit hash: `e36e6cf`)
**Issue**: signalcompose/orbitscore#228
**Branch**: `228-phase-1-midi-output`

**動機**: raw MIDI 送出層。 ポート解決・note 送出・active note tracking・パニックを担う隔離モジュール。 §5 委譲方針に従い実装は Sonnet サブエージェントに委譲、 契約 (interface) と統合品質レビューは main (Opus)。

**変更内容**:

- `packages/engine/package.json`: `@julusian/midi@^3.6.1` を依存追加
- `midi-output.ts` (main 作成): 契約定義 — `MidiOutput` interface、 `MidiBackend` 注入 seam (テストで mock 可)、 `ActiveNote`
- `rtmidi-output.ts` (Sonnet 実装 + main レビュー): `RtMidiOutput implements MidiOutput`。 ポート名 case-insensitive substring 解決 (ローカライズ名 `"IACドライバ バス1"` を `"iac"` で当てる、 §1)、 note-on/off、 pitch bend (±2半音固定)、 active note tracking、 `releaseOwner` (LOOP除外/MUTE/play差し替え時の解放)、 `panic` (CC123+CC120 全ch、 §7-2)
- `tests/midi/midi-output.spec.ts`: mock backend で 41 件 (ポート解決・note tracking・releaseOwner・panic・**hanging note 不変条件**・pitch bend)

**main によるレビュー改善**: `noteOn`/`noteOff`/`pitchBend` が毎回 `ensurePort` (ポート再列挙) を呼ぶとライブ演奏で1音ごとに CoreMIDI 列挙が走るため、 解決済みポート名のキャッシュ高速パス (`resolveOpenPort`) を追加。

**テスト結果**: 820 passed / 23 skipped (843 total)。 midi-output +41、 回帰なし。

**次**: 増分4 (MidiScheduler: TS lookahead) [Sonnet 委譲]。

---

### 6.94 Issue #228 — Phase 1 増分2b: TimedEvent シンボリックピッチ拡張 (§7-0) (Jun 13, 2026)

**Date**: 2026-06-13
**Status**: 🚧 IN PROGRESS (Phase 1 増分2b。 commit hash: `e9abf90`)
**Issue**: signalcompose/orbitscore#228
**Branch**: `228-phase-1-midi-output`

**動機**: パース (増分2a) で生成した `PlayPitch` を、 タイミング計算を通してシンボリックピッチのまま運ぶ。 これで「パース → timing」がつながり、 §7-0 (MIDI 番号化は出力最終段のみ) を pipeline で守る。

**変更内容**:

- `timing/calculation/types.ts`: `TimedEvent` に optional `pitch?: SymbolicPitch` を追加 (非破壊。 audio スライスイベントは未設定のまま)。 midi/types から SymbolicPitch を import (timing→midi の一方向依存、 循環なし)
- `calculate-event-timing.ts`: `element.type === 'pitch'` を処理。 リズム木が startTime/duration を与え、 シンボリックピッチを未解決のまま carry。 sliceNumber は degree をフォールバックとしてミラー
- `tests/timing/pitch-timing.spec.ts`: 4 件 (pitch carry、 octave shift/detune 透過、 ネスト内 pitch、 audio 回帰)

**設計判断**: TimedEvent は解決済み midiNote を持たず **シンボリックピッチのみ** を運ぶ。 root context (rootPitchClass/octave) の適用と MIDI 番号化は出力アダプタ最終段 (増分3-5) で行う。

**テスト結果**: 779 passed / 23 skipped (802 total)。 pitch-timing +4、 回帰なし。

**次**: 増分3 (MidiOutput: @julusian/midi ラッパー) [Sonnet 委譲]。

---

### 6.93 Issue #228 — Phase 1 増分2a: ピッチトークン + パーサー (§2.1 / §2.4) (Jun 13, 2026)

**Date**: 2026-06-13
**Status**: 🚧 IN PROGRESS (Phase 1 増分2a。 commit hash: `356afcb`)
**Issue**: signalcompose/orbitscore#228
**Branch**: `228-phase-1-midi-output`

**動機**: MIDI 度数記法 (`b3`, `#5`, `bb7`, `##1`, `3^+1`, `b7~-0.25`) を DSL でパースできるようにする。 共有トークナイザーに触れる最重要作業のため main (Opus) が直列で実施 (§5)。

**事前確認**: audio DSL のコメントは `//` で `#` と衝突しない。 `#`/`^`/`~`/`b+数字` は既存 .orbs / テストで未使用 → 新トークン追加は既存パースを壊さない (grep 確認済み)。

**変更内容**:

- `tokenizer.ts`: ACCIDENTAL (`#`/`##`/`b`/`bb` ラン)、 CARET (`^`)、 TILDE (`~`)、 PLUS (`+`) トークンを追加。 `b` ランは「直後が数字」のときのみ alteration とみなし、 そうでなければ識別子にフォールバック (変数名 `b` を保護)
- `parser/types.ts`: 新トークン型 + `PlayPitch` AST ノード (degree/alteration/octaveShift/detune) を `PlayElement` union に追加。 裸の整数は `number` のまま (audio スライス番号互換)
- `parse-expression.ts`: accidental + number + `^`/`~` 修飾を `PlayPitch` に解析。 トップレベルとネスト両対応。 `bb`/`##` = ±2、 3個以上で warning (spec §2.1)
- `tests/audio-parser/pitch-parsing.spec.ts`: トークナイザー/パーサーテスト 21 件

**設計判断**: 裸整数を `number` のまま残すことで audio スライス番号パースを完全に無変更に保つ。 `PlayPitch` は accidental か `^`/`~` がある場合のみ生成。 値=度数の解釈は MIDI ディスパッチ時 (増分3以降)。

**既知の制約**: `b7` 等は flat-7 記法として予約されるため、 同名の変数定義は不可 (spec の設計通り)。

**テスト結果**: 775 passed / 23 skipped (798 total)。 pitch-parsing +21、 回帰なし。

**次**: 増分2b (TimedEvent シンボリックピッチ拡張 + timing 計算のピッチ対応)。

---

### 6.92 Issue #228 — Phase 1 増分1: 度数解決コア (§2.1 / §7-0) (Jun 13, 2026)

**Date**: 2026-06-13
**Status**: 🚧 IN PROGRESS (Phase 1 全体の増分1。 commit hash: `283e56f`)
**Issue**: signalcompose/orbitscore#228
**Branch**: `228-phase-1-midi-output`
**Epic**: signalcompose/orbitscore#224

**動機**: Phase 1 (raw MIDI 出力) の基盤として、 MIDI ハードウェア・スケジューラに依存しない純関数部分から着手。 §7-0 シンボリックピッチ保持の型契約と §2.1 度数解決を最初に確立する (パイプライン全体がこの型に乗るため、 最初に固めないと後で取り返せない)。

**増分1の内容 (新規 `packages/engine/src/midi/`)**:

- `types.ts` — §7-0 契約の型定義: `SymbolicPitch` (degree/alteration/octaveShift/detune)、 `RootContext` (rootPitchClass/octave)、 `ResolvedPitch` (midiNote + シンボリック情報を保持)。 MIDI 番号化は出力最終段のみという §7-0 を型レベルで強制
- `degree-resolution.ts` — §2.1 の IONIAN 式による純関数 `resolveDegree()`。 度数 0 = 休符 (null)、 度数 9/11/13/15 はオクターブ折り返しが式から自然導出、 C4=60 規約
- `index.ts` — モジュール公開面
- `tests/midi/degree-resolution.spec.ts` — プロパティテスト 326 件 (全度数 1-15 × 変化記号 ±2 × octave 2-5 の網羅 + C4=60 + テンション折り返し + §7-0 保持 + detune 透過 + バリデーション)

**設計判断**: spec §3 のアーキテクチャ決定に従い `packages/engine/src/midi/` を AudioEngine と並置 (EventRouter フル分離はしない)。 型契約は中枢に影響するため main (Opus) が直接定義。 度数解決の数理は §2.1 が完全な契約。

**テスト結果**: 754 passed / 23 skipped (777 total)。 midi +326、 回帰なし。

**Phase 1 の残り増分 (次セッション以降)**: ① パーサー拡張 (`b3`/`#5`/`3^+1`/`b7~-0.25` トークン)、 ② MidiOutput (@julusian/midi ラッパー、 ポート名ロケール対応、 active note tracking、 パニック CC123/120) [Sonnet 委譲可]、 ③ MidiScheduler (TS lookahead 50-100ms、 ドリフト補正) [Sonnet 委譲可]、 ④ Sequence への `midi()` メソッド + ディスパッチフラグ + 値=度数解釈、 ⑤ `global.key()`/`midiLatency()` + ポート単位オフセット、 ⑥ seq.gate/vel/octave、 ⑦ audio `[ ]` の diagnostic エラー予約、 ⑧ hanging note 不変条件テスト。

---

### 6.91 Issue #226 — Phase 0 事前検証4項目 (Jun 13, 2026)

**Date**: 2026-06-13
**Status**: ✅ DONE (commit hash: `93dad80`)
**Issue**: signalcompose/orbitscore#226
**Branch**: `226-phase-0-verification`
**Epic**: signalcompose/orbitscore#224

**動機**: v1.1 Pitch DSL 実装に着手する前に、 仕様が依拠する4つの前提をコードを書く前に検証する (指示書 §4 Phase 0)。 仕様の前提を崩す結果が出たら停止して報告する条件付き。

**検証結果 (停止条件には1件も該当せず)**:

- **0-1 `(1)(2)` タプル並置**: ✅ 前提成立。 兄弟展開される (parse-statement.ts:383 が意図的に連続処理)。 ただしパーサーは並置とカンマ区切りを区別せずフラット化するため、 Phase 2 の `.root()` スコープ規則には AST 区別の拡張が必要 (spec 織り込み済み)。 再現テスト `tests/phase0/juxtaposition-verification.spec.ts` (4件) で固定
- **0-2 `quantize("bar")` play() 差し替え**: ✅ 前提成立・実装済み。 `seamlessParameterUpdate` の deferToNextCycle に 'play' が含まれ次サイクル反映。 既存34テスト (loop-quantize / seamless-parameter-update / quantize) で担保。 Issue #212 修正が PR #215 でマージ済み
- **0-3 `@julusian/midi`**: ✅ 動作確認。 Node 22.17.1 + macOS arm64 で prebuild `midi-darwin-arm64` 込みインストール成功。 実 IAC ポート `"IACドライバ バス1"` への note 送出に成功。 ⚠️ ポート名がロケール依存 (英語例 `"IAC Driver Bus 1"` と不一致) のため Phase 1 で `/iac/i` 等の言語非依存マッチが必要。 `openVirtualPort()` も利用可
- **0-4 Link 追従**: ⚠️ オーディオ受け渡しのみ。 スケジューリングは内部クロック (`Date.now()` + `setInterval`) 独立で Link beat/phase を参照しない。 → W-Link (#234) に「Link 追従スケジューリング」を新規実装項目として昇格 (spec 織り込み済み、 停止条件外)

**成果物**: `docs/research/PHASE0_VERIFICATION_REPORT.md` (各項目の結果 + 後続フェーズへの影響評価)、 `tests/phase0/juxtaposition-verification.spec.ts`。

**テスト結果**: 428 passed / 23 skipped (451 total)。 phase0 テスト +4、 回帰なし。

**次のステップ**: Phase R (#227) または Phase 1 (#228)。 0-1/0-3 の含意を各フェーズ着手時に反映。

---

### 6.90 Issue #225 — specs-v2 配置 + CLAUDE.md オンボーディング (Jun 13, 2026)

**Date**: 2026-06-13
**Status**: ✅ DONE (commit hash: `19141f1`)
**Issue**: signalcompose/orbitscore#225
**Branch**: `225-docs-specs-v2`
**Epic**: signalcompose/orbitscore#224 (v1.1 Pitch DSL + Session Log + WCTM、 締切 2026-08-07)

**動機**: v1.1 Pitch DSL / MIDI 出力・Session Log (.orbslog)・WCTM コンサートシステムの正本仕様5文書をリポジトリに配置し、 後続の実装セッション (Opus) が迷わず作業を開始できる土台を作る。 Epic #224 配下の最初のタスクであり、 全実装フェーズの前提。

**作業内容**:

- ローカル未追跡だった `docs/spec-v2/` を、 指示書 §8 指定の **`docs/specs-v2/`** にリネームして git 管理下に配置 (5文書: 4 HTML + DESIGN_DISCUSSION_RECORD は md/html 併存。 HTML が正本、 SVG アーキテクチャ図を含む)
- **CLAUDE.md** に「🎯 現在進行中」セクションを追記 (全書き換えはせずセクション単位の追記。 Context Collapse 防止): specs-v2 の読み順、 §7 Known Decisions 再議論禁止ルール、 Epic #224 参照、 委譲方針 (§5)、 Phase 0 停止条件
- **docs/core/INDEX.md** に「Active spec set」セクションを追加 (読み順テーブル + 再議論禁止の注記)
- **docs/core/INSTRUCTION_ORBITSCORE_DSL.md** (SoT) 冒頭に specs-v2 への参照 + 各フェーズゲートでの SoT 反映ルール (§8.1-1) を追記

**正本仕様 (docs/specs-v2/、 読み順)**:

1. `IMPLEMENTATION_INSTRUCTIONS.html` — 作業指示書 (フェーズ・依存グラフ・委譲方針・Known Decisions §7)
2. `PITCH_DSL_SPEC_v1.1.html` — Stage 1 = note DSL の仕様正本
3. `SESSION_LOG_SPEC_v1.html` — 記録 .orbslog の仕様正本
4. `WCTM_SYSTEM_SPEC_v1.html` — コンサートシステムの仕様正本
5. `DESIGN_DISCUSSION_RECORD.md` — 設計経緯と棄却済み代替案 (決定ログ #1-32)

**起票した Issue 群 (2026-06-13)**: Epic #224、 実装系 #225-237 (Phase 0/R/1/L1/2/3/4・W-Bridge/RuntimeA/Link/Ops・docs sync)、 将来予約 #238-242 (audio `[ ]`・slice()・譜面レンダリング Epic・L2 Replayer・WCTM 事後分析)。 ラベル `wctm` / `session-log`、 マイルストーン「WCTM 2026-08-07」を新設。

**テスト結果**: 424 passed / 23 skipped (447 total)。 ドキュメントのみの変更で回帰なし。

**次のステップ**: #226 Phase 0 (事前検証4項目。 仕様前提が崩れたら停止して報告)。

---

### 6.89 Issue #221 — audioPath search resolution + sample bank lookup (May 10, 2026)

**Date**: May 10, 2026
**Status**: ✅ DONE (実装、テスト、docs 更新完了。 commit hash: `bacf4e0`)
**Issue**: signalcompose/orbitscore#221
**Branch**: `claude/review-issue-221-RkVzz`
**Version target**: v1.2.1 (forward-only patch、 v1.2.0 LinkAudio とは独立)

**動機**: TidalCycles 系 sample collection (Clean-Samples 等) を OrbitScore で利用可能にする。 SuperDirt / sclang を経由せず、 単なる WAV file 群として独立配布されている collection を user が自分で配置し、 OrbitScore はその sample 名 (`bd`, `sd`, `hh:5` 等) で参照できる仕組みを提供。 既存 TidalCycles user の barrier を下げ、 既存 `audio() + chop() + play()` の DSL style がそのまま使えるようにする。

**設計判断 (Hybrid 採用)**:

Issue #221 本文の strict 仕様 (`audioPath(string[])` のみ、 bare name は常に bank lookup) を厳密適用すると、 既存の 30+ `.orbs` ファイル / VS Code extension / unit test (旧 `audioPath(string)` + `audio("kick.wav")` join 挙動依存) が全部 break する。 v1.2.1 は patch version で breaking change 想定外のため、 user に確認のうえ **Hybrid 方式** を採用:

- `audioPath()` は `string | string[] | variadic` の 3 形式を受ける (旧 single string と新 array の共存)
- `audio()` は path-direct → bank lookup → legacy join の優先順で解決
- 拡張子付き bare name (`kick.wav`) は bank lookup hit せず legacy join 経路に fallback
- 既存 30+ `.orbs` ファイル / VS Code extension / 既存 7 件の unit test を一切触らずに新機能追加

**実装内容**:

1. **新規 `packages/engine/src/core/global/audio-resolver.ts`** (約 165 行)
   - `looksLikePath(spec)` — path-direct 判定
   - `expandHome(p)` — `~`, `~/foo` を `os.homedir()` で展開
   - `resolveAudio({ spec, audioPaths, documentDirectory, cache })` — 統合 resolver
   - `bd:N` の variant index parsing (modulo wraparound、 NaN/負数/非整数は throw)
   - 拡張子 filter `wav|aif|aiff|mp3|mp4|flac` (大文字小文字不問)
   - 解決失敗時の error には available banks の hint 同梱

2. **`packages/engine/src/core/global/audio-manager.ts`** 拡張
   - 内部 storage を `_audioPath: string` → `_audioPaths: string[]` に変更
   - `audioPath(...values: (string | string[])[]): string | this` で variadic + array 両対応
   - 解決結果 cache (`Map<string, string>`)、 audioPath 再設定 / documentDirectory 変更で invalidate
   - getter `audioPath()` は配列の 0 番目を string で返す (legacy compat)
   - `resolve(spec)` を新設、 内部で audio-resolver に委譲

3. **`packages/engine/src/core/global/types.ts`** — `GlobalState` に `audioPaths: string[]` 追加 (旧 `audioPath: string` も legacy compat で残す)

4. **`packages/engine/src/core/global.ts`**
   - `audioPath()` を variadic 化、 audio-manager に転送
   - `resolveAudioSpec(spec): string` を新設、 audio-manager `.resolve()` への薄い wrapper

5. **`packages/engine/src/core/sequence.ts`** の `audio()` 簡素化
   - 自前の path resolution logic を削除
   - `this.global.resolveAudioSpec(filepath)` 1 行に置換
   - 既存 chop / `_audioFilePath` 周辺は変更なし

6. **新規 `tests/core/audio-bank-resolution.spec.ts`** (39 件)
   - looksLikePath / expandHome の pure function tests
   - resolveAudio の path-direct / bank lookup / `bank:N` variant / multi-path traversal / 拡張子 filter / cache hit
   - 解決失敗時の error message validation
   - Global.audioPath() の variadic + array + `~/` 展開
   - Sequence.audio() integration (bare name, legacy join, `~/`, cache invalidation)

**テスト結果**:
- 全 447 件 pass (424 passed, 23 skipped) — 旧 230 から 217 件増加、 既存全 pass
- 新規 39 件 (audio-bank-resolution) + 既存 7 件 (audio-path-resolution) 全 green
- `npm run build` clean、 `npm run lint` clean (1 件の warning は既存の audio-slicer.spec.ts、 本件と無関係)

**触らなかった領域** (Issue 仕様の 「既存 layer に手を入れない」 を遵守):
- `BufferManager` / OSC layer / `EventScheduler` / DSL parser (`tokenizer.ts`, `parse-expression.ts`)
- VS Code extension の completion / diagnostic (legacy single-string API でも動作継続)
- 既存の 30+ `test-assets/scores/*.orbs` ファイル

**Sample collection license に関する文書化**:
- `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` で Clean-Samples (GPL-3.0) を最初の推奨として案内
- Dirt-Samples は LICENSE 不在 / provenance unknown を明示、 OrbitScore 側 bundle / auto-download は実装しない方針を明記
- README 更新 (本変更と同一 PR 内で実施)

**変更ファイル**:
- 新規: `packages/engine/src/core/global/audio-resolver.ts`、 `tests/core/audio-bank-resolution.spec.ts`
- 編集: `packages/engine/src/core/global/audio-manager.ts`、 `packages/engine/src/core/global/types.ts`、 `packages/engine/src/core/global.ts`、 `packages/engine/src/core/sequence.ts`、 `docs/core/INSTRUCTION_ORBITSCORE_DSL.md`、 `docs/development/WORK_LOG.md`、 `README.md`

**Next steps**:
- Issue #221 を closing する PR 作成 (ユーザー承認後)
- v1.2.1 release notes に本機能を含める
- `.orbs` parser への配列 literal 対応は別 issue (現状 variadic で代替可能)

---

### 6.88 Release v1.1.1 — quantize patch ship (May 09, 2026)

**Date**: May 09, 2026 (tag push: May 09 16:09 UTC, re-tag: 16:26 UTC)
**Status**: ✅ DONE (GitHub Release v1.1.1 作成済、 Marketplace/Open VSX は gate off で skip)
**Tag**: `v1.1.1` annotated (現在は commit `afd6646` を指す、 後述の re-tag 経緯あり)
**Branch (1.1.x)**: `1.1.x` HEAD
**Issue**: signalcompose/orbitscore#216 (gate backport)、 #219 (本 entry)
**Related PRs**: #214 (1.1.x への #212 patch)、 #215 (main への forward port)、 #217 (gate backport to 1.1.x)
**GitHub Release**: https://github.com/signalcompose/orbitscore/releases/tag/v1.1.1
**.vsix asset**: `orbitscore-darwin-arm64-1.1.1.vsix` (7,445,312 bytes)

**動機**: ICMC 2026 Hamburg (5/10-16) 直前で v1.1.0 (May 06 stable) にバンドルされた quantize 関連 bug fix (#212) を patch release として ship する。 v1.1.1 は ICMC 期間の primary distribution vehicle、 v1.2.0 (LinkAudio + quantize 含む post-rebase) は post-ICMC release を想定。

**ship までの flow** (時系列):

1. **PR #214 merge** (16:07 UTC) — `1.1.x` line に #212 quantize patch を取り込み (merge commit `99a16df`)
2. **v1.1.1 tag push #1** (16:09 UTC) — `99a16df` に annotated tag、 release.yml run `25605590449` 起動
3. **partial failure 発生** — Build / .vsix package / GitHub Release 作成は SUCCESS、 但し `Publish to VS Code Marketplace` step が `VSCE_PAT` 未登録のまま failure、 `Publish to Open VSX` も skip
4. **原因切り分け** — 1.1.x の `release.yml` には main entry 6.76 (Issue #197) で導入された `vars.PUBLISH_MARKETPLACE == 'true'` gate が backport されていなかった。 同等の gate なしで stable tag を push すると secret 未整備の現状では必ず failure になる構造
5. **Issue #216 + PR #217** — gate を 1.1.x に backport、 CI 全 green で merge (merge commit `afd6646`)
6. **v1.1.1 re-tag** (16:26 UTC) — 旧 tag (`99a16df` を指す) を delete し、 新 HEAD `afd6646` に v1.1.1 を annotated tag で打ち直し
7. **v1.1.1 tag push #2** — release.yml run `25605955652` 起動
8. **clean SUCCESS** — Build / .vsix / GitHub Release 作成は SUCCESS、 Marketplace + Open VSX は `vars.PUBLISH_MARKETPLACE != 'true'` で skip (期待通り)、 Summary に 「Marketplace/Open VSX gated off」 ラベル表示

**過去パターンからの逸脱 (honest record)**:

entry 6.75 (v1.1.0 stable release、 May 07) では **同一の partial failure** が発生したが、 当時は **re-tag せず、 partial failure を歴史として受け入れ、 後続 release のために gate を整備** (entry 6.76) という forward-only path を選択していた。

本 release では:
- **destructive operation を実行**: `git push origin :refs/tags/v1.1.1` で remote tag 削除、 `gh release delete v1.1.1` で旧 GitHub Release 削除
- **commit 上の tag pointer を rewrite**: v1.1.1 が `99a16df` → `afd6646` に移動

これは過去パターン (entry 6.75 forward-only) からの逸脱。 ICMC 直前で session 内のみの状態で download 履歴がほぼなかったため pragmatic に決断したが、 公開済 tag の rewrite は通常避けるべき。

**今後の方針** (今回の判断を踏まえて):
- stable tag push 後の partial failure は、 今後は forward-only (v1.1.2 patch を切る) を default とする
- destructive な re-tag は **release が hour 単位以内、 download 実績が確認できる前** にのみ pragmatic option として残す
- いずれの場合も WORK_LOG に honest に記録する

**配布手段** (ICMC 期間):
- **GitHub Release から `.vsix` direct download → VS Code に手動 install**
- VS Code Marketplace / Open VSX は publisher 整備が完了する post-ICMC で publish (`gh secret set VSCE_PAT/OVSX_PAT` + `gh variable set PUBLISH_MARKETPLACE=true` でゲート開放)
- Yamato 氏が現地発表時に install 手順をデモするフロー

**v1.1.1 に含まれる主な変更** (#212):
- `LOOP()` 起動の bar boundary quantize (default `"bar"`、 `off`/`beat`/`bar`/`2bar`/`4bar`/`8bar` を選択可)
- LOOP 中の `play()` 差し替えが次サイクルで反映される seamless update
- `RUN()` は即時 (one-shot のトリガー感を維持)
- VS Code 補完から実装が削除済の `tick` / `key` を除去、 `quantize` を新規追加
- DSL spec §5 に Launch Quantize セクション追加

**スコープ外**:
- `fixpitch()` / `time()` の実装本体は #213 で対応 (post-ICMC、 PitchShift UGen / Warp1 / PV_PitchShift の比較検証から)
- LinkAudio + sc-link-audio plugin (Epic #187) は v1.2.0 line で post-ICMC release

**main への反映**:
- 1.1.x の WORK_LOG entry 6.77 (#216 backport) は frozen patch line に留め、 本 entry 6.88 (release record) で main 側に集約
- 1.1.x の 6.77 内容は本 entry の「Step 5」として再構成済、 重複扱いは可

**テスト結果**:
- 1.1.x: 300 passed / 23 skipped / 0 failed (build:clean + npm test、 May 09 18:09 JST)
- main (PR #215 merge 後): 385 passed / 23 skipped / 0 failed (CI 環境)

---

### 6.87 Issue #212: LOOP/RUN scheduler を quantize 起動に変更 (May 09, 2026)

**Date**: May 09, 2026
**Status**: ⏳ IN PROGRESS (PR pending)
**Branch**: `212-loop-run-quantize`
**Issue**: signalcompose/orbitscore#212
**Related Issue**: signalcompose/orbitscore#213 (`fixpitch()` / `time()` 実装、 別 PR)
**Commits**:
- `61ec990` feat(scheduler): quantize LOOP startup and play() updates to bar boundary
- `856fbca` fix(vscode): align completions with implementation, add quantize support
- `7f14096` test(scheduler): cover quantize math, LOOP boundary snap, and completion
- `aae395d` docs: document launch quantize, log #212 and CHANGELOG entry

**動機**: ライブコーディング中に `LOOP(seq)` を発火するとループの途中から音が出てしまい、 走っている他ループとリズムが噛み合わない。 `play()` の差し替えも即時で反映されてバーをまたぐ swap がリズムを崩す。 ユーザー要望:
> 本来であれば、その時に走っているループが終わり次第実行がされるというのが良いかと思っています。これはLOOPを回したまま各トラックの内容を変更した時にも同じことが言えます。

加えて VS Code 補完で `tick` `key` のような未実装メソッドが提案され、選ぶと runtime で `Method not found` を起こす。

**実装内容**:

1. **launch quantize の追加** (新 DSL method)
   - `global.quantize("off"|"beat"|"bar"|"2bar"|"4bar"|"8bar")` (default `"bar"`)
   - `seq.quantize(...)` で per-sequence override (未指定時はグローバル継承)
   - `packages/engine/src/core/global/quantize-manager.ts` 新規作成 (manager + `nextQuantizedTime` / `quantizeDurationMs` ヘルパー)
   - `packages/engine/src/core/sequence/parameters/quantize-manager.ts` 新規 (override 用)

2. **`loopSequence()` の起動を quantize 境界に揃える**
   - `LoopSequenceOptions.startTime` 追加。 `currentTime > startTime` のとき lead-in 分を最初の setTimeout に絞り込んで、 iteration 0 の events を `effectiveStart` で予約、 以降のサイクル境界を `effectiveStart + n × patternDuration` に揃える
   - `loopStartTime` も quantize 後の `effectiveStart` を返すよう修正 (post-trigger seamless update がバー境界基準で計算されるようにするため)

3. **`RUN()` は即時のまま** (one-shot のトリガー感を維持)

4. **LOOP 中の `play()` 差し替えを次サイクル待機に変更**
   - `seamlessParameterUpdate` の deferred list に `play` を追加 (従来は `tempo` / `beat` / `length` のみ)
   - `gain` / `pan` / `audio` / `chop` は即時のまま (mixer 操作は real-time の方が自然との判断)

5. **VS Code 補完 / ハイライトの整合性修正**
   - `completion-context.ts` から `tick` / `key` を削除 (実装が既に削除済 `Global.tick()` / `Global.key()`)
   - `quantize` を global / sequence 両方の補完に追加 (snippet で値を選択肢化)
   - `orbitscore-audio.tmLanguage.json` から `tick` / `key` を除去、 `quantize` を追加
   - `extension.ts` の hover で `fixpitch` を「(planned, see #213)」表記に変更
   - `MethodChainContext.hasQuantize` を追加して 1 chain 内で重複提案しない

6. **テスト追加 (+31 件)**
   - `tests/core/quantize.spec.ts`: QuantizeManager / SequenceQuantizeManager / `nextQuantizedTime` / polymeter での bar 計算など、 純粋ロジックを 18 件
   - `tests/core/loop-quantize.spec.ts`: `seq.loop()` 後の `scheduleSliceEvent.time` がグローバル小節境界に snap されること、 `seq.quantize("off")` override が global を上書きすること、 polymeter 下でも quantize は global grid 基準であることを 8 件
   - `tests/vscode-extension/completion-context.spec.ts`: quantize 補完 / `tick` `key` `fixpitch` `time` が出ないこと 5 件
   - `tests/core/seamless-parameter-update.spec.ts`: `play()` の期待ログを `(seamless)` から `(next cycle)` に修正

7. **DSL 仕様書 (`docs/core/INSTRUCTION_ORBITSCORE_DSL.md`) §5 に Launch Quantize セクション追加**
   - 値一覧 / scope / polymeter 時の grid 基準を明記
   - 「`RUN()` は常に即時」「LOOP 中の `play()` は next cycle、 `gain` / `pan` 系は即時」の例外規則を整理

**スコープ外 (別 Issue)**:
- `fixpitch()` / `time()` の実装本体は #213 で対応 (PitchShift UGen / Warp1 / PV_PitchShift の比較検証から)
- 旧 MIDI DSL grammar (`packages/vscode-extension/syntaxes/orbitscore.tmLanguage.json`) の整理は別途
- `.force` 修飾子による即時実行 escape hatch の活性化 (parser は受理するが interpreter で未使用) も別途検討

**バージョン**: 1.2.0 (Unreleased) — forward port from #214 (1.1.1 patch line)

**テスト結果**: 370 passed / 38 skipped / 0 failed (CI 環境)

---

## Archived sections

Older entries have been archived by month for readability:

- [2025-09](../archive/WORK_LOG_2025-09.md)
- [2025-10](../archive/WORK_LOG_2025-10.md)
- [2026-02](../archive/WORK_LOG_2026-02.md)
- [2026-04](../archive/WORK_LOG_2026-04.md)
- [2026-05](../archive/WORK_LOG_2026-05.md)
