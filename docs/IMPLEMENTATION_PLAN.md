# OrbitScore 新DSL 実装計画

## 概要

`INSTRUCTIONS_NEW_DSL.md` の仕様に基づいて、LilyPond に依存しない新しい音楽DSLを実装する。

## 現在の状況

- プロジェクト構造: monorepo (packages/engine, packages/vscode-extension)
- 既存ファイル: ir.ts (IR型定義済み), parser.ts (TODO), scheduler.ts (TODO), midi.ts (TODO)
- デモファイル: examples/demo.osc
- テスト: tests/parser/parser.spec.ts

## プランの使い方

- 作業開始前に必ずこのドキュメントを参照し、該当フェーズ/タスクを確認する。
- 実際の進行と計画がズレた場合は、先にこのプランを更新して現状を反映させてからコーディングする。
- ハンドオフでは「どのフェーズのどの項目を進め、どこまで完了しているか」をこのプランを参照して報告する。

## 実装フェーズ

### Phase 1: パーサ実装 (P0)

**目標**: `parseSourceToIR` の完全実装とdemo.oscのIRスナップショット作成

#### 1.1 パーサ基盤

- [ ] トークナイザー実装
  - キーワード: `key`, `tempo`, `meter`, `randseed`, `sequence`, `bus`, `channel`, `octave`, `octmul`, `bendRange`, `mpe`, `defaultDur`
  - 数値: 整数、小数（3桁まで）
  - 文字列: `"IAC Bus 名"`
  - 括弧: `()`, `{}`
  - 記号: `@`, `%`, `:`, `*`, `^`, `~`, `r`

#### 1.2 グローバル設定パース

- [ ] `key <ROOT>` (C, Db, D, Eb, E, F, Gb, G, Ab, A, Bb, B)
- [ ] `tempo <BPM>` (数値)
- [ ] `meter <N>/<D> <align>` (align = shared | independent)
- [ ] `randseed <INT>` (整数)

#### 1.3 シーケンス設定パース

- [ ] `sequence <name> { ... }` ブロック
- [ ] `bus "<IAC Bus 名>"`
- [ ] `channel <1-16>`
- [ ] `key <ROOT>` (シーケンス固有)
- [ ] `tempo <BPM>` (シーケンス固有)
- [ ] `meter <N>/<D> <align>` (シーケンス固有)
- [ ] `octave <FLOAT>`
- [ ] `octmul <FLOAT>`
- [ ] `bendRange <SEMITONES>`
- [ ] `mpe <true|false>`
- [ ] `defaultDur <DUR>`
- [ ] `randseed <INT>` (シーケンス固有)

#### 1.4 イベントパース

- [ ] 度数: `0..12`
  - 0=休符/無音（rest/silence）
    - **音階に0の概念を導入することが本ソフトウェアの重要な特徴**
    - **音が出ない音価を指定することで休符を表現、他の音と同列に扱う**
    - **無音にも音楽的価値があり、リズムと間を作る重要な要素**
  - 1=C, 2=C#, 3=D, 4=D#, 5=E, 6=F, 7=F#, 8=G, 9=G#, 10=A, 11=A#, 12=B
  - 小数可（微分音はPitchBendで表現）
- [ ] 音価:
  - [ ] 秒: `@2s`
  - [ ] 単位: `@U1.5`
  - [ ] %: `@25%2bars`
  - [ ] 連符: `@[3:2]*U1`
- [ ] 和音: `( ... )` (グループ音価は内部最大)
- [ ] オクターブシフト: `^+1`
- [ ] detune: `~+0.3`
- [ ] ランダム: `1.0r` (randseedで再現性)

#### 1.5 テストとGolden IR

- [ ] parser.spec.ts に全トークン、r、U、%/bars、連符、和音のテスト追加
- [ ] demo.osc のIRスナップショットをJSONファイルとして作成
- [ ] IR型の契約としての凍結確認

### Phase 2: Pitch/Bend変換 (P0)

**目標**: 度数→MIDIノート+PitchBend変換の実装

#### 2.1 度数→半音変換

- [ ] 度数マッピング実装
  - **重要**: 0=休符（無音） - 音楽的価値を持つ無音として他の度数と同等に扱う
  - 1=C, 2=C#, 3=D, 4=D#, 5=E, 6=F, 7=F#, 8=G, 9=G#, 10=A, 11=A#, 12=B
  - キー基準でトランスポーズ（key=GならG=degree 1）
- [ ] 小数度数の処理
- [ ] オクターブシフト適用 (`^+1` など)

#### 2.2 オクターブ・係数・detune合成

- [ ] `octave` 基本オクターブ適用
- [ ] `octmul` オクターブ係数適用
- [ ] `detune` セント/半音単位の微調整

#### 2.3 MIDIノート+PitchBend変換

- [ ] 近傍MIDIノート計算
- [ ] PitchBend値計算 (bendRangeで制御)
- [ ] MPE/チャンネル割り当て

#### 2.4 テスト

- [ ] bendRangeとMPEのテスト追加
- [ ] 各種度数・detune・オクターブシフトのテスト

### Phase 3: スケジューラ + Transport (P0)

**目標**: LookAhead=50ms, Tick=5msでのスケジューリング実装

#### 3.1 スケジューラ基盤

- [ ] LookAhead=50ms, Tick=5msの実装
- [ ] グローバルPlayhead (Bar:Beat) 管理
- [ ] 時間窓でのイベント処理

#### 3.2 メーター対応

- [ ] shared: 全シーケンスが同じ小節線を共有
- [ ] independent: 各シーケンスが自分の小節線で回り込み
- [ ] ポリリズム/ポリメーターの実装

#### 3.3 Transport機能

- [ ] Loop窓 (startBar, endBar, enabled)
- [ ] Jump/Scene/Mute/Solo
- [ ] 小節頭でのQuantized Apply

#### 3.4 MIDI出力

- [ ] NoteOn/Offイベント生成
- [ ] TestMidiSinkでの自動テスト
- [ ] golden event JSONで±5ms検証

#### 3.5 テスト

- [ ] Loop/JumpのQuantized Applyテスト
- [ ] shared/independentの差異テスト
- [ ] 時間精度テスト (±5ms)

### Phase 4: VS Code拡張 (最小実装)

**目標**: 選択範囲実行とTransport UI

#### 4.1 言語サポート

- [ ] 言語: orbitscore (.osc)
- [ ] シンタックスハイライト
- [ ] Diagnostics: パースエラー表示

#### 4.2 コマンド実装

- [ ] `start`: エンジン開始
- [ ] `runSelection`: 選択範囲実行 (一時ファイル経由)
- [ ] `stop`: エンジン停止
- [ ] `transport`: Transport UI

#### 4.3 UI要素

- [ ] StatusBar: Playing | Bar | BPM | Loop | Mode
- [ ] Transport UI (Play/Pause/Stop/Loop設定)

#### 4.4 エンジン連携

- [ ] child_process でengine起動
- [ ] 選択テキストを一時ファイルで渡す
- [ ] エンジンからの状態受信

### Phase 5: MIDI出力実装 (Completed)

**目標**: CoreMIDI経由でのIAC Bus出力

#### 5.1 CoreMIDI実装

- [x] @julusian/midi を使用したIAC Bus接続
- [x] MIDIメッセージ送信
- [x] ポート管理

#### 5.2 テスト

- [x] IAC出力のMIDI Monitor確認 (手動)
- [x] 各種MIDIメッセージのテスト

### Phase 6: Max/MSP Integration (Completed)

**目標**: Max/MSPパッチでの音声出力

#### 6.1 Max/MSP Patch Fixes

- [x] ADSR実装の修正
- [x] 音声出力の動作確認
- [x] UDPテレメトリーの実装

#### 6.2 Integration Testing

- [x] UDPテレメトリー受信テスト
- [x] Max/MSPパッチシミュレーション
- [x] MIDIポート検出テスト

### Phase 7: Live Coding Implementation (Completed)

**目標**: TidalCycles/Scratchスタイルのライブコーディング

#### 7.1 Engine Live Evaluation

- [x] CLIに`live:`コマンドを追加
- [x] `liveEvaluate()`関数を実装
- [x] 既存スケジューラがある場合は`liveUpdate()`を呼び出し

#### 7.2 VS Code Extension Live Coding

- [x] `runSelection()`をライブ評価に変更
- [x] 一時ファイルではなくstdinで直接コードを送信
- [x] Cmd+Enterで即座に実行

### Phase 8: VS Code Extension Live Coding Fixes (Completed)

**目標**: VS Code拡張のライブコーディング機能の修正

#### 8.1 Module Resolution Issues

- [x] 診断機能の無効化（エンジンモジュールの直接読み込みを回避）
- [x] 一時ファイル方式でのコード送信実装
- [x] エンジンのstdin処理で`eval:`コマンドを独立処理

#### 8.2 Debug Infrastructure

- [x] デバッグログの追加
- [x] エラーハンドリングの改善
- [x] Max/MSPでの音声出力確認

### Phase 9: Parameter Implementation and DSL Refactoring

**目標**: 各種パラメータの動作実装とDSLの明示的セクション化

#### 9.1 Parameter Implementation (Priority 1)

- [ ] **key** パラメータの実装
  - [ ] パーサーでのキー設定の解析
  - [ ] PitchConverterでのキーオフセット適用
  - [ ] テスト: 異なるキーでの音程確認

- [ ] **tempo** パラメータの実装
  - [ ] グローバルテンポの適用
  - [ ] シーケンス固有テンポの適用
  - [ ] スケジューラーでのテンポ変更
  - [ ] テスト: テンポ変更での再生速度確認

- [ ] **meter** パラメータの実装
  - [ ] shared/independentメーターの適用
  - [ ] 小節線の計算
  - [ ] テスト: 異なるメーターでの小節線確認

- [ ] **bendRange** パラメータの実装
  - [ ] PitchConverterでのベンドレンジ適用
  - [ ] PitchBend値の計算
  - [ ] テスト: 異なるベンドレンジでの音程確認

- [ ] **octmul** パラメータの実装
  - [ ] オクターブ係数の適用
  - [ ] PitchConverterでの計算
  - [ ] テスト: オクターブ係数での音程確認

- [ ] **defaultDur** パラメータの実装
  - [ ] デフォルト音価の適用
  - [ ] パーサーでの音価補完
  - [ ] テスト: デフォルト音価での音長確認

#### 9.2 DSL Refactoring (Priority 2)

- [ ] **明示的セクション化**
  - [ ] `global` セクションの実装
  - [ ] `sequence` セクションの分離
  - [ ] パーサーの更新
  - [ ] IR型の更新

- [ ] **選択的実行機能**
  - [ ] グローバル設定のみの実行
  - [ ] 選択シーケンス + グローバル設定の実行
  - [ ] VS Code拡張での選択処理

#### 9.3 Testing and Validation

- [ ] 各パラメータの単体テスト
- [ ] パラメータ組み合わせのテスト
- [ ] 明示的セクション化のテスト
- [ ] 選択的実行のテスト

### Phase 10: Transport Integration Enhancement (In Progress)

**目標**: トランスポート統合機能の実装とテスト

#### 10.1 Transport Integration Implementation

- [x] `simulateTransportAdvanceAcrossSequences`メソッドの実装
- [x] 共有/独立メーター混在対応のトランスポート前進
- [x] ジャンプとループの小節境界での適用
- [x] 新しいテストファイルの追加

#### 10.2 Test Coverage

- [x] `tests/scheduler/golden_events_demo.json`: デモ用のMIDIイベントデータ
- [x] `tests/scheduler/transport_integration.spec.ts`: トランスポート統合のテスト
- [x] ジャンプの小節境界での適用テスト
- [x] ループの小節境界での適用テスト
- [x] 共有/独立メーター混在シーケンスでの動作テスト
- [x] リアルタイム再生でのトランスポート統合テスト

### Phase 11: Performance Optimization and Advanced Features

**目標**: パフォーマンス最適化と高度な機能

#### 11.1 Performance Optimization

- [ ] パーサーの最適化
- [ ] スケジューラーの最適化
- [ ] メモリ使用量の最適化

#### 11.2 Advanced Features

- [ ] 高度なトランスポート機能
- [ ] エフェクト処理
- [ ] リアルタイムパラメータ調整

## 実装ルール

- IR型は契約として凍結。破壊的変更は別バージョンで
- 各Phaseは1〜3コミット、必ずテスト追加
- IAC/DAW確認など自動化できない工程は必ず依頼
- **各Phase完了時は必ずWORK_LOG.mdにログを記録すること**
- **各Phase完了時はREADME.mdも更新すること（使い方/進捗/テスト方法）**

## DoD (完了定義)

1. [ ] demo.osc → IRスナップショットが固定される
2. [ ] shared/independent の差異がテストで再現される
3. [ ] PitchBend が detune/小数度数/オクターブ係数で動く
4. [ ] VS Code拡張から cmd+enter で選択実行できる
5. [ ] IAC出力を MIDI Monitor で確認できる（手動）

## 技術スタック

- TypeScript
- VS Code Extension API
- CoreMIDI (@julusian/midi)
- macOS IAC Bus
- 小数第3位精度
- 乱数シードによる再現性

## 注意事項

- 各フェーズは順次実装、前のフェーズが完了してから次へ
- テスト駆動開発を基本とする
- IR型の変更は最小限に留める
- パフォーマンスより正確性を優先
