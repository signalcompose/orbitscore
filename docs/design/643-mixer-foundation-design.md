# #643 設計: ミキサーの土台と、その上に乗るオプションの責務分離

- Issue: [#643](https://github.com/signalcompose/orbitscore/issues/643)（改題後: *separate the mixer foundation from the sources that ride it — audio, instrument, and their routing*）
- ブランチ: `643-instrument-insert-bus-design`
- 設計: Fable subagent（v1→v5・2026-08-29）/ **検収: main**（各版で一次ソース照合）
- 前提コード: PR #639 マージ後（ラック #628 完成済み）

> **この文書は設計のみ。実装は含まない。**

---

## 🔴 owner 確定事項（再議論しない）

### 三条（2026-08-29）

> 基本的にミキサーのバス仕様はオーディオであれインストであれ一緒になっていないとダメですよね。midi だけが外部（もしくは内部）の MIDI 出力にまわるのでミキサーバスとは関係がなくなります。また、インストやオーディオでミキサーバスに乗らない例外は LinkAudio が出力先になっている時だけです（LinkAudio は外部オーディオへ流す特殊なバス）。

1. **ミキサーのバス仕様は audio と instrument で同一**
2. **midi のみミキサーバスと無関係**（外部/内部 MIDI 出力へ）
3. **例外は LinkAudio が出力先の時だけ**

### 責務分離（2026-08-29）

> オーディオもインストも midi も（midi は毛色が違うとはいえ）基本的には**ミキサーの上に乗るオプション**、であることは変わらないので、**オプション側と土台側でちゃんと責務を分けて作る**必要があると思います。

### 設計の目的（2026-08-29）

> この**土台がしっかりすれば**、OrbitStudio の場合 **UI という制限がない**ので、より**柔軟だったり危険だったりするようなワイヤリングを表現できる**ようになるはずなんですよ。

### アドレスモデル（2026-07-27・2026-08-29 再確認）

> instrument の**アドレッシングは `instance` 単独では足りない**。マルチティンバーでは **`(instance, unit/channel)` が実アドレス**。**アドレスモデルは今決める**（後付けは owner が避けたい手戻りそのもの）。**実装は段階化してよい**

### 容量（2026-08-29）

> シーケンス数は基本「**メモリがゆるすまで**」にしたい

Ableton Live（Suite/Standard）・Bitwig Studio はいずれも**無制限**（Bitwig は return も無制限・Ableton は return のみ 12）。Logic Pro は各 1000。**OrbitScore は instrument 32（既定 8）/ バス 64 / Link 64。**

---

## 0. 結論サマリ

- **責務境界を定義**（§2）。土台は「**premaster contributor**（zero-fill 後・gain 前に名前付きターゲットへ加算する資格を持つもの）」という抽象までを知り、instrument / plugin / シーケンスが何かを**知らない**。
- **境界侵犯を grep で監査**（§1・main 再検証済み）。core は**コード語彙 0 件で清浄**。native の違反は識別子 **2件のみ**（`start_default_output_with_clap` / `ClapHostStart`・依存はなく命名だけ）。
- **protocol の語彙を修正**: `SetInstrumentBus` → **`SetSourceRouting { source, unit, target }`**（未出荷なので互換コスト 0）。判定規則: *侵犯とは「土台の操作にオプション名が付く」こと*。
- **注入点**: `render_multi` の**内側** — zero-fill 後・event 混合後・**gain ramp の前**。これにより **`global.gain` が instrument に効かない現行欠陥が位置の修正だけで消える**。
- **機構は feed（データ渡し）**: native がロック**外**で instrument を render し、core へは `&[(&[f32], FeedDest)]` の不変データを渡す。core の追加は ~15 行。
- **アドレスは `(instance, unit)`**。`unit` = フォーマット中立の**音声出力 index**（VST3 `unitId` ではない）。
- **テストは3層**（型・構造 / キャプチャ E2E / 変異検証）。**変異検証は空**。
- **配線の表現力**（§7）: 現在の4禁止は「借用の都合」と「音楽ポリシー」の混在。恒久形は **Forward / Feedback の2種エッジ**。**#643 では実装しないが、境界は additive に許す**。

---

## 1. 境界監査（grep 実施・main 再検証済み）

| 対象 | 結果 | main の再検証 |
|---|---|---|
| `orbit-audio-core/src/*.rs` | `instrument\|plugin\|vst\|clap\|daemon` の**コード識別子 0 件**（ヒットは全てコメント） | ✅ コメント行を除外して 0 件を確認 |
| `orbit-audio-native/src/output.rs` | 違反は **`start_default_output_with_clap`（886行）/ `ClapHostStart`（820行）** の2識別子のみ。シグネチャは `Box<dyn PostProcessor>` で中立 | ✅ 非コメントのヒットが 886 行のみを確認 |
| `orbit-audio-native/src/post_processor.rs` | doc が CLAP に言及するが型依存なし。`post_processor.rs:3` に「native は permissive な mixing core を保ち、CLAP/clack には依存しない」と**設計意図が明文化済み** | — |
| `session.rs` の全コマンド | 土台 / egress オプション / plugin オプション / テスト に分類。**routing 系だけ土台語彙で統一できる** | — |

**境界の意図は最初から正しく、名前だけが漏れた。**

**処置**: 新規 API は中立名で導入。既存 `_with_clap` の改名は公開 API churn のため **follow-up に記録**（動作影響ゼロ）。

---

## 1.5 🔴 この設計の欠落: 出口が一般化されていない（2026-08-29 owner 指摘）

> オーディオやインスト → ミキサー（バス、AUX など様々なルーティング、柔軟なアウトプット指定）
> という感じですよね。（owner）

ミキサーは **入口・内部・出口**の3つを持つ。本設計が一般化したのは**内部だけ**である。

```
audio / instrument  →   ミキサー          →   出力
    （source）        bus / AUX / insert       ？
                      ↑ §2-§9 で設計した       ↑ 未設計
```

| | 状態 |
|---|---|
| **入口** — source が何本の feed を出すか | ✅ `(instance, unit)` で設計済み（§6） |
| **内部** — bus / insert / send / routing / gain | ✅ 設計済み（§2-§5） |
| **出口** — どのバスがデバイスのどのチャンネルへ出るか | ❌ **未設計** |

### 症状として現れていること

1. **`SourceDest { Master, Bus, Link }` は、バスグラフの内側しか指せない。**
   `Master` の**先**（何チャンネルで、どの物理出力へ）を表現できない
2. **`Link` が「外部オーディオへ」の唯一の出口として特別扱いされている。**
   本来はマルチアウトと同じ軸（出口の種類）に乗るはずで、**特別扱いが必要なこと自体が
   出口の未一般化の証拠**
3. **マスターがステレオ固定**（`CHANNELS = 2` が子プロセスとの shm レイアウトに焼き込み）。
   `output_channels` はデバイス依存（`output.rs:1405`・cpal の `StreamConfig` 由来）なので、
   **8ch インターフェース + 2048 サンプルバッファで instrument の音が出ない**
   （`frames × channels > BUF_LEN(8192)` で feed が破棄される）

### owner 決定（2026-08-29）

- **現状はマスターをステレオ限定とする。** マルチアウトは #611 で**設計から**行う
- **#611 は「マルチアウトの実装」ではなく「ミキサーの出口の設計」**として扱う

### 調査結果（この判断の材料）

| 項目 | 事実 |
|---|---|
| audio シーケンスの物理チャンネル指定 | **存在しない**。`_outputChannel` は **LinkAudio のチャンネル名**（`scheduler.rs:31,95`）で、ハードウェアの ch 番号ではない |
| オフライン側 | `output(n)` → `_renderBus` → `canonical_render_bus`（`session.rs:476`）→ `render-score.ts` は**実装済み** |
| realtime 側 | **未実装**。#611 が「全てのバスやシーケンスのオーディオはマルチで描き出せる必要がある」と定義 |
| モノラル音源 | **子プロセスが解決済み**（`orbit-clap-host/src/buffers.rs:186-` が mono→複製 / multi→ミックスダウン）。ミキサーに届く時点で常にステレオ |
| 発火条件 | `frames × output_channels > 8192`。例: **8ch @ 2048 / 6ch @ 2048 / 16ch @ 1024** |
| この PR の前後 | 前: 幅の違いを無視して加算し **L/R が全 ch に散る** / 後: **feed を丸ごと破棄して無音**。**どちらも壊れている**（この PR が作った欠陥ではなく、症状が変わっただけ） |

### 次に触る人へ

**入口だけ一般化して出口を固定のまま残すと、対称性が崩れる。** §2 の責務境界表には
「土台が知ってよいもの」に**出口の幅が入っていない** — これは意図的な除外ではなく**欠落**である。
#611 でここを埋める時、`Link` を出口の一種として同じ軸に載せられるかを検討すること。

---

## 2. 責務境界

| 層 | 知ってよい | 知ってはいけない |
|---|---|---|
| **土台 core**（scheduler / engine） | バッファ・名前付きターゲット（文字列）・event の時間解決・gain / ramp・transport・feed の加算 | daemon・プロセス・plugin・instrument・シーケンス・バスの「種類」 |
| **土台 native**（output / バスグラフ） | insert 席（`PostProcessor` 抽象）・routing・send・activation・capture・**`BlockSource`（render すると N 本の block をくれる何か）**・容量上限 | instrument / plugin / CLAP / VST3 が何か・子プロセス・shm・**instance 文字列の意味**（opaque） |
| **オプション**（audio / instrument / midi / LinkAudio / master effect） | 自分が何であるか・どう音を作るか・自分の制御面 | **他のオプションの存在**・土台の内部レイアウト |
| **protocol** | 土台の仕事は土台の語彙で・オプションの仕事はオプションの語彙で | **土台の仕事にオプションの名を付けること** |

**土台が知る抽象の下限**: 「zero-fill 済みの名前付きターゲットに、gain の前でサンプルを足す資格を持つもの（**premaster contributor**）」。これより具体的な知識が土台に入ったら境界違反。

---

## 3. event と feed — 1つの契約・2つの実装

土台の契約は1つ: **premaster contributor は、zero-fill（`scheduler.rs:368-380`）の後・gain ramp（405-418）の前に、名前付きターゲットへサンプルを加算できる。**

実装は2つで、**統一しない**:

| | event（scheduler 所有） | feed（外部 render） |
|---|---|---|
| 粒度 | **サンプル精度**（block 内オフセット） | **block 粒度**（常に全長） |
| データ | scheduler が所有 | 借用のみ（`&[f32]`） |
| 状態 | 消費簿記（`read_pos` / retain） | 無状態（毎 block 上書き契約） |
| 由来 | 楽譜（スケジュール済みの決定） | 現在時刻の生成 |

**統一しない理由**: (1) どちらの向きに寄せても**表現力が減る**（feed に event を被せるとサンプル精度と所有を持たない側に強制し、event を feed に落とすと精度と簿記を失う） (2) `render_multi ≡ render` の bit 一致などピン留め済みテスト資産が無効化され、機能は1つも増えない (3) 概念統一は contributor 契約として文書側で達成済み。

🔴 **後から読む人へ**: 「なぜ2つ？」の答えは「**event は時間を解く機構・feed は時間を解かない機構**」であり、**音源の種類（audio か instrument か）による分類ではない**。

---

## 4. オプションカタログ

| オプション | 土台に乗るか | 入り口 | 出口 | 分割アドレス |
|---|---|---|---|---|
| **audio** シーケンス | **乗る** | event（サンプル精度） | バス → master / sum / aux / Link | バス名 |
| **instrument** シーケンス | **乗る**（本設計） | **feed**（block 粒度） | 同上（audio と完全対称・三条1） | `(instance, unit)` + note 側 MIDI channel |
| **midi** シーケンス | **乗らない（仕様・三条2）** | — | 外部/内部 MIDI ポート | port + channel |

midi が乗らないのは制限ではなく仕様: **midi の生成物は音ではなく指示**で、contributor 契約（サンプルを足す）を満たす音声が存在しない。

---

## 5. 機構 — feed

### 5.1 注入点

`orbit-audio-core/src/scheduler.rs` `render_multi`:

```
368-380: zero-fill（hw + 全 channel）
381-403: event 混合                    ← audio シーケンス
         ★ feed 加算ループ（新規 ~10行） ← instrument
405-418: gain ramp 単一 frame ループ     ← 無改変・全バッファに適用
```

```rust
// core（追加はこれだけ・std 型 + core 内 enum）
pub enum FeedDest { Hardware, Channel(usize) }
pub fn render_multi_feeds(&mut self, hw, channels, feeds: &[(&[f32], FeedDest)])
// 既存 render_multi は feeds=&[] で委譲（既存呼び出し・テスト無変更）
```

native 側（**スケジューラロックの外**）:

```
1. 全 slot を render → per-slot scratch（instrument DSP はここで完了）
2. dest を1回 load → position map で FeedDest へ解決（全域関数・未登録 → Hardware fallback）
3. engine.render_multi_feeds(...)   ← ロック内は加算だけ（memcpy 級）
4. post.process(hw)（master effect のみ・CompositePostProcessor は解体）
```

**🔴 これで `global.gain` が instrument に効かない現行欠陥が消える**（位置の修正のみ・別途の手当て不要）。

### 5.2 なぜ callback ではなく feed か

初版は core にクロージャを渡す設計だったが棄却:

1. instrument の DSP（Kontakt の `process_block`）が**スケジューラ Mutex 内**で走り、control スレッドの blocking `lock()` の待ちを延ばす。feed はロック内を**加算だけ**に縮める
2. core に**コード**を注入する器は、**データ1列**より大きい
3. 借用構造が単純（クロージャの捕獲が不要）

### 5.3 source の契約

```rust
pub struct BlockTransport { pub cursor_frames: u64, pub sample_rate: u32 }

pub trait BlockSource {
    /// 全 unit を render。戻り値 = 有効 unit 数（0 = 出力なし）。
    fn render(&mut self, frames: usize, transport: &BlockTransport) -> usize;
    /// render 済み unit u（engine チャンネル数 interleaved）。
    fn output(&self, unit: usize) -> &[f32];
}
pub struct SourceSlot { pub source: Box<dyn BlockSource>, pub dests: Vec<SourceDestCell> }
```

**二段式（render → output）**にすることで、`&mut` からの借用返しが不要になり借用が単純化する。

**`BlockTransport` を最初から渡す根拠**: 現行 instrument は既に `STUB_TRANSPORT` を子ホストへ渡しており、「**オプションが土台の時間を欲しがる**」ことは実証済み。後から要求されると **trait 変更 = 土台変更**になり、「オプション追加で土台を触らない」という本設計の中心主張が最初の追加で破れる。

### 5.4 型による封殺

```rust
pub enum SourceDest { Master, Bus(usize), Link(usize) }
pub struct SourceDestCell(Arc<AtomicUsize>);   // encode/decode をこの中だけに閉じる
```

**マジックナンバーの帯域分割はコードから消える。** 範囲外整数 → `Master`（全域関数）。

| 故障クラス | 封殺の仕組み |
|---|---|
| **pop**（zero-fill されないバッファへの累積） | core は**自分が同一呼び出し冒頭で zero-fill したバッファ**にしか加算しない。未登録バスは hook から**到達不能** |
| source によるバッファ破壊 | feed は **`&[f32]`（不変借用）** — 書き込みが型で不能 |
| scratch の持ち越し | `process_block` の全サンプル上書き契約（既存コメントで明文化済み） |
| 宛先解決の取りこぼし | resolve は**全域関数**（`Option` の未処理分岐が存在しない） |
| snapshot 割れ | dest の読み取りが**構造上 callback あたり1回しか無い** |
| ramp 多重前進 | gain ループは単一 fn 内・無改変 |

---

## 6. アドレスモデル `(instance, unit)`

```
unit 0 = main 出力（全プラグインが必ず持つ）
unit u = ホストが列挙した u 番目の音声出力
```

- **VST3 の `unitId` は採らない**。`IUnitInfo` はパラメータ/プログラム編成の機構で **opt-in**。一方**音声の出口**は VST3 = 出力バス列挙、CLAP = 出力ポート列挙で、**両フォーマットとも index で数えられる**
- 写像（VST3 バス / CLAP ポート）は**子ホストの中**に閉じ、protocol・daemon・TS はフォーマットを知らない
- チャンネル数の非一致（mono・5.1 等）の up/down-mix は**子ホストの責務**

### 一対の完全性（「半分だけ作らない」条項）

| 半分 | wire | 状態 |
|---|---|---|
| 入力（note の分割） | `PluginNoteOn.channel` | **既存**（`rust-engine-player.ts:1137`・main 確認済み） |
| 出力（音声の分割） | `SetSourceRouting.unit` | **本設計で追加** |

「どのパートがどの unit から出るか」は**決めない** — プラグイン内部の設定（Kontakt の UI/state）。DAW と同じ責務分割。

### MIDI サミング（N seq → 1 instrument）との整合

`source` は wire 上**自由文字列**。現行 TS が `plugin:<seqName>` を使うのは **TS 側の命名ポリシー**で、`plugin-note-output.ts:6-9` が *"The scheduler's `port` ... **doubles as the daemon `instance` ID**"* と明記している（main 確認済み）。独立ノード化の日は TS が別の文字列を発行すればよく、**wire の形は変わらない**。

🔴 **避けるべき唯一の結合**: daemon が `source` 文字列の**意味**を解釈しないこと（opaque キーとしてのみ使う）。

---

## 7. protocol

```
SetSourceRouting { source: string, unit: u32, target: string | null }   // null = Master
```

`SetBusRouting`（バス→バス）と `SetSourceRouting`（source→バス）が土台の routing 語彙として対になる。

### 🔴 必ず踏む横断的関心事

1. **replace（#618）の宛先移行**: READY 後の commit 時に**旧 slot の全 unit 宛先を新 slot へコピーし、旧 slot をリセット**。落とすと「音色を差し替えた瞬間にリバーブが外れる」silent detach
2. **teardown → slot 再利用**: 解放時に全 unit をリセット。落とすと次のテナントが前のテナントのバスへ流れ込む

TS 側は intent cache（キー `${source}#${unit}`）+ **respawn replay**。落とすと daemon 再起動で**黙って master 直結に戻る**。

---

## 8. 容量の帰属

| 定数 | 所在 | 帰属 |
|---|---|---|
| `MAX_INSERT_BUS_STAGES = 64` | native | **土台** |
| `MAX_LINK_CHANNELS = 64` | native | **土台** |
| `MAX_SOURCE_SLOTS` / `MAX_SOURCE_UNITS`（新設） | native | **土台** |
| `MAX_INSTRUMENT_SLOTS = 32`（既定 8） | daemon | **オプション**（`≤ MAX_SOURCE_SLOTS` を起動時 assert） |

**「後から容量だけ変えられる」根拠**: **protocol は容量を運ばない** — `SetBusRouting` / `SetSourceRouting` / `PlayAt` はすべて**名前と opaque id** で参照し、wire に上限が現れるのは検証エラーの文言だけ。容量変更 = 定数 + 起動時確保の変更で、**wire 互換に触れない**。

**世代タグの流用範囲（main 確認済み）**: `tenant_generation`（`outproc_instrument.rs:201-203`）のコメントは *"Slot tenant handoff generation... it only asks the RT host to **discard tenant-local voice bookkeeping**"* — **slot の中身（テナント）の入れ替え専用で、プール本数の変更には流用できない**。撤廃の道は「大きい上限の事前確保（idle コストが小さいことは #540 P1 で実証済み）」または「stream 再構築」。

**容量撤廃自体は #643 のスコープ外**（別 issue）。

---

## 9. 配線の表現力 — 土台が禁じるもの・許すもの

### 9.1 現状: 1つの関数に2つの責務が混在

`validate_bus_topology`（`output.rs:416-439`）は配列順の後方参照のみを許す。doc はその理由を**同じ文で2つ**述べる:

> render 時に **`split_at_mut` で解決できない**（**借用の都合**）／前方参照 or 自己参照は **sum のネスト・循環に相当し v1 で禁止**（**音楽ポリシー**）

**音楽的に何が許されるかを借用検査が決めている** — 責務の混入。

現在禁止されているもの:

| | 音楽的な意味 |
|---|---|
| 循環（A→B→A） | **フィードバック** |
| 自己参照（A→A） | セルフフィードバック |
| 前方参照 | 宣言順に依存しない配線 |
| **sum のネスト** | **バスの階層**（DAW では当然できる） |

### 9.2 恒久形: 禁止ではなく「エッジの型」で線を引く

```
Forward(target)   — 同一 block 内の加算。Forward だけから成るグラフは DAG であること（違反は loud 拒否）
Feedback(target)  — target の「前 block の出力」を読む。グラフ制約なし（自己参照も可）
```

循環を書く者は**輪を閉じる1辺を `Feedback` と宣言させられる** — Max/MSP・Reaktor・Bitwig Grid の「循環には明示的な遅延」と同じ意味論（遅延 = 1 block）。

🔴 **GUI が「描けない」で守っていたものを、型が「Forward では書けない」で守る。** Forward の循環はエラーになり、その文言が「この辺を feedback にせよ」と修正方法まで言える。

### 9.3 forward 前提の焼き込み — 3箇所（列挙し尽くし・main 検証済み）

| # | 箇所 | 内容 | 外す時の変更 |
|---|---|---|---|
| 1 | `validate_bus_topology`（`output.rs:416-439`・構築時） | `target <= i` を拒否 | 「Forward グラフの DAG 検証」に置換（control 側・非 RT） |
| 2 | post-loop の `split_at_mut(i + 1)`（`output.rs:676-`・RT） | 配列順 = 処理順の前提 | control 側で事前計算した**処理順の置換配列**を RT が読む + **`slice::get_disjoint_mut`**（std・safe）。**unsafe / `Cell` / 二重バッファは不要** |
| 3 | **`send_gain_overrides` の相対レイアウト** | **配列上の相対位置がデータ構造にエンコードされている**。前方参照を許すと **k が負になり表現不能** | 相対 index → 絶対 stage index のテーブルに張り替え |

**#3 の一次ソース（main 確認済み）**:
- `engine_wrap.rs:1706-1707`: 「index k = 「この stage の**絶対 index + 1 + k**」への send gain」
- `engine_wrap.rs:1760`: `let send_gain_overrides: Vec<Arc<AtomicU32>> = (0..(total - index - 1))`

**3箇所とも native / daemon の内部表現**で、**protocol（名前と opaque id のみ）と core（contributor 契約）は無傷**。

### 9.4 着手順: 階層が最優先・かつ最も安い

階層（sum のネスト）は **DAG のまま**なので Feedback 不要・**順序の問題だけ**。しかも配列順が合う方向（前→後）の sum→sum は**今日の検証を既に通る** — 全面禁止ではなく「宣言順依存で片方向だけ通る」状態。

**着手順**: 順序分離（#1+#2 → 階層が開く）→ Feedback エッジ（循環が開く）→ 保護（下記）。

### 9.5 危険の分担 — 土台は「壊れない」まで、「良い音」は保証しない

| 危険 | 分担 | 根拠 |
|---|---|---|
| CPU 暴走（配線起因） | **土台が構造的に防ぐ** | グラフ有限・処理順事前計算・**再帰なし** → block コストは席数に線形で有界。循環を許しても**処理は循環しない**（Feedback は前 block 参照） |
| UB・メモリ破壊 | **土台が防ぐ** | disjoint 借用は型検査・RT 確保なし |
| 発振の発散（feedback gain ≥ 1） | **利用者の責任** | **意図的発振はこの表現力の目的そのもの。土台は止めない** |
| DC 蓄積 | 利用者の責任 | DC blocker を effect として挿す（オプションの仕事） |
| denormal（減衰尾） | **土台が機械的に防ぐ（推奨）** | FTZ/DAZ は表現力を 1bit も削らない。**現状 0 件 = 未設定**（main 確認済み） |
| NaN/Inf 感染 | 利用者の責任 + **観測は土台が提供** | per-stage メータを将来提供。**自動 flush は入れない** |

### 9.6 スコープ

**#643 では実装しない。** 本 § の成果は「**境界がこれらを後から additive に許す形である**」ことの確定と、その根拠の列挙。

**着手時の受け入れ基準**: `split_at_mut` ・ `- i - 1` ・ `- index - 1` 系の演算を native / daemon で**全数 grep**する（#3 の後追い発見を再発させないため。今回この grep が有効だったことが実証）。

---

## 10. テスト方針（3層・2026-08-29 改訂後のルールに従う）

**大前提: 機能にはテストを書く（TDD・実装前に red を確認）。型はテストの代替ではない。**

| 対象 | 追加で足すもの |
|---|---|
| 型が保証している誤り | **何も足さない** |
| DSL から決定論的に駆動でき信号に出る振る舞い | 機能テストそのものを**キャプチャ E2E** に |
| 駆動できない／信号に出ない内部状態 | **変異検証** |

### キャプチャ E2E（`tests/e2e/orbitstudio-mcp-gated.spec.ts`）

| # | シナリオ | アサーション |
|---|---|---|
| E2E-1 | instrument 演奏 → `global.gain(0.5)` | RMS が ≈½ — **gain 欠陥の修正証明** |
| E2E-2 | `seq.effect(-6dB rack)` で演奏 | dry 比で RMS ≈½ |
| E2E-3 | **演奏中に** `effect()` を後付け | 遷移区間に不連続・スパイクが無い + 以降 effect 適用 |
| E2E-4 | `output(sum)` + `send(aux, g)` | sum / aux 経路の RMS 寄与 |
| E2E-5 | effect 付き instrument を**演奏中に差し替え** | 差し替え後も effect 適用が継続（**宛先移行の証明**） |
| E2E-6 | 解放 slot を新 instrument が再取得（`free_slots` の **LIFO** で決定論的・main 確認済み） | 新 instrument は dry（**teardown リセットの証明**） |
| E2E-7 | 宣言なしの instrument セッション | 音が出る・従来相当の RMS |

すべて capture WAV + `get_log` に ERROR 無しで判定。❌ **`evaluate_orbitscore` の `ok` には依拠しない**。ERROR 件数は 500 行窓なので `<=` を使う。

### 変異検証: **空**

v2 で候補だった replace 宛先移行・teardown リセットも、**DSL から駆動手順が組めた**ため E2E-5/6 へ昇格。

---

## 11. 段階分け

| PR | 内容 |
|---|---|
| **PR-1**（Rust） | core feed → native `BlockSource` / `SourceSlot` / `SourceDestCell` → daemon 改組 + `SetSourceRouting` + replace/teardown の全 unit 処理。**冒頭に借用のコンパイルスパイク（30分）** |
| **PR-2**（TS + E2E） | 3表面解禁（unit 0 固定）・ガード3分岐・E2E 7本 |
| **PR-3**（follow-up） | LinkAudio 実配線（`SourceDest::Link` は型に既在） |
| **後段（別 issue）** | 子プロセスの N 出力（shm レイアウト・出力列挙の写像） |
| **将来（別 issue）** | §9 の配線表現力 / 容量撤廃 / マルチティンバー DSL / instrument 独立ノード化・MIDI サミング / `_with_clap` 改名 |

---

## 12. `output()` 3分岐の扱い（🔴 owner 確認事項）

`output()` は分岐が **3本**あり、note-seq ガードは **sum 分岐にしかない**（main 発見）。

| 分岐 | 行 | midi | instrument |
|---|---|---|---|
| sum バス | `sequence.ts:354-366` | 拒否（現状維持） | **解禁**（本設計の本体） |
| 数値 render bus | `368-386` | **拒否に変更**（現在は黙って記録） | **拒否**（offline render は未設計） |
| LinkAudio チャンネル | `388-400` | **拒否に変更** | **PR-3 まで拒否 → PR-3 で解禁** |

🔴 **midi の2分岐を「黙って記録」から「エラー」に変えるのは、受理していた入力の破壊的変更**。DSL 表面の規律により **owner 確認が必要**。推奨は拒否（三条2の帰結・現状の記録は何の効果も生まない）。

---

## 13. 未確認の前提

| # | 内容 | 確認方法 |
|---|---|---|
| 1 | cfg 4 象限（`outproc-effect` × `outproc-instrument`）の起動経路 | 実装時に4通り列挙してビルド |
| 2 | 借用のコンパイル成立 | **実装 PR 冒頭の 30 分スパイク**（最も安い反証手段） |
| 3 | `MAX_SOURCE_UNITS = 16` の妥当性 | Kontakt 実機で出力バス列挙を数える（後段 issue の頭） |
| 4 | コールバックスタックの `ArrayVec<_, 512>`（~12-16KB） | 実測 or 最初から render state 側事前確保に倒す |
| 5 | **出力列挙の安定性**（state 復元後に順序が変わらないか） | 後段 issue で Kontakt の multi-out 構成を保存→復元して比較。不安定なら子ホスト内で写像を pin（**protocol は不変**） |
| 6 | `SetBusRouting` の kind 検証が sum→sum を許すか | `engine_wrap.rs:1342-1343` は「output は **sum のみ**・send 先は aux のみ」= **宛先**は sum 限定。**source 側**は引数名 `seq_bus` から insert 前提に見えるが未確定 |
| 7 | specs-v2 決定ログとの整合 | **spec を先に更新**（規則 6） |

**解消済み（main 検証）**: instrument が audio event を出さない／slot 定数 32・8／`process_block` 非ブロッキング／`free_slots` の LIFO／`get_disjoint_mut` が rustc 1.97.0 で使える（**実コンパイル確認**）／FTZ・DAZ は**未設定**（0 件）／`STUB_TRANSPORT` 実在／`send_gain_overrides` の相対 index。

---

## 14. 重さの見積もり

| 層 | 内容 | 規模（本体+テスト） | 重さ |
|---|---|---|---|
| core | `render_multi_feeds` + `FeedDest` | ~50-70 + ~80 | **小** |
| native RT | `BlockSource`・`BlockTransport`・`SourceSlot.dests`・二パス収集・定数 | ~180-240 + ~160 | **中** |
| daemon 配線 | `BlockSource` 改組（`STUB_TRANSPORT` を土台 transport に置換）・cfg 4 象限 | ~110-160 | **中** |
| daemon 制御 | `SetSourceRouting`・replace / teardown の全 unit 処理・`≤` 起動 assert | ~130-180 + ~140 | **中** |
| protocol / TS | `SetSourceRouting`・cache キー `${source}#${unit}`・respawn replay | ~200 + ~100 | **小〜中** |
| TS core | 3表面解禁（unit 0）・ガード3分岐 | ~140-180 + ~120 | **中** |
| specs | 三条・責務境界・contributor 契約・アドレスモデル・3分岐表 | 文書のみ | **小〜中** |
| E2E | 7本 | ~300-400 | **中〜大** |

**総量**: 実装 **~900-1100 行** + テスト **~900-1100 行**。**2 PR**（+ follow-up 1）。

最重量は **E2E** と **cfg 4 象限の配線**。後者は機械的だが省略不可（**このプロジェクトで実害を出すのは常に配線**）。

---

## 15. 確信度と反証可能性

**「オプションを1つ足す時に土台を触らずに済む」— 確信度: 条件付きで高。**

新オプションに必要なのは (1) 席（`SourceSlot`）(2) `SetSourceRouting`（名前・opaque id）(3) 自分の制御面 の3つで、いずれも既定の seam。live 入力・ネットワーク音声・自前シンセ（#497）は **`BlockSource` を実装するだけ**で乗る。

**この主張が間違っているとしたら、何を見れば分かるか**:

1. **サンプル精度が要るオプション**が現れた時（feed は block 粒度）。兆候 = 仕様に「block 内オフセット」が出る → contributor 契約に第3実装を土台側に**追加**することになる（作り直しではないが「触らずに済む」は破れる）
2. **土台を読むオプション**（sidechain・アナライザ・メータ）。現契約は**書き込み専用**。前例あり（capture tap `RingTapSink`）
3. **wire に index や処理順が漏れた時**。レビュー観点: 新コマンドのパラメータに**名前と opaque id 以外の構造**が入ったら停止
4. **daemon が `source` id の中身を解釈し始めた時**。兆候 = id の部分一致・接頭辞分岐

**監査方法**: §1 の grep を PR ごとに再実行すれば機械的に検出できる（レビュー観点としてテンプレに残す）。
