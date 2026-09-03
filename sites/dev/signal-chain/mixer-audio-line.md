---
title: "SC-2. ミキサーとオーディオライン — sum / aux / send / output / master gain"
chapter-id: "SC-2"
verified-against: 69dc968
verified-at: "2026-09-01"
status: draft
---

> **Note**: 本ページは 2026-09-01 時点での著者の reading の足跡です。code が真実、本ページはその時点の理解の snapshot に過ぎません。

# SC-2. ミキサーとオーディオライン — sum / aux / send / output / master gain

本章は OrbitScore の「ミキサー」を追います。`global.sum()` / `global.aux()` で宣言した bus に
`seq.output()` / `seq.send()` で音を流し込み、`global.gain()` でマスターを絞る — DAW なら
ミキサー画面で当たり前にやる操作が、TS の DSL 層から Rust daemon の render callback まで
どう配線されているかを、仕様（core spec MX.1〜MX.5）と実装の両方から読みます。

対象 Issue は 4 つです。ミキサー DSL の仕様を決めた
[#453](https://github.com/signalcompose/orbitscore/issues/453) /
[#459](https://github.com/signalcompose/orbitscore/issues/459)、instrument をミキサーの
source に載せ替えてマスターフェーダーを配線し直した
[#643](https://github.com/signalcompose/orbitscore/issues/643)、そして「フェーダーという段を
作らない」オーディオライン設計の
[#649](https://github.com/signalcompose/orbitscore/issues/649)。最後の #649 は 2026-08-30 時点で
**設計のみ**で実装されていないので、本章では「決まっていること」と「まだ決まっていないこと」を
分けて読みます。

per-sequence insert bus（`seq.effect()`）そのものは [RE-3](/rust-engine/insert-bus) が扱って
いるので、本章は「insert bus の**先**」— bus 同士の合流と master への出口 — に集中します。
capture E2E の仕組みは [RE-4](/rust-engine/capture-verification) を参照してください。

## ルーティングモデル — source は行き先を指す

まず仕様の絵を頭に入れましょう。core spec MX.1 は次の一文でモデルを定義しています。

> グラフは **source（seq）→ 任意の per-seq insert（PH.2b）→ sum（group bus）→ master** の直列と、
> **send → aux（return bus）→ master** の並列タップで構成する。エッジは常に **source が行き先を指す**。
> reconciliation key は名前（同名 = 同一 node・再評価は再束縛）。
>
> — `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` MX.1

図にするとこうなります。

```mermaid
flowchart LR
  kick["kick (seq)"] --> ki["kick insert<br/>seq-bus-n"]
  snare["snare (seq)"] --> si["snare insert<br/>seq-bus-m"]
  ki -->|"output('drum')"| drum["sum 'drum'<br/>sum-bus-0"]
  si -->|"output('drum')"| drum
  ki -.->|"send('rev', 0.3)"| rev["aux 'rev'<br/>aux-bus-0"]
  drum --> master["master<br/>(global.gain / global.effect)"]
  rev --> master
  master --> hw["hardware"]
```

ポイントは「**エッジは source が行き先を指す**」という向きです。sum bus 側が「メンバーは kick と
snare」と列挙するのではなく、kick と snare がそれぞれ `output("drum")` と宣言します。
これは後で見る `SetBusRouting` の形（seq bus が output 先と send 先を持つ）にそのまま対応します。

仕様の DSL サンプルも引用しておきます（spec の Markdown から逐語）。

```js
// docs/core/INSTRUCTION_ORBITSCORE_DSL.md:1660-1664
global.sum("drum")                    // group bus 宣言（冪等）
kick.output("drum")                   // メンバーシップ = 行き先指定
snare.output("drum")
sum("drum").effect("GlueComp.clap")   // group bus 自身の insert（v1 は 1 基・PH.2b と同規則）
sum("drum").remove("GlueComp")        // 外す（差し替え・削除は PH.2d）
```

```js
// docs/core/INSTRUCTION_ORBITSCORE_DSL.md:1712-1714
global.aux("rev")                     // return bus 宣言
aux("rev").effect("Reverb.clap")      // return の insert（v1 必須要素）
kick.send("rev", 0.3)                 // send（copy・原音は継続して master/sum へ）
```

v1 の制約として、MX.5 は **PDC（plugin latency 補償）なし・sum のネスト不可・send は
post-fader 固定・LinkAudio と相互排他** を明記しています。「post-fader 固定」は #649 で
覆される予定の項目なので、後半でもう一度触れます。

## DSL の入口: `global.sum()` / `global.aux()` → `MixerManager`

TS 側の司令塔は `packages/engine/src/core/global/mixer-manager.ts` の `MixerManager` です。
`Global.sum(name)` / `Global.aux(name)`（`global.ts:481-489`）は `this.mixerManager.sum(name)` /
`.aux(name)` へ委譲するだけの薄い入口で、実体は `declareBus`（`mixer-manager.ts:251-283`）に
あります。空文字チェックの後に、bus 名の予約・LinkAudio 排他・pool からの確保、という 3 段が
並びます。

```typescript
// packages/engine/src/core/global/mixer-manager.ts:263-283
    if (name === 'master') {
      throw new Error(
        `global.${kind}("master") is reserved: "master" names the output endpoint, not a ` +
          `${kind} bus. Choose a different name for this ${kind} bus.`,
      )
    }
    if (this.linkAudioManager.isEnabled()) {
      throw new Error(`global.${kind}() cannot be used while LinkAudio is enabled in v1.`)
    }

    const state = this.kinds[kind]
    let bus = state.buses.get(name)
    if (bus === undefined) {
      bus = state.pool.acquire(name)
      state.buses.set(name, bus)
      if (this.kindsWithBus(name).length > 1) {
        console.warn(MixerManager.ambiguousMessage(name))
      }
    }
    return this.makeHandle(kind, name, bus)
  }
```

`"master"` が予約語として弾かれている理由がコメントに書かれています。後述の
`SetBusRouting` は `output: "master"` を「sum への出力を解除して master へ戻す」という
予約語として解釈するので、同名の sum bus が存在すると黙って影に隠れてしまうのです。
`var master = mix.sum` のような Signal Chain のノード宣言形も同じ `sum()` に到達するため、
ここ 1 箇所でガードする、という設計です。

冪等性にも注目してください。`state.buses.get(name)` が既にあれば pool から取らずに同じ bus を
返します。仕様の「同名 = 同一 node・再評価は再束縛」を、名前をキーにした `Map` で
そのまま実現しています。

### bus 名の契約: TS と Rust で prefix を共有する

pool から確保される名前は `sum-bus-0` … `sum-bus-3` / `aux-bus-0` … `aux-bus-3` です。
prefix と上限は TS 側の定数として置かれていて、コメントが「Rust 側と一致させること」と
明言しています。

```typescript
// packages/engine/src/core/global/mixer-manager.ts:16-29
/**
 * `sum-bus-<n>` / `aux-bus-<n>` default pool prefixes. Must match
 * `DEFAULT_SUM_BUS_POOL_PREFIX` / `DEFAULT_AUX_BUS_POOL_PREFIX` in
 * `rust/crates/orbit-audio-daemon/src/engine_wrap.rs` (MX.4, #459/#453 M3) — changing
 * one requires changing the other.
 */
export const SUM_BUS_PREFIX = 'sum-bus-'
export const AUX_BUS_PREFIX = 'aux-bus-'

/**
 * v1 cap: at most 4 sum buses and 4 aux buses concurrently declared. Must match
 * `DEFAULT_SUM_BUS_POOL_SIZE` / `DEFAULT_AUX_BUS_POOL_SIZE` in `engine_wrap.rs`.
 */
export const MIXER_BUS_POOL_SIZE = 4
```

対応する Rust 側の定数は daemon の `engine_wrap.rs` にあります。

```rust
// rust/crates/orbit-audio-daemon/src/engine_wrap.rs:1963-1976
/// `sum-bus-<n>` 既定プールの名前 prefix。TS 側 `seq.output(sum)` が同じ規則で名前を組み立てる
/// （M3 で配線予定）。
#[cfg(feature = "outproc-effect")]
pub const DEFAULT_SUM_BUS_POOL_PREFIX: &str = "sum-bus-";
/// `aux-bus-<n>` 既定プールの名前 prefix。TS 側 `seq.send(aux, gain)` が同じ規則で名前を組み立てる
/// （M3 で配線予定）。
#[cfg(feature = "outproc-effect")]
pub const DEFAULT_AUX_BUS_POOL_PREFIX: &str = "aux-bus-";
/// `ORBIT_SUM_BUS_POOL` の既定サイズ（未設定時）。
#[cfg(feature = "outproc-effect")]
const DEFAULT_SUM_BUS_POOL_SIZE: usize = 4;
/// `ORBIT_AUX_BUS_POOL` の既定サイズ（未設定時）。
#[cfg(feature = "outproc-effect")]
const DEFAULT_AUX_BUS_POOL_SIZE: usize = 4;
```

つまり `global.sum("drum")` と書いたとき、daemon には `"drum"` という名前は届きません。
TS が `"drum" → "sum-bus-0"` と束縛し、daemon へは常に `sum-bus-0` のような pool 名で
話しかけます。daemon 側は起動時に `ORBIT_SUM_BUS_POOL` / `ORBIT_AUX_BUS_POOL`（既定 4）の
数だけ inactive な stage を確保して待っている、という構図です（insert bus の
`ORBIT_EFFECT_BUS_POOL` と同じ機構・[RE-3](/rust-engine/insert-bus) 参照）。

面白いのは、daemon が bus の「種類」を prefix 文字列からではなく構築時の enum
`BusKind { Insert, Sum, Aux }`（`engine_wrap.rs:1950-1961`）で持っている点です。doc コメントは
「`SetBusRouting` の検証を prefix 文字列比較に依存させないため、構築時に確定した値として明示的に
持つ」と説明しています。この `BusKind` が、後で見る `SetBusRouting` の検証（output 先は sum のみ・send 先は aux のみ）の
根拠になります。名前の規則と種類の検証を分離しておくことで、prefix を変えても検証ロジックが
壊れない作りです。

## `seq.output()` の 3 分岐と `seq.send()`

次に、sequence 側から bus へ「行き先を指す」入口を読みます。`Sequence.output()` は引数が
sum 名なのか、数値の render bus なのか、LinkAudio channel 名なのかで **3 分岐** します。
解決順は仕様（#598 §4.4）で固定されていて、コード上もその順で並んでいます。

```typescript
// packages/engine/src/core/sequence.ts:350-375
  output(channelName: string | number): this {
    const name = this.stateManager.getName() || 'sequence'
    const destinationName = typeof channelName === 'number' ? String(channelName) : channelName
    if (!destinationName || !destinationName.trim()) {
      throw new Error(`Sequence '${name}': output(channelName) requires a non-empty channel name.`)
    }

    // Resolution order is normative (#598 §4.4): an existing sum named "1" must still win over
    // numeric render-bus interpretation. This lookup therefore deliberately precedes the number
    // branch below.
    const sumBus = this.global.resolveSumBus(destinationName)
    if (sumBus) {
      if (this.isMidi()) {
        throw new Error(
          `Sequence '${name}': output("${destinationName}") cannot target a mixer bus. ` +
            `MIDI is sent to an external device and therefore has no mixer output destination.`,
        )
      }
      // §4.4.1: live 宛先の宣言は render bus をクリアする（stale な offline 宛先を残さない）。
      this._renderBus = undefined
      this._insertBus = this._insertBus ?? this.global.ensureSequenceInsertBus(name)
      this._sumOutputBus = sumBus
      this.syncBusRouting()
      this.syncInstrumentSourceRouting()
      return this
    }
```

sum 分岐で注目したいのは `this._insertBus ?? this.global.ensureSequenceInsertBus(name)` です。
`seq.effect()` を宣言していない sequence でも、`output(sum)` を呼んだ瞬間に
**plugin を載せない pass-through の insert bus** が確保されます。daemon にとって routing の
source は常に「seq bus」なので、bus が無いと `SetBusRouting` の主語が作れないからです。
`SequenceEffectManager.ensureBus()` の doc コメント（`sequence-effect-manager.ts:89-97`）が
「DAW の、insert plugin は無いが routing 可能な track」と例えてこの事情を説明しています。本体は
短く、`Map` にあれば返し、無ければ pool から取るだけです。

```typescript
// packages/engine/src/core/global/sequence-effect-manager.ts:98-104
  ensureBus(sequenceName: string): string {
    const existing = this.buses.get(sequenceName)
    if (existing) return existing
    const bus = this.pool.acquire(sequenceName)
    this.buses.set(sequenceName, bus)
    return bus
  }
```

残りの 2 分岐（数値 render bus は `sequence.ts:377-401`・LinkAudio channel は `403-432`）には
#643 PR-2 で instrument 向けのガードが追加されました。instrument の `output(1)` は「offline render
bus は instrument 未対応」、`output("Kick Ch")` は「LinkAudio は instrument 向けに未配線」として
それぞれ throw します。「宛先だけ記録して音が従わない silent failure」を避けるためです
（設計文書 §12 の 3 分岐表・midi 側は破壊的変更になるため据え置き）。

MIDI シーケンスは sum 分岐で例外になります（`isMidi()` → throw）。#643 の設計文書が owner
の言葉として記録している「三条」— **ミキサーの bus 仕様は audio と instrument で同一・
midi だけがミキサーと無関係・例外は LinkAudio が出力先の時だけ** — が、ここのガード分割に
そのまま現れています。

`send()` も同じ形です。aux が未宣言ならエラー、`amount` は有限値のみ、複数回呼べば
fan-out、同じ aux 名なら上書きです。

```typescript
// packages/engine/src/core/sequence.ts:454-481
  send(auxName: string, amount: number): this {
    const name = this.stateManager.getName() || 'sequence'
    if (!auxName || !auxName.trim()) {
      throw new Error(`Sequence '${name}': send(auxName, amount) requires a non-empty aux name.`)
    }
    if (this.isMidi()) {
      throw new Error(
        `Sequence '${name}': send() cannot target a mixer bus. ` +
          `MIDI is sent to an external device and therefore has no mixer output destination.`,
      )
    }
    const auxBus = this.global.resolveAuxBus(auxName)
    if (!auxBus) {
      throw new Error(
        `Sequence '${name}': send("${auxName}", ...) references an undeclared aux bus. ` +
          `Call global.aux("${auxName}") first.`,
      )
    }
    if (!Number.isFinite(amount)) {
      throw new Error(`Sequence '${name}': send("${auxName}", ${amount}) gain must be finite.`)
    }

    this._insertBus = this._insertBus ?? this.global.ensureSequenceInsertBus(name)
    this._auxSends.set(auxBus, amount)
    this.syncBusRouting()
    this.syncInstrumentSourceRouting()
    return this
  }
```

`_auxSends` が `Map<string, number>` で、キーが **pool 名（`aux-bus-n`）** になっている点は
覚えておいてください。#649 の設計が「メソッドは完全に独立したスライスを更新する」と
確認した根拠の 1 つがこの Map です。

## routing を daemon へ届ける: `SetBusRouting`

`output()` / `send()` の末尾で呼ばれる `syncBusRouting()`（`sequence.ts:543-570`）は
fire-and-forget で、`this.global.setBusRouting(bus, this._sumOutputBus, buildRoutingSends(this._auxSends))`
と **output + 全 send を毎回まとめて** `SetBusRouting` に載せます。差分ではなく全量を送るのは、
再送が冪等になるようにするためです。失敗時は `_busRoutingStale` を立て、`DaemonProtocolError`
（daemon 側の決定的な拒否）なら `console.error` で「routing was NOT applied」、それ以外は
`console.warn` で「will re-sync」と出し分けます。Signal Chain 構文から呼ばれる awaitable 版が
`pushBusRouting()`（`522-535`）で、同じ引数を組み立てます。

`RustEnginePlayer.setBusRouting`（`rust-engine-player.ts:949-969`）は intent-first のキャッシュ
`busRoutings` を持ち、transport 断では intent を残して respawn 後に `reapplyBusRoutingAfterRespawn`
が再送、daemon が `DaemonProtocolError` で決定的に拒否した場合だけキャッシュを巻き戻します。
respawn した daemon は routing atomic が既定値に戻っているので、この再送が無いと sum / aux への
routing が黙って per-sequence 出力に退化します。

daemon 側 `set_bus_routing` の検証を見ると、「output 先は自分より後ろの stage で、かつ
`BusKind::Sum`」「send 先は後ろの stage で `BusKind::Aux`」「1 件でも失敗したら何も反映しない」
という規則が読み取れます。

```rust
// rust/crates/orbit-audio-daemon/src/engine_wrap.rs:5797-5817
        // 1. output target を検証（反映はまだしない・部分適用を避ける）。
        let resolved_output = match output {
            Some("master") => Some(1),
            Some(name) => {
                let target_index = *control.bus_index.get(name).ok_or_else(|| {
                    WrapError::OutProcEffect(format!("SetBusRouting output: unknown bus '{name}'"))
                })?;
                if target_index <= seq_index {
                    return Err(WrapError::OutProcEffect(format!(
                        "SetBusRouting output '{name}' (index {target_index}) must be a later stage than '{seq_bus}' (index {seq_index})"
                    )));
                }
                if control.bus_kinds.get(name) != Some(&BusKind::Sum) {
                    return Err(WrapError::OutProcEffect(format!(
                        "SetBusRouting output '{name}' must be a sum bus"
                    )));
                }
                Some(target_index + 2)
            }
            None => None,
        };
```

`Some("master") => Some(1)` が、先ほど TS 側で予約していた `"master"` の受け口です。
`target_index + 2` というエンコードは「0 = 変更なし / 1 = Master / 2 以降 = bus index」の
三状態を 1 つの atomic に詰めるためのもので、native 側の `routing_override` がこれを
読みます。

### render 側: post-loop がトポロジカル順に合流させる

daemon が atomic に書いた routing を、native の render callback はどう消費するのでしょうか。
`output.rs` の `render_engine_with_insert_buses_and_source_outputs` の後半、いわゆる
**post-loop** がその場所です。

```rust
// rust/crates/orbit-audio-native/src/output.rs:935-961
    let feeds = collect_source_feeds(sources, rendered_units, &bus_positions, bs);
    engine.render_multi_feeds(hw, &mut targets, &feeds);
    drop(targets);

    // post-loop: 配列順（= トポロジカル順・MX.4）で is_render_target な stage を処理する。
    // stage i の output_target/send は必ず i より後ろを指す（構築時 validate_bus_topology で
    // 検証済み）ので、`split_at_mut(i + 1)` で「i を含む左」と「i より後ろの右」に安全に分割できる
    // （sum のネスト・循環は構造的に発生しない）。
    for i in 0..buses.len() {
        if !render_targets[i] {
            continue;
        }
        if active_flags[i] {
            if let Some(processor) = buses[i].processor.as_mut() {
                processor.process(&mut buses[i].buffer[..bs]);
            }
        }

        let (left, right) = buses.split_at_mut(i + 1);
        let src_stage = &left[i];

        match effective_targets[i] {
            BusTarget::Master => {
                for (dst, s) in hw.iter_mut().zip(&src_stage.buffer[..bs]) {
                    *dst += *s;
                }
            }
```

読み方はこうです。

1. `engine.render_multi_feeds(hw, &mut targets, &feeds)` で、scheduler が event を各 bus buffer
   （`targets`）と `hw` に混合し、feed（instrument の出力）も加算し、**master gain ramp を
   全 buffer に 1 回だけ**適用します（core 側の実装は次節）
2. post-loop は stage を配列順（= トポロジカル順・MX.4）に回し、insert があれば
   `processor.process` を通し、`effective_targets[i]` に従って `hw`（Master）か後ろの bus
   （`Bus(j)`）に加算します
3. 引用の続き（`output.rs:962-985`）では `Bus(j)` への加算と、`sends` / 実行時 send override の
   `gain` を掛けた copy 加算が続きます（fan-out は event の複製ではなく「bus 処理段の copy 加算」
   という MX.4 の規範どおり）

`split_at_mut(i + 1)` で左右に分けられるのは、構築時に `validate_bus_topology` が
「stage i の行き先は必ず i より後ろ」を検証しているからです。sum のネストや循環が
**構造的に**起きない、という仕様（MX.2「ネストは v1 不可」）の実装側の裏付けがここにあります。

## instrument をミキサーの source にする（#643）

ここまでの routing は、もともと audio シーケンス（`audio()` / `chop()`）のためのものでした。
instrument（`seq.instrument()`）の音は、2026-08-29 の #643 PR-1 までは daemon の
`CompositePostProcessor` で **master バッファへ直接加算**されており、bus グラフの外に
いました。設計文書（`docs/design/643-mixer-foundation-design.md`）が「発端」として記録して
いるのは、そのせいで `effect()` / `output()` / `send()` の 3 つが note シーケンスで全部例外に
なっていたことです。

PR-1 の解は「instrument を **premaster contributor** にする」でした。土台（core / native）は
instrument が何かを知らず、「render すると N 本の block をくれる何か」という抽象だけを
持ちます。

```rust
// rust/crates/orbit-audio-native/src/output.rs:269-282
/// A callback-owned source which renders one or more interleaved output units.
pub trait BlockSource: Send {
    fn render(&mut self, frames: usize, transport: &BlockTransport) -> usize;
    fn output(&self, unit: usize) -> &[f32];
}

/// Destination of one source output unit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SourceDest {
    #[default]
    Master,
    Bus(usize),
    Link(usize),
}
```

`SourceDest` が `Master / Bus / Link` の 3 値なのは、設計の「アドレスモデルは
`(instance, unit)` で今決める」（owner 確定事項）に対応します。`SourceSlot.dests` が
`Vec<SourceDestCell>` で、unit ごとに行き先を持てる形です。ただし 2026-09-01 時点の TS は
`unit` を 0 固定で発行しています（後述）。

feed の収集は `collect_source_feeds`（`output.rs:772-801`）が行い、unit ごとの `SourceDest` を
core の `FeedDest` に写します。写像の部分だけ引用します。

```rust
// rust/crates/orbit-audio-native/src/output.rs:787-797
            let dest = match slot.dests[unit].load() {
                SourceDest::Master => FeedDest::Hardware,
                SourceDest::Bus(index) => bus_positions
                    .get(index)
                    .copied()
                    .flatten()
                    .map_or(FeedDest::Hardware, FeedDest::Channel),
                // Link source routing is wired in PR-3. Until then it is a total hardware fallback.
                SourceDest::Link(_) => FeedDest::Hardware,
            };
            feeds.push((output, dest));
```

`SourceDest::Link(_) => FeedDest::Hardware` のコメントにあるとおり、instrument → LinkAudio の
実配線は PR-3 として残されています。TS 側 `output()` の LinkAudio 分岐が instrument を
拒否していたのは、この fallback が「黙って hardware に出る」ことを silent failure として
封じるためです。

core 側の `render_multi_feeds`（`scheduler.rs:375-460`）を見ると、zero-fill → event 混合 →
feed 加算（`422-441`・`FeedDest::Hardware` なら `hardware_out`、`Channel(i)` なら該当 bus buffer に
`*dst += *sample`）→ gain ramp、の順になっています。gain ramp の部分を引用します。

```rust
// rust/crates/orbit-audio-core/src/scheduler.rs:443-456
        // master gain ramp を **1 回だけ**進め（next_gain_frame）、全バッファに同じ per-frame
        // gain を適用する（バッファごとに進めると ramp が多重に進み desync するため frame ループは 1 つ）。
        for frame in 0..frames_to_render {
            let g = self.next_gain_frame();
            let base = frame * output_channels;
            for ch in 0..output_channels {
                hardware_out[base + ch] *= g;
            }
            for (_, buf) in channels.iter_mut() {
                for ch in 0..output_channels {
                    buf[base + ch] *= g;
                }
            }
        }
```

設計文書 §5.1 はこの位置を「★ feed 加算ループ（新規 ~10行）」と書き、
「**これで `global.gain` が instrument に効かない現行欠陥が消える**（位置の修正のみ・別途の
手当て不要）」と結論していました。native の unit test
`global_gain_scales_instrument_contribution`（`output.rs:2017`）は、`set_global_gain(0.5, 0.0)` を
設定した状態で `SourceDest::Master` の feed を流し、出力が 0.5 倍になることを固定しています
（WORK_LOG 6.405 に red → green の実出力が残っています）。

### TS 側: `SetSourceRouting` の choke point

PR-2（TS 側）は、instrument sequence が insert bus を持った時点で
`SetSourceRouting { source: "plugin:<name>", unit: 0, target: <bus> }` を発行する経路を
1 箇所に集約しました。`instrument()` → `effect()` の順でも逆でも、ここを通ります。

```typescript
// packages/engine/src/core/sequence.ts:730-757
  private ensureInstrumentSourceRouting(): Promise<void> {
    if (!this.isInstrument() || !this._insertBus) return Promise.resolve()
    const bus = this._insertBus
    if (this._instrumentSourceRoutingBus === bus) {
      return this._instrumentSourceRoutingPromise ?? Promise.resolve()
    }
    if (!this.audioEngine.setSourceRouting) {
      return Promise.reject(new Error('Instrument mixer routing requires the Rust engine backend.'))
    }

    const name = this.stateManager.getName() || 'sequence'
    this._instrumentSourceRoutingBus = bus
    const pending = this.audioEngine
      .setSourceRouting(`plugin:${name}`, 0, bus)
      .catch((error) => {
        if (this._instrumentSourceRoutingBus === bus) {
          this._instrumentSourceRoutingBus = undefined
        }
        throw error
      })
      .finally(() => {
        if (this._instrumentSourceRoutingPromise === pending) {
          this._instrumentSourceRoutingPromise = undefined
        }
      })
    this._instrumentSourceRoutingPromise = pending
    return pending
  }
```

`_instrumentSourceRoutingBus` と `_instrumentSourceRoutingPromise` の 2 つで「同じ bus への
二重発行」を防ぎつつ、失敗時にはマーカーを外して再試行できるようにしています。
`output()` / `send()` の末尾で呼ばれていた `syncInstrumentSourceRouting()` は、この
Promise を fire-and-forget に包んだアダプタです。

E2E-4（後述）は、instrument が `output("sum643")` と `send("aux643", 0.5)` を同時に持つとき、
capture の RMS が dry の約 1.5 倍（sum 経由 1.0 + aux 経由 0.5）になることで、
この経路全体が実機で通っていることを示しています。

## マスターフェーダー `global.gain()` — 3 度読み直された配線

本章で一番読み応えがあるのがマスターゲインです。WORK_LOG 6.404 → 6.405 → 6.408 → 6.410 →
6.415 → 6.420 と、**同じ日（2026-08-29）から翌日にかけて理解が 3 回書き換わって**います。
順に追いましょう。

### (1) 旧実装: TS がイベントごとに畳み込んでいた

#643 PR-2 で直される前の `global.gain()` は、`masterGainDb` を **各 audio イベントの gain に足し込む**
方式でした（`event-scheduler.ts` の `sequenceGainDb + masterGainDb`）。instrument の note 経路には
この畳み込みが無かったため、**マスターが instrument に一切効かない**。しかも Rust 側には
最初から `set_global_gain`（gain ramp 付き）が存在していたのに、**TS が一度も呼んでいなかった**
のです（WORK_LOG 6.408）。

### (2) #643 PR-2: daemon の master gain に配線し直す

修正後の `Global.gain()` は dB を線形 amplitude に変換して `setGlobalGain` に渡します。

```typescript
// packages/engine/src/core/global.ts:601-613
  gain(valueDb?: number): number | this {
    const result = this.effectsManager.gain(valueDb)
    if (typeof result === 'number') {
      return result
    }
    // 線形 amplitude へ変換して daemon へ。fire-and-forget（DSL 表面を async にしない）。
    void this.audioEngine
      .setGlobalGain?.(gainDbToAmplitude(this.effectsManager.getMasterGainDb()))
      ?.catch((error) => {
        console.warn(`⚠️  global.gain(): failed to apply master gain to the mixer: ${error}`)
      })
    return this
  }
```

`AudioEngine` 側の契約は `setGlobalGain?(amplitude: number, rampSec?: number): Promise<void>`
の 1 行（`engine-backend.ts:46`）で、optional なので SC バックエンドでは何も起きません。
`RustEnginePlayer.setGlobalGain` は「daemon の状態に関わらず先に intent を記録する」のが要点です。

```typescript
// packages/engine/src/audio/rust-engine/rust-engine-player.ts:1247-1259
  async setGlobalGain(amplitude: number, rampSec = 0): Promise<void> {
    // 🔴 daemon の状態に関わらず**先に intent を記録する**。未接続時に捨てると、
    // 接続後に復元する手がかりが消える（`Global.gain()` を再評価する経路は存在しない）。
    this.globalGainIntent = { amplitude, rampSec }
    if (!this.daemon.isRunning()) {
      // daemon 未接続時は送らない。**intent は上で記録済み**なので、respawn 後に
      // `reapplyGlobalGainAfterRespawn()` が再送する。
      // （旧コメントは「次の起動時に global.gain() が再評価される」と書いていたが、
      //   そのような経路は存在しなかった — #648 レビューで指摘）
      return
    }
    await this.daemon.setGlobalGain(amplitude, rampSec)
  }
```

intent を残すのは respawn のためです。daemon は新プロセスで `global_gain = 1.0` から始まるので、
再送しないと「DSL 上は -6dB なのに実際は unity」がエラーもログも無く起きます。この退行は
PR #648 のレビュー（WORK_LOG 6.410・Critical 1 件目）で見つかり、
`reapplyGlobalGainAfterRespawn()` として `reapplyBusRoutingAfterRespawn` の鏡像に追加されました。

イベント側の畳み込みは外されましたが、`-Infinity`（完全無音）だけは残っています。
`calculateEventGain`（`event-scheduler.ts:30-65`）のコメントは、旧実装が `sequenceGainDb +
masterGainDb` を返していたこと、**insert との順序は変わっていない**こと（次節）を明記した上で、
残す理由をこう書いています。

```typescript
// packages/engine/src/core/sequence/scheduling/event-scheduler.ts:56-65
  // `masterGainDb === -Infinity`（完全無音）だけは残す — daemon 側の gain が 0.0 になるまでの
  // ramp 中に音が漏れるのを避けるため、発音側でも落とす。
  if (isMuted) {
    return -Infinity
  } else if (sequenceGainDb === -Infinity || masterGainDb === -Infinity) {
    return -Infinity
  } else {
    return sequenceGainDb
  }
}
```

### (3) 6.410 の訂正: master gain は今も insert の前

PR #648 の初稿は「バスに入る前に master を掛ける問題も解消」と 6 箇所に書いていましたが、
Fable 監査が spec の既知制約を指して誤りだと指摘しました。

> master gain ramp は per-sequence insert の**前**に適用される（DAW の「fader は insert 後」と逆・master unity なら影響なし）。
>
> — `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` PH.2b 既知の v1 制約

先ほどの post-loop を読み直すと、たしかに `render_multi_feeds`（gain ramp）→
`processor.process`（insert）の順であり、#643 はこの順序を変えていません。「insert 後に
フェーダーを置く」は #649 の主題として持ち越されます。

### (4) 6.415: capture E2E が「効いていない」を実機で捕まえた

ここからが本章の山場です。#633 の実機検証（WORK_LOG 6.415・2026-08-29）で、
`global.gain(-6)` を評価した区間の capture WAV を 0.25 秒窓で RMS 測定したところ、
**0.0886 のままフラット**（効いていれば 0.044）でした。両端に probe を仕込むと、TS は
`amp=0.5011872` を送り、daemon は `SetGlobalGain received value=0.5011872` を受けている。
**送受信は正常で、それでも音が変わらない**、という状況です。

6.415 はその時点の仮説として「post-loop の `BusTarget::Master` が gain 適用後の `hw` に
直接加算しているから、stage から master へ合流する音は master gain を素通りする」と書き、
#649 の issue にも同じ説明が載りました。

しかし翌日の #649 設計 v3（WORK_LOG 6.420）が、この説明を **自ら訂正**しています。

> 私が issue に書いた「post-loop が gain の後に stage を加算するから」は
> **E2E-1 を説明しない**（E2E-1 の instrument はバスを経由せず `FeedDest::Hardware` で
> gain ループの前に加算される）。**Fable が「特定し切れていない」と正直に書いたことで発覚。**
>
> — `docs/development/WORK_LOG.md` 6.420

実際、E2E-1 の DSL は sum も aux も宣言しないので、instrument の feed は
`render_engine_with_source_outputs`（`output.rs:1078`）から `render_multi_feeds` に渡り、
gain ループの**前**に `hw` へ加算されます。先ほど引用した core のコードを見るかぎり、
`hw` と全 `channels` buffer に同じ `g` が掛かるので、静的な読解だけでは「素通り」は
説明できません。#649 設計文書 §13 はこれを「**静的配線は完全**。したがって欠陥は静的欠線では
なく動的事象」と整理し、原因を仮説で埋めずに **B-0 測定ラダー**（core に `global_gain` の
getter を足して `get_engine_state` に露出 → probe 0.5 / 1.0 で二分 → TS を外して daemon
protocol を直接叩く）を先に組む、としています。

> NOTE: unverified — needs confirmation: 2026-09-01 時点（`69dc968`）で E2E-1 が実機で
> green か red かは、著者は実行して確認していません。#649 設計文書 §13 が「E2E-1 red + probe」
> を前提に組まれていることから、2026-08-30 時点では red だったと読んでいます。

### なぜ unit test では見えなかったのか

WORK_LOG 6.415 の表を引きます。

| 手段 | master gain の欠陥を捕まえたか |
|---|---|
| 変異検証 35 件（80 分以上） | 捕まえていない |
| ユニットテスト 2149 件 | 捕まえていない |
| ユーザーと同じ動線のキャプチャ E2E | **これだけ** |

native の unit test `global_gain_scales_instrument_contribution` は green です。つまり
`render_block_with_sources` を**単体で**呼べば gain は正しく掛かります。それでも実機で
効かないということは、欠陥は「部品」ではなく「配線」— production の stream 起動順・
instrument child の attach タイミング・複数の消費者が同じ状態を触る順序 — のどこかにある、
ということです。設計文書はこれを「新モデルで E2E-1 を green にするだけでは、旧経路の他の
消費者が壊れたままになりうる」と警告しています。

もう 1 つ、6.415 が但し書きとして残している点も重要です。この欠陥は**異常系ではない**。
各層は成功を返し、ERROR は 1 行も出ていません。ログは「壊れた時に気づく」ための装置で、
「正しく見えるが合成が違う」を捕まえるのは capture E2E だけだ、という整理です。

## capture E2E がどう測っているか

`tests/e2e/orbitstudio-mcp-gated.spec.ts` の `captureInstrumentScenario` は、実 OrbitStudio を
MCP 経由で駆動し、daemon の capture WAV を区間ごとに RMS 測定します。区間の RMS は
区間内の各 window の RMS を二乗平均して平方根を取ったもので、区間の両端に guard（既定
0.15 秒）を取って遷移の影響を除きます。

```typescript
// tests/e2e/orbitstudio-mcp-gated.spec.ts:572-577
    const rms = (name: string, guardSec = 0.15): number => {
      const selected = windows(name, guardSec)
      return Math.sqrt(
        selected.reduce((sum, window) => sum + window.rms * window.rms, 0) / selected.length,
      )
    }
```

E2E-1 は `global.gain(0)` で 1 区間、`global.gain(-6)` を評価してもう 1 区間を取り、
比が 0.45〜0.55 に入ることを要求します（$10^{-6/20} \approx 0.501$）。

```typescript
// tests/e2e/orbitstudio-mcp-gated.spec.ts:1408-1442
  it.skipIf(!appAvailable)(
    '#643 E2E-1 applies global.gain(-6) to a playing instrument at about half the 0 dB RMS',
    async () => {
      const catalog = requireCatalogFixtures()
      const result = await captureInstrumentScenario(
        'global-gain',
        [
          'var global = init GLOBAL',
          'global.key("C")',
          'global.tempo(120)',
          'global.beat(4 by 4)',
          'global.gain(0)',
          'global.start()',
          'var gain643 = init global.seq',
          `gain643.instrument(${JSON.stringify(catalog.clapSynthName)})`,
          'gain643.gate(1)',
          'gain643.play(1, 1, 1, 1)',
          'LOOP(gain643)',
        ],
        async ({ captureSegment, evaluate }) => {
          await captureSegment('unity')
          await evaluate('global.gain(-6)')
          await captureSegment('half')
        },
      )
      // 🔴 `global.gain()` は **dB**（`gain(valueDb?)`・-60..+12 にクランプ）。線形値ではない。
      // 0 dB -> -6 dB で amplitude は 10^(-6/20) ≈ 0.501 = 約半分。
      const unity = result.rms('unity')
      const half = result.rms('half')
      expect(unity, 'E2E-1 unity instrument must be audible').toBeGreaterThan(0.05)
      expect(half / unity, `E2E-1 half/unity RMS ratio (${half}/${unity})`).toBeGreaterThan(0.45)
      expect(half / unity, `E2E-1 half/unity RMS ratio (${half}/${unity})`).toBeLessThan(0.55)
    },
    TEST_TIMEOUT_MS,
  )
```

E2E-4 は sum + aux の経路です。dry（bus 無し）と、`output("sum643")` + `send("aux643", 0.5)` を
持つ instrument を切り替え、比が 1.35〜1.65（理論値 1.5）に入ることを見ます（`1587-1594`）。
DSL 部分を引用します。

```typescript
// tests/e2e/orbitstudio-mcp-gated.spec.ts:1535-1554
        [
          'var global = init GLOBAL',
          'global.key("C")',
          'global.tempo(120)',
          'global.beat(4 by 4)',
          'global.sum("sum643")',
          'global.aux("aux643")',
          'global.start()',
          'var routeDry643 = init global.seq',
          `routeDry643.instrument(${JSON.stringify(catalog.clapSynthName)})`,
          'routeDry643.gate(1)',
          'routeDry643.play(1, 1, 1, 1)',
          'var routeWet643 = init global.seq',
          `routeWet643.instrument(${JSON.stringify(catalog.clapSynthName)})`,
          'routeWet643.output("sum643")',
          'routeWet643.send("aux643", 0.5)',
          'routeWet643.gate(1)',
          'routeWet643.play(1, 1, 1, 1)',
          'LOOP(routeDry643)',
        ],
```

`ORBIT_KEEP_CAPTURES=<dir>` を渡すと capture WAV が tmpRoot の掃除に巻き込まれず残ります。
ハーネスのコメントが書いているとおり、6.415 で欠陥に辿り着けたのは「窓の中の 1 つの数」では
なく、残した WAV の RMS を時系列で眺めたからです。

## オーディオライン設計（#649）— 決まったこと・まだ決まっていないこと

#649（`docs/design/649-audio-line-design.md`）は、6.415 で露わになった「フェーダーの位置」を
根本から扱い直す設計です。**2026-08-30 時点で設計のみ・実装はありません。**
`69dc968` の `packages/engine/src` / `rust/crates` を `_lineOrder` / `evalBegin` /
`gain_override` で grep しても該当がないことは著者が確認しました。

### owner 確定（再議論しない）

| 項目 | 決定 |
|---|---|
| 原理 | **メソッドチェーンの順序が、オーディオラインでは決定論になる**（§7.6） |
| 境界 | 「音が生まれる点」（`audio()` / `instrument()` / `play()` まで）より後ろがオーディオライン（§1） |
| フェーダー | 「フェーダーという段」は作らない。`gain` はチェーン上の 1 要素（§2.1） |
| pre / post | フラグを持たない。`send` を `gain` の前に置けば pre-fader、後ろなら post-fader（§2.2） |
| `seq.send()` メソッド形 | **廃止**（破壊的変更・owner 了承済み）。send はチェーン要素のみ（§7.2） |
| `output` | 終端ではない。後ろに音が届かないのは位置の帰結で、エンジンはエラーを投げない（§7.3） |
| 評価の粒度 | 既存の「主語ごとの全行」評価に従う。新規則を足さない（§7.4） |
| ラック | `effect([...])` のラック記法は維持。`Gain` はラックの**外**（§7.5） |
| bus / master | `sum("drum").effect([...])` / `global.effect([...])` も同じ資格で扱う（§2.3） |

`seq.send()` の廃止は、本章で読んだ `send()` メソッドが将来なくなることを意味します。
ただし `69dc968` では `send()` は動いていて、E2E-4 もそれを使っています。

### 実装設計 v3 で確定した「実装を読んで分かった事実」

v1・v2 の設計は「実装を読まずに発明した規則」で 3 回とも owner に訂正された、と設計文書
§15 が記録しています。v3 が実装から確定した事実は 3 つです。

1. **評価経路は 3 つ**（エディタ選択あり / 選択なし = 主語の全行 / MCP）で、すべて
   `writeCodeToEngine` に収束する
2. **エンジンは文書を持たない。** 評価とは stdin へテキストを書くことなので、「再評価のたびに
   ソースを読み直す」は物理的に不可能
3. `gain()` / `send()` / `output()` / `effect()` は**完全に独立したスライス**を更新する。
   本章で見た `_auxSends` / `_sumOutputBus` / `_insertBus` がその実体で、呼び出し順は
   `process-statement.ts` が `dispatchCall` した時点で失われる

v3 の設計はそこから、順列 `_lineOrder` を 1 つ新設し（値は既存スライスに残す）、評価バッチ
境界を `//#evalBegin` / `//#evalEnd` の注入で作り、gain / pan はラック外の native stage
スカラー（child プロセスを増やさない）として実装する、と組んでいます。

### 未決（実装前に決める）

| 項目 | 状態 |
|---|---|
| オーディオラインに乗る要素の集合（`mute` / `defaultGain` / `quantize` 等の分類） | §8 Q1・未決 |
| 1 本の PR か段階化か | §8 Q2・規模を測ってから |
| 単独文で初めて要素を作る時の既定位置（チャンネルストリップ順を推奨） | §10.4・owner 確認 1 件 |
| カーソル規則の移動方向 | §14 #2・確信度「中」 |
| `//#evalBegin/End` と既存メタ行処理の干渉 | §14 #3・確信度「中高」 |
| E2E-1 が red である原因 | §13 B-0 で測定してから（未特定） |

設計の完了条件（§5）はすべて capture で測る形になっています。「`send` を `effect` の前後に
置き分けると AUX の音が変わる」「`gain` を `effect` の後に置くと残響比が変わらない」— 本章で
読んだ E2E-1 / E2E-4 の延長線上に、この設計の検証が置かれることになります。

## Try it: sum / aux / send / master gain を最小構成で

以下は本章で読んだ経路をひととおり通す最小の `.orbs` です（著者作成・E2E-4 の DSL を
audio シーケンス向けに書き換えたもの）。

```
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.sum("drum")
global.aux("rev")
global.start()

var kick = init global.seq
kick.audio("kick.wav")
kick.output("drum")
kick.send("rev", 0.5)
kick.play(1, 1, 1, 1)

var hat = init global.seq
hat.audio("hat.wav")
hat.output("drum")
hat.play(1, 1, 1, 1)

LOOP(kick, hat)
```

期待される配線は次のとおりです。

1. `global.sum("drum")` → `MixerManager.declareBus('sum', 'drum')` → `sum-bus-0`
2. `global.aux("rev")` → `aux-bus-0`
3. `kick.output("drum")` → `ensureSequenceInsertBus('kick')` で `seq-bus-0` を pass-through
   確保 → `SetBusRouting(seq-bus-0, output=sum-bus-0, sends=[])`
4. `kick.send("rev", 0.5)` → `SetBusRouting(seq-bus-0, output=sum-bus-0, sends=[(aux-bus-0, 0.5)])`
   （全量再送）
5. `hat.output("drum")` → `seq-bus-1` → `SetBusRouting(seq-bus-1, output=sum-bus-0, sends=[])`
6. render callback: `seq-bus-0` / `seq-bus-1` の buffer に event が混合され、post-loop で
   `sum-bus-0` に加算、`seq-bus-0` からは 0.5 倍の copy が `aux-bus-0` に加算、最後に
   `sum-bus-0` と `aux-bus-0` が `hw` に合流

ここに `global.gain(-6)` を評価すると `SetGlobalGain(value=0.5011872)` が daemon に届き、
core の gain ramp が `hw` と全 bus buffer に掛かります。audio シーケンスでこの経路が実機で
どう振る舞うかは、著者は本章執筆時に測っていません。

注意点が 2 つあります。`SetBusRouting` は daemon の `outproc-effect` feature 専用なので、
feature 無しビルドでは `UNSUPPORTED` が返り、`syncBusRouting` が `console.error` で
「routing was NOT applied」と出します。また `global.linkAudio()` を宣言したセッションでは
`global.sum()` / `global.aux()` 自体が例外になります（v1 相互排他・PH.5）。

## 次の深掘り候補

- **E2E-1 が red になる動的事象の特定** — #649 §13 の B-0 測定ラダー（`global_gain` getter を
  `get_engine_state` に露出・probe 二分・daemon protocol 直叩き）を実際に回した記録を追う
- **`SetBusRouting` の `routing_override` エンコード（0 / 1 / index+2）と `SourceDestCell` の
  帯域分割** — 2 種類の atomic routing が native 側でどう decode されるか（`output.rs:286-330`）
- **`validate_bus_topology` と bus 配列の構築順** — insert → sum → aux の順が
  `build_effect_bus_stages` でどう固定されるか（`engine_wrap.rs:2050-2130` 付近）
- **respawn 後の再適用 3 兄弟**（`reapplyBusRoutingAfterRespawn` / `reapplySourceRoutingAfterRespawn`
  / `reapplyGlobalGainAfterRespawn`）の呼び出し順と失敗時の独立性
- **ミキサーの出口（#611）** — #643 設計 §1.5 が「未設計」と認めた「どの bus がデバイスの
  どのチャンネルへ出るか」。`SourceDest::Master` の先が stereo 固定である理由
- **#649 の実装が入った後の再読** — `_lineOrder` / `//#evalBegin` / native stage スカラーが
  本章の `_auxSends` / `syncBusRouting` をどう置き換えるか

## Sources

- `docs/core/INSTRUCTION_ORBITSCORE_DSL.md:1616-1706` — Mixer / Routing（MX.1〜MX.5）規範
- `docs/core/INSTRUCTION_ORBITSCORE_DSL.md:1247-1249` — master gain ramp が insert の前に掛かる既知制約
- `docs/design/643-mixer-foundation-design.md` — #643 設計（owner 三条・責務境界・feed 注入点 §5.1・`output()` 3 分岐 §12）
- `docs/design/649-audio-line-design.md` — #649 オーディオライン設計（§7 確定事項・§8 未決・§9-§14 実装設計 v3）
- `docs/development/WORK_LOG.md` 6.404 / 6.405 / 6.408 / 6.410 / 6.415 / 6.420 — #643 設計〜PR-1〜PR-2〜レビュー訂正〜実機発見〜#649 設計 v3
- `packages/engine/src/core/global/mixer-manager.ts:16-29` — `SUM_BUS_PREFIX` / `AUX_BUS_PREFIX` / `MIXER_BUS_POOL_SIZE`
- `packages/engine/src/core/global/mixer-manager.ts:251-283` — `declareBus`（`"master"` 予約・LinkAudio 排他・pool 確保）
- `packages/engine/src/core/global.ts:481-489` — `Global.sum()` / `Global.aux()`
- `packages/engine/src/core/global.ts:601-613` — `Global.gain()` → `setGlobalGain`
- `packages/engine/src/core/global/sequence-effect-manager.ts:89-104` — `ensureBus()`（pass-through insert）
- `packages/engine/src/core/sequence.ts:350-432` — `Sequence.output()` の 3 分岐
- `packages/engine/src/core/sequence.ts:454-481` — `Sequence.send()`
- `packages/engine/src/core/sequence.ts:522-570` — `pushBusRouting` / `syncBusRouting`
- `packages/engine/src/core/sequence.ts:724-757` — `ensureInstrumentSourceRouting`（`SetSourceRouting` choke point）
- `packages/engine/src/core/sequence/scheduling/event-scheduler.ts:30-65` — `calculateEventGain`（畳み込み除去・`-Infinity` 残置）
- `packages/engine/src/audio/engine-backend.ts:45-46` — `setGlobalGain` 契約
- `packages/engine/src/audio/rust-engine/rust-engine-player.ts:949-969` — `setBusRouting`（intent-first キャッシュ）
- `packages/engine/src/audio/rust-engine/rust-engine-player.ts:1023-1035` — `reapplyGlobalGainAfterRespawn`
- `packages/engine/src/audio/rust-engine/rust-engine-player.ts:1247-1259` — `setGlobalGain`（intent 記録）
- `rust/crates/orbit-audio-daemon/src/engine_wrap.rs:1950-1976` — `BusKind` / sum・aux pool prefix と既定サイズ
- `rust/crates/orbit-audio-daemon/src/engine_wrap.rs:5776-5845` — `set_bus_routing` 検証
- `rust/crates/orbit-audio-daemon/src/session.rs:2214-2236` — `SetGlobalGain` ハンドラ
- `rust/crates/orbit-audio-native/src/output.rs:269-282` — `BlockSource` / `SourceDest`
- `rust/crates/orbit-audio-native/src/output.rs:772-801` — `collect_source_feeds`
- `rust/crates/orbit-audio-native/src/output.rs:935-986` — `render_multi_feeds` 呼び出しと post-loop
- `rust/crates/orbit-audio-native/src/output.rs:1078-1094` — bus 無し経路 `render_engine_with_source_outputs`
- `rust/crates/orbit-audio-native/src/output.rs:2017-2060` — unit test `global_gain_scales_instrument_contribution`
- `rust/crates/orbit-audio-core/src/scheduler.rs:375-460` — `render_multi_feeds`（feed 加算と gain ramp）
- `tests/e2e/orbitstudio-mcp-gated.spec.ts:475-579` — `captureInstrumentScenario` / `rms()`
- `tests/e2e/orbitstudio-mcp-gated.spec.ts:1408-1442` — E2E-1（`global.gain(-6)`）
- `tests/e2e/orbitstudio-mcp-gated.spec.ts:1529-1571` — E2E-4（`output(sum)` + `send(aux, 0.5)`）
- Issue [#453](https://github.com/signalcompose/orbitscore/issues/453) / [#459](https://github.com/signalcompose/orbitscore/issues/459) — ミキサー DSL（sum / aux / send）
- Issue [#643](https://github.com/signalcompose/orbitscore/issues/643) / PR [#648](https://github.com/signalcompose/orbitscore/pull/648) — ミキサーの土台と instrument source 化・マスターフェーダー配線
- Issue [#649](https://github.com/signalcompose/orbitscore/issues/649) — オーディオライン設計
- Issue [#611](https://github.com/signalcompose/orbitscore/issues/611) — ミキサーの出口（マルチアウト）設計
