# マルチチャンネルレンダリング設計 — per-bus オフラインレンダリング (#598)

```json
{"type":"meta","doc":"MULTICHANNEL_RENDERING_DESIGN","issue":598,"status":"design-for-owner-review","date":"2026-08-01","head":"363d942","rev":2}
```

**Status**: 設計（実装なし・owner レビュー待ち）
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

オフライン要求は自己完結の **render manifest** として daemon へ送る:

```
RenderScore {
  sample_rate, duration_sec, block_frames,
  samples:  [{name, path}],                     // LoadSample 相当
  buses:    [{name, chain: [{plugin, state}]}], // per-bus insert chain（空 = 素通し bus）
  master:   {chain: [...]} | none,
  events:   [{start_sec, sample, gain, pan, slice, rate, bus, ...}],  // PlayAt 相当・絶対時刻
  out_dir
}
```

TS 側 score-mode ドライバが `.orbs` を評価し、仮想クロックで `[0, T]` の全発音を列挙して
events を作る（LOOP は `T` で打ち切り）。`T` はレンダ要求のパラメータ。
`.orbslog` replay（SESSION_LOG_SPEC_v1 の因果記録の再生）は同じ manifest に落ちる別の
フロントエンドとして後続 issue に分離する（ライブセッションの書き出しに将来必要だが、
「作品をファイル化する」本命ユースケースは score-mode で先に立つ）。

### 4.4 DSL 表面 — `output(n)` は既存 `output(name)` に統合する【owner 裁定 §6-1】

現状の `seq.output(name)` は (a) sum バス名なら mixer routing（bus 側 wire）、
(b) それ以外は LinkAudio channel（LinkAudio 未宣言なら警告して不発）という2用途を持つ
（`sequence.ts:337-377`）。ここに第3の解釈を足すのではなく、
**「宣言済みレンダーバスへの routing」として (a) 側に寄せる**ことを推奨する:

- 案 X1（推奨）: `global.bus(...)` 等でレンダーバスを宣言 → `seq.output(1)` は宣言済み
  バスへの routing（wire は既存の `bus` フィールド・`session.rs` の排他検証そのまま）。
  数値は名前 `"1"` の糖衣。effect 無し bus は素通し stem（`InsertBusStage::unattached`
  `output.rs:366-368` が既存）。
- 案 X2: `output(n: number)` を新設し文字列（LinkAudio）と型で分ける。表面は明確だが
  「同じ語が wire の別フィールドに落ちる」非対称が残る。
- いずれでも `seq.effect()` 宣言済み seq は自分の insert bus がそのまま stem になる
  （追加宣言不要）。

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
