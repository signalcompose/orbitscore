//! orbit-audio-daemon entry point.
//!
//! 起動シーケンス:
//! 1. audio output を初期化
//! 2. localhost free port に WebSocket listener を bind
//! 3. stdout に 1 行 JSON で port と protocol_version を出力
//! 4. accept loop を回す
//!
//! 起動失敗時は stderr に 1 行 JSON を出して非ゼロ exit code で終了する。

use orbit_audio_daemon::engine_wrap::EngineWrap;
use orbit_audio_daemon::protocol::{
    Event, ProtocolError, StartupError, StartupReady, ERROR_CODE_FATAL_PANIC, ERROR_SEVERITY_FATAL,
    EVENT_DAEMON_ERROR, PROTOCOL_VERSION,
};
use orbit_audio_daemon::server;
use serde_json::json;

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
        .with_writer(std::io::stderr)
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
        match serde_json::to_string(&evt) {
            Ok(line) => eprintln!("{line}"),
            Err(e) => eprintln!(
                r#"{{"type":"event","event":"{EVENT_DAEMON_ERROR}","data":{{"severity":"{ERROR_SEVERITY_FATAL}","code":"{ERROR_CODE_FATAL_PANIC}","message":"panic hook serialize failed: {e}"}}}}"#
            ),
        }
        std::process::exit(1);
    }));
}

async fn run() -> Result<(), i32> {
    // 0. `--audio-device <name>` を解析し、`ORBIT_AUDIO_DEVICE` env へ反映する（#484 D1）。
    // 実際の device 解決（列挙・一致判定・不一致時の縮退警告）は `orbit-audio-native`
    // 側（`resolve_output_device`）が cpal I/O を伴って行う。ここでは env に橋渡しするだけ
    // （`engine_wrap::device_name_from_env` が capture_path_from_env と同じ層分けで読む）。
    apply_audio_device_arg(std::env::args().skip(1));

    // 1. Engine を起動（audio device 取得）
    let (engine, _stream_guard) = match EngineWrap::start() {
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

fn report_startup_failure(error: ProtocolError) {
    let payload = StartupError {
        ready: false,
        error,
    };
    let line = serde_json::to_string(&payload).unwrap_or_else(|_| {
        r#"{"ready":false,"error":{"code":"INTERNAL_ERROR","message":"startup error serialization failed"}}"#.to_string()
    });
    eprintln!("{line}");
    use std::io::Write;
    let _ = std::io::stderr().flush();
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
}
