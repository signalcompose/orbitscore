---
title: "RE-3. Per-Sequence Insert Bus (seq.effect())"
chapter-id: "RE-3"
verified-against: 69dc968
verified-at: "2026-09-01"
status: draft
---

> **Note**: This page is a trace of the author's reading as of 2026-09-01. The code is the truth; this page is only a snapshot of understanding at that time.

# RE-3. Per-Sequence Insert Bus (seq.effect())

`seq.effect()` answers a long-standing owner request — `global.effect()`'s
master-only insert cannot apply a different effect to each sequence
individually. It was implemented as Issue
[#434](https://github.com/signalcompose/orbitscore/issues/434) and merged via PR
[#461](https://github.com/signalcompose/orbitscore/pull/461). This chapter traces
the `InsertBusStage` in the render pipeline, the daemon's bus pool, and the
"declaration = activation" contract.

Since this chapter was first written on 2026-07-17, the mixer (sum / aux — #459/#453 / #643),
replacement (#625) and racks (#628) were stacked on top of the insert bus. The DSL surface of
racks (writing several inserts as a value) and of the mixer belongs to the
[SC-1](/en/signal-chain/) / [SC-2](/en/signal-chain/mixer-audio-line) chapters; here we stay
with the substrate: how one named bus is born and how it lands in the render.

## Isomorphic to a DAW's per-track insert

```js
var drums = init global.seq
drums.audio("kick.wav")
drums.effect("~/plugins/TAL-Reverb-4.clap")   // この seq だけに掛かる insert
```

Processing order is **per-sequence insert → master mix → `global.effect()`
(master chain)** — the existing master-path semantics are unchanged (core spec
PH.2b). The constraints stated by spec PH.2b as of 2026-09-01 are summarized below.

| item | as written on 2026-07-17 | as of 2026-09-01 (PH.2b / PH.2d / SC.10) |
|---|---|---|
| number of inserts | 1 seq = 1 insert | the single form `effect("X")` desugars to a one-element rack; several inserts use the array form `effect(["A", "B"])` (#628) |
| accepted formats | `.clap` only | `.clap` / `.vst3` (same as effect); `.component` unsupported |
| redeclaration | same spec is idempotent | same spec is idempotent; **a different spec replaces** (#625, PH.2d); removal = delete from the array |
| sequences that can hold an insert at once | 8 by default | 8 by default (`DEFAULT_EFFECT_BUS_POOL_SIZE` and `SEQUENCE_EFFECT_BUS_POOL_SIZE` both agree on 8) |

The "1 seq = 1 **bus**" correspondence is intact. What changed is what sits on the bus: "one
plugin" became "one rack (a chain the rack child runs serially)"; the bus allocation,
activation and render mechanism is still the one from #434.

## `InsertBusStage`: a per-bus insert stage that takes a named routing tag

The core of the render side is `orbit-audio-native`'s `InsertBusStage`.
`processor=None` represents a "registered but not-yet-attached" bus, and in
that state the stage still passes its buffer through `render_multi` so the
event is always consumed — if it were not consumed, events tagged for an
unattached bus would be retained forever (the landmine described below).

```rust
// rust/crates/orbit-audio-native/src/output.rs:883-902
/// named routing tag を受ける per-bus insert stage。sum/aux を含む mixer graph の1ノード
/// （#459/#453・MX.1-MX.5）。
///
/// `processor=None` は effect 未 attach の **登録済み bus** を表す。buffer を `render_multi` に渡して
/// event を必ず消費し、そのまま `output_target` へ足すので、未 attach bus の event が retain され
/// 続けない。
pub struct InsertBusStage {
    name: String,
    processor: Option<Box<dyn PostProcessor>>,
    buffer: Vec<f32>,
    /// **activation flag**（`LinkChannelActivate.ready` と同じパターン）: `false` の間この bus は
    /// render 対象から完全に外れる（zero-fill / gain-ramp / sum のコストゼロ）。daemon の既定
    /// bus プール（#434 S3）は宣言（LoadPlugin）まで inactive で、全 bus inactive なら
    /// `render_block` は bus 無し経路（ビット同一）に落ちる — `seq.effect()` を使わない
    /// セッションが pool のコストを払わないための機構。
    /// ⚠ inactive bus 名に tag された event は render_multi の対象外 = 消費されず retain される
    /// （LinkAudio の not-ready channel と同じ既存ハザード）。producer（TS）は「宣言 =
    /// activation → その後に tag 付き PlayAt」の順序を守ること（`seq.effect()` は await するので
    /// 構造的に成立）。
    active: Arc<AtomicBool>,
```

`active: Arc<AtomicBool>` is the substance of the "declaration = activation"
contract. The flag is shared with the daemon-side `EffectBusBuild.active`, and is
stored `true` the moment `seq.effect()`'s `LoadPlugin` (`ApplyEffectChain` in the rack form)
names the bus. **There is no separate activation step** — calling `seq.effect()`
itself activates the bus.

The ⚠ landmine the comment warns about (events tagged for an inactive bus are
never consumed and are retained forever) is structurally avoided on the TS side
by "await the declaration, then send the tagged `PlayAt`" (see
`SequenceEffectManager.effect()` below). In addition, since the #461 review the 1 Hz ticker
watches core's `Scheduler::unroutable_event_count` and surfaces "tag before declaration / name
typo" as an `UNROUTABLE_EVENTS` `DaemonError` (`protocol.rs:157-161`).

Beyond the four fields of 2026-07-17, `InsertBusStage` now carries the mixer fields
`output_target` / `sends` / `routing_override` / `send_gain_overrides` (`output.rs:397-412`). They
decide where this bus's output is summed — the subject of the SC-2 chapter.

## Zero buses → bit-identical legacy path

The `render_engine_with_sources` seen in RE-1 falls back entirely to the legacy `render_engine`
(no-bus path) if no insert bus is active. This means a session that never uses `seq.effect()`
pays nothing for the bus pool.

```rust
// rust/crates/orbit-audio-native/src/output.rs:1291-1296
    if sources.is_empty() {
        if buses.iter().any(|bus| bus.active.load(Ordering::Relaxed)) {
            render_engine_with_insert_buses(engine, link, buses, output_channels, hw);
        } else {
            render_engine(engine, link, output_channels, hw);
        }
```

When some bus is active, `render_engine_with_insert_buses` (or
`render_engine_with_insert_buses_and_source_outputs` when instrument sources exist) is called.
The `active` flags are atomic-loaded once at the top of the callback into an `ArrayVec` snapshot
that both the marking pass and the accumulation pass reuse (loading the same atomic twice would
let a `SetBusRouting` that lands mid-callback make the two passes see different things).

```rust
// rust/crates/orbit-audio-native/src/output.rs:1407-1413
    let bs = (hw.len() / output_channels) * output_channels;

    // active フラグを 1 回だけ atomic load して使い回す（RT: 同じ判定を何度も load しない）。
    let active_flags: ArrayVec<bool, MAX_INSERT_BUS_STAGES> = buses
        .iter()
        .map(|bus| bus.active.load(Ordering::Relaxed))
        .collect();
```

## The daemon's default bus pool — `ORBIT_EFFECT_BUS_POOL`

At startup, `orbit-audio-daemon`'s `engine_wrap.rs` reserves N inactive
`InsertBusStage`s named `seq-bus-0` through `seq-bus-N` as a pool (default 8,
configurable via `ORBIT_EFFECT_BUS_POOL`, disabled with `"0"`). This prefix is
a contract that must match the TS-side `SequenceEffectManager` both numerically
and as a string.

```rust
// rust/crates/orbit-audio-daemon/src/engine_wrap.rs:2006-2014
/// 既定 insert bus プールの名前 prefix。DSL 側（TS）の per-sequence effect manager が
/// 同じ規則（`seq-bus-<n>`）で bus 名を組み立てて `LoadPlugin.bus` / `PlayAt.bus` に
/// 送るため、prefix を変える場合は TS 側の定数も合わせて更新すること（#434 S3）。
#[cfg(feature = "outproc-effect")]
pub const DEFAULT_EFFECT_BUS_POOL_PREFIX: &str = "seq-bus-";

/// `ORBIT_EFFECT_BUS_POOL` の既定サイズ（未設定時）。PH.2b の v1 上限（同時 insert 8 seq）と一致。
#[cfg(feature = "outproc-effect")]
const DEFAULT_EFFECT_BUS_POOL_SIZE: usize = 8;
```

If `ORBIT_EFFECT_BUSES` (an explicit bus-name list, the S2 backward-compat
path) is set, it takes priority; otherwise the default pool is generated
per `ORBIT_EFFECT_BUS_POOL`:

```rust
// rust/crates/orbit-audio-daemon/src/engine_wrap.rs:2038-2050
/// bus 名の解決: `ORBIT_EFFECT_BUSES`（明示名・非空）が設定されていればそれを使う（既存 S2 挙動を
/// 保つ）。未設定なら `ORBIT_EFFECT_BUS_POOL`（既定 8・`"0"` で無効）に従って `seq-bus-<n>` の
/// 既定プールを生成する。両方指定は `ORBIT_EFFECT_BUSES` を優先（明示指定が常に勝つ）。
#[cfg(feature = "outproc-effect")]
fn effect_buses_from_env() -> Result<Vec<String>, WrapError> {
    let explicit = std::env::var("ORBIT_EFFECT_BUSES").unwrap_or_default();
    if !explicit.trim().is_empty() {
        return parse_effect_buses(&explicit).map_err(WrapError::OutProcEffect);
    }
    let pool_raw = std::env::var("ORBIT_EFFECT_BUS_POOL").unwrap_or_default();
    let pool_size = parse_effect_bus_pool_size(&pool_raw).map_err(WrapError::OutProcEffect)?;
    Ok(default_effect_bus_pool(pool_size))
}
```

Each bus is built as an `EffectBusBuild` carrying the shm, engaged/stop/done
flags, stats, and the `active: Arc<AtomicBool>` shared with the render-side
`InsertBusStage::active`. "Declaration = activation" is the same flag here too. The difference
from 2026-07-17 is the added `kind: BusKind` (insert / sum / aux) and the shared routing `Arc`s for
the mixer.

```rust
// rust/crates/orbit-audio-daemon/src/engine_wrap.rs:2128-2150
/// 1 本の named bus stage（insert/sum/aux 共通）を構成する部材（`build_effect_bus_stages` →
/// `install_effect_bus_slots` の間で運ぶ・#434 S2/S3・M2 で kind/routing を追加）。
/// effect-only / both の両起動経路で同一のライフサイクルを共有する。
#[cfg(feature = "outproc-effect")]
struct EffectBusBuild {
    name: String,
    kind: BusKind,
    shm_path: std::path::PathBuf,
    engaged: Arc<std::sync::atomic::AtomicBool>,
    stop: Arc<std::sync::atomic::AtomicBool>,
    done: Arc<std::sync::atomic::AtomicBool>,
    stats: Arc<crate::outproc_effect::OutProcEffectStats>,
    /// render 側 `InsertBusStage::active` と共有。LoadPlugin が bus を指名した時点で
    /// `true`（宣言 = activation → 以降 pass-through）。それまで callback は bus を
    /// render 対象に含めない = 既定プールのコストゼロ。
    active: Arc<std::sync::atomic::AtomicBool>,
    /// render 側 `InsertBusStage::routing_override` と共有（M2）。`SetBusRouting` が
    /// control 側からこの Arc を書き換えて実行時に output target を切替える。
    routing_override: Arc<AtomicUsize>,
    /// render 側 `InsertBusStage::send_gain_overrides` と共有（M2・index k = 「この stage の
    /// 絶対 index + 1 + k」への send gain）。`SetBusRouting` が該当 index の Arc を書き換える。
    send_gain_overrides: Vec<Arc<AtomicU32>>,
}
```

`build_effect_bus_stages` lays the three pools — insert / sum / aux — into one stage array in the
order `[insert…, sum…, aux…]` (insert first so that a forward-only reference insert → sum/aux can
always be built — MX.4). The cap is `orbit_audio_native::MAX_INSERT_BUS_STAGES`.

## TS side: `SequenceEffectManager`'s bus allocation and free-list

`packages/engine/src/core/global/sequence-effect-manager.ts`'s
`SequenceEffectManager` maintains a `Map` from sequence name to bus name. On 2026-07-17 it owned
the bus allocation, free-list and idempotent-redeclaration logic itself; with #468 / #527 that
moved to the shared building blocks in `effect-slot.ts` (`BusPool` + `EffectChainMap`). The prefix
and pool-size constants are maintained in lockstep with the Rust side.

```typescript
// packages/engine/src/core/global/sequence-effect-manager.ts:16-29
/**
 * Bus name prefix for the daemon's default per-sequence insert bus pool. Must
 * match `DEFAULT_EFFECT_BUS_POOL_PREFIX` in
 * `rust/crates/orbit-audio-daemon/src/engine_wrap.rs` — changing one requires
 * changing the other (#434 S3).
 */
export const SEQUENCE_EFFECT_BUS_PREFIX = 'seq-bus-'

/**
 * v1 concurrent-insert cap. Must match `DEFAULT_EFFECT_BUS_POOL_SIZE` in
 * `rust/crates/orbit-audio-daemon/src/engine_wrap.rs` (PH.2b: "同時に持てる
 * シーケンス数には上限がある（既定 8）").
 */
export const SEQUENCE_EFFECT_BUS_POOL_SIZE = 8
```

The body of `effect()` looks like this. What is specific to this manager is only the separation
between a passthrough bus (`ensureBus()` — a bus allocated for `seq.output()` / `seq.send()`
routing without any plugin loaded, MX.4) and a real insert, plus the rollback that does not
release the bus when promoting a passthrough bus fails.

```typescript
// packages/engine/src/core/global/sequence-effect-manager.ts:106-161
  /** Declares (or idempotently re-declares) the insert for `sequenceName`. Returns the allocated bus name. */
  async effect(
    sequenceName: string,
    value: string | RackRecipe,
    pluginId?: string,
  ): Promise<string> {
    const recipe = toRackRecipe(value, pluginId)
    if (this.linkAudioManager.isEnabled()) {
      throw new Error(
        `Sequence '${sequenceName}': seq.effect() cannot be used while LinkAudio is enabled in v1.`,
      )
    }
    const rack = resolveEffectRack(
      recipe,
      { audioManager: this.audioManager, linkAudioManager: this.linkAudioManager },
      `Sequence '${sequenceName}': seq.effect() cannot be used while LinkAudio is enabled in v1.`,
    )

    // passthrough（ensureBus 由来・insert 未ロード）は「既存 insert」ではない — 同じ bus を
    // その場で昇格する。実 insert が既にあれば slots.declare が冪等/self-heal/重複エラーを担う。
    const hadBus = this.buses.has(sequenceName)
    const bus = this.buses.get(sequenceName) ?? this.pool.acquire(sequenceName)
    this.buses.set(sequenceName, bus)
    try {
      await this.slots.applyRack(sequenceName, rack)
    } catch (err) {
      if (!hadBus) {
        // この呼び出しで新規に確保した bus の load 失敗: free-list へ返す（daemon 側も
        // activation を巻き戻すため、両側の状態が対称に戻る）。
        //
        // ただし直列化キュー（#527 review Important 1）が生んだ新しい成功経路がある:
        // 同一 sequenceName への `effect()` を await せず連打すると、後続呼び出しは
        // 「hadBus === true」（この呼び出しが確保した bus を同期的に見て再利用）で
        // pending キューに並ぶ。この呼び出しの declare() が失敗しても、後続はキューの
        // 順番で独立に再試行し、成功すればこの bus に生きた宣言を持つ。`!hadBus` の
        // 時点の判定はもう有効ではない — キューがまだ流れている最中に同期的に
        // `has()` を見ると、後続の `declareBody()` がまだ走っていない可能性がある
        // タイミングを掴んで「誰も使っていない」と誤判定しうる（#527 review round 3）。
        // `slots.settled()` でこの key へのキューが完全に片付くのを待ってから、
        // 真に誰も宣言を持っていない場合だけ解放する。
        await this.slots.settled(sequenceName)
        if (!this.slots.hasAppliedRack(sequenceName) && !this.slots.hasUncertain(sequenceName)) {
          this.buses.delete(sequenceName)
          this.pool.release(bus)
        }
      }
      // 既存 bus（passthrough 昇格 / self-heal 再ロード）の失敗は bus を返却しない —
      // seq.output()/seq.send() の routing がその bus を参照し続けているため。
      // 【意図的な旧実装との差分】旧実装は self-heal 再ロード失敗で宣言ごと bus を消して
      // いた（hasDeclaration/hasAnyDeclaration が false に反転 = LinkAudio 排他ゲートが
      // 緩む + routing が参照中の bus 名が pool 外へ漏失）。本実装は bus を温存する —
      // MixerManager の従来挙動とも一致（#472 レビューで確認・回帰テストでピン留め済み）。
      throw err
    }
    return bus
  }
```

`freedBuses` (the free-list that returns a failed declaration's bus) was added
during PR #461's review (an Important finding). In live coding, "typo → failure
→ fix → redeclare" is routine, and if failures permanently consumed the bus
pool, a few retries would exhaust it — the free-list is the countermeasure. It now lives in
`BusPool`, shared with `MixerManager` (sum / aux).

```typescript
// packages/engine/src/core/global/effect-slot.ts:980-1011
/**
 * `<prefix><n>` 連番 + free-list の bus pool（SequenceEffectManager / MixerManager 由来）。
 * 失敗した宣言が pool を恒久消費しないよう、返却された名前を優先再利用する
 * （#461 review Important の free-list 根拠）。
 */
export class BusPool {
  private nextIndex = 0
  private readonly freed: string[] = []

  constructor(
    private readonly prefix: string,
    private readonly size: number,
    private readonly exhaustedMessage: (name: string) => string,
  ) {}

  /** free-list 優先で bus 名を確保する。枯渇時は exhaustedMessage で throw。 */
  acquire(name: string): string {
    const freed = this.freed.pop()
    if (freed !== undefined) return freed
    if (this.nextIndex >= this.size) {
      throw new Error(this.exhaustedMessage(name))
    }
    const bus = `${this.prefix}${this.nextIndex}`
    this.nextIndex += 1
    return bus
  }

  /** 失敗した宣言の bus を pool へ返す。 */
  release(bus: string): void {
    this.freed.push(bus)
  }
}
```

Because `slots.applyRack()` is awaited, "declaration = activation" completes **structurally
before** the caller can send the next `PlayAt` — this is how the producer-side calling discipline
avoids the landmine described at the top of this chapter. `applyRack` sends one
`ApplyEffectChain` command that makes the daemon prepare-commit "the diff (LCS) against the
previous chain"; `mode` is normally `'diff'` and becomes `'rebuild'` only after a respawn, when
the daemon-side registry cannot be trusted.

```typescript
// packages/engine/src/core/global/effect-slot.ts:454-472
  /** Settle a complete effect rack through one prepare-commit daemon command. */
  async applyRack(key: K, rack: RackSpec): Promise<void> {
    return this.enqueue(key, () => this.applyRackBody(key, rack))
  }

  private async applyRackBody(key: K, rack: RackSpec): Promise<void> {
    if (!this.audioEngine.applyEffectChain) {
      throw new Error('Effect rack hosting requires the Rust engine backend.')
    }
    const bus = this.effectBus?.(key)
    // A failed post-respawn replay means the fresh daemon has no rack registry. Reuse the
    // existing per-declaration active seam so an idempotent evaluation joins uncertain recovery.
    if (this.audioEngine.isPluginActive?.('effect', bus) === false) {
      this.rackChains.delete(key)
      this.uncertainRacks.add(key)
    }
    const previous = this.rackChains.get(key) ?? []
    const mode: EffectChainApplyRequest['mode'] = this.uncertainRacks.has(key) ? 'rebuild' : 'diff'
    const pairs = mode === 'rebuild' ? [] : lcsPairs(previous, rack)
```

A point to note is the comment in the catch block saying that the `!hadBus` judgment is no
longer valid. If `effect()` is fired repeatedly on the same sequence without awaiting, the later
calls line up in a per-key serialization queue. Even when the first declaration fails, a later
one may succeed and hold a live declaration on the same bus, so the bus is returned to the pool
only after `slots.settled()` drained the queue and truly nobody holds a declaration
(#527 review round 3).

## Try it: end-to-end verification of `seq.effect()`

The following is the procedure confirmed by Issue #434's real-hardware
gated test (WORK_LOG 6.262,
`rust/crates/orbit-audio-daemon/tests/outproc_effect_bus_gated.rs`).

```
var global = init GLOBAL
global.tempo(100)
global.beat(4 by 4)
global.key("C")
global.start()

var drums = init global.seq
drums.audio("sine_880.wav")
drums.effect("/path/to/CLAPTestEffect.clap")

drums.play(1)

RUN(drums)
```

Start the daemon with the `outproc-effect` feature +
`ORBIT_EFFECT_BUSES=fx1` (or the DSL path using the default
`ORBIT_EFFECT_BUS_POOL`'s `seq-bus-0`) and capture with `ORBIT_CAPTURE_WAV`.
This lets you objectively verify the whole path: DSL → `LoadPlugin(bus)` →
`PlayAt(bus)` → `render_multi` bus routing → OOP effect child gain → master
sum.

```bash
ORBIT_EFFECT_BUSES=fx1 cargo test -p orbit-audio-daemon --features outproc-effect \
  --test outproc_effect_bus_gated -- --ignored --nocapture --test-threads=1
```

**Expected value**: with `EFFECT_GAIN = 0.5`, the gain ratio between
`dry_peak` and `post_peak` should be **≈ 0.5** (the test asserts the wider
tolerance `(0.4..=0.6).contains(&bus_ratio)`). WORK_LOG 6.262's real-hardware
record states an **exact ratio of 0.50000** (single-sine peak 0.70711 →
0.35355 through the bus). This exact figure comes from the WORK_LOG entry;
`outproc_effect_bus_gated.rs` was not re-run on real hardware during this page's re-read on
2026-09-01 either (the test's own assertion is the wider `0.4..=0.6` range).

The E2E that goes through the user's own path (OrbitStudio + MCP) is accumulated in
`tests/e2e/orbitstudio-mcp-gated.spec.ts` and runs with `npm run test:e2e:gated` (see
[RE-4](/en/rust-engine/capture-verification)).

> **Known pitfall**: if a tagged `PlayAt` is sent without awaiting
> `drums.effect()`, the event is retained because the bus is not yet active
> (see `InsertBusStage`'s doc comment). This cannot happen through the DSL
> path since `effect()` is awaited structurally.

## Next exploration candidates

- The daemon side of `ApplyEffectChain` (`outproc_effect::ApplyEffectChainMode` diff / rebuild and the rack child's prepare-commit)
- How the passthrough bus of `ensureBus()` is referenced from `seq.output()` / `seq.send()` (connecting to SC-2)
- `EffectChainMap.enqueue`'s per-key serialization, and the failure scenario of returning a bus without waiting for `settled()`
- The observation point of `UNROUTABLE_EVENTS` (`Scheduler::unroutable_event_count`) and the user experience of a typo declaration

## Sources

- `rust/crates/orbit-audio-native/src/output.rs:377-412` — the `InsertBusStage` struct (meaning of `processor`/`active` and the mixer fields)
- `rust/crates/orbit-audio-native/src/output.rs:709-750` — `render_engine_with_sources`'s zero-bus fallback (bit-identical path)
- `rust/crates/orbit-audio-native/src/output.rs:823-846` — the active-flag snapshot in `render_engine_with_insert_buses_and_source_outputs`
- `rust/crates/orbit-audio-daemon/src/engine_wrap.rs:1904-1948` — `DEFAULT_EFFECT_BUS_POOL_PREFIX` / `DEFAULT_EFFECT_BUS_POOL_SIZE` / `effect_buses_from_env`
- `rust/crates/orbit-audio-daemon/src/engine_wrap.rs:2026-2075` — `EffectBusBuild` and `build_effect_bus_stages` (insert/sum/aux ordering)
- `rust/crates/orbit-audio-daemon/src/protocol.rs:157-161` — `ERROR_CODE_UNROUTABLE_EVENTS`
- `packages/engine/src/core/global/sequence-effect-manager.ts:1-162` — `SequenceEffectManager` (constants, `ensureBus`, the rollback in `effect()`)
- `packages/engine/src/core/global/effect-slot.ts:454-472,980-1011` — mode selection in `EffectChainMap.applyRack`, `BusPool`
- `rust/crates/orbit-audio-daemon/tests/outproc_effect_bus_gated.rs` — gated real-hardware test (`EFFECT_GAIN=0.5`, ratio assertion `0.4..=0.6`)
- [`docs/core/INSTRUCTION_ORBITSCORE_DSL.md`](https://github.com/signalcompose/orbitscore/blob/main/docs/core/INSTRUCTION_ORBITSCORE_DSL.md) PH.2b / PH.2d — `seq.effect()` DSL spec (processing order, accepted formats, cap of 8, replacement)
- [`docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md`](https://github.com/signalcompose/orbitscore/blob/main/docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md) SC.10 — source of truth for the rack form
- [`docs/archive/WORK_LOG_2026-07.md`](https://github.com/signalcompose/orbitscore/blob/main/docs/archive/WORK_LOG_2026-07.md) 6.262 — #434 S1-S3 implementation record (real-hardware ratio 0.50000)
- Issue [#434](https://github.com/signalcompose/orbitscore/issues/434) — per-sequence effect insert
- PR [#461](https://github.com/signalcompose/orbitscore/pull/461) — merged implementation (includes free-list addition)
- Issue [#625](https://github.com/signalcompose/orbitscore/issues/625) / [#628](https://github.com/signalcompose/orbitscore/issues/628) — insert replacement/removal / effect rack
