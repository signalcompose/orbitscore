---
title: "RE-3. Per-Sequence Insert Bus (seq.effect())"
chapter-id: "RE-3"
verified-against: 3983828
verified-at: "2026-07-17"
status: draft
---

> **Note**: This page is a trace of the author's reading as of 2026-07-17. The code is the truth; this page is merely a snapshot of understanding at that point in time.

# RE-3. Per-Sequence Insert Bus (seq.effect())

`seq.effect()` answers a long-standing owner request — `global.effect()`'s
master-only insert cannot apply a different effect to each sequence
individually. It was implemented as Issue
[#434](https://github.com/signalcompose/orbitscore/issues/434) and merged via PR
[#461](https://github.com/signalcompose/orbitscore/pull/461). This chapter traces
the `InsertBusStage` in the render pipeline, the daemon's bus pool, and the
"declaration = activation" contract.

## Isomorphic to a DAW's per-track insert

```js
var drums = init global.seq
drums.audio("kick.wav")
drums.effect("~/plugins/TAL-Reverb-4.clap")   // insert that applies only to this seq
```

Processing order is **per-sequence insert → master mix → `global.effect()`
(master chain)** — the existing master-path semantics are unchanged (core spec
PH.2b). v1 supports 1 insert per seq, accepts `.clap` only (`.vst3` /
`.component` are not supported on the effect path), and caps the number of
sequences that can hold a concurrent insert at 8 by default.

## `InsertBusStage`: a per-bus insert stage that takes a named routing tag

The core of the render side is `orbit-audio-native`'s `InsertBusStage`.
`processor=None` represents a "registered but not-yet-attached" bus, and in
that state the stage still passes its buffer through `render_multi` so the
event is always consumed — if it weren't consumed, events tagged for an
unattached bus would be retained forever (the landmine described below).

```rust
// rust/crates/orbit-audio-native/src/output.rs:131-149
/// named routing tag を受ける per-bus insert stage。
///
/// `processor=None` は effect 未 attach の **登録済み bus** を表す。buffer を `render_multi` に渡して
/// event を必ず消費し、そのまま master へ足すので、未 attach bus の event が retain され続けない。
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
}
```

`active: Arc<AtomicBool>` is the substance of the "declaration = activation"
contract. This flag is shared with the daemon-side `EffectBusBuild.active`,
and is stored to `true` the instant `seq.effect()`'s `LoadPlugin` names the
bus. **There is no separate activation step** — calling `seq.effect()` is
itself what activates the bus.

The landmine the comment warns about (⚠ an event tagged for an inactive bus
name is never consumed and is retained forever) is avoided structurally on
the TS side by the sequencing rule "await the declaration, then send the
tagged `PlayAt`" (see `SequenceEffectManager.effect()` below).

## Zero insert buses falls back to a bit-identical legacy path

If not a single insert bus is active, `render_block` falls back entirely to
the legacy `render_engine` (no-bus path). This means a session that never
uses `seq.effect()` pays zero cost for the bus pool.

```rust
// rust/crates/orbit-audio-native/src/output.rs:250-260
    // active な bus が 1 つも無ければ既存の呼び出し列をそのまま維持する（bit-identical）。
    // 既定 bus プール（全 stage inactive で起動）はここで従来経路に落ちるため、
    // `seq.effect()` 未使用セッションに RT コストを課さない。
    if !insert_buses
        .iter()
        .any(|bus| bus.active.load(Ordering::Relaxed))
    {
        render_engine(engine, link, output_channels, hw);
    } else {
        render_engine_with_insert_buses(engine, link, insert_buses, output_channels, hw);
    }
```

When at least one bus is active, `render_engine_with_insert_buses` is called
instead. It skips inactive buses, packs the named buses into the
`render_multi` target list, runs each bus's `processor` (if any), then sums
into `hw`:

```rust
// rust/crates/orbit-audio-native/src/output.rs:293-308
    let bs = (hw.len() / output_channels) * output_channels;
    let mut targets: ArrayVec<(&str, &mut [f32]), MAX_TARGETS> = ArrayVec::new();
    for bus in buses.iter_mut() {
        // inactive stage は render 対象外（コストゼロ・InsertBusStage::active の doc 参照）。
        if !bus.active.load(Ordering::Relaxed) {
            continue;
        }
        debug_assert!(
            bus.buffer.len() >= bs,
            "insert bus '{}' buffer too short",
            bus.name
        );
        targets
            .try_push((bus.name.as_str(), &mut bus.buffer[..bs]))
            .expect("bounded bus count");
    }
```

## The daemon's default bus pool — `ORBIT_EFFECT_BUS_POOL`

At startup, `orbit-audio-daemon`'s `engine_wrap.rs` reserves N inactive
`InsertBusStage`s named `seq-bus-0` through `seq-bus-N` (default 8,
configurable via `ORBIT_EFFECT_BUS_POOL`, disabled with `"0"`). This prefix
is a contract that must stay in sync (name and count both) with the TS-side
`SequenceEffectManager`.

```rust
// rust/crates/orbit-audio-daemon/src/engine_wrap.rs:240-248
/// 既定 insert bus プールの名前 prefix。DSL 側（TS）の per-sequence effect manager が
/// 同じ規則（`seq-bus-<n>`）で bus 名を組み立てて `LoadPlugin.bus` / `PlayAt.bus` に
/// 送るため、prefix を変える場合は TS 側の定数も合わせて更新すること（#434 S3）。
#[cfg(feature = "outproc-effect")]
pub const DEFAULT_EFFECT_BUS_POOL_PREFIX: &str = "seq-bus-";

/// `ORBIT_EFFECT_BUS_POOL` の既定サイズ（未設定時）。PH.2b の v1 上限（同時 insert 8 seq）と一致。
#[cfg(feature = "outproc-effect")]
const DEFAULT_EFFECT_BUS_POOL_SIZE: usize = 8;
```

If `ORBIT_EFFECT_BUSES` (an explicit bus-name list — the pre-existing S2
backward-compat path) is set, it takes priority; otherwise the default pool
is generated according to `ORBIT_EFFECT_BUS_POOL`:

```rust
// rust/crates/orbit-audio-daemon/src/engine_wrap.rs:272-284
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

Each bus is built as an `EffectBusBuild`, carrying shm / engaged/stop/done
flags / stats, plus the `active: Arc<AtomicBool>` shared with the render
side's `InsertBusStage::active`. The "declaration = activation" contract is
this same flag on the daemon side too:

```rust
// rust/crates/orbit-audio-daemon/src/engine_wrap.rs:286-300
/// 1 本の named insert bus を構成する部材（`build_effect_bus_stages` → `install_effect_bus_slots`
/// の間で運ぶ・#434 S2/S3）。effect-only / both の両起動経路で同一のライフサイクルを共有する。
#[cfg(feature = "outproc-effect")]
struct EffectBusBuild {
    name: String,
    shm_path: std::path::PathBuf,
    engaged: Arc<std::sync::atomic::AtomicBool>,
    stop: Arc<std::sync::atomic::AtomicBool>,
    done: Arc<std::sync::atomic::AtomicBool>,
    stats: Arc<crate::outproc_effect::OutProcEffectStats>,
    /// render 側 `InsertBusStage::active` と共有。LoadPlugin が bus を指名した時点で
    /// `true`（宣言 = activation → 以降 pass-through）。それまで callback は bus を
    /// render 対象に含めない = 既定プールのコストゼロ。
    active: Arc<std::sync::atomic::AtomicBool>,
}
```

## TS side: `SequenceEffectManager`'s bus allocation and free-list

`packages/engine/src/core/global/sequence-effect-manager.ts`'s
`SequenceEffectManager` maintains a `Map` from sequence name to bus name. It
follows the same "eager load + idempotent redeclare" pattern as
`PluginEffectManager` / `PluginInstrumentManager`, but keys by sequence name
instead of a single master slot.

```typescript
// packages/engine/src/core/global/sequence-effect-manager.ts:65-112
  /** Declares (or idempotently re-declares) the insert for `sequenceName`. Returns the allocated bus name. */
  async effect(sequenceName: string, spec: string, pluginId?: string): Promise<string> {
    // Order mirrors PluginEffectManager.effect(): validate the spec, gate on
    // LinkAudio, then resolve the path (see that file's doc comment for why).
    validatePluginExtension(spec, 'effect')

    if (this.linkAudioManager.isEnabled()) {
      throw new Error(
        `Sequence '${sequenceName}': seq.effect() cannot be used while LinkAudio is enabled in v1.`,
      )
    }

    const resolvedPath = resolvePluginPath(
      spec,
      this.audioManager.getAudioPaths(),
      this.audioManager.getDocumentDirectory(),
      'effect',
    )

    const existing = this.declarations.get(sequenceName)
    if (existing) {
      if (existing.resolvedPath === resolvedPath && existing.pluginId === pluginId) {
        await existing.load
        // Self-heal on stale cache after a daemon respawn (see PluginEffectManager
        // for the full rationale). Engines without isPluginActive keep the old
        // no-op idempotent behavior.
        if (this.audioEngine.isPluginActive?.('effect', existing.bus) === false) {
          await this.issueLoad(sequenceName, existing.bus, resolvedPath, pluginId)
        }
        return existing.bus
      }
      throw new Error(
        `Sequence '${sequenceName}': seq.effect() supports one insert per sequence in v1; ` +
          `chains (multiple inserts) are reserved for future support.`,
      )
    }

    const bus = this.freedBuses.pop() ?? this.allocateFreshBus(sequenceName)
    try {
      await this.issueLoad(sequenceName, bus, resolvedPath, pluginId)
    } catch (err) {
      // ロールバック: 失敗した宣言の bus を free-list に返す（daemon 側も activation を
      // 巻き戻すため、両側の状態が対称に戻る）。
      this.freedBuses.push(bus)
      throw err
    }
    return bus
  }
```

`freedBuses` (a free-list returning the bus of a failed declaration) was
added during PR #461 review (an Important-severity finding). In live
coding, "typo → failure → fix → redeclare" is a normal cycle; if a failure
permanently consumed a bus from the pool, a handful of retries would
exhaust it. This is the fix.

`issueLoad`'s `await` guarantees that "declaration = activation" completes
**structurally before** the caller can send the next `PlayAt` — this is how
the producer-side calling discipline avoids the landmine described at the
top of this chapter.

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
it was not re-verified on real hardware by re-running
`outproc_effect_bus_gated.rs` while writing this page (note that the test's
own assertion is the wider `0.4..=0.6` range — the exact match is from the
WORK_LOG's measured record).

> **Known pitfall**: if a tagged `PlayAt` is sent without awaiting
> `drums.effect()`, the event is retained because the bus is not yet active
> (see `InsertBusStage`'s doc comment). This cannot happen through the DSL
> path since `effect()` is awaited structurally.

## Sources

- `rust/crates/orbit-audio-native/src/output.rs:131-149` — the `InsertBusStage` struct (meaning of the `processor`/`active` fields)
- `rust/crates/orbit-audio-native/src/output.rs:250-260` — `render_block`'s zero-bus fallback (bit-identical path)
- `rust/crates/orbit-audio-native/src/output.rs:293-308` — `render_engine_with_insert_buses`'s active-bus filter and target assembly
- `rust/crates/orbit-audio-daemon/src/engine_wrap.rs:240-248` — `DEFAULT_EFFECT_BUS_POOL_PREFIX` / `DEFAULT_EFFECT_BUS_POOL_SIZE`
- `rust/crates/orbit-audio-daemon/src/engine_wrap.rs:272-284` — `effect_buses_from_env` (`ORBIT_EFFECT_BUSES` priority, `ORBIT_EFFECT_BUS_POOL` fallback)
- `rust/crates/orbit-audio-daemon/src/engine_wrap.rs:286-300` — `EffectBusBuild` (bus components, shared active flag)
- `packages/engine/src/core/global/sequence-effect-manager.ts:65-112` — `SequenceEffectManager.effect()` (bus allocation, free-list rollback)
- `rust/crates/orbit-audio-daemon/tests/outproc_effect_bus_gated.rs` — gated real-hardware test (`EFFECT_GAIN=0.5`, ratio assertion `0.4..=0.6`)
- [`docs/core/INSTRUCTION_ORBITSCORE_DSL.md`](https://github.com/signalcompose/orbitscore/blob/main/docs/core/INSTRUCTION_ORBITSCORE_DSL.md) PH.2b — `seq.effect()` DSL spec (processing order, v1 constraints, cap of 8)
- [`docs/development/WORK_LOG.md`](https://github.com/signalcompose/orbitscore/blob/main/docs/development/WORK_LOG.md) 6.262 — #434 S1-S3 implementation record (real-hardware ratio 0.50000)
- Issue [#434](https://github.com/signalcompose/orbitscore/issues/434) — per-sequence effect insert
- PR [#461](https://github.com/signalcompose/orbitscore/pull/461) — merged implementation (includes free-list addition)
