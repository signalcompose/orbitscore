# OrbitScore DSL 仕様書 v1.0

## 概要

OrbitScoreは、半音階度数システムを基盤とした音楽記述言語（DSL）です。最大の特徴は、**度数0を休符として定義**し、音と無音を同じ体系で扱うことです。これにより、リズムパターンの記述が直感的になり、ポリリズムやポリメーターの表現が容易になります。

## 基本思想

### 度数システム（革新的特徴）

- **度数0 = 休符/無音** - 音楽的価値を持つ無音として定義
- **度数1-12 = 半音階** - C, C#, D, D#, E, F, F#, G, G#, A, A#, B
- 音と無音を同じ体系で扱うことで、シーケンスの記述が統一的に

### 精度とランダム性

- 小数第3位までの精度
- 数値末尾の`r`は[0, 0.999]の範囲でランダム値を加算
- `randseed`による再現可能なランダム性

## 文法仕様

### 1. グローバル設定

ファイル全体に適用される基本設定です。シーケンス内で上書き可能。

```osc
key <ROOT>              # 調性: C, Db, D, Eb, E, F, Gb, G, Ab, A, Bb, B
tempo <BPM>             # テンポ: 整数または小数（例: 120, 132.5）
meter <N>/<D> <align>   # 拍子: N/D形式、align = shared | independent
randseed <INT>          # 乱数シード: 整数値（再現性のため）
```

#### メーターの概念

- **shared**: すべてのシーケンスが同じ小節線を共有（ポリリズム）
- **independent**: 各シーケンスが独立した小節線を持つ（ポリメーター）

### 2. シーケンス定義

個別の楽器パートや音源を定義します。

```osc
sequence <name> {
  # MIDI出力設定
  bus "<IAC Bus名>"      # MIDIバス名（IAC Driver Bus 1など）
  channel <1-16>         # MIDIチャンネル
  
  # 音楽的設定（グローバル設定を上書き）
  key <ROOT>             # このシーケンス固有の調
  tempo <BPM>            # このシーケンス固有のテンポ
  meter <N>/<D> <align>  # このシーケンス固有の拍子
  
  # ピッチ関連
  octave <FLOAT>         # 基本オクターブ（例: 4.0 = 中央C付近）
  octmul <FLOAT>         # 度数間音程係数（1.0=標準12半音）
  bendRange <SEMITONES>  # ピッチベンド範囲（半音単位）
  mpe <true|false>       # MPE（多次元表現）モード
  
  # その他
  defaultDur <DUR>       # デフォルト音価
  randseed <INT>         # シーケンス固有の乱数シード
  
  # イベント列
  <events...>
}
```

### 3. イベント記法

#### 度数表記

```osc
# 基本度数（1-12）
1     # C
2     # C#
3     # D
4     # D#
5     # E
6     # F
7     # F#
8     # G
9     # G#
10    # A
11    # A#
12    # B
0     # 休符（無音）

# 小数度数（微分音）
1.5   # CとC#の中間（ピッチベンドで表現）
3.25  # Dより1/4半音高い

# ランダム
1.0r  # 1.0 + [0, 0.999]のランダム値
```

#### 音価（Duration）記法

```osc
# 秒単位
@2s        # 2秒
@0.5s      # 0.5秒

# 単位（Unit）- 拍子の分母を1とする
@U1        # 4/4拍子なら四分音符
@U0.5      # 八分音符
@U2        # 二分音符
@U1.5      # 付点四分音符

# パーセンテージ
@25%2bars  # 2小節の25%
@50%1bar   # 1小節の50%

# 連符
@[3:2]*U1  # 3連符（U1の時間に3つ）
@[5:4]*U2  # 5連符（U2の時間に5つ）
```

#### 修飾子

```osc
# オクターブシフト
3^+1       # 度数3を1オクターブ上げる
5^-2       # 度数5を2オクターブ下げる

# デチューン（微調整）
3~+0.5     # 度数3を0.5半音上げる
7~-0.25    # 度数7を0.25半音下げる

# 組み合わせ
3^+1~-0.2  # 1オクターブ上げて0.2半音下げる
```

#### 和音記法

```osc
# 基本和音（同時発音）
(1, 5, 8)           # C, E, Gの和音

# 異なる音価を持つ和音
(1@U1, 5@U0.5, 8@U2)  # 各音が異なる長さ

# 修飾子付き和音
(1^+1, 5~+0.3, 8)  # 各音に異なる修飾
```

## サンプルコード集

### 例1: 基本的なメロディー

```osc
# シンプルなCメジャースケール
key C
tempo 120
meter 4/4 shared

sequence melody {
  bus "IAC Driver Bus 1"
  channel 1
  octave 4
  defaultDur @U1
  
  # ドレミファソラシド
  1 3 5 6 8 10 12 1^+1
  
  # 下降
  1^+1 12 10 8 6 5 3 1
}
```

### 例2: リズムパターン（休符を活用）

```osc
key C
tempo 140
meter 4/4 shared

sequence drums {
  bus "IAC Driver Bus 1"
  channel 10  # ドラムチャンネル
  octave 3
  
  # キック・スネア・休符のパターン
  1@U0.5 0@U0.5 5@U0.5 0@U0.5
  1@U0.25 1@U0.25 5@U0.5 0@U1
}
```

### 例3: ポリリズム（shared meter）

```osc
key G
tempo 120
meter 4/4 shared  # 全シーケンスが小節線を共有

sequence bass {
  bus "IAC Driver Bus 1"
  channel 1
  octave 2
  
  # 4拍パターン
  1@U1 1@U1 5@U1 5@U1
}

sequence melody {
  bus "IAC Driver Bus 1"
  channel 2
  octave 4
  
  # 3拍パターン（4/4の中で）
  1@U1.333 3@U1.333 5@U1.334
}
```

### 例4: ポリメーター（independent meter）

```osc
key F
tempo 108
meter 4/4 shared

sequence piano {
  bus "IAC Driver Bus 1"
  channel 1
  meter 5/4 independent  # 独立した5/4拍子
  octave 4
  
  # 5拍のパターンが独立して回る
  1@U1 3@U1 5@U1 8@U1 10@U1
}

sequence bass {
  bus "IAC Driver Bus 1"
  channel 2
  meter 3/4 independent  # 独立した3/4拍子
  octave 2
  
  # 3拍のパターン
  1@U1 5@U1 8@U1
}
```

### 例5: 和音とアルペジオ

```osc
key Eb
tempo 90
meter 6/8 shared

sequence harmony {
  bus "IAC Driver Bus 1"
  channel 1
  octave 4
  
  # 和音進行
  (1, 5, 8)@U3          # Ebメジャー
  (6, 10, 1^+1)@U3      # Abメジャー
  (8, 12, 3^+1)@U3      # Bbメジャー
  (1, 5, 8)@U3          # Ebメジャー
}

sequence arpeggio {
  bus "IAC Driver Bus 1"
  channel 2
  octave 5
  
  # アルペジオ（分散和音）
  1@U0.5 5@U0.5 8@U0.5
  8@U0.5 5@U0.5 1@U0.5
}
```

### 例6: 微分音とピッチベンド

```osc
key C
tempo 60
meter 4/4 shared

sequence microtonal {
  bus "IAC Driver Bus 1"
  channel 1
  octave 4
  bendRange 2  # ±2半音のベンド範囲
  
  # 微分音のメロディー
  1      # C
  1.5    # C + 1/4音
  2      # C#
  2.5    # D - 1/4音
  3      # D
  
  # デチューンを使った効果
  5~+0.15  # Eより少し高く
  5        # E
  5~-0.15  # Eより少し低く
}
```

### 例7: ランダム要素

```osc
key A
tempo 150
meter 4/4 shared
randseed 12345  # 再現可能なランダム

sequence random_melody {
  bus "IAC Driver Bus 1"
  channel 1
  octave 4
  
  # ランダムな変化を含むメロディー
  1@U1
  3.0r@U1    # 3 + [0, 0.999]のランダム
  5@U1
  8.0r@U1    # 8 + [0, 0.999]のランダム
  
  # ランダムな音価
  10@U1r     # U1 + ランダム
}
```

### 例8: 連符の使用

```osc
key D
tempo 100
meter 4/4 shared

sequence tuplets {
  bus "IAC Driver Bus 1"
  channel 1
  octave 4
  
  # 通常の8分音符
  1@U0.5 3@U0.5 5@U0.5 8@U0.5
  
  # 3連符（2拍に3つの音）
  1@[3:2]*U1 3@[3:2]*U1 5@[3:2]*U1
  
  # 5連符（1拍に5つの音）
  1@[5:4]*U1 2@[5:4]*U1 3@[5:4]*U1 4@[5:4]*U1 5@[5:4]*U1
}
```

### 例9: octmulによる音程システムの変更

```osc
key C
tempo 120
meter 4/4 shared

sequence normal {
  bus "IAC Driver Bus 1"
  channel 1
  octave 4
  octmul 1.0  # 標準12半音システム
  
  1 2 3 4 5  # C, C#, D, D#, E
}

sequence compressed {
  bus "IAC Driver Bus 1"
  channel 2
  octave 4
  octmul 0.5  # 6半音に圧縮
  
  1 2 3 4 5  # より狭い音程で進行
}

sequence expanded {
  bus "IAC Driver Bus 1"
  channel 3
  octave 4
  octmul 2.0  # 24半音に拡張
  
  1 2 3 4 5  # より広い音程で進行
}
```

### 例10: 複雑な楽曲構造

```osc
# グローバル設定
key Bb
tempo 96
meter 4/4 shared
randseed 808

# ベースライン
sequence bass {
  bus "IAC Driver Bus 1"
  channel 1
  octave 2
  defaultDur @U1
  
  # 4小節のループパターン
  1 0 1 0  5 0 5 0  # 小節1-2
  6 0 6 0  5 0 3 0  # 小節3-4
}

# コード進行
sequence chords {
  bus "IAC Driver Bus 1"  
  channel 2
  octave 4
  
  # Bb - Eb - F - Bb
  (1, 5, 8)@U4           # Bb
  (6, 10, 1^+1)@U4       # Eb
  (8, 12, 3^+1)@U4       # F
  (1, 5, 8)@U4           # Bb
}

# メロディーライン
sequence lead {
  bus "IAC Driver Bus 1"
  channel 3
  octave 5
  
  # メロディーフレーズ
  0@U1 8@U0.5 10@U0.5 12@U1 10@U1
  8@U2 0@U1 5@U1
  6@U0.5 8@U0.5 5@U1 3@U1 1@U1
  0@U2 0@U2
}

# パーカッション的要素
sequence percussion {
  bus "IAC Driver Bus 1"
  channel 10
  meter 3/4 independent  # 独立した3/4でポリメーター
  octave 3
  
  # 3拍子のパターン
  1@U0.333 1@U0.333 1@U0.334
  0@U0.5 5@U0.5
  1@U0.5 0@U0.5
}
```

## パラメータリファレンス

### グローバルパラメータ

| パラメータ | 値の範囲 | デフォルト | 説明 |
|----------|---------|-----------|------|
| key | C, C#/Db, D, D#/Eb, E, F, F#/Gb, G, G#/Ab, A, A#/Bb, B | C | 調性 |
| tempo | 1-999 | 120 | BPM（1分あたりの拍数） |
| meter | N/D shared\|independent | 4/4 shared | 拍子とメーター共有設定 |
| randseed | 整数 | 0 | ランダム生成のシード値 |

### シーケンスパラメータ

| パラメータ | 値の範囲 | デフォルト | 説明 |
|----------|---------|-----------|------|
| bus | 文字列 | なし | MIDI出力先（IAC Bus名） |
| channel | 1-16 | 1 | MIDIチャンネル |
| octave | 0.0-10.0 | 4.0 | 基本オクターブ |
| octmul | 0.1-10.0 | 1.0 | 度数間音程係数 |
| bendRange | 1-24 | 2 | ピッチベンド範囲（半音単位） |
| mpe | true/false | false | MPEモード |
| defaultDur | 音価記法 | @U1 | デフォルト音価 |

## 実装状況と制約

### 実装済み機能

- ✅ 基本的なパーサー
- ✅ 度数システム（0=休符、1-12=半音階）
- ✅ 音価記法（秒、単位、パーセント、連符）
- ✅ 和音記法
- ✅ オクターブシフトとデチューン
- ✅ Pitch/Bend変換
- ✅ スケジューラー（shared/independent）
- ✅ MIDI出力（CoreMIDI）
- ✅ VS Code拡張（シンタックスハイライト、実行）
- ✅ ライブコーディング機能

### 未実装機能

- ⏳ keyパラメータの実際の適用
- ⏳ tempoパラメータの動的変更
- ⏳ defaultDurの適用
- ⏳ シーケンスループ再生
- ⏳ DJライクな制御（.stop, .mute, .unmute）

### 制約事項

1. **MIDI制約**: 微分音は1チャンネルに1音のみ（MPE推奨）
2. **精度**: 小数第3位まで
3. **プラットフォーム**: macOS専用（CoreMIDI使用）
4. **出力**: IAC Bus経由のMIDIのみ（音源は含まない）

## 今後の拡張予定

### フェーズ11: シーケンス制御
- シーケンスごとのループ再生
- `.stop`, `.mute`, `.unmute`コマンド
- グローバル/シーケンス設定の分離実行

### フェーズ12: パラメータ完全実装
- すべてのパラメータの動作実装
- パラメータデバッグ機能
- リアルタイムパラメータ変更

### フェーズ13: VS Code拡張強化
- リアルタイム構文チェック
- オートコンプリート
- パラメータヒント表示

### フェーズ14: 高度な機能
- エフェクト記述
- MIDI CC自動化
- OSC出力サポート
- 複数ファイルのインポート/インクルード

## まとめ

OrbitScore DSLは、**度数0を休符として定義**することで、音と無音を統一的に扱える革新的な音楽記述言語です。ポリリズムやポリメーター、微分音、ライブコーディングなど、現代的な音楽制作に必要な機能を備えています。

シンプルな記法で複雑な音楽構造を表現でき、VS Code拡張によって快適な制作環境を提供します。今後も継続的に機能拡張を行い、より表現力豊かな音楽制作ツールを目指します。