---
title: エフェクトを挿す
description: seq.effect() / global.effect() でシーケンスやバスにプラグインエフェクトを挿す方法、複数プラグインをチェーンする方法を解説します
---

# エフェクトを挿す

これまでの章では、`gain()` や `pan()` といった OrbitScore 内蔵の機能で音を調整してきました。OrbitScore では、それに加えて外部のプラグインエフェクト（コンプレッサーやリバーブなど）をシーケンスやバスに挿すこともできます。この章では `seq.effect()` と `global.effect()` を中心に、エフェクトの挿し方を解説します。

## seq.effect() — シーケンスにエフェクトを挿す

`effect(spec)` は、そのシーケンス**だけ**にかかるエフェクトを挿すメソッドです。DAW でいう「トラックの insert」と同じ位置づけです。

```text
var drums = init global.seq
drums.audio("kick.wav")
drums.effect("TAL Reverb 4")   // カタログ名で指定
```

処理の順番は次のとおりです。

1. シーケンス個別の insert（`seq.effect()`）
2. マスターミックス
3. `global.effect()`（マスターチェーン、設定していれば）

::: warning MIDI シーケンスには使えません
`seq.effect()` は `seq.audio()` と `seq.instrument()` のシーケンスで使えます。
`seq.midi()` で作ったシーケンスは外部機器へ送るものなので、ミキサーの出口を持たず、
宣言するとエラーになります。
:::

### 宣言のタイミングと失敗の扱い

`effect()` は**宣言した時点**でプラグインを読み込みます。ファイルが見つからない場合や対応していない形式の場合は、その場でエラーになります。「音が鳴らないまま気づかない」という事故を防ぐため、警告だけで無音のまま進行することはありません。

## global.effect() — マスターに挿す

`global.effect(spec)` は、**すべてのシーケンスにかかる**マスターバスの insert です。

```text
global.effect("TAL Reverb 4")
```

`seq.effect()` と同様に、宣言した時点でプラグインを読み込みます。失敗時の扱いも同じです。

## カタログ名 or パスで指定する

プラグインの指定方法は 2 通りあります。

```text
drums.effect("TAL Reverb 4")                  // カタログ名（推奨・補完が効きます）
drums.effect("~/plugins/TAL-Reverb-4.clap")   // フルパス
drums.effect("./plugins/MyEffect.clap")       // 相対パス
```

同名のプラグインが CLAP と VST3 の両方にある場合は CLAP が優先されます。VST3 版を明示したい場合は `"vst3/TAL Reverb 4"` のように format を接頭辞で指定してください。vendor が複数ある場合も同様に `"TAL Software/TAL Reverb 4"` のように指定して一意化できます。パス指定はカタログを一切参照しないので、カタログに登録されていないプラグインでも使えます。

::: tip カタログ名が候補に出ないとき
コマンドパレットから **「OrbitScore: Rescan Plugin Catalog」** を実行すると、インストール済みのプラグインを再スキャンします。
:::

受け付ける形式は **`.clap`** と **`.vst3`** です。`.component`（AU）は現時点では対応していません。

## 複数のプラグインを直列に挿す — チェーン

`effect()` には配列を渡すこともできます。配列で書いたプラグインは**上から順に直列接続**されます。

```text
drums.effect([
  "TAL Reverb 4",
  Gain(db: -6),
])
```

- 配列の要素は「カタログのプラグイン名（文字列）」「`Gain(db: n)` のような標準プラグイン」「`plugin("名前", enabled: false)` のように引数を付けた形」のいずれかです。
- **`effect("名前")`（文字列 1 つ）は `effect(["名前"])` とまったく同じ意味です。** つまり `effect(spec)` は毎回「チェーン全体をこの形にする」という宣言であり、追記ではありません。

```text
drums.effect(["TAL Reverb 4"])
drums.effect(["TAL Reverb 4", "ValhallaRoom"])   // ← Reverb 4 に ValhallaRoom を追加した「全体像」を渡す
drums.effect(["ValhallaRoom"])                   // ← Reverb 4 は消え、ValhallaRoom だけになる
drums.effect([])                                 // ← 全部外す
```

### 削除は「配列から消して再評価する」

明示的な削除メソッドはありません。**外したいプラグインを配列から除いて再評価する**のが削除です。外したプラグインの音色（state）はアンロード直前に自動保存されるので、配列に書き戻せば同じ音色で復帰します。

### 無効化 — enabled: false

プラグインをアンロードせずに一時的にバイパスしたいときは `plugin("名前", enabled: false)` を使います。

```text
drums.effect([
  plugin("TAL Reverb 4", enabled: false),   // 素通し（バイパス）
  "ValhallaRoom",
])
```

直列チェーンでは `enabled: false` のプラグインは信号をそのまま通します（素通し）。プラグインはロードされたまま state も保持されるので、`enabled: true` に戻せば同じ音色で復帰します。

### 標準プラグイン — Gain

`Gain(db: n)` は OrbitScore にアプリ同梱されている標準プラグインです。UI や state を持たず、パラメータはすべて DSL 側のテキストで指定します。

```text
drums.effect(["TAL Reverb 4", Gain(db: -10)])
```

標準プラグインは大文字で始まる呼び出しで書き、カタログのプラグイン（文字列で指定）とは名前が衝突しません。現時点で使える標準プラグインは `Gain` のみです。

### v1 の制約

- **`layer([...])`（並列合成）は記法だけ予約されており、v1 では使うとエラーになります。** 直列チェーンのみが動作します。
- 複数の insert を同時に持てるシーケンス数には上限があります（既定 8）。上限を超える宣言は明示エラーになります。
- プラグインのレイテンシ補正（PDC）はありません。

## sum / aux にもエフェクトを挿せる

`seq.effect()` / `global.effect()` と同じ考え方で、グループバス（`sum`）やリターンバス（`aux`）にもチェーンでエフェクトを挿せます。

```text
sum("bus").effect(["TAL Reverb 4", Gain(db: -6)])
```

`sum` や `aux` の詳しい使い方は次の章 [sum と aux/send](./routing.md) で扱います。ここでは「バスにもシーケンスと同じ要領でエフェクトを挿せる」という点だけ押さえてください。

## プラグイン UI を開く

音を作り込みたいときは、`ui()` でプラグイン本体の画面を開けます。名前を渡すと、チェーンの中で一致するプラグインの UI をすべて開きます。

```text
drums.ui("TAL Reverb 4")          // 一致するプラグインの UI をすべて開く
drums.ui("TAL Reverb 4", false)   // 閉じる

sum("bus").ui("ValhallaRoom")     // sum バスの insert にも使えます
```

- 同名のプラグインがチェーン内に複数あっても、**選ばずに全部開きます**（曖昧にしないための仕様です）。
- 標準プラグイン（`Gain` など）は UI を持たないため、標準プラグイン名を渡すと明示エラーになります。
- 一致するプラグインが 1 つも無い場合も明示エラーになります（黙って何も起きない、ということはありません）。
- 楽譜を再評価しても、既に開いている UI を二重に開くことはありません（冪等）。

---

次は、複数のシーケンスをまとめてバスに送る `sum` と `aux/send` の仕組みを見てみましょう。

→ [sum と aux/send](./routing.md)
