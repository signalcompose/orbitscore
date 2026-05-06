---
title: インストール
description: OrbitScore VS Code 拡張機能を .vsix ファイル経由でインストールする手順
---

# インストール

OrbitScore は VS Code の拡張機能として動作します。この章では、拡張機能をインストールして、動作を確認するまでの手順を説明します。

## 動作環境

作業を始める前に、お使いの環境が以下の条件を満たしているか確認してください。

| 項目 | 対応状況 |
|---|---|
| macOS Apple Silicon（M1 / M2 / M3 等の Mac） | 対応 |
| macOS Intel（x86_64） | 一部動作する可能性がありますが未検証 |
| Windows / Linux | v1 系では未対応 |
| VS Code または Cursor（バージョン 1.99.0 以上） | 必須 |

::: info SuperCollider のインストールは不要です
OrbitScore の拡張機能には音を鳴らすためのオーディオエンジン（scsynth）が同梱されています。別途 SuperCollider をインストールしなくても、そのまま使い始めることができます。
:::

## インストール手順

### ステップ 1: .vsix ファイルをダウンロードする

[GitHub Releases](https://github.com/signalcompose/orbitscore/releases) を開き、最新バージョンの `orbitscore-*.vsix` ファイルをダウンロードします。

### ステップ 2: VS Code に拡張機能をインストールする

ダウンロードした `.vsix` ファイルを使って、以下の 3 つの方法のうちどれかでインストールできます。やりやすい方法を選んでください。

#### 方法 A: ファイルをダブルクリック

ダウンロードした `.vsix` ファイルをダブルクリックします。VS Code が自動的に開いてインストールが始まります。

#### 方法 B: VS Code のコマンドから

1. VS Code を起動します
2. コマンドパレットを開きます（`Cmd+Shift+P`）
3. `Extensions: Install from VSIX...` と入力して選択します
4. ダウンロードした `.vsix` ファイルを選びます

#### 方法 C: コマンドライン（ターミナル）から

ターミナルを開き、次のコマンドを実行します。`orbitscore-*.vsix` の部分は、実際のファイル名に書き換えてください。

```text
code --install-extension orbitscore-*.vsix
```

Cursor を使っている場合は `code` の代わりに `cursor` と入力します。

### ステップ 3: 動作を確認する

インストールが完了すると、VS Code の画面下部にあるステータスバー（青いバー）に OrbitScore の状態が表示されます。

```
🎵 OrbitScore: Ready     ✅ scsynth (bundled)
```

この 2 つが表示されていれば、インストールは正常に完了しています。

ステータスバーに表示される内容は状況によって変わります:

| 表示 | 意味 |
|---|---|
| `✅ scsynth (bundled)` | 同梱のオーディオエンジンが動作しています（通常の状態） |
| `⚙️ scsynth (custom)` | ユーザーが設定で指定したオーディオエンジンを使用しています |
| `❌ scsynth: not found` | オーディオエンジンが見つかりません（後述の対処法を参照） |

::: warning `❌ scsynth: not found` と表示された場合
拡張機能を一度アンインストールし、`.vsix` ファイルを改めてダウンロードしてからインストールし直してください。それでも解決しない場合は [トラブルシューティング](../troubleshooting.md) を参照してください。
:::

## 将来の予定

現在は GitHub Releases から `.vsix` をダウンロードしてインストールする方法のみ対応しています。将来は VS Code Marketplace と Open VSX からも直接インストールできる予定です。

## 次のステップ

インストールが確認できたら、最初の音を出してみましょう。

→ [はじめての音](./first-sound.md)
