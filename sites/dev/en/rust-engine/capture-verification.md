---
title: "RE-4. Capture Seam and Objective Verification (ORBIT_CAPTURE_WAV)"
chapter-id: "RE-4"
verified-against: f006a51
verified-at: "2026-09-03"
status: draft
---

> **Note**: This page is a trace of the author's reading as of 2026-09-01. The code is the truth; this page is only a snapshot of understanding at that time.

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

With #651 on 2026-08-29, this capture became "a WAV that opens even when the process died
abnormally". The same day, a mechanism landed that stops the real-hardware E2E from running
against a stale daemon binary. Both bear directly on whether the primary evidence of a
verification can be trusted, so two sections were added at the end.

## The capture tap point: post-mix, pre-hardware

Capture taps the `hw` buffer, read-only, **after** the master-bus post-processor has been applied
but right before it is sent to the device, inside `render_block_with_sources` (see
[RE-1](/en/rust-engine/)). This means it records "the final signal that actually reaches the
device"; the presence of capture does not change the output samples themselves (it only reads —
it does not mutate).

```rust
// rust/crates/orbit-audio-native/src/output.rs:997-1042
fn render_block_with_sources(
    engine: &Engine,
    link: &mut Option<LinkEgress>,
    insert_buses: &mut [InsertBusStage],
    sources: &mut [SourceSlot],
    transport: &mut BlockTransport,
    post: &mut Option<Box<dyn PostProcessor>>,
    capture: &mut Option<RingTapSink>,
    cb_stats: &Option<Arc<CallbackTimeStats>>,
    output_channels: usize,
    hw: &mut [f32],
) {
// ...
    // 読み取り専用 tap。`RingTapSink::commit` は wait-free / no-alloc（満杯時はあふれを drop カウント）
    // ＝ RT 契約を満たす。off-thread writer が ring を drain する。post の後・計測の内側に置くことで
    // capture コストも callback-duration に含めて監視する。
    if let Some(sink) = capture.as_mut() {
        sink.commit(hw);
    }

    if let (Some(stats), Some(t0)) = (cb_stats, t0) {
        stats.record(t0.elapsed().as_nanos() as u64);
    }
}
```

The tap is performed via `RingTapSink::commit`, a wait-free / no-alloc
operation; if the ring is full, it is tracked with a drop counter (this keeps
the RT contract intact while making it visible when the off-thread writer
cannot keep up). The ring holds `CAPTURE_RING_SECONDS = 8` seconds, generously sized so that a
temporarily lagging writer is absorbed (`output.rs:222`).

## `RiffWavWriter`: a self-authored 32-bit float WAV encoder with no external dependency

Per an owner-confirmed policy (no additional external WAV encoder crate
such as hound), `capture.rs` writes RIFF WAV using only `std::io`. It uses
`wFormatTag = 3` (`WAVE_FORMAT_IEEE_FLOAT`), so there is no quantization —
the recorded f32 values round-trip exactly.

```rust
// rust/crates/orbit-audio-native/src/capture.rs:37-64
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
// rust/crates/orbit-audio-native/src/capture.rs:110-127
    /// 先頭に seek して RIFF / data チャンクの size を実値に patch し、flush する。
    /// `self` を値で消費するので二重 finalize は型で防止される。
    ///
    /// # 既知の制限
    /// 古典 WAV(RIFF)の size フィールドは u32 なので、`samples_written * 4` バイトが
    /// 4GiB を超える capture は正しく表現できない(RF64 拡張が必要・未対応)。ここでは
    /// saturating して壊れた header にはしない。
    pub fn finalize(mut self) -> io::Result<()> {
        self.writer.flush()?;
        let data_bytes = self.data_bytes();
        // BufWriter<File>::seek は seek 前に内部バッファを flush してから inner を seek する
        // (std documented behavior)ので、直前の flush と合わせて安全に先頭へ戻れる。
        self.writer.seek(SeekFrom::Start(0))?;
        self.writer
            .write_all(&build_header(self.sample_rate, self.channels, data_bytes))?;
        self.writer.flush()?;
        Ok(())
    }
```

A capture exceeding 4GiB cannot be represented correctly because of the u32
size field (the RF64 extension is not supported), but even then the
implementation saturates rather than producing a corrupt header — the comment explicitly notes
this known limitation. The saturating semantics live in exactly one place, `data_bytes()`, shared
by `finalize` and by `sync_header` in the next section.

## A WAV that opens after an abnormal exit: periodic `sync_header` patching (#651)

This is the largest difference from 2026-07-17. If header patching is left to `finalize()`
alone, **a capture whose process did not shut down gracefully stays a size=0 placeholder that
standard tools cannot open**. In the measurement recorded in WORK_LOG 6.416, the WAV left behind
by an E2E run carried 2.29MB of data under RIFF size=36 / data size=0, and macOS `afinfo` read it
as `estimated duration: 0.000000 sec` (`CaptureWriter::Drop` had not run).

The fix is to re-patch the header to the real size about once per second.

```rust
// rust/crates/orbit-audio-native/src/capture.rs:28-35
/// header の size を patch し直す間隔（サンプル数）。48kHz stereo で約 1 秒。
///
/// 🔴 `finalize` だけに任せると、**プロセスが graceful に落ちなかった capture は
/// size=0 の placeholder のまま残り、標準ツールで開けない**（2026-08-29 実測: E2E が
/// 残した WAV は RIFF size=36 / data size=0 で 2.29MB のデータを抱えていた。
/// `CaptureWriter::Drop` が走っていなかった）。capture は検証の一次資料なので、
/// **いつ落ちてもその時点まで有効な WAV** になるよう定期的に patch する。
const HEADER_SYNC_INTERVAL_SAMPLES: u64 = 48_000 * 2;
```

```rust
// rust/crates/orbit-audio-native/src/capture.rs:81-102
    /// header の size を「いまここまで書けた」値へ patch し、書き込み位置を末尾へ戻す。
    ///
    /// [`Self::finalize`] と違い `self` を消費しないので、drain ループの途中から何度でも
    /// 呼べる。目的は**プロセスが異常終了しても開ける WAV を残すこと**（[`HEADER_SYNC_INTERVAL_SAMPLES`]）。
    /// seek は BufWriter を flush してから inner を動かす（std documented）ので、
    /// 追記位置は `SeekFrom::End(0)` で正しく復元できる。
    pub fn sync_header(&mut self) -> io::Result<()> {
        // 🔴 **先に flush する。** `data_bytes()` は `samples_written` から計算するが、
        // `write` は **BufWriter へ渡した時点で**カウンタを進める。flush しないと、header が
        // 「ディスク上にまだ無いバイト」を指す WAV になる — `kill -9` されたとき（まさにこの
        // 機構が対象にしている状況）に **data チャンクが EOF を越える**。厳密なリーダは拒否する。
        // 毎秒 1 回なのでバッチングへの実害は無い。
        self.writer.flush()?;

        // 🔴 位置は `seek` で動かさない。`BufWriter::seek` は内部バッファを強制 flush してから
        // inner を動かすので、往復するたびに書き込み位置の管理が絡む。`write_at`（pwrite 相当）は
        // **ファイルのカーソルを動かさない**ので、追記は素直に進んだまま header だけを上書きできる
        // （macOS 限定プロジェクトなので `std::os::unix` は使える）。
        use std::os::unix::fs::FileExt;
        let header = build_header(self.sample_rate, self.channels, self.data_bytes());
        self.writer.get_ref().write_all_at(&header, 0)
    }
```

The comments spell out two things to be careful about.

1. **Flush first.** `samples_written` advances the moment bytes are handed to the `BufWriter`, so
   writing the header without flushing produces a WAV whose header points at "bytes not yet on
   disk" — and the moment the process is `kill -9`ed, the data chunk extends past EOF.
2. **Do not move the position with `seek`.** `BufWriter::seek` flushes its internal buffer before
   moving the inner file, so every round trip entangles the write-position bookkeeping.
   `write_all_at` (the `pwrite` equivalent) does not move the file cursor, so appending proceeds
   untouched while only the header is overwritten (the project is macOS-only, so `std::os::unix`
   is available).

## `CaptureWriter`: an off-thread writer that drains outside the RT callback

`CaptureWriter::create` creates the WAV writer and a `RingTapSink`, and
spawns a background thread that drains the ring and performs the writes. The
RT callback only calls `RingTapSink::commit` (wait-free); the actual file
I/O completes entirely outside the audio thread. Inside the drain loop is the call to
`sync_header` seen above.

```rust
// rust/crates/orbit-audio-native/src/capture.rs:186-256
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
            let mut last_header_sync: u64 = 0;
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
// ...
                samples_written += (a.len() + b.len()) as u64;
                chunk.commit_all();
                // 異常終了に備えて header を追いつかせる。
                //
                // 🔴 **失敗しても drain を止めない。** patch は「途中で落ちても開ける」ための
                // best-effort であり、**音声データの正しさには影響しない**。ここで `break` すると
                // 1 回の一時的な失敗で**以降の音声が一切録れなくなる** — capture を検証の一次資料
                // にするという本来の目的を、その保険が壊すことになる。
                //
                // 失敗は握り潰さず operator へ 1 行報告する（off-thread なので RT 契約に触れない）。
                // 最後に `finalize` が同じ patch を試みるので、一時的な失敗はそこで回復しうる。
                if samples_written - last_header_sync >= HEADER_SYNC_INTERVAL_SAMPLES {
                    last_header_sync = samples_written;
                    if let Err(e) = wav.sync_header() {
                        eprintln!(
                            "[capture] periodic WAV header sync failed (recording continues; \
                             the file may not open until finalize): {e}"
                        );
                    }
                }
            };
            // drain の成否に関わらず header を実サイズへ patch する(best-effort)。write error が
            // あればそれを優先して返し、無ければ finalize 自体の失敗を返す。
            let finalized = wav.finalize();
            match (drain, finalized) {
                (Ok(()), Ok(())) => Ok(samples_written),
                (Err(e), _) => Err(e),
                (Ok(()), Err(e)) => Err(e),
            }
        });
```

`break Err(e)` is followed by an unconditional call to `finalize()` — this
is the silent-failure guard. An early return would leave the header at its
placeholder (`data=0`), producing a corrupt WAV; a best-effort finalize
reflects "however much was written" in the header instead.

What is interesting is how a failed `sync_header` is treated: **the drain does not stop.** The
patch is insurance so that the file opens even after a crash; it has no bearing on the
correctness of the audio data, so a `break` here would let one transient failure prevent any
further audio from being recorded — the insurance would destroy the very purpose it protects.
Failures are not swallowed: one line goes to stderr, and the final `finalize` attempts the same
patch again.

On the `OutputStream` side, the `_capture` field is declared **after**
`_stream`, exploiting Rust's declaration-order field drop to structurally
guarantee the sequence "stream stops (callback stops) → writer drains
remaining ring contents and finalizes".

```rust
// rust/crates/orbit-audio-native/src/output.rs:529-538
/// 生きている間はストリームを保持する RAII ハンドル。
pub struct OutputStream {
    _stream: Stream,
    /// capture seam（#307 realtime）: `ORBIT_CAPTURE_WAV` 有効時のみ `Some`。**`_stream` より後に
    /// 宣言する**ことで drop 順を「stream 停止（callback 停止＝以後 commit なし）→ writer が ring の
    /// 残りを drain して WAV を finalize」に固定する（Rust は struct field を宣言順に drop する）。
    _capture: Option<crate::capture::CaptureWriter>,
    render_state: Arc<std::sync::Mutex<RenderState>>,
    pub device_name: String,
    pub sample_rate: u32,
```

## "Objective verification" in practice: the gated test's drops assert + oracle agreement

The pattern for verifying with the capture seam is concentrated in the
gated tests (`--ignored`, needs a real output device) under
`rust/crates/orbit-audio-daemon/tests/`. `capture_realtime_gated.rs` (a
realtime parity check for #304's examples22) is a representative example:

```rust
// rust/crates/orbit-audio-daemon/tests/capture_realtime_gated.rs:208-219
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
// rust/crates/orbit-audio-daemon/tests/capture_realtime_gated.rs:104-111
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

## E2E looks at the capture "numerically" — the master fader of #643

How much an E2E that asserts the capture WAV's RMS numerically is worth was demonstrated by #643
on 2026-08-29. `global.gain()` had no effect on instruments at all: the sound merging from the
mixer's stages into master was being added **after** the master gain was applied (WORK_LOG
6.415). Every layer returned success and not a single ERROR line appeared, so the logs could not
catch it. 2149 unit tests and 35 mutation checks passed. **Only the E2E that measured the RMS of
the capture WAV** caught it.

Out of that experience, `tests/e2e/gated-assertion-hygiene.spec.ts` turns red on "a test that
captures but never looks at rms", and `tests/e2e/dsl-e2e-coverage.spec.ts` turns red on "a DSL
word was added without an E2E" — ratchets that accompany the discipline in CLAUDE.md.

## How the real-hardware E2E refuses to run a stale binary (#651)

Right after it was implemented, the header fix of #651 was observed "not working" in the
real-hardware E2E. The cause was not a bug in the fix but the fact that **the E2E was using an
old daemon built at 17:49** (WORK_LOG 6.417). The extension bundles the daemon under
`<extension>/engine/bin/<platform>/`, and that copy is refreshed by `npm run build`'s
`build:copy-engine`, not by `cargo build`.

The countermeasure has two stages. First, `tests/e2e/orbitstudio-mcp-gated.spec.ts` carries a
check at **module load time** of a gated run: if the daemon binary that will actually be spawned
(`resolveDaemonBinaryPath()` is the source of truth) is older than the `.rs` | `Cargo.toml` files
under `rust/`, it fails before running a single test. Some directories are excluded from that
walk, which the next subsection covers (#713).

```typescript
// tests/e2e/orbitstudio-mcp-gated.spec.ts:166-180
        walk(full)
      } else if (entry.name.endsWith('.rs') || entry.name === 'Cargo.toml') {
        const at = fs.statSync(full).mtimeMs
        if (at > newest.at) newest = { at, file: full }
      }
    }
  }
  walk(path.join(REPO_ROOT, 'rust'))
  if (newest.at > builtAt) {
    throw new Error(
      'gated E2E: the daemon binary is older than the Rust sources, so this run would measure ' +
        `stale code.\n  newest source: ${path.relative(REPO_ROOT, newest.file)}\n` +
        `  binary:        ${new Date(builtAt).toISOString()}\n` +
        `  source:        ${new Date(newest.at).toISOString()}\n` +
        'Rebuild before running (npm run test:e2e:gated does this for you):\n' +
```

Second, `package.json` gained `pretest:e2e:gated`, so that `npm run test:e2e:gated` makes npm run
cargo build + `npm run build` **first, unconditionally** (the owner's call: "once the procedure
is reliable, make it not manual").

```jsonc
// package.json:17-17
    "test": "npm -w @orbitscore/engine test",
```

The mtime comparison is a weaker judgment than "is the rebuild a no-op", but it finishes in 1ms
before the tests start; the weakness is tilted toward "when in doubt, fail" (equal timestamps
pass).

### What the walk leaves out — never look at a target it cannot rebuild (#713)

That "when in doubt, fail" had a pitfall. Because the walk picked up every `.rs` under `rust/`
unconditionally, an **integration test** such as
`rust/crates/orbit-vst3-host/tests/spike_s_concurrent_load.rs` could be selected as the "newest
source". An integration test is a separate cargo target and never enters the dependency graph of
the `orbit-audio-daemon` binary. So cargo correctly reads its dependencies, builds nothing
(`Finished release profile in 0.21s`), and the binary's mtime is never refreshed. The result was
an **unfixable red**: running `npm run test:e2e:gated`, precisely what the guard's own message
instructs, could not clear it.

The trigger is a property of mtime. `git checkout` sets a file's mtime to the checkout time, so
merely moving between branches turns an unrelated integration test — one whose content never
changed — into the "newest source". As measured in #713, the gated suite stopped running a single
test at startup.

So three directories, `tests` / `benches` / `examples`, were dropped from the walk.

```typescript
// tests/e2e/orbitstudio-mcp-gated.spec.ts:161-165
        // ⚠️ **`src/` は除外しない。** daemon が依存するコードが新しければ、
        // ガードは本来の役目どおり赤くなるべきである（CLAUDE.md「実機テストは最新ビルドで走る」）。
        if (entry.name === 'tests' || entry.name === 'benches' || entry.name === 'examples') {
          continue
        }
```

The one reason they may be dropped — "a separate target, so it never enters the daemon binary" —
is not a reason to drop `src/`. If code the daemon depends on is newer, the guard should go red;
that is its job. The line is pinned from both sides by two checks in
`tests/e2e/gated-assertion-hygiene.spec.ts`: red if the exclusion disappears, red if `src` gets
excluded too.

Both checks, however, only scan the **source text** of the gated spec, so what they guarantee
stops at "it is written that way". The guard itself, `assertDaemonBinaryIsNotStale()`, runs only
when `gated && appAvailable`, so an ordinary `npm test` never executes a line of it. It is
accurate to read this as a device that pins the *written shape*, not an *executed behaviour*.

## The engine's own peak log: `post_peak_bits`

Separately from the capture WAV, the engine also keeps its own running
post-mix peak at the daemon layer, stored as an `AtomicU32` (f32 bits). This
is a lock-free `fetch_max` implementation that relies on non-negative f32
bit representations preserving numeric ordering; instrument and effect each have their own
dedicated field (`outproc_instrument.rs::OutProcInstrumentStats.post_peak_bits` /
`outproc_effect.rs::OutProcEffectStats.post_peak_bits`). Gated tests read
this via accessors such as `engine.outproc_instrument_post_peak()`, and it
can be used as a double-check against the measured peak of a WAV recorded
via `ORBIT_CAPTURE_WAV`.

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
   automatically; for manual runs, call `guard.capture_drops()` or check the `[capture]` lines on
   stderr. `eprintln!` does not reach the MCP `get_log`, so stderr must be read directly — WORK_LOG
   6.417 records a case of misreading "empty observation" as "the event did not happen").
3. Load the recorded WAV and measure peak/RMS (using
   `orbit-audio-verify`'s primitives such as `region_rms` /
   `detect_onset_threshold`, or an external tool like `soxi`/`ffprobe`/`afinfo` for a
   quick sanity check). Since #651, the WAV up to that point should open even if the daemon is
   killed midway.
4. If possible, read the engine's `post_peak`-family accessor (equivalent to
   `outproc_instrument_post_peak`) during the same session and compare it
   against the capture WAV's measured peak.

**Expected value (cross-verified on real hardware, 2026-07-17)**: since the tap point is the
same `hw` (post-mix, after the post-processor), the two must agree. Measured example: against
the same clap-test-synth oracle (known amplitude 0.25), the gated tests' stats-side
`post_mix_peak` = **0.25000** (`outproc_instrument_vst3_gated` etc.) and the DSL E2E's
measured capture-WAV peak = **0.25000** (WORK_LOG 6.258) — two independent measurement paths
agreeing with the known amplitude to five digits, demonstrating that capture and the
post-peak accessors observe the same signal. These figures were not re-measured during the
2026-09-01 re-read.

## Next exploration candidates

- The list of conditions `tests/e2e/gated-assertion-hygiene.spec.ts` names as red, and the incidents behind each
- The implementation of `orbit-audio-verify`'s primitives (`region_rms` / `detect_onset_threshold` / pan back-calculation)
- What `CaptureWriter::finish` is for in capture mode B (per-play, follow-on)
- The resolution order of `resolveDaemonBinaryPath()` (explicit → env → monorepo-release → monorepo-debug → extension-bundle)

## Sources

- `rust/crates/orbit-audio-native/src/output.rs:222-233,662-707` — `CAPTURE_RING_SECONDS` / `OutputStream` (drop-order guarantee for the `_capture` field) / `render_block_with_sources` (location of the capture tap)
- `rust/crates/orbit-audio-native/src/capture.rs:21-35` — constants (`HEADER_SYNC_INTERVAL_SAMPLES` and the #651 background)
- `rust/crates/orbit-audio-native/src/capture.rs:37-127` — `RiffWavWriter` (32-bit float, no external crate, `sync_header`, `data_bytes`, `finalize`)
- `rust/crates/orbit-audio-native/src/capture.rs:186-256` — `CaptureWriter::create` (off-thread drain loop, periodic header patch, best-effort finalize)
- `rust/crates/orbit-audio-daemon/tests/capture_realtime_gated.rs:1-23` — capture seam realtime gated test's module doc comment (purpose, how to run)
- `rust/crates/orbit-audio-daemon/tests/capture_realtime_gated.rs:99-111` — WAV header vs. physical size cross-check (silent-failure guard)
- `rust/crates/orbit-audio-daemon/tests/capture_realtime_gated.rs:206-217` — `drops == 0` assertion (pre-teardown silent-failure guard)
- `rust/crates/orbit-audio-daemon/src/outproc_instrument.rs:232-234` — `post_peak_bits` (lock-free peak accumulation implementation)
- `tests/e2e/orbitstudio-mcp-gated.spec.ts:80-154` — the stale artifact guard (`assertDaemonBinaryIsNotStale`)
- `package.json:17-18` — `pretest:e2e:gated` / `test:e2e:gated`
- [`docs/archive/WORK_LOG_2026-08.md`](https://github.com/signalcompose/orbitscore/blob/main/docs/archive/WORK_LOG_2026-08.md) 6.415 / 6.416 / 6.417 — discovery of the #643 master fader defect, the #651 header patch and stale guard, pretest automation
- Issue [#307](https://github.com/signalcompose/orbitscore/issues/307) — capture seam realtime wiring
- Issue [#651](https://github.com/signalcompose/orbitscore/issues/651) — capture WAV that opens after an abnormal exit, and the stale-binary countermeasure
- Issue [#713](https://github.com/signalcompose/orbitscore/issues/713) — excluding cargo targets that can never be rebuilt from the walk
