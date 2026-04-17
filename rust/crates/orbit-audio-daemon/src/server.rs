//! WebSocket accept loop.

use std::net::SocketAddr;
use std::sync::Arc;

use tokio::net::{TcpListener, TcpStream};
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
pub async fn serve(listener: TcpListener, engine: Arc<EngineWrap>) {
    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(s) => s,
            Err(e) => {
                warn!("accept error: {e}");
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
    let ws = tokio_tungstenite::accept_async(stream).await?;
    session::run(ws, engine).await?;
    Ok(())
}
