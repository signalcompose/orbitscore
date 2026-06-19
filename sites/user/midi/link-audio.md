---
title: LinkAudio（Ableton Live への音声出力）
description: global.linkAudio() と seq.output() を使って OrbitScore の音を Ableton Live へ直接送る方法を説明します
---

# LinkAudio（Ableton Live への音声出力）

OrbitScore 2.0.0 では、**LinkAudio** を使って音声を Ableton Live へ直接送ることができます。IAC 経由の MIDI と異なり、オーディオ信号をそのまま LAN 上でストリームします。

## 前提条件

- **macOS** のみ対応
- **Ableton Live 12.4 以降**が起動していること
- **OrbitLinkAudio.scx** プラグインがインストール済みであること
- Live のセッション SR を OrbitScore の設定に合わせること（既定: 48000 Hz）

---

## 基本的な使い方

`.orbs` ファイルの最初に `global.linkAudio()` を一度宣言します。これで以降の**すべてのオーディオシーケンス**が LinkAudio 経由で出力されます。

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.linkAudio()     // LinkAudio モードを有効化
global.start()

var kick = init global.seq
kick.audio("../audio/kick.wav").output("kick")
kick.play(1, 0, 1, 0)

var snare = init global.seq
snare.audio("../audio/snare.wav").output("snare")
snare.play(0, 1, 0, 1)

LOOP(kick, snare)
```

Live 側では:
1. オーディオトラックの「Audio From」で OrbitScore の `"kick"` / `"snare"` を選択
2. モニタリングを有効にして再生

::: warning LinkAudio と通常オーディオは混在不可
`global.linkAudio()` を宣言したファイルでは、すべてのオーディオシーケンスが LinkAudio 経由になります。同じファイルでハードウェア出力と LinkAudio を混在させることはできません。

ただし **MIDI シーケンス**（`seq.midi()` を使ったもの）は LinkAudio の制約外です。`global.linkAudio()` が宣言されていても、MIDI シーケンスは IAC へそのまま送られます。
:::

---

## seq.output() — チャンネル名の指定

`seq.output("name")` で、Live 側での受信チャンネル名を指定します。

```text
kick.audio("kick.wav").output("kick")      // Live で "kick" として受信
snare.audio("snare.wav").output("snare")   // Live で "snare" として受信
```

`output()` を指定しないオーディオシーケンスは `global.linkAudio()` 宣言中にランタイムエラーを発生させます（混在防止のための strict モード）。

### 同名チャンネルへの合成

複数のシーケンスが同じチャンネル名を使うと、プラグイン内で**加算合成（サミング）**されます。

```text
global.linkAudio()

var hat_c = init global.seq
hat_c.audio("hihat_closed.wav").output("drums")
hat_c.play(1, 1, 1, 0)

var hat_o = init global.seq
hat_o.audio("hihat_open.wav").output("drums")
hat_o.play(0, 0, 0, 1)
// 両方が Live の "drums" チャンネルにミックスされる
```

### gain() / pan() との組み合わせ

`gain()` と `pan()` は合成前に各シーケンスに適用されます。

```text
var ghost = init global.seq
ghost.audio("snare.wav").output("drums")
ghost.gain(-12).pan(-30)
ghost.play(0, (0, 1), 0, (1, 0))
```

---

## サンプルレートの設定

Live のセッション SR と一致させるために `global.linkAudio(SR)` で明示指定できます。

```text
global.linkAudio(48000)    // 48000 Hz（デフォルト値でもある）
global.linkAudio(44100)    // 44100 Hz に変更
```

---

## テンポについて

OrbitScore 2.0.0 では **OrbitScore が Link テンポリーダー**として動作します（#283）。

- `global.tempo()` で設定した BPM が Link ピアに push される
- Ableton Live がそのテンポに追従する
- **Live 側からのテンポ変更が OrbitScore に反映される機能は 2.0.0 では未実装**

実際の演奏では、OrbitScore 側でテンポを管理し、Live をフォロワーとして使う運用になります。

---

## MIDI と LinkAudio の共存

同一ファイル内で MIDI シーケンスと LinkAudio オーディオシーケンスを並走させることができます。

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.key("C")
global.linkAudio()   // オーディオは LinkAudio 経由
global.start()

// MIDI シーケンス（IAC へ送信、LinkAudio の制約外）
var piano = init global.seq
piano.midi("IAC", 1).octave(4).vel(84)
piano.play(1, 3, 5, 8)

// オーディオシーケンス（LinkAudio 経由で Live へ）
var kick = init global.seq
kick.audio("kick.wav").output("kick")
kick.play(1, 0, 1, 0)

LOOP(piano, kick)
```

---

## OrbitLinkAudio.scx プラグインがない場合

プラグインが読み込まれていない状態で `global.linkAudio()` を宣言すると、最初のディスパッチ（再生）時にハードウェア出力にフォールバックし、警告が表示されます。

---

## 次のページ

- ループのタイミングを制御する Launch Quantize → [Launch Quantize](./quantize.md)
- メソッド一覧 → [リファレンス](../reference/methods.md)
