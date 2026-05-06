---
title: OrbitScore とは
description: OrbitScore は VS Code でライブコーディング音楽を作るための DSL とオーディオエンジンです
---

# OrbitScore とは

OrbitScore は、VS Code の上で短いコードを書きながら音楽を作るためのツールです。書いたコードを保存することなく、その場で音を変えたり、リズムを足したり、テンポを変えたりできます。これを「ライブコーディング」と呼びます。

このサイトでは、OrbitScore で初めて音を出すところから、ステージで演奏できるレベルまで、順を追って解説します。

## こんな人に向いています

- DAW（音楽制作ソフト）でマウスを使って打ち込むのが面倒だと感じる方
- コードを書きながら音楽を作ることに興味がある方
- 即興演奏（ジャム / ライブ）が好きな方
- 数行のコードで複雑なリズムを表現できる仕組みが面白そうだと感じた方

プログラミングの経験がそれほど無くても問題ありません。最初の数章で基礎を一緒に確認します。

## どんなことができるのか

OrbitScore で書く DSL（特定の用途に特化した小さなプログラミング言語のこと）は、たとえば次のような形をしています:

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")
global.start()

var drum = init global.seq
drum.audio("kick.wav").chop(1)
drum.play(1, 1, 1, 1)

LOOP(drum)
```

このコードは「kick の音を 4 拍ぶん同じ間隔で鳴らし続ける」 という動作を表します。VS Code の中でこれを書いて `Cmd+Enter`（macOS）を押すと、すぐに音が鳴り始めます。

## OrbitScore の特徴

### シンプルな DSL

メソッドチェーン（`drum.audio(...).chop(...)`のように `.` で繋ぐ書き方）で、何をどうしたいかを直感的に表現できます。

### ライブコーディング向けの設計

書いたコードを保存しなくても、選んだ部分だけを「実行」できます。これにより、演奏中に小節ごとにパターンを書き換えていく、という使い方ができます。

### ポリメーター・ポリリズム対応

異なる拍子のパターンを同時に走らせる「ポリメーター」 や、異なるテンポを組み合わせる「ポリリズム」 が、書きやすい構文で表現できます。詳しくは [ポリメーター・ポリリズム](./basics/polyrhythm.md) で紹介します。

### SuperCollider をバックエンドに

音を実際に鳴らしているのは [SuperCollider](https://supercollider.github.io/) という古くからあるオーディオエンジンです。OrbitScore の VS Code 拡張機能には SuperCollider 本体が同梱されているため、別途インストールする必要はありません。

## このサイトの読み方

章番号順に読み進めると、自然に学習曲線を登れる構成にしています:

1. **このページ**（OrbitScore とは）
2. [インストール](./getting-started/installation.md)
3. [はじめての音](./getting-started/first-sound.md) — まずここまで進めば「OrbitScore で音を出せた」状態になります
4. [パターンを作る](./basics/patterns.md)
5. [複数のシーケンス](./basics/multiple-sequences.md)
6. [ポリメーター・ポリリズム](./basics/polyrhythm.md)
7. [オーディオ操作](./basics/audio-manipulation.md)
8. [ライブコーディング](./basics/live-coding.md)
9. [リファレンス](./reference/methods.md) — メソッド一覧の早見表
10. [トラブルシューティング](./troubleshooting.md)

困ったときに 9 章のリファレンスや 10 章のトラブルシューティングだけを開く、という読み方も想定しています。

## 動作環境

- macOS Apple Silicon（M1, M2, M3 等の Mac）
- VS Code または Cursor（バージョン 1.99.0 以上）

Intel Mac、Windows、Linux は v1 系では未対応です（一部 Intel Mac では動作する可能性がありますが未検証）。

## 次のステップ

それでは、まず VS Code 拡張機能をインストールするところから始めましょう。

→ [インストール](./getting-started/installation.md)
