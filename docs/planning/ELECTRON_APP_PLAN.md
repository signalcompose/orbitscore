# Electron + Monaco統合版 アプリ開発プラン

**ステータス**: 計画段階（未着手）
**優先度**: 中〜高（比較的早期に実装予定）
**作成日**: 2025-10-10
**最終更新**: 2025-10-10

---

## 📋 プロジェクト概要

### 目標
OrbitScoreをスタンドアロンのElectronアプリとして配布する。

### 主な特徴
- **Monaco Editor**: VS Codeと同じエディタエンジンによる快適な編集体験
- **Node.js統合**: SuperColliderエンジンとの直接通信（低レイテンシ）
- **クロスプラットフォーム**: macOS, Windows, Linux対応
- **スタンドアロン**: VS Code不要で動作する専用ライブコーディング環境

### VS Code Extension版との比較

| 項目 | VS Code Extension | Electron App |
|------|------------------|--------------|
| インストール | VS Code必須 | スタンドアロン |
| UI拡張性 | 限定的 | 自由度高 |
| 配布 | .vsix | .dmg/.exe/.AppImage |
| カスタマイズ | VS Code設定に依存 | 独自設定可能 |
| 機能追加の容易さ | 中 | 高 |
| ターゲットユーザー | 開発者寄り | 一般ユーザー含む |

**このプランの動機**: UIや機能を追加する際の自由度が高く、OrbitScore専用の最適化されたユーザー体験を提供できる。

---

## 🏗️ アーキテクチャ設計

### パッケージ構成
```
packages/
├── engine/              # 既存（変更なし）
│   ├── src/
│   └── dist/
├── vscode-extension/    # 既存（参考実装として継続メンテナンス）
│   └── src/
└── electron-app/        # 新規作成
    ├── src/
    │   ├── main/        # Main Process（Node.js）
    │   │   ├── main.ts
    │   │   ├── engine-manager.ts
    │   │   └── ipc-handlers.ts
    │   ├── renderer/    # Renderer Process（Monaco Editor）
    │   │   ├── index.html
    │   │   ├── editor.ts
    │   │   ├── language-orbitscore.ts
    │   │   ├── completion-provider.ts
    │   │   └── styles.css
    │   └── preload/     # Preload Script（IPC Bridge）
    │       └── preload.ts
    ├── assets/          # アイコン等
    └── dist/            # ビルド出力
```

### プロセス分離（Electronの標準構成）

#### 1. Main Process (Node.js環境)
**役割**: バックエンド処理
- SuperColliderエンジンの起動・管理
- ファイルシステムアクセス
- IPC通信のハンドラー
- メニューバー・ウィンドウ管理

**技術**: Node.js, Electron Main API

#### 2. Renderer Process (Chromium環境)
**役割**: フロントエンド UI
- Monaco Editorの表示・操作
- シンタックスハイライト
- ユーザー入力処理
- コード実行トリガー

**技術**: Monaco Editor, HTML/CSS, TypeScript

#### 3. Preload Script
**役割**: セキュリティブリッジ
- contextBridge経由でIPC APIを安全に公開
- Main ↔ Renderer間の型安全な通信

**セキュリティ**: `contextIsolation: true`, `nodeIntegration: false`

---

## 📝 実装タスク詳細

### Phase 1: プロジェクトセットアップ（推定: 1日）

#### 1.1 パッケージ初期化
- [ ] `packages/electron-app/` ディレクトリ作成
- [ ] `package.json` 作成
  ```json
  {
    "name": "@orbitscore/electron-app",
    "version": "0.1.0",
    "main": "dist/main/main.js",
    "devDependencies": {
      "electron": "^28.0.0",
      "electron-builder": "^24.0.0",
      "electron-vite": "^2.0.0",
      "monaco-editor": "^0.50.0",
      "typescript": "^5.9.0"
    }
  }
  ```

#### 1.2 ビルド環境構築
- [ ] `electron.vite.config.ts` 作成
  - Main Process用設定
  - Renderer Process用設定
  - Monaco Editor Worker設定（5つのworker: editor, json, css, html, ts）
- [ ] 開発用スクリプト追加
  ```json
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "preview": "electron-vite preview",
    "pack": "electron-builder --dir",
    "dist": "electron-builder"
  }
  ```

**成果物**: 空のElectronアプリが起動する（Hello World表示）

---

### Phase 2: Main Process実装（推定: 2-3日）

#### 2.1 エンジン管理モジュール
**ファイル**: `src/main/engine-manager.ts`

**実装内容**:
- SuperColliderエンジン起動ロジック移植（`extension.ts:startEngine`から）
- プロセス管理（spawn, kill, restart）
- stdout/stderr監視
- エラーハンドリング
- デバッグモード対応

**参考コード**: `packages/vscode-extension/src/extension.ts:595-656`

```typescript
class EngineManager {
  private engineProcess: ChildProcess | null = null;

  async start(options: { debugMode?: boolean; audioDevice?: string }): Promise<void>
  async stop(): Promise<void>
  async restart(): Promise<void>
  async execute(code: string): Promise<void>
  getStatus(): EngineStatus
}
```

#### 2.2 IPC通信ハンドラー
**ファイル**: `src/main/ipc-handlers.ts`

**実装するチャンネル**:
- `engine:start` - エンジン起動
- `engine:stop` - エンジン停止
- `engine:restart` - エンジン再起動
- `engine:execute` - コード実行（stdin書き込み）
- `engine:status` - 状態取得（running/stopped/error）
- `engine:output` - 出力イベント（stdout/stderrをRendererに配信）
- `audio-device:list` - オーディオデバイス一覧取得
- `audio-device:select` - デバイス選択
- `file:open` - ファイルを開く（ダイアログ表示）
- `file:save` - ファイル保存
- `file:save-as` - 名前をつけて保存

```typescript
export function registerIpcHandlers(engineManager: EngineManager) {
  ipcMain.handle('engine:start', async (event, options) => { ... });
  ipcMain.handle('engine:execute', async (event, code) => { ... });
  // ...
}
```

#### 2.3 メインウィンドウ作成
**ファイル**: `src/main/main.ts`

**実装内容**:
- `BrowserWindow` 初期化（800x600、ダークモード対応）
- メニューバー設定
  - File: New, Open, Save, Save As, Quit
  - Edit: Undo, Redo, Cut, Copy, Paste
  - View: Reload, Toggle DevTools, Zoom
  - Run: Start Engine, Stop Engine, Execute Selection (Cmd+Enter)
- ライフサイクル管理
  - `app.whenReady()`: IPC登録、ウィンドウ作成
  - `app.on('window-all-closed')`: macOSでは終了しない
  - `app.on('activate')`: macOSでウィンドウ再作成

**成果物**: エンジン起動・停止ができるMain Process

---

### Phase 3: Monaco Editor統合（推定: 3-4日）

#### 3.1 Monaco Editorセットアップ
**ファイル**: `src/renderer/editor.ts`

**実装内容**:
- Monaco Editor初期化
- 基本設定（テーマ、フォント、行番号、ミニマップ）
- Worker環境設定（Web Worker経由でシンタックス解析）

```typescript
import * as monaco from 'monaco-editor';

// Worker設定
self.MonacoEnvironment = {
  getWorkerUrl: function (moduleId, label) {
    if (label === 'json') return './json.worker.js';
    if (label === 'css' || label === 'scss' || label === 'less')
      return './css.worker.js';
    if (label === 'html' || label === 'handlebars' || label === 'razor')
      return './html.worker.js';
    if (label === 'typescript' || label === 'javascript')
      return './ts.worker.js';
    return './editor.worker.js';
  }
};

// エディタ作成
const editor = monaco.editor.create(document.getElementById('container'), {
  value: '// Welcome to OrbitScore\n',
  language: 'orbitscore',
  theme: 'vs-dark',
  fontSize: 14,
  minimap: { enabled: true },
  lineNumbers: 'on',
  automaticLayout: true
});
```

#### 3.2 カスタム言語サポート
**ファイル**: `src/renderer/language-orbitscore.ts`

**実装内容**:
- 言語定義登録（`monaco.languages.register`）
- Monarch Tokenizer移植（`orbitscore-audio.tmLanguage.json`から変換）
- シンタックスハイライトルール

**変換作業**: TextMate Grammar → Monaco Monarch Tokenizer
- TextMate: `.tmLanguage.json` 形式（VS Code標準）
- Monarch: Monaco Editor独自形式（より軽量）

```typescript
monaco.languages.register({ id: 'orbitscore' });

monaco.languages.setMonarchTokensProvider('orbitscore', {
  keywords: ['var', 'init', 'GLOBAL', 'RUN', 'LOOP', 'MUTE', 'by', 'force'],

  tokenizer: {
    root: [
      [/\/\/.*$/, 'comment'],
      [/#.*$/, 'comment'],
      [/\b(var|init|GLOBAL|RUN|LOOP|MUTE)\b/, 'keyword'],
      [/\b(global|seq\d*|drums|bass|piano)\b/, 'variable'],
      [/\b(tempo|tick|beat|audio|chop|play|gain|pan)\b(?=\()/, 'function'],
      [/"([^"\\]|\\.)*$/, 'string.invalid'],
      [/"/, 'string', '@string'],
      [/\d+\.\d+/, 'number.float'],
      [/\d+/, 'number'],
      // ...
    ],
    string: [
      [/[^\\"]+/, 'string'],
      [/\\./, 'string.escape'],
      [/"/, 'string', '@pop']
    ]
  }
});
```

**参考**: `packages/vscode-extension/syntaxes/orbitscore-audio.tmLanguage.json`

#### 3.3 補完機能（IntelliSense）
**ファイル**: `src/renderer/completion-provider.ts`

**実装内容**:
- `monaco.languages.registerCompletionItemProvider` 登録
- コンテキスト認識（`global.`, `seq.`, トップレベル）
- グローバルメソッド補完
  - `tempo(bpm)`, `tick(n)`, `beat(n)`, `key(note)`, `gain(level)`, `pan(position)`
- シーケンスメソッド補完
  - `audio(path)`, `chop(n)`, `play(...)`, `tempo(bpm)`, `beat(n)`, `length(bars)`, `gain(level)`, `pan(position)`
- キーワード補完
  - `var`, `init`, `GLOBAL`, `RUN()`, `LOOP()`, `MUTE()`

```typescript
monaco.languages.registerCompletionItemProvider('orbitscore', {
  provideCompletionItems: (model, position) => {
    const textUntilPosition = model.getValueInRange({
      startLineNumber: position.lineNumber,
      startColumn: 1,
      endLineNumber: position.lineNumber,
      endColumn: position.column
    });

    // global. の後
    if (/global\.\w*$/.test(textUntilPosition)) {
      return {
        suggestions: [
          {
            label: 'tempo',
            kind: monaco.languages.CompletionItemKind.Method,
            insertText: 'tempo(${1:120})',
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            documentation: 'Set global tempo in BPM'
          },
          // ...
        ]
      };
    }

    // seq. の後
    if (/\b(seq\d*|[a-z_]\w*)\.\w*$/.test(textUntilPosition)) {
      return { suggestions: [ /* シーケンスメソッド */ ] };
    }

    // トップレベル
    return { suggestions: [ /* キーワード */ ] };
  }
});
```

**参考**: `packages/vscode-extension/src/completion-context.ts`

#### 3.4 UI実装
**ファイル**: `src/renderer/index.html`

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>OrbitScore</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <div id="app">
    <!-- ツールバー -->
    <div id="toolbar">
      <button id="btn-start-engine">▶ Start Engine</button>
      <button id="btn-stop-engine">■ Stop Engine</button>
      <button id="btn-execute">⚡ Execute (Cmd+Enter)</button>
    </div>

    <!-- エディタコンテナ -->
    <div id="editor-container"></div>

    <!-- ステータスバー -->
    <div id="statusbar">
      <span id="engine-status">Engine: Stopped</span>
      <span id="cursor-position">Ln 1, Col 1</span>
    </div>
  </div>

  <script type="module" src="./renderer.js"></script>
</body>
</html>
```

**ファイル**: `src/renderer/styles.css`

```css
body {
  margin: 0;
  padding: 0;
  overflow: hidden;
  background: #1e1e1e;
  color: #d4d4d4;
  font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
}

#app {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

#toolbar {
  height: 40px;
  background: #2d2d30;
  display: flex;
  align-items: center;
  padding: 0 10px;
  gap: 10px;
}

#editor-container {
  flex: 1;
  overflow: hidden;
}

#statusbar {
  height: 24px;
  background: #007acc;
  color: white;
  display: flex;
  align-items: center;
  padding: 0 10px;
  justify-content: space-between;
  font-size: 12px;
}
```

**成果物**: OrbitScore DSLがシンタックスハイライトされる美しいエディタ

---

### Phase 4: IPC通信とコード実行（推定: 2-3日）

#### 4.1 Preload Script
**ファイル**: `src/preload/preload.ts`

**実装内容**: contextBridgeでIPC APIを安全に公開

```typescript
import { contextBridge, ipcRenderer } from 'electron';

// 型定義
export interface ElectronAPI {
  // エンジン操作
  startEngine: (options?: { debugMode?: boolean }) => Promise<void>;
  stopEngine: () => Promise<void>;
  executeCode: (code: string) => Promise<void>;
  getEngineStatus: () => Promise<string>;

  // イベントリスナー
  onEngineOutput: (callback: (data: string) => void) => void;
  onEngineError: (callback: (error: string) => void) => void;

  // ファイル操作
  openFile: () => Promise<string | null>;
  saveFile: (content: string, path?: string) => Promise<void>;

  // オーディオデバイス
  listAudioDevices: () => Promise<string[]>;
  selectAudioDevice: (device: string) => Promise<void>;
}

contextBridge.exposeInMainWorld('electronAPI', {
  startEngine: (options) => ipcRenderer.invoke('engine:start', options),
  stopEngine: () => ipcRenderer.invoke('engine:stop'),
  executeCode: (code) => ipcRenderer.invoke('engine:execute', code),
  getEngineStatus: () => ipcRenderer.invoke('engine:status'),

  onEngineOutput: (callback) => {
    ipcRenderer.on('engine:output', (_event, data) => callback(data));
  },
  onEngineError: (callback) => {
    ipcRenderer.on('engine:error', (_event, error) => callback(error));
  },

  openFile: () => ipcRenderer.invoke('file:open'),
  saveFile: (content, path) => ipcRenderer.invoke('file:save', content, path),

  listAudioDevices: () => ipcRenderer.invoke('audio-device:list'),
  selectAudioDevice: (device) => ipcRenderer.invoke('audio-device:select', device)
});

// TypeScript型定義をグローバルに追加
declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
```

#### 4.2 Renderer → Main通信
**ファイル**: `src/renderer/engine-client.ts`

**実装内容**: エンジン操作のAPIラッパー

```typescript
class EngineClient {
  private outputCallbacks: Array<(data: string) => void> = [];

  constructor() {
    // エンジン出力のイベントリスナー登録
    window.electronAPI.onEngineOutput((data) => {
      this.outputCallbacks.forEach(cb => cb(data));
    });

    window.electronAPI.onEngineError((error) => {
      console.error('Engine error:', error);
      this.updateStatusBar('error', error);
    });
  }

  async start(debugMode = false): Promise<void> {
    await window.electronAPI.startEngine({ debugMode });
    this.updateStatusBar('running', '🎵 Engine: Ready');
  }

  async stop(): Promise<void> {
    await window.electronAPI.stopEngine();
    this.updateStatusBar('stopped', 'Engine: Stopped');
  }

  async execute(code: string): Promise<void> {
    await window.electronAPI.executeCode(code);
  }

  onOutput(callback: (data: string) => void): void {
    this.outputCallbacks.push(callback);
  }

  private updateStatusBar(status: string, message: string): void {
    const statusEl = document.getElementById('engine-status');
    if (statusEl) statusEl.textContent = message;
  }
}
```

#### 4.3 コード実行機能
**ファイル**: `src/renderer/execution.ts`

**実装内容**:
- キーバインド実装（Cmd+Enter / Ctrl+Enter）
- 選択範囲の実行
- カーソル行の実行（選択なしの場合）
- ファイル全体の評価（初回のみ、バックグラウンド）
- 実行時のビジュアルフィードバック

```typescript
import * as monaco from 'monaco-editor';

class ExecutionManager {
  private editor: monaco.editor.IStandaloneCodeEditor;
  private engineClient: EngineClient;
  private hasEvaluatedFile = false;

  constructor(editor: monaco.editor.IStandaloneCodeEditor, engineClient: EngineClient) {
    this.editor = editor;
    this.engineClient = engineClient;
    this.registerKeyBindings();
  }

  private registerKeyBindings(): void {
    // Cmd+Enter / Ctrl+Enter
    this.editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
      () => this.executeSelection()
    );
  }

  async executeSelection(): Promise<void> {
    const selection = this.editor.getSelection();
    let code: string;

    if (!selection || selection.isEmpty()) {
      // 現在行を実行
      const position = this.editor.getPosition();
      if (!position) return;
      code = this.editor.getModel()?.getLineContent(position.lineNumber) || '';
    } else {
      // 選択範囲を実行
      code = this.editor.getModel()?.getValueInRange(selection) || '';
    }

    // 初回のみファイル全体を評価（定義のみフィルタ）
    if (!this.hasEvaluatedFile) {
      await this.evaluateFileInBackground();
      this.hasEvaluatedFile = true;
      // 500ms待機（評価完了待ち）
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // コード実行
    await this.engineClient.execute(code.trim());

    // ビジュアルフィードバック
    this.flashExecutedLines(selection);
  }

  private async evaluateFileInBackground(): Promise<void> {
    const model = this.editor.getModel();
    if (!model) return;

    const fullText = model.getValue();
    const definitionsOnly = this.filterDefinitionsOnly(fullText);

    await this.engineClient.execute(definitionsOnly);
  }

  private filterDefinitionsOnly(text: string): string {
    // var, init, GLOBAL のみを抽出（RUN/LOOP/MUTEは除外）
    return text
      .split('\n')
      .filter(line => {
        const trimmed = line.trim();
        return (
          trimmed.startsWith('var ') ||
          trimmed.includes('.init') ||
          trimmed.startsWith('GLOBAL')
        ) && !trimmed.includes('//');
      })
      .join('\n');
  }

  private flashExecutedLines(selection: monaco.Selection | null): void {
    if (!selection) return;

    const range = selection.isEmpty()
      ? new monaco.Range(
          selection.startLineNumber,
          1,
          selection.startLineNumber,
          Number.MAX_VALUE
        )
      : selection;

    // デコレーション作成（背景色フラッシュ）
    const decorations = this.editor.deltaDecorations([], [
      {
        range: range,
        options: {
          isWholeLine: selection.isEmpty(),
          className: 'flash-executed-line',
          inlineClassName: 'flash-executed-inline'
        }
      }
    ]);

    // 150ms後にデコレーション削除（3回繰り返し）
    let flashCount = 0;
    const flashInterval = setInterval(() => {
      flashCount++;
      if (flashCount >= 3) {
        clearInterval(flashInterval);
        this.editor.deltaDecorations(decorations, []);
      } else {
        // Toggle visibility
        this.editor.deltaDecorations(decorations, []);
        setTimeout(() => {
          this.editor.deltaDecorations([], [
            {
              range: range,
              options: {
                isWholeLine: selection.isEmpty(),
                className: 'flash-executed-line'
              }
            }
          ]);
        }, 100);
      }
    }, 250);
  }
}
```

**CSS** (styles.cssに追加):
```css
.flash-executed-line {
  background-color: rgba(255, 255, 255, 0.15);
}

.flash-executed-inline {
  background-color: rgba(100, 150, 255, 0.2);
}
```

**参考**: `extension.ts:runSelection()` (888-986行)

**成果物**: Cmd+Enterでコードが実行できるエディタ

---

### Phase 5: 機能拡張（推定: 2-3日）

#### 5.1 ファイル操作
**実装内容**:

**メニューバー** (`src/main/menu.ts`):
```typescript
import { Menu, dialog, BrowserWindow } from 'electron';

export function createMenu(mainWindow: BrowserWindow): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow.webContents.send('file:new')
        },
        {
          label: 'Open...',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const result = await dialog.showOpenDialog({
              properties: ['openFile'],
              filters: [
                { name: 'OrbitScore Files', extensions: ['osc'] },
                { name: 'All Files', extensions: ['*'] }
              ]
            });
            if (!result.canceled && result.filePaths.length > 0) {
              const content = fs.readFileSync(result.filePaths[0], 'utf-8');
              mainWindow.webContents.send('file:opened', {
                path: result.filePaths[0],
                content
              });
            }
          }
        },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => mainWindow.webContents.send('file:save')
        },
        {
          label: 'Save As...',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => mainWindow.webContents.send('file:save-as')
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' }
      ]
    },
    {
      label: 'Run',
      submenu: [
        {
          label: 'Start Engine',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: () => mainWindow.webContents.send('engine:start')
        },
        {
          label: 'Stop Engine',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => mainWindow.webContents.send('engine:stop')
        },
        { type: 'separator' },
        {
          label: 'Execute Selection',
          accelerator: 'CmdOrCtrl+Enter',
          click: () => mainWindow.webContents.send('code:execute')
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
```

**最近開いたファイル履歴** (electron-storeで永続化):
```typescript
import Store from 'electron-store';

const store = new Store();

function addToRecentFiles(filePath: string): void {
  const recent = store.get('recentFiles', []) as string[];
  const updated = [filePath, ...recent.filter(p => p !== filePath)].slice(0, 10);
  store.set('recentFiles', updated);
}
```

**ドラッグ&ドロップ対応** (`src/renderer/file-handler.ts`):
```typescript
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files[0];
  if (file && file.name.endsWith('.osc')) {
    const content = await file.text();
    editor.setValue(content);
  }
});

document.addEventListener('dragover', (e) => {
  e.preventDefault();
});
```

#### 5.2 エディタ機能強化

**実装内容**:
- ミニマップ表示切り替え
- 検索/置換（Cmd+F / Cmd+H）（Monaco標準機能）
- マルチカーソル（Monaco標準機能）
- コマンドパレット（Cmd+Shift+P）

```typescript
// ミニマップトグル
editor.updateOptions({
  minimap: { enabled: !editor.getOptions().get(monaco.editor.EditorOption.minimap).enabled }
});

// 検索/置換（Monaco標準で対応済み）
// Cmd+F: 検索
// Cmd+H: 置換
// Cmd+G: 次を検索
// Cmd+Shift+G: 前を検索
```

#### 5.3 設定パネル
**実装内容**: Preferences画面（モーダルウィンドウ）

**UI** (`src/renderer/preferences.html`):
```html
<div id="preferences-modal" class="modal">
  <div class="modal-content">
    <h2>Preferences</h2>

    <section>
      <h3>Audio</h3>
      <label>Output Device:</label>
      <select id="audio-device-select">
        <!-- デバイス一覧が動的に追加される -->
      </select>
    </section>

    <section>
      <h3>Editor</h3>
      <label>Theme:</label>
      <select id="theme-select">
        <option value="vs-dark">Dark</option>
        <option value="vs-light">Light</option>
      </select>

      <label>Font Size:</label>
      <input type="number" id="font-size" min="10" max="24" value="14">
    </section>

    <section>
      <h3>Flash Settings</h3>
      <label>Flash Count:</label>
      <input type="number" id="flash-count" min="1" max="5" value="3">

      <label>Flash Duration (ms):</label>
      <input type="number" id="flash-duration" min="50" max="500" step="50" value="150">

      <label>Flash Color:</label>
      <input type="color" id="flash-color" value="#ff6b6b">
    </section>

    <div class="modal-buttons">
      <button id="btn-save-prefs">Save</button>
      <button id="btn-cancel-prefs">Cancel</button>
    </div>
  </div>
</div>
```

**設定の永続化** (`src/main/settings.ts`):
```typescript
import Store from 'electron-store';

interface Settings {
  audioDevice?: string;
  theme: 'vs-dark' | 'vs-light';
  fontSize: number;
  flashCount: number;
  flashDuration: number;
  flashColor: string;
}

const settingsStore = new Store<Settings>({
  defaults: {
    theme: 'vs-dark',
    fontSize: 14,
    flashCount: 3,
    flashDuration: 150,
    flashColor: '#ff6b6b'
  }
});

export function getSettings(): Settings {
  return settingsStore.store;
}

export function updateSettings(settings: Partial<Settings>): void {
  settingsStore.set(settings);
}
```

#### 5.4 ステータスバー
**実装内容**:
- エンジン状態表示（Stopped / Ready / Running / Error）
- 現在のBPM表示（エンジンから取得）
- カーソル位置（行・列）
- 選択範囲の行数・文字数

```typescript
class StatusBar {
  private engineStatusEl: HTMLElement;
  private cursorPosEl: HTMLElement;
  private bpmEl: HTMLElement;

  constructor() {
    this.engineStatusEl = document.getElementById('engine-status')!;
    this.cursorPosEl = document.getElementById('cursor-position')!;
    this.bpmEl = document.getElementById('bpm-display')!;

    // カーソル位置更新
    editor.onDidChangeCursorPosition((e) => {
      this.cursorPosEl.textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
    });

    // 選択範囲更新
    editor.onDidChangeCursorSelection((e) => {
      if (!e.selection.isEmpty()) {
        const model = editor.getModel();
        if (model) {
          const text = model.getValueInRange(e.selection);
          const lines = text.split('\n').length;
          const chars = text.length;
          this.cursorPosEl.textContent += ` (${lines} lines, ${chars} chars selected)`;
        }
      }
    });
  }

  setEngineStatus(status: 'stopped' | 'ready' | 'running' | 'error', message?: string): void {
    const icons = {
      stopped: '⚫',
      ready: '🟢',
      running: '🔵',
      error: '🔴'
    };
    this.engineStatusEl.textContent = `${icons[status]} ${message || status}`;
  }

  setBPM(bpm: number): void {
    this.bpmEl.textContent = `♩ = ${bpm}`;
  }
}
```

**成果物**: フル機能のプロフェッショナルなエディタアプリ

---

### Phase 6: パッケージング・配布（推定: 2-3日）

#### 6.1 electron-builder設定
**ファイル**: `electron-builder.yml`

```yaml
appId: com.orbitscore.app
productName: OrbitScore
copyright: Copyright © 2026 Signal compose Inc.

directories:
  output: release
  buildResources: assets

files:
  - dist/**/*
  - package.json

# macOS
mac:
  category: public.app-category.music
  icon: assets/icon.icns
  target:
    - target: dmg
      arch: [x64, arm64]
    - target: zip
      arch: [x64, arm64]
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: assets/entitlements.mac.plist
  entitlementsInherit: assets/entitlements.mac.plist

dmg:
  title: "${productName} ${version}"
  icon: assets/icon.icns
  background: assets/dmg-background.png
  contents:
    - x: 130
      y: 220
    - x: 410
      y: 220
      type: link
      path: /Applications

# Windows
win:
  icon: assets/icon.ico
  target:
    - target: nsis
      arch: [x64]
  publisherName: OrbitScore
  verifyUpdateCodeSignature: false

nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  createStartMenuShortcut: true

# Linux
linux:
  icon: assets/icon.png
  target:
    - target: AppImage
      arch: [x64]
    - target: deb
      arch: [x64]
  category: Audio
  maintainer: orbitscore@example.com

# 自動更新（オプション）
publish:
  provider: github
  owner: signalcompose
  repo: orbitscore
```

#### 6.2 アイコン・アセット
**作成物**:
- `assets/icon.png` - 512x512 PNGマスター画像
- `assets/icon.icns` - macOS用（iconutil で変換）
- `assets/icon.ico` - Windows用（複数サイズ: 16x16, 32x32, 48x48, 256x256）
- `assets/dmg-background.png` - macOS DMGインストーラー背景

**macOS .icns作成手順**:
```bash
# 1. iconset フォルダ作成
mkdir icon.iconset

# 2. 各サイズのPNG生成
sips -z 16 16     icon.png --out icon.iconset/icon_16x16.png
sips -z 32 32     icon.png --out icon.iconset/icon_16x16@2x.png
sips -z 32 32     icon.png --out icon.iconset/icon_32x32.png
sips -z 64 64     icon.png --out icon.iconset/icon_32x32@2x.png
sips -z 128 128   icon.png --out icon.iconset/icon_128x128.png
sips -z 256 256   icon.png --out icon.iconset/icon_128x128@2x.png
sips -z 256 256   icon.png --out icon.iconset/icon_256x256.png
sips -z 512 512   icon.png --out icon.iconset/icon_256x256@2x.png
sips -z 512 512   icon.png --out icon.iconset/icon_512x512.png
cp icon.png icon.iconset/icon_512x512@2x.png

# 3. .icns変換
iconutil -c icns icon.iconset
```

#### 6.3 自動更新機能（オプション）
**実装内容**: electron-updater統合

```typescript
import { autoUpdater } from 'electron-updater';

// Main Process (main.ts)
app.on('ready', () => {
  // 起動時にアップデートチェック
  autoUpdater.checkForUpdatesAndNotify();
});

autoUpdater.on('update-available', (info) => {
  dialog.showMessageBox({
    type: 'info',
    title: 'Update Available',
    message: `Version ${info.version} is available. Download now?`,
    buttons: ['Yes', 'No']
  }).then((result) => {
    if (result.response === 0) {
      autoUpdater.downloadUpdate();
    }
  });
});

autoUpdater.on('update-downloaded', () => {
  dialog.showMessageBox({
    type: 'info',
    title: 'Update Ready',
    message: 'Update downloaded. Restart now?',
    buttons: ['Restart', 'Later']
  }).then((result) => {
    if (result.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });
});
```

**GitHub Releases連携**:
- `package.json` に `publish` 設定追加
- GitHub Personal Access Token設定
- CI/CD（GitHub Actions）で自動ビルド・リリース

#### 6.4 コード署名（オプション）

**macOS**:
- Apple Developer Program登録 ($99/年)
- Developer ID Application証明書取得
- `electron-builder.yml` に証明書設定

```yaml
mac:
  identity: "Developer ID Application: Your Name (TEAM_ID)"
  hardenedRuntime: true
  entitlements: assets/entitlements.mac.plist
```

**entitlements.mac.plist**:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
</dict>
</plist>
```

**Windows**:
- Code Signing証明書購入（Sectigo, DigiCertなど）
- `electron-builder.yml` に証明書設定

```yaml
win:
  certificateFile: path/to/certificate.pfx
  certificatePassword: ${WINDOWS_CERT_PASSWORD}
```

**注意**: 署名なしでも配布可能だが、macOSではGatekeeperの警告が表示される。

**成果物**:
- **macOS**: `release/OrbitScore-1.0.0.dmg` (Universal: x64 + arm64)
- **Windows**: `release/OrbitScore-Setup-1.0.0.exe`
- **Linux**: `release/OrbitScore-1.0.0.AppImage`

---

### Phase 7: テスト・ドキュメント（推定: 1-2日）

#### 7.1 手動テスト

**テストチェックリスト**:

**macOS**:
- [ ] アプリ起動（dmgからインストール）
- [ ] エンジン起動・停止
- [ ] コード実行（Cmd+Enter）
- [ ] シンタックスハイライト確認
- [ ] IntelliSense動作確認（補完表示）
- [ ] ファイル操作（New, Open, Save, Save As）
- [ ] ドラッグ&ドロップでファイルを開く
- [ ] 設定パネル（オーディオデバイス選択、テーマ変更）
- [ ] ステータスバー表示更新
- [ ] 実行時のフラッシュアニメーション
- [ ] SuperColliderとの統合（音が鳴る）

**Windows** (可能なら):
- [ ] 同上（Ctrl+Enter）

**Linux** (可能なら):
- [ ] 同上

#### 7.2 ドキュメント作成

**ファイル**: `packages/electron-app/README.md`

```markdown
# OrbitScore Electron App

Standalone desktop application for OrbitScore live coding environment.

## Development

### Prerequisites
- Node.js 22+
- SuperCollider (for audio engine)

### Setup
```bash
cd packages/electron-app
npm install
```

### Run Development Mode
```bash
npm run dev
```

### Build
```bash
npm run build
```

### Package for Distribution
```bash
# macOS
npm run dist -- --mac

# Windows
npm run dist -- --win

# Linux
npm run dist -- --linux
```

## Debugging

### Main Process
Use VS Code debugger with the following configuration:

```json
{
  "type": "node",
  "request": "launch",
  "name": "Electron Main",
  "runtimeExecutable": "${workspaceFolder}/node_modules/.bin/electron",
  "args": [".", "--remote-debugging-port=9222"]
}
```

### Renderer Process
1. Start dev mode: `npm run dev`
2. Open DevTools: Cmd+Option+I (macOS) / Ctrl+Shift+I (Windows/Linux)

## Architecture
- **Main Process**: Node.js environment, manages SuperCollider engine
- **Renderer Process**: Chromium, Monaco Editor UI
- **Preload Script**: IPC bridge with contextBridge

## Folder Structure
```
src/
├── main/         # Main process
├── renderer/     # Renderer process (UI)
└── preload/      # Preload script
```
```

**ファイル**: `docs/USER_MANUAL.md` 更新（Electronアプリ版の使い方を追記）

```markdown
## Installation (Electron App)

### macOS
1. Download `OrbitScore-1.0.0.dmg`
2. Open the DMG file
3. Drag OrbitScore to Applications folder
4. Launch OrbitScore from Applications

**Note**: First launch may show "OrbitScore cannot be opened because the developer cannot be verified."
- Right-click → Open → Open again to bypass Gatekeeper.

### Windows
1. Download `OrbitScore-Setup-1.0.0.exe`
2. Run the installer
3. Follow installation wizard
4. Launch from Start Menu

### Linux
1. Download `OrbitScore-1.0.0.AppImage`
2. Make executable: `chmod +x OrbitScore-1.0.0.AppImage`
3. Run: `./OrbitScore-1.0.0.AppImage`

## Basic Usage

### Starting the Engine
1. Launch OrbitScore
2. Click "▶ Start Engine" or press Cmd+Shift+E (macOS) / Ctrl+Shift+E (Windows/Linux)
3. Wait for status bar to show "🟢 Engine: Ready"

### Writing Code
1. Type OrbitScore DSL code in the editor
2. Enjoy syntax highlighting and auto-completion

### Executing Code
1. Select code (or place cursor on a line)
2. Press Cmd+Enter (macOS) / Ctrl+Enter (Windows/Linux)
3. See the line flash to confirm execution

### Keyboard Shortcuts
- **Cmd+Enter** (macOS) / **Ctrl+Enter** (Windows/Linux): Execute selection
- **Cmd+N**: New file
- **Cmd+O**: Open file
- **Cmd+S**: Save file
- **Cmd+Shift+S**: Save As
- **Cmd+F**: Find
- **Cmd+H**: Replace
- **Cmd+Shift+E**: Start Engine
- **Cmd+Shift+S**: Stop Engine
```

**成果物**: リリース可能なアプリケーション + 完全なドキュメント

---

## 📊 総推定工数

| Phase | 内容 | 推定工数 | 難易度 |
|-------|------|---------|--------|
| Phase 1 | プロジェクトセットアップ | 1日 | ⭐ |
| Phase 2 | Main Process実装 | 2-3日 | ⭐⭐ |
| Phase 3 | Monaco Editor統合 | 3-4日 | ⭐⭐⭐ |
| Phase 4 | IPC通信とコード実行 | 2-3日 | ⭐⭐⭐ |
| Phase 5 | 機能拡張 | 2-3日 | ⭐⭐ |
| Phase 6 | パッケージング・配布 | 2-3日 | ⭐⭐ |
| Phase 7 | テスト・ドキュメント | 1-2日 | ⭐ |
| **合計** | | **13-19日** | |

**実作業時間**: 約2.5週間〜4週間（1日4-6時間作業想定）

---

## 🎯 最小限の実装（MVP版）

早期リリースが必要な場合、以下のスコープで **5-7日** に短縮可能：

### 含むもの（MVP）
- ✅ Phase 1: プロジェクトセットアップ
- ✅ Phase 2: Main Process実装（基本機能のみ）
  - エンジン起動・停止・コード実行のみ
- ✅ Phase 3: Monaco Editor統合（シンタックスハイライトのみ）
  - IntelliSense補完は省略
- ✅ Phase 4: IPC通信とコード実行（Cmd+Enter実行のみ）
- ✅ Phase 6: パッケージング（macOSのみ）

### 省略するもの（v1.1以降に延期）
- ❌ ファイル操作メニュー → ドラッグ&ドロップで代用
- ❌ IntelliSense補完 → 手動入力
- ❌ 設定パネル → コンフィグファイル編集で代用
- ❌ クロスプラットフォーム対応 → macOS先行リリース
- ❌ コード署名 → 未署名版として配布

**MVP版のメリット**:
- 開発期間が約60%短縮
- コア機能（ライブコーディング）に集中
- ユーザーフィードバックを早期に取得
- 段階的に機能追加可能

---

## 🔧 技術スタック推奨

### 必須ライブラリ
| ライブラリ | バージョン | 用途 |
|-----------|-----------|------|
| **electron** | ^28.0.0 | アプリケーションフレームワーク |
| **monaco-editor** | ^0.50.0 | コードエディタ |
| **typescript** | ^5.9.0 | 型安全な開発 |

### ビルドツール（どちらか選択）
| ツール | 特徴 | 推奨度 |
|--------|------|--------|
| **electron-vite** | 簡単、高速、Monaco統合が容易 | ⭐⭐⭐⭐⭐ (推奨) |
| **electron-forge** | 柔軟性高、プラグイン豊富 | ⭐⭐⭐⭐ |
| **webpack** | 完全制御可能、学習コスト高 | ⭐⭐⭐ |

**推奨**: electron-vite（理由: Monaco Editorとの統合が簡単、Viteの高速ビルド）

### 補助ライブラリ
| ライブラリ | 用途 | 必須度 |
|-----------|------|--------|
| **electron-store** | 設定の永続化 | 高 |
| **electron-builder** | アプリ配布用パッケージング | 高 |
| **electron-updater** | 自動更新機能 | 中（オプション） |
| **vitest** | テスト（既存） | 低（手動テストで代用可） |

---

## 📦 既存コードの再利用

以下のコードは**ほぼそのまま移植可能**：

### 1. エンジン管理（`extension.ts` → `src/main/engine-manager.ts`）
- `startEngine()` (595-656行) → Main Process
- `stopEngine()` → Main Process
- `killSuperCollider()` → Main Process
- `setupStdoutHandler()`, `setupStderrHandler()`, `setupExitHandler()` → Main Process

**再利用率**: 約80%（VS Code APIを削除するだけ）

### 2. コード実行（`extension.ts` → `src/renderer/execution.ts`）
- `runSelection()` (888-986行) のロジック → Renderer Process
- `evaluateFileInBackground()` → Main Process経由で実行
- `filterDefinitionsOnly()` → Renderer Process

**再利用率**: 約70%（VS Code APIをMonaco APIに置き換え）

### 3. シンタックス定義（`syntaxes/` → `src/renderer/language-orbitscore.ts`）
- `orbitscore-audio.tmLanguage.json` → Monaco Monarch Tokenizerに変換

**変換作業**: TextMate Grammar → Monarch（手動変換、約2-3時間）

### 4. 補完機能（`completion-context.ts` → `src/renderer/completion-provider.ts`）
- `getGlobalCompletions()` → Monaco CompletionProvider
- `getSequenceCompletions()` → Monaco CompletionProvider
- `getTopLevelCompletions()` → Monaco CompletionProvider

**再利用率**: 約60%（VS Code APIをMonaco APIに置き換え）

### 総再利用率: 約60-70%

**新規実装が必要な部分**:
- Electron Main/Renderer/Preload構造
- IPC通信（型定義、ハンドラー）
- Monaco Editor UI（HTML/CSS）
- ファイル操作（ダイアログ）
- 設定パネルUI

---

## ⚠️ 注意点・課題

### 1. SuperColliderのバンドル
**問題**: SuperCollider (scsynth) をアプリに同梱する必要がある

**解決策（macOS）**:
- `scsynth` バイナリをアプリリソースに同梱
- `app.asar.unpacked` に配置（実行権限維持）
- `electron-builder.yml` の `extraResources` で指定

```yaml
extraResources:
  - from: resources/supercollider/scsynth
    to: supercollider/scsynth
```

**解決策（Windows/Linux）**:
- 初期リリースではユーザーに別途インストールを求める
- 将来的にインストーラーでSuperColliderも同梱

**影響**: アプリサイズが約+50MB増加（scsynth + プラグイン）

### 2. Monaco Editorのバンドルサイズ
**問題**: Monaco Editorの全言語サポート版は約5MB

**解決策**:
- `monaco-editor-webpack-plugin` でOrbitScoreのみバンドル
- 不要な言語サポートを除外（JSON, CSS, HTML, TypeScriptのworkerのみ保持）
- カスタムビルド: 約1MB

```typescript
// electron.vite.config.ts
import MonacoWebpackPlugin from 'monaco-editor-webpack-plugin';

export default {
  renderer: {
    plugins: [
      new MonacoWebpackPlugin({
        languages: [], // OrbitScoreのみ（カスタム言語）
        features: ['bracketMatching', 'find', 'folding', 'hover', 'suggest']
      })
    ]
  }
};
```

**影響**: ビルド時間が若干増加（約+30秒）

### 3. コード署名コスト
**macOS**:
- Apple Developer Program: $99/年
- 証明書取得後、`electron-builder` で自動署名

**Windows**:
- Code Signing証明書: $100-400/年（業者により異なる）
- Extended Validation (EV) 証明書推奨（SmartScreen警告回避）

**Linux**:
- 署名不要

**回避策**:
- 初期リリースは署名なしで配布
- macOS: ユーザーに「右クリック → 開く」を案内
- Windows: SmartScreen警告を承知でリリース
- ユーザー数が増えたら署名導入

### 4. クロスプラットフォームテスト
**問題**: Windows/Linuxでの動作確認が困難（開発環境がmacOS想定）

**解決策**:
- **macOS**: メイン開発・テスト環境
- **Windows**: GitHub ActionsでCI/CDビルド + 仮想環境でテスト
- **Linux**: Docker環境でビルドテスト

**CI/CD設定例（GitHub Actions）**:
```yaml
name: Build & Release

on:
  push:
    tags:
      - 'v*'

jobs:
  build:
    strategy:
      matrix:
        os: [macos-latest, windows-latest, ubuntu-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: 22
      - run: npm install
      - run: npm run build
      - run: npm run dist
      - uses: actions/upload-artifact@v3
        with:
          name: ${{ matrix.os }}-build
          path: release/*
```

---

## 🚀 開発開始手順

このプランを実行する場合、以下の手順で開始します：

### 1. Issue作成
```bash
gh issue create \
  --title "Electron + Monaco統合版アプリ開発" \
  --body "$(cat docs/ELECTRON_APP_PLAN.md)" \
  --label "enhancement,electron,high-priority"
```

### 2. ブランチ作成
```bash
git checkout main
git pull origin main
git checkout -b <issue-number>-electron-monaco-app
```

### 3. パッケージ初期化
```bash
cd packages
mkdir electron-app
cd electron-app

# package.json初期化
npm init -y

# 依存関係インストール
npm install --save-dev \
  electron@^28.0.0 \
  electron-vite@^2.0.0 \
  electron-builder@^24.0.0 \
  monaco-editor@^0.50.0 \
  typescript@^5.9.0 \
  electron-store@^8.0.0

# ディレクトリ構造作成
mkdir -p src/{main,renderer,preload}
mkdir -p assets
```

### 4. Phase 1実装開始
```typescript
// src/main/main.ts
import { app, BrowserWindow } from 'electron';

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/preload.js')
    }
  });

  win.loadFile('src/renderer/index.html');
}

app.whenReady().then(createWindow);
```

---

## 🤔 拡張性についての考察

### ユーザーによる機能拡張の可能性

#### オプション1: ソースコード公開 + ビルド環境提供（推奨）
**アプローチ**: "開発したい人はソース落としてVS Codeでやってね"

**メリット**:
- 実装がシンプル（プラグインシステム不要）
- セキュリティリスクが低い
- メンテナンスコストが低い
- TypeScript/Electronの知識があれば拡張可能

**デメリット**:
- ビルド環境の構築が必要（Node.js, Electron, SuperCollider）
- 技術的ハードルが高い（一般ユーザーには困難）
- フォークが乱立する可能性

**適用シーン**:
- 初期リリース（v1.0）
- コミュニティが小規模な間
- 開発者向けツールとして位置づける場合

#### オプション2: プラグインシステム導入
**アプローチ**: ユーザーがJavaScript/TypeScriptでプラグインを作成、アプリに読み込み

**実装例**:
```typescript
// プラグインAPI
interface OrbitScorePlugin {
  name: string;
  version: string;
  activate(api: PluginAPI): void;
  deactivate(): void;
}

interface PluginAPI {
  // エディタ拡張
  editor: {
    registerCommand(id: string, handler: () => void): void;
    registerLanguageFeature(feature: LanguageFeature): void;
  };

  // DSL拡張
  dsl: {
    registerMethod(name: string, handler: (...args: any[]) => void): void;
    registerKeyword(keyword: string): void;
  };

  // UI拡張
  ui: {
    registerPanel(id: string, component: React.Component): void;
    registerStatusBarItem(item: StatusBarItem): void;
  };
}

// プラグイン例（ユーザー作成）
const myPlugin: OrbitScorePlugin = {
  name: 'my-custom-plugin',
  version: '1.0.0',
  activate(api) {
    // カスタムコマンド追加
    api.editor.registerCommand('myPlugin.customAction', () => {
      console.log('Custom action!');
    });

    // カスタムDSLメソッド追加
    api.dsl.registerMethod('myCustomMethod', (arg1, arg2) => {
      // SuperCollider経由で音声処理
    });
  },
  deactivate() {
    // クリーンアップ
  }
};
```

**メリット**:
- 一般ユーザーでも拡張可能（ビルド不要）
- プラグインの配布が容易（npm, GitHub）
- アプリ本体のアップデートと独立

**デメリット**:
- プラグインAPI設計が複雑
- セキュリティリスク（任意コード実行）
- サンドボックス環境の構築が必要
- メンテナンスコストが高い
- 開発工数が大幅に増加（+2-3週間）

**適用シーン**:
- ユーザーコミュニティが成長した後（v2.0以降）
- プロフェッショナルユーザーが多い場合
- 商用ツールとして展開する場合

#### オプション3: スクリプト拡張（軽量版プラグイン）
**アプローチ**: ユーザーがOrbitScore DSLのスーパーセットでスクリプトを書く

**実装例**:
```javascript
// ~/.orbitscore/scripts/my-custom-functions.osc
// ユーザー定義関数（DSL拡張）
function myPattern(seq, n) {
  seq.play(
    (0).chop(2),
    (1).chop(2),
    (n).chop(4)
  );
}

// 使用例
kick.myPattern(3);
```

**メリット**:
- 実装が比較的簡単（パーサー拡張のみ）
- セキュリティリスクが低い（DSLの範囲内）
- ユーザーの学習コストが低い

**デメリット**:
- 拡張範囲が限定的（DSL構文のみ）
- UI拡張はできない
- SuperCollider直接操作はできない

**適用シーン**:
- 中期リリース（v1.5）
- DSLパターンライブラリの共有が活発になった場合

### 推奨アプローチ（段階的実装）

#### v1.0 (初期リリース)
- **拡張方法**: ソースコード公開 + ビルド環境ドキュメント
- **ターゲット**: 開発者、アーリーアダプター
- **理由**: 機能開発に集中、プラグインシステムは見送り

#### v1.5 (中期)
- **拡張方法**: スクリプト拡張（DSLユーザー定義関数）
- **ターゲット**: ライブコーディング経験者
- **理由**: ユーザーからのパターン共有ニーズに応える

#### v2.0 (長期)
- **拡張方法**: プラグインシステム導入
- **ターゲット**: プロフェッショナルユーザー、コミュニティ開発者
- **理由**: エコシステム構築、商用展開の可能性

### 実装判断の基準

**プラグインシステムを導入すべきタイミング**:
- ✅ ユーザー数が100人以上
- ✅ GitHub Issuesで拡張機能のリクエストが月10件以上
- ✅ コミュニティフォーラムが活発
- ✅ 開発チームに2人以上のコントリビューター

**当面見送る判断**:
- ❌ ユーザー数が少ない（<50人）
- ❌ 拡張ニーズが不明確
- ❌ コア機能の開発が優先
- ❌ メンテナンスリソース不足

---

## 📚 関連ドキュメント

- **DSL仕様**: `docs/INSTRUCTION_ORBITSCORE_DSL.md`
- **プロジェクトルール**: `docs/PROJECT_RULES.md`
- **実装計画**: `docs/IMPLEMENTATION_PLAN.md`
- **ユーザーマニュアル**: `docs/USER_MANUAL.md`
- **開発履歴**: `docs/WORK_LOG.md`

---

## 🎯 次のアクション

このプランを実行する場合:

1. **Issue作成**: 上記の「開発開始手順」に従う
2. **技術スタック確定**: electron-vite vs electron-forge を決定
3. **Phase 1開始**: プロジェクトセットアップ（1日）
4. **プロトタイプ作成**: MVP版を5-7日で実装
5. **フィードバック収集**: アーリーアダプターに配布
6. **機能拡張**: Phase 5-7を段階的に実装

---

**このプランに関する質問や提案があれば、Issue/PRで議論してください。**
