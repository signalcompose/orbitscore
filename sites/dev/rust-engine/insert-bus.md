---
title: "RE-3. per-sequence insert bus（seq.effect()）"
chapter-id: "RE-3"
verified-against: 69dc968
verified-at: "2026-09-01"
status: draft
---

> **Note**: 本ページは 2026-09-01 時点での著者の reading の足跡です。code が真実、本ページはその時点の理解の snapshot に過ぎません。

# RE-3. per-sequence insert bus（seq.effect()）

`seq.effect()` は owner の長年の要望（`global.effect()` の master-only insert では
シーケンス単位で別々のエフェクトを掛けられない）に応える機能で、Issue
[#434](https://github.com/signalcompose/orbitscore/issues/434) として実装され PR
[#461](https://github.com/signalcompose/orbitscore/pull/461) でマージされました。本章は
render パイプラインの `InsertBusStage`、daemon 側の bus プール、そして「宣言 =
activation」という契約を追います。

この章が最初に書かれた 2026-07-17 以降、insert bus の上には mixer（sum / aux・#459/#453・#643）、
差し替え（#625）、ラック（#628）が積まれました。ラック（複数 insert を値として書く形）と
mixer の DSL 面は [SC-1](/signal-chain/) / [SC-2](/signal-chain/mixer-audio-line) 章に譲り、
ここでは「1 本の named bus がどう生まれ、どう render に載るか」という土台に絞ります。

## DAW の per-track insert と同型

```js
var drums = init global.seq
drums.audio("kick.wav")
drums.effect("~/plugins/TAL-Reverb-4.clap")   // この seq だけに掛かる insert
```

処理順は **per-sequence insert → master mix → `global.effect()`（master chain）** です。
master 経路の既存意味論は変えません（core spec PH.2b）。2026-09-01 時点の spec PH.2b が
述べる制約を整理すると次のとおりです。

| 項目 | 2026-07-17 時点の記述 | 2026-09-01 時点（PH.2b / PH.2d / SC.10） |
|---|---|---|
| insert の数 | 1 seq = 1 insert | 単発形 `effect("X")` は 1 要素のラックへ脱糖。複数 insert は配列形 `effect(["A", "B"])`（#628） |
| 受理フォーマット | `.clap` のみ | `.clap` / `.vst3`（effect と同じ）。`.component` は未対応 |
| 再宣言 | 同一 spec は冪等 | 同一 spec は冪等。**異なる spec は差し替え**（#625・PH.2d）。削除は配列から消す |
| 同時に insert を持てる seq 数 | 既定 8 | 既定 8（`DEFAULT_EFFECT_BUS_POOL_SIZE` / `SEQUENCE_EFFECT_BUS_POOL_SIZE` とも 8 で一致） |

「1 seq = 1 **bus**」という対応はそのままです。変わったのは bus の上に載るものが「1 plugin」から
「1 ラック（rack child が直列に回すチェーン）」になった点で、bus の確保・activation・render の
仕組みは #434 のままです。

## `InsertBusStage`: named routing tag を受ける per-bus insert stage

render 側の核は `orbit-audio-native` の `InsertBusStage` です。`processor=None` は
「effect 未 attach だが登録済みの bus」を表し、この状態でも event を
`render_multi` に渡して必ず消費します — 消費しないと未 attach bus に tag された
event が retain され続けます（後述の landmine）。

```rust
// rust/crates/orbit-audio-native/src/output.rs:755-774
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

`active: Arc<AtomicBool>` が「宣言 = activation」契約の実体です。この flag は daemon
側の `EffectBusBuild.active` と共有され、`seq.effect()` の `LoadPlugin`（ラック形では
`ApplyEffectChain`）が bus を指名した瞬間に `true` へ store されます。**別途 activation ステップは
存在しません** — `seq.effect()` を呼ぶこと自体が bus を有効化します。

コメントが警告する ⚠ landmine（inactive bus に tag された event は消費されず
永久 retain される）は TS 側で「宣言を `await` してから tag 付き `PlayAt` を送る」
という順序で構造的に回避しています（後述の `SequenceEffectManager.effect()` 参照）。
加えて #461 のレビュー以降、core の `Scheduler::unroutable_event_count` を 1 Hz ticker が
監視し、`UNROUTABLE_EVENTS` の `DaemonError` として「宣言前 tag / 名前 typo」を可視化します
（`protocol.rs:157-161`）。

`InsertBusStage` は 2026-07-17 時点の 4 フィールドに加えて、mixer 用の `output_target` /
`sends` / `routing_override` / `send_gain_overrides` を持つようになりました（`output.rs:397-412`）。
これらは「この bus の出力をどこへ足すか」を決めるもので、SC-2 章の主題です。

## bus 0 個ならビット同一の従来経路

RE-1 で見た `render_engine_with_sources` は、insert bus が 1 つも active でなければ従来の
`render_engine`（bus 無し経路）へ完全にフォールバックします。これにより `seq.effect()` を一度も
使わないセッションは bus プールのコストを一切払いません。

```rust
// rust/crates/orbit-audio-native/src/output.rs:1100-1105
    if sources.is_empty() {
        if buses.iter().any(|bus| bus.active.load(Ordering::Relaxed)) {
            render_engine_with_insert_buses(engine, link, buses, output_channels, hw);
        } else {
            render_engine(engine, link, output_channels, hw);
        }
```

active な bus がある場合は `render_engine_with_insert_buses`（instrument source があれば
`render_engine_with_insert_buses_and_source_outputs`）が呼ばれます。`active` フラグは callback の
冒頭で 1 回だけ atomic load して `ArrayVec` に snapshot し、その後の marking pass と加算 pass で
使い回します（同じ atomic を 2 回 load すると、callback の途中に `SetBusRouting` が挟まったとき
両 pass の見え方が食い違うため）。

```rust
// rust/crates/orbit-audio-native/src/output.rs:1216-1222
    let bs = (hw.len() / output_channels) * output_channels;

    // active フラグを 1 回だけ atomic load して使い回す（RT: 同じ判定を何度も load しない）。
    let active_flags: ArrayVec<bool, MAX_INSERT_BUS_STAGES> = buses
        .iter()
        .map(|bus| bus.active.load(Ordering::Relaxed))
        .collect();
```

## daemon の既定 bus プール — `ORBIT_EFFECT_BUS_POOL`

`orbit-audio-daemon` の `engine_wrap.rs` は起動時に `seq-bus-0`〜`seq-bus-N`
という名前の inactive `InsertBusStage` を N 個（既定 8、`ORBIT_EFFECT_BUS_POOL`
で変更可・`"0"` で無効化）プールとして確保します。この prefix は TS 側の
`SequenceEffectManager` と数値・文字列とも一致させる必要がある契約です。

```rust
// rust/crates/orbit-audio-daemon/src/engine_wrap.rs:1998-2006
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
いればそれを優先し、無ければ `ORBIT_EFFECT_BUS_POOL` に従って既定プールを生成します:

```rust
// rust/crates/orbit-audio-daemon/src/engine_wrap.rs:2030-2042
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
を持ちます。「宣言 = activation」の実体はここでも同じ flag です。2026-07-17 時点との差分は
`kind: BusKind`（insert / sum / aux）と mixer 用の routing 共有 Arc が足された点です。

```rust
// rust/crates/orbit-audio-daemon/src/engine_wrap.rs:2120-2142
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

`build_effect_bus_stages` は insert / sum / aux の 3 プールを `[insert…, sum…, aux…]` の順に
1 つの stage 配列へ並べます（insert → sum/aux への forward-only 参照が常に構築できるよう、
insert を先頭に置く・MX.4）。上限は `orbit_audio_native::MAX_INSERT_BUS_STAGES` です。

## TS 側: `SequenceEffectManager` の bus 割り当てと free-list

`packages/engine/src/core/global/sequence-effect-manager.ts` の
`SequenceEffectManager` は、seq 名 → bus 名の対応を `Map` で管理します。
2026-07-17 時点では bus 割り当て・free-list・冪等再宣言のロジックを自前で持っていましたが、
#468 / #527 で `effect-slot.ts` の共通基盤（`BusPool` + `EffectChainMap`）へ委譲されました。
prefix と pool size の定数は Rust 側と対で保守する契約です。

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

`effect()` 本体はこうなっています。この manager 固有なのは「passthrough bus（`ensureBus()` —
plugin 未ロードのまま `seq.output()` / `seq.send()` の routing 用に割り当てた bus・MX.4）と
insert の分離」と「昇格失敗時に bus を返却しないロールバック」だけです。

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

`freedBuses`（失敗した宣言の bus を返却する free-list）は PR #461 のレビュー
（Important 指摘）で追加されました。ライブコーディングでは「typo → 失敗 → 直して
再宣言」が普通に起こるため、失敗が bus pool を恒久消費すると数回のリトライで
プールが枯渇してしまいます — その対策です。free-list は `BusPool` へ移り、`MixerManager`
（sum / aux）とも共有されています。

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

`slots.applyRack()` が `await` を挟むことで、「宣言 = activation」が **構造的に先に完了
してから** 呼び出し側が次の `PlayAt` を送れることを保証しています（RE-3 冒頭の
landmine を producer 側の呼び出し規律で回避する仕組み）。`applyRack` は 1 回の
`ApplyEffectChain` command で「前回のチェーンとの差分（LCS）」を daemon に prepare-commit させる
形で、`mode` は通常 `'diff'`、respawn 後で daemon 側の registry が信用できないときだけ `'rebuild'`
になります。

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

ここで気をつけたいのは catch 節のコメントにある「`!hadBus` の判定はもう有効ではない」という
話です。同一 seq への `effect()` を `await` せず連打すると、後続呼び出しは per-key の直列化
キューに並びます。先頭の宣言が失敗しても後続が成功して同じ bus に生きた宣言を持ち得るため、
bus を pool へ返すのは `slots.settled()` でキューが片付いたあと、本当に誰も宣言を持っていない
場合だけです（#527 review round 3）。

## Try it: `seq.effect()` の実機 E2E

以下は Issue #434 の実機 gated テストで確認された手順です（WORK_LOG 6.262、
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
master sum、という経路全体を客観的に実証できます。

```bash
ORBIT_EFFECT_BUSES=fx1 cargo test -p orbit-audio-daemon --features outproc-effect \
  --test outproc_effect_bus_gated -- --ignored --nocapture --test-threads=1
```

**期待値**: `EFFECT_GAIN = 0.5` に対して `dry_peak` / `post_peak` の
gain ratio **≈ 0.5**（テストは `(0.4..=0.6).contains(&bus_ratio)` で許容幅を
取っています）。WORK_LOG 6.262 の実機記録では **ratio 0.50000 厳密一致**
（sine 単体 peak 0.70711 → bus 経由後 0.35355）と記載されています。この厳密値は
WORK_LOG の記述であり、本ページの再読（2026-09-01）でも `outproc_effect_bus_gated.rs` を
実機で再実行してはいません（テスト自体の assert は `0.4..=0.6` という許容レンジです）。

ユーザーと同じ動線（OrbitStudio + MCP）を通す E2E は `tests/e2e/orbitstudio-mcp-gated.spec.ts`
に積まれており、`npm run test:e2e:gated` で回します（[RE-4](/rust-engine/capture-verification)
参照）。

> **注意（既知の落とし穴）**: `drums.effect()` の `await` を待たずに `PlayAt` を
> tag 付きで送ると、bus が未 activation のまま event が retain されます
> （`InsertBusStage` の doc コメント参照）。DSL 経由では `effect()` が
> `await` されるため構造的に発生しません。

## 次の深掘り候補

- `ApplyEffectChain` の daemon 側（`outproc_effect::ApplyEffectChainMode` の diff / rebuild と rack child の prepare-commit）
- `ensureBus()` の passthrough bus が `seq.output()` / `seq.send()` からどう参照されるか（SC-2 と接続）
- `EffectChainMap.enqueue` の per-key 直列化と、`settled()` を待たずに bus を返却したときの故障シナリオ
- `UNROUTABLE_EVENTS` の観測点（`Scheduler::unroutable_event_count`）と、typo 宣言時のユーザー体験

## Sources

- `rust/crates/orbit-audio-native/src/output.rs:377-412` — `InsertBusStage` 構造体（`processor`/`active` と mixer 用フィールドの意味）
- `rust/crates/orbit-audio-native/src/output.rs:709-750` — `render_engine_with_sources` の bus 0 個フォールバック（bit-identical 経路）
- `rust/crates/orbit-audio-native/src/output.rs:823-846` — `render_engine_with_insert_buses_and_source_outputs` の active flag snapshot
- `rust/crates/orbit-audio-daemon/src/engine_wrap.rs:1904-1948` — `DEFAULT_EFFECT_BUS_POOL_PREFIX` / `DEFAULT_EFFECT_BUS_POOL_SIZE` / `effect_buses_from_env`
- `rust/crates/orbit-audio-daemon/src/engine_wrap.rs:2026-2075` — `EffectBusBuild` と `build_effect_bus_stages`（insert/sum/aux の並び）
- `rust/crates/orbit-audio-daemon/src/protocol.rs:157-161` — `ERROR_CODE_UNROUTABLE_EVENTS`
- `packages/engine/src/core/global/sequence-effect-manager.ts:1-162` — `SequenceEffectManager`（定数・`ensureBus`・`effect()` のロールバック）
- `packages/engine/src/core/global/effect-slot.ts:454-472,980-1011` — `EffectChainMap.applyRack` の mode 決定、`BusPool`
- `rust/crates/orbit-audio-daemon/tests/outproc_effect_bus_gated.rs` — gated 実機テスト（`EFFECT_GAIN=0.5`・ratio assert `0.4..=0.6`）
- [`docs/core/INSTRUCTION_ORBITSCORE_DSL.md`](https://github.com/signalcompose/orbitscore/blob/main/docs/core/INSTRUCTION_ORBITSCORE_DSL.md) PH.2b / PH.2d — `seq.effect()` の DSL 規範（処理順・受理フォーマット・上限 8・差し替え）
- [`docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md`](https://github.com/signalcompose/orbitscore/blob/main/docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md) SC.10 — ラック形の正本
- [`docs/archive/WORK_LOG_2026-07.md`](https://github.com/signalcompose/orbitscore/blob/main/docs/archive/WORK_LOG_2026-07.md) 6.262 — #434 S1〜S3 実装記録（ratio 0.50000 実機記録）
- Issue [#434](https://github.com/signalcompose/orbitscore/issues/434) — per-sequence effect insert
- PR [#461](https://github.com/signalcompose/orbitscore/pull/461) — マージ済み実装（free-list 追加を含む）
- Issue [#625](https://github.com/signalcompose/orbitscore/issues/625) / [#628](https://github.com/signalcompose/orbitscore/issues/628) — insert の差し替え・削除 / effect rack
