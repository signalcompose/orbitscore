//! Integration test harness for `orbit-audio-daemon`.
//!
//! [`TestDaemon`] は `StubBackend` 経由で `EngineWrap` を audio device なしに
//! 起動し、`server::bind_localhost` + `server::serve` を tokio task に乗せて
//! TCP loopback で待ち受ける。各テストは `TestDaemon::start().await` で
//! 立ち上げ、scope 終了時の `Drop` で accept loop を abort する。

use std::net::SocketAddr;
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use orbit_audio_daemon::backend::StubBackend;
use orbit_audio_daemon::engine_wrap::EngineWrap;
use orbit_audio_daemon::server;
use orbit_audio_native::StreamStats;
use serde_json::Value;
use tokio::net::TcpStream;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

pub type WsClient = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Test-only daemon handle. drop されると accept loop を abort する。
pub struct TestDaemon {
    pub addr: SocketAddr,
    pub stats: Arc<StreamStats>,
    #[allow(dead_code)]
    pub engine: Arc<EngineWrap>,
    serve_handle: JoinHandle<()>,
    // 実装保持用: cpal::Stream 等の guard（StubBackend では Box<()>）
    _audio_guard: Box<dyn std::any::Any + Send>,
}

impl TestDaemon {
    /// `StubBackend` を使って daemon を起動する。
    pub async fn start() -> Self {
        let (engine, guard) = EngineWrap::start_with(StubBackend::default())
            .expect("StubBackend start should not fail");
        let stats = engine.stream_stats_arc();
        let bound = server::bind_localhost()
            .await
            .expect("bind_localhost should succeed on loopback");
        let addr = bound.addr;
        let engine_for_serve = engine.clone();
        let serve_handle = tokio::spawn(async move {
            server::serve(bound.listener, engine_for_serve).await;
        });
        Self {
            addr,
            stats,
            engine,
            serve_handle,
            _audio_guard: guard,
        }
    }

    /// WebSocket クライアントを接続し、handshake フレームを読み飛ばして返す。
    pub async fn connect(&self) -> WsClient {
        let url = format!("ws://{}", self.addr);
        let (ws, _resp) = connect_async(url)
            .await
            .expect("connect_async should succeed");
        ws
    }

    /// handshake を受信するヘルパー。
    pub async fn recv_handshake(ws: &mut WsClient) -> Value {
        let msg = next_text(ws).await;
        serde_json::from_str(&msg).expect("handshake should be JSON")
    }
}

impl Drop for TestDaemon {
    fn drop(&mut self) {
        // accept loop は listener が drop されるまで止まらないので
        // spawn した task を abort して runtime を cleanly 終了させる。
        //
        // `server::serve` 内で per-connection に `tokio::spawn` された session
        // task は個別 abort しない。各テストは `flavor = "current_thread"` で
        // 専用 runtime を持ち、関数終了時に runtime ごと drop されるため、
        // 残存 session task もそのタイミングで回収される。
        self.serve_handle.abort();
    }
}

/// 次の Text フレームを取り出す（Close/Binary は expect で失敗）。
pub async fn next_text(ws: &mut WsClient) -> String {
    loop {
        match ws.next().await {
            Some(Ok(Message::Text(t))) => return t,
            Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => continue,
            Some(Ok(other)) => panic!("unexpected ws frame: {other:?}"),
            Some(Err(e)) => panic!("ws recv error: {e}"),
            None => panic!("ws closed unexpectedly"),
        }
    }
}

/// 次の Text フレームを JSON として parse する。
pub async fn next_json(ws: &mut WsClient) -> Value {
    let text = next_text(ws).await;
    serde_json::from_str(&text).expect("response should be JSON")
}

/// 指定 id のレスポンスを受信するまで、途中に挟まる event を読み飛ばす。
///
/// StreamStats event は `start_paused = true` でも runtime が自動進行するケース
/// があり、先に到着することが多い。本ヘルパーはコマンド往復専用。
pub async fn recv_reply_for_id(ws: &mut WsClient, id: &str) -> Value {
    let (resp, _events) = recv_reply_with_events(ws, id).await;
    resp
}

/// reply を待ちつつ、途中で見た event を別途返す。
///
/// PlayStarted が reply より先に来るケース（`PlayAt` の実装順序）で、
/// event を discard せず保持したいテスト向け。
///
/// `StreamStats` は 1 Hz ticker が連続で積むことがあるため、scan budget の
/// 圧迫を避けて `events` には含めない（純 StreamStats を検証するテストは
/// `recv_reply_for_id` を使わず直接 `next_json` でドレインする）。
pub async fn recv_reply_with_events(ws: &mut WsClient, id: &str) -> (Value, Vec<Value>) {
    let mut events = Vec::new();
    for _ in 0..64 {
        let msg = next_json(ws).await;
        if msg["id"] == id {
            return (msg, events);
        }
        if msg["type"] == "event" && msg["event"] != "StreamStats" {
            events.push(msg);
        }
    }
    panic!("did not receive reply for id={id} within 64 messages");
}

/// Command を JSON 文字列で送る。
pub async fn send_cmd(ws: &mut WsClient, id: &str, method: &str, params: Value) {
    let payload = serde_json::json!({
        "id": id,
        "method": method,
        "params": params,
    });
    ws.send(Message::Text(payload.to_string()))
        .await
        .expect("send cmd");
}

/// 虚時間を進める前後で spawn タスクに実行機会を与える。
///
/// `tokio::time::advance()` だけでは spawn されている stats ticker や
/// PlayEnded 遅延 task が必ずしも実行されない。各 advance の前後で
/// 複数回 `yield_now().await` を呼ぶことで、協調スケジューリング上
/// それらの task に順番を回す。
///
/// なお `tokio::time::pause` 状態では「全 task が park すると次の pending
/// timer まで自動で時計が進む」仕様 (docs.rs/tokio/latest/tokio/time/fn.pause)。
/// そのため `tokio::time::timeout(50ms, ...)` を含む drain loop は単一 poll
/// 化せず、auto-advance により実時間を待たずに timeout として成立する。
pub async fn advance_and_yield(duration: std::time::Duration) {
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    tokio::time::advance(duration).await;
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
}
