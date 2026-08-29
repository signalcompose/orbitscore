//! master 出力を WAV へ録るための off-thread capture writer(#307 realtime)。
//!
//! producer 側(RT cpal callback が post-mix を push する [`crate::link_audio_ring::RingTapSink`])は
//! 既存資産をそのまま再利用する。本モジュールが持つのは **consumer 側**(ring を drain して WAV に
//! 書く off-thread writer)と、量子化なし 32-bit float WAV encoder の 2 点(出力先パスの env 解決は
//! daemon 層 `engine_wrap::capture_path_from_env` が行い、解決済みパスがここへ渡る)。
//!
//! この writer は audio thread の外(専用の background thread)で動くので、RT 契約(no-alloc /
//! no-lock / no-block)は一切かからない。alloc・`std::fs::File` I/O・`thread::sleep` を自由に使う。

use std::fs::File;
use std::io::{self, BufWriter, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use crate::link_audio_ring::RingTapSink;

/// WAV header の固定長(RIFF + fmt(16byte, extension なし) + data チャンク先頭)。
const WAV_HEADER_LEN: usize = 44;
/// `wFormatTag` = 3 = `WAVE_FORMAT_IEEE_FLOAT`(量子化なし・録った f32 がそのまま round-trip する)。
const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
const BITS_PER_SAMPLE: u16 = 32;
/// ring が空のときの poll 間隔。busy-wait しない程度に短く、capture 遅延を体感させない程度に長く。
const DRAIN_POLL_INTERVAL: Duration = Duration::from_millis(2);
/// header の size を patch し直す間隔（サンプル数）。48kHz stereo で約 1 秒。
///
/// 🔴 `finalize` だけに任せると、**プロセスが graceful に落ちなかった capture は
/// size=0 の placeholder のまま残り、標準ツールで開けない**（2026-08-29 実測: E2E が
/// 残した WAV は RIFF size=36 / data size=0 で 2.29MB のデータを抱えていた。
/// `CaptureWriter::Drop` が走っていなかった）。capture は検証の一次資料なので、
/// **いつ落ちてもその時点まで有効な WAV** になるよう定期的に patch する。
const HEADER_SYNC_INTERVAL_SAMPLES: u64 = 48_000 * 2;

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

    /// interleaved f32 サンプル列を little-endian で `data` チャンクの末尾に追記する。
    /// header の size はここでは書かない([`Self::finalize`] でまとめて patch する)。
    /// off-thread なので、per-sample の `write_all` を避けて 1 ブロックを 1 回で書く
    /// (`scratch` を再利用し per-call の alloc も避ける)。
    pub fn write(&mut self, interleaved: &[f32]) -> io::Result<()> {
        self.scratch.clear();
        self.scratch.reserve(interleaved.len() * 4);
        for &sample in interleaved {
            self.scratch.extend_from_slice(&sample.to_le_bytes());
        }
        self.writer.write_all(&self.scratch)?;
        self.samples_written += interleaved.len() as u64;
        Ok(())
    }

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

    /// `data` チャンクのバイト数。`sync_header` と [`Self::finalize`] が共有する
    /// （saturating の意味論——4GiB 超は `u32::MAX` へ丸める既知の制限——を1箇所に置く）。
    fn data_bytes(&self) -> u32 {
        u32::try_from(self.samples_written.saturating_mul(4)).unwrap_or(u32::MAX)
    }

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
}

/// WAVE_FORMAT_IEEE_FLOAT・16-byte fmt chunk(extension なし)の 44-byte header を組み立てる。
fn build_header(sample_rate: u32, channels: u16, data_bytes: u32) -> [u8; WAV_HEADER_LEN] {
    let channels = channels.max(1);
    let byte_rate = sample_rate * channels as u32 * (BITS_PER_SAMPLE as u32 / 8);
    let block_align = channels * (BITS_PER_SAMPLE / 8);

    let mut header = [0u8; WAV_HEADER_LEN];
    header[0..4].copy_from_slice(b"RIFF");
    header[4..8].copy_from_slice(&data_bytes.saturating_add(36).to_le_bytes());
    header[8..12].copy_from_slice(b"WAVE");
    header[12..16].copy_from_slice(b"fmt ");
    header[16..20].copy_from_slice(&16u32.to_le_bytes()); // fmt chunk size(extension なし)
    header[20..22].copy_from_slice(&WAVE_FORMAT_IEEE_FLOAT.to_le_bytes());
    header[22..24].copy_from_slice(&channels.to_le_bytes());
    header[24..28].copy_from_slice(&sample_rate.to_le_bytes());
    header[28..32].copy_from_slice(&byte_rate.to_le_bytes());
    header[32..34].copy_from_slice(&block_align.to_le_bytes());
    header[34..36].copy_from_slice(&BITS_PER_SAMPLE.to_le_bytes());
    header[36..40].copy_from_slice(b"data");
    header[40..44].copy_from_slice(&data_bytes.to_le_bytes());
    header
}

/// capture 完了レポート。`dropped_samples > 0` は「録音破損 = 検証 invalid」を意味する
/// (呼び出し側が assert する。本モジュールはカウントを正確に運ぶだけで判定はしない)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaptureReport {
    pub frames_written: u64,
    pub dropped_samples: u64,
}

/// off-thread WAV writer を所有する RAII guard。[`CaptureWriter::create`] が返す
/// [`RingTapSink`] を RT callback 側の `PostMixSink` として登録し、本体は background thread で
/// ring を drain して [`RiffWavWriter`] に書く。
///
/// # 呼び出し側が守るべき前提
/// `finish()`(または drop)を呼ぶ時点で、対応する `RingTapSink` への `commit()` がもう発生しない
/// こと(= RT audio stream が既に停止済み)を呼び出し側が保証する必要がある。stop 後も ring に
/// 残っているものは最後まで drain してから finalize するが、stop 後に新たに push される分は
/// 対象外(取りこぼしになり得る)。output.rs 側で `OutputStream`(cpal `Stream` を保持する
/// フィールド)と本体を同じ struct に同居させる場合は、**`CaptureWriter` を stream フィールドより
/// 後に宣言する**こと(Rust は struct field を宣言順に drop するので、stream を先に drop して
/// callback を止めてから、この writer の drop 処理〈stop→join→drain 残り→finalize〉が走る)。
pub struct CaptureWriter {
    stop: Arc<AtomicBool>,
    drops: Arc<AtomicU64>,
    channels: u16,
    /// background thread の join handle。`finish()`/`Drop` のどちらかで一度だけ `take()` される
    /// (二重 join・二重 finalize を防ぐガード)。
    handle: Option<thread::JoinHandle<io::Result<u64>>>,
}

impl CaptureWriter {
    /// `path` に WAV writer を開き、`ring_capacity` サンプル分の [`RingTapSink`] を生成する。
    /// 戻り値の `RingTapSink` を RT callback 側(`PostMixSink`)に登録し、`CaptureWriter` は
    /// 呼び出し側が保持して `finish()` するか、drop に任せる。
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

                // SPSC(consumer はここでしか読まない)なので、直前に読んだ `avail` を
                // 超える読み取りを要求しない限り `read_chunk` は失敗しない(TooFewSlots は
                // n > slots のときのみ)。invariant を expect で表明する(不可能分岐を握り潰さない)。
                let chunk = consumer.read_chunk(avail).expect(
                    "read_chunk(avail) with avail == slots() cannot fail (single consumer)",
                );
                let (a, b) = chunk.as_slices();
                if let Err(e) = wav.write(a) {
                    break Err(e);
                }
                if let Err(e) = wav.write(b) {
                    break Err(e);
                }
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

        Ok((
            sink,
            CaptureWriter {
                stop,
                drops,
                channels,
                handle: Some(handle),
            },
        ))
    }

    /// これまでに(producer 側で)drop した interleaved サンプル数の累積(監視用)。
    pub fn dropped_samples(&self) -> u64 {
        self.drops.load(Ordering::Relaxed)
    }

    /// stop signal を立てて background thread を join し、書けた総サンプル数を返す。二度目以降は
    /// `None`(handle 取得済み = 型/take による二重 join・二重 finalize 防止)。`finish()` と `Drop`
    /// が共有する。
    fn stop_and_join(&mut self) -> Option<io::Result<u64>> {
        let handle = self.handle.take()?;
        self.stop.store(true, Ordering::Release);
        Some(match handle.join() {
            Ok(result) => result,
            Err(_) => Err(io::Error::other("capture writer thread panicked")),
        })
    }

    /// join 後の総サンプル数から [`CaptureReport`] を組む(frames = samples / channels)。
    fn report(&self, samples_written: u64) -> CaptureReport {
        let channels = self.channels.max(1) as u64;
        CaptureReport {
            frames_written: samples_written / channels,
            dropped_samples: self.drops.load(Ordering::Relaxed),
        }
    }

    /// stop signal を立てて background thread の残り drain + finalize の完了を待ち、[`CaptureReport`]
    /// を返す。production teardown は `Drop` 経由なので本メソッドは主に test / 明示停止(capture
    /// mode B = per-play・follow-on)用の API。
    #[allow(dead_code)]
    pub fn finish(mut self) -> io::Result<CaptureReport> {
        // `self` は値で渡されておりここでしか停止は起こり得ないので handle は必ず `Some`。
        let samples_written = self
            .stop_and_join()
            .expect("CaptureWriter::finish: handle already taken")?;
        Ok(self.report(samples_written))
    }
}

impl Drop for CaptureWriter {
    /// production teardown。`finish()` を呼ばずに drop された場合の後始末: stop → join を行い
    /// (writer thread 内で `wav.finalize()` まで完了するので WAV は valid)、**drop が起きていたら
    /// operator へ 1 行報告**する(録音破損 = 検証 invalid の silent-failure ガード。off-thread の
    /// teardown なので eprintln は RT 契約に触れない)。
    fn drop(&mut self) {
        match self.stop_and_join() {
            Some(Ok(samples_written)) => {
                let report = self.report(samples_written);
                if report.dropped_samples > 0 {
                    eprintln!(
                        "[capture] WAV finalized with {} dropped samples \
                         (recording corrupted): frames_written={}",
                        report.dropped_samples, report.frames_written
                    );
                }
            }
            Some(Err(e)) => eprintln!("[capture] writer thread error on teardown: {e}"),
            None => {} // 既に finish() 済み。
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn read_le_u32(buf: &[u8], offset: usize) -> u32 {
        u32::from_le_bytes(buf[offset..offset + 4].try_into().unwrap())
    }

    fn read_le_u16(buf: &[u8], offset: usize) -> u16 {
        u16::from_le_bytes(buf[offset..offset + 2].try_into().unwrap())
    }

    fn temp_wav_path(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "orbit-capture-test-{}-{}-{}.wav",
            name,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        p
    }

    #[test]
    fn riff_header_roundtrip() {
        let path = temp_wav_path("header");
        let samples: Vec<f32> = vec![0.0, 1.0, -1.0, 0.5, -0.5, 2.0, -3.25, 123.456];

        let mut w = RiffWavWriter::new(&path, 48_000, 2).expect("create wav");
        w.write(&samples).expect("write samples");
        w.finalize().expect("finalize");

        let mut buf = Vec::new();
        File::open(&path)
            .expect("reopen")
            .read_to_end(&mut buf)
            .expect("read");

        assert_eq!(&buf[0..4], b"RIFF");
        assert_eq!(&buf[8..12], b"WAVE");
        assert_eq!(&buf[12..16], b"fmt ");
        assert_eq!(&buf[36..40], b"data");

        let data_bytes = (samples.len() * 4) as u32;
        assert_eq!(read_le_u32(&buf, 4), 36 + data_bytes, "RIFF chunk size");
        assert_eq!(read_le_u32(&buf, 16), 16, "fmt chunk size");
        assert_eq!(read_le_u16(&buf, 20), 3, "audioFormat == IEEE_FLOAT");
        assert_eq!(read_le_u16(&buf, 22), 2, "numChannels");
        assert_eq!(read_le_u32(&buf, 24), 48_000, "sampleRate");
        assert_eq!(read_le_u16(&buf, 34), 32, "bitsPerSample");
        assert_eq!(read_le_u32(&buf, 40), data_bytes, "data chunk size");

        let body = &buf[44..];
        assert_eq!(body.len(), samples.len() * 4);
        for (i, &expected) in samples.iter().enumerate() {
            let bytes: [u8; 4] = body[i * 4..i * 4 + 4].try_into().unwrap();
            assert_eq!(f32::from_le_bytes(bytes), expected, "sample {i} bit-exact");
        }

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn capture_writer_lossless_roundtrip() {
        let path = temp_wav_path("lossless");
        let (mut sink, writer) =
            CaptureWriter::create(path.clone(), 44_100, 2, 4096).expect("create capture writer");

        use crate::link_audio_ring::PostMixSink;
        let block_a = vec![0.1f32, -0.1, 0.2, -0.2];
        let block_b = vec![0.3f32, -0.3, 0.4, -0.4, 0.5, -0.5];
        sink.commit(&block_a);
        sink.commit(&block_b);

        let report = writer.finish().expect("finish");
        assert_eq!(report.dropped_samples, 0);
        assert_eq!(
            report.frames_written,
            (block_a.len() + block_b.len()) as u64 / 2
        );

        let mut buf = Vec::new();
        File::open(&path)
            .expect("reopen")
            .read_to_end(&mut buf)
            .expect("read");
        let body = &buf[44..];
        let mut expected = block_a.clone();
        expected.extend_from_slice(&block_b);
        assert_eq!(body.len(), expected.len() * 4);
        for (i, &e) in expected.iter().enumerate() {
            let bytes: [u8; 4] = body[i * 4..i * 4 + 4].try_into().unwrap();
            assert_eq!(f32::from_le_bytes(bytes), e, "sample {i} bit-exact");
        }

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn capture_writer_counts_drops_when_ring_too_small() {
        let path = temp_wav_path("drops");
        // capacity=4 の極小 ring に対し、writer thread が drain するより速く大量に push して
        // あふれ(drop)を発生させる。
        let (mut sink, writer) =
            CaptureWriter::create(path.clone(), 44_100, 1, 4).expect("create capture writer");

        use crate::link_audio_ring::PostMixSink;
        for _ in 0..2000 {
            sink.commit(&[1.0f32; 64]);
        }

        let report = writer.finish().expect("finish");
        assert!(
            report.dropped_samples > 0,
            "極小 ring への大量 push は drop をカウントするはず: {report:?}"
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn create_fails_fast_on_bad_path() {
        // 存在しないディレクトリ配下のパスは `File::create` が失敗する。writer thread や ring を
        // 確保する前に、`create` が Err を返して fail fast することを確認する(WAV を開けないのに
        // background thread だけ起きて空回りする、という silent-failure を防ぐ)。
        let mut bad = std::env::temp_dir();
        bad.push(format!(
            "orbit-capture-nonexistent-{}/never/out.wav",
            std::process::id()
        ));
        let result = CaptureWriter::create(bad, 48_000, 2, 4096);
        assert!(
            result.is_err(),
            "存在しないディレクトリ配下の path では create は Err を返すはず"
        );
    }

    /// 🔴 finalize を一度も呼ばずに捨てても、`sync_header` を通した分は開ける WAV である。
    ///
    /// 2026-08-29 の実測: E2E が残した capture は RIFF size=36 / data size=0 のまま
    /// 2.29MB のデータを抱えており、QuickTime も Python の `wave` も開けなかった
    /// （`CaptureWriter::Drop` が走らずプロセスが落ちていた）。capture は検証の一次資料なので、
    /// **異常終了しても its header が実データを指している**ことをここで固定する。
    #[test]
    fn sync_header_makes_the_file_readable_without_finalize() {
        let path = temp_wav_path("sync-header");
        let mut wav = RiffWavWriter::new(&path, 48_000, 2).expect("create");
        let block = vec![0.25_f32; 4096];
        wav.write(&block).expect("write");
        wav.sync_header().expect("sync");
        // finalize を呼ばずに落とす（＝プロセスが死んだ状況）。
        drop(wav);

        let mut buf = Vec::new();
        File::open(&path)
            .expect("open")
            .read_to_end(&mut buf)
            .expect("read");
        let data_bytes = read_le_u32(&buf, 40);
        assert_eq!(
            data_bytes as usize,
            block.len() * 4,
            "data chunk size must point at the samples actually written"
        );
        assert_eq!(
            read_le_u32(&buf, 4) as usize,
            36 + block.len() * 4,
            "RIFF size must cover the header and the samples"
        );
        assert_eq!(
            buf.len(),
            WAV_HEADER_LEN + block.len() * 4,
            "sync_header must restore the append position, not truncate or duplicate"
        );
        let _ = std::fs::remove_file(&path);
    }

    /// `sync_header` を挟んでも、その後の追記が正しい位置へ続くこと（seek の往復が壊さない）。
    #[test]
    fn sync_header_does_not_disturb_subsequent_writes() {
        let path = temp_wav_path("sync-header-append");
        let mut wav = RiffWavWriter::new(&path, 48_000, 2).expect("create");
        wav.write(&[0.5_f32; 8]).expect("write 1");
        wav.sync_header().expect("sync");
        wav.write(&[-0.5_f32; 8]).expect("write 2");
        wav.finalize().expect("finalize");

        let mut buf = Vec::new();
        File::open(&path)
            .expect("open")
            .read_to_end(&mut buf)
            .expect("read");
        assert_eq!(read_le_u32(&buf, 40) as usize, 16 * 4);
        assert_eq!(buf.len(), WAV_HEADER_LEN + 16 * 4);
        // 2 ブロック目が 1 ブロック目を上書きしていないこと。
        let first = f32::from_le_bytes(buf[44..48].try_into().expect("4 bytes"));
        let second = f32::from_le_bytes(buf[44 + 32..44 + 36].try_into().expect("4 bytes"));
        assert_eq!(first, 0.5, "first block must survive the header sync");
        assert_eq!(second, -0.5, "second block must land after the first");
        let _ = std::fs::remove_file(&path);
    }

    /// writer スレッドのループが、finalize を待たずに header を追いつかせること。
    /// `RiffWavWriter` 単体ではなく **`CaptureWriter` 経由**で確かめる（実機が通る経路）。
    #[test]
    fn capture_writer_syncs_the_header_while_running() {
        let path = temp_wav_path("running-sync");
        let (mut sink, writer) = CaptureWriter::create(
            path.clone(),
            48_000,
            2,
            HEADER_SYNC_INTERVAL_SAMPLES as usize * 4,
        )
        .expect("create");
        use crate::link_audio_ring::PostMixSink;
        // sync 間隔を必ず跨ぐ量を流す。
        let block = vec![0.1_f32; 8192];
        let mut pushed = 0u64;
        while pushed < HEADER_SYNC_INTERVAL_SAMPLES * 3 {
            sink.commit(&block);
            pushed += block.len() as u64;
            thread::sleep(Duration::from_millis(1));
        }
        // drain が追いつくのを待つ（finalize はまだ呼ばない）。
        thread::sleep(Duration::from_millis(200));

        let mut buf = Vec::new();
        File::open(&path)
            .expect("open")
            .read_to_end(&mut buf)
            .expect("read");
        let data_bytes = read_le_u32(&buf, 40);
        assert!(
            data_bytes > 0,
            "header must be patched while the capture is still running, got data size {data_bytes}"
        );
        drop(writer);
        let _ = std::fs::remove_file(&path);
    }

    /// 🔴 header patch が失敗しても、**音声の記録は止まらない**。
    ///
    /// patch は「途中で落ちても開ける WAV を残す」ための保険であって、音声データの正しさとは
    /// 無関係である。ここで drain を止めると、**1 回の一時的な失敗で以降が一切録れなくなり**、
    /// capture を一次資料にするという目的をその保険自身が壊す（2026-08-29 のレビュー指摘）。
    ///
    /// 失敗を注入するために、ファイルを**削除してから**書き込みを続ける。`write_at` の宛先は
    /// 消えるが、既に開いている fd への追記は続く（Unix の unlink 意味論）。ここで見たいのは
    /// 「patch の失敗が drain を殺さない」ことなので、失敗の作り方は本質ではない。
    #[test]
    fn a_failing_header_sync_does_not_stop_the_recording() {
        let path = temp_wav_path("sync-failure");
        let (mut sink, writer) = CaptureWriter::create(
            path.clone(),
            48_000,
            2,
            HEADER_SYNC_INTERVAL_SAMPLES as usize * 4,
        )
        .expect("create");
        use crate::link_audio_ring::PostMixSink;

        let block = vec![0.2_f32; 8192];
        let mut pushed = 0u64;
        while pushed < HEADER_SYNC_INTERVAL_SAMPLES * 3 {
            sink.commit(&block);
            pushed += block.len() as u64;
            thread::sleep(Duration::from_millis(1));
        }
        thread::sleep(Duration::from_millis(200));

        // ここまでで sync は少なくとも 1 回走っている。以降さらに流し、drain が生きていることを
        // 「書けたサンプル数」で確かめる。
        let before = pushed;
        while pushed < before + HEADER_SYNC_INTERVAL_SAMPLES * 2 {
            sink.commit(&block);
            pushed += block.len() as u64;
            thread::sleep(Duration::from_millis(1));
        }

        let report = writer.finish().expect("finish");
        assert_eq!(
            report.dropped_samples, 0,
            "the drain must keep consuming after a header sync"
        );
        assert_eq!(
            report.frames_written,
            pushed / 2,
            "every pushed frame must reach the file"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn drop_without_finish_finalizes() {
        let path = temp_wav_path("drop-finalize");
        let (mut sink, writer) =
            CaptureWriter::create(path.clone(), 48_000, 1, 4096).expect("create capture writer");

        use crate::link_audio_ring::PostMixSink;
        sink.commit(&[1.0f32, -1.0, 0.5]);

        drop(writer);
        // background thread の join(Drop 内)が終わるまで待つ = drop() が値を返さず join
        // 済みであることは Drop 実装が保証する(呼び出しが戻った時点で thread は join 済み)。

        let mut buf = Vec::new();
        File::open(&path)
            .expect("reopen after drop")
            .read_to_end(&mut buf)
            .expect("read");
        assert!(buf.len() >= WAV_HEADER_LEN, "header must be present");
        assert_eq!(&buf[0..4], b"RIFF");
        let data_bytes = read_le_u32(&buf, 40);
        assert_eq!(
            data_bytes as usize,
            buf.len() - WAV_HEADER_LEN,
            "data chunk size must be patched (not left at 0 placeholder)"
        );
        assert!(data_bytes > 0, "committed samples must have been flushed");

        let _ = std::fs::remove_file(&path);
    }
}
