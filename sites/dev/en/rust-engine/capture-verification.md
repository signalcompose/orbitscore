---
title: "RE-4. Capture Seam and Objective Verification (ORBIT_CAPTURE_WAV)"
chapter-id: "RE-4"
verified-against: 3983828
verified-at: "2026-07-17"
status: draft
---

> **Note**: This page is a trace of the author's reading as of 2026-07-17. The code is the truth; this page is merely a snapshot of understanding at that point in time.

# RE-4. Capture Seam and Objective Verification (ORBIT_CAPTURE_WAV)

Beyond "listening with your ears", OrbitScore's audio engine has a **capture
seam** (Issue #307) as a verification mechanism. Setting the
`ORBIT_CAPTURE_WAV` environment variable records the master output
(post-mix, right before the device) to a WAV file in real time; that file
can then be run through `orbit-audio-verify`'s analysis primitives (onset
detection, RMS, pan back-calculation) to objectively confirm that the DSL's
intent matches the actual samples produced. This chapter traces this path's
implementation (the self-authored RIFF WAV writer in `capture.rs`) and how
this "ears-free verification" is actually assembled.

## The capture tap point: post-mix, pre-hardware

Capture taps the `hw` buffer, read-only, **after** the master-bus
post-processor has been applied but right before it's sent to the device,
inside `render_block`. This means it records "the final signal that
actually reaches the device"; the presence of capture does not change the
output samples themselves (it only reads — it does not mutate).

```rust
// rust/crates/orbit-audio-native/src/output.rs:226-273 (relevant excerpt)
/// 1 callback 分の処理（計測 + engine render + master-bus post-processor）。
///
/// 手順: (1) callback 開始時刻を取る（`cb_stats` 有り時のみ）→ (2) [`render_engine`] で engine
/// （+ LinkAudio egress）を render → (3) `post` 有りなら hardware sum を in-place 変換（CLAP
/// effect/instrument・Issue #340）→ (4) `capture` 有りなら **post 適用後の最終 `hw`** を WAV 用
/// ring へ読み取り専用 tap（#307）→ (5) callback 所要時間を記録。`post`/`capture`/`cb_stats` は
/// 各々独立の opt-in 分岐で、すべて None なら従来経路とビット同一。`capture` は `hw` を読むだけ
/// なので有効でも出力サンプルは不変（tap であって mutation ではない）。
#[inline]
#[allow(clippy::too_many_arguments)] // callback state is kept as independent opt-in seams.
fn render_block(
    engine: &Engine,
    link: &mut Option<LinkEgress>,
    insert_buses: &mut [InsertBusStage],
    post: &mut Option<Box<dyn PostProcessor>>,
    capture: &mut Option<RingTapSink>,
    cb_stats: &Option<Arc<CallbackTimeStats>>,
    output_channels: usize,
    hw: &mut [f32],
) {
    // ...
    if let Some(sink) = capture.as_mut() {
        sink.commit(hw);
    }
    // ...
}
```

The tap is performed via `RingTapSink::commit`, a wait-free / no-alloc
operation; if the ring is full, it's tracked with a drop counter (this keeps
the RT contract intact while making it visible when the off-thread writer
can't keep up).

## `RiffWavWriter`: a self-authored 32-bit float WAV encoder with no external dependency

Per an owner-confirmed policy (no additional external WAV encoder crate
such as hound), `capture.rs` writes RIFF WAV using only `std::io`. It uses
`wFormatTag = 3` (`WAVE_FORMAT_IEEE_FLOAT`), so there is no quantization —
the recorded f32 values round-trip exactly.

```rust
// rust/crates/orbit-audio-native/src/capture.rs:29-56
/// 32-bit float(量子化なし)streaming WAV writer。`std::io` のみで実装する(外部 WAV encoder crate
/// を増やさない方針 = owner 確定・hound 不採用)。
///
/// ファイルサイズは書き込み終了時まで確定しないので、[`Self::new`] で size を 0 の placeholder
/// にした header をまず書き、サンプルを逐次追記した後、[`Self::finalize`] で実サイズに patch する。
pub struct RiffWavWriter {
    writer: BufWriter<File>,
    sample_rate: u32,
    channels: u16,
    samples_written: u64,
    /// `write` が per-call の alloc を避けるため再利用する little-endian バイトバッファ。
    scratch: Vec<u8>,
}

impl RiffWavWriter {
    /// `path` に新規ファイルを作り、size placeholder 込みの 44-byte header を書く。
    pub fn new(path: &Path, sample_rate: u32, channels: u16) -> io::Result<Self> {
        let file = File::create(path)?;
        let mut writer = BufWriter::new(file);
        writer.write_all(&build_header(sample_rate, channels, 0))?;
        Ok(Self {
            writer,
            sample_rate,
            channels,
            samples_written: 0,
            scratch: Vec::new(),
        })
    }
```

The problem of an undetermined size (the total file size is unknown during
streaming writes) is solved with the standard trick: write a placeholder
header with size 0 first, then seek back to the start and patch in the real
size in `finalize()`. `finalize` consumes `self` by value, so double-finalize
is prevented by the type system.

```rust
// rust/crates/orbit-audio-native/src/capture.rs:73-90
    /// 先頭に seek して RIFF / data チャンクの size を実値に patch し、flush する。
    /// `self` を値で消費するので二重 finalize は型で防止される。
    ///
    /// # 既知の制限
    /// 古典 WAV(RIFF)の size フィールドは u32 なので、`samples_written * 4` バイトが
    /// 4GiB を超える capture は正しく表現できない(RF64 拡張が必要・未対応)。ここでは
    /// saturating して壊れた header にはしない。
    pub fn finalize(mut self) -> io::Result<()> {
        self.writer.flush()?;
        let data_bytes = u32::try_from(self.samples_written.saturating_mul(4)).unwrap_or(u32::MAX);
        // BufWriter<File>::seek は seek 前に内部バッファを flush してから inner を seek する
        // (std documented behavior)ので、直前の flush と合わせて安全に先頭へ戻れる。
        self.writer.seek(SeekFrom::Start(0))?;
        self.writer
            .write_all(&build_header(self.sample_rate, self.channels, data_bytes))?;
        self.writer.flush()?;
        Ok(())
    }
```

A capture exceeding 4GiB cannot be correctly represented due to the u32 size
field limit (an RF64 extension would be needed and is not implemented), but
the comment explicitly notes this known limitation and states that the
implementation saturates rather than producing a corrupt header.

## `CaptureWriter`: an off-thread writer that drains outside the RT callback

`CaptureWriter::create` creates the WAV writer and a `RingTapSink`, and
spawns a background thread that drains the ring and performs the writes. The
RT callback only calls `RingTapSink::commit` (wait-free); the actual file
I/O completes entirely outside the audio thread.

```rust
// rust/crates/orbit-audio-native/src/capture.rs:145-211 (excerpt — drain loop body)
    pub fn create(
        path: PathBuf,
        sample_rate: u32,
        channels: u16,
        ring_capacity: usize,
    ) -> io::Result<(RingTapSink, CaptureWriter)> {
        // 先に WAV ファイルを開く(path 不正等で失敗するなら ring を確保する前に fail fast)。
        let mut wav = RiffWavWriter::new(&path, sample_rate, channels)?;
        let (sink, mut consumer, drops) = RingTapSink::new(ring_capacity);
        let stop = Arc::new(AtomicBool::new(false));
        let stop_for_thread = Arc::clone(&stop);

        let handle = thread::spawn(move || -> io::Result<u64> {
            let mut samples_written: u64 = 0;
            // drain ループ。write error は `break Err(e)` で抜け、下の finalize を必ず通す
            // (`?` で即 return すると finalize が走らず header が placeholder〈data=0〉のまま
            // 残り、壊れた WAV になる。best-effort finalize で「書けた分」を header に反映する)。
            let drain: io::Result<()> = loop {
                let avail = consumer.slots();
                if avail == 0 {
                    if stop_for_thread.load(Ordering::Acquire) {
                        break Ok(());
                    }
                    thread::sleep(DRAIN_POLL_INTERVAL);
                    continue;
                }
                // ... (read_chunk, write, commit_all)
            };
            let finalized = wav.finalize();
            match (drain, finalized) {
                (Ok(()), Ok(())) => Ok(samples_written),
                (Err(e), _) => Err(e),
                (Ok(()), Err(e)) => Err(e),
            }
        });
```

Even when the drain loop hits a write error, it does not return early;
`break Err(e)` is followed by an unconditional call to `finalize()` — this
is the silent-failure guard. An early return would leave the header at its
placeholder (`data=0`), producing a corrupt WAV; a best-effort finalize
reflects "however much was written" in the header instead.

On the `OutputStream` side, the `_capture` field is declared **after**
`_stream`, exploiting Rust's declaration-order field drop to structurally
guarantee the sequence "stream stops (callback stops) → writer drains
remaining ring contents and finalizes".

```rust
// rust/crates/orbit-audio-native/src/output.rs:101-110
/// 生きている間はストリームを保持する RAII ハンドル。
pub struct OutputStream {
    _stream: Stream,
    /// capture seam（#307 realtime）: `ORBIT_CAPTURE_WAV` 有効時のみ `Some`。**`_stream` より後に
    /// 宣言する**ことで drop 順を「stream 停止（callback 停止＝以後 commit なし）→ writer が ring の
    /// 残りを drain して WAV を finalize」に固定する（Rust は struct field を宣言順に drop する）。
    _capture: Option<crate::capture::CaptureWriter>,
    pub sample_rate: u32,
    pub channels: u16,
}
```

## What "objective verification" actually looks like: gated-test drops assertion + oracle matching

The pattern for verifying with the capture seam is concentrated in the
gated tests (`--ignored`, needs a real output device) under
`rust/crates/orbit-audio-daemon/tests/`. `capture_realtime_gated.rs` (a
realtime parity check for #304's examples22) is a representative example:

```rust
// rust/crates/orbit-audio-daemon/tests/capture_realtime_gated.rs:206-217
    // teardown 前に drops を assert（silent-failure ガード）。
    let drops = guard.capture_drops();
    assert_eq!(
        drops,
        Some(0),
        "capture drop が発生（録音破損＝検証 invalid）: {drops:?}"
    );

    // guard を drop すると stream 停止 → writer が ring 残りを drain → WAV finalize。
    drop(guard);
    drop(wrap);
    std::env::remove_var("ORBIT_CAPTURE_WAV");
```

The "art of objective verification" is distilled here:

1. **Assert `drops == 0` before teardown** — nail down, before doing any
   further verification, that the off-thread writer never dropped a slot
   from the ring. If `drops > 0`, every subsequent check is meaningless
   (the recording itself is corrupt).
2. **Cross-check the WAV header against the physical file size** — if
   `finalize()`'s header patch fails (e.g. disk full), the header stays at
   its placeholder while the PCM body itself physically exists. Without
   comparing the header's `data` chunk size against the actual file length,
   a corrupt WAV would still parse successfully as PCM and produce a false
   positive:

```rust
// rust/crates/orbit-audio-daemon/tests/capture_realtime_gated.rs:99-111
    let data_bytes = u32::from_le_bytes(buf[40..44].try_into().unwrap()) as usize;
    assert_eq!(
        data_bytes,
        body.len(),
        "WAV data chunk size ({data_bytes}) が物理 body 長 ({}) と不一致 = finalize 失敗による \
         header 破損（録音 invalid）",
        body.len()
    );
```

3. **Anchor on onset detection, then take windows at relative positions** —
   device startup latency means the start of the WAV is offset from
   transport time 0, so each event's RMS window is measured relative to the
   detected first onset frame (comparing at absolute times would always be
   off by the device's latency).
4. **Back-calculate pan from L/R RMS and check it against the scheduled pan
   within tolerance** — strict gain-dB comparison is left to the offline
   `per_event_gain` fixture, which uses the same sample; the realtime
   capture check's division of labor is limited to "there is signal in this
   region" and "pan matches".

## The engine's own peak log: `post_peak_bits`

Separately from the capture WAV, the engine also keeps its own running
post-mix peak at the daemon layer, stored as an `AtomicU32` (f32 bits). This
is a lock-free `fetch_max` implementation that relies on non-negative f32
bit representations preserving numeric ordering; CLAP/VST3 instrument and
effect each have their own dedicated field (corresponding to
`outproc_instrument.rs::ClapInstrumentStats.post_peak_bits` /
`outproc_effect.rs::OutProcEffectStats.post_peak_bits`). Gated tests read
this via accessors such as `engine.outproc_instrument_post_peak()`, and it
can be used as a double-check against the measured peak of a WAV recorded
via `ORBIT_CAPTURE_WAV` (this page only confirmed the existence of the
field name via `grep`; the "Try it" section below describes the procedure
for cross-checking the capture WAV's measured peak against the daemon's
logged `post_peak`, but the exact match between the two was not re-verified
on real hardware).

## Try it: capture → peak cross-check loop

1. Start the daemon with `ORBIT_CAPTURE_WAV=<path>.wav` set:

```bash
ORBIT_CAPTURE_WAV=/tmp/orbit-capture.wav cargo test -p orbit-audio-daemon \
  --test capture_realtime_gated -- --ignored --nocapture
```

(This particular test sets `ORBIT_CAPTURE_WAV` to its own unique temp path
internally, so the value above will be overwritten by the test. To
manually capture an arbitrary DSL session, export `ORBIT_CAPTURE_WAV` before
starting the daemon, then run the normal `RUN` flow.)

2. After teardown, confirm `drops == 0` (the gated test asserts this
   automatically; for manual runs, call `guard.capture_drops()` or check for
   any `LINK_EGRESS_DROP`-style warnings in the log).
3. Load the recorded WAV and measure peak/RMS (using
   `orbit-audio-verify`'s primitives such as `region_rms` /
   `detect_onset_threshold`, or an external tool like `soxi`/`ffprobe` for a
   quick sanity check).
4. If possible, read the engine's `post_peak`-family accessor (equivalent to
   `outproc_instrument_post_peak`) during the same session and compare it
   against the capture WAV's measured peak.

**Expected value (unverified)**: since the tap point is the same `hw`
(post-mix, post-processor applied) in both cases, the capture WAV's measured
peak and the value from the daemon's `post_peak_bits`-derived accessor
should in principle match — but this page's author has not actually run
this cross-check on real hardware and confirmed the numbers as of writing.
If you run it, overwrite this description with the measured values.

## Sources

- `rust/crates/orbit-audio-native/src/output.rs:226-273` — `render_block` (location of the capture tap and its opt-in branching)
- `rust/crates/orbit-audio-native/src/output.rs:101-110` — `OutputStream` (drop-order guarantee for the `_capture` field)
- `rust/crates/orbit-audio-native/src/capture.rs:29-56` — the `RiffWavWriter` struct (32-bit float, no external crate)
- `rust/crates/orbit-audio-native/src/capture.rs:73-90` — `RiffWavWriter::finalize` (size patching, 4GiB limit)
- `rust/crates/orbit-audio-native/src/capture.rs:145-211` — `CaptureWriter::create` (off-thread drain loop, best-effort finalize)
- `rust/crates/orbit-audio-daemon/tests/capture_realtime_gated.rs:1-23` — capture seam realtime gated test's module doc comment (purpose, how to run)
- `rust/crates/orbit-audio-daemon/tests/capture_realtime_gated.rs:99-111` — WAV header vs. physical size cross-check (silent-failure guard)
- `rust/crates/orbit-audio-daemon/tests/capture_realtime_gated.rs:206-217` — `drops == 0` assertion (pre-teardown silent-failure guard)
- `rust/crates/orbit-audio-daemon/src/outproc_instrument.rs:193-205` — `post_peak_bits` (lock-free peak accumulation implementation)
- [`docs/development/WORK_LOG.md`](https://github.com/signalcompose/orbitscore/blob/main/docs/development/WORK_LOG.md) — history of the capture seam #307 realtime design (owner-confirmed decision: daemon-start config, self-authored WAV writer)
- Issue [#307](https://github.com/signalcompose/orbitscore/issues/307) — capture seam realtime wiring
