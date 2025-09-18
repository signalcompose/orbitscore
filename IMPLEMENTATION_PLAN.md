# OrbitScore 新DSL 実装計画

## 概要
`INSTRUCTIONS_NEW_DSL.md` の仕様に基づいて、LilyPond に依存しない新しい音楽DSLを実装する。

## 現在の状況
- プロジェクト構造: monorepo (packages/engine, packages/vscode-extension)
- 既存ファイル: ir.ts (IR型定義済み), parser.ts (TODO), scheduler.ts (TODO), midi.ts (TODO)
- デモファイル: examples/demo.osc
- テスト: tests/parser/parser.spec.ts

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
- [ ] 度数: `0..12` (0=休符、1..12=キー基準半音度数、小数可)
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
- [ ] キー基準の度数計算 (C=0, C#=1, D=2, ...)
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

### Phase 5: MIDI出力実装
**目標**: CoreMIDI経由でのIAC Bus出力

#### 5.1 CoreMIDI実装
- [ ] @julusian/midi を使用したIAC Bus接続
- [ ] MIDIメッセージ送信
- [ ] ポート管理

#### 5.2 テスト
- [ ] IAC出力のMIDI Monitor確認 (手動)
- [ ] 各種MIDIメッセージのテスト

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