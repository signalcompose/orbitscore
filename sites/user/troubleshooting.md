---
title: トラブルシューティング
description: OrbitScore を使う上でよく起こる問題と、その解決方法をまとめています
---

# トラブルシューティング

うまくいかないときに参照するページです。症状のカテゴリから該当するものを探してください。

## 音が鳴らない

### `global.start()` を呼んでいますか？

OrbitScore では、シーケンスを実行する前に必ずスケジューラー（タイミングを管理する仕組み）を起動しておく必要があります。`global.start()` を書き忘れると、コードを実行しても音が出ません。

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")
global.start()   // ← これを忘れずに

var drum = init global.seq
drum.audio("kick.wav")
drum.play(1, 1, 1, 1)

LOOP(drum)
```

### `audioPath` のパスは正しいですか？

`global.audioPath("./audio")` のように相対パスを書いた場合、その基準になるのは「現在開いている `.orbs` ファイルがある場所」です。フォルダの場所やファイル名が違うと、音声ファイルが見つからず音が出ません。

絶対パス（ドライブのルートから書くパス）を使うと確実です:

```text
global.audioPath("/Users/yourname/orbitscore-practice/audio")
```

### 音声ファイルが正しい場所にありますか？

`audioPath` で指定したフォルダの中に、`audio()` で指定したファイル名のファイルが実際にあるか確認してください。ファイル名のスペルミスにも注意してください。

### スピーカーやヘッドフォンの設定を確認してください

OS のオーディオ出力設定で、音を聞きたいデバイスが選ばれているか確認してください。システムの音量が 0 になっていないかも確認してください。

OrbitScore 側でデバイスを選んでいる場合は、**Audio Engine Settings** ビューの **Output Device** で `●` が付いているデバイスも確認してください。指定したデバイスから音の要求が来なかった場合、エンジンは起動時に OS のデフォルト出力へ切り替えます（[エンジン設定](/getting-started/engine-settings)）。

---

## `Cmd+Enter` が動かない

### ファイルの拡張子は `.orbs` ですか？

OrbitScore のコード実行は、`.orbs` という拡張子のファイルの中でのみ有効です。`.txt` や `.js` など別の拡張子のファイルでは `Cmd+Enter` は機能しません。

ファイル名の末尾が `.orbs` になっているか、VS Code のタブで確認してください。

### ステータスバーに `🎵 OrbitScore: Ready` が表示されていますか？

拡張機能が起動していないと、コマンドが動きません。VS Code 下部のステータスバーを確認してください。`🎵 OrbitScore: Ready` が表示されていない場合は、ステータスバーのその部分をクリックすると起動します。

---

## パターンが想定通りに鳴らない

### `global.start()` より前に `LOOP()` を書いていませんか？

`global.start()` を呼ぶ前に `LOOP()` や `RUN()` を実行しても、スケジューラーがまだ動いていないため正しく機能しません。必ず `global.start()` を実行した後に `LOOP()` や `RUN()` を呼んでください。

### `beat()` と `play()` を混同していませんか？

`global.beat()` は拍子（タイムシグネチャ：1 小節に何拍あるか）を設定するメソッドです。リズムのパターンは `play()` で定義します。

```text
// ❌ 間違い: beat() にパターンを書いてもリズムにはならない
// seq.beat("x___")  ← これは動きません

// ✅ 正しい: 拍子は beat()、リズムパターンは play()
global.beat(4 by 4)       // 4/4 拍子に設定
seq.play(1, 0, 0, 0)      // 1 拍目だけ鳴らす
```

### テンポや拍子は変更しましたか？

デフォルトのテンポや拍子の設定によって、パターンが想定よりゆっくりまたは速く聞こえることがあります。`global.tempo()` と `global.beat()` を明示的に書いて確認してください。

## audioPath 関連のエラーが出る

### 相対パスの基準はどこですか？

`global.audioPath("./audio")` のように `./` から始まる相対パスは、「現在開いている `.orbs` ファイルと同じ場所にある `audio` フォルダ」を意味します。`.orbs` ファイルとは別の場所にフォルダを置いている場合は、絶対パスを使うとトラブルを避けられます。

### ファイルを個別に絶対パスで指定することもできます

`audioPath` を設定しなくても、`audio()` に直接絶対パスを書くことができます:

```text
var drum = init global.seq
drum.audio("/Users/yourname/audio/kick.wav")
drum.play(1, 1, 1, 1)
```

## それでも解決しない場合

ここに書かれていない問題が起きた場合や、上記の手順で解決しなかった場合は、GitHub の Issue トラッカーで報告してください。

→ [GitHub Issues](https://github.com/signalcompose/orbitscore/issues)

報告の際は、以下の情報をできる範囲で記載していただくと、原因の特定がスムーズになります:

- OS のバージョン（例: macOS 15.0 Apple Silicon）
- VS Code または Cursor のバージョン
- OrbitScore のバージョン
- エラーメッセージがあれば全文
- `View → Output → OrbitScore` に表示されたログ
