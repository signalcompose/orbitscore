//! γ sandbox spike — 子プロセス（隔離されたエフェクトプロセス）。
//!
//! 本来 3rd-party plugin が走る側のスタンドイン。共有メモリの SPSC ハンドシェイクで host から
//! block を受け取り、trivial な gain を掛けて返す。`--crash-after-blocks N` で N ブロック処理後に
//! 自発 segfault し、Gate2（親が子の crash を封じ込めて watchdog 復帰できるか）を駆動する。
//!
//! 使い方:
//!   sandbox-child --shm <path> [--crash-after-blocks <N>]

#![allow(unsafe_code)]

use std::path::PathBuf;
use std::sync::atomic::Ordering;

use orbit_sandbox_spike::{open_shared, region_ptr, set_realtime_thread, CHANNELS, MAX_FRAMES};

struct Cli {
    shm: PathBuf,
    /// > 0 なら N ブロック処理後に自発 segfault（Gate2 用）。0 = crash しない。
    crash_after_blocks: u64,
    /// true なら spin スレッドを RT(time-constraint)優先度に上げる（candidate A・#350）。
    rt_priority: bool,
    /// RT の period（µs）= block period。computation/constraint をここから導く。0 = host 未指定。
    rt_period_us: u64,
}

fn parse_args() -> anyhow::Result<Cli> {
    let mut args = std::env::args().skip(1);
    let mut shm: Option<PathBuf> = None;
    let mut crash_after_blocks: u64 = 0;
    let mut rt_priority = false;
    let mut rt_period_us: u64 = 0;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--shm" => {
                shm = Some(
                    args.next()
                        .ok_or_else(|| anyhow::anyhow!("--shm requires a value"))?
                        .into(),
                )
            }
            "--crash-after-blocks" => {
                crash_after_blocks = args
                    .next()
                    .ok_or_else(|| anyhow::anyhow!("--crash-after-blocks requires a value"))?
                    .parse()?
            }
            "--rt-priority" => rt_priority = true,
            "--rt-period-us" => {
                rt_period_us = args
                    .next()
                    .ok_or_else(|| anyhow::anyhow!("--rt-period-us requires a value"))?
                    .parse()?
            }
            other => anyhow::bail!("Unknown argument: {other}"),
        }
    }
    Ok(Cli {
        shm: shm.ok_or_else(|| anyhow::anyhow!("--shm is required"))?,
        crash_after_blocks,
        rt_priority,
        rt_period_us,
    })
}

fn main() -> anyhow::Result<()> {
    let cli = parse_args()?;
    let mmap = open_shared(&cli.shm)?;
    let r = region_ptr(&mmap);
    eprintln!(
        "[sandbox-child pid={}] attached to {} (crash_after_blocks={})",
        std::process::id(),
        cli.shm.display(),
        cli.crash_after_blocks
    );

    // candidate A: spin スレッド（このスレッド = 唯一の処理スレッド）を RT に上げる。
    // computation = period/2・constraint = period*3/4（>= computation）。失敗しても通常優先度で
    // 継続し、計測は RT 無効として読める（host は child_rt_priority を結果に出すので区別可能）。
    if cli.rt_priority {
        let period_ns = cli.rt_period_us.saturating_mul(1_000);
        match set_realtime_thread(period_ns, period_ns / 2, period_ns * 3 / 4) {
            Ok(()) => eprintln!(
                "[sandbox-child pid={}] RT thread enabled (period={}us)",
                std::process::id(),
                cli.rt_period_us
            ),
            Err(e) => eprintln!(
                "[sandbox-child pid={}] WARNING: RT thread NOT enabled: {e} (running at normal priority)",
                std::process::id()
            ),
        }
    }

    // gain は host 起動時に一度だけ設定され計測中は不変 → ループ外で 1 回だけ読む
    // （毎ブロックの shared control-line への atomic load + bit-cast を省く）。
    let gain = f32::from_bits(unsafe { (*r).gain_bits.load(Ordering::Relaxed) });

    let mut last: u64 = 0;
    loop {
        // SAFETY: r は host が REGION_BYTES に確保した共有領域。atomic アクセスは健全。
        // Acquire で seq_request を読み、host の Release(input 書き込み後)と synchronize-with する。
        let cur = unsafe { (*r).seq_request.load(Ordering::Acquire) };
        if cur > last {
            let n = unsafe { (*r).n_frames.load(Ordering::Relaxed) as usize }.min(MAX_FRAMES);
            let count = n * CHANNELS;
            // SAFETY: host の 1-outstanding 不変条件により、host は前 req 完了後のみ次の input を
            // 上書きする = この req を処理している間 host は input/output に触れない。よって input を
            // 読み gain を掛けて output に書くこの window で host との競合は無い。
            unsafe {
                let inp = (*r).input.as_ptr();
                let out = (*r).output.as_mut_ptr();
                for i in 0..count {
                    *out.add(i) = *inp.add(i) * gain;
                }
            }
            // 観測用カウンタを進め、その新値を crash 判定にも使う（別ローカルを持たない）。
            // host が warm-up 後に 0 リセットするので計測中の実ブロック数を数える。なお全子プロセス
            // 累積で respawn 子はリセットされない（respawn 子は crash_after=0 なので実害なし）。
            let processed = unsafe { (*r).child_processed.fetch_add(1, Ordering::Relaxed) } + 1;

            // Gate2: 規定ブロック数を処理したら自発 segfault（misbehaving plugin の模擬）。
            // seq_done を立てる **前** に死ぬ → host はこの req を取りこぼし timeout する。
            if cli.crash_after_blocks > 0 && processed >= cli.crash_after_blocks {
                eprintln!(
                    "[sandbox-child pid={}] crash-after-blocks reached ({}); segfaulting now",
                    std::process::id(),
                    cli.crash_after_blocks
                );
                // 意図的な null 書き込みで SIGSEGV を起こす（C-ABI plugin の crash 模擬）。
                unsafe {
                    std::ptr::null_mut::<u8>().write_volatile(0);
                }
                unreachable!("segfault should have terminated the process");
            }

            // Release で seq_done を publish → host の Acquire(seq_done)と synchronize-with し、
            // host から output が可視になる。
            unsafe {
                (*r).seq_done.store(cur, Ordering::Release);
            }
            last = cur;
        } else {
            // 新規 request 待ち。専用プロセスなので busy-spin で良い（最低レイテンシ）。
            std::hint::spin_loop();
        }
    }
}
