---
title: プラグイン音源を鳴らす
description: seq.instrument() で CLAP / VST3 プラグインを音源として鳴らし、度数記法で演奏する方法を解説します
---

# プラグイン音源を鳴らす

これまでの章では、`seq.audio()` によるオーディオファイル再生と、`seq.midi()` による外部 MIDI 機器への出力を扱ってきました。OrbitScore では、これらに加えて **CLAP / VST3 のプラグイン音源（シンセサイザーやサンプラー）を直接ホストして鳴らす**こともできます。エンジン内で完結するため、外部 DAW を経由する必要はありません。

## seq.instrument() — プラグインを音源として宣言する

```text
var piano = init global.seq
piano.instrument("Kontakt 8")     // カタログ名で指定
piano.octave(4).vel(96).gate(0.8)
piano.play(1, 3, 5, 0)            // 値は度数（MIDI 出力と同じ記法）
```

- `instrument()` を宣言したシーケンスは「note シーケンス」になり、`play()` の値は度数として解釈されます。これは `seq.midi()` と同じ意味論です。度数記法・コード・ボイシングの詳しい説明は [ピッチ DSL（度数・コード）](../midi/pitch-dsl.md) を参照してください。
- `.audio()` / `.midi()` とは排他です。1 つのシーケンスは 1 つの出口（audio / MIDI / instrument）しか持てません。
- 対応する形式は **CLAP** と **VST3** です。`.component`（AU）は現時点では未対応です。
- `octave()` / `vel()` / `gate()` / `root()` など、MIDI シーケンスと同じメソッドが使えます（詳細は [リファレンス](../reference/methods.md) を参照してください）。

## カタログ名 or パスで指定する

プラグインの指定方法は 2 通りあります。

```text
piano.instrument("Kontakt 8")                                    // カタログ名（推奨）
piano.instrument("/Library/Audio/Plug-Ins/VST3/Kontakt 8.vst3")  // フルパス
```

カタログ名で指定すると、エディタの補完でプラグイン名の候補が出ます。同名のプラグインが CLAP と VST3 の両方にある場合は CLAP が優先されます。VST3 版を明示したい場合は `"vst3/Kontakt 8"` のように format を接頭辞で指定してください。vendor が複数ある場合も同様に `"Native Instruments/Kontakt 8"` のように指定して一意化できます。

::: tip カタログ名が候補に出ないとき
コマンドパレットから **「OrbitScore: Rescan Plugin Catalog」** を実行すると、インストール済みのプラグインを再スキャンします。新しくインストールしたプラグインが補完に出ない場合はこれを試してください。
:::

## 音色の保存と復元（state）

プラグインで作った音色は、`.vstpreset` または `.state` で終わるパスを第 2 引数（pluginId を指定する場合は第 3 引数）に渡すことで保存・復元できます。**CLAP / VST3 のどちらでも使えます**（#562）。

```text
// カタログ名 + state（拡張子で state と判定される）
piano.instrument("Kontakt 8", "./states/piano.state")

// パス + pluginId + state（3 引数）
piano.instrument("/Library/Audio/Plug-Ins/VST3/Kontakt 8.vst3", "kontakt-8-id", "./states/piano.state")
```

第 2 引数の判別は拡張子だけで行われます。`.vstpreset` / `.state` で終わるものは state パス、それ以外の文字列は pluginId として扱われます。相対パスは編集中のファイルのディレクトリを基準に解決されます。

## シーケンスごとに独立したインスタンス

`instrument()` を宣言したシーケンスは、それぞれ独立したプラグインインスタンス（独立した子プロセス）を持ちます。**同じプラグインを複数のシーケンスで宣言しても、音色やパラメータは共有されません。**

```text
var vc = init global.seq
vc.instrument("Kontakt 8", "./states/cello.state")

var pf = init global.seq
pf.instrument("Kontakt 8", "./states/piano.state")   // vc とは別インスタンス・別音色
```

1 インスタンス = 1 子プロセスなので、片方がクラッシュしても他のシーケンスの発音には影響しません（クラッシュしたインスタンスは自動的に再起動されます）。

## ライブ中の差し替え

演奏中に `instrument()` の宣言を書き換えて再評価すると、エンジンを再起動せずに音色が差し替わります。

```text
piano.instrument("Kontakt 8", "./states/piano-a.state")
// ライブ中に別の state へ差し替え（次の評価で反映）
piano.instrument("Kontakt 8", "./states/piano-b.state")
```

- **同じ内容の再宣言は何も起きません**（冪等）。ライブコーディング中にファイル全体を再評価しても音が途切れないようにするためです。
- **異なる path / pluginId / state の再宣言は差し替え**になります。新しいインスタンスの読み込みが終わるまで元の音は鳴り続け、失敗した場合は元の音色が無傷で残ります。
- 差し替えの直前に、それまでの音色は自動保存されます。同じ宣言をもう一度評価すれば元の音色に戻ります。

## プラグイン UI を開く

音を作り込みたいときは、`ui()` でプラグイン本体の画面を開けます。

```text
piano.ui()   // instrument の UI を開く（無引数 = instrument）
```

- **無引数形が instrument の UI を開く形です。** instrument はシーケンスに 1 つしかないため、名前の指定は不要です。
- 楽譜を再評価しても二重に開くことはありません（冪等）。ライブコーディングでは同じ行が何度も再評価される前提だからです。
- 開いた UI を閉じるには、パネルを直接閉じてください。

## v1 の制約（正直な開示）

- **`~`（デチューン）は使えません。** プラグイン経路には pitch bend / CC がまだ無いため、警告のうえスキップされます。
- **CC 制御・per-note expression・テンポ連動**は未実装です。
- **オフラインレンダ先の指定（`output(1)` のような番号指定）は未対応です。** 録音経路が別のため、
  指定すると明示エラーになります。
- **LinkAudio チャンネルへの `output()` も未対応です**（配線がまだありません）。
- **`global.linkAudio()` とは同時に使えません**（宣言時エラー）。
- ノートの発音タイミングはブロック単位の精度です（サンプル精度化は今後の課題）。

---

`seq.effect()` は **instrument シーケンスにも使えます**（#643 でミキサーに載りました）。
複数のプラグインを直列に挿す「チェーン」や、マスター/シーケンス個別のエフェクトについては次の章で扱います。

→ [エフェクトを挿す](../mixing/effects.md)

::: tip 実際に使われている例
実作品（弦楽五重奏 + ピアノの Kontakt 音源、ゴングのオーディオファイル）は `instrument(path, statePath)` の形で本番の音色を復元しています。カタログ名や state を使った運用の実例です。
:::
