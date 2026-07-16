---
title: "RE-4. capture seam と客観検証（ORBIT_CAPTURE_WAV）"
chapter-id: "RE-4"
verified-against: 3983828
verified-at: "2026-07-17"
status: draft
---

> **Note**: 本ページは 2026-07-17 時点での著者の reading の足跡です。code が真実、本ページはその時点の理解の snapshot に過ぎません。

# RE-4. capture seam と客観検証（ORBIT_CAPTURE_WAV）

OrbitScore の audio エンジンは「耳で聞く」以外の検証手段として **capture seam**
（Issue #307）を持つ。`ORBIT_CAPTURE_WAV` 環境変数を設定すると、master 出力
（post-mix・device 直前）を WAV ファイルへ実時間で録音でき、そのファイルを
`orbit-audio-verify` の解析プリミティブ（onset 検出・RMS・pan 逆算）に通して
DSL の意図と実サンプルの一致を客観的に検証できる。本章はこの経路の実装
（`capture.rs` の自作 RIFF WAV writer）と、実際にどう「耳なし検証」を組み立てる
かを追う。

## capture のタップ点: post-mix・pre-hardware

capture は `render_block` の中で post-processor（master-bus effect）適用**後**、
device に送る直前の `hw` バッファを読み取り専用でタップする。これは「実際に
デバイスへ出る最終信号」を録ることを意味し、capture の有無で出力サンプル自体は
変わらない（読むだけで mutation ではない）。

```rust
// rust/crates/orbit-audio-native/src/output.rs:226-273（該当部分抜粋）
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

タップは `RingTapSink::commit` という wait-free / no-alloc な操作で行われ、
リングが満杯なら drop カウントで検出する（RT 契約を守りつつ off-thread writer
が追いつかない場合を可視化する）。

## `RiffWavWriter`: 外部依存なしの自作 32-bit float WAV encoder

owner 確定方針（hound 等の外部 WAV encoder crate は追加しない）に基づき、
`capture.rs` は `std::io` のみで RIFF WAV を書く。`wFormatTag = 3`
(`WAVE_FORMAT_IEEE_FLOAT`) を使うため量子化なし・録った f32 がそのまま
round-trip する。

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

サイズが確定しない問題（streaming write の間はファイル総サイズが未知）は
「0 の placeholder header を先に書き、`finalize()` で先頭に seek して実サイズを
patch する」という定石で解決している。`finalize` は `self` を値で消費するため、
二重 finalize は型で防止される。

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

4GiB を超える capture は u32 size field の限界で正しく表現できない（RF64 拡張は
未対応）が、その場合も saturating で壊れた header にはしない、という明示的な
既知制限がコメントされている。

## `CaptureWriter`: RT callback の外で drain する off-thread writer

`CaptureWriter::create` は WAV writer と `RingTapSink` を生成し、background
thread を spawn して ring を drain・書き込みを行う。RT callback は
`RingTapSink::commit`（wait-free）のみを呼び、実際のファイル I/O は audio
thread の外で完結する。

```rust
// rust/crates/orbit-audio-native/src/capture.rs:145-211（抜粋・drain ループ本体）
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
                // ...（read_chunk・書き込み・commit_all）
            };
            let finalized = wav.finalize();
            match (drain, finalized) {
                (Ok(()), Ok(())) => Ok(samples_written),
                (Err(e), _) => Err(e),
                (Ok(()), Err(e)) => Err(e),
            }
        });
```

drain ループが write error に遭遇しても即 return せず、`break Err(e)` の後
必ず `finalize()` を呼ぶ点が silent-failure ガードになっている — 途中で
早期 return すると header が placeholder（`data=0`）のまま残って壊れた WAV
になるため、best-effort で「書けた分」を header に反映する。

`OutputStream` 側は `_capture` フィールドを `_stream` より後に宣言することで、
Rust の struct field 宣言順 drop を利用し「stream 停止（callback 停止）→
writer が ring 残りを drain して finalize」という順序を構造的に保証している。

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

## 「客観検証」の実際: gated test の drops assert + oracle 一致

capture seam を使った検証の型は `rust/crates/orbit-audio-daemon/tests/`
配下の gated test（`--ignored` 付き・実 output device 要）に集約されている。
`capture_realtime_gated.rs`（#304 examples22 の realtime parity 検証）は
その代表例:

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

「客観検証の作法」はここに凝縮されている:

1. **teardown 前に `drops == 0` を assert** — off-thread writer が ring から
   取りこぼしていないことを検証前に固定する。`drops > 0` なら以降の全ての
   検証は無意味（録音自体が壊れている）。
2. **WAV header と物理サイズの突き合わせ** — `finalize()` の header patch が
   失敗（例: disk full）すると header は placeholder のまま残るが、PCM 本体
   自体は物理的に存在してしまう。header の `data` チャンク size と実ファイル
   長を突き合わせないと、壊れた WAV でも PCM 読み取り自体は成功し偽陽性の
   parity が出る:

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

3. **onset 検出でアンカーを取ってから相対位置で窓を取る** — device 起動
   latency で WAV 先頭が transport 0 とはずれるため、検出した最初の onset
   フレームを基準に、各イベントの相対位置で RMS 窓を切る（絶対時刻での
   比較は device latency の分だけ必ずずれる）。
4. **pan は L/R RMS から逆算し、schedule の pan 値と許容誤差内か判定** —
   厳密な gain dB 比較は同一サンプルを使う offline `per_event_gain` fixture
   に譲り、realtime capture は「領域に信号がある」「pan が合っている」の
   2 点を担う分業になっている。

## エンジン自身の peak ログ: `post_peak_bits`

capture WAV とは別に、エンジンは daemon 層で自分自身の post-mix peak を
`AtomicU32`（f32 bits）として保持し続けている。これは非負 f32 の bit 表現が
値の大小と一致することを利用した lock-free な `fetch_max` 実装で、CLAP/VST3
の instrument/effect それぞれに専用のフィールドがある
（`outproc_instrument.rs::ClapInstrumentStats.post_peak_bits` /
`outproc_effect.rs::OutProcEffectStats.post_peak_bits` に相当）。gated test は
これを `engine.outproc_instrument_post_peak()` 等のアクセサ経由で読み、
`ORBIT_CAPTURE_WAV` で録った WAV の実測 peak と突き合わせる二重チェックに
使える（本ページでは field 名の存在を `grep` で確認したのみで、capture WAV
の実測 peak と daemon ログの `post_peak` を実機で突き合わせる検証コマンドは
「Try it」節で手順として記すが、両者が厳密一致することの実機再確認はしていない）。

## Try it: capture → peak 突き合わせループ

1. daemon を `ORBIT_CAPTURE_WAV=<path>.wav` を設定して起動する:

```bash
ORBIT_CAPTURE_WAV=/tmp/orbit-capture.wav cargo test -p orbit-audio-daemon \
  --test capture_realtime_gated -- --ignored --nocapture
```

（このテストは自身で `ORBIT_CAPTURE_WAV` を一意な temp path にセットするので、
上記のように外部から指定しても内部で上書きされる。手動で任意の DSL セッション
に対して capture したい場合は、daemon 起動前に `ORBIT_CAPTURE_WAV` を export
してから通常の `RUN` フローを実行する。）

2. teardown 後、`drops == 0` を確認する（gated test は自動 assert、手動運用
   では `guard.capture_drops()` を呼ぶか、ログの `LINK_EGRESS_DROP` 系
   warning が出ていないか確認する）。
3. 録れた WAV をロードして peak / RMS を計測する（`orbit-audio-verify` の
   `region_rms` / `detect_onset_threshold` 等のプリミティブ、もしくは
   `soxi`/`ffprobe` 等の外部ツールで簡易確認）。
4. 可能ならエンジン側の `post_peak` 系アクセサ（`outproc_instrument_post_peak`
   相当）を同じセッションで読み、capture WAV の実測 peak と比較する。

**期待値（実機で相互検証済み・2026-07-17）**: tap 点が同じ `hw`（post-mix・post 適用後）
である以上、両者は一致する。実測例: clap-test-synth（既知振幅 0.25）の同一 oracle に対し、
gated テストの stats 側 `post_mix_peak` = **0.25000**（`outproc_instrument_vst3_gated` 等）、
DSL E2E の capture WAV 実測 peak = **0.25000**（WORK_LOG 6.258）— 独立した 2 計測経路が
既知振幅と 5 桁一致しており、capture と post_peak 系アクセサが同じ信号を見ていることの
実証になっている。

## Sources

- `rust/crates/orbit-audio-native/src/output.rs:226-273` — `render_block`（capture タップの位置と opt-in 分岐の説明）
- `rust/crates/orbit-audio-native/src/output.rs:101-110` — `OutputStream`（`_capture` フィールドの drop 順保証）
- `rust/crates/orbit-audio-native/src/capture.rs:29-56` — `RiffWavWriter` 構造体（32-bit float・外部 crate 不使用）
- `rust/crates/orbit-audio-native/src/capture.rs:73-90` — `RiffWavWriter::finalize`（size patch・4GiB 制限）
- `rust/crates/orbit-audio-native/src/capture.rs:145-211` — `CaptureWriter::create`（off-thread drain ループ・best-effort finalize）
- `rust/crates/orbit-audio-daemon/tests/capture_realtime_gated.rs:1-23` — capture seam realtime gated test のモジュールコメント（役割・実行方法）
- `rust/crates/orbit-audio-daemon/tests/capture_realtime_gated.rs:99-111` — WAV header/物理サイズ突き合わせ（silent-failure ガード）
- `rust/crates/orbit-audio-daemon/tests/capture_realtime_gated.rs:206-217` — `drops == 0` assert（teardown 前の silent-failure ガード）
- `rust/crates/orbit-audio-daemon/src/outproc_instrument.rs:193-205` — `post_peak_bits`（lock-free peak 累積の実装）
- [`docs/development/WORK_LOG.md`](https://github.com/signalcompose/orbitscore/blob/main/docs/development/WORK_LOG.md) — capture seam #307 realtime 設計の経緯（daemon-start config・自作 WAV writer 採用の owner 確定）
- Issue [#307](https://github.com/signalcompose/orbitscore/issues/307) — capture seam realtime 配線
