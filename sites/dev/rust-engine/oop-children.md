---
title: "RE-2. OOP children と shm transport"
chapter-id: "RE-2"
verified-against: 69dc968
verified-at: "2026-09-01"
status: draft
---

> **Note**: 本ページは 2026-09-01 時点での著者の reading の足跡です。code が真実、本ページはその時点の理解の snapshot に過ぎません。

# RE-2. OOP children と shm transport

[RE-1](/rust-engine/) で見た daemon は、自プロセス内では 3rd-party plugin（CLAP/VST3）の実体を持ちません。
楽器（サンプラー/audio DSL）は in-process ですが、effects と 3rd-party plugin は out-of-process (OOP)
sandbox の子プロセスとして分離されます。本章では、この in-process/OOP の使い分けの理由、
child バイナリの一覧、`orbit-audio-sandbox` crate が提供する共有メモリ (shm) transport の仕組み、
READY handshake、watchdog/respawn、そして親プロセス死活監視 (`ParentWatch`) を扱います。
plugin hosting の DSL 面（`global.effect()` / `seq.instrument()`）や child バイナリ選択ロジック
（`child_exe_for_attach`）は [PH-1](/plugin-hosting/) 章に、plugin UI の window 配線は
[PH-2](/plugin-hosting/plugin-ui) 章に譲り、ここでは effect/instrument 両方の child が
**共有する土台**（transport の仕組みそのもの）に焦点を当てます。

## in-process vs out-of-process の使い分け

`docs/development/POST_2.0_MASTER_PLAN.html` に記された確定アーキテクチャによれば:

> 楽器（サンプラー/audio DSL）= in-process（楽器は DSL 表現力の着地点なので flatten 境界を
> 経由させない。in-process は表現力を自由に進化させる + 自社 Rust で隔離不要）。effects +
> 3rd-party = out-of-process sandboxed plugin（audio→audio の下流 / 非信頼 crash を隔離）。

つまり判定基準は「DSL が per-note/per-slice の細かい制御を要するか」（→ 楽器側・in-process）
か「純粋な audio→audio 変換か」（→ plugin 側・OOP）かで分かれます。3rd-party の CLAP/VST3
plugin は信頼できないコードなので、crash してもホスト（daemon 本体）を道連れにしないよう
プロセス境界で隔離します。この隔離を実現するのが `orbit-audio-sandbox` crate です。

## child バイナリの一覧

daemon が spawn し得る child バイナリは `orbit-audio-daemon` の `SPAWNABLE_CHILD_BINARIES` に
明示されています。これは配布物の出荷ゲート（`scripts/copy-daemon-bin.sh` が全 child を同梱したか）と
実装が食い違わないよう「真実を 1 箇所に置く」ために作られた定数です。

```rust
// rust/crates/orbit-audio-daemon/src/lib.rs:84-93
pub const SPAWNABLE_CHILD_BINARIES: &[&str] = &[
    // effect: #628 以降は rack child 1 本がチェーン全体を持つ（format で分岐しない）。
    "orbit-effect-rack-child",
    // effect（退役予定・#628 で到達不能になったが、退役 PR まで配布は続ける）。
    "orbit-clap-effect-child",
    "orbit-vst3-effect-child",
    // instrument: format ごとに child が分かれる（1 instrument = 1 child）。
    "orbit-clap-instrument-child",
    "orbit-vst3-instrument-child",
];
```

| child バイナリ | 役割 | 2026-09-01 時点の状態 |
|---|---|---|
| `orbit-effect-rack-child` | effect チェーン全体（ラック）を 1 child で直列に回す。CLAP/VST3 を同じ child が持つ | #628 以降の effect の唯一の到達経路 |
| `orbit-clap-effect-child` / `orbit-vst3-effect-child` | format ごとの単体 effect child（1 bus = 1 child） | #628 で到達不能・退役 PR まで配布は継続 |
| `orbit-clap-instrument-child` / `orbit-vst3-instrument-child` | format ごとの instrument child（1 instrument = 1 child） | 現役。拡張子で選ぶ規則は PH-1 参照 |

2026-07-17 時点では「CLAP/VST3 × effect/instrument の 4 種類」でしたが、#628 の effect rack で
「1 child が N プラグインを直列に回す」rack child が加わりました。`parent_watch.rs` の module
コメントが今も「4 つの child バイナリ」と書いているのは、その時点の記述が残っているためです。

## shm transport: `SharedRegion`

host（daemon）と child は 1 つの mmap ファイルを共有メモリとして開き、`#[repr(C, align(64))]` の
`SharedRegion` 構造体をその上に重ねます。フィールド順は固定、64-byte align でキャッシュライン
境界に載ります。まず audio と handshake の土台の部分を見てみましょう。

```rust
// rust/crates/orbit-audio-sandbox/src/transport.rs:170-204
#[repr(C, align(64))]
pub struct SharedRegion {
    /// host が input/n_frames 書き込み後に進める。child はこれが前回値より進むのを待つ。
    pub seq_request: AtomicU64,
    /// child が処理し終えた **最新** request seq(monotone)。host の **submit guard** が slot 再利用
    /// 可否(`seq_done >= new_seq - SLOTS`)に使う。READ の fresh 判定には使わない(それは per-slot
    /// [`SharedRegion::seq_tag`]。global monotone な seq_done では「latest 処理」の skip を検知できない)。
    pub seq_done: AtomicU64,
    /// child が処理したブロック総数(観測用。respawn 後の処理再開を可視化する)。
    pub child_processed: AtomicU64,
    /// **child -> host health signal**(γ M1 PR-C・carry-forward ①): child の per-block 処理
    /// (`plugin.process()`)が失敗したブロックの累積数。child が `fetch_add` で書き、host(supervisor /
    /// accessor)が読む。effect は失敗時 dry 素通し・instrument は無音になるため、この counter だけが
    /// 失敗の可視化手段になる(silent-failure 防止)。**child が crash しても host は mmap を保持し続けるので
    /// 値は読める**(supervisor の respawn で同一 shm を再利用するため child を跨いで累積する)。supervisor
    /// 側の `respawn_count` / `last_respawn_ns` / `measurement_invalid`(child の異常終了を host が
    /// 観測する signal)は host-side atomic で別に持つ(SharedRegion ではない)。gain child(PR-A)は
    /// 失敗経路を持たないので増分せず 0 のまま。
    pub child_process_error_count: AtomicU64,
    /// host -> child の制御フラグ([`CONTROL_RUN`] / [`CONTROL_QUIT`])。host が teardown 時に
    /// QUIT を store し、child は spin loop の各周回で確認して正常終了する(kill より clean)。
    pub control: AtomicU32,
    /// **per-slot**: child が各 slot に書いた output の seq。child は output 書き込み後 Release で store し、
    /// host は READ 時に `seq_tag[slot(target)] == target` を Acquire で確認してから読む(その Acquire が
    /// 当該 slot の output 書き込みを可視化する)。child が「latest 処理」で中間 seq を skip しても、その
    /// slot の tag は target に一致しないので host は false-fresh せず repeat-previous に落ちる。
    pub seq_tag: [AtomicU64; SLOTS],
    /// **per-slot**: 各 slot の有効フレーム数(<= MAX_FRAMES)。host が submit 時に該当 slot へ書き、child
    /// はその slot の値で処理長を決め、host は READ 時に copy 長の clamp に使う。pipelined で host が次 block
    /// (別フレーム数)を submit 済みでも、各 slot は自分の正しい長さを持つ(単一 n_frames だと取り違える)。
    pub n_frames: [AtomicU32; SLOTS],
    /// host -> child のインターリーブ入力(ping-pong: SLOTS 個の block。`slot_offset` で index)。
    pub input: [f32; BUF_LEN * SLOTS],
    /// child -> host のインターリーブ出力(ping-pong: SLOTS 個の block。`slot_offset` で index)。
    pub output: [f32; BUF_LEN * SLOTS],
```

`SLOTS = 2` の ping-pong バッファで、host が現ブロックを submit しつつ前ブロックの output を
読む「pipelined」方式が採用されています（下記参照）。これにより毎ブロックの同期 round-trip
待ち（tail latency）を避け、小バッファ（32/64フレーム）運用を現実的にしています。

```rust
// rust/crates/orbit-audio-sandbox/src/host.rs:1-12
//! pipelined(候補B) effect host — RT callback ごとに 1 block を境界越しに処理する状態機械。
//!
//! γ latency fork spike(#351)が採用した候補B: host は **spin しない**。callback K で
//! 現ブロック(`data` = engine の dry 出力)を child へ submit し、**前 callback で submit した
//! ブロックの出力を読んで `data` を上書きする**(serial insert)。これにより同期 round-trip の
//! tail(~2-4ms・buffer 非依存)を構造的に消し、32f まで小バッファを feasible にする。代償は
//! **+1 block の出力遅延**(最終 hw sum 全体に均一にかかる純レイテンシ)と、child が間に合わない
//! 時の **stale**(owner 決定 = repeat-previous: 直前の good block を再出力してクリック回避)。
//!
//! 本 host は `&mut [f32]`(post-processor の in-place バッファ)と `*mut SharedRegion` の上で完結し、
//! orbit-audio-native(PostProcessor trait)にも cpal にも依存しない。`impl PostProcessor` の adapter は
//! daemon 側(native がある所)に薄く置く。本 host の `process_block` を RT callback から呼ぶ。
```

`PipelinedEffectHost::process_block` は RT 契約を守る（alloc/lock/syscall なし）ことが型・
コメントの両方で明示されており、submit（現ブロックを child へ）→ read（前ブロックの output を
読む）の順で `data` を in-place 書き換えます。

```rust
// rust/crates/orbit-audio-sandbox/src/host.rs:86-98
    /// 1 callback ぶんを処理する。`data` は interleaved f32(stereo)で in-place 上書きされる。
    ///
    /// RT-safe: alloc/lock/syscall なし。submit(data を input slot へ)→ read(前ブロックの output を
    /// data へ)の順で、data の dry 入力を失わずに前ブロックの effected 出力へ差し替える。
    pub fn process_block(&mut self, data: &mut [f32]) {
        let raw = data.len();
        if raw > BUF_LEN {
            self.frames_clamped += 1;
        }
        // BUF_LEN = MAX_FRAMES * CHANNELS なので clamp 後は n_frames <= MAX_FRAMES が自明。
        let n_frames = (raw.min(BUF_LEN) / CHANNELS) as u32;
        // count を frame 境界に丸める(端数 sample は触らない)。
        let count = n_frames as usize * CHANNELS;
```

instrument 側の host（`PipelinedInstrumentHost`、`instrument_host.rs`）は同じ shm 基盤の上に
note event の voice 管理（`VoiceTable`）を重ねたもので、effect 用の `SharedRegion` と同じ
transport（`seq_request`/`seq_done`/slot 機構）を再利用しています。`SharedRegion` には M2
instrument IPC 用の event 転送窓（`input_events`/`output_events` 等）も同居していますが、
これは event の wire format 自体（`NeutralEvent`）の詳細であり、本章の範囲外とします
（一次情報は `orbit-audio-sandbox/src/events.rs` と Issue #398）。

### `SharedRegion` の末尾に足された領域（#555 / #474 P2 / #628）

2026-07-17 以降、`SharedRegion` の末尾には「audio 以外」の通信路が 3 つ足されました。
既存 field の offset を維持するため、追加は常に末尾です。

1. **command mailbox**（#555）: host → child のコマンド（state 保存・UI open 等）。`cmd_seq` /
   `cmd_kind` / `cmd_arg` を host が書き、child が `cmd_ack_seq` / `cmd_result` で応答します。
   既存の `control`（RUN/QUIT）と分けたのは、teardown 経路が `control` を RUN に戻すため
   コマンドの意味論を同居させると競合するからです。
2. **event ring**（#474 P2）: child → host の「取りこぼし不可」イベント（UI window が閉じた等）。
   `evt_seq` / `evt_kind` / `evt_arg` を child が書き、host が `evt_ack_seq` で完結を通知します。
   `dirty_epoch` は plugin の dirty 通知の累積水位で、**respawn でもリセットしない**設計です。
3. **`active_stage_index`**（#628）: rack child がいま処理している stage の index。

```rust
// rust/crates/orbit-audio-sandbox/src/transport.rs:265-285
    // ── #474 P2: child → host の取りこぼし不可イベントリング（UIH.2a）。
    /// child -> host: 新規イベント投函時に単調増加。0 = 未発行。
    pub evt_seq: ReleaseAcquireSeq,
    /// child -> host: per-slot イベント種別（[`EVT_UI_CLOSED`] / [`EVT_UI_CLOSED_DONE`]）。
    pub evt_kind: [AtomicU32; EVT_SLOTS],
    /// child -> host: per-slot 固定長引数域（NUL 終端 UTF-8）。
    pub evt_arg: [[u8; EVT_ARG_BYTES]; EVT_SLOTS],
    /// host -> child: host 側処理が完結した最新の `evt_seq`。
    ///
    /// `s` は「`s` 以下の全イベントが完結済み」を意味するため、host は seq 順にのみ進める。
    pub evt_ack_seq: ReleaseAcquireSeq,
    /// child -> host: plugin dirty 通知の累積回数。respawn ではリセットしない。
    pub dirty_epoch: MonotoneEpoch,
    /// child -> host: rack child が現在処理している stage の 0 始まり index。
    ///
    /// 既存 field の offset を維持するため、SharedRegion の末尾にだけ追加する。
    pub active_stage_index: AtomicU32,
}

/// `cmd_arg` のバイト長。command 固有文字列を収める（state sidecar の絶対パスは macOS の
/// PATH_MAX = 1024、UI command では window title）。
```

`ReleaseAcquireSeq` / `MonotoneEpoch` は `AtomicU64` の薄い wrapper で、「`evt_seq` は Release で
publish し host は Acquire で読む」という規律を型で強制するためのものです（`transport.rs:351` 以降の
`evt_sync` module）。`evt_seq.store(seq, Ordering::Relaxed)` のような逸脱はコンパイルできません。

## child-side READY handshake

child は起動後すぐに process loop へ入るのではなく、plugin のロードが終わってから
`child_status` を `CHILD_STATUS_READY` に遷移させます。host はこのフラグを poll してから初めて
submit を始めます。

```rust
// rust/crates/orbit-audio-sandbox/src/transport.rs:113-135
/// `control` の値: child は spin を続ける。
pub const CONTROL_RUN: u32 = 0;
/// `control` の値: host が child に spin loop を抜けて正常終了するよう要求する。
pub const CONTROL_QUIT: u32 = 1;

/// child が実際にロードした CLAP plugin の readiness（PR-431・child→host handshake）。
/// 0 = starting（child がまだ load 中）。
pub const CHILD_STATUS_STARTING: u32 = 0;
/// child が load に成功し、以降 process loop に入る状態。
pub const CHILD_STATUS_READY: u32 = 1;
/// **現状は未使用の予約値**（child が load に失敗して終了する直前の状態を表す想定）。
/// child は load 失敗時 `?` の早期 return でこの値を書かずにそのままプロセス終了する。PR-1c (#441)
/// では watchdog が初回 attach 中の child exit を stats に publish し、host が timeout を待たずに
/// retryable attach failure として返す。
///
/// **respawn 注意**: shm は daemon 起動時に一度だけ truncate され、respawn（`EffectChildSupervisor`/
/// `InstrumentChildSupervisor` の watchdog による再起動）は同一 shm を再利用する（再 truncate しない）
/// ため、一度 READY に達した後の respawn 失敗では `child_status` は STARTING でなく前 incarnation の
/// READY が残留する。PR-1b（#440）は spawn 直前の `reset_child_starting` による STARTING リセット
/// のみを実装し、この前 incarnation の READY 残留誤認を解消した。一方、初回 attach 時に child が
/// `CHILD_STATUS_LOAD_FAILED` は現状も write 箇所なしの予約値であり、early-exit は上記 watchdog
/// signal で検出する。
pub const CHILD_STATUS_LOAD_FAILED: u32 = 2;
```

コメントが指摘する落とし穴は重要です: shm ファイル自体は daemon 起動時に一度だけ truncate（ゼロ
初期化）され、respawn（watchdog による child 再起動）は**同じ shm を再利用**します。そのため、
一度 READY に達した後で respawn に失敗すると、`child_status` は STARTING に戻らず前
incarnation の READY が残ってしまいます。これに対する修正が「spawn 直前に必ず `reset_child_starting`
で STARTING にリセットする」という規律です。

READY と対で `child_flags` という bit flags もあります。child がロードした plugin の性質
（bit0 = audio input を持つか）を host に伝えるもので、child は `child_flags` を先に Release store
してから `child_status` を READY にします。

```rust
// rust/crates/orbit-audio-sandbox/src/transport.rs:137-140
/// child のロード結果を表す bit flags（PR-431）。bit0 = has_audio_input
/// （`orbit_clap_host::buffers::HostAudioBuffers::has_audio_input()` 相当）。effect/instrument の
/// 実体判定に使い、PR-1b で role 不一致検証に使う予定（本 PR では書き込みのみ）。
pub const CHILD_FLAG_HAS_AUDIO_INPUT: u32 = 1 << 0;
```

## watchdog と respawn

daemon 側は `InstrumentChildSupervisor`（instrument 用。effect 側は `EffectChildSupervisor`）が
専用スレッドで child の生死を監視し、予期しない終了を検知すると自動で respawn します。
2026-07-17 時点の respawn ループには上限が無く、起動直後に死に続ける child を tight loop で
respawn し続ける余地がありました。#573 で「`FAST_RESPAWN_THRESHOLD`（2 秒）未満で死ぬ respawn が
`MAX_CONSECUTIVE_FAST_RESPAWNS`（5 回）続いたら諦める」というガードが入っています。

```rust
// rust/crates/orbit-audio-daemon/src/outproc_instrument.rs:32-37
/// 「速い失敗」とみなす生存時間の閾値（#573）。`outproc_effect::FAST_RESPAWN_THRESHOLD` と同値・
/// 同じ理由（`CHILD_READY_TIMEOUT` より十分短く `WATCHDOG_POLL` よりずっと長い）。effect 側の
/// doc comment を参照。
const FAST_RESPAWN_THRESHOLD: Duration = Duration::from_secs(2);
/// 連続 fast-fail の上限（#573）。`outproc_effect::MAX_CONSECUTIVE_FAST_RESPAWNS` と同値・同じ理由。
const MAX_CONSECUTIVE_FAST_RESPAWNS: u32 = 5;
```

```rust
// rust/crates/orbit-audio-daemon/src/outproc_instrument.rs:662-687
                            if consecutive_fast_fails >= MAX_CONSECUTIVE_FAST_RESPAWNS {
                                tracing::error!(
                                    plugin = ?plugin,
                                    "{child_name_wd} exited {consecutive_fast_fails} times in a row \
                                     within less than {FAST_RESPAWN_THRESHOLD:?} of being spawned \
                                     (last exit status: {status}); giving up on the respawn loop \
                                     (measurement invalid)"
                                );
                                stats.measurement_invalid.store(true, Ordering::Release);
                                break;
                            }
                            tracing::warn!(
                                plugin = ?plugin,
                                "{child_name_wd} exited ({status}); respawning"
                            );
                            // 旧 child の死亡確認後にだけ command failure/reset を行う。
                            if !service_ui_pump_on_respawn(
                                "instrument",
                                &ui_pump,
                                &mailbox,
                                &ui_target,
                                None,
                                &ui_events,
                            ) {
                                stats.measurement_invalid.store(true, Ordering::Release);
                                break;
```

respawn を諦めた場合、supervisor は `measurement_invalid` フラグを一度だけ立てます
（fire-once）。これは「daemon/engine 自体は生存し他の audio は流れ続けるが、その instrument
（または effect）経路だけが直前の good block を repeat-previous で出し続ける恒久停止」を意味
する WARNING severity の状態で、`ERROR_CODE_OUTPROC_INSTRUMENT_INVALID` /
`ERROR_CODE_OUTPROC_EFFECT_INVALID` として 1 Hz ticker（RE-1 で見た daemon の `StreamStats`
event 経路）経由で client に可視化されます。

上の snippet で respawn の直前に `service_ui_pump_on_respawn` を呼んでいるのが #474 / #633 の
配線です。旧 child が死んだ時点で開いていた plugin UI window の簿記を畳み、`PluginUiClosedByRespawn`
event を client へ流します（詳細は [PH-2](/plugin-hosting/plugin-ui)）。

respawn とは別に、#618 の instrument 差し替え（`ReplacePlugin`）は audio thread との協調フラグを
必要とします。旧 tenant 宛の note event を新 tenant に流さないよう、control thread が
「event ring の全残渣を捨てて」と要求し、audio thread が空にしてから ack する構造です。

```rust
// rust/crates/orbit-audio-daemon/src/outproc_instrument.rs:310-317
pub struct SlotSignals {
    pub teardown_requested: Arc<AtomicBool>,
    pub teardown_done: Arc<AtomicBool>,
    /// #618: slot tenant 差し替え時、control thread が event ring の全残渣破棄を要求する。
    pub drain_requested: Arc<AtomicBool>,
    /// #618: `event_rx` を空にした後に audio thread が publish する決定論的 ack。
    pub drain_done: Arc<AtomicBool>,
}
```

child プロセスの teardown（graceful shutdown）自体は `SandboxChildGuard` という RAII ガードに
集約されています。drop 時に `CONTROL_QUIT` を store → 一定時間（2秒）reap を待つ → ダメなら
kill → shm ファイル削除、という手順を daemon・offline driver・統合テストで共通化しています。

```rust
// rust/crates/orbit-audio-sandbox/src/child.rs:44-84
impl Drop for SandboxChildGuard {
    fn drop(&mut self) {
        // child に正常終了を要求 → 一定時間待って、ダメなら kill。
        // SAFETY: region は呼び出し側が本ガードより後まで生かす mapping を指す(構築時の契約)。
        unsafe {
            (*self.region).control.store(CONTROL_QUIT, Release);
        }
        // TODO(PR-C): respawn 判断のため child の ExitStatus を捕捉して supervisor へ渡す
        // (本ガードは teardown 専用で終了 status を破棄する)。親プロセス死亡時の孤児化対策
        // (PR_SET_PDEATHSIG 等)も supervisor 層で扱う。
        let deadline = Instant::now() + REAP_TIMEOUT;
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => break,
                // 非 RT の teardown 待ち。spin より yield で CPU を譲る(offline.rs の wait と一貫)。
                Ok(None) if Instant::now() < deadline => std::thread::yield_now(),
                Ok(None) => {
                    eprintln!(
                        "orbit-audio-sandbox: child が {REAP_TIMEOUT:?} 以内に終了せず kill にフォールバック"
                    );
                    let _ = self.child.kill();
                    let _ = self.child.wait();
                    break;
                }
                // try_wait 自体の失敗(ECHILD 等)は timeout と区別して実エラーを出す。
                Err(e) => {
                    eprintln!("orbit-audio-sandbox: try_wait 失敗(kill にフォールバック): {e}");
                    let _ = self.child.kill();
                    let _ = self.child.wait();
                    break;
                }
            }
        }
        if let Err(e) = std::fs::remove_file(&self.path) {
            eprintln!(
                "orbit-audio-sandbox: shm ファイル削除失敗 {:?}: {e}",
                self.path
            );
        }
    }
}
```

## `ParentWatch`: 親プロセス死活監視（#448）

RE-1 で見た通り、daemon 側には SIGTERM/SIGINT ハンドラも graceful-shutdown 配線も無い既知の
ギャップがあります。`SandboxChildGuard::drop`（上記）に依存する teardown 経路は、daemon が
`Drop` を経ずに死ぬ（`SIGKILL`・panic による `process::exit(1)`）と一切発火しません。この穴を
child 側から埋めるのが `ParentWatch` です。

```rust
// rust/crates/orbit-audio-sandbox/src/parent_watch.rs:1-15
//! orphan child 対策(Issue #448): child プロセスの親死活監視。
//!
//! host(daemon)が `CONTROL_QUIT` を書かずに死ぬ経路(プロセス exit・SIGKILL・crash)では、
//! 4 つの child バイナリ(orbit-clap-effect-child / orbit-clap-instrument-child /
//! orbit-vst3-effect-child / orbit-vst3-instrument-child)は `seq_request` 待ちの spin loop に
//! 残り続け、CPU を専有し続ける(shm 側の CONTROL_QUIT に依存する既存の終了経路は host 側の
//! Drop 実行が前提のため、host が Drop を経ずに死ぬとこの経路が発火しない)。
//!
//! [`ParentWatch`] は起動時に `getppid()` を記録し、低頻度(既定 250ms)でこれを再取得する。
//! 親が死んで child が launchd/PID1 等に reparent されると `getppid()` の値が変わるので、
//! それを検知して spin loop から抜けるための helper。RT 影響を避けるため、チェックは
//! 「spin loop を回った回数」でなく「経過時間」で rate-limit する(system call 1 回 / 250ms 程度)。
//!
//! 4 crate(orbit-clap-effect-child 等)で同じロジックを重複させないための共有 helper。
//! transport とは独立した薄いモジュール(既存の「child main はミラー」方針と両立)。
```

実装は `getppid()` を起動時に記録し、250ms ごとに再取得して比較するだけの単純な状態機械です。
Unix の reparent 規則（親が死ぬと子は launchd/PID1 等に reparent され `getppid()` の値が変わる）
を利用しています。2026-07-17 時点との違いは `should_exit(&self)` になった点で、`last_check` を
`Cell<Instant>` に入れることで `&mut self` を要求しなくなりました（クロージャから呼びやすく
するため）。テスト支援の `orphaned_for_tests()` も足されています。

```rust
// rust/crates/orbit-audio-sandbox/src/parent_watch.rs:24-82

/// child プロセスが起動時の親 PID を記録し、reparent(親死亡)を低頻度で検知する状態機械。
pub struct ParentWatch {
    original_ppid: libc::pid_t,
    check_interval: Duration,
    last_check: Cell<Instant>,
}

impl ParentWatch {
    /// 現在の `getppid()` を起動時の親 PID として記録する。既定の rate-limit 間隔
    /// ([`DEFAULT_CHECK_INTERVAL`])を使う。
    pub fn new() -> Self {
        Self::with_interval(DEFAULT_CHECK_INTERVAL)
    }

    /// rate-limit 間隔を明示指定するコンストラクタ(主にテスト用)。
    pub fn with_interval(check_interval: Duration) -> Self {
        // SAFETY: getppid(2) は引数を取らず常に成功する(POSIX)。
        let original_ppid = unsafe { libc::getppid() };
        Self {
            original_ppid,
            check_interval,
            last_check: Cell::new(Instant::now()),
        }
// ...
        }
    }

    /// 親が死んで(= 現在の `getppid()` が起動時と異なる場合)true を返す。
    ///
    /// rate-limit: 前回チェックから `check_interval` 未満なら syscall を発行せず false を返す
    /// (spin loop 内で毎回呼んでも system call 頻度は interval に収まる)。
    pub fn should_exit(&self) -> bool {
        let now = Instant::now();
        if now.duration_since(self.last_check.get()) < self.check_interval {
            return false;
        }
        self.last_check.set(now);
        // SAFETY: 同上。
        let current_ppid = unsafe { libc::getppid() };
        current_ppid != self.original_ppid
    }
```

child 側で「QUIT を受けた」と「親が死んだ」を 1 つの述語にまとめているのが `orbit-child-runtime`
crate の `child_should_quit` です。5 種類の child バイナリ（rack child を含む）はすべてこの関数を
spin loop から呼びます。どちらの理由で抜けたかを stderr に 1 行残すのは、log だけからでは
両者を区別できないためです（#474 P3b のレビューで落ちていたのを戻した経緯がコメントにあります）。

```rust
// rust/crates/orbit-child-runtime/src/lib.rs:61-72
pub unsafe fn child_should_quit(
    region: *const orbit_audio_sandbox::SharedRegion,
    parent_watch: &orbit_audio_sandbox::ParentWatch,
) -> bool {
    let reason = quit_reason(
        (unsafe { (*region).control.load(Ordering::Relaxed) }) == orbit_audio_sandbox::CONTROL_QUIT,
        || parent_watch.should_exit(),
    );
    if reason == Some(QuitReason::ParentDied) {
        eprintln!("[orbit-child-runtime] 親プロセス死亡を検知、終了する");
    }
    reason.is_some()
```

git 履歴上、`parent_watch.rs` は 1 コミット（`a0449b8 fix(sandbox): add parent-liveness watchdog
to VST3/CLAP child processes`）で追加されました。

## Try it: 親死亡時に child が自発的に exit することを実証する

`orbit-audio-sandbox` crate には `parent_watch_integration.rs` という統合テストがあり、実
プロセス階層（テスト process → probe P（daemon 役）→ probe C（child 役））を作り、P を
`SIGKILL` した後に C が `ParentWatch::should_exit()` の true を検知して自発的に exit する
ことを検証します。device にも shm にも依存しないため `#[ignore]` 無しで CI 実行できます。

```bash
cargo test -p orbit-audio-sandbox --test parent_watch_integration
```

**期待される出力**（2026-07-17 にこのサンドボックス環境で実行し、確認済み。2026-09-01 の再読では
再実行していません）:

```
running 1 test
test orphaned_child_exits_after_parent_is_killed ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.32s
```

respawn/watchdog の状態機械そのもの（child crash → respawn → `measurement_invalid`）は
`orbit-audio-daemon` の `outproc_instrument.rs`/`outproc_effect.rs` 内 `#[test]` として実装
されています（例: `supervisor_stops_respawning_after_consecutive_fast_failures`）。実 device・
実 CLAP plugin を要さないスタブ child を使うユニットテストで、`#[ignore]` タグは付いていません。
feature flag 付きで実行します: `cargo test -p orbit-audio-daemon --features outproc-instrument --lib`
で instrument 系、`--features outproc-effect` で effect 系、両 role 同時は
`--features outproc-effect,outproc-instrument`。

## 次の深掘り候補

- rack child（`orbit-effect-rack-child`）の stage 切替 — `ApplyEffectChain` の prepare-commit と `active_stage_index` の関係
- command mailbox（#555）の state 保存経路（`GetPluginState` → `cmd_arg` の sidecar path → child の書き込み）
- `evt_sync`（`ReleaseAcquireSeq` / `MonotoneEpoch`）が型で禁じているものと、`reset_child_starting` が `evt_seq` をリセットする理由
- `outproc_respawn_guard.rs` の generation 管理（respawn 世代を跨ぐ ack の拒否）

## Sources

- `rust/crates/orbit-audio-daemon/src/lib.rs:84-93` — `SPAWNABLE_CHILD_BINARIES`（spawn し得る child の正本）
- `rust/crates/orbit-audio-sandbox/src/transport.rs:113-140,170-285` — `CONTROL_*` / `CHILD_STATUS_*` / `CHILD_FLAG_*`、`SharedRegion` レイアウト（audio・M2 event 窓・command mailbox・event ring・`dirty_epoch`・`active_stage_index`）
- `rust/crates/orbit-audio-sandbox/src/host.rs:1-98` — `PipelinedEffectHost`（pipelined submit/read 状態機械、RT-safe `process_block`）
- `rust/crates/orbit-audio-sandbox/src/child.rs:44-84` — `SandboxChildGuard`（child teardown の RAII ガード：QUIT → reap → kill フォールバック → shm 削除）
- `rust/crates/orbit-audio-sandbox/src/parent_watch.rs:1-124`（全文） — `ParentWatch`（`getppid()` ベースの親死活監視、rate-limit 済み、`orphaned_for_tests`）
- `rust/crates/orbit-child-runtime/src/lib.rs:61-72` — `child_should_quit`（QUIT と親死亡を 1 述語に畳む）
- `rust/crates/orbit-audio-sandbox/tests/parent_watch_integration.rs` — 実プロセス階層での `ParentWatch` 実証テスト
- `rust/crates/orbit-audio-daemon/src/outproc_instrument.rs:32-37,310-317,487-760` — `InstrumentChildSupervisor`（watchdog スレッド、#573 fast-fail ガード、respawn、`measurement_invalid` fire-once、#618 の `SlotSignals`）
- [`docs/development/POST_2.0_MASTER_PLAN.html`](https://github.com/signalcompose/orbitscore/blob/main/docs/development/POST_2.0_MASTER_PLAN.html) — in-process/OOP 分割の確定アーキ
- Issue [#448](https://github.com/signalcompose/orbitscore/issues/448) — daemon graceful-shutdown ギャップと `ParentWatch` 対策（PR: `a0449b8`）
- Issue [#573](https://github.com/signalcompose/orbitscore/issues/573) — 連続 fast-fail での respawn 打ち切り
- Issue [#618](https://github.com/signalcompose/orbitscore/issues/618) — instrument 差し替えと event ring の drain
- Issue [#628](https://github.com/signalcompose/orbitscore/issues/628) — effect rack child
