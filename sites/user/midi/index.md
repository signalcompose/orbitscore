---
title: MIDI 出力
description: OrbitScore から IAC 経由で MIDI を送る方法と、基本的なシーケンスの作り方を説明します
---

# MIDI 出力

OrbitScore 2.0.0 では、IAC Bus 経由で MIDI を送ることができます。シンセやソフトウェア音源に音程・ベロシティ・アーティキュレーションを付けて演奏させることが、OrbitScore の DSL から直接できます。

## IAC の準備

1. **Audio MIDI Setup** を開く（Launchpad → その他 → Audio MIDI Setup）
2. 上メニューの「ウインドウ」→「MIDI スタジオ」を選ぶ
3. 「IAC ドライバ」をダブルクリックして「デバイスはオンラインです」にチェックを入れる
4. MIDI を受信したい DAW（Ableton Live など）で、IAC ドライバのポートを MIDI 入力に設定する

---

## シーケンスを MIDI に切り替える

`seq.midi()` を呼ぶと、そのシーケンスは MIDI シーケンスになります。`play()` に書く数値はスライス番号ではなく **度数（degree）** として解釈されます。

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.key("C")    // トニック（根音）を C に設定
global.start()

var piano = init global.seq
piano.midi("IAC", 1)   // IAC Bus のポート名に "IAC" を含むポート、ch 1 へ送信
piano.octave(4)        // 度数 1 = C4（MIDI 60）
piano.vel(96)          // デフォルト ベロシティ（1〜127）
piano.gate(0.8)        // デフォルト ゲート比（0.8 = 1スロットの 80% 分の長さで発音）
piano.length(1)
piano.play(1, 3, 5, 8)  // C E G C(+1 oct)

LOOP(piano)
```

この例では C メジャースケールの 1・3・5 度と 8 度（1 度のオクターブ上）が鳴ります。

::: info audio() との違い
`seq.midi()` を宣言したシーケンスは MIDI シーケンスになります。同じシーケンスで `audio()` と `midi()` の両方は使えません。ただし MIDI シーケンスとオーディオシーケンスを**別々の変数**で並走させることは問題ありません。
:::

### ポート名の指定

`midi(portName, channel)` の第 1 引数は、CoreMIDI の出力ポート名を**部分一致**で探します。

- `"IAC"` → ポート名に "IAC" を含む最初のポートに接続します
- 一致するポートが複数ある場合は最初の 1 つを使い、警告を表示します
- 一致しない場合はエラーになり、利用可能なポート名の一覧が表示されます

---

## 基本的なパラメーター

### octave() — 基準オクターブ

`seq.octave(N)` で「度数 1 が属するオクターブ」を設定します。デフォルトは `4`（C4 = MIDI 60）。

```text
piano.octave(4)   // 度数 1 = C4 (デフォルト)
piano.octave(3)   // 度数 1 = C3（1 オクターブ低い）
```

### vel() — ベロシティ

`seq.vel(N)` でシーケンス全体のデフォルトベロシティを設定します（1〜127、デフォルト 96）。

```text
piano.vel(80)    // やや抑えた音量
piano.vel(110)   // 強め
```

### gate() — ゲート比

`seq.gate(N)` で発音する時間の割合を設定します（デフォルト 0.8、0〜1 にクランプ）。

| 値 | 聴こえ方 |
|---|---|
| `0.3` | スタッカート（短く切れる） |
| `0.8` | 標準（デフォルト） |
| `1.0` | 各スロットぴったりまで発音（上限） |

::: info 音を重ねたいとき
`gate` は 0〜1 にクランプされるため、`gate(1.2)` のように 1 を超える値は `1.0` になります。次の音と重ねたい（レガート）ときは `{ }` レガートグループを使ってください（[ピッチ DSL](./pitch-dsl.md) 参照）。
:::

---

## global.key() — トニックの設定

> ⚠️ **2.0.0 時点の仕様 — post-2.0 で見直し予定**
>
> `global.key()` / `seq.root()` などの root/key 系インターフェースは、2.0.0 リリース後に設計が見直される予定です。2.0.0 での動作は本ページに記載のとおりです。

`global.key("C")` でファイル全体のトニック（根音の音名）を設定します。これが MIDI シーケンスで数値の度数を解決する基準になります。

```text
global.key("C")     // C を根音とする
global.key("D")     // D を根音とする
global.key("F#")    // F# を根音とする
global.key("D3")    // D をトニックとし、度数 1 が D3 になるよう基準オクターブを指定
```

`global.key("D3")` のようにオクターブ番号を付けると、どのオクターブが「根音の基準」かを 1 か所で管理できます（個々のシーケンスの `seq.octave()` でさらに上書きできます）。

---

## global.midiLatency() — MIDI 遅延補正

SuperCollider のオーディオ出力と MIDI 出力のタイミングを耳で合わせるための固定オフセットです。

```text
global.midiLatency(20)  // 20 ms のオフセットを加えて MIDI を送信（デフォルト 0）
```

---

## 完全な例

```text
var global = init GLOBAL
global.tempo(100)
global.beat(4 by 4)
global.key("C")
global.start()

var piano = init global.seq
piano.midi("IAC", 1)
piano.octave(4)
piano.vel(90)
piano.gate(0.7)
piano.length(2)
piano.play(
  1, 0, 3, 0,   // 1 小節目: ド・休・ミ・休
  5, 0, 8, 0,   // 2 小節目: ソ・休・ド(+1)・休
)

LOOP(piano)
```

---

## 次のページ

- 度数記法の詳細や音符のレジスター、コードの書き方 → [ピッチ DSL（度数・コード）](./pitch-dsl.md)
- モードやスケールの指定 → [モードとスケール](./mode-scale.md)
- Ableton Live への音声出力 → [LinkAudio](./link-audio.md)
