# Rust サウンドエンジン移行計画

**ステータス**: 構想段階（R&D Issue 候補）
**最終更新**: 2026-04-17
**関連 Issue**: TBD（Rust 移行研究 Issue を別途作成予定）

---

## 1. 背景と動機

現在の OrbitScore は SuperCollider（`supercolliderjs`）をサウンドエンジンとして利用している。
この構成には以下の課題がある:

| 課題 | 内容 |
|---|---|
| メンテナンス性 | `supercolliderjs` の脆弱性（Dependabot 警告）、依存関係のパッチ運用 |
| パッケージサイズ | VS Code 拡張の `.vsix` が 3.3 MB（ランタイム同梱のため） |
| プラットフォーム制約 | デスクトップ限定、Web 展開不可 |
| 拡張性 | VST3/CLAP 等の商用プラグインホスティング不可 |
| ライセンス | SC のライセンス体系が商用配布と相性が悪い |

同時に、以下の戦略目標が浮上している:

- 商用プロダクト化（Steam / App Store / Gumroad 販売）
- Web 版デモによるユーザー獲得
- VST3/CLAP プラグインホスティング（DAW 統合、外部音源利用）
- LLM エージェント統合

これらの目標を同時に実現するため、**サウンドエンジンを Rust で再実装**し、**デーモン型アーキテクチャ**へ移行する計画を立てる。

---

## 2. 全体ロードマップ

### Phase 0: 脆弱性対応（即座）

```
・npm audit fix（非force）で SC 以外の脆弱性を解消
・SC 関連の脆弱性は実質リスクが低く、将来的に置き換えるため手を出さない
・Issue #73（リリース自動化）を完遂
```

### Phase 1: 技術検証 R&D（1〜2ヶ月）

```
・Rust + Tauri の技術検証 Spike
  └─ 「WAV 再生 + スケジューリング + cpal 出力」の PoC
・タイムストレッチ方式の比較検証
  └─ SoundTouch / Rubato / 独自 Phase Vocoder
・DSL-to-Engine 通信プロトコルの設計
  └─ WebSocket + JSON-RPC または MCP ライク
```

### Phase 2: Rust エンジン本実装（3〜6ヶ月）

```
・Rust エンジン本実装（デーモン構造）
・VS Code 拡張を「エンジンクライアント」として書き換え
・既存テストスイート（220 tests）の移植
・機能パリティ達成
  └─ WAV/AIFF/MP3/MP4 デコード (symphonia)
  └─ タイムストレッチ (SoundTouch 等)
  └─ ポリメーター対応スケジューラ
  └─ ゲイン・パン・ループ再生
```

### Phase 3: スタンドアローンアプリ化（2〜3ヶ月）

```
・Tauri ベースのスタンドアローンアプリ開発
・CodeMirror 6 エディタウィジェット組み込み
・インストーラ（macOS DMG, Windows MSI, Linux AppImage）
・v2.0 リリース
```

### Phase 4: プラグイン拡張（6〜12ヶ月、段階リリース）

```
v2.1: MIDI 出力（midir 経由、1〜2ヶ月）
v2.2: CLAP ホスティング（clack-host、2〜3ヶ月）
v2.3: VST3 ホスティング（vst3-sys、3〜4ヶ月）
v3.0: Web 版（WAM: Web Audio Modules 対応）
```

---

## 3. アーキテクチャ再フレーミング: Engine-as-a-Service

「VS Code 拡張 vs スタンドアローン」という二択ではなく、**エンジンをデーモン化して複数フロントを持つ**構造に統合する。

```
                    ┌───────────────────────────────┐
                    │ orbitscore-engine (Rust バイナリ)│
                    │ ・DSL Interpreter              │
                    │ ・Audio I/O (cpal)            │
                    │ ・Plugin Host (VST3/CLAP)     │
                    │ ・Scheduler                    │
                    │ ・WebSocket/gRPC API           │
                    │ ・スタンドアロン実行 OK         │
                    └───────────────┬───────────────┘
                                    │ IPC (LSP-like protocol)
            ┌───────────┬───────────┼───────────┬──────────┐
            ▼           ▼           ▼           ▼          ▼
       ┌────────┐  ┌────────┐  ┌────────┐ ┌────────┐ ┌────────┐
       │ VS Code│  │ Tauri  │  │ Web    │ │ CLI    │ │ LLM    │
       │ Ext    │  │ Standa-│  │ Editor │ │ Tool   │ │ Agent  │
       │ (TS薄) │  │ lone   │  │ (将来) │ │        │ │ (MCP等)│
       └────────┘  └────────┘  └────────┘ └────────┘ └────────┘
```

### この構造のメリット

| 項目 | 効果 |
|---|---|
| **VS Code 拡張を残せる** | 既存ユーザー・開発者向け UX を維持 |
| **スタンドアローンも実現** | Tauri で 5〜10MB の軽量ネイティブアプリ |
| **LLM 統合が自然** | MCP サーバーやエージェント API を直接実装可能 |
| **プラグインホストが安定** | VS Code プロセスと分離 → クラッシュ隔離 |
| **ファイルサイズ解決** | 拡張は数百 KB、エンジンは別プロセス |
| **Web 版への道** | 同じ API を WebSocket で Web 版フロントに |
| **単一コードベース** | Rust コアを全フロントで共有 |

### 実装スタック推奨

| レイヤー | 技術 | 理由 |
|---|---|---|
| Engine Core | Rust | 性能、安全性、DSP 適性 |
| Engine API | WebSocket + JSON-RPC / MCP | LLM 統合と相性、デバッグ容易 |
| Standalone Shell | Tauri | Rust 直結、軽量、クロスプラットフォーム |
| Editor Widget | CodeMirror 6 | 軽量、カスタマイズ容易 |
| VS Code Ext | TypeScript（薄く） | LSP 的にエンジンと通信するだけ |
| インストーラ | `cargo-bundle` + GitHub Actions | DMG / MSI / AppImage |

---

## 4. 重要な技術判断

### 4.1 タイムストレッチ実装（最大のライセンス・技術リスク）

| 選択肢 | 品質 | ライセンス | 商用利用 | 実装工数 |
|---|---|---|---|---|
| Rubber Band (GPL/商用) | ★★★★★ | GPL or 商用（有料） | 要ライセンス | 小（FFI） |
| **SoundTouch (LGPL)** | ★★★★ | LGPL-2.1 | 動的リンクで OK | 小（FFI） |
| Rubato (Rust) | ★★★ | MIT | ◎ | 中 |
| 独自 Phase Vocoder | 調整次第 | 自由 | ◎ | 大 |

**推奨**: **SoundTouch** で開始。将来の差別化要因として独自実装を検討。
Rubber Band の商用ライセンスは数千ドル単位で、OSS 戦略と相性が悪い。

### 4.2 Rust 実装の現実的スコープ

OrbitScore が SC に依存している機能は**限定的**:

```
必須（絶対移植）:
├── WAV/AIFF/MP3/MP4 デコード (symphonia で解決)
├── サンプル再生 + リング出力
├── タイムストレッチ (SoundTouch/独自)
├── ゲイン・パン
└── ポリメーター対応のスケジューラ

任意（後回し可）:
├── リバーブ/ディレイ等の FX
├── 合成シンセ
└── 高度なルーティング
```

**12〜18 週の実装ボリューム**で現状機能パリティに到達できる見込み。

### 4.3 VST3/CLAP ホスティング

| 用途 | Rust crate | 備考 |
|---|---|---|
| VST3 ホスト | `vst3-sys`, `nih-plug` | `vst3-sys`: 低レベルバインディング、`nih-plug`: 高レベルホスト/プラグインフレームワーク |
| CLAP ホスト | `clack-host` | CLAP は Rust 親和性が高い |
| LV2 ホスト | `lv2-host` (Linux 中心) | Linux ユーザー向け |
| オーディオ I/O | `cpal` | クロスプラットフォーム |
| MIDI ルーティング | `midir`, `coremidi` | デバイス・プラグイン間 |

**実装順序の推奨**: MIDI → CLAP → VST3 → LV2
（CLAP は API がクリーンなため、VST3 より先に設計パターンを固めやすい）

### 4.4 DSL 拡張イメージ

```
# MIDI
sequence.midi([C4, E4, G4])
  .device("Ableton via IAC")
  .channel(1)
  .cc(74, 0.8)

# プラグイン (CLAP/VST3)
sequence.plugin("Diva.clap")
  .preset("Analog Lead 3")
  .midi([C4, E4, G4])
  .param("filter_cutoff", 0.7)
  .automate("filter_cutoff", 0.3, 1.0, beats=8)

# サイドチェイン・ルーティング
kick.send_to(reverb, 0.5)
bass.sidechain(kick, threshold=-20)
```

---

## 5. 戦略的意義

### 5.1 競合との差別化

| 言語 | プラグインホスト | シンセ |
|---|---|---|
| TidalCycles | ❌（SuperDirt 経由、VST 非対応） | SC のみ |
| Sonic Pi | ❌ | SC のみ |
| Strudel | ❌ | WebAudio のみ |
| **OrbitScore (将来)** | ✅ **VST3/CLAP/LV2** | Rust + 外部プラグイン |

**「ライブコーディングで Serum や Kontakt を叩く」は現時点で事実上空白地帯**。

### 5.2 商業展開パス

```
[現在]                    [将来]
OrbitScore (VS Code)  →   OrbitScore (Rust core)
                          ├─ VS Code Extension (無料 OSS)
                          ├─ Web Editor (無料 Try)
                          ├─ Standalone App (Steam/App Store 販売)
                          ├─ DAW Plugin (VST3/CLAP 有料)
                          └─ Mobile (iOS/Android 将来)
```

Signal compose Source-Available License により:
- ソースコードは公開（コミュニティ成長）
- 販売される完成品は別 EULA（収益源）
- 大規模商用利用は別途商用ライセンス要求

---

## 6. 重要な意思決定ポイント

これから決めるべき戦略変数:

### 6.1 ビジネス方針

- [ ] 商用化の具体的時期（v2.0 / v3.0 / それ以降）
- [ ] 価格設定（Steam 販売価格、App Store 価格、商用ライセンス料金）
- [ ] モネタイゼーションモデル（買い切り / メジャーアップデート料金）

### 6.2 ターゲットユーザー

- [ ] musician-coder（主に音楽家）向け: スタンドアローン優先
- [ ] coder-musician（主にプログラマ）向け: VS Code 拡張優先
- [ ] 両方同時対応（デーモン構造で可能）

### 6.3 チーム体制

- [ ] Rust + リアルタイム DSP 経験者の確保
  - 採用 / 外部委託 / 自学（大和・森田・大石・池田）
- [ ] 工数見積もりとタイムライン確定

### 6.4 予算

- [ ] Rubber Band 商用ライセンス（数万〜数十万円）投資可否
- [ ] VST3 SDK 利用条件確認
- [ ] Apple Developer Program、Steam Publisher Fee 等の初期費用

---

## 7. 次のアクション

### 完了済み

- ✅ Dependabot 警告の安全な修正（Phase 0）— PR #90 (2026-04-17)
- ✅ Research Issue 群の作成（下記）
- ✅ ライセンス切り替え（MIT → Signal compose Source-Available License v1.0）— PR #88

### 進行中 / 次に取り組む

- [ ] Issue #73: リリース自動化（エンドユーザー向け `.vsix` ワークフロー）

### Research / Design Issues（Phase 1）

- [ ] Issue #91: [spike: Rust audio engine proof of concept](https://github.com/signalcompose/orbitscore/issues/91)
- [ ] Issue #92: [research: time-stretch DSP library selection for Rust engine](https://github.com/signalcompose/orbitscore/issues/92)
- [ ] Issue #93: [design: engine daemon IPC protocol (WebSocket + JSON-RPC)](https://github.com/signalcompose/orbitscore/issues/93)
- [ ] Issue #94: [design: Tauri standalone application architecture](https://github.com/signalcompose/orbitscore/issues/94)
- [ ] Issue #95: [research: VST3 and CLAP plugin hosting in Rust](https://github.com/signalcompose/orbitscore/issues/95)
- [ ] Issue #96: [design: LLM agent integration architecture](https://github.com/signalcompose/orbitscore/issues/96)

### 組織タスク

- [ ] チーム合意形成（Signal compose ミーティングで議論）
- [ ] Rust + リアルタイム DSP 経験者の確保（採用 / 外部委託 / 自学）
- [ ] `license@signalcompose.com` メールアドレスのセットアップ（Google Workspace エイリアス等）

---

## 8. 参考リンク

- Rust Audio エコシステム:
  - `symphonia` (audio decoding): https://github.com/pdeljanov/Symphonia
  - `cpal` (cross-platform audio I/O): https://github.com/RustAudio/cpal
  - `rubato` (resampling): https://github.com/HEnquist/rubato
  - `fundsp` (functional DSP): https://github.com/SamiPerttu/fundsp
- プラグインホスティング:
  - `clack` (CLAP bindings): https://github.com/prokopyl/clack
  - VST3 SDK: https://steinbergmedia.github.io/vst3_doc/
- Tauri: https://tauri.app/
- Web Audio Modules (WAM): https://www.w3.org/community/webaudiomodules/

---

**このロードマップは構想段階であり、実装に着手する前にチーム合意形成が必要。**
