# P2P協調ライブコーディング機能 開発プラン

**ステータス**: 計画段階（未着手）
**優先度**: 中（Electron版アプリ後に実装推奨）
**作成日**: 2025-10-10
**最終更新**: 2025-10-10

---

## 📋 プロジェクト概要

### 背景
VS Code Live ShareやOpen Collaboration toolsは以下の問題を抱えている：
- ❌ 接続が不安定（頻繁に切断される）
- ❌ レイテンシが高い（編集が遅延する）
- ❌ 複雑な設定が必要（認証、ネットワーク設定）
- ❌ OrbitScore固有の機能（エンジン状態同期、コード実行同期）に非対応

### 目標
**「ゲームのマルチプレイのように簡単で安定した協調ライブコーディング環境」**

- ✅ ホストが部屋を作成、仲間を招待（P2P接続）
- ✅ ホストが落ちても他の人にホストが引き継がれる（ホストマイグレーション）
- ✅ リアルタイムでコード編集・実行を共有
- ✅ 各自のSuperColliderで音を鳴らす（ネットワーク遅延の影響を受けない）
- ✅ 安定した接続（自動再接続、バックアップサーバー）
- ✅ **リアルタイムチャット**（テキストメッセージ交換）
- ✅ **コードコメント機能**（行を選択してコメント → チャットに表示 → クリックでその行にジャンプ）

### ユースケース

#### 1. 教育・ワークショップ
- 講師がホスト、生徒5-10人が参加
- 講師がコードを書く → 全員にリアルタイム反映
- 生徒も編集可能（ハンズオン）
- 講師が途中退出しても、アシスタントがホストを引き継ぎ継続

#### 2. 協調パフォーマンス
- アーティスト3-5人が同時参加
- リアルタイムで音楽を共同制作
- 誰かが接続トラブルでも、他のメンバーは演奏継続

#### 3. リモートペアプログラミング
- 開発者2人で新機能を実装
- リアルタイムでコードレビュー・編集
- どちらかが落ちても作業継続

---

## 🏗️ アーキテクチャ設計

### P2P接続モデル（WebRTC + シグナリングサーバー）

```
┌─────────────────────────────────────────────────────────┐
│                  Signaling Server                        │
│         (初期接続・ホスト発見のみ使用)                    │
└────────────┬────────────────────────────┬────────────────┘
             │                            │
             │ (接続確立後はP2P)          │
             │                            │
        ┌────▼────┐                  ┌────▼────┐
        │ Host    │◄────────────────►│ Peer 1  │
        │ (Alice) │  WebRTC P2P      │ (Bob)   │
        └────┬────┘                  └────┬────┘
             │                            │
             │                            │
             │         ┌────────┐         │
             └────────►│ Peer 2 │◄────────┘
                       │(Charlie)│
                       └────────┘
```

### ホストマイグレーション

```
┌──────────────────────────────────────────────────────────┐
│ Phase 1: 通常時                                           │
├──────────────────────────────────────────────────────────┤
│ Host (Alice) ◄───► Peer 1 (Bob) ◄───► Peer 2 (Charlie)  │
│  [Primary]           [Backup]           [Member]         │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│ Phase 2: Aliceが切断 → Bobが自動的にHostに昇格           │
├──────────────────────────────────────────────────────────┤
│ Host (Bob) ◄───────────────────► Peer 2 (Charlie)        │
│  [Primary]                         [Backup]              │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│ Phase 3: Aliceが再接続 → Peerとして参加                  │
├──────────────────────────────────────────────────────────┤
│ Host (Bob) ◄───► Peer 1 (Alice) ◄───► Peer 2 (Charlie)  │
│  [Primary]         [Member]             [Backup]         │
└──────────────────────────────────────────────────────────┘
```

### ホスト選出アルゴリズム
1. **起動順**: 最初に部屋を作った人がホスト
2. **Backup指定**: ホストが次のホスト候補を指定可能
3. **自動昇格**: ホスト切断時、Backupが自動的にホストに昇格
4. **Backupがいない場合**: 接続時間が最も長いPeerが昇格

---

## 📝 実装タスク詳細

### Phase 1: 基盤実装（推定: 1週間）

#### 1.1 パッケージセットアップ
**作成物**: `packages/vscode-extension-collab/` または `packages/electron-app-collab/`

**どちらで実装するか**:
- **VS Code Extension版**: 開発環境向け、プロトタイプ実装に最適
- **Electron App統合版**: エンドユーザー向け、最終製品

**推奨**: VS Code Extension版で先行実装 → 動作確認 → Electron版に移植

**依存関係**:
```json
{
  "dependencies": {
    "simple-peer": "^9.11.1",        // WebRTC P2P接続
    "socket.io-client": "^4.5.0",   // シグナリングサーバー接続
    "yjs": "^13.6.0",                // CRDT（衝突解決）
    "y-webrtc": "^10.2.5",           // Yjs WebRTC Provider
    "uuid": "^9.0.0",                // セッションID生成
    "eventemitter3": "^5.0.0"        // イベント管理
  }
}
```

#### 1.2 シグナリングサーバー構築
**目的**: P2P接続の初期確立（ICE候補交換、SDP交換）

**技術**: Socket.IO (Node.js)

**実装**: `packages/collab-signaling-server/`

```typescript
// server.ts
import { Server } from 'socket.io';
import express from 'express';

const app = express();
const server = app.listen(3000);
const io = new Server(server, {
  cors: { origin: '*' }
});

interface Room {
  id: string;
  hostId: string;
  backupId: string | null;
  members: Set<string>;
}

const rooms = new Map<string, Room>();

io.on('connection', (socket) => {
  console.log(`[Connected] ${socket.id}`);

  // 部屋作成
  socket.on('create-room', (roomId: string) => {
    rooms.set(roomId, {
      id: roomId,
      hostId: socket.id,
      backupId: null,
      members: new Set([socket.id])
    });
    socket.join(roomId);
    socket.emit('room-created', { roomId, role: 'host' });
    console.log(`[Room Created] ${roomId} by ${socket.id}`);
  });

  // 部屋参加
  socket.on('join-room', (roomId: string) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('error', 'Room not found');
      return;
    }

    room.members.add(socket.id);
    socket.join(roomId);

    // 既存メンバーにシグナル
    socket.to(roomId).emit('peer-joined', {
      peerId: socket.id,
      role: room.backupId === socket.id ? 'backup' : 'member'
    });

    // 新規参加者に既存メンバーリスト送信
    const memberList = Array.from(room.members).map(id => ({
      id,
      role: id === room.hostId ? 'host' : id === room.backupId ? 'backup' : 'member'
    }));
    socket.emit('room-joined', {
      roomId,
      role: room.backupId === socket.id ? 'backup' : 'member',
      members: memberList
    });

    console.log(`[Room Joined] ${socket.id} → ${roomId}`);
  });

  // WebRTC シグナリング
  socket.on('signal', ({ to, signal }) => {
    io.to(to).emit('signal', {
      from: socket.id,
      signal
    });
  });

  // Backup指定
  socket.on('set-backup', ({ roomId, backupId }) => {
    const room = rooms.get(roomId);
    if (room && socket.id === room.hostId) {
      room.backupId = backupId;
      io.to(roomId).emit('backup-updated', { backupId });
      console.log(`[Backup Set] ${roomId}: ${backupId}`);
    }
  });

  // ホストマイグレーション
  socket.on('disconnect', () => {
    console.log(`[Disconnected] ${socket.id}`);

    // 切断したユーザーがホストの場合
    rooms.forEach((room, roomId) => {
      if (room.hostId === socket.id) {
        room.members.delete(socket.id);

        if (room.members.size === 0) {
          // 全員退出 → 部屋削除
          rooms.delete(roomId);
          console.log(`[Room Closed] ${roomId}`);
        } else {
          // Backupを新ホストに昇格
          const newHostId = room.backupId || Array.from(room.members)[0];
          room.hostId = newHostId;
          room.backupId = null;

          io.to(roomId).emit('host-migrated', {
            newHostId,
            reason: 'previous-host-disconnected'
          });

          console.log(`[Host Migrated] ${roomId}: ${socket.id} → ${newHostId}`);
        }
      } else {
        // 通常メンバーの切断
        room.members.delete(socket.id);
        io.to(roomId).emit('peer-left', { peerId: socket.id });
      }
    });
  });
});

console.log('🚀 Signaling server started on http://localhost:3000');
```

**デプロイ**:
- 開発環境: ローカル起動 (`npm run signaling-server`)
- 本番環境: Heroku, Railway, Render等の無料PaaSで公開

#### 1.3 P2P接続マネージャー
**ファイル**: `src/p2p/connection-manager.ts`

```typescript
import SimplePeer from 'simple-peer';
import { io, Socket } from 'socket.io-client';
import EventEmitter from 'eventemitter3';

export type Role = 'host' | 'backup' | 'member';

export interface Peer {
  id: string;
  role: Role;
  connection: SimplePeer.Instance;
}

export class ConnectionManager extends EventEmitter {
  private signalingSocket: Socket;
  private peers = new Map<string, Peer>();
  private myId: string = '';
  private myRole: Role = 'member';
  private roomId: string = '';

  constructor(private signalingServerUrl: string) {
    super();
    this.signalingSocket = io(signalingServerUrl);
    this.setupSignalingHandlers();
  }

  // 部屋作成（ホストとして）
  createRoom(): string {
    this.roomId = this.generateRoomId();
    this.myRole = 'host';
    this.signalingSocket.emit('create-room', this.roomId);
    return this.roomId;
  }

  // 部屋参加（メンバーとして）
  joinRoom(roomId: string): void {
    this.roomId = roomId;
    this.signalingSocket.emit('join-room', roomId);
  }

  // Backup指定（ホストのみ）
  setBackup(peerId: string): void {
    if (this.myRole !== 'host') {
      throw new Error('Only host can set backup');
    }
    this.signalingSocket.emit('set-backup', {
      roomId: this.roomId,
      backupId: peerId
    });
  }

  // 全Peerにデータ送信
  broadcast(data: any): void {
    this.peers.forEach(peer => {
      if (peer.connection.connected) {
        peer.connection.send(JSON.stringify(data));
      }
    });
  }

  // 特定Peerにデータ送信
  sendTo(peerId: string, data: any): void {
    const peer = this.peers.get(peerId);
    if (peer && peer.connection.connected) {
      peer.connection.send(JSON.stringify(data));
    }
  }

  private setupSignalingHandlers(): void {
    this.signalingSocket.on('connect', () => {
      this.myId = this.signalingSocket.id!;
      this.emit('connected', { myId: this.myId });
    });

    this.signalingSocket.on('room-created', ({ roomId, role }) => {
      this.myRole = role;
      this.emit('room-created', { roomId, role });
    });

    this.signalingSocket.on('room-joined', ({ roomId, role, members }) => {
      this.myRole = role;
      this.emit('room-joined', { roomId, role });

      // 既存メンバーとP2P接続確立
      members.forEach(({ id, role }) => {
        if (id !== this.myId) {
          this.connectToPeer(id, role, true);
        }
      });
    });

    this.signalingSocket.on('peer-joined', ({ peerId, role }) => {
      this.connectToPeer(peerId, role, false);
    });

    this.signalingSocket.on('peer-left', ({ peerId }) => {
      this.disconnectPeer(peerId);
    });

    this.signalingSocket.on('signal', ({ from, signal }) => {
      const peer = this.peers.get(from);
      if (peer) {
        peer.connection.signal(signal);
      }
    });

    this.signalingSocket.on('backup-updated', ({ backupId }) => {
      if (backupId === this.myId) {
        this.myRole = 'backup';
      }
      this.emit('backup-updated', { backupId });
    });

    this.signalingSocket.on('host-migrated', ({ newHostId, reason }) => {
      if (newHostId === this.myId) {
        this.myRole = 'host';
        this.emit('promoted-to-host', { reason });
      }
      this.emit('host-migrated', { newHostId, reason });
    });
  }

  private connectToPeer(peerId: string, role: Role, initiator: boolean): void {
    const peer = new SimplePeer({ initiator, trickle: false });

    peer.on('signal', (signal) => {
      this.signalingSocket.emit('signal', { to: peerId, signal });
    });

    peer.on('connect', () => {
      console.log(`[P2P Connected] ${peerId}`);
      this.emit('peer-connected', { peerId, role });
    });

    peer.on('data', (data) => {
      const message = JSON.parse(data.toString());
      this.emit('data', { peerId, data: message });
    });

    peer.on('close', () => {
      console.log(`[P2P Closed] ${peerId}`);
      this.disconnectPeer(peerId);
    });

    peer.on('error', (err) => {
      console.error(`[P2P Error] ${peerId}:`, err);
      this.emit('peer-error', { peerId, error: err });
    });

    this.peers.set(peerId, { id: peerId, role, connection: peer });
  }

  private disconnectPeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.connection.destroy();
      this.peers.delete(peerId);
      this.emit('peer-disconnected', { peerId });
    }
  }

  private generateRoomId(): string {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  }

  disconnect(): void {
    this.peers.forEach(peer => peer.connection.destroy());
    this.peers.clear();
    this.signalingSocket.disconnect();
  }
}
```

**成果物**: P2P接続が確立できる基盤

---

### Phase 2: データ同期実装（推定: 1週間）

#### 2.1 CRDT統合（Yjs）
**目的**: 複数人が同時編集してもコンフリクトしない

**ファイル**: `src/sync/crdt-manager.ts`

```typescript
import * as Y from 'yjs';
import { WebrtcProvider } from 'y-webrtc';

export class CRDTManager {
  private ydoc: Y.Doc;
  private provider: WebrtcProvider;
  private ytext: Y.Text;

  constructor(roomId: string, signalingServer: string) {
    this.ydoc = new Y.Doc();
    this.ytext = this.ydoc.getText('orbitscore-code');

    // WebRTC Provider（Y.jsの標準WebRTC統合）
    this.provider = new WebrtcProvider(roomId, this.ydoc, {
      signaling: [signalingServer]
    });
  }

  // テキスト取得
  getText(): string {
    return this.ytext.toString();
  }

  // テキスト挿入
  insert(index: number, text: string): void {
    this.ytext.insert(index, text);
  }

  // テキスト削除
  delete(index: number, length: number): void {
    this.ytext.delete(index, length);
  }

  // 変更監視
  observe(callback: (event: Y.YTextEvent) => void): void {
    this.ytext.observe(callback);
  }

  // カーソル位置同期（Awareness）
  setAwareness(state: { name: string; color: string; cursor: number }): void {
    this.provider.awareness.setLocalState(state);
  }

  getAwareness(): Map<number, any> {
    return this.provider.awareness.getStates();
  }

  destroy(): void {
    this.provider.destroy();
    this.ydoc.destroy();
  }
}
```

#### 2.2 エディタ統合
**ファイル**: `src/sync/editor-sync.ts`

**VS Code版**:
```typescript
import * as vscode from 'vscode';
import { CRDTManager } from './crdt-manager';

export class EditorSync {
  private crdt: CRDTManager;
  private editor: vscode.TextEditor;
  private isRemoteChange = false;

  constructor(editor: vscode.TextEditor, roomId: string, signalingServer: string) {
    this.editor = editor;
    this.crdt = new CRDTManager(roomId, signalingServer);
    this.setupSync();
  }

  private setupSync(): void {
    // ローカル編集 → CRDT
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document !== this.editor.document || this.isRemoteChange) {
        return;
      }

      event.contentChanges.forEach((change) => {
        this.crdt.delete(change.rangeOffset, change.rangeLength);
        if (change.text) {
          this.crdt.insert(change.rangeOffset, change.text);
        }
      });
    });

    // CRDT → ローカル編集
    this.crdt.observe((event) => {
      this.isRemoteChange = true;

      const edit = new vscode.WorkspaceEdit();
      event.changes.forEach((change) => {
        if (change.action === 'insert') {
          const pos = this.editor.document.positionAt(change.index);
          edit.insert(this.editor.document.uri, pos, change.text);
        } else if (change.action === 'delete') {
          const start = this.editor.document.positionAt(change.index);
          const end = this.editor.document.positionAt(change.index + change.length);
          edit.delete(this.editor.document.uri, new vscode.Range(start, end));
        }
      });

      vscode.workspace.applyEdit(edit).then(() => {
        this.isRemoteChange = false;
      });
    });

    // カーソル位置同期
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (event.textEditor === this.editor) {
        const cursor = this.editor.document.offsetAt(event.selections[0].active);
        this.crdt.setAwareness({
          name: 'User', // TODO: ユーザー名取得
          color: this.generateColor(),
          cursor
        });
      }
    });
  }

  private generateColor(): string {
    const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8'];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  destroy(): void {
    this.crdt.destroy();
  }
}
```

**Monaco Editor版（Electron App用）**:
```typescript
import * as monaco from 'monaco-editor';
import { CRDTManager } from './crdt-manager';

export class MonacoEditorSync {
  private crdt: CRDTManager;
  private editor: monaco.editor.IStandaloneCodeEditor;
  private isRemoteChange = false;

  constructor(
    editor: monaco.editor.IStandaloneCodeEditor,
    roomId: string,
    signalingServer: string
  ) {
    this.editor = editor;
    this.crdt = new CRDTManager(roomId, signalingServer);
    this.setupSync();
  }

  private setupSync(): void {
    const model = this.editor.getModel()!;

    // ローカル編集 → CRDT
    model.onDidChangeContent((event) => {
      if (this.isRemoteChange) return;

      event.changes.forEach((change) => {
        this.crdt.delete(change.rangeOffset, change.rangeLength);
        if (change.text) {
          this.crdt.insert(change.rangeOffset, change.text);
        }
      });
    });

    // CRDT → ローカル編集
    this.crdt.observe((event) => {
      this.isRemoteChange = true;

      const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];

      event.changes.forEach((change) => {
        if (change.action === 'insert') {
          const pos = model.getPositionAt(change.index);
          edits.push({
            range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
            text: change.text,
            forceMoveMarkers: true
          });
        } else if (change.action === 'delete') {
          const start = model.getPositionAt(change.index);
          const end = model.getPositionAt(change.index + change.length);
          edits.push({
            range: new monaco.Range(
              start.lineNumber,
              start.column,
              end.lineNumber,
              end.column
            ),
            text: '',
            forceMoveMarkers: true
          });
        }
      });

      model.applyEdits(edits);
      this.isRemoteChange = false;
    });

    // カーソル位置同期
    this.editor.onDidChangeCursorPosition((event) => {
      const cursor = model.getOffsetAt(event.position);
      this.crdt.setAwareness({
        name: 'User',
        color: this.generateColor(),
        cursor
      });
    });
  }

  private generateColor(): string {
    const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8'];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  destroy(): void {
    this.crdt.destroy();
  }
}
```

#### 2.3 エンジン状態同期
**ファイル**: `src/sync/engine-state-sync.ts`

```typescript
import { ConnectionManager } from '../p2p/connection-manager';

export interface EngineState {
  tempo: number;
  tick: number;
  beat: number;
  runGroup: string[];
  loopGroup: string[];
  muteGroup: string[];
}

export class EngineStateSync {
  private connectionManager: ConnectionManager;
  private currentState: EngineState;

  constructor(connectionManager: ConnectionManager) {
    this.connectionManager = connectionManager;
    this.currentState = {
      tempo: 120,
      tick: 16,
      beat: 4,
      runGroup: [],
      loopGroup: [],
      muteGroup: []
    };

    this.setupListeners();
  }

  // ローカルエンジン状態更新時に呼び出す
  updateState(state: Partial<EngineState>): void {
    this.currentState = { ...this.currentState, ...state };
    this.broadcast();
  }

  private broadcast(): void {
    this.connectionManager.broadcast({
      type: 'engine-state',
      state: this.currentState
    });
  }

  private setupListeners(): void {
    this.connectionManager.on('data', ({ peerId, data }) => {
      if (data.type === 'engine-state') {
        this.handleRemoteStateUpdate(data.state);
      }
    });
  }

  private handleRemoteStateUpdate(state: EngineState): void {
    // リモート状態を適用（マージロジック）
    // ホストの状態を優先（ホストマイグレーション時は新ホストの状態）
    this.currentState = state;

    // UIに反映（イベント発火）
    this.emit('state-updated', state);
  }

  private emit(event: string, data: any): void {
    // TODO: EventEmitter統合
  }
}
```

**成果物**: リアルタイムで編集・状態が同期される

---

### Phase 3: コード実行同期（推定: 3-5日）

#### 3.1 実行イベント同期
**ファイル**: `src/sync/execution-sync.ts`

```typescript
import { ConnectionManager } from '../p2p/connection-manager';

export interface ExecutionEvent {
  userId: string;
  userName: string;
  code: string;
  timestamp: number;
  rangeStart: number;
  rangeEnd: number;
}

export class ExecutionSync {
  private connectionManager: ConnectionManager;

  constructor(connectionManager: ConnectionManager) {
    this.connectionManager = connectionManager;
    this.setupListeners();
  }

  // ローカルでコード実行時に呼び出す
  broadcastExecution(event: ExecutionEvent): void {
    this.connectionManager.broadcast({
      type: 'code-execution',
      event
    });
  }

  private setupListeners(): void {
    this.connectionManager.on('data', ({ peerId, data }) => {
      if (data.type === 'code-execution') {
        this.handleRemoteExecution(data.event);
      }
    });
  }

  private handleRemoteExecution(event: ExecutionEvent): void {
    // リモート実行を各自のエンジンで再生
    // TODO: エンジンに渡す

    // UIにハイライト表示
    this.highlightRemoteExecution(event);
  }

  private highlightRemoteExecution(event: ExecutionEvent): void {
    // エディタ上で実行された範囲をハイライト
    // ユーザー色でフラッシュ表示
    // TODO: UI実装
  }
}
```

#### 3.2 音声出力モードの設計

**⚠️ 重要な問題**: 複数人が同時に音を出すと、同じ音が重複して爆音になる

**解決策: 3つの音声出力モード**

##### モード1: **個別モード（Individual Mode）** - デフォルト

各自が独立して音を出す（教育・ハンズオン向け）

**動作**:
1. ユーザーAがコード実行（Cmd+Enter）
2. **ユーザーAのSuperColliderのみ**で音が鳴る
3. 実行イベントが全員にブロードキャスト
4. ユーザーB, Cは**コード変更のみ受信**（音は出さない）
5. 他のユーザーがエディタ上で「Aが実行中」を視覚的に確認

**使用例**:
- ワークショップで各自が練習
- 講師がデモ → 生徒は聴くだけ

##### モード2: **ホスト専用モード（Host-Only Mode）**

ホストだけが音を出せる（ライブパフォーマンス向け）

**動作**:
1. ホストのみがコード実行可能
2. 他のメンバーは閲覧・編集のみ（実行は無効化）
3. ホストが落ちた場合 → 新ホストに自動引き継ぎ（後述）

**使用例**:
- ライブパフォーマンス（ホスト = パフォーマー）
- リモートペアプロ（ホスト = ドライバー）

##### モード3: **共有モード（Shared Mode）** - 上級者向け

全員の音をミキサーで合成（協調パフォーマンス向け）

**動作**:
1. 各自のSuperColliderが異なるトラックを担当
2. 全員の音がミキサーに送られる
3. ミキサーで合成 → スピーカー出力

**使用例**:
- 複数人でのライブ演奏
- 役割分担（Aがドラム、Bがベース、Cがメロディ）

**⚠️ 注意**: このモードは手動設定が必要（各自がオーディオルーティングを構成）

##### モード切り替え機能

```typescript
// src/sync/audio-output-mode.ts
export type AudioOutputMode = 'individual' | 'host-only' | 'shared';

export class AudioOutputManager {
  private mode: AudioOutputMode = 'individual';
  private connectionManager: ConnectionManager;
  private isHost: boolean;

  setMode(mode: AudioOutputMode): void {
    this.mode = mode;
    this.connectionManager.broadcast({
      type: 'audio-mode-changed',
      mode
    });
  }

  shouldExecuteLocally(event: ExecutionEvent): boolean {
    switch (this.mode) {
      case 'individual':
        // 自分が実行した場合のみ音を出す
        return event.userId === this.connectionManager.myId;

      case 'host-only':
        // ホストの実行のみ音を出す
        return event.userId === this.connectionManager.hostId;

      case 'shared':
        // 全員が音を出す（各自が異なるトラックを担当する想定）
        return true;

      default:
        return false;
    }
  }
}
```

**UI**: モード選択ドロップダウン
```
Audio Output Mode:
[ Individual ▼ ]  ← Host-Only / Shared
```

**デフォルト**: `Individual` モード（最も安全）

##### スピーカー保護機能

**問題**: 音が急に出る/止まるとスピーカーが破損する可能性

**解決策**: フェードイン/フェードアウト

```typescript
// src/audio/speaker-protection.ts
export class SpeakerProtection {
  private fadeInMs = 50;   // フェードイン時間
  private fadeOutMs = 100; // フェードアウト時間

  async fadeIn(engineManager: EngineManager): Promise<void> {
    // SuperColliderのマスターボリュームを0→1に徐々に上げる
    await engineManager.execute(`
      s.volume.volume = 0;
      s.volume.volume = 1.linlin(0, 1, 0, 1, ${this.fadeInMs / 1000});
    `);
  }

  async fadeOut(engineManager: EngineManager): Promise<void> {
    // SuperColliderのマスターボリュームを1→0に徐々に下げる
    await engineManager.execute(`
      s.volume.volume = 1.linlin(0, 1, 0, 1, ${this.fadeOutMs / 1000});
    `);

    // フェードアウト完了まで待機
    await new Promise(resolve => setTimeout(resolve, this.fadeOutMs));
  }

  async safeMute(engineManager: EngineManager): Promise<void> {
    await this.fadeOut(engineManager);
    await engineManager.execute('s.freeAll'); // 全音停止
  }
}
```

**適用シーン**:
- ホストマイグレーション時（旧ホストの音をフェードアウト → 新ホストの音をフェードイン）
- モード切り替え時
- 緊急停止時（Panic Button）

**成果物**: 音声出力の排他制御 + スピーカー保護

---

### Phase 4: UI/UX実装（推定: 1週間）

#### 4.1 セッション管理UI

**VS Code Extension版**: サイドバーパネル

```
┌─────────────────────────────────┐
│ 🌐 OrbitScore Collaboration     │
├─────────────────────────────────┤
│ [➕ Create Session]              │
│ [🔗 Join Session]                │
├─────────────────────────────────┤
│ Status: Not Connected           │
└─────────────────────────────────┘
```

**セッション作成時**:
```
┌─────────────────────────────────┐
│ 🌐 Collaboration Session        │
├─────────────────────────────────┤
│ Status: Active (Host)           │
│ Room ID: ABC123                 │
│ [📋 Copy Invite Link]           │
│ [🛑 End Session]                │
├─────────────────────────────────┤
│ 👥 Participants (3)             │
│ ● Alice (You, Host) 🔴         │
│ ● Bob (Backup)     🔵          │
│ ● Charlie          🟢          │
│                                 │
│ Right-click for options:        │
│ - Set as Backup                 │
│ - Kick User                     │
└─────────────────────────────────┘
```

**実装** (`src/ui/session-panel.ts`):
```typescript
import * as vscode from 'vscode';
import { ConnectionManager } from '../p2p/connection-manager';

export class SessionPanel {
  private panel: vscode.WebviewPanel;
  private connectionManager: ConnectionManager;

  constructor(context: vscode.ExtensionContext, connectionManager: ConnectionManager) {
    this.connectionManager = connectionManager;

    this.panel = vscode.window.createWebviewPanel(
      'orbitscoreCollab',
      'OrbitScore Collaboration',
      vscode.ViewColumn.Two,
      { enableScripts: true }
    );

    this.panel.webview.html = this.getHtmlContent();
    this.setupMessageHandlers();
  }

  private getHtmlContent(): string {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: var(--vscode-font-family); padding: 20px; }
          button { padding: 10px; margin: 5px 0; width: 100%; }
          .participant { padding: 5px; margin: 5px 0; }
          .host { color: #FF6B6B; }
          .backup { color: #4ECDC4; }
          .member { color: #98D8C8; }
        </style>
      </head>
      <body>
        <h2>🌐 OrbitScore Collaboration</h2>
        <button id="create-btn">➕ Create Session</button>
        <button id="join-btn">🔗 Join Session</button>

        <div id="session-info" style="display: none;">
          <h3>Status: <span id="status">Connected</span></h3>
          <p>Room ID: <span id="room-id"></span></p>
          <button id="copy-link-btn">📋 Copy Invite Link</button>
          <button id="end-btn">🛑 End Session</button>

          <h3>👥 Participants</h3>
          <div id="participants"></div>
        </div>

        <script>
          const vscode = acquireVsCodeApi();

          document.getElementById('create-btn').addEventListener('click', () => {
            vscode.postMessage({ command: 'create-session' });
          });

          document.getElementById('join-btn').addEventListener('click', () => {
            vscode.postMessage({ command: 'join-session' });
          });

          document.getElementById('copy-link-btn').addEventListener('click', () => {
            const roomId = document.getElementById('room-id').textContent;
            vscode.postMessage({ command: 'copy-link', roomId });
          });

          document.getElementById('end-btn').addEventListener('click', () => {
            vscode.postMessage({ command: 'end-session' });
          });

          window.addEventListener('message', (event) => {
            const message = event.data;
            switch (message.command) {
              case 'session-created':
                document.getElementById('room-id').textContent = message.roomId;
                document.getElementById('session-info').style.display = 'block';
                break;
              case 'update-participants':
                updateParticipants(message.participants);
                break;
            }
          });

          function updateParticipants(participants) {
            const container = document.getElementById('participants');
            container.innerHTML = participants.map(p =>
              \`<div class="participant \${p.role}">● \${p.name} (\${p.role})</div>\`
            ).join('');
          }
        </script>
      </body>
      </html>
    `;
  }

  private setupMessageHandlers(): void {
    this.panel.webview.onDidReceiveMessage((message) => {
      switch (message.command) {
        case 'create-session':
          this.createSession();
          break;
        case 'join-session':
          this.joinSession();
          break;
        case 'copy-link':
          this.copyInviteLink(message.roomId);
          break;
        case 'end-session':
          this.endSession();
          break;
      }
    });
  }

  private createSession(): void {
    const roomId = this.connectionManager.createRoom();
    this.panel.webview.postMessage({
      command: 'session-created',
      roomId
    });

    vscode.window.showInformationMessage(
      `Session created! Room ID: ${roomId}`,
      'Copy Link'
    ).then((action) => {
      if (action === 'Copy Link') {
        this.copyInviteLink(roomId);
      }
    });
  }

  private async joinSession(): Promise<void> {
    const roomId = await vscode.window.showInputBox({
      prompt: 'Enter Room ID or paste invite link',
      placeHolder: 'ABC123 or orbitscore://join/ABC123'
    });

    if (roomId) {
      const cleanRoomId = roomId.replace(/^orbitscore:\/\/join\//, '');
      this.connectionManager.joinRoom(cleanRoomId);
    }
  }

  private copyInviteLink(roomId: string): void {
    const link = `orbitscore://join/${roomId}`;
    vscode.env.clipboard.writeText(link);
    vscode.window.showInformationMessage('Invite link copied!');
  }

  private endSession(): void {
    this.connectionManager.disconnect();
    this.panel.webview.postMessage({ command: 'session-ended' });
    vscode.window.showInformationMessage('Session ended.');
  }
}
```

#### 4.2 カーソル位置・選択範囲の表示

**他のユーザーのカーソル位置を色分け表示**

**VS Code版**:
```typescript
import * as vscode from 'vscode';
import { CRDTManager } from '../sync/crdt-manager';

export class CursorDecorations {
  private editor: vscode.TextEditor;
  private crdt: CRDTManager;
  private decorationTypes = new Map<number, vscode.TextEditorDecorationType>();

  constructor(editor: vscode.TextEditor, crdt: CRDTManager) {
    this.editor = editor;
    this.crdt = crdt;
    this.setupAwarenessListener();
  }

  private setupAwarenessListener(): void {
    this.crdt.provider.awareness.on('change', () => {
      this.updateCursorDecorations();
    });
  }

  private updateCursorDecorations(): void {
    const states = this.crdt.getAwareness();

    states.forEach((state, clientId) => {
      if (!state.cursor) return;

      const position = this.editor.document.positionAt(state.cursor);
      const range = new vscode.Range(position, position);

      let decorationType = this.decorationTypes.get(clientId);
      if (!decorationType) {
        decorationType = vscode.window.createTextEditorDecorationType({
          borderStyle: 'solid',
          borderWidth: '0 0 0 2px',
          borderColor: state.color,
          after: {
            contentText: ` ${state.name}`,
            color: state.color,
            fontStyle: 'italic'
          }
        });
        this.decorationTypes.set(clientId, decorationType);
      }

      this.editor.setDecorations(decorationType, [range]);
    });
  }

  destroy(): void {
    this.decorationTypes.forEach(decoration => decoration.dispose());
    this.decorationTypes.clear();
  }
}
```

**Monaco Editor版**:
```typescript
import * as monaco from 'monaco-editor';
import { CRDTManager } from '../sync/crdt-manager';

export class MonacoCursorDecorations {
  private editor: monaco.editor.IStandaloneCodeEditor;
  private crdt: CRDTManager;
  private decorations: string[] = [];

  constructor(editor: monaco.editor.IStandaloneCodeEditor, crdt: CRDTManager) {
    this.editor = editor;
    this.crdt = crdt;
    this.setupAwarenessListener();
  }

  private setupAwarenessListener(): void {
    this.crdt.provider.awareness.on('change', () => {
      this.updateCursorDecorations();
    });
  }

  private updateCursorDecorations(): void {
    const model = this.editor.getModel()!;
    const states = this.crdt.getAwareness();

    const newDecorations: monaco.editor.IModelDeltaDecoration[] = [];

    states.forEach((state, clientId) => {
      if (!state.cursor) return;

      const position = model.getPositionAt(state.cursor);

      newDecorations.push({
        range: new monaco.Range(
          position.lineNumber,
          position.column,
          position.lineNumber,
          position.column
        ),
        options: {
          className: 'remote-cursor',
          glyphMarginClassName: 'remote-cursor-glyph',
          beforeContentClassName: 'remote-cursor-label',
          hoverMessage: { value: state.name },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
        }
      });
    });

    this.decorations = this.editor.deltaDecorations(this.decorations, newDecorations);
  }

  destroy(): void {
    this.editor.deltaDecorations(this.decorations, []);
  }
}
```

**CSS**:
```css
.remote-cursor {
  border-left: 2px solid var(--user-color);
  position: relative;
}

.remote-cursor-label::before {
  content: attr(data-user-name);
  position: absolute;
  top: -20px;
  left: 0;
  background: var(--user-color);
  color: white;
  padding: 2px 5px;
  border-radius: 3px;
  font-size: 10px;
  white-space: nowrap;
}
```

**成果物**: 美しいコラボレーションUI

---

### Phase 4.5: チャット・コメント機能（推定: 1週間）

#### 4.5.1 リアルタイムチャット

**目的**: コラボレーター同士がテキストでコミュニケーション

**ファイル**: `src/chat/chat-manager.ts`

```typescript
import { ConnectionManager } from '../p2p/connection-manager';
import EventEmitter from 'eventemitter3';

export interface ChatMessage {
  id: string;
  userId: string;
  userName: string;
  userColor: string;
  text: string;
  timestamp: number;
  type: 'text' | 'code-comment' | 'system';

  // code-commentの場合のみ
  codeReference?: {
    lineStart: number;
    lineEnd: number;
    code: string;
    fileName?: string;
  };
}

export class ChatManager extends EventEmitter {
  private connectionManager: ConnectionManager;
  private messages: ChatMessage[] = [];
  private myUserId: string;
  private myUserName: string;
  private myUserColor: string;

  constructor(
    connectionManager: ConnectionManager,
    userId: string,
    userName: string,
    userColor: string
  ) {
    super();
    this.connectionManager = connectionManager;
    this.myUserId = userId;
    this.myUserName = userName;
    this.myUserColor = userColor;
    this.setupListeners();
  }

  // テキストメッセージ送信
  sendMessage(text: string): void {
    const message: ChatMessage = {
      id: this.generateMessageId(),
      userId: this.myUserId,
      userName: this.myUserName,
      userColor: this.myUserColor,
      text,
      timestamp: Date.now(),
      type: 'text'
    };

    this.addMessage(message);
    this.broadcast(message);
  }

  // コードコメント送信
  sendCodeComment(
    text: string,
    lineStart: number,
    lineEnd: number,
    code: string,
    fileName?: string
  ): void {
    const message: ChatMessage = {
      id: this.generateMessageId(),
      userId: this.myUserId,
      userName: this.myUserName,
      userColor: this.myUserColor,
      text,
      timestamp: Date.now(),
      type: 'code-comment',
      codeReference: {
        lineStart,
        lineEnd,
        code,
        fileName
      }
    };

    this.addMessage(message);
    this.broadcast(message);
  }

  // システムメッセージ送信（参加/退出通知）
  sendSystemMessage(text: string): void {
    const message: ChatMessage = {
      id: this.generateMessageId(),
      userId: 'system',
      userName: 'System',
      userColor: '#999999',
      text,
      timestamp: Date.now(),
      type: 'system'
    };

    this.addMessage(message);
    this.broadcast(message);
  }

  // メッセージ履歴取得
  getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  private broadcast(message: ChatMessage): void {
    this.connectionManager.broadcast({
      type: 'chat-message',
      message
    });
  }

  private setupListeners(): void {
    this.connectionManager.on('data', ({ peerId, data }) => {
      if (data.type === 'chat-message') {
        this.handleRemoteMessage(data.message);
      }
    });

    // 新規参加者にメッセージ履歴送信
    this.connectionManager.on('peer-connected', ({ peerId }) => {
      this.connectionManager.sendTo(peerId, {
        type: 'chat-history',
        messages: this.messages
      });
    });

    // 参加者からメッセージ履歴を受信
    this.connectionManager.on('data', ({ peerId, data }) => {
      if (data.type === 'chat-history') {
        // 既存メッセージとマージ（重複排除）
        this.mergeMessages(data.messages);
      }
    });
  }

  private handleRemoteMessage(message: ChatMessage): void {
    this.addMessage(message);
  }

  private addMessage(message: ChatMessage): void {
    this.messages.push(message);
    this.emit('message', message);

    // 最大1000件まで保持（古いものから削除）
    if (this.messages.length > 1000) {
      this.messages.shift();
    }
  }

  private mergeMessages(newMessages: ChatMessage[]): void {
    const existingIds = new Set(this.messages.map(m => m.id));

    newMessages.forEach(msg => {
      if (!existingIds.has(msg.id)) {
        this.messages.push(msg);
      }
    });

    // タイムスタンプでソート
    this.messages.sort((a, b) => a.timestamp - b.timestamp);

    this.emit('history-updated', this.messages);
  }

  private generateMessageId(): string {
    return `${this.myUserId}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  destroy(): void {
    this.messages = [];
    this.removeAllListeners();
  }
}
```

#### 4.5.2 チャットUI

**VS Code Extension版**: サイドバーパネルにチャットを追加

```
┌─────────────────────────────────┐
│ 🌐 Collaboration Session        │
├─────────────────────────────────┤
│ Status: Active (Host)           │
│ Room ID: ABC123                 │
│ [📋 Copy Invite Link]           │
│ [🛑 End Session]                │
├─────────────────────────────────┤
│ 👥 Participants (3)             │
│ ● Alice (You, Host) 🔴         │
│ ● Bob (Backup)     🔵          │
│ ● Charlie          🟢          │
├─────────────────────────────────┤
│ 💬 Chat                         │
├─────────────────────────────────┤
│ [Alice] 10:30                   │
│ Hey, let's try this pattern!    │
│                                 │
│ [Bob] 10:31 → Line 15-18        │
│ ┌─────────────────────────┐    │
│ │ kick.play(               │    │
│ │   (0)(1)(2)(3)           │    │
│ │ )                        │    │
│ └─────────────────────────┘    │
│ This sounds great!              │
│                                 │
│ [System] 10:32                  │
│ Charlie joined the session      │
├─────────────────────────────────┤
│ [Type message...]         [Send]│
└─────────────────────────────────┘
```

**実装** (`src/ui/chat-panel.ts`):

```typescript
import * as vscode from 'vscode';
import { ChatManager, ChatMessage } from '../chat/chat-manager';

export class ChatPanel {
  private panel: vscode.WebviewPanel;
  private chatManager: ChatManager;

  constructor(
    context: vscode.ExtensionContext,
    chatManager: ChatManager
  ) {
    this.chatManager = chatManager;

    this.panel = vscode.window.createWebviewPanel(
      'orbitscoreChat',
      'OrbitScore Chat',
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    this.panel.webview.html = this.getHtmlContent();
    this.setupMessageHandlers();
    this.setupChatListeners();
  }

  private getHtmlContent(): string {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body {
            font-family: var(--vscode-font-family);
            padding: 0;
            margin: 0;
            display: flex;
            flex-direction: column;
            height: 100vh;
          }

          #messages {
            flex: 1;
            overflow-y: auto;
            padding: 10px;
          }

          .message {
            margin-bottom: 15px;
            padding: 8px;
            border-radius: 4px;
            background: rgba(255, 255, 255, 0.05);
          }

          .message-header {
            display: flex;
            justify-content: space-between;
            margin-bottom: 5px;
            font-size: 12px;
            opacity: 0.7;
          }

          .message-author {
            font-weight: bold;
          }

          .message-text {
            margin-top: 5px;
            white-space: pre-wrap;
          }

          .code-reference {
            margin-top: 8px;
            padding: 8px;
            background: rgba(0, 0, 0, 0.3);
            border-left: 3px solid var(--user-color);
            font-family: 'Monaco', 'Menlo', monospace;
            font-size: 12px;
            cursor: pointer;
            position: relative;
          }

          .code-reference:hover {
            background: rgba(0, 0, 0, 0.5);
          }

          .code-reference::before {
            content: '→ Line ' attr(data-line-start) '-' attr(data-line-end);
            position: absolute;
            top: -18px;
            left: 8px;
            font-size: 10px;
            color: var(--user-color);
          }

          .code-reference code {
            white-space: pre;
            display: block;
          }

          .system-message {
            text-align: center;
            font-style: italic;
            opacity: 0.5;
            font-size: 12px;
          }

          #input-container {
            display: flex;
            padding: 10px;
            border-top: 1px solid rgba(255, 255, 255, 0.1);
          }

          #message-input {
            flex: 1;
            padding: 8px;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.2);
            color: var(--vscode-editor-foreground);
            border-radius: 4px;
          }

          #send-button {
            margin-left: 10px;
            padding: 8px 16px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
          }

          #send-button:hover {
            background: var(--vscode-button-hoverBackground);
          }
        </style>
      </head>
      <body>
        <div id="messages"></div>

        <div id="input-container">
          <input
            type="text"
            id="message-input"
            placeholder="Type message... (Ctrl+Enter to send)"
          />
          <button id="send-button">Send</button>
        </div>

        <script>
          const vscode = acquireVsCodeApi();
          const messagesContainer = document.getElementById('messages');
          const messageInput = document.getElementById('message-input');
          const sendButton = document.getElementById('send-button');

          // メッセージ送信
          function sendMessage() {
            const text = messageInput.value.trim();
            if (text) {
              vscode.postMessage({ command: 'send-message', text });
              messageInput.value = '';
            }
          }

          sendButton.addEventListener('click', sendMessage);

          messageInput.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === 'Enter') {
              sendMessage();
            }
          });

          // コード参照クリック → エディタにジャンプ
          messagesContainer.addEventListener('click', (e) => {
            const codeRef = e.target.closest('.code-reference');
            if (codeRef) {
              const messageId = codeRef.dataset.messageId;
              const lineStart = parseInt(codeRef.dataset.lineStart);
              const lineEnd = parseInt(codeRef.dataset.lineEnd);

              vscode.postMessage({
                command: 'jump-to-code',
                messageId,
                lineStart,
                lineEnd
              });
            }
          });

          // メッセージ受信
          window.addEventListener('message', (event) => {
            const message = event.data;

            switch (message.command) {
              case 'add-message':
                addMessage(message.message);
                break;
              case 'load-history':
                messagesContainer.innerHTML = '';
                message.messages.forEach(msg => addMessage(msg));
                break;
            }
          });

          function addMessage(msg) {
            const div = document.createElement('div');
            div.className = 'message';

            if (msg.type === 'system') {
              div.classList.add('system-message');
              div.textContent = msg.text;
            } else {
              const time = new Date(msg.timestamp).toLocaleTimeString('ja-JP', {
                hour: '2-digit',
                minute: '2-digit'
              });

              let html = \`
                <div class="message-header">
                  <span class="message-author" style="color: \${msg.userColor}">
                    [\${msg.userName}]
                  </span>
                  <span class="message-time">\${time}</span>
                </div>
              \`;

              if (msg.codeReference) {
                html += \`
                  <div
                    class="code-reference"
                    style="--user-color: \${msg.userColor}"
                    data-message-id="\${msg.id}"
                    data-line-start="\${msg.codeReference.lineStart}"
                    data-line-end="\${msg.codeReference.lineEnd}"
                  >
                    <code>\${escapeHtml(msg.codeReference.code)}</code>
                  </div>
                \`;
              }

              html += \`<div class="message-text">\${escapeHtml(msg.text)}</div>\`;

              div.innerHTML = html;
            }

            messagesContainer.appendChild(div);
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
          }

          function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
          }
        </script>
      </body>
      </html>
    `;
  }

  private setupMessageHandlers(): void {
    this.panel.webview.onDidReceiveMessage((message) => {
      switch (message.command) {
        case 'send-message':
          this.chatManager.sendMessage(message.text);
          break;

        case 'jump-to-code':
          this.jumpToCode(message.lineStart, message.lineEnd);
          break;
      }
    });
  }

  private setupChatListeners(): void {
    // 新規メッセージ受信
    this.chatManager.on('message', (message: ChatMessage) => {
      this.panel.webview.postMessage({
        command: 'add-message',
        message
      });
    });

    // メッセージ履歴更新
    this.chatManager.on('history-updated', (messages: ChatMessage[]) => {
      this.panel.webview.postMessage({
        command: 'load-history',
        messages
      });
    });
  }

  private jumpToCode(lineStart: number, lineEnd: number): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    // 行番号は0-indexedに変換
    const range = new vscode.Range(
      new vscode.Position(lineStart - 1, 0),
      new vscode.Position(lineEnd - 1, Number.MAX_VALUE)
    );

    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

    // ハイライトアニメーション
    const decoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(100, 150, 255, 0.3)',
      isWholeLine: true
    });

    editor.setDecorations(decoration, [range]);

    setTimeout(() => {
      decoration.dispose();
    }, 2000);
  }
}
```

#### 4.5.3 コードコメント機能

**VS Code Extension統合**:

```typescript
// extension.ts に追加
import { ChatManager } from './chat/chat-manager';
import { ChatPanel } from './ui/chat-panel';

let chatManager: ChatManager;
let chatPanel: ChatPanel;

// セッション作成時
chatManager = new ChatManager(
  connectionManager,
  connectionManager.myId,
  'User', // TODO: ユーザー名入力UI
  '#FF6B6B' // TODO: ランダム色生成
);

chatPanel = new ChatPanel(context, chatManager);

// コードコメントコマンド登録
context.subscriptions.push(
  vscode.commands.registerCommand('orbitscore.commentOnSelection', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const selection = editor.selection;
    if (selection.isEmpty) {
      vscode.window.showWarningMessage('Please select code to comment on');
      return;
    }

    // コメント入力
    const comment = await vscode.window.showInputBox({
      prompt: 'Enter your comment on the selected code',
      placeHolder: 'This pattern is interesting!'
    });

    if (!comment) return;

    // 選択範囲の情報取得
    const lineStart = selection.start.line + 1; // 1-indexed
    const lineEnd = selection.end.line + 1;
    const code = editor.document.getText(selection);
    const fileName = editor.document.fileName;

    // チャットに送信
    chatManager.sendCodeComment(comment, lineStart, lineEnd, code, fileName);

    vscode.window.showInformationMessage('Comment sent to chat!');
  })
);

// キーバインド追加（package.json）
{
  "command": "orbitscore.commentOnSelection",
  "key": "cmd+shift+c",
  "when": "editorTextFocus && editorLangId == orbitscore"
}
```

**使い方**:
1. コードを選択
2. **Cmd+Shift+C** (macOS) / **Ctrl+Shift+C** (Windows/Linux)
3. コメント入力
4. チャットに表示される
5. 他のユーザーはチャット内のコード参照をクリック → その行にジャンプ

#### 4.5.4 Monaco Editor版（Electron App用）

```typescript
import * as monaco from 'monaco-editor';
import { ChatManager } from '../chat/chat-manager';

export class MonacoChatIntegration {
  private editor: monaco.editor.IStandaloneCodeEditor;
  private chatManager: ChatManager;

  constructor(
    editor: monaco.editor.IStandaloneCodeEditor,
    chatManager: ChatManager
  ) {
    this.editor = editor;
    this.chatManager = chatManager;
    this.setupContextMenu();
  }

  private setupContextMenu(): void {
    // 右クリックメニューに「Comment on Selection」追加
    this.editor.addAction({
      id: 'orbitscore.comment-on-selection',
      label: 'Comment on Selection',
      contextMenuGroupId: 'orbitscore',
      contextMenuOrder: 1,
      keybindings: [
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyC
      ],
      run: (editor) => {
        this.handleCommentOnSelection();
      }
    });
  }

  private async handleCommentOnSelection(): Promise<void> {
    const selection = this.editor.getSelection();
    if (!selection || selection.isEmpty()) {
      alert('Please select code to comment on');
      return;
    }

    const model = this.editor.getModel();
    if (!model) return;

    // コメント入力（プロンプト表示）
    const comment = prompt('Enter your comment on the selected code:');
    if (!comment) return;

    // 選択範囲の情報取得
    const lineStart = selection.startLineNumber;
    const lineEnd = selection.endLineNumber;
    const code = model.getValueInRange(selection);

    // チャットに送信
    this.chatManager.sendCodeComment(comment, lineStart, lineEnd, code);

    console.log('Comment sent to chat!');
  }

  jumpToCode(lineStart: number, lineEnd: number): void {
    const range = new monaco.Range(lineStart, 1, lineEnd, Number.MAX_VALUE);

    this.editor.setSelection(range);
    this.editor.revealRangeInCenter(range, monaco.editor.ScrollType.Smooth);

    // ハイライトアニメーション
    const decorations = this.editor.deltaDecorations([], [
      {
        range: range,
        options: {
          isWholeLine: true,
          className: 'jump-highlight',
          inlineClassName: 'jump-highlight-inline'
        }
      }
    ]);

    setTimeout(() => {
      this.editor.deltaDecorations(decorations, []);
    }, 2000);
  }
}
```

**CSS** (Electron App用):
```css
.jump-highlight {
  background-color: rgba(100, 150, 255, 0.3);
  animation: pulse 0.5s ease-in-out 3;
}

.jump-highlight-inline {
  background-color: rgba(100, 150, 255, 0.2);
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}
```

**成果物**: リアルタイムチャット + コード参照機能

---

### Phase 5: ホストマイグレーション（推定: 3-5日）

#### 5.1 ホスト切断検出 + 確認フロー

**⚠️ 重要**: ホストマイグレーションは慎重に行う必要がある
- 音が急に切れる/鳴り出すとスピーカーが破損する可能性
- 意図しないタイミングでホストが変わるとパフォーマンスが台無しになる

**解決策: 3段階の安全な引き継ぎフロー**

##### ステップ1: ホスト切断検出

```typescript
// src/p2p/host-migration.ts
import { ConnectionManager, Role } from './connection-manager';

export class HostMigration {
  private connectionManager: ConnectionManager;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private hostTimeout: NodeJS.Timeout | null = null;
  private migrationState: 'idle' | 'confirming' | 'migrating' = 'idle';

  constructor(connectionManager: ConnectionManager) {
    this.connectionManager = connectionManager;
    this.setupHeartbeat();
    this.setupHostMigrationHandlers();
  }

  private setupHeartbeat(): void {
    // ホストは定期的にハートビート送信（5秒ごと）
    if (this.connectionManager.myRole === 'host') {
      this.heartbeatInterval = setInterval(() => {
        this.connectionManager.broadcast({
          type: 'heartbeat',
          timestamp: Date.now()
        });
      }, 5000);
    }
  }

  private setupHostMigrationHandlers(): void {
    this.connectionManager.on('data', ({ peerId, data }) => {
      if (data.type === 'heartbeat') {
        this.resetHostTimeout();
      }
    });
  }

  private resetHostTimeout(): void {
    if (this.hostTimeout) {
      clearTimeout(this.hostTimeout);
    }

    // ホストからのハートビートが15秒途絶えたら切断と判断
    this.hostTimeout = setTimeout(() => {
      this.handleHostDisconnected();
    }, 15000);
  }

  private handleHostDisconnected(): void {
    console.warn('[Host Disconnected] Starting migration confirmation...');

    // ステップ2へ: 確認フェーズ開始
    this.startMigrationConfirmation();
  }

  destroy(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    if (this.hostTimeout) {
      clearTimeout(this.hostTimeout);
    }
  }
}
```

##### ステップ2: 引き継ぎ確認ダイアログ

**動作フロー**:
1. ホスト切断検出
2. **全メンバーにダイアログ表示**: "Host disconnected. Would you like to take over as the new host?"
3. 最初に「Yes」を押した人が新ホストに昇格
4. タイムアウト（30秒）までに誰も応答しない場合 → セッション終了

```typescript
// ステップ2の実装
private startMigrationConfirmation(): void {
  this.migrationState = 'confirming';

  // 確認ダイアログを全員に送信
  this.connectionManager.broadcast({
    type: 'host-migration-confirmation-request',
    timeout: 30000, // 30秒
    timestamp: Date.now()
  });

  // ローカルにもダイアログ表示
  this.showMigrationConfirmationDialog();

  // タイムアウト設定
  setTimeout(() => {
    if (this.migrationState === 'confirming') {
      // 誰も応答しなかった → セッション終了
      this.handleMigrationTimeout();
    }
  }, 30000);
}

private async showMigrationConfirmationDialog(): Promise<void> {
  // VS Code版
  const response = await vscode.window.showWarningMessage(
    '⚠️ Host disconnected. Would you like to take over as the new host?',
    { modal: true },
    'Yes, Take Over',
    'No, Let Others'
  );

  if (response === 'Yes, Take Over') {
    this.acceptHostRole();
  }

  // Electron版（同様のダイアログをModalで表示）
}

private acceptHostRole(): void {
  if (this.migrationState !== 'confirming') {
    // 既に他の人がホストになった
    vscode.window.showInformationMessage('Another user has already taken over as host.');
    return;
  }

  // 他のメンバーに通知
  this.connectionManager.broadcast({
    type: 'host-migration-accepted',
    newHostId: this.connectionManager.myId,
    timestamp: Date.now()
  });

  // ステップ3へ: 引き継ぎ処理開始
  this.startMigration();
}
```

**UI例（VS Code）**:
```
┌──────────────────────────────────────────┐
│ ⚠️  Host Disconnected                    │
├──────────────────────────────────────────┤
│ The current host has disconnected.       │
│ Would you like to take over as the new   │
│ host?                                    │
│                                          │
│ ⚠️ Warning: Taking over will make you    │
│ responsible for audio output.            │
│                                          │
│ Timeout: 25 seconds remaining            │
├──────────────────────────────────────────┤
│ [Yes, Take Over]  [No, Let Others]       │
└──────────────────────────────────────────┘
```

##### ステップ3: 安全な引き継ぎ処理

**動作**:
1. **旧ホストの音をフェードアウト**（スピーカー保護）
2. **新ホストに状態同期**（エンジン状態、CRDT）
3. **新ホストの音をフェードイン**
4. **全員に通知**: "Alice is now the host"

```typescript
private async startMigration(): Promise<void> {
  this.migrationState = 'migrating';

  // 1. 旧ホストの音をフェードアウト（もしまだ鳴っていれば）
  await this.speakerProtection.fadeOut(this.engineManager);

  // 2. 新ホストとしてハートビート開始
  this.setupHeartbeat();
  this.connectionManager.myRole = 'host';

  // 3. 状態同期確認（CRDT経由で既に同期済みのはず）
  const currentState = await this.syncState();

  // 4. 新ホストの音をフェードイン
  await this.speakerProtection.fadeIn(this.engineManager);

  // 5. 全員に通知
  this.connectionManager.broadcast({
    type: 'host-migration-completed',
    newHostId: this.connectionManager.myId,
    timestamp: Date.now()
  });

  this.migrationState = 'idle';

  vscode.window.showInformationMessage('✅ You are now the host!');
  this.chatManager.sendSystemMessage('Host migrated successfully.');
}

private handleMigrationTimeout(): void {
  this.migrationState = 'idle';

  // 誰も引き継がなかった → セッション終了
  vscode.window.showErrorMessage(
    '❌ No one accepted the host role. Session will be closed.'
  );

  this.connectionManager.disconnect();
}
```

**UI通知例**:
```
┌──────────────────────────────────────────┐
│ ✅ Host Migration Completed              │
├──────────────────────────────────────────┤
│ Alice is now the host.                   │
│ Session continues normally.              │
└──────────────────────────────────────────┘
```

**チャット通知例**:
```
[System] 10:35
⚠️ Bob (Host) disconnected

[System] 10:35
Alice accepted the host role

[System] 10:35
✅ Host migration completed
```

##### エラーハンドリング

**ケース1: 複数人が同時に「Yes」を押した**
- **解決**: 最初にメッセージを送信した人が優先（タイムスタンプで判定）
- 他の人には「Another user has already taken over」を表示

**ケース2: 新ホストも直後に切断した**
- **解決**: 再度確認フローを開始（最大3回まで）
- 3回失敗したらセッション終了

**ケース3: 音がフェードアウト中に新しいコードが実行された**
- **解決**: フェードアウト完了まで実行をキューに溜める → フェードイン後に実行

**成果物**: 安全で確認フロー付きのホストマイグレーション

#### 5.2 状態引き継ぎ

**問題**: ホストマイグレーション時、新ホストは旧ホストの状態を引き継ぐ必要がある

**解決策**: CRDT（Y.js）が自動的に状態を同期しているため、追加実装不要
- エディタ内容: Y.jsが全Peerで同期済み
- エンジン状態: 最後にブロードキャストされた状態を保持
- カーソル位置: Awareness APIで同期済み

**追加処理**:
```typescript
// 新ホスト昇格時に全Peerに状態確認リクエスト
this.connectionManager.broadcast({
  type: 'request-state-sync',
  timestamp: Date.now()
});

// 各Peerは最新状態を返信
this.connectionManager.on('data', ({ peerId, data }) => {
  if (data.type === 'request-state-sync') {
    this.connectionManager.sendTo(peerId, {
      type: 'state-sync-response',
      editorContent: this.crdt.getText(),
      engineState: this.engineState
    });
  }
});
```

**成果物**: ホストが落ちてもセッション継続

---

### Phase 6: 安定性・エラーハンドリング（推定: 3-5日）

#### 6.1 自動再接続

```typescript
export class AutoReconnect {
  private connectionManager: ConnectionManager;
  private roomId: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;

  constructor(connectionManager: ConnectionManager, roomId: string) {
    this.connectionManager = connectionManager;
    this.roomId = roomId;
    this.setupDisconnectHandler();
  }

  private setupDisconnectHandler(): void {
    this.connectionManager.on('disconnected', () => {
      this.attemptReconnect();
    });
  }

  private async attemptReconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[Reconnect Failed] Max attempts reached');
      // TODO: ユーザーに通知
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 10000);

    console.log(`[Reconnecting] Attempt ${this.reconnectAttempts} in ${delay}ms...`);

    await new Promise(resolve => setTimeout(resolve, delay));

    try {
      await this.connectionManager.joinRoom(this.roomId);
      this.reconnectAttempts = 0; // リセット
      console.log('[Reconnected] Successfully');
    } catch (err) {
      console.error('[Reconnect Error]', err);
      this.attemptReconnect(); // リトライ
    }
  }
}
```

#### 6.2 バックアップサーバー

**シグナリングサーバーの冗長化**:
```typescript
const signalingServers = [
  'https://signaling1.orbitscore.com',
  'https://signaling2.orbitscore.com',
  'https://signaling3.orbitscore.com'
];

let currentServerIndex = 0;

function connectToSignalingServer(): Socket {
  const socket = io(signalingServers[currentServerIndex]);

  socket.on('connect_error', () => {
    console.error(`[Signaling Server Error] ${signalingServers[currentServerIndex]}`);
    currentServerIndex = (currentServerIndex + 1) % signalingServers.length;
    console.log(`[Switching to Backup] ${signalingServers[currentServerIndex]}`);
    socket.close();
    return connectToSignalingServer(); // 次のサーバーに接続
  });

  return socket;
}
```

**成果物**: 安定した接続

---

### Phase 7: テスト・ドキュメント（推定: 2-3日）

#### 7.1 テストシナリオ

**手動テスト**:
- [ ] 2人でセッション作成・参加
- [ ] 3人で同時編集（コンフリクトなし）
- [ ] ホストが切断 → Backupが昇格
- [ ] ホストが再接続 → Memberとして参加
- [ ] 全員同時にコード実行 → 音が同期
- [ ] ネットワーク切断 → 自動再接続

**負荷テスト**:
- [ ] 10人同時接続
- [ ] 100行のコードを同時編集
- [ ] 5分間の連続セッション

#### 7.2 ドキュメント

**ファイル**: `packages/vscode-extension-collab/README.md`

```markdown
# OrbitScore Collaboration Extension

P2P real-time collaboration for OrbitScore live coding.

## Features
- ✅ P2P connection (WebRTC)
- ✅ Host migration (no single point of failure)
- ✅ Real-time code sync (CRDT)
- ✅ Cursor position sync
- ✅ Code execution sync
- ✅ Engine state sync

## Installation
```bash
code --install-extension orbitscore-collab.vsix
```

## Usage

### Create Session (Host)
1. Open Command Palette (Cmd+Shift+P)
2. Run `OrbitScore: Create Collaboration Session`
3. Share Room ID with participants

### Join Session (Guest)
1. Open Command Palette (Cmd+Shift+P)
2. Run `OrbitScore: Join Collaboration Session`
3. Enter Room ID

## Architecture
- **P2P**: WebRTC (simple-peer)
- **CRDT**: Yjs (conflict-free sync)
- **Signaling**: Socket.IO server

## Troubleshooting

### Connection Failed
- Check firewall settings
- Try different signaling server (automatic fallback)

### Audio Not Synced
- This is expected! Each user runs code on their own SuperCollider.
- Network latency: 10-50ms is normal.
```

**成果物**: 本番リリース可能な協調編集機能

---

## 📊 総推定工数

| Phase | 内容 | 推定工数 | 難易度 |
|-------|------|---------|--------|
| Phase 1 | 基盤実装（P2P接続） | 1週間 | ⭐⭐⭐ |
| Phase 2 | データ同期（CRDT） | 1週間 | ⭐⭐⭐⭐ |
| Phase 3 | コード実行同期 | 3-5日 | ⭐⭐ |
| Phase 4 | UI/UX実装 | 1週間 | ⭐⭐ |
| **Phase 4.5** | **チャット・コメント機能** | **1週間** | **⭐⭐** |
| Phase 5 | ホストマイグレーション | 3-5日 | ⭐⭐⭐⭐ |
| Phase 6 | 安定性・エラーハンドリング | 3-5日 | ⭐⭐⭐ |
| Phase 7 | テスト・ドキュメント | 2-3日 | ⭐ |
| **合計** | | **約5-6週間** | |

**実作業時間**: 約1.5-2ヶ月（1日4-6時間作業想定）

---

## 🎯 最小限の実装（MVP版）

早期リリースが必要な場合、以下のスコープで **2-3週間** に短縮可能：

### 含むもの（MVP）
- ✅ Phase 1: P2P接続基盤
- ✅ Phase 2: CRDT統合（基本同期）
- ✅ Phase 3: コード実行同期
- ✅ Phase 4: 最小限UI（Create/Join Session）
- ✅ Phase 7: 基本テスト

### 省略するもの（v1.1以降に延期）
- ❌ ホストマイグレーション → ホストが落ちたらセッション終了
- ❌ カーソル位置表示 → テキスト同期のみ
- ❌ 自動再接続 → 手動で再接続
- ❌ バックアップサーバー → 単一シグナリングサーバー

**MVP版の制約**:
- ホストが切断したらセッション終了（再作成が必要）
- ネットワーク不安定時に再接続が必要

---

## ⚠️ 注意点・課題

### 1. オーディオ同期の考え方

**❌ 間違ったアプローチ**:
音声ストリームをネットワーク経由で送信
- ネットワーク遅延でリズムがずれる
- 帯域幅が必要
- エコーが発生

**✅ 正しいアプローチ**:
各自のSuperColliderで同じコードを実行
- コード実行イベントのみ同期（軽量）
- 各自のローカルで音を生成
- ネットワーク遅延: 10-50ms程度（許容範囲内）

**結果**: 全員がほぼ同期した音楽体験を得る

### 2. OrbitScore利用時の制約

**問題**: OrbitScoreはリアルタイム音声生成ツールなので、ネットワーク遅延の影響を受ける

**対策**:
- **コード実行の遅延**: 10-50ms（許容範囲内、人間は気づかない）
- **エディタ編集の遅延**: CRDT（Y.js）により最小化（1-10ms）

**Live ShareやOpen Collaboration toolsとの比較**:
- Live Share: エディタ同期のみ、OrbitScoreエンジン状態は非同期
- OrbitScore Collab: **エディタ + エンジン状態 + コード実行**を全て同期

### 3. シグナリングサーバーの運用

**コスト**:
- 無料PaaS（Heroku, Railway, Render）で月$0-7
- 有料サーバー（Linode, DigitalOcean）で月$5-10

**スケーラビリティ**:
- 1サーバーで100-200同時セッション対応可能
- 負荷が高い場合は複数サーバーに分散

**代替案**: P2P完全版（シグナリングサーバー不要）
- WebRTC + STUN/TURNサーバー
- NAT traversal問題（実装が複雑）
- 初期リリースでは見送り、将来的に検討

### 4. NAT/ファイアウォール問題

**問題**: 企業ネットワークや厳格なファイアウォール環境ではP2P接続が失敗する

**解決策**: TURNサーバー経由でリレー
- TURN: STUN/TURN無料サービス（Google STUN, Twilio TURN等）
- コスト: 無料版で十分（月10GB以下）

**設定**:
```typescript
const peer = new SimplePeer({
  initiator,
  trickle: false,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      {
        urls: 'turn:turn.example.com:3478',
        username: 'user',
        credential: 'pass'
      }
    ]
  }
});
```

### 5. セキュリティ

**脅威**:
- 悪意のあるユーザーが部屋に侵入
- 任意コード実行（SuperCollider経由）

**対策**:
- セッションIDは128bit UUID（推測困難）
- 部屋にパスワード設定（オプション）
- ホストがユーザーをKick可能
- コード実行は各自のSuperColliderで（サンドボックス）

---

## ⚠️ 重要な設計上の注意点（追加指摘への対応）

### 1. 音の排他制御

**問題**: 複数人が同時に音を出すと、同じ音が重複して爆音になる

**解決策**: 3つの音声出力モードを実装（Phase 3.2参照）
- **Individual Mode** (デフォルト): 自分が実行した音だけ出る
- **Host-Only Mode**: ホストだけが音を出せる
- **Shared Mode**: 全員が異なるトラックを担当（上級者向け）

**実装箇所**: `src/sync/audio-output-mode.ts`

### 2. スピーカー保護

**問題**: 音が急に出る/止まるとスピーカーが破損する可能性

**解決策**: フェードイン/フェードアウト機能を実装（Phase 3.2参照）
- フェードイン: 50ms
- フェードアウト: 100ms
- SuperColliderのマスターボリュームを徐々に変化

**適用シーン**:
- ホストマイグレーション時
- 音声出力モード切り替え時
- 緊急停止時（Panic Button）

**実装箇所**: `src/audio/speaker-protection.ts`

### 3. ホストマイグレーションの確認フロー

**問題**: 勝手にホストが変わるとパフォーマンスが台無しになる

**解決策**: 3段階の安全な引き継ぎフロー（Phase 5.1参照）

#### ステップ1: ホスト切断検出
- ハートビート途絶（15秒）で検出

#### ステップ2: 確認ダイアログ
- **全メンバーに確認**: "Would you like to take over as the new host?"
- **最初にOKした人**が新ホストに昇格
- タイムアウト（30秒）→ 誰も応答しない場合はセッション終了

#### ステップ3: 安全な引き継ぎ
1. 旧ホストの音をフェードアウト
2. 状態同期確認
3. 新ホストの音をフェードイン
4. 全員に通知

**実装箇所**: `src/p2p/host-migration.ts`

### 4. エラーハンドリング

**ケース1: 複数人が同時に「Yes」を押した**
- 最初にメッセージを送信した人が優先（タイムスタンプで判定）

**ケース2: 新ホストも直後に切断した**
- 再度確認フローを開始（最大3回まで）
- 3回失敗したらセッション終了

**ケース3: 音がフェードアウト中に新しいコードが実行された**
- フェードアウト完了まで実行をキューに溜める
- フェードイン後に実行

---

## 🤔 拡張アイデア（将来版）

### v1.5: ボイスチャット統合
- WebRTC音声通話
- コラボレーション中に会話可能

### v2.0: セッション録画・再生
- 全編集履歴を記録
- タイムライン再生（教育用）

### v2.5: AI Assistant統合
- コード補完・提案をリアルタイム共有
- AIが音楽理論的アドバイスを提供

---

## 🚀 開発開始手順

このプランを実行する場合、以下の手順で開始します：

### 1. Issue作成
```bash
gh issue create \
  --title "P2P協調ライブコーディング機能開発" \
  --body "$(cat docs/COLLABORATION_FEATURE_PLAN.md)" \
  --label "enhancement,collaboration,p2p"
```

### 2. ブランチ作成
```bash
git checkout main
git pull origin main
git checkout -b <issue-number>-p2p-collaboration
```

### 3. パッケージ初期化
```bash
cd packages
mkdir vscode-extension-collab
cd vscode-extension-collab

npm init -y

npm install --save-dev \
  @types/vscode@^1.99.0 \
  typescript@^5.9.0

npm install \
  simple-peer@^9.11.1 \
  socket.io-client@^4.5.0 \
  yjs@^13.6.0 \
  y-webrtc@^10.2.5 \
  uuid@^9.0.0 \
  eventemitter3@^5.0.0
```

### 4. シグナリングサーバー構築
```bash
cd packages
mkdir collab-signaling-server
cd collab-signaling-server

npm init -y
npm install express socket.io

# server.ts作成（上記Phase 1.2参照）
```

### 5. Phase 1実装開始
```bash
# P2P接続マネージャー実装
touch src/p2p/connection-manager.ts

# 開発開始！
```

---

## 📚 関連ドキュメント

- **Electron版アプリ**: `docs/ELECTRON_APP_PLAN.md`
- **DSL仕様**: `docs/INSTRUCTION_ORBITSCORE_DSL.md`
- **プロジェクトルール**: `docs/PROJECT_RULES.md`
- **実装計画**: `docs/IMPLEMENTATION_PLAN.md`

---

## 🎯 次のアクション

**推奨実装順序**:
1. **Electron版アプリ** (2.5-4週間) - UI/UXの基盤
2. **P2P協調機能** (4-5週間) - コラボレーション環境

**理由**:
- Electron版で安定したエディタ基盤を構築
- その上に協調機能を追加する方が効率的
- VS Code Extension版で協調機能のプロトタイプ実装も可能

---

**このプランに関する質問や提案があれば、Issue/PRで議論してください。**
