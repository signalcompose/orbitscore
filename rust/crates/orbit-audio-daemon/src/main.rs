//! orbit-audio-daemon entry point.
//!
//! 起動シーケンス:
//! 1. audio output を初期化
//! 2. localhost free port に WebSocket listener を bind
//! 3. stdout に 1 行 JSON で port と protocol_version を出力
//! 4. accept loop を回す
//!
//! 起動失敗時は stderr に 1 行 JSON を出して非ゼロ exit code で終了する。

use orbit_audio_daemon::best_effort_stderr::{best_effort_stderr, write_line_best_effort};
use orbit_audio_daemon::engine_wrap::{DeviceSwitchRequest, EngineWrap, WrapError};
use orbit_audio_daemon::protocol::{
    Event, ProtocolError, StartupError, StartupReady, ERROR_CODE_FATAL_PANIC, ERROR_SEVERITY_FATAL,
    EVENT_DAEMON_ERROR, PROTOCOL_VERSION,
};
use orbit_audio_daemon::server;
use serde_json::json;
use std::sync::Arc;

// 既知事項（#448）: この daemon には SIGTERM/SIGINT ハンドラが無く、`install_fatal_panic_hook`
// の panic hook も `process::exit(1)` を hook 内から直接呼ぶ（unwind が supervisor 保持フレーム
// まで届く前に終了する）。そのため通常の client 側 `SIGTERM → SIGKILL` 停止（daemon-client.ts
// `killChildGracefully`）や panic では、`InstrumentChildSupervisor` / `EffectChildSupervisor` の
// `Drop`（CONTROL_QUIT 送出）が実行されず、out-of-process CLAP/VST3 child が孤児化し得る。
// `server::serve` の accept loop 内タスクが `Arc<EngineWrap>` を clone して保持するため、
// main() のローカル drop だけでは決定論的な shutdown にならず、まとまった graceful-shutdown
// 配線（signal → 全 clone 収束待ち → drop）が必要になる（本 issue のスコープ外・別 issue 向き）。
// 本 issue の本命防御は child 側（[`orbit_audio_sandbox::ParentWatch`]）: どの死に方でも
// child が親の死亡を自力で検知して抜けるため、この daemon 側ギャップの実害を軽減する。
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    tracing_subscriber::fmt()
        .with_writer(best_effort_stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    install_fatal_panic_hook();

    if let Err(code) = run().await {
        std::process::exit(code);
    }
}

/// panic 時に DaemonError event の wire format を stderr に出力し、
/// `process::exit(1)` で daemon を確実に終了させる。
///
/// WebSocket と stderr で同じ schema を使うため、client は transport
/// を問わず同じ parser で fatal を扱える。`StartupError { ready: false }`
/// は pre-ready 失敗専用なので意図的に使わない。
fn install_fatal_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let msg = format!("{info}");
        let evt = Event::new(
            EVENT_DAEMON_ERROR,
            json!({
                "severity": ERROR_SEVERITY_FATAL,
                "code": ERROR_CODE_FATAL_PANIC,
                "message": msg,
            }),
        );
        // 🔴 #605: ここで `eprintln!` を使ってはいけない。stderr が壊れていると
        // **panic hook 自身が panic** し、`panic_with_hook` の再帰検知が
        // `process::abort()` を呼ぶ。すると下の `exit(1)` に到達できず、
        // client は「終了コード 1 + DaemonError 行」ではなく **SIGABRT** を見る。
        match serde_json::to_string(&evt) {
            Ok(line) => write_line_best_effort(&line),
            Err(e) => write_line_best_effort(&format!(
                r#"{{"type":"event","event":"{EVENT_DAEMON_ERROR}","data":{{"severity":"{ERROR_SEVERITY_FATAL}","code":"{ERROR_CODE_FATAL_PANIC}","message":"panic hook serialize failed: {e}"}}}}"#
            )),
        }
        std::process::exit(1);
    }));
}

async fn run() -> Result<(), i32> {
    // -1. `--list-audio-devices`（#484 D3）: cpal 列挙のみ行い stdout に JSON 一覧を出して即 exit
    // する軽量モード。stream は開かない（ハングリスクを避ける・上の `resolve_output_device` の
    // Aggregate デバイス probe 回避コメント参照）。通常起動（WebSocket listener bind・accept loop）
    // には進まない。
    if has_list_audio_devices_flag(std::env::args().skip(1)) {
        return run_list_audio_devices();
    }

    // 0. `--audio-device <name>` を解析し、`ORBIT_AUDIO_DEVICE` env へ反映する（#484 D1）。
    // 実際の device 解決（列挙・一致判定・不一致時の縮退警告）は `orbit-audio-native`
    // 側（`resolve_output_device`）が cpal I/O を伴って行う。ここでは env に橋渡しするだけ
    // （`engine_wrap::device_name_from_env` が capture_path_from_env と同じ層分けで読む）。
    apply_audio_device_arg(std::env::args().skip(1));

    // 1. Engine を起動（audio device 取得）。ランタイム device switch（#484 D2）に備え、実際の
    // `EngineWrap::start()` 呼び出しと `StreamGuard` の生存管理を専用 OS thread（"audio owner
    // thread"）へ委譲する — `cpal::Stream` は `!Send` なので、以降 tokio worker 間を自由に飛び回る
    // 通常の async task にはハンドルを一切持ち込めない。
    let engine = match start_engine_with_device_switch() {
        Ok(e) => e,
        Err(e) => {
            report_startup_failure(ProtocolError::new("DEVICE_CONFIG_ERROR", e.to_string()));
            return Err(1);
        }
    };

    // 2. WebSocket listener bind
    let bound = match server::bind_localhost().await {
        Ok(b) => b,
        Err(e) => {
            report_startup_failure(ProtocolError::new("INTERNAL_ERROR", e.to_string()));
            return Err(2);
        }
    };
    let port = bound.addr.port();

    // 3. stdout に ready line を出力（改行 + flush）
    let ready = StartupReady {
        ready: true,
        port,
        protocol_version: PROTOCOL_VERSION,
    };
    let line = serde_json::to_string(&ready).unwrap_or_else(|_| {
        format!(r#"{{"ready":true,"port":{port},"protocol_version":"{PROTOCOL_VERSION}"}}"#)
    });
    println!("{line}");
    use std::io::Write;
    let _ = std::io::stdout().flush();

    tracing::info!("orbit-audio-daemon listening on 127.0.0.1:{port}");

    // 4. accept loop
    server::serve(bound.listener, engine).await;
    Ok(())
}

/// ランタイム device switch（#484 D2）: `EngineWrap::start()`（cpal I/O・`cpal::Stream` は `!Send`）を
/// 専用 OS thread（"audio owner thread"）上で実行し、その thread に `StreamGuard` を生涯所有させる。
/// 呼び出し元（`run()`・tokio 上の async fn）は `Arc<EngineWrap>`（`Send + Sync`）だけを受け取る。
///
/// 以後の `SelectAudioDevice` RPC は `EngineWrap::select_audio_device` → `mpsc` 経由でこの thread に
/// 委譲され、この thread が [`EngineWrap::apply_device_switch`] で実際の cpal `Device`/`Stream` 差し替え
/// を行う。thread は `switch_rx` が close する（= `engine.device_switch_tx` を保持する最後の `Arc`
/// が drop される）まで無期限に生存し、`_guard`（`StreamGuard`）を握り続ける — 既存の「`main()` の
/// ローカル変数が daemon プロセス終了まで guard を握る」という寿命モデルと同一。
fn start_engine_with_device_switch() -> Result<Arc<EngineWrap>, WrapError> {
    let (switch_tx, switch_rx) = std::sync::mpsc::channel::<DeviceSwitchRequest>();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<Arc<EngineWrap>, WrapError>>();

    std::thread::Builder::new()
        .name("orbit-audio-owner".into())
        .spawn(move || {
            let (engine, mut guard) = match EngineWrap::start() {
                Ok(pair) => pair,
                Err(e) => {
                    // ready_rx 側が既に drop されていても（呼び出し元が別経路で失敗した等）
                    // send 失敗は無視してよい — 報告先が無いだけで、この thread はそのまま終了する。
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };
            engine.install_device_switch_channel(switch_tx);
            if ready_tx.send(Ok(engine.clone())).is_err() {
                // 呼び出し元が既に諦めている（recv 側 drop）。stream 起動には成功しているので、
                // 静かに guard を保持したまま待ち受けを続ける意味はない — 即座に終了して stream を
                // 閉じる（プロセス自体は起動失敗として既に exit 済みのはず）。
                return;
            }
            // switch_rx: 要求が来る限り処理し続ける。`engine`（延いては `device_switch_tx` の
            // Sender clone）が全て drop されるとこの for ループは自然終了するが、`Arc<EngineWrap>`
            // は `server::serve` の accept loop タスクが保持し続けるため、実運用ではプロセスが
            // 生きている間ずっとブロックしたままになる（既存の「グレースフルシャットダウン機構が
            // 無い」という #448 既知事項と同じ前提）。
            for req in switch_rx {
                let result = engine.apply_device_switch(&mut guard, req.device);
                let _ = req.reply.send(result);
            }
        })
        .expect("spawn audio owner thread");

    ready_rx
        .recv()
        .expect("audio owner thread exited before reporting readiness")
}

/// `--audio-device <name>` を argv から抽出する純関数（#484 D1）。値が欠けている（末尾で
/// 引数無し）場合は `None` を返し無視する（起動は既定デバイスで続行 — 起動失敗にしない）。
/// 複数回指定された場合は最後の指定を優先する（CLI の一般的な慣習）。
fn parse_audio_device_arg<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    let mut result = None;
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        if arg == "--audio-device" {
            result = iter.next();
        }
    }
    result
}

/// argv から `--audio-device` を解析し、見つかれば `ORBIT_AUDIO_DEVICE` env へ反映する
/// （`EngineWrap::start()` 到達前に呼ぶ必要がある・main の起動シーケンス step 0）。
fn apply_audio_device_arg<I: IntoIterator<Item = String>>(args: I) {
    if let Some(name) = parse_audio_device_arg(args) {
        // SAFETY: main() 起動シーケンス冒頭・単一スレッドで他スレッド生成前に呼ばれるため、
        // env の読み書き競合は発生しない（tokio worker はまだ起動していない）。
        unsafe {
            std::env::set_var("ORBIT_AUDIO_DEVICE", name);
        }
    }
}

/// argv に `--list-audio-devices` フラグが含まれるかを判定する純関数（#484 D3）。
fn has_list_audio_devices_flag<I: IntoIterator<Item = String>>(args: I) -> bool {
    args.into_iter().any(|arg| arg == "--list-audio-devices")
}

/// `--list-audio-devices` モードの実処理（#484 D3）。`orbit_audio_native::list_output_devices()`
/// で cpal 列挙のみ行い、1 行 JSON で stdout に出力して終了する。TS 側（VS Code extension の
/// Engine ビュー・D3）はこのプロセスを spawn → 1 行読んで即 exit を待つ想定。列挙失敗時は
/// stderr に理由を出し非ゼロ exit（通常起動の `report_startup_failure` と同じ schema は使わない
/// — こちらは WebSocket プロトコルの外側の一過性 CLI 呼び出しのため）。
fn run_list_audio_devices() -> Result<(), i32> {
    match orbit_audio_native::list_output_devices() {
        Ok(devices) => {
            // wire 形は session.rs `ListAudioDevices` ハンドラと同じフィールド名に揃える
            // （`AudioDeviceInfo` は Serialize を derive していないため手動でマップする）。
            let devices: Vec<serde_json::Value> = devices
                .into_iter()
                .map(|d| {
                    json!({
                        "name": d.name,
                        "isDefault": d.is_default,
                        "maxOutputChannels": d.max_output_channels,
                        "defaultSampleRate": d.default_sample_rate,
                        "direction": d.direction,
                    })
                })
                .collect();
            let line = serde_json::to_string(&json!({ "devices": devices }))
                .unwrap_or_else(|_| r#"{"devices":[]}"#.to_string());
            println!("{line}");
            use std::io::Write;
            let _ = std::io::stdout().flush();
            Ok(())
        }
        Err(e) => {
            // 🔴 #612: subscriber 稼働後なので best-effort（`eprintln!` の panic が
            // hook 経由の `exit(1)` を招き、device 列挙の失敗報告が daemon 終了に化ける）。
            write_line_best_effort(&format!(r#"{{"error":"{e}"}}"#));
            Err(1)
        }
    }
}

fn report_startup_failure(error: ProtocolError) {
    let payload = StartupError {
        ready: false,
        error,
    };
    let line = serde_json::to_string(&payload).unwrap_or_else(|_| {
        r#"{"ready":false,"error":{"code":"INTERNAL_ERROR","message":"startup error serialization failed"}}"#.to_string()
    });
    // 🔴 #612: startup error は client が parse する wire の一部。書けない状況では
    // どのみち client に届かないが、`eprintln!` の panic で終了コードの意味論が
    // 変わる（`Err(1)` のつもりが hook 経由になる）ため best-effort に揃える。
    write_line_best_effort(&line);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_audio_device_arg_absent() {
        let args = ["--foo".to_string(), "bar".to_string()];
        assert_eq!(parse_audio_device_arg(args), None);
    }

    #[test]
    fn parse_audio_device_arg_present() {
        let args = ["--audio-device".to_string(), "USB Audio".to_string()];
        assert_eq!(parse_audio_device_arg(args), Some("USB Audio".to_string()));
    }

    #[test]
    fn parse_audio_device_arg_missing_value_ignored() {
        // 末尾で値が欠けている（typo 等）場合は起動を落とさず None へ縮退する。
        let args = ["--audio-device".to_string()];
        assert_eq!(parse_audio_device_arg(args), None);
    }

    #[test]
    fn parse_audio_device_arg_last_occurrence_wins() {
        let args = [
            "--audio-device".to_string(),
            "First".to_string(),
            "--audio-device".to_string(),
            "Second".to_string(),
        ];
        assert_eq!(parse_audio_device_arg(args), Some("Second".to_string()));
    }

    #[test]
    fn list_audio_devices_flag_absent() {
        let args = ["--audio-device".to_string(), "USB Audio".to_string()];
        assert!(!has_list_audio_devices_flag(args));
    }

    #[test]
    fn list_audio_devices_flag_present() {
        let args = ["--list-audio-devices".to_string()];
        assert!(has_list_audio_devices_flag(args));
    }

    #[test]
    fn list_audio_devices_flag_present_among_others() {
        let args = [
            "--audio-device".to_string(),
            "USB Audio".to_string(),
            "--list-audio-devices".to_string(),
        ];
        assert!(has_list_audio_devices_flag(args));
    }
}
