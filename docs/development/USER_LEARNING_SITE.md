# User Learning Site — Project Brief & Skill Overrides

**Status**: Brief 確定 (2026-05-06)、初版 scaffold + 全章執筆は Issue #174 で対応
**Skill**: [`.claude/skills/vitepress-learning-site/`](../../.claude/skills/vitepress-learning-site/) (yuichkun/.claude 由来、verbatim install、作者承諾済)
**Related Issue**: [#174](https://github.com/signalcompose/orbitscore/issues/174) (本サイト構築)

> **用語**: 本文書の「post-ICMC」は **ICMC 2026 Hamburg (2026-05-10 〜 16)** 開催以降を指す。

---

## 1. 位置付け — なぜ作るか

### 動機

OrbitScore はライブコーディング音楽 DSL であり、ICMC で論文発表後に興味を持った人が試したくなる。そのとき:

- VS Code 拡張をインストールするだけで音は出せる
- だが「何を書けばどう鳴るか」「どの順序で覚えれば全体像をつかめるか」 が `.vsix` だけでは伝わらない

`docs/user/ja/USER_MANUAL.md` (741 行) は仕様書としては網羅的だが、**仕様書を読み下せる読者層は限定的**。初心者は手順 → 試す → わかる → 次の手順、というシーケンシャルな学習を求める。

### 応答としての本サイト

`sites/user/` を **「やりたいこと → やり方」 順に再構成した usage-oriented リソース** として整備する:

- 章 1〜3: 「とにかく音を出す」 まで
- 章 4〜8: 「自分の作りたい音楽を作る」 ための個別技法
- 章 9〜10: リファレンス + トラブルシューティング

トーンは ですます調、初心者の不安に寄り添う書き方で、**しかし子供扱いはしない**（「〜だよ！」「やってみよう！」 のような幼稚なトーンは避ける）。

### Single Source of Truth (SoT) 階層

```
真の階層:
  code             ← 実行レベルの真実 (動作の SoT)
  DDD ドキュメント   ← 意図レベルの SoT (yamato が真実を保証)
  user site        ← DDD 由来の derivative (本サイト、ユーザー読者向け)
  dev learning site ← DDD 由来の derivative (実装学習用)
```

**重要**: user サイトは `docs/user/ja/USER_MANUAL.md` および `docs/user/ja/GETTING_STARTED.md` を **primary source として再構成**する。code 直接引用は不要（dev サイトとはここが大きく異なる）。

DSL 仕様の真実は `docs/core/INSTRUCTION_ORBITSCORE_DSL.md`、ユーザー向け説明の真実は `docs/user/ja/USER_MANUAL.md`。user site はその UX 寄り表現で、両者を参照しながら初心者向けに再パッケージする。

---

## 2. Skill Phase 1 — 事前確定事項 (interview を skip するための pre-filled answers)

skill の Phase 1 (Discovery interview) では audience / scope / language 等を grilling するが、本プロジェクトでは以下の通り確定済。skill 起動時は再 interview しない。

| 項目 | 確定値 |
|---|---|
| **audience** | 完全初心者（音楽プログラミング・コーディングどちらも経験浅め）。小学校高学年〜中学生でも理解できる平易さを目標とする |
| **content language** | 日本語 only (initial)。英語版は別 issue で on-the-web / CronCreate routine を使って後追い |
| **primary source** | `docs/user/ja/USER_MANUAL.md`、`docs/user/ja/GETTING_STARTED.md`、`examples/*.orbs` |
| **secondary source** | `docs/core/INSTRUCTION_ORBITSCORE_DSL.md`（DSL 仕様の真実、必要時に確認） |
| **scope (含む)** | DSL 構文の使い方、典型的なライブコーディング workflow、トラブルシューティング |
| **scope (含まない)** | 実装内部（dev サイトに譲る）、SuperCollider 内部、ICMC 論文内容 |
| **voice / tone** | ですます調、friendly、kind、子供扱いしない、技術用語は適切に噛み砕く |
| **math rendering** | 不要（KaTeX 依存を入れない） |
| **diagram density** | low — Mermaid 必要時のみ。動画・GIF・スクリーンショット動画は使わない（コスト対効果） |
| **interactivity** | なし — 単純 Markdown のみ。WASM 化された Rust エンジン経由の interactive demo は将来の別 issue |
| **bridge chapter** | 不要 |
| **external audit** | advisor で代替 (詳細は §5) |
| **research depth** | beginner-friendly recompose（仕様逐語ではなく、初心者の頭で再構成） |
| **deploy target** | コンテンツ完成後に別 issue で判断（GitHub Pages 想定）|

---

## 3. Skill Phase 4 — Site Location & Structure

### ディレクトリ

```
sites/user/                  ← VitePress project root
├── package.json             ← @orbitscore/user-site
├── .vitepress/
│   ├── config.ts            ← title, lang ja-JP, srcExclude
│   ├── sidebar.ts           ← 10 章フラット構成
│   └── theme/
│       └── index.ts         ← default theme re-export
├── index.md                 ← 章 1 「OrbitScore とは」 兼 landing
├── STYLE_GUIDE.md           ← user 用簡易 style guide (srcExclude 対象)
├── README.md                ← サイト運用 README
├── getting-started/
│   ├── installation.md      ← 章 2
│   └── first-sound.md       ← 章 3
├── basics/
│   ├── patterns.md          ← 章 4
│   ├── multiple-sequences.md ← 章 5
│   ├── polyrhythm.md        ← 章 6
│   ├── audio-manipulation.md ← 章 7
│   └── live-coding.md       ← 章 8
├── reference/
│   └── methods.md           ← 章 9
└── troubleshooting.md       ← 章 10
```

### 章構成の原則

- **目的別フラット**: dev サイトの「code tree mirror」 とは異なる。ユーザーが「やりたいこと」 から逆引きで章にたどり着けるように
- **シーケンシャル前提**: 章番号順に読み進めれば学習曲線が滑らかになる構成
- **横断参照**: 章 9 リファレンスは他章から飛んで来る用途を想定

---

## 4. Skill Phase 5 — Writing 規律 (user 専用、dev とは別)

dev サイトの「code を verbatim 引用」「`<file>:<start>-<end>` line range」 規律は **user サイトでは適用しない**。理由: 初心者向けの説明では line range 引用は逆に難読化要因。

### 採用する規律

#### Frontmatter 必須項目（緩和版）

各章 Markdown の先頭に YAML frontmatter:

```yaml
---
title: <chapter title>
description: <one-line summary>
---
```

`verified-against` (commit-sha) や `status` (draft/reviewed/stable) は user では不要。代わりに「primary source の USER_MANUAL.md / GETTING_STARTED.md / examples/ と整合する」 ことを advisor audit で検証する。

#### コードブロック

- DSL コード例は **`examples/*.orbs` にある書き方と整合**するように
- ファイル名 (`.orbs` 拡張子) を含める（例: `demo.orbs`）
- 本文中で必要なら example file への link で済ませる

#### トーン

- **ですます調**を統一
- 「〜してみてください」「〜できます」 のような穏やかな指示
- **以下のような幼稚なトーンは禁止**:
  - 「〜してみよう！」「〜だよ！」「やった！できたね！」
  - 過剰な絵文字（🎉、🚀、✨ 等の連発）
  - 子供扱いの励まし
- 技術用語は適切に噛み砕く
  - 例: 「DSL」 → 初出時は「特定の用途に特化した小さなプログラミング言語」 と添える
  - 例: 「シーケンス」 → 初出時は「音のパターンの 1 まとまり」 と添える
- 失敗・エラーへの言及は「もし動かない場合は…」 のように断定を避ける

#### 図

- 動画・GIF・スクリーンショット動画は **使わない**
- 必要に応じて Mermaid 図のみ
- 静止画（PNG / JPG）も基本不要、 どうしても必要なら個別判断

### Phase B 以降の writing agent dispatch 時の必須事項

`.claude/skills/vitepress-learning-site/references/writing-agent-template.md` の prompt skeleton に加え、**user 用の追加規律**:

1. ですます調の徹底（agent 出力で「だ・である」 が混入しないよう明示指示）
2. 子供扱いトーンの禁止（具体例を prompt に列挙）
3. primary source からの逸脱禁止（USER_MANUAL.md にない仕様を勝手に追加しない）
4. 動画・GIF への言及禁止
5. 章相互の cross-reference は VitePress link 構文で（`[章名](./other.md)`）

---

## 5. Skill Phase 8 — Audit Substitution

dev サイト同様、advisor 単段で十分（user 向けは hallucination リスクが dev より低い、primary source の USER_MANUAL.md が SoT として機能するため）。

### 必須運用

- 各章 writing agent output は advisor audit を 1 回経てから commit
- audit で flag された箇所は writing agent に渡して fix の二巡目
- **最終 check は著者**: ですます調が崩れていないか、子供扱いトーンが入っていないか、説明が初心者にとって自然か

### Future Upgrade

- 著者以外の初心者ユーザーに読んでもらってのフィードバック収集（post-ICMC）
- en 翻訳時に native speaker review

---

## 6. Skill Phase 9 — Deployment

- **Initial**: local-only (`docs:dev` で hot reload)。飛行機内オフラインでも動く
- **post-content-completion**: 別 issue で判断
  - 候補: GitHub Pages、Vercel、カスタムドメイン
  - URL 案: `signalcompose.github.io/orbitscore/`、`orbitscore.signalcompose.com`、`orbitscore.dev` 等
  - dev サイトの URL とは別パスを与えるか、user を default にして dev は `/dev` 配下に置くか、はデプロイ時に決定

---

## 7. 未決事項 — 別 issue で順次決定

- [ ] 英語版翻訳の workflow（on-the-web vs CronCreate routine vs 手動）と着手時期
- [ ] Web デプロイ先（GitHub Pages / Vercel / 独自ドメイン）と URL 構造
- [ ] マーケットプレイス公開後の install ページ更新
- [ ] WASM 化 Rust エンジン経由の interactive demo 埋め込み（はるか先）
- [ ] 章 9 リファレンスの auto-generation（USER_MANUAL.md からの抽出を仕組み化するか）

---

## 8. 関連ドキュメント

- [`.claude/skills/vitepress-learning-site/SKILL.md`](../../.claude/skills/vitepress-learning-site/SKILL.md) — skill 本体
- [DEV_LEARNING_SITE.md](./DEV_LEARNING_SITE.md) — dev 学習サイトの project brief（本ファイルのテンプレート元）
- [USER_MANUAL.md](../user/ja/USER_MANUAL.md) — user サイトの primary source
- [GETTING_STARTED.md](../user/ja/GETTING_STARTED.md) — user サイトの primary source
- [Issue #174](https://github.com/signalcompose/orbitscore/issues/174) — 本サイト構築 issue
- [CLAUDE.md](../../CLAUDE.md) — skill 起動時の必須読み込み指示
