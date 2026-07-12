# γ M2 設計 — instrument IPC substrate（format-neutral event/param）

> 🚧 **status: DRAFT — §7 受け入れ基準・PR レビュー未消化。** wire の設計方針（§2/§3・旧 Q1/Q2）・
> per-event sample offset（Q3）・transport 容量設計（Q4・§4）・bus arrangement アドレッシング（Q5）・
> transport/musical context（Q6・§4.5）は **すべて owner 確定済み（2026-07-12）**。実装の一部
> （tempo plumbing = #408・multi-bus audio transport = #409）は意図的に別 issue へ切り出し済み
> （サイレント除外ではない・追跡可能）。次は本 doc の `/simplify` → `/code:pr-review-team` 通過
> （本 doc は docs-only のため advisor 相談で軽量パスも判断対象）と、§7 の Phase 3 landing 準備。

- **Issue**: #398（本 doc）/ 親 #395（VST3 hosting plan）/ Epic #292
- **正本（決定の根拠）**: [`POST_2.0_PLUGIN_STRATEGY.html`](POST_2.0_PLUGIN_STRATEGY.html) §3（唯一の plan-affecting 決定）・[`POST_2.0_VST3_HOSTING_PLAN.md`](POST_2.0_VST3_HOSTING_PLAN.md) §Phase 2・[`POST_2.0_GAMMA_M1_DESIGN.md`](POST_2.0_GAMMA_M1_DESIGN.md)（M1/M2 境界）
- **日付**: 2026-07-12
- **委譲**: format-neutral 決定は Opus main + owner が所有。**codex 委譲禁止**（正本 §Phase2）。設計確定後、child 側の event 適用実装は Sonnet/codex 委譲可。

---

## 設計経緯（whiplash 防止のため記録・§2/§3 を読む前に一読）

本 doc は同一セッション内で **superset → thin-core → superset(named) の3段階**を経て現在の形に収束した。次セッションが同じ議論を蒸し返さないよう経緯を残す。

1. **初版 DRAFT**: fresh agent による CLAP/VST3/AU の event/param/note-expression grounding（§1）を経て、advisor の「superset 完全性」チェックに従い、3 format の全ディメンションを1つの巨大な tagged union に詰め込む案で執筆。
2. **owner が疑問提起**: 「DSL→IAC Bus MIDI のように、薄い共通層＋各プラグイン規格側で翻訳する pluggable な設計の方が、無理な共通化をしなくて済むのでは」。
3. **advisor が一旦「薄い core」案に振れる**（NoteOn/NoteOff+offset+param/CC のみ）→ **その後 advisor 自身が撤回**。理由: 正本 §3(「note+param/CCの意味論」)と正本 `VST3_HOSTING_PLAN.md` §1(「宣言された I/O+event surface を全部 honor しないと正しくホストできない」)は対立しておらず、前者は **STYLE**（CLAP の型そのままに寄せるな）、後者は **SCOPE**（機能を除外するな）という別軸の制約だった。
4. **owner が明言**: 「VST/AU/CLAP に外していい機能はない」→ SCOPE 制約の再確認。ただし owner の本来の論点は「SCOPE を満たす**手段**が pluggable であるべきでは」という③軸（コード構造）の話であり、①(意味論カバレッジ)・②(wire 型構造)と別問題と判明。
5. **Fable による一発の決定的判断**（owner 指名で起動）: 「候補A(意味論に名前をつけた統合 tagged union) を採用・候補B(規格ごとの不透明な byte payload) は不採用」。理由: host/child は同一ビルド前提なので、B の「host が型を知らない」利点は実現しない（実装すると結局 A と同じバイト列に収束し、opaque な分だけ劣化する）。**M1 との類推の訂正**: M1 の host は「完成した音声をただ運ぶだけ」だったが、M2 の host（DSL スケジューラ）は note/param イベントの**生成者**である以上、意味論からは逃げられない。逃げるべきは「format ごとの符号化」だけで、これは child 内に隔離する。「pluggable」の正しい置き場所は **wire の型ではなく、各 child の honor 段階（原則A）と child バイナリの追加**。
6. **grounding agent（並行起動）の追加事実**: 「superset にする」という文言は正本 §3 の原文には無く、8日後の派生 doc（`VST3_HOSTING_PLAN.md` §Phase2・PR #395）で追加された gloss だった。また JUCE・UAPMD 等の実在する複数規格ホストはいずれも「名前のついた薄い共通層（MIDI/UMP）＋各規格側で翻訳」を採用しており、「規格ごとに不透明な byte payload」の実例は見つからなかった（= 5 の Fable 判断と整合。JUCE/UAPMD の「薄さ」は語彙の小ささであって型の不透明さではない）。
7. **owner 確定（2026-07-12）**: Fable 判断どおり **候補A（named tagged union）採用**。MIDI2 は明示的に含める。§2/§3 を旧 Q1/Q2 として決着させ、DECIDED として記録。

**教訓**: 「format-neutral」は3つの独立した軸（①意味論カバレッジ ②wire 型構造＝named か opaque か ③コード構造＝共有か per-format か）を持つ。正本の文言は①②の一部だけを縛り、③（pluggable の置き場所）は縛っていない。次に類似の疑問が出たらこの3軸分解から始めること。

8. **Q3（sample offset）は owner 即決**（「含める」）。**Q4（transport 容量）で第2の紆余曲折**: 当初「64個/ブロック・drop-oldest」を提案 → owner が「実験的な用途で見えない天井になりかねない」と懸念 → grounding agent が JUCE(容量制限なし)・JACK MIDI(2048B/cycle・drop+count)・VST3(~2048 events/block 相当)を調査し、64 が業界水準より小さいことを裏付け → Fable が「drop-oldest は捨てられるイベントに NoteOff が含まれうるため stuck note を生む」構造的欠陥を指摘し、「上限を大きくする」でなく「溢れても失わない」設計(4096窓+backing ring lossless spillover)へ転換 → owner がさらに「本当に上限を作る形でよいか・既存 CLAP ホストの同種欠陥を今直すべきでは・アーキ全体の監査は要らないか」と3点を再度問う → 2回目の Fable 判断で「time-budget 方式は転送コピーが軽すぎて意味がなく決定論も壊すため不採用・4096+spillover のまま」「既存 in-process CLAP ring は producer が非RTスレッドなので bounded retry だけで安価に直せる→今すぐ別 issue で」「exhaustive 監査は不要・見つかった2件(既存ring+`Engine::with_scheduler`のsilent zero-fill)を issue化し再発防止は宣言原則の成文化で足りる」と確定。owner はこの「監査不要」判断についても「Fable は高コストなので、もっと安いやり方で本当に不要か検討し直せ」と再度指摘 → fresh agent(opus・低コスト)による TS層+grepパターン非依存の拡張調査を別途実施（結果は #400/#401 と合わせて記録）。

**教訓2**: 数値の妥当性（「64は十分か」）を検討する前に、**「溢れた時に何を失うか」の質**（drop-oldest が stuck note を生む等）を先に検討すべきだった。また「決定的な一発判断」が必要な論点（wire構造・容量アーキテクチャ）と「網羅的な接地確認」が必要な論点（既存コードに同種欠陥が他にないか）は異なる mechanism を使うべきで、後者を high-cost な Fable で行うのはコスト対効果が悪い（fresh general-purpose agent で足りる）。

9. **Q5/Q6 で owner が「今見送るとあとで負債になる」と明確に反論**（2026-07-12）:
   - **Q6（transport/musical context）**: owner 「エンジン自体がテンポ情報を持っており、seq ごとにも送れる。活用ケースは必ずあるので見送る意味が全くわからない」。grounding で確認したところ、実際には `orbit-audio-core::Engine`/`Scheduler` に読み出し可能な live tempo state は無く（`engine_wrap::set_link_tempo` は Ableton Link セッションへの一方通行 push のみで、TS 側 `DaemonPlayParams` にも per-seq tempo フィールドは無い）。事実前提には訂正が要ったが、advisor は「事実の訂正は owner の priority 判断（『必ず使う』）そのものを覆さない」と整理し、**選択肢(a)（wire に含める）を採用**。「wire に transport-context header を今置く」ことと「tempo 値を Engine に実際に供給する仕組み（DSL→engine plumbing）」を2段階に分離し、後者は **#408 で追跡**（owner: 「追跡可能にしておいて」）。
   - **Q5（bus arrangement）**: owner 「後からミキサー実装を変更する時にどのみち払うコストなら、プラグイン側インターフェースの定義は今決めておいた方が後の修正が楽になるのでは」。grounding で `POST_2.0_MIXER_DSL_DESIGN.html`（Issue #337 のディスカッション記録）を発見し、**DSL 層では sidechain 入力が既に「スコープ in」と決定済み**であることを確認（§6/§11 決定台帳）。ただし advisor は「audio 実装コストが実装時点で同じという前提は、同一ビルド前提（published ABI 無し）では誇張。実装 defer は実際に安い」と指摘し、**実装の前倒しではなく「アドレッシング・インターフェースは doc に明記・audio 実装は引き続き defer」の分離**を提案。owner はこの分離（「インターフェース層と分けて考えるの大事」）に同意。実装は **#409 で追跡**。
   - **教訓3**: 「見送ると負債になるか」という owner の懸念の核は「実装を今やること」ではなく「defer が サイレントな忘却になること」だった。doc に明記し issue 化して追跡可能にすれば、実装の即時前倒しをせずに解消できる場合がある。M2 と同じ「wire/インターフェースは今・実装の一部は段階的」という原則Aの型が、event の意味論だけでなく block-level context（Q6）・audio bus（Q5）にも一貫して適用できた。

---

## 0. これは何か

M1（effect の OOP host・PR #360）は完了済み。次の関門は **M2 = instrument の per-block note/param IPC を format-neutral に設計すること**。正本 §3 の唯一の plan-affecting 決定は「M2 の event/param IPC は CLAP イベント形に寄せず、CLAP/VST3/AU の宣言 surface を包含する superset として仕様化する」。本 doc はこの決定を具体化する設計案と、owner が確定すべき残りの未決点を記録する。

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
| **MIDI2/UMP（per-note ctrl・16bit velocity）** | `clap_event_midi2` | **なし** | `MIDIEventList`（`kMIDIProtocol_2_0`） | MIDI2 命令セットの拡張分解能が CLAP/AU で失われる（VST3 はそもそも経路なし）。**owner 明示: 対応必須** |
| **sysex** | `clap_event_midi_sysex`（可変長 buffer） | `DataEvent(kMidiSysEx)` | MIDI event 経由 | patch dump 等の設定変更を送れない |
| **note choke / note-end** | `NOTE_CHOKE`（host→plugin）/ `NOTE_END`（**plugin→host**・voice 解放） | なし（noteId lifetime 暗黙） | 全ノートオフ/per-note | drum choke group・voice leak 防止機構が失われる |
| **per-note tuning at attack** | note-expression TUNING 経由 | `NoteOnEvent.tuning: f32`（直接） | MIDI2 per-note pitch / MPE | attack 時点の microtuning が失われる |

（全項目の詳細列挙・struct フィールド定義・一次ソース citation は agent 成果物に保存済み。必要なら再取得可能。）

### 1.2 現行 orbit baseline とのギャップ

`orbit-clap-host/src/events.rs` の `PluginEvent` は現状 `NoteOn{key,channel,velocity}` / `NoteOff{key,channel,velocity}` のみ。`drain_to_event_buffer` は sample offset を常に `0` 固定、`note_id` は常に `Match::All`（wildcard）。上表の全ディメンションが未実装 — これは A0 時点の意図的な simplification（コメントに明記済み）であり、M2 が正式に埋める対象。

---

## 2. 設計原則（Q1/Q2 相当・owner 確定済み・DECIDED）

advisor + Fable のレビューを経て確定した3原則。§3/§4 の設計はこれに従う。**旧 Q1「wire=superset・child=段階的」・旧 Q2「neutral IR 戦略」はここで決着し、以後は open question として扱わない。**

### 原則A — wire 意味論は「今 named superset」・child 側の honor は「段階的でよい」【DECIDED】

正本 §3(STYLE) と `VST3_HOSTING_PLAN.md` §1(SCOPE) は対立しない別軸の制約であり、両方を同時に満たす:

- **neutral wire type = 今 superset にする**（§1.1 の全ディメンションを named variant として持つ。MIDI2 含む）。ここを痩せさせると「VST3/AU は後から additive」という正本の前提や、`VST3_HOSTING_PLAN.md` §1 の「宣言された I/O+event surface を全部 honor しないと正しくホストできない」という correctness 要件が壊れる。wire 自体は同一 build 前提（published ABI 無し）なので variant 追加は後からでも技術的には可能だが、DSL timing・session log・translate 契約等の**周辺層がその時点の wire 形状に合わせて組まれてしまう**ため、後から足すと周辺層の作り直しを招く（§6 冒頭「判定軸」参照）。
- **child 側の適用 = 段階的でよい**。例: VST3 instrument child は初版で note-expression の custom type や per-voice param modulation（note_id ターゲット）を無視/drop してよい（VST3 base API に無い機能なので honor しようがない・honor できない場合は **global fallback ではなく drop + counter で可視化**。per-voice 変調を誤って global 適用すると音が壊れるため、M1 の silent-failure 防止文化と整合させる）。CLAP instrument child は note_id ターゲットの param_mod を正しく honor できる。**wire がフィールドを運んでいれば、child の実装能力向上だけで機能が increment し、wire の作り直しは不要。**
- **「pluggable」の正しい置き場所はここ**（child の honor 段階 + child バイナリの追加）であり、wire の型を薄める/不透明にすることではない（下記 原則D 参照）。

典型例: `ParamValue`/`ParamMod` に `note_id`（`-1`=グローバル）を持たせる。CLAP child はこれを honor して per-voice modulation を実現できるが、VST3/AU child は `-1` 以外を drop して counter に記録してよい。

### 原則B — neutral wire は `orbit-audio-sandbox`（clack-free）の POD として置く【DECIDED】

現行 `PluginEvent`（`orbit-clap-host::events`）は `clack_host::events` に依存しており、CLAP dialect 寄りの型。M2 wire 型をここから派生させると、M1 で確立した transport crate の clack-free 不変条件（`cargo tree -p orbit-audio-sandbox` に clack が出現しない）を破る。

→ **neutral wire 型は `orbit-audio-sandbox` に `#[repr(C)]` POD として新規定義する。** 各 child が自分の SDK 型（CLAP `EventBuffer` / VST3 `IEventList`+`IParameterChanges` / AU `AURenderEvent` list）へ変換する。`orbit-clap-host::PluginEvent` は現行の in-process 経路（`engine_wrap.rs` 経由の control-thread → audio-thread event ring）では今後も使われ続けるが、M2 の OOP transport 境界とは別物として扱う（収斂させるかは本 doc のスコープ外・follow-on 判断）。

### 原則C — RT-safe な固定レイアウトが transport の形を規定する【DECIDED】

`SharedRegion` は alloc/lock 無しの固定 `#[repr(C)]`。event slot も**可変長にできない** → 「1 block あたりの最大 event 数」「固定サイズの POD event record」が設計の自由選択ではなく既存 transport（M1 の `n_frames`/`seq_tag` per-slot パターン）の帰結として要求される。

**帰結（sysex の扱い）**: `clap_event_midi_sysex` / VST3 `DataEvent(kMidiSysEx)` は可変長 buffer を持つ。固定サイズ POD の event record に含めると、稀にしか使わない sysex のために全 event（NoteOn 等の高頻度小サイズ event）のサイズが最大 variant（sysex buffer 分）まで膨らむ。**推奨: sysex は per-block hot ring から分離し、低頻度の side-channel（M1 の「load-time param は child 起動引数」に類する制御プレーン拡張）で運ぶ。** ただし sysex は起動時だけでなく演奏中の patch 切替でも起こりうるため、起動引数では足りず「低頻度 message queue」が要る（詳細は §6 Q4 で owner に諮る）。

### 原則D — wire は named POD union（候補A）。format ごとの opaque payload（候補B）は不採用【DECIDED・Fable 一発判断】

- **候補A（採用）**: `orbit-audio-sandbox` に、意味論に名前のついた POD union（`NoteBody`/`ExprBody`/`ParamBody`/`Midi2Body` 等）+ `kind` タグを定義する。全 format 共通のワイヤ。
- **候補B（不採用）**: `{ format_tag, opaque_payload: [u8; N] }` のように、payload の中身を各 format の encoder/decoder だけが知る不透明な bytes にする。
- **不採用の理由**（Fable 判断・§0 経緯5 参照）: host/child は同一ビルド前提なので、B の「host が型を知らない」利点は成立しない。実装すると encoder/decoder のレイアウト一致をコンパイラに検査させるため、結局 payload 型を共有 crate に置く必要が生じ、**A の再発明**に堕ちる。しかも「特定 format 向けの不透明 bytes」を wire に流す行為自体が、正本 §3「CLAP イベント形に寄せない」という STYLE 制約に反する方向に働く（wire に format 固有の形が透けて見える）。
- **M1 との類推の訂正**: M1 の host（daemon）は「完成した音声を右から左に流すだけ」の dumb pipe だった。M2 の host（DSL スケジューラ）は note/param イベントの**生成者**であり、音楽的な意味論から逃げられない。M1 の「host は format を知らない」を正しく一般化すると「host は自分のドメイン（音楽イベントの意味論）を知り、format ごとの符号化だけを child に隔離する」であり、これは候補Aそのもの。
- **「pluggable」は原則Aの child 側 honor 段階 + child バイナリの追加で実現する**（詳細は §0 経緯参照）。

---

## 3. neutral event wire 型（DECIDED 設計・Fable 提案の安全な型）

`orbit-audio-sandbox` に新規追加する型。**重要な安全性上の制約**: `#[repr(C, u8)]` の Rust enum を共有メモリから直接 transmute で読んではいけない。クラッシュした child が output 側に不正な discriminant を残す可能性があり、それを enum として解釈すると未定義動作になる（M1 の unsafe 監査文化・PR #397 と整合させる）。そのため wire 表現は「`kind` タグ + POD union」の struct にし、`kind` を検証してから union を読む `decode()` を挟む。

```rust
/// per-voice / per-event 共通アドレス（wildcard = -1）。
#[repr(C)]
#[derive(Clone, Copy)]
pub struct VoiceAddr {
    pub note_id: i32,     // -1 = wildcard（voice 一意識別・per-voice mod のターゲット）
    pub port_index: i16,  // -1 = wildcard（VST3 は busIndex に読み替え）
    pub channel: i16,     // -1 = wildcard（0..15 = MIDI1 channel）
    pub key: i16,          // -1 = wildcard（0..127 = MIDI1 key）
    pub _pad: i16,
}

// ── kind タグの値（イラストレーティブ。実装時に定数 or #[repr(u32)] enum で確定）──
// NOTE_ON=0 / NOTE_OFF=1 / NOTE_CHOKE=2 / NOTE_END=3 / POLY_PRESSURE=4 /
// NOTE_EXPRESSION=5 / PARAM_VALUE=6 / PARAM_MOD=7 / PARAM_GESTURE_BEGIN=8 /
// PARAM_GESTURE_END=9 / MIDI_RAW=10 / MIDI2=11 / LEGACY_MIDI_CC_OUT=12

#[repr(C)] #[derive(Clone, Copy)]
pub struct NoteBody  { pub addr: VoiceAddr, pub velocity: f64, pub tuning_cents: f32, pub length_frames: i32 } // NoteOn/NoteOff 共用（NoteOff は tuning/length 未使用）
#[repr(C)] #[derive(Clone, Copy)]
pub struct AddrBody  { pub addr: VoiceAddr } // NoteChoke/NoteEnd（addr だけで足りる）
#[repr(C)] #[derive(Clone, Copy)]
pub struct ExprBody  { pub addr: VoiceAddr, pub value: f64, pub expression_id: u32, pub _pad: u32 } // NoteExpression/PolyPressure 共用（expression_id で区別）
#[repr(C)] #[derive(Clone, Copy)]
pub struct ParamBody { pub addr: VoiceAddr, pub value: f64, pub param_id: u32, pub _pad: u32 } // ParamValue/ParamMod 共用（addr.note_id!=-1 なら per-voice ターゲット・原則A）
#[repr(C)] #[derive(Clone, Copy)]
pub struct GestureBody { pub param_id: u32 } // ParamGestureBegin/End
#[repr(C)] #[derive(Clone, Copy)]
pub struct MidiBody  { pub data: [u8; 3], pub _pad: u8, pub port_index: u16, pub _pad2: u16 } // MidiRaw
#[repr(C)] #[derive(Clone, Copy)]
pub struct Midi2Body { pub words: [u32; 4], pub port_index: u16, pub _pad: u16 } // UMP 最大128bit・owner 明示で必須
#[repr(C)] #[derive(Clone, Copy)]
pub struct CcOutBody { pub control_number: u8, pub channel: i8, pub value: i8, pub value2: i8, pub port_index: u16, pub _pad: u16 } // LegacyMidiCcOut（child→host）

/// ワイヤ payload。全フィールドが POD（全ビットパターン valid）なので、
/// kind 検証後の union 読みは健全（未検証の enum transmute はしない）。
#[repr(C)]
#[derive(Clone, Copy)]
pub union EventPayload {
    pub note: NoteBody,
    pub addr_only: AddrBody,
    pub expr: ExprBody,
    pub param: ParamBody,
    pub gesture: GestureBody,
    pub midi: MidiBody,
    pub midi2: Midi2Body,
    pub cc_out: CcOutBody,
    raw: [u8; 24], // 最大 variant に合わせて調整（実装時に確定）
}

/// 共有メモリ上の1 event record（固定長 POD）。
/// ⚠ これを Rust enum として直接 transmute しない。必ず decode() を通す。
#[repr(C)]
#[derive(Clone, Copy)]
pub struct EventRecord {
    pub kind: u32,          // 上記 kind タグの生値。未知値は decode() が None を返す（UB にしない）
    pub sample_offset: u32, // block 内オフセット（全 kind 共通ヘッダ・§6 Q3 で必須と確定）
    pub payload: EventPayload,
}

/// host/child のロジック層が使う ergonomic な enum（shm には直接置かない）。
pub enum NeutralEvent {
    NoteOn { sample_offset: u32, addr: VoiceAddr, velocity: f64, tuning_cents: f32, length_frames: i32 },
    NoteOff { sample_offset: u32, addr: VoiceAddr, velocity: f64 },
    NoteChoke { sample_offset: u32, addr: VoiceAddr },
    NoteEnd { sample_offset: u32, addr: VoiceAddr },       // ⚠ child→host 方向
    PolyPressure { sample_offset: u32, addr: VoiceAddr, pressure: f64 },
    NoteExpression { sample_offset: u32, addr: VoiceAddr, expression_id: NeutralExpressionId, value: f64 },
    ParamValue { sample_offset: u32, param_id: u32, addr: VoiceAddr, value: f64 },
    ParamMod { sample_offset: u32, param_id: u32, addr: VoiceAddr, amount: f64 },
    ParamGestureBegin { sample_offset: u32, param_id: u32 },
    ParamGestureEnd { sample_offset: u32, param_id: u32 },
    MidiRaw { sample_offset: u32, port_index: u16, data: [u8; 3] },
    Midi2 { sample_offset: u32, port_index: u16, words: [u32; 4] },      // owner 明示で必須
    LegacyMidiCcOut { sample_offset: u32, control_number: u8, channel: i8, value: i8, value2: i8 }, // ⚠ child→host 方向
    // Sysex は原則C の帰結によりこのホット ring に含めない（§6 Q4）。
}

#[repr(u8)]
#[derive(Clone, Copy)]
pub enum NeutralExpressionId {
    Volume = 0, Pan = 1, Tuning = 2, Vibrato = 3,
    Expression = 4, Brightness = 5, Pressure = 6,
    // Custom/Text/Phoneme/Int-value variant は v1 スコープ外（下記メモ参照）。
}

impl EventRecord {
    /// kind を検証して union の該当 body だけを読む。未知 kind は None
    /// （呼び出し側が `event_decode_error_count` を進める — `child_process_error_count` と同パターン）。
    pub fn decode(&self) -> Option<NeutralEvent> { /* match self.kind { ... } */ todo!() }
    /// 逆変換（host 側の DSL イベント生成 / child 側の応答生成で使用）。
    pub fn encode(ev: &NeutralEvent) -> EventRecord { todo!() }
}
```

**設計判断メモ**:
- `sample_offset` を `EventRecord` の共通ヘッダとして持つ（原則A の「wire は今 superset」の直接適用。CLAP/VST3/AU すべてが sample-accurate offset を持つため、ここを削ると 3 format 共通の精度が最初から失われる。§6 Q3 で必須と確定）。
- `VoiceAddr` の `note_id`/`port_index`/`channel`/`key` を wildcard 可能な `i16`/`i32` にし、CLAP `Pckn` 相当のアドレス指定を neutral 化。VST3 は `noteId`+`channel`+`pitch` のみ（`port_index` は `busIndex` に読み替え）、AU は cable+MPE channel で近似。
- **MIDI2/UMP（`Midi2Body`/`Midi2` variant）は owner 明示により必須**（CLAP・AU の2規格が直接サポート・16bit 分解能や per-note 制御など表現力に直結）。VST3 はそもそも MIDI2 経路が無いため honor できないが、原則A どおり VST3 child は単に drop してよい。
- `NoteExpression` の Custom/Text/Int-value variant（VST3 3.8.0 で追加された `kCustomStart..kCustomEnd` 100000-200000 範囲、UTF-16 text）は **v1 スコープ外**（可変長 text は固定 POD と相性が悪い・custom range はプラグイン固有で neutral 化の恩恵が薄い）。将来必要になれば named variant を追加可能（同一ビルド前提なので再コンパイルのみで足りる・原則A の帰結）。
- **VST3 `ChordEvent`/`ScaleEvent`（harmonic context hint）は v1 スコープ外**（VST3 固有・稀な用途）。数値部（root/bassNote/mask）は将来 named variant で追加でき、可変長 text 部は sysex 同様 side-channel 行き。
- **param automation の canonical 表現 = discrete な `(sample_offset, value)` 点列**（`ParamValue`/`ParamMod` の並び）。VST3 `IParamValueQueue`（点間線形補間）・AU `rampDurationSampleFrames`（隣接点からのランプ導出）は、child 側が点列から再構成する前提。CLAP `clap_event_param_value` も同型の discrete event なので、この点列表現は 3 format の superset として capable。
- per-voice ターゲット（`addr.note_id != -1`）を honor できない child（VST3/AU の `ParamMod`）は、**global fallback ではなく drop + `event_decode_error_count`（または専用 counter）で可視化**することを推奨（原則A・M1 の silent-failure 防止文化）。

---

## 4. Transport 拡張（DECIDED・容量設計は Fable 判断で確定）

M1 の `SharedRegion`（`orbit-audio-sandbox::transport`）は現状 audio input/output slot のみ。M2 は per-slot の **event 配列**を追加する形が M1 のパターン（`n_frames`/`seq_tag` の per-slot 化）と整合する。

### 4.1 容量設計の原則（owner + Fable 確定・2026-07-12）

当初「1ブロックあたり64個・溢れたら古いイベントを捨てる」という仮案を検討したが、owner から「実験的な用途で見えない天井になりかねない」という懸念が出され、Fable のレビューで**仮案は2つの点で不適格**と判明した:

1. **64 は既存の設計エンベロープ内でも不足しうる**（`MAX_FRAMES=4096` の大バッファ時は1ブロック約93msに達し、64 events/block は持続 ~690 events/sec 相当 — 中規模なアルゴリズミックパターンで普通に到達する）。
2. **drop-oldest は音楽的に最悪**: 捨てられる最古イベントに `NoteOff` が含まれうるため、stuck note（音が鳴りっぱなしで止まらない）という最悪の故障を生む。

**確定した設計思想 = 「上限を大きくする」のではなく「溢れても失わない」**。「時間予算で区切る(天井を無くす)」案も検討したが、Fable が却下した（transport が固定レイアウトの `#[repr(C)]` mmap である以上どこかに必ず bound は残る／転送コピー自体は極めて軽い(数µs)ためRT予算では時間は希少資源にならない／時計で区切ると同一演奏が run ごとに異なるブロックへ event を配ることになり、このプロジェクトの検証文化(sample-exact closed-form oracle parity・`.orbslog` 決定論的再現)と衝突する）。真に物理的な制約(共有メモリのレイアウト・メモリ容量)にのみ従う設計として、count-bound + lossless spillover を採用する。

### 4.2 二段構造（per-block 転送窓 + 背後のバッキングring）

既存の in-process 経路（制御スレッド → rtrb SPSC ring → RT callback が最大 N 個だけ pop して EventBuffer へ drain）を OOP 版に鏡映しする:

```rust
/// 1ブロックあたりの転送窓（= shm 上の EventRecord 配列サイズ）。
/// 根拠 = 統計的典型性でなく「アーキテクチャ飽和点」: MAX_FRAMES と揃え、
/// 「1 sample あたり1 event」を持続転送できる水準にする。これを超える密度は
/// 個別イベントでなく audio-rate 変調が正しい表現媒体であり、"天井" ではなく
/// 表現媒体の境界になる。
pub const MAX_EVENTS_PER_BLOCK: usize = 4096; // = MAX_FRAMES

// SharedRegion に追加するフィールド（イラストレーティブ）
pub input_events:        [[EventRecord; MAX_EVENTS_PER_BLOCK]; SLOTS],  // host -> child（per-block 転送窓）
pub input_event_count:   [AtomicU32; SLOTS],
pub output_events:       [[EventRecord; MAX_EVENTS_PER_BLOCK]; SLOTS],  // child -> host（NoteEnd/LegacyMidiCcOut 等）
pub output_event_count:  [AtomicU32; SLOTS],
pub event_dropped_count:  AtomicU64,  // 真の喪失（backing ring 自体が尽きた場合のみ・health signal）
pub event_spilled_count:  AtomicU64,  // 無損失の1ブロック超遅延（情報用・health signal）
pub event_decode_error_count: AtomicU64,  // decode() が未知 kind を skip した回数（validated decode の可視化）
```

- **backing ring**（host 側・control スレッドが producer）は shm 外の通常メモリで確保する大きめの ring（目安 65,536 slot ≈ 4MB・起動時確保）。RT callback は毎ブロック、この ring から**最大 `MAX_EVENTS_PER_BLOCK` 個だけ pop**して `input_events` へ書く。**窓に載りきらない残りは ring に残し、次ブロック以降で配送する**（＝ overflow の帰結が「データ喪失」ではなく「最大 1 ブロック(64f で約1.45ms)の遅延」になる）。pop 数を減らすだけなので alloc/lock なし・RT-safe。
- **真の drop が起きるのは backing ring 自体が尽きた場合のみ**（drain レート ≈ 4096 events/block @64f ≈ 秒間280万イベント相当なので、実質 producer 側のバグ以外では発生しない）。その場合は **drop-newest**（drop-oldest は §4.1 の理由により不採用）。**`NoteOff` 等の note 状態変更イベントはサイレント drop 禁止**: 捨てざるを得ない場合は sticky flag を立て、次ブロックで note-choke/all-notes-off を側路から注入し、stuck note を構造的に排除する。
- **spill された event の `sample_offset` 再タイミング規約（実装時に曖昧にしないこと）**: 配送が後続ブロックにずれた event の `sample_offset` は、配送先ブロックの先頭（0）にクランプする。元ブロック内での相対位置は保持しない。これは既存 in-process 経路が A0 §4.2 で採用済みの簡略化（全イベントを block 先頭オフセットに置く）と同じ粒度であり、新たな精度劣化ではない。
- **可視化は音を変えない**: `event_dropped_count`（真の喪失）と `event_spilled_count`（無損失遅延・情報）を分離し、`child_process_error_count` と同型の health signal パターンで 1Hz ticker（`OUTPROC_EFFECT_*` 相当）→ TS 層 → OrbitStudio のステータス表示へ配線する。**演奏・録音の音そのものを変える通知（警告音等）は禁止**（報せる対象の故障より害が大きいため）。
- **既存の audio slot 同期（`seq_request`/`seq_done`/per-slot `seq_tag`）をそのまま event slot にも適用**（同一 slot・同一 seq で audio と event が対になる）。M1 の +1-block pipelined discipline とは整合する。`input_event_count`/`output_event_count` は `n_frames` と同じ「Relaxed store → Release publish で可視」規律に従う。
- **bidirectionality**: `NoteEnd`（plugin→host の voice 解放通知）・`LegacyMidiCcOut`（plugin→host の MIDI CC 出力）は child 起点のイベント。M1 の audio transport は host→child(input)/child→host(output) が対称に存在するので、event も同様に input/output を分離する（上記）。
- **サイズ見積り**: `EventRecord` ≈ 32 bytes。`MAX_EVENTS_PER_BLOCK=4096` なら 32B × 4096 × `SLOTS`(2) × 2方向 ≈ 512 KB 追加（現行 audio 領域 ~128 KB に対し増分は無視できる規模。count-prefix 配列なので未使用容量のコピーコストはゼロ）。
- **crate 配置**: `EventRecord`/`EventPayload`/`NeutralEvent`/`decode`/`encode` はすべて `orbit-audio-sandbox` に置き、clack-free 回帰テストの対象に含める（`cargo tree -p orbit-audio-sandbox` に clack・vst3 系 crate が一切出現しないことを維持）。各 child は `orbit-audio-sandbox` + 自 SDK crate に依存し、`NeutralEvent → SDK 型` の翻訳を child 内に完全隔離する。
- **受け入れ信号**（§7 に統合）: gated stress test — @32f で 10K ノート同時バースト + 持続 100K events/sec を流し、`event_dropped_count == 0` を assert。

### 4.3 新規 bounded queue 宣言原則（再発防止・M2 が初適用）

Fable の拡張調査で、同種の欠陥（固定容量 + 統計的典型性の前提 + silent 劣化）が2箇所（既存 in-process CLAP ring・`Engine::with_scheduler` の lock 競合時 silent zero-fill）で見つかった（詳細は #400・#401）。exhaustive な監査を毎回行うのは高コストなので、再発防止は**新しい bounded 構造を導入する際の宣言原則**として成文化する:

> 固定容量の queue/buffer/ring を新規導入する変更は、doc comment で次の3点を明記しなければならない: **(a)** producer のスレッド種別（RT か非RTか） **(b)** overflow policy（lossless か、drop するなら note-off 級の状態依存 event を保護する方法） **(c)** 可視化 counter の有無。

M2 の `input_events`/`output_events`/backing ring がこの原則の初適用例（上記 §4.2 が (a)(b)(c) を明記済み）。

### 4.4 既存コードの同種欠陥（M2 とは別スコープ・issue 化済み）

M2 の容量設計を検討する過程で、同じ欠陥パターンが**既存の出荷済みコード**にも存在することが判明した。M2 の設計・実装はブロックしないが、独立した修正として着手する:

- **#400**: in-process CLAP event ring（`orbit-audio-daemon/src/engine_wrap.rs` の `push_plugin_event`）— 満杯時 drop-newest だが可視化カウンタなし・producer が RT スレッドでないため bounded retry だけで lossless 化できる。
- **#401**: `Engine::with_scheduler` の try_lock 経路（`orbit-audio-core/src/engine.rs`）— lock 競合時に1ブロック無音化するが可視化なし。lock-free 化は別途 defer 済みの判断を維持し、contention counter のみ追加。

### 4.5 Transport/musical context（tempo/beat/tsig）— DECIDED（§6 Q6・owner 確定 2026-07-12）

grounding で確認した欠落（CLAP `clap_event_transport` / VST3 `ProcessContext` / AU `AUHostMusicalContextBlock`）を wire に含める。**event ではなく per-slot・per-block の header**として持たせる（3 format とも process 呼び出し単位で消費する block-level metadata であり、event ストリームに混ぜると submit protocol の形自体を汚すため）。原則Aと同じ「今 superset・child の honor は段階的でよい」だが、**単位が event でなく block である点**が §3 の `EventRecord` と異なる。

```rust
/// per-block の演奏文脈（event ではなく block header）。CLAP/VST3/AU が
/// process 呼び出しのたびに共通して消費する transport metadata の superset。
#[repr(C)]
#[derive(Clone, Copy)]
pub struct TransportContext {
    pub tempo_bpm: f64,            // 0.0 = 未供給（#408 の plumbing 完了までは 0.0 になりうる）
    pub time_sig_numerator: u16,
    pub time_sig_denominator: u16,
    pub is_playing: u8,            // POD union の安全性規約（§3）に合わせ bool でなく u8
    pub is_looping: u8,
    pub song_position_beats: f64,  // 直近 block 先頭の楽曲内位置（拍単位・四分音符=1.0・CLAP song_pos_beats/VST3 projectTimeMusic 相当）
}

// SharedRegion に追加するフィールド（イラストレーティブ）
pub transport_context: [TransportContext; SLOTS],  // host -> child のみ（child からの逆方向は無い）
```

**設計判断メモ**:
- **`tempo_bpm=0.0` は「未供給」の sentinel**（0 BPM は演奏上意味を持たないため衝突しない）。tempo-sync 機能を持つ child は 0.0 を「host からテンポ供給なし」と解釈し、自走（free-run）してよい — 原則Aの「honor できない/データが無ければ drop/フォールバックしてよい」規約と同型。**#408（plumbing）が完了するまでは常に 0.0 になりうる**ことを正直に記録する（サイレントに「動いているように見える」ことを避ける）。
- **loop cycle 点（VST3 `cycleStartMusic`/`cycleEndMusic`・CLAP `loop_start_beats`/`loop_end_beats`）は v1 スコープ外**（Custom note-expression variant・ChordEvent と同様の理由：稀な用途・同一ビルド前提で後から named field 追加可能）。
- **`SLOTS` 単位で持つ理由は §4.2 の `n_frames`/`seq_tag` と同じ**: 各 child が自分のペースでスロットを消費するため、消費時点で有効だった transport 値を保証するには per-slot 保持が必要（単一グローバル値だと、遅れて消費した child が「未来」の値を読んでしまう可能性がある）。
- child 側の honor は原則Aどおり段階的でよい: CLAP child は `clap_event_transport` へ、VST3 child は `ProcessContext` へ、AU child は musical-context callback の戻り値へ翻訳する。翻訳できないフィールド（例: VST3 の `continousTimeSamples` 等 host 固有拡張）は child 内で妥当なデフォルトを補う。

---

## 5. スコープ外（本 doc では扱わない）

- **DSL 構文**: VST3 hosting plan §6 のとおり non-blocking な後続判断。
- **bus arrangement honor（multi-out/sidechain）の実装**: audio transport 側（`SharedRegion` の audio 配列）の拡張であり本 doc の event/param IPC とは直交。アドレッシング・インターフェースの決定は §6 Q5 で確定済みだが、実装自体は **#409** に切り出し（DECIDED・スコープ外のまま）。
- **`orbit-clap-host::PluginEvent`（in-process 経路）を neutral wire に収斂させるか**: 収斂の要否・時期は follow-on 判断（M2 の OOP substrate 自体には影響しない）。
- **VST3/AU instrument child の実装**（Phase 3）。
- **transport/musical context（tempo/beat/tsig）の実データ供給**: wire への header 追加は §6 Q6・§4.5 で DECIDED（M2 スコープ内）。Engine への live tempo state plumbing（DSL→engine）は **#408** に切り出し（M2 本体をブロックしない）。
- **sysex / 可変長 note-expression text / Chord-Scale の text 部の低頻度 side-channel 設計**: 原則C で存在の必要性は確定したが、具体設計（メッセージ形式等）は実装時に詰める。

---

## 6. owner 判断（Q1-Q6 すべて DECIDED・2026-07-12）

旧 Q1/Q2（wire の設計方針）は §2/§3 で **DECIDED** 済み。**Q3-Q6 も本節下記のとおり全て DECIDED**（owner 確定 2026-07-12）。open question は残っていない。次は §7 の Phase 3 landing 準備と、本 doc 自体の `/simplify` → `/code:pr-review-team` 通過。

**判定軸（何を今決め、何を defer してよいか）**: neutral wire は同一 build 前提（cross-process だが published ABI ではなく host/child は同一ビルド）なので、named variant の追加自体は後から再コンパイルで足せる。真の論点は **wire ABI 互換性ではなく、その event が DSL timing・session log・translate 契約・daemon push API など周辺層とどれだけ結合するか**: 結合が薄い自己完結 event（例: Chord/Scale の数値部）はサイレントでない「意図的除外」の明記だけで defer 可、結合が強い次元（例: sample_offset・transport/musical-context）は defer すると周辺層の作り直しを招くため今決める必要がある。

### Q3 — per-event sample-offset-within-block を v1 で必須にするか【DECIDED（owner 確定）】
**確定: はい、必須**（§3 は既にこれを前提）。3 format とも持つ共通ディメンションであり、かつ **DSL timing・スケジューリングと高度に結合する**（上記「判定軸」）— defer すると offset=0 前提で周辺層（event-scheduler 側の変換・session log 等）が組まれ、後から sample-accurate 化する際にそれら全てを作り直す羽目になる。

### Q4 — transport layout の具体値・overflow policy・side-channel 設計【DECIDED（owner + Fable 確定）】
**確定内容は §4 参照**（`MAX_EVENTS_PER_BLOCK=4096` + backing ring による lossless spillover + drop-newest は backing ring 枯渇時のみ + note-off サイレント drop 禁止 + `event_dropped_count`/`event_spilled_count` の非音響可視化）。当初案「64個・drop-oldest」は owner の「実験的用途で見えない天井になる」懸念 → Fable レビューで不適格と判明 → 「上限を大きくする」でなく「溢れても失わない」設計へ転換した経緯は §4.1 参照。sysex・可変長 note-expression text・Chord/Scale text 部の低頻度 side-channel は**存在の必要性のみ確定・具体設計は実装時に詰める**（原則C）。input/output event slot の bidirectional 構成は §4.2 のとおり確定。

### Q5 — bus arrangement honor（multi-out/sidechain）を M2 スコープに含めるか【DECIDED（owner + advisor 確定）】
**確定: インターフェース（アドレッシングの考え方）は今決める・audio transport の実装は defer**（実装先送り自体は #409 で追跡・サイレント除外にしない）。

owner の懸念（「後からミキサー実装を変更する時にどのみち払うコストなら、プラグイン側インターフェースは今決めておいた方が後の修正が楽」）を受け、grounding で `POST_2.0_MIXER_DSL_DESIGN.html`（Issue #337）を確認したところ、**DSL 層では sidechain 入力（aux 入力ポート）が既に「スコープ in」と決定済み**（§6/§11 決定台帳）。ただし advisor 検査により「audio 実装コストが今も後も同じ」という前提は同一ビルド前提（published ABI 無し）では誇張と判明し、**実装の前倒しではなく次の分離が妥当**と確定した:

- **今決める（M2 スコープ内）**: M2 の event/param wire（§3）と、将来の audio bus 拡張（#409）は別々の addressing 空間を持つ。`VoiceAddr.port_index` は **event/note port**（instrument がどの MIDI/note ポートでイベントを受けるか）の addressing であり、sidechain/multi-out のような **audio 信号経路**の addressing（#409 側で独自に設計する bus index）とは別物 — 混同しない。両者は直交する設計であるため、event wire 側に追加のアドレッシング設計は不要（#409 の実装が来ても event wire の再設計を要求しない）。
- **defer する（M2 スコープ外・#409 で追跡）**: `SharedRegion` の audio input/output 配列を単一 stereo sum から複数バス（sidechain input・multi-out）へ拡張する**実装**。M1 effect・M2 instrument が共有する audio transport の拡張であり、DSL 側でミキサー/ルーティング構文（`POST_2.0_MIXER_DSL_DESIGN.html` の具体化）に着手するタイミング、または Phase 3 で multi-bus/sidechain を要する具体プラグインが出たタイミングで着手する。
- **インターフェース層（アドレッシングの考え方）と実装層（audio 配列の物理拡張）を分けて考える**のが owner・advisor 共通の結論。前者は今回の grounding で「既存設計が既に満たしている」ことを確認できたため、追加の doc 化以上の作業は不要だった。

### Q6 — transport/musical context（tempo/beat/tsig 同期）を M2 の wire に含めるか【DECIDED（owner + advisor 確定）】
**確定: (a) wire に含める。ただし「wire に header を置く」ことと「tempo 値を実際に Engine から供給する」ことは2段階に分離し、後者は #408 で追跡する。**

grounding が指摘した欠落（CLAP `clap_event_transport` / VST3 `ProcessContext` / AU `AUHostMusicalContextBlock`）は、内蔵 arp/LFO/tempo-sync effect を持つ 3rd-party instrument が host tempo に追従できず free-run してしまう問題を生む。owner（「エンジン自体がテンポ情報を持っており、seq ごとにも送れる。活用ケースは必ずあるので見送る意味が全くわからない」）の指摘どおり、**サイレント除外は不可**と判断し (a) を採用。

- **今決める・M2 スコープ内（§4.5）**: `TransportContext`（tempo/time-sig/is_playing/is_looping/song_position_beats）を per-block header として `SharedRegion` に追加する。設計詳細は §4.5 参照。
- **defer する・#408 で追跡**: `orbit-audio-core::Engine`/`Scheduler` は現状「今のテンポ」を読み出し可能な live state として持たない（`engine_wrap::set_link_tempo` は Ableton Link への一方通行 push のみ・TS 側 `DaemonPlayParams` にも per-seq tempo フィールドは無い）。DSL からのテンポ指定（`global.tempo`・seq 単位）をこの live state に反映し、M2 の per-block submit 経路が `TransportContext` へ書き込めるようにする仕組みは、別 issue（#408）の作業とする。**v1 の M2 landing 時点では `tempo_bpm=0.0`（未供給）が有効値として観測されうる**ことを明記する（§4.5 参照）。
- 事実確認: grounding での Engine 調査は「テンポ情報を持っている」という owner の前提の一部（グローバルな Link tempo push の存在）は正しいが、「seq ごとに送れる」を裏付ける per-seq tempo 経路は現状のコードには見当たらなかった。advisor はこの事実訂正について「owner の priority 判断（活用ケースが必ずある）そのものは覆らない」と整理しており、(a) 採用の結論はこの訂正後も変わらない。

---

## 7. Phase 3 受け入れ基準（draft — M2 landing の定義）

Q1-Q6 は全て owner サインオフ済み（§6）。以下を M2 substrate の landing 条件とする案（advisor 検査対象）:

1. `orbit-audio-sandbox::EventRecord`/`EventPayload`（§3）が `#[repr(C)]` POD として定義され、`cargo tree -p orbit-audio-sandbox` に clack・vst3 系 crate が出現しないこと（原則B の回帰テスト）。
2. `EventRecord::decode()` が **未検証の enum transmute を行わず**、未知 `kind` を `None` + `event_decode_error_count` 増分で処理すること（原則D の安全性要件・unit test で不正 kind を注入して確認）。
3. `orbit-clap-host` 側に `PluginEvent → NeutralEvent` / `NeutralEvent → clack EventBuffer` の双方向 translate が実装され、既存の NoteOn/NoteOff 経路が sample-exact に回帰しないこと（offline test）。
4. `SharedRegion` の event slot 拡張（§4）が M1 の `host_child_integration.rs` に相当する offline 統合テストで「host submit → child consume → host read（+ NoteEnd 等の output 方向）」の round trip を証明すること（device 不要）。`transport_context`（§4.5）も同じ統合テストで round trip を確認する（`tempo_bpm=0.0` の未供給ケースを含む）。
5. 少なくとも1つの child が新 event 経路で **offline note-render oracle parity**（既知 event 列 → 既知波形、sample-exact）を通すこと（M1 の closed-form oracle パターンを踏襲）。
   - **これは新規 deliverable**: M1 が作った `orbit-clap-effect-child` は effect 専用であり、instrument child（CLAP 版が最有力・既存 `orbit-clap-host` の対称拡張）は現存しない。M2 landing の一部としてゼロから作る。
   - **oracle は closed-form・決定論的でなければならない**: 例）`NoteOn(key)` 受信 → smoothing 無し・既知位相で `key` の周波数の正弦波（or 矩形波）を固定振幅で出力する test-synth。
6. `cargo fmt`/`cargo clippy`/`cargo deny check`/`cargo test --workspace` 全緑。
7. ✅ 本 doc §6 の Q1-Q6 が「owner サインオフ済み」として記録されていること（2026-07-12 達成）。
8. gated stress test（§4.2）: @32f で 10K ノート同時バースト + 持続 100K events/sec を流し `event_dropped_count == 0`。

---

## 8. 参照

- 正本: `POST_2.0_PLUGIN_STRATEGY.html` §3（format-neutral 決定）・§9（まとめ）
- 実装計画: `POST_2.0_VST3_HOSTING_PLAN.md` §Phase 2（本 doc の親）・§1（I/O カバレッジ要件・SCOPE 制約の根拠）
- M1 設計: `POST_2.0_GAMMA_M1_DESIGN.md`（M1/M2 境界・transport パターンの前例）
- 既存資産: `rust/crates/orbit-clap-host/src/events.rs`（`PluginEvent`）・`rust/crates/orbit-audio-sandbox/src/transport.rs`（`SharedRegion`）・`rust/crates/orbit-audio-daemon/src/outproc_effect.rs`（`EffectChildSupervisor`・format 分岐の前例）
- 設計決定の経緯: 本 doc冒頭「設計経緯」節・grounding agent 成果物（正本の文言成立時期の裏取り・JUCE/UAPMD 業界実例調査）・Fable 一発判断（候補A/B/C の比較）
- Issue: #398（本 doc）/ #395（親 plan）/ Epic #292 / #400（既存 in-process CLAP ring lossless 化・M2 と独立）/ #401（`Engine::with_scheduler` contention 可視化・M2 と独立）/ #408（Q6 follow-on・tempo source plumbing）/ #409（Q5 follow-on・multi-bus audio transport）/ `POST_2.0_MIXER_DSL_DESIGN.html`（Issue #337・Q5 の DSL 層先行決定）
