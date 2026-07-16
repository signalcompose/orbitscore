# Dev Learning Site Refresh Plan — 2026-07

**Status**: 計画（第一段・Issue [#451](https://github.com/signalcompose/orbitscore/issues/451)）
**非公開ディレクトリ**: `sites/dev/.plan/` は `srcExclude` 対象外なので `.vitepress/config.ts` の
`srcExclude` に `.plan/**` を追加してから章の fan-out に着手すること（本ファイル自体が
VitePress のビルド対象に混入しないようにするための前提条件）。

> 本計画は [`docs/development/DEV_LEARNING_SITE.md`](../../../docs/development/DEV_LEARNING_SITE.md)
> の 2026-07-17 決定（バイリンガル必須・step-by-step = E2E 検証二重役割・ローカル配信 MCP/OrbitStudio）
> を実装するための章立てである。決定そのものはそちらが正本。

---

## 1. なぜ今リフレッシュが必要か

既存 5 章群（orientation / pipeline / scheduling / audio / editor + decisions）は 2026-05 時点の
**TypeScript engine + SuperCollider** 構成を記述しており、以下が完全に欠落している:

- Rust engine（`rust/crates/orbit-audio-daemon` 他）への移行（cutover #108、`57c780f`）
- OOP（out-of-process）children アーキテクチャ（CLAP/VST3 effect・instrument child、shm transport）
- M2 IPC event wire（`NeutralEvent` / named tagged union、Issue #398）
- capture seam（`ORBIT_CAPTURE_WAV`、realtime WAV capture）
- plugin hosting DSL（`global.effect()` / `seq.instrument()`）と CLAP/VST3 フォーマット対応

2026-07 時点のコードベースの中核（daemon・plugin hosting・M2 IPC）が学習サイトに一切反映されて
いない。これは DEV_LEARNING_SITE.md §1 が警告する「ブラックボックス債務」がまさに rust-engine
以降の実装で累積している状態を意味する。

---

## 2. 新章群

### 2.1 rust-engine 章群（`sites/dev/rust-engine/` + `sites/dev/en/rust-engine/`）

| # | 章 | 内容 | 主要ソース |
|---|---|---|---|
| RE-1 | daemon アーキテクチャ概観 | `orbit-audio-daemon` のプロセス構造、TS engine との境界（IPC 経由）、boot〜teardown ライフサイクル | `rust/crates/orbit-audio-daemon/src/`、`docs/development/POST_2.0_MASTER_PLAN.html` |
| RE-2 | OOP children と shm transport | in-process（楽器）vs out-of-process（3rd-party plugin/effect）の使い分け、`orbit-audio-sandbox` の共有メモリ (`PipelinedInstrumentHost`, `open_shared`, `region_ptr`)、watchdog/respawn 供給 | `rust/crates/orbit-audio-sandbox/`、`rust/crates/orbit-audio-daemon/src/outproc_instrument.rs`、`outproc_effect.rs` |
| RE-3 | M2 IPC event wire | `NeutralEvent` named tagged union 設計（候補A採用の経緯）、note on/off の port/channel/key モデル、`event_decode_error_count` 等の観測ミラー | [[vst3-m2-ipc-wire-design-decision]] 相当の実装 = `rust/crates/orbit-audio-sandbox/src/`、Issue #398 |
| RE-4 | capture seam | `ORBIT_CAPTURE_WAV`、`PostMixSink`、realtime WAV writer（自前 minimal RIFF）の設計と検証手段 | WORK_LOG 6.24x 台（capture seam 実装回）、`docs/development/POST_2.0_MASTER_PLAN.html` |

### 2.2 plugin-hosting 章群（`sites/dev/plugin-hosting/` + `sites/dev/en/plugin-hosting/`）

| # | 章 | 内容 | 主要ソース |
|---|---|---|---|
| PH-1 | **概観（パイロット章・本 Issue で執筆済み）** | DSL 構文（`global.effect` / `seq.instrument`）、フォーマット対応表、OOP hosting の全体像 | `packages/engine/src/core/global/plugin-resolver.ts`、`plugin-instrument-manager.ts`、`plugin-effect-manager.ts` |
| PH-2 | CLAP instrument hosting | `orbit-clap-instrument-child` の内部、note ring、attach/respawn | `rust/crates/orbit-audio-daemon/src/outproc_instrument.rs`、WORK_LOG 6.25x |
| PH-3 | VST3 instrument hosting | `Vst3InstrumentProcessor`、NOTE_END 非対称の吸収（synthetic NoteEnd）、child 選択ロジック（`child_exe_for_attach`） | `rust/crates/orbit-vst3-host/`（Stage 1）、`outproc_instrument.rs:106-167`、WORK_LOG 6.258 |
| PH-4 | effect hosting（CLAP master insert） | `global.effect()` の DoD 配線、LinkAudio との排他 | `packages/engine/src/core/global/plugin-effect-manager.ts`、WORK_LOG 6.256-6.257 |
| PH-5 | Epic #424 全体像 | effect × instrument 共存、DoD 実機達成の経緯 | WORK_LOG 6.256-6.258、Epic #424 |

---

## 3. Step-by-step チュートリアル trail（= E2E テストタスク）

DEV_LEARNING_SITE.md の新決定「カリキュラム = 実機再現可能な手順の連鎖 = 網羅的 E2E テスト」を
体現する trail。各章末に「Try it」節を置き、以下の順で積み上げる。実機コマンド・期待客観値は
執筆時に一次情報（daemon 実行結果・`ORBIT_CAPTURE_WAV` 出力）で検証してから記載する。

| # | Try it | 章 | 期待される客観値（検証必須・未検証は draft のまま明記） |
|---|---|---|---|
| 01 | 音を出す（daemon boot → 単音再生） | RE-1 | capture peak が既知振幅と一致（テストトーン相当） |
| 02 | audio DSL（audio file 再生） | 既存 `audio/` 章の再検証 | 既存章の verified-against 更新（下記 §4） |
| 03 | Pitch DSL + MIDI 出力 | 既存 v1.1 Pitch DSL 章（未着手なら新設） | note on/off イベント列が期待と一致 |
| 04 | `seq.instrument("...clap")` | PH-2 | CLAP gated テスト同等の実機 RUN。capture peak = 既知振幅（synth oracle 依存） |
| 05 | `seq.instrument("SynthOracle.vst3")` | PH-3 | **capture peak = 0.25000**（WORK_LOG 6.258 実機 E2E で確認済みの厳密一致値） |
| 06 | `global.effect("...clap")` | PH-4 | master insert 適用後の波形差分（未検証・執筆時に一次情報で確定） |
| 07 | capture 検証（`ORBIT_CAPTURE_WAV` を使った自己検証ループ） | RE-4 | WAV ファイルが生成され、peak 値が daemon ログの `post_peak` と一致 |

**設計原則**: 各 Try it は単独で再現可能なコマンド列（daemon 起動〜.orbs 実行〜capture 確認）とし、
これを CI/gated テストに転用できる形で書く（learning note と E2E テストタスクの二重利用）。

---

## 4. 既存章の verified-against 更新対象

以下は 2026-05 時点の commit で `verified-against` が固定されており、rust-engine 移行後の実態と
乖離している可能性が高い。本計画の fan-out で再検証・更新する:

- `sites/dev/orientation/architecture-overview.md`（TS engine 前提の全景図 → rust-engine 反映要）
- `sites/dev/audio/supercollider.md`（SC 経路は現在も併存するか要確認。daemon 経路との関係を追記）
- `sites/dev/scheduling/*`（event queue / transport が rust-engine 側でどう扱われるか要確認）

verified-against 更新は「解消」ではなく「drift の document」（DEV_LEARNING_SITE.md §1 の artifact
framing）。乖離が見つかっても即修正せず、まず現状を記述する。

---

## 5. ja/en 同時執筆の作業単位分割（後続 fan-out 用）

2026-07-17 決定によりバイリンガル必須。1 writing agent = 1 章 = ja + en 両方を同一ターンで担当
（ja だけ書いて en を後回しにする分割は禁止 — drift を生む）。fan-out 単位:

| 作業単位 | 章 | 備考 |
|---|---|---|
| Unit A | RE-1 + RE-2（daemon 概観 + OOP children） | **済（Issue #451・ja/en 各 index.md + oop-children.md）** |
| Unit B | RE-3 + RE-4（M2 IPC + capture seam） | **済（Issue #451・ja/en 各 insert-bus.md + capture-verification.md）** |
| Unit C | PH-1（概観・**本 Issue でパイロット執筆済み**） | 他 Unit のテンプレートとして先行公開 |
| Unit D | PH-2 + PH-3（CLAP/VST3 instrument hosting） | 依存: Unit C の DSL 構文説明を前提にできる |
| Unit E | PH-4 + PH-5（effect hosting + Epic 全体像） | 依存: Unit D 完了後（instrument/effect 対比のため） |
| Unit F | Try it trail 07 本（§3）+ 既存章 verified-against 更新（§4） | 全 Unit 完了後、横断で実施 |

各 Unit のディスパッチ時は `.claude/skills/vitepress-learning-site/references/writing-agent-template.md`
のプロンプト skeleton + DEV_LEARNING_SITE.md §4 の verbatim 規律 + 「ja/en 同時」を明記する。

---

## 6. Sources 候補

- `docs/development/POST_2.0_MASTER_PLAN.html`（rust-engine アーキテクチャの正本）
- `docs/development/WORK_LOG.md` 6.24x 台（capture seam realtime 配線）〜 6.258（VST3 instrument
  production）— 特に 6.256（OOP effect × instrument 共存）・6.257（DoD 配線）・6.258（VST3 横展開）
- `rust/crates/orbit-audio-daemon/src/`（daemon 本体）
- `rust/crates/orbit-audio-sandbox/src/`（shm transport、M2 IPC event wire 実装）
- `rust/crates/orbit-vst3-host/`（VST3 host 側、Stage 1）
- `packages/engine/src/core/global/plugin-resolver.ts`、`plugin-instrument-manager.ts`、
  `plugin-effect-manager.ts`（DSL 面）
- Issue #398（M2 IPC wire 設計）、Epic #424（plugin hosting DoD）、Issue #413（本番トラック retarget）、
  Issue #450（MCP サーバ `/docs/`）

---

## 7. 本計画のスコープ外（第一段では着手しない）

- Pitch DSL v1.1 / Session Log (.orbslog) / WCTM 章群（Epic #224・別トラック。学習サイト章化は
  WCTM 実装が Stage 3 に進んでから判断）
- ローカル配信（MCP サーバ `/docs/`・OrbitStudio ワンクリック）の実装自体（Issue #450 側で対応。
  本計画は章コンテンツのみ）
- cross-LLM-family audit への格上げ（DEV_LEARNING_SITE.md §5 Future Upgrade のまま未着手）
