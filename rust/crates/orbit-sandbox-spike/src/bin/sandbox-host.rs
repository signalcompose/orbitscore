//! γ sandbox spike — 親プロセス（host）。
//!
//! cpal 出力ストリームの RT callback で、1 ブロックを共有メモリ経由で子プロセスに渡して
//! gain を掛け戻させる round-trip を行い、そのレイテンシ分布と overrun 挙動を計測する。
//! 別スレッドの watchdog が子の死（segfault）を検知して clean な子を respawn する。
//!
//! 使い方:
//!   sandbox-host [--measure-secs N] [--buffer-frames F] [--round-trip-timeout-us US]
//!                [--child-crash-after-blocks N] [--gain G]
//!                [--child-rt-priority] [--in-process] [--pipelined]
//!
//! Gate1（RT round-trip が block budget に収まるか）: crash 無しで実行しレイテンシ分布を見る。
//! Gate2（子の crash 封じ込め + watchdog 復帰）: --child-crash-after-blocks N で実行し、
//!   respawn 後に round-trip が再開し audio が復帰することを確認する。
//! candidate A（#350）: --child-rt-priority で子を RT(time-constraint)優先度にし、worst-case
//!   tail が同期ベースライン（Step0）より縮むかを比較する。
//! candidate B（#350）: --pipelined で host が spin せず block N を渡して N-1 を読む。判定軸は stale 率。
//! in-process 対照（#350）: --in-process で child を使わず callback 内で直接合成し floor を測る。

#![allow(unsafe_code)]

use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use orbit_sandbox_spike::{
    create_shared, region_ptr, slot_offset, SharedRegion, CHANNELS, MAX_FRAMES,
};

// ---- CLI ----------------------------------------------------------------

struct Cli {
    measure_secs: u64,
    buffer_frames: Option<u32>,
    /// round-trip 待ちの上限（µs）。これを超えたら glitch-to-silence（RT は無制限ブロックしない）。
    round_trip_timeout_us: u64,
    /// > 0 なら最初の子を「N ブロック後 segfault」で起動し Gate2 を駆動する。respawn 後は clean。
    child_crash_after_blocks: u64,
    gain: f32,
    /// true なら spawn する子に --rt-priority を渡し RT(time-constraint)スケジュールにする
    /// （candidate A・#350）。period は buffer_frames + sample_rate から導く。
    child_rt_priority: bool,
    /// true なら child を使わず callback 内で直接トーンを合成する in-process 対照（#350）。
    /// sandbox round-trip を通さない経路（= ネイティブ楽器が走る経路）の callback_max floor を測り、
    /// 「この機材/CoreAudio が 64f を in-process でクリーンに出せるか」を独立に検証する。
    in_process: bool,
    /// true なら candidate B（one-block-pipelined）: host は spin せず block N を渡して N-1 を読む。
    /// tail を構造的に消す代わり 1 block の遅延 + child 遅延時の stale。判定軸は stale 率（#350）。
    pipelined: bool,
}

fn parse_args() -> anyhow::Result<Cli> {
    let mut args = std::env::args().skip(1);
    let mut cli = Cli {
        measure_secs: 10,
        buffer_frames: None,
        round_trip_timeout_us: 5000,
        child_crash_after_blocks: 0,
        gain: 0.5,
        child_rt_priority: false,
        in_process: false,
        pipelined: false,
    };
    while let Some(arg) = args.next() {
        let mut next = || {
            args.next()
                .ok_or_else(|| anyhow::anyhow!("{arg} requires a value"))
        };
        match arg.as_str() {
            "--measure-secs" => cli.measure_secs = next()?.parse()?,
            "--buffer-frames" => cli.buffer_frames = Some(next()?.parse()?),
            "--round-trip-timeout-us" => cli.round_trip_timeout_us = next()?.parse()?,
            "--child-crash-after-blocks" => cli.child_crash_after_blocks = next()?.parse()?,
            "--gain" => cli.gain = next()?.parse()?,
            "--child-rt-priority" => cli.child_rt_priority = true,
            "--in-process" => cli.in_process = true,
            "--pipelined" => cli.pipelined = true,
            other => anyhow::bail!("Unknown argument: {other}"),
        }
    }
    // --in-process は child を使わない対照なので、child 系フラグと併用すると黙って無視され
    // 「3 実験のどれでもない」誤計測になる（altitude review）。明示的に弾く。
    if cli.in_process && (cli.pipelined || cli.child_rt_priority) {
        anyhow::bail!("--in-process cannot be combined with --pipelined / --child-rt-priority");
    }
    // --child-rt-priority は RT period 算出に buffer_frames が要る。未指定だと黙って 512 を仮定し
    // 誤った period で child を RT 設定してしまう（altitude review）。明示を要求する。
    if cli.child_rt_priority && cli.buffer_frames.is_none() {
        anyhow::bail!("--child-rt-priority requires --buffer-frames (RT period を確定するため)");
    }
    Ok(cli)
}

// ---- RT stats -----------------------------------------------------------

const HIST_BUCKETS: usize = 4096;
// 2 µs / bucket -> 0..8.192 ms。default round-trip timeout(5ms)を範囲内に収め、5ms 近傍の
// 成功 round-trip が overflow bucket に飽和して p99 を過小評価するのを防ぐ（#348 altitude review）。
const BUCKET_NS: u64 = 2_000;

/// RT callback が更新する計測。全 atomic（callback スレッドが唯一の writer、終了後に読む）。
/// `callback_count` は持たない（= success_count + overrun_count で導出でき、hot-path の atomic を 1 個減らす）。
struct RtStats {
    frames_total: AtomicU64,
    /// callback が届けたフレーム数が MAX_FRAMES を超えクランプされた回数。> 0 なら計測が
    /// 部分ブロックしか round-trip していない（block budget は全幅で計算）ので結果で警告する。
    frames_clamped: AtomicU64,
    /// round-trip 成功回数（timeout でない）。
    success_count: AtomicU64,
    /// round-trip timeout = glitch-to-silence した回数。
    overrun_count: AtomicU64,
    /// 成功 round-trip のレイテンシ（ns）。
    rt_min_ns: AtomicU64,
    rt_max_ns: AtomicU64,
    rt_sum_ns: AtomicU64,
    rt_hist: Vec<AtomicU64>,
    /// audio callback 全体の所要（ns）の最大（spin 待ち込み）。RT 安全性の判定軸。
    callback_max_ns: AtomicU64,
    /// post-mix の絶対値ピーク（f32 bits）。> 0 で音が流れている証拠。
    post_peak_bits: AtomicU32,
    /// 最後に round-trip が成功した時刻（t_start からの ns）。recovery 判定用。
    last_success_ns: AtomicU64,
    /// pipelined（候補 B）: 出力時に child がその block を未完了で stale 出力した回数。B の判定軸。
    stale_count: AtomicU64,
    /// pipelined（候補 B）: slot 再利用不可（child が 2 block 以上遅延）で submit を見送った回数。
    stall_count: AtomicU64,
}

impl RtStats {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            frames_total: AtomicU64::new(0),
            frames_clamped: AtomicU64::new(0),
            success_count: AtomicU64::new(0),
            overrun_count: AtomicU64::new(0),
            rt_min_ns: AtomicU64::new(u64::MAX),
            rt_max_ns: AtomicU64::new(0),
            rt_sum_ns: AtomicU64::new(0),
            rt_hist: (0..HIST_BUCKETS).map(|_| AtomicU64::new(0)).collect(),
            callback_max_ns: AtomicU64::new(0),
            post_peak_bits: AtomicU32::new(0),
            last_success_ns: AtomicU64::new(0),
            stale_count: AtomicU64::new(0),
            stall_count: AtomicU64::new(0),
        })
    }

    fn record_roundtrip(&self, ns: u64) {
        self.success_count.fetch_add(1, Ordering::Relaxed);
        self.rt_min_ns.fetch_min(ns, Ordering::Relaxed);
        self.rt_max_ns.fetch_max(ns, Ordering::Relaxed);
        self.rt_sum_ns.fetch_add(ns, Ordering::Relaxed);
        let bucket = ((ns / BUCKET_NS) as usize).min(HIST_BUCKETS - 1);
        self.rt_hist[bucket].fetch_add(1, Ordering::Relaxed);
    }

    /// p99 を histogram から復元（stream 停止後に読む）。
    fn p99_ns(&self) -> u64 {
        let total: u64 = self.rt_hist.iter().map(|b| b.load(Ordering::Relaxed)).sum();
        if total == 0 {
            return 0;
        }
        let threshold = (total as f64 * 0.99).ceil() as u64;
        let mut cum = 0u64;
        for (i, b) in self.rt_hist.iter().enumerate() {
            cum += b.load(Ordering::Relaxed);
            if cum >= threshold {
                return i as u64 * BUCKET_NS;
            }
        }
        (HIST_BUCKETS - 1) as u64 * BUCKET_NS
    }
}

/// crash からの復帰判定: respawn が起きており、最後の成功 round-trip が最後の respawn より後なら、
/// audio-flow が復帰している（= daemon 生存 + 音再開。plugin 内部状態の復帰は意味しない）。
fn is_recovered(respawns: u64, last_success_ns: u64, last_respawn_ns: u64) -> bool {
    respawns > 0 && last_success_ns > last_respawn_ns
}

/// 生ポインタを cpal callback（Send 要求）に渡すためのラッパ。
/// SAFETY: ポインタは run() が保持する mmap を指す。stream は mmap より先に drop されるので
/// callback 実行中は常に有効。バッファ競合は 1-outstanding 不変条件（host は前 req 完了後のみ input を
/// 上書きする）+ seq_done の Release/Acquire で排除されるので、別スレッドへの送付も健全。
struct RegionPtr(*mut SharedRegion);
unsafe impl Send for RegionPtr {}

impl RegionPtr {
    /// ポインタを取り出す。メソッド呼び出しにすることでクロージャが（生ポインタフィールドだけでなく）
    /// `RegionPtr` 全体を捕捉する（edition 2021 disjoint capture で `.0` 直参照だと
    /// `*mut` 単体が捕捉され Send にならないため）。
    fn get(&self) -> *mut SharedRegion {
        self.0
    }
}

// ---- child / watchdog ---------------------------------------------------

fn child_exe_path() -> anyhow::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let dir = exe
        .parent()
        .ok_or_else(|| anyhow::anyhow!("current_exe has no parent dir"))?;
    Ok(dir.join("sandbox-child"))
}

/// child を起動する。`rt_period_us` が Some なら子を RT(time-constraint)優先度で起動する
/// （candidate A）。初回・watchdog respawn の双方が同じ rt 設定で子を立てる。
fn spawn_child(
    child_exe: &Path,
    shm: &Path,
    crash_after: u64,
    rt_period_us: Option<u64>,
) -> anyhow::Result<Child> {
    let mut cmd = Command::new(child_exe);
    cmd.arg("--shm").arg(shm);
    if crash_after > 0 {
        cmd.arg("--crash-after-blocks").arg(crash_after.to_string());
    }
    if let Some(period_us) = rt_period_us {
        cmd.arg("--rt-priority")
            .arg("--rt-period-us")
            .arg(period_us.to_string());
    }
    Ok(cmd.spawn()?)
}

// ---- shared helpers -----------------------------------------------------

/// 出力デバイスを開き `(device, StreamConfig, sample_rate)` を返す（`run` / `run_in_process` 共用）。
fn open_device(
    buffer_frames: Option<u32>,
) -> anyhow::Result<(cpal::Device, cpal::StreamConfig, u32)> {
    let cpal_host = cpal::default_host();
    let device = cpal_host
        .default_output_device()
        .ok_or_else(|| anyhow::anyhow!("no default output device"))?;
    let sample_rate = device.default_output_config()?.sample_rate().0;
    let cpal_config = cpal::StreamConfig {
        channels: CHANNELS as u16,
        sample_rate: cpal::SampleRate(sample_rate),
        buffer_size: match buffer_frames {
            Some(f) => cpal::BufferSize::Fixed(f),
            None => cpal::BufferSize::Default,
        },
    };
    Ok((device, cpal_config, sample_rate))
}

/// 全ストリーム共通の cpal error callback を作る: ログ出力 + `measurement_invalid` を立てる。
/// device 切断等で callback 配送が止まると無音のまま teardown され誤データになるのを sentinel で可視化。
fn err_callback(mi: Arc<std::sync::atomic::AtomicBool>) -> impl FnMut(cpal::StreamError) {
    move |err| {
        eprintln!("[cpal err] {err}");
        mi.store(true, Ordering::Relaxed);
    }
}

/// shared input slot にテストトーン（220Hz サイン・振幅 0.5）を `n` フレーム書く（sync / pipelined 共用）。
///
/// # Safety
/// `inp` は確保済み input slot の先頭で、`n * CHANNELS` 要素ぶん書き込み可能であること。
unsafe fn fill_tone_block(inp: *mut f32, n: usize, phase: &mut f64, phase_inc: f64) {
    for f in 0..n {
        *phase += phase_inc;
        if *phase >= std::f64::consts::TAU {
            *phase -= std::f64::consts::TAU;
        }
        let s = ((*phase).sin() as f32) * 0.5;
        *inp.add(f * CHANNELS) = s;
        *inp.add(f * CHANNELS + 1) = s;
    }
}

// ---- entry --------------------------------------------------------------

fn main() -> anyhow::Result<()> {
    let cli = parse_args()?;
    if cli.in_process {
        run_in_process(&cli)
    } else {
        run(&cli)
    }
}

/// in-process 対照（#350）: child を使わず callback 内で直接トーンを合成する。sandbox round-trip を
/// 通さない経路（= ネイティブ楽器が走る経路）の callback_max floor を測り、candidate B の
/// callback_max の「tiny」基準を較正する。また「この機材/CoreAudio が 64f を in-process でクリーンに
/// 出せるか」を独立に検証する（host 側 tail が CoreAudio/OS 由来なら in-process でも spike する）。
fn run_in_process(cli: &Cli) -> anyhow::Result<()> {
    let (device, cpal_config, sample_rate) = open_device(cli.buffer_frames)?;
    println!(
        "audio: {} Hz, {} ch, buffer={:?} (IN-PROCESS control)",
        sample_rate, CHANNELS, cpal_config.buffer_size
    );

    let stats = RtStats::new();
    let cb_stats = stats.clone();
    let phase_inc = 2.0 * std::f64::consts::PI * 220.0 / sample_rate as f64;
    let mut phase: f64 = 0.0;
    let measurement_invalid = Arc::new(std::sync::atomic::AtomicBool::new(false));

    let stream = device.build_output_stream(
        &cpal_config,
        move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
            let cb_start = Instant::now();
            let frames = data.len() / CHANNELS;
            let mut peak: f32 = 0.0;
            for f in 0..frames {
                phase += phase_inc;
                if phase >= std::f64::consts::TAU {
                    phase -= std::f64::consts::TAU;
                }
                let s = (phase.sin() as f32) * 0.5;
                data[f * CHANNELS] = s;
                data[f * CHANNELS + 1] = s;
                peak = peak.max(s.abs());
            }
            cb_stats
                .post_peak_bits
                .fetch_max(peak.to_bits(), Ordering::Relaxed);
            cb_stats
                .callback_max_ns
                .fetch_max(cb_start.elapsed().as_nanos() as u64, Ordering::Relaxed);
            cb_stats
                .frames_total
                .fetch_add(frames as u64, Ordering::Relaxed);
            cb_stats.success_count.fetch_add(1, Ordering::Relaxed);
        },
        err_callback(measurement_invalid.clone()),
        None,
    )?;
    stream.play()?;
    std::thread::sleep(Duration::from_secs(cli.measure_secs));
    drop(stream);

    let invalid = measurement_invalid.load(Ordering::Relaxed);
    let callbacks = stats.success_count.load(Ordering::Relaxed);
    let frames_total = stats.frames_total.load(Ordering::Relaxed);
    let cb_max = stats.callback_max_ns.load(Ordering::Relaxed);
    let post_peak = f32::from_bits(stats.post_peak_bits.load(Ordering::Relaxed));
    let avg_frames = frames_total.checked_div(callbacks).unwrap_or(0);
    let block_budget_ns = avg_frames * 1_000_000_000 / sample_rate as u64;

    println!();
    println!("=== orbit-sandbox-spike (in-process control) ===");
    if invalid {
        println!("MEASUREMENT INVALID — cpal error during run (see stderr); 数値は信頼できない。");
    }
    println!("measurement_valid:     {}", !invalid);
    println!("sample_rate:           {sample_rate}");
    println!("total_callbacks:       {callbacks}");
    println!("avg_frames_per_cb:     {avg_frames}");
    println!("block_budget_ns:       ~{block_budget_ns}");
    println!("callback_max_ns:       {cb_max}");
    println!("post_mix_peak:         {post_peak:.5}");
    println!("================================================");
    Ok(())
}

fn run(cli: &Cli) -> anyhow::Result<()> {
    // --- shared memory（mmap は run() が保持。stream より先に宣言し後で drop させる）---------
    let shm_path =
        std::env::temp_dir().join(format!("orbit-sandbox-spike-{}.shm", std::process::id()));
    let mmap = create_shared(&shm_path)?;
    let region = region_ptr(&mmap);
    // SAFETY: region は確保済み共有領域。gain を初期化。
    unsafe {
        (*region)
            .gain_bits
            .store(cli.gain.to_bits(), Ordering::Relaxed);
    }
    println!("shm: {}", shm_path.display());

    // --- 出力デバイスを先に開く（RT period 算出に sample_rate が要る）-------------------------
    let (device, cpal_config, sample_rate) = open_device(cli.buffer_frames)?;

    // candidate A: child を RT に上げる場合の period(µs) = block period = buffer_frames / sample_rate。
    // --child-rt-priority は --buffer-frames 必須（parse_args で検証済）なので unwrap で良い。
    let rt_period_us = if cli.child_rt_priority {
        let frames =
            cli.buffer_frames
                .expect("--buffer-frames required with --child-rt-priority") as u64;
        Some(frames * 1_000_000 / sample_rate as u64)
    } else {
        None
    };

    // --- child を起動（最初の子は crash arg を載せる場合がある）-----------------------------
    let child_exe = child_exe_path()?;
    let first_child = spawn_child(
        &child_exe,
        &shm_path,
        cli.child_crash_after_blocks,
        rt_period_us,
    )?;
    let child = Arc::new(Mutex::new(first_child));

    // --- watchdog -----------------------------------------------------------
    let t_start = Instant::now();
    let shutdown = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let respawn_count = Arc::new(AtomicU64::new(0));
    let last_respawn_ns = Arc::new(AtomicU64::new(0));
    // 計測が信頼できない事象（respawn 失敗 / 子の終了検知エラー / watchdog panic）が起きたら立てる。
    // 結果は「全 overrun」など authoritative に見える誤データになりうるので、結果前にバナーを出し
    // recovered を gate して go/no-go を誤導しないようにする。
    let measurement_invalid = Arc::new(std::sync::atomic::AtomicBool::new(false));

    let wd = {
        let child = child.clone();
        let shutdown = shutdown.clone();
        let respawn_count = respawn_count.clone();
        let last_respawn_ns = last_respawn_ns.clone();
        let measurement_invalid = measurement_invalid.clone();
        let child_exe = child_exe.clone();
        let shm_path = shm_path.clone();
        std::thread::spawn(move || loop {
            if shutdown.load(Ordering::Relaxed) {
                let mut g = child.lock().unwrap();
                let _ = g.kill();
                let _ = g.wait();
                break;
            }
            // try_wait は終了済みなら status を返し zombie を reap する。検知自体が Err なら子の死を
            // 取りこぼし全 callback が overrun 化しうるので、握り潰さず計測無効を立てる。
            let exited = match child.lock().unwrap().try_wait() {
                Ok(status) => status,
                Err(e) => {
                    eprintln!("[watchdog] try_wait error: {e} — treating child as alive");
                    measurement_invalid.store(true, Ordering::Relaxed);
                    None
                }
            };
            if let Some(status) = exited {
                eprintln!("[watchdog] child exited ({status:?}); respawning clean child");
                // respawn は crash arg 無し → clean な子 → audio 復帰。RT 設定は初回と揃える。
                match spawn_child(&child_exe, &shm_path, 0, rt_period_us) {
                    Ok(newc) => {
                        *child.lock().unwrap() = newc;
                        respawn_count.fetch_add(1, Ordering::Relaxed);
                        last_respawn_ns
                            .store(t_start.elapsed().as_nanos() as u64, Ordering::Relaxed);
                    }
                    Err(e) => {
                        // 以後 child 不在のまま全 callback が overrun = 「アーキ不成立」に見える誤データ。
                        eprintln!("[watchdog] FATAL: respawn failed: {e}");
                        measurement_invalid.store(true, Ordering::Relaxed);
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(2));
        })
    };

    // --- cpal 出力ストリーム（device/config は run() 冒頭で open_device 済み）-----------------
    println!(
        "audio: {} Hz, {} ch, buffer={:?}, round_trip_timeout={}us, child_rt_priority={}",
        sample_rate,
        CHANNELS,
        cpal_config.buffer_size,
        cli.round_trip_timeout_us,
        cli.child_rt_priority
    );

    let stats = RtStats::new();
    let timeout = Duration::from_micros(cli.round_trip_timeout_us);
    let phase_inc = 2.0 * std::f64::consts::PI * 220.0 / sample_rate as f64;

    // --- warm-up: child の attach + ページフォルトを RT 計測の前に済ませる ------------------
    // これをしないと最初の数 callback が child の dlopen/mmap/初回 spin を待ち込みで吸い込み、
    // cold-start のレイテンシが steady-state の tail に混ざる。warm-up 後の req を RT の起点にする。
    let mut warm_req: u64 = 0;
    {
        let warm_deadline = Instant::now() + Duration::from_secs(2);
        for _ in 0..64 {
            unsafe {
                (*region).n_frames.store(64, Ordering::Relaxed);
            }
            warm_req += 1;
            unsafe {
                (*region).seq_request.store(warm_req, Ordering::Release);
            }
            loop {
                if unsafe { (*region).seq_done.load(Ordering::Acquire) } >= warm_req {
                    break;
                }
                if Instant::now() >= warm_deadline {
                    anyhow::bail!("child did not attach within warm-up window (2s)");
                }
                std::hint::spin_loop();
            }
        }
        println!("child warm-up complete ({warm_req} round-trips)");
    }
    // warm-up 分（64 block）を child_processed から除く。リセット後は計測中の実ブロック数のみを数え、
    // child の crash 判定（--child-crash-after-blocks N = 実ブロック N 個目で crash）と
    // child_processed_blocks 出力が warm-up に汚染されない。ここでは stream 未開始かつ child は
    // seq_request > warm_req を待っているので child_processed への並行書き込みは無い。
    unsafe {
        (*region).child_processed.store(0, Ordering::Relaxed);
    }

    // cpal の fatal error（device 切断 / HAL 障害）でストリームが callback 配送を止めると、残りの
    // 計測窓は無音のまま teardown され `measurement_valid: true` の誤データになりうる。error callback
    // でも同じ sentinel を立て、go/no-go を誤導しないようにする。
    let stream = if cli.pipelined {
        // ===== candidate B: one-block-pipelined（host は spin しない）=====
        let region_ptr_send = RegionPtr(region);
        let cb_stats = stats.clone();
        let stream_err_invalid = measurement_invalid.clone();
        // req = 直近に submit 成功した seq。primed=false の初回は読むべき前回 submit が無い。
        let mut req: u64 = warm_req;
        let mut phase: f64 = 0.0;
        let mut primed = false;
        device.build_output_stream(
            &cpal_config,
            move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                let cb_start = Instant::now();
                let r = region_ptr_send.get();
                let frames = data.len() / CHANNELS;
                let n = frames.min(MAX_FRAMES);
                let count = n * CHANNELS;
                if frames > MAX_FRAMES {
                    cb_stats.frames_clamped.fetch_add(1, Ordering::Relaxed);
                }

                let mut peak: f32 = 0.0;

                // --- 出力: 前回 submit した seq `req` の結果を読む（child は ~1 block 分の時間があった）---
                if primed {
                    let done = unsafe { (*r).seq_done.load(Ordering::Acquire) } >= req;
                    if done {
                        // fresh: この seq の slot の output を出力にコピー。
                        // SAFETY: seq_done >= req を Acquire 観測 → child の output 書き込みが可視。
                        // 2-outstanding guard により host はこの slot を上書きしていない。
                        unsafe {
                            let out = (*r).output.as_ptr().add(slot_offset(req));
                            for (i, slot) in data.iter_mut().enumerate().take(count) {
                                let v = *out.add(i);
                                *slot = v;
                                peak = peak.max(v.abs());
                            }
                        }
                        data[count..].fill(0.0); // フレーム超過分は無音
                        cb_stats.success_count.fetch_add(1, Ordering::Relaxed);
                    } else {
                        // stale: child がこの block を未完了 → silence（stale policy）。B の判定軸。
                        // production は直前 block の repeat が選択肢だが spike は silence で stale 率を測る。
                        data.fill(0.0);
                        cb_stats.stale_count.fetch_add(1, Ordering::Relaxed);
                    }
                } else {
                    // priming: 読むべき前回 submit がまだ無い → 無音。
                    data.fill(0.0);
                }

                // --- submit: 新 seq を child に渡す（spin しない）---
                // slot 再利用安全: 新 seq の slot の前 occupant = new_seq-2。seq_done >= new_seq-2 を要求。
                let new_seq = req + 1;
                let slot_free =
                    unsafe { (*r).seq_done.load(Ordering::Acquire) } >= new_seq.saturating_sub(2);
                if slot_free {
                    let off = slot_offset(new_seq);
                    // SAFETY: 上の guard で new_seq の slot の前 occupant は完了済 = child は触れない。
                    // n_frames は固定 buffer で常に同値（可変 block 化するなら slot 毎に持つ必要あり）。
                    unsafe {
                        fill_tone_block((*r).input.as_mut_ptr().add(off), n, &mut phase, phase_inc);
                        (*r).n_frames.store(n as u32, Ordering::Relaxed);
                        (*r).seq_request.store(new_seq, Ordering::Release);
                    }
                    req = new_seq;
                    primed = true;
                } else {
                    // stall: child が 2 block 以上遅延し slot 再利用不可 → submit 見送り（req 据え置き）。
                    cb_stats.stall_count.fetch_add(1, Ordering::Relaxed);
                }

                cb_stats
                    .post_peak_bits
                    .fetch_max(peak.to_bits(), Ordering::Relaxed);
                cb_stats
                    .callback_max_ns
                    .fetch_max(cb_start.elapsed().as_nanos() as u64, Ordering::Relaxed);
                cb_stats.frames_total.fetch_add(n as u64, Ordering::Relaxed);
            },
            err_callback(stream_err_invalid),
            None,
        )?
    } else {
        // ===== sync / candidate A（host が bounded spin で待つ）=====
        let region_ptr_send = RegionPtr(region);
        let cb_stats = stats.clone();
        let stream_err_invalid = measurement_invalid.clone();
        let mut req: u64 = warm_req;
        let mut phase: f64 = 0.0;
        device.build_output_stream(
            &cpal_config,
            move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                let cb_start = Instant::now();
                let r = region_ptr_send.get();
                let frames = data.len() / CHANNELS;
                let n = frames.min(MAX_FRAMES);
                let count = n * CHANNELS;
                if frames > MAX_FRAMES {
                    // 全幅を round-trip できていない（部分ブロックのみ）。結果で警告するため記録。
                    cb_stats.frames_clamped.fetch_add(1, Ordering::Relaxed);
                }

                // --- 1-outstanding request モデル ---
                // 前の request が完了（seq_done が req に追いついている）したときのみ新規 request を発行する。
                // こうすると、child が（生きていて遅延中でも・crash 後 respawn 待ちでも）前 req の input を
                // 読んでいる最中に host が input を上書きすることが無く、クロスプロセスのデータ競合を
                // 構造的に排除する（high-load で live child が timeout を超過した場合の UB を防ぐ）。
                let prev_done = unsafe { (*r).seq_done.load(Ordering::Acquire) } >= req;

                let mut peak: f32 = 0.0;
                if prev_done {
                    // 新 seq へ進めてから、その seq の slot に input を書く（child も slot_offset(req) で読む）。
                    req += 1;
                    let off = slot_offset(req);
                    // SAFETY: 前 req は完了済（seq_done >= req-1）= 新 seq の slot の前 occupant（req-2）も
                    // 完了している（1-outstanding）。よって host がこの slot の唯一の writer（child は次の
                    // seq_request を観測するまで input/output に触れない）。
                    unsafe {
                        fill_tone_block((*r).input.as_mut_ptr().add(off), n, &mut phase, phase_inc);
                        (*r).n_frames.store(n as u32, Ordering::Relaxed);
                        // publish: Release で seq_request を進める（n_frames/input が child から可視に）。
                        (*r).seq_request.store(req, Ordering::Release);
                    }

                    // --- bounded spin で child の done を待つ（RT は無制限ブロックしない）---
                    let t0 = Instant::now();
                    let mut got = false;
                    loop {
                        if unsafe { (*r).seq_done.load(Ordering::Acquire) } >= req {
                            got = true;
                            break;
                        }
                        if t0.elapsed() >= timeout {
                            break;
                        }
                        std::hint::spin_loop();
                    }
                    // spin 直後の時刻を一度だけ読み、round-trip と last_success の両方に使う
                    // （hot-path の clock 読みを 1 回に減らす）。
                    let now = Instant::now();
                    let rt_ns = (now - t0).as_nanos() as u64;

                    if got {
                        // SAFETY: done を Acquire で観測済 → child の output 書き込みが可視。slot は req と一致
                        // （input 書き込みで使った off と同じ）。
                        unsafe {
                            let out = (*r).output.as_ptr().add(off);
                            for (i, slot) in data.iter_mut().enumerate().take(count) {
                                let v = *out.add(i);
                                *slot = v;
                                peak = peak.max(v.abs());
                            }
                        }
                        data[count..].fill(0.0); // フレーム超過分（n < frames）は無音
                        cb_stats.record_roundtrip(rt_ns);
                        cb_stats
                            .last_success_ns
                            .store((now - t_start).as_nanos() as u64, Ordering::Relaxed);
                    } else {
                        // この req は timeout = glitch-to-silence。req は outstanding のまま残り、次の
                        // callback は prev_done=false となって child が追いつくまで input を上書きしない。
                        data.fill(0.0);
                        cb_stats.overrun_count.fetch_add(1, Ordering::Relaxed);
                    }
                } else {
                    // 前 req がまだ outstanding（child が遅延 or crash 後 respawn 待ち）。input を上書きせず
                    // glitch-to-silence する。child が前 req を完了（or respawn 子が処理）すれば次から再開。
                    data.fill(0.0);
                    cb_stats.overrun_count.fetch_add(1, Ordering::Relaxed);
                }

                cb_stats
                    .post_peak_bits
                    .fetch_max(peak.to_bits(), Ordering::Relaxed);
                cb_stats
                    .callback_max_ns
                    .fetch_max(cb_start.elapsed().as_nanos() as u64, Ordering::Relaxed);
                cb_stats.frames_total.fetch_add(n as u64, Ordering::Relaxed);
            },
            err_callback(stream_err_invalid),
            None,
        )?
    };
    stream.play()?;

    // --- 計測（main スレッドは待つだけ）------------------------------------
    std::thread::sleep(Duration::from_secs(cli.measure_secs));

    // --- teardown -----------------------------------------------------------
    shutdown.store(true, Ordering::Relaxed);
    drop(stream); // cpal 停止（callback が止まり region への RT アクセスが終わる）
    if let Err(e) = wd.join() {
        // watchdog の panic は「respawn が走らなかった」= Gate2 が成立していないことを意味する。
        // 握り潰すと recovered=false を「復帰失敗」と誤読させるので計測無効を立てる。
        eprintln!("[watchdog] thread panicked: {e:?}");
        measurement_invalid.store(true, Ordering::Relaxed);
    }
    if let Err(e) = std::fs::remove_file(&shm_path) {
        eprintln!(
            "[host] failed to remove shm file {}: {e}",
            shm_path.display()
        );
    }
    let invalid = measurement_invalid.load(Ordering::Relaxed);

    // --- 結果出力（pipelined / 候補 B は判定軸が stale 率なので専用ブロック）-------------------
    if cli.pipelined {
        let frames_total = stats.frames_total.load(Ordering::Relaxed);
        let fresh = stats.success_count.load(Ordering::Relaxed);
        let stale = stats.stale_count.load(Ordering::Relaxed);
        let stall = stats.stall_count.load(Ordering::Relaxed);
        let cb_max = stats.callback_max_ns.load(Ordering::Relaxed);
        let post_peak = f32::from_bits(stats.post_peak_bits.load(Ordering::Relaxed));
        let frames_clamped = stats.frames_clamped.load(Ordering::Relaxed);
        // 出力 callback 総数 = fresh + stale（priming の無音 callback 〜1 は除外）。
        let output_cbs = fresh + stale;
        let avg_frames = frames_total.checked_div(output_cbs.max(1)).unwrap_or(0);
        let block_budget_ns = avg_frames * 1_000_000_000 / sample_rate as u64;
        let stale_pct = if output_cbs > 0 {
            stale as f64 * 100.0 / output_cbs as f64
        } else {
            0.0
        };

        println!();
        println!("=== orbit-sandbox-spike (pipelined / candidate B) ===");
        if invalid {
            println!(
                "MEASUREMENT INVALID — cpal/watchdog failure (see stderr); 数値は信頼できない。"
            );
        }
        println!("measurement_valid:     {}", !invalid);
        println!("sample_rate:           {sample_rate}");
        println!("output_callbacks:      {output_cbs}");
        println!("avg_frames_per_cb:     {avg_frames}");
        println!("block_budget_ns:       ~{block_budget_ns}");
        println!("pipelined_fresh:       {fresh}");
        println!("pipelined_stale:       {stale}");
        println!("pipelined_stall:       {stall}");
        println!("stale_pct:             {stale_pct:.4}");
        println!("callback_max_ns:       {cb_max}");
        println!("post_mix_peak:         {post_peak:.5}");
        if frames_clamped > 0 {
            println!("WARNING: {frames_clamped} callbacks exceeded MAX_FRAMES ({MAX_FRAMES})");
        }
        println!("=====================================================");
        return Ok(());
    }

    // --- 結果出力（sync / 候補 A）-------------------------------------------
    let frames_total = stats.frames_total.load(Ordering::Relaxed);
    let frames_clamped = stats.frames_clamped.load(Ordering::Relaxed);
    let success = stats.success_count.load(Ordering::Relaxed);
    let overruns = stats.overrun_count.load(Ordering::Relaxed);
    // 各 callback は成功か overrun のどちらか 1 つ → total はその和（hot-path の atomic を省ける）。
    let callbacks = success + overruns;
    let rt_min = stats.rt_min_ns.load(Ordering::Relaxed);
    let rt_max = stats.rt_max_ns.load(Ordering::Relaxed);
    let rt_sum = stats.rt_sum_ns.load(Ordering::Relaxed);
    let rt_mean = rt_sum.checked_div(success).unwrap_or(0);
    let rt_p99 = stats.p99_ns();
    let cb_max = stats.callback_max_ns.load(Ordering::Relaxed);
    let post_peak = f32::from_bits(stats.post_peak_bits.load(Ordering::Relaxed));
    let respawns = respawn_count.load(Ordering::Relaxed);
    let last_respawn = last_respawn_ns.load(Ordering::Relaxed);
    let last_success = stats.last_success_ns.load(Ordering::Relaxed);
    let child_processed = unsafe { (*region).child_processed.load(Ordering::Relaxed) };

    let avg_frames = frames_total.checked_div(callbacks).unwrap_or(0);
    let block_budget_ns = avg_frames * 1_000_000_000 / sample_rate as u64;
    // recovery: respawn があり、最後の成功 round-trip が最後の respawn より後で、かつ計測が有効
    // （respawn 失敗等が無い）なら復帰している。invalid のときは偽 recovered を出さない。
    let recovered = !invalid && is_recovered(respawns, last_success, last_respawn);
    // Gate2 の無音窓は `roundtrip_overruns`（glitch-to-silence した callback 数 × block 周期）で読む。
    // last_success は毎成功で上書きされる「最後の成功時刻」なので last_success − last_respawn は
    // 「respawn から実行終了まで」になり無音窓ではない（誤った派生メトリックは持たない・#348 review）。

    println!();
    println!("=== orbit-sandbox-spike (host) results ===");
    if invalid {
        println!(
            "MEASUREMENT INVALID — respawn/watchdog/child-detect failure; results below are NOT"
        );
        println!("  usable for go/no-go (see stderr). 数値は信頼できない。");
    }
    println!("measurement_valid:     {}", !invalid);
    println!("sample_rate:           {sample_rate}");
    println!("child_rt_priority:     {}", cli.child_rt_priority);
    println!("total_callbacks:       {callbacks}");
    println!("avg_frames_per_cb:     {avg_frames}");
    println!("block_budget_ns:       ~{block_budget_ns}");
    println!("roundtrip_success:     {success}");
    println!("roundtrip_overruns:    {overruns}");
    println!(
        "roundtrip_min_ns:      {}",
        if rt_min == u64::MAX { 0 } else { rt_min }
    );
    println!("roundtrip_mean_ns:     {rt_mean}");
    println!("roundtrip_p99_ns:      {rt_p99}");
    println!("roundtrip_max_ns:      {rt_max}");
    println!("callback_max_ns:       {cb_max}");
    println!("post_mix_peak:         {post_peak:.5}");
    println!("child_processed_blocks:{child_processed}");
    println!("child_respawns:        {respawns}");
    println!("last_respawn_ns:       {last_respawn}");
    println!("last_success_ns:       {last_success}");
    println!("recovered_after_crash: {recovered}");
    if frames_clamped > 0 {
        println!(
            "WARNING: {frames_clamped} callbacks exceeded MAX_FRAMES ({MAX_FRAMES}); \
             measurement covered only a partial block — raise MAX_FRAMES"
        );
    }
    println!("==========================================");

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // 990/1000 が bucket0、10/1000（ちょうど 1%）が 50µs: p99 の閾値 = ceil(1000*0.99) = 990 で、
    // これは bucket0 の累積（990）でちょうど満たされる → p99 は tail に入らず 0。境界（cum == threshold）
    // のオフバイワン回帰を捕捉する。max は tail を捉えることも確認。
    #[test]
    fn p99_stays_in_fast_bucket_at_exactly_one_percent() {
        let s = RtStats::new();
        for _ in 0..990 {
            s.record_roundtrip(500); // bucket 0 (<2µs)
        }
        for _ in 0..10 {
            s.record_roundtrip(50_000); // bucket 25 (50µs)
        }
        assert_eq!(s.p99_ns(), 0);
        assert_eq!(s.rt_max_ns.load(Ordering::Relaxed), 50_000);
    }

    // histogram 範囲（(HIST_BUCKETS-1)*BUCKET_NS = 8.19ms）を超える round-trip は overflow bucket に
    // 飽和する。timeout を 8.19ms 超に設定して走らせた場合、8.19ms 超の成功 round-trip は p99 を
    // 過小評価する（= histogram は round_trip_timeout <= 8.19ms のときのみ正確）という限界を明文化する。
    #[test]
    fn p99_saturates_at_overflow_bucket_beyond_histogram_range() {
        let s = RtStats::new();
        for _ in 0..100 {
            s.record_roundtrip(10_000_000); // 10ms > 8.192ms histogram max → bucket 4095 に飽和
        }
        assert_eq!(
            s.p99_ns(),
            (HIST_BUCKETS - 1) as u64 * BUCKET_NS,
            "overflow bucket は下限を返す（真のレイテンシではない）"
        );
        // 真の最大は飽和しない（rt_max は実値を保持）。
        assert_eq!(s.rt_max_ns.load(Ordering::Relaxed), 10_000_000);
    }

    // tail がより太いと p99 が tail bucket に乗る。
    #[test]
    fn p99_lands_in_tail_when_tail_exceeds_one_percent() {
        let s = RtStats::new();
        for _ in 0..950 {
            s.record_roundtrip(500); // bucket 0
        }
        for _ in 0..50 {
            s.record_roundtrip(2_000_000); // 2 ms -> bucket 2000
        }
        // ceil(1000*0.99)=990。bucket0 累積 950 < 990 → tail bucket 2000(=2ms 下限)で到達。
        assert_eq!(s.p99_ns(), 2_000_000);
    }

    #[test]
    fn p99_zero_when_no_samples() {
        let s = RtStats::new();
        assert_eq!(s.p99_ns(), 0);
    }

    // recovery: respawn が無ければ false。respawn 後に成功があれば true。respawn 後に成功が無ければ false。
    #[test]
    fn recovered_requires_respawn_and_later_success() {
        assert!(!is_recovered(0, 100, 0), "respawn 無しは false");
        assert!(is_recovered(1, 200, 100), "respawn 後に成功 → true");
        assert!(
            !is_recovered(1, 50, 100),
            "最後の成功が respawn より前 → 未復帰"
        );
    }
}
