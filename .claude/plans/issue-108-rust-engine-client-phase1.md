🔴 MANDATORY: このプランは auto mode で `/code:autopilot` により実装すること。
手動実装禁止。起動コマンド: `/code:autopilot .claude/plans/issue-108-rust-engine-client-phase1.md`

---

# Plan: Rust engine client — Phase 1 scaffold + feature flag (Issue #108)

## Context

Issue #108 は TS 側 audio engine の SuperCollider OSC 経路を Rust daemon への WebSocket client に差し替える feature。完了条件が 7 項目あり一度にやると PR が巨大化して review 困難なので、**Phase 1 は scaffold + feature flag + 最小限動作** に絞る。

前提として PR #121 で daemon 側 protocol と integration test 基盤が完成済み。本 PR では TS から同じ protocol を話せる client を構築する。

**Phase 1 スコープ**（本 PR）:
- `packages/engine/src/audio/rust-engine/` 新設
- `DaemonClient` class（子プロセス spawn + WebSocket 接続 + handshake）
- daemon protocol の最小サブセット: `LoadSample` / `PlayAt` / `Stop` / `SetGlobalGain`
- feature flag (`ORBITSCORE_ENGINE` env var, default=`"supercollider"`)
- SC path 完全据置（既存 220+ tests が回帰しないこと）
- 新規 unit tests: WebSocket mock server で daemon client の基本動作

**Phase 2+ 非目標**（別 PR 予定）:
- BufferManager / EventScheduler の内部 refactor（bufnum → sample_id）
- Rust を default にする切替
- SC deprecation
- Full interface parity（effect chain 等）

## 設計方針

### 1. `DaemonClient` class 構造

```ts
// packages/engine/src/audio/rust-engine/daemon-client.ts (新規)
export interface DaemonClientOptions {
  daemonPath?: string;       // orbit-audio-daemon の絶対パス
  startupTimeoutMs?: number; // default 10_000
  connectTimeoutMs?: number; // default 3_000
  handshakeTimeoutMs?: number; // default 5_000
}

export class DaemonClient {
  async start(options?: DaemonClientOptions): Promise<void>;
  async loadSample(path: string): Promise<{ sampleId: string; frames: number; channels: number; sampleRate: number }>;
  async playAt(sampleId: string, timeSec: number, gain: number): Promise<{ playId: string }>;
  async stop(playId: string): Promise<boolean>;
  async setGlobalGain(value: number, rampSec?: number): Promise<void>;
  async quit(): Promise<void>;
  isRunning(): boolean;

  // Event stream (PlayStarted / PlayEnded / StreamStats / DaemonError)
  on(event: 'play-started' | 'play-ended' | 'stream-stats' | 'daemon-error', listener: (data: unknown) => void): void;
}
```

内部:
- `child_process.spawn` で daemon 起動、stdout から `{"ready":true,"port":N}` を readline で待つ
- `ws` package で WebSocket 接続、handshake フレーム受信を確認
- request/response は `id: uuid()` で multiplex、`Map<id, {resolve, reject}>` で対応付け
- event frames (`type: "event"`) は `EventEmitter` に dispatch

### 2. Feature flag

`packages/engine/src/audio/index.ts` に:
```ts
const engineKind = process.env.ORBITSCORE_ENGINE ?? 'supercollider';
export function createAudioEngine(): AudioEngine & Scheduler {
  if (engineKind === 'rust') {
    return new RustEngineAdapter();  // Phase 2 で実装
  }
  return new SuperColliderPlayer();   // default 据置
}
```

Phase 1 では `RustEngineAdapter` は skeleton のみ（throw new Error("Phase 2")）。`DaemonClient` 単体のテストで動作を担保。

### 3. Daemon バイナリ解決

優先順位:
1. `options.daemonPath` 明示
2. 環境変数 `ORBIT_AUDIO_DAEMON_PATH`
3. monorepo root 基準の規定パス `rust/target/release/orbit-audio-daemon` → `rust/target/debug/orbit-audio-daemon`
4. 見つからなければ明示的エラー（`DaemonNotFoundError`）

### 4. テスト戦略

`tests/audio/rust-engine/` 新設:
- `daemon-client.spec.ts`: **mock WebSocket server** を tests 内に立てて DaemonClient の:
  - handshake 受信
  - LoadSample / PlayAt round-trip
  - Stop 正常 / 未知 id
  - SetGlobalGain 負値拒否
  - event stream 受信（PlayEnded）
  - 切断時の quit 処理

daemon バイナリを実際に spawn しない（CI で audio device 不在の問題を回避）。spawn テストは integration test として scope 外にする。

## 変更ファイル

### 新規
- `packages/engine/src/audio/rust-engine/index.ts`
- `packages/engine/src/audio/rust-engine/daemon-client.ts`
- `packages/engine/src/audio/rust-engine/protocol-types.ts` — protocol v0.1 TypeScript 型定義
- `packages/engine/src/audio/rust-engine/errors.ts` — `DaemonNotFoundError` 等
- `packages/engine/src/audio/rust-engine/README.md` — 利用方法概要
- `tests/audio/rust-engine/daemon-client.spec.ts`
- `tests/audio/rust-engine/mock-daemon-server.ts` — テスト用 WebSocket server helper

### 修正
- `packages/engine/src/audio/index.ts`: feature flag + factory
- `packages/engine/package.json`: `ws` / `@types/ws` / `uuid` を deps に追加（既存あれば skip）

## 検証

```bash
# 既存テスト全 green
npm run build
npm test

# 新規 test
npm test -- rust-engine

# type check
npm run typecheck
```

完了条件:
- 既存 220+ tests 全通過
- 新規 rust-engine tests 全通過
- `ORBITSCORE_ENGINE=rust` でも（Phase 2 未実装のため）明示的エラーが出るだけでハングしない
- ESLint / Prettier clean

## 実装チェックリスト

- [ ] Branch: `108-ts-rust-engine-client-phase1` (作成済)
- [ ] `packages/engine/package.json` に `ws` / `uuid` deps 追加
- [ ] `protocol-types.ts` で daemon protocol v0.1 型定義
- [ ] `daemon-client.ts` で spawn + WS + handshake + request/response + event stream
- [ ] `errors.ts` で `DaemonNotFoundError` / `DaemonStartupError`
- [ ] `index.ts` factory + feature flag
- [ ] `mock-daemon-server.ts` テスト helper
- [ ] `daemon-client.spec.ts` 6-8 ケース
- [ ] 既存 audio tests 全 green
- [ ] /simplify → /code:pr-review-team iterate to 0 critical / 0 important
- [ ] WORK_LOG.md 追記

## 参考 file:line

- `packages/engine/src/audio/supercollider/osc-client.ts` — 差し替え対象 interface
- `packages/engine/src/audio/types.ts:12` — `AudioEngine` interface
- `packages/engine/src/core/global/types.ts:11` — `Scheduler` interface
- `packages/engine/src/interpreter/interpreter-v2.ts:27` — `new SuperColliderPlayer()` hardcode 箇所（factory 経由に置換）
- `docs/research/ENGINE_DAEMON_PROTOCOL.md` — daemon protocol v0.1 仕様
- `rust/crates/orbit-audio-daemon/src/protocol.rs` — protocol 定義のソース
- `tests/audio/supercollider-gain-pan.spec.ts` — 既存テストのモック pattern
