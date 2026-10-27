//! WebSocket ハンドシェイクの Origin 検査（#996・設計 848 §4.7）。
//!
//! daemon は `LoadPlugin { path }` を受け付けるので、ブラウザ（必ず Origin を付ける）からの
//! 接続を通してはいけない。engine（Node の `ws`）は Origin を付けないので従来どおり通る。

// common の helper のうち、ここで使うのは TestDaemon の起動と接続だけ。
#[allow(dead_code)]
mod common;

use common::TestDaemon;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderValue, StatusCode};
use tokio_tungstenite::tungstenite::Error as WsError;

/// Origin の値を問わず 403 で拒否し、拒否の後も accept loop は次の接続を受ける。
#[tokio::test]
async fn handshake_with_any_origin_is_rejected_with_403() {
    let daemon = TestDaemon::start().await;
    for origin in ["https://example.com", "null", "http://127.0.0.1:5173"] {
        let mut request = format!("ws://{}", daemon.addr)
            .into_client_request()
            .expect("request");
        request
            .headers_mut()
            .insert("Origin", HeaderValue::from_static(origin));
        match connect_async(request).await {
            Err(WsError::Http(response)) => {
                assert_eq!(response.status(), StatusCode::FORBIDDEN, "Origin {origin}")
            }
            Ok(_) => panic!("handshake with Origin {origin} must be rejected"),
            Err(other) => panic!("Origin {origin}: expected HTTP 403, got {other}"),
        }
    }

    let mut ws = daemon.connect().await;
    let handshake = TestDaemon::recv_handshake(&mut ws).await;
    assert_eq!(handshake["type"], "handshake");
}

/// Origin の無い接続（engine の形）は従来どおり通り、handshake フレームを受け取る。
#[tokio::test]
async fn handshake_without_origin_is_accepted() {
    let daemon = TestDaemon::start().await;
    let (mut ws, response) = connect_async(format!("ws://{}", daemon.addr))
        .await
        .expect("a handshake without Origin must be accepted");
    assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
    let handshake = TestDaemon::recv_handshake(&mut ws).await;
    assert_eq!(handshake["type"], "handshake");
}
