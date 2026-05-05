---
title: "ADR-002 DSL v1 (MIDI) → v3 (Audio) pivot"
chapter-id: "adr-002"
verified-against: 0a4b598
verified-at: "2026-05-05"
status: draft
---

> **Note**: 本ページは 2026-05-05 時点での著者の reading の足跡です。code が真実、本ページはその時点の理解の snapshot に過ぎません。

# ADR-002 DSL v1 (MIDI) → v3 (Audio) pivot

OrbitScore DSL は 3 回のメジャーバージョンを経て現在の v3.0 に至っています。このバージョン番号の変化は単なる通し番号ではなく、それぞれが設計上の重要な転換点を表しています。本章では v0.1 → v1.0 → v2.0 → v3.0 の流れを DSL 仕様書とコミット履歴から読み解きます。

**重要**: ADR のタイトルが "v1 → v3 pivot" と書かれていますが、実際には 3 段階の変化です。**v1 → v2 が最大の pivot (MIDI → Audio)** であり、v2 → v3 は DSL 構文の洗練です。この章では 3 つすべての変化を扱います。

---

## 目次

1. [バージョン履歴の概略](#バージョン履歴の概略)
2. [v0.1 → v1.0: MIDI ベースの完成形](#v01--v10-midi-ベースの完成形)
3. [v1.0 → v2.0: MIDI → Audio への pivot (最大の転換)](#v10--v20-midi--audio-への-pivot-最大の転換)
4. [v2.0 → v3.0: DSL 構文の洗練](#v20--v30-dsl-構文の洗練)
5. [論文との整合](#論文との整合)
6. [機能消失のトレードオフ](#機能消失のトレードオフ)
7. [v1.0 MIDI DSL の仕様概略](#v10-midi-dsl-の仕様概略)
8. [v3.0 現行 DSL との対比](#v30-現行-dsl-との対比)

---

## バージョン履歴の概略

`docs/core/INSTRUCTION_ORBITSCORE_DSL.md` の Versioning セクションに公式の記録があります:

| バージョン | 日付 | 主な変化 |
|---|---|---|
| v0.1 | 2024-09-28 | 初期ドラフト仕様 |
| v1.0 | 2024-12-25 | Core 実装完了・100% テストカバレッジ (MIDI + Parser + Interpreter) |
| v2.0 | 2025-01-06 | **SuperCollider 統合・MIDI 廃止** |
| v3.0 | 2025-01-09 | アンダースコアプレフィックスパターン + 片記号方式 (unidirectional toggle) |

v1.0 から v2.0 まで **わずか 12 日**、v2.0 から v3.0 まで **3 日** という密度の濃いスプリントです。

> NOTE: unverified — 上記の日付 (v1.0: 2024-12-25, v2.0: 2025-01-06, v3.0: 2025-01-09) は `INSTRUCTION_ORBITSCORE_DSL.md` の仕様書に記載されている日付ですが、git コミット履歴のタイムスタンプとは一致しない場合があります。仕様書の「バージョン宣言日」と「コミット日」が異なる可能性があり、コミット履歴を直接確認した場合に矛盾が見つかることがあります。正確な実装時期はコミットログを参照してください。

---

## v0.1 → v1.0: MIDI ベースの完成形

v1.0 は「MIDI 出力ベースの音楽 DSL」として完成した版です。DSL の基本概念 (Parser, Interpreter, 時間計算器) が揃い、テストカバレッジが 100% に達しました。

v1.0 DSL の中心概念は **度数システム** と **sequence キーワード** です:

```
// v1.0 DSL の例 (docs/archive/DSL_SPECIFICATION_v1.0_MIDI.md より)
sequence kick {
  bus "IAC Driver Bus 1"
  channel 10
  meter 4/4 shared
  1 0 1 0   // 度数: 1=キック音、0=休符
}
```

特徴:
- **度数 0 = 休符** という独自の音楽的抽象化
- MIDI バス名とチャンネルを直接指定
- `meter N/D shared|independent` によるポリリズム/ポリメーター表現
- `sequence` キーワードでブロック記述

アーカイブファイルのヘッダーにある記録 (`docs/archive/DSL_SPECIFICATION_v1.0_MIDI.md:1-12`):

> アーカイブ日: 2025-10-06
> 理由: v2.0でSuperCollider Audio Engineに移行（MIDIベースからオーディオベースへ）

---

## v1.0 → v2.0: MIDI → Audio への pivot (最大の転換)

v1.0 → v2.0 が OrbitScore の設計上の最大の pivot です。MIDI 出力をオーディオファイル再生に置き換えました。

DSL 仕様書の Migration Notes:

> **Migration Notes from v1.0 to v2.0**:
> - MIDI output system has been completely replaced with SuperCollider audio engine
> - Old MIDI DSL syntax is no longer supported
> - All audio playback now goes through SuperCollider for professional-grade timing and quality

この pivot は非互換な変化です。v1.0 の `sequence` キーワードは廃止され、`var seq = init global.seq` という新しい構文に置き換わりました。MIDI バス・チャンネル指定という概念自体がなくなり、代わりに WAV/AIFF/MP3 のファイルパスを指定します。

v2.0 の新機能:
- SuperCollider オーディオエンジンによるプロフェッショナルグレードのタイミング (0-8ms ドリフト)
- グローバルマスタリングエフェクト: compressor, limiter, normalizer
- dB ベースのゲインコントロール (-60 to +12 dB)

> NOTE: unverified — v1.0 から v2.0 への意思決定プロセス (なぜ MIDI を捨てたか、どのような議論があったか) は、現時点でコミットメッセージや PR ディスカッションに残っていません。タイムライン上は sox → SuperCollider 移行 (ADR-001 で扱った変化) と v1.0 → v2.0 の DSL 更新がほぼ同時期に起きており、「SuperCollider が使えるようになったのでオーディオ出力に切り替えた」という自然な流れだったと考えられます。

---

## v2.0 → v3.0: DSL 構文の洗練

v3.0 は Audio エンジンという基盤の上での DSL 表現力の改善です。2 つの主要な変化があります。

### 1. アンダースコアプレフィックスパターン (Setting vs. Application)

v2.0 では設定メソッドを呼んでも「いつ反映されるか」が不明確でした。v3.0 では明確な規則を導入しています:

```js
// Setting-only methods (no underscore)
seq.audio("file.wav")     // Set audio file (no playback)
seq.play(1, 0, 1, 0)      // Set play pattern (no playback)

// Immediate application methods (with underscore)
seq._audio("file.wav")    // Set audio file AND apply immediately
seq._play(1, 0, 1, 0)     // Set play pattern AND start playback immediately
```

- `method()`: 値を保存するが即時適用しない (次の `run()` / `loop()` まで buffered)
- `_method()`: 値を保存し **かつ即時適用** する (ライブコーディングで再生中のループを差し替えるとき)

この区別はライブコーディングにとって重要です。セットアップ時は `audio()` / `chop()` / `play()` で設定を積み上げてから `loop()` で一括開始できます。演奏中にループを差し替えるには `_play()` で即座に反映できます。

### 2. 片記号方式 (Unidirectional Toggle)

v3.0 は `RUN()`, `LOOP()`, `MUTE()` という複数シーケンス制御の semantics を「片記号方式」に統一しました:

```js
LOOP(seq1, seq2)    // seq1 と seq2 を loop グループに設定 (それまで loop していたものは止まる)
LOOP(seq2, seq3)    // seq2 と seq3 に切り替える (seq1 は自動停止)
MUTE(seq2)          // seq2 をミュート (seq1 は MUTE 解除)
```

- 各コマンドは「現在のグループをこのリストで完全置換」する
- `STOP` キーワードは削除 (代わりに `LOOP()` で空リストを渡す、または別のシーケンスに切り替える)
- `UNMUTE` キーワードは削除 (別のシーケンスを `MUTE()` することで間接的に unmute)

これにより、ライブコーディング中に「どのシーケンスが動いているか」を常に明示的に宣言できます。

---

## 論文との整合

DSL の設計変更は ICMC (International Computer Music Conference) への発表と密接に関わっています。

v1.0 の度数システム (0=休符、1-12=半音階) はオリジナルの学術的貢献として論文に書ける概念でした。しかし v2.0 でオーディオファイル再生に pivot したことで、「度数システムによるポリリズム表現」という軸は薄くなり、代わりに「オーディオサンプルの高精度スケジューリングとライブコーディング環境」という軸が強くなりました。

> NOTE: unverified — 論文の最終的な位置付け (どの側面を学術的貢献として主張するか) は、現時点で公開されているドキュメントからは確認できません。ICMC 発表のステータスは README に "ICMC v1.1.0 release-ready" と記載されています。

---

## 機能消失のトレードオフ

v1.0 → v2.0 の pivot で消えた機能があります:

| v1.0 機能 | 状態 | 備考 |
|---|---|---|
| MIDI バス/チャンネル指定 | **廃止** | オーディオファイル再生に置き換え |
| 度数システム (0-12) | **廃止** | ピッチ表現が WAV ファイル選択に変わった |
| 微分音表現 (`1.5` 等) | **廃止** | SuperCollider で再実装は可能だが未実装 |
| `meter N/D shared|independent` | **形を変えて継続** | `beat(N by D)` に改名、ポリメーター概念は保持 |
| MPE モード | **廃止** | MIDI 依存の機能 |

一方で v2.0 で**新たに得られた**機能:
- WAV / AIFF / MP3 / MP4 の直接再生
- `chop()` によるオーディオスライシング
- dB ベースのゲインコントロール
- グローバルマスタリングエフェクト (compressor, limiter, normalizer)
- ライブコーディング中のシームレスなパターン差し替え

また、v3.0 の `updateDiagnostics()` には v1.0 MIDI 構文の残滓への警告が実装されています。`sequence ` キーワードを含む行は `DiagnosticTag.Deprecated` でハイライトされます:

```typescript
// packages/vscode-extension/src/extension.ts:1244-1253
    // Check for deprecated syntax (old MIDI DSL)
    if (line.includes('sequence ') && !line.includes('//')) {
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(i, 0, i, line.length),
        'Deprecated: Use "var seq = init GLOBAL.seq" instead of "sequence"',
        vscode.DiagnosticSeverity.Warning,
      )
      diagnostic.tags = [vscode.DiagnosticTag.Deprecated]
      diagnostics.push(diagnostic)
    }
```

v1.0 時代のコードを開いた時に取り消し線スタイルで警告が表示される、という実装上の歴史の痕跡です。

---

## v1.0 MIDI DSL の仕様概略

アーカイブ (`docs/archive/DSL_SPECIFICATION_v1.0_MIDI.md`) からの引用です。現在の v3.0 がいかに異なるかの対比のために残します。

v1.0 のグローバル設定:
```
key C
tempo 120
meter 4/4 shared
randseed 42
```

v1.0 のシーケンス定義:
```
sequence kick {
  bus "IAC Driver Bus 1"
  channel 10
  meter 4/4 shared
  1 0 1 0   // 度数: 1=C音、0=休符
}
```

イベント記法:
- `1` → C (MIDI note)
- `2` → C#
- `0` → 休符 (無音)
- `1.5` → C と C# の中間 (微分音、ピッチベンドで表現)
- `1r` → [C+0, C+0.999] のランダム値

---

## v3.0 現行 DSL との対比

| 側面 | v1.0 (MIDI) | v3.0 (Audio) |
|---|---|---|
| 出力 | MIDI バス経由 | SuperCollider + WAV ファイル |
| シーケンス定義 | `sequence name { ... }` | `var seq = init global.seq` |
| 音符表現 | 度数 0-12 | なし (音高はファイル選択で決まる) |
| リズム表現 | 度数列で暗黙に定義 | `.chop(N)` + `.play(...)` パターン |
| マルチシーケンス制御 | なし (記述なし) | `RUN()`, `LOOP()`, `MUTE()` 片記号方式 |
| 即時適用 | なし | `_method()` アンダースコアパターン |
| ファイル参照 | なし | `.audio("file.wav")` |

v3.0 では「どの音を出すか」はファイル名で決まり、「どのタイミングで出すか」は `chop()` と `play()` で決まります。v1.0 の度数システムが担っていた「音高のシーケンシング」という側面は、オーディオサンプラー的なアプローチに置き換わりました。

---

## 関連用語

- [DSL (Domain-Specific Language)](/glossary#dsl) — 本 ADR の主題。v1.0 MIDI DSL から v3.0 Audio DSL への進化
- [アンダースコアプレフィックスパターン](/glossary#アンダースコアプレフィックスパターン) — v3.0 で導入した `method()` vs `_method()` の区別
- [片記号方式](/glossary#片記号方式) — v3.0 の `RUN()` / `LOOP()` / `MUTE()` セマンティクス
- [RUN](/glossary#run) — v3.0 で導入した片記号方式の 1 回再生コマンド
- [LOOP](/glossary#loop) — v3.0 で導入した片記号方式のループコマンド
- [MUTE / UNMUTE](/glossary#mute--unmute) — v3.0 で `UNMUTE` キーワードを廃止し片記号方式に統一
- [sequence (旧キーワード)](/glossary#sequence-旧キーワード) — v1.0 の `sequence name { }` 構文。v2.0 で廃止。`DiagnosticTag.Deprecated` で警告表示
- [init](/glossary#init) — v2.0 で `sequence` キーワードを置き換えた `var seq = init global.seq` 構文
- [ICMC (International Computer Music Conference)](/glossary#icmc-international-computer-music-conference) — DSL 設計変更と密接に関わる発表目標

## 関連 ADR

- [ADR-001 SuperCollider ベース実装の選択](/decisions/adr-001-supercollider) — v1.0 → v2.0 pivot (MIDI → Audio) を支えたオーディオエンジン採用の意思決定
- [ADR-003 scsynth bundle strict mode](/decisions/adr-003-scsynth-bundle) — v2.0 以降の Audio DSL を動かす scsynth の配布戦略

## 次の深掘り候補

- v2.0 pivot の意思決定記録の発掘 — PR やコミット本文に詳細な議論が残っていないか確認
- 度数システムの再実装可能性 — SuperCollider の SynthDef でピッチ変調付きサンプル再生を実現できるか
- `randseed` の現行サポート状況 — v1.0 にあったランダム性制御が v3.0 に引き継がれているか
- ポリメーターの実装詳細 — `beat(N by D)` での independent タイムベースが v1.0 の `meter N/D independent` と同等かどうか
- 論文での v1.0 度数システムの扱い — 廃止された機能が学術的貢献として論文に含まれるか

---

## Sources

- `docs/core/INSTRUCTION_ORBITSCORE_DSL.md:734-769` — Versioning セクション: v0.1-v3.0 の変更履歴と Migration Notes
- `docs/core/INSTRUCTION_ORBITSCORE_DSL.md:362-415` — v3.0 アンダースコアプレフィックスパターンの仕様
- `docs/core/INSTRUCTION_ORBITSCORE_DSL.md:233-257` — 片記号方式 (unidirectional toggle) の仕様
- `docs/archive/DSL_SPECIFICATION_v1.0_MIDI.md` — v1.0 MIDI DSL 仕様書アーカイブ (2025-10-06 アーカイブ)
- `packages/vscode-extension/src/extension.ts:1244-1253` — `sequence ` キーワードの deprecated 警告実装
- commit `081a474` — SuperCollider 統合と sox 廃止 (v2.0 の技術的基盤)
- commit `cfa0381` — Web Audio API 削除・SuperCollider 一本化 (PR #31)
