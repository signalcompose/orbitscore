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

### docs(design): design the native macOS OrbitStudio, and start a fresh plan and map (#848) (Sep 11, 2026)

owner 指示 2026-09-11。**凍結線を越えた後の本線**。設計は Fable（effort: xhigh）が起案し、
main が実行フロー②（独立第二意見）として一次ソースで検算した。

| 文書 | 行 | 何を決めたか |
|---|---|---|
| `docs/design/848-native-orbitstudio-design.md` | 577 | 完了条件 D-1〜D-8 / 層 2 のプロセス化 / セッションプロトコル / MCP の置き場 / Swift シェルの面積 / 配布（656 からの差分） / 拡張を仕様書として使う具体 |
| `docs/planning/IMPLEMENTATION_PLAN_NATIVE.md` | 230 | 段 N0〜N4・束 9 本・一方通行 10 件・engine 線 PR の付け替え表 |
| `docs/planning/NATIVE_DEVELOPMENT_MAP.md` | 297 | 現在地 → 第 1 リリースの筋・本線と枝葉・やらないこと |

#### 戻れない判断 2 件

**層 2 のプロセス化 = app が所有する Node 子プロセス + ヘッドレス host**。
in-process JSC / 常駐サービス / Rust に JS 埋め込み / Rust 移植を棄却。決め手は
**所有権を 1 つに固定すれば故障モードが今日と同じクラスに収まる**こと。常駐サービス案が
持ち込む孤児・発見・二重起動は、このリポジトリが 2026-09 に何度も踏んだクラス
（#624 二重 daemon・#779 shm 孤児・#830 のソケットパス 103 文字）。
**B → C は後から足せるが C → B は戻れない**ので戻れる側に倒した。

**プロトコルは作り直す = 双方向 JSON-RPC 2.0 over WebSocket**（同一リスナーの
`/rpc` + `/mcp`・JSON Schema 単一正本）。決め手は `open_file` 等が
**サーバ → エディタの逆方向**で、MCP にも LSP にもその形が無いこと。

#### main の検算（実行フロー②）

設計の土台になっている実測 2 件を一次ソースで確かめた。

| 主張 | 実測 |
|---|---|
| engine が native N-API addon に依存する（JSC / Rust 埋め込み案を棄却する根拠） | `packages/engine/package.json` の dependencies に **`@julusian/midi`** が実在 |
| 拡張 21 モジュール中 vscode 依存は 2 本だけ（層の分割が成り立つ根拠） | `ls src/*.ts` = **21**・`grep -l "from 'vscode'"` = **2**（`completion-context.ts` / `extension.ts`） |

どちらも一致。**ただし but 1 件**: 設計は `origin/main`（`229d6387`）で書かれており、
依存一覧に `supercolliderjs` が残っている。#502（PR #840）が入ると消えるので、
束が main に入った時点で本文の依存列挙を更新する（設計の結論は変わらない）。

#### main の follow-up（起案者が `tests/` を触れない指示だったため）

`tests/docs/planning-issue-state.spec.ts` の `DOCUMENTS` に新 2 本を追加した。
拡張版の 2 本と同じラチェットに載せる — 計画文書が閉じた issue を「未着手」と語る型の
ドリフトは、**文書が増えるほど起きやすい**。3 件緑。

#### owner 裁定待ち 14 件

設計 §14 に列挙。主なもの: detach（アプリを閉じてもセッションを残す）を第 1 リリースに
含めるか（推奨: 含めない）/ `packages/engine` の rename（推奨: しない）/ タグ名前空間 /
自動更新 / Swift の CI / `.app` の bundle id（推奨: 過去の VSCodium 版と同じ
`com.signalcompose.orbitstudio` を再利用）/ パリティ台帳で落としてよい拡張の表面 /
**app の版の正本**（推奨: `apps/OrbitStudio/VERSION` + `app-v<版>` をタグで強制）。

#### 🔴 owner 指摘で読み直した一次ソース 10 本（2026-09-11）

最初のブリーフは参照文書を **6 本しか挙げておらず、既に検討済みの文書を落としていた**。
owner の指摘で洗い直し、10 本 + Serena メモリ 3 本 + 協調計画を追送して設計を見直した。
**列挙が一段手前で止まる型**（memory `enumeration-stops-one-level-too-early`）の再発である。

設計が変わった主な点:

- **配布（§9）は再設計をやめ、`656-release-design.md` からの差分だけにした**。
  §9.0 に裁定 10 件 + Q-656 回答 8 件を「引き継ぐ / 失効」で 1 行ずつ仕分けた。
  失効したのは trim（Electron 前提）/「自作しない」/ **app 版 = 拡張版 のバージョン規則** /
  VSCodium 既定の bundle id / `ORBIT_GATED_EXT_MODE=installed`。
  引き継いだのは署名順序・identity・entitlements の実測手順・stop 条件・E2E-D3/D4/D5
- **§0b「既存の検討との関係」を新設**。文書ごとに「引き継ぐ / 棄却 / 失効」と本書での置き場を
  表にした。**過去の検討を無かったことにしていない**と読み手が確認できる形にするため
- `AUDIO_ENGINE_CORE_ARCHITECTURE.md` §5 の「musical timing を Rust へ移す引き金 =
  複数フロントが同じ timing を使う時」は、**本設計では引かれない**（フロントが 3 つでも
  timing を持つ層 2 は 1 プロセス）。MIDI / transport の Rust 化を急がない根拠として §4.6 に
- 地図に `USER_OUTCOMES_2026-09.md` と同じ粒度で「各段が終わるとユーザーは何ができるか」を新設

### test(e2e): launch the gated harness from stock VS Code (#830) (Sep 10, 2026)

🔴 **実機で回して 3 件の欠陥が出た。いずれも stock VS Code に切り替えて初めて現れたもので、
CI・ユニット・机上レビューのどれにも掛からない。** 実機ゲートを置いている理由そのもの。

| # | 症状 | 原因 |
|---|---|---|
| 1 | `The window terminated unexpectedly (reason: 'killed', code: '15')` のモーダルが出て**人待ちになる** | `pkill -f` が **Electron のヘルパーにも当たる**（同じ `--user-data-dir` 引数を継承するため）。レンダラを本体より先に殺すと本体が異常終了と判断する |
| 2 | 新規プロファイルの welcome / サインイン画面が毎回出る | stock VS Code の初回起動 UI。フォークはビルド時に無効化されていた |
| 3 | **MCP が 60 秒立たない** | `--user-data-dir` のパスが **105 文字**で、macOS の Unix ソケット上限 **103 文字**を超えた。VS Code 本体が `listen EINVAL` で即死し、ウィンドウが一度も開かない |

**出典**（2026-09-10・main が本ツリーで実測。owner のスクリーンショットが発端）:

- ヘルパーも一致する件: `pgrep -f 'MacOS/Code.*--user-data-dir=[^ ]*/orbitstudio-'` が
  **7 PID** を返した（本体 1 + Electron helper 群）
- ソケット長: 子プロセスの stderr に
  `WARNING: IPC handle ".../orbitstudio-named-device-0IgvF5/user-data/1.13-main.sock" is longer than 103 chars`
  と `Error: listen EINVAL` が出た。当該パスは `wc -c` で **105**。
  上限 103 は macOS の `sys/un.h` の `sun_path[104]` に由来する
- ⚠️ `os.tmpdir()` の長さ（ここでは 48 文字）は**マシンごとに変わる**ので、105 という数字は本機の値

**3 が本体で、いちばん質が悪い。** ハーネスからは「MCP が立たない」としか見えないので、
拡張が activation していないように読める。実際 main はそちらを 30 分調べた。
`os.tmpdir()` だけで 48 文字（`/var/folders/<2>/<28>/T/`）あり、説明的な prefix を足すと超える。

**対処**: temp root を `/tmp` へ移し prefix を短縮（`orbitstudio-` → `orbe2e-`）。加えて
**起動前にソケット長を検査して即座に理由を出す**（60 秒待って原因不明で落ちるのを避ける）。

🔴 **4 件目として「ワークスペースの信頼」を挙げていたが、実験で否定された（同日中に訂正）。**

途中で `--disable-workspace-trust` を足し、「`machine-overridable` の設定が未信頼ワークスペースで
無視されるからエンジンが起動しない」と書いた。しかし **`uuid` を入れた後にフラグを外して回すと通る**
（`#661 D-0` が 8.5 秒で緑）。「エンジンが起動しない」の原因は**最初から依存不足**であり、
信頼は無関係だった。フラグは削除した。

**なぜ誤ったか**: フラグを足した時点でまだ `uuid` が入っておらず、**前後どちらも赤**だった。
それを「フラグでは直らなかった」ではなく「フラグは必要」と読み、原因の説明まで書いてしまった。
🔴 **変化しなかった変数を原因に数えない。** 監査（Fable）が VS Code の実ソースを読み
「`machine-overridable` は未信頼でも落ちない。落ちるのは `restricted` だけ」と指摘し、
その反証手順（フラグ無しで 1 回起動する）に従って確かめた。

## 🔴 `pretest:e2e:gated` が engine の実行時依存を入れていなかった

診断の途中で `❌ daemon resolver failed: Cannot find module 'uuid'` が出た。
`npm run build` の `build:copy-engine` は dist をコピーするだけで、
`scripts/install-engine-deps.sh` を**呼んでいない**。**ビルドは緑・パッケージも成功し、
実行時にだけ落ちる**（#654 の `yaml` と同じクラス）。`pretest:e2e:gated` に追加した。

## 実機の結果

**29 passed / 1 failed**（528 秒）。落ちた 1 件は
`steps the live playhead through an instrument() sequence, rests included` で、
**main の既知ベースラインと同一**。新しい赤は無い。


実機 gated ハーネスの起動先を VSCodium フォークの OrbitStudio.app から stock VS Code へ切り替え、
`--extensionDevelopmentPath` と隔離した user-data / extensions dir をそのまま使う構成にした。
終了処理はアプリ名ではなく、ハーネス専用 `--user-data-dir` の共通接頭辞だけを対象にするため、
日常利用中の VS Code を巻き込まない。旧フォークのビルドスクリプトを削除し、非 archive 文書の
参照先を現行のネイティブ移行裁定へ更新した。フォークを畳む前にマージゲートを維持するための変更で、
実機 gated 全件の結果は main が本ツリーで実行して追記する。

---

### docs(planning): record the extension-stable freeze line and the native OrbitStudio line (#827) (Sep 10, 2026)

**Issue**: #827 / **ブランチ**: `827-stable-freeze-line` → main（docs のみ）

#### 何を決めたか（owner 裁定・2026-09-10）

別セッションで作られた「OrbitStudio ネイティブ移行 — 検討状況」を main が実測で検算し、owner が裁定した。
**会話の中でしか決まっていない状態**を解消するため、正本を `docs/planning/NATIVE_MIGRATION_2026-09.md` に置いた
（§0〜§11 = 検討状況をそのまま取り込み、**§12 = 裁定**。食い違えば §12 が正）。

| 裁定 | 内容 |
|---|---|
| 方針 | **拡張版を stable として凍結し `.vsix` をリリース**。制作（楽曲・インスタレーション）はこれを使う。以降はネイティブ OrbitStudio.app の新ラインへ |
| 🔴 凍結線 | **ステージ 2 の O-surface（PR-O4）完了**。DSL 表面の一方通行（W-2 / W-3 / W-18）がそこで確定し、以降は加法的 |
| 制作の要件 | 出口は master + sum / aux + **物理アウトのスピーカー振り分け**（O-surface に含まれる）。記録・render・ラック・`outs:` は不要。録音は `ORBIT_CAPTURE_WAV` で今日できる |
| 新ラインへ | O-multiout（PR-O5 / O6）・ステージ 3〜7・ステージ 8 は再定義（VSCodium フォークは畳む） |
| 凍結前に | SC 資産の削除（#502 を「削除」へ更新・GPL 同梱の解消・タグより前）/ gated ハーネスを stock VS Code 起動へ / README を導線へ |

#### main が実測で検算して直した点

- 🔴 検討状況の §2.6「フォークを畳んで失うのは 47 行のスクリプトと E2E のターゲット指定のみ」→
  **そのターゲット指定がマージゲート（実機 gated）そのもの**。ただしハーネス（`orbitstudio-mcp-gated.spec.ts:460-471`）は
  既に `--extensionDevelopmentPath` + 隔離 dir で起動しており、**フォーク固有は旧専用 CLI を指す 1 行だけ**。
  VS Code の `bin/code` に変えれば足りる
- SC 削除の影響: 実機 gated は **0 件**、ユニットは 22 ファイル（SC 専用 5 本は削除・17 は整理）
- 「凍結線はステージ 2 完了」→ 制作に `outs:` が要らないので **O-surface 完了まで縮んだ**。
  PR-O6 の「O4 が実機で確かめられた後」は stable 版の制作利用がそのまま満たす
- 未検証項目に **層 2 の多クライアント同時性**と **Swift アプリの CI（macOS ランナー）**を追加

#### 未決（本 PR で決めていない）

タグ名前空間（`ext-v*`）/ バージョン番号（`send` の dB 化は既存譜面の意味が変わるので semver なら 3.0.0）/
地図の全面再編（Fable 起案で別 issue）/ O-surface に `SetGlobalGain` の写しを含めるか（設計時に決める）。

---

### docs: follow the O-wire-b merge with the dev site and the core spec (Sep 10, 2026)

**追従元**: PR [#824](https://github.com/signalcompose/orbitscore/pull/824)（マージコミット `183b612`）/
**ブランチ**: `claude/docs-sync-pr824` / **性格**: ドキュメントのみ（`packages/` `rust/` `tests/` は無改変）

#### 直したもの

| 場所 | 何が食い違っていたか |
|---|---|
| `sites/dev/rust-engine/index.md` + `en/` | daemon コマンド表に **`SetBusLine` の行が無かった**（`session.rs` の match arm が 1 つ増えたのに表が 2026-09-01 のまま）。`SetBusLine` の wire 契約（2 段検証・全検証後に一度だけ publish・`dest` 5 種のうち受理は 3 種）と master line の 2 本立て（`explicit_line` / `execute_master_line`）を節として追加 |
| `sites/dev/signal-chain/mixer-audio-line.md` + `en/` | 「routing を daemon へ届ける」節が `SetBusRouting` を唯一の経路として説明していた。`SetBusLine` が併存すること・**TS に呼び出し元がまだ無い**こと・kind 制約が `SetBusRouting` 固有であることを Note で明示 |
| `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` MX.4 / MX.5 | 🔴 **引用行が壊れていた** — `engine_wrap.rs:5809-5813` / `:5802-5806` は本 PR の +644 行で `SelectAudioDevice` の stream 差し替え recovery になっていた。実際の kind 制約は `:6956-6960`（output）/ `:6981-6985`（send）、forward-only は `:6951-6955`。あわせて「制約が外れるのは PR-O3」という記述を実態へ（PR-O3 で入ったのは wire だけで、DSL は `SetBusRouting` のままなので**ユーザーから見える制約は変わっていない**・切り替えは PR-O4） |

#### 検証

`npm run docs:check` = **1018 verified / 0 failed / 58 files**、`docs:build`（user / dev）ともに成功。

🔴 **`docs:check` が見るのは `sites/dev/` の `// FILE:START-END` 引用だけ**で、`docs/core/` の
行参照は誰も突合していない。今回の壊れた 2 件がレビュー 4 段を素通りしたのはこのため。

---

## 束 O-wire-b（#611 ステージ 2・統合ブランチ `611-line-wire-b`）

`SetBusLine` の wire 契約を足す束。**DSL からは呼ばない**（送るのは PR-O4）ので、束の収束条件は
O-wire と同じ「**`OUTPUT_LINE_GOLDENS` / `#611 O0-1〜4` が 1 つも動かないこと**」+ cargo 全緑 + 実機 gated 全件。

### docs: follow the SetBusLine wire in the dev site and core spec (#823 追従) (Sep 8, 2026)

**ブランチ**: `claude/docs-sync-pr823` → `611-line-wire-b`（docs-sync ルーチン・PR [#823](https://github.com/signalcompose/orbitscore/pull/823) 追従）

マージ済み PR にドキュメントを追従させる定期ルーチンの成果物。**実装とテストは 1 行も触っていない。**

#### 直したもの

| 文書 | 何 |
|---|---|
| `sites/dev/signal-chain/mixer-audio-line.md`（+ `en/`） | `SetBusLine` の節を新設（wire 語彙・検証が session / `EngineWrap` の 2 層に分かれた理由・拒否 code の表・forward-only は残り kind 制約は無いこと・全か無かの publish・`master` も同じ publish に乗ったこと）。`verified-against` を `f6c9c37` へ |
| `sites/dev/rust-engine/index.md`（+ `en/`） | `set_global_gain` の節の記述を訂正（下記）|
| `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` MX.4 | 「v1 の現在地」の行番号が `engine_wrap.rs:5809-5813` 等で古かったので実測値へ。**wire 側の kind 制約は PR-O3b で外れたが、送信元がまだ無いので譜面から見える振る舞いは変わっていない**ことを追記 |

#### 🔴 差分と食い違っていた記述を 1 件訂正した — `explicit_line`

PR-O3b 本文・WORK_LOG・dev サイトの 3 箇所が「`explicit_line` は最初の `SetBusLine("master", …)` まで
`false` なので既存譜面は従来経路をそのまま通る」と書いていた。だが差分を読むと、
`MasterLine::line_program_installer` が返す closure は install 成功時に**無条件で**
`explicit_line` を立てる（`rust/crates/orbit-audio-native/src/output.rs:790-798`）。
そして `EngineWrap::set_global_gain` は `outproc-effect` build でそのハンドルを呼ぶ
（`rust/crates/orbit-audio-daemon/src/engine_wrap.rs:9284-9290`）。

したがって **`SetGlobalGain`（DSL の `global.gain()`）を 1 回受けた時点で** master の render は
`execute_master_line` 側（`output.rs:1719-1721`）へ移る。dev サイトの記述をコードに合わせて直し、
**出力にどう出るかは実機で測っていない**ので `NOTE: unverified` を付けた。

差分から読み取れる差は 2 つ（どちらも未測定）:

- ランプ長の出どころ — `MasterLine::ramp_frames` は sample_rate から算出、`LineSlot::new` の既定は
  **240 固定**（`output.rs:1196`）。`set_sample_rate` は insert bus の line にしか呼ばれない（同 `:2765`）
- 再 publish のたびに `LineProgram::new` が gain セルを **1.0 から**始める（同 `:1005-1020`）

**判断は仕様の側なので、追従作業では直していない。** #823 追従 PR の本文で質問として出している。

#### 検証

`npm run docs:build`（user / dev）と `npm run docs:check`（**1,026 citations verified / 0 failed**）。

---

### feat(daemon): SetBusLine wire command and TS client (#611 PR-O3b) (Sep 9, 2026)

**Issue**: #611 / **ブランチ**: `611-o3b-setbusline` → `611-line-wire-b`（小 PR）/
**実装**: Codex（`gpt-5.6-sol` / effort high・専用 worktree）/ **検証**: main（本ツリー）

#### 何を足したか

| 層 | 何 |
|---|---|
| `session.rs` | `parse_set_bus_line_params`（wire 形式の検証）+ dispatch。feature 無効ビルドは `UNSUPPORTED` |
| `engine_wrap.rs` | `set_bus_line`（意味論の検証 → `LineProgram` 構築 → 全検証後に一括 publish）・`SetGlobalGain` と master line の同期 |
| `output.rs` | 🔴 **`MasterLine.line` と `execute_master_line`**（下記）|
| `lib.rs` | O3a の型（`LineOp` / `LineOutput` / `LineProgram` / `OutputDest`）と installer の re-export |
| `protocol-types.ts` / `daemon-client.ts` | `'SetBusLine'` / `setBusLine()` / `WireDest` / `WireLineOp` |

🔴 **TS の呼び出し元は作っていない**（DSL から送るのは PR-O4）。
🔴 **旧 `SetBusRouting` は併存**（撤去は PR-O6）。既存テストは 1 行も書き換えていない。

#### 🔴 PR-O3a の実装漏れを 1 件埋めた — `MasterLine.line`

設計 611 **§5.2 は `MasterLine` に `line: LineSlot` を持たせる**と定め、**§4.1 の `bus` は `"master"` を
受理対象**にしている（`master` の自己参照を拒否する検証行がその証拠）。ところが **PR-O3a はそれを
入れていなかった** — main `2ca00f6a` の `output.rs` の `MasterLine` は `post` / `gain_target` などだけで、
**`SetBusLine("master", …)` を受理する先が無い**。

本 PR が §5.2 を埋めた。**互換は分岐で保つ**:

```
if master.explicit_line { execute_master_line(...) }   // publish 後
else { post → advance_gain → place_master_into_device }  // 従来経路（1 命令も変えていない）
```

`explicit_line` は最初の `SetBusLine("master", …)` が publish されるまで `false` なので、
**既存譜面は従来経路をそのまま通る**。O0 golden の bit 一致はこの分岐で構造的に保たれる
（既存の `legacy_*_bit_for_bit` 群が無改変で緑）。

⚠️ 計画 §1.10 の「触るファイル」欄が `output.rs` を落としていた（見積もりの漏れ）。
`BUNDLE_BRANCH_WORKFLOW` §5.1b に従い、**実装の前に**計画へ理由と追加の検証条件を書いた（`fc67c771`）。

#### 検証の層を分けた（main の裁定・2026-09-08）

`validate_line_program`（`output.rs`）は **RT 実行の可用性ゲート**であって wire の契約検証ではない。
そこは `Pan` / `Render` / `Link` を `OutputError::NoConfig` で拒否しており、**その文言を wire へ流すと
`DEVICE_CONFIG_ERROR` になって §4.1 のどの行とも一致しない**（`actionable_output_error_code` は
4 種の device エラーしか拾わない）。

したがって `set_bus_line` が §4.1 の表を**先に**適用する。**このゲートは無改変**（差分に出ていない）:

| §4.1 の行 | wire code | 経由する variant |
|---|---|---|
| 形式不正・`rack` 二重・`master` 自己参照・`render` 未登録 | `MALFORMED_REQUEST` | `OutProcEffectRequest` |
| `dest.bus` 未知 / forward-only 違反 | `OUTPROC_EFFECT_RUNTIME` | `OutProcEffect` |
| `dest.device` 範囲外・`a == b` | `PARAM_OUT_OF_RANGE` | （session の dispatch で直接）|
| `dest.link`（feature 無し） | `LINK_AUDIO_UNAVAILABLE` | `LinkAudioUnavailable` |
| feature 無効ビルド | `UNSUPPORTED` | （dispatch の `#[cfg(not(...))]`）|

🔴 **ブリーフ（09-07 起案）は 3 箇所を誤っていた**ので、着手前に一次ソースで検算して訂正した:
`engine_wrap.rs` の行番号（6227 → **6310**）/ feature 無効時の code（`OUTPROC_EFFECT_UNAVAILABLE`
→ **`UNSUPPORTED`**）/ wire code は variant 名と別物であること。**訂正しなければ、存在しない
エラー code を期待するテストが緑になっていた。**

#### 検証（🔴 すべて main が本ツリーで実行）

| 検証 | 結果 |
|---|---|
| `cargo test --workspace --locked` | **617 passed / 0 failed / 38 ignored** |
| `cargo test -p orbit-audio-daemon --features outproc-effect,outproc-instrument` | **339 passed / 0 failed / 13 ignored**（新規 `set_bus_line_*` 11 件を含む）|
| `cargo fmt --all --check` | 緑 |
| `cargo clippy --workspace --all-targets -- -D warnings` | 警告なし |
| `cargo clippy -p orbit-audio-daemon --features outproc-effect,outproc-instrument --all-targets` | 警告なし |
| `npm run lint` | 緑 |
| `npm test` | **2,329 passed / 58 skipped / 0 failed**（164 ファイル）|
| `npm run build` / `npm run typecheck:e2e` | 緑 |

🔴 **委譲先が走らせられなかったものが 2 つあった**:

1. **protocol 統合テスト 61 件** — Codex の sandbox は localhost bind を許さず
   `bind_localhost ... Operation not permitted` で全件落ちていた。**本ツリーでは bind エラー 0 件で全緑**
2. **TS 側すべて** — worktree に `node_modules` が無く、lint / vitest / tsc を一度も実行していない

**「Codex が緑と言った」だけでマージできる PR は構造的に存在しない**（CLAUDE.md）ことが、
そのまま再現した形。

#### main が差分を読んで直した点（1 件）

`output.rs` の従来経路を `else` 分岐へ包む際に、**設計判断を記録したコメント 3 ブロックが削除**されていた:
`g == 1.0` が bit 一致を崩さない理由 / デバイス配置の意味（設計 §5.3 row 6）/
🔴 **`hw` を全域 zero-fill してはいけない**理由（`place_master_into_device` が全要素を書くので、
1ch・2ch では毎ブロック二重 store になる。64 frames × 2ch で約 96,000 store/秒の無駄）。

**コードは無改変だがコメントだけ落ちる**類の欠落で、テストでは検出できない。復元した。

#### 🔴 CI が捕まえた検証漏れ — `docs:check` を手元で回していなかった

小 PR [#823](https://github.com/signalcompose/orbitscore/pull/823) の CI で `code-review` が落ちた。
原因は**実装ではなく dev サイトの引用**で、**102 件が FAIL**。Rust に +1,096 行入れたので
`// file:start-end` の行番号が動いたため。

**私（main）の検証漏れである**。cargo・vitest・lint・build・typecheck は回したのに、
**`npm run docs:check` を回していなかった**。`--no-verify` でコミットしたので pre-commit も走らず、
**CI が唯一の検出点になっていた**。

対処:

| 手 | 結果 |
|---|---|
| `node sites/dev/scripts/check-citations.mjs --fix` | 102 → **4 件**（スニペットの移動ぶんは自動で再アンカーされる）|
| 残り 4 件（ja/en の 2 箇所） | **引用の中身自体が変わっていた**ので `--fix` では直らず、コードブロックごと差し替えた |
| 地の文 | `EngineWrap::set_global_gain` の説明が「`MasterLine` の目標値へ atomic store するだけ」のままだった（本 PR で master line への再 publish が 1 段増えている）。ja / en とも追記した |

最終: **1,012 citations verified / 0 failed**・`npm run docs:build` 成功。

🔴 **教訓**: Rust に大きな差分を入れたら **`docs:check` は cargo と同じ列に置く**。
引用は「コードは正しいが記述が古い」を検出する層で、他のどのテストも代わりにならない。

#### `/simplify` の結果（4 観点を並行・束 PR [#824](https://github.com/signalcompose/orbitscore/pull/824)）

**適用したもの**:

| 指摘 | 出所 | 何をしたか |
|---|---|---|
| master 分岐と named bus 分岐で **Device 変換・Render/Link 拒否が一字一句同一** | altitude・simplification が**独立に**指摘 | `device_dest_from_wire` / `render_dest_rejected` / `link_dest_rejected` の 3 つへ抽出。両分岐から呼ぶ |
| `link` のエラー文言が「requires link-audio」で誤解を招く | altitude | **feature の有無ではなく RT が未配線だから拒否している**ので「is not wired into RT execution yet」へ。code は §4.1 どおり `LINK_AUDIO_UNAVAILABLE` のまま |
| `explicit_line` の**消える条件**がコメントに無い | altitude | 「PR-O4 で新表面が実機で確かめられ、PR-O6 で旧経路が撤去され、O0 golden を取り直した後」と明記 |
| `MasterLine::new` の既定 program が control 側 shadow と食い違う | simplification | **RT では一度も実行されない**（`explicit_line == false` の間は固定経路へ分岐する）ことを明記。不整合ではない |
| `explicit_line` は `SetGlobalGain` でも `true` になる | simplification | フィールドの doc に明記（名前は「明示的な line が入ったか」の意） |

🔴 **1 件は指摘が誤りだった（適用しかけて戻した）**。simplification が「`gain` の上限チェックが
session 側にしか無い＝乖離」と報告したので条件を揃えたが、**型が違うため乖離ではない**:
session は JSON の **f64** を受けるので `> f32::MAX` を弾いてから `as f32` する必要がある（変換で
`inf` になるのを防ぐ）。`engine_wrap` 側は既に **f32** で、`is_finite()` が `inf` を弾き、有限な f32 は
定義上 `f32::MAX` 以下。戻した上で**理由をコメントに残した**（次に同じ指摘が出ても即座に却下できる）。

**skip したもの**:

| 指摘 | skip の理由 |
|---|---|
| forward-only 判定が 3 箇所目 / activation ループが同一 | 相手の `set_bus_routing` は **PR-O6 で退役**（計画 §1.10）。今統合すると O6 で解く手間が増える。かつ `set_bus_line` が `bus_kinds` を見ないのは設計 §4.1 の**裁定 ③（kind は問わない）どおり** |
| `LineOp::Gain` の逐語重複（6 行 × 2） | 軽微。master と insert bus で buffer と `ramp_frames` の取得元が違い、抽出しても引数で受け渡すだけになる |
| `bus_lines` / `bus_line_programs` の二重 map | 旧 `SetBusRouting` と対になっており、PR-O6 で片方が消える |
| Render/Link の判断が 3 層 4 箇所 | 一本化は範囲が大きい。**一次情報は `validate_line_program`** である旨を各所のコメントに書いて代替した |

**efficiency は「該当なし」**が結論 — RT パス（`execute_master_line` / `LineSlot::load`）に
**alloc・lock・syscall は無く**、`LineSlot` / `LineExchange` の退役規律も PR-O3a の insert bus と
**同じ型をそのまま再利用**している。control 側の clone やロック区間の指摘はすべて
「ユーザー操作 1 回・低頻度」の規模だった。

適用後の再検証: cargo **617 / 339 passed・0 failed**（変更前と同数）・fmt・clippy 警告なし・
`docs:check` **1,012 verified / 0 failed**（helper 追加で行番号が動いたので `--fix` で再アンカー）。

#### 🔴 レビュー・ラウンド 1 — 既存機能の回帰を 1 件止めた

レビューチーム 4 名 + Fable 監査を**並行**投入（CLAUDE.md）。**Critical 5 / Important 3 / Minor 2**。

##### 最重要: `global.gain()` の可聴ポップ（**code-reviewer と Fable が独立に指摘**）

`SetGlobalGain` を master line へ写した結果、`LineProgram::new` が `current_gain` を全 op で 1.0 から
始めるため、**2 回目以降の `global.gain()` で ramp が unity から再開**する。直前の実効ゲイン
（例 −20 dB）から目標（−10 dB）へ寄る代わりに**一度 1.0 へ跳ね上がってから寄る** — 64 frame の
小バッファでは数ブロックかかるので可聴のポップになる。

🔴 **これは新機能の不足ではなく回帰**である。この PR の前は `SetGlobalGain` が `gain_target` atomic を
更新するだけで、`advance_gain` が**呼び出しをまたいで `gain_current` を連続させていた**。

**裁定と、その前にやったこと**: 設計 §4.2 は「**意味を変えない形で**写す」と書いており、条件を
満たしていない。運用規則 6 に従い**設計を先に更新**してから実装を直した:

| 文書 | 追記 |
|---|---|
| §4.2 | 🔴 **この写しは PR-O4 と同時**。O3b で写すと TS がまだ `SetGlobalGain` を送るので回帰する |
| §5.1 | 🔴 **再 publish 時の `current_gain` 初期値規則**（本書に欠けていた節）|

Fable が「**§5.1 に新 program の初期値規則が無い**」と指摘したのが要点だった。規則が無いので
実装者が判断できず、Codex は素直に `LineProgram::new` を使った。**規則を先に書く。**

##### 適用した fix（Codex・ポリシーを 1 本にまとめて一括発注）

| # | 何を |
|---|---|
| 1 | `set_global_gain` から master line 再 publish を**外した**（`master_gain.store` のみ＝この PR の前と同じ）|
| 2 | 🔴 **`master.line.set_sample_rate` の呼び忘れ**（Fable）。`LineSlot::new` は `ramp_frames: 240` 固定で、呼び出しは insert bus の 1 箇所だけだった → 44.1k / 96k で master の ramp が 5 ms からずれていた |
| 3a | `bus_actives` の活性化テスト（旧 `SetBusRouting` には前例があるのに新規側に無かった）|
| 3b | **device channel の 1 始まり → 0 始まり変換**。🔴 `device_dest_from_wire` は**どのテストからも一度も実行されていなかった** |
| 3c | `set_bus_line("master", …)` の成功系と全か無か（既存の master テストは installer を直接呼んでおり `set_bus_line` を通らなかった）|
| 3d | 裁定③（kind を問わない）の**正のテスト**。🔴 Codex が「**kind チェックを復活させても既存 290 件は全緑**」を先に実証してから追加した＝変異検証として機能した |
| 4 | `debug_assert!` が release で no-op であること・到達不能を保証するのは control 層だけであること・破れたら**無音でログにも残らない**ことをコメント化（実装は変えない）|
| 5 | `explicit_line` の doc から**一次文書に根拠の無い一文**を削除（`/simplify` で main が書いたもの）|

##### 検証（🔴 すべて main が本ツリーで実行）

| 検証 | 結果 |
|---|---|
| `cargo test --workspace` | **617 passed / 0 failed / 38 ignored** |
| `cargo test`（outproc features） | **344 passed / 0 failed / 13 ignored**（339 → 344・新規 5 件）|
| fmt / clippy 2 本 | 警告なし |
| `npm test` | **2,329 passed / 58 skipped** |
| `npm run lint` / `typecheck:e2e` / `docs:build` | 緑 |
| `npm run docs:check` | **1,012 verified / 0 failed**（Rust の行番号が動いたので `--fix` + 引用の中身を差し替え）|

🔴 **Codex は sandbox で cargo の 29 件 / 32 件を落としていた**（`bind_localhost ... Operation not
permitted`）。本ツリーでは **bind エラー 0 件で全緑**。「委譲先の緑は実機の緑ではない」が再現した。

##### owner の裁定を仰いでいる 2 件（O3b の範囲外）

Fable が **設計 §4.1 自体が 2026-09-03 の裁定を反映していない**ことを発見した:

- **`pan` op が wire に無い** — §2.4b / W-18 は「wire に `pan`」と書くが §4.1 の `WireLineOp` は 3 op
- **mono device が wire で表現できない** — §2.2 の `mix.output(3)` / §5.1 の `right: None` に対し、
  §4.1 の `channels: [number, number]` は 2 要素必須

実装は §4.1 に忠実なので**本 PR の欠陥ではない**。§4.1 の改訂自体は運用規則 6 に従い今やるべきだが、
束の範囲を広げる判断なので owner の裁定待ち。

#### 🔴 束の締め — 収束条件を満たした（2026-09-09 実測）

**マージ前ゲート**（無条件の 3 行 + build）:

| ゲート | 結果 |
|---|---|
| `npm run build` | errors 0 |
| `bash rust/crates/orbit-std-gain/bundle-macos.sh` | `Gain.clap` 生成 |
| `cargo test -p orbit-effect-rack-child --lib -- --ignored` | **3 passed**（実 gain プラグイン依存）|
| `cargo test -p orbit-effect-rack-child --lib`（`--ignored` **無し**）| **16 passed**（退行検知テストが実際に走った）|

**実機 gated 全件**（`npm run test:e2e:gated`・523 秒）: **29 passed / 1 failed**。

🔴 **収束条件「goldens が 1 つも動かないこと」を達成**:

| golden | 実測 |
|---|---|
| `#611 O0-1` no-bus RMS | `0.08701663328646671` / `0.0870166332956341`（2 セッション）|
| `#611 O0-2` sum-output RMS | `0.08701663328620282` |
| `#611 O0-3` `send(0.3)` の total/dry | **`1.300000013268198`**（= 1 + 0.3）|
| `#611 O0-4` `effect + gain(-6)` | `effectOnly 1.9952622668994517` / `combined 0.9999999200541101` |

**4 件とも通過**。`#611 O0-4`（#775 の間欠故障）も**今回は緑**で、U2 に該当するログは 0 行だった。

唯一の失敗は **`steps the live playhead`**（`timed out waiting for [STEP] markers ... after 20000ms`）で、
これは **main baseline の既知の赤**（台帳に記載済み）。**新しい赤は 0 件。**

孤児プロセス（`OrbitStudio` / `orbit-audio-daemon`）の残留なしも確認した。

⚠️ **ログの所在で 2 回つまずいた**: `nohup` を `dangerouslyDisableSandbox` で回すと `$TMPDIR` が
**sandbox 内とは別のパス**（`/var/folders/…/T/`）を指すため、sandbox 内から読めない。
**完了マーカー（`EXIT=`）を先に見て集計行が無いことに気づいた**ので、「テスト本体に到達していない」と
判断でき、実装ではなくログの所在を疑う方向に進めた。

#### 🔴 owner 裁定（2026-09-10）— §4.1 を改訂し、`pan` / mono の実装は PR-O4 へ

Fable が **設計 §4.1 だけが 2026-09-03 の裁定に追従していなかった**ことを発見した。

| 層 | mono `device` | `pan` op |
|---|---|---|
| §2.2 / §2.4b（DSL 表面・09-03 裁定）| `mix.output(3)` = L+R マージ（Q-611-5）✅ | ライン要素（Q-611-4）✅ |
| §2.x の TS 型（`:162` `:179`）| `[number,number] \| [number]` ✅ | `{ kind: 'pan' }` ✅ |
| §5.1 / §5.3（Rust 型・RT 式）| `Device { right: Option<usize> }` ✅ | `LineOp::Pan` と式 ✅ |
| 🔴 **§4.1（wire）** | **2 要素固定** ❌ | **3 op のみ** ❌ |

🔴 **PR-O3b の実装は §4.1 に忠実だったので、実装の欠陥ではない。**
**正本が古いと、忠実さがそのまま欠落になる。**

**裁定**: §4.1 を改訂し、**実装は両方 PR-O4（束 O-surface）で 1 回にまとめる**。

**なぜ O3b でやらないか**（2 件でコストが違うので分けて判断した）:

| | mono `device` | `pan` op |
|---|---|---|
| RT の実装 | ✅ **既にある**（`add_to_device` が `right: None` で L+R を 0.5 マージ）| ❌ **無い**（`validate_line_program` が拒否し実行側も空）|
| 必要な作業 | wire の型と parse（約 40 行）| wire + **RT 実行**（等パワー・約 150 行）|

`pan` は RT 実装を伴うので O3b に入れると**「振る舞いを変えない」という束の性格が壊れ、
goldens の「動かないこと」という検算が使えなくなる** — O3 を O3a / O3b に割ったのは
まさにこの検算を守るためだった。mono だけ先に足すと **wire を 2 回変える**ことになり、
一方通行の変更回数が増える。したがって**両方を O4 で 1 回にまとめる**。

⚠️ 計画 §2.1 の「1 PR で wire と DSL の両方を変えると golden の差分がどちら由来か分からない」に
抵触するが、**`pan` については §2.4b が既に「`pan` を含む譜面の golden は再ベースライン」と
裁定済み**（owner 受け入れ済み）なので、帰属問題はその範囲で扱える。

**更新した文書**: 設計 §4.1（型・検証表 2 行・経緯の引用ブロック）/ 計画 §1.10 の PR-O4 行
（wire + RT の `Pan`・`SetGlobalGain` の写しも O4）。

#### 未検証・次の束へ

- 実機 gated（**goldens が 1 つも動かないこと**）は**束の締め**で 1 回 → ✅ **上記のとおり達成**
- 🔴 **PR-O4 が引き継ぐもの**（本 PR では実装しない）: `pan` op の wire + RT / mono `device` の wire /
  `SetGlobalGain` の master line への写し（§4.2・ramp の実効値引き継ぎ機構とセット）
- `LineOp::Pan` の wire 表現は無い（§4.1 の `WireLineOp` に `pan` が無い・PR-O4）
- `dest.render` は登記簿（`DeclareRender`・PR-R2）が無いので今日はすべて拒否

---

### chore(docs): rotate WORK_LOG before the O-wire-b bundle (Sep 9, 2026)

**ブランチ**: `611-o3b-setbusline` → `611-line-wire-b`（束 O-wire-b の前処理）

`tests/docs/worklog-size.spec.ts` の上限 2,000 行に対し **1,998 行**（残り 2 行）だったので、
PR-O3b のエントリを書く前にローテーションした。

| | 前 | 後 |
|---|---|---|
| `docs/development/WORK_LOG.md` | 1,998 行 | **1,430 行** |
| `docs/archive/WORK_LOG_2026-09.md` | 4,535 行 | 5,119 行 |

移設したのは **Sep 6 のエントリ 11 件**。archive 側に
「## 09-06 の追補（本体の 2,000 行上限で移設・2026-09-09 第 3 回）」を新設して先頭へ入れた。
本体末尾の索引と `docs/core/INDEX.md` の表は **`2026-09（前半・09-01〜09-06）` のままで正しい**
（移したのが 09-06 の範囲内なので期間が変わらない）。

🔴 日付が混在していたので**行の位置ではなく見出しの日付で選別**した。Sep 6 群の間に
Sep 7 のエントリ 2 件（E-gate のレビュー fix と `/simplify`）が挟まっていたため、
行範囲で切ると一緒に移動してしまう。

---

### docs: restore the three index lines the #821 consolidation dropped (Sep 8, 2026)

**追従元**: PR [#821](https://github.com/signalcompose/orbitscore/pull/821)（マージコミット `2489218` / head `8c40ce8`）/ **ブランチ**: `claude/docs-sync-pr821`

#821 は 3 本のルーティン追従 PR（#809 / #818 / #820）を 1 コミットにまとめ直したが、**その過程で 3 行が落ちた**。PR 本文は「中身はそのまま」と書いており削除に触れていない。**同じ PR が入れた WORK_LOG 本文が、落ちた行を実在する前提で書いている**（#820 分「#819 は CLAUDE.md と INDEX.md からポインタを張った」/ #818 分「INDEX.md Planning 表に `issue-states.json` を登録」）ため、意図した削除ではなく取りこぼしと判断して復元した。

#### 直した箇所

| ファイル | 何を | 出どころ |
|---|---|---|
| `CLAUDE.md:181-183` | Development Commands 直後の macOS スキャン警告（`MACOS_DEV_SETUP.md` へのポインタ）| PR #819（`6e22a84`）が追加 → #821 が削除 |
| `docs/core/INDEX.md:118` | Development 表の `MACOS_DEV_SETUP.md` 行 | 同上 |
| `docs/core/INDEX.md:243` | Planning 表の `issue-states.json` 行（生成物・手で編集しない）| PR #818 に在ったが #821 に入らなかった |

復元前、`MACOS_DEV_SETUP.md` は `docs/testing/TESTING_GUIDE.md:30` と WORK_LOG 本文からしか辿れず、`issue-states.json` はどこからも索引されていなかった。🔴 **この取りこぼしを赤にするテストは無い**（`worklog-size.spec.ts` は行数とアーカイブ名、`planning-issue-state.spec.ts` は状態語の矛盾しか見ない）。提案は PR 本文へ回した。

#### 追従不要と判断したもの

#821 の差分 6 ファイルはすべて docs で、`packages/engine/`・`rust/`・`packages/vscode-extension/` に変更が無い。DSL の構文・意味論、MCP ツールの引数と返り値、エディタの評価経路のいずれも変わらないため、`docs/specs-v2/`・`docs/core/INSTRUCTION_ORBITSCORE_DSL.md`・`sites/user/`・`sites/dev/`（日英とも）は対象外。

---

### docs(testing): point the testing guide at the macOS setup trap (PR #819 follow-up) (Sep 8, 2026)

**追従元**: PR [#819](https://github.com/signalcompose/orbitscore/pull/819)（マージコミット `6e22a84` / head `5ef4151`） / **ブランチ**: `claude/docs-sync-pr819`

docs-sync ルーチンが PR #819 のマージを受けて実行。#819 は `docs/development/MACOS_DEV_SETUP.md` を
新設し、CLAUDE.md と `docs/core/INDEX.md` からポインタを張ったが、**Rust テストの手順書である
`docs/testing/TESTING_GUIDE.md` には張られていなかった**。同ガイドの Prerequisites は
「Rust toolchain」「macOS Apple Silicon」を要求しつつ、設定なしの macOS では
`cargo test --workspace` が 37 分かかる事実に触れていない。

#### 変更

- `docs/testing/TESTING_GUIDE.md` の System Requirements 直後に `MACOS_DEV_SETUP.md` への
  ポインタを追加（2,240 秒 → 66 秒・遅さの 91% はマルウェアスキャン・件数は不変）

#### 追従不要と判断したもの

#819 の差分は 4 ファイルすべてがドキュメント（CLAUDE.md / `docs/core/INDEX.md` /
`MACOS_DEV_SETUP.md` / WORK_LOG.md）で、`packages/engine/`・`rust/`・
`packages/vscode-extension/` に変更が無い。DSL の構文・意味論、MCP ツールの引数と返り値、
エディタの評価経路のいずれも変わらないため、`docs/specs-v2/`・
`docs/core/INSTRUCTION_ORBITSCORE_DSL.md`・`sites/user/`・`sites/dev/` は対象外。
`sites/dev/` は内部構造の解説サイトで開発機セットアップの章を持たない（`orientation/` は
`what-is-orbitscore.md` と `architecture-overview.md` のみ）。

---

### docs: follow up PR #815 — record the new planning-doc ratchet where the rules live (Sep 8, 2026)

**追従元**: PR [#815](https://github.com/signalcompose/orbitscore/pull/815)（#814・merge commit `5eaea2f`）/
**ブランチ**: `claude/docs-sync-pr815` → main（ルーティンのドキュメント追従）

PR #815 は**仕組み**（`tests/docs/planning-issue-state.spec.ts`）と**運用規則**
（`BUNDLE_BRANCH_WORKFLOW.md` §5.1b）を足したが、**それを列挙している既存の 3 箇所には入っていなかった**。
規律の一覧が実在の仕組みより古いままだと、次のセッションは「その仕組みは無い」と読む。

| 直した先 | 何を |
|---|---|
| `CLAUDE.md`「これらは仕組みで強制されている」 | 表に 1 行追加。**捕まえるのは状態語の矛盾だけ**で内容の誤りは通ることも併記（出典必須の運用へ送る）|
| `DEVELOPMENT_MAP.md` §0.2 | 運用規則 7（事実が変わった瞬間に地図を更新）・8（実測には出典）を追加。既存の規則 4「issue を閉じたら」より**広い**ことを明示 |
| `PROJECT_RULES.md` §1c（棚卸しの作法）| `KNOWN_STALE_BASELINE` が**棚卸しの入口**であること・直したら削ること・増やして通さないこと |
| `INDEX.md` Planning 表 | `docs/planning/issue-states.json` を**生成物**として登録 |

🔴 **`packages/` `rust/` `sites/` は 0 件。** 元 PR に実装の差分が無く、`sites/dev` は
コードの内部構造を扱う層なので追従先が無い（判断理由は PR 本文）。

---

### docs(index): follow PR #805 — the archive period label stayed at 09-05 (Sep 7, 2026)

**ブランチ**: `claude/docs-sync-pr805`（ルーチンによる docs 追従）

PR [#805](https://github.com/signalcompose/orbitscore/pull/805)（マージコミット `7a71f51`）の追従。
#805 は WORK_LOG のローテーションのみで、**DSL / ランタイム / OrbitStudio の表面は 1 行も動いていない**。
追従対象はアーカイブの索引 1 箇所だけだった。

#### 直した箇所

| ファイル | 内容 |
|---|---|
| `docs/core/INDEX.md:176` | 「Archived WORK_LOG」表の period 列 `2026-09（前半・09-01〜09-05）` → `09-01〜09-06` |

#805 はアーカイブ側 H1（`docs/archive/WORK_LOG_2026-09.md:1`）と本体末尾の索引
（`docs/development/WORK_LOG.md:1184`）を `09-01〜09-06` へ更新したが、`PROJECT_RULES.md:116` が
更新を義務づけている **3 箇所目の `docs/core/INDEX.md` が旧ラベルのまま**残っていた。

🔴 **仕組みがこの列を見ていない。** `tests/docs/worklog-size.spec.ts:44-53` の索引テストは
「`docs/archive/` にある `WORK_LOG_YYYY-MM.md` が本体末尾から辿れるか」= **ファイル名の存在**しか
照合しない。period 列のラベルも INDEX.md 側の表も検査範囲の外なので、ずれても緑のままになる。

#### 追従不要と判断したもの

- `docs/archive/WORK_LOG_2026-09.md`（+790 行）と `docs/development/WORK_LOG.md`（-786 行）の
  本文 — **移設のみで内容は不変**（#805 が文字列比較で同一性を確認済み）。参照先が本体から
  archive へ移るが、`sites/**` からの `development/WORK_LOG.md` 名指しは 0 件で、
  `sites/dev/editor/vscode-architecture.md:918`（および `en/` 同行）は既に archive を指している
- `sites/dev/` の各章 — 内部構造・評価経路は変わっていない
- `docs/specs-v2/` / `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` — DSL の構文・意味論は変わっていない

#### 🔴 #805 は `fmt / clippy / test` が赤いままマージされている

`device_switch_result_records_failure_and_success_through_the_same_path` の `captured log: ""`
（`rust/crates/orbit-audio-daemon/src/engine_wrap.rs:10723`）。**再実行（run_attempt 2）でも再発**。
既知の flaky #801 で、docs のみの差分とは無関係。PR [#808](https://github.com/signalcompose/orbitscore/pull/808)
（`801-tracing-interest-anchor`）が anchor subscriber で直しており、その run は緑。

---

### docs: follow the merged O-wire bundle into the dev site (Sep 8, 2026)

**ブランチ**: `claude/docs-sync-pr811` / **追従元**: PR [#811](https://github.com/signalcompose/orbitscore/pull/811)（束 O-wire・merge commit `66efda5`）

ルーチン「マージされた PR にドキュメントとサイトを追従させる」による docs のみの変更。
**実装・テストは 1 行も変更していない。**

#### 追従した内容（ja / en 両方）

| 章 | 何を書いたか | 差分のどこ |
|---|---|---|
| `sites/dev/signal-chain/mixer-audio-line.md` | post-loop の本文が `effective_targets[i]` 分岐から **line program 実行**へ変わった。`LineOp` / `OutputDest` / `LineOutput.thru`、`validate_line_program` の install-time 拒否、`effective_line_output_dest` と `LineProgram::settled` という互換の 2 仕掛け、`LineExchange` の AtomicPtr + 世代カウンタ、marking pass と実行が **1 snapshot を共有する**理由 | `rust/crates/orbit-audio-native/src/output.rs:914-939,1043-1100,1249-1297,1301-1312,2049-2066,2160-2184` |
| `sites/dev/rust-engine/index.md` | `render_block_with_sources` に **直行デバイスライン**の段が増えた（`DeviceLineBuffer` / `direct_device_written` / `wrote` による遅延 zero-fill）。引用 range が capture tap と `cb_stats` を落としていたので本文の 5 段記述に合わせて復元 | `rust/crates/orbit-audio-native/src/output.rs:1651-1700,1926-1930` |
| `sites/dev/editor/vscode-architecture.md` | #773: stdout の bridge dispatch が `createLinePrefixer` + `StringDecoder` 経由になった。buffer をハンドラ内に置く理由（stale プロセスとの分離）、decode をこの経路だけに限った線引き、`end` での `decoder.end()` → `flush()` の順序 | `packages/vscode-extension/src/extension.ts:1479-1486,1516-1519,1534-1535,1578-1586` |
| `sites/dev/editor/mcp-and-gated-e2e.md` | evalMark 分岐が prefixer callback の中へ移ったこと（分岐と prefix 順は不変・取りこぼし経路が 1 つ減った）への cross-link | 同上 |
| `sites/dev/rust-engine/insert-bus.md` | `InsertBusStage` の mixer 用 4 フィールド（`output_target` / `sends` / `routing_override` / `send_gain_overrides`）が **`line: LineSlot` の 1 本**へまとまった。`LineOp` の並びが「ラックの位置・gain・出口」を表す。source 無し専用の `render_engine_with_insert_buses` は `#[cfg(test)]` のラッパーへ後退 | `rust/crates/orbit-audio-native/src/output.rs:1314-1336,932-939,1785-1790` |
| `sites/dev/editor/execution-feedback.md` | stdout の 4 分岐が `for` ループから prefixer callback へ移った理由（引用のインデントが 8 → 4 になった）と、それ以前は `evalMark` 応答がまるごと失われて `evaluateForAgent()` が timeout していたこと | `packages/vscode-extension/src/extension.ts:1499-1507` |

5 章の frontmatter は `verified-against: 66efda5` / `verified-at: 2026-09-08` に更新した。

#### 🔴 先行する追従 PR 2 本をここへ統合した（#807 / #812 は close）

`claude/docs-sync-pr806`（#807・#773 の追従）と `claude/docs-sync-pr810`（#812・PR-O3a の追従）は、
**本 PR と同じ章の同じ主題を、1 つ前の code に対して**書いていた。#811 が束として main に入った時点で
両者の引用は壊れており（`docs:check` で 8 件 FAIL）、地の文も `StringDecoder` 導入前の説明のままだった。

そこで **両者にしか無いファイルだけを本 PR へ取り込み**、重複していた 4 章
（`vscode-architecture.md` / `mcp-and-gated-e2e.md` / `rust-engine/index.md` /
`signal-chain/mixer-audio-line.md`）は**本 PR の版＝最新 code に対する記述を採った**。
取り込んだのは上表の下 2 行。引用は `check-citations.mjs --fix` で再アンカーし、
PR 参照は束のマージ PR **#811** に統一した（dev サイトは main の履歴を基準にするため）。

🔴 **教訓**: ルーティンの追従 PR を溜めると、追従先の code が動いて**追従そのものが陳腐化する**。
6 本溜まった時点で 3 本が同じ章を奪い合っていた。`BUNDLE_BRANCH_WORKFLOW` §4 が
「束を開く前に全部消化する」と言っているのは、衝突だけでなくこの陳腐化も理由である。

#### 追従不要と判断したもの

- `docs/specs-v2/` / `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` / `sites/user/` / `docs/user/ja/USER_MANUAL.md`
  — この束は `packages/engine/` を 1 行も触っておらず、DSL 表面（構文・チェーンメソッド・宣言形式）も
  wire 契約も変わっていない。`SetBusLine` と DSL 表面は次の束（O3b / O-surface）
- `rust/crates/orbit-audio-daemon/src/test_tracing.rs`（#801）— テストハーネスのみ。dev サイトに該当章が無い
- `docs/design/611-output-line-design.md` — 起案時点のスナップショットなので後から書き換えない（ルーチン規約）

#### 検証

`npm run docs:build`（user / dev）と `npm run docs:check` を実行。結果は PR 本文に貼付。

---

### perf(test): the Rust test cycle was 91% macOS malware scanning — 2,240s to 66s (#816) (Sep 8, 2026)

**Issue**: #816 / **ブランチ**: `816-test-cycle-perf` → main（直行）

#### 発端（owner）

> テストは重要なのですが、**過剰なテストになっていませんか？** テストを正しく無駄なく行う方法はありませんか？

#### 🔴 答え: 過剰ではなかった。テストは 80 秒しか走っていない

`cargo test --workspace --locked`（1 ファイル変更後）の内訳を実測で分解した:

| 内訳 | 時間 | 割合 |
|---|---|---|
| ビルド + リンク | 101 秒 | 5% |
| **テスト自身の実行** | **80 秒** | 4% |
| 🔴 **バイナリ初回起動の macOS 検査** | **約 34 分** | **91%** |

決定的な観測 — **同じバイナリを 3 回起動**した:

```
run 1: 23.22 秒   ← 初回
run 2:  0.004 秒
run 3:  0.004 秒
```

CPU サンプリングで犯人も特定した: **前半 5 秒が `syspolicyd`（Gatekeeper）・後半 6 秒が
`XprotectService`（マルウェアスキャン）**。

🔴 **`cargo test` はこの検査にとって最悪のケース**である。テストバイナリは**1 回しか実行されない**ので
キャッシュが効く前に用済みになり、このワークスペースは**77 個**作る。しかも
**`XprotectService` はシングルスレッド**なので、並列に起動しても検査は 1 本ずつしか進まない。

#### 対策と結果

**ターミナル（Ghostty）をデベロッパツールに登録 + ターミナル再起動 + `cargo clean`**。

| | ベースライン | 対策後 |
|---|---|---|
| **所要** | **2,240 秒（37 分 20 秒）** | 🔴 **66 秒** |
| passed / failed / ignored | 615 / 0 / 38 | **615 / 0 / 38** |
| スイート数 | 93 | **93** |
| テストバイナリ | 77 | **77** |

🔴 **検証の範囲も結果も 1 つも変わらず 34 倍。** 「速度と正しさを交換する」類ではない。

#### 🔴 `cargo clean` が要る理由（ここを飛ばすと効かない）

設定は「**これから作られるバイナリ**」にしか効かない。`target` に残っている成果物（**71 GB** あった）は
**設定前のまま**なので検査され続ける。nextest の公式が
"You may also need to run `cargo clean` afterwards" と書いているとおりだった。

**設定だけ入れて `cargo clean` しなかった段階では、32 秒のまま変化しなかった。**

#### 効かなかったもの（記録・再試行の必要なし）

| 手 | 結果 |
|---|---|
| `codesign -v` で事前検証 | ❌ 13.6 秒かけても初回起動は 76 秒。**署名検証と実行時スキャンは別物** |
| バイナリを並列に warm up | ❌ `XprotectService` がシングルスレッドなので直列化する |
| `sudo spctl developer-mode enable-terminal` 単独 | ❌ **Terminal.app を追加するだけ**でトグルも ON にならない。Ghostty 利用時は無関係 |

⚠️ **並列 warm up の自作は危険**でもあった。`--list` を渡しても、テストバイナリではない実行ファイル
（`orbit-plugin-scan` / `sandbox-effect-child`）は**引数を無視して本体として起動する**。
実際にやってしまい 8 分以上走り続けた。**止めて方法を変えた。**

#### 🔴 このリポジトリは既に半分知っていた

`orbit-audio-sandbox/src/child.rs:107` の `warm_up_executable`（#520）が
「`cargo build` 直後の child は macOS のセキュリティ評価を伴い**数秒〜24 秒**止まりうる」と
コメントしていた。**個別のテストには対策済みで、テストサイクル全体には効いていなかった。**

同日「実機の赤を実装のせいにしかけた」3 件のうち 2 件も**同じ Gatekeeper** が原因だった。
**同じ現象に 3 つの別々の名前を付けて、別々に対処していた**ことになる。

#### 残したもの

- **`docs/development/MACOS_DEV_SETUP.md`**（新設）— 手順・トレードオフ・効かなかった手
- **CLAUDE.md の Development Commands** と **`docs/core/INDEX.md`** からポインタ
  （次のセッションが最初に読む場所に置く）

#### 🔴 owner の環境で変えたもの（リポジトリ外・戻す時の参照）

| # | 何を | 状態 |
|---|---|---|
| 1 | **Ghostty をデベロッパツールに登録（ON）** | 🔴 **これが効いた。外すと 37 分に戻る** |
| 2 | `sudo spctl developer-mode enable-terminal` | ⚪ **無関係**（Terminal.app 対象・トグル OFF）。戻してよい |
| 3 | `cargo-nextest` を `~/.cargo/bin` に導入 | ⚪ **未使用**。原因が別だったので出番が無かった |

⚠️ **戻し方**: `spctl` に `disable-terminal` は**無い**（main が誤って案内し訂正した）。
解除は **システム設定 → プライバシーとセキュリティ → デベロッパツール** で
トグル OFF か `−` で削除する。

#### 方針として採らなかったもの

**「`--workspace` を毎回回さない」は採らない。** 検証の範囲を狭める手であり、このリポジトリは
「委譲先の緑は実機の緑ではない」「配線は E2E でしか見えない」という失敗を繰り返している。
**範囲を狭めると同じクラスの事故が戻る。** 今回の対策は「**同じ検証を速くする**」だけなので失うものが無い。

---

### chore(docs): stop planning documents from drifting silently (#814) (Sep 8, 2026)

**Issue**: #814 / **ブランチ**: `814-doc-drift-check` → main（直行）

#### 発端 — owner の問い

束 O-wire を閉じる直前、owner に「**先に送った内容は地図・設計・プランに反映してあるか**」と問われ、
一次ソースで確認したら**不十分だった**。さらに「**現状の地図や設計、実装プランが正しいことは保証
できますか**」と問われ、**保証できないと答えた**（確認したのは 3 項目だけだった）。

🔴 **地図の #801 行が「実測は負荷依存」のままだった。** これは**同日の実測で否定された記述**である。
**地図は次のセッションが最初に読む層**なので、古い記述は**申し送りの誤りを再生産する** —
実際その束は、旧 `/goal` の「負荷をかけて再現条件を作る」という**誤った前提から始まっていた**。

#### 実測した規模

| 文書 | 参照している issue（ユニーク）|
|---|---|
| `DEVELOPMENT_MAP.md` | **174 件** |
| `IMPLEMENTATION_PLAN_2026-09.md` | 90 件 |

⚠️ **粗い検出（同一行に複数 issue）だと 18 件出るが、行の主題で絞ると 4 件**だった。
**数字を出すときは検出条件の粗さも一緒に言う** — 一度「18 件」とだけ報告して owner に問い返された。

#### ① 手順書に「いつ更新するか」を書いた（`BUNDLE_BRANCH_WORKFLOW.md` §5.1b）

**「後でまとめて書く」は必ず忘れる。** 同日の失敗はすべて「変わった直後に書かなかった」ことだった。

| 時点 | 何を | なぜ |
|---|---|---|
| 🔴 **事実が変わった瞬間** | **地図** | 「今どうなっているか」の層。次のセッションが最初に読む |
| 🔴 **決めた瞬間（実装の前）** | **計画・設計** | `CLAUDE.md` 運用規則 6「spec 側を先に更新してから実装する」|
| 束を閉じる前 | 3 文書の突合 | 上 2 つができていれば**確認だけ**で済む |

手順表にも 2 行足した（束を開く前の grep・束を閉じる前の突合）。

🔴 **「実測」を書くときは出典（日付 / PR / commit）を必須にする**とも定めた。
テストが捕まえるのは状態語の矛盾だけで、**内容の誤りは捕まらない**。
出どころがあれば次の人が「これは 09-07 の測定で 09-08 に否定されている」と気づける。

#### ② 突合テストを新設（`tests/docs/planning-issue-state.spec.ts`）

- 文書の `#NNN` を抽出 → **行の主題**（最初に現れる番号）が CLOSED かを判定
- CLOSED なのに `未着手` `引き込む` `予定` 等があれば **red**
- **ベースラインでラチェット**（`dsl-e2e-coverage.spec.ts` と同じ形）

🔴 **テストは GitHub API を叩かない。** issue の状態は
`docs/planning/issue-states.json`（`scripts/docs/refresh-issue-states.mjs` が生成）に固定する。
テストがネットワークとレート制限で落ちると、**#801 と同じ「赤の帰属ができない」状態**を持ち込む。

#### 🔴 テストが初回から本物を 5 件捕まえた

| 行 | 記述 | 実際 |
|---|---|---|
| `MAP:1136` `MAP:1139` | #773 を「**束 O-wire に引き込む**」 | **同日 CLOSED**（PR #811）|
| `PLAN:332` | #780 の束が「**ステージ 2 に着手する前提**」 | **09-07 完了**・ステージ 2 は着手済み |
| `PLAN:333` | #773 を「**引き込み**」 | 同上 |
| `PLAN:499` | #801 を「**O-wire に引き込む**」 | **同日 CLOSED** |

**5 件を直した。** 誤検知 3 件（行頭の番号が主題でない形）は**理由を書いてベースラインへ**。
主題の判定を賢くするより、**少数の誤検知を明示的に許容する**ほうが読みやすいと判断した。

#### 変異検証（main が実行）

| 変異 | 結果 |
|---|---|
| 閉じた issue を「未着手」と書く行を足す | ✅ **red**（該当行を名指し）|
| ベースラインから 1 件消す | ✅ **red** |

#### 🔴 変異の復元を確認して助かった

変異 2 のあと `git checkout -- tests/docs/planning-issue-state.spec.ts` で戻したつもりが、
**ファイルが未追跡（`??`）なので効いていなかった**。テストが赤のままで気づいた。
**「復元した」を確認せずに次へ進まない。**

#### このテストが捕まえないもの（過大評価しない）

| 誤りの型 | 捕まるか |
|---|---|
| 状態語の矛盾（CLOSED なのに「未着手」）| ✅ |
| 🔴 **内容の誤り**（「#801 は負荷依存」・issue は OPEN）| ❌ |
| 文書間のずれ（地図は「PR-O3」・計画は「PR-O3a」）| ❌ |

**同日いちばん危なかったのは 2 番目**で、そこは出典必須の運用で担保する。

---

## 束 O-wire（#611 ステージ 2・統合ブランチ `611-line-wire`）

出口の配線を入れ替える束。**振る舞いは変えない**ので、束の収束条件は
「**`OUTPUT_LINE_GOLDENS` / `O0-1` などの goldens が 1 つも動かないこと**」+ cargo 全緑 + 実機 gated 全件。
中身は PR-O3（`LineProgram` / `SetBusLine`）+ #773 + #801。

### fix(daemon): close the O-wire review round-1 findings (#611) (Sep 8, 2026)

**PR**: [#811](https://github.com/signalcompose/orbitscore/pull/811)（束 O-wire → main）/ **ブランチ**: `611-line-wire`

#### レビュー編成 — Fable を並行投入した（最後に回さない）

`/simplify` 4 エージェント（reuse / simplification / efficiency / altitude）と **Fable 設計監査を並行**起動。
**Critical 0 件**。発見クラスは規約どおり**直交**した:

| 層 | 見つけたもの |
|---|---|
| Sonnet 4 名 | 差分に**在る**ものの重複・冗長（4 件）|
| 🔴 **Fable** | 差分に**無い**もの — **silent な受理 2 件**・**UTF-8 の byte 境界**・**±12% で見逃せる誤りの具体的な範囲** |

#### 🔴 監査が main の読みを 2 箇所訂正した

1. 「bit 一致テストは変換の正しさしか見ていない」→ **静的な方は完全な同語反復**
   （`with_output_target` / `with_sends` は内部で同じ `LineProgram` を組む）。
   実行時の方は**別分岐だが両方とも新コード**。より正確だった
2. 「互換ミラーは特殊ケースの積み上げでは」→ **呼び出し元を追跡すると本番では常に `None`**。
   `with_routing_overrides` を呼ぶのは `output.rs` のテストだけで、
   実体は**旧経路との bit 一致を証明する現役の安全網**だった

#### 🔴 ±12% の許容で何が見逃せるか（監査が具体化）

| 誤り | 検出 |
|---|---|
| **`send` 係数 0.3 の誤り** | 🔴 **0.144〜0.456（−52%〜+52%）が通る** |
| 出力ゲイン ±1 dB / 全体の極性反転 / L/R 入れ替え | 通る |
| send の二重加算・消失 | 落ちる |

**穴は実在する。** これを知ったので cargo 層を厚くする判断ができた。

#### ポリシーを 1 つ決めてから適用した（指摘単位のローカルパッチにしない）

> **出口の配線において「未登録」「未配線」を silent に受理しない。**
> 反映されない入力（登録されていない bus、RT が実行しない op）は `Ok` を返さず `Err` にする。

このリポジトリでは「評価は成功するのに音が変わらない／変わる」形の欠陥が繰り返し出荷されている。
**silent な受理は、次の PR の配線忘れをそのまま本番へ通す。**

#### 直したもの

| # | 内容 |
|---|---|
| **A-1** | `set_bus_routing` が `bus_lines` に無い bus で **silent に `Ok`** を返していた → `Err`。🔴 **`Err` は atomic mirror と activation の両方より前**に返る |
| **A-2** | `Pan` / `Render` / `Link` を `validate_line_program` が受理し RT が無視 → `Err`。**「配線したらこの拒否行を消せ」とコメントに明記**（可用性ゲートであって形式制限ではない）|
| **A-3** | #773 が **UTF-8 の byte 境界**未対応（`data.toString()` per chunk で多バイト文字が U+FFFD 化）→ `StringDecoder` を **bridge dispatch の前段だけ**に。🔴 **`decoder.end()` を `flush()` の前**に置く（逆順だと最後の 1 文字が消える）|
| **B-1** | 実行時 bit 一致を **4 トポロジ**へ拡張（master のみ / sum のみ / output-only 更新で send 保持 / 2 send）|
| C-1〜C-4 | `BusLineInstaller` の重複定義 / sentinel デコード 2 箇所 / send オフセット 3 箇所 / `first_output` の三項分岐 2 箇所 |
| D-1〜D-3 | 退役 margin の論法を先例と書き分け / `Cell` の RT 専有は型でなく encapsulation 依存 / poisoning の注記 |

🔴 **A-3 の red-first が本物だった**: 修正前は実際に `"���本語の診断"` と化けていた。

#### 🔴 B-1 は要求より 1 段強く作られていた

bit 一致だけだと「**両方とも send を落としている**」場合も緑になる。
output-only 更新のテストが **「send バッファが非ゼロ」を別途 assert** しており、同語反復の穴が塞がれている。

#### なぜ (A) ではなく (B) を採ったか

監査は「旧 RT から bit-exact oracle を作る」(A) を推奨したが、**(B) トポロジを増やす**を採った。
理由: RT の shim 分岐（`legacy_targets` / `legacy_send_gains`）は**無改変の既存テスト 6 本が固定している**ので、
`shim ≡ program` を複数トポロジで示せば **推移的に「旧 RT ≡ program」**が言える。(A) より安く、ほぼ同じ強度。

#### 見送った指摘（理由つき）

| 指摘 | 見送りの理由 |
|---|---|
| RT の marking / execution 2 重 walk | **構造的**（`render_multi_feeds` が事前に完全な target を要求）・**パス数は元から 2 本**・**未測定**。2 人のレビュアーが独立に同判断 |
| `extension.ts` の stdout 二重 split | **#614 で穴を踏んだ高リスク領域**。軽微・未測定 |
| mono downmix の `0.5` が 2 箇所 | 意味論が違う（代入 vs 加算）|
| `LineControl` の薄いラッパー | 確信度 中・呼び出し側の書き換えを伴う・実害小 |
| `LineExchange` ≒ `ChainExchange` | 共有クレート抽出が要る・**PR-O6 まで形が固まらない** |

#### 監査の運用指摘 2 件も処理した

- **束の中身が正本とずれる**（O3b 分離）→ 計画 §1.10・§2.5 と設計 611 §12 に
  **PR-O3a / O3b の分割とその理由**を記録
- **追跡先が CLOSED 済み #801 のコメント**だった → issue
  [#813](https://github.com/signalcompose/orbitscore/issues/813) を独立して作成

#### 🔴 地図・計画・設計への反映が漏れていた（owner 指摘）

束を閉じる直前に owner から「先に送った内容は地図・設計・プランに反映してあるか」と問われ、
**一次ソースで確認したら不十分だった**。

| 文書 | O3a/O3b 分割 | 実機未検証の範囲 | #801 の実測訂正 |
|---|---|---|---|
| 地図 | 🔴 **無し**（「PR-O3」のまま）| 🔴 無し | 🔴 **「負荷依存」の古い記述が残存** |
| 計画 | ✅ | 🔴 無し | ✅ |
| 設計 611 | ✅ | 🔴 無し | — |

🔴 **地図の #801 行が「実測は負荷依存」のままだった。** これは同日の実測
（効く変数は `--test-threads`・除外実験で犯人は 1 本）で**否定された記述**である。
**古い事実が地図に残るのが一番まずい** — 地図は次のセッションが最初に読む層だから。

直したもの:

1. **地図 §4.A** — PR-O3 → **O3a / O3b**（可逆 vs 一方通行という分割理由つき）
2. **地図 #801 行** — 「負荷依存」を撤回し、`--test-threads` 依存と犯人 1 本の確定へ。**解決済みの印**
3. **地図 #773 行** — 解決済みの印 +「**UTF-8 byte 境界は直したが stderr 側（#756）は未対応**」
4. **設計 611 §10 冒頭** — 実機で一度も鳴っていない op の一覧 + **±12% で `send` 係数の −52%〜+52% が通る**根拠
5. **計画 §1.10 PR-O4 行** — 上記を「次の束で押さえる対象」として引き継ぎ

#### 🔴 スクリプトの成功出力を成果の証拠にしない（本日 2 回目）

設計 611 への書き込みが**一度空振りした**。見出しが
`## 10. E2E 項目（すべて MCP 経由…）` と括弧つきなのに `## 10. E2E 項目\n` をアンカーにしており、
`assert s.count(anchor)==1` が**部分文字列として成立してしまった**ため `ok` が出た。

**`ok` の後に grep で実在を確認したので気づけた。** 同日 1 件目はワークスペーステストの
中断ログを完走と読みかけた件で、いずれも「**実行が成功したこと**」と「**目的が達成されたこと**」を
取り違える型である。

#### 🔴 実機で検証されていない範囲（記録）

実機 gated が通している op は **{Rack, Output(Master,1.0), Output(Bus,1.0), Output(Bus,0.3)}** だけ。
**`Gain` op / `Device` 宛て / mono マージ / 複数 send / gain 0 での send 除去 は実機未検証**
（cargo の bit 一致では覆っている）。

---

### feat(daemon): line program and RT execution, legacy SetBusRouting mapped onto it (#611 PR-O3a) (Sep 8, 2026)

**Issue**: #611 / **ブランチ**: `611-o3a-line-program` → `611-line-wire`（小 PR）
**正本**: `docs/design/611-output-line-design.md` §5.1（型）・§5.3（RT アルゴリズム）

#### この PR の価値は「音が変わらないこと」にある

`OutputDest` / `LineOutput` / `LineOp` / `LineProgram` / `LineSlot` を新設し、RT の post-loop を
プログラム実行に置き換えた。**旧 `SetBusRouting` は内部で `LineProgram` を生成する形に写して互換を保つ。**
振る舞いを変えない配線の入れ替えなので、**「変わっていない」が最も決定的な検算**になる。

🔴 **wire（`SetBusLine`）と TS 側は含まない**（PR-O3b）。`LineOp::Pan` / `OutputDest::Render` /
`OutputDest::Link` は variant の定義のみで**実配線しない**（PR-O4 以降）。

#### 🔴 収束条件は満たされた — goldens は 10 桁一致

| golden | O3a 前（#773 の実機）| O3a 後 1 本目 | O3a 後 2 本目 |
|---|---|---|---|
| `noBus firstRms` | 0.0870166332**8518032** | 0.0870166332**7764678** | 0.0870166332**8789269** |
| `totalOverDry` | 1.3000000133**642298** | 1.3000000133**585945** | 1.3000000129**92668** |
| `effectOnly/dry` | 1.9952622670**586015** | 1.9952622670**915188** | 1.9952622669**054862** |
| `combined/dry` | 0.9999999201**338745** | 0.9999999201**503713** | 0.9999999200**459261** |

⚠️ **golden 定数（0.0846173）との +2.8% のずれは O3a 以前から存在していた**もので、±12% の
意味論許容に吸収されている。**この PR で動いたものは何も無い。**

#### 🔴 main の変異検証がテストの穴を 1 つ見つけた

`if !output.thru { … break }` は **2 箇所**ある。`if false {` へ変異させて実測:

| 箇所 | 役割 | 当初 | 修正後 |
|---|---|---|---|
| `output.rs:2161`（RT 実行側）| 加算の打ち切り | ✅ red | ✅ red |
| 🔴 `output.rs:2002`（**marking pass**）| `render_targets[target] = true` の打ち切り | 🔴 **70 件すべて緑**（生き残り）| ✅ **red** |

marking pass が止まらないと**本来描画されないバスが描画対象になり、自分のラインを実行して
master へ加算する** = **音が変わる**。**この束の収束条件が捕まえるべき種類の誤りが、
cargo 層では素通りしていた。**

対処として `marking_stops_before_bus_output_after_thru_false` と対照の
`marking_reaches_bus_output_after_thru_true` を追加（後段 inactive バスに sentinel 値を置き、
marking されれば zero-fill される／されなければ保存される、で区別する）。
🔴 **実装は 1 行も変えていない**（実装領域の SHA-256 照合で確認）。

#### 🔴 main が反証してほしい読み（Fable 監査へ回す）

互換の bit 一致テスト 2 本は「旧 API 構成」と「program 構成」を比べているが、
**O3a 以降は旧 API も内部で `LineProgram` を生成する**ので両方が同じ実行経路に収束する。
したがって保証されるのは**変換の正しさ**であって、
**「新しい RT 実行が O3a 以前と同じ音を出すこと」ではない。**
後者を保証しているのは**期待値を直書きした既存テスト（無改変）**と**実機 goldens（±12%）**だけ。

#### 退役規律は先例を踏襲した

`RetiredLineProgram::retired_at_generation` を**退役オブジェクト内**に保持する。
`orbit-effect-rack-child` の `StageList::retired_at_generation`（`:214, :247-249`）が
**「別の atomic をポインタの隣に置く形」を明示的に棄却している**ので、それに倣った。
世代は RT が `finish_generation()` で進め、**描画対象でない stage も含む全 stage** に対して
呼ぶので、非アクティブなバスの退役分も回収される。

#### 検証（🔴 すべて main が sandbox 外で実行）

| 何を | 結果 |
|---|---|
| `cargo fmt --all --check` | exit 0 |
| `cargo clippy --workspace --all-targets -- -D warnings` | exit 0 |
| `cargo clippy`（`outproc-effect,outproc-instrument`）| exit 0 |
| `cargo test --workspace --locked` | **608 passed / 0 failed / 38 ignored**（93 スイート・**完走マーカーで確認**）|
| `cargo test -p orbit-audio-native --lib` | **72 passed / 0 failed / 2 ignored** |
| 互換 bit 一致 2 本 | pass |
| 🔴 変異（marking pass）| 修正前 = 生き残り → 修正後 = **red** |
| 実機 gated（静穏時）| **29 passed / 1 failed** = `steps the live playhead`（**既知の main baseline**）のみ |
| 既存アサーションの削除・変更 | **0 件** |

#### 引用の再アンカー（64 件・うち 10 件は引用元の変更）

`output.rs` を大きく触ったので dev サイトの引用が 64 件落ちた。

| 種類 | 件数 | 対処 |
|---|---|---|
| 純粋な行ずれ | 54 | `check-citations.mjs --fix` |
| 🔴 **引用元の移動** | **10**（ja/en 各 5）| **手作業で新しい位置へ付け替え** |

後者は `render_block_with_sources` / `advance_gain` の doc / `render_engine_with_sources` /
`sources.is_empty()` / `collect_source_feeds` の 5 箇所で、**中身は同じで位置だけが動いた**もの。
行数を変えずに開始位置だけを移した。

検証: `npm run docs:check` → **984 citations verified, 0 failed**。

🔴 **`--fix` の後に必ず残件を確認する。** 64 → 10 に減った時点で満足すると、
**引用元が変わった 10 件が古いコードを見せ続ける**。#773（80 → 6）でも同じ形だった。

#### 🔴 実機の赤を実装のせいにしかけた（本日 2 件目）

1 本目の実機で `#611 O0-1` が落ちたが、原因は RMS ではなく **ERROR 行の増加**だった:

```
engine lock contention (N total); a block was silently zero-filled — this self-heals next block
```

`session.rs:987` の**既存**の WARNING（#401・engine 内部 Mutex の `try_lock` 失敗を可視化）で、
O3a の差分には無い。しかし **O3a 前の実機ログでは 0 回**だったので「無関係」とは言えず、
`LineSlot::install` が control 側で `Mutex` を取ることもあって**因果があり得た**。

**静穏時に測り直したら contention は 0 回・O0-1 は緑**だった。1 本目は `syspolicyd` が 30%
動いている最中の実行だった。

🔴 **本日 2 件目**（1 件目は `pipelined_host_with_real_child_is_gain_delayed_one_block`）。
**実機の赤は、実装を疑う前に静穏時に測り直す。** macOS のセキュリティ評価
（`syspolicyd` / `XprotectService`）は数十秒〜数分の単位で走り、その間だけ実機テストが落ちる。

---

### fix(test): anchor the tracing callsite interest so capture cannot go empty (#801) (Sep 7, 2026)

**Issue**: #801 / **ブランチ**: `801-tracing-interest-anchor` → `611-line-wire`（小 PR）

#### 実害 — ステージ 2 の 1 本目を出す前に 2 回起きた

`rust-ci.yml` は**全 PR で走る**。`device_switch_result_records_failure_and_success_through_the_same_path`
が `captured log: ""` で間欠的に落ちると、**赤の帰属ができなくなる**。

本日、**docs のみの PR 2 本**（[#800](https://github.com/signalcompose/orbitscore/pull/800) /
[#805](https://github.com/signalcompose/orbitscore/pull/805)・いずれも **Rust 差分 0 件**）で発生し、
#805 では**再実行（attempt 2）でも同じ失敗**をした。

#### 🔴 申し送りの前提が 1 つ崩れた — 「負荷依存」ではなく「スレッド数依存」

`/goal` は「**負荷をかけて再現条件を作れ**」だったが、**CPU 負荷は無関係だった**。
default feature の `--lib`（**55 テスト・1 回 0.01 秒**）を、負荷ゼロで 100 回ずつ:

| `--test-threads` | 失敗 / 100 |
|---|---|
| 1 | **0** |
| 2 | **16〜24** |
| 3 | 0 |
| 4（= `ubuntu-latest` は 4 コア）| **9** |
| 6 | **11** |

⚠️ `--test-threads 3` が 0 なのは**説明できていない**（不確実として残す）。
🔴 **CPU を 20 プロセスで飽和させた最初の試みは無駄足だった。変数の当て方を誤っていた。**

#### 🔴 除外実験で犯人を 1 本に確定した

| 条件（`--test-threads 2` × 100）| 失敗 |
|---|---|
| baseline（全 55）| **24** |
| `--skip select_audio_device_records_capture_owner_and_send_rejections` | 🔴 **0** |
| `--skip get_status_adds_effective_output_callback_state_and_last_switch_failure` | 22（**変化なし**）|

当初候補に挙げた `session::tests::get_status_...` は**無関係**だった（推測を実測が否定した）。

#### 機構（一次ソース `tracing-core 0.1.36`・設計は Fable・実証は main）

1. `never` を書くのは **初回登録（`DefaultCallsite::register`）の 1 回だけ**
2. 🔴 `MAX_LEVEL` の初期値は `OFF` で、マクロは `level_enabled!` を `interest()` より**先に**評価する
   → **犯人が初回登録者になれるのは、被害者が `Dispatch::new` を済ませた後だけ**（窓は数 µs）
3. 犯人が登録者になると `NoSubscriber` に解決して **`Interest::never()`** をキャッシュ
4. それが被害者の `rebuild_interest_cache()` **より後**・`error!` **より前**に着地すると **skip**
   （`never` は `enabled()` にフォールバックしない）

🔴 **2026-09-05 の緩和策のコメント「この順序依存を消す」は誤りだった。** 窓を狭めただけである。

#### 直し方 — グローバル「anchor」subscriber

`register_callsite` が**常に `Interest::sometimes()`** を返す subscriber を `set_global_default` で
1 回だけ入れる。以後どのスレッドが登録・再構築しても interest は `sometimes` に固定され
（`Interest::and` は異なる値なら `sometimes`）、判定は毎回**そのスレッドの `enabled()`** に落ちる。

`max_level_hint` は **`OFF`**。捕捉スコープが無い間は `MAX_LEVEL` が `OFF` のままなので、
**残り約 270 本の挙動とコストが現状と同一**（マクロが `level_enabled!` で短絡）。

#### 🔴 発注前に不確実性をゼロにした（最小クレートで 5 モード実行・各モード別プロセス）

| モード | 捕捉 |
|---|---|
| `baseline` / `preregistered`（`--test-threads=1` の形）| ERROR 行あり |
| **`race`** / **`firsthit-after-rebuild`**（実経路を順序づけた形）| 🔴 **`""`** |
| **`anchor`**（本修正）| ✅ ERROR 行あり |

`max_level_hint` を **`TRACE` と `OFF` の両方**で実行し、どちらでも `anchor` が捕捉できることを確認。
設計で唯一「中〜高」だった確信度を**実装発注の前に**潰した。

#### 入ったもの

| 場所 | 内容 |
|---|---|
| `test_tracing.rs`（新設・`#[cfg(test)]`）| `InterestAnchor` / `install_interest_anchor()` / 共通 `capture_tracing` / `simulate_subscriberless_rebuild` |
| `engine_wrap.rs` `EngineWrap::build` | `#[cfg(test)] install_interest_anchor()`。🔴 **`start_with` ではなく `build`**（`start_with` は integration test からも呼ばれ `cfg(test)` が付かない）|
| 捕捉 2 箇所 | 共通 helper へ。**誤ったコメントと `rebuild_interest_cache()` を削除**。重複していた writer 実装 2 つも 1 本化 |
| 決定論テスト | 犯人の実経路（別スレッド）+ 遅着 rebuild（別スレッド）の**両方**を置く |
| 衛生テスト | `with_default` 等が `test_tracing.rs` の外に現れたら赤（自分自身は `concat!` で除外）|

**犯人テストは書き換えていない** — subscriber を張らずに製品コードを呼ぶのは正当なテストで、
壊れていたのは**捕捉の仕組みの方**である。

#### 検証（🔴 すべて main が sandbox 外で実行した結果）

| 何を | 結果 |
|---|---|
| `cargo fmt --all --check` | exit 0 |
| `cargo clippy --workspace --all-targets -- -D warnings` | exit 0 |
| `cargo clippy`（`outproc-effect,outproc-instrument`）| exit 0 |
| `cargo test --workspace --locked` | **599 passed / 0 failed / 38 ignored**（93 スイート）|
| `cargo test`（feature 付き）| **326 passed / 0 failed / 13 ignored**（20 スイート）・`r9_missing_rt_ack` も緑 |
| 🔴 **red-first** | anchor の設置を外すと **`assertion left == right failed: captured log: ""` / `left: 0, right: 1`** |
| 100 回 × `--test-threads 2` | **0 / 100**（修正前 16〜24）|
| 100 回 × `--test-threads 4`（CI と同条件）| **0 / 100** |

#### 🔴 測定で 2 回つまずいた（同じ轍を踏まないための記録）

1. **空パスを実行して「100/100 失敗」と出した。** `ls -t ... | grep -v '\.d$'` が空を返し、
   `"" --test-threads 2` を 100 回叩いていた。**変数を表示していたので気づけた**
2. **中断された実行を「完走」と読みかけた。** ワークスペーステストが `orbit_effect_rack_child` の
   起動行で止まったログを、50 スイート分の集計で「455 passed」と報告した。
   🔴 **終了マーカー（`EXIT=`）を確認してから数字を使う。** 走らせ直したら 93 スイート・599 passed だった

#### 🔴 既知の赤を 1 件、台帳に足す

`pipelined_host_with_real_child_is_gain_delayed_one_block`（`orbit-audio-sandbox`）が 4 回連続で
落ちたが、**私の変更を外しても落ちた**。`docs/archive/WORK_LOG_2026-08.md:1557` に同じ記録があり、
原因は **macOS のセキュリティ評価**（実測: `syspolicyd` 42% / `XprotectService` 29%）。
**静穏になってから 3 回走らせると 0.1〜0.3 秒で pass**（負荷時は 7.00 秒 = タイムアウト）。
テスト自身が `#520` で「ビルド直後の child は macOS のセキュリティ評価で数秒〜24 秒止まりうる」と
警告している。**赤を実装のせいにする前に、静穏時に測り直す。**

#### 引用の再アンカー（22 件・すべて純粋な行ずれ）

`engine_wrap.rs` と `lib.rs` の行数が動いたので dev サイトの `// file:start-end` 引用が 22 件落ちた。
**今回は全件が純粋な行ずれ**で、`check-citations.mjs --fix` が再アンカーして解決した
（#773 のときは 80 件中 6 件が「引用元の変更」で手作業が要った）。

検証: `npm run docs:check` → **984 citations verified, 0 failed**。

🔴 **Rust / TS のどの PR でもこれは起きる。** `--fix` を掛けたあと**必ず残件を確認する**
（残るなら、それは行ずれではなく引用元が変わったということ）。

#### 触っていないもの（列挙として残す）

`orbit-audio-sandbox/src/transport.rs:3273` / `:3329` に**同型の脆さ**があるが、
**実害が観測されていない**ので本 PR の範囲外とした（束の差分予算）。
探索範囲つきの全列挙は [#801 のコメント](https://github.com/signalcompose/orbitscore/issues/801)に残した。
本筋は dev 専用クレート `orbit-tracing-testkit` へ抽出して両クレートで共有すること。

---

### fix(extension): buffer partial stdout lines before bridge dispatch (#773) (Sep 7, 2026)

**Issue**: #773 / **ブランチ**: `773-stdout-line-buffer` → `611-line-wire`（小 PR）

#### 何が壊れていたか

`setupStdoutHandler`（`extension.ts:1478`）は engine stdout を **chunk ごとに `output.split('\n')`**
していたが、**部分行を次の chunk へ持ち越していなかった**。JSON envelope が chunk 境界で割れると:

- 前半は `{"evalMark"` 等で始まるので分岐に入るが **JSON として不正** → 「malformed」警告
- 後半は prefix 判定を**すべてすり抜けて通常ログとして捨てられる**

→ **その要求の応答が失われる**。`evalMark` / `savePluginState` / `pluginUi` / `engineState` の
4 ブリッジすべてが同じ経路なので、MCP 経由の LLM と gated E2E が待ち続けて timeout する。

**この束で直す理由**: PR-O4 が `//#evalBegin` / `//#evalEnd` を導入して**この壊れたチャネルの
通信量を増やす**ので、増やす前に受け側を直す（計画 §3「ステージ 2 が実際に依存しているもの」）。

#### 直し方 — `createLinePrefixer` を **bridge dispatch だけ**に流用

同じファイルの `createLinePrefixer`（#756・`:1599`）が既に「`partial` を持ち越し、`end` で flush」の
正解形を持っていたので、それを **bridge の 4 分岐だけ**に被せた。

🔴 **ログ転写には使っていない。** 生 chunk と chunk 単位の `lines` は従来どおり即座に
`applyEngineStdoutChunk` へ渡すので、**ユーザーが見るログは 1 行も遅れない**し、
`createLinePrefixer` の空行除去も入らない。playhead / `//#selectAudioDevice` の呼び出し規約も不変。

buffer は `setupStdoutHandler` の**呼び出しごと** = process ごとに閉じているので、
stale な process の断片が現行 process の dispatch に混ざらない（#528 の stale ガードと同じ意図）。

#### 🔴 遅延は実際には起きない（一次確認）

バッファリングは「改行が来るまで待つ」ので、原理的には最後の 1 行が遅れうる。
だが 4 種の envelope はすべて `packages/engine/src/cli/repl-mode.ts` の
**`console.log(JSON.stringify(...))`** で出しており、`console.log` は**必ず改行を付ける**
（`:460` evalMark / `:167,177,482` savePluginState / `:244,250,440` pluginUi / `:332` engineState）。
したがって `end` の flush は**保険**であって、通常経路では発火しない。

#### 検証（main が sandbox 外で実行した結果）

| 何を | 結果 |
|---|---|
| `npm test`（全件） | **2324 passed / 58 skipped**（158 files passed / 4 skipped）|
| `npm run lint` | 緑（ESLint errors 0）|
| 🔴 **red-first**（main が実装だけ戻して実行）| **新規 7 本が red**。差分の実例: 期待 `{"savePluginState":{"requestId":...}}` に対し実際は **`{"savePluginState":{"reque`**（＝断片が dispatch されていた）|
| 等価ガード 2 本（ログ転写）| **前後とも緑** — 転写の挙動が変わっていないことの証拠 |

🔴 **委譲先の緑を根拠にしていない。** Codex は sandbox の loopback bind 制限で HTTP 系 31 件が
`listen EPERM` になり「all green とは報告しない」と正しく申告した。**その 31 件は main の
sandbox 外実行で緑**である（上表 2324 に含まれる）。

#### 追加したテスト（57 本中の新規 9 本）

| 何を | アサーション |
|---|---|
| 4 ブリッジそれぞれ、envelope を 2 chunk に割って投入 | `toHaveBeenCalledTimes(1)` + **完全な行**で `toHaveBeenNthCalledWith` + malformed 警告 **0 件** |
| 1 chunk に完成 2 本 + 末尾断片 | 完成分は**即座に** 2 回、断片は次の chunk で 3 回目 |
| 改行なしで `end` | flush されて**ちょうど 1 回** |
| process ごとの分離 | 別 process の断片が混ざらない |
| ログ転写（debug / 非 debug） | **即時・従来と同一**（空行の扱いを含む）|

#### 🔴 引用のずれを 2 種類に分けて直した（CI が捕まえた）

`extension.ts` に 49 行足したので、dev サイトの `// file:start-end` 引用 **80 件**が落ちた
（`code-review` ワークフローの `docs:check`）。**内訳は 2 種類で、直し方が違う。**

| 種類 | 件数 | 直し方 |
|---|---|---|
| **純粋な行ずれ** | 74 | `check-citations.mjs --fix` が再アンカー |
| 🔴 **本文の変更** | 6（ja/en 各 3）| **サイトが古い形のコードを逐語引用していた**ので、現在のコードで置き換えた |

後者は `{"evalMark"` / `{"pluginUi"` の分岐を引用していた 3 箇所（`editor/execution-feedback.md` /
`editor/mcp-and-gated-e2e.md` / `plugin-hosting/plugin-ui.md`）。分岐が `for` ループから
`createLinePrefixer` のコールバックへ移り、**インデントが 8 → 4 に変わった**ため機械的な
再アンカーでは合わなかった。地の文（「`setupStdoutHandler` に独立した分岐として置かれている」
「stdout ルータが `{"pluginUi"` の前方一致で拾う」）は現在も正しいので触っていない。

検証: `npm run docs:check` → **984 citations verified, 0 failed**。

🔴 **`--fix` の結果を確認せずに済ませない。** `--fix` 後もまだ 6 件落ちており、
そこだけが「行がずれた」ではなく「**引用元が変わった**」だった。件数が減ったことを
成功と読むと、古い記述がサイトに残る。

#### 直していないもの

`//#selectAudioDevice` も chunk 境界で割れうるが、そちらは既に専用の
「possible chunk-boundary split」警告を持っており、本 issue のスコープ外。
docstring の「chunk → 行の経路は 4 つ」の 3 番を現状に合わせて更新した。

---

### chore(docs): rotate WORK_LOG before the O-wire bundle (#804) (Sep 7, 2026)

**Issue**: #804 / **ブランチ**: `804-rotate-worklog`（main 直行・docs のみ）

#### なぜ今か — 束の途中で止まると commit ごと止まる

本体が **1,926 行**で上限 2,000 行（`tests/docs/worklog-size.spec.ts:19`）まで残り **74 行**だった。
束 O-wire（PR-O3 + #773 + #801）は小 PR を 3 本以上積むので、**束の途中で red になる**。

🔴 red になった時に止まるのは**テストではなく commit** — pre-commit フックが走るので、
「テストを直してから commit」ができない。2026-09-04 に実際に 2 回止まっており、
そのとき push だけが通って**中身の無いブランチを「push した」と報告**する事故になった
（`chore(hooks): verify a push actually landed (#742)` の記録・本 PR で archive へ移設）。
**着手前に片づけるのはこのため。**

#### 移設した範囲

| | |
|---|---|
| 移設 | 09-04〜09-06 の **19 見出し**（うち実エントリ 17・2 件は本文中のコード柵内） |
| 本体 | 1,926 行 → **1,141 行**（最新 20 エントリ = `PROJECT_RULES.md` §1a「latest 15-20 sections」） |
| 先 | `docs/archive/WORK_LOG_2026-09.md`（3,746 → 4,535 行）の新節 `## 09-04〜09-06 の追補` |

**本文は 1 文字も書き換えていない**（移設のみ）。アーカイブ側の H1 と本体末尾
`## Archived sections` の索引ラベルを `09-01〜09-05` → `09-01〜09-06` へ更新した。

#### 検証（結果を貼る・自己申告にしない）

| 何を | 結果 |
|---|---|
| `npx vitest run tests/docs/worklog-size.spec.ts` | **2 passed**（行数・索引の 2 件とも） |
| `npm run docs:check` | **984 citations verified, 0 failed** |
| 移設ブロックの同一性 | 🔴 `git show HEAD:...` の 1127-1911 行と archive 側を **文字列比較して一致**（`identical: True`）|
| 見出しの保存 | 39 → 本体 20 + archive 19（**欠落なし**）|
| 他文書からの名指し | `sites/**/*.md` に `development/WORK_LOG.md` の引用は **0 件**。既存の引用はすべて archive 側の `6.xxx` 番号なので影響なし |

🔴 **同一性を目視で済ませなかった理由**: 前回（2026-09-06）のローテーションは docs-sync の衝突解消と
重なって**見出しだけが本体に取り残される**事故を起こしている
（`docs: repair the orphan WORK_LOG headings the docs-sync merges left`・本 PR で archive へ移設）。
「移した」の自己申告ではなく、**移設元と移設先の文字列一致**を根拠にする。

---

### docs(planning): pull the CI flake (#801) into the O-wire bundle (Sep 7, 2026)

**ブランチ**: `801-pull-flake-into-o-wire`（main 直行・docs のみ・Closes #801 ではない — #801 は実装で閉じる）

#### 発端 — docs のみの PR で CI が落ちた

PR [#800](https://github.com/signalcompose/orbitscore/pull/800)（**`.md` 4 ファイルのみ・Rust 差分 0 件**）で
`fmt / clippy / test` が FAILURE になった。落ちたのは
`engine_wrap::select_audio_device_tests::device_switch_result_records_failure_and_success_through_the_same_path`
の **`captured log: ""`**（`engine_wrap.rs:10723`）。

🔴 **コード中のコメント自身がこの故障を記録していた**（`engine_wrap.rs:10704-10709`）:

> callsite の interest はプロセス全体で 1 つ。並列に走る別テストが同じ `tracing::error!` を
> **subscriber の無い状態**で先に踏むと `Interest::never()` がキャッシュされ、このテストの捕捉が**空**になる
> （**2026-09-05 に `--lib` 全件で 1 回発生**・単体と再実行では緑）。捕捉の直前に再構築して、この順序依存を消す。

**緩和策（`tracing::callsite::rebuild_interest_cache()`）は 2026-09-05 に入っているのに、09-07 に再発した。**
「この順序依存を消す」は達成できていない。→ **issue #801** を新規に立てた。

#### 実測（負荷依存・単一の失敗率は出さない）

| 実行 | 結果 |
|---|---|
| CI（ubuntu） | 🔴 **FAIL** → 再実行で **SUCCESS**（flaky の裏付け） |
| 手元 `--lib` 全件 × 5（他の処理と並走） | **2 FAIL / 5** |
| 手元 `--lib` 全件 × 10（アイドル） | 0 FAIL |
| 手元 当該テスト単体 × 10 | 0 FAIL |
| 手元 `--lib` 全件 × 5（`--test-threads=1`） | 0 FAIL |

⚠️ **途中で計測を 1 回壊した。** `$TMPDIR` がサンドボックスの内外で別を指すため
`> "$TMPDIR/a1.log"` のリダイレクトが失敗し、cargo の終了コードではなく**リダイレクトの失敗**で
「25 件すべて FAIL」に見えていた。書けるディレクトリを明示して取り直した値が上表。
🔴 **終了コードだけで判定せず、ログに期待する文字列（`captured log: ""`）が在るかで数え直した。**

#### 🔴 O-wire 束に引き込む（owner 2026-09-07）

計画 §3 の引き込み条件「**そのステージの受け入れ基準が依存しているものだけを、そのステージの
PR の中で直す**」に照らして引き込む。

**依存している根拠**: `rust-ci.yml` は**全 PR で走る**。間欠的に赤くなると
**ステージ 2 のどの PR でも「自分の変更のせいか」を切り分けさせる**ことになり、慣れると無視されて
ゲートが死ぬ — **#780 をステージ 2 の着手条件にしたのと同じクラス**。
**O-wire は Rust を触る束なので、この CI ジョブを最も多く回す。**

| 束 | 中身（更新後） | 概算 |
|---|---|---|
| **O-wire** | PR-O3 + **#773** + **#801** | 約 850 行 |

#### 反映先

- **実装プラン**: §2.5 束テーブル / §3 ステージ 2 の 3 束テーブル + 引き込みの理由 / 引き込み条件の表
- **地図**: §4.A の出口行 / §6.2 に **#801 の行を新設**
- **設計 611**: §12 の束テーブル
- Serena 引き継ぎメモリ + `/goal` プロンプト + auto-memory

#### 🔴 直し方は決めていない（未検証の仮説だけ残す）

`rebuild_interest_cache()` は**呼んだ時点**の interest を再計算するが、`with_default` のスコープに
入った後で**別スレッドが同じ callsite を subscriber 無しで踏む**と再びキャッシュが `never` へ倒れうる。
だとすれば「捕捉の直前に 1 回再構築」では足りない。**机上推論なので確定させず、
着手時に再現条件（負荷をかける）を作ってから直す**（#801 本文）。

#### 検証

- `npm run docs:check`: 984 citations verified / 0 failed
- `tests/docs/`: 2 passed

---

### docs(planning): split stage 2 into three bundles (Sep 7, 2026)
### docs(process): follow the three-bundle split into the workflow docs (Sep 7, 2026)

**追従元**: PR [#800](https://github.com/signalcompose/orbitscore/pull/800)（`799-split-stage2-bundles` → main・マージコミット `9672ba3`）/ **ブランチ**: `claude/docs-sync-pr800`

#### 何を追従したか

#800 は計画 §2.5 / 地図 §4.A / 設計 611 §12 の 3 点セットを直したが、**束テーブルの写しがもう 1 箇所ある**ことを拾えていなかった。`BUNDLE_BRANCH_WORKFLOW.md` §10 は旧 2 束（`O-dsl` = PR-O4・O5・O6・約 1,300 行）のまま残っていた。

| ファイル | 直した内容 |
|---|---|
| `docs/development/BUNDLE_BRANCH_WORKFLOW.md` §10 | 旧 2 束 → **3 束**（O-wire / O-surface / O-multiout）。検証列を追加し、**正本が計画 §2.5 である**ことを明記 |
| 同 §10.1（新設） | 3 束に切った 4 つの理由と払うコスト |
| 同 §5.1 | 🔴 **上限だけで切らず「検算の機会」でも切る**を一般規則として追加。数え方（**変更行 = `+` と `-` の合計**）も追加 |
| 同 §2 用語 | 「1 つの設計文書に対応する」→ **1 設計文書 = 1 束とは限らない**（611 は 3 束）|
| 同 §3 形 | 図の小 PR ラベル `O3 O4 O5 O6` を汎用の番号へ（1 束 = O3〜O6 ではなくなったため）|
| `docs/core/PROJECT_RULES.md` 束ブランチ運用 | 同上 2 点（1 設計文書 = 1 束ではない・変更行で数える）|
| `CLAUDE.md` 束の節 | 数え方と「検算の機会で切る」を 1 行で追記 |
| `docs/planning/IMPLEMENTATION_PLAN_2026-09.md` §3 | 🔴 **`#### 3 束に切る` が箇条書きの途中に空行なしで挿入されていた**ため、ステージ 2 の `- **結果**` / `- **確認**` / `- **閉じる**` 以降 20 行超が**この見出しの配下に回っていた**。見出しブロックをステージ 2 の末尾へ移動（**本文は 1 文字も変えていない**）|

#### 追従不要と判断したもの

`packages/` `rust/` の変更がゼロなので、DSL 仕様（`docs/specs-v2/` / `docs/core/INSTRUCTION_ORBITSCORE_DSL.md`）・ユーザー向け（`sites/user/` / `docs/user/`）・dev サイト（`sites/dev/`）はいずれも対象外。#800 は**まだ書かれていない PR の割り当て**を決めただけで、出荷された表面は変わっていない。



**ブランチ**: `799-split-stage2-bundles`（main 直行・docs のみ・Closes #799）

#### owner の問い

> ステージ２をいくつかの段階に分けて進めたいと考えています。キリのいい分け方はありますか？
> それともボリューム的に分けないでやっても問題ないですか？
> これは「分けろ」と言ってるのではなく**忖度ない進め方の意見**がほしいです。

**答え: 分ける。ただし理由は分量ではない。**

#### 3 束（計画 §2.5 が正本）

計画 §2.5 は既に **2 束**（`O-wire` = PR-O3 / `O-dsl` = PR-O4・O5・O6）だったので、**後者を割った**。

| 束 | 統合ブランチ | 中身 | 検証 |
|---|---|---|---|
| **O-wire** | `611-line-wire` | PR-O3 + **#773** | 🔴 **goldens が 1 つも動かないこと** + cargo |
| **O-surface** | `611-output-line` | PR-O4 + **daemon 台数のアサーション** | **E2E-2〜7 + E2E-10** |
| **O-multiout** | `611-multiout` | PR-O5 + PR-O6 | **E2E-9 + 全件緑** |

#### 🔴 切る理由（分量は四番目）

1. **O3 の検証は一度しか使えない機会。** PR-O3 は「旧 `SetBusRouting` の内部を program 生成へ写す
   （**互換維持**）」＝**振る舞いを変えない配線の入れ替え**なので、検証は「**goldens が動かないこと**」
   で済む（`OUTPUT_LINE_GOLDENS` / `O0-1` は実装済み）。**O4 と同じ束に入れるとこの検算は永久に失われる** —
   O4 は DSL 表面を変えるので goldens は*正当に*動き、「配線の入れ替えで音が変わったか」を二度と問えない
2. **O6 は旧経路を消す＝逃げ道を塞ぐ。** O4 と同じ束だと、赤が出たときに「新しい DSL が誤り」と
   「消したものがまだ必要だった」を区別できない。**逃げ道は O4 が実機で確かめられた後に塞ぐ**
3. **一方通行と可逆を混ぜない。** O4 は 🔴 一方通行（DSL 表面）、O5 / O6 は戻せる
4. **分量**: O4+O5+O6 = 約 1,850 **変更行**で束の上限 1,500 を超える

**払うコスト（正直に記録する）**: 束の締めのフルレビューが **1 回 → 3 回**。ただし束の中の小 PR は
どのみち分かれているので、増えるのは**締めのレビュー 2 回分**。

**採る根拠**: このリポジトリの反復する失敗モードは**帰属**である（#780 は仮説を 3 連続で外した。
E-gate をステージ 2 の前提にしたのも「毎回**自分の変更のせいかを切り分けさせる**」から）。

#### 🔴 訂正 2 件

| | #797 の記載 | 正しくは |
|---|---|---|
| daemon 台数のアサーションの置き場 | 「**PR-O6** と同じ PR」 | **PR-O4**。§1.10 の **O4 行の検証列が「E2E-2〜7・E2E-10」**と明記しており、**E2E-10（daemon respawn）は O4 の検証** |
| 束の「概算」行数の数え方 | 明記なし（旧「O-dsl 約 1,300 行」は net） | **変更行（`+` と `-` の合計）で数える**と §2.5 に明記。net だと同じ束が上限を跨いだり跨がなかったりする。**レビューが読む量は変更行** |

#### 反映先（3 点セット）

- **実装プラン**: §2.5 束テーブル（3 束 + 数え方の但し書き）/ §1.10 の PR-O3〜O6 行に束と根拠 /
  §3 ステージ 2 に構造・4 つの理由・コスト
- **地図**: §4.A の出口行に 3 束 + 切る理由の注記 / §6.2 の #624（置き場を O4 へ訂正）・
  **#773（束 O-wire へ引き込み）**・**#777（backlog）**
- **設計 611**: §12「PR 分割」に束の対応と、O3 を単独にする理由・O6 を O4 と分ける理由

#### 検証

- `npm run docs:check`: 984 citations verified / 0 failed
- `tests/docs/`: 2 passed

---
### docs(planning): follow up PR #797 — split the E-router bundle in the summary rows and fix the PR-E8 call site (Sep 7, 2026)

**ブランチ**: `claude/docs-sync-pr797`（docs 追従ルーチン・**docs のみ**。実装とテストは触っていない）

**追従元**: PR [#797](https://github.com/signalcompose/orbitscore/pull/797)（merge commit `c1144bd`・head `f008705c`）。
CI は head `f008705c` に対して **3 件すべて緑**（code-review / fmt・clippy・test / license・dependency gate）。

#### 1. 束 E-router の「割った」が要約行に届いていなかった

#797 §3 は **束 E-router を束として持たず割る**（#773 → ステージ 2 の PR / #777 → backlog）と決めたが、
**同じ文書の要約行 2 つと地図の 1 節が旧のまま**だった:

| 場所 | 旧 | 直した内容 |
|---|---|---|
| `IMPLEMENTATION_PLAN_2026-09.md:325` | 束一覧に「E-router / PR-E12 / 約 240 行 / ステージ 2 と並行可」 | 打ち消し + §3 への差し戻し。順序制約は #757 着手時に #777 と畳んで満たす旨を明記 |
| 同 `:406` | 現況一覧に「🔴 #757 の直前に置く」 | 同上 |
| `DEVELOPMENT_MAP.md:1131` 手前 | 「束 E-router の収束条件」が束前提のまま | 改訂の見出しを前に置き、**着手の単位が変わった**ことと**目標は変わらない**ことを分けた |

**放置した場合の実害**は #797 自身が書いたものと同型 — 束一覧を読んだ次の人が `777-line-router` を切りに行く。
🔴 **決定を本文に書いても、同じ文書の要約表が古いままなら決定は伝わらない。**

#### 2. 🔴 PR-E8 の「唯一の使用箇所」が別のテストだった

#797 は `orbitAudioDaemonPids()` の唯一の使用を「`:5391` の **#779 sweep** テスト」と書いたが**誤り**:

- `:5391` / `:5399` は **`#606 E2E-K3`**（`tests/e2e/orbitstudio-mcp-gated.spec.ts:5385`）の内側
- #779 の sweep テストは `:5446` から始まり、**この関数を呼んでいない**

さらに「gated spec に台数のアサーションは無い」も不正確で、`:5399-5404` に
`expect(startedDaemonPids).toHaveLength(1)` が**在る**。ただしこれは
「**このテスト自身の start が増やした daemon がちょうど 1 台**」という**差分**の主張で、
PR-E8 の狙い「**各 phase 境界で daemon が高々 1 台**」（総数）ではない。
**結論（E2E-10 が偽緑になりうる）は変わらない**ので、根拠だけ差し替えた。

🔴 **教訓**: #797 が残した「**『無い』は探索範囲とセットでしか成り立たない**」の隣に、
**「唯一の使用箇所」は行番号ではなくテスト名で書く**を並べた。行番号だけなら、
それがどの `it(` の内側かを確かめずに書ける — 実際そうなっていた。

#### 3. 追従不要と判断したもの

- **用語 `段 N` → `ステージ N`**: 残っている `段` は `make-local-release.sh` の手順（656）と
  daemon `run()` の `段 0.5`（`sites/dev/rust-engine/`）だけで、#797 が**意図して残した**ものと一致
- **dev サイト en**: `sites/dev/en/editor/vscode-architecture.md:102` は元から `stage 1` と書いており、
  ja 側の rename に対する en の追従は**既に済んでいた**（片翼になっていない）
- **DSL / MCP / OrbitStudio の各層**: #797 は `packages/` `rust/` を 1 行も触っていないので、
  `docs/specs-v2/` `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` `sites/user/` に追従先は無い

### docs(planning): rename 段 to ステージ and stop treating the remainder as a checklist (Sep 7, 2026)

**ブランチ**: `796-correct-remainder-table`（main 直行・docs のみ）

#### owner の指示（引用）

> 段と言うのをちょっとやめたいので**ステージ**と呼びますが、**ステージ０、１を完璧を目指して
> ずるずるとやると機能実装に進まない**ので、ステージ２との関連を考えてステージ２と今の
> 残っているものをどう進めるのかを見直してみてください。

#### 1. 用語 — 「段 N」→「ステージ N」（201 箇所）

計画 / 地図 / USER_OUTCOMES / 設計 668・649・656・739 / dev サイト 3 章。

🔴 **機能内の手順を表す「段」は残した**: 668 §7.2「分割の順序」・§12 の起動 3 段・
656 の署名手順 12 段・地図の機能別テーブルの `| 段 |`・「フェーダーという段は作らない」
（#649 の主題そのもの）。**同じ字で別の意味なので、数字付きを機械置換したあと 1 件ずつ文脈を見た。**

🔴 **その見直しで、機械置換が 16 箇所を誤爆していたのを見つけて戻した。**
`段 N` という**形は同じでもステージではない**もの:

| 誤爆 | 実際の意味 |
|---|---|
| `656:§4.2 段 3` / `段 10` / `段 1-3`（11 箇所） | `make-local-release.sh` の**手順**（§4.2 は「段の並び」= 12 手順）と §5.3 の**署名の実測手順** |
| `sites/dev/rust-engine/index.md` の `段 0.5`（3 箇所）/ `oop-children.md`（2 箇所） | daemon の **`run()` の起動手順**（孤児 shm 回収の置き場） |

判定は**置換後の数字の範囲**で機械化した: プロジェクトのステージは **0〜8** しか無いので、
`ステージ 10` や `ステージ 0.5` が出たら誤爆と分かる。残す判断も 1 件ずつ文脈を見て確定した
（656 の 13 箇所のうち **2 箇所だけ**が本当に `IMPLEMENTATION_PLAN` のステージ 8 を指していた）。

**教訓**: 用語の一括置換は、**同じ字の別用法を巻き込む**。数字付きに絞っても足りない —
**置換後に値域で検算する**手を持つと、目視より確実に落とせる。

WORK_LOG の過去エントリと archive は**書き換えていない**（記録なので）。

#### 2. 🔴 残余を「全部やる」対象から外した — 引き込み条件を置く

> **そのステージの受け入れ基準が依存しているものだけを、そのステージの PR の中で直す。**
> 依存していないものは backlog に置き、**どのステージの完了条件にもしない。**

**なぜ安全か**: 未カバー語はラチェット（`dsl-e2e-coverage.spec.ts`）が**増加を止めている**。
**債務の上限は既に機械が押さえており、返済速度を急ぐ理由が無い。**
「残っている＝危険」ではなく「残っている＋**上限が無い**＝危険」で、後者は潰してある。

#### 3. 結合を測った結果 — 2 件だけ本当に結合していた

| 残り | 結合 | 根拠 |
|---|---|---|
| **PR-E8 の狭いスライス** | 🔴 **結合** | ステージ 2 の受け入れ基準 **E2E-10 が daemon respawn**（doc 611 §10）。#624 は「旧 daemon が残ると**両方がデバイスへ出力し capture には片方しか写らない**」。gated spec に台数のアサーションは無い（`orbitAudioDaemonPids()` の使用は `:5391` の #779 sweep だけ）→ **E2E-10 が偽緑になりうる** |
| **#773** | 🔴 **結合** | **PR-O4 が `//#evalBegin` / `//#evalEnd` を導入**（`extension.ts:3000-3033`）。#773 が落とすのは `{"evalMark"` を含む封筒 → **ステージ 2 は壊れているチャネルの通信量を増やす** |
| #777 / PR-E5 / E6・E7 / E9 / E16 | ⚪ 無関係 | E2E-0〜11 に一度も現れない。36 語も `pan` / `mute` / `loop` / `midi` 等で、ステージ 2 が触るのは `output` / `send` / `thru:` / `db:` / `outs:`。`pan` のライン要素化は doc 611 §2.4b が**別 PR**と明記 |

**束 E-router を割った。** #773 はステージ 2 へ引き込み、#777 は backlog へ。
🔴 **これでも #757 の順序制約は保たれる**（#757 はこの先。着手時に #777 と畳めばよい）。

#### 反映先

- 計画 §3「安全網の残余」— チェックリスト → **引き込み条件 + 結合の測定結果 + 進め方の表**
- 計画 §3 ステージ 2 — 「残余は着手条件ではない」に **2 件だけ引き込む**旨を追記
- 地図 §6.2 #624 行 — 狭いスライスをステージ 2 に引き込む旨（**issue 全体は backlog**）
- 設計 668 §13.5.4 — 「並行可」は**まだ全部やる前提**だったので、方針変更の注記を追加

#### 検証

- `npm run docs:check`: 984 citations verified / 0 failed
- `tests/docs/`: 2 passed

---

### docs(planning): correct the safety-net remainder table (Sep 7, 2026)

**ブランチ**: `796-correct-remainder-table`（main 直行・docs のみ・Closes #796）

owner の「段 2 に着手するにあたって、並行でやる束もあるんだっけ？」に答えるため
**表を実物で読み直したところ、前日の PR #794 で自分が書いた行が 1 つ間違っていた。**

#### 🔴 誤りの中身

| 行 | #794 の記載 | 実際 |
|---|---|---|
| **PR-E4** | 「**部分**。正本 `dsl-surface.ts` が無い」 | ✅ **完了している。** 正本は `packages/engine/src/parser/dsl-surface.ts`（`DSL_SYNTAX_SURFACE` 13 件）で、ラチェットが `dsl-e2e-coverage.spec.ts:36` で import している。#668 のクローズコメントも PR-E4 を ✅（PR #715）と記録 |

原因は **`tests/e2e/` の下だけを探して `packages/engine/src/parser/` を見ていなかった**こと。
「成果物の実在で確認した」と表に書いておきながら、**探索範囲が狭くて不在と誤判定した。**

🔴 **教訓**: **「無い」は探索範囲とセットでしか成り立たない。** 不在を記録するときは
**どこを探したか**まで書く。書いてあれば、次の人はその範囲の外を疑える。
表の冒頭にこの注意書きを残した。

#### 精度が上がった行

| 行 | 旧 | 新 |
|---|---|---|
| **PR-E6 / E7** | ❓ 未確認 | ❌ **未カバー 36 語**（ラチェットの baseline が自認）: sequence 16 / global 7 / **syntax 13 件中 13 件** |
| **PR-E5** | ❌（`tests/docs/` を見た） | ❌（**リポジトリ全体を `find` で走査**）。加えて `dsl-e2e-coverage.spec.ts:219-222` が「A-10 は PR-E5 に割り当てられているが分割の隙間に落ちるのでここで塞ぐ」と明記しており、**ラチェット側も未存在を前提に書かれている** |
| **PR-E8** | ❓ `daemon-census.ts` は無い | ❌ **目的は未達だが部品は在る**。`orbitAudioDaemonPids()`（`:348-361`）は在るが使用は **1 箇所**（`:5391` の #779 sweep が起動前スナップショットに使う）。「各 phase 境界で daemon が高々 1 台」のアサーションは無い |

構文表面が 13/13 全部未カバーなのは、**正本を作る PR-E4 と埋める PR-E6/E7 が別作業**だからで矛盾ではない。

#### 段 2 と並行してよいもの（owner への回答）

- **束 E-router**（`777-line-router`・PR-E12・#777 → #773）— 🔴 **#757 の直前**。これが**唯一の順序制約**
- 束 **E-noise**（`775-capture-clock`・PR-E11・#775）— 🔴 **先に払わない**。段 2 の実機で U2 を観測してから
- 単発: **PR-E5**（#668-C）/ **PR-E9**（#640-A）/ **PR-E16**（#684）/ **PR-E6・E7**（#650 / #630 / #668-B）

#### 検証

- `npm run docs:check`: 984 citations verified / 0 failed
- `tests/docs/`: 2 passed

---

### docs(planning): record stage 0/1 completion and reshape the safety-net remainder (Sep 7, 2026)

**ブランチ**: `793-record-stage-state`（main 直行・docs のみ・Closes #793）

束 E-gate（PR #789・merge `900d4532`）が main へ入り段 1 も完了したので、**この時点の実状態を
地図・計画・設計へ反映**した。新しいセッションが引き継げるようにするのが目的。

#### 🔴 owner の指摘が起点

> 仕様とか PR の内容とか、いろいろ残して進めてきているので、**表面だけを見ずにきちっと
> エビデンスベースや議論の事実ベースで決めなきゃいけないこと**があるとかっていうのはこちらに聞いてください。

この指摘を受けて `/goal` の申し送りを鵜呑みにせず**一次ソースを読み直した**ところ、
**記録と実物のずれが 7 件**見つかった（直下の表の行数）。

#### 反映した内容

| 対象 | ずれ | 実際 |
|---|---|---|
| 計画 §3 段 1 | 「5 件」（#649/#645/#661/#606/**#385**） | owner が 2026-09-05 に **3 件へ限定**（#385 は「触らない」）。**段 1 は完了** |
| 計画 §3 段 0 | 閉じる条件に E-router と PR-E 群が残る | **目的（退行を機械で検出できる）は達成**（実機 29/30・新しい失敗ゼロ）。残りは **「安全網の残余」として段 2 と並行の別枠**へ（owner 裁定 2026-09-07） |
| 計画 §3 段 2 | 「着手条件」「#649 の改訂は裁定待ち」 | **着手条件は満たされた**。**#649 §7.3 / §10.1 の改訂は 2026-09-03 に済んでいる**（正本は doc 611） |
| 地図 §6.2 の #649 行 | 「spec 本文への反映はまだ」 | **反映済み**。残るのは core spec MX.3（`send` の線形 → dB）だけ |
| 地図 #779 / #780 の行 | #780 の原因が「move で保証されない」 | **その原因記述は誤り**。実際は `line!()` の定数展開によるパス衝突。対照実験が決め手 |
| 地図 | **#785 の行が無い** | 束 E-gate で新設した issue。追加した |
| 計画 §1.10 | **PR 番号が重複**（E10 / E11 / E12 が 2 回ずつ） | 後発 3 行を **E15 / E16 / E17** へ振り直した。「PR-E11 は済んだか」に**一意に答えられない**状態だった |

#### 🔴 同じ欠陥が設計文書 5 本にあった（見出しと本文の食い違い）

「§7.3 / §10.1 は裁定待ち」を 4 セッション延命させた原因を追ったところ、**doc 611 §14 の見出しが
`🔴 owner 裁定待ち` のままで、節末は「8 件すべて解消」と書いていた**。見出しだけを見る読み手には
未決に見える。同じ形を全設計文書で探したら **5 本**あった:

| 文書 | 節 | 実際 |
|---|---|---|
| `598-render-endpoint-design.md` | §16 | 9 件すべて ✅（2026-09-03） |
| `610-diagnostics-applicability-design.md` | §15 | 8 件すべて ✅ |
| `611-output-line-design.md` | §14 | 8 件すべて ✅・PR-O4 は着手可能 |
| `662-performance-and-visibility-design.md` | §17 | 6 件すべて ✅（回答ブロックが直下にある） |
| `694-session-log-editor-path-design.md` | §13 | 9 件すべて ✅ |

見出しを `✅ owner 裁定（… N 件すべて解消）` に直し、**なぜ食い違ったか**を各節に 1 ブロック残した。

🔴 **残る 6 本（#428 / #634 / #656 / #668 / #672 / #679）は本当に未決なので触っていない。**
一件ずつ表の行を読んで判定した（`✅` の付いた行数と本文の回答ブロックの両方を見る）。
**機械的に一括置換していたら、生きている裁定待ちを消していた。**

**教訓**: 節の状態は**見出しに出す**。本文だけを更新すると、目次と見出しが古い状態を配り続ける。

#### 段 0 の残り（成果物の実在で確認した）

| 項目 | 状態 |
|---|---|
| PR-E1 / E2 / E3 / E17 / #779 / #780 / #785 | ✅ 実在（E17 = 二重台帳。旧 E12 を改番）|
| **PR-E4** | **部分**（ラチェットは在るが正本 `dsl-surface.ts` が無い） |
| **PR-E5 / E9 / E16(root skip)** | ❌ 成果物が無い |
| PR-E6 / E7 / E8 | ❓ 未確認 |
| **束 E-router**（#777 / #773） | ❌ OPEN。🔴 **#757 の直前** |
| 束 E-noise（#775） | 段 0 から既に除外済み。**段 2 の実機で要否判断** |

**#543 / #650 / #630 / #624 / #640 / #684 が OPEN のままなのはこの残余のため。**
計画は「該当項目」と書いており、issue 全体が段 0 の対象だったわけではない。

#### 🔴 #385 は所属未定（owner 2026-09-07: 「今後決める」）

段 1 から外れたが、どの段で扱うかは未記載のまま。`must-fix` ラベルは維持（**演奏は壊れないが
利用者が機能に到達できない**種類）。

内容は **VS Code の Workspace Trust** の話で、macOS の署名や dylib とは無関係。
フォルダなしの単一ファイル起動（ライブコーディングの典型動線）だと未信頼 workspace が作られ、
**orbitscore 拡張も Claude Code 拡張も activation されない**（silent）。

⚠️ **本文の対策 2 に未検証の主張がある。**「`configurationDefaults` で
`security.workspace.trust.enabled: false` を既定化（**VSCodium 系カスタムの定番手法**）」に**出典が無い**。
同じ段落の前半（`workspaceTrust.ts` の probe）には「根拠:」と明記があるため、
**未検証の主張が検証済みの根拠と並んでいて区別がつかない**。`configurationDefaults` で
セキュリティ設定を上書きできるかも未確認。**本 PR では #385 の本文は触っていない**（記録のみ）。

🔴 **根拠を書くときは、どこまでが裏付けの範囲かも書く。**

#### この日の総括 — 「記録と実物のずれ」が同日 5 件

#780 の原因記述 / `Drop` がサイドカーを消していないという main の報告 / `ORBIT_GATED_ONLY` の位置づけ /
sweep の診断が `DaemonStartupError` で観測できるという主張 / #385 の「定番手法」。

**いずれも読んで筋が通るので誰も疑わなかった。** 確かめるコストは毎回極めて低かった
（`grep` 1 回・`sed -n` 1 回・対照実験 5 分）。文書は書いた時点では正しくても、
**コードが動けば黙って古くなる**。

#### 検証

`npm run docs:check` / `tests/docs`

### fix(test): close the review findings on the E-gate bundle (Sep 7, 2026)

**ブランチ**: `780-merge-gate`（束 PR [#789](https://github.com/signalcompose/orbitscore/pull/789) の
レビュー指摘。統合ブランチの先頭に積む）

レビュアー 4 名 + Fable 監査の結果。**Critical 0 / Important 4 / Minor 9**。
指摘単位のローカルパッチを避けるため、**修正の前にポリシーを 4 本決めてから**一括適用した。

#### 🔴 Important 4 件のうち 3 件は「差分に無いもの」だった

code-reviewer と comment-analyzer は Critical 0 / Important 0。彼らが見る層（差分に**在る**ものの
正しさ）には問題が無く、**差分に無いもの**（ラッパー越しの 2 箇所・走らない回帰テスト・届かない
診断）は別系統の目でなければ見えなかった。CLAUDE.md の「Sonnet チームと Fable は発見クラスが
直交する」がそのまま出た形。

| 指摘 | 出どころ | 処理 |
|---|---|---|
| 窓由来カウントの厳密等価が **2 箇所残る**（`:2603` / `:2692`）。`countAttachFailures` という**ローカル arrow ラッパー**越しなので **3 本のラチェットすべてが構造的に見えない** | Fable | **ポリシー 1**（下記）。2 箇所を移行し、束の主張を「4 箇所」→「**6 箇所**」に訂正 |
| 🔴 **回帰テストがどの自動経路でも走らない** | pr-test-analyzer | CLAUDE.md のマージ前ゲートに `--ignored` 無しの行を追加 |
| `probe_pid_liveness` の `Unknown` 分岐が無防備 | pr-test-analyzer | `pid=0` / `pid=u32::MAX` のテストを追加（実プロセス不要なので **ubuntu CI でも走る**） |
| sweep の診断が**起動成功時に構造的に到達不能** | silent-failure-hunter | **ポリシー 2**（下記）。提案された修正は却下 |

##### 回帰テストが走らなかった件（実測）

```
$ cargo test ... -p orbit-effect-rack-child --lib -- --ignored actual_fixtures_use_distinct_shm_paths
running 0 tests ... 19 filtered out          ← CLAUDE.md がゲートに指定したコマンド
$ cargo test ... -p orbit-effect-rack-child --lib actual_fixtures_use_distinct_shm_paths
test ... ok. 1 passed                        ← --ignored を外すと走る
```

`-- --ignored` は **`#[ignore]` を付けたテストしか実行しない**。#780 の回帰テストは実プラグイン
不要なので意図的に `#[ignore]` していない。したがって **CI（ubuntu なので `#[cfg(macos)]` は
存在しない）でもゲートでも二度と走らない**状態だった。`--include-ignored` はリポジトリで
1 箇所も使われていない（grep 実測）。**束自身の測定器が繋がっていなかった。**

#### ポリシー 1 — 「窓由来カウント」は**形**ではなく**出どころの連鎖**で閉じる

検出器はこれまで**値の形**を列挙してきた（名前 → `Before` の算術 → `.match().length` →
import した helper）。**ローカルラッパーは「次の形」**であり、1 つずつ足す限り必ず次が漏れる。

そこで形の列挙をやめ、**「log 由来の文字列を受けて件数を返す関数」を一般に解決**する
（`resolveLogCountHelperNames`）。関数宣言・arrow const のうち本体が第 1 引数に対する count 式で
あるものを helper として登録し、🔴 **集合が増えなくなるまで反復する**（ラッパーがラッパーを
包む場合に届くため）。

🔴 **私自身の列挙も一段手前で止まっていた。** 設計の「3 箇所」を疑って全列挙し 4 箇所を見つけたが、
その走査は `.match(` を手がかりにしていたので**ラッパー越しは最初から視野の外**だった。
「列挙を尽くした」と思ったときこそ、**何を手がかりに列挙したか**を疑う必要がある。

#### ポリシー 2 — 可観測性は「主張しない」。事実だけ書く

🔴 **silent-failure-hunter の提案（sweep を ready 行の後ろへ動かす）は採らなかった。**
`engine_wrap.rs:4797` が **engine 起動中に** master effect の shm を作る（ready 行より前）ので、
後ろへ動かすと自 PID 規則が**この daemon 自身の生きた shm を削除**する — この束が直したばかりの
SIGBUS のクラスを再導入する。レビュアーは TS 側と `main.rs` は読んだが `engine_wrap.rs` の
shm 生成までは辿っていなかった。**層をまたぐ契約は main が両層を読んで裁定する。**

指摘そのものは有効なので、届くようにする代わりに:

- E2E のコメントを**事実に訂正**（「起動失敗時には `DaemonStartupError` の診断として観測できる」は
  **偽**。`.stderr` を読む箇所はリポジトリに存在しない）
- 呼び出し順序の前提を doc に明文化（動かすと自分の shm を消す）
- 個別失敗に `tracing::debug!` で path と元 error を残す（既定の `info` では出ない）

#### ポリシー 3 / 4

行番号引用の off-by-one を 4 箇所で訂正（`:1396`→`:1397` 等）。`IMPLEMENTATION_PLAN` の PR-E13 行を
実態（6 箇所・provenance 検出器の新設）へ更新。ラチェットが**黙って空振り**する条件
（`engine-log` のファイル名変更）に赤を置いた。

#### 検証（main が実測）

| 項目 | 結果 |
|---|---|
| `gated-assertion-hygiene.spec.ts` | **29 passed**（25 → +4） |
| `tests/e2e/` 全体 | **106 passed / 37 skipped**（100 → +6） |
| daemon 両 feature | **275 passed / 0 failed**（274 → +1）・sweep のテストは **7 本** |
| `rack-child --lib`（`--ignored` 無し） | **16 passed**＝回帰テストが走るようになった |
| clippy **5 象限** | 4 象限 + `clap-host` すべて exit 0 |
| `typecheck:e2e` / `fmt` / `docs:check` | exit 0 / exit 0 / **978 verified 0 failed** |
| 🔴 **変異**（ラッパー越しの形を復活） | **赤・該当行を名指し**（`:2610`）→ 復元で 29 passed |

#### fix 差分の再点検（新しい故障モードは何か / どの実行コンテキストで走るか）

検出器の一般化は**より多く検出する**方向なのでリスクは偽陽性だが、最終判定は
`isLogDerivedText`（`get_log` 由来か）と AND されるため、引数が log 由来でなければ違反にならない
（陰性 corpus が境界を押さえている）。新コードの実行文脈は、検出器 = `npm test` 毎回、
`tracing::debug!` = daemon 起動時のみで既定フィルタでは出ない、`probe_pid_liveness` の 2 テスト =
実プロセス不要なので ubuntu CI でも走る、移行した 2 箇所 = 実機 gated のみ。


### refactor(test): apply the /simplify pass to the E-gate bundle (Sep 7, 2026)

**ブランチ**: `780-merge-gate`（束 PR [#789](https://github.com/signalcompose/orbitscore/pull/789) の
レビュー指摘。束運用どおり**統合ブランチの先頭に積む**）

`/simplify` の 4 観点（reuse / simplification / efficiency / altitude）を並行実行した結果。

#### 適用したもの

| 指摘 | 出どころ | 対処 |
|---|---|---|
| AST の走査骨格が **3 本目のコピー**（`sourceEntries` を回す → `createSourceFile` → 再帰 `visit` → `formattedNodeLine`） | reuse と simplification が**独立に一致** | `scanGatedSources(entries, makeOffenderAt)` を抽出し 3 本すべてを移行。`makeOffenderAt` はファイルごとに 1 回呼ばれるので、provenance 検出器の 2 パス前処理はそのクロージャに収まる。`createSourceFile` のエラー寛容性についての load-bearing なコメントも共有側へ移した |
| 🔴 **`countErrors` の別名で両方の検出器をすり抜ける** | altitude | provenance 検出器が `helpers/engine-log` からの import の**局所名**を解決し、`countErrors(<log 由来>)` / `countLogMarker(<log 由来>, ...)` も「件数」として追うようにした |

🔴 **altitude の指摘が的確だった**: 1 本目は `countErrors` を**リテラルな名前**で特別扱いしているだけなので、
`import { countErrors as ce }` にすると**どちらの検出器からも消える**。つまり 2 本目を作った目的
（名前依存の脆さの解消）が、1 本目の特例として**同じ脆さのまま残っていた**。

#### スキップしたもの（理由つき）

| 指摘 | 理由 |
|---|---|
| `newLogLines(...).filter(...)` を helper に畳む（simplification） | reuse が「確立済みイディオム」と判定して対立したので事実で裁定した。gated spec に **18 箇所**あり、新しい 4 箇所だけ畳むと**同じことを表す書き方が 2 つ並存**する。18 箇所すべての移行は束の範囲外（実機 15 分の回し直しも要る） |
| `sweep_dir` で `metadata()` を生存判定の後ろへ動かす（efficiency） | 正しい指摘だが利得が小さい。節約できるのは**生存 PID の orbit ファイル**の `lstat` だけで、定常状態は約 25 件、backlog の場合はほぼ全部 Dead なので `metadata()` は結局必要。検証済みの sweep とその分岐表テストを触る対価に見合わない |
| `create_shared` を `create_new(true)` にする（altitude Q1） | 筋は通るが **production の音声インフラの挙動変更**で、PID 再利用で同名の残骸があると**起動が失敗する**新しい経路を作る（sweep は 2 秒未満のファイルを残すので残骸が必ず消えている保証はない）。**別 issue に切った** |

#### altitude Q2 は設計の裏付けになった

「起動時 sweep は #448（SIGTERM ハンドラ）が入っても不要にならないバックストップか」への回答は
**Yes**。SIGKILL / OOM kill / panic-in-panic では、ハンドラを足しても `Drop` は走らない。
分割は妥当と独立に確認された。

#### 検証

| 項目 | 結果 |
|---|---|
| `gated-assertion-hygiene.spec.ts` | **25 passed**（corpus に陽性 1 + 陰性 1 を追加） |
| `tests/e2e/` 全体 | 100 passed / 37 skipped |
| `npm run typecheck:e2e` | exit 0 |
| 🔴 変異 1（helper 追跡を外す） | **新しい corpus が赤** |
| 🔴 変異 2（gated spec の 1 箇所を件数比較へ戻す） | **ラチェットが赤・該当行を名指し**（`:1643`） |


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
- [2026-09（前半・09-01〜09-06）](../archive/WORK_LOG_2026-09.md)
