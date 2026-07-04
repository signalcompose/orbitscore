# Research: LLM 作曲スキル — OrbitScore DSL でリフを作曲させる実装方法（小エポック計画）

## 調査日
2026-07-04

## 調査目的

WCTM のテーマ調達 Option 2-b（[WCTM_EAR_PDCA_RESEARCH](WCTM_EAR_PDCA_RESEARCH.md) 記録）を実装に落とす:
**LLM に OrbitScore DSL でリフ（クルディッシュ・ダンス型・前のめりの 9 拍子・モーダル）を作曲させる「作曲スキル」**の具体的実装方法。
owner 制約 = 大きな開発にしない・**小さくエポックを積む**（各 = 数日以内・単独検証可・kill しても床が残る）。

## 調査方法

deep-research ハーネス（**Sonnet 5 × 13 agents**）: 自社資産の実地把握（Orient）→ 3角度スイープ（LLM 作曲手法 / イディオム符号化 / ループ・評価器設計）→ **敵対的検証 6 件（CONFIRMED 4 / REFUTED 1 / UNCLEAR 1）** → エポック計画起草 → **批評 → 改訂**。

---

## 最重要訂正（Orient の成果）

1. **「Pitch DSL v1.1 は Phase 1 開発中」という前提は古い — 誤り。** 実際は **v1.1 Pitch DSL は Phases 1/2/3/R/4 実装・テスト済み**（`INSTRUCTION_ORBITSCORE_DSL.md:14`・2.0.0 リリース同梱・WORK_LOG 6.131・git tag v2.0.0）。度数記法・`^N`・`mode()`・`[ ]` コード・`import chords`・タイ/`.hold()` まで揃っており、**単旋律リフを書く機能ブロッカーは無い**。
   ⚠️ **Epic #224 の子 issue チェックリスト（#225-#242）は全未チェックのまま stale**（実態と乖離）— **owner 確認/クローズ検討を推奨**。
2. **試聴経路の空白**: `npm run midi-run <file.orbs>` が実エンジン経路（parser→度数解決→MidiScheduler）で IAC へ実時間送信 — **owner の試聴は今日可能**。ただしファイル化・音声レンダは無い（`--capture`/`ORBIT_CAPTURE_WAV` は grep 0 件 = #307 未着手どおり）→ 機械解析はシンボリック層（ScheduledMidiNote[]）で行うのが現実的（音声は E6 に分離）。
3. `.claude/skills/` の前例は `vitepress-learning-site` の 1 つのみ（SKILL.md + references/ + assets/ 構成）— これを構造テンプレとする。
4. **sideman の転用可能資産**（file:line 特定済み）: `line.ts` の Barry Harris scale/cell 選択/フレーズ生成・`harmony.ts` の MODES table（出典明記付き）+ モーダルフィールド・`rhythm-section.ts` の cell ベース伴奏。**UNLICENSED/private のためコード import 不可** — 再導出・静的スナップショット複製（出典/ライセンス出自明記）の運用規律で扱う。
5. `orbit-audio-verify` の `detect_onset_matched`（テンプレート相関）等は**リフ再帰検出に転用余地**があるが PCM 入力前提 — capture seam (#307) 完成までは直接繋がらない。

## 外部調査の主要知見（検証済み）

| 知見 | 出典 |
|---|---|
| **Libretto**（Interspeech 2026）: 平文 DSL + 29 次元特徴 → コーパス百分位 → **音楽的自然言語に翻訳して返す** bounded（最大 3 周）generate-measure-revise ループで合格率 12%→39% / 62%→94%。**生の数値でなく解釈済み自然言語で返すのが鍵**（一次確認済） | arXiv:2606.22708 |
| **AI TrackMate**: タイムスタンプ付き生ラベルをそのまま LLM に渡すのは**効果的でない** — 統計サマリー → 段階的に言語化を厚くする設計に収斂（Libretto と独立に同結論） | arXiv:2412.06617 |
| **Grammar Prompting**（NeurIPS 2023・検証 CONFIRMED）: BNF 文法を in-context 付与 → LLM が最小文法を予測してから生成。few-shot DSL 生成で標準プロンプトを上回る | arXiv:2305.19234 |
| イディオム固有の様式再現は LLM の弱点: 最良モデルでも特定様式の忠実再現は **40%**（南アジア古典・直接外挿は不可だが隣接証拠） | arXiv:2606.05522 |
| 人間演奏可能性の機械検証は **CSP（音域・運指制約）が確立した実務**（検証 CONFIRMED） | Anders & Miranda 2011 §3.6 |
| 山下洋輔様式の英語圏体系分析は限定的（Atkins "Blue Nippon" 等はあるが技術的様式分析は薄い・検証で訂正）。「クルディッシュ・ダンス = 9 拍子・前のめり」は一次資料で確認（「9/4」表記までは未確認） | 検証 REFUTED/UNCLEAR |

**設計含意**: ①出力スキーマ固定 + **部分 BNF の in-context 提示**（Grammar Prompting）②フィードバックは**常に音楽的自然言語**（生スコア/生数値禁止 — 2 論文が独立収斂）③様式忠実度は LLM 単体では届かない前提で**人間キュレーションを実質的品質ゲート**に。

---

## スキル・アーキテクチャ（改訂済み）

`.claude/skills/riff-composer/`（SKILL.md + references/ + assets/・vitepress-learning-site 型）。

核 = **schedule() 構築時点で ScheduledMidiNote[] を同期抽出**（E1・LOOP なし有限 play() に限定）→ E2 構造/playability ゲート + E4 記号動機検出器（**局所リズムセル再帰に限定・スコアは revise/選抜のゲートに使わない固定制約**）+ 任意 E5 LLM 二次ランカー → JSON 候補台帳（.orbslog とは別）→ **Artifact でピアノロール + スコア提示 → 人間が選ぶ**（E3・様式面の自然言語フィードバック経路あり）。SKILL.md 内に Pitch DSL 部分 BNF + パーサエラーを revise 指示に使用。音声試聴（E6）は分離・任意。

## エポック計画 E0-E6（批評→改訂済み）

| E | 内容 | 工数 | kill（要点） |
|---|---|---|---|
| **E0** | **今日の資産で動く最小**: Claude Code が Pitch DSL でリフ候補 2-3 案 → `midi-run` で IAC → owner 試聴。**新規コードゼロ**。着手前に依拠機能の実コード現存を 1 行チェック（#224 stale のため issue 状態を信用しない） | 1日 | 表現力の失敗（ハック必須）→ 停止・owner 報告 / 様式的に空疎 → E0 は kill せず E3 の様式フィードバックへ持ち越し |
| **E1** | **ノートリスト抽出ハーネス**: schedule() 構築時点の同期抽出（fire-time タップでなく）。LOOP なし有限 play() に限定（LOOP 対応は follow-on issue に分離）。既存 fake-timers テストの型を踏襲 | 2日 | **第一検証 = wall-clock を待たず全ノートが同期確定するか**。否なら owner エスカレーション（クロック注入 fix vs N 数を絞る） |
| **E2** | **構造/playability ゲート**（純関数）: 音域/跳躍/密度/休符比/反復数。閾値は sideman パターンの**再導出**（コード import 不可）+ 公開文献。参照する sideman 由来文書は出典/ライセンス出自明記で docs/research/ に複製してから使う | 2日 | good/bad ペアで判別不能なら追加投資を止め E4/人間キュレーションへ |
| **E3** | **スキル本体**: compose → extract → score → **bounded revise（最大 3 周・Libretto 実績）** → JSON 台帳 → Artifact で N 案並置 → 人間が選ぶ。revise は音楽的自然言語 + **owner の様式フィードバック経路**。sideman 出力は構文 exemplar 限定（bebop 語彙の混入防止） | 3日 | ルールスコアが「直接読む」を超えないなら単純化 / 2 セッションで様式的に妥当 0 ならプロンプト設計見直し / 初回に 1 候補あたりレビュー時間を実測しラウンド数を再確認 |
| **E4** | **記号動機/自己相似検出器**（機械可聴性の本体・**論文候補**: Schuller vs Givan 論争の記号データ検証角度）。**0.5 日 survey 先行**（music21 等の転用可否）→ 実装。範囲 = **局所リズム/ピッチセル再帰に限定**（PR #372 の「形式は特徴量から創発しない」知見に基づくスコープ固定）。**E4 スコアを E3 のゲート/報酬に使わない = 固定制約**（検出器にしか聴こえない曲への循環防止） | 0.5+3日（survey 後再見積り） | 強/弱動機性ペアで判別不能なら当面ペンディング（E1-E3 の床は無傷） |
| **E5** | LLM-judge = **非ゲートのソフト二次ランカー**（LLM はフォーム判定に系統的に弱い検証済み知見のため表示のみ） | 1日 | 人間の最終選択と無相関なら表示から外す |
| **E6** | 音声試聴（分離・任意）: (a) Artifact 内 Web Audio 簡易シンセ or (b) capture seam (#307/#365) 完成待ち。**方式は着手前に owner 確定**（着手後切替は追加工数） | 2-3日 | (a) の音色が聴感判断を誤らせるなら停止・再協議 |

依存: E0 → E1 → E2 → E3（床の完成）。E4 は E1 のみ依存・E5/E6 は E3 の拡張。**どの kill でも E3 までの床は残る**。

## owner 決定事項

1. **計画全体の位置づけ**: WCTM 本番の楽曲そのものを作るためか、独立した作曲支援ツールの試作か（前者ならリハ W6 等との時間配分を確定）
2. E4（研究寄与・論文候補）を今追うか post-concert に回すか
3. E6 の方式: (a) Web Audio 即席シンセ vs (b) capture seam 完成待ち（着手前に確定必須）
4. E5 の LLM-judge に作曲側と別モデルを使うか（自己採点バイアス回避）
5. N（候補数）× ラウンド上限: E3 初回のレビュー実測時間と 08-07 までの残り時間から逆算
6. E0 kill 時: Pitch DSL 拡張（大）か近似で妥協（小）か
7. E1 で wall-clock 発火が実証された場合: engine への クロック注入 fix（小さいが engine スコープ拡大）か N を絞るか
8. **Epic #224 の stale チェックリストの扱い**（実態 = 実装済みと乖離・クローズ/更新の判断）

## リスク（要点）

- クルディッシュ・ダンス様式の一次資料は薄い → E2/E4 の指示文は類推文献依存・**様式忠実度は本質的に近似**（隣接証拠 40% を踏まえ人間キュレーションを実質ゲートに維持）
- E1 の wall-clock 問題が床全体の前提 → **他のどの epoch より先に検証**
- sideman 資産の誤用（bebop 語彙の混入・UNLICENSED 越境参照）→ 構文 exemplar 限定 + 複製運用の規律
- E3 のキュレーション疲労（N×ラウンドのレビュー負荷）→ 初回実測でラウンド数を決める
- E4 のスコープ限定（局所再帰）が将来の統合議論で無自覚に拡大するリスク → 仕様上固定として扱う

## 出典（主要）

- arXiv:2606.22708（Libretto・一次確認）/ 2412.06617（AI TrackMate・一次確認）/ 2305.19234（Grammar Prompting・検証済）/ 2606.05522（様式忠実度 40%・一次確認）/ Anders & Miranda 2011（CSP playability・検証済）
- 社内: INSTRUCTION_ORBITSCORE_DSL.md:806-985（Pitch DSL 実装済リファレンス）/ PITCH_DSL_SPEC_v1.1.html（正本）/ midi-run.ts / orbit-audio-verify（onset.rs/analysis.rs）/ WCTM_EAR_PDCA_RESEARCH.md / WCTM_MACHINE_LISTENING_RESEARCH.md
- sideman（private・UNLICENSED）: line.ts / harmony.ts / rhythm-section.ts — 再導出・静的スナップショットのみ

## 本調査の限界

- Libretto/AI TrackMate 以外のマルチエージェント系（ComposerX/CoComposer 等）は WebSearch 要約ベース（本文未 fetch・medium）
- 山下洋輔様式の技術的分析は英語圏資料が薄く、検証でも UNCLEAR が残る（「9 拍子・前のめり」は一次確認済・「9/4」表記は未確認）
- E1 の schedule() 同期確定仮説は**未検証**（E1 の第一タスクがその検証）
