# OrbitScore 開発地図 — ネイティブ線（NATIVE DEVELOPMENT MAP）

**制定**: 2026-09-11（起案: Fable subagent〔effort: xhigh〕/ 検収: main / 裁定: owner・#848）
**位置づけ**: **凍結線（O-surface 完了・`NATIVE_MIGRATION_2026-09.md` §12.2）を越えた後の開発計画の正本。** 凍結線までは [`DEVELOPMENT_MAP.md`](DEVELOPMENT_MAP.md)（拡張版の地図）が正本のまま。**両者は同時に生きる**が、主語が違う（拡張版 = 凍結と `.vsix` の保守 / 本地図 = ネイティブ OrbitStudio.app と層 1 / 2 の続き）。
**入力**: [`848-native-orbitstudio-design.md`](../design/848-native-orbitstudio-design.md)（設計・完了条件）/ [`IMPLEMENTATION_PLAN_NATIVE.md`](IMPLEMENTATION_PLAN_NATIVE.md)（段・束）/ [`NATIVE_MIGRATION_2026-09.md`](NATIVE_MIGRATION_2026-09.md) §12（裁定）/ 旧地図 §3・§4（engine 線の節を**番号で**参照する）

> **この地図が答える 4 つの問い**
> 1. **現在地** — 何が在って何が無いか（§3・証拠は `path:line` か PR / commit。**推測では書かない**）
> 2. **リリースまでの筋** — 第 1 リリースが閉じるまでの 1 本の順序（§3）
> 3. **本線と枝葉** — 何を先に、何を後に、何をやらないか（§2・§5・§6）
> 4. **新規起票の判断基準** — 地図に無い作業はまず地図を直す（旧地図 §0.2 と同じ運用）
>
> **書かないこと**: 個別 PR の実装詳細（計画と設計の仕事）・日程・工数・可否（owner の領分）。

---

## 0. 使い方と運用規則

- **記号・運用規則は旧地図 §0.1 / §0.2 をそのまま使う**（✅ 実装済み / 📐 設計済み / ○ 未着手 / ❓ 未確認 / 🔴 塞いでいる / 🚪 リリース前に必要）。起票前に本地図の節を探し、無ければ地図を直す PR が先。issue 本文の先頭に `NMAP §4.X` と書く（旧地図の `MAP §4.X` と区別する）
- 🔴 **「実測」は出典（日付 / PR / commit / ファイル:行）を併記する**（旧地図 §0.2 規則 8）
- 🔴 **事実が変わった瞬間に更新する**（旧地図 §0.2 規則 7・`BUNDLE_BRANCH_WORKFLOW.md` §5.1b）
- 🔴 **凍結版に触らない**: 本地図から起きる作業は `packages/vscode-extension/**` と `packages/engine/src/cli/repl-mode.ts` を変更しない（設計 §10.3）。凍結版の bug fix は旧地図の運用で
- `tests/docs/planning-issue-state.spec.ts` の `DOCUMENTS` に本地図と `IMPLEMENTATION_PLAN_NATIVE.md` を足す（設計 D-8・**main の follow-up**・本 PR は `tests/` を触らない）

### 0.1 旧地図との関係

| 文書 | 扱い |
|---|---|
| `DEVELOPMENT_MAP.md`（拡張版） | **凍結版の正本**。§3 の `release-gate` 連鎖（ラック・配布）は**本地図 §3 が引き継ぐ**。§4 の engine 線の節（4.A ミキサー / 4.B ラック / 4.D パラメータ / 4.E DSL 拡張 / 4.F 診断 / 4.G E2E / 4.H 可視化 / 4.I 堅牢性 / 4.L audio DSL / 4.O 性能 / 4.P 入力）は**中身をここに写さず番号で参照**する |
| `IMPLEMENTATION_PLAN_2026-09.md`（拡張版） | 凍結版の計画。engine 線の PR は**正本のまま**。拡張側に触る行の付け替えは `IMPLEMENTATION_PLAN_NATIVE.md` §4.1 |
| `NATIVE_MIGRATION_2026-09.md` | 移行の判断と根拠。**§12 が裁定**。本地図はその上に立つ |
| `POST_2.0_ORBITSTUDIO_PLAN.md` / `POST_2.0_ENGINE_AND_DISTRIBUTION.md` | VSCodium 版の歴史的計画。**新しい判断の根拠にしない**（フォークは畳んだ・裁定 2.6） |
| `docs/design/656-release-design.md` | 配布の設計。**再設計しない**。裁定 10 件と回答 8 件を引き継ぐ / 失効に仕分けした表は設計 §9.0。VSCodium 前提の部分（§3.4・§4 の段 3〜7・§5.4 (b)・§6.2・§16 (4)(5) の bundle id・(7)）が失効 |
| `docs/development/POST_2.0_ROADMAP_NOTES.md` / `POST_2.0_ENGINE_AND_DISTRIBUTION.md` | **engine-first** と層 1 の確定事項。引き継ぐ（設計 §0b） |
| `docs/research/EDITOR_HOST_AND_APP_SIZE.md` | 「自作しない」の結論は裁定 2.2 で失効。**vscode 依存 4,405 行の内訳**（= 編集面の配線）は §4.B パリティの母集団として引き継ぐ |
| `docs/research/NATIVE_ENGINE_TRACKTION_VSCODIUM.md` | Tracktion / VSCodium は失効。「動機の核心が未検証なら併記する」作法を引き継ぐ |
| `docs/planning/post-icmc/ELECTRON_APP_PLAN.md` / `RUST_ENGINE_MIGRATION_PLAN.md` / `AUDIO_ENGINE_CORE_ARCHITECTURE.md` | Electron / Tauri / CodeMirror は棄却。**Engine-as-a-Service（複数フロント・背骨 1 つ）と「橋渡しはプロトコル」**は引き継ぐ。機能列挙は §4.B |
| `docs/research/DAW_AUDIO_ARCHITECTURE.md` | 「graph は engine が所有し UI は描くだけ」を層 3 の境界として引き継ぐ |
| `docs/planning/USER_OUTCOMES_2026-09.md` | ユーザー視点の到達点の粒度。§3.3 に同じ形の表 |
| `docs/planning/post-icmc/COLLABORATION_FEATURE_PLAN.md` | 範囲外。層 2 の中を変えずに後から乗せられることだけ確認（設計 §0b） |
| Serena `orbitstudio_phase0_phase1_2026-07-07` / `orbitstudio_phase2_spike_2026-07-07` | VSCodium 版 Phase 0〜2 は一度成立していた（失効）。bundle id `com.signalcompose.orbitstudio` は §7 の裁定材料 |

---

## 1. 再設計しない確定事項（本地図の前提）

| 事項 | 内容 | 正本 |
|---|---|---|
| 8 項目の裁定 | macOS のみ / Swift・AppKit / Monaco / Rust engine 不変 / 拡張は凍結 / フォークは畳む / モノレポ / claude-code 非同梱 | `NATIVE_MIGRATION` §2 |
| 凍結線と新ラインの順序 | 凍結線 = O-surface / O-multiout が新ラインの最初の束 / ステージ 3〜7 は生きる / ステージ 8 は再定義 / 凍結の翌日から新ライン | 同 §12 |
| リリースの前提 | **ラックはリリースの前提**（新ラインに対して生きる）。**凍結版 ≠ リリース** | 同 §12.2 / memory `racks-are-a-release-gate` |
| GUI | GUI の操作結果は必ず DSL テキストに落ちる（#681）。確認・停止を挟まない。窓は勝手に開閉しない | 旧地図 §1 / memory |
| LLM | 第一級ユーザー。DSL 経由。MCP はユーザーと同じ動線 | 旧地図 §1 / memory `orbitstudio-shared-medium-human-llm` |
| 投資の順位 | 1 仕様 → 2 E2E → 3 機能テスト → 4 変異（PR のクリティカルパスに置かない） | CLAUDE.md |
| 層の責務 | 層 1 = 発音（不変）/ 層 2 = セッション（`packages/session`・Node・host が所有）/ 層 3 = 編集（Swift シェル + WebView） | 設計 §3・§4 |
| プロトコル | JSON-RPC 2.0 over WebSocket・双方向・単一スキーマ・strict version | 設計 §5（🔴 確定は束 S-rpc の締め） |

---

## 2. 全体図 — 何が何の前提か

矢印は「左が終わらないと右が着手できない」。**同じ行に並ぶものは順序を持たない。** 節番号は §4。

```
  ┌── 凍結版（旧地図の領分・本地図は待つだけ）──────────────────────────────────────────┐
  │  O-surface（PR-O4）── SC 削除（#502）── README 導線 ── stable タグ                         │
  └────────────────────────────────────────────────────────────────────────────────────┘
        ↓ 凍結の翌日から（ブランチも実機も共有しない）

  [A] 層 2 セッション   N1 S-rpc 🔴 ─→ S-mcp 🔴 ─→ S-editor
                          │              └─→ headless で engine 線の E2E が回る（§4.F の束が使う）
  [B] アプリ            N0 spike 🔴 ─────────────→ N2 A-skeleton 🔴 ─→ N3 A-document ─→ A-panels ─→ A-parity 🚪
                          （IME が崩れたら Electron 検討へ・設計 §1.3）        ↑ [A] S-editor が先
  [C] プロトコル        N0-b ─→ S-rpc（v1 確定）─→ 以降は MINOR 追加のみ
  [D] 配布             N0-c ─→ R-app 🚪（bundle id / tag / node 同梱 = owner 裁定・§7）
  [E] E2E・パリティ     S-mcp（headless ターゲット + 台帳）─→ A-skeleton（native ターゲット）─→ A-parity（D-1〜D-5）
  [F] engine 線         O-multiout ─→ L ─→ R ─→ V ─→ Q/K 🚪 ─→ P   （旧地図 §4.A / 4.B / 4.D / 4.E / 4.F / 4.H / 4.O）
  [G] docs             user サイトを「アプリ」主語へ ─→ 拡張 README は導線（凍結前・旧地図）

  🚪 第 1 リリース = [B] A-parity ∧ [D] R-app ∧ [F] K（ラック #635 → #636・#669）
```

**🔴 foundation の一覧（塞いでいる相手つき）**

| 項目 | 塞いでいるもの |
|---|---|
| N0-a Monaco + IME | [B] 全部 |
| S-rpc（プロトコル v1） | [A] の残り・[B] N2・[E] headless |
| S-mcp（MCP を層 2 へ・台帳） | [E] 全部・[F] の headless 検証 |
| A-skeleton | [B] N3 |
| owner 裁定 (3)(4)(10)（node / tag / bundle id） | [D] R-app |
| K（ラック） | 🚪 |

---

## 3. 🚪 現在地からリリースまでの筋

### 3.1 現在地（2026-09-11・main `229d6387`）

| 領域 | 現在地 | 証拠 |
|---|---|---|
| ネイティブ線の成果物 | **何も無い**。`apps/` `protocol/` `packages/session/` は存在しない | `ls apps/ protocol`（2026-09-11） |
| 設計・計画・地図 | 📐 本 PR の 3 本 | `docs/design/848-…` / `docs/planning/IMPLEMENTATION_PLAN_NATIVE.md` / 本書 |
| gated ハーネスの起動先 | ✅ stock VS Code（フォーク非依存） | PR #831（2026-09-10・`WORK_LOG.md`「test(e2e): launch the gated harness from stock VS Code」） |
| フォークのビルドスクリプト | ✅ 削除済み | 同上 |
| 凍結線（O-surface） | 旧地図の領分（進行中）。**本地図は待たない** — アプリ線は独立（#848 本文） | `IMPLEMENTATION_PLAN_2026-09.md` §3 ステージ 2 |
| 層 2 の抽出可能性 | 拡張 21 モジュールのうち **19 本が `vscode` 非依存**（`mcp-server.ts` 1,417 行を含む） | `grep -L "from 'vscode'" packages/vscode-extension/src/*.ts`（2026-09-11） |
| プロトコルの現行 | `//#` メタ行 6 種 + stdout 3 系統（設計 §2）。相関ブリッジ 5 本 625 行が拡張側に重複（#757） | `grep -o '//#[a-zA-Z]*'` / 旧地図 §4.J.1 |
| 署名の材料 | Developer ID `ZWULF5LA37`・ASC API キーは手元にある。entitlements は未確認 | `656-release-design.md` §5.2-5.3 |
| 未検証（裁定 §9） | Monaco × WKWebView × **IME** / スキーマ生成ツール / 同梱 node の hardened runtime / 層 2 の多クライアント同時性（設計 §5.6 で規則を起案・**実測は S-mcp**）/ Swift の CI | `NATIVE_MIGRATION` §9 |

### 3.2 筋（順序だけ・日程は書かない）

```
 ① N0 spike（IME・スキーマ・署名）──→ ② S-rpc ──→ ③ S-mcp ──→ ④ S-editor ──→ ⑤ A-skeleton
 ──→ ⑥ A-document ──→ ⑦ A-panels ──→ ⑧ A-parity（D-1〜D-5）──→ ⑨ R-app（D-7）
 ∥ engine 線: O-multiout → L → R → V → Q/K（🚪 ラック）→ P   （headless で検証・③ の後）
 ──→ 🚪 第 1 リリース（⑨ ∧ K）
```

- ① は今すぐ着手できる（裁定待ち 0・計画 §6）
- ② 〜 ④ は拡張を触らないので凍結版と衝突しない
- ⑤ で **Electron へ戻るかの判断**が出る（設計 §1.3）。戻る場合も ② 〜 ④ は無駄にならない（transport は WebSocket のまま）
- engine 線は ③ の後、**アプリを待たずに** headless で E2E が回る。V6 / V7 / V10（可視化の表面）だけは ⑦ の後（計画 §4.1）

### 3.3 各段が終わるとユーザーは何ができるか（`USER_OUTCOMES_2026-09.md` と同じ粒度）

**凡例**: 🎵 音・操作が変わる / 👀 見える / 🧱 土台・変化なし / 📄 仕様・文書。「何も変わらない」は正直にそう書く。

| 段 | 見え方 | 終わるとできること |
|---|---|---|
| N0 spike | 📄 | 何も変わらない。Monaco が WKWebView で日本語込みで動くか・スキーマ生成・同梱 node の署名の答えが文書に載る |
| N1 S-rpc | 🧱 | 何も変わらない（利用者からは）。`orbitscore session` が単体で立ち、evaluate に応える |
| N1 S-mcp | 👀 | **エディタを開かずに** `orbitscore session --mcp` だけで、今日と同じ MCP ツールを LLM が使える。既存譜面は同じ音 |
| N1 S-editor | 🧱 | 何も変わらない。エディタが繋がった時の診断・補完・⌘Enter の中身が層 2 に揃う |
| N2 A-skeleton | 🎵 | **`OrbitStudio.app` を開き、`.orbs` を書いて ⌘Enter で音が出て playhead が動く**。日本語が打てる。保存・タブ・設定はまだ無い |
| N3 A-document | 👀 | 開く・保存・自動保存・タブ・最近使った書類・環境設定が使える |
| N3 A-panels | 👀 | デバイス選択・engine の起動停止・ログ・プラグインカタログ・docs がアプリの中で見える。flash と playhead の色が設定できる |
| N3 A-parity | 🎵 | **拡張でできたことが全部アプリでできる**（台帳が緑）。LLM がアプリと同じセッションに入って同じ譜面を評価できる |
| N4 R-app | 👀 | 署名・公証済み `.dmg` を GitHub Releases から落として、node が無い Mac でも開いて音が出る |
| engine 線（O-multiout → L → R → V → Q/K → P） | 🎵 / 👀 | 旧 `USER_OUTCOMES_2026-09.md` のステージ 2 後半〜7 の表がそのまま（アプリでも headless でも同じ DSL） |

### 3.4 `release-gate` と `must-fix`（ラベルの写像）

| ラベル | 本地図で付く先 |
|---|---|
| `release-gate` | R-app の一方通行 3 件（N-7〜N-9）/ K（#635 / #636 / #669）/ A-parity |
| `must-fix` | 凍結版の演奏が壊れるもの（旧地図の運用）。**ネイティブ線では A-parity までは付けない**（利用者がまだ到達できない） |
| `foundation` | §2 の表 |

---

## 4. 領域ごとの地図

各節: **正本** / **現在地** / **前提** / **未決**。

### 4.A 層 2 セッション（`packages/session`）

| 段 | 正本 | 現在地 | 前提 |
|---|---|---|---|
| プロトコル v1 + WebSocket サーバ + `session.evaluate` + イベント + CLI | 設計 §4・§5 / 計画 S-rpc | ○ | N0-b |
| MCP を層 2 へ（ツール 26 → 25・`force_kill_scsynth` は SC 削除で消滅） | 設計 §6 / 計画 S-mcp | ○（`mcp-server.ts` は pure で移動可・実測 2026-09-11） | S-rpc |
| document 同期・診断・補完・subject-block（層 2 の言語サービス） | 設計 §5.4-5.5 / 計画 S-editor | ○（`diagnostics-analysis.ts` / `plugin-name-diagnostics.ts` は pure。`completion-context.ts` 290 行だけ vscode 依存） | S-mcp |
| 同時性（FIFO・後勝ち・出自の記録・エディタは 1 つ） | 設計 §5.6 | 📐 | S-rpc で実装・S-mcp で実測 |
| MIDI スケジューラ / transport の Rust 化 | 裁定 §3 / 設計 §4.6 | ○・**§9「聞こえているか」の実測が先**。受け皿は doc 428（PR-Q） | 実測 |
| #757（bridge 5 本の重複） | 旧地図 §4.J.1 | 新ラインでは wire の request id で**発生しない**（設計 §15）。凍結版では OPEN のまま | — |

**未決**: (1) detach / (2) rename / (8) 複数エディタ / (9) `protocol/` ライセンス（設計 §14）。

### 4.B アプリ（`apps/OrbitStudio`）

| 段 | 正本 | 現在地 | 前提 |
|---|---|---|---|
| N0-a Monaco + IME + `file://`→`ws://` | 設計 §1.3・§7.3 / 計画 N0 | ○・🔴 **最大の未知数** | — |
| N2 walking skeleton（1 窓・Monaco・音・playhead・IME） | 設計 §1.3 / 計画 A-skeleton | ○ | S-editor・N0-a |
| N3 `NSDocument`・タブ・メニュー・環境設定 | 設計 §7.1・§7.4 / 計画 A-document | ○ | A-skeleton |
| N3 パネル（Engine / Log / Catalog / Docs）・flash・status | 設計 §7.4 / 計画 A-panels | ○（`engine-view.ts` / `playhead.ts` / `log-ring.ts` は pure で再利用可） | A-document |
| N3 パリティ台帳の完走（D-1〜D-5） | 設計 §1.2 / 計画 A-parity | ○ | A-panels |
| GUI = DSL テキストの編集面（#681・旧地図 §4.N） | 旧地図 §4.N | ○（#681 の (1) 落とし方は**アプリ線でも未決のまま**。最初の実例 #664 は engine 線） | #681 |

**未決**: (11) not-applicable にしてよい表面（`reloadWindow` / `openWalkthrough` / Learning view / `startEngineDebug`）。

### 4.C プロトコル（`protocol/`）

| 段 | 正本 | 現在地 | 前提 |
|---|---|---|---|
| スキーマ形式（JSON Schema 2020-12）と生成ツール | 設計 §5.8 / 計画 N0-b | ○（ツールは spike で確定） | — |
| v1 の確定（一方通行 N-1） | 設計 §5.2-5.3 / 計画 S-rpc | ○ | N0-b |
| `x-surfaces` と D-4 の検査 | 設計 §1.2 D-4 | ○ | S-rpc |
| 生成物のコミットと `protocol:check` | 設計 §5.8 | ○ | S-rpc |
| daemon protocol v0.2（層 1） | `protocol.rs:8` | ✅ 不変（裁定 2.4）。本地図の対象外 | — |

### 4.D 配布（ステージ 8 の再定義）

| 段 | 正本 | 現在地 | 前提 |
|---|---|---|---|
| N0-c 同梱 node の署名 spike（entitlements の実測表） | 設計 §9.2 / 計画 N0 | ○ | — |
| `make-local-release.sh`（app 版）・署名・公証・dmg | 設計 §9.2 / 656 §5.1-5.3 / 計画 R-app | ○（旧フォーク用の `make-local-release.sh` は作業ツリーに untracked で残っているだけ・裁定 §12.3「役目を終える」） | N0-c・owner 裁定 (3)(10) |
| `release-app.yml`（`app-v*`） | 設計 §9.3 / 計画 R-app | ○ | owner 裁定 (4)(6) |
| cold-install E2E（成果物に gated `native`・PATH を絞る） | 設計 D-7 / 656 §6 | ○ | R-app |
| #656 / #659 / #138（🚪） | 旧地図 §4.J | 🔴 **ネイティブ app の配布として書き直す**（裁定 §12.3）。書き直しは本地図の節から起票 | — |
| 自動更新 | 設計 §14 (5) | ○・第 1 リリース外（推奨） | — |
| Marketplace / Open VSX（#197 / #184） | 旧地図 §3 | 凍結版の話（**本地図の対象外**） | — |

### 4.E E2E・パリティ（拡張を仕様書として使う）

| 段 | 正本 | 現在地 | 前提 |
|---|---|---|---|
| `ORBIT_GATED_TARGET = vscode \| native \| headless` | 設計 §10.2 / 計画 S-mcp・A-skeleton | ○（`vscode` は今日の形・`orbitstudio-mcp-gated.spec.ts:604-610`） | S-rpc |
| `native-parity-ledger.ts`（凍結タグの `it` 題名を全列挙・未分類 red） | 設計 D-1 / 計画 S-mcp | ○（母集団は 2026-09-10 の 29 passed / 1 failed・`WORK_LOG.md`） | 凍結タグ |
| goldens の共有（native / headless で動かないこと） | 設計 D-2 | ○（`output-line-expectations.ts` / `rack-chain-gain-expectations.ts` は既存） | S-mcp |
| D-4（`x-surfaces`）/ D-5（モーダル無し） | 設計 §1.2 | ○ | S-rpc / A-parity |
| ラチェット・衛生検査・台帳（旧地図 §4.G） | `gated-sources.ts` / `dsl-e2e-coverage.spec.ts` / `gated-assertion-hygiene.spec.ts` | ✅ そのまま効く（走査対象は `gated-sources.ts` が持つのでターゲット追加で壊れない） | — |

### 4.F engine 線（層 1 / 2・旧地図の節をそのまま使う）

**中身は写さない。** 順序は計画 §4.2。

| 束 | 旧地図の節 | 本地図での位置 |
|---|---|---|
| O-multiout（PR-O5 / O6） | §4.A | **最初の束**（裁定 §12.3）。headless 不要（既存 `vscode` ターゲットでも回る） |
| L-record / L-replay | §4.A.3 | S-mcp の後は headless で検証。PR-L1b / L7 の拡張側は付け替え（計画 §4.1） |
| R-live / R-offline / R-p3 | §4.A.3 | 同上 |
| V（可視化・設定・性能） | §4.H / §4.O | 表面（V6 / V7 / V10）は A-panels の後 |
| Q / K（queue・PDC・layer・instrument rack・標準プラグイン） | §4.D / §4.B | 🚪 **K がリリースゲート** |
| P（プラグイン境界・DSL Plugin） | §4.E | DSL Plugin の登録先は層 2（`packages/session`） |
| D（診断の整合） | §4.F | PR-D2 / D6 の拡張側は付け替え（計画 §4.1） |
| I（daemon / child 堅牢性） | §4.I | 変わらない |
| 入力（レコーディング） | §4.P | 着手しない（旧地図の裁定） |

### 4.G docs

| 段 | 現在地 | 前提 |
|---|---|---|
| user サイトを「アプリ」主語へ | ○ | A-parity（表面が確定してから） |
| dev サイト `sites/dev/editor/`（`vscode-architecture.md` 1,037 行ほか）にネイティブ線の章 | ○ | S-rpc（プロトコルが確定してから） |
| `CLAUDE.md` を層ごとに（`packages/session/` `apps/OrbitStudio/` `protocol/`・中身は「置かないもの」だけ） | ○ | 各束の最初の小 PR で |
| CLAUDE.md マージ前ゲートに `swift build` を足す | ○（docs・main 直行） | N0-a で sandbox の可否を確認してから |

---

## 5. 何が本線で何が枝葉か

| | 内容 | なぜ |
|---|---|---|
| **本線** | §3.2 の ①〜⑨ + engine 線の K | 第 1 リリースの条件そのもの |
| **本線だが順序を持たない** | engine 線の O-multiout → L → R → V → P | アプリ線と独立。headless で先に進められる |
| **枝葉（第 1 リリースに要らない）** | detach（設計 §14 (1)）/ 自動更新 / 複数エディタ / MIDI スケジューラの Rust 化（実測が先）/ 拡張を薄いクライアントに（凍結後・owner 明示時のみ）/ engine の別リポジトリ切り出し（裁定 §6「後」）/ `packages/engine` の rename | 戻れる側に倒し、リリース後に足せる |
| **枝葉（事務・並行）** | CLA 自動化 / `protocol/` のライセンス / `LICENSES/` 全文配置 / Link 申請の要否（裁定 §5「並行して進む事務」） | 実装を止めない。ただし `protocol/` のライセンスは**公開契約になる前**が最も安い |

---

## 6. やらないこと（本地図の期間中）

| やらない | 根拠 |
|---|---|
| Windows / Linux 対応・`cfg` 抽象の温存 | 裁定 2.1 |
| Mac App Store | サンドボックスがプラグインホスティングを許さない（`POST_2.0_ENGINE_AND_DISTRIBUTION.md` §5・裁定 2.5） |
| JUCE / Tracktion / Electron / Tauri / CodeMirror / `NSTextView` 自作 / VSCodium rebuild | 裁定 2.2・2.3・2.4・2.6・§10（設計 §0b の仕分け）。Electron は **Monaco × WKWebView × IME が崩れた時だけ**再検討 |
| 656 の配布設計の再設計 | 差分だけ（設計 §9.0）。署名・公証・cold-install の手順は 656 が正本のまま |
| 層 2 の Rust 移植・Rust に JS エンジン埋め込み | 設計 §4.2 D / E。境界を先に固定し、必要が生じたときに |
| 拡張への新機能・`extension.ts` の分割 | 裁定 2.5・§4.2。凍結版は bug fix のみ |
| `//#` メタ行プロトコルの延命・Swift での再実装 | 設計 §5.1 P-A |
| MCP を GUI プロトコルにする・LSP 化 | 設計 §5.1 P-C / P-D |
| 常駐サービス（detach）を第 1 リリースで | 設計 §4.2 C・§14 (1) |
| per-PR の macOS ランナー | owner 方針（`rust-ci.yml:1-24`） |
| WCTM 本体・ICLC | 旧地図 §4.M（このリポジトリでは進めない） |
| 入力（レコーディング #679） | 旧地図の裁定「今はやらない」 |
| Marketplace / Open VSX の判断 | 凍結版の話（旧地図 §3 要裁定）。本地図は触らない |

---

## 7. 確認できなかったこと（❓・推測で埋めていない）

| 項目 | 何を確認すれば確定するか |
|---|---|
| Monaco が WKWebView で IME 込みで動く | N0-a（owner 実機確認） |
| `file://` origin から `ws://127.0.0.1` へ接続できる | N0-a。不可なら層 2 が静的配信（設計 §7.3） |
| TextMate 文法を Monaco で流用できる（`monaco-textmate` + oniguruma WASM）か Monarch に書き直すか | N0-a（20 譜面のトークン列比較） |
| JSON Schema → TS / Swift の生成ツール | N0-b |
| 同梱 node に要る entitlements（JIT 等） | N0-c（656 §5.3 の手順） |
| Codex の sandbox で `swift build` が通るか | N0-a の最初の小 PR |
| Swift シェルの実行数（数千行のオーダーか） | N2 / N3 で `wc -l` |
| `transport.step` の通知頻度が WebSocket で詰まらないか | N2 で 1 秒あたりの通知数を実測 |
| 拡張が同梱している docs（`get_dev_doc` の資産）の実体と、アプリでの同梱形 | `packages/vscode-extension` のパッケージ内容を読む（N3 Docs パネルの前） |
| 5 ms ポーリングの MIDI が演奏で聞こえているか（裁定 §9） | capture のオンセット位置で実測（受け皿は PR-Q） |
| W-22（node 同梱）の裁定が新ラインにも及ぶか | owner（設計 §14 (3)） |
| bundle id / アプリ名 / 配布物名 | owner（設計 §14 (10)）。「OrbitStudio」は候補名のまま（`POST_2.0_ORBITSTUDIO_PLAN.md` owner 決定事項 8） |
| #848 本文の出力先 `847-…` と本 PR の `848-…` の食い違い | main が issue 本文を直す |

---

## 8. 更新履歴

| 日付 | 内容 |
|---|---|
| 2026-09-11 | 初版（#848・Fable 起案）。凍結線の先の地図として新設。engine 線は旧地図の節を番号で参照 |
