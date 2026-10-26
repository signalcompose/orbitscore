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
host: both
---
```

`host` は必須です（値と書き方は下の「可用性表記」の節）。

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

## 可用性表記（拡張版 / OrbitStudio）

このサイトは **2 つの配布線**に向けた 1 本の文書です。

| 配布線 | 指すもの | 書く語（ja / en） |
|---|---|---|
| **拡張版** | VS Code 拡張（`.vsix`・機能は凍結。bug fix の例外だけ出る） | `拡張版` / `Extension` |
| **OrbitStudio** | macOS ネイティブ版アプリ | `OrbitStudio` / `OrbitStudio` |

違いは 2 種類あり、書き方を分けます（設計: `docs/design/848-docs-structure-design.md` §2〜§5）。

- **どこで操作するか**（コマンドパレット・ステータスバー・`.vsix` など）→ 章の frontmatter `host:` と、段落の**併記**
- **その機能がどの配布線のどの版から使えるか** → 機能ごとの**可用性の行**（`> **対応**:`）

DSL の説明本文は 1 本のまま書きます。配布線ごとに本文を書き分けることはしません。

🔴 owner の条件（2026-10-26・設計 848 §14 (20)）: **拡張版の読者が OrbitStudio の記述を自分の手順として読まないこと**（拡張版を退役させるまで）。下の規則 `AV-HOST-SCOPE` がこれを機械で守ります。

### lint — `npm run docs:check`

`sites/user/scripts/check-availability.mjs` が全章（ja / en）を検査し、違反があれば red にします。`npm run docs:check`（CI の `Check doc citations`）から走ります。

| 規則 | red の条件 |
|---|---|
| `AV-HOST` | frontmatter に `host:` が無い / 4 値以外 / 分割節の印の形・置き場所が違う |
| `AV-SYNTAX` | 可用性の行が 5 形のどれでもない / 綴り違い（全角コロン・`>` 無し）/ 章の言語と違うアンカー / 次の行が空行でない |
| `AV-PLACE` | 可用性の行が機能の見出しの直下に無い |
| `AV-UNRELEASED` | `未リリース（…）` が残っている（通常は警告。`--release` を付けたリリースの preflight では red） |
| `AV-I18N` | ja の章と en の章で `host`・可用性の行の数・分割節の印の数が違う |
| `AV-HOST-SCOPE` | `host: both` / `both+split` の章で、OrbitStudio を含む行が下の「併記の行」にも「OrbitStudio の可用性の行が付いた節」にも入っていない |
| `AV-TERM` | 拡張版を「OrbitStudio（凍結版）」と呼んでいる |

### frontmatter `host:`（必須）

| 値 | 意味 |
|---|---|
| `both` | 両方の配布線で同じ内容。操作が違う段落だけを併記する |
| `both+split` | 章は共通だが、手順の節が配布線で分かれる（節に分割節の印を付ける） |
| `app` | OrbitStudio だけの章 |
| `ext` | 拡張版だけの章（`.vsix` の入れ方など）。アプリには同梱しない |

ja と en で同じ値にします。

### 分割節の印（`both+split` の章だけ）

配布線ごとの節は、**見出しの次の行**に印を置きます。

```markdown
## ステップ 2: VS Code でフォルダを開く
<!-- host: ext -->
```

- 値は `ext` か `app` の 2 つだけです。アプリへの同梱時に `ext` の節を落とすための印です
- 見出しの**行の中**には書きません（VitePress が見出しの `aria-label` に印の文字列をそのまま入れ、読み上げに出るため）
- 印は読者には見えません。**見出しか節の最初の文で**、どの配布線の手順かが読んで分かるように書きます（例: 「VS Code を起動し…」）

### 段落の併記

操作が配布線で違う箇所は、行頭に配布線の名前を置いた**併記の行**にします。置き場所は `::: tip` / `::: info` / `::: warning` の中か、箇条書き（「用意するもの」「報告に書くもの」など）の項目です。DSL の説明本文には混ぜません。

```markdown
::: tip カタログ名が候補に出ないとき
- **拡張版**: コマンドパレットから **「OrbitScore: Rescan Plugin Catalog」** を実行します
:::
```

en では `- **Extension**:` と `- **OrbitStudio**:` です。

- 🔴 **`AV-HOST-SCOPE`**: `host: both` / `both+split` の章では、OrbitStudio を含む行（大文字小文字を問わない。コードブロックと frontmatter も含む）は次のどちらかにしか置けません
  1. `- **OrbitStudio**:` で始まる併記の行
  2. 見出しの直下の可用性の行が OrbitStudio を含む節（その下位の節も含む）
- **OrbitStudio の操作手順は、アプリの表面が決まるまで書きません**（設計 848 別冊 §7.4・§14 (20)「主語は A-parity 後」）。それまでは `- **拡張版**:` の行だけを置き、OrbitStudio の行は表面が決まってから足します

### 可用性の行（固定文法・5 形）

機能の**見出しの直下**に 1 行だけ置きます（章全体が 1 つの機能なら章のタイトルの直下）。行頭の `> **対応**:` が唯一のアンカーで、`grep -rn "> \*\*対応\*\*:" sites/user` の 1 本で全件を列挙できる形にしてあります。

```markdown
> **対応**: 拡張版 4.2.0 以降 / OrbitStudio 0.1.0 以降
> **対応**: OrbitStudio 0.2.0 以降（拡張版には入りません）
> **対応**: 拡張版 4.2.0 以降（OrbitStudio では 0.1.0 から動作が変わります — 下記）
> **対応**: 未リリース（OrbitStudio）— main にマージ済み・次のリリースから
> **対応**: 未リリース（拡張版 4.2.1）— 凍結版の bug fix
```

en（`sites/user/en/`）は `> **Availability**:` で同じ 5 形です。

```markdown
> **Availability**: Extension 4.2.0 and later / OrbitStudio 0.1.0 and later
> **Availability**: OrbitStudio 0.2.0 and later (not in the Extension)
> **Availability**: Extension 4.2.0 and later (behaves differently in OrbitStudio from 0.1.0 — see below)
> **Availability**: Unreleased (OrbitStudio) — merged to main, ships in the next release
> **Availability**: Unreleased (Extension 4.2.1) — bug fix for the frozen line
```

- 版は semver の 3 桁（`4.2.0`）。配布線の語は上の 2 つだけです
- 行の**次は必ず空行**にします（続けて文を書くと、その文が引用の中に取り込まれます）
- **可用性の行が無い機能は、両方の配布線で使えるもの**として読みます。行は配布線で違いがある機能にだけ置きます
- `未リリース（<配布線>）` は暫定値です。リリースの bump PR で版番号に置き換え、`grep -rn "未リリース（OrbitStudio）" sites docs` が 0 件になることを確かめます（リリースの preflight は `check-availability.mjs --release` で落とします）
- 5 形で書けない場合は、**STYLE_GUIDE と lint を同じ PR で直してから**書きます（自由文で書くと grep で拾えなくなります）
- 既存の自由文の版表記（`#883 / DSL 2.0`・`v3.0 以降` など）は本文として残してかまいません。可用性の正本は行の方です

## NG 集（チェックリスト）

執筆後に self-check するためのアンチパターン:

- [ ] 「だ・である」 調が混ざっていないか
- [ ] 「〜してみよう！」 のような子供扱いトーンになっていないか
- [ ] 絵文字の連発がないか
- [ ] 動画・GIF への言及がないか
- [ ] primary source（USER_MANUAL.md / GETTING_STARTED.md / examples）に書いていない仕様を独自に追加していないか
- [ ] 章番号と sidebar 構成が整合しているか
- [ ] dead link がないか（VitePress build で自動検出）
- [ ] frontmatter に `host:` があり、ja / en で同じ値か
- [ ] 操作が配布線で違う段落を、`- **拡張版**:` の併記にしたか
- [ ] OrbitStudio の記述が併記の行か OrbitStudio の可用性の行が付いた節の中にあるか（`npm run docs:check` が `AV-HOST-SCOPE` で検査）
