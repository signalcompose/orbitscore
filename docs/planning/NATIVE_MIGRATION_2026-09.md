# OrbitStudio ネイティブ移行 — 検討状況と裁定

最終更新: 2026-09-10
対象リポジトリ: `signalcompose/orbitscore`

> 🔴 **読み方**: §0〜§11 は別セッションで作られた**検討状況**（実測値は PR #822 時点）。
> **§12 が 2026-09-10 の owner 裁定**で、§0〜§11 と食い違う場合は **§12 が正**。
> 裁定の要点は [`DEVELOPMENT_MAP.md`](DEVELOPMENT_MAP.md) §3 と
> [`IMPLEMENTATION_PLAN_2026-09.md`](IMPLEMENTATION_PLAN_2026-09.md) §3 からもポインタで引かれる。

---

## 0. このドキュメントの位置づけ

**議論のベースとして使う。指示書ではない。**

ここに書かれた判断は、別セッションでリポジトリの実測値をもとに検討した結果であって、確定事項ではない。各項目には根拠を併記してあるので、**根拠が間違っている、あるいは根拠は正しいが結論が導けていないと思ったら、そう指摘してほしい。**

特に次の3種類を区別して読んでほしい。

| 種別 | 扱い |
|---|---|
| **実測値**（セクション7） | リポジトリを読んで得た数値。ただし PR #822 時点なので現在の main とはずれている可能性がある。触る前に確認すること |
| **判断**（セクション2〜6） | 根拠つきの現時点の見解。再検討の対象 |
| **未検証**（セクション9） | まだ誰も確かめていない。ここが崩れると判断が変わる |

セクション10 には、検討の過程で一度言われて撤回された主張を残してある。同じ議論を繰り返さないため。

---

## 1. 全体の方向性

OrbitStudio を **macOS ネイティブアプリ（Swift/AppKit）として新規開発する**方向で検討している。あわせて VSCodium フォークを畳み、VS Code 拡張は発見経路として残して機能凍結し、Rust オーディオエンジンは書き換えずに使う。

当面の作業は **拡張版を「ステーブル」として閉じること**に絞る案になっている（セクション4）。制作が待っているため、まずここを終わらせたい、という事情がある。

---

## 2. 現時点の判断と、その根拠

### 2.1 プラットフォーム

**当面は macOS のみに集中する。macOS 版があることが最優先。**

Windows 版を作る可能性はある。ただし現状は次の状況にある。

- 開発者本人が Windows を使わない
- OS を絞るほうが、プラットフォーム抽象を挟まない分、そのプラットフォームの作法に素直に従える
- 商売として成立するなら Windows を検討する余地が出てくる

判断の根拠は**コストの非対称性**にある。今 Windows のために払うコスト（`cfg` 分岐を将来のために丁寧に書く、抽象を温存する、cpal 経由の遠回りを維持する）は確実に発生し、リターンは仮定的。**必要になった日に daemon を移植するほうが安い。**

やるとした場合の作業本体は daemon の移植（WASAPI/ASIO、CLAP/VST3 の Windows 実装、memmap2 transport の検証、署名）で、拡張側はおまけ。

現状すでにプラグインホスティングは `#[cfg(target_os = "macos")]` で構造的に macOS 専用（`rust-ci.yml` 冒頭に明記あり）。非 macOS ではスタブが即エラー終了する。CI の ubuntu-latest は clippy のみ。**つまり「今から macOS 専用にする」のではなく、すでにそうなっている状態を認めるかどうかという話。**

Linux については、現状やる予定はない。

### 2.2 OrbitStudio.app を Swift/AppKit で新規開発する

Tauri と比較して優位なのは WebView ではなく**その外側**、という見立て。

`NSDocument`（開閉・保存・自動保存・未保存確認）、ウィンドウのタブ化、メニューバー、キーボードショートカット、環境設定、find バーが AppKit 標準で付いてくる。見積もりのリスクが集中していた「退屈で時間を食う部分」がここに当たる。

なお Tauri も macOS では WKWebView を使うので、「ネイティブにすると WebView が使える」は差分にならない。

**Swift の面積はシェルだけに保つ**案。ウィンドウ・メニュー・ドキュメント管理、WKWebView ホスティングと `WKScriptMessageHandler` ブリッジ、Rust への FFI、サイドカーの起動監視。数千行のオーダーを想定。

**`NSTextView` でエディタを自作しない。** 根拠として、TZPL（James McCartney）は JUCE の `CodeEditorComponent` を使ったうえで `main_component.cpp` が 2,631行ある。

### 2.3 エディタは Monaco

TypeScript worker が同梱され、型チェック・補完・ホバー・定義ジャンプが付く。

Monaco の API は VS Code とほぼ同型（`CompletionItemProvider`, `Diagnostic`, `Range`, `Position`）なので、既存ロジックは書き直しでなく差し替えに近い、という見立て。対象は `completion-context.ts`, `dsl-method-catalog.ts`, `plugin-catalog-completion.ts`, `diagnostics-analysis.ts`。

**この判断は セクション9 の「Monaco が WKWebView で動くか」に依存している。** そこが崩れると Electron へ戻る検討が必要になる。

### 2.4 Rust オーディオエンジンは書き換えない

cpal は macOS で既に CoreAudio（AudioUnit HAL）を呼んでいる。「Rust だからネイティブでない」わけではない。

抽象を剥がしたくなる可能性があるのは Workgroup（`os_workgroup`）、aggregate device の細かい制御、ホグモード程度。必要になったら `coreaudio-sys` で局所的に叩けばよく、Swift も JUCE も要らない。

**JUCE を使わない理由**は2つ。

1. JUCE が提供する3機能（クロスプラットフォームのオーディオ I/O、プラグインホスティング、GUI ツールキット）が全部埋まっている。しかも JUCE のプラグインホスティングはインプロセスで、現行のアウトオブプロセス構成のほうがクラッシュ隔離という点では上
2. JUCE は AGPLv3 で、ルートの Signal compose Source-Available License v1.0（Apache-2.0 基底 + Commons Clause + Fair Revenue Clause）と両立しない。使うなら商用ライセンス購入かライセンス方針の放棄の二択になる

参考として TZPL は JUCE をビュー層とオーディオ I/O にのみ使っているが、それでも README に「成果物は GPL+AGPL 混合バイナリになる」と明記している。

約80,000行の Rust 資産は `orbit-audio-verify` と `ORBIT_CAPTURE_WAV` による実測 WAV の E2E で検証済み。書き換えるとこの検証済みの挙動をやり直すことになる。

### 2.5 VS Code 拡張は残すが機能凍結

残す理由として恒久的なのは **Marketplace / Open VSX という発見経路**。ネイティブアプリには店がなく、Mac App Store はサンドボックス制約でプラグインホスティングアプリを出せない。つまり Marketplace は、自社サイトと学会以外で OrbitScore が見つかる数少ない場所になる。

副次的な理由は参照実装だが、これは Phase 3 が終われば役目を終える。

「クロスプラットフォームの hedge」という理由は成り立たない。daemon が macOS 専用なので、Linux に拡張を入れても何も動かない。

この位置づけを取るなら、**凍結の内容には README とマーケットプレイス説明文を「OrbitStudio という macOS アプリがある」への導線として書き直すことが含まれる。**

### 2.6 VSCodium フォークを畳む

- リリースパイプラインに入っていない。`release.yml` が publish するのは `.vsix` のみ（GitHub Release + VS Code Marketplace + Open VSX）
- `scripts/orbitstudio/build_orbitstudio.sh` は47行の env ラッパーで、用途は gated E2E（`ORBIT_GATED_ORBITSTUDIO=1`）のみ
- claude-code 非同梱の決定により workspace trust の課題（#656 ブロッカー、`product.overrides.json` の層2）が消えた

失う資産は47行のビルドスクリプトと gated E2E のターゲット指定のみ。畳むと **"OrbitStudio" という名前と `apps/OrbitStudio/` の置き場所が空く。**

> 🔴 §12 補正: 「gated E2E のターゲット指定」は**マージゲートそのもの**なので、畳む前にハーネスの起動先を変える（§12.4）。

### 2.7 リポジトリはモノレポ維持

`signalcompose/orbitscore`、public のまま。プロトコル変更を1 PR で原子的にできることが決定的、という判断。既に npm workspaces + Cargo workspace + C++ の同居実績がある。

リリースはリポジトリでなくパイプラインを分ける案。タグ名前空間 `ext-v*` / `app-v*`、`release-extension.yml` / `release-app.yml`、`paths:` フィルタ。

### 2.8 claude-code 拡張は同梱しない

ライセンス上の問題。LLM とは MCP で通信する。

---

## 3. 3層アーキテクチャ（提案）

プロセス境界を「何がクラッシュしたら何が止まるか」で切る、という考え方。

| 層 | 性質 | 中身 | 実装 |
|---|---|---|---|
| **1. 発音** | 絶対に止まらない | オーディオ I/O、サンプル精度スケジューラ、プラグインホスト | Rust daemon、別プロセス |
| **2. セッション** | UI 再読み込みで生き残る | DSL 評価、セッション状態、トランスポート、MCP サーバ、tsserver | 常駐プロセス |
| **3. 編集** | いつ落ちてもいい | エディタ(Monaco)、パネル、パーサー | WebView + Swift シェル |

層1 をアプリに取り込まない理由は、UI が落ちても音が続くこと、拡張からも使えること、`link-audio` の GPL 隔離との整合。

### 層2 をプロセスにすることが、二本立ての成立条件になる

型付き RPC で切れば「クライアント3つ（VS Code 拡張 / OrbitStudio.app / LLM エージェント）、背骨1つ」になる。コストは2倍ではなく「1 + 薄いシェル2枚」という見立て。

**DSL の互換性は、層2 をプロセスとして切った時点で問題として消える。** 上位互換・下位互換を考える必要すらなく、同じ実装が両方に答えるので構造上ずれようがない。差が出るのはフロントエンド固有の機能（エディタの見た目、パネル、ショートカット）だけで、それは DSL ではない。

> 🔴 §12 補正: DSL 互換性は消えるが**同時性**は消えない（複数クライアントが同じセッションへ同時に eval したときの規則）。また `runSelection` の subject-block 解決（`extension.ts:2800-2815`）は DSL 意味論に近いので層 2 へ移す対象に入れる。

### 層2 の中身は段階移行する案

まず現行 TS をそのまま常駐させ、境界を型付き RPC で固定する。MIDI スケジューラとトランスポートだけ先に Rust へ落とす。残りのセマンティクス約12,600行の Rust 移植は必要が生じたときに。**境界を先に固定すれば中身の言語は後で変えられる**という考え方。

Node を完全に捨てたい場合の中間案として、Rust プロセスに JS エンジンを組み込む選択肢（`rquickjs` 約1MB / `deno_core` 約30-40MB）がある。ただし unworklet を製品内でビルドさせるなら JS ランタイムは避けられない。

### プロトコルは作り直す案

`//#` メタ行（チャンネルが1本しかなかったことへの適応）を廃し、型付き RPC のメソッド + リクエスト ID + イベントストリームへ。`evalMark` は不要になる。

daemon の protocol v0.2 と同じ流儀（serde、バージョン + capabilities ネゴシエーション）を層2 に適用し、**単一スキーマから TS / Rust serde / Swift Codable を生成**する。

### MCP サーバは層2 に置く案

現在は拡張内（`mcp-server.ts` 1,417行）でエディタ寿命に結合している。層2 に下ろすと、エディタを閉じてもエージェントが動き、拡張とアプリが共有し、**既存の gated E2E ハーネスが両フロントエンドを検証できる**（二本立てで一番怖い「片方だけ壊れる」の防止）。

### GUI の設計制約

UI に特権的な経路を作らない。つまみを回したときに層2 に送るのは、DSL を書いたときと同じコマンド。

新しい GUI は WebView で作る。`createWebviewPanel` にも `WKScriptMessageHandler` 経由の `WKWebView` にも同じものが載る。TreeView / QuickPick 等の VS Code ネイティブプリミティブは使わない。

### ディレクトリレイアウト案

```
rust/crates/                 層1（現状のまま）
packages/session/            層2（現 packages/engine。「engine」が層1と層2の
                                  両方を指す曖昧さを解消するためリネーム）
packages/vscode-extension/   層3-a
apps/OrbitStudio/            層3-b（Swift + Xcode）
protocol/                    単一スキーマと生成物
```

`CLAUDE.md` を層ごとに配置する。

---

## 4. 当面の作業範囲についての提案

**案: 拡張版を「ステーブル」として閉じることに絞り、新機能は足さない。**

根拠は、中途半端な状態で機能を足すと結局 `extension.ts` に戻ること、および制作が待っていること。**ここは実際に着手する前に一度合意を取りたい部分。**

> 🔴 §12 で合意済み。凍結線と順序は §12 を見ること。

### 4.1 完了条件の案

#### (1) 拡張の機能凍結を宣言する

- 以降はバグ修正のみ
- 新機能は層2 へ
- README とマーケットプレイス説明文を、OrbitStudio への導線として書き直す

#### (2) SuperCollider 資産を出荷から外す

凍結する版に死んだ経路を残さないため。**サイズが理由ではない**（約11.5MB はノイズ。500MB は Electron）。理由は GPL-3.0 同梱の解消、死んだ経路の除去、CI 時間。

| 場所 | 内容 |
|---|---|
| `.github/workflows/release.yml` | `npm run build:bundle` ステップ（`scripts/extract-scsynth-bundle.sh`、ステップ名に "~11.5 MB" と記載）、SuperCollider をソースからインストールするステップ（:62 付近）、`scripts/verify-bundle.sh`（:132 付近） |
| `packages/vscode-extension/.vscodeignore` | `!engine/scsynth/**` と `!engine/supercollider/**` の keep 指定 |
| `packages/engine/package.json` | `supercolliderjs` 依存、`build:engine` の supercollider コピー |
| `scripts/patch-supercolliderjs.sh` | 削除 |
| `packages/engine/src/audio/supercollider/` | 削除（`osc-client.ts` を含む） |
| 拡張側 | `resolveScsynthForUI()`、MCP ツール `force_kill_scsynth` |
| README | 「opt-out backend」表記 |

**影響範囲が広いので、テストと gated E2E が SC 経路に依存していないかを先に確認したい。**

> 🔴 §12.5 に実測を追記。

#### (3) VSCodium フォークを畳む

- `scripts/orbitstudio/build_orbitstudio.sh` を削除
- gated E2E のターゲットを層2 の MCP へ向け直す
- `apps/OrbitStudio/` の名前を空ける

> 🔴 §12.4 補正: 「層2 の MCP へ」は Phase 1 の成果物に依存するので、**先に stock VS Code 起動へ切り替える**。

### 4.2 この範囲に入れない想定のもの

- 拡張への新機能追加
- `extension.ts` の分割・リファクタ（真の結合点は行数ではなくモジュールレベルの可変状態なので、行数を減らしても解消しない）
- MIDI スケジューラの Rust 移植（実際に演奏で問題として聞こえているかの確認が先。セクション9）
- Rust エンジンの別リポジトリ切り出し（セクション6）
- Windows / Linux 対応
- Swift の実装

---

## 5. その先の段階（案）

### Phase 1: 層2 を独立プロセスに

1. **MCP サーバ 1,417行を `packages/session` へ下ろす。** 単独で最も費用対効果が高いと見ている。エディタを開かずにエージェントがセッションを操作でき、日々の開発体験を直接改善する
2. `//#` メタ行を型付き RPC へ置換、`protocol/` を切り、TS/Rust/Swift のバインディングを単一スキーマから生成
3. engine ライフサイクル、log ring、補完・診断ロジック、プロトコル codec も層2 へ

### Phase 2: Swift の walking skeleton

ウィンドウが開き、WKWebView に Monaco が載って `.orbs` がハイライトされ、層2 に繋がり、選択範囲評価で音が出て playhead が動く。タブ・保存・設定なし。**数週間で結論が出る想定。**

### Phase 3: 拡張を仕様書として使いながらネイティブ側を育てる

### 並行して進む事務（実装を止めない）

- **CLA の自動化**（CLA Assistant 等）。Phase 2 前が望ましい。Swift の新規領域は外部貢献を受けやすく、1件でも CLA なしで入ると再ライセンス不能になる
- **`protocol/` を素の Apache-2.0 か MIT にするかの判断。** 今やるのが一番安い。プロトコルが公開契約になる日に変更作業が不要になる
- `LicenseRef-Signal-compose-FairTrade-1.0` と `LICENSE` の名前整合、`LICENSES/` に全文配置
- Ableton Link: `link-audio` feature の default off を維持する限り申請不要。デフォルト化を決めた時点で Ableton へ申請
- Commons Clause の "Sell" 定義がワークショップ・受託を捕捉しないかの確認（LICENSE 冒頭の「教育・学術は無償」の意図が条文で実現できているか）

---

## 6. Rust エンジンの切り出しについて

**現時点の見立て: 後。Phase 2 が終わり Phase 3 を進めている頃。**

背景として、JUCE / Tracktion Engine が GPL 汚染の問題を持つため、その対抗として Rust オーディオエンジンを公開する構想がある。

### 今が不利と考える理由

汎用オーディオエンジンとしての境界がまだ決まっていない。Tracktion Engine が汎用ライブラリとして成立しているのは、DAW というドメインを何度も通過した後だから。現行の Rust は OrbitScore を鳴らすものとしては十分成熟しているが、**第三者のアプリを鳴らしたことがまだない。**

OrbitStudio を作る過程は、その境界が試される場面になる。**OrbitStudio が2番目の利用者になる機会を、切り出す前に使いたい。**

境界が怪しい具体箇所:

- protocol v0.2 の `capabilities` は「playback」「src」だけ。汎用ライブラリならもっと細かい能力記述が要るはず
- サンプル再生（`ScheduledSample`）が中心の設計。汎用なら合成やバス構成の一般化が必要
- `channel` フィールドが LinkAudio outputChannel と per-sequence insert bus の2用途を兼ね、ワイヤレベルで相互排他になっている。OrbitScore の事情から生まれた形で、汎用 API としては説明しにくい

### 分けるコストが今いちばん効く

現状は daemon・層2・拡張を1 PR で原子的に変えられる。切り出すとバージョンピン留めと2リポジトリの調整、CI とリリースの二重化が発生する。Swift シェル・層2 の抽出・プロトコルの作り直しが同時に走る時期に、この摩擦は避けたい。

### 名前

**Orbit を冠したままでよい**という結論。Tracktion Engine と同じで、出自が名前に残るのは弱点ではなく、実戦で使われた履歴は信頼の材料になる。改名しないのが一番安い。

- **`orbit-engine` は避ける。** `packages/engine` が層1と層2の両方を指す曖昧さを解消したのに、それが別の場所に戻る
- `orbit-audio` 系が素直。既に `orbit-audio-core` / `-daemon` / `-native` / `-sandbox` がプレフィックスとして機能している
- 名前の最終決定は、切り出す範囲が決まってから

### 配布経路

**分離してから考える。** 誰に使ってほしいかは、切り出す範囲とポジショニングが確定してから見える。今は全 crate が `publish = false` で、後回しにしてもコストが発生しない。

参考情報として、crates.io の名前の空き状況（2026-09-10 時点で確認）:

- `orbit` 単体のみ取得済み（nickcorin/orbit、0.0.1、ダウンロード29、実質プレースホルダ。名前の解放・譲渡は原則行われないので空くことは期待しない）
- `orbit-audio` / `orbit-audio-core` / `orbit-audio-engine` / `orbit-engine` / `orbit-host` / `orbit-score` / `orbitscore` / `orbit-studio` / `orbitstudio` / `orbit-clap-host` / `orbit-vst3-host` / `orbit-plugin-scan` / `orbit-link-audio` / `orbit-audio-daemon` / `orbit-audio-native` / `orbit-audio-sandbox` は**すべて空き**
- crates.io はハイフンとアンダースコア、大文字小文字を同一視するので、片方取れば足りる
- publish は取り消せない（yank しても名前は解放されない）
- なお crates.io に publish される crate は git 依存を持てないため、第三者が**ライブラリ**を作って crates.io に出す経路は塞がる。**アプリケーション**を作る分には支障ない

### ポジショニング

JUCE の実質的な価値は、オーディオ I/O そのものより「プラグインを**作る**側」の支援（`AudioProcessor`、パラメータ、状態保存、各フォーマットへのラッパー生成）とクロスプラットフォーム。こちらは**ホストする側**が主なので、同じ土俵ではない。

**「Rust で書かれた、アウトオブプロセスでプラグインをホストするオーディオエンジン」**という狭く明確なポジションになる。nih-plug が作る側で、ホストする側は埋まっていない。ただし「JUCE の代替」と名乗ると期待とずれる。

---

## 7. リポジトリ実測値（判断の根拠）

main、PR #822 マージ時点、1122ファイル。**現在の main とずれている可能性があるので、触る前に確認すること。**

> 🔴 §12.5 で main `487aba4e` 時点の再測を併記。差は Rust +約 800 行のみで判断に影響なし。

| 領域 | 行数 |
|---|---|
| `packages/engine/src`（TS） | 約24,300（core 8,747 / audio 6,130 / parser 3,392 / midi 1,759 / interpreter 1,576 / signal-chain 778 / timing 496） |
| `packages/vscode-extension/src`（TS） | 約9,600（`extension.ts` 4,258 / `mcp-server.ts` 1,417 / 他は500行未満） |
| `rust/crates` | 約79,800（daemon 25,432 / sandbox 8,143 / native 6,116 / clap-host 3,977 / vst3-host 3,480 / plugin-scan 3,308 / audio-core 2,137 / child-runtime 2,717 / effect-rack-child 2,359 / link-audio 826 ほか） |
| `packages/sc-link-audio`（C++） | 約880 |

### 現行プロセス構成

```
VSCodium → Extension Host → engine プロセス(node cli-audio.js repl)
  … stdin/stdout 行指向 → orbit-audio-daemon (Rust, cpal) … WebSocket
    → plugin child processes (CLAP/VST3, out-of-process)
```

メタ行プロトコル: `//#documentDirectory`、`//#selectAudioDevice`、`//#savePluginState`、`//#pluginUi`、`//#evalMark`。engine→拡張は1行 JSON と `[STEP] <seq> <argPath> <atEpochMs>`。送信は `writeCodeToEngine()`（`extension.ts:3117-3149`）に集約。daemon 側は `protocol.rs` 204行で protocol v0.2、serde 型定義、handshake + `capabilities`。

### タイミング経路

- **オーディオは保護されている。** `rust/crates/orbit-audio-core/src/scheduler.rs`（1,510行）が `ScheduledSample { start_sec: f64, ... }` でサンプル精度スケジューリング
- **MIDI は保護されていない。** `packages/engine/src/midi/midi-scheduler.ts` が `setInterval` 5ms ポーリング + `Date.now()`。transport も `core/sequence/playback/loop-sequence.ts` / `run-sequence.ts` が `setTimeout` ベース。JS イベントループに露出しており、ドリフト補正はあるが1発ごとの揺れは残る

### TS engine の Node 依存は薄い

- parser 0/8、timing 0/5、midi 0/13、signal-chain 0/4 のファイルが Node 組み込み依存ゼロ
- 使用は `path`(15) / `fs`(11) / `node:path`(5) / `readline`(3) 等のみ
- `@julusian/midi` は `midi/midi-output.ts` の注入可能な継ぎ目の向こうにあり、実 import は `midi/rtmidi-output.ts` 1ファイルのみ
- `supercolliderjs` は `audio/supercollider/osc-client.ts` のみ、`ws` は `audio/rust-engine/daemon-client.ts` のみ、`child_process` は2ファイルのみ

### `extension.ts` 4,258行についての所見

行数ほど悪くない。小さい名前付き関数 + セクションコメント（issue 番号付き）で構成され、`activate()` は290-505行に収まっている。

真の結合点は**モジュールレベルの可変状態**（`engineProcess`, `statusBarItem`, `outputChannel`, playhead 状態）で、`__setXForTest` 系の継ぎ目が必要になっている理由もここ。**行数を減らしても解消しない。**

### GUI 層は非対称

`createWebviewPanel` はリポジトリ全体で1箇所（学習ドキュメント表示）のみ。

### ライセンス構成

- ルート `LICENSE` は Signal compose Source-Available License v1.0（Apache-2.0 基底 + Commons Clause + Fair Revenue Clause）。条文自身が「OSD 上のオープンソースではない」と明記
- Rust の21 crate が `license.workspace = true`
- 例外: `orbit-link-audio`（`LicenseRef-Signal-compose-FairTrade-1.0`、feature `link-audio` は default off）、`packages/sc-link-audio`（GPL-2.0-or-later）
- `cargo-deny` で daemon の依存グラフを GPL-free に保つ不変条件あり
- `CONTRIBUTING.md:176` に PR ごとの CLA を求める旨
- `vst3` crate 0.3.0 は crates.io 上で MIT OR Apache-2.0（repo: `coupler-rs/vst3-rs`）

### 関連ドキュメント

- `sites/dev/editor/vscode-architecture.md`（1,037行）
- `sites/dev/editor/execution-feedback.md`（793行）
- `sites/dev/editor/mcp-and-gated-e2e.md`（1,381行）

---

## 8. 参考にした外部事例

### TZPL / Tzopilotl（James McCartney、SuperCollider 作者）

GPLv3、https://github.com/lfnoise/tzpl 。

- **IDE は既存エディタのフォークではなくゼロから実装。** GUI 非依存のモデル層（`document.hpp`, `symbol_scanner.hpp`, `definition_finder.hpp` 等、"No JUCE dependency" と明記）と、薄い JUCE ビュー層（約16,000行）に分離。ImGui 版と JUCE 版が並存
- エディタ本体は `juce::CodeDocument` + `CodeEditorComponent` 派生。**LSP なし**、シンボル検索は字句スキャンで自前実装
- ノートブック `.tzd` の原則は「code creates behavior; the document stores state」。ウィジェットは必ずコードが生成し、バインディングは保存しない
- `bindControl` は GUI スレッドが VM を通さず直接エンジンへ（fast path / flexible path の二重バインディング）
- 音楽ライブラリにポリメトリック特化はなく、**言語領域では OrbitScore と直接競合しない**
- JUCE を AGPLv3 で使用し、成果物は GPL+AGPL 混合バイナリになると README に明記

### unworklet

https://github.com/yuichkun/unworklet 、MIT。

**TS はビルド時のみ実行されグラフを捕捉し、オーディオスレッドで走るのは生成された WASM だけ**という型。コンパイラがアロケーションフリー・境界付き・非throw/非blocking を静的に保証する。**Rust daemon と衝突しない。**

WASM をどこでホストするかの選択肢:

| 案 | 評価 |
|---|---|
| a. Rust daemon で wasmtime + ABI 再実装 | 追随コストが高い |
| b. WebView の AudioWorklet | **避ける。** オーディオ経路が2本になり同期が破綻する |
| c. 汎用 CLAP 子プロセスで包み既存 `orbit-clap-host` 基盤に乗せる | **推奨** |

リスクは内部 ABI が非公開契約であること、API の変動、単一メンテナ。緩和策は**本線ではなく経路の1つとして扱い、自前の音源 interface の実装として CLAP 経由で刺す**こと。

`.uwk.ts` を製品内でビルドさせるなら JS ランタイムが必要（コンパイラは core にあり Vite 全体は不要だが、JS ランタイムは要る）。Bun が候補（`renderOffline` が Node/Bun/Deno 対応）。

---

## 9. 未検証・オープンな項目

**ここが崩れると上の判断が変わる。**

| 項目 | 影響 |
|---|---|
| **Monaco が WKWebView で問題なく動くか** | **最大の未知数。** 動かなければ Electron へ戻る判断もあり得る（2.3 が崩れる）。🔴 §12: **日本語入力（IME）**を walking skeleton の完了条件に含める |
| unworklet の生成 WASM を Rust（wasmtime）から呼べるか | `renderOffline` が出荷と同じバイナリを回すので、それで試すとホスト ABI の実装量が見える |
| `@unworklet/lang/typescript-plugin` が Monaco で動くか | tsserver 機構依存。Monaco は tsserver でなく LanguageService を worker で動かすため、載る保証がない。動かないなら tsserver サイドカーが確定 |
| `vst3-rs` が SDK ヘッダを持ち込まず独立にインタフェースを宣言しているか | 独立なら VST3 は懸案から外れる |
| MIDI の 5ms ポーリングが実際に演奏で問題として聞こえているか | 細かい音価、重い eval 中の遅れ、CPU 負荷時。気にならないなら Rust 移行の優先度は下げてよい |
| `orbit-audio-core` と daemon の境界 | 切り出す範囲に直結（セクション6）。OrbitStudio を作る過程で答えが出るはず。それまで新しいものを core と daemon のどちらに入れるかを毎回意識する |
| `packages/engine/src/core/` 8,747行の中身 | 未読。層1/層2 の分割線の精度に影響する |
| `docs/specs-v2/` と `sites/dev/` | 目次レベルのみ既読 |
| `orbit-audio-core` / `orbit-audio-native` の DSP・スケジューリング実装 | 未読 |
| 🔴 §12 追加: **層 2 の多クライアント同時性**の規則 | 拡張 + app + エージェントが同じセッションへ同時に eval したとき誰が勝つか。同一プロセスの暗黙の直列性がプロセス境界で消える |
| 🔴 §12 追加: **Swift アプリの CI**（macOS ランナー） | owner は per-PR の macOS ジョブをコストで却下している。Swift アプリを PR ごとにビルドしないなら UI の検証は手元だけ |

---

## 10. 検討過程で撤回・訂正された主張

同じ議論を繰り返さないための記録。**下段が現在の理解。**

| 一度出た主張 | 訂正 |
|---|---|
| SC 資産が 500MB の一番安く切れる部分 | **11.5MB でノイズ。500MB は Electron。** 削る理由は GPL 同梱と死んだ経路 |
| 16,000行の TS を Rust 移植するか Node 同梱かの二択 | Node 依存が薄く、境界の切り方の問題 |
| TS engine を WebView で動かせる | 技術的に可能でも**置くべきではない**（UI リロードで音が止まる） |
| 4,258行が分割コストの根拠 | 行数でなく**モジュールレベル可変状態**が結合点 |
| エディタは CodeMirror 6 も候補 | **TS を書かせるなら Monaco 一択** |
| ネイティブにすると WebView が使える | **Tauri も macOS では WKWebView** |
| 拡張がクロスプラットフォームの hedge になる | **daemon が macOS 専用なので成り立たない** |
| VST3 のライセンス懸念 | crate は MIT OR Apache-2.0 で問題なし |
| crates.io の名前を今押さえるべき | 配布経路を分離後に決めるなら不要。空き状況の確認で足りる |
| 🔴 §12: フォークを畳んで失うのは 47 行のスクリプトと E2E のターゲット指定のみ | **そのターゲット指定がマージゲート（実機 gated）そのもの**。畳む前に起動先を変える |
| 🔴 §12: 凍結線は「ステージ 2 完了」 | 制作に `outs:` は要らないので **O-surface 完了**まで縮む。O-multiout は新ラインの最初の束 |

---

## 11. このドキュメントの使い方

**まず議論してほしい。** 特に次の点。

1. **セクション4 の作業範囲は妥当か。** 拡張を凍結して閉じる、という切り方でよいか。含めるべきものが漏れていないか、逆に今やらなくていいものが入っていないか
2. **SC 資産の削除の影響範囲。** テストと gated E2E が SC 経路に依存していないか。セクション4.1(2) の一覧に漏れがないか
3. **セクション7 の実測値が現在の main と合っているか。** PR #822 時点の数値なので、ずれている可能性がある
4. **セクション2 の判断のうち、根拠が弱いと思うもの。** 特に 2.3（Monaco）はセクション9 の未検証項目に依存している

合意が取れてから着手する。セクション5 以降（Phase 1〜3）と セクション6（エンジン切り出し）は、今回の作業範囲の外にある想定。

> 🔴 §11 の 4 点は 2026-09-10 に議論済み。結論は §12。

---

## 12. 🔴 裁定（owner・2026-09-10）— ここが正

§0〜§11 の議論を main が実測で検算し、owner が裁定した。**§0〜§11 と食い違う場合は本節が正。**

### 12.1 方針

**拡張版を stable として凍結し、`.vsix` をリリースする。** 制作（楽曲・インスタレーション）はこれを使う。
凍結後の開発は**新ライン**（ネイティブ OrbitStudio.app + 層 2 抽出）で進める。**両者は直列ではなく、凍結の翌日から新ラインを始めてよい**（凍結の実体はタグなので main は止まらない）。

### 12.2 凍結線 = ステージ 2 の **O-surface（PR-O4）完了**

**理由**: DSL 表面の一方通行（`output()` 統一・`send` の dB 化・`pan` のライン要素化 = 計画 §0 の W-2 / W-3 / W-18）が O-surface で確定し、**以降のステージはすべて加法的**（既存譜面を壊さない）。制作物は長く残るので、退役が決まっている表面で書かせない。

**制作の要件（owner 回答）**:

| 問い | 答え | 帰結 |
|---|---|---|
| 出口 | **master + sum / aux + 物理アウトのスピーカー振り分け**で足りる | 物理アウト（`mix.output(3, 4)` / mono）は O-surface に含まれるので ✅。音源プラグインの `outs:`（O-multiout・#409 / #647）は**不要** |
| 演奏の記録（.orbslog）・stem 書き出し（render） | 不要。再生はできる | ステージ 3 / 4 は新ラインへ |
| 並列ラック・compressor 等 | 不要 | ステージ 6 は新ラインへ。**「凍結版 ≠ リリース」** — 過去裁定「ラックはリリースの前提」は新ラインのリリースに対して生きる |
| 録音 | 別途考える | **`ORBIT_CAPTURE_WAV=<path>` で今日できる**（capture seam #307・`engine_wrap.rs:4743`。master 出力を whole-stream WAV へ）。新規作業は不要 |

**O-surface の中で凍結版に不要なら外せる候補**: `SetGlobalGain` の master line への写し（設計 611 §4.2）。ramp の実効値引き継ぎ機構（§5.1）とセットで、機構の設計はまだ無い。今日の `global.gain()` は atomic で正しく動いており、凍結版に「master gain をラックの前後へ置き替える」機能が要らないなら新ラインへ回す。**O-surface の設計時に決める。**

### 12.3 新ラインへ回すもの

- **O-multiout**（PR-O5 `outs:` + PR-O6 旧 `SetBusRouting` の撤去）— 新ラインの**最初の束**。🔴 **PR-O6 の「O4 が実機で確かめられた後」という条件は、stable 版の制作利用がそのまま満たす**
- ステージ 3〜7（log / render / 可視化 / ラック / plugin 境界）— 層 1 / 2 の作業なのでそのまま生きる
- **ステージ 8（配布）は再定義**。「署名・公証済み OrbitStudio.app（VSCodium フォーク）」は §2.6 で消える。#659 / #656 / #138 はネイティブ app の配布として書き直す。作業ツリーに untracked で残っている `scripts/orbitstudio/make-local-release.sh` は役目を終える
- §5 の Phase 1〜3・§6 の engine 切り出し

### 12.4 gated ハーネスは stock VS Code 起動へ（フォークを畳む**前**に）

`tests/e2e/orbitstudio-mcp-gated.spec.ts:460-471` は既に `--extensionDevelopmentPath`（拡張をソースから直接ロード）+ 隔離した `--user-data-dir` / `--extensions-dir` で起動している。**フォーク固有なのは実行ファイルのパス `Contents/Resources/app/bin/orbs` の 1 行だけ**で、VS Code の `bin/code` に変えれば足りる。vsix の入れ替えは不要で、日常の VS Code にも触れない。

§4.1(3)「層 2 の MCP へ向け直す」は Phase 1 の成果物に依存するので、**その前にこの 1 行を変える**。これで実機 gated（マージゲート）を失う期間が無くなる。

### 12.5 SC 資産の削除 — 実測と順序

**owner: 「もう SC は使っていないので、しっかり削除して整理する」。**

| 対象 | 実測（main `487aba4e`） |
|---|---|
| 実機 gated（`orbitstudio-mcp-gated.spec.ts` + helpers 11 本） | **SC 参照 0 件** → マージゲートは無傷 |
| ユニットテスト | **22 ファイル**が参照。うち SC 専用 5 本（`supercollider-player-boot` / `supercollider-gain-pan` / `scsynth-resolver` / `synthdef-loader` / `osc-client-register`）は削除、残り 17 は import / fixture の整理 |
| §4.1(2) の一覧への追加 | 上記 5 本・`ORBITSCORE_ENGINE=sc` を読む箇所・`docs/core/INDEX.md` の「opt-out backend」表記・`packages/sc-link-audio`（GPL-2.0・SC 専用なら同時に） |

**順序**: 🔴 **#502 を「レガシー残置」から「削除」へ更新してから**専用 PR（main 直行・フルレビュー）。**stable タグより前**（今の `.vsix` は `.vscodeignore` の keep 指定で GPL の scsynth を同梱しており、`release.yml` は `v*` タグで Marketplace / Open VSX へ publish する）。

### 12.6 実測値の再測（main `487aba4e`）

`engine` 24,330 / 拡張 9,587 / `extension.ts` 4,258 / `mcp-server.ts` 1,417 / **Rust 80,591**（+約 800・#824）。判断に影響なし。

### 12.7 順序

| # | 作業 | 種別 | 備考 |
|---|---|---|---|
| 0 | 本節の文書化（#827）| docs | ✅ |
| 1 | **O-surface**（PR-O4） | 束 | `SetGlobalGain` の写しの要否は設計時に決める |
| 2 | SC 削除（#502 更新 → PR） | main 直行 | 1 と独立。別セッション可。**タグより前** |
| 3 | gated ハーネスを VS Code 起動へ（1 行）→ フォークを畳む | main 直行 | 1 と独立 |
| 4 | README / Marketplace を OrbitStudio への導線へ | docs | 3 と一緒でも可 |
| 5 | **stable タグ = 凍結** | — | 2〜4 が全部入ってから。タグ名前空間（`ext-v*`）とバージョン（`send` の dB 化は既存譜面の意味が変わるので semver なら 3.0.0）は**未決** |
| 6 | 新ライン: O-multiout → Phase 1（層 2 抽出）→ Phase 2 spike（Monaco + **IME**）を並行 | 新ライン | spike の結果を入力に OrbitStudio.app を設計（Fable 起案・main 審査） |

**未決（本節で決めていないもの）**: タグ名前空間 / バージョン番号 / 地図の全面再編（ステージ 2〜8 × 層 × 凍結版の分割線の表・Fable 起案で別 issue）/ `SetGlobalGain` の写しの要否。
