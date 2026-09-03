# 設計: 時刻付き非オーディオイベントの共通 queue（#428 / #680 / #674 / #460）

**対象 issue**: #428（note の sample-accurate 化・`foundation`）/ #680（プラグインパラメータを DSL から動かす）/ #674（OSC 送信・時間軸だけ揃える）/ #460（関数的オートメーション・本 queue の消費者）
**関連**: #506（**SC.10.9 で撤回済み**・#680 へ統合）/ #522（param スコープは #680 へ移管）/ #213（`fixpitch()`/`time()` — **本 queue に乗らない**・§3.9）/ #606（RUN 終端の note-off flush・§6）/ #672（DSL Plugin 契約・`docs/design/672-plugin-boundaries-design.md`）
**正本**: 地図 `docs/planning/DEVELOPMENT_MAP.md` §4.D（700-734 行）/ §4.E（735-797 行）/ §7 (1)。DSL 表面の正本は `docs/core/INSTRUCTION_ORBITSCORE_DSL.md`（改訂案は §8）
**状態**: 設計（実装しない）・2026-09-03・main `ca176f0` 実測

---

## 0. 裁定・確定事項（再議論しない）

| # | 裁定 | 出どころ |
|---|---|---|
| 1 | **#428 を foundation にし、#680 の engine 側は #428 の queue に乗せる**（別々に作ると note と param で 2 本のタイムドキューができる） | 地図 §4.D / #428 コメント 2 / #680 コメント 2 |
| 2 | **#674（OSC）は queue を共有しない**（実行系が違う・RT 外）。**DSL 表面と時間軸は揃える** | 地図 §4.D 表 / #428 コメント 2 |
| 3 | **DSL はプレーン値**（案 B）。VST3 は `getParamValueByString("-6 dB")` で変換 | owner 決定 2026-09-02・#680 本文 |
| 4 | **#506 のメソッド形 DSL は撤回済み**。残る価値（名前付きパラメータ）は #680 が持つ | SC.10.9 / 地図 §6.1 / #506 コメント 1 |
| 5 | **#460 は #680 の上に建つ**（#680 = 位置に置く離散値 / #460 = 区間に置く連続曲線。同じパラメータ面・同じ wire） | 地図 §4.D 表 / #460 コメント 1 |
| 6 | **DSL 表面は 3 件とも owner 確認が要る**（#428 / #680 / #674） | memory `dsl-surface-needs-owner-confirmation` / 地図 §4.D |
| 7 | **audio シーケンスの `play()` 意味論は変更しない** | CLAUDE.md 運用規則 5 |
| 8 | v1 で #680 を「即時 param set」として先に出す場合、note と同じく `offset=0` で揃うので不整合は生まれない | 地図 §4.D 末尾 |

---

## 1. 到達点（1 文）

**note / param（将来: tempo・mode）は「daemon transport 秒の時刻」を持つ 1 種類の wire メッセージで送られ、daemon の RT 側は 1 本の時刻付き queue から「このブロックに属するもの」だけを取り出して `sample_offset` を計算し、既存の `EventRecord` 窓へ載せる。**

---

## 2. 現在地（一次情報・本書が変えるもの）

| 事実 | 根拠（`path:line`） | 本書 |
|---|---|---|
| note は**即時メソッド**。wire に時刻が無い | `session.rs:2365` `plugin_note_spec` / `:2392` `handle_plugin_note` | `ScheduleEvents` を新設（§3.1） |
| note は `sample_offset: 0` 固定で `NeutralEvent` へ変換される | `engine_wrap.rs:7136-7168`（`NoteOn`/`NoteOff` とも `sample_offset: 0`） | 時刻→フレーム解決後に offset を計算（§3.2） |
| `PlayAt` は `time_sec` を持ち、core が `start_frame` に変換する | `session.rs:2088` / `engine_wrap.rs:7942` `play_at` / `scheduler.rs:235` `start_frame = start_sec * sr` | note/param も同じ座標系に乗せる |
| M2 wire の `EventRecord` は `sample_offset: u32` を**既に持つ** | `events.rs:150-156` | 変えない（載せるだけ） |
| M2 wire は `ParamValue { sample_offset, param_id, addr, value }` を**既に持つ** | `events.rs:226-231` / `KIND_PARAM_VALUE = 6` `:53` | 変えない |
| **CLAP instrument child は `ParamValue` を既にサンプル精度で適用する** | `orbit-clap-host/src/events.rs:182-198`（`ParamValueEvent::new(sample_offset, …)`） | 経路が既にある = #680 の instrument 側は wire を通すだけ |
| **VST3 instrument は param を一切受けない** | `orbit-vst3-host/src/lib.rs:1437` `inputParameterChanges: ptr::null_mut()` / `orbit-vst3-instrument-child/src/main.rs:215` `classify_event` は note 3 種のみ | #680 で追加（§3.5） |
| **VST3 の param queue は 1 点・offset 0 固定・`addPoint` は失敗を返す** | `lib.rs:2534` `single_gain` / `:2653` `getPointCount → 1` / `:2660-2672` `getPoint` は `*sample_offset = 0` / `:2675` `addPoint → kResultFalse` | #680 で N 点化（§3.5） |
| **effect ラックの param は event ではなくコマンドメールボックス経由**（ブロック境界・chain 単位） | `transport.rs:314` `CMD_APPLY_CHAIN` / `orbit-effect-rack-child/src/macos.rs:70` `apply_params` / `orbit-clap-host/src/effect.rs:239` `ParamValueEvent::new(0, …)` | v1 は据え置き（§3.6） |
| effect ラックの catalog プラグインは param 設定を**拒否する** | `macos.rs:140` / `:196` `"catalog plugin parameter updates are staged with #522"` | #680 が置き換える |
| `plugin()` の DSL は param 名前付き引数を**拒否する** | `signal-chain/rack.ts:98-106`（`enabled` / `format` / `vendor` のみ許可） | #680 の DSL 表面（owner 確認・§11） |
| 標準プラグイン `Gain` の param 名は DSL 引数名と 1:1 | `orbit-std-gain/src/lib.rs:19-22` / `plugin_main.rs:33` `parameter_id_by_name` | 名前解決は**child の main スレッド**で行う（§3.5） |
| RT は event ring を**毎ブロック全量 drain** する | `outproc_instrument.rs:385-387` `while let Ok(event) = self.event_rx.pop()` | 時刻 gate を前段に置く（§3.2） |
| `EventBackingRing` は **窓あふれ**の受け皿。持ち越し分は `sample_offset` を 0 に書き換える | `instrument_host.rs:274-277` / `event_backing_ring.rs:63` `drain_into` | **変えない**（役割が違う・§3.2） |
| ブロック先頭フレームは RT に届いている | `output.rs:264-267` `BlockTransport { cursor_frames, sample_rate }` / `:751` で毎コールバック前進 | 時刻→フレーム変換の基準（ただし §3.3 の落とし穴） |
| 🔴 **engine scheduler の cursor は lock 競合時に前進しない** | `engine.rs:163-177` `with_scheduler` / `:205-225` `render_multi_feeds`（`try_lock` 失敗で zero-fill・closure 未実行）/ `scheduler.rs:458` `cursor_frames += frames` | `PlayAt` の時計と `BlockTransport` が**ずれる**（§3.3） |
| note の TS 側は 5 ms poll・発火時に即送信 | `midi-scheduler.ts:99` `tickMs ?? 5` / `:188` `setInterval` / `plugin-note-output.ts:25` | poll は残し、送る中身を時刻付きにする（§3.4） |
| audio の TS 側は 1 ms poll + 50 ms lookahead + anchor 回帰 | `rust-engine-player.ts:333` `POLL_INTERVAL_MS = 1` / `:330` `DEFAULT_LOOKAHEAD_SEC = 0.05` / `:1700` `daemonNowSec()` | epoch ms → daemon 秒の写像を 1 本にする（§3.4） |
| note の発音時刻は**小節単位で先に確定している** | `sequence.ts:1305` `onTime = schedulerStartTime + baseTime + ev.startTime + sendDelay` | 「意図した時刻」を送れる（§3.4 案 ii） |
| instrument の note ring 容量は 1024・満杯は明示エラー | `outproc_instrument.rs:38` `NOTE_RING_CAPACITY = 1024` / `engine_wrap.rs:7246-7250` | 時刻付きにすると滞留が増える（§6） |
| shm には**バージョンハンドシェイクが無い**（親子は同梱前提） | `transport.rs` に `version`/`magic` の grep ヒット 0 | payload 変更は同梱ビルドの前提に依存（§3.6） |
| 実機 E2E の instrument シナリオ基盤は既にある | `tests/e2e/orbitstudio-mcp-gated.spec.ts:494` `captureInstrumentScenario` / `:1435` E2E-1 | ここに足す（§7） |
| **`CLAPTestSynth` は `sample_offset` を尊重する**（`batch()` / `sample_bounds()` でサブブロック生成） | `rust-spike/clap-test-synth/src/lib.rs:376,414` | サンプル精度が capture で測れる（§7） |
| **標準 `Gain` は offset を無視してブロック先頭で適用する** | `orbit-std-gain/src/lib.rs:177-186` `apply_param_events`（`sample_offset` を読まない）/ `:279` | サンプル精度は**ホストの保証**であって、プラグインが従うかは別（§7） |

---

## 3. 設計

### 3.1 1 本の queue に乗る event の型 — wire

🔴 **wire は一方通行**（method を足したら消せない）。したがって「種が増えるたびに method が増える形」を避ける。

| 案 | 形 | 判定 |
|---|---|---|
| A. 種ごとに時刻付きメソッド | `PluginNoteAt` / `PluginParamAt` / …（`PlayAt` と対称） | ❌ 種が増えるたびに wire が増える。#460 の breakpoint 列で往復が爆発 |
| **B. 1 本の汎用 `ScheduleEvents`（配列）** | 下記 | ✅ **推奨**。種は `kind` で増やせる。1 件でも配列で送れるので dispatch は後から変えられる |
| C. `PluginNoteOn` に `time_sec` を optional 追加 | 既存 method を拡張 | ❌ note 専用のまま。param が乗らないので裁定 1 に反する |

**推奨 = B。** 理由: (1) wire は一方通行だが **dispatch（1 件ずつ送るか小節分まとめて送るか）は可逆**なので、v1 は長さ 1 の配列で送り、#460 で束にすればよい。(2) #460 の層①「事前レンダした breakpoint 列」は**束で送る形が本質**であり、後から method を足すと 2 本になる。

```jsonc
// → daemon
{
  "id": "u42",
  "method": "ScheduleEvents",
  "params": {
    "target": { "kind": "instrument", "instance": "plugin:lead" },  // 将来: {"kind":"effect","bus":"...","index":0}
    "events": [
      { "time_sec": 12.3456, "kind": "note_on",  "key": 60, "channel": 0, "velocity": 0.8 },
      { "time_sec": 12.8456, "kind": "note_off", "key": 60, "channel": 0, "velocity": 0.0 },
      { "time_sec": 13.0000, "kind": "param",    "param": "db", "value": -12.0 }
    ]
  }
}
// ← daemon
{ "id": "u42", "result": { "scheduled": 3 } }
```

- `time_sec` の座標系は **`PlayAt` と同一**（daemon transport 秒・`engine_wrap.rs:7869` の doc が定義）。
- **検証は全件先行・1 件でも不正なら全件 reject**（`MALFORMED_REQUEST`・メッセージに `events[i]` の index を含める）。RT へ半端な列を渡さない。`PlayAt` の規約（致命 = reject / 非致命 = clamp・`session.rs:2091-2117`）をそのまま継承する: `key` 0..=127 と `channel` 0..=15 は reject、`velocity` は clamp。
- `param` は**名前**で指す（ID は人にも LLM にも書けない・#680 本文 論点 1）。解決は child の main スレッド（§3.5）。
- 🔴 **対になる `CancelScheduledEvents` を同時に入れる**（§3.7 の失敗モード）。

```jsonc
{ "id": "u43", "method": "CancelScheduledEvents",
  "params": { "target": { "kind": "instrument", "instance": "plugin:lead" },
              "flush_sounding": true } }   // true = 未発火を捨て、鳴っている音に note-off を出す
```

### 3.2 RT 側の queue — `EventBackingRing` の一般化ではなく**前段に別で置く**

**結論: 別。** `EventBackingRing` の仕事は「1 ブロック窓（4096 件）に載らない分を次ブロックへ持ち越す」= **窓あふれ**であり、持ち越し分の `sample_offset` を 0 に潰すのが正しい（`instrument_host.rs:274-277`）。時刻 gate の仕事は「このブロックに属するものを選ぶ」= **時間**。2 つを 1 つの構造に混ぜると drop 方針が 2 つの無関係な原因に依存し、「持ち越し = offset 0」の不変条件が壊れる。

```rust
// rust/crates/orbit-audio-sandbox/src/timed_event_queue.rs（新設）

/// 1 instance ぶんの時刻付きイベント保持庫。固定容量・construction 後は alloc / lock / syscall なし。
pub const TIMED_QUEUE_CAPACITY: usize = 4096; // = MAX_EVENTS_PER_BLOCK

#[derive(Clone, Copy)]
pub struct TimedEvent {
    /// engine transport 上の目標フレーム（§3.3 の時計）。
    pub target_frame: u64,
    /// 同一フレーム内の安定順序（push 順・note_on と param の前後を保つ）。
    pub seq: u32,
    pub event: NeutralEvent,
}

pub struct TimedEventQueue { /* 固定長 min-heap（target_frame, seq） */ }

impl TimedEventQueue {
    pub fn new() -> Self;
    /// 満杯なら drop-newest で `false`。drop したのが NoteOff/NoteEnd なら sticky flush を立てる
    /// （`EventBackingRing::push` と**同じ方針**・`event_backing_ring.rs:42-57`）。
    pub fn push(&mut self, ev: TimedEvent) -> bool;
    /// `block_start <= target_frame < block_end` と**遅刻分**（`target_frame < block_start`）を
    /// `dst` へ取り出し、`sample_offset` を書いて件数を返す。遅刻は offset 0 + `late` を進める。
    pub fn drain_due(
        &mut self, block_start: u64, frames: u32, dst: &mut [NeutralEvent], late: &mut u64,
    ) -> usize;
    pub fn take_note_flush_pending(&mut self) -> bool;
    /// `CancelScheduledEvents` の RT 側（全件破棄）。
    pub fn clear(&mut self);
    pub fn len(&self) -> usize;
}
```

**なぜ min-heap で、FIFO ではないか**: イベントは概ね時刻順に届くが、**厳密ではない**。複数シーケンスが別々の lookahead で発火し、`note_off` は `note_on` より後に enqueue されるとは限らない（`sequence.ts:1366-1379` は plan 順に `scheduleNote` する）。FIFO の先頭ブロッキングにすると「遠い未来の 1 件」が「今すぐのもの」を止める。固定長配列上の binary heap は `push`/`pop` が O(log n) で alloc しない。

**なぜ `rtrb::Consumer::peek` を使わないか**: ring を毎ブロック全量 drain して heap へ移す現行構造（`outproc_instrument.rs:385-387`）を変えずに済み、ring の順序仮定にも依存しないため。

**設置場所**: `OutProcInstrumentBlockSource`（`outproc_instrument.rs:357-414`）。`render()` は既に `&BlockTransport` を受け取っており、フレーム基準がある。`PipelinedInstrumentHost::process_block`（`instrument_host.rs:220`）の契約（「`sample_offset` が既に入った `NeutralEvent` の列を受ける」）は**変えない** — offline 経路（`offline.rs`・#598 P3）に波及させないため。

```rust
// outproc_instrument.rs:385-398 の置き換え（差分のかたち）
self.event_scratch.clear();
while let Ok(timed) = self.event_rx.pop() {        // ring 要素が TimedEvent になる
    if !self.timed_queue.push(timed) {
        self.stats.timed_queue_dropped.fetch_add(1, Ordering::Relaxed);
    }
}
let block_start = self.transport_frames.load(Ordering::Relaxed);  // §3.3
let mut late = 0u64;
let taken = self.timed_queue.drain_due(
    block_start, frames as u32, &mut self.event_scratch_buf, &mut late,
);
if late != 0 { self.stats.timed_event_late.fetch_add(late, Ordering::Relaxed); }
self.host.process_block(
    scratch, &self.event_scratch_buf[..taken], transport_context(transport),
);
```

### 3.3 🔴 時計 — `PlayAt` の秒と `BlockTransport.cursor_frames` は**同じではない**

- `PlayAt` の `time_sec` は engine scheduler の cursor（`scheduler.rs:591` `now_sec = cursor_frames / sr`）を基準にする。この cursor は **RT の `try_lock` が失敗したブロックでは前進しない**（`engine.rs:205-225`: 失敗時は closure を実行せず zero-fill）。
- `BlockTransport.cursor_frames` は**毎コールバック無条件に**前進する（`output.rs:751`）。
- したがって両者は「競合ブロック数 × frames」だけずれる。競合は観測されている（`contention_count`・#401）。

| 案 | 内容 | 判定 |
|---|---|---|
| a | RT から `Engine::now_sec()` を呼ぶ | ❌ `try_lock` が要る（同じ失敗モードを二重に持ち込む） |
| **b** | **scheduler cursor を `AtomicU64` にミラーし、block source が読む** | ✅ **推奨**。小さく、テストで固定できる |
| c | `BlockTransport.cursor_frames` を単一の transport にし `PlayAt` をそちらへ移す | ❌ audio の発音時刻の意味が変わる（裁定 7 に抵触） |

**b の形**（`orbit-audio-core`）:

```rust
// engine.rs — Engine に足す
transport_frames: Arc<AtomicU64>,          // scheduler cursor のミラー
pub fn transport_frames_arc(&self) -> Arc<AtomicU64>;

// scheduler.rs:458 の直後（cursor_frames を進めた後）
self.transport_frames.store(self.cursor_frames, Ordering::Relaxed);
```

- **順序が load-bearing**: `render_sources` は engine render の**前**に走る（`output.rs:728`）ので、block source が読む値は「前ブロック終端 = 今ブロック先頭」になる。これがちょうど欲しい基準。
- 競合ブロックでは store も advance も起きない → **音とノートが同じ量だけ遅れる**（相対ずれは生じない）。これは仕様として明記する。
- 🔴 この規律は**データの配置で守る**: ミラーを `Scheduler` の外の独立 atomic に置くと「store を advance の後に書く」という順序の慣習になり、変異が書けてしまう（#628 の教訓）。`Scheduler` が自分の cursor を進める式の**すぐ隣**に置き、`cursor_frames` を private のまま `advance_cursor(frames)` 1 本に畳んで store を内側に入れる。

### 3.4 TS 側の dispatch — 5 ms poll と lookahead の**どちらでもなく、両方**

役割が違うので寄せない。

| 部品 | 役割 | 本書 |
|---|---|---|
| `MidiScheduler` の poll（`midi-scheduler.ts:188`） | **キャンセル可能な発火ゲート**。`clearOwner`（`:211`）は「まだ送っていない」ことを前提に queue から消す | 残す |
| `RustEnginePlayer` の anchor（`rust-engine-player.ts:1700`） | **epoch ms → daemon transport 秒の写像**。回帰フィットも観測（`onDispatch`）もここにしかない | ここに寄せる |

**送る時刻の 2 案**:

| 案 | 発火 | 送る `time_sec` | 判定 |
|---|---|---|---|
| i | `onTime` | `daemonNowSec() + lookahead` | audio と同形。poll ジッタ（≤5 ms）が発音時刻に残る = #428 の DoD を満たさない |
| **ii** | `onTime − leadMs` | `daemonSecOf(onTime)` | ✅ **推奨**。poll ジッタが消える。キャンセル猶予が `leadMs` だけ縮む |

**ii を推奨する理由**: #428 の DoD は「指定した `time_sec` にサンプル精度で note-on が発音される」であり、i は**要求時刻そのものが揺れる**ので測っても揺れが残る。audio 側（`play()`）は**触らない**（裁定 7）。結果として note は audio より分散が小さくなるが、平均は同じ（lookahead は定数シフト）なので音楽的な前後関係は変わらない。

```ts
// midi-scheduler.ts — leadMs を足す（scheduler 単位。rtmidi は 0 のまま）
export interface MidiSchedulerOptions { tickMs?: number; leadMs?: number }
// scheduleNote: enqueue は (onTime - leadMs)、output へは onTime を渡す
noteOn(port, channel, note, velocity, owner, atEpochMs: number): void
noteOff(port, channel, note, owner, atEpochMs: number): void
```

- `midi-manager.ts:60` `getPluginScheduler()` は `new MidiScheduler(this.pluginOutput, { leadMs: PLUGIN_LEAD_MS })`、`:49` `getScheduler()`（rtmidi）は既定 0 のまま。**同一シグネチャの兄弟が 2 つあるので、引数で分ける**（`leadMs` を引数に持たせるのが「型で潰す」形）。
- `RtMidiOutput`（`rtmidi-output.ts:75`）は `atEpochMs` を無視する。無視してよいのは `leadMs = 0` のスケジューラにしか繋がらないから。**この対応を型で保証できないのが唯一の緩い箇所**なので、`MidiManager` が 2 つの scheduler を作る 2 箇所を単体テストで固定する（§7 の unit）。

```ts
// audio/types.ts / engine-backend.ts — 追加する 1 本（既存 pluginNoteOn/Off は残す・§3.10）
export type TimedInstrumentEvent =
  | { kind: 'note_on';  atEpochMs: number; key: number; channel: number; velocity: number }
  | { kind: 'note_off'; atEpochMs: number; key: number; channel: number; velocity?: number }
  | { kind: 'param';    atEpochMs: number; param: string; value: number }

scheduleInstrumentEvents?(instance: string, events: readonly TimedInstrumentEvent[]): Promise<void>
cancelInstrumentEvents?(instance: string, flushSounding: boolean): Promise<void>
```

```ts
// rust-engine-player.ts:1700 を 1 本に畳む（兄弟関数を作らない）
private daemonSecOf(epochMs: number): number {
  const fit = this.anchorFit
  if (fit) return fit.intercept + fit.slope * ((epochMs - fit.t0Ms) / 1000)
  return this.clockAnchor.daemonSec + (epochMs - this.clockAnchor.tsMs) / 1000
}
private daemonNowSec(): number { return this.daemonSecOf(Date.now()) }
```

### 3.5 #680 パラメータの粒度 — 「何を測るか」で書く

| 経路 | 今日 | 本設計後 | 粒度 |
|---|---|---|---|
| CLAP instrument | 経路はあるが誰も出さない（`orbit-clap-host/src/events.rs:182-198`） | `ScheduleEvents` の `kind:"param"` → `NeutralEvent::ParamValue` | **ホスト側はサンプル精度**（`sample_offset` を載せる） |
| VST3 instrument | **受けない**（`lib.rs:1437` `inputParameterChanges: null`） | `InputParameterChanges` を実装し `classify_event`（`orbit-vst3-instrument-child/src/main.rs:215`）に `ParamValue` を足す | 同上（`IParamValueQueue` は点列を持てる規格） |
| VST3 の param queue | 1 点・offset 0・`addPoint` は `kResultFalse`（`lib.rs:2653-2678`） | N 点・offset 付きへ一般化 | 同上 |
| effect ラック | `CMD_APPLY_CHAIN` → `apply_params` → `ParamValueEvent::new(0, …)`（`effect.rs:239`） | **v1 は据え置き** | **ブロック粒度**（§3.6） |

🔴 **サンプル精度は「ホストの保証」であって「聞こえ方の保証」ではない。** 標準 `Gain` は自分でブロック先頭に潰す（`orbit-std-gain/src/lib.rs:177-186` は `sample_offset` を読まない）。`CLAPTestSynth` は尊重する（`rust-spike/clap-test-synth/src/lib.rs:376` `batch()`）。この差は仕様に書く（§8）。

**測るもの（閾値は書かない・実装前に baseline を取って決める）**:

1. **配置**: DSL で「次の小節頭で `db` を下げる」と書き、**評価した壁時計時刻と、capture 上で RMS が落ちた時刻の差**が「次の小節頭までの残り時間」に一致すること。即時経路なら差は 0 になる = **二値で落ちる**。
2. **サンプル精度（note）**: 一定の音符列を鳴らし、capture のオンセット間隔の**ばらつき**を見る。ブロック先頭量子化ならブロック長で量子化された鋸状になる。実装前に現行値を測り、それを下回ることを受け入れ条件にする。
3. **サンプル精度（param）**: capture では**測らない**。上記のとおりプラグイン側が offset を無視しうるため。代わりに `TimedEventQueue::drain_due` が書いた `sample_offset` の値を daemon の unit で固定する（E2E が届かない場所だけを unit に落とす — CLAUDE.md の順序）。

**名前解決の置き場**: `resolve_params` は **child の main スレッド**（`macos.rs:132` / `plugin_main.rs:33` `parameter_id_by_name`）。したがって `ScheduleEvents` が運ぶ `param: "db"` は daemon で ID に解決できない。2 通り:

| 案 | 内容 | 判定 |
|---|---|---|
| **P1** | 名前→ID は **attach 時に 1 回**解決してテーブルを daemon 側に持つ（`LoadPlugin` の応答に param マップを載せる） | ✅ **推奨**。RT に文字列を持ち込まない。#495 の候補源にもなる |
| P2 | `ScheduleEvents` が数値 ID を運ぶ（TS がカタログから引く） | ❌ カタログが古いと黙って別の param を叩く |

P1 の帰結: **`param_id` は `u64` opaque のまま**（`events.rs:87-92` の契約を変えない）。CLAP は `u32` に収まる必要がある（`orbit-clap-host/src/events.rs:118-120` `clap_param_id` は `u32::MAX` を弾く）。

### 3.6 effect（ラック）の param を同じ queue に載せない理由と、載せるとしたら

- ラック child は `SharedRegion` を共有しているが **`input_events` を読んでいない**（読者は `orbit-clap-instrument-child/src/main.rs:262-270` と `orbit-vst3-instrument-child/src/main.rs:364-370` の 2 つだけ）。
- ラックは **N 段**あるので、宛先の段を指す欄が要る。`ParamBody`（`events.rs:87-92`）は `addr(12) + pad(4) + value(8) + param_id(8) = 32` で**オフセット 12 に 4 バイトの穴がある**ため、`stage_index: u32` をそこへ置けば `EventPayload` は 32 バイトのまま（`events.rs:159-160` の `const _: () = assert!` を壊さない）。
- ただし shm には**バージョンハンドシェイクが無い**（`transport.rs` に `version`/`magic` なし）。親子同梱が前提なので同一ビルドなら安全だが、**古い child バイナリが残っていると無警告で壊れる**（#528 と同型）。

**v1 判断**: effect の param は **`CMD_APPLY_CHAIN` のまま（ブロック粒度）**。理由は (a) 上記 3 点の作業量が #428 の foundation より大きい、(b) #680 のチェックリストの受け入れ（「DSL から動かして音が変わる」）はブロック粒度で満たせる、(c) 標準プラグインは自分でブロック先頭へ潰すのでサンプル精度に意味が無い。**サンプル精度が要るのは連続曲線（#460 層②）**なので、**effect の event 窓は #460 の前提として起こす**（§11 の裁定待ちではなく、順序の宣言）。

### 3.7 #674（OSC・kind B）の口 — 同じ queue には乗らない

裁定 2 のとおり。**契約は `docs/design/672-plugin-boundaries-design.md` が持つ**（§7.3 `HostContext.timedEvents.subscribe(seq, consumer)` — 種 B は時刻付きイベントを**非 RT で購読する**。同書 §8 の表「スケジューラ … 種 B はこの consumer であって owner ではない」）。**ここでは再設計しない。境界だけ引く。**

| 共有する | 共有しない |
|---|---|
| 「シーケンス上の位置 → epoch ms」の解決（`sequence.ts:1305`） | daemon wire（`ScheduleEvents`） |
| オーナー単位のキャンセル / パニック（`MidiScheduler.clearOwner` `:211` / `panic`） | RT の `TimedEventQueue`・`sample_offset` |
| 「時刻付きで発火する」ゲート（poll。種 B の consumer が受け取る `atMs` の出どころ） | engine transport 秒（OSC の宛先は daemon ではないので anchor 写像が要らない） |

**本書が #672 に対して負う義務**: 種 B が購読する「時刻付きイベント」の**時刻の意味**を 1 つに保つこと。本書の `atEpochMs`（§3.4）と #672 の `subscribe(..., atMs)` は**同じ量**（`sequence.ts:1305` の `onTime`）である。daemon 宛だけが `daemonSecOf()` で transport 秒へ写される — **写像は `RustEnginePlayer` の内側にしか無い**（§3.4）。

**MIDI が既に種 B の原型である**（#672 §7.1 の表「MIDI 出力（`midi()` + `midi-scheduler.ts` の 5ms poll = 既存の種 B の原型）」）ので、§3.4 で `MidiScheduler` に `leadMs` を足す変更は **#672 の種 B 契約に先回りしない**（scheduler 単位の値であって、契約の面には現れない）。

### 3.8 #460 の位置 — 本 queue の**消費者**

#460 層①（時間決定論）は「`ramp(0,1,4bars)` を**事前レンダ**して control-rate レーン / breakpoint にする」（#460 本文）。**その breakpoint 列がそのまま `ScheduleEvents` の `kind:"param"` の配列**になる。つまり #460 は新しい wire を要求しない — **束で送れる形（案 B）にしておくことが #460 の前提**であり、これが §3.1 で B を推す 2 つ目の理由。

層②（LFO / envelope follower / sidechain の control-rate 評価）は engine 内評価なので本 queue の外（#460 のスコープ）。ここでは扱わない。

### 3.9 #213（`fixpitch()` / `time()`）— 本 queue には乗らない

判定: **乗らない。** `fixpitch()` / `time()` は `play()` の**スライスごとの属性**であり、`PlayAt` の `rate`（`session.rs:2118` / `engine_wrap.rs:7942`）と同じ位置に座る。時刻付き非オーディオイベントではない。前提も違う（#92 のタイムストレッチライブラリ選定・#213 コメント 1）。本 queue とは無関係。

### 3.10 既存 `PluginNoteOn` / `PluginNoteOff` wire — **残す（deprecated）**

| 案 | 影響 | 判定 |
|---|---|---|
| 退役（削除） | TS 4 ファイル・Rust 2 ファイル・テスト 6 本・dev サイト 2 ファイル | ❌ protocol doc が「**汎用**: OrbitScore 以外のアプリケーションも同じ daemon を使える」と明記している（`docs/research/ENGINE_DAEMON_PROTOCOL.md:16`）。method 削除は外部契約の破壊 |
| **残す（deprecated・本体からの呼び出しを 0 にする）** | doc に「即時。OrbitScore 本体は `ScheduleEvents` を使う」と注記 | ✅ **推奨** |

**互換の表**:

| wire | v1 の意味 | 呼び出し元（本設計後） |
|---|---|---|
| `PluginNoteOn` / `PluginNoteOff` | 即時（`time_sec` 相当 = 現在ブロック先頭・`sample_offset = 0`） | **OrbitScore 本体からは 0**。外部クライアント / 手動デバッグのみ |
| `ScheduleEvents` | 時刻付き | `PluginNoteOutput` → `RustEnginePlayer.scheduleInstrumentEvents` |
| `CancelScheduledEvents` | 未発火の破棄 + 任意で note-off flush | `PluginNoteOutput.releaseOwner` / `panic`、#606 の RUN 終端 flush |

実装上は `handle_plugin_note`（`session.rs:2392`）を残したまま、`ScheduleEvents` が同じ `EngineWrap` の入口（§4）へ `target_frame = 現在ブロック` で流し込む形にできる。**dispatch は 1 本に畳めるが wire は 2 本のまま**、が結論。

---

## 4. データの通り道（1 本・端から端まで）

`instSeq.play(1,1,1,1)` の 1 打点が音になるまで（**太字が本書で変わる箇所**）:

```
sequence.ts:1305   onTime = schedulerStartTime + baseTime + ev.startTime + sendDelay   （epoch ms・小節ぶん先に確定）
      ↓ sequence.ts:1369  scheduler.scheduleNote({ ..., onTime, offTime })
midi-scheduler.ts:133  enqueue(**onTime − leadMs**, owner, run)                        （キャンセル可能な保留）
      ↓ :188 setInterval(tickMs = 5)  → :233 tick() が due を発火
plugin-note-output.ts:22  noteOn(port, channel, note, velocity, owner, **atEpochMs**)
      ↓ **engine.scheduleInstrumentEvents(port, [{kind:'note_on', atEpochMs, …}])**
rust-engine-player.ts     **daemonSecOf(atEpochMs)** → time_sec                        （anchor 回帰・:1700 を 1 本に畳む）
      ↓ daemon-client.ts  **request('ScheduleEvents', { target, events })**
────────────────────────────── WebSocket ──────────────────────────────
session.rs                **"ScheduleEvents" =>** 全件検証 → spawn_blocking
      ↓ engine_wrap.rs    **schedule_instrument_events()**
                          target_frame = (time_sec * sample_rate) as u64
                          instance → slot 解決（:7233-7243 の既存ガードを流用）
      ↓ slot.event_tx.push(**TimedEvent**)                                              （rtrb 1024・:38）
────────────────────────────── audio callback ──────────────────────────
output.rs:728             render_sources(sources, frames, transport)                    （engine render の**前**）
      ↓ outproc_instrument.rs:385  ring を全量 drain → **TimedEventQueue::push**
      ↓ **block_start = transport_frames.load()**                                       （§3.3 のミラー）
      ↓ **TimedEventQueue::drain_due(block_start, frames, dst, &mut late)**
                          sample_offset = (target_frame − block_start).min(frames−1)
      ↓ :398 host.process_block(scratch, dst, transport_context(transport))
instrument_host.rs:234    EventBackingRing::push（窓あふれ受け皿・**不変**）
      ↓ :274 drain_into(window)  / :276 持ち越し分は offset 0（**不変**）
      ↓ :285 input_event_count[slot].store / :288 seq_request.store(Release)
────────────────────────────── shm / 別プロセス ─────────────────────────
orbit-clap-instrument-child/src/main.rs:262  input_event_count を読む
      ↓ :267 decode_slot_events → :282 push_neutral_event
orbit-clap-host/src/events.rs:148  NoteOnEvent::new(sample_offset, pckn, velocity)
      ↓ clap-test-synth/src/lib.rs:376  events.input.batch() → :414 sample_bounds()
                          → **サブブロック位置で発音**
```

`kind:"param"` は同じ道を通り、`orbit-clap-host/src/events.rs:182-198` で `ParamValueEvent::new(sample_offset, id, …)` になる。**ここまで全部既存**であり、本書が足すのは「時刻」と「その時刻を守る queue」だけ。

---

## 5. 呼び出し元の全列挙（grep 出力）

```
$ grep -rn "pluginNoteOn\|pluginNoteOff" packages/ --include=*.ts | grep -v node_modules | grep -v /dist/
packages/engine/src/midi/plugin-note-output.ts:23:    if (this.engine.pluginNoteOn) {
packages/engine/src/midi/plugin-note-output.ts:25:        .pluginNoteOn(key, channel - 1, normalizedVelocity, port)
packages/engine/src/midi/plugin-note-output.ts:28:      console.error('❌ PluginNoteOn unavailable: engine.pluginNoteOn is not implemented', {
packages/engine/src/midi/plugin-note-output.ts:77:    if (this.engine.pluginNoteOff) {
packages/engine/src/midi/plugin-note-output.ts:79:        .pluginNoteOff(key, note.channel - 1, undefined, note.port)
packages/engine/src/midi/plugin-note-output.ts:82:      console.error('❌ PluginNoteOff unavailable: engine.pluginNoteOff is not implemented', {
packages/engine/src/audio/engine-backend.ts:47:  pluginNoteOn?(key: number, channel: number, velocity: number, instance?: string): Promise<void>
packages/engine/src/audio/engine-backend.ts:48:  pluginNoteOff?(key: number, channel: number, velocity?: number, instance?: string): Promise<void>
packages/engine/src/audio/rust-engine/daemon-client.ts:698:  pluginNoteOn(key: number, channel: number, velocity: number, instance?: string): Promise<void> {
packages/engine/src/audio/rust-engine/daemon-client.ts:707:  pluginNoteOff(key: number, channel: number, velocity?: number, instance?: string): Promise<void> {
packages/engine/src/audio/rust-engine/rust-engine-player.ts:1261:  pluginNoteOn(key: number, channel: number, velocity: number, instance?: string): Promise<void> {
packages/engine/src/audio/rust-engine/rust-engine-player.ts:1282:    return this.daemon.pluginNoteOn(key, channel, velocity, instance)
packages/engine/src/audio/rust-engine/rust-engine-player.ts:1285:  pluginNoteOff(key: number, channel: number, velocity?: number, instance?: string): Promise<void> {
packages/engine/src/audio/rust-engine/rust-engine-player.ts:1305:    return this.daemon.pluginNoteOff(key, channel, velocity, instance)
packages/engine/src/audio/types.ts:194:  pluginNoteOn?(key: number, channel: number, velocity: number, instance?: string): Promise<void>
packages/engine/src/audio/types.ts:195:  pluginNoteOff?(key: number, channel: number, velocity?: number, instance?: string): Promise<void>

$ grep -rn "\.noteOn(\|\.noteOff(\|scheduleNote(" packages/engine/src --include=*.ts
packages/engine/src/midi/midi-scheduler.ts:133:  scheduleNote(n: ScheduledMidiNote): void {
packages/engine/src/midi/midi-scheduler.ts:140:      this.output.noteOn(n.port, n.channel, n.note, n.velocity, n.owner)
packages/engine/src/midi/midi-scheduler.ts:143:      this.output.noteOff(n.port, n.channel, n.note, n.owner)
packages/engine/src/core/sequence.ts:1369:      scheduler.scheduleNote({

$ grep -rn "implements MidiOutput" packages/engine/src --include=*.ts
packages/engine/src/midi/plugin-note-output.ts:11:export class PluginNoteOutput implements MidiOutput {
packages/engine/src/midi/rtmidi-output.ts:75:export class RtMidiOutput implements MidiOutput {

$ grep -rn 'input_events\|input_event_count' rust/crates/ --include=*.rs | grep -v test   （= shm event 窓の読者）
rust/crates/orbit-clap-instrument-child/src/main.rs:262,268
rust/crates/orbit-vst3-instrument-child/src/main.rs:364,370
（orbit-effect-rack-child / outproc_effect.rs にヒット無し = ラックは event 窓を使っていない）

$ grep -rn 'ClapParamValue\|apply_param_values' rust/crates/ --include=*.rs
rust/crates/orbit-clap-host/src/effect.rs:56,233
rust/crates/orbit-clap-host/src/lib.rs:44
rust/crates/orbit-effect-rack-child/src/macos.rs:17,73,78

$ grep -n 'fn plugin_note_spec\|async fn handle_plugin_note\|if let Some(spec) = plugin_note_spec' rust/crates/orbit-audio-daemon/src/session.rs
1285:    if let Some(spec) = plugin_note_spec(&method) {
2365:fn plugin_note_spec(method: &str) -> Option<PluginNoteSpec> {
2392:async fn handle_plugin_note(
（テスト側: 3466 / 3488 / 3513 / 3567）
```

**帰結**: note の TS 側の入口は `midi-scheduler.ts:140,143` の 2 行だけ、`MidiOutput` の実装は 2 つだけ。**シグネチャに `atEpochMs` を足せば、コンパイラが全呼び出し元を洗い出す**（`() => void` の兄弟取り違えが起きない形・CLAUDE.md「型で潰す」）。

---

## 6. 失敗モード（握り潰される経路が無いこと）

| # | 失敗 | 今日 | 本設計 | 観測 |
|---|---|---|---|---|
| F1 | **キャンセルできない未来のイベント**（lookahead で daemon に渡した後に mute / LOOP 外し / `stop()`） | 起きない（即時送信） | 🔴 **新設される失敗**。`CancelScheduledEvents` を**同じ PR で**入れる。`clearOwner`（`midi-scheduler.ts:211`）が TS queue を消した後に必ず呼ぶ | E2E: mute の反映が `leadMs` 以内（capture の RMS 立ち下がり位置） |
| F2 | RUN 終端の note-off 未配送（#606） | 発生中（must-fix） | queue に未発火 note-off が残ったまま停止しうるので**悪化する**。`CancelScheduledEvents{flush_sounding:true}` が #606 の flush の受け皿になる | #606 の受け入れ条件をそのまま使う |
| F3 | 時計のずれ（scheduler cursor vs BlockTransport） | 潜在（誰も両方を使っていない） | §3.3 の atomic ミラーで一致。**ミラーを配線し忘れると無警告でノートだけ遅れる** | unit: 競合ブロックで cursor が進まないこと + ミラーが cursor と常に等しいこと |
| F4 | `TimedEventQueue` 満杯（drop-newest） | — | `EventBackingRing` と同じ方針（NoteOff/NoteEnd の drop は sticky flush・`event_backing_ring.rs:42-51`） | `timed_queue_dropped` を 1 Hz ticker で WARNING（`plugin_event_ring_overflow_count`・`engine_wrap.rs:7412` と同型） |
| F5 | 遅刻イベント（`target_frame < block_start`） | — | offset 0 で出す（落とさない）+ `timed_event_late` を進める | 同上。**常時 0 でないなら lookahead が足りない** |
| F6 | rtrb ring（1024）が満杯 | 明示エラー（`engine_wrap.rs:7246-7250`） | 不変。ただし**時刻付きにすると 1 回の送信で複数件送る**ので満杯が起きやすい | 既存の `plugin_event_ring_overflow_count` |
| F7 | 未知 instance への送信 | 明示エラー（`engine_wrap.rs:7239-7243`） | 不変（`ScheduleEvents` も同じ入口を通す） | wire の error 応答 |
| F8 | plugin 未ロード | `CLAP_NOT_LOADED`（`engine_wrap.rs:7258-7262`） | 不変 | 同上 |
| F9 | daemon respawn 中に送った未来のイベント | `respawning` ガードで drop（`rust-engine-player.ts:1570`） | 新 daemon は transport 0 から再開するので、**旧 anchor で計算した `time_sec` は遥か未来になる**。ガードを `scheduleInstrumentEvents` にも同じ形で入れる | E2E は無い（respawn は既存の gated 経路） |
| F10 | 部分的に不正な batch | — | **全件 reject**（index 付き `MALFORMED_REQUEST`）。半端な列を RT に渡さない | wire の error 応答 |
| F11 | 古い child バイナリ × 新 payload（`stage_index` を足す場合） | shm に version が無い | **v1 では payload を変えない**（§3.6 で effect を据え置く理由の 1 つ） | — |
| F12 | プラグインが `sample_offset` を無視する | — | 失敗ではなく**仕様**（`orbit-std-gain/src/lib.rs:177`）。spec に明記（§8） | — |

---

## 7. E2E（`tests/e2e/orbitstudio-mcp-gated.spec.ts` に足す）

すべて既存の `captureInstrumentScenario`（`:494`）で駆動する（**並行機構を新設しない**）。`evaluate_orbitscore` の `ok` には assert しない。ERROR 件数は `<=`（既存の `countErrors` が既にそう書かれている `:562-566`）。

### E2E-T1（#428・**実装前に red を確認する**）: note が指定時刻に鳴る

```
var t1 = init global.seq
t1.instrument(<CLAPTestSynth>)
t1.gate(1)
t1.play(1, 1, 1, 1, 1, 1, 1, 1)      // 8分音符・120bpm 4/4 → 250 ms 間隔
LOOP(t1)
```
判定: capture の**隣接オンセット間隔のばらつき**（`analyzeWavBuffer` の窓 RMS から立ち上がりを検出）。
- ブロック先頭量子化なら、間隔はブロック長で量子化された鋸になる。
- **閾値は実装前に測った現行値から決める**（数値をここに置かない）。受け入れは「現行 baseline を下回る」。
- ⚠️ `CLAPTestSynth` が `sample_offset` を尊重する（`rust-spike/clap-test-synth/src/lib.rs:376,414`）ことが前提。これが崩れると E2E が無力になるので、**前提が成り立つことを同じ spec の先頭で 1 回確かめる**（オンセットがブロック長より細かい位置に出ること）。

### E2E-T2（#680・**本命**）: 時刻付き param が「評価した瞬間」ではなく「指定した位置」で効く

```
var t2 = init global.seq
t2.instrument(<CLAPTestSynth>)
t2.effect([Gain(db: 0)])
t2.gate(1)
t2.play(1, 1, 1, 1)
LOOP(t2)
```
本体で **小節の途中**に `db` を `-12` へ落とす時刻付き変更を評価する（**DSL 表面は #680 の owner 確認待ち** — §11。確定したら差し替える。判定側は表面に依存しない）。

判定（**invented number を使わない 2 本立て**）:
1. **量**: 変更前後の窓 RMS 比が `10^(-12/20) ≈ 0.251` 付近（既存 E2E-1 `:1460-1466` と同じ形。`-6 dB → 0.501` の前例あり）。
2. **位置**: `evaluate` の壁時計時刻と、capture 上で RMS が落ちた時刻の差が **「次の小節頭までの残り時間」に一致**する。
   - 即時経路（今日）なら差は ≈ 0 → **red**。
   - 時刻付きなら差 > 0 かつ、落ちた位置が**オンセットと同じ窓**に来る（自己参照で判定するので capture の絶対原点が要らない）。

### E2E-T3（F1・キャンセル）: lookahead 中の mute が `leadMs` 以内に効く

`LOOP` 中に `t3.mute()` を評価し、capture の RMS が落ちるまでの時間が `leadMs` を超えないこと。`CancelScheduledEvents` を入れ忘れると、最大 `leadMs` ぶん音が残る（= red）。

### 足す unit（E2E が届かない場所だけ）

| 対象 | なぜ E2E で届かないか |
|---|---|
| `TimedEventQueue::drain_due` が書く `sample_offset` の値 | プラグインが offset を無視しうる（F12）ので capture に出ない |
| `TimedEventQueue` の drop-newest + sticky flush | 満杯を DSL から決定論的に作れない |
| §3.3 のミラーが cursor と常に等しいこと（競合ブロック含む） | lock 競合を DSL から起こせない |
| `MidiManager` が plugin scheduler にだけ `leadMs` を渡すこと | rtmidi 実機が要る |

### ラチェット

`ScheduleEvents` は wire であって DSL 語ではないので `SEQUENCE_DSL_METHODS`（`signal-chain/runtime.ts:37`）は増えない。**#680 が DSL 語を足すなら `dsl-e2e-coverage.spec.ts:57` の baseline を増やさず E2E を書く**（`tests/e2e/dsl-e2e-coverage.spec.ts:14-19` の契約）。

---

## 8. spec 改訂（実装より先に spec を直す・運用規則 6）

| ファイル | 箇所 | 改訂 |
|---|---|---|
| `docs/research/ENGINE_DAEMON_PROTOCOL.md` | `:219` `PlayAt` の隣 | `ScheduleEvents` / `CancelScheduledEvents` の節を新設。`time_sec` は `PlayAt` と同一座標系であることを明記 |
| 同上 | `PluginNoteOn` / `PluginNoteOff`（節が無いので新設） | **deprecated（即時）**と明記。「OrbitScore 本体は `ScheduleEvents` を使う」 |
| `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` | `:1526` PH.6「note 発火は block-head 精度（sample-accurate 化は #428）」 | 実装後に更新。**「サンプル精度はホストの保証であり、プラグインがブロック先頭へ潰すことは規格上ありうる」**を規範として追記 |
| 同上 | `:1529-1530` PH.6「param / CC 制御は本節のスコープ外（構文未確定）」 | #680 の表面が確定したら差し替え（**本書では書かない** — owner 確認待ち・§11） |
| 同上 | `:1933-1935` Implementation Status「Only sample-accurate note timing (#428) remains outstanding」 | 実装後に更新 |
| `docs/specs-v2/PLUGIN_CAPABILITY_ABSTRACTION_v1.md` | CAP.6-1（形式を利用者に見せない） | 「param のプレーン値契約（裁定 3）」と「VST3 の `getParamValueByString` は規格上 optional で失敗しうる（地図 §8）」の縮退規則を #680 で追記 |

---

## 9. PR 分割

| PR | 件名 | 対象 | 触るファイル（概算行） | 依存 | 検証 | 一方通行 |
|---|---|---|---|---|---|---|
| **A** | `docs(protocol): specify ScheduleEvents / CancelScheduledEvents` | §8 の protocol doc + core spec PH.6 の但し書き | `ENGINE_DAEMON_PROTOCOL.md`(+80) / `INSTRUCTION_ORBITSCORE_DSL.md`(+10) | — | docs のみ（CLAUDE.md「docs のみは advisor と相談」） | **wire の形が確定する** |
| **B** | `fix(engine): mirror the scheduler transport cursor for block sources` | §3.3 | `orbit-audio-core/src/engine.rs`(+25) / `scheduler.rs`(+15) / `orbit-audio-native/src/output.rs`(+5) | A | unit（競合時に進まない・ミラー一致）+ 実機 E2E は既存の緑維持 | いいえ |
| **C** | `feat(sandbox): add a fixed-capacity timed event queue` | §3.2 | `orbit-audio-sandbox/src/timed_event_queue.rs`(+220 新規) / `lib.rs`(+2) | — | unit（`drain_due` の offset・drop-newest・sticky flush） | いいえ |
| **D** | `feat(engine): schedule instrument events at a transport time` | §3.1 daemon 側 + §3.2 配線 | `session.rs`(+120) / `engine_wrap.rs`(+90) / `outproc_instrument.rs`(+60) | A,B,C | unit + 実機 MCP（`get_log` に ERROR なし） | **wire が確定する** |
| **E** | `feat(engine): send notes with their intended transport time` | §3.4 TS 側 | `midi-scheduler.ts`(+30) / `midi-output.ts`(+6) / `plugin-note-output.ts`(+25) / `rtmidi-output.ts`(+4) / `midi-manager.ts`(+6) / `rust-engine-player.ts`(+60) / `daemon-client.ts`(+20) / `types.ts`+`engine-backend.ts`(+12) | D | **E2E-T1**（実装前 red → 後 green）+ E2E-T3 | いいえ（DSL 表面は変わらない） |
| **F** | `feat(engine): cancel scheduled instrument events` | §3.1 の cancel + F1/F2 | `session.rs`(+50) / `engine_wrap.rs`(+40) / `plugin-note-output.ts`(+15) | D | **E2E-T3** | **wire が確定する**（D と同時に出すのが安全） |
| **G** | `feat(dsl): drive plugin parameters from a sequence`（= #680 本体） | §3.5 + DSL 表面 | `rack.ts` / `sequence.ts` / VST3 host / instrument child / catalog | E,F + **owner の DSL 表面確認** | **E2E-T2** | **DSL 表面が確定する** |

**E と F を同じ PR にするか**: F1 は E が導入する失敗なので、**E と F は同時にマージする**（分けるなら F を先）。

---

## 10. 確信度と反証

| 主張 | 確信 | 反証の仕方 |
|---|---|---|
| M2 wire は `ParamValue` を既に持ち、CLAP instrument child はサンプル精度で適用する | **高**（コード実測） | `orbit-clap-host/src/events.rs:182-198` を読む |
| VST3 instrument は param を一切受けない | **高**（実測） | `lib.rs:1437` が `null_mut()` であること、`classify_event` に param の腕が無いこと |
| effect ラックは event 窓を使っていない | **高**（grep で読者 2 箇所のみ） | `grep -rn input_event_count rust/crates/` |
| scheduler cursor と `BlockTransport.cursor_frames` がずれうる | **高**（`with_scheduler` が失敗時に closure を呼ばない） | `contention_count` を注入する既存 seam（`engine.rs:238` `contention_count_arc`）で unit を書く |
| `CLAPTestSynth` がサンプル位置を守る | **中〜高**（`batch()`/`sample_bounds()` は読んだが実測していない） | E2E-T1 の前提チェックで 1 回測る。守らないなら E2E-T1 は unit へ降格 |
| min-heap が RT で十分速い | **中**（O(log n)・alloc なし。実測していない） | `CallbackTimeStats`（`output.rs` の cb_stats）で callback 時間の分布を before/after で比較 |
| 案 B（batch wire）が案 A より良い | **中**（#460 の要求からの推論） | #460 の層①が本当に breakpoint 列を吐くか、#460 着手時に確認 |
| `PluginNoteOn` を残すのが正しい | **中**（protocol doc の「汎用」記述への依存） | owner に「daemon を外部から叩く予定があるか」を確認（§11） |

---

## 11. 🔴 owner 裁定待ち

**以下だけが未決。本文の §3.1〜§3.4・§3.7〜§3.10・§9 の PR A〜F は、これらの裁定を待たずに着手できる。**

### (1) #680 の DSL 表面（時刻付き param の書き方）

memory `dsl-surface-needs-owner-confirmation` により main は決めない。判定側（§7 E2E-T2）は表面に依存しない形で書いてある。

| 案 | 形（例） | 影響 |
|---|---|---|
| A | `seq.effect([Gain(db: -12)])` を**再評価**することで変更（= 今日の形の延長） | 新語ゼロ。ただし「いつ効くか」が書けない（評価時）。#460 が乗らない |
| B | `play()` と同じ位置表記に param を置く（例: `seq.param("db", 0, 0, -12, 0)`） | 位置が第一級になる。#460 の入口。**新語 1**（ラチェット baseline を増やさず E2E を書く） |
| C | パラメータのハンドル（#460 本文 / #434）: `var g = seq.effect(...)` → `g.db(-12)` / `g.db.automate(ramp(...))` | #460 の 3 層とそのまま繋がる。**設計量が最大**・#434 のハンドル化が前提 |

**main の推奨**: **B を v1、C を #460 と同時**。理由: B は #428 の queue にそのまま乗り（位置 = 時刻）、C は #434 のハンドル返却設計（#460 コメント 1）が前提で、それを待つと #680 が塞がる。

### (2) `PluginNoteOn` / `PluginNoteOff` を残すか

§3.10 で「残す」を推したが、根拠は protocol doc の「汎用」記述（`ENGINE_DAEMON_PROTOCOL.md:16`）**だけ**である。

- **A（推奨）**: 残す（deprecated 注記・本体からの呼び出し 0）。削除コストを払わない
- **B**: 退役させる。TS 4 ファイル / Rust 2 ファイル / テスト 6 本 / dev サイト 2 ファイルを消す。wire が 2 本減って読みやすくなる

**確認したいこと**: 「daemon を OrbitScore 以外から叩く」想定が今も生きているか。生きていないなら B のほうが良い。

### (3) effect（ラック）param のサンプル精度をいつ入れるか

§3.6 で v1 はブロック粒度に据え置くと書いた。サンプル精度にするには (a) ラック child が `input_events` を読む、(b) `ParamBody` の 4 バイト穴に `stage_index` を置く（payload 32 バイト不変）、(c) 古い child バイナリとの不整合を検出する手段（今日は無い）— の 3 点が要る。

- **A（推奨）**: **#460 の前提として起こす**（連続曲線が要求したときに初めて必要になる）
- **B**: #680 に含める（作業量が #428 の foundation を超える）

### (4) `leadMs`（note の先送り量）を設定にするか固定にするか

`midiLatency`（`global.midiLatency()`・`GLOBAL_DSL_METHODS` `runtime.ts:11`）が既に MIDI 用の送出補正を持っている。plugin note の `leadMs` を
- **A（推奨）**: 内部定数（`DEFAULT_LOOKAHEAD_SEC` `rust-engine-player.ts:330` と同じ値・`ORBITSCORE_*` の env も設けない）
- **B**: #662 の設定一覧に載せる（live / restart 属性つき）

**影響**: A なら §9 の PR E に何も足さない。B なら #662 バッチと調整が要る。
