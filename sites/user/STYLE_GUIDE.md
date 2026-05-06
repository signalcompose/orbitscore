# Style Guide — OrbitScore User Learning Site

このサイトの執筆規律。`docs/development/USER_LEARNING_SITE.md` の §4 「Writing 規律」 を補足し、執筆者（人間 / AI 両方）が読む運用ドキュメント。

## トーン

### ですます調を統一

- 文末は「です・ます・しょう・ください」 で終える
- 「だ・である」 調は混ぜない（混在すると文体が崩れる）

### 子供扱いしない

以下のような幼稚なトーンは **使わない**:

- 「〜してみよう！」「〜だよ！」「やった！できたね！」
- 過剰な絵文字（🎉、🚀、✨、🎵、🎶 の連発）
- 子供扱いの励まし（「えらい！」「すごい！」）

代わりに穏やかな指示形:

- 「〜してみてください」
- 「〜できます」
- 「もし動かない場合は…」（断定を避ける）

### 平易さの目標

- 小学校高学年〜中学生でも理解できる平易な日本語
- ただし「やさしさ = 幼稚さ」 ではない。読み手を尊重した平易さ

### 技術用語の噛み砕き

初出時に短い説明を添える:

- 「DSL」 → 「特定の用途に特化した小さなプログラミング言語のこと」
- 「シーケンス」 → 「音のパターンの 1 まとまり」
- 「BPM」 → 「1 分間に何拍鳴らすかの数字」

二度目以降は通常通り使ってよい。

## 構成

### Frontmatter

各章 Markdown の先頭に:

```yaml
---
title: <chapter title>
description: <one-line summary>
---
```

### 見出し

- `# <章タイトル>` を 1 つだけ（VitePress の慣習）
- `##` でセクション、`###` でサブセクション
- 4 階層以上は深すぎるので避ける

### コードブロック

- DSL コードは ` ```orbitscore ` または ` ```text ` で
- 説明用の擬似コードと実際のコードを区別する
- ファイル名を示すときは `<filename>.orbs` のように拡張子を含める

### 例

実例は `examples/*.orbs` を primary source として参照する。本文中に転載する場合は **完全コピーではなく、説明に必要な部分のみ抜粋**してよい。

## 図・画像

### 使わないもの

- 動画 (`.mp4`、YouTube 埋め込み等)
- GIF アニメーション
- スクリーンショットの動画化
- 静止画スクリーンショット（基本的に使わない、 どうしても必要な場合のみ個別判断）

### 使ってよいもの

- Mermaid 図（必要時のみ、過度に使わない）
- VitePress 標準のテキスト装飾（`::: tip`、`::: warning`、`::: info`）

## 章相互の link

VitePress link 構文で:

```markdown
詳しくは [パターンを作る](./basics/patterns.md) を参照してください。
```

絶対パスは `cleanUrls: true` 設定により `.md` 省略可だが、ソースでは `.md` を含めると lint との相性がよい。

## 内容の整合性

primary source からの逸脱は禁止:

- `docs/user/ja/USER_MANUAL.md` にない仕様を user site に書かない
- `docs/user/ja/GETTING_STARTED.md` の手順と齟齬を出さない
- `examples/*.orbs` の DSL 例から逸脱した書き方を紹介しない

仕様の真実は `docs/core/INSTRUCTION_ORBITSCORE_DSL.md`。 不明点はそちらを当たる。

## NG 集（チェックリスト）

執筆後に self-check するためのアンチパターン:

- [ ] 「だ・である」 調が混ざっていないか
- [ ] 「〜してみよう！」 のような子供扱いトーンになっていないか
- [ ] 絵文字の連発がないか
- [ ] 動画・GIF への言及がないか
- [ ] primary source（USER_MANUAL.md / GETTING_STARTED.md / examples）に書いていない仕様を独自に追加していないか
- [ ] 章番号と sidebar 構成が整合しているか
- [ ] dead link がないか（VitePress build で自動検出）
