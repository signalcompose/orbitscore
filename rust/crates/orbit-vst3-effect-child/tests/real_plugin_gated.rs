//! Phase 1 VST3 OOP host — **実市販プラグイン**に対する machinery smoke（#381 follow-on）。
//!
//! ## このテストが証明すること・証明しないこと
//! 証明するのは「Phase 1 の OOP host 機構（child spawn・SharedRegion transport・plugin
//! load・process()・isolation）が実市販プラグイン（NI/iZotope 等 arm64）を crash 0 で生き延びる」
//! ことだけ。合成 gain oracle（`oracle_parity.rs`）と違い商用プラグインには closed-form 参照が
//! 無いため、**`process_errors == 0`（`process()` が非 OK を返し dry passthrough になっていない）
//! ＋ 有限 ＋ 非発散（`|x| <= 8.0`）＋ 期待ブロック数の到達** をゲートにする。これは
//! 「host が実際に `process()` を crash 無く完走させた証跡」であって **musical に正しい DSP の
//! 証拠ではない**（音楽的正しさの検証は capture→owner 試聴の follow-on）。
//!
//! ## 分類 = out-of-process `vst3_probe`（Phase 0 資産・新規コード不要）
//! 各プラグインをまず `vst3_probe`（別プロセス・20s timeout）で probe し、`audio_in` で
//! effect/instrument を判定する。probe 自体の crash/hang はここで隔離され、`real_plugin_gated`
//! 本体のプロセスには波及しない（「結果ベース分類」だと instrument の crash が誤って effect gate
//! に混入しうる ── その穴をここで閉じる）。
//!
//! ## 二層判定
//! - **effect（`audio_in > 0`）= ゲート対象**: FAIL したらこのテスト全体を `panic!` させる。
//! - **instrument（`audio_in == 0`）= informational**: 結果は記録するが gate しない
//!   （primary bus 以外の extra bus を持つ多バス instrument は host が単に配線しない ── OOB read
//!   ではなく bus 0 が host の固定 stereo 幅と食い違う場合は load 時点で reject される。
//!   `orbit-vst3-host/src/lib.rs` の `Vst3EffectProcessor::run_process` 直上コメント参照）。
//! - probe 自体の load 失敗/crash/hang（kind 判定前）は **non-gating**（surfaced のみ）。
//!
//! ## 既知の limitation
//! `find_audio_module_class`（orbit-vst3-host/src/lib.rs）は factory の最初の Audio Module Class を
//! 選ぶ。multi-component な VST3 bundle では意図しないクラスを選ぶ可能性がある（informational・
//! 別 issue 相当・本テストはそれを検出も補正もしない）。
//!
//! ## 実行（非サンドボックス・実機のみ）
//! ```text
//! ORBIT_GATED_VST3_DIR=/Library/Audio/Plug-Ins/VST3 \
//! cargo test -p orbit-vst3-effect-child --test real_plugin_gated -- --ignored --nocapture
//! ```
//! 既定は curated 代表セット（下記 `CURATED_NAMES`）。全プラグインを流すには
//! `ORBIT_GATED_VST3_ALL=1`（`ORBIT_GATED_VST3_MAX` で上限）。個別指定は
//! `ORBIT_GATED_VST3_PLUGINS`（`:` 区切りのフルパス）。

use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use orbit_audio_sandbox::{render_through_child_sync_with_options, RenderOptions, CHANNELS};

/// probe 1 本あたりの timeout（load が重い商用プラグイン向けに余裕を持たせる。sweep.sh の実績値
/// 20s を踏襲）。
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

/// effect 駆動の 1 ブロック目（plugin load を含む）の timeout。商用サンプラー等の重い load を吸収。
const FIRST_BLOCK_TIMEOUT: Duration = Duration::from_secs(60);
/// 2 ブロック目以降の timeout。
const STEADY_BLOCK_TIMEOUT: Duration = Duration::from_secs(5);

/// 駆動する総フレーム数(64 と 128 の両方の倍数)。
const TOTAL_FRAMES: usize = 2048;

/// env 未指定時に流す代表セット(owner 環境に存在するものだけを実際には使う)。
const CURATED_NAMES: &[&str] = &[
    "Kontakt 8",
    "Massive X",
    "FM8",
    "Reaktor 6",
    "Guitar Rig 7",
    "Ozone 11",
    "Neutron 5",
    "RX 11 Voice De-noise",
    "Nectar 4",
    "Vinyl",
    "Relay",
];

const DEFAULT_VST3_DIR: &str = "/Library/Audio/Plug-Ins/VST3";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum PluginKind {
    Effect,
    Instrument,
    Unknown,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Outcome {
    Pass,
    Fail,
    Skip,
    Crash,
}

struct Row {
    name: String,
    kind: PluginKind,
    outcome: Outcome,
    detail: String,
}

#[test]
#[ignore = "requires non-sandboxed commercial VST3 measurement environment"]
fn commercial_vst3_oop_smoke_gated() {
    let Some(probe_bin) = resolve_probe_bin() else {
        eprintln!(
            "[real_plugin_gated] vst3_probe binary を用意できなかった — このマシンでは loud skip"
        );
        return;
    };

    let plugins = resolve_plugins();
    if plugins.is_empty() {
        eprintln!(
            "[real_plugin_gated] 対象 VST3 プラグインが無い(ORBIT_GATED_VST3_DIR 非在 or curated \
             セットが 1 つも見つからない) — loud skip"
        );
        return;
    }

    let child_exe = PathBuf::from(env!("CARGO_BIN_EXE_orbit-vst3-effect-child"));
    let mut rows: Vec<Row> = Vec::new();

    for plugin in &plugins {
        let name = plugin
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("<unknown>")
            .to_owned();

        match is_arm64(plugin) {
            Some(true) => {}
            Some(false) => {
                rows.push(Row {
                    name,
                    kind: PluginKind::Unknown,
                    outcome: Outcome::Skip,
                    detail: "Intel-only bundle(arm64 スライス無し)".to_owned(),
                });
                continue;
            }
            None => {
                rows.push(Row {
                    name,
                    kind: PluginKind::Unknown,
                    outcome: Outcome::Skip,
                    detail: "arch 判定不能(bundle 構造異常 or lipo 失敗)".to_owned(),
                });
                continue;
            }
        }

        let Some(plugin_str) = plugin.to_str() else {
            rows.push(Row {
                name,
                kind: PluginKind::Unknown,
                outcome: Outcome::Skip,
                detail: "非 UTF-8 パス".to_owned(),
            });
            continue;
        };

        let probe_run = match run_probe(&probe_bin, plugin, PROBE_TIMEOUT) {
            Ok(r) => r,
            Err(err) => {
                rows.push(Row {
                    name,
                    kind: PluginKind::Unknown,
                    outcome: Outcome::Crash,
                    detail: format!("probe spawn 失敗: {err}"),
                });
                continue;
            }
        };

        if probe_run.timed_out {
            rows.push(Row {
                name,
                kind: PluginKind::Unknown,
                outcome: Outcome::Crash,
                detail: format!("probe が {PROBE_TIMEOUT:?} 以内に終了しなかった(hang)"),
            });
            continue;
        }
        let status = probe_run
            .status
            .expect("timed_out=false ならば status は Some");

        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            if let Some(sig) = status.signal() {
                rows.push(Row {
                    name,
                    kind: PluginKind::Unknown,
                    outcome: Outcome::Crash,
                    detail: format!("probe がシグナル {sig} で終了(crash)"),
                });
                continue;
            }
        }

        if !status.success() && probe_run.stdout.trim().is_empty() {
            rows.push(Row {
                name,
                kind: PluginKind::Unknown,
                outcome: Outcome::Crash,
                detail: format!("probe が JSON 未出力のまま異常終了(status={status:?})"),
            });
            continue;
        }

        let json = probe_run.stdout.as_str();
        let loaded = extract_bool(json, "loaded").unwrap_or(false);
        if !loaded {
            let error = extract_string(json, "error").unwrap_or_default();
            rows.push(Row {
                name,
                kind: PluginKind::Unknown,
                outcome: Outcome::Fail,
                detail: format!("load 失敗(non-gating): {error}"),
            });
            continue;
        }

        let audio_in = extract_i32(json, "audio_in").unwrap_or(0);
        let kind = if audio_in > 0 {
            PluginKind::Effect
        } else {
            PluginKind::Instrument
        };

        let drive = drive_plugin(&child_exe, plugin_str);
        let outcome = if drive.ok {
            Outcome::Pass
        } else {
            Outcome::Fail
        };
        rows.push(Row {
            name,
            kind,
            outcome,
            detail: drive.detail,
        });
    }

    eprintln!(
        "\n=== VST3 Phase 1 gated smoke summary (machinery only; not a DSP-correctness proof) ==="
    );
    for row in &rows {
        eprintln!(
            "{:<6} {:<10} {:<28} {}",
            format!("{:?}", row.outcome),
            format!("{:?}", row.kind),
            row.name,
            row.detail
        );
    }
    eprintln!("=========================================================================\n");

    let effect_failures: Vec<&str> = rows
        .iter()
        .filter(|row| row.kind == PluginKind::Effect && row.outcome == Outcome::Fail)
        .map(|row| row.name.as_str())
        .collect();
    assert!(
        effect_failures.is_empty(),
        "effect gate 破り(crash / process_errors>0 / 未処理ブロック / 非有限 / 発散): {effect_failures:?} \
         — 詳細は上のサマリを参照"
    );
}

/// [`orbit_vst3_host`] の `vst3_probe` バイナリを解決する。別 crate のバイナリなので
/// `CARGO_BIN_EXE_*` は使えない(cargo はテスト対象パッケージ自身のバイナリにしか設定しない)。
/// `sweep.sh`(Phase 0 spike)と同じ資産を自前 build してから、このテストバイナリと同じ
/// target ディレクトリ配下(sibling)を解決する。`current_exe()` は `CARGO_TARGET_DIR` が
/// 設定されていても実際の出力先を反映するため、環境変数を手で読んで再現するより頑健。
fn resolve_probe_bin() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("ORBIT_VST3_PROBE_BIN") {
        let p = PathBuf::from(p);
        if p.exists() {
            return Some(p);
        }
        eprintln!(
            "[real_plugin_gated] ORBIT_VST3_PROBE_BIN={} が存在しない",
            p.display()
        );
        return None;
    }

    let status = Command::new("cargo")
        .args([
            "build",
            "-p",
            "orbit-vst3-host",
            "--bin",
            "vst3_probe",
            "--locked",
        ])
        .status();
    match status {
        Ok(s) if s.success() => {}
        Ok(s) => {
            eprintln!(
                "[real_plugin_gated] `cargo build -p orbit-vst3-host --bin vst3_probe` が失敗(status={s})"
            );
            return None;
        }
        Err(err) => {
            eprintln!(
                "[real_plugin_gated] `cargo build -p orbit-vst3-host --bin vst3_probe` の起動に失敗: {err}"
            );
            return None;
        }
    }

    let mut p = std::env::current_exe().ok()?;
    p.pop(); // test 実行ファイル名を除く
    if p.ends_with("deps") {
        p.pop(); // deps/ を除く → target/<profile>/
    }
    p.push("vst3_probe");
    if p.exists() {
        Some(p)
    } else {
        eprintln!(
            "[real_plugin_gated] vst3_probe binary が見つからない: {}(cargo build 後も未生成)",
            p.display()
        );
        None
    }
}

/// 対象プラグインの一覧を解決する。優先順位: `ORBIT_GATED_VST3_PLUGINS`(`:` 区切りフルパス) →
/// `ORBIT_GATED_VST3_ALL=1` なら `ORBIT_GATED_VST3_DIR`(既定 `/Library/Audio/Plug-Ins/VST3`) 配下の
/// 全 `*.vst3`(`ORBIT_GATED_VST3_MAX` で上限) → それ以外は curated 代表セット(存在するものだけ)。
fn resolve_plugins() -> Vec<PathBuf> {
    if let Ok(list) = std::env::var("ORBIT_GATED_VST3_PLUGINS") {
        return list
            .split(':')
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .collect();
    }

    let dir = std::env::var("ORBIT_GATED_VST3_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(DEFAULT_VST3_DIR));
    if !dir.is_dir() {
        eprintln!(
            "[real_plugin_gated] VST3 ディレクトリが無い: {} — loud skip",
            dir.display()
        );
        return Vec::new();
    }

    if std::env::var("ORBIT_GATED_VST3_ALL").as_deref() == Ok("1") {
        let max: usize = std::env::var("ORBIT_GATED_VST3_MAX")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(usize::MAX);
        let mut entries: Vec<PathBuf> = std::fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("vst3"))
            .collect();
        entries.sort();
        entries.truncate(max);
        entries
    } else {
        CURATED_NAMES
            .iter()
            .map(|name| dir.join(format!("{name}.vst3")))
            .filter(|p| p.exists())
            .collect()
    }
}

/// bundle の唯一の実行ファイル(`Contents/MacOS/<exe>`)が arm64 スライスを含むか。
/// bundle 構造異常や `lipo` 失敗時は `None`(判定不能)。
fn is_arm64(bundle: &Path) -> Option<bool> {
    let macos_dir = bundle.join("Contents").join("MacOS");
    let mut candidates: Vec<PathBuf> = std::fs::read_dir(&macos_dir)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .collect();
    candidates.sort();
    let exe = candidates.into_iter().next()?;

    let output = Command::new("lipo").arg("-archs").arg(&exe).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let archs = String::from_utf8_lossy(&output.stdout);
    Some(archs.split_whitespace().any(|a| a == "arm64"))
}

struct ProbeRun {
    timed_out: bool,
    status: Option<ExitStatus>,
    stdout: String,
}

/// `probe_bin <plugin>` を別プロセスで `timeout` 以内に実行する。timeout 超過時は kill して
/// crash/hang 扱いにする(std のみ・try_wait ポーリング)。stdout の読み取りは別スレッドに逃がす
/// (poll ループ内で `read_to_string` するとパイプが埋まった場合にブロックしうるため)。
fn run_probe(probe_bin: &Path, plugin: &Path, timeout: Duration) -> io::Result<ProbeRun> {
    let mut child = Command::new(probe_bin)
        .arg(plugin)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut stdout_pipe = child.stdout.take().expect("stdout is piped");
    let (tx, rx) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = stdout_pipe.read_to_string(&mut buf);
        let _ = tx.send(buf);
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait()? {
            Some(status) => break Some(status),
            None => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    };
    let stdout = rx.recv_timeout(Duration::from_secs(5)).unwrap_or_default();
    let _ = reader.join();
    Ok(ProbeRun {
        timed_out: status.is_none(),
        status,
        stdout,
    })
}

fn extract_bool(json: &str, key: &str) -> Option<bool> {
    let needle = format!("\"{key}\":");
    let idx = json.find(&needle)? + needle.len();
    let rest = &json[idx..];
    if rest.starts_with("true") {
        Some(true)
    } else if rest.starts_with("false") {
        Some(false)
    } else {
        None
    }
}

fn extract_i32(json: &str, key: &str) -> Option<i32> {
    let needle = format!("\"{key}\":");
    let idx = json.find(&needle)? + needle.len();
    let rest = json[idx..].trim_start();
    let end = rest
        .find(|c: char| !(c.is_ascii_digit() || c == '-'))
        .unwrap_or(rest.len());
    rest[..end].parse().ok()
}

/// `"error":null` または `"error":"..."`(`\"`/`\\` のみエスケープ済み。`to_json_line` の
/// `json_escape` は他の制御文字をエスケープしないため、値に生の改行が含まれる可能性はある ──
/// このパーサは `find` ベースで行分割に依存しないのでそれでも安全)。
fn extract_string(json: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\":");
    let idx = json.find(&needle)? + needle.len();
    let rest = &json[idx..];
    if rest.starts_with("null") {
        return None;
    }
    let rest = rest.strip_prefix('"')?;
    let mut out = String::new();
    let mut chars = rest.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => match chars.next() {
                Some('"') => out.push('"'),
                Some('\\') => out.push('\\'),
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => break,
            },
            '"' => break,
            other => out.push(other),
        }
    }
    Some(out)
}

fn make_signal(total_frames: usize) -> Vec<f32> {
    (0..total_frames * CHANNELS)
        .map(|i| {
            let t = i as f32;
            0.9 * ((t * 0.013).sin())
        })
        .collect()
}

struct DriveOutcome {
    ok: bool,
    detail: String,
}

/// `plugin` を `child_exe`(OOP VST3 effect child)越しに block=[64,128] で駆動し、二層判定の
/// gate 条件(TimedOut でない・process_errors==0・processed==期待ブロック数・全サンプル有限かつ
/// `|x|<=8.0`)を確認する。effect にも instrument にも使う(instrument は呼び出し側で non-gating
/// 扱いにする)。
fn drive_plugin(child_exe: &Path, plugin: &str) -> DriveOutcome {
    let input = make_signal(TOTAL_FRAMES);
    for &block_frames in &[64usize, 128usize] {
        let expected_blocks = (TOTAL_FRAMES / block_frames) as u64;
        let opts = RenderOptions {
            first_block_timeout: FIRST_BLOCK_TIMEOUT,
            block_timeout: STEADY_BLOCK_TIMEOUT,
        };
        let result = render_through_child_sync_with_options(
            child_exe,
            &input,
            block_frames,
            &["--plugin", plugin, "--sample-rate", "48000"],
            opts,
        );
        let (out, stats) = match result {
            Ok(v) => v,
            Err(err) => {
                return DriveOutcome {
                    ok: false,
                    detail: format!(
                        "block={block_frames}f: child round-trip 失敗(crash/hang の可能性): {err}"
                    ),
                };
            }
        };
        if stats.process_errors != 0 {
            return DriveOutcome {
                ok: false,
                detail: format!(
                    "block={block_frames}f: process_errors={}(dry passthrough 発生)",
                    stats.process_errors
                ),
            };
        }
        if stats.processed != expected_blocks {
            return DriveOutcome {
                ok: false,
                detail: format!(
                    "block={block_frames}f: processed={} != 期待{expected_blocks}",
                    stats.processed
                ),
            };
        }
        if out.len() != input.len() {
            return DriveOutcome {
                ok: false,
                detail: format!(
                    "block={block_frames}f: 出力長不一致 {} != {}",
                    out.len(),
                    input.len()
                ),
            };
        }
        if let Some((idx, sample)) = out
            .iter()
            .enumerate()
            .find(|(_, s)| !s.is_finite() || s.abs() > 8.0)
        {
            return DriveOutcome {
                ok: false,
                detail: format!(
                    "block={block_frames}f: sample[{idx}]={sample} 非有限 or 発散(|x|>8.0)"
                ),
            };
        }
    }
    DriveOutcome {
        ok: true,
        detail: "PASS(block 64f/128f, crash 0, process_errors 0, 全サンプル有限・非発散)"
            .to_owned(),
    }
}
