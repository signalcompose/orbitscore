---
title: "RE-2. OOP Children and the Shared-Memory Transport"
chapter-id: "RE-2"
verified-against: 3983828
verified-at: "2026-07-17"
status: draft
---

> **Note**: This page is a snapshot of the author's reading as of 2026-07-17. The code is the
> source of truth; this page is only a snapshot of that understanding at that point in time.

# RE-2. OOP Children and the Shared-Memory Transport

The daemon we saw in RE-1 doesn't host any 3rd-party plugin's (CLAP/VST3) implementation in its
own process. Instruments (sampler / audio DSL) are in-process, but effects and 3rd-party plugins
are split off as out-of-process (OOP) sandbox child processes. This chapter covers why that
split exists, how the shared-memory (shm) transport in the `orbit-audio-sandbox` crate works,
the READY handshake, watchdog/respawn behavior, and parent-liveness monitoring (`ParentWatch`).
The plugin-hosting DSL surface (`global.effect()` / `seq.instrument()`) and the child-binary
selection logic (`child_exe_for_attach`) are already covered in the PH-2/PH-3 chapters and are
not repeated here — this chapter focuses on the **shared substrate** both effect and instrument
children use: the transport mechanism itself.

## Why in-process vs. out-of-process

Per the confirmed architecture recorded in `docs/development/POST_2.0_MASTER_PLAN.html`:

> 楽器（サンプラー/audio DSL）= in-process（楽器は DSL 表現力の着地点なので flatten 境界を
> 経由させない。in-process は表現力を自由に進化させる + 自社 Rust で隔離不要）。effects +
> 3rd-party = out-of-process sandboxed plugin（audio→audio の下流 / 非信頼 crash を隔離）。
>
> (Instruments (sampler / audio DSL) = in-process — instruments are where DSL expressiveness
> lands, so they should not pass through a flattening boundary; in-process lets that
> expressiveness evolve freely, and our own Rust code needs no isolation. Effects + 3rd-party =
> out-of-process sandboxed plugin — a downstream audio→audio stage whose untrusted crashes
> should be isolated.)

In short, the criterion is whether the DSL needs fine-grained per-note/per-slice control (→
instrument side, in-process) or is a pure audio→audio transformation (→ plugin side, OOP).
3rd-party CLAP/VST3 plugins are untrusted code, so they are isolated behind a process boundary
so a crash doesn't take the host (the daemon itself) down with it. `orbit-audio-sandbox`
implements that isolation.

## The shm transport: `SharedRegion`

The host (daemon) and the child (`orbit-clap-effect-child`, etc.) both open the same mmap file
as shared memory and overlay a `#[repr(C, align(64))]` `SharedRegion` struct on top of it. Field
order is fixed, and the 64-byte alignment lands on a cache-line boundary.

```rust
// transport.rs:137-171
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

With `SLOTS = 2`, a ping-pong buffer scheme is used, where the host submits the current block
while reading the previous block's output — the "pipelined" approach described below. This
avoids a synchronous round-trip wait (tail latency) on every block, making small buffer sizes
(32/64 frames) practically feasible.

```rust
// host.rs:1-13
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

`PipelinedEffectHost::process_block` upholds the RT contract (no alloc/lock/syscall), as stated
explicitly in both its type and its comment, and rewrites `data` in-place in submit-then-read
order (submit the current block to the child, then read the previous block's output).

```rust
// host.rs:86-98
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

The instrument-side host (`PipelinedInstrumentHost` in `instrument_host.rs`) layers note-event
voice management (`VoiceTable`) on top of the same shm substrate, reusing the same transport
(`seq_request`/`seq_done`/slot mechanism) as the effect host. `SharedRegion` also holds the
event-transfer windows for M2 instrument IPC (`input_events`/`output_events`, etc.), but the
wire format itself (`NeutralEvent`) is a detail left to the RE-3 (M2 IPC) chapter.

## The child-side READY handshake

A child doesn't enter its process loop the moment it starts; it only flips `child_status` to
`CHILD_STATUS_READY` once the plugin has finished loading. The host polls this flag and only
starts submitting blocks after it sees READY.

```rust
// transport.rs:85-102
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

The gotcha the comment points out matters: the shm file itself is truncated (zero-initialized)
only once, at daemon startup, and a respawn (a watchdog-triggered child restart) **reuses the
same shm** rather than re-truncating it. So if a respawn fails after the child once reached
READY, `child_status` does not fall back to STARTING — the previous incarnation's READY value
lingers. The fix for this is the discipline of always calling `reset_child_starting` to force
STARTING right before every spawn.

## Watchdog and respawn

On the daemon side, `InstrumentChildSupervisor` (for instruments; `EffectChildSupervisor` for
effects) runs a dedicated thread that monitors the child's liveness and automatically respawns
it on an unexpected exit.

```rust
// outproc_instrument.rs:493-519 (excerpted)
"orbit-clap-instrument-child exited ({status}); respawning"
// SAFETY: region は watchdog が所有する生存 ctl_mmap を指す。
// ...
stats.respawn_count.fetch_add(1, Ordering::Relaxed);
// ...
"instrument child respawn failed; measurement invalid: {error}"
```

If respawns repeatedly fail, the supervisor sets a `measurement_invalid` flag exactly once
(fire-once). This is a WARNING-severity state meaning "the daemon/engine itself stays alive and
other audio keeps flowing, but that instrument's (or effect's) path is permanently stuck
repeating its last good block" — surfaced to the client through the same 1 Hz `StreamStats`
ticker path seen in RE-1, as `ERROR_CODE_OUTPROC_INSTRUMENT_INVALID` /
`ERROR_CODE_OUTPROC_EFFECT_INVALID`.

Child-process teardown (graceful shutdown) itself is consolidated into an RAII guard,
`SandboxChildGuard`. On drop it stores `CONTROL_QUIT`, waits up to a fixed timeout (2 seconds)
for the child to reap, falls back to `kill` if that fails, and finally removes the shm file —
the same procedure shared by the daemon, an offline driver, and integration tests.

```rust
// child.rs:44-84
impl Drop for SandboxChildGuard {
    fn drop(&mut self) {
        // child に正常終了を要求 → 一定時間待って、ダメなら kill。
        // SAFETY: region は呼び出し側が本ガードより後まで生かす mapping を指す(構築時の契約)。
        unsafe {
            (*self.region).control.store(CONTROL_QUIT, Release);
        }
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

## `ParentWatch`: parent-liveness monitoring (#448)

As seen in RE-1, the daemon has a known gap: no SIGTERM/SIGINT handler and no graceful-shutdown
wiring. The teardown path that relies on `SandboxChildGuard::drop` (above) never fires at all if
the daemon dies without going through `Drop` (`SIGKILL`, or a panic's `process::exit(1)`).
`ParentWatch` fills this gap from the child side.

```rust
// parent_watch.rs:1-16
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

The implementation is a simple state machine: it records `getppid()` at startup and re-fetches
it every 250ms to compare. It relies on standard Unix reparenting semantics (when a parent dies,
its children get reparented to launchd/PID1/etc. and `getppid()`'s value changes).

```rust
// parent_watch.rs:24-63
/// child プロセスが起動時の親 PID を記録し、reparent(親死亡)を低頻度で検知する状態機械。
pub struct ParentWatch {
    original_ppid: libc::pid_t,
    check_interval: Duration,
    last_check: Instant,
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
            last_check: Instant::now(),
        }
    }

    /// 親が死んで(= 現在の `getppid()` が起動時と異なる場合)true を返す。
    ///
    /// rate-limit: 前回チェックから `check_interval` 未満なら syscall を発行せず false を返す
    /// (spin loop 内で毎回呼んでも system call 頻度は interval に収まる)。
    pub fn should_exit(&mut self) -> bool {
        let now = Instant::now();
        if now.duration_since(self.last_check) < self.check_interval {
            return false;
        }
        self.last_check = now;
        // SAFETY: 同上。
        let current_ppid = unsafe { libc::getppid() };
        current_ppid != self.original_ppid
    }
}
```

`ParentWatch` is implemented as a single thin helper shared across all four child binaries
(CLAP/VST3 × effect/instrument) — each child's main function just calls `should_exit()` inside
its spin loop, independent of the transport module. Per git history, this module was added in a
single commit: `a0449b8 fix(sandbox): add parent-liveness watchdog to VST3/CLAP child
processes`.

## Try it: verify a child self-exits when its parent dies

The `orbit-audio-sandbox` crate has an integration test, `parent_watch_integration.rs`, that
builds a real process hierarchy (test process → probe P playing the "daemon" role → probe C
playing the "child" role), `SIGKILL`s P, and verifies that C detects `true` from
`ParentWatch::should_exit()` and exits on its own. It depends on neither a device nor shm, so it
runs in CI without an `#[ignore]` tag.

```bash
cargo test -p orbit-audio-sandbox --test parent_watch_integration
```

**Expected output** (actually run and confirmed by this agent in this sandboxed environment):

```
running 1 test
test orphaned_child_exits_after_parent_is_killed ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.32s
```

These run with feature flags (verified on real hardware, 2026-07-17):
`cargo test -p orbit-audio-daemon --features outproc-instrument --lib` runs the instrument-side
units (measured the same day: 38 passed under the instrument filter). Effect-side units need
`--features outproc-effect`, and both roles together use
`--features outproc-effect,outproc-instrument`.

## Sources

- `rust/crates/orbit-audio-sandbox/src/transport.rs:80-211` — `SharedRegion` layout, `CONTROL_RUN`/`CONTROL_QUIT`, `CHILD_STATUS_*` readiness constants and the respawn gotcha
- `rust/crates/orbit-audio-sandbox/src/host.rs:1-98` — `PipelinedEffectHost` (pipelined submit/read state machine, RT-safe `process_block`)
- `rust/crates/orbit-audio-sandbox/src/child.rs:1-84` — `SandboxChildGuard` (child-teardown RAII guard: QUIT → reap → kill fallback → shm removal)
- `rust/crates/orbit-audio-sandbox/src/parent_watch.rs:1-104` (full file) — `ParentWatch` (`getppid()`-based parent-liveness monitoring, rate-limited)
- `rust/crates/orbit-audio-sandbox/tests/parent_watch_integration.rs:1-20` — real-process-hierarchy test of `ParentWatch` (run by this agent, confirmed passing)
- `rust/crates/orbit-audio-daemon/src/outproc_instrument.rs:386-605` — `InstrumentChildSupervisor` (watchdog thread, respawn logic, `measurement_invalid` fire-once)
- [`docs/development/POST_2.0_MASTER_PLAN.html`](https://github.com/signalcompose/orbitscore/blob/main/docs/development/POST_2.0_MASTER_PLAN.html) — confirmed in-process/OOP architecture split
- Issue [#448](https://github.com/signalcompose/orbitscore/issues/448) — daemon graceful-shutdown gap and the `ParentWatch` countermeasure (PR: `a0449b8`)
