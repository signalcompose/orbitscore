---
title: "RE-3. per-sequence insert bus（seq.effect()）"
chapter-id: "RE-3"
verified-against: 3983828
verified-at: "2026-07-17"
status: draft
---

> **Note**: 本ページは 2026-07-17 時点での著者の reading の足跡です。code が真実、本ページはその時点の理解の snapshot に過ぎません。

# RE-3. per-sequence insert bus（seq.effect()）

`seq.effect()` は owner の長年の要望（`global.effect()` の master-only insert では
シーケンス単位で別々のエフェクトを掛けられない）に応える機能で、Issue
[#434](https://github.com/signalcompose/orbitscore/issues/434) として実装され PR
[#461](https://github.com/signalcompose/orbitscore/pull/461) でマージされた。本章は
render パイプラインの `InsertBusStage`、daemon 側の bus プール、そして「宣言 =
activation」という契約を追う。

## DAW の per-track insert と同型

```js
var drums = init global.seq
drums.audio("kick.wav")
drums.effect("~/plugins/TAL-Reverb-4.clap")   // この seq だけに掛かる insert
```

処理順は **per-sequence insert → master mix → `global.effect()`（master chain）**。
master 経路の既存意味論は変えない（core spec PH.2b）。v1 は 1 seq = 1 insert、
`.clap` のみ受理（`.vst3` / `.component` は effect 系では未対応）、同時に insert を
持てる seq 数の上限は既定 8。

## `InsertBusStage`: named routing tag を受ける per-bus insert stage

render 側の核は `orbit-audio-native` の `InsertBusStage`。`processor=None` は
「effect 未 attach だが登録済みの bus」を表し、この状態でも event を
`render_multi` に渡して必ず消費する — 消費しないと未 attach bus に tag された
event が retain され続ける（後述の landmine）。

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

`active: Arc<AtomicBool>` が「宣言 = activation」契約の実体。この flag は daemon
側の `EffectBusBuild.active` と共有され、`seq.effect()` の `LoadPlugin` が bus を
指名した瞬間に `true` へ store される。**別途 activation ステップは存在しない**
— `seq.effect()` を呼ぶこと自体が bus を有効化する。

コメントが警告する ⚠ landmine（inactive bus に tag された event は消費されず
永久 retain される）は TS 側で「宣言を `await` してから tag 付き `PlayAt` を送る」
という順序で構造的に回避している（後述の `SequenceEffectManager.effect()` 参照）。

## bus 0 個ならビット同一の従来経路

`render_block` は、insert bus が 1 つも active でなければ従来の `render_engine`
（bus 無し経路）へ完全にフォールバックする。これにより `seq.effect()` を一度も
使わないセッションは bus プールのコストを一切払わない。

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

active な bus がある場合は `render_engine_with_insert_buses` が呼ばれ、
`inactive` な bus を skip しつつ `render_multi` の target 配列に named bus を
積み、bus ごとの `processor`（あれば）を通してから `hw` に加算する:

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

## daemon の既定 bus プール — `ORBIT_EFFECT_BUS_POOL`

`orbit-audio-daemon` の `engine_wrap.rs` は起動時に `seq-bus-0`〜`seq-bus-N`
という名前の inactive `InsertBusStage` を N 個（既定 8、`ORBIT_EFFECT_BUS_POOL`
で変更可・`"0"` で無効化）プールとして確保する。この prefix は TS 側の
`SequenceEffectManager` と数値・文字列とも一致させる必要がある契約になっている。

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

`ORBIT_EFFECT_BUSES`（明示 bus 名リスト・既存 S2 の後方互換経路）が設定されて
いればそれを優先し、無ければ `ORBIT_EFFECT_BUS_POOL` に従って既定プールを生成する:

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

各 bus は `EffectBusBuild` として構築時に shm・engaged/stop/done フラグ・stats・
そして render 側の `InsertBusStage::active` と共有する `active: Arc<AtomicBool>`
を持つ。「宣言 = activation」の実体はここでも同じ flag:

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

## TS 側: `SequenceEffectManager` の bus 割り当てと free-list

`packages/engine/src/core/global/sequence-effect-manager.ts` の
`SequenceEffectManager` は、seq 名 → bus 名の対応を `Map` で管理する。
`PluginEffectManager` / `PluginInstrumentManager` の「eager ロード + 冪等再宣言」
パターンをそのまま踏襲しつつ、単一 master slot ではなく seq 名でキーする。

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

`freedBuses`（失敗した宣言の bus を返却する free-list）は PR #461 のレビュー
（Important 指摘）で追加された。ライブコーディングでは「typo → 失敗 → 直して
再宣言」が普通に起こるため、失敗が bus pool を恒久消費すると数回のリトライで
プールが枯渇してしまう — その対策。

`issueLoad` が `await` を挟むことで、「宣言 = activation」が **構造的に先に完了
してから** 呼び出し側が次の `PlayAt` を送れることを保証している（RE-3 冒頭の
landmine を producer 側の呼び出し規律で回避する仕組み）。

## Try it: `seq.effect()` の実機 E2E

以下は Issue #434 の実機 gated テストで確認された手順（WORK_LOG 6.262、
`rust/crates/orbit-audio-daemon/tests/outproc_effect_bus_gated.rs`）。

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

daemon を `outproc-effect` feature + `ORBIT_EFFECT_BUSES=fx1`（または既定
`ORBIT_EFFECT_BUS_POOL` で `seq-bus-0` を使う DSL 経路）で起動し、
`ORBIT_CAPTURE_WAV` で capture すると、DSL → `LoadPlugin(bus)` →
`PlayAt(bus)` → `render_multi` の bus routing → OOP effect child gain →
master sum、という経路全体を客観的に実証できる。

```bash
ORBIT_EFFECT_BUSES=fx1 cargo test -p orbit-audio-daemon --features outproc-effect \
  --test outproc_effect_bus_gated -- --ignored --nocapture --test-threads=1
```

**期待値**: `EFFECT_GAIN = 0.5` に対して `dry_peak` / `post_peak` の
gain ratio **≈ 0.5**（テストは `(0.4..=0.6).contains(&bus_ratio)` で許容幅を
取っている）。WORK_LOG 6.262 の実機記録では **ratio 0.50000 厳密一致**
（sine 単体 peak 0.70711 → bus 経由後 0.35355）と記載されている。この厳密値は
WORK_LOG の記述であり、本ページ執筆時点で `outproc_effect_bus_gated.rs` を
実機で再実行して再確認したわけではない点に注意（テスト自体の assert は
`0.4..=0.6` という許容レンジであり、厳密一致は WORK_LOG の実測記録に基づく）。

> **注意（既知の落とし穴）**: `drums.effect()` の `await` を待たずに `PlayAt` を
> tag 付きで送ると、bus が未 activation のまま event が retain される
> （`InsertBusStage` の doc コメント参照）。DSL 経由では `effect()` が
> `await` されるため構造的に発生しない。

## Sources

- `rust/crates/orbit-audio-native/src/output.rs:131-149` — `InsertBusStage` 構造体（`processor`/`active` フィールドの意味）
- `rust/crates/orbit-audio-native/src/output.rs:250-260` — `render_block` の bus 0 個フォールバック（bit-identical 経路）
- `rust/crates/orbit-audio-native/src/output.rs:293-308` — `render_engine_with_insert_buses` の active bus フィルタと target 組み立て
- `rust/crates/orbit-audio-daemon/src/engine_wrap.rs:240-248` — `DEFAULT_EFFECT_BUS_POOL_PREFIX` / `DEFAULT_EFFECT_BUS_POOL_SIZE`
- `rust/crates/orbit-audio-daemon/src/engine_wrap.rs:272-284` — `effect_buses_from_env`（`ORBIT_EFFECT_BUSES` 優先・`ORBIT_EFFECT_BUS_POOL` フォールバック）
- `rust/crates/orbit-audio-daemon/src/engine_wrap.rs:286-300` — `EffectBusBuild`（bus 部材・active flag 共有）
- `packages/engine/src/core/global/sequence-effect-manager.ts:65-112` — `SequenceEffectManager.effect()`（bus 割り当て・free-list ロールバック）
- `rust/crates/orbit-audio-daemon/tests/outproc_effect_bus_gated.rs` — gated 実機テスト（`EFFECT_GAIN=0.5`・ratio assert `0.4..=0.6`）
- [`docs/core/INSTRUCTION_ORBITSCORE_DSL.md`](https://github.com/signalcompose/orbitscore/blob/main/docs/core/INSTRUCTION_ORBITSCORE_DSL.md) PH.2b — `seq.effect()` の DSL 規範（処理順・v1 制約・上限 8）
- [`docs/development/WORK_LOG.md`](https://github.com/signalcompose/orbitscore/blob/main/docs/development/WORK_LOG.md) 6.262 — #434 S1〜S3 実装記録（ratio 0.50000 実機記録）
- Issue [#434](https://github.com/signalcompose/orbitscore/issues/434) — per-sequence effect insert
- PR [#461](https://github.com/signalcompose/orbitscore/pull/461) — マージ済み実装（free-list 追加を含む）
