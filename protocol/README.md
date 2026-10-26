# OrbitScore session protocol

OrbitStudio の層 2（`packages/session`）と、そのクライアント（アプリの WebView・MCP の中継・headless の道具）が話すプロトコルの定義。JSON-RPC 2.0 over WebSocket（`/rpc`・1 テキストフレーム = 1 メッセージ）。

| パス | 中身 |
|---|---|
| `session/v1/session.schema.json` | **正本**（JSON Schema 2020-12）。型（`$defs`）とメソッドの一覧（`x-methods`: 方向・種類・`x-surfaces`・MCP ツールとの対応）・エラーコード（`x-errors`） |
| `gen/ts/session/v1/session.d.ts` | 正本から生成した TypeScript の型（`npm run protocol:generate`） |
| `gen/swift/` | Swift の生成物（生成ツールは N0-b の spike で決める・まだ無い） |

設計: `docs/design/848-native-orbitstudio-design.md` §5。

## License

The definitions in this directory (`session/v1/` and the generated files under `gen/`) are licensed under the Apache License, Version 2.0 — see [`LICENSE`](LICENSE). Copyright 2026 Signal compose Inc. The rest of the repository is under its root license.
