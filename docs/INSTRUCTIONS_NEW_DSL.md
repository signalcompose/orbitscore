# OrbitScore — 新DSL: 仕様と実装タスクリスト（P0 + Transport）

## 目的

- LilyPond に依存しない **新しい音楽DSL** を設計・実装する。
- エディタで **選択範囲を実行**（TidalCycles風）。
- **グローバル設定**と**シーケンス設定**（優先はシーケンス側）。
- **ポリリズム/ポリメーター**：4/4 と 5/4 の「小節線共有（shared）」と「回り込み（independent）」の両方を表現。
- macOS / IAC Bus / TypeScript / VS Code拡張で動作。
- **小数第3位まで**の精度。任意の数値末尾 `r` は [0, 0.999] を加算（乱数シードで再現性）。

---

## DSL 仕様（v0.1）

### 1) グローバル設定

```
key <ROOT>           # 例: C, Db, D, ...
tempo <BPM>          # 例: 120
meter <N>/<D> <align>  # align = shared | independent
randseed <INT>
```

### 2) シーケンス

```
sequence <name> {
  bus "<IAC Bus 名>"
  channel <1-16>
  key <ROOT>
  tempo <BPM>
  meter <N>/<D> <align>
  octave <FLOAT>
  octmul <FLOAT>
  bendRange <SEMITONES>
  mpe <true|false>
  defaultDur <DUR>
  randseed <INT>

  # イベント列…
}
```

### 3) イベント

- 度数: `0..12`
  - **0 = 休符/無音（rest/silence）**
    - 音階に0の概念を導入することが本ソフトウェアの重要な特徴
    - 音が出ない音価を指定することで休符を表現
    - 無音も他の音と同列に扱われ、音楽的価値を持つ
  - **1 = C（ド）**
  - **2 = C#（ド#）**
  - **3 = D（レ）**
  - **4 = D#（レ#）**
  - **5 = E（ミ）**
  - **6 = F（ファ）**
  - **7 = F#（ファ#）**
  - **8 = G（ソ）**
  - **9 = G#（ソ#）**
  - **10 = A（ラ）**
  - **11 = A#（ラ#）**
  - **12 = B（シ）**
  - 小数可→PitchBendで微分音表現
- 音価:
  - 秒: `@2s`
  - 単位: `@U1.5`
  - %: `@25%2bars`
  - 連符: `@[3:2]*U1`
- 和音: `( … )`、グループ音価は内部最大
- オクターブシフト: `^+1` など
- detune: `~+0.3`
- ランダム: `1.0r`（randseedで再現性）

### 4) メーター

- shared: 小節線共有（ポリリズム）
- independent: 小節線独立（ポリメーター）

### 5) ルーティングと微分

- 各シーケンスで bus + channel を指定
- 微分は PitchBend（bendRangeで制御）、複数同時ならMPE推奨

### 6) 精度

- 小数第3位まで
- r は [0, 0.999]

---

## 実装順序

### 1. パーサ

- `parseSourceToIR`
- IR型は `ir.ts` に固定
- demo.osc を golden IR JSON に

### 2. Pitch/Bend

- degree→半音変換（重要: 0=休符, 1=C, 2=C#, ..., 12=B）
- octave/octmul/detune 合成
- 近傍MIDIノート+PitchBend
- bendRangeで変換
- MPE/Ch割当

### 3. スケジューラ + Transport

- LookAhead=50ms, Tick=5ms
- shared/independent両対応
- Loop/Jumpを小節頭でQuantized Apply
- TestMidiSinkで自動テスト
- golden event JSONで±5ms検証

### 4. VS Code拡張（最小）

- 言語: orbitscore（.osc）
- コマンド: start / runSelection / stop / transport
- runSelectionは選択範囲を一時ファイル経由でエンジンへ
- Diagnostics: パースエラー
- StatusBar: Playing | Bar | BPM | Loop | Mode

---

## テスト

- parser: 全トークン、r、U、%/bars、連符、和音
- scheduler: Loop/Jump のQuantized Apply
- pitch: bendRangeとMPE
- e2e: demo.osc を runSelection して golden event 列を検証

---

## ルール

- IR型は契約として凍結。破壊的変更は別バージョンで。
- 各Phaseは 1〜3コミット、必ずテスト追加。
- IAC/DAW 確認など自動化できない工程は必ず私に依頼すること。
- **各Phase完了時は必ずWORK_LOG.mdにログを記録すること。**
- **各Phase完了時はREADME.mdも更新すること（使い方/進捗/テスト方法）。**

---

## DoD（完了定義）

1. demo.osc → IRスナップショットが固定される
2. shared/independent の差異がテストで再現される
3. PitchBend が detune/小数度数/オクターブ係数で動く
4. VS Code拡張から cmd+enter で選択実行できる
5. IAC出力を MIDI Monitor で確認できる（手動）
