# Engine Daemon IPC Protocol Specification (v0.1 draft)

**ステータス**: Draft（Issue #93 の初期設計）
**最終更新**: 2026-04-17
**対象バージョン**: protocol v0.1 (Phase 1b)
**関連 Issue**: [#93](https://github.com/signalcompose/orbitscore/issues/93), [#107](https://github.com/signalcompose/orbitscore/issues/107), [#108](https://github.com/signalcompose/orbitscore/issues/108)

---

## 1. 目的

TypeScript 側アプリケーション層（VS Code extension / interpreter）と Rust 側 audio engine (`orbit-audio-daemon`) を繋ぐ **IPC プロトコル**を定義する。

このプロトコルは以下を満たす:

- **汎用**: OrbitScore 以外のアプリケーションも同じ daemon を使える
- **明示的**: 全てのコマンドとイベントが型付き JSON メッセージ
- **秒ベース**: Musical time (BPM / 拍子) は呼び出し側が秒に変換して渡す
- **拡張可能**: Phase 2 以降の MIDI Event / Plugin 操作を破壊的変更なしに追加できる

---

## 2. トランスポートと接続

### 2.1 トランスポート

- **WebSocket over localhost**: `ws://127.0.0.1:<port>`
- `<port>` は daemon 起動時に自動選択（OS から free port 取得）
- daemon は選択した port を **stdout に 1 行 JSON**（改行終端、即 flush）で出力:

```json
{"ready": true, "port": 52913, "protocol_version": "0.1"}
```

クライアントは stdout をキャプチャしてこれを読み、接続する。
改行コードは `\n`（LF）を正、Windows でも `\r` をトリムして解釈すること。

### 2.1.1 起動失敗の通知と stderr 監視

daemon が起動中に失敗した場合（audio device 取得失敗、port bind 失敗、Rust panic 等）:

- **stderr** に 1 行 JSON を出力して非ゼロ終了コードで exit:

```json
{"ready": false, "error": {"code": "DEVICE_NOT_FOUND", "message": "No audio device available"}}
```

クライアントは以下の順序とタイムアウトで起動を監視する:

1. **stderr は stdout と並行監視**を開始（sequential ではない）
2. stdout の ready line を最大 **10 秒**待つ
3. ready line 未到達で期限到来 → stderr の内容を error として報告、daemon を kill
4. ready line 到達 → WebSocket 接続開始。接続タイムアウト **3 秒**
5. WebSocket connect 失敗 → **その時点での stderr 出力を error 診断情報として含めて**報告、daemon を kill
6. WebSocket connect 成功 → handshake フレーム待ち最大 **5 秒**
7. handshake timeout → 同様に stderr を確認してから報告

### 2.2 認証 / 権限

- `127.0.0.1` のみ bind（外部接続拒否）
- トークン認証なし（localhost 前提）
- 将来的にリモート対応する場合は別 protocol version で token ベース認証を追加

### 2.3 エンコーディング

- UTF-8 JSON テキストフレーム
- バイナリフレームは使用しない（大きいサンプルデータはパス渡し）

### 2.4 接続ライフサイクル

```
Client                          Daemon
  |------ WebSocket connect ------>|
  |<----- OK (handshake frame) -----|
  |------ Command (id=1) --------->|
  |<----- Response (id=1) ---------|
  |                                |
  |<----- Event (notification) ----|
  |                                |
  |------ Command (id=2) --------->|
  |<----- Response (id=2) ---------|
  |                                |
  |------ WebSocket close -------->|
```

### 2.5 ハンドシェイク

最初のフレームとして daemon が送信:

```json
{
  "type": "handshake",
  "protocol_version": "0.1",
  "daemon_version": "0.0.1",
  "capabilities": ["playback", "src"]
}
```

- クライアントはハンドシェイク到達を **5 秒**のタイムアウトで待つ
- 期限内に届かなければ WebSocket を閉じ、daemon プロセスを kill してエラー通知
- `protocol_version` の **major** 不一致なら即切断（v0.x と v1.x は互換なし）
- **minor** 違いは警告ログを出して継続（forward-compatible fields は無視）

---

## 3. メッセージの種類

3 種類のメッセージを扱う:

| タイプ | 方向 | 識別 | 応答 |
|---|---|---|---|
| **Command** | Client → Daemon | `id` 必須 | 同 `id` の Response が返る |
| **Response** | Daemon → Client | 同 `id` | — |
| **Event** | Daemon → Client | `id` なし | — |

### 3.1 Command フォーマット

JSON-RPC 2.0 の影響を受けた独自形式:

```json
{
  "id": "uuid-v4",
  "method": "LoadSample",
  "params": { "path": "/abs/path.wav" }
}
```

- `id`: クライアントが生成する UUID v4（応答照合用）
- `method`: CamelCase のコマンド名
- `params`: メソッド固有のパラメータオブジェクト

### 3.2 Response フォーマット

成功時:

```json
{
  "id": "uuid-v4",
  "result": { "sample_id": "s-123" }
}
```

失敗時:

```json
{
  "id": "uuid-v4",
  "error": {
    "code": "SAMPLE_NOT_FOUND",
    "message": "file does not exist",
    "details": { "path": "/abs/path.wav" }
  }
}
```

### 3.3 Event フォーマット

```json
{
  "type": "event",
  "event": "PlayEnded",
  "data": { "play_id": "p-456", "ended_at_sec": 2.345 }
}
```

- `id` がないことで Event と判別
- `event` は CamelCase のイベント名

### 3.4 Command タイムアウト / 接続断ポリシー

- **Command timeout**: 既定 **30 秒**。指定時間内に `id` 一致の Response が届かなければ
  クライアントは `COMMAND_TIMEOUT` エラーとして扱い、WebSocket 接続を fatal とみなす
- **自動 retry なし**: 既定では失敗 Command を再送しない（副作用の二重実行防止）
- **WebSocket 切断**: fatal として扱う
  - in-flight Command は全て失敗として reject
  - 自動 reconnect は行わず、クライアント UI にエラー通知
  - 再接続はユーザーアクション（明示的な再接続コマンド）に限定
  - **daemon 側の責務**: TCP FIN 受信時点で全ての再生 / ロード済みサンプルを即座にクリーンアップ。クライアントが Stop 等で後始末を送る必要はない（送れないため）
- **idempotency**: 本 protocol の command は**非冪等**を前提。再送は呼び出し側が判断

---

## 4. Phase 1 Commands（必須）

### LoadSample

音声ファイルを daemon にロードし、後続の `PlayAt` で参照できる `sample_id` を返す。

```json
// Request
{
  "id": "u1",
  "method": "LoadSample",
  "params": { "path": "/abs/path/kick.wav" }
}

// Response
{
  "id": "u1",
  "result": { "sample_id": "s-7b4e", "frames": 24000, "channels": 1, "sample_rate": 48000 }
}
```

- `path` は絶対パス（symlink は解決される）
- daemon はロード時に project SR へ自動リサンプル（Issue #100 の実装）

### UnloadSample

ロード済みサンプルを破棄（メモリ解放）。

```json
{
  "id": "u2",
  "method": "UnloadSample",
  "params": { "sample_id": "s-7b4e" }
}
```

### PlayAt

指定時刻にサンプルを発音。

```json
{
  "id": "u3",
  "method": "PlayAt",
  "params": {
    "time_sec": 0.5,
    "sample_id": "s-7b4e",
    "gain": 1.0,
    "pan": 0.0
  }
}

// Response
{
  "id": "u3",
  "result": { "play_id": "p-a9f2" }
}
```

- `time_sec`: daemon 内部 transport の基準時刻（起動時に 0.0 からスタート、`ResetTransport` で reset 可能 / Phase 2 で検討）。詳細はセクション 11 の Open Questions 参照
- `gain`: `[0.0, ∞)`。範囲外（負値）は `PARAM_OUT_OF_RANGE` で reject。上限超過はクリッピング前提で accept
- `pan`: `[-1.0, 1.0]`。範囲外は自動 clamp（UX 優先、reject しない）、省略時は 0.0

### Stop

発音中の再生を停止（冪等: 存在しない / 終了済み play_id でも成功）。

```json
// Request
{
  "id": "u4",
  "method": "Stop",
  "params": { "play_id": "p-a9f2" }
}

// Response (playing / already-stopped 両方とも同じ構造)
{
  "id": "u4",
  "result": { "play_id": "p-a9f2", "status": "stopped" | "already_stopped" | "not_found" }
}
```

### SetGlobalGain

マスターゲインを設定（ramp 付き）。

```json
{
  "id": "u5",
  "method": "SetGlobalGain",
  "params": { "value": 0.8, "ramp_sec": 0.1 }
}
```

### GetStatus

daemon の状態取得。

```json
{
  "id": "u6",
  "method": "GetStatus"
}

// Response
{
  "id": "u6",
  "result": {
    "daemon_version": "0.0.1",
    "protocol_version": "0.1",
    "uptime_sec": 123.4,
    "output_sample_rate": 48000,
    "output_channels": 2,
    "loaded_samples": 12,
    "active_plays": 3
  }
}
```

### Ping

接続確認。

```json
{ "id": "u7", "method": "Ping" }
// Response
{ "id": "u7", "result": "pong" }
```

---

## 5. Phase 2 予約 Commands（実装は #107 以降）

### Plugin 関連

- `LoadPlugin { path, kind: "vst3" | "clap" | "midi_out" }` → `plugin_id`
- `UnloadPlugin { plugin_id }`
- `PluginMidiEvent { plugin_id, time_sec, event: MidiEvent }`
- `PluginParam { plugin_id, param_id, value, ramp_sec? }`
- `ConnectNode { src: NodeId, dst: NodeId, bus? }`
- `DisconnectNode { src, dst }`
- `ScanPlugins { kind }` → プラグイン一覧

### Transport 関連

- `SetTempo { bpm, time_sec? }`（ホストプラグインが欲しがる場合）
- `SetTimeSignature { numerator, denominator }`

### MIDI Event 型（共通）

```json
// NoteOn
{ "kind": "NoteOn", "channel": 0, "pitch": 60, "velocity": 100 }

// NoteOff
{ "kind": "NoteOff", "channel": 0, "pitch": 60, "velocity": 64 }

// CC
{ "kind": "CC", "channel": 0, "controller": 74, "value": 80 }

// PitchBend
{ "kind": "PitchBend", "channel": 0, "value": 8192 }

// ProgramChange
{ "kind": "ProgramChange", "channel": 0, "program": 42 }

// Aftertouch
{ "kind": "Aftertouch", "channel": 0, "value": 50 }
```

Plugin が必要になったら [Issue #107](https://github.com/signalcompose/orbitscore/issues/107) で実装する。現時点では **型定義のみ**を protocol に予約しておく。

---

## 6. Phase 1 Events

### PlayStarted

```json
{
  "type": "event",
  "event": "PlayStarted",
  "data": { "play_id": "p-a9f2", "sample_id": "s-7b4e", "time_sec": 0.5 }
}
```

### PlayEnded

```json
{
  "type": "event",
  "event": "PlayEnded",
  "data": { "play_id": "p-a9f2", "ended_at_sec": 1.0 }
}
```

### StreamStats（定期送信）

```json
{
  "type": "event",
  "event": "StreamStats",
  "data": { "cpu_load": 0.12, "xruns": 0, "buffer_underruns": 0, "now_sec": 12.34 }
}
```

- 送信頻度: **1 Hz 固定**（Phase 1。Phase 2 で opt-in / rate 調整を検討）
- クライアントが処理しない場合は無視して良い（WebSocket 側で自然に drop される想定）

### DaemonError

処理中の異常を通知。重大度で 2 分類:

```json
// Fatal: クライアントは接続を閉じてユーザーに通知すべき
{
  "type": "event",
  "event": "DaemonError",
  "data": { "severity": "fatal", "code": "DEVICE_LOST", "message": "Audio device disappeared" }
}

// Warning: 続行可能、ログのみ推奨
{
  "type": "event",
  "event": "DaemonError",
  "data": { "severity": "warning", "code": "STREAM_XRUN", "message": "Buffer underrun occurred" }
}
```

**fatal コード例**: `DEVICE_LOST`, `FATAL_PANIC`
**warning コード例**: `STREAM_XRUN`, `STREAM_OVERRUN`

---

## 7. エラーコード

| Code | 意味 |
|---|---|
| `SAMPLE_NOT_FOUND` | LoadSample / PlayAt で指定 sample が存在しない |
| `FILE_DECODE_ERROR` | LoadSample でデコードに失敗 |
| `UNSUPPORTED_FORMAT` | サポート外の sample format |
| `RESAMPLE_ERROR` | SRC 変換失敗 |
| `DEVICE_NOT_FOUND` | 起動時に audio device が見つからない |
| `DEVICE_CONFIG_ERROR` | config 取得失敗 |
| `PLAY_ID_NOT_FOUND` | Stop で指定 play が存在しない |
| `PROTOCOL_VERSION_MISMATCH` | handshake で version 不一致 |
| `MALFORMED_REQUEST` | JSON / method / params が不正 |
| `COMMAND_TIMEOUT` | クライアント側でタイムアウト検出（Response 欠落） |
| `PARAM_OUT_OF_RANGE` | PlayAt の gain / pan 等が仕様範囲外 |
| `SAMPLE_IN_USE` | UnloadSample で再生中のサンプルを unload しようとした |
| `INTERNAL_ERROR` | 上記以外の予期しないエラー |

Phase 2 で追加予定のコード（`PLUGIN_NOT_FOUND`, `PLUGIN_INCOMPATIBLE`, `PLUGIN_INIT_ERROR`, `NODE_NOT_FOUND` 等）は #107 実装時に確定する。

### 7.1 Unload / Stop の冪等性

- `UnloadSample`: サンプルが再生中なら `SAMPLE_IN_USE` でエラー（呼び出し側が Stop 後に unload）
- `Stop`: `play_id` が既に終了済み or 存在しない場合は**成功として扱う**（冪等）

---

## 8. MCP (Model Context Protocol) との関係

MCP は LLM agent とツールを繋ぐ標準プロトコル。本プロトコルとの比較:

| 観点 | 本 protocol (v0.1) | MCP |
|---|---|---|
| 目的 | Audio engine のリアルタイム制御 | LLM agent のツール呼び出し |
| トランスポート | WebSocket | stdio / SSE / HTTP |
| リアルタイム性 | 必須（音声タイミング） | 低レイテンシだが必須ではない |
| Event / Streaming | 必須（`PlayEnded` 等） | Streaming 対応あり |
| ツール記述 | 不要（クライアントが契約を知っている） | 必須（LLM が動的に発見） |

**結論**: 本 protocol は MCP とは別物として設計するが、**将来 LLM agent から daemon を触りたい場合は、MCP→本 protocol のブリッジ**を別途作る（Issue [#96](https://github.com/signalcompose/orbitscore/issues/96) のスコープ）。

互換性を取る必要はないが、メッセージ型は **MCP 風の Command/Response/Event トリプル**に揃えることで、将来 MCP アダプタを書きやすくしておく。

---

## 9. バージョニング

### プロトコルバージョン

- `protocol_version`: semver 風文字列（例 `"0.1"`, `"1.0"`, `"1.1"`）
- 後方互換な追加（新 command / 新 event）: minor bump（`0.1` → `0.2`）
- 破壊的変更: major bump（`1.0` → `2.0`）

クライアントと daemon の major が不一致なら即切断。

### Command の後方互換性

- 新 command を追加するのは後方互換
- 既存 command に **必須** params を追加するのは破壊的変更
- 既存 command に **オプショナル** params を追加するのは互換
- Response スキーマへのフィールド追加は互換（クライアントは未知フィールドを無視する）

---

## 10. 実装上の注意点（#107 / #108 向け）

### Rust daemon 側（#107）

- WebSocket 受信スレッドと audio callback は別スレッド
- Command 受信 → internal command queue (ringbuf or crossbeam channel) → audio thread が consume
- Audio callback 内でロックや allocation を避ける
- Sample データは `Arc<Vec<f32>>` で共有（load 時に固定）
- 長時間実行されるが panic で落ちないこと。panic したら client に `DaemonError` を送ってから exit

### TypeScript 側（#108）

- daemon 子プロセス管理: `child_process.spawn` + stdout 監視
- WebSocket クライアント: `ws` or `reconnecting-websocket`
- 接続断時の reconnection policy（指数 backoff）
- Command は Promise で包み、`id` で Response を照合（タイムアウトあり）
- Event は EventEmitter として expose
- 既存の `osc-client` と同じインターフェースで wrap すれば、interpreter 側の変更を最小化できる

---

## 11. 検討中 / Open Questions

| 質問 | 優先度 | 決定期限 | 現案 / 判断基準 |
|---|---|---|---|
| **時刻基準** | HIGH | #107 実装前 | daemon 内部 transport 基準、起動時 0.0 開始。`ResetTransport` / `SeekTransport` は Phase 2 で検討 |
| **Sample hot reload** | MEDIUM | #107 実装時 | 同一ファイルでも常に新規 ID（シンプル優先） |
| **Streaming decode** | LOW | Phase 3 | 大きい WAV のストリーミング再生は Phase 3 で評価 |
| **Buffer size 指定** | LOW | 必要時 | daemon 一括決定（呼び出し側から指定不可） |
| **Error details per code** | MEDIUM | #107 実装時 | 各 error code 固有の `details` フィールド仕様は実装時に確定 |
| **Sample channel mismatch** | MEDIUM | #107 実装時 | mono ↔ stereo の自動 upmix / downmix か、`CHANNEL_MISMATCH` 拒否か、実装時に選定 |
| **Phase 2 error codes** | LOW | Phase 2 実装時 | Plugin / Node 関連のエラーコードは実装時に確定 |
| ~~**パラメータ検証厳密度**~~ | ✅ RESOLVED | — | Section 4 PlayAt で確定: 負の gain は reject、pan は clamp |

---

## 12. 参考

- [Epic #105](https://github.com/signalcompose/orbitscore/issues/105)
- [docs/planning/AUDIO_ENGINE_CORE_ARCHITECTURE.md](../planning/AUDIO_ENGINE_CORE_ARCHITECTURE.md)
- [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [WebSocket RFC 6455](https://datatracker.ietf.org/doc/html/rfc6455)
