//! WebSocket accept loop.

use std::net::SocketAddr;
use std::sync::Arc;

use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::{header::ORIGIN, StatusCode};
use tracing::{info, warn};

use crate::engine_wrap::EngineWrap;
use crate::session;

pub struct BoundServer {
    pub listener: TcpListener,
    pub addr: SocketAddr,
}

/// localhost の free port に bind して、listener を返す（accept はしない）。
pub async fn bind_localhost() -> std::io::Result<BoundServer> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    Ok(BoundServer { listener, addr })
}

/// accept loop。各接続ごとに新タスクを spawn し、[`session::run`] で処理する。
///
/// accept エラーはすべて永続化し得るため、短い backoff を挟んで tight spin を防ぐ。
pub async fn serve(listener: TcpListener, engine: Arc<EngineWrap>) {
    use std::io::ErrorKind;
    use tokio::time::{sleep, Duration};

    let mut consecutive_errors: u32 = 0;
    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(s) => {
                consecutive_errors = 0;
                s
            }
            Err(e) => {
                consecutive_errors = consecutive_errors.saturating_add(1);
                match e.kind() {
                    // リソース枯渇系: 長めに待って諦め条件も設定
                    ErrorKind::OutOfMemory => {
                        tracing::error!("accept fatal (out of memory): {e}, exiting");
                        return;
                    }
                    _ => {
                        warn!("accept error: {e} (consecutive={consecutive_errors})");
                    }
                }
                if consecutive_errors >= 20 {
                    tracing::error!(
                        "accept error persists for {} attempts, exiting",
                        consecutive_errors
                    );
                    return;
                }
                // Tight spin 防止: 100ms backoff
                sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        info!("accepted connection from {peer}");
        let engine_for_task = engine.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_connection(stream, engine_for_task).await {
                warn!("connection closed with error: {e}");
            }
        });
    }
}

async fn handle_connection(
    stream: TcpStream,
    engine: Arc<EngineWrap>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let ws = tokio_tungstenite::accept_hdr_async(stream, reject_browser_origin).await?;
    session::run(ws, engine).await?;
    Ok(())
}

/// **Origin ヘッダのある**ハンドシェイクを 403 で拒否する（#996・設計 848 §4.7）。
///
/// WebSocket のハンドシェイクには CORS の preflight が無く、利用者のブラウザで開いた任意のページから
/// `ws://127.0.0.1:<port>` に届きうる。RFC 6455 §10.2 は、特定のページ以外からの入力を扱わない
/// サーバは Origin を検証すべき（SHOULD）としている。daemon は `LoadPlugin { path }`（ネイティブ
/// コードの読み込み）を受け付けるので、ブラウザからの接続を通してはいけない。ブラウザは Origin を
/// 必ず付け（RFC 6455 §4.1）、ページのスクリプトからは外せない。daemon のクライアントは engine
/// （Node の `ws`）だけで、Origin を付けない。値は見ない — `null`（sandbox の iframe・`file://`）も拒否する。
// 戻り値の型は tungstenite の `handshake::server::Callback` が決めている（変えられない）。
#[allow(clippy::result_large_err)]
fn reject_browser_origin(request: &Request, response: Response) -> Result<Response, ErrorResponse> {
    let Some(origin) = request.headers().get(ORIGIN) else {
        return Ok(response);
    };
    warn!("rejected a WebSocket handshake with Origin {origin:?}: only non-browser clients may connect");
    let mut rejection = ErrorResponse::new(Some("Origin header is not allowed".to_string()));
    *rejection.status_mut() = StatusCode::FORBIDDEN;
    Err(rejection)
}
