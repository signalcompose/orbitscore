//! orbit-audio-daemon entry point.
//!
//! 起動シーケンス:
//! 1. audio output を初期化
//! 2. localhost free port に WebSocket listener を bind
//! 3. stdout に 1 行 JSON で port と protocol_version を出力
//! 4. accept loop を回す
//!
//! 起動失敗時は stderr に 1 行 JSON を出して非ゼロ exit code で終了する。

mod engine_wrap;
mod protocol;
mod server;
mod session;

use engine_wrap::EngineWrap;
use protocol::{ProtocolError, StartupError, StartupReady, PROTOCOL_VERSION};

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    if let Err(code) = run().await {
        std::process::exit(code);
    }
}

async fn run() -> Result<(), i32> {
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
