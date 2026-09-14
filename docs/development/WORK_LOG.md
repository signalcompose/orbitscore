# OrbitScore Development Work Log

## Project Overview

A design and implementation project for a new music DSL (Domain Specific Language) independent of LilyPond. Supports TidalCycles-style selective execution and polyrhythm/polymeter expression.

## Development Environment

- **OS**: macOS (darwin 24.6.0)
- **Language**: TypeScript
- **Testing Framework**: vitest
- **Project Structure**: monorepo (packages/engine, packages/vscode-extension)
- **Version Control**: Git
- **Code Quality**: ESLint + Prettier with pre-commit hooks

---

## Recent Work

### fix: address the review round-1 findings for #939 / #940 (Sep 14, 2026)

レビュー 5 体（`/code:pr-review-team` フル編成 + Fable 監査を**並行**）の指摘を集約し、
main が実機コードで再現を取った 8 件を直した。

🔴 **本体は Critical 1 件 — #939 が防ぐために作られた失敗を、#939 自身が再導入していた。**

#### 何が起きていたか

```
drums.effect(["Echo", ["Echo", "Echo"], "Echo"])
engine の真の並び: [Echo#1, Echo#2, Echo#3, Echo#4] → UIH.5 index 1,2,3,4

  Echo#1 → index 1          ✅
  Echo#2 → FAIL "layer() … serial chains only"   ← layer は書かれていない
  Echo#3 → FAIL 同上
  Echo#4 → index 3, expectedName "Echo"          🔴 3 番目が開く
```

**`expectedName` ガードは名前が同じだと止められない**（`global.ts:1242` は名前しか比べない）。
つまり**エラーも警告も無しに別のインスタンスが開く**。

原因は engine との規則の食い違い。`packages/engine/src/signal-chain/rack.ts:196`:

```ts
return value.elements.flatMap((element) => resolveRackValue(element, env))
```

**素の配列は深さに関係なく親へ平坦化される。階層を作るのは `layer(...)` だけ**
（既存テスト `rack-value-resolution.spec.ts:188` が固定済み）。
スキャナは透過を **「その呼び出し語の最初の `[` か」**（`directArraySeen`）で決めており、
2 つ目以降の素の配列を layer の枝と誤認していた。

**なぜレビューまで残ったか**: フィクスチャが `layer([...])` 経由の入れ子しか持たず、
**`layer` を経由しない素の入れ子配列が 1 つも無かった**。
ユニット 2,542 件・実機 gated 48 件・`/simplify` 4 体を素通りしている。

#### 修正の規則（指摘単位のローカルパッチを避けるため、先に 5 本書いた）

| 規則 | 内容 |
|---|---|
| **P1** | チェーンのアドレスは engine の平坦化規則を 1 つだけ写す。階層を作るのは `layer` だけ |
| **P2** | receiver は **文の起点**で決まる（`.effect(` の直左ではない） |
| **P3** | 機能を黙って無効化しうる解決は、**両方の分岐で**ログを出す |
| **P4** | 登録の述語は、そのツールが**実際に使う**ハンドラだけを名指す |
| **P5** | 観測ヘルパは、絞り込みで空になったら**絞る前**を見せる |

#### 直したもの

| id | 何を |
|---|---|
| **F1** (P1) | `directArraySeen` と `TRANSPARENT_ROOT_ARRAY_WORDS` を**削除**し、`[` の直近 CallFrame が `layer` の時だけ階層を積む |
| **F2** (P2) | receiver を行の文頭から解決。`var <name> =` があれば右辺を起点に。失敗文言から誤った「1 行に書け」案内を削除 |
| **F3** (P3) | `resolvePluginWindowHostBundleId` の 4 分岐（成功 / `.app` 不在 / plist 読めない / キー不在）を `outputChannel` へ。`platform !== 'darwin'` は正常系なので黙る |
| **F4** (P4) | UI 3 ツールをそれぞれ自身のハンドラだけの述語へ分離。**登録順序は維持** |
| **F5** (P5) | `soloWindowLayer` のエラーにフィルタ前の一覧を含め、全 name が空なら画面録画権限を名指す |
| **F6** | `collectDerivedMixerBuses` の「読み手は 1 つ」コメントが**嘘だった**（`dsl-completion-context.ts:195-198` に残っている）。委譲は循環依存（`diagnostics-analysis.ts:8` が逆向きに import）なので**コメントを実態へ訂正** |
| **F7** | gated E2E が `.app/Contents/Info.plist` を `plutil` で読むようにし、bundle id の決め打ちを廃止 |
| **F8** | `.optionAll` は off-screen も含む（`CGWindow.h:137-145`）— コメント訂正 |

#### F2 の実測（訂正前 → 訂正後）

| 入力（すべて 1 行） | 前 | 後 |
|---|---|---|
| `snare.output(verb, thru: true, db: -6).effect(["Comp"])` — **core spec `:1796` の例** | undefined | `snare` |
| `kick.audio("k.wav").effect(["Comp"]).output()` | undefined | `kick` |
| `global.sum("drum").gain(-3).effect(["Comp"])` | undefined | `sum:drum` |
| `drums.effect(["A","B"]).effect(["C"])` の `C` | undefined | `drums` |

🔴 **仮定の話ではなかった。** この形は**リポジトリ自身の実機 E2E フィクスチャ**が使っている
（`tests/fixtures/mcp-e2e/output_line_position_matters.orbs:38`）。
しかも失敗文言が「keep receiver.effect([...]) on one line」— **1 行に書いてあるのに**。

#### テスト

**期待値を手書きしない形にした。** `engineCatalogOrder()` が同じ式を engine の
`parseAudioDSL` → `resolveRackValue` に実際に通し、その平坦順と拡張の index を突き合わせる。

- 素の入れ子 / **同名 4 つ** / 深い入れ子 / `chain()` を含む形（🔴 同名版が**区別するテスト** —
  名前が違う版だけでは `expectedName` が偶然守ってしまう）
- `layer` が引き続き拒否されること
- F2 の表の全行（core spec の行を含む）
- `startEngine` が `ORBIT_HOST_BUNDLE_ID` を env に載せる / 取れない時は**キーが消える**配線
- カーソルツールだけ欠けても既存 2 本が登録されること
- `window-layer` の権限診断（新規 `tests/e2e/window-layer-helper.spec.ts`）
- gated E2E に素の入れ子・同名 4 インスタンス版を 1 本追加（`index: 4` を要求し、
  **index 3 への close が失敗する**ことを確認）

#### 見送り・別 issue

| 指摘 | 判断 |
|---|---|
| `HOST_BUNDLE_ID_ARG` が 2 クレートに重複 | **見送り**。daemon は `orbit-child-runtime` に依存しておらず、共有には依存追加が要る。`--shm` も raw literal で 28 箇所に散っており慣習が無い。値がずれれば child が未知引数で落ちて loud |
| `set_plugin_window_level` が `NSApplication.windows()` **全部**にレベルを掛ける | **別 issue**。JUCE のポップアップ（独自レベル）が巻き込まれうるが、実プラグインでの確認が要る |

#### 🔴 レビュー運用で分かったこと

- **Fable を並行投入した意味があった**: Fable の I-1（receiver）と pr-test-analyzer の C1（入れ子）は
  **どちらも「差分に在るコードの誤り」ではなく「フィクスチャに無かったもの」**だった。
  code-reviewer（Critical 0 / Important 0）は差分を丁寧に追ったが、**無いものは見えない**
- **Codex が read-only sandbox で起動され、何もせず exit 0 で終わった**。`task` に **`--write`** が要る。
  `git status` にコード差分が無いことで気づいた。**「完了」を成果物で検算する**
- **dist が古いまま**で「修正が効いていない」と誤判定しかけた（[[ts-mutations-need-a-rebuild-before-real-machine]] と同型）

---

### refactor: apply the /simplify findings for #939 / #940 (Sep 14, 2026)

`/simplify`（reuse / simplification / efficiency / altitude の 4 体）が出した指摘のうち
4 件を採用、1 件を見送った。**挙動は変えていない**が、1 件は直す過程で**既存側の欠陥**が出た。

#### 🔴 直す過程で見つかった、指摘より重いもの — `mix.` 決め打ち

`plugin-name-diagnostics` が持っていた「3 本目の正規表現」を消す作業で、**既存 2 本の方が
間違っている**ことが分かった:

```
既存: /\bvar\s+(...)\s*=\s*mix\.(?:sum|aux)\b/g   ← 受け側が "mix" 決め打ち
```

`mix` は `var mix = init global.mixer`（SC.2.1）で作る**ただの変数**なので、
譜面が別名を付けた瞬間に **`declaredMixerBusNames` が派生バスを見落とす**。
[`INSTRUCTION_ORBITSCORE_DSL.md`](../core/INSTRUCTION_ORBITSCORE_DSL.md) MX.2 の例
（`var drums = mix.sum`）も `mix` を変数として導入している。受け側を一般の識別子にした。

一本化の先は `diagnostics-analysis.collectDerivedMixerBuses`。**この形を読む場所を 1 つにする**
のが目的で、3 本が文字集合もアンカリングも違っていた（同じ譜面が 3 通りに読まれうる状態）。

#### 採った 4 件

| 対象 | 何をしたか |
|---|---|
| `tests/e2e/helpers/window-layer.ts` | `execFileSync` → **`spawnSync`**。`run-cli.ts:35` が定める規約（`helpers.spec.ts` が pin）に反していた。`execFileSync` は**成功時に stdout しか返さない**ので、`CGWindowListCopyWindowInfo` が画面録画権限の警告を stderr へ出しつつ空配列を返す形が**「窓が無い」と読める**。`error` / `signal` / `status` / `stderr` を個別に見て throw する |
| `plugin-name-diagnostics.ts` | 語彙判定 4 箇所のインライン `\|\|` 連鎖を **3 つの名前付き集合**へ（`CATALOG_ROOT_WORDS` / `TRANSPARENT_ROOT_ARRAY_WORDS` / `ELEMENT_SEPARATOR_WORDS`）。**意図的な差**（`layer` は透過にしない）が並べて見える形になる |
| `diagnostics-analysis.ts` | 上記 `collectDerivedMixerBuses` を新設し、`plugin-name-diagnostics` が委譲 |
| `orbit-child-runtime` | `strip_host_bundle_id_argument` を新設。child 3 種（clap / vst3 instrument・effect rack macos）が持っていた「`--host-bundle-id` を読み捨てる」分岐を削除。**child 固有パーサに関心外のフラグを教えない**。単体テスト 3 件追加（child-runtime **40 passed**） |

#### 見送った 1 件 — `HOST_BUNDLE_ID_ARG` の daemon 側二重定義

daemon が `"--host-bundle-id"` を文字列リテラルで書いている箇所を定数へ寄せる指摘。
**`--shm` が raw literal で 28 箇所**に散っており、CLI 引数名を共有定数にする慣習が
このリポジトリに無い。レビュアー間でも評価が割れていた（reuse は指摘・altitude は
「既存慣習より厳密なので入れない」）ので、慣習を変えるなら別 PR とする。

#### 検証

`npm test` **2542 passed / 78 skipped**・`lint` 0・`typecheck:e2e` 0・
cfg 4 象限すべて緑・`cargo check --target x86_64-unknown-linux-gnu` 0・
実機 gated **48 passed**。

🔴 ファイルサイズ ratchet が 1 件赤になった。`strip_host_bundle_id_argument` の抽出で
`orbit-effect-rack-child/src/macos.rs` が **531 → 529 行**に*減った*のに baseline が
古いままだったため。baseline を下げた（ラチェットは減る方向にしか編集してはいけない、を守る側の発火）。

この追記で本体が **2,034 行**になり `worklog-size.spec.ts`（上限 2,000）も赤になったので、
末尾の 09-12 分 **415 行**を [`WORK_LOG_2026-09.md`](../archive/WORK_LOG_2026-09.md) へ移した。

---

### test(e2e): assert the plugin window level, and add a manual-gate score (#940) (Sep 14, 2026)

🔴 **設計 §5b の前提「窓の重なり順は自動で観測できない」は誤りだった。** それを根拠に
**全部を手動ゲートに置いていた**。owner の「テスト用のコードを書いて」で調べ直して分かった。

#### 何が読めるのか

`CGWindowListCopyWindowInfo` の **`kCGWindowLayer`**（0 = Normal / 3 = Floating）。
🔴 **child に `window.level()` を聞くのとは違う** — あれは*process が信じている値*で、
窓サーバが適用したかは分からない。`kCGWindowLayer` は**窓サーバ側の記録**なので、
レベルが効かなかった場合はここで食い違いとして出る。

実測（同じ child・同じビルド・**前面アプリだけ**を変えた）:

| 前面のアプリ | layer |
|---|---|
| `com.mitchellh.ghostty` | **0 = Normal** |
| `com.microsoft.VSCode` | **3 = Floating** |

#### 足したもの

- `tests/e2e/helpers/window-layer.swift` — 外部リーダ（**0.24 秒**）。1 行 1 JSON で依存を増やさない
- `tests/e2e/helpers/window-layer.ts` — `observeWindows` / `soloWindowLayer`。
  窓が 1 つでなければ **throw**（先頭を黙って選ぶと壊れた状態が数値として通る）
- gated E2E `#940` — ホスト前面 → floating → **別アプリ前面 → normal** → 戻すと floating
- `examples/manual-gates/939-940-plugin-ui.orbs` — 人が触る用（owner 依頼）。
  ⑥ に `twin.ui("CLAP Test Effect")` をコメントで置き、**同名 2 つが両方開く**のと
  右クリックで 1 つだけ開くのを**その場で見比べられる**ようにした

🔴 **区別するアサーションは「別アプリ前面で normal に戻る」。** 常時 floating を掛ける実装でも
「ホスト前面で floating」は通ってしまう。#935 と同型の失敗を避けるための本体。

#### 🔴 owner の環境で「効かない」と見えた理由 — また計測側だった

古いプロセスが残っていた: dev host **8 個** / daemon **2 個** / child 3 個。
child はいずれも **`--host-bundle-id` 無し**（#940 より前に起動したもの）で、
`desired_plugin_window_level` が `Normal` を返すのが**正しい動作**だった。
しかも `start_engine` が **`engine already running`** を返し、新ビルドの daemon は起動していなかった。

全部落として立て直すと、`Info.plist` → daemon の `ORBIT_HOST_BUNDLE_ID=com.microsoft.VSCode` →
child の `--host-bundle-id` → **layer 3** まで通った。**実装は最初から正しかった。**

昨日の「変異版 `dist` で dev host を起動」と**同じ形**。→ [[stale-processes-invalidate-real-machine-results]]

#### 途中で踏んだもの

`CLANG_MODULE_CACHE_PATH` に `/tmp` を使うと、swift が `/private/tmp` と**別物として扱い**
2 回目以降が `module 'Darwin' is defined in both` で落ちる。実体パスに固定した。

#### 検証

実機 gated **48 passed / skip 0**（#940 を含む）/ lint / `typecheck:e2e` /
`docs:check`（986 引用 0 失敗）/ `tests/repo` + `tests/docs` 86 passed。

Part of #940

---

### feat(plugin-ui): float plugin windows above the editor while OrbitStudio is frontmost (#940) (Sep 14, 2026)

owner 裁定で **#939 の PR に畳んだ**（「振る舞いとしては同じ関心ですよね」）。
利用者から見れば「楽譜から UI を開く」ひとつの体験で、**#939 の手動ゲート中に発見**された。
加えて**手動ゲートは人手が要る一番高い工程**なので、分けると owner に 2 回やってもらうことになる。

🔴 main が当初「検算の機会で切る」を理由に分離を提案したのは**筋違い**だった。あの規律は
「**振る舞いを変えない**変更を、変える変更と混ぜるな」であり、本件は両方とも変え、互いの検算を潰さない。

#### 方式: child 自己完結 — **wire 変更なし**

child が `NSWorkspace` の `didActivateApplicationNotification` を購読し、
**前面が「ホストまたは自分自身」なら `NSFloatingWindowLevel`** を child の中だけで判定する。
ホストの bundle id は **spawn 時の固定値**（`ORBIT_HOST_BUNDLE_ID` → `--host-bundle-id`）。

🔴 **拡張側でフォーカスを検知する案を採らなかった理由**: `onDidChangeWindowState` は
VS Code のフォーカスしか見ないので、**プラグイン窓をクリックした瞬間に floating が外れる**。
child なら「自分が前面」を直接見られるので、この罠が構造的に起きない。
**wire を使わない方が正しい**という珍しいケース。

判定は純関数 `desired_plugin_window_level(host, child, frontmost, frontmost_is_child)` に切り出し。
**未指定時は `Normal`**（後方互換）。

#### 🔴 Codex が実測で見つけた穴（main の設計に無かった）

standalone の child では **`NSRunningApplication.current.bundleIdentifier` が `nil`** を返す
（Swift で実際に叩いて確認）。bundle id 比較だけでは「**窓自体をクリック**」が成立しない。
同一 `NSRunningApplication` オブジェクトの比較で塞いだ。IPC も host focus 購読も増やしていない。

#### 🔴 main の発注ミス: 500 行ラチェットの規律を書き忘れた

4 ファイルが超過した（`orbit-child-runtime/src/lib.rs` 551/500 ほか）。#939 のブリーフには
「`agent-handlers.ts` に足すな」と書いたのに、#940 では同じ規律が抜けていた。
baseline の書き換えは #888 子 0 の裁定で禁止なので**分割で対応**:

| 新規 | 内容 | コード行 |
|---|---|---|
| `orbit-child-runtime/src/appkit.rs` | AppKit run loop と `NSWorkspace` observer | 214 |
| `orbit-audio-daemon/src/outproc_child_command.rs` | effect child のコマンド構築 | 24 |
| `orbit-audio-daemon/src/outproc_instrument_transport.rs` | instrument の transport context | 18 |
| `orbit-effect-rack-child/src/macos/args.rs` | rack child の `Args` 型 | 6 |

`lib.rs` は **551 → 332 行**。🔴 **3 ファイルが `allowed` と同値**（余裕ゼロ）なので、
次に 1 行足すと赤くなる。レビューで扱う。

#### 引用の追従は `--fix` だけでは終わらなかった

10 件が `--fix` で解決できなかった。**コードが別ファイルへ移動**していたため
（`lib.rs:481-497` → `appkit.rs:205-221`）で、行シフトではない。ヘッダのパスごと直し、
**引用ブロックの中身も実コードから再同期**した。

🔴 `(env の組み立てを省略)` と注記のある**意図的な省略引用**を、再同期スクリプトが
全行で上書きしてしまい 1 度壊した。`git checkout` で戻し、範囲と差分行だけ手で直した。
**注記つきの引用は機械的な再生成の対象にしない。**

#### 🔴 `git add -A packages` で無関係な 18,916 行を巻き込みかけた

未追跡の `packages/sc-link-audio/`（ビルド成果物 + 埋め込み git リポジトリ）が入った。
`git reset` して**変更ファイルを明示**する形に直した（最終 1,424 行）。
memory `dont-use-git-add-all` を自分で破っていた。

#### 検証

`npm test` **2,542 passed / 77 skipped** / lint / `typecheck:e2e` / `docs:check`（986 引用 0 失敗）/
500 行ラチェット 70 passed / `cargo fmt --check` / `clippy --workspace --all-targets -D warnings` /
child-runtime 37 / daemon 305 / std-gain 実機 3 行。

🔴 **窓の重なり順は自動で観測できない。** 手動ゲート 4 項目（VS Code 前面で上に出る /
他アプリ前面で被さらない / **窓自体をクリックしても外れない** / 未指定時は normal）は**未了**。

Part of #940

---

### feat(extension): open one plugin's UI from the cursor position (#939) (Sep 14, 2026)

楽譜上のプラグイン名を右クリックし、`OrbitScore: Open Plugin UI` からそのインスタンスだけを
開く経路を追加した。同名の insert はカーソル位置から `chainPath` で区別し、engine へ渡す直前の
1 箇所だけで UIH.5 index に変換する。標準プラグイン（`Gain(...)`）もチェーン位置を消費し、
派生 sum / aux bus、master、直指定 bus の receiver を解決する。

MCP の `open_plugin_ui_at_cursor` は引数なしで同じ VS Code command id を `executeCommand` し、
メニューと同じ成功・失敗経路を通る。純関数・配線・manifest のユニット、同名 + `Gain` の gated
E2E を追加した。実機 E2E と右クリック手動ゲートは sandbox 外で実施する。

#### main の検証（工程 ④⑤・実装は Codex / 検証は main）

🔴 **委譲先の報告ではなく差分を読んで確かめた。** トラップ 4 点はいずれも正しく処理されていた:

| トラップ | 実装 |
|---|---|
| `Gain(...)` を数える | `,` を数えるのは `effect`/`instrument`/`layer`/`chain` の**フレーム直下のみ**。`Gain(db: -6, label: "x")` 内の `,` は数えず、`Gain(` 自体は要素を 1 つ進める |
| MCP が `executeCommand` を通る | `openPluginUiAtCursorForAgent` が command id を `executeCommand`。モック（`tests/mocks/vscode.ts:229-232`）も**登録済みハンドラへ委譲する形**に直っている |
| E2E の区別力 | `close_plugin_ui(index: 1)` が `no plugin UI opened` で**失敗**することを assert |
| engine 不可侵 | `packages/engine/**` / `rust/**` の差分ゼロ |

既存テストを触った 3 箇所（`mcp-server.spec.ts` / `engine-command-awaits.spec.ts` / `tests/mocks/vscode.ts`）は
**すべて追加または委譲化**で、期待値の変更は 1 つも無い。

🔴 **`npm test` は Codex の環境では完走していない**（sandbox の loopback 制限で
`listen EPERM 127.0.0.1` → `rust-engine-player.spec.ts` が 44 件 timeout）。
main が sandbox 外で回し直して **2,541 passed / 77 skipped / exit 0**。
500 行ラチェットの失敗も**新規ファイルが未追跡だったための人工物**で、index に入れれば 70 passed。
**「委譲先が緑と言った」では済ませない**という規律がそのまま効いた形。

#### main が直した 2 点

1. 🔴 **テスト名が実体と食い違っていた** — `'... the same plugin is inserted three times'` だが、
   フィクスチャは同名 CLAP **2 つ + `Gain`**。設計 §0b でフィクスチャを変えた時に**名前だけ
   取り残されていた**（Codex が報告で指摘してきた）。名前を実体に合わせ、設計側も同期した
2. **本エントリの見出しが日本語だった** — 規約は「タイトルは英語・本文は日本語」

### docs(design): design the cursor-based route to one plugin's UI (#939) (Sep 13, 2026)

**Issue**: #939（#474 の後継）。起案 = Fable subagent / レビュー = main（工程 ①→②）。
設計文書のみ。実装は次。

#### 何が問題か

DSL の `ui("名前")` は**一致する insert を全部開く**（SC.10.10.1 規範 3・仕様どおり）。
しかし**同じプラグインを 2 つ挿すと分離できない**。index 形は SC.10.10 規範 (2) で撤回済み
（ラックは入れ子になり得るので 1 次元では指せない）。
**MCP は `chain_path` で個別に指せるので、LLM は開けて人間だけが開けない。**

#### 方式は右クリック（⌘クリックではない）

仕様 SC.10.10 規範 (2) は ⌘クリックを主経路としているが、**実装手段が両方とも問題を抱える**:
`DefinitionProvider` は **⌘ホバーの peek でも発火**する（名前を見ただけで窓が開く）。
`DocumentLinkProvider` の target に `command:` URI を置く形は**公式 API ドキュメントに記載が無い**
（Context7 で確認）。一方 command URI は**ホバーの `MarkdownString`（`isTrusted`）では公式サポート**。

`contributes.menus` の `editor/context` は**既に存在**する（`orbitscore.rescanPlugins` が入っている）。
🔴 **仕様改訂が要る**（§2.5 に文面・残存 4 箇所を列挙）。

#### main のレビューで変えた 3 点

1. 🔴 **E2E のフィクスチャを `[clap, vst3, clap]` → `[clap, Gain(db: -6), clap]`**。
   旧案は**設計自身が §8 の筆頭に挙げたトラップ（`Gain` を数えない）を検出できない** —
   3 つとも非標準だと index は数え方に関わらず 1/2/3 で同じになる。`Gain` を挟むと、
   数えない実装は 3 つ目に index 2 を割り当て、**index 2 は `targets` に無い**ので loud に落ちる
2. **変異を 1 件 → 2 件**（M2「`Gain` を数えない」を受け入れ条件へ）
3. **手動ゲートに実 VST3 の右クリックを追加**（owner 指摘）。混在チェーンの index 演算は
   `#633 E2E-2` が既に実証済みだが、**VST3 の UI が開くことは自動化できない**
   （フィクスチャ `GainOracle.vst3` の `createView` がヘッドレスで null）

#### main が閉じた穴

起案は「`Gain` が offset を消費する」を **state 経路**（`pluginStateTargets`）から導いていた。
**UI 経路でも成り立つかは書かれていなかった** — `openPluginUi` も `resolvePluginStateEntry` を
呼ぶので index 空間は共有で、規則は有効。ここを確かめずに実装すると根拠が宙に浮いていた。

VS Code の `contextmenu.ts` の引用も **`raw.githubusercontent.com` から取得して逐語一致を確認**した
（委譲先の引用を鵜呑みにしない）。クリック位置が既存選択の外なら `setPosition` する。
ただし**実機は未確認**なので、§3.1 に 1 分の確認手順、§3.2 にホバーへ倒す代案を置いた。
**F1 が偽でも解決器・配線・E2E・MCP は無変更**で済む形にしてある。

#### 規模

**約 900〜1,300 変更行**（起案の 700 行は楽観的）。根拠は `#652` のエディタ側の切片で、
`plugin-name-diagnostics.ts` を新規作成して 324 行 + spec 248 + 配線 102 = **674 行**。
本件はそれを**拡張**する側。**半分近くがテスト**。
**1 PR で通す**（owner 裁定）— 分割すると束 1 が消費者のいない層になる。

Part of #939

---

### docs: bring the README back in line with the shipped 4.1.0 (Sep 13, 2026)

**Issue**: #937。README を実体と 1 行ずつ突き合わせ、**乖離 7 件**を直した。

#### 🔴 最重要: 入門例が鳴らなかった

`README.md` の `Basic DSL Syntax` は `kick.play(...)` を書いて **`.output()` が無かった**。
#883（DSL 2.0・暗黙 master 終端の廃止）以降、**`output()` の無いシーケンスは無音**である。

| | `.output()` |
|---|---|
| `examples/01_getting_started.orbs` | ✅ |
| `sites/user/getting-started/first-sound.md:50` | ✅ |
| **`README.md`** | 🔴 **無し** |

`examples/` の audio 系 10 本はすべて `output(` を含む（0 は MIDI 専用の 2 本のみ）。
**README だけが取り残されていた** — 読者が最初にコピペするコードなので実害が一番大きい。
修正後の例は `parseAudioDSL` に通して **14 statements・エラー 0** を確認した。

#### 直した残り 6 件

| 箇所 | 何が古かったか |
|---|---|
| `Current Implementation Status` | **「2.0.0 is released」** — 同じ節の別行は 4.1.0 を名乗っており自己矛盾していた |
| `Development Status` の Phase 7 | **「SuperCollider Integration」が `<details>` の外**＝現況として読めた（#502 で削除済み） |
| `Testing` の件数 | `2271/58/2329`（2026-09-10）→ **`2497/76/2573`**（実測） |
| 拡張のインストール手順 | **`Developer: Install Extension from Location...` でソースフォルダを読ませていた** — #873 / #878 が露出した層を丸ごと飛ばす経路。`npx vsce package` → `.vsix` へ変更し、`pretest:e2e:cold-install` と同じ手順に揃えた |
| Technical Features | **セッションログ（`.orbslog`）に一言も触れていなかった**（既定 off・`ORBITSCORE_SESSION_LOG=1` で opt-in） |
| `#138` の行 / `Syntax highlighting (2.0.0)` | 前者は自動化済みの注記を追加、後者は無意味な版表記を削除 |

🔴 **ビルド手順も直した** — 旧手順は `cd packages/vscode-extension && npm run build` だったが、
engine の `dist` と daemon / plugin-child のバイナリを拡張へ入れるのは**ルートの `npm run build`**
である。拡張ディレクトリだけでビルドして package すると、中身の入っていない `.vsix` になる。

#### 🔴 自分の誤り: 層を 1 つ見て「存在しない」と判断しかけた

`seq.effect()` / `seq.instrument()` / `seq.ui()` について、`Sequence` クラスの public メソッドを
列挙して**「存在しない」と結論しかけた**。実際は **interpreter の dispatch**
（`packages/engine/src/interpreter/process-statement.ts:281,285`）と
`signal-chain/runtime.ts:53,76` が DSL 表面として扱っており、README の記述は正しかった。
**DSL の表面はクラスのメソッド一覧ではない。** [[enumeration-stops-one-level-too-early]]

同様に検算して**乖離が無かった**もの: `compressor()`/`limiter()`/`normalizer()` の no-op
（`rust-engine-player.ts:1462` が warn only）/ LinkAudio の default off（`Cargo.toml:23`）/
ディレクトリ構造 11 項目 / 参照している issue 番号 10 件の状態。

`docs:check` exit 0 / lint exit 0 / `tests/docs` + `tests/repo` 86 passed。

Closes #937

---

### docs: fold the remaining docs-sync PRs and fix the version claims they found (Sep 13, 2026)

**Issue**: #933。#930 / #907 / #902 / #901 / #900 を取り込み、**#904 と #929 は close**した。

#### 🔴 #904 はマージしてはいけなかった — が、発見は正しかった

#904 は「4.0.1 の bump が漏らしたページ」を直す PR で、**main は既に 4.1.0** なので
マージすると**版が巻き戻る**（`+` 側に `4.0.1` が 16 箇所）。
**しかし指摘は当たっていた** — 4.1.0 の bump が届いていない箇所が残っていた:

| 箇所 | 直前の値 | 直した値 |
|---|---|---|
| `docs/core/INDEX.md:5` | 拡張 **3.0.0** / `DSL_VERSION 1.2` | 4.1.0 / `DSL_VERSION 2.0` |
| `sites/dev/{,en/}editor/vscode-architecture.md:15` | package version **3.0.0** | 4.1.0 |
| `sites/dev/{,en/}editor/vscode-architecture.md:1154/1155` | version **3.0.0** | 4.1.0 |

**2 版分（3.0.0 → 4.0.1 → 4.1.0）取り残されていた。** #904 の中身だけ採って 4.1.0 で書いた。

#### 🔴 版の列挙はこれで 3 回連続で漏れている

| 版 | 漏れ | 後始末 |
|---|---|---|
| 4.0.1 | 複数ページ | `10d3c7eb`「follow the bump into the pages it missed」を後出し |
| 4.1.0 | `README.md:55` | PR #928 の中で修正 |
| **今回** | 上の 5 スポット | 本 PR |

原因は毎回同じで、**grep のパターンが「現在の版の数字」や特定の強調記法に依存していた**こと。
`**4.0.1**` と `"version"` を狙ったパターンは、`VS Code 拡張 **3.0.0**` や
`package version 3.0.0` を**構造的に拾えない**（探しているのが「古い版」ではなく
「**版を名乗っている場所**」だから）。

**今後は数字に依存しないパターンで数える**:

```
(拡張|extension)[^0-9]{0,40}[0-9]+\.[0-9]+\.[0-9]+|package version [0-9]+\.[0-9]+\.[0-9]+|Current release
```

24 箇所が挙がり、1 つずつ「現在の版を名乗るのか／履歴記述か」を判定した。
履歴（`DEVELOPMENT_MAP:240` の #883、各 provenance Note、`architecture-overview:620`）は触っていない。

#### ついでに直した 2 件

- `sites/dev/en/editor/vscode-architecture.md` の `contributes.commands` が **(17)** だったが、
  `package.json` の実体は **15**。ja 側は 15 で正しく、**en だけがずれていた**
- `docs/testing/{TESTING_GUIDE,PERFORMANCE_TEST}.md` のインストール例が
  `orbitscore-0.0.1.vsix` のままで、**コピペすると失敗する**。
  `orbitscore-darwin-arm64-*.vsix`（`release.yml:129` の命名と一致）へ直した。
  `docs/user/{ja,en}/GETTING_STARTED.md` にも同じ例があるが、**両方 DEPRECATED 宣言付き**なので触っていない

#### #902 の衝突は「分割前 vs 分割後」だった

HEAD 側が `output.rs:254-260` / `session.rs:691-718` という**分割前のパス**を指したままで、
#902 が `output/lines.rs` / `output/render.rs` / `session/dispatch.rs` へ貼り直していた。
**参照リストは #902 側を採り**、frontmatter は HEAD（`verified-against: f2245bb` が新しい）を採って、
Note は**両側の固有文を文単位で統合**した。

#### #929 は差分 0 だが中身が重要（→ issue へ）

🔴 **E2E-P が裁定 D′ と旧 `√2 · equal_power_pan` 則を区別できない**ことを指摘している。
`hardLeftCh1 / hardLeftCh0 ≤ 0.05` も `centerRms / noPanRms ≈ 1` も**旧則で通る** —
発音側の差は 3 本すべてに等しく掛かるので比を取ると消えるため。
その他の指摘とあわせて issue 化した。

`docs:check` exit 0 / lint exit 0 / `npm test` 全件 pass。

Closes #933

---

### docs: re-anchor the dev-site code pointers onto the #896 split (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `claude/docs-sync-pr896`

PR [#896](https://github.com/signalcompose/orbitscore/pull/896)（#888 子 2・`session.rs` 2,605 → 439 /
`output.rs` 2,587 → 322 コード行）へのドキュメント追従。

#896 は `// FILE:START-END` 引用ブロックを分割後のモジュールへ張り直しており、`npm run docs:check`
は 948 件すべて緑である。**しかし `check-citations.mjs` が見ているのは引用ブロックだけ**で、
本文中のインライン参照と各章末「参考にしたコード」の `path:line` は検査対象外だった。
その結果、**dev サイトに 44 箇所の宙に浮いた参照が残っていた**（`output.rs:3290-3322` など、
445 行しかないファイルへの参照）。

本コミットはそれらを**シンボルから引き直して**再アンカーした（ja / en 両方）:

- `sites/dev/rust-engine/index.md` — コマンド表の出典が単一 `match` ではなくなった旨を追記し、
  `session/run_loop.rs` / `session/dispatch.rs` / `dispatch_plugin.rs` / `dispatch_transport.rs` へ分解
- `sites/dev/rust-engine/insert-bus.md` — `InsertBusStage` の 2 つの参照が同一定義に解決するため 1 本へ統合
- `sites/dev/rust-engine/capture-verification.md` — `CAPTURE_RING_SECONDS` / `OutputStream` と
  `render_block_with_sources` が別ファイルへ分かれたため 2 本へ分割
- `sites/dev/signal-chain/mixer-audio-line.md` — post-loop が `output/render_full.rs` へ移った
- `sites/dev/plugin-hosting/plugin-ui.md` — `ClosePluginUI` が `session/dispatch.rs` へ移った
- 上記 5 章の `verified-against` / `verified-at` を `9c29e45` / `2026-09-12` へ更新

`/docs` 側も 2 件:

- `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` — `validate_line_program` の `Pan` 受理と
  バス上 pan 則（`line_pan_coefficients`）を `output/line_program.rs` / `output/dsp.rs` へ
- `docs/research/ENGINE_DAEMON_PROTOCOL.md` — 最後の session 切断の判定を
  `session/params_plugin.rs` の `SessionRegistration::disconnect` へ

🔴 **発見: これらの参照は #896 より前から既に壊れていた。** 旧 `path:line` を `9d39d2e`
（#896 の base）で引き直したところ、**確認した 34 箇所のほぼ全部が無関係な行を指していた**
（例: `output.rs:823-846` は「active flag snapshot」と書かれていたが実際は `MasterLine::new`、
`session.rs:1271-1284` は「session 切断 trigger」と書かれていたが実際は outproc frames-clamped の
ticker）。**引用ブロックだけがラチェットで守られ、その隣の散文参照は誰にも検査されずに漂流していた。**
CLAUDE.md「規律を足す時は、同時にそれを守らせる仕組みを足すこと」の未適用箇所である。

**実装・テストは 1 行も変更していない。**

---

### docs: re-anchor the dev-site prose citations that PR #895 moved out of engine_wrap.rs (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `claude/docs-sync-pr895`

PR [#895](https://github.com/signalcompose/orbitscore/pull/895)（merge commit `9d39d2e`）の
ドキュメント追従。`engine_wrap.rs` は 6,418 → 424 コード行になり、21 の子モジュールへ実体が移った。

### 🔴 `docs:check` が見ていない引用が 40 件残っていた

PR #895 は `// FILE:START-END` の**コードブロック引用**（`docs:check` が文字単位で突合する層）を
すべて直していた。直っていなかったのは、**本文と「参考」節の散文引用**である。

| 層 | #895 で直ったか | 機械検査 |
|---|---|---|
| ` ```rust // path:start-end ` のコードブロック | ✅ | `sites/dev/scripts/check-citations.mjs`（948 件） |
| 本文の `` `engine_wrap.rs:6470-6560` `` 等 | ❌ **40 件が残存** | **無い** |

`check-citations.mjs` はフェンス直後のヘッダ行しか見ないので、散文に書かれた path:line は
**ラチェットの外側**にいる。今回はそこを実ファイルへ手で突き合わせて貼り直した。

🔴 **この 40 件は #895 より前から line がずれていた**（base `0819a88` で実測。例:
`engine_wrap.rs:4455` が指していたのは `path: &std::path::Path,` の行だった）。
ただし #895 で**ファイルそのものが変わった**ので、行ずれではなく到達不能になった。

### 直した範囲

`sites/dev/`（ja）と `sites/dev/en/`（en）の 6 章 × 2 言語:
`rust-engine/index.md` / `rust-engine/insert-bus.md` / `signal-chain/index.md` /
`signal-chain/mixer-audio-line.md` / `plugin-hosting/catalog.md` / `plugin-hosting/plugin-ui.md` /
`glossary.md` / `rust-engine/oop-children.md`。

置換は 40 件の行番号付き引用と 18 件の散文言及で、**ja / en の件数一致を assert して**適用した
（片方だけ直る事故を機械で防いだ）。

### DSL 正本（`docs/core/INSTRUCTION_ORBITSCORE_DSL.md`）も 5 箇所直した

MX.4 の「今日の現在地」表が `SetBusRouting` の kind 拒否と forward-only 拒否を
`engine_wrap.rs:7212-7216` / `:7237-7241` / `:5802-5806` / `:7207-7211` で引いていた。
実体は `engine_wrap/bus_lines.rs` の `set_bus_routing` にある:

| 規則 | 現在地 |
|---|---|
| `output '<name>' must be a sum bus` | `engine_wrap/bus_lines.rs:299-303` |
| `send '<name>' must be an aux bus` | `engine_wrap/bus_lines.rs:325-329` |
| forward-only（output） | `engine_wrap/bus_lines.rs:292-296` |
| forward-only（send） | `engine_wrap/bus_lines.rs:318-322` |

### frontmatter は触っていない（意図的）

`verified-against` を新しい SHA へ上げると「章全体を再検証した」と主張することになる。
本 PR が突き合わせたのは `engine_wrap/` 配下の引用だけで、同じ章が引いている
`session.rs` / `output.rs` は **PR [#896](https://github.com/signalcompose/orbitscore/pull/896)
（`9d39d2e` の直後にマージ）で分割済み**であり未検証である。`f23eb5d` のまま残すのが正しい。

### docs(dev-site): re-anchor the source pointers left behind by the #888 child-3 split (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `claude/docs-sync-pr897` / **追従元**: PR [#897](https://github.com/signalcompose/orbitscore/pull/897)（merge `6dcd80bb2086fd6ced22e0c9711a7063e45ee535`）

PR #897 は `orbit-vst3-host/src/lib.rs` / `orbit-plugin-scan/src/lib.rs` /
`orbit-audio-sandbox/src/transport.rs` を分割し、dev サイトの **`// FILE:START-END`
引用ヘッダ 32 件**を移動先へ追随させた。しかし各章末の **`## Sources` / 「Further reading」の
散文ポインタは旧パスのまま**残っていた。

🔴 **`docs:check` はこの取りこぼしを構造的に検出できない。**
`sites/dev/scripts/check-citations.mjs` が突合するのは ```` ```rust ```` ブロック先頭の
`// FILE:START-END` ヘッダだけで、**散文の中のバッククォート付きパスは走査対象外**である。
そのため #897 は `948 citations / 0 failed` で緑のまま、**17 種 34 箇所**（ja / en 対）の
死んだポインタを残せた。

本コミットはその 17 種すべてを移動先へ張り直した（ja / en 対で 8 ファイル・計 34 箇所）:

| 旧 | 新 |
|---|---|
| `transport.rs:79-87`（`EVT_SLOTS`） | `transport/layout.rs:33-41` |
| `transport.rs:265-277`（evt ring / `dirty_epoch`） | `transport/layout.rs:222-234` |
| `transport.rs:359-378`（`ReleaseAcquireSeq`） | `transport/event_ring.rs:37-56` |
| `transport.rs:512-538`（`EventRingChild::service`） | `transport/event_ring.rs:192-218` |
| `transport.rs:1213-1225`（`UiPumpNotification`） | `transport/ui_codec.rs:33-45` |
| `transport.rs:1355-1374`（`UiPumpState`） | `transport/ui_pump.rs:63-82` |
| `transport.rs:113-143,173-288`（`CONTROL_*` / `SharedRegion`） | `transport/layout.rs:67-97,127-239` |
| `transport.rs:2031-2041`（`create_shared`） | `transport/shm.rs:171-186` |
| `plugin-scan/src/lib.rs` 9 件（カタログ型・role 判定・scan dir・dedup・atomic write） | `types.rs` / `dirs.rs` / `clap_scan.rs` / `vst3_scan.rs` / `catalog_io.rs` |

`docs/planning/DEVELOPMENT_MAP.md` の 2 件（`extra_scan_dirs_from_env` の実装位置、
`reset_child_starting` の在処）も同様に張り直した。前者は「`CLAP_PATH` 対応は同じ関数に
1 行並べるだけ」という**着手手順そのもの**を指すポインタで、死んだままだと実装者が迷う。

`verified-against` / `verified-at` は**更新していない**。STYLE_GUIDE §4 の
「小規模 cross-link / 体裁修正のみ: 更新しない（本文内容と code の対応関係に変更がないため）」に
該当する — 純粋な移動なので本文の主張は 1 つも変わっていない。

検証: `npm run docs:build`（user / dev）両方緑 / `npm run docs:check` **948 citations / 0 failed**。
張り直した 17 種は docs:check の対象外なので、`sed -n '<start>p;<end>p'` で各範囲の先頭行・
末尾行を**実ファイルから目視照合**した。

### docs: follow the install-route change into the user site (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `claude/docs-sync-pr906`

PR [#906](https://github.com/signalcompose/orbitscore/pull/906)（マージコミット `85f29aa`）の追従。
同 PR で**リリースページが持つ内容が変わった**ため、user site の記述を合わせた。

### 何が食い違ったか

`release.yml` の `--notes-file` が先頭に置くのは、**Assets からの入れ方の 1 行と、正本
（`sites/user/getting-started/installation.md`）へのリンクと、動作環境の注意**である
（`.github/workflows/release.yml:244-264`）。**手順そのものはリリースページに載らない。**

一方 user site の installation 章は、`::: tip` の中で「リリースページを開くと、そのページに
インストール手順も載っています」と書いていた。#906 以前から v4.0.0 で外れていた約束であり、
#906 の後も**手順ではなくリンクが載る**ので、どちらの意味でも成り立たない。

### やったこと

| ファイル | 変更 |
|---|---|
| `sites/user/getting-started/installation.md:33` | tip を「Assets に直接行ける / 先頭に動作環境とこのページへのリンクが置かれる / 手順の正本はこのページ」に書き換え |
| `sites/user/en/getting-started/installation.md:33` | 同内容の英語版（バイリンガル必須） |

### やらなかったこと

- **`docs/user/ja/USER_MANUAL.md:65`** に同じ文が残っているが、この文書は **DEPRECATED で
  「履歴として保持」（#237）**。#906 でも同じ理由で意図的に触れていないため、追従対象から外した
- **`sites/dev/`** — 差分はリリースノートの生成（配布面）であり、dev site の章立て
  （内部構造・評価経路）に該当する節が無い
- **実装・テスト** — 変更なし（本追従はドキュメントのみ）
### docs: fold the four pending docs-sync PRs into one branch (Sep 13, 2026)

**Issue**: #931。bot の docs 同期 PR **4 本**（#923 / #916 / #925 / #915）をまとめて取り込んだ。

#### 🔴 1 本ずつ入れると、入れるたびに残りが衝突し直す

4 本とも `WORK_LOG.md` を触るので、**1 本 main へ入れた瞬間に残り 3 本が衝突する**。
実際 4.1.0 の作業で #927 を入れた直後、4 本が一斉に `CONFLICTING` になった。
1 つの枝で解消すれば、衝突解消もゲートも 1 回で済む。判定は GitHub の
`mergeStateStatus` が `UNKNOWN` を返し続けたので **`git merge-tree --write-tree` で手元実測**した。

#### 🔴 #916 が「黙って」取り込めていなかった

ループで 4 本を merge した時、**#916 だけマージコミットが作られていなかった**。
原因は**サンドボックス**で、#916 は `.claude/hooks/README.md` を触るが、このディレクトリは
**Bash も git も書き込み拒否**される（[[hook-guards-must-check-the-path-not-just-the-branch]]）。
`git merge` はエラーを出していたが、私の `grep -E 'CONFLICT|Merge made'` がその行を落としていた。

**「4 本回した」は根拠にならない。** `git merge-base --is-ancestor <head> HEAD` を
4 本すべてに対して回して初めて分かった。**ループの結果は件数ではなく到達性で検算する。**

#### zsh は未クォート変数を単語分割しない

`U=$(git diff --name-only --diff-filter=U)` を `for f in $U` で回したが、zsh では
**分割されず 1 つの文字列として渡り**、`FileNotFoundError` になった。bash の癖で書いていた。

#### 衝突の解消方針

| 対象 | 方針 |
|---|---|
| `WORK_LOG.md` の新規エントリ同士 | **両側保持**（別の作業の記録なので落とすものが無い） |
| 既にアーカイブ済みの 3 エントリ | **HEAD（空）を採る** — `### ` 見出しの集合演算で本体 × アーカイブの重複 0 を確認 |
| `mcp-and-gated-e2e.md` の Note | HEAD が追従チェーンの上位集合（#917 まで）なので HEAD を採り、#915 固有の分割告知だけ足す |
| アーカイブの索引行 | 両方の説明を統合 |

#### 検査（bot は但し書きを読まない）

#915 の貼り直しは**散文中のファイル参照**で、`docs:check` の対象外（逐語一致するのは
`// file:start-end` の引用ブロックだけ）。**5 件を抜き取って実ファイルと突き合わせ**、
`autoStartConfiguredRustEngine()` / 括弧バランス判定 / `deactivate()` / `EvalMarkBridge` /
`setupErrorHandler` のいずれも正しい位置に着地していることを確認した。

`docs:check` exit 0 / lint exit 0 / `tests/docs` + `tests/repo` 86 passed。
本体が 1,970 行になったので `test: add a file-size ratchet` を 1 件アーカイブへ移した（162 行）。

Closes #931

---

### docs(hooks): follow PR #914 in the hook docs (Sep 13, 2026)

PR [#914](https://github.com/signalcompose/orbitscore/pull/914)（merge commit `7061245`）が
`.claude/hooks/pre-edit-check.sh` の判定を「ブランチ名だけ」から
「ブランチ名 + **編集先が repo 配下か**」に変えたので、フックの挙動を書いている
ドキュメント 2 箇所を実装に追従させた（ドキュメントのみ・実装とテストは変更なし）。

#### 変更内容

- `.claude/hooks/README.md` §1: 「対象外 / 判定できない入力の倒し方」の表を追加。
  plan file（#153）と **repo 外の絶対パス**（#913）が allow、相対パス・`..` を含む絶対パス・
  `file_path` 無しは deny 側へ倒れることを明記。テストの所在（`tests/repo/pre-edit-hook.spec.ts`）も追記
- `CLAUDE.md` "Hook Protection": `pre-edit-check.sh` の説明に「**リポジトリ配下のみ**」を追記

#### 差分外だが同じ節にあった誤り（併せて訂正）

`.claude/hooks/README.md` はブロック方式を **exit 2** と書いていたが、実装は
Issue #119 以降 `permissionDecision: "deny"` の JSON を stdout に出して **exit 0** である
（`.claude/hooks/pre-edit-check.sh:91-92`）。#914 の差分ではないが、書き換えた同じ箇条書きの
中にあったため放置せず訂正した。

#### 追従不要と判断したもの

- `docs/specs-v2/` / `docs/core/INSTRUCTION_ORBITSCORE_DSL.md`: DSL の構文・意味論は無変更
- `sites/user/` / `sites/dev/`: 両サイトとも `pre-edit-check` / Claude Code hooks に言及していない
  （`grep -rl "pre-edit" sites/` が 0 件）。バイリンガル追従の対象も発生しない
- `docs/archive/WORK_LOG_2026-09.md`: #914 が WORK_LOG の行数上限（2,000 行）のために
  退避した既存エントリ。過去ログなので触らない

### docs: record the 4.1.0 follow in the dev-site provenance Notes (Sep 13, 2026)

PR [#928](https://github.com/signalcompose/orbitscore/pull/928)（#926・4.1.0 バンプ）への
docs 追従（実装・テストは変更なし）。

#928 は dev サイト 4 ページ（`orientation/architecture-overview.md` と
`decisions/adr-002-dsl-v3-pivot.md` の ja + en）の**本文の版表記だけ**を 4.1.0 に上げ、
同じページの冒頭 Note は「2026-09-12 に #883（拡張 **4.0.0**）まで追従しました」のままだった。
**本文と来歴注記が同一ファイル内で食い違う**ので、Note に 2026-09-13 の 4.1.0 追従を追記した。

`verified-against` / `verified-at` は**据え置き**。STYLE_GUIDE §4「`verified-against` の更新
ポリシー」では「小規模 cross-link / 体裁修正のみ」は更新しない、であり、版表記の差し替えは
本文と code の対応関係を変えない。2026-09-12 の #883 追従も同じ 4 ページで `56c34c3` /
`2026-09-11` を据え置いており、その前例に合わせた。

🔴 直さず報告（PR 本文へ）:

- **版表記の同期を守らせる仕組みが無い。** #928 の記述（本ログ上方）自身が「4.0.1 でも
  取りこぼして `10d3c7eb` を後から出した」「**2 回連続で同じ形**」と書いているのに、
  `packages/vscode-extension/package.json` の版と doc の版を突合するテストは存在しない
  （`tests/docs/` は `planning-issue-state` と `worklog-size` のみ）。CLAUDE.md の
  「規律を足す時は、同時にそれを守らせる仕組みを足すこと」に対して、仕組みだけが欠けている
- **`CHANGELOG.md` が 1.1.0（2026-05-06）で止まっている。** 2.0.0 / 3.0.0 / 4.0.0 / 4.0.1 /
  4.1.0 のどれも項が無く、`[Unreleased]` は #212 の内容のまま。どの版を遡って書き起こすかは
  リリース判断なので追従作業では決めない

Part of #926

---

### chore(release): bump the extension to 4.1.0 (Sep 13, 2026)

**Issue**: #926。出すのは **#922（振る舞いの修正）** + #918 / #920（テストのみ）。

#### 🔴 なぜ patch ではなく minor か

**patch は「振る舞いが変わらない」の意味**で、それは嘘になる（audio が +3 dB）。
**major でもない** — semver が問うのは**利用者の入力との契約**で、v3.0.0（設定とコマンドが消えた）
v4.0.0（暗黙 master が消えた）と違い、**4.1.0 では譜面を 1 文字も変えなくていい**。
加えて #922 は実質バグ修正（誤って 3 dB 減衰されていた audio を戻した）。
**minor が「聞いて分かる変化はあるが書いたものは壊れない」の信号。**

#### 🔴 版を名乗る箇所は 11 ではなく 12 あった

**最初の列挙は 11 で止まり、`README.md:55` を落とした**（`- **Post-2.0 (shipped on \`main\`,
extension 4.0.1)**` の行）。同じ README の 5 行目は直っていたので、**ファイル単位では
「直した」ように見えていた**。`git diff --stat` が `README.md | 2 +-` と出ているのを
「1 行で足りる」と読んだのが誤り。

パターンの穴はこうだった: 最初の grep は `**4.0.1**`（強調記法）と `"version"` を狙っており、
**地の文に埋まった `extension 4.0.1`** を拾わなかった。数え直しは
`(拡張|extension)[^0-9]{0,14}4\.0\.[0-9]` の双方向パターンで行い、残る 4.0.0 の言及が
**すべて #883 の履歴記述**であることまで確認した。


前回（4.0.1）も取りこぼして `10d3c7eb`「follow the bump into the pages it missed」を
後から出している。**2 回連続で同じ形で落ちた** — 「grep で列挙して件数を固定する」だけでは
足りず、**落ちるのは常にパターンが想定していない書き方の方**である。
内訳は `package.json` 正本 / `CLAUDE.md` / `README.md` **×2** / core spec ×2 /
dev サイト ja+en ×6。設計文書の「4.0.1」は当時の記録なので触っていない。
`ENGINE_VERSION` / `DSL_VERSION` は別軸（設計 656 §4.4）。

#### マージ前ゲート（main `77a17905` で実測）

実機 gated **46 passed / 46（skip 0）** / cold install exit 0 / build / std-gain 実機 3 行 /
CI 4 チェック全 pass。

🔴 **E2E-5 の比率は `× √2` が消えても不動** — `9.999999829984711`（期待 10・誤差 1.7e-8）。
絶対レベルは √2 倍（`0.0867` → `0.1226`）でも比率は動かないことを実測で確認。

#### リリースノートに書くこと

audio が +3 dB / 🔴 **ヘッドルームが 3 dB 減る**（リミッタが無い系なので重ねたミックスは
0 dBFS に近づく）/ pan がフルスケールを超えなくなった / gated が skip 0 の 46 件に。

### docs: follow PR #918 — the self-launching test placement rule, and two WORK_LOG separators (Sep 13, 2026)

PR [#918](https://github.com/signalcompose/orbitscore/pull/918)（マージ `77a1790`）の追従。
実装は触らない（差分は `tests/` と `CLAUDE.md` と WORK_LOG のみ）。

#### 1. 自前アプリのテストの配置規則が CLAUDE.md にしか無かった

元 PR は `launchIsolatedOrbitStudio()` が冒頭で `killHarnessInstances()` を呼ぶため、
自己完結のテストを共有セッションの途中に置くと後続が `ECONNREFUSED` で落ちることを
実測し、spec の境界にコメントを残した（`tests/e2e/orbitstudio-mcp-gated.spec.ts:6550-6553`）。
これはハーネスの不変条件なので、以下へ展開した:

- `docs/testing/E2E_HARNESS_SPEC.md` §3.1（新設）— 共有セッション / 自己完結の 2 種別と順序規則
- `sites/dev/editor/mcp-and-gated-e2e.md` と `sites/dev/en/editor/mcp-and-gated-e2e.md`
  — `killHarnessInstances()` の節の直後に節を 1 つ追加（引用は 6550-6553）。
  `verified-against` を `77a1790` へ、Note の追従先に #917 / #918 を追記

#### 2. WORK_LOG の区切りが 2 箇所崩れていた

| ファイル | 症状 |
|---|---|
| `docs/development/WORK_LOG.md` | #918 のエントリと次のエントリの間に `---` が無く、本文の次の行が `###` 見出しになっていた |
| `docs/archive/WORK_LOG_2026-09.md` | アーカイブへの追記で `---` が 2 連続になっていた |

どちらも他のエントリの形（空行 + `---` + 空行）に揃えた。

#### 検証

`npm run docs:build -w @orbitscore/user-site` / `-w @orbitscore/dev-site` / `npm run docs:check`。

#### 追従しなかったもの（PR 本文に出す）

- `sites/user/getting-started/engine-settings.md:29,33` の「チャンネル = ステレオ（2ch）」/
  「マルチチャンネル出力は未実装」が、同じサイトの `sites/user/mixing/routing.md:115` と
  食い違う。元 PR は 8ch デバイスで ch3/4 に音が出ることを実測しているが、
  この警告文の「マルチチャンネル出力」が DSL の宛先を指すのか設定 UI を指すのかは
  差分から確定できないので、書き換えずに報告に回した


---

### test(e2e): implement E2E-4/E2E-5 against a real >=4ch device (Sep 13, 2026)

owner が Loopback で **`OrbitScore E2E`（8ch）** を作成したので、`#611` O-surface で
唯一 skip されていた `E2E-4 / E2E-5` の本体を書いた。**実機 gated が初めて skip 0 の
46 passed になった**（#917 / #851 B-2）。

#### 固定したもの

| | 期待値 | 実測（4 周） |
|---|---|---|
| **E2E-5** `output(master, thru: true).output("3,4", db: -20)` | ch1/2 : ch3/4 = `10^(20/20)` | **9.999999818**（8 桁一致） |
| **E2E-4** `output(master, thru: false).output(cue)` | 終端の後ろには到達しない | `cutCue` = **厳密に 0** |

8ch あるので **ch5/6 を「誰も宛先にしていない対照」**として使い、E2E-4 の無音を
「小さい」ではなく「**未使用チャンネルと同じ床**」で判定している（4ch デバイスでは飛ばす）。

#### 🔴 Monitors を繋がなくてよいことを実測で確かめた

capture は **cpal へ渡す最終 `hw` を読み取り専用で tap** している
（`orbit-audio-native/src/output/render.rs:56-59`「tap であって mutation ではない」）ので、
デバイスがその先へ流すかに依存しない。クロックも刻む（**first callback 12 ms**）。
→ **BlackHole は不要**（設計 §8.3 の元案）。

#### red-first ではない。変異で代替した

O-surface の実装は v4.0.0 で出荷済みなので「実装前に書いて赤」は成立しない。
代わりに**期待値を壊す変異 2 種**で、この判定が区別できることを確かめた:

| 変異 | 結果 |
|---|---|
| E2E-5 の期待比 `10 → 3` | red（`expected 2.33 to be <= 0.12`） |
| E2E-4 が ch3/4 ではなく **ch1/2 を見る**（off-by-one） | red（`cutCue` が `cutMaster` と同値・`cutLeak = 1`） |

後者が重要で、**DSL は 1 始まり・`channelRms` は 0 始まり**なので取り違えが最も起きやすい。

#### 🔴 自分の誤り 3 つ

1. **配置**: 共有セッションのブロックの真ん中に置いたので、`launchIsolatedOrbitStudio` の
   `killHarnessInstances()` が共有アプリを殺し、後続の `#606 T1` / `E2E-K3` が
   `ECONNREFUSED` で落ちた。自前アプリ群の側へ移し、**境界にコメントを残した**
2. **後始末**: `fs.rmSync` を裸で呼んでいて `ENOTEMPTY` で 2 周続けて赤くなった
   （アサーションは全部通っていた）。**既に `removeHarnessTree` が
   kill → 終了待ち → best-effort 削除を持っていた**ので、手書きをやめてそれを使った
3. **Spotlight を索引中だと誤断**した。CPU は 0.0〜0.1% で、12 日間常駐していただけ。
   **メモリ使用量だけを見て動いていると推測した**のが誤り

#### 実機ゲートが 2 回メモリ不足で kill された

`claude` プロセスが **89 個 / 5.28GB**（11 日 23 時間動く `--resume` が 17 個）積み上がり、
free が 0.1GB まで落ちていた（swap は 0）。owner の許可を得て自分以外の **47 セッション**を停止し、
free 0.2GB → **8.5GB**。その後 1 周で全件緑。

#### 🔴 `-t` の限界を CLAUDE.md に足した

`-t 'E2E-4/E2E-5'` は 2 分で回る（自己完結テストなので）。**だが `-t` は
「そのテストが後続を壊すこと」を原理的に検出できない** — 上の誤り 1 は単独実行では
**自分だけ緑**になる。**開発は `-t`、影響の確認とマージ前ゲートは全件**。

### docs: follow the attenuate-only pan ruling into the specs and both sites (Sep 13, 2026)

PR [#922](https://github.com/signalcompose/orbitscore/pull/922)（#921 / `#851` B-3 の裁定 D′）へ
docs を追従（実装・テストは変更なし）。`docs/core/INSTRUCTION_ORBITSCORE_DSL.md` MX.4 に
「pan 則の改訂」を追記し、dev サイト SC-2 / RE-1 / RE-3 と user サイト `methods.md`（ja + en）を
`balance_pan`（中央素通り・端 `(1, 0)`）へ更新。audio が
+3 dB になる破壊的変更と `gain(-3)` の回避策を user 側に明記した。RE-1 の capture peak `0.70711` は「#921 より前の値・要再測定」と注記するに留めた（実機で測っていないため）。

🔴 **`docs/user/{ja,en}/USER_MANUAL.md` は追従させない**（main が bot の変更から落とした）。
両ファイルは冒頭で **`⚠️ DEPRECATED（非推奨・2.0.0 時点）… 本ファイルは履歴として保持しています（#237）`**
と宣言している。**履歴として凍結してあるものを現在の仕様へ更新すると、凍結の意味が消える**。
同じ判断は 2026-09-11 の「`USER_MANUAL.md` を直さない」（本ログ下方）と一致する。

🔴 SC-2 `Pan` 節のコードブロック 2 つが `line_pan_coefficients` を説明しながら `bus_topology.rs:226-229`（`channel_egress_active`）を引用していた誤りも直した。逐語一致なので `docs:check` は緑のまま通っていた — **引用チェッカは「正しい関数を引用しているか」を見ない**。

🔴 直さず報告: `INSTRUCTION_ORBITSCORE_DSL.md:1771`「`pan(random)` は発音側のまま」と #922 の前提「`event.pan` は本番コードで一度も設定されない」が食い違う（`packages/engine/src/core/sequence/scheduling/event-scheduler.ts:125`）。仕様判断なので追従作業では決めない。

### docs: record the #920 doc-sync audit (no spec follow-up needed) (Sep 13, 2026)

[#920](https://github.com/signalcompose/orbitscore/pull/920)（merge `59511c9`）の追従監査。
差分は `scheduler.rs` の `mod tests` 内テスト 1 本と #920 自身の WORK_LOG entry だけで、
**振る舞いを 1 行も変えていない**ため spec / site の追従は不要。`docs:check` 982 引用 0 失敗。

🔴 #920 が固定した「端で +3 dB」は **20 分後の #922（裁定 D′）が置き換えた**ので、
仕様文書へ書き写していない。書けば main と食い違う記述を新規に作ることになる。

追従できなかった点（E2E の穴・`docs/core/INSTRUCTION_ORBITSCORE_DSL.md:1992` の旧法則残存・
E2E-P の比のみアサーション）は **PR 本文に path:line 付きで列挙した**。E2E と baseline は触っていない。



---

### feat(audio)!: make both pan stages attenuate-only so panning can never clip (Sep 13, 2026)

`#851` B-3 の owner 裁定 **D′**（#921）。**発音側とライン側の両方**を減衰のみの
`balance_pan`（中央は素通り・端で持ち上げない）へ揃えた。

#### 🔴 調査で前提が覆った

裁定の選択肢は当初 A（現状維持）/ B（feed にも発音側 pan）/ C（DAW の pan 流儀）だったが、
**`event.pan` が本番コードで一度も設定されない**ことが分かって前提が変わった
（DSL の `pan` は wire 上 `BusLineOp::Pan` = ライン側へ行く・`session/params.rs:141`）。

つまり発音側の `equal_power_pan(event.pan)` は**定位ではなく、全 audio への固定 −3 dB**。
その結果:

- **audio は instrument feed より常時 3 dB 小さかった**（pan の有無に無関係）
- ライン側の `× √2` は「audio を戻す補正」として働き、**発音側を通らない feed だけを
  +3 dB へ押し上げて**いた

🔴 **一度 D（ライン側だけ減衰のみにする）を推奨して、実装前に撤回した。**
`dsp.rs` の doc コメントが `Do not remove the factor as "double compensation"` と
明示しており、発音側との合成を見ていなかった。**ライン側だけ変えると audio が端で
0.707 になって壊れる。** 発音側と対にして初めて成立する（それが D′）。

#### なぜ持ち上げをやめたか

🔴 **この系にはリミッタもクランプも無い**（実測）。`limiter()` / `compressor()` /
`normalizer()` は #502 で実装ごと消滅し代替経路が無く、float 出力にクランプも無い
（クランプは i16/i32/u16 変換時のみ）。**1.0 超はそのままデバイスへ行く。**
加えてライン Pan は**バランス**で、端へ振ると片チャンネルの中身を実際に捨てている。
`× √2` は**存在しないエネルギーを足していた**。

#### 旧則を固定していたテストは 16 件。うち pan のテストは 2 件だけだった

残る 14 件は `render_block_one_bus_applies_effect_then_sums` のような**合成・配線**のテストで、
期待値の式に `√0.5` が埋まっていた:

```
// center pan の equal-power gain は √0.5。tagged=2.0×√0.5×0.5、untagged=3.0×√0.5
```

**全 audio が一律に減衰されていたせいで、無関係なテストの算術にまで係数が漏れていた。**
これが「pan の設計判断ではなく audio 全体のレベルの問題だった」ことの裏づけになった。

🔴 置換は**網羅を確認してから**行った（18 箇所を grep で列挙し、期待件数を `assert` で固定）。
目的が「係数」でないテスト（channel stride / global gain）は、係数を落としても
**目的が残っているか**を見てから直した。

#### 実機の実測が予測と厳密に一致した

旧実測 `0.08701663` → 新実測 **`0.12306010509914503`**。比は **1.41421356 = √2**。
3 回の実測が 11 桁一致し、`noBus` と `sumOutput` も一致した（同じ信号が同じ経路を通るので
一致するのが正しい。旧 golden では 0.03% ずれていた）。

🔴 **旧 golden `0.0846173` は実測より 2.8% 低い緩い基準だった**（許容 12% に収まるので
誰も気づかない）。今回は実測値を根拠に置き換えたので基準が締まった。

#### 🔴 TS 側のユニットテストは 1 件も動かなかった

audio の絶対レベルが変わる変更なのに `npm test` 2,497 件が全部通った。
**この層を守っているのは E2E の golden だけ**である。

#### 補正機能は作らない

`.gain(db)` で書けるため。🔴 ただし **pan をスイープさせる時は補正量が位置で変わる**ので
`.gain()` では追随できない。必要になったら `global.panLaw()` を検討する。

#### 検証

`cargo test --workspace` 97 suite 緑 / fmt / clippy / cfg 4 象限 緑 /
`npm test` 2,497 passed / lint / `typecheck:e2e` 緑 / `docs:check` 982 引用 0 失敗 /
実機 gated **45 passed**（残る 1 件は E2E-4/E2E-5 の `unimplemented`。実装は PR #918 側で
このブランチには無い）。

---

### test(core): pin the instrument-feed vs centered-event pan asymmetry (Sep 13, 2026)

`#851` B-3 の裁定材料。**裁定そのものは owner**（#919）。

#### 🔴 まず訂正: 「未検証」は不正確だった

`#851` に「B-3 はまだ事実かは未検証」と書いたが、**「端で +3 dB」自体は cargo test が
既に固定していた**（`orbit-audio-native/src/output/startup.rs:2590` の `hard_left = SQRT_2`）。

未検証だったのは「**instrument feed が発音側の pan を通らない**」という**非対称の方**である。

#### 一次ソースで確認した事実

`render_multi_feeds` は feed を `*dst += *sample` と**素のまま加算**しており、
`equal_power_pan` を一切通らない。一方 audio event は通る（中央 0.707）。

| 素材 | 発音側 | ライン pan（端） | 着地 |
|---|---|---|---|
| audio event | 0.707（`equal_power_pan(0)`） | × √2 | **1.0 = unity** |
| instrument feed | **1.0（素通り）** | × √2 | **1.414 = +3 dB** |

#### 数値で固定した

`orbit-audio-core` に、**両者を同じ条件に並べて測る**テストを足した。
実測 `centered event = 0.70710677` / `feed = 1.0` / `ratio = √2`。

🔴 **`equal_power_pan(0) * SQRT_2` の掛け算では済ませていない。** それでは
**feed の経路を一度も通らない**ので、あとで誰かが feed にも発音側 pan を掛けても
緑のまま通る。`render_multi_feeds` を実際に走らせている。

変異 2 種で確認:

| 変異 | 結果 |
|---|---|
| feed にも発音側 pan を掛ける（= 非対称を解消する変更） | red（`feed must pass through unattenuated; actual=0.70710677`） |
| `equal_power_pan` を `(1,1)` にする | red（`centered event must be 1/sqrt(2); actual=1`） |

#### 🔴 未コミットのまま変異を当てて、新テストを消した

`git checkout -- <file>` で変異を戻そうとしたが、**テスト自体が未コミットだったので
一緒に消えた**。書き直して**先にコミットしてから**変異を当て直した。
memory `mutation-backup-must-use-tmpdir` は「コミット済みなら `git checkout --` が確実」と
書いているが、**その前提（コミット済み）を自分で満たしていなかった**。

#### 裁定に残る事実

**+3 dB は事実だが「クリップする」かは素材の振幅次第**（ピーク 0.708 超で 1.0 を超える）。
その先のリミッタ/飽和は未確認。選択肢 A（現状維持）/ B（feed にも発音側 pan）/
C（ライン pan の正規化を外す）と実測値は **`#851` のコメント**に整理した。
**B と C はどちらも既存の譜面の音を変える。**

---

### fix(hooks): let pre-edit-check.sh allow writes outside the repo on main (Sep 13, 2026)

owner 指摘:

> メモリ書くためだけにブランチ作るの良くないのでmainからでもメモリは書けるように出来んの？

#### 何が問題だったか

`.claude/hooks/pre-edit-check.sh` は `main` にいる時 Edit / Write を一律に deny していた。
判定は**ブランチ名だけ**で、**編集先のパスを見ていなかった**
（例外は `*/.claude/plans/*` のホワイトリスト 1 件）。

そのため**リポジトリの外**（`~/.claude/projects/<project>/memory/` / scratchpad / `~/.cvi`）も
巻き込まれ、**memory を 1 ファイル書くためだけに差分 0 のブランチを作って消す**という
運用が発生した（本日実際にやった）。

**このフックが守っているのは「main に直接実装を積まない」こと**で、repo の外は保護対象ではない。

#### 直し方

**リポジトリ外の絶対パスを一律に対象外にする。** 個別ホワイトリストは増やさない
（次に別の外部パスで同じことが起きる）。判定は「repo 配下かどうか」の 1 本。

**安全側の倒し方**: 相対パスは repo 相対なので repo 内扱い。
`..` を含む絶対パスは解決せず repo 内扱い（fail closed）。`file_path` 無しも deny へ落ちる。

#### 🔴 最初に書いたテストが 2 回続けて何も検査していなかった

**1 回目**: 「今 main にいるなら検査する」形にしたので、**feature ブランチと CI では
主要な検査が全部 skip され、空で緑**になった（memory `a-test-that-exists-may-never-run`）。
→ 使い捨ての git repo を 2 つ作り、HEAD を `main` / `1-feature` に固定して
`CLAUDE_PROJECT_DIR` で指す形に変えた。どのブランチから走らせても同じ判定を検査できる。

**2 回目**: fail-closed の検査に `${REPO}/../evil.ts` を使っていたが、これは
`"$PROJECT_DIR"/*` のグロブに `../evil.ts` が一致するので **`*..*` ガードが無くても deny** =
何も検査していなかった。**変異を当てて緑のまま通ったので判明した。**
→ **prefix から外れて `..` で repo 内へ戻る**形（`${REPO}-decoy/../${basename}/secret.ts`）に変えた。
これは `*..*` ガードが無いと allow に倒れるが、実際には repo 内へ着地する。

#### 変異検証（3 種・実出力を確認）

| 変異 | 結果 |
|---|---|
| `*..*` の fail-closed を外す | red（「判定できない入力は deny」が `expected 'allow' to be 'deny'`） |
| repo 内/外の判定を反転 | red（「repo 外は allow」と「repo 内は deny」の**両方**） |
| ガードを丸ごと無効化 | red（「repo 外は allow」） |

restore 後はいずれも 6 passed。

🔴 **`.claude/hooks/` は Bash の sandbox 書き込み拒否対象**なので、変異は Edit ツールで当てた。
最初は `python3` / `cp` で当てようとして**3 回とも書き込みが失敗しており、
「6 passed」は何も証明していなかった**（`git diff --stat` が無変更だったので気づいた）。

Closes #913

---

### docs(dev-site): re-anchor the extension-split file references and record the new module layout (Sep 13, 2026)

PR [#909](https://github.com/signalcompose/orbitscore/pull/909)（#887・`extension.ts` /
`mcp-server.ts` の 19 モジュール分割、マージコミット `ca745e8`）への**ドキュメント追従のみ**。
`packages/` と `rust/` とテストは 1 行も触っていない。

#### 何を直したか

dev 学習サイトの散文にある `extension.ts` / `mcp-server.ts` への行参照を、分割後の位置へ
付け替えた（ja / en 同時・合計 160 参照）。

- 範囲付き参照（`<file>:<a>-<b>`）: **110 件のうち 96 件**を再アンカー
- 基底名だけの参照（`` `extension.ts:3405` `` 等）: **62 件**を再アンカー
- `sites/dev/editor/vscode-architecture.md` の drift 節に、**分割の対応表**（主題 → 分割後の
  ファイル）と MCP `tools/list` の順序復帰（`8561210`）を追記
- 誤った地の文 2 件を修正: 「候補の組み立ては `extension.ts` 側」→ `dsl-providers.ts`、
  `EngineViewProvider` (`extension.ts` 側) → `engine-view-provider.ts`

#### 🔴 参照は分割より前から既に腐っていた

再アンカーの方法として、まず**分割前の `extension.ts` のその行範囲の中身**を新モジュール群から
内容一致で探した。**54 組中 17 組しか一致しなかった。**

原因は、**分割より前の時点で散文の行番号が既にずれていたこと**である。実測（`0f930f3` =
マージ直前の main）:

| 散文が指していた範囲 | 実際にそこに在ったもの | 記述 |
|---|---|---|
| `extension.ts:286-498` | `if (playheadActiveRanges.size > 0) {` | `activate()` 全体 |
| `extension.ts:500-521` | `decorationType.dispose()` | `deactivate()`（実際は 489 行目） |
| `extension.ts:2044-2198` | `globalInitialized = false` | `startEngine()`（実際は 1927 行目） |
| `extension.ts:3716-3726` | `function registerHoverProvider(` | カタログ不在の案内 |

**「範囲内」は「正しい」を意味しない**（#911 が同じ指摘をしている）。したがって内容一致では
引けず、**箇条書きが明示しているシンボル名で引き直した** — 各シンボルの定義位置を現在の
ツリーで読んで範囲を確定させている。

#### 直していないもの

- **#502 で削除された関数を指す 14 件**（`getConfiguredEngineKind()` /
  `resolveScsynthForUI()` / `startEngine()` の `sc` 分岐 / `bundleStatusItem` の engine kind
  コメント）。`sites/dev/decisions/adr-003-scsynth-bundle.md` と
  `sites/dev/editor/vscode-architecture.md:1066` に在る。**指す先が存在しない**ので範囲の
  付け替えでは直らず、箇条書きの文章そのものを書き換える判断が要る（#911 の 3 番）
- **`check-citations.mjs` に散文の範囲外検査を足すこと**（#911 の 1 番・本体）。仕組みの追加は
  テスト / スクリプトの変更なので、この追従 PR の範囲外


### docs(extension): fix a comment that the split itself made false, and record the split rationale (Sep 13, 2026)

`/code:peer-review-team` の comment-analyzer が出した 2 件。**コメントのみの変更**で、
差分にコメント行以外の追加 / 削除が 1 件も無いことを機械的に確認した。

#### 🔴 同じ PR 内で偽になったコメント

`docs-panels.ts` の `resolveDevDocsUrl` の doc が「`mcp-server.ts` の `DOCS_PUBLIC_BASE`」と
書いていたが、**定義元は `mcp-docs.ts:12`** で `mcp-server.ts` は再輸出しているだけ。

このコメントは `docs-panels.ts` を作った束 C（`9143a233`）の時点では**正しかった**。
束 F（`d8bda308`）で `mcp-docs.ts` を新設して定義元が移った時に、
**この横参照だけが追随しなかった。**

**束をまたいだ相互参照は自動では追随しない。** import なら型チェッカが捕まえるが、
**地の文の参照は誰も見ていない。**

#### 新設 19 モジュールのうち doc の無かった 6 本に module doc を足した

`mcp-sdk` / `mcp-types` / `mcp-docs` / `mcp-tools-engine` / `mcp-tools-editor` / `mcp-tools-plugins`。

🔴 **comment-analyzer の「他 16 ファイルには必ずある」は不正確だった** — doc が無いのは
40 ファイル中 12 件で、`completion-context.ts` / `plugin-state-bridge.ts` 等**分割前から
無いもの**も含まれる。「3 ファイルが普遍的な規約を破っている」わけではない。

ただし**設計 D5 の分割意図がコード側に一切残っていなかった**のは事実なので、
6 本に足した。特に `mcp-tools-*` には **`tools/list` の順序の制約**を書いた
（これが今日の退行の原因だった）。

#### 検証

差分がコメントのみ（機械確認）/ `npm test` 2,491 passed / lint 緑 / `tsc --noEmit` 緑 /
`typecheck:e2e` 緑 / `docs:check` 982 引用 0 失敗 / リポジトリのラチェット 64 passed。

**実機 gated は再実行していない。** コメントは出荷物の振る舞いに届かないので、
先の全件緑（`45 passed | 1 skipped`・`ratio 1.000015`）が有効なままである。

---

### fix(mcp): restore the tool registration order the split had changed (Sep 13, 2026)

Fable 監査が、Sonnet レビュアー 8 体が全員通した後に **MCP ツール一覧の順序の変化**を検出した。

#### 何が起きていたか

分割前の `mcp-server.ts` は docs 系 3 本（`get_dev_doc` / `search_dev_docs` /
`register_mcp_server`）を **plugin 系 6 本より後ろ**（23–25 番）に登録していた。
束 F で `registerEditorTools` に docs 系を含めたため、**17–19 番へ繰り上がり、
plugin 系 6 本が 3 つ後ろへずれた。**

MCP SDK の `tools/list` は `Object.entries(this._registeredTools)` を返す
= **登録順がそのまま一覧の順序**なので、これは**クライアントに見える観測可能な変化**である。

#### 🔴 なぜ 8 体が見落としたか — done 条件の検証コマンドが条件を見ていなかった

設計 §7.7 の done 条件は「25 本・**順序も**同一」と書いていたが、
指定していた検証コマンドが

```
grep -oE "'[a-z_]+'" | sort
```

で、**`| sort` が順序の情報を消していた。** レビュアーも私も Codex も
「集合が diff ゼロ」までしか確かめておらず、**順序は誰も見ていなかった**
（「列挙は一段手前で止まる」の形）。

**done 条件を書く時は、それを検査するコマンドが本当にその条件を見ているかを確かめること。**

#### 直し方

`registerDocsTools(server, handlers, docsSourceRoot)` を `mcp-tools-editor.ts` 内に切り出し、
`buildServer` を **engine → editor → plugins → docs** の 4 呼び出しにした。
これが分割前の 25 本の順序を再現する唯一の並びである。
副作用として `registerEditorTools` から `docsSourceRoot` が外れ、署名が揃った。

**恒久対策**: `mcp-server.spec.ts` に `tools/list keeps the exact registration order` を追加。
実サーバを立てて `tools/list` を叩き、順序を配列で固定する。
退行を再現する変異（docs を plugins の前へ）で red を確認済み。

#### 同時に直した 1 件

`extension.ts` の export が 27 → 28 に増えていた（`export type { EngineViewProvider }` を
分割時に足していた）。葉の `extension-state.ts` が根から型を取る形は設計が棄却した向きなので、
本籍の `engine-view-provider.ts` から取るようにし、根の型 re-export を落とした。
**main と HEAD の export 集合が完全一致（対称差が空）** になった。

#### 🔴 自分の件数主張が誤っていた

PR 本文と束 A のコミットに書いた「**31 箇所の代入を setter 化**」は再現できない。
実測は main の直接代入 **37 件** / HEAD の setter 呼び出し **32 件**。
設計 §14 の「件数の主張を書かない。何を変えたかを書く」に従い、
**数値を別の数値に差し替えず、主張自体を落とす**。

#### 別 issue に切り出した 1 件

散文の `## Sources` 参照 **110 件が存在しない行を指すようになった**（#911）。
`docs:check` はコードブロックのヘッダ引用しか見ないため、**982 件が緑のまま**起きていた。
108 件はこの分割が壊したもの。「振る舞い不変の分割」と「#887 より前から在る腐りの修復」を
同じ束に混ぜると双方の検算ができなくなるので分けた（`BUNDLE_BRANCH_WORKFLOW.md` §5.1）。

#### 検証

`npm test` 2,491 passed（既存の期待値は 1 つも変えていない）/ lint 緑 /
`tsc --noEmit` 緑 / `typecheck:e2e` 緑 / `docs:check` 982 引用 0 失敗 /
ファイルサイズのラチェット 64 passed。

---

### fix(extension): remove a docblock that was copy-pasted from extension.ts, and mechanize the check (Sep 12, 2026)

`/simplify` のラウンド 1（4 観点並行）で見つかった 1 件を直し、同じ欠陥クラスを機械化した。

#### 何が起きていたか

`diagnostics-provider.ts` と `dsl-providers.ts` に、**`extension.ts` を説明する docblock が
そのまま複製**されていた。死んだ `// import * as os from 'os'` 行まで一緒に付いてきていた。

どちらのファイルにも**正しいファイル固有の doc が先頭に既にある**ので、複製は 2 つ目に居た。
先頭が正しいと、人は 2 つ目を読み飛ばす。

`// import * as os from 'os'` は main の `extension.ts:6` に元からあったもので、
`extension.ts` 側は触っていない（この PR の持ち込みではない）。
複製された 2 ファイルは**この PR で新規追加**したので、両方とも分割作業でのコピペである。

#### 🔴 最初に書いた検査は何も見ていなかった

`module-doc-purity.spec.ts` に足した最初の版は**先頭の doc ブロックだけ**を見ていた。
複製は 2 つ目に居るので、**実際の欠陥を戻す変異を当てても緑のまま通った**。
「新しいテストが緑」は「そのテストが何かを検査している」証明にならない
（memory `test-assertions-must-discriminate` の 3 回目）。

書き直して**ファイル内のすべての doc ブロック**を対象にし、変異 3 種で red を確認した:

| 変異 | 結果 |
|---|---|
| TS 間のコピペ（実際に起きた欠陥を戻す） | red・両ファイルを名指し |
| baseline の組を解消して表から消さない | red（厳密等価の向き） |
| 無関係な Rust 2 ファイル間のコピペ | red・両ファイルを名指し |

#### baseline は 2 組

364 ファイル / 1,355 ブロックを走査して衝突は 2 件だけで、どちらも effect / instrument の
並行実装（同じ構造の同じフィールドに同じ説明）という正当なもの。`KNOWN_SHARED_DOCS` に明示した。
**厳密等価**にしてあるので、解消したら表から消さないと red になる。

#### 引用の追随

2 ファイルから 8 行 / 7 行を削ったので、引用 20 件が落ちた。`--fix` の後、
**start と end が同じだけ動いたこと**（範囲の長さが変わった引用 0 件）と、
**オフセットが実際の削除行数と一致すること**（−8 が 12 件 / −7 が 8 件・ファイル単位で一意）を
検算した。`--fix` が別ブロックへ着地した形は排除できている。

#### `__*ForTest` は減っていない（実測）

#887 本文が「何が実際に困るか」として挙げたテスト専用の裏口は、
**分割前 13 本 → 分割後 13 本で 1 本も減っていない**（本文の「14 本」は末尾が `...` の概数）。
裏口を外すにはテストを書き直す必要があり、それは「既存テストの期待値を 1 つも変えていない」
という #887 の検算そのものを壊す。**分割では解消しない**ことを記録しておく。

#### 検証

`npm test` 2,490 passed（2,488 + 新規 2 件・**既存の期待値は 1 つも変えていない**）/
lint 緑 / `tsc --noEmit` 緑 / `docs:check` 982 引用 0 失敗。

---

### refactor(extension): split mcp-server.ts — the TS split is complete (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `887-extension-split`

#887 の**束 F（最終）**。**`packages/vscode-extension/src/` の全ファイルが 500 コード行以下**に
なった（超過 **0 件**）。

| ファイル | コード行 |
|---|---|
| `mcp-server.ts` | 1,161 → **271** |
| `mcp-tools-editor.ts` | 251 |
| `mcp-tools-plugins.ts` | 217 |
| `mcp-types.ts` | 148 |
| `mcp-tools-engine.ts` | 140 |
| `mcp-docs.ts` | 129 |
| `mcp-sdk.ts` | 96 |

### `buildServer` は 616 コード行の単一関数だった

ファイルを分けても 1 つの式なので閾値を満たせない。`session.rs` の `handle_command`
（1,028 行の単一 `match`）と同じ問題で、**owner 裁定（#888 子 2）に倣い中身を引数付きの
`register*Tools` へ切った**。`registerTool` の本文はインデントも含めて不変。

Codex が **ツール名 25 本の一覧が diff ゼロ**であること、および条件付き登録の 3 群
（`save_plugin_state` / `open_plugin_ui`・`close_plugin_ui` / `register_mcp_server`）の
述語が byte 単位で一致することを確認した。

### #887 全体の成果

| ファイル | 前 | 後 |
|---|---|---|
| `extension.ts` | 2,779 | **301**（89% 削減） |
| `mcp-server.ts` | 1,161 | **271**（77% 削減） |

新設 **19 モジュール**。ラチェットの baseline は 19 → **17 件**（`packages/vscode-extension/src/`
からは 1 件も残っていない）。

🔴 **`npm test` は 7 束すべてで 2,488 passed。既存テストの期待値の変更は 0 件。**
これが分割の検算そのものである。

### 引用と散文

引用は束ごとに壊れ、合計 **約 300 件**を直した。手順は
`--fix`（行番号）→ 本文一致で再アンカー → 本文をソースから再生成、の 3 段。

🔴 **散文の帰属は 4 束連続で腐っていた**（`extension.ts` の…と書いてあるものが別モジュールへ移った）。
`docs:check` は行が合っているかしか見ない。束 F では `buildServer` の `registerTool` 群と
docs 配信部の帰属を直した。

### refactor(extension): extension.ts is under 500 code lines (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `887-extension-split`

#887 の**束 E**。**`extension.ts` が 2,779 → 301 コード行（89% 削減）**になり、
ラチェットの baseline から外れた。

| 新設 | コード行 |
|---|---|
| `dsl-providers.ts` | **302**（補完・quick fix・hover の登録） |
| `diagnostics-provider.ts` | **127**（`updateDiagnostics`） |

`extension.ts` に残ったのは `activate` / `deactivate` / `showCommands` / `restartEngine` /
`reloadWindow` / `isTransportCommand` と、import・再輸出ブロックだけ。

### 🔴 この束は main が直接やった

Codex の発注が sandbox の `EPERM`（companion のログ書き込み）で**起動しなかった**
（memory `codex-rescue-sandbox-broker-gotcha`）。残りが小さかったので main が実装した
（CLAUDE.md「4 ラウンド目は main が直す」の一般化）。

### 🔴 import は「推測」せず「引き写す」

新モジュールに import を**自分で書こうとして名前を 5 つ外した**
（`detectPitchScopeContext` / `detectPlayArgContext` / `detectOutputArgContext` /
`detectEffectArgContext` / `analyzeMissingOutput` の受け方）。

そこで**束 E 前の `extension.ts` の import 群 111 行をそのまま引き写し**、
未使用分を `eslint --format json` の指摘で機械的に刈る方式へ切り替えた。**推測が 0 になった。**
残った型エラー 2 件（`registerHoverProvider` / `updateDiagnostics` に `export` が必要）も
コンパイラが名指ししたものだけを直した。

### 散文参照は「範囲を保てない限り動かさない」

束 D で範囲を 1 点に潰した失敗を踏まえ、**束 E 前の内容と一致した場合のみ**移す実装にした。
今回は 12 件すべて一致せず（散文の行番号がもっと古い版を指している）、**据え置いた**。
壊すより据え置く方が良い。

### 検証

`npm test` **2,488 passed**（6 束連続で不変・**既存テストの期待値の変更 0 件**）/
`npm run lint` / `npm run typecheck:e2e` / `npm run build` / `npm run docs:check` 982 引用 /
`dsl-completion-provider.spec` 15 passed / `output-code-action.spec` 1 passed /
`public-surface.spec` 38 passed（設計 §7.6 の done 条件）。

**残るは `mcp-server.ts`（1,161）= 束 F。**

### refactor(extension): move evaluation and agent handlers out of extension.ts (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `887-extension-split`

#887 の**束 D**。純粋な移動。

| 新設 | コード行 |
|---|---|
| `agent-handlers.ts` | **392**（`*ForAgent` 17 本 + `__pluginUiForAgentForTest`） |
| `run-selection.ts` | **152** |
| `mcp-register-command.ts` | **152** |
| `plugin-commands.ts` | **127** |

`extension.ts` は 1,461 → **715** コード行（開始時 2,779 の **26%**。目標 500 まであと 215）。

Codex は全 10 塊を `9143a233` と **verbatim 一致**で照合し、27 export の維持も確認している。
`activate().handlers` のオブジェクトリテラルは byte-for-byte 不変。

### 🔴 Codex に `npm test` の全件を頼んだのが間違いだった（束 0〜C）

束 C の Codex が構造的な事実を報告した:

```
Error: listen EPERM: operation not permitted 127.0.0.1:<port>
Tests  107 failed | 2381 passed
```

**sandbox が loopback の listen を禁じるので、localhost を使う 4 スイート（107 テスト）は
原理的に走らない。** CLAUDE.md が「Codex は sandbox で daemon protocol（localhost bind）・
MCP 系・実機 E2E が原理的に走らない」と明記しているとおりで、**私が読んでいたはずのこと**。

束 B / C の Codex はどちらも「2,488 passed は自分の出力ではない」と明記して報告を拒んだ。
**正しい態度である。** 束 D からブリーフを focused な spec だけに変えたところ、
**衝突なしで完走した。**

### 🔴 散文の参照は「範囲を潰さずに」直す

散文中に `extension.ts:3000-3032` のような**行範囲つきの参照**が 12 件あり、これは引用 header
ではないので `docs:check` が一切見ない。機械的に「関数の定義行 1 点」へ置き換えたところ
`3000-3032` → `592` のように**範囲が潰れた**。**劣化なので取り消した。**

取り消しに `git checkout -- sites/dev` を使って**引用の再アンカーまで巻き戻し**、やり直した。
さらにその過程で `extension.ts:654-654`（`} else {` の 1 行）という**潰れた引用**を作ってしまい、
元の 50 行（`run-selection.ts:63-112`）へ復元した。

**範囲を保って移せた 2 件だけを移し、残り 10 件は据え置いた。** 内容が一致しないものを
機械で動かすと、今回のように壊す。

### 検証

`npm test` **2,488 passed**（5 束連続で不変・**既存テストの期待値の変更 0 件**）/
`npm run lint` / `npm run typecheck:e2e` / `npm run build` / `npm run docs:check` 982 引用 /
`public-surface.spec` 38 passed / `start-engine-for-agent.spec` 4 passed。

### refactor(extension): move view, docs and flash out of extension.ts (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `887-extension-split`

#887 の**束 C**。純粋な移動。

| 新設 | コード行 |
|---|---|
| `engine-view-provider.ts` | **243** |
| `flash-config.ts` | **222** |
| `docs-panels.ts` | **104** |

`extension.ts` は 1,991 → **1,461** コード行（開始時 2,779 の **53%**）。

🔴 既存の `engine-view.ts` へは入れていない。あれは header で「vscode 非依存」を宣言した
純モジュールで、vscode に触る配線は**対になる新ファイル**へ置く（設計 §4.1 / D4）。

### 🔴 引用が緑でも散文は検査されない（3 回目）

`vscode-architecture.md` が「`engine-view.ts` の純関数がノードを組み立て、**`extension.ts` の**
`EngineViewProvider` がそれを `vscode.TreeItem` に写します」と書いていた。ja/en とも直した。

**3 束連続で同じ形の腐りが出ている**（束 A: 行数と状態の置き場所 / 束 B: stdout ルータの帰属 /
束 C: `EngineViewProvider` の帰属）。`docs:check` は**行が合っているか**しか見ないので、
**移した関数名で散文を横断検索する**のを各束の手順に入れている。

### 🔴 委譲先と同じツリーで作業して衝突させた（main の運用ミス）

束 B の Codex が正直に報告した: 検証中に main（私）が `npm test` を並走させ、さらに
コミットまでしたため、**Codex は一度も全テストを完走できなかった**（exit 130 で停止）。
Codex は「2,488 passed は自分の出力ではない」と明記して報告を拒んでいる。**正しい態度である。**

memory `delegate-work-needs-its-own-worktree` がそのまま当たっている。
検証は main の仕事なので結果に影響は無いが、**委譲先の時間を無駄にした**。
以後の束では、ブリーフから「全テストを回す」を外し、**focused な spec だけを求める**。

なお Codex は **AST 比較で 26 関数すべての本文が IDENTICAL** であることを確認しており、
これは main の residual 分類より強い証拠である。

### 検証

`npm test` **2,488 passed**（4 束連続で不変・**既存テストの期待値の変更 0 件**）/
`npm run lint` / `npm run typecheck:e2e` / `npm run build` / `npm run docs:check` 982 引用 /
`engine-command-awaits.spec` 10 passed（設計 §7.4 の追加 done）/ `public-surface.spec` 38 passed。

### refactor(extension): move the engine wiring out of extension.ts (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `887-extension-split`

#887 の**束 B**。束 A で代入を setter に替えたので、ここは**純粋な移動**。

| 新設 | コード行 | 中身 |
|---|---|---|
| `engine-handlers.ts` | **321** | stdout / stderr / exit / error のハンドラ 9 本 |
| `engine-process.ts` | **423** | engine パス解決・`startEngine` / `stopEngine` / `toggleEngine` ほか 11 本 |

`extension.ts` は 2,662 → **1,991** コード行。

### 🔴 `engine-lifecycle.ts` へ戻さなかったことが、テストで証明された

issue #887 の本文は「stdout/exit ハンドラは `engine-lifecycle.ts`（既存）へ」と書いていたが、
設計（Fable 起案・main が `grep` で裏取り）がこれを覆した。
`extension-wiring.spec.ts:48` が `engine-lifecycle` を `vi.mock` して `applyEngineExit` /
`applyEngineError` を spy にしており、**同一モジュール内の呼び出しは mock を通らない**。
戻した瞬間に spy が一度も呼ばれなくなり、テストを書き換えるしかなくなる。

**`extension-wiring.spec.ts` が 58 passed であることが、mock 境界の外側に置けた証拠**である。

### 引用 122 件 — 束 A で作った手順がそのまま効いた

`--fix`（行番号のみ）70 → 本文をソースから再生成して再アンカー 52。
束 A で書いた再アンカー手順を `$TMPDIR` のスクリプトとして再利用した。

🔴 **引用が緑でも散文は検査されない（2 回目）。** `plugin-ui.md` が
「**`extension.ts` の** stdout ルータはこの結果行を拾います」と書いているのに、
引用は `engine-handlers.ts` を指していた。ja/en とも帰属を直した。
移した関数名 7 つで横断検索し、他に同型が無いことも確認した。

### 検証

`npm test` **2,488 passed**（束 0 / A と同値・**既存テストの期待値の変更 0 件**。
`tests/` の差分はラチェットの baseline のみ）/ `npm run lint` / `npm run typecheck:e2e` /
`npm run build` / `npm run docs:check` 982 引用 / `extension-wiring.spec` 58 passed /
`public-surface.spec` 38 passed。

### refactor(extension): move module state to a leaf and turn 31 assignments into setters (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `887-extension-split`

#887 の**束 A**。分割の核心で、以降の束が「純粋な移動」になるための前提。

### 読みは live binding・書きは setter

ES module の import 束縛は**代入できない**が、読みは常に最新値が見える。そこで:

- **読み出し約 220 箇所の本文は 1 文字も変えていない**
- **代入 31 箇所だけ**が `setX(v)` になった

新設は `extension-state.ts`（103 コード行・leaf）と `playhead-decorations.ts`（124）。
`__*ForTest` **13 本**は名前も引数も本文も変えず、閉じている状態と同じモジュールへ移し、
`extension.ts` が `export { … } from` で再輸出する。**テスト側 239 箇所の変更は 0**。

`extension.ts` は 2,779 → **2,662** コード行。

### residual 322 行をすべて分類した

設計 §7.2 の done 条件。**未分類 0**:

| 分類 | 行数 |
|---|---|
| setter の定義と本体 | 54 |
| setter の呼び出し | 32 |
| 局所定数化 / 旧宣言 | 31+ |
| import / 再輸出 | 89 |
| 宣言・関数に `export` を前置（移動） | 25 |
| doc / コメント | 11 |

分類中に `outputChannel.appendLine` → `channel.appendLine` が一度「未分類」に落ちたが、
設計 §4.5 が予告した **narrowing のための局所定数化**だった
（`const channel = vscode.window.createOutputChannel(...)` の直後に `setOutputChannel(channel)`。
**同一オブジェクト**であることを実物で確認）。

### 🔴 今朝作った L-3 ガードが、今日のうちに TS 側で仕事をした

新設 2 ファイルが `git add` 前だったため、ラチェットが**名指しで検出**した
（`docs/design/888-file-size-ratchet-design.md` §13.10）。Rust 側で踏んだ穴が TS でも同じ形で出る。

### 引用 124 件が壊れた — 3 段階で直した

| 手段 | 解決 |
|---|---|
| `--fix`（行番号のみ） | 88 |
| 本文一致で移動先を特定（`export` 前置を剥がす） | 12 |
| 先頭行・末尾行を鍵にした再アンカー + **本文をソースから再生成** | 22 |
| 手で 1 組 | 2 |

🔴 途中で relocate スクリプトが **`/tmp` の一時パスを markdown に書き込んだ**（2 件）。
候補ディレクトリに `/tmp` を渡した私の使い方の誤りで、直した。

🔴 **引用が緑になっても散文は検査されない。** `vscode-architecture.md` が
「`extension.ts` は 4,115 行の大きなファイルで、状態はモジュールレベル変数に置かれています」と
書いており、**分割後は両方とも事実でない**。ja/en とも実態に合わせた。

### 検証

`npm test` **2,488 passed**（束 0 と同値・**既存テストの期待値の変更 0 件**）/
`npm run lint` / `npm run typecheck:e2e` / `npm run build` / `npm run docs:check` 982 引用 /
`grep -cE '^let ' extension.ts` = **0**。

### test(extension): freeze the public surface before splitting extension.ts (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `887-extension-split`

#887（TS 分割）の**束 0 = 道具を先に置く**。**ソースは 1 行も動かしていない**
（`git diff --stat main -- packages/` が空）。

### 🔴 Rust で 2 度踏んだ欠陥の TS 版を先に塞ぐ

Rust では `pub` 項目が `pub(crate) use` 経由で crate 外から消え、**全ゲート緑のまま通過**した。
TS に `pub(crate)` は無いが、同型の欠陥は「再輸出ブロックから 1 本抜ける」「型だけ export されて
値が消える」形で出る。しかも **`tests/vscode-extension/` は一度も型検査されていなかった**
（`tsconfig.tests.json` の include は `tests/e2e/**` のみ）。

`tests/vscode-extension/public-surface.spec.ts` を置き、**tsc と vitest の 2 層**に通した。
凍結したのは `extension.ts` **27** + `mcp-server.ts` 値 **11** = **38 値**と、型 **25**。
（設計文書の一覧を写さず、現物を `grep -E '^export'` して突き合わせた結果が一致）

main が実測した fail-before **3 件**:

| 変異 | 検出した層 |
|---|---|
| 存在しない export を import | tsc **TS2724** |
| 型を値として使う | tsc **TS2693** |
| 🔴 **実際に `export` を 1 本消す** | vitest（実行時に `undefined`） |

3 番目が本題。Rust で踏んだ欠陥はこの形だった。

### 引用追随スクリプトもリポジトリへ

`sites/dev/scripts/relocate-citations.mjs`。引用は `extension.ts` **248 箇所** /
`mcp-server.ts` **46 箇所**あり、全束で動く。`--fix` は**行番号しか直せない**ので、
移動先を中身から特定するこれが要る。Rust 分割では scratchpad に置いていて毎回探していた。

### 検証

`npm test` **2,488 passed**（main の基準 2,450 + surface spec 38・**既存テストの期待値の変更 0 件**）/
`npm run typecheck:e2e` / `npm run lint` / `npm run docs:check` 982 引用。


## Archived sections

Older entries have been archived by month for readability:

- [2025-09](../archive/WORK_LOG_2025-09.md)
- [2025-10](../archive/WORK_LOG_2025-10.md)
- [2026-02](../archive/WORK_LOG_2026-02.md)
- [2026-04](../archive/WORK_LOG_2026-04.md)
- [2026-05](../archive/WORK_LOG_2026-05.md)
- [2026-06](../archive/WORK_LOG_2026-06.md)
- [2026-07](../archive/WORK_LOG_2026-07.md)
- [2026-08](../archive/WORK_LOG_2026-08.md)
- [2026-09（前半・09-01〜09-12）](../archive/WORK_LOG_2026-09.md) — #883 束 C のレビュー round 1、#883 束 S / 本体 (#883)、#888 子 1、#878 を含む
