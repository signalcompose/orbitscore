# マルチチャンネルレンダリング設計 — per-bus オフラインレンダリング (#598)

```json
{"type":"meta","doc":"MULTICHANNEL_RENDERING_DESIGN","issue":598,"status":"p1-implementation","date":"2026-08-01","head":"ea138bd","rev":3}
```

**Status**: owner 裁定済み・P0 完了・P1 実装仕様
**調査対象 HEAD**: `363d942`（行番号はこの時点で実読して確認。§3 の実測もこの HEAD で実行）
**先行調査**: `~/Src/proj_orbitscore/Soundcinema_Düsseldorf_2026/FEASIBILITY.md`（2026-07-31）
**依存**: #474（プラグイン UI）完了後に着手

> **rev 2 の改稿理由**: owner 裁定（2026-08-01）によりスコープを再定義した。
> 7.1 は「エンジンの 8ch 出力」でも「プラグインの 7.1 バス」でも達成しない。
> **seq ごとに出力バスを指定し（`output(1)`〜`output(8)` 概算）、バスごとに別ファイルへ
> オフラインで書き出し、空間化・ミックスは別の DAW で行う。**
> したがって CLAP `audio_ports` / VST3 `SpeakerArrangement` の多ch交渉・エンジンの
> 8ch 出力・placement DSL は本設計のスコープ外（§4.6 に将来課題として記録のみ）。

---

## 1. 要旨

求められている形:

```
OrbitScore: seq ごとに出力バスを指定（output(1) ... output(8)）
  ↓  オフラインレンダリング（実時間より速く・録音操作なし・#474 の音色 = プラグインを通る）
バスごとの WAV（8ファイル）+ master
  ↓
別の DAW で空間化・ミックス・整形（7.1 化は DAW の仕事）
```

設計の核心は3点:

1. **オフライン経路は本番の `render_block`（cpal 非依存の自由関数・`output.rs:521`）を
   そのまま block ループで駆動する**。プラグイン（per-bus insert チェーン + master post）を
   通ること・bus 分配・render 順序は本番と同一コードで担保される（§4.1）。
   stem の取り出しにエンジン変更は不要 — `render_block` 実行後の各 bus buffer が
   そのまま stem の 1 block である（§4.2）。
2. **最大の未知だった「out-of-process child のオフライン駆動」は、実測で解消した**（§3）。
   同期オフライン駆動の primitive `render_through_child_sync_with_options`
   （`orbit-audio-sandbox/src/offline.rs:102`）が**既に実装・テスト済み**で、
   実 CLAP effect / 実 CLAP instrument / VST3 child の3系統すべてが本日 pass、
   1 block 往復 ≈ 12.5μs（64f 実時間周期の**約 1/107**）だった。
3. **残る最大の設計課題はエンジン側でなく TS 側**: dispatch が wall-clock 連動の
   just-in-time（lookahead）なので、オフライン用に**有界時間の決定論的イベント列**を
   作る score-mode ドライバが要る（§4.3）。

エンジンの出力は**ステレオのまま**（各バス上でプラグインも stereo/mono のまま）。
`pan` の 2ch 前提（`scheduler.rs:250-257`）は本計画では**触る必要がなくなった**（§4.6）。

---

## 2. 現状のコード実測

### 2.1 オフラインが再利用すべき本番 render 経路は cpal 非依存

native 層の callback 本体は自由関数 `render_block`（`output.rs:521-563`）で、
(1) engine render（named bus への分配を含む `render_multi` 1 パス・
`render_engine_with_insert_buses` `output.rs:566-728`）→ (2) 各 bus の insert processor 適用 +
graph 合流（`:676-719`）→ (3) master post（`:548-550`）→ (4) capture tap（`:556-558`）を行う。
引数は `Engine` 参照・`&mut [InsertBusStage]`・`Option<Box<dyn PostProcessor>>`・`&mut [f32]` のみで
**cpal 型に依存しない**。オフラインドライバはこの関数をそのまま呼べる。

`InsertBusStage`（`output.rs:296-330`）は名前付き bus + 任意の `PostProcessor` + 出力先
（master / 他 bus / sends）を持ち、**`render_block` 実行後も自 buffer に post-insert の
内容を保持する**（合流は加算コピーで、buffer は clear されない・`:689-707`）。

### 2.2 per-bus プラグインチェーンの機構は実装済み（realtime 側）

- 宣言: `seq.effect()`（PH.2b / #434 S3）・`seq.output(sumName)` / `seq.send()`（MX.3-4 /
  #459/#453）。TS 表面は `sequence.ts:337-377`（`output()`）・`:595-`（`effect()`）。
- wire: `PlayAt` の `bus` / `channel` は**相互排他**（`session.rs:192`, `:1484`）。
  bus = insert bus routing・channel = LinkAudio egress。
- daemon: `build_effect_bus_stages`（`engine_wrap.rs:457-533`）が **bus ごとに専用 shm +
  out-of-process child + `OutProcEffectPostProcessor`** を組む。すなわち
  「バスごとに独立したプラグイン chain」は realtime 側の既存資産である。

### 2.3 既存のオフライン API は test-only かつプラグインを通らない

`render_offline` / `render_offline_channel`（`engine_wrap.rs:4448-4475`・`#[doc(hidden)]`）は
`engine.render(buf)` のみで post-processor を経由しない。ただし共通本体
`render_offline_inner`（`:4427-4446`）の block ループ構造は新ドライバの雛形になる。
🔴 **#474 で作る音色はプラグイン（per-bus chain）に宿る**ので、この経路のままでは
レンダリング結果に音色が乗らない。§4.1 の新経路が必須である。

### 2.4 TS dispatch は just-in-time（オフラインの本当の壁）

`rust-engine-player.ts:16-20`: 「poll-and-fire-now + 定数 lookahead」。wall-clock の poll 発火で
`playAt(daemonNowSec + lookahead)` を送る。**daemon を速く回してもイベントが実時間でしか
届かない**ため、オフラインには「有界時間 `[0, T]` の全発音を前倒しで列挙する」別ドライバが要る。

### 2.5 capture / WAV writer

`CaptureWriter`（`capture.rs`）は f32 WAV writer として再利用可能（オフラインでは ring 経由で
なく直接 write でよい）。ヘッダは 16-byte fmt・stereo/mono の範囲では現行のままで問題ない
（>2ch interleaved を書く計画が消えたため extensible 化も不要になった）。

### 2.6 LinkAudio（案B）を採らない理由（記録）

`seq.output("name")` → LinkAudio egress → Ableton Live のトラックで録る案は、
**Live 側での実時間録音を要する**（10 分の曲を 8 トラック分、変更のたびに実時間で録り直す）。
これは「録音操作なしにファイル化したい」という目的（owner 2026-08-01）に正面から反する。
加えて feature `link-audio` は default off で GPL 依存を持ち込み、boot pipeline 統合
（sc-link-audio README の Step 4）は動作未確認のままである。よって案Bは不採用。
per-bus の named buffer 分配という**機構そのもの**は `render_multi` / insert bus として
LinkAudio と独立に存在するので、本設計はそちらを使う。

---

## 3. 実測 — out-of-process child のオフライン駆動は成立する（2026-08-01 実行）

### 3.1 primitive は既に存在する

`orbit-audio-sandbox/src/offline.rs:102-188` `render_through_child_sync_with_options`:
実 child プロセスを spawn し、shm transport を「submit → `seq_done >= seq` 待ち → 同 seq を
read」の**同期 1-outstanding** で駆動する。wall-clock は一切登場しない（transport の同期は
seq atomic ハンドシェイクのみ・`transport.rs:1-28`）。stale/repeat-previous は構造的に発生しない。
instrument（イベント消費）用の変種 `render_instrument_through_child_sync_with_options`
（`:192-263`）もある。商用プラグインの重い load を想定した初回 block 専用 timeout まで実装済み
（`:33-48`）。

### 3.2 本日の実行結果（HEAD `363d942`・Apple Silicon ローカル・audio device 不使用）

| コマンド | 結果 |
|---|---|
| `cargo test -p orbit-audio-sandbox --test parity --test host_child_integration` | **4 passed**（実 spawn gain child + 実 mmap・sample-exact parity。テスト本体 0.29s + 0.02s） |
| `cargo test -p orbit-clap-effect-child --test effect_parity_gated -- --ignored` | **1 passed**（**実 CLAP effect** を child で offline 同期駆動・in-process と sample-exact 一致・0.65s） |
| `cargo test -p orbit-clap-instrument-child --test instrument_parity_gated -- --ignored` | **2 passed**（**実 CLAP instrument**・イベント経路込みで bit-exact・0.62s） |
| `cargo test -p orbit-vst3-effect-child --test oracle_parity` | **2 passed**（VST3 child・sample-exact passthrough・0.82s） |
| `cargo test -p orbit-clap-effect-child --test roundtrip_latency_gated -- --ignored --nocapture` | **1 passed**。実測出力: `[32f] round-trip ≈ 12.45us \| period 666.67us \| margin 53.6x` / `[64f] ≈ 12.49us \| margin 106.7x` / `[128f] ≈ 15.94us \| margin 167.3x` |

**結論**: shm transport は非実時間の lockstep 駆動を（機構としても実測としても）許す。
1 block 往復 12〜16μs は転送オーバーヘッドがオフライン速度の律速にならないことを示す
（実プラグインの DSP コストが支配項になる。それはオフラインレンダの本質的コストであり障害ではない）。

### 3.3 実測が言えないこと（誠実な限界）

- 上記は **standalone ドライバ**（テストが自分で child を spawn）での実証である。
  production の `OfflineRenderSession` として bus プール・plugin state 復元・
  supervisor/teardown と統合する工数は別に残る（§5 P3）。
- test-effect / gain child / oracle での確認であり、**重い商用プラグイン**での
  スループット・load 時間は未計測（P3 の受け入れ基準に含めた。timeout 機構は実装済み）。
- instrument 変種は backing ring / spill FIFO を介さない簡易 publish（`offline.rs:191` の
  doc 明記）。高密度イベントでの lossless 配送は P3 で本経路に揃える。

---

## 4. アーキテクチャ

### 4.1 OfflineRenderSession — 本番 `render_block` を cpal なしで駆動する

```
OfflineRenderSession（daemon 内・live セッションと完全独立）
  ├─ 専有 Engine（fresh Scheduler・channels=2・sample_rate は要求で指定、既定 48k。デバイス非依存）
  ├─ 専有 insert_buses（レンダ対象バスを宣言どおり構築・chain 有りは processor を装着）
  ├─ 専有 master post（宣言があれば）
  ├─ per-bus WAV writer + master WAV writer（RT 制約なし・直接 write）
  └─ driver loop:
       for each block:
         render_block(engine, link=None, insert_buses, post, capture=None, cb_stats=None,
                      channels=2, &mut hw_block)          // output.rs:521 をそのまま呼ぶ
         for bus in active_buses: bus_writer[bus].write(bus.buffer[..bs])   // §4.2
         master_writer.write(hw_block)
```

- **「プラグインを通る本番相当の経路」を、コード複製ではなくコールバックと同一関数の
  再利用で満たす。** これは推測ではなく現行シグネチャからの帰結（§2.1）。
- live セッションの `play()` 意味論・RT 経路には触れない（絶対規約の遵守が構造的に担保される）。
- プラグインインスタンスは live と共有しない。音色は #474 のプラグイン state save/load 経路で
  オフライン側 child に復元する（レンダ要求に state blob / state ファイルパスを含める）。
- プラグイン駆動の adapter:
  - **in-process CLAP**: `PostProcessor` 実装を専有インスタンスで生成（既存 `ClapEffectProcessor`
    は同期 API なのでそのまま使える — §3.2 の parity テストの side A が実例）。
  - **out-of-process**: `PipelinedEffectHost`（pipelined・stale 前提）の代わりに、
    `render_through_child_sync` の内部ループを `PostProcessor` として包んだ
    **同期 adapter**（submit → 待ち → 同 seq read・+1 block 遅延なし）を新設する。
    per-bus の shm/child 構成は `build_effect_bus_stages`（§2.2）の offline 版。

### 4.2 stem の取り出しはエンジン変更ゼロ

`render_block` 実行後、各 `InsertBusStage.buffer[..bs]` には **insert 適用後・合流前**の
内容が残っている（合流は加算コピー・§2.1）。オフラインドライバが buses を所有しているので、
呼び出し直後に各 buffer を bus 別 WAV へ追記するだけで per-bus 出力になる。
master WAV は `hw_block`（全合流 + master post 適用後）。

- 意味論の定義: **stem = 各バスの post-insert 信号**（= そのバスの「音色込み」の音）。
  sum バス配下の member バスも個別 stem として書ける（合流前 buffer が残るため）。
  master post（全体にかかる effect）は stem には乗らない — 乗せたい処理はバス側 chain に置く。
  この分担は DAW の stem export の慣行と一致する。
- 8 本の数え方: owner 案の `output(1)`〜`output(8)` は「バス 8 本を宣言し、各 seq を
  いずれかへルーティングする」ことに相当する。バス数は 8 固定ではなく宣言依存
  （`MAX_INSERT_BUS_STAGES = 64`・`output.rs:268` が上限）。

### 4.3 イベント源 — score-mode（TS 仮想クロック列挙）

オフライン要求は自己完結の **render manifest** として daemon へ送る。P1 で確定する
wire schema は次のとおり（field 名は daemon wire と同じ snake_case）:

```
RenderScore {
  sample_rate: number,
  duration_sec: number,
  block_frames: number,
  samples: [{ name: string, path: string }],
  buses: [{
    name: "1" | ... | "16",
    chain: [{
      plugin: string,
      plugin_id?: string,
      target: { role: "effect", bus?: string },
      state?: string
    }]
  }],
  master: {
    chain: [{
      plugin: string,
      plugin_id?: string,
      target: { role: "effect" },
      state?: string
    }]
  } | null,
  events: [{
    start_sec: number,
    sample: string,
    gain: number,
    pan: number,
    offset_sec: number,
    duration_sec: number,
    rate: number,
    bus: "1" | ... | "16"
  }],
  out_dir: string
}
```

- `samples[].name` と `buses[].name` は manifest 内で一意。`events[].sample` / `events[].bus`
  は必ず同 manifest の宣言を参照する。未宣言参照は `MALFORMED_REQUEST`。
- bus 名は `output(n)` と同じ canonical decimal (`"1"`〜`"16"`)。先頭ゼロ表記は不可。
- bus chain の `target` は `GetPluginState` と同じ `{role,bus,instance}` 語彙を使う。P1 の
  bus/master chain は effect のみを受理し、bus chain の `target.bus` は省略時に包含 bus、
  指定時は包含 bus と一致しなければならない。master は `bus` を持たない。
- `state` は P0-C で確定した**絶対 state ファイルパス**。blob 埋め込みや project 相対 path は
  wire に持ち込まず、TS が `resolveRegisteredPluginStatePath` で解決してから焼き込む。
- `sample_rate` / `block_frames` は正の整数、`duration_sec` は正の有限値。event の時刻・gain・pan・
  region・rate も有限値とし、`start_sec` は `[0, duration_sec)`、`offset_sec` / event の
  `duration_sec` は 0 以上、`rate` は 0 より大きい。`out_dir` と各 path は非空、plugin/state path
  は絶対 path とする。
- `master` を含む上記 top-level field はすべて必須（master chain 無しは `null`）。P1 は
  validation 後に `NOT_IMPLEMENTED` を返し、実レンダは P2 まで行わない。

TS 側 score-mode ドライバが `.orbs` を評価し、仮想クロックで `[0, T]` の全発音を列挙して
events を作る（LOOP は `T` で打ち切り）。`T` はレンダ要求のパラメータ。
`.orbslog` replay（SESSION_LOG_SPEC_v1 の因果記録の再生）は同じ manifest に落ちる別の
フロントエンドとして後続 issue に分離する（ライブセッションの書き出しに将来必要だが、
「作品をファイル化する」本命ユースケースは score-mode で先に立つ）。

### 4.4 DSL 表面 — `output(n)` は既存 `output(name)` に統合する【owner 裁定済み・X1】

現状の `seq.output(name)` は (a) sum バス名なら mixer routing（bus 側 wire）、
(b) それ以外は LinkAudio channel（LinkAudio 未宣言なら警告して不発）という2用途を持つ
（`sequence.ts:337-377`）。owner は **X1（同じ `output` へ統合）**を裁定した。
解決順と意味論を次で固定する:

1. 引数を名前へ正規化し、まず既存 `global.sum(name)` を解決する。したがって
   `global.sum("1")` があれば `output(1)` も既存 sum routing になり、数値解釈より優先する。
2. sum に解決されず、元の引数が number なら render bus と解釈する。整数 `1..16` のみ受理し、
   wire/manifest の bus 名は canonical decimal string (`"1"`〜`"16"`)。
3. string 引数は従来どおり LinkAudio channel（未宣言時の「記録 + 警告」を含む）。数字に見える
   string は render bus に暗黙変換しない。

render bus は score-mode の routing 宣言であり、`output(n)` 自体は bus を別メソッドで宣言させない。
audio sequence と instrument sequence の両方で使える。既存 `output(sumName)` / LinkAudio 用法、
`play()`、realtime の既定経路は変更しない。`seq.effect()` の insert chain は score manifest 構築時に
該当 render bus の chain へ載せる（P2/P3）。P1 は routing の記録と manifest wire の確定までとする。

#### 4.4.1 再宣言時に何が残るか — **オフラインの宣言は live routing を変えない**（一方向）

上の解決順は「1回の呼び出しがどう解釈されるか」しか定めていない。**同じ seq に `output()` を
2回以上宣言した時に前の宛先がどうなるか**を、次で固定する（ライブコーディングでは書き換えて
再評価するのが常態なので、この規則が無いと挙動が宛先の種類ごとに散らばる）:

| 宣言 | `_renderBus` | `_outputChannel`（LinkAudio egress） | `_sumOutputBus` |
|---|---|---|---|
| `output(n)`（render bus） | **設定** | **変更しない** | **変更しない** |
| `output(name)`（LinkAudio channel） | **クリア** | 設定 | 変更しない（既存挙動） |
| `output(sumName)`（sum 解決） | **クリア** | 変更しない（既存挙動） | 設定 |

**非対称は意図的である。**

- **オフライン → live 方向を禁じる理由**: `output(n)` は「後でオフラインレンダする時の宛先」の
  宣言であって、いま鳴っている経路の指示ではない。これが live routing を壊すと、
  `global.linkAudio()` セッションで `kick.output("Kick Ch")` が稼働中に
  レンダ準備として `kick.output(1)` と書き足した瞬間、`_outputChannel` が消えて
  次の schedule で `resolveDispatchChannel()` が「has no .output() channel set」の skip 判定に落ち、
  **ライブ中に kick が無音になる**（2026-08-01 の #612 監査で特定）。
  🔴 #645 PR-D0（2026-09-04）以降、この経路は throw ではなく**無音スキップ + ログ**である
  （core spec §8.1.2 参照）。他の sequence を巻き添えにはしなくなったが、
  **意図しない skip 自体は今も避けるべき事故**なので、非対称の理由は変わらない
- **live → オフライン方向を許す理由**: オフラインレンダは P2 まで走らないので、
  live 宛先の宣言が render bus を落としても失うものが無い。むしろ
  「もう使わない render bus が残り続ける」stale を防げる

live 宛先どうし（LinkAudio channel ↔ sum bus）の相互排他は本 issue の対象外（既存挙動のまま）。
なお LinkAudio と sum bus は v1 で相互排他なので（`mixer-manager` の宣言ゲートと
`global.linkAudio()` のゲートが双方向に塞ぐ）、その2つが同時に立つ状態自体が到達不能である。

### 4.5 決定論

- プラグインなし構成: 同一 manifest → **bit 一致**を保証・受け入れ基準にする
  （単スレッド駆動・`Scheduler` は決定論・§3.2 の parity が transport の透明性を実証済み）。
- プラグインあり: プラグイン自体の非決定性（内部乱数・denormal 差等）は保証外。
  決定論的な test plugin での parity（in-process vs out-of-process・§3.2 と同型）を
  受け入れ基準にする。

### 4.6 スコープ外になったもの（将来課題としての記録）

- **エンジンの >2ch 出力・placement DSL・`pan` の 2ch gate（`scheduler.rs:250-257`）・
  ch3 以降の R 複製（`scheduler.rs:536-545`）**: per-bus 書き出し + DAW 空間化の構成では
  OrbitScore が 2ch を超える interleaved 出力を作る局面が存在しないため、現行のままでよい。
  将来「OrbitScore 内での空間化」「8ch デバイスへの realtime モニタ」をやる場合の課題として
  残る（その時は per-event channel-gain vector の precompute 一般化が素直。stereo 経路の
  bit-identity 維持が制約）。
- **プラグインの多ch バス**（CLAP surround / VST3 SpeakerArrangement）: 不要（各バス上で
  stereo/mono のまま）。なお rev 1 での一次ソース確認により、規格・pin 済み crate とも
  技術的障害は無いことだけ記録しておく（必要になった時の見積もり材料）。
- **`link-audio` × plugin 系 feature の compile 時排他**（`engine_wrap.rs:1642-1671`）:
  オフライン経路は cpal callback を使わないため無関係。排他解消は本 issue から外す。
  なおコメントの参照先 #340 は CLOSED のため、**#598 への参照差し替えだけ**は実装フェーズの
  ついでに行ってよい（挙動不変・1行）。

---

## 5. フェーズ分割

依存: `P0 → P1 → P2 → P3`。P2 完了時点で「プラグインなしの per-bus オフライン書き出し」が
使え、P3 完了で #474 の音色込みになる。

### P0 — 残り調査（小）

内容:
1. **score-mode 列挙の設計スパイク**: TS のスケジューリング（`sequence.ts` /
   `rust-engine-player.ts`）から、wall-clock 非依存に `[0, T]` の発音列挙を切り出せるか。
   結合度と切り出し面を特定する（lookahead 送信部と発音計算部の分離可能性）。
2. **#474 到達点の確定**: プラグイン state save/load の最終形（P4c 完了後の API）を確認し、
   manifest の `state` 受け渡し形式を確定する。
3. **instrument offline の経路差確認**: 簡易 publish（§3.3）と本番 backing ring の差分を
   列挙し、P3 でどちらへ寄せるか決める。

受け入れ基準: 各項の結論が根拠（file:line / 実行出力）つきで報告されること。
停止条件: (1) で列挙の切り出しが不成立（発音計算が wall-clock と分離不能）なら、
score-mode の代替（daemon 側で schedule 済みイベントを固定 time で流し込む等）を再設計して
owner に提示してから先へ進む。
難易度: 低。

### P1 — DSL / wire / spec（spec 先行）

内容:
- §4.4 の owner 裁定を反映して `INSTRUCTION_ORBITSCORE_DSL.md` と本 spec に確定を書く。
- `output(n)` → レンダーバス routing の TS 実装 + `RenderScore` manifest 型の確定。
- daemon: `RenderScore` RPC の受理・検証（バス名照合・排他検証は既存パターン踏襲）。
- P0-A の必須昇格: VST3 の setup/process 両方を session mode に従って
  `kRealtime` / `kOffline` へ切替可能にし、CLAP は `clap.render` を query して offline を set する。
  既定は realtime のまま。CLAP 拡張なしは warning を出して継続する。

受け入れ基準: manifest の round-trip（TS 生成 → daemon 検証）のユニット + 変異検証。
既存 DSL（`output(sumName)` / LinkAudio 用法・`effect()`）の全テスト green。
依存: P0-1。停止条件: 既存 `output()` の2用途と衝突しない表面が組めない場合は
X2 案へ切り替えて owner 再裁定。
難易度: 低〜中。

### P2 — OfflineRenderSession（プラグインなし・per-bus WAV + master）

内容:
- daemon: §4.1 の driver（`render_block` 再利用・bus buffer tap・WAV 直接 write）。
- TS: score-mode ドライバ（`.orbs` → manifest → RenderScore → 完了待ち → パス受領）。
- 進捗/完了/失敗の event 面（MCP から叩けること — LLM 第一級ユーザー原則）。

受け入れ基準:
- 同一 manifest 2回で **bit 一致**（§4.5）。
- 実時間比の高速性を実測報告（例: 60 秒の score が数秒でレンダ完了すること。閾値は
  固定しないが実測値を必ず記録）。
- 8 バス構成の E2E: `.orbs` → 8 stem WAV + master WAV、各 stem に該当 seq の音のみが
  入っている（他バスへの bleed 無し）ことの WAV 内容アサーション。
- live 経路の全テスト green・`play()` 意味論無変更。
- gated E2E として `tests/e2e` 系に資産化（MCP 経由で実 daemon を駆動）。

依存: P1。停止条件: `render_block` 再利用で不都合（可視性・所有権）が出て複製実装に
傾きそうになったら、複製せず停止して報告（複製は本設計の核心を壊す）。
難易度: 中。

### P3 — プラグインチェーン統合（in-process + out-of-process 同期駆動）

内容:
- out-of-process 同期 adapter（`PostProcessor` 実装・`render_through_child_sync` の
  ループを per-session 常駐 child に対する stateful 版へ）。bus ごとの shm/child 構成の
  offline 版（`build_effect_bus_stages` の対応物）。plugin state 復元。
- instrument child の offline 駆動（イベント転記を本番 backing ring 経路に揃える・P0-3 の決定に従う）。
- 失敗の扱い: child crash / load 失敗 / timeout は**レンダ全体の明示エラー**
  （部分成功の silent な WAV を残さない。dry 素通しの誤 PASS は `ChildStats`
  （`offline.rs:56-64`）の突き合わせで検出 — 既存パターン）。

受け入れ基準:
- 決定論 test plugin での in-process vs out-of-process offline parity（§3.2 の再現を
  production セッション経由で）。
- **実商用プラグイン**（owner 常用のもの・音色 state 込み）で 60 秒級レンダが完走し、
  stem に効果が乗っていることの実機確認 + 所要時間の実測報告。
- `process_errors == 0 && processed == 期待 block 数` の検証を E2E に含める。
- 変異検証: chain を外した変異で stem の内容が変わり red になるテスト。

依存: P2・P0-2/3。
停止条件: 商用プラグインで同期駆動が構造的に破綻する事例（load はしたが offline の
lockstep で process が返らない等）が出たら、当該プラグインを in-process fallback で
救えるか評価して owner に報告（§3 の実測は test plugin までなので、ここが本フェーズの
真の検証点）。
難易度: 中〜高。

### スコープ外（本 issue でやらない・§4.6）

realtime >2ch モニタリング / placement DSL / プラグイン多ch / feature 排他解消 /
`.orbslog` replay フロントエンド。それぞれ必要になった時点で別 issue。

---

## 6. 未解決の問い（owner 裁定）

1. **DSL 表面**（§4.4）: 案 X1（`output(n)` = 宣言済みレンダーバスへの routing・既存
   `output(name)` に統合・推奨）か、案 X2（数値専用の別メソッド）か。
   バス宣言の語彙（`global.bus(...)` 等）も概算で構わないので方向の指定が欲しい。
2. **stem ファイルの形式**: 各バス stereo WAV のまま書く（推奨・DAW 側でモノ化可能）か、
   モノ downmix オプションを v1 から持つか。sample_rate 既定 48k / f32 でよいか
   （提出形式 24bit 化は DAW/ffmpeg 側の仕事と整理している）。
3. **レンダ尺 `T` の指定方法**: レンダ要求のパラメータ（推奨）か、DSL 側に書くか。
4. **master post を stem に乗せない整理**（§4.2）でよいか（DAW 慣行準拠・推奨）。
5. **`.orbslog` replay** を別 issue に分離すること（推奨）の確認。
6. **out-of-process が使えないプラグインが P3 で見つかった場合**の優先順位:
   in-process fallback を許す（クラッシュ隔離を捨てる）か、offline 非対応として弾くか。
   実例が出てからの裁定でよい（P3 停止条件に接続）。

---

## 7. 確信度と反証可能性

| 主張 | 確信度 | 何を見れば誤りと分かるか |
|---|---|---|
| out-of-process child は非実時間で同期駆動できる | **高（実測済み）** | §3.2 の5コマンドの再実行。fail するなら環境依存の見落とし。ただし実証は test plugin / oracle まで — **商用プラグインで覆る余地**は P3 停止条件に明記 |
| `render_block` はオフラインから再利用できる | **高** | `output.rs:521-563` のシグネチャに cpal / RT 専用型が現れたら誤り。`Engine` + slices のみが根拠 |
| stem = render 後の bus buffer 読み出しで取れる（エンジン変更ゼロ） | **高** | `output.rs:676-719` の合流が加算コピーで buffer を消費しないこと、および `InsertBusStage` の所有がドライバ側にあること。前者は post-loop の実装が上書き/消去に変われば崩れる |
| TS dispatch は just-in-time でオフラインに転用不可（score-mode 新設が要る） | **高** | `rust-engine-player.ts:16-20`。全量前倒し送信の隠し経路があれば誤り（発見できず） |
| score-mode の列挙が既存 TS 構造から切り出せる | **中（未検証）** | P0-1 のスパイクが唯一の実証。本設計で最も検証が薄い前提であり、P0 停止条件に接続 |
| per-bus プラグイン chain の機構が realtime 側に既にある | **高** | `engine_wrap.rs:457-533`・`sequence.ts:337-` の実読。offline 版はその対応物という見積もり |
| pan 2ch 前提は本計画で触らなくてよい | **高（スコープ定義に従属）** | 「OrbitScore が >2ch interleaved を出力する局面が無い」というスコープ（owner 裁定）自体が変われば崩れる |
| LinkAudio 案は目的に合わない | **高** | 「実時間録音が要る」ことは経路構造（Live 側で録る）から自明。owner の目的定義（録音レス）が変われば再評価 |

---

## 付録: FEASIBILITY.md との対応

| FEASIBILITY の結論 | 本設計での扱い |
|---|---|
| (1) per-track 経路なし → × | P2 の per-bus stem 書き出しで解消 |
| (2) オフラインはプラグインを通らない → × | P2+P3 の OfflineRenderSession（`render_block` 再利用 + 同期 child 駆動）で解消 |
| (3) LUFS/dBTP は外部ツールで可 → ○ | 変更なし（7.1 化・整形は DAW/ffmpeg 側の仕事） |
| 案A（DAW で最終段） | **本設計の恒久構成として昇格**（OrbitScore = stem 生成 + 音色、DAW = 空間化・整形） |
| 案B（LinkAudio） | 不採用（§2.6 に理由を記録） |

---

## §P0 調査結果（2026-08-01 実施・調査のみ・実装なし）

> 実施者: p598p0 調査エージェント。probe ハーネス =
> `rust/crates/orbit-vst3-instrument-child/tests/kontakt_probe_gated.rs`（**未コミット・調査専用**）。
> P0-A のための一時パッチ（下記 A-3）も未コミット・`TEMP(#598 P0 probe)` マーカー付き。

### P0-A: Kontakt early probe

**結論（第1段・確定）: Kontakt 8 は `kRealtime` のまま offline lockstep で process が返る。
ハングしない。停止条件（process が返らない）には触れていない。**

- 実行: Kontakt 8 VST3（`/Library/Audio/Plug-Ins/VST3/Kontakt 8.vst3`）を
  `orbit-vst3-instrument-child` で load し、`render_instrument_through_child_sync_with_options`
  相当の同期 lockstep で 5 秒分 = 1875 block（128f/48k）を駆動。
- 実測出力: `elapsed=16.1ms (x309.7 realtime) processed=1875 process_errors=0 decode_errors=0`
  （空ラック）。patch 入り（下記 probe3）でも 7500 block 完走・ハングなし。

**結論（第2段・内容比較・確定）: 乖離は実在する。
「ディスク読み・非同期 voice 起動が新規に必要な区間」で full-speed 側の音が遅れ・欠ける。
`process_errors == 0` のまま起きる（サイレント障害の実証）。
→ オフラインモード通知（VST3 `kOffline` / CLAP `clap.render`）を P1/P3 の必須項目へ昇格する。**

- 条件: owner が Kontakt 8 に **Symphony Series String Ensemble**（ライブラリ実測 32.5GB・
  state 1,333,207 bytes）をロードした state を `--state` で復元。イベント = C2/G2/E3/B3/D4 の
  5音和音を 16 秒保持（20 秒尺の 80%）+ 0.5s ごとに C5/E5 の短音・48k/128f・7500 block。
- 3脚: **A** = full-speed lockstep（FS キャッシュ最冷）→ **B** = full-speed 2回目（温）→
  **C** = 実時間 paced lockstep（最温・realtime に最有利）。全脚 `processed=7500
  process_errors=0`。A/B は **x25 realtime**（20 秒の score が 0.8 秒。x309 でないのは
  Kontakt の DSP コストが支配項になったため — これは §3.2 の予想どおりで障害ではない）。

| 区間 | 実測 | 解釈 |
|---|---|---|
| 0–0.5s | 3脚とも無音 | patch の立ち上がり（正常） |
| **0.5–1.6s（初回オンセット群）** | **full-speed が系統的に欠ける**: 100ms 窓 RMS で A=0.0004 / B=0.0000 / C=0.0184（w5）、A=0.0121 / C=0.0437（w10）、A=0.0112 / C=0.0663（w11）。B は w11-13 で 0.046→0.082 と**遅れて束になって立ち上がる** | 非実時間駆動では Kontakt の非同期 voice 起動・ストリーミングが wall-clock を要するため**発音が遅れる／薄くなる**。warm cache（B）でも遅れは残る = **キャッシュでは救えない、pacing そのものの効果** |
| 1.6–16s（ループ持続） | 3脚とも 100ms 窓 RMS が**小数6桁で一致** | ループ区間・再利用サンプルは RAM 内で完結し自己回復する。**全体 RMS の近さは成功の根拠にならない**（欠けるのは音楽的に最重要な立ち上がり） |
| **16–17.6s（NoteOff → リリースサンプル）** | A が B/C から再び乖離（w162: A=0.0558 / B=0.0655 / C=0.0647、w166: A=0.0735 / C=0.0683） | リリースサンプルの**初回ディスク読み**で cold+fast が再び崩れる。warm（B）はほぼ C に一致 |
| bit 比較 | A-B=0.287 / A-C=0.292 / B-C=0.312（最大絶対差・**いずれも 1.2-1.3s 地点**） | Kontakt は同 pacing でも bit 非決定（A vs B）。ただし乖離の**所在**が streaming 敏感区間に集中しており、判定は bit でなく窓 RMS で行った |

- WAV 3本 + 実行ログ: `/tmp/claude/kontakt-probe/probe3-{A,B,C}-*.wav`・`probe3-run.log`
  （検聴可。/tmp のため永続しない — 必要なら退避）。
- **誠実な限界**: (a) 脚 C は「実時間 pacing の lockstep」であり cpal 実機 capture ではない
  （同一 transport・同一 child で pacing だけを変数化し交絡を消す設計を採った）。
  (b) `kRealtime` のままの実測である — **`kOffline` を立てれば直るかは未検証**（Kontakt が
  オフラインモードで同期読みに切り替えることを期待するが、それは P3 実装後の受け入れ基準
  「実商用プラグインで stem に効果が乗っている実機確認」で再測定する）。
  (c) 1 patch・1 構成での実測（一般化はしない）。

**副産物の発見（#474 の実装ゲャップ・本 issue と独立に修正 issue 化すべき）**:

| # | 発見 | 根拠 |
|---|---|---|
| A-1 | **Kontakt 7/8 は現行 host で UI が開けない**（`OPEN_UI` → `edit controller is unavailable`）。Kontakt は単一コンポーネント型で `getControllerClassId` が失敗し、host に「component 自身へ IEditController を query する」VST3 正準フォールバック（SDK editorhost 慣行）が無い | `orbit-vst3-host/src/lib.rs:1383-1392`（フォールバック不在）・`view.rs:133`（エラー発生点）。実行ログで Kontakt 7/8 とも再現 |
| A-2 | Kontakt は attach 前の `IPlugView::getSize` に kNotInitialized(5) を返し、現行 host は open を中断する | `view.rs:173-180`。実行ログ `IPlugView::getSize failed (5)` |
| A-3 | 上記2点への**一時パッチ**（controller フォールバック + getSize 失敗時の既定サイズ）で Kontakt 8 の UI open → SAVE_STATE 経路が動作 | working tree の `TEMP(#598 P0 probe)` 差分（未コミット）。実行ログ `[probe2] UI opened` |

**確信度**: 「process が返る」= 高（実測）。「kRealtime のままでは内容が壊れる」= 高
（3脚比較で pacing 起因の乖離を実測。窓 RMS 5〜40 倍の欠落）。
**反証可能性**: probe3 の再実行（`kontakt_probe_gated.rs` + 退避済み state）。
別 patch・別イベント列で early-window 乖離が再現しなければ一般化を弱める。
`kOffline` 通知で乖離が消えるかは P3 の受け入れ基準で検証する。

**P3 への含意（実測済みの別материал）**: VST3 host の `ProcessContext` は現在**完全に静的**
（`tempo: 120.0` 固定・`projectTimeSamples: 0` 固定・`lib.rs:954-978`）で、shm の
`transport_context[slot]`（`transport.rs:235`）は**どの child も読んでいない**（全 crate grep で
消費者ゼロ・書き手は `instrument_host.rs:286` のみ）。テンポ同期系の Kontakt patch は realtime
でも offline でも同じ「120bpm・時刻0」を見るため、この点は両脚の比較を汚さない。

### P0-B: score-mode 列挙の設計スパイク

**結論: 成立する（切り出し可能）。停止条件（wall-clock と分離不能）には該当しない。**

発音時刻の計算と wall-clock は既に層で分離されている:

1. **audio 経路**: `Sequence.scheduleEvents(scheduler, loopIteration, baseTime)`
   （`sequence.ts:1440`）は iteration と baseTime が純パラメータで、イベント時刻は
   `baseTime + event.startTime + loopIteration × patternDuration` の算術
   （`event-scheduler.ts:83-88`）。wall-clock は入らない。
2. **loop 継続機構**（`loop-sequence.ts`）の setTimeout / `Date.now()` は「次の bar の
   schedule 呼び出しを実時間上のいつ実行するか」だけを担い、グリッド自体は
   `nextScheduleTime += previousDuration` の算術で前進する（`loop-sequence.ts:194`）。
   列挙には不要。
3. **note（instrument = Kontakt）経路**: `scheduleMidiEvents`（`sequence.ts:1129`）の
   Stage A/B は `onTime = schedulerStartTime + baseTime + ev.startTime + sendDelay`
   （`:1151`）と offTime を**完全に事前計算**し、Stage C で
   `MidiScheduler.scheduleNote({onTime, offTime, ...})`（`:1214`）へ渡す。wall-clock は
   `MidiScheduler` の 5ms poll（`midi-scheduler.ts:77-80`）に閉じている。
4. **dispatch 層**（`rust-engine-player.ts`）の poll / clock anchor / lookahead は
   スケジュール済みイベントの発火にのみ関与（`:1179-1189`, `:1406-1412`）。

**切り出し面（推奨）**: collector を2面用意する —
(a) `Scheduler` interface（`core/global/types.ts:11`）の収集実装に
`scheduleEvents(collector, k, 0)` を k = 0..⌈T/patternDuration⌉-1 で直列に呼ぶ、
(b) `MidiScheduler.scheduleNote` 互換の収集実装（`schedulerStartTime=0` を渡せば相対 ms）。
これで `[0, T]` の全発音が本番と同一の計算経路から得られる。

**注意点（設計に織り込むべき残り）**:
- **RNG**: `gainRandom`/`panRandom`（`event-scheduler.ts:39,94`）・§12 `^r`/`Xr`
  （`sequence.ts:1167,1172`）は `Math.random` — **manifest 構築時に値が焼き込まれる**ので
  「同一 manifest → bit 一致」（§4.5）は成立するが、「同一 .orbs → 同一 manifest」はシード
  なしでは成立しない（列挙の再現性が要るならシード注入を P1 で検討）。
- **slice 領域解決**: `resolveSliceRegion`（`rust-engine-player.ts:1425-1446`）はサンプル尺
  （daemon LoadSample メタ）依存。manifest 構築は 2-phase（先に LoadSample → 尺取得 →
  本番と同じ `toDaemonParams` を再利用して解決）が parity 上素直。
- score-mode v1 は「評価後の静的状態 × T」を列挙する（live の tempo/mute 動態は対象外 —
  §4.3 の「LOOP は T で打ち切り」と整合）。

### P0-C: #474 到達点（plugin state save/load の最終形）

**結論: 確定した。manifest の `state` 受け渡しは「絶対 state ファイルパス」でよい。**

- **保存経路**: UI close → `savePluginUiStateAtSafepoint`（`global.ts:772`）→
  `ProjectStateStore.save(identity, target)` →
  `audioEngine.savePluginState(target, absolutePath)` →
  `<projectDirectory>/states/<base64url(identity)>.state` に書き、`project.yaml` の
  `states[identityKey]` に相対パスを登記（`project-state-store.ts:214-234`・atomic rename +
  dir sync）。identity = `{receiver, role, normalizedName, occurrence}`（SC.5）、
  identityKey = `receiver/role/normalizedName/occurrence`（`:28-35`）。
- **復元経路**: `resolveRegisteredPluginStatePath(projectDirectory, identity)`
  （`project-state-store.ts:94`）が絶対パスへ解決 →
  `loadPlugin(filePath, pluginId, role, bus, instance, statePath)`
  （`rust-engine-player.ts:941`）→ daemon → child 起動引数 `--state <path>`
  （`outproc_instrument.rs:398`・`orbit-vst3-instrument-child/src/main.rs:56`。
  VST3 は `.vstpreset` container / raw component chunk の両対応、restore は
  **setActive 前**適用 = 正準・`main.rs:276-298`）。
- **RenderScore への含意**: オフライン child も同じ `--state` 経路をそのまま使える。
  manifest の `chain: [{plugin, state}]` の `state` は**絶対パス**（TS 側で
  `resolveRegisteredPluginStatePath` を再利用して identity → パス解決してから manifest に
  焼き込む）。blob 埋め込みは不要。

### P0-D: instrument offline の経路差

**結論: 差分は4点。P3 は「本番 backing ring に揃える」のではなく、
同期 publish のまま不足2点を足すのが正しい（spec §3.3 の想定を修正する）。**

| # | 差分 | 本番（`instrument_host.rs`） | 簡易 publish（`offline.rs:192`） |
|---|---|---|---|
| D-1 | イベント配送 | `EventBackingRing` に push → 空き slot へ drain。**RT で待てないため spill/drop があり得る**（`input_event_spilled_count` / `input_event_dropped_count`・`:236-241, :279-284`） | 呼び出し側が block ごとに直接 slot へ書く。同期 1-outstanding で slot は常に空き — **構造的に lossless**。ただし `events.len() > MAX_EVENTS_PER_BLOCK`(4096) は assert panic（`offline.rs:217`）→ 事前検証か分割が要る |
| D-2 | **transport_context** | slot ごとに書く（`instrument_host.rs:286`） | **書かない**（`offline.rs:216-228` に該当 store なし）→ P3 で追加（1行）。※現状は全 child が未消費（P0-A 末尾）なので今日の実害はないが、将来 child が消費し始めた時に offline だけ 0 値になる罠 |
| D-3 | voice 会計・NoteChoke 注入・respawn 回復 | あり（`:257-296` ほか） | なし。オフラインは単発駆動・child 死亡は即エラーでよいので**不要が正しい** |
| D-4 | child 出力イベント（note_end 等）の drain | あり（voice 会計のため） | なし。オフラインでは不要（stats 突き合わせで代替） |

**推奨**: P3 の instrument offline 駆動は簡易 publish 系を昇格させる
（transport_context 書き込み追加 + per-block イベント数の事前検証）。backing ring への
片寄せは「lossless 配送」を**むしろ悪化**させる（ring/spill は RT 都合の損失許容機構）。
spec §3.3 の「高密度イベントでの lossless 配送は P3 で本経路に揃える」は本調査で
**逆向きに訂正**する。

### 停止条件の総括

| 項目 | 停止条件 | 判定 |
|---|---|---|
| P0-A | process が返らない・ハング | **非該当**（空ラック 310x / 実 patch 25x で完走）。内容比較は**乖離を実証** → 設計変更でなく **P1/P3 への必須項目追加**（オフラインモード通知）で対処 |
| P0-B | 列挙が wall-clock と分離不能 | **非該当**（分離は既に層構造として存在） |
| P0-C | —（確認事項） | 完了 |
| P0-D | —（確認事項） | 完了（spec §3.3 の想定を1点訂正） |
