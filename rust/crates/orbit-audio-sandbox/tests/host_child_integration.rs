//! production path CI proof(γ M1 検証の root-of-trust)。
//!
//! **実 `PipelinedEffectHost`(候補B 状態機械)+ 実 spawn child + 実 mmap** を cpal なしで統合する。
//! これが本番で実際に走る経路そのもの。host.rs の mock-child unit test(host のみ)と parity.rs の
//! sync-driver test(child + 同期ドライバ・host は通らない)はそれぞれ半分しかカバーしないため、
//! 両 production 半分を一緒に動かすこのテストが production path の唯一の CI 根拠になる。
//!
//! 決定論化: 各 `process_block` の後、child がその seq を終えるまで(`seq_done >= submitted`)spin で
//! 待ってから次へ進む。これで毎回の read が fresh path に当たり、stale の非決定性が入らない。
//! 期待値 = 入力を gain 倍し **ちょうど 1 block 遅延**(候補B の +1 block レイテンシ)させたもの。

#![allow(unsafe_code)]

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::Ordering::Acquire;
use std::time::{Duration, Instant};

use orbit_audio_sandbox::{
    create_shared, open_shared, region_ptr, PipelinedEffectHost, SandboxChildGuard, CHANNELS,
};

fn child_exe() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_sandbox-effect-child"))
}

#[test]
fn pipelined_host_with_real_child_is_gain_delayed_one_block() {
    let gain = 0.5f32;
    let frames = 64usize;
    let num_blocks = 8usize;

    let path = std::env::temp_dir().join(format!("orbit-sbx-int-{}.shm", std::process::id()));
    let mmap_host = create_shared(&path).expect("create_shared");
    let child = Command::new(child_exe())
        .arg("--shm")
        .arg(&path)
        .arg("--gain")
        .arg(gain.to_string())
        .spawn()
        .expect("spawn child");
    // 制御用に同一ファイルを別 map(host は from_mmap で mmap_host を消費するので seq_done 観測と
    // QUIT 送出にはこの第 2 mapping を使う)。
    let mmap_ctl = open_shared(&path).expect("open_shared");
    let ctl = region_ptr(&mmap_ctl);
    // mmap_ctl は _guard より後に drop される(宣言順 = drop 逆順)ので ctl は guard drop 時に有効。
    let _guard = SandboxChildGuard::new(child, ctl, path.clone());
    // production 構築子(daemon が使う from_mmap)を通す。
    let mut host = PipelinedEffectHost::from_mmap(mmap_host);

    // 決定論入力(block ごとに異なる定数)。
    let inputs: Vec<Vec<f32>> = (1..=num_blocks)
        .map(|k| vec![0.1 * k as f32; frames * CHANNELS])
        .collect();

    let mut outputs: Vec<Vec<f32>> = Vec::with_capacity(num_blocks);
    for (idx, inp) in inputs.iter().enumerate() {
        let seq = (idx + 1) as u64;
        let mut buf = inp.clone();
        host.process_block(&mut buf);
        outputs.push(buf);
        // child がこの seq を処理し終えるまで待つ(次 callback の read を fresh にする)。
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if unsafe { (*ctl).seq_done.load(Acquire) } >= seq {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "child が seq {seq} を時間内に処理しなかった"
            );
            std::hint::spin_loop();
        }
    }

    // callback 1 は prime 無音(まだ読める出力が無い)。
    assert!(
        outputs[0].iter().all(|&x| x == 0.0),
        "callback 1 は prime silence"
    );
    // callback k(>=2)は input[k-1] を gain 倍した値 = ちょうど 1 block 遅延(sample-exact)。
    for k in 1..num_blocks {
        let expected: Vec<f32> = inputs[k - 1].iter().map(|&x| x * gain).collect();
        assert_eq!(
            outputs[k], expected,
            "callback {k}: 1 block 遅れの gain 出力に sample-exact 一致"
        );
    }

    assert_eq!(host.fresh, (num_blocks - 1) as u64, "fresh 読み出し回数");
    assert_eq!(host.stale, 0, "毎回追いつくので stale 0");
    assert_eq!(host.stall, 0, "slot 圧は無いので stall 0");
}
