# Dev Learning Site — Project Brief & Skill Overrides

**Status**: Brief 確定 (2026-05-05)、scaffold は別 issue で対応予定
**Skill**: [`.claude/skills/vitepress-learning-site/`](../../.claude/skills/vitepress-learning-site/) (yuichkun/.claude 由来、verbatim install、作者承諾済)
**Skill upstream pin**: [yuichkun/.claude `66e544d704cf57ee6256a4dfe7eddc8097b53381`](https://github.com/yuichkun/.claude/tree/66e544d704cf57ee6256a4dfe7eddc8097b53381/skills/vitepress-learning-site) (install 時点)
**Related Issue**: [#160](https://github.com/signalcompose/orbitscore/issues/160) (skill install)

> **用語**: 本文書の「post-ICMC」は **ICMC 2026 Hamburg (2026-05-10 〜 16)** 開催以降を指す。当該会期前に着手しない作業項目すべてに該当。

---

## 1. 位置付け — なぜ作るか

### 動機

OrbitScore は LLM (Claude Code 等) を主要な実装担当として運用している。これは速度・カバレッジで利点がある一方、**実装レイヤーの理解が著者 (yamato) 側に蓄積しない** 構造的弱点を生む:

```
従来開発:    仕様考案 → 実装 → 動作確認
            (理解は実装作業中に副産物として獲得される)

LLM 駆動:    仕様考案 (人) → 実装 (LLM) → 動作確認 (人)
            (実装段階の "書きながら理解する" ステップが消失)
```

その結果、著者は **仕様レイヤーの理解** (自分で考えた) と **挙動レイヤーの理解** (テストした) は持つが、**実装レイヤーの理解は構造的に欠落** する。これは LLM 駆動開発に固有の deficit で、放置すれば「ブラックボックス債務」 として累積する。

### 応答としての本サイト

dev 学習サイトを正規のフェーズとして開発サイクルに組み込むことで、3 レイヤーの理解を揃える:

```
新サイクル:  仕様考案 → 実装 → 動作確認 → dev 学習サイト更新 → (人による読解と編集)
                                            ↑ 実装レイヤー理解の獲得儀式
```

LLM が code から explanation を draft → external audit が hallucination を潰す → 著者が読んで違和感を感じ、code に戻り、編集する。**サイト更新作業 = 学習作業** という運用。

### Single Source of Truth (SoT) 階層

本サイトは **DDD 由来の derivative であって SoT そのものではない**:

```
真の階層:
  code             ← 実行レベルの真実 (動作の SoT)
  DDD ドキュメント   ← 意図レベルの SoT (yamato が真実を保証)
  user site         ← DDD 由来の derivative (ユーザー読者向け)
  dev learning site ← DDD 由来の derivative (実装学習用)
```

dev サイトは「ドキュメント」ではなく **「個人の学習ノート」** として運用する。各章 top に「現時点の理解の snapshot」 disclaimer を入れ、code との drift は document するが解消はしない (artifact framing)。

---

## 2. Skill Phase 1 — 事前確定事項 (interview を skip するための pre-filled answers)

skill の Phase 1 (Discovery interview) では audience / scope / language 等を grilling するが、本プロジェクトでは以下の通り確定済。skill 起動時は再 interview しない。

| 項目 | 確定値 |
|---|---|
| **audience** | self (yamato、実装学習が主目的)。contributor onboarding は副次効果として歓迎 |
| **content language** | 日本語 only (start)。en は post-ICMC で i18n 追加検討 |
| **primary source** | own codebase: `packages/engine/src/`、`packages/vscode-extension/src/` |
| **scope (含む)** | parser / DSL runtime / scheduler / audio / vscode-extension の **内部実装** |
| **scope (含まない)** | SuperCollider 内部、Vue 内部、VS Code API 内部 (引用と link に留める) |
| **voice / tone** | technical-explanatory、sempai 寄り (warmth 中程度)。詳細は STYLE_GUIDE で確定 |
| **math rendering** | KaTeX 必要 (BEAT_METER 関連、MLTS 数式) |
| **diagram density** | Mermaid 中程度 (architecture overview / data flow) |
| **interactivity** | low — Vue component は必要時のみ (timing 図など state visualization が効く章) |
| **bridge chapter** | 不要 (本サイト自体が ulterior project への bridge ではない) |
| **external audit** | advisor で代替 (詳細は §5) |
| **research depth** | spec-grade (primary source = code 自身、reading 時は逐語引用) |
| **deploy target** | post-ICMC で GitHub Pages、initial は local-only (`docs:dev`) |

---

> **Skill Phase 2 / 3 の扱い**: Phase 2 (Source research) と Phase 3 (Plan & user sign-off) は本ファイルでは事前確定事項を持たない。両 Phase は skill 本体 ([`SKILL.md`](../../.claude/skills/vitepress-learning-site/SKILL.md)) の手順通り、章を起こす都度に実行する (該当章が依拠する code path / 外部仕様の bind、章プラン起案 → 著者 sign-off)。

## 3. Skill Phase 4 — Site Location & Structure

### ディレクトリ

```
sites/dev/                  ← VitePress project root
├── .vitepress/
│   ├── config.ts
│   └── theme/
└── src/
    ├── index.md            ← landing
    ├── parser/             ← packages/engine/src/parser/ を mirror
    ├── audio/              ← packages/engine/src/audio/ を mirror
    │   ├── supercollider/
    │   └── rust-engine/    ← TODO: post-ICMC で着手 (Issue #105/#107/#108、現 v1.x stack には未統合)
    ├── scheduler/
    ├── dsl-runtime/
    ├── vscode-extension/
    └── overview/
        ├── architecture.md ← 3 層構造図
        ├── decisions.md    ← ADR (architectural decision records)
        └── glossary.md
```

### 章構造の原則

- **code tree mirror**: 実装ディレクトリと章ディレクトリを 1:1 で対応させる
- **横断章は `overview/`**: 単一モジュールに紐づかない設計判断 (ADR)、用語集、全体アーキテクチャは別建て
- **章とファイルの粒度**: 1 章 = 1 module または 1 design unit (細かすぎる場合は section 分割で対応)

---

## 4. Skill Phase 5 — Writing 規律 (skill default + OrbitScore 上乗せ)

skill default の規律 (verbatim citation / `## Sources` section / unverified marker) は維持。OrbitScore 固有で **以下を追加要求**:

### Frontmatter 必須項目

各章 Markdown の先頭に YAML frontmatter:

```yaml
---
title: <chapter title>
verified-against: <commit-sha>     # この章が code と整合確認された時点の commit
verified-at: <YYYY-MM-DD>          # 確認日
status: draft | reviewed | stable  # 編集状態
---
```

`verified-against` を必須にする理由: doc rot を **document する** (解消ではない)。半年後に著者が読み返した時、章の信頼度を commit hash で判断できる。

### `## Sources` section の最低要件

skill default は URL/file path レベル。OrbitScore では:

- ファイル参照は **`<file>:<start>-<end>` の line range 付き** で記述
- 引用は逐語、再構成不可
- 外部仕様 (SC OSC protocol 等) は URL + 章/節指定

例:

```markdown
## Sources

- `packages/engine/src/audio/supercollider/scsynth-resolver.ts:76-99` — `resolveScsynthPath()` の優先順位ロジック
- PR [#155](https://github.com/signalcompose/orbitscore/pull/155) — strict mode 採用の経緯
- [SuperCollider Server Command Reference](https://doc.sccode.org/Reference/Server-Command-Reference.html) — `/s_new`、`/n_set` の正確な引数
```

### Disclaimer の必須位置

各章先頭 (frontmatter の直後) に以下相当の文を 1 行入れる:

> **Note**: 本ページは {YYYY-MM-DD} 時点での著者の reading の足跡です。code が真実、本ページはその時点の理解の snapshot に過ぎません。

---

## 5. Skill Phase 8 — Audit Substitution

skill default は別 LLM family (Codex / Gemini 等) を independent reviewer として要求。OrbitScore では:

### 採用方針

- **第 1 layer (LLM audit)**: advisor (会話 context の reviewer モデル) が writing agent の output を audit
  - rationale: vantage point が writer (= sub-agent) と異なるため genuine な独立性は確保される
  - Codex / Gemini は precondition ではない (training distribution 重複により完全独立とは言えず、必須化のメリットが薄い)
- **第 2 layer (final check)**: **著者 (yamato) によるコード照合**が最終 check
  - 重要な observation: LLM audit は同分布の盲点を共有する可能性がある。**真の独立 check は人間がコードに戻って trace する行為のみ**
  - サイトはその「trace を affordable にする」 ための足場であって、人間 trace を不要にするものではない

### 必須運用

- writing agent output は **必ず** advisor audit を経てから章として commit する
- audit で flag された箇所は writing agent に渡して fix の二巡目を回す (skill 流儀通り)
- 重要章 (architecture overview / parser core / audio engine 中核 等) は **著者自身が code と章を突き合わせる時間** をスケジュールする

### Future Upgrade

cross-LLM-family audit に格上げする選択肢は post-ICMC で検討:

- Codex / Gemini を audit phase の追加 reviewer として導入
- ハルシネーションのトリプルチェック体制 (writer / advisor / external LLM family)

---

## 6. Skill Phase 9 — Deployment

- **Initial**: local-only (`docs:dev` で hot reload)。飛行機内などのオフライン作業もこれで足りる
- **post-ICMC**: GitHub Pages に deploy
  - URL 案: `signalcompose.github.io/orbitscore-internals/` (or 独自 subdomain)
  - 公開範囲: public (OSS なので隠す理由なし、contributor 用途でも有用)
  - 「個人の学習ノート」 disclaimer は landing page でも明記

---

## 7. 未決事項 — 別 issue で順次決定し本ファイルに追記

- [ ] 章の優先順位 (parser から書く? audio から書く? small/recent な scsynth-resolver から?)
- [ ] ADR (overview/decisions/) の format (Michael Nygard 形式準拠? 独自?)
- [ ] **Routine 設計**: PR merge 時の sub-agent dispatch、verified-against 古い章の自動 flag、章更新の trigger 条件 (post-ICMC で着手)
- [ ] 飛行機内オフライン作業時の routine 動作確認 (Anthropic API は要 net、ローカルのみで完結する task の切り分け)
- [ ] STYLE_GUIDE.md の中身 (sempai トーンの具体化、コードブロック規則、図注規則)
- [ ] cross-LLM-family audit の post-ICMC 導入時期と評価指標
- [ ] チャプター粒度 — 「1 ファイル 1 章」 か 「1 module 1 章」 か (mirror 構造の解釈)

---

## 8. 関連ドキュメント

- [`.claude/skills/vitepress-learning-site/SKILL.md`](../../.claude/skills/vitepress-learning-site/SKILL.md) — skill 本体 (verbatim、yuichkun/.claude 由来)
- [`.claude/skills/vitepress-learning-site/references/`](../../.claude/skills/vitepress-learning-site/references/) — skill の reference 集 (interview-checklist, research-discipline, bootstrap-recipe, browser-verification, external-audit-template, writing-agent-template, deployment, gotchas)
- [CLAUDE.md](../../CLAUDE.md) — skill 起動時の必須読み込み指示が含まれる
- [Issue #160](https://github.com/signalcompose/orbitscore/issues/160) — skill install の経緯
