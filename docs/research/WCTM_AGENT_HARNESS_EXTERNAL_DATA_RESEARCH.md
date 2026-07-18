# Research: pi ベースの外部データ受信ハーネス ── WCTM / orbitstudio への採用検討

## 調査日
2026-06-28

## 調査目的

laiso の記事「作って使うAIエージェント —— Pi Coding Agent で足りる」を起点に、大和が提起した問い ──

> **このハーネスを orbitstudio / WCTM で採用することで、外部データの受け取りをエージェント側で可能にできるのではないか。**

を、WCTM システム仕様（`docs/specs-v2/WCTM_SYSTEM_SPEC_v1.md` §4 LLM Runtime）に照らして検討し、**本番ランタイムの選択を確定する**ための調査。結論として WCTM 本番ランタイムを **pi ベースの OrbitScore 専用ハーネス**に確定した（旧 decision #29「Claude Code 二段構え」を上書き）。本書はその判断の一次資料。

## 調査方法

WebSearch（laiso blog は 403 のため検索スニペット + 一次情報源のクロスチェック）+ 設計対話。pi の一次情報源は npm（`@mariozechner/pi-coding-agent` / `@mariozechner/pi-ai`）、Mario Zechner の技術記事、nader の解説。Claude Code の MCP push 対応状況は anthropics/claude-code の issue 群（#7252 / #33679 / #36665）。

> **スコープ注意**: 本書はランタイム**選択**の research であり、pi の API 詳細な実装ガイドではない。実装着手時は pi の最新 SDK ドキュメントを別途参照する。

---

## 結論サマリ

1. **問いの答えは Yes**。ただし解の正体は「pi が MCP に push を足す」ことではなく、**「エージェント側でイベント駆動ループを所有する」**こと。
2. **Claude Code をランタイムにできない実機制約が確定的**。MCP プロトコル自体は server→client push を持つが、Claude Code が①`resources/updated` 未実装・②push を受信しても agent 不達、の二段階で未対応。WCTM の「小節到着が特徴量を駆動する」push 型本質要件と非両立。
3. **pi-first が開発コストでも有利**。開発ツール（Claude Code）と本番ランタイム（pi）を分離すれば、測定妥当性・二重実装回避・リハ中の柔軟性で pi を最初から採るのが勝つ。「即日動く」は薄いスケルトンで確保。
4. **長期の本命は「OrbitScore 専用ハーネス」**。customTools = OrbitScore 語彙・SDK 埋め込み・.orbslog = 記憶、により Claude Code では構造的に不可能なドメイン特化が可能。演奏ハーネスと作曲ハーネスを共有コアに載せられる。
5. **ランタイムを解いても残る核心問題 = 位置検出**。「今どこを演奏しているか」（形式内位置 = bar:beat + セクション/コード）の確定は push 経路とは独立の未解決問題。要 大和確認。

---

## 1. pi coding agent とは

Mario Zechner（libGDX の作者）による**最小ハーネス + TypeScript SDK**。「完成品エージェント」ではなく「自作するための部品」である点が本質。

- コアツールは read/write/edit/bash の4つだけ。あとは `customTools` で自分で足す。
- 4モードで動く: interactive / print・JSON / **RPC（プロセス統合）/ SDK（自分のアプリへ埋め込み）**。
- `@mariozechner/pi-ai` = マルチプロバイダ統一 API（Anthropic/OpenAI/Google/xAI/Groq/Cerebras/OpenRouter ほか OpenAI 互換）、ストリーミング、tool calling（TypeBox スキーマ）、**プロバイダ跨ぎのコンテキスト引き継ぎ**、トークン/コスト追跡。
- ループ・ツール・コンテキスト・セッションは提供し、MCP・サブエージェント・権限・plan mode は「自分で組む primitive」として残す。

→ 「ハーネス層をどこに置くか自分で設計できる」ことが、汎用エージェントを使うのと質的に異なる。

---

## 2. 中核問題1: Claude + MCP の push 制約

大和の指摘: **「Claude の MCP だとデータはポーリングしないと受け取れない。」**

事実関係を切り分けると、詰まっているのは MCP プロトコルではなく **Claude Code の実装側**である。

| 層 | MCP プロトコル | Claude Code の対応（2026-06 時点） |
|---|---|---|
| `list_changed`（tools/resources/prompts 一覧更新通知） | あり | **対応済**（自動リフレッシュ） |
| `resources/updated`（subscribe → リソース変化を push） | あり | **未実装**（要望 anthropics/claude-code #7252） |
| サーバ push チャネル（`claude/channel` capability + `--channels`） | あり | **受信はするが agent に届かず UI にも出ない**（#33679 / #36665） |

→ **MCP には push API が存在する。Claude Code が①②とも未対応なのが問題**、という大和の framing が正確。特に3行目が決定的で、issue の言葉では *「Claude Code はサーバ通知を正しく受信するが、チャットに表示されず、外部イベント（webhook/CI/タイマー）はセッション中の agent に届かない」*。

WCTM は §3.2 で「特徴量はすべて音楽時間（bar:beat）でラベル付け、LLM が小節で思考できることが本質要件」= **小節の到着が特徴量を駆動する push 型**を要求する。Claude Code をランタイムにすると、これを pull / long-poll でしか実現できず、周期・レイテンシが読めない（旧 §4 A の弱点「ターン所要時間が読みにくい」が構造化する）。

---

## 3. 中核概念: 「自前ループ」= ターンを誰が発火するか

「pi で push を受け取れれば実行に持ち込めるのでは？」（大和）── 答えは Yes。ただし「自前ループ」の意味を精密化する。

エージェントの1回の実行は関数呼び出しである:

```
コンテキスト（特徴量 + .orbslog 末尾）を組む → LLM API を呼ぶ → 返ってきた DSL を評価投入
```

これを**誰が・何をきっかけに起動するか**が「ループ」。

**Claude Code**（起動コードを Anthropic が握り、編集不可）:

```js
while (true) {
  const input = await ユーザー入力を待つ()   // ← 起動トリガーはこれだけ
  エージェント1ターン(input)
}
```

push 通知が届いても差し込む先がなく、「push が来たらターンを起こす」分岐を書き足せない（= #33679 の実体）。

**pi**（「エージェント1ターン」を呼べる関数として渡す SDK。起動コードを自分で書く）:

```js
const agent = new Agent({ model, tools, systemPrompt: スキル })

bridge.on小節窓(async (features) => {        // ← ここに push が届く
  const ctx = コンテキストを組む(features, orbslog末尾())
  const result = await agent.run(ctx)        // ← LLM ターン発火
  evaluate_orbitscore(result.code)           // ← 実行に持ち込み
})
```

この `bridge.on小節窓(...)` の中で `agent.run` を呼ぶ**数行が「自前ループ」の正体**。「自前」は複雑だからではなく、起動コードを自分が書くから。

> **重要な但し書き**: pi でも LLM 推論中に非同期データは差し込めない（どの実装でも不可 = 推論は固定コンテキストの1回 forward）。変わるのは**ターンを発火する主体**がハーネスから自分のループへ移ること。個々の LLM 呼び出しは依然 request/response だが、システムとしては「外部イベントがターンを駆動する」push 型になる。

→ pi が解くのは「MCP に push を足す」ことではなく、**「Claude Code が塞いでいる①②を、自前クライアント + 自前ループで両方開ける」**こと。

---

## 4. 薄さと過剰機能の削減 ── 利点と代償

大和: 「元の設計よりかなり薄い設計になる」「Claude Code の過剰な機能を落として使えるのは利点」。

**薄さは仕様の価値観（§0.5 最小実装・§7 作らないもの）と一致する**。

- 利点: 周期/レイテンシの**予測可能性**（plan/todo/sub-agent/compaction/権限プロンプト/対話 UI といった不予測要因を落とせる）、**故障表面の縮小**（一発本番で「止まらない」を最優先）、**コンテキスト完全制御**（スキルのプロンプトキャッシュ）。
- 落とすもの: file 編集 / bash / plan mode / web 検索 ──「数小節の DSL を吐く」には不要で、本番で抱えるのは負債。

**ただし「全 overhead を落とす」ではない**。Claude Code がタダでくれていて実は欲しいものを最小で再実装する:

- **自己修復**（§3.3 の diagnostic → 1回リトライ）
- **コンテキスト窓ポリシー**（.orbslog 末尾の件数・トリミング）
- **エラー耐性**（API リトライ等。pi-ai が一部供給）

薄さの代償は「タダだが不透明/不予測」→「自分のもの・小さい・**監査可能**」への移動であり、一発本番では監査可能性はむしろ利点（ハードニング時間を8週間内に取れる前提）。

**精密化2つ**:
1. **薄い ≠ 速い**。支配的レイテンシはモデル推論そのもの（数秒）で A でも pi でも同一。pi で得るのは平均速度ではなく**予測可能性と制御**。
2. **投影演出の損失**（§6 参照）は技術ではなく演出のトレード。

---

## 5. 専用ハーネス構想 ── 演奏 + 作曲を共有コアで

大和: 「OrbitScore/orbitstudio 専用のパフォーマンスや作曲ハーネスとして作れるのは良いのでは？」── **長期の本命はここ**。汎用エージェントを使うのと専用ハーネスを持つのは、以下3点で質的に異なる（いずれも Claude Code では構造的に不可能）。

1. **ツール語彙 = OrbitScore のセマンティクスそのもの**。pi の customTools でエージェントが触る道具を `evaluate_orbitscore` / `get_performance_features` / `transpose` / `set_coupling` / `panic` / `query_lead_sheet` … にできる。§6 スキル「人間リードシートと LLM スキルを同じ度数語彙で書く = 橋」が比喩でなく実装になる。
2. **SDK 埋め込み**。pi は「自分のアプリに embed する SDK モード」を持つ。orbitstudio に**エージェントコアをライブラリとして内蔵**できる（Claude Code は app であって embed 不可）。
3. **.orbslog がネイティブな記憶**。§0.3 統一評価経路で human/agent 全部が .orbslog に残る。専用ハーネスならこれを**作業記憶・few-shot コーパス・リプレイ源**として一級市民に扱える（laiso の cman = 過去セッションログを記憶として検索、と同型。OrbitScore は .orbslog を既に持つ）。

**演奏ハーネスと作曲ハーネスを共有コアに**:

| | 演奏ハーネス | 作曲ハーネス |
|---|---|---|
| ループ | push 駆動・小節クロック・低機能・止まらない | offline・探索的・リッチな道具（変奏生成/A-B/コーパス検索/長文脈） |
| 共有 | ← OrbitScore eval 経路 / .orbslog 形式 / pi-ai モデル層 / リードシート語彙 → | |

「ライブで即興する AI を、減速させると共作 AI になる」── orbitstudio の製品ストーリーとして一貫する。

**ただし締切から守る規律**:
- 本番（08-07）は**演奏ハーネスの薄い種のみ**。作曲ハーネス・orbitstudio 埋め込みは**本番後に一般化**（§7 のリプレイヤー/L2 を本番後に送る規律と同じ）。
- 種を正しい境界（**データ源アダプタ ↔ agent-run コア ↔ OrbitScore eval/log**）で切っておけば、後で platform に伸ばせる。
- 作曲モードは未仕様。締切プレッシャー下で設計しない。

---

## 6. pi-first の意思決定 ── 開発コストの決め手

大和: 「開発コストを考えると初めから pi で専用ハーネス化した方が柔軟性がある開発ができるのでは？ 開発自体は Claude Code でやるし。」

この**「開発ツール（Claude Code）と本番ランタイム（pi）の分離」**が決め手となり、旧 §4「まず A で試作（即日動く）」の根拠を無効化した。

| | A-first（旧 §4） | pi-first（確定） |
|---|---|---|
| 統合実装 | A 足場 + 後で B = **2回** | pi = **1回** |
| 測定妥当性 | 本番経路でない（A のターン機構・compaction 込みのレイテンシは pi に移植不能） | **本番経路そのもの** |
| リハ中の柔軟性 | Claude Code の固定ターンと戦う | ループ周期/文脈/ツール/モデルを**自由に変えられる** |

**「即日動く」は失わない**: pi は薄いので「小節到着→モデル呼ぶ→eval」の極薄スケルトンを初日に動かせる。旧 A の真の価値は測定ではなく**チェーンの de-risk**（Max→Bridge→LLM→eval→MIDI→ピアノが端から端まで鳴るか）であり、これは pi のスケルトンでも取れる。

**ガードレール**: ループ実装に没頭して Phase 0 の未知（Max ビートトラッキング / Disklavier レイテンシ / Link 追従）の検証を後回しにしない ── **チェーンの薄い串刺しを最優先**。

**残るトレード = 投影演出**: 旧 A 固有の「Claude Code 画面投影 = 開発ツールがバンドメンバー」は pi-first で消える。要れば pi の TUI / 並走観測画面を新規開発。**演出判断として大和に留保**。

---

## 7. 中核問題2: 「今どこを演奏しているか」= 位置検出

大和: **「結局は『今どこを演奏してるのか？』をどう検出するか、だよなー。」**

push/pull 議論の着地点はここに収束する。**ランタイム選択とは独立に残る核心問題**。

- §3.1 の特徴量（onset/energy/register/密度）は**テクスチャ**を与えるが、**形式内位置（bar:beat + セクション/コード）**を与えない。リードシート曲（ATTYA、AABA・転調多）では LLM の最重要入力はこの形式内位置で、無いと正しいチェンジでコンプできない。
- **bar:beat（クロック位置）≠ 形式位置**: Link beat/phase は「今が何拍目か」を出すが「2 周目の A」は教えない。エンジンの小節カウントは形式を知っていればカウントできるが、人間との結合下でリピート/ヴァンプによりドリフトする。

**供給源候補**:

| 案 | 内容 | 評価 |
|---|---|---|
| (a) | オペレーター舵取り / セクション送りゲート（§5） | 確実。ただし機械が追従者寄りになる |
| (b) | エンジン小節カウント + Link beat/phase | クロック位置は出るが形式位置はドリフト |
| (c) | 音響特徴からのセクション境界推定 | 8週間では不確実。§7「作らないもの」寄り |

**推奨初期案 = (a)+(b) ハイブリッド**: エンジン小節カウントで bar:beat を、オペレーター/エンジンが保持するセクション・コード index を特徴量窓に**位置ラベル**として付す。音響ベースの自動セクション検出は本番では非目標。

**要 大和確認**: 本番の自律度をどこに置くか（介助前提で位置を「与える」か、機械に「検出させる」か）。pi-first で push 経路を解いても「**何を** push するか（位置をどう確定するか）」は別途設計が要る。

---

## 8. WCTM 仕様への反映（本調査に伴う spec 変更）

本調査の結論は以下に反映済み（同一 PR）:

- **`WCTM_SYSTEM_SPEC_v1.md`**: §4 を「pi ベース専用ハーネス」に全面改訂（4.1 なぜ変えたか / 4.2 A/B 比較を歴史保存 / 4.3 確定方針 / 4.4 コスト・ガードレール）。§3.2 に位置検出の核心メモ、§10 に Open Q 2件（位置検出問題・投影演出）、ヘッダ改訂注、構成図凡例。
- **`IMPLEMENTATION_INSTRUCTIONS.md`**: W-Runtime / ロードマップ図 / known-decisions 表 / 委譲表を pi-first に整合。
- **`DESIGN_DISCUSSION_RECORD.md`**: §14「第七議論」新規（決定 #60–#63）。
  - #60: 本番ランタイム = pi ベース専用ハーネス（#29 を上書き）
  - #61: Claude Code は開発ツール、本番ランタイムにしない
  - #62: Agent Bridge（脳なし MCP）据え置き、pi が consume
  - #63: 演奏 + 作曲ハーネスを共有コアに、本番は種のみ

**据え置き**: Agent Bridge（脳なし MCP）・統一評価経路（原則3）は不変。

---

## 9. 未解決 / フォローアップ

1. **位置検出問題（§7）は要 大和確認**。本番の自律度を決めてから特徴量窓の位置ラベル仕様を確定。
2. **投影演出の存続**（§6）は演出判断。残すなら pi TUI / 並走観測画面を新規開発項目化。
3. **pi 採用の実務**: 依存・ライセンス確認、`@mariozechner/pi-ai` のマルチプロバイダ/コスト追跡による本番フォールバック設計を W1–2 で詰める。
4. **モジュール境界**: 演奏ハーネスを「データ源アダプタ ↔ agent-run コア ↔ eval/log」で切り、作曲ハーネス/orbitstudio 埋め込みへの一般化の種にする。

---

## 出典

- laiso「作って使うAIエージェント —— Pi Coding Agent で足りる」 https://blog.lai.so/pi-coding-agent/
- Mario Zechner「What I learned building an opinionated and minimal coding agent」 https://mariozechner.at/posts/2025-11-30-pi-coding-agent/
- nader「How to Build a Custom Agent Framework with PI」 https://nader.substack.com/p/how-to-build-a-custom-agent-framework
- npm `@mariozechner/pi-coding-agent` / `@mariozechner/pi-ai`
- anthropics/claude-code issues: #7252（resources/updated 未実装）, #33679 / #36665（サーバ push が agent に届かない）
- 関連社内資料: `docs/specs-v2/WCTM_SYSTEM_SPEC_v1.md` §3-§4, `docs/specs-v2/DESIGN_DISCUSSION_RECORD.md` §14, `docs/research/WCTM_LLM_ENSEMBLE_LISTENING_RESEARCH.md`（LLM の「耳」の先行研究）
