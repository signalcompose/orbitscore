---
title: はじめての音
description: OrbitScore で最初の音を鳴らすまでの手順
---

# はじめての音

VS Code 拡張機能のインストールが終わったら、いよいよ音を鳴らしてみましょう。この章を読み終える頃には、画面に「ドンッ」というキックドラムの音が出ているはずです。

## 用意するもの

- インストール済みの OrbitScore VS Code 拡張機能（[インストール](./installation.md)を参照）
- `.wav` 形式のオーディオファイルが入ったフォルダ。今回は kick（バスドラム）の音 1 つあれば十分です

オーディオファイルがまだ手元にない場合は、[freesound.org](https://freesound.org/) などから無料のキックサンプルをダウンロードしてください。ファイル名は何でも構いませんが、本ページでは `kick.wav` という名前で進めます。

## ステップ 1: 作業フォルダを作る

任意の場所に新しいフォルダを作ります。たとえば、ホームディレクトリの下に `orbitscore-practice` というフォルダを作るとしましょう。

そのフォルダの中に、さらに `audio` というサブフォルダを作り、`kick.wav` をその中に置いてください。

```
orbitscore-practice/
└── audio/
    └── kick.wav
```

## ステップ 2: VS Code でフォルダを開く

VS Code を起動し、メニューから **File → Open Folder...** を選んで、先ほど作った `orbitscore-practice` フォルダを開きます。

## ステップ 3: `.orbs` ファイルを作る

サイドバーの作業フォルダのところで右クリックし、**New File** を選びます。ファイル名は `first-sound.orbs` とします（拡張子は必ず `.orbs` にしてください）。

## ステップ 4: コードを書く

`first-sound.orbs` を開いて、次のコードを書きます。コピーして貼り付けても構いません。

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")
global.start()

var drum = init global.seq
drum.audio("kick.wav")
drum.play(1, 1, 1, 1)

LOOP(drum)
```

これだけで「キックドラムを 4 拍ぶん繰り返し鳴らす」という指示になります。

それぞれの行が何をしているのかは [パターンを作る](../basics/patterns.md) でゆっくり解説します。今はとにかく音を出すことを優先しましょう。

## ステップ 5: 実行する

書いたコードをすべて選択します（`Cmd+A`、Windows / Linux の場合は `Ctrl+A`）。

選択したまま、`Cmd+Enter`（Windows / Linux の場合は `Ctrl+Enter`）を押します。

しばらくすると、スピーカーやヘッドフォンから「ドン、ドン、ドン、ドン」という音が繰り返し鳴り始めるはずです。これで OrbitScore で音を出すことができました。

## 音を止める

音を止めるときは、新しい行に次のコードを書きます。

```text
LOOP()
```

その行にカーソルを置いて、もう一度 `Cmd+Enter` を押します。これですべてのループが止まります。

## もし音が鳴らなかったら

いくつか原因が考えられます。順番に確認してみてください。

### `audioPath` のパスが正しいか

`global.audioPath("./audio")` の `./audio` という指定は、「いま開いている `.orbs` ファイルと同じ階層にある `audio` フォルダ」 という意味です。フォルダ名や場所を変えた場合は、それに合わせて書き換えてください。

絶対パスで書くこともできます:

```text
global.audioPath("/Users/yourname/orbitscore-practice/audio")
```

### `.wav` ファイルが正しい場所にあるか

`audio/` フォルダの中に `kick.wav` がちゃんと存在するかを確認してください。ファイル名のスペルミスにも注意してください。

### VS Code 拡張機能が起動しているか

ステータスバー（VS Code 画面下部の青いバー）に `🎵 OrbitScore: Ready` と表示されているはずです。表示されていない場合は、ステータスバーのその部分をクリックすると拡張機能が起動します。

### スピーカー / ヘッドフォンの設定

OS のオーディオ出力先が、聞きたいデバイスになっているか確認してください。

それでも解決しない場合は、[トラブルシューティング](../troubleshooting.md) を参照してください。

## 何が起きていたのか（少しだけ解説）

詳細は次の章以降で扱いますが、ざっくりと:

- `var global = init GLOBAL` — 全体のテンポや拍子を管理する「指揮者」を作っています
- `global.tempo(120)` — 1 分間に 120 拍のテンポに設定しています
- `global.beat(4 by 4)` — 4 拍子（4 分の 4 拍子）に設定しています
- `global.audioPath("./audio")` — オーディオファイルのあるフォルダを指定しています
- `global.start()` — 指揮者にスタートの合図を出しています
- `var drum = init global.seq` — `drum` という名前のシーケンス（音のパターンの 1 まとまり）を作っています
- `drum.audio("kick.wav")` — このシーケンスで `kick.wav` を鳴らすことを指示しています
- `drum.play(1, 1, 1, 1)` — 4 拍ぶん、毎回 `kick.wav` を鳴らすパターンを書いています
- `LOOP(drum)` — `drum` を繰り返し再生開始する命令です

## 次のステップ

最初の音が出たら、次はリズムパターンを作ってみましょう。

→ [パターンを作る](../basics/patterns.md)
