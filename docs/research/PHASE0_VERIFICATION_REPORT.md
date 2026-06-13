# Phase 0 事前検証レポート — v1.1 Pitch DSL + WCTM

**Date**: 2026-06-13
**Issue**: signalcompose/orbitscore#226
**Branch**: `226-phase-0-verification`
**Epic**: #224
**正本**: `docs/specs-v2/IMPLEMENTATION_INSTRUCTIONS.html` §4 Phase 0

---

## 結論サマリ

プロダクションコードを書く前に、仕様が依拠する4つの前提を検証した。
**仕様の前提を崩す結果はなかった**（0-4 は spec が織り込み済みの分岐で、停止条件には該当しない）。
→ **Phase R / Phase 1 へ進行可。**

| # | 検証項目 | 判定 | 後続への影響 |
|---|---|---|---|
| 0-1 | `(1)(2)` タプル並置の現行挙動 | ✅ 前提成立（兄弟展開） | Phase 2 にパーサー拡張の含意（後述、想定内） |
| 0-2 | `quantize("bar")` の play() 差し替え | ✅ 前提成立（実装済み・テスト緑） | Phase 1 / L1 の前提が満たされている |
| 0-3 | `@julusian/midi` IAC 列挙・送出 | ✅ 動作確認（実 IAC 送出成功） | Phase 1 にポート名ローカライズの実装メモ |
| 0-4 | Link 追従スケジューリングの現状 | ⚠️ オーディオ受け渡しのみ | **W-Link に「Link 追従スケジューリング」を実装項目として昇格**（spec 織り込み済み） |

---

## 0-1: `(1)(2)` タプル並置の現行パーサー挙動

**問い**: カンマなしのグループ並置 `(1)(2)` は兄弟展開されるか（PITCH_DSL_SPEC §3.3 の前提）。

**方法**: コード読解 + 再現テスト `tests/phase0/juxtaposition-verification.spec.ts`（4件）。

**結果**:

- **兄弟展開される（パースエラーにならない）**。`parse-statement.ts:383-389` が `RPAREN` 直後の `LPAREN` を「`// Special case: consecutive nested elements like (1)(2)`」として意図的に連続処理。`play((1)(2)(3))` → 3つの兄弟 `{type:'nested'}` 要素。
- **タイミングモデル**: `play()` のトップレベル要素は `effectiveBarDuration = barDuration × length` を等分する（`tempo-manager.ts:99`、`calculate-event-timing.ts:35` の `barDuration / elements.length`）。`seq.length(N)` + トップレベル N グループ → **各グループ = 1小節**。これは spec §9.1 が `piano.length(4)` + 4グループを使う記法と一致する。
- **並置とカンマ区切りはタイミング同一**: パーサーは `(1)(2)` と `(1), (2)` を構造的に同一の args 配列へフラット化する（テストで実証）。

**判定**: ✅ **前提成立。** spec §3.3 の「並置されたグループは時間的には兄弟（各々が自身のスロットを保持）」は現行挙動と一致。

**⚠️ Phase 2 への含意（前提崩壊ではない・想定内）**:
現状の AST は「並置 `(A)(B)`」と「カンマ区切り `(A), (B)`」を**区別せずフラット化**している。
spec §3.3 の `.root()` スコープ規則 —「チェーンは並置を閉じる」「カンマがスコープ終端」「チェーン直後のカンマなし `(` はパースエラー」— を実装するには、**この区別を AST に保持するパーサー拡張が Phase 2 で必要**。
これは spec が前提とするパーサー作業（§5 Delegation: main/Opus 直列）であり、Phase 0 の停止条件には該当しない。Phase 2 の設計時に「並置グループ列」を1つのスコープ単位として束ねる AST ノードを導入する想定。

---

## 0-2: `quantize("bar")` の `play()` 差し替えタイミング

**問い**: ライブコーディング中の `play()` 再評価が「次の小節頭で反映」されるか（ユーザー認識では未確認）。MIDI note-off と WCTM の小節整列、L1 の effect スタンプの前提。

**方法**: コード読解 + 既存テスト実行（`loop-quantize.spec.ts` 8件 / `seamless-parameter-update.spec.ts` / `quantize.spec.ts` 17件 = 計34件）。

**結果**:

- **実装済み・正常動作**。`sequence.ts:147-168` `seamlessParameterUpdate()` で、LOOP 中の `play` は `deferToNextCycle` リスト（`['tempo','beat','length','play']`）に含まれ、**即時再スケジュールせず return**。新パターンは `stateManager` に保存済みで、次のループタイマーコールバック（現サイクル終端 = 次の小節頭）で適用される。
- `gain` / `pan` / `audio` / `chop` は即時反映（ミキサー操作はリアルタイムが自然との設計判断）。
- LOOP 起動時も `nextQuantizedTime()`（`quantize-manager.ts:61-73`、`Math.ceil(currentTime / durationMs) * durationMs`）で次の quantize 境界にスナップ。
- 関連 Issue #212 の修正は PR #215 で main にマージ済み（即時差し替えでリズムが小節をまたぐ問題は解消済み）。

**判定**: ✅ **前提成立。** スケジューラ層で「play() 差し替え = 次サイクル反映」「LOOP = 小節境界スナップ」が実装・テスト済み。

**注**: 本検証はスケジューラ（TS）層。MIDI note-off の実発音タイミングは Phase 1 で実装・検証する（effect スタンプ＝解決済み効果時刻は、この `nextQuantizedTime` の戻り値を流用できる）。

---

## 0-3: `@julusian/midi` の IAC 列挙・送出

**問い**: `@julusian/midi` が Node 22 + macOS arm64 で動作し、IAC Bus を列挙・送出できるか。

**方法**: 隔離環境（`$TMPDIR`）に `@julusian/midi` をインストールし、ロード・ポート列挙・送出スクリプトを実行。

**結果**:

- **環境**: Node v22.17.1 / macOS arm64。`@julusian/midi@3.6.1` が prebuild `midi-darwin-arm64` 込みでインストール成功（ネイティブビルド不要）。
- **モジュールロード**: OK（`Output` / `Input` コンストラクタ利用可）。
- **ポート列挙**: OK（出力12ポート検出）。
- **送出経路**: `openVirtualPort()` + `sendMessage()` + `closePort()` がエラーなく動作。
- **実 IAC 送出**: IAC ドライバを online にした状態で再実行 → ポート `"IACドライバ バス1"`（index 0）を検出、`note-on C4 vel96` / `note-off` の送出に成功。

**判定**: ✅ **動作確認。** `@julusian/midi` は Phase 1 の MIDI 出力ライブラリとして要件を満たす。

**Phase 1 実装メモ（重要）**:
1. **ポート名はロケール依存**。日本語 macOS では IAC ポートは **`"IACドライバ バス1"`** であり、spec §1 の例 `"IAC Driver Bus 1"` とは一致しない。portName の解決は **言語非依存の部分文字列**（例: `/iac/i`）でフォールバックするか、ユーザーに実ポート名の指定を促す設計が必要。`/iac/i` での substring match は実機で当たることを確認済み。
2. **`openVirtualPort()` が利用可能**。IAC Driver の手動 online 化を必須にせず、OrbitScore 自身が仮想出力ポートを作る選択肢がある（UX 改善の提案。Known Decisions の再設計ではなく Phase 1 の実装オプションとして記録）。
3. IAC ドライバが Audio MIDI 設定で **「装置はオンライン」未チェックだとポートが公開されない**。初回セットアップのドキュメント／診断対象。

---

## 0-4: Link 追従スケジューリングの現状

**問い**: 現行エンジンの Link 統合がスケジューリングまで beat/phase に従うか、LinkAudio のオーディオ受け渡しのみか（WCTM_SYSTEM_SPEC §2 の前提）。

**方法**: `packages/sc-link-audio`（C++ plugin）と `packages/engine` のスケジューラ／Transport をコード読解、`docs/research/LINK_AUDIO_API.md` の設計意図を確認。

**結果**:

- **現行の Link 統合は (B) オーディオ受け渡しのみ。スケジューリングは内部クロック独立。**
- エンジンのスケジューラは `Date.now()` + `setInterval(1ms)`（`event-scheduler.ts:198,204`）、ループは `setTimeout(patternDuration)`（`loop-sequence.ts:101`）、小節長は `60000 / tempo` の純粋算術（`quantize-manager.ts:39`）。**Link の beat/phase を参照する経路はエンジン TS 側に皆無**。
- Link の `beatAtTime()` / `captureAudioSessionState()` は **C++ plugin の audio thread 内**（`orbit_link_audio_out.cpp:166-169`）で、オーディオバッファを Live の timeline にキューするためのメタデータとしてのみ使用。
- `LINK_AUDIO_API.md` も「LinkAudio = オーディオ伝送路（出力モード宣言）。スケジューリングは内部クロックが担う」と一貫して記述。

**判定**: ⚠️ **オーディオ受け渡しのみ。** spec の想定どおり「後者」だった。

**後続への影響（W-Link、spec 織り込み済み）**:
WCTM_SYSTEM_SPEC §2 / IMPLEMENTATION_INSTRUCTIONS Phase 0-4 は「後者なら『Link 追従スケジューリング』を新規実装項目に昇格」と明記している。
→ **#234 W-Link のスコープを確定**: エンジンを Link ピアとして beat/phase に追従させ、スケジューリング（`loop-sequence` / `event-scheduler` の時刻決定）を Link の transport に同期させる実装が **新規に必要**。結合度パラメータ・信頼度ゲートはその上に乗る。
これは Pitch DSL（Phase 1-3）のクリティカルパスとは独立。Phase 0 の停止条件（仕様前提の崩壊）には該当しない。

---

## 全体結論と次フェーズへの引き継ぎ

- **停止条件には1件も該当しない。** 4項目すべて、前提成立または spec 織り込み済みの分岐。
- **Phase R / Phase 1 へ進行可。**

### 後続フェーズに引き継ぐ事項

| 引き継ぎ先 | 内容 |
|---|---|
| **Phase 2 (#230)** | パーサーで「並置」と「カンマ区切り」を AST レベルで区別する拡張が必要（`.root()` スコープ規則の前提）。0-1 参照 |
| **Phase 1 (#228)** | (a) portName 解決はロケール依存に対応（`/iac/i` フォールバック）。(b) `openVirtualPort()` 採用を検討。(c) effect スタンプは `nextQuantizedTime()` の戻り値を流用可。0-2 / 0-3 参照 |
| **L1 (#229)** | effect スタンプ＝解決済み効果時刻は 0-2 の `nextQuantizedTime` 経路で取得可能 |
| **W-Link (#234)** | 「Link 追従スケジューリング」を新規実装項目として確定（現状はオーディオ受け渡しのみ）。0-4 参照 |

### 検証成果物（再現可能）

- `tests/phase0/juxtaposition-verification.spec.ts` — 0-1 の現行挙動を固定する回帰テスト（4件）
- 0-2 は既存テスト `tests/core/{loop-quantize,seamless-parameter-update,quantize}.spec.ts` で担保
- 0-3 の MIDI スモークスクリプトは隔離環境（`$TMPDIR`）で実行（プロジェクトには未追加。Phase 1 で正式に依存追加する）
- 0-4 はコード読解（スケジューラに Link 参照なし）が根拠
