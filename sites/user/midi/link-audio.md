---
title: LinkAudio（Ableton Live への音声出力）
description: global.linkAudio() と seq.output() を使って OrbitScore の音を Ableton Live へ直接送る方法を説明します
---

# LinkAudio（Ableton Live への音声出力）

**LinkAudio** は、音声を Ableton Live へ直接送るための仕組みです。IAC 経由の MIDI と異なり、オーディオ信号をそのまま LAN 上でストリームします。

::: danger 配布版では音が Live に届きません（2026-09-10 時点）
**配布されている OrbitScore（`.vsix`）では LinkAudio の音声送出が動きません。** `global.linkAudio()` と `seq.output()` は今までどおり書けますし、エラーにもなりませんが、**Live 側にチャンネルは現れません**。

理由は 2 つあります。

- 音声送出を担っていた **OrbitLinkAudio.scx**（SuperCollider 用のプラグイン）は、SuperCollider 経路ごと [#502](https://github.com/signalcompose/orbitscore/issues/502)（2026-09-10）で削除されました
- 置き換えとなる Rust 側の送出機能（`orbit-link-audio`）は、配布ビルドに**含まれていません**。有効化すると Ableton Link のライセンス（GPL-2.0-or-later）が配布物に入るため、有効にするかどうかがまだ決まっていません

⚠️ **そのとき音がどうなるかは、まだ確定していません。** 仕様（DSL 仕様 §8.1）は「ハードウェア出力へフォールバックし、警告が 1 回だけ出る」と書いていますが、2026-09-04 の実機測定では**音が出ず、警告も出ませんでした**（`tests/e2e/orbitstudio-mcp-gated.spec.ts` の「**A comment is not evidence of implementation behavior**」で始まるコメント に記録）。**どちらが正しいかが決まるまで、LinkAudio を前提にした演奏はしないでください。**

`global.tempo()` を Link の相手に伝える機能も同じ理由で無効です。

このページの以下の説明は、**送出機能が有効なビルドでの動作**として読んでください。仕様の現在地は [DSL 仕様 §8.1](https://github.com/signalcompose/orbitscore/blob/main/docs/core/INSTRUCTION_ORBITSCORE_DSL.md) に記録されています。
:::

## 前提条件

- **macOS** のみ対応
- **Ableton Live 12.4 以降**が起動していること
- **LinkAudio の音声送出が有効なビルド**であること（上の警告を参照。配布版は無効です）
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

`output()` を指定しないオーディオシーケンスは `global.linkAudio()` 宣言中は**無音でスキップ**され、その理由がログに出ます（混在防止のための strict モード）。ハードウェア出力へ勝手に落ちることはありません。

以前はこの場合にランタイムエラーを投げていましたが、ライブコーディング中に例外が飛ぶと**同じ評価ブロックの他のシーケンスまで巻き添えで止まる**ため、スキップ + ログに変わりました（#645）。エディタ側では `output()` の書き忘れを評価前にエラー診断として知らせます。

### 同名チャンネルへの合成

複数のシーケンスが同じチャンネル名を使うと、送出側で**加算合成（サミング）**されます。

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

::: warning テンポの push も配布版では無効です
テンポを Link の相手へ送る機能は、音声送出と**同じ仕組み**の上に載っています。そのため配布版では音声と同様に無効で、警告が 1 回出るだけになります（ページ冒頭の警告を参照）。
:::

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

## 音声送出が使えないビルドの場合

仕様（DSL 仕様 §8.1.3）では、送出機能が使えない状態で `global.linkAudio()` を宣言すると、**最初のディスパッチ（再生）時**にハードウェア出力へフォールバックし、警告が **1 回だけ**出ることになっています。`global.linkAudio()` を書いた時点では何も起きません。

警告が 1 回だけなのは意図的です。発音のたびに同じ理由の警告が積み上がらないよう、警告を出すのは**チャンネルを登録する 1 箇所だけ**と決められています。

⚠️ ただし、**この記述と実機の測定が食い違っています**。2026-09-04 の実機では音が出ず（capture RMS = 0）、警告も出ませんでした（`tests/e2e/orbitstudio-mcp-gated.spec.ts` の「**A comment is not evidence of implementation behavior**」で始まるコメント）。ページ冒頭の警告も参照してください。

---

## 次のページ

- ループのタイミングを制御する Launch Quantize → [Launch Quantize](./quantize.md)
- メソッド一覧 → [リファレンス](../reference/methods.md)
