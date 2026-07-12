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
    pub note_id: i32,     // -1 = wildcard（voice 一意識別・per-voice mod のターゲット）。host 側実装規約: monotone 採番・再利用しない（§4.2 output 方向の overflow policy が前提とする invariant。pool/recycle すると NoteEnd drop 時の簿記リセットが voice id 衝突を起こす）
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
pub struct ParamBody { pub addr: VoiceAddr, pub value: f64, pub param_id: u64 } // ParamValue/ParamMod 共用（addr.note_id!=-1 なら per-voice ターゲット・原則A）。u64 化は _pad 置換で size=32B 据え置き（offset 24 は 8-align 済み・実装時 static assert で封じる・下記「設計判断メモ」参照）
#[repr(C)] #[derive(Clone, Copy)]
pub struct GestureBody { pub param_id: u64 } // ParamGestureBegin/End
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
    raw: [u8; 32], // 最大 variant = NoteBody/ExprBody/ParamBody の 32B（rustc 実測で機械検証済み・実装時 static assert で封じる）
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
    ParamValue { sample_offset: u32, param_id: u64, addr: VoiceAddr, value: f64 },
    ParamMod { sample_offset: u32, param_id: u64, addr: VoiceAddr, amount: f64 },
    ParamGestureBegin { sample_offset: u32, param_id: u64 },
    ParamGestureEnd { sample_offset: u32, param_id: u64 },
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
    /// **検証は `kind` タグだけでなく payload 内の nested enum フィールドにも及ぶ**（例:
    /// `ExprBody.expression_id: u32` → `NeutralExpressionId`〔0..=6〕への変換。範囲外の値は
    /// `kind` 不明と同じ扱いで None を返し `event_decode_error_count` を進める。未検証の
    /// u32→enum 変換は本節冒頭の transmute 禁止と同じ UB クラスであり、`kind` だけを検証して
    /// nested enum を素通しするのは不十分）。将来 payload に enum フィールドを追加する際も
    /// 同じ規律に従うこと。
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
- **`param_id` の意味論 = child native format id の zero-extend（host は採番も解釈もしない opaque u64・DECIDED・Fable 一発判断 2026-07-12。landing 前レビューで判明した doc 未記載の穴を埋める owner-owned micro-decision であり、Q1-Q6 本体〔§6〕の再決定ではない）**: CLAP `clap_id`（u32）・VST3 `ParamID`（u32）は上位32bit=0で載せ、AU `AUParameterAddress`（u64）はそのまま載せる。原則A「wire は今 superset」の直接適用（u64 = 3 format の id 型の superset）で、`param_id: u32 + _pad: u32` → `param_id: u64` の置換により wire サイズコストは**厳密にゼロ**（`ParamBody`/`EventPayload`/`EventRecord` いずれもサイズ不変・rustc 実測で機械検証済み）。host 発行の論理 index 案は不採用: (i) index↔native id 対応表を host/child 両側で同期する契約面が増え、CLAP `rescan()` / VST3 restructure による実行中のパラメータ集合変化で全 index が一斉無効化され、in-flight RT event と競合しながら両側の表を差し替える羽目になる（native id なら消えた id が child SDK 層で自然に不発になるだけで済む）。(ii) wire/`.orbslog` 上の id がベンダ文書の id と一致しなくなり、enumeration 順依存の index はプラグイン更新（パラメータ追加）で壊れる。(iii) crate 配置規約（翻訳は child 内に完全隔離）を host 側採番が破る。
- **永続化の注意（AU）**: `AUParameterAddress` は SDK ヘッダ上「個々の Audio Unit が明示的に維持を約束しない限り persistent とは限らない」と明記されている（hosts should bind to key paths）。wire が運ぶのは**当該 child インスタンス生存中の id**（AU 自身の `AURecordedParameterEvent` と同スコープ）であり、run を跨ぐ束縛はセッション層が name/key path → native id を load-time param discovery で run ごとに解決し直す規約とする。この注意は論理 index 案でも同じ enumeration に依存する以上消えない。
- `param_id` は全 u64 が POD として valid なので `decode()` は値域検証しない。存在しない id は child SDK 層で不発になる（原則A の drop 可視化文化に合わせ、child 側 `param_unknown_id_count` で可視化してよい・任意）。
- **サイズ見積りの訂正**: `EventPayload` union は最大 variant（`NoteBody`/`ExprBody`/`ParamBody`）が **32 bytes**（`raw: [u8;24]` は現行定義でも既に stale だった・rustc 実測で確認）。`EventRecord`（kind 4B + sample_offset 4B + payload 32B）= **40 bytes**。§4.2 のサイズ見積りもこれに合わせて訂正する（増分が無視できる規模という結論自体は不変）。

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
pub input_event_dropped_count:  AtomicU64,  // host 側 backing ring 自体が尽きた場合のみ・health signal
pub input_event_spilled_count:  AtomicU64,  // host 側の無損失な1ブロック超遅延（情報用・health signal）
pub output_event_dropped_count: AtomicU64,  // child-local spill FIFO 自体が尽きた場合のみ・health signal（§4.2 output 方向）
pub output_event_spilled_count: AtomicU64,  // child-local spill FIFO 経由の無損失な1ブロック超遅延（情報用）
pub output_note_end_dropped_count: AtomicU64, // 上記 drop に NoteEnd が含まれた回数（host の簿記リセット判断トリガ）
pub event_decode_error_count: AtomicU64,  // decode() が未知 kind を skip した回数（validated decode の可視化）
```

**input 方向（host→child）**:
- **backing ring**（host 側・control スレッドが producer）は shm 外の通常メモリで確保する大きめの ring（目安 65,536 slot × `EventRecord`(40B) ≈ 2.6MB・起動時確保。output 方向の child-local spill FIFO と同オーダー）。RT callback は毎ブロック、この ring から**最大 `MAX_EVENTS_PER_BLOCK` 個だけ pop**して `input_events` へ書く。**窓に載りきらない残りは ring に残し、次ブロック以降で配送する**（＝ overflow の帰結が「データ喪失」ではなく「最大 1 ブロック(64f で約1.45ms)の遅延」になる）。pop 数を減らすだけなので alloc/lock なし・RT-safe。
- **真の drop が起きるのは backing ring 自体が尽きた場合のみ**（drain レート ≈ 4096 events/block @64f ≈ 秒間280万イベント相当なので、実質 producer 側のバグ以外では発生しない）。その場合は **drop-newest**（drop-oldest は §4.1 の理由により不採用）。**`NoteOff` 等の note 状態変更イベントはサイレント drop 禁止**: 捨てざるを得ない場合は sticky flag を立て、次ブロックで note-choke/all-notes-off を側路から注入し、stuck note を構造的に排除する。

**output 方向（child→host）— DECIDED（Fable 一発判断 2026-07-12。§6 Q4「overflow policy」の一部として整理。landing 前レビューで判明した doc 未記載の穴を埋める owner-owned micro-decision）**:
- **spill の発生点は shm ではなく child プロセス内**: output event（`NoteEnd`/`LegacyMidiCcOut` 等）は CLAP `out_events`/VST3 output `IEventList`/AU `MIDIOutputEventBlock` いずれも **render 呼び出し内の同期出力**で、child が render を自分の block 処理スレッド1本から呼ぶ。したがって「plugin out-event queue → shm 転送窓」間の spill は producer=consumer が同一スレッド内で完結する。**input のような shm 外 backing ring を host 側に置く必然はなく、spill buffer は child プロセスの通常メモリに置く**（起動時 pre-allocate・65,536 slot 目安・固定容量ローカル FIFO。producer=consumer が同一スレッドなので lock-free SPSC も不要・alloc/lock なし・RT-safe）。**この単一スレッド前提は 3 format の標準 render 経路（CLAP `process()`・VST3 `process()`・AU render callback）が output event を render 呼び出し内で同期発生させることに依拠する — もし将来 SDK が render 呼び出し外の別スレッドから output event を渡す構成を要求すると判明した場合は、この FIFO を lock-free SPSC 化する必要がある（「child-local に置く」という結論自体は変わらない）。**
- **child 側の per-block 手順**: ① spill FIFO 先頭から `output_events` 転送窓へ詰める → ② 当ブロックの plugin out-event を続けて詰める → ③ 窓（4096）に載らない残りを FIFO 末尾へ push（FIFO 全順序保存）。spill された event の `sample_offset` は配送先ブロック先頭 0 に clamp（input と同一規約・下記参照）。
- **真の drop は child-local spill FIFO が尽きた場合のみ・drop-newest**。`output_event_dropped_count` を child が fetch_add（`child_process_error_count` と同パターン）。**drop 対象に `NoteEnd` が含まれる場合は `output_note_end_dropped_count` を別に進める**（input 側 sticky flag の output 版・host の反応トリガ）。
- **host 側防衛（タイムアウト強制解放は不採用）**: タイムアウト解放は child 内の実発音状態を知らない推測処置であり、誤解放 → note_id 再利用 → per-voice ターゲット衝突という input 側より悪い故障を生むため採らない。代わりに次の2規約で「NoteEnd 喪失＝不可聴の簿記リーク」に格下げし、リーク自体を無害化する: **(a) `note_id` は monotone 採番・再利用しない**（host 側実装規約・wire 影響なし。`output_note_end_dropped_count` の増分検知時に host は当該 child の per-voice 簿記を保守的に一括リセットしてよい。monotone id により生きている voice を誤って忘れても新 voice との id 衝突は起きず、劣化に留まり破損にならない）。**(b) supervisor respawn = 当該 child の implicit all-voices-end**（respawn 検知で voice 簿記をクリア。crash による spill FIFO 喪失も leak にならない）。**スコープ外注記（Stage6 landing レビューで判明・2026-07-12）**: 本規約が保証するのは「簿記がリークしないこと」のみで、「respawn 後の in-order child が historical seq を再処理しないこと」は保証しない。現行 child 実装は respawn 後も常に `last=0` から再開するため（M1 effect child の「skip 許容で最新へ直行」とは異なり、instrument child は §4.6 の in-order 制約により `seq_request` まで逐次再処理する）、長時間セッションでの respawn は無制限の再処理コストを招きうる。resume point の受け渡し（child に「どこから再開すべきか」を伝える機構）は現状存在せず、実際に respawn を発行する本番 supervisor が未実装の段階（M2 substrate #416 のスコープ外）では設計不要と判断し、defer する。追跡: #418（`orbit-clap-instrument-child/src/main.rs` の `last` 初期化箇所にもコード内コメントでアンカー済み）。**スコープ外注記2（`/code:pr-review-team` レビューで判明・2026-07-12）**: 実 CLAP instrument child（`orbit-clap-instrument-child`）は `ClapInstrumentProcessor::process_block` 経由で plugin を駆動するが、共有カーネル `process_block_core`（M1 effect と共有・本 PR 無変更）が `OutputEvents::void()` を渡すため、実 plugin が発行する NOTE_END 等の出力 event は破棄され、`output_events`/`output_event_count` への配線がそもそも存在しない。Stage6 の §7 受け入れ基準はすべて合成 child（`sandbox-instrument-child`）経由で満たされており、実 child の event 出力方向は未検証。正しい修正は M1 と共有する `process_block_core` のシグネチャ変更を要し、かつ `orbit-clap-instrument-child` はまだ production 経路として spawn されていない（Phase 3 = 実 instrument hosting で初めて使われる）ため、#416 のスコープ外として defer する。追跡: #419（`ClapInstrumentProcessor::process_block` にもコード内コメントでアンカー済み）。
- **検討して不採用**: (i) shm 内 child backing ring — spill 発生点が child プロセス内である以上 shm に置く必然が無く、host 事前確保 + child 側 SPSC という契約面だけ増える。(ii) NoteEnd 専用高信頼レーン（voice admission cap と同サイズで構造的 lossless）— cap↔lane の cross-component 不変条件が増え、misbehaving plugin には結局 backstop が要り、lane 分割は FIFO 全順序を崩す。(iii) 転送窓拡大 — §4.1 確定の「窓=飽和点 4096」を崩すだけで bound は消えない。

**共通**:
- **spill された event の `sample_offset` 再タイミング規約（実装時に曖昧にしないこと）**: 配送が後続ブロックにずれた event の `sample_offset` は、配送先ブロックの先頭（0）にクランプする。元ブロック内での相対位置は保持しない。これは既存 in-process 経路が A0 §4.2 で採用済みの簡略化（全イベントを block 先頭オフセットに置く）と同じ粒度であり、新たな精度劣化ではない。
- **可視化は音を変えない**: `input_event_dropped_count`/`output_event_dropped_count`（真の喪失）と `input_event_spilled_count`/`output_event_spilled_count`（無損失遅延・情報）を方向別に分離し、`child_process_error_count` と同型の health signal パターンで 1Hz ticker（`OUTPROC_EFFECT_*` 相当）→ TS 層 → OrbitStudio のステータス表示へ配線する。**演奏・録音の音そのものを変える通知（警告音等）は禁止**（報せる対象の故障より害が大きいため）。
- **既存の audio slot 同期プロトコル（`seq_request`/`seq_done`/per-slot `seq_tag`）をそのまま event slot にも適用**（同一 slot・同一 seq で audio と event が対になる）。`input_event_count`/`output_event_count` は `n_frames` と同じ「Relaxed store → Release publish で可視」規律に従う。**ただし child の消費ポリシー（M1 の「latest 処理・skip 可」を踏襲するか）は event を消費するかどうかで分岐する — §4.6 で DECIDED。**
- **host 側の防御的読み取り（`output_event_count`）**: `output_event_count` は child（クラッシュしうる別プロセス）が書き込む値のため、host はこれを信用せず読み取り時に `.min(MAX_EVENTS_PER_BLOCK)` で clamp してから `output_events` を走査する（M1 の `host.rs` が `n_frames` を `.min(MAX_FRAMES)` で clamp してから読む規律と同型。汚染された count による境界外走査を防ぐ）。
- **bidirectionality**: `NoteEnd`（plugin→host の voice 解放通知）・`LegacyMidiCcOut`（plugin→host の MIDI CC 出力）は child 起点のイベント。M1 の audio transport は host→child(input)/child→host(output) が対称に存在するので、event も同様に input/output を分離する（上記）。
- **サイズ見積り**: `EventRecord` = 40 bytes（kind 4B + sample_offset 4B + payload 32B・§3 参照）。`MAX_EVENTS_PER_BLOCK=4096` なら 40B × 4096 × `SLOTS`(2) × 2方向 ≈ 640 KB（shm 上・現行 audio 領域 ~128 KB に対し増分は無視できる規模。count-prefix 配列なので未使用容量のコピーコストはゼロ）。加えて output 方向の child-local spill FIFO は **child プロセス側**の通常メモリで 65,536 slot × 40B ≈ 2.6MB（shm 外・host の backing ring と同オーダー）。
- **crate 配置**: `EventRecord`/`EventPayload`/`NeutralEvent`/`decode`/`encode` はすべて `orbit-audio-sandbox` に置き、clack-free 回帰テストの対象に含める（`cargo tree -p orbit-audio-sandbox` に clack・vst3 系 crate が一切出現しないことを維持）。各 child は `orbit-audio-sandbox` + 自 SDK crate に依存し、`NeutralEvent → SDK 型` の翻訳を child 内に完全隔離する。
- **受け入れ信号**（§7 に統合）: gated stress test — @32f で 10K ノート同時バースト + 持続 100K events/sec を流し、`input_event_dropped_count == 0` かつ `output_event_dropped_count == 0` を assert。

### 4.3 新規 bounded queue 宣言原則（再発防止・M2 が初適用）

Fable の拡張調査で、同種の欠陥（固定容量 + 統計的典型性の前提 + silent 劣化）が2箇所（既存 in-process CLAP ring・`Engine::with_scheduler` の lock 競合時 silent zero-fill）で見つかった（詳細は #400・#401）。exhaustive な監査を毎回行うのは高コストなので、再発防止は**新しい bounded 構造を導入する際の宣言原則**として成文化する:

> 固定容量の queue/buffer/ring を新規導入する変更は、doc comment で次の3点を明記しなければならない: **(a)** producer のスレッド種別（RT か非RTか） **(b)** overflow policy（lossless か、drop するなら note-off 級の状態依存 event を保護する方法） **(c)** 可視化 counter の有無。

M2 の `input_events`/`output_events`/backing ring がこの原則の初適用例（上記 §4.2 が (a)(b)(c) を明記済み）。**(b) overflow policy は「queue 自体が溢れないか」だけでなく「消費側が window を必ず訪れるか（skip しないか）」も契約の一部**（§4.6 参照。lossless な queue でも、消費側が window を丸ごと skip すれば同じ喪失が別の場所で再発する）。

### 4.6 Event 消費ポリシー — event を消費する child は in-order 必須（DECIDED・Fable 一発判断 2026-07-12）

M1 effect child（`orbit-audio-sandbox::host::PipelinedEffectHost` 対向の child）は「latest 処理」で中間 seq を skip しうる設計を意図的に採用している（spike #351 実証・`host.rs` の `pipelined_skip_is_not_false_fresh` テストが正式挙動として検証）。**M2 実装着手前のレビューで、この skip ポリシーを instrument child にそのまま流用すると、skip されたブロックの `input_events`（NoteOn/NoteOff 含みうる）が child に一度も読まれず、stuck note / ノート消失を構造的に生むことが判明した**。§4.2 の sticky-flag/drop-counter 機構は「host 側 backing ring 自体が尽きた」場合の drop のみを対象とし、この「window は正常に書かれたが child が一度も読まなかった」経路をカバーしない。owner 判断を経て Fable に一発判断を依頼し、以下で確定した。

**確定: event を消費する child（instrument child）は in-order 消費を必須とする（skip 禁止）。** M1 effect child（event を消費しない）は現行の latest-skip ポリシーを変更なく維持する。境界は「event を消費するか否か」であり、将来 effect に per-block automation event を配る時点で同じ規則が自動適用される。

**理由（Fable 判断の要旨）**:
- skip=latest が effect で正当だったのは「audio 入力は次ブロックで上書きされる使い捨てデータ」だからで、この前提は累積する状態変化（note/param）を運ぶ instrument には成立しない。
- M1 実測（本 doc の親 `POST_2.0_GAMMA_M1_DESIGN.md` §6 SLOTS デジタル根拠）で 1 ブロックの実処理+IPC は buffer period の ~1/170〜1/229。かつ `host.rs` の submit guard（`seq_done >= new_seq - SLOTS`）により backlog は構造的に最大 `SLOTS` ブロックへ閉じ込められる。よって in-order 消費で追加される catch-up コストは高々 `SLOTS`−1 ブロック（µs オーダー）で、skip が買う便益は instrument では実質ゼロ。
- **既存 submit guard が「skip された slot は上書きされない（無傷）」ことを既に保証している** — 追加のプロトコル変更なしに in-order 消費が成立する根拠。
- skip 許容+drop 可視化拡張（検討した代替案）は §4.1 で確定した「溢れても失わない」思想と正面から矛盾し（choke による正当な voice の巻き添え切断を伴う）、かつ (i) の便益ゼロと合わせて筋が悪い。
- skip は「どの event が honor されるか」を OS スケジューラの preemption タイミング依存にし、§4.1 が time-budget 方式を棄却した根拠（sample-exact closed-form oracle parity との衝突）と同型の決定論破壊を招く。
- instrument plugin 内部時間（envelope/LFO 等）も process 呼び出しで進むため、render 自体の skip は event 以前に state 破損を生む副次的リスクがある。

**実装方針**:
- **child（instrument）**: 消費ループを「`seq_request`(Acquire) を読み、`last+1..=seq_request` を昇順に1 seq ずつ処理」に変更する（M1 effect child の「latest だけを読む」ループとは異なる）。各 seq で input slot（audio + `input_events`/`n_frames`）を読み render し、`seq_tag[slot]=seq`(Release)→`seq_done=seq`(Release)→`last=seq`。event の `sample_offset` は各 seq 自身の slot から読まれるため、元ブロック内の相対位置がそのまま保持される（backing ring の spill 時 offset-0 クランプより高精度。追加規約不要）。
- **host**: wire・`SharedRegion` レイアウト・SUBMIT/READ・repeat-previous は無変更。実装規律として明記: **backing ring からの pop は submit が成立したブロックのみ行う**（host が stall したブロックでは pop せず ring に残す。slot に書いたのに `seq_request` を進めない状態を作らない）。
- **effect child（M1）**: 無変更（event を消費しないため）。

**反証可能性 / 留保**（Fable 判断が明示した不確実性）:
1. **重い synth での catch-up コスト**: 上記の µs 実測は gain/CLAP test-effect のもの。実 instrument が period 予算の大半を使う場合、backlog `SLOTS` ブロックの in-order 消化が stale を悪化させうる。**予約された fallback**: §7 の gated stress test で in-order child の stale_pct が有意に劣化した場合、「event は in-order で全 slot から drain・render は latest のみ」というハイブリッド（losslessness を保ったまま latest-render を回復）に切り替える。これは skip 許容案への回帰ではない（event の loss なしは維持される）。
2. **無傷保証の前提**: submit guard の現行形（`seq_done >= new_seq - SLOTS`）に依存する不変条件。将来 guard や `SLOTS` の意味論を変える変更では再検証が必要。
3. **stall 時の event 滞留**: host が stall したブロックの event は backing ring に留まり、配送が最大 `SLOTS` ブロック（64f で ~3ms）遅延しうる。音楽的には無害だが NoteOff の最悪遅延として記録する。

**§7 受け入れ基準への追加**: 上記「実装方針」の in-order 消費・「予約された fallback」の判断根拠は §7 に統合する（後述）。

### 4.4 既存コードの同種欠陥（M2 とは別スコープ・issue 化済み）

M2 の容量設計を検討する過程で、同じ欠陥パターンが**既存の出荷済みコード**にも存在することが判明した。M2 の設計・実装はブロックしないが、独立した修正として着手する:

- **#400**: in-process CLAP event ring（`orbit-audio-daemon/src/engine_wrap.rs` の `push_plugin_event`）— 満杯時 drop-newest だが可視化カウンタなし・producer が RT スレッドでないため bounded retry だけで lossless 化できる。**✅ 修正済み・CLOSED（2026-07-12）**。
- **#401**: `Engine::with_scheduler` の try_lock 経路（`orbit-audio-core/src/engine.rs`）— lock 競合時に1ブロック無音化するが可視化なし。lock-free 化は別途 defer 済みの判断を維持し、contention counter のみ追加。**✅ 修正済み・CLOSED（2026-07-12）**。

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

### 4.7 host 側 per-voice 簿記のキー — `(port, channel, key)` 参照カウント方式（DECIDED・Fable 一発判断 2026-07-12）

Stage6（#416 統合テスト + host 側 voice 簿記）着手前のレビューで、§4.2 (a) が前提とする「monotone 採番された note_id」が現行実装のどこにも存在しないことが判明した。Stage4 の `PluginEvent::to_neutral_event`（`orbit-clap-host/src/events.rs`）は既存 `drain_to_event_buffer` の CLAP `Pckn` 構成（`note_id = Match::All`）を sample-exact に保持するため、意図的に `VoiceAddr.note_id = -1`（wildcard）のみを発行しており、この挙動は regression test でロックされている（Stage4 受け入れ基準3「既存 NoteOn/NoteOff 経路の sample-exact 回帰なし」の核心）。owner 判断を経て Fable に一発判断を依頼し、以下で確定した。

**確定: host 側 per-voice 簿記のキーは `(port_index, channel, key)` とし、同一キーの多重発音は参照カウントで計数する（案A）。Stage4 の wildcard note_id 発行・regression test は一切変更しない。** あわせて §3 `VoiceAddr.note_id` と §4.2 (a) の「monotone 採番・再利用しない」規約は、「**host が実 note_id（`>= 0`）を発行し始めた時点から拘束力を持つ条件付き invariant**」に再スコープする（wildcard のみを発行する M2 v1 の host は、note_id を1つも採番しないためこの規約を自明に満たす）。案B（Stage4 を修正し host が実 note_id を採番する）は不採用。

**format 横断性（CLAP 固有の判断ではない）**: この決定は host が `VoiceAddr`（neutral wire）だけを見て動く原則B/原則Aの直接の帰結であり、CLAP に限らず VST3・AU にもそのまま成立する。§1.1 の grounding table は AU の voice identity を「MPE ch / MIDI2 per-note（**scalar id なし**）」と記録しており、§3 の `VoiceAddr` 設計コメントも「VST3 は `noteId`+`channel`+`pitch` のみ（`port_index` は `busIndex` に読み替え）、AU は cable+MPE channel で近似」としている。VST3 は CLAP と同型（optional scalar id + pitch/channel フォールバック）、AU に至っては scalar note_id 自体が存在せず (port/cable, channel, key) が最初からネイティブな addressing である。したがって VST3/AU child が実装される時点でも host 側簿記（`VoiceKey`）の変更は不要 — SDK 固有の相関処理は各 child 内部に完全隔離される（§4.2 crate 配置規約）。

**理由（Fable 判断の要旨）**:

- **原則Aの対称適用**: 原則Aは「wire がフィールドを運んでいれば、child の実装能力向上だけで機能が increment し、wire の作り直しは不要」と定めた。同じ論理は host 側の**発行**にも対称に適用できる — wire は `note_id` を今すでに運んでおり（§3）、host がそこに実値を入れ始めるのは「既存フィールドへの値の供給開始」であって wire 変更ではない。per-voice targeting（note-expression / per-voice param mod の per-instance 指定）を DSL/host 機能として公開する時点で実 note_id 採番を有効化すればよく、M2 substrate の landing にそれを先取りする必要はない。
- **簿記の目的に per-instance identity は不要**: §4.2 の host 側簿記の目的は (i) voice leak の検出・可視化と (ii) `output_note_end_dropped_count` 増分・respawn 時の保守的一括リセットであり、いずれも「どの (port,channel,key) に何本の voice が生きているか」という計数で足りる。per-instance の識別が必要になるのは per-voice targeting を wire に流し始めてからであり、それは M2 v1 には存在しない（host は wildcard しか発行しないので、per-voice ターゲット衝突という §4.2 が防ごうとした故障モード自体が現行 wire 上で構成不能）。
- **CLAP 自身のアドレッシングモデルと一致**: note_id なしの `Pckn`（port/channel/key specific・note_id wildcard）は CLAP の第一級の動作モードであり、plugin は NOTE_END を含む note 系イベントで host が与えた note_id（= -1）をエコーする。したがって child→host の NoteEnd も現行 wire 上で実際に相関可能な軸は `(port, channel, key)` の3つだけである。同一キー再トリガ時に NoteEnd の帰属が曖昧になるのは wire の表現力の既知の限界（CLAP without note_id と同一）であって新たな劣化ではない — §4.2 の offset クランプが「A0 既採用の簡略化と同じ粒度・新たな精度劣化ではない」と整理したのと同型。
- **既存契約の保持**: 案Bは Stage4 受け入れ基準3（sample-exact 回帰なし）を re-open する。`Pckn.note_id` を `Specific` にすると in-process 経路の全 plugin に届くバイト列が変わり、plugin 側の note-id ベース voice matching・NOTE_END 発行挙動への影響範囲は未調査。Stage5 で実証済みの A/B パリティ（実 CLAP instrument の M2 経由発音）も再検証が必要になる。簿記のためだけにこのコストを払う便益はゼロ（前項のとおり計数で足りる）。§4.6 が「既存 submit guard が既に保証している — 追加のプロトコル変更なしに成立する」設計を選んだのと同じ判断基準。
- **リセットの安全性は monotone id なしでも成立**: 一括リセット後に遅延到着した NoteEnd は参照カウントの saturating decrement（下限0）で吸収され、underflow も誤ターゲットも起きない。リセットで新 voice のカウントを誤って減らす可能性は残るが、簿記は観測・health signal であって音響経路を制御しないため（§4.2「可視化は音を変えない」）、帰結は「leak 検出の一時的な過小計数」= 劣化に留まり破損にならない — §4.2 (a) が monotone id で達成しようとした性質そのものが、計数方式では id なしで成立する。

**検討して不採用（案B: Stage4 を修正し host が実 note_id を採番する）**: doc の現行文言には忠実だが、(i) Stage4 の確定済み受け入れ基準を re-open し、(ii) plugin 側挙動への未調査の影響面を開き、(iii) その対価で得られる per-instance identity を M2 v1 の簿記は必要としない。実 note_id 採番は per-voice targeting 機能の landing 時に、その機能の受け入れ基準の一部として導入する（その時点で §3/§4.2 の monotone 規約が拘束力を持つ）。

**Stage6 実装方針（host 側 voice 簿記）**:

```rust
/// host 側 per-voice 簿記のキー（M2 v1）。wire 上で実際に識別可能な3軸。
/// host が実 note_id を発行し始めた時点で per-instance キーへ拡張する（§4.7）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct VoiceKey {
    pub port_index: i16,
    pub channel: i16,
    pub key: i16,
}
```

- **データ構造**: per-child の `VoiceKey → live_count`（`u16` saturating カウンタ）。RT 経路（RT callback 内で input 転送窓へ pop するタイミング）から触る場合は alloc 禁止のため、note port ごとの固定密配列 `[[u16; 128]; 16]`（channel × key・起動時確保）を推奨。簿記更新を非RT側（output reader / health ticker）に置くならプリアロケート済み map でもよいが、いずれも**音響経路を制御しない観測専用構造**とする。
- **increment**: NoteOn が input 転送窓へ実際に載った時点（backing ring からの pop 成立時）で `live_count` を saturating increment。NoteOff では減算しない（release tail 中の voice は生きている。解放通知は NoteEnd）。
- **decrement**: output 方向の NoteEnd 受信時に一致キーを saturating decrement（下限0・underflow なし）。NoteEnd/NoteChoke の addr に wildcard（-1）フィールドが含まれる場合は match-all 意味論で該当範囲を一括ゼロ化する（`Pckn` の wildcard 規約と整合）。
- **`output_note_end_dropped_count` 増分検知時**: 当該 child の全カウンタを一括ゼロ化（保守的リセット）。以後の遅延 NoteEnd は saturating decrement で無害に吸収される。
- **respawn 検知時（§4.2 (b) 無変更）**: implicit all-voices-end として当該 child の全カウンタを一括ゼロ化。crash による spill FIFO 喪失も leak にならない。
- **§7 基準 11(b) の文言修正**: 「host が monotone note_id 前提で per-voice 簿記を安全にリセットできること」→「host が `(port, channel, key)` 参照カウント簿記を一括リセットし、リセット後の遅延 NoteEnd が underflow・誤帰属なく吸収されること」。11(c) は変更なし。

**反証可能性 / 留保**:

1. **同一キー高速再トリガ下の計数ドリフト**: §4.6 の in-order 消費と spill FIFO の全順序保存により、drop が無い限り参照カウントは正確に均衡するはずである。§7 の gated stress test（10K ノートバースト）で drop 無しにもかかわらずカウントが恒常的にドリフトする場合、plugin の NOTE_END 発行が仮定（送った NoteOn と1対1）から外れている証拠であり、簿記の意味論を再検討する。
2. **per-voice targeting の landing = 案B の予約発動**: DSL/host が per-note expression・per-voice param mod を公開する時点で、host の実 note_id 採番（monotone・再利用なし）と `VoiceKey` の per-instance 拡張が**必須**になる。これは本判断の失敗ではなく計画された移行であり、その時点で Stage4 の regression test は「新機能の受け入れ基準の一部」として正式に書き換える（silent な re-open ではなく、per-voice targeting 機能の spec 更新 → 実装の順で行う）。
3. **NOTE_END を発行しない・(port,channel,key) を specific にエコーしない plugin**: 簿記が減算機会を失い leak 計数が単調増加しうるが、これはキー選択と独立の問題であり、(a) のリセット経路と health signal 可視化が backstop になる（キーを note_id にしても同じ plugin は同じ問題を起こす）。

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
**確定内容は §4 参照**（`MAX_EVENTS_PER_BLOCK=4096` + input方向 backing ring / output方向 child-local spill FIFO による lossless spillover + drop-newest は各々の枯渇時のみ + note-off/NoteEnd サイレント drop 禁止 + `input_event_dropped_count`/`input_event_spilled_count`/`output_event_dropped_count`/`output_event_spilled_count`/`output_note_end_dropped_count` の非音響可視化）。当初案「64個・drop-oldest」は owner の「実験的用途で見えない天井になる」懸念 → Fable レビューで不適格と判明 → 「上限を大きくする」でなく「溢れても失わない」設計へ転換した経緯は §4.1 参照。output 方向の overflow policy（child-local spill FIFO・monotone note_id・respawn=all-voices-end）は §4.2 参照（Fable 一発判断 2026-07-12）。sysex・可変長 note-expression text・Chord/Scale text 部の低頻度 side-channel は**存在の必要性のみ確定・具体設計は実装時に詰める**（原則C）。input/output event slot の bidirectional 構成は §4.2 のとおり確定。

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
2. `EventRecord::decode()` が **未検証の enum transmute を行わず**、未知 `kind` を `None` + `event_decode_error_count` 増分で処理すること（原則D の安全性要件・unit test で不正 kind を注入して確認）。**`kind` タグだけでなく payload 内の nested enum フィールドも同様に検証すること**（`ExprBody.expression_id` に `NeutralExpressionId`〔0..=6〕の範囲外値を注入し、`None` + `event_decode_error_count` 増分で処理されることを unit test で確認）。
3. `orbit-clap-host` 側に `PluginEvent → NeutralEvent` / `NeutralEvent → clack EventBuffer` の双方向 translate が実装され、既存の NoteOn/NoteOff 経路が sample-exact に回帰しないこと（offline test）。
4. `SharedRegion` の event slot 拡張（§4）が M1 の `host_child_integration.rs` に相当する offline 統合テストで「host submit → child consume → host read（+ NoteEnd 等の output 方向）」の round trip を証明すること（device 不要）。`transport_context`（§4.5）も同じ統合テストで round trip を確認する（`tempo_bpm=0.0` の未供給ケースを含む）。
5. 少なくとも1つの child が新 event 経路で **offline note-render oracle parity**（既知 event 列 → 既知波形、sample-exact）を通すこと（M1 の closed-form oracle パターンを踏襲）。
   - **これは新規 deliverable**: M1 が作った `orbit-clap-effect-child` は effect 専用であり、instrument child（CLAP 版が最有力・既存 `orbit-clap-host` の対称拡張）は現存しない。M2 landing の一部としてゼロから作る。
   - **oracle は closed-form・決定論的でなければならない**: 例）`NoteOn(key)` 受信 → smoothing 無し・既知位相で `key` の周波数の正弦波（or 矩形波）を固定振幅で出力する test-synth。
6. `cargo fmt`/`cargo clippy`/`cargo deny check`/`cargo test --workspace` 全緑。
7. ✅ 本 doc §6 の Q1-Q6 が「owner サインオフ済み」として記録されていること（2026-07-12 達成）。
8. gated stress test（§4.2）: @32f で 10K ノート同時バースト + 持続 100K events/sec を流し `input_event_dropped_count == 0` かつ `output_event_dropped_count == 0`。
9. **全 variant の encode/decode round-trip test**: `NeutralEvent` の全バリアント（NoteOn/NoteOff/NoteChoke/NoteEnd/PolyPressure/NoteExpression/ParamValue/ParamMod/ParamGestureBegin/ParamGestureEnd/MidiRaw/Midi2/LegacyMidiCcOut）について `encode() → decode()` が元の値と一致することを unit test で確認する（未使用 variant の符号化バグが Phase 3 の child 実装まで潜伏するのを防ぐ）。
10. **offline spillover 決定論テスト**: input・output 双方向で 1ブロックあたり `MAX_EVENTS_PER_BLOCK` を超えるバーストを注入し、超過分が次ブロック以降で無損失配送される（対応する `*_event_spilled_count` が増分し `*_event_dropped_count` は増えない）ことを offline test で確認する。spill された event の `sample_offset` が配送先ブロック先頭にクランプされること（§4.2 記載の規約）も併せて確認する。
11. **枯渇時 note 保護テスト**: (a) host 側 backing ring を意図的に枯渇させ（真の drop 条件を再現し）、`input_event_dropped_count` が増分すること・sticky flag による note-choke/all-notes-off 側路注入が発火し stuck note が構造的に排除されることを確認する。(b) child 側 spill FIFO を意図的に枯渇させ、`output_event_dropped_count`（NoteEnd 込みなら `output_note_end_dropped_count` も）が増分すること・host が monotone note_id 前提で per-voice 簿記を安全にリセットできることを確認する（§4.2 output 方向）。(c) supervisor が child を respawn した際、implicit all-voices-end により voice 簿記がリークしないことを確認する。
12. **in-order 消費の回帰テスト**（§4.6・Fable 一発判断 2026-07-12）: instrument child が host を意図的に backlog させた後（一部ブロックを stall させた後）追いつく offline 統合テストで、**全ブロックの全 event が正確に1回ずつ・元の submit 順序・元の（配送先ブロックにクランプされない）`sample_offset` で消費される**ことを assert する。加えて「child が `last+1` を skip したら fail する」oracle（skip 検出）を用意し、in-order 規律自体の回帰を防ぐ。

---

## 8. 参照

- 正本: `POST_2.0_PLUGIN_STRATEGY.html` §3（format-neutral 決定）・§9（まとめ）
- 実装計画: `POST_2.0_VST3_HOSTING_PLAN.md` §Phase 2（本 doc の親）・§1（I/O カバレッジ要件・SCOPE 制約の根拠）
- M1 設計: `POST_2.0_GAMMA_M1_DESIGN.md`（M1/M2 境界・transport パターンの前例）
- 既存資産: `rust/crates/orbit-clap-host/src/events.rs`（`PluginEvent`）・`rust/crates/orbit-audio-sandbox/src/transport.rs`（`SharedRegion`）・`rust/crates/orbit-audio-daemon/src/outproc_effect.rs`（`EffectChildSupervisor`・format 分岐の前例）
- 設計決定の経緯: 本 doc冒頭「設計経緯」節・grounding agent 成果物（正本の文言成立時期の裏取り・JUCE/UAPMD 業界実例調査）・Fable 一発判断（候補A/B/C の比較）
- Issue: #398（本 doc）/ #395（親 plan）/ Epic #292 / #400（既存 in-process CLAP ring lossless 化・M2 と独立）/ #401（`Engine::with_scheduler` contention 可視化・M2 と独立）/ #408（Q6 follow-on・tempo source plumbing）/ #409（Q5 follow-on・multi-bus audio transport）/ `POST_2.0_MIXER_DSL_DESIGN.html`（Issue #337・Q5 の DSL 層先行決定）
