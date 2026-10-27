# protocol — セッションプロトコルの定義

設計: [`docs/design/848-native-orbitstudio-design.md`](../docs/design/848-native-orbitstudio-design.md) §5（とくに §5.2・§5.3・§5.8）。ここには**この層に置かないもの**だけを書く。

## この層に置かないもの

- **実装**。ここに置くのは定義（`session/v1/*.schema.json`）と、そこから生成した型（`gen/`）だけ。サーバ・クライアントの実装は `packages/session` と `apps/OrbitStudio`
- **手で書いた生成物**。`gen/` は `npm run protocol:generate` で作り、`npm run protocol:check`（と `npm test` の `tests/protocol/generated-types.spec.ts`）が差分ゼロを検査する
- **正本の二重化**。メソッドの一覧・方向・`x-surfaces`・MCP ツールとの対応はスキーマの `x-methods` が唯一の正本。TS や Swift の側に別の一覧を書かない
- **ルートのライセンスの文書**。このディレクトリの定義は Apache License 2.0（`LICENSE`・owner 裁定 2026-10-26）で、リポジトリの他の部分とライセンスが違う。ルートのライセンスでしか配れないもの（実装・DSL のエンジン）をここへ置かない
- **黙った破壊的変更**。`protocol_version` の MINOR は追加だけ（新メソッド・省略可能なフィールド）。それ以外は MAJOR（設計 §5.2）
