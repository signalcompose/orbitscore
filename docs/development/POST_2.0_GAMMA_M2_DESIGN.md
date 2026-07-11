# γ M2 設計 — instrument IPC substrate（format-neutral event/param）

> 🚧 **status: DRAFT — owner サインオフ待ち。** §6 の全項目が未決。本 doc の推奨（recommended）は
> Opus main の提案であり決定ではない。owner が §6 を確定するまで、本 doc を正本として実装に着手しない
> （Phase 3 = VST3 instrument は本 doc の landing 後）。

- **Issue**: #398（本 doc）/ 親 #395（VST3 hosting plan）/ Epic #292
- **正本（決定の根拠）**: [`POST_2.0_PLUGIN_STRATEGY.html`](POST_2.0_PLUGIN_STRATEGY.html) §3（唯一の plan-affecting 決定）・[`POST_2.0_VST3_HOSTING_PLAN.md`](POST_2.0_VST3_HOSTING_PLAN.md) §Phase 2・[`POST_2.0_GAMMA_M1_DESIGN.md`](POST_2.0_GAMMA_M1_DESIGN.md)（M1/M2 境界）
- **日付**: 2026-07-12
- **委譲**: format-neutral 決定は Opus main + owner が所有。**codex 委譲禁止**（正本 §Phase2）。設計確定後、child 側の event 適用実装は Sonnet/codex 委譲可。

---

## 0. これは何か

M1（effect の OOP host・PR #360）は完了済み。次の関門は **M2 = instrument の per-block note/param IPC を format-neutral に設計すること**。正本 §3 の唯一の plan-affecting 決定は「M2 の event/param IPC は CLAP イベント形に寄せず、CLAP/VST3/AU の宣言 surface を包含する superset として仕様化する」。本 doc はこの決定を具体化する設計案と、owner が確定すべき未決点を記録する。

**本 doc のスコープ = SPEC のみ。** 実装（`orbit-audio-sandbox` の型定義・SharedRegion 拡張・child 側の translate 層）は本 doc の owner サインオフ後に着手する。DSL 構文・VST3 instrument child 実装（Phase 3）は対象外。

---

## 1. Grounding — 3 format の event/param/note-expression surface

fresh agent（opus・一次ソース: `free-audio/clap` `events.h`/`note-ports.h`、`steinbergmedia/vst3_pluginterfaces` `ivstevents.h`/`ivstnoteexpression.h`/`ivstparameterchanges.h`、macOS SDK `AUAudioUnit.h`/`AUParameters.h`/`CoreMIDI.h`）による列挙。設計提案はさせず事実の列挙のみを依頼した。

### 1.1 横断ディメンションと欠落時の損失（要約）

| ディメンション | CLAP | VST3 | AU | wire が表現しないと失うもの |
|---|---|---|---|---|
| **voice identity（note_id）** | `note_id: i32`（note/expr/param に付与・`-1`=wildcard） | `noteId: i32`（NoteOn/Off/PolyPressure/NoteExpression） | MPE ch / MIDI2 per-note（scalar id なし） | 同一 key の重複発音の区別・per-voice expression/mod の correlation・NOTE_END による voice 解放 |
| **per-event sample offset** | `header.time: u32` | `Event.sampleOffset: i32` / `IParamValueQueue` point offset | `AUEventSampleTime: i64` per event + ramp | sub-block timing・automation カーブ精度が全 format で失われる（現状 orbit は offset=0 固定） |
| **note-expression / per-voice modulation** | `clap_event_note_expression`（7 id: vol/pan/tuning/vibrato/expr/brightness/pressure）+ param_mod(note_id) | `NoteExpressionValueEvent`（typeId 0-7 + custom 100000-200000 + Int/Text variant） | MPE + MIDI2 per-note controller（UMP） | 表情豊かなポリフォニー（per-note tuning/pressure/timbre）が host 不可能に |
| **per-voice PARAM modulation** | `param_value`/`param_mod` が note_id をターゲットにできる | 不可（global のみ、per-voice は note-expression 経由） | 不可（global のみ） | CLAP 固有の polyphonic param modulation が失われる |
| **global param automation** | `clap_event_param_value`（sample offset 付き） | `IParamValueQueue`（per-ParamID 線形補間カーブ） | `AUScheduleParameterBlock`（address+value+ramp） | DSL/automation からのプラグイン制御そのものが不可能（M1 effect でも既に必要） |
| **raw MIDI 1.0 passthrough** | `clap_event_midi` | **なし**（sysex のみ DataEvent 経由・host が型付きイベントへ翻訳する前提） | `scheduleMIDIEventBlock` / `AUMIDIEvent` | raw MIDI しか受け付けない CLAP/AU プラグインを駆動できない |
| **MIDI2/UMP（per-note ctrl・16bit velocity）** | `clap_event_midi2` | **なし** | `MIDIEventList`（`kMIDIProtocol_2_0`） | MIDI2 命令セットの拡張分解能が CLAP/AU で失われる（VST3 はそもそも経路なし） |
| **sysex** | `clap_event_midi_sysex`（可変長 buffer） | `DataEvent(kMidiSysEx)` | MIDI event 経由 | patch dump 等の設定変更を送れない |
| **note choke / note-end** | `NOTE_CHOKE`（host→plugin）/ `NOTE_END`（**plugin→host**・voice 解放） | なし（noteId lifetime 暗黙） | 全ノートオフ/per-note | drum choke group・voice leak 防止機構が失われる |
| **per-note tuning at attack** | note-expression TUNING 経由 | `NoteOnEvent.tuning: f32`（直接） | MIDI2 per-note pitch / MPE | attack 時点の microtuning が失われる |

（全項目の詳細列挙・struct フィールド定義・一次ソース citation は agent 成果物に保存済み。必要なら再取得可能。）

### 1.2 現行 orbit baseline とのギャップ

`orbit-clap-host/src/events.rs` の `PluginEvent` は現状 `NoteOn{key,channel,velocity}` / `NoteOff{key,channel,velocity}` のみ。`drain_to_event_buffer` は sample offset を常に `0` 固定、`note_id` は常に `Match::All`（wildcard）。上表の全ディメンションが未実装 — これは A0 時点の意図的な simplification（コメントに明記済み）であり、M2 が正式に埋める対象。

---

## 2. 設計原則

advisor レビューで確立した3原則。§4/§5 の設計はこれに従う。

### 原則A — wire 意味論は「今 superset」・child 側の honor は「段階的でよい」

正本 §3 が守るのは **neutral の意味論モデルの superset 完全性**であり、初版で MPE/MIDI2/note-expression を全部 *honor* することではない。両者を分離する:

- **neutral wire type = 今 superset にする**（§1.1 の全ディメンションをフィールドとして持つ）。ここを痩せさせると「VST3/AU は後から additive」「EQ-from-DSL は M2 param/CC path の消費者」という正本の前提が壊れる。wire 自体は同一 build 前提（published ABI 無し）なので variant 追加は後からでも技術的には可能だが、DSL timing・session log・translate 契約等の**周辺層がその時点の wire 形状に合わせて組まれてしまう**ため、後から足すと周辺層の作り直しを招く（§6 冒頭「判定軸」参照）。
- **child 側の適用 = 段階的でよい**。例: VST3 instrument child は初版で note-expression の custom type や per-voice param modulation（note_id ターゲット）を無視/drop してよい（VST3 base API に無い機能なので honor しようがない）。CLAP instrument child は note_id ターゲットの param_mod を正しく honor できる。**wire がフィールドを運んでいれば、child の実装能力向上だけで機能が increment し、wire format-break は不要。**

典型例: `ParamValue`/`ParamMod` に `note_id: i32`（`-1`=グローバル）を持たせる。CLAP child はこれを honor して per-voice modulation を実現できるが、VST3/AU child は `-1` 以外を無視して global 相当にフォールバックしてよい。

### 原則B — neutral wire は `orbit-audio-sandbox`（clack-free）の POD として置く

現行 `PluginEvent`（`orbit-clap-host::events`）は `clack_host::events` に依存しており、CLAP dialect 寄りの型。M2 wire 型をここから派生させると、M1 で確立した transport crate の clack-free 不変条件（`cargo tree -p orbit-audio-sandbox` に clack が出現しない）を破る。

→ **neutral wire 型は `orbit-audio-sandbox` に `#[repr(C)]` POD として新規定義する。** 各 child が自分の SDK 型（CLAP `EventBuffer` / VST3 `IEventList`+`IParameterChanges` / AU `AURenderEvent` list）へ変換する。`orbit-clap-host::PluginEvent` は現行の in-process 経路（`engine_wrap.rs` 経由の control-thread → audio-thread event ring）では今後も使われ続けるが、M2 の OOP transport 境界とは別物として扱う（収斂させるかは本 doc のスコープ外・follow-on 判断）。

### 原則C — RT-safe な固定レイアウトが transport の形を規定する

`SharedRegion` は alloc/lock 無しの固定 `#[repr(C)]`。event slot も**可変長にできない** → 「1 block あたりの最大 event 数」「固定サイズの tagged-union event record」が設計の自由選択ではなく既存 transport（M1 の `n_frames`/`seq_tag` per-slot パターン）の帰結として要求される。

**帰結（sysex の扱い）**: `clap_event_midi_sysex` / VST3 `DataEvent(kMidiSysEx)` は可変長 buffer を持つ。固定サイズ POD の event record に含めると、稀にしか使わない sysex のために全 event（NoteOn 等の高頻度小サイズ event）のサイズが最大 variant（sysex buffer 分）まで膨らむ。**推奨: sysex は per-block hot ring から分離し、低頻度の side-channel（M1 の「load-time param は child 起動引数」に類する制御プレーン拡張）で運ぶ。** ただし sysex は起動時だけでなく演奏中の patch 切替でも起こりうるため、起動引数では足りず「低頻度 message queue」が要る（詳細は §6 Q4 で owner に諮る）。

---

## 3. 提案 — neutral event wire 型（draft）

`orbit-audio-sandbox` に新規追加する想定の POD（イラストレーティブ・最終フィールド幅/命名は実装時に調整可。§6 の未決点〔特に容量・sysex 扱い〕はここでは仮置き）。

```rust
/// per-voice / per-event 共通のアドレス指定（wildcard は -1）。
#[repr(C)]
#[derive(Clone, Copy)]
pub struct VoiceAddr {
    pub note_id: i32,     // -1 = wildcard/未指定（voice 一意識別・per-voice mod のターゲット）
    pub port_index: i16,  // -1 = wildcard
    pub channel: i16,     // -1 = wildcard（0..15 = MIDI1 channel）
    pub key: i16,         // -1 = wildcard（0..127 = MIDI1 key）
}

#[repr(u8)]
#[derive(Clone, Copy)]
pub enum NeutralExpressionId {
    Volume = 0, Pan = 1, Tuning = 2, Vibrato = 3,
    Expression = 4, Brightness = 5, Pressure = 6,
    // Custom/Text/Phoneme/Int-value variant は v1 スコープ外（§3 設計判断メモ参照）。
}

#[repr(C, u8)]  // tagged union（sample_offset は全 variant 共通ヘッダとして先頭に持たせる案）
pub enum NeutralEvent {
    NoteOn   { sample_offset: u32, addr: VoiceAddr, velocity: f64, tuning_cents: f32, length_frames: i32 },
    NoteOff  { sample_offset: u32, addr: VoiceAddr, velocity: f64 },
    NoteChoke{ sample_offset: u32, addr: VoiceAddr },
    NoteEnd  { sample_offset: u32, addr: VoiceAddr },  // ⚠ plugin→host 方向（§6 Q4 で bidirectional 化を検討）
    PolyPressure { sample_offset: u32, addr: VoiceAddr, pressure: f64 },
    NoteExpression { sample_offset: u32, addr: VoiceAddr, expression_id: NeutralExpressionId, value: f64 },
    ParamValue { sample_offset: u32, param_id: u32, addr: VoiceAddr, value: f64 },   // addr.note_id != -1 なら per-voice ターゲット（CLAP のみ honor 可・原則A）
    ParamMod   { sample_offset: u32, param_id: u32, addr: VoiceAddr, amount: f64 },
    ParamGestureBegin { sample_offset: u32, param_id: u32 },
    ParamGestureEnd   { sample_offset: u32, param_id: u32 },
    MidiRaw  { sample_offset: u32, port_index: u16, data: [u8; 3] },
    Midi2    { sample_offset: u32, port_index: u16, words: [u32; 4] },  // UMP 最大128bit
    LegacyMidiCcOut { sample_offset: u32, control_number: u8, channel: i8, value: i8, value2: i8 },  // child→host 方向
    // Sysex は原則C の帰結によりこのホット ring に含めない（§6 Q4）。
}
```

**設計判断メモ（決定込み・低リスクなので owner 個別判断は不要と判断、§6 で異論があれば覆せる）**:
- `sample_offset` を全 variant が持つ（原則A の「wire は今 superset」の直接適用。CLAP/VST3/AU すべてが sample-accurate offset を持つため、ここを削ると 3 format 共通の精度が最初から失われる）。
- `VoiceAddr` の `note_id`/`port_index`/`channel`/`key` を wildcard 可能な `i16`/`i32` にし、CLAP `Pckn` 相当のアドレス指定を neutral 化。VST3 は `noteId`+`channel`+`pitch` のみ（`port_index` は `busIndex` に読み替え）、AU は cable+MPE channel で近似。
- `NoteExpression` の Custom/Text/Int-value variant（VST3 3.8.0 で追加された `kCustomStart..kCustomEnd` 100000-200000 範囲、UTF-16 text）は **v1 スコープ外**（可変長 text は固定 POD と相性が悪い・custom range はプラグイン固有で neutral 化の恩恵が薄い）。将来必要になれば別 event 種別として追加可能。
- **VST3 `ChordEvent`/`ScaleEvent`（harmonic context hint）は v1 スコープ外**（VST3 固有・稀な用途・他ディメンションと違い周辺層〔DSL timing・session log 等〕との結合が薄い自己完結 event）。将来必要になれば variant 追加のみで足りる。
- **param automation の canonical 表現 = discrete な `(sample_offset, value)` 点列**（`ParamValue`/`ParamMod` の並び）。VST3 `IParamValueQueue`（点間線形補間）・AU `rampDurationSampleFrames`（隣接点からのランプ導出）は、child 側が点列から再構成する前提。CLAP `clap_event_param_value` も同型の discrete event なので、この点列表現は 3 format の superset として capable（曲線/ランプの「表現方法」を運ぶのではなく「サンプル点」を運び、補間は child の責務）。

---

## 4. Transport 拡張（draft）

M1 の `SharedRegion`（`orbit-audio-sandbox::transport`）は現状 audio input/output slot のみ。M2 は per-slot の **event 配列**を追加する形が M1 のパターン（`n_frames`/`seq_tag` の per-slot 化）と整合する。

```rust
pub const MAX_EVENTS_PER_BLOCK: usize = /* §6 Q4 — owner 確定 */;

// SharedRegion に追加するフィールド（イラストレーティブ）
pub input_events:       [[NeutralEvent; MAX_EVENTS_PER_BLOCK]; SLOTS],  // host -> child
pub input_event_count:  [AtomicU32; SLOTS],
pub output_events:      [[NeutralEvent; MAX_EVENTS_PER_BLOCK]; SLOTS],  // child -> host（NoteEnd/LegacyMidiCcOut 等）
pub output_event_count: [AtomicU32; SLOTS],
pub event_overflow_count: AtomicU64,  // §6 Q4 の overflow policy 用 health signal（M1 の child_process_error_count に倣う）
```

- **既存の audio slot 同期（`seq_request`/`seq_done`/per-slot `seq_tag`）をそのまま event slot にも適用**（同一 slot・同一 seq で audio と event が対になる）。M1 の +1-block pipelined discipline とは整合する（event も audio と同じ 1-block 遅延を受け入れる）。
- **overflow policy**: block 内の event 数が `MAX_EVENTS_PER_BLOCK` を超えた場合の挙動（drop-oldest / drop-newest / stall）は未決（§6 Q4）。M1 の `child_process_error_count` パターンに倣い `event_overflow_count` で可視化する案を仮置き。
- **bidirectionality**: `NoteEnd`（plugin→host の voice 解放通知）・`LegacyMidiCcOut`（plugin→host の MIDI CC 出力）は child 起点のイベント。M1 の audio transport は host→child(input)/child→host(output) が対称に存在するので、event も同様に input/output を分離する案（上記）。

---

## 5. スコープ外（本 doc では扱わない）

- **DSL 構文**: VST3 hosting plan §6 のとおり non-blocking な後続判断。
- **bus arrangement honor（multi-out/sidechain）**: audio transport 側の拡張であり本 doc の event/param IPC とは直交。§6 Q5 でスコープ判断のみ諮る。
- **`orbit-clap-host::PluginEvent`（in-process 経路）を neutral wire に収斂させるか**: 収斂の要否・時期は follow-on 判断（M2 の OOP substrate 自体には影響しない）。
- **VST3/AU instrument child の実装**（Phase 3）。
- **transport/musical context（tempo/beat/tsig 同期）は明示的に defer するか wire に含めるかを §6 Q6 で決める**（サイレント除外にしない — 理由は §6 Q6 参照）。

---

## 6. 未決の owner 判断（open questions — 先取りしない）

以下は**推奨を添えるが、決定ではない**。owner サインオフを得るまで本 doc は DRAFT のまま。

**判定軸（何を今決め、何を defer してよいか）**: neutral wire は同一 build 前提（cross-process だが published ABI ではなく host/child は同一ビルド・§4.3 相当の N-slot-generic transport と同じ思想）なので、variant 追加自体は後から再コンパイルで足せる。真の論点は **wire ABI 互換性ではなく、その event が DSL timing・session log・translate 契約・daemon push API など周辺層とどれだけ結合するか**: 結合が薄い自己完結 event（例: Chord/Scale）はサイレントでない「意図的除外」の明記だけで defer 可、結合が強い event（例: sample_offset・後述の transport/musical-context）は defer すると周辺層の作り直しを招くため今決める必要がある。

### Q1 — 原則A（wire=superset・child=段階的）をこの分離軸で確定してよいか
**推奨**: はい。§2 原則A の分離（wire 意味論は今 superset・child の full honor は段階的）を採用。根拠: 痩せた wire は §3 決定を破壊するが、段階的 child 実装は「後から作り直し」を要さない。§6 の残り4問はこの原則の下での具体値・スコープ判断。

### Q2 — neutral IR 戦略: 完全に bespoke な OrbitScore-native 型（§3 draft のような）か、既存の何かをベースに拡張するか
**推奨**: §3 draft のような bespoke tagged union（1 format 依存を避ける）。CLAP 寄せは正本 §3 が明示的に戒めている。VST3 base API には note_id 付き raw MIDI/MIDI2 が無いなど、どの単一 format も superset の起点として使えない（grounding §1.1 が示す通り相互に欠落がある）。

### Q3 — per-event sample-offset-within-block を v1 で必須にするか
**推奨**: はい、必須（§3 draft は既にこれを前提）。3 format とも持つ共通ディメンションであり、かつ **DSL timing・スケジューリングと高度に結合する**（上記「判定軸」）— defer すると offset=0 前提で周辺層（event-scheduler 側の変換・session log 等）が組まれ、後から sample-accurate 化する際にそれら全てを作り直す羽目になる。ABI 互換性の問題ではなく周辺層結合の問題として今決めるべき項目。

### Q4 — transport layout の具体値・overflow policy・NoteEnd 等の bidirectional 化
- `MAX_EVENTS_PER_BLOCK` の値（推奨候補: 64 — 典型 block size 32-128 frames に対し MPE 演奏等の high density でも十分な余裕、かつ `SharedRegion` サイズ増加が許容範囲〔event record ~32-40 bytes 想定 × 64 × SLOTS(2) × in/out(2) ≈ 数十 KB〕。ただし実測ではなく見積り）。
- overflow policy（drop-oldest / drop-newest / stall）。**推奨: drop-oldest + `event_overflow_count` 可視化**（M1 の `child_process_error_count` パターンと一貫。stall は audio callback の RT 予算を脅かすため非推奨）。
- sysex を per-block hot ring から分離する場合の代替チャネル設計（原則C 参照。低頻度 message queue が要る — 具体設計は本 doc 未確定）。
- input/output event slot の bidirectional 構成（§4 案）でよいか。

### Q5 — bus arrangement honor（multi-out/sidechain）を M2 スコープに含めるか、明示 defer か
**推奨**: defer。M1 は単一 stereo sum（既知 coverage gap として記録済み・`POST_2.0_VST3_HOSTING_PLAN.md` §1）。event/param IPC と audio bus 拡張は直交する関心事であり、M2 の主眼（instrument の note/param 駆動）を先に landing させ、multi-out/sidechain は別 issue に切り出せる。

### Q6 — transport/musical context（tempo/beat/tsig 同期）を M2 の wire に含めるか、明示 defer するか
grounding が指摘した3つ目の欠落（CLAP `clap_event_transport` / VST3 `ProcessContext` / AU `AUHostMusicalContextBlock`）。**サイレント除外は不可**（Chord/Scale と異なり DSL timing・session log 等の周辺層と結合するため — 上記「判定軸」）。内蔵 arp/LFO/tempo-sync effect を持つ 3rd-party instrument はこれが無いと host tempo に追従せず free-run する。選択肢:
- **(a) wire に含める** — per-block の transport context を event とは別の構造（block header 的な固定フィールド、SharedRegion に tempo/beat/tsig を per-slot で持たせる）として今設計する。
- **(b) 明示 defer** — v1 は「内蔵テンポ同期 instrument は非対応」と明記して外す。現状 TS 側の absolute-time scheduling（`event-scheduler.ts`）が個々の note の絶対時刻を計算し尽くしているため、note/param IPC さえあれば当面の instrument 演奏は成立する（tempo-sync arp/LFO 等の特殊機能を持つ instrument だけが対象外になる）。

**推奨**: (b)（defer・doc に明記した上で）。理由: 現行 DSL は絶対時刻ベースでスケジューリングしており、tempo-sync 系機能を要する instrument は当面のユースケースに乏しい（M1 でも同種の「未使用機能は cutover bar から外す」判断〔正本 §4〕と整合）。ただし (a)/(b) いずれも owner 確定が必要（今回は defer を推奨として提示するのみ）。

---

## 7. Phase 3 受け入れ基準（draft — M2 landing の定義）

Q1-Q6 が owner サインオフ済みであることに加え、以下を M2 substrate の landing 条件とする案（advisor 検査対象）:

1. `orbit-audio-sandbox::NeutralEvent`（§3）が `#[repr(C)]` POD として定義され、`cargo tree -p orbit-audio-sandbox` に clack が出現しないこと（原則B の回帰テスト）。
2. `orbit-clap-host` 側に `PluginEvent → NeutralEvent` / `NeutralEvent → clack EventBuffer` の双方向 translate が実装され、既存の NoteOn/NoteOff 経路が sample-exact に回帰しないこと（offline test）。
3. `SharedRegion` の event slot 拡張（§4）が M1 の `host_child_integration.rs` に相当する offline 統合テストで「host submit → child consume → host read（+ NoteEnd 等の output 方向）」の round trip を証明すること（device 不要）。
4. 少なくとも1つの child が新 event 経路で **offline note-render oracle parity**（既知 event 列 → 既知波形、sample-exact）を通すこと（M1 の closed-form oracle パターンを踏襲）。
   - **これは新規 deliverable**: M1 が作った `orbit-clap-effect-child` は effect 専用であり、instrument child（CLAP 版が最有力・既存 `orbit-clap-host` の対称拡張）は現存しない。M2 landing の一部としてゼロから作る。
   - **oracle は closed-form・決定論的でなければならない**: 例）`NoteOn(key)` 受信 → smoothing 無し・既知位相で `key` の周波数の正弦波（or 矩形波）を固定振幅で出力する test-synth。M1 の gain(*0.5) oracle と同様、「それらしいが検証にならない」実プラグインではなく、host 側が出力を式で予測できるものを使う。
5. `cargo fmt`/`cargo clippy`/`cargo deny check`/`cargo test --workspace` 全緑。
6. 本 doc §6 の全 open question が「owner サインオフ済み」として記録されていること。

---

## 8. 参照

- 正本: `POST_2.0_PLUGIN_STRATEGY.html` §3（format-neutral 決定）・§9（まとめ）
- 実装計画: `POST_2.0_VST3_HOSTING_PLAN.md` §Phase 2（本 doc の親）・§1（I/O カバレッジ要件）
- M1 設計: `POST_2.0_GAMMA_M1_DESIGN.md`（M1/M2 境界・transport パターンの前例）
- 既存資産: `rust/crates/orbit-clap-host/src/events.rs`（`PluginEvent`）・`rust/crates/orbit-audio-sandbox/src/transport.rs`（`SharedRegion`）
- Issue: #398（本 doc）/ #395（親 plan）/ Epic #292
