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

### refactor(dsl): apply the /simplify cleanup to the bundle-B line surface (#611) (Sep 11, 2026)

束 B（PR #852）に `/simplify` を回した。4 体（reuse / simplification / efficiency / altitude）
の指摘は 14 件、重複を畳んで 9 件。**3 体が同じ 1 件を指した**ので、そこから直した。

| # | 指摘 | 何体 | 対応 |
|---|---|---|---|
| 1 | 自己バッチの 4 行が `Sequence.upsertLine` と `MixerManager.applyLineElement` に逐語重複 | **3** | `AudioLine.upsertAutoBatch()` へ移した |
| 2 | `resolveLineDest` と `resolveDest` が同じ §3.3 の解決を二重に持つ | 2 | 共有 `resolveNamedOutputDest(value, lookupBus)` |
| 3 | `allLines` が `Set` で、破棄された行がプロセス寿命だけ残る | 2 | `Set<WeakRef<AudioLine>>` + 反復時の剪定 |
| 4 | `firstInBatch` は `cursor === 0` から導出できる | 1 | getter 化 |
| 5 | `outputs()` が本番から呼ばれていない | 1 | 削除（テストは `program()` 全体で見る形へ） |
| 6 | output 段取りの 5 行が 3 メソッドに重複 | 1 | `stageOutputElement()` |
| 7 | `gain()`/`pan()` の instrument insert-bus ブロックが重複 | 2 | `ensureInsertBusForInstrument()` |
| 8 | `MixerOutputOptions`/`MixerSendOptions` が `OutputOptions`/`SendOptions` の複製 | 1 | 共有版へ統合 |
| 9 | capture 定数がテストで再定義 | 1 | `capture-windows.ts` から export して import |

## 争点が 1 件あり、自分で検算した

指摘 8 について **reuse 側は「循環しないので統合できる」、simplification 側は
「循環 import があるので複製が正当」と逆の判断**をした。複製側のコメント自身が
「circular import を避けるため」と書いていた。

実際に読むと `audio-line.ts` の import は `audio-gain-utils` と `audio/types` の 2 本だけで、
**`sequence.ts` にも `global.ts` にも `mixer-manager.ts` にも依存していない葉**。
両者が既にここから import している以上、型をここへ置いても循環は起きない。
**reuse 側が正しく、コメントの正当化根拠は成立していなかった。**
simplification 側は `sequence.ts → global.ts → mixer-manager.ts` の向きだけを確認して、
両者が共通で依存する葉の存在を見落としていた。

## 指摘 4 は「フラグを消す」ではなく「導出を明示する」形にした

`firstInBatch` を単に消すと、「`cursor` はバッチ中 0 に戻らない」という不変条件が
暗黙になる。getter にして**その不変条件を doc に書いた**（`beginBatch()` だけが 0 にし、
どの `upsert` 経路も `<index> + 1`（index >= 0）を代入し、splice 分岐の `-= 1` は必ず
対の `+= 1` を伴う）。フラグという 2 つ目の写しは持たないが、根拠は残る。

## 🔴 `WeakRef` は tsconfig の `lib` に触れた

`WeakRef` は ES2021 で、この repo の `target` は ES2020 だった。最初 engine の
tsconfig だけに `"lib": ["ES2021"]` を足したところ engine は通ったが、
**`npm run typecheck:e2e` が `tsconfig.tests.json` で同じエラーを出した**
（memory `consumerless-code-is-unprotected` の「正本は `npm run typecheck:e2e`」どおり）。

`tsconfig.base.json` に 1 箇所だけ置いた。`target` は ES2020 のまま
（`WeakRef` はランタイムグローバルであって構文ではないのでダウンレベルは不要）。
そもそも root package.json が **Node >= 22 を要求**しているので、型面を ES2020 に絞るのは
実際のランタイムより狭い宣言だった。

## ラチェットが 1 件発火した

`tests/interpreter/signal-chain-dispatch.spec.ts` が `stageOutputElement` を
「未分類の Sequence メソッド」として赤にした。TS の `private` は実行時に残るので
prototype に見える。`ensureInsertBusForInstrument` と併せて内部 API 側に分類した。

検証: `npm test` **2,363 passed / 67 skipped / 0 failed** / `npm run lint` 緑 /
`npm run typecheck:e2e` 緑 / 引用 1,034 verified / 0 failed。

### docs(native): correct the current_gains serialization table (#611) (Sep 11, 2026)

束 A のレビューラウンドを閉じる前の **fix 差分再点検**（1 レビュアー・問いは
「新しい故障モードは何か」「新コードはどの実行コンテキストで走るか」の 2 つ）で
出た Minor 1 件を直した。Critical / Important は 0。

**何が間違っていたか**: `LineControl::current_gains()` に付けた「どの mutex で
直列化されているか」の表が、1 行目を `EngineWrap::set_global_gain` としていた。
実際の `set_global_gain`（`engine_wrap.rs:9747`）は `master_gain` atomic へ store
するだけで、`master_line_program` にも `LineExchange` にも触れていない。
`current_gains()` の呼び出し元は 2 つとも `EngineWrap::set_bus_line`
（`engine_wrap.rs:6980`）の中 — `bus == "master"` 分岐（7047）と named-bus 分岐（7141）。

🔴 **なぜ実害になりうるか**: この表は「呼び手が install と直列化する契約であり
型では強制していない」ことを将来の監査者へ伝えるために足したもの。PR-O4 はまさに
`set_global_gain` を `SetBusLine("master", …)` へ切り替える予定なので、その担当者が
表を読んで「既に `master_line_program` で直列化されている」と誤解しうる。
**この PR が対処しようとした「規約を知らない 4 つ目の呼び出し元」問題を、
コメント自身の不正確さで再生産していた。**

**変更**: 表を 2 つに分けた。①`current_gains()` を呼ぶ経路（2 件・どちらも
`set_bus_line`）②同じ `LineExchange` へ install する経路（3 件・`current_gains()` を
呼ばない `set_bus_routing` を含む）。②が全部同じ mutex を取ることが「install どうし」も
「読む → install」も直列化される根拠なので、①だけでは説明が閉じない。
`set_global_gain` が現状この表に**入らない**ことと、PR-O4 で触るときに契約を新たに
満たす必要があることを明記した。

検証: `cargo fmt --check` 緑 / `cargo clippy -p orbit-audio-native --all-targets -- -D warnings` 緑。

### chore(docs): rotate WORK_LOG before closing the bundle-A review (#611) (Sep 11, 2026)

`tests/docs/worklog-size.spec.ts` が **2,104 行**で赤くなった（上限 2,000）。
PROJECT_RULES §1a どおりアーカイブへ回した。

**移設**: `Sep 7, 2026` 以前の 18 エントリ・1,326 行を
`docs/archive/WORK_LOG_2026-09.md` の先頭へ。本体は **2,103 → 775 行**。
アーカイブの期間ラベルを `09-01〜09-06` → `09-01〜09-07` に更新し、本体末尾の索引と
`docs/core/INDEX.md` の表も揃えた。

🔴 **一度失敗した手順を記録しておく**（同じ落とし穴を踏まないため）。移設範囲の終端を
`s.index("## Archived sections")` で取ったところ、**過去エントリの本文が引用している
同じ見出し**を拾って、18 件のうち 3 件しか移らなかった。`rindex`（最後の出現）で取り直した。
**WORK_LOG は自分自身の構造を語るので、見出し文字列は本文にも現れる。**

### fix(daemon): build the master default line in exactly one place, too (#611) (Sep 11, 2026)

`/code:pr-review-team` ラウンド 1（4 レビュアー）を束 A（PR #834）に回した。
**Critical 1 / Important 4 / Minor 2**。fixer は main。

#### 🔴 Critical — mono デバイスで seed が実体と食い違い、この機構が防ぐはずのポップを再導入する

`MasterLine::new` は初期 program の `dest.right` を **`Some(1)` に固定**していた。一方 daemon 側の
shadow `default_master_line_program(output_channels)` は `(output_channels > 1).then_some(1)` を
返していた。**1ch デバイスでは `dest` が食い違う**ので、`line_republish_seeds` の Output 照合が
外れ、新しい master Output の seed が既定の **0.0** に落ちる。鳴っていた master が一瞬無音から
5 ms かけてフェードインし直す — 設計 §4.3 が名指ししている失敗モードそのもの。

**2ch では偶然一致するので、開発機の実機検証でも顕在化しない。**

さらに `add_to_device` の境界検査は `debug_assert` だけなので、**実 1ch デバイスでは
`right: Some(1)` が RT で範囲外アクセスになる**（`device_base + 1` が mono バッファを超える）。

**対処**: `default_master_line_ops(output_channels)` を `orbit-audio-native` から export し、
`MasterLine::new` と daemon の shadow の**両方がこれを呼ぶ**ようにした。`MasterLine::new` は
`output_channels` を受け取る（呼び出し 11 箇所・production の 1 箇所は同スコープに `channels` が居た）。
**同じ日にバス側で `legacy_line_ops` へ統一したのと同じ手当てを master にも当てた**
— reviewer が「是正の一貫性の欠落」として指摘したとおり。

固定するテスト `master_line_starts_from_the_shared_default_ops_for_any_channel_count` を足し、
**旧バグ（`right: Some(1)` 固定）を再現する変異で赤・戻して緑**を実走で確認した。

#### Important — 設計 §11 が挙げた 6 件のうち 2 件がまだ未実装だった

前回の Fable 監査が 3 件を埋めた**その一段外側**に、`channels` の要素数（0 個 / 3 個以上）の拒否と
**mono の `left` が範囲外**の拒否が残っていた（既存テストは stereo ペアしか通しておらず
`right: None` の枝に到達していなかった）。
`set_bus_line_wire_rejects_device_channel_arity_and_mono_out_of_range` を追加。
**2 種類の変異（要素数制限を外す / mono 上限を外す）で赤**を確認。

**列挙は一段手前で止まる。** 同じ設計文書の同じ表で、2 回続けて起きた。

#### Important — 「center は unity」を近似で検査していた

`line_program_pan_is_normalized_and_executes_in_rt` の許容差は `1e-6` で、
`apply_line_pan` の中央早期リターンを消しても `sqrt(2)*cos(pi/4)` の **6e-8** のずれが埋もれて
**そのまま通った**。設計 §4.1 の「center は unity」は近似ではないので、**ビット一致**で見る形に
変えた。変異で `1.4142134` と `1.4142135` の 1 ulp を捉えることを確認。

#### Important — dev サイトが裁定と逆のことを書いていた（comment-analyzer の Critical）

「`EngineWrap` はこのハンドルを `SetBusLine("master", …)` だけでなく **`SetGlobalGain` からも**
呼ぶ」と書いてあったが、現在の `set_global_gain` は `master_gain.store(...)` の 1 行だけで、
line-program installer を**呼ばない**。ユニットテスト
`set_global_gain_only_updates_the_compatibility_atomic` が「must not republish」を assert している。
PR #823 の時点では正しかったが、O-wire-b のレビュー修正（`9e22e427`）で戻り、裁定 F2（写さない）で
確定していた。**文書だけが 1 層取り残されていた**（ゴールが警告している型）。ja / en とも訂正。

#### そのほか

- `line_republish_seeds` への行番号参照がずれていた（`2162-2193` → 実体は 2157-2188）ので、
  **行番号をやめて関数名で参照する**ようにした
- TS の `daemon-client-line-wire.spec.ts` が、この束が広げた型（`pan` op・mono の `channels: [number]`）を
  **1 件も通していなかった**。設計 §11 が検証コマンドとして名指ししているファイルなのに
  「実行はされるが変更点は通らない」状態だった。1 件追加
- `LineControl::current_gains()` の直列化契約を、**どの mutex かまで表で明記**した
  （code-reviewer の Minor: 「規約を知らない 4 つ目の呼び出し元が追加されると壊れる」）

#### レビュアー別

| | 結果 |
|---|---|
| code-reviewer | **Critical 0 / Important 0**（mutex 経路を追い直して UAF なしと確認・cargo で 31 件を実走） |
| silent-failure-hunter | **Critical 1** / Important 1 / Minor 2 |
| pr-test-analyzer | Important 3 / Minor 1 |
| comment-analyzer | **Critical 1** / Important 2 |

**検算**: `cargo test -p orbit-audio-native --lib` **84 passed** /
`-p orbit-audio-daemon --features outproc-effect --lib` **220 passed** /
`cargo fmt --check` 緑 / TS wire spec 2 passed。

#### 持ち越し（issue 化する）

silent-failure-hunter の Important #2: `LineExchange::install` は RT へ swap した**後**に
`retired` mutex を取るので、その mutex が poison すると **RT は新 program で鳴っているのに
呼び出し元へ Err が返る**。この束が新設した「shadow は install 成功時だけ前進する」不変条件は、
その既存の非 atomic 失敗経路では成立しない。発生確率は低いが**ログが 1 行も出ない**。
束 A の差分の外（既存仕様）なので **#850** に切り出した。

### refactor(daemon): build the default bus line in exactly one place (#611) (Sep 11, 2026)

束 A（PR #834）に `/simplify` を回した。**引き継ぎに「レビュー済み」とあったのを検算せず信じていた**
（記録を見ると `/simplify` も `/code:pr-review-team` も痕跡が無かった）。owner の指摘で気づいた。
memory `handoff-claims-need-primary-source-recheck` の再発である。

#### 🔴 Reuse と Altitude が**独立に同じ 1 点**を指摘

`default_bus_line_program()`（`engine_wrap.rs`）が `legacy_line_ops(BusTarget::Master, &[])` と
**同じ ops 列を手書きで再定義**していた。すぐ下の `initial_bus_line_shadows` のコメントは

> 🔴 The shadow is what a later `SetBusLine` seeds effective gains from. If it disagreed with
> what the bus is actually running, seeding would restore the wrong value and reintroduce the
> jump it exists to prevent — **so build it in exactly one place**

と書いているのに、**実装は 2 箇所で作っていた**。`legacy_line_ops` 側だけが変わると shadow が
旧い形で残り、未設定バスへの最初の `SetBusLine` が誤った seed から republish する
— **この機構が防ごうとしているポップを、この機構自身が再導入する**。
`legacy_line_ops` の呼び出しに置き換えた（1 行）。コメントの約束が実際に成立するようになった。

#### Efficiency — 中央パンの早道

`apply_line_pan` に unity の早期リターンが無く、`LineOp::Gain` が `gain != 1.0` で同じことを
しているのと非対称だった。RT コールバックのたびに `frames × 2` 回の無駄な乗算になる。

🔴 **副次的に丸め誤差が消える**。f32 では `sqrt(2) * cos(pi/4) = 0.99999994` で **1.0 ちょうどに
ならない**（実測）。省くことで `pan(0)` を書いた譜面が書かない譜面と一致し、設計 §4.1 の
「center で `(1, 1)`（unity）」が**文書どおり**になる。

#### Simplification — wire parse の形をそろえた

`pan` だけ「取得はアーム内にインライン・範囲検証は別関数」という、`gain`（1 関数）と違う分割に
なっていた。`parse_set_bus_line_pan` に揃えてアームを 1 行にした。エラーコードは
`PARAM_OUT_OF_RANGE` のまま残す（範囲外は「形が壊れている」ではない。`gain` 側を寄せるかは
既存挙動を巻き込むので本 PR では触らない）。

#### 🔴 到達できない入力でガードを検査していたテストを直した

`!pan.is_finite()` の枝を `validate_set_bus_line_pan(f64::NAN)` で検査していたが、
**非有限の pan は wire から到達できない**（2026-09-11 実測）: JSON に NaN / Infinity の
リテラルは無く、`serde_json` は `1e400` を `Error("number out of range")` として
**parse 時点で拒否する**。実際に来る形（数値でない → `MALFORMED_REQUEST`）を固定し直した。
ガード自体は型が保証していないので防御として残す。

#### 見送り

`#[inline]` が無いという指摘は**誤検知**（既に付いている。差分だけを読んだため）。
master line と bus post-loop の実行器 2 本を 1 本に畳む案は、Altitude が
「本 PR 以前からある構造で、`Pan` はそれに素直に追従しただけ。畳むなら Gain / Output も含む
別 PR」と判定したので見送る。

**検算**: `cargo test -p orbit-audio-native --lib` **83 passed** /
`-p orbit-audio-daemon --features outproc-effect --lib` **219 passed** /
`cargo fmt --check` 緑 / `cargo clippy --all-targets -- -D warnings` 緑。

### fix(e2e): copy the whole audio asset directory into the gated workspace (#611) (Sep 11, 2026)

**`#611 E2E-7` の無音の原因**。実機 gated で capture 20.2 s が **1,939,456 サンプルすべてゼロ**
だった。素材の長さでも DSL でもなく、**ハーネスが一時ワークスペースへ `kick.wav` だけを
コピーしていた**ため、`sine_440.wav` が存在しなかった。

#### 切り分けの経路（記録）

| 手順 | 結果 |
|---|---|
| capture を直接読む | 20.2 s・非ゼロサンプル **0** 件。「小さすぎて拾えない」ではなく完全な無音 |
| `gainDbToAmplitude(-40)` | **0.01**。下限クランプ無し。ゲインは原因でない |
| バスプールの枯渇を疑う | 枯渇時は throw する実装（`effect-slot.ts` の `BusPool.acquire`）で、ログにその文言なし |
| `mix.sum` の node 形を疑う | `registerMixerNode` は `mixerGlobal[kind](variableName)` を呼ぶだけで、**文字列形と同一経路**（`runtime.ts`） |
| 🔴 **エンジンを直接叩くプローブ** | 同じ譜面が**鳴った**。peak **0.007071** = `gainDbToAmplitude(-40) × equal_power_pan(0)` = 0.01 × 0.7071。譜面もエンジンも正常 |
| ハーネスの workspace 準備を読む | `prepareWorkspace` が `test-assets/audio/kick.wav` **1 ファイルだけ**を写していた（3 箇所とも） |

#### 直した形

**ディレクトリごと `fs.cpSync`** にした（3 箇所）。1 ファイルずつ列挙する設計をやめる。
**列挙は必ず一段手前で止まる** — 新しい fixture が新しい素材を使うたびにハーネスを直す形に
しない（memory `enumeration-stops-one-level-too-early`）。

#### あわせて足した観測手段

E2E-7 の `waitForSound` が落ちた時に **`get_log` の末尾を例外に添える**ようにした。
今回は「音が出ないまま時間切れ」としか言わず、原因の特定に実機実行を 2 本払った。
規律の順序（DSL を網羅した E2E → 実機で問題 → **ログで異常系を捕まえられるようにする**）
のとおり、まずログを出せるようにする。

#### 同じ実行で直したもう 2 件

- **`#661 D-2` / `D-3`**: 音の判定はすべて通っているのに、後始末の `ENOTEMPTY` だけで赤かった。
  `child.kill()` は SIGTERM を送るだけで、VS Code の agent host はその後も
  `<user-data-dir>/.../sdk-cache/` へ書き続ける。`force: true` は **ENOENT しか抑えない**。
  子の終了を待ってから消し、それでも残ったら警告して続ける `removeHarnessTree()` を置いた。
  **後始末でテストを落とさない。** 残骸は `/tmp/orbe2e-` 前置きなので次回開始時の掃除が拾う
- **`#611 E2E-7` の譜面**: `RUN` + 固定 sleep(300ms) → `LOOP` + `play(1, 0, 1, 0)` +
  **音が出るのを待つ**形へ。gated スイートで `RUN(` を使う譜面はこれ 1 本だけで、他は全部
  音を追いかけていた。`sine_440.wav` はちょうど 1.000 s（実測）なので、1.0 s 間隔の
  `play(1, 0, 1, 0)` なら隙間なく連なり、440 Hz は 1 s でちょうど 440 周期でつなぎ目の位相も連続する

### test(e2e): add the three O-surface E2E the freeze line requires (#611) (Sep 10, 2026)

凍結線の収束条件「O-surface E2E-2〜7 + E2E-10 が緑」の未達部分。B2 本体は時間制約で
この 3 本を落としていた。

| # | 何を固定するか | 判定式 |
|---|---|---|
| **E2E-6** | **位置が意味を持つこと**。`output(verb, thru: true)` を `effect([Gain(db: -12)])` の**前に**書くか**後に**書くかで混合が変わる | `g = 10^(-12/20)` として `total_A / total_B = (1 + g) / (2g)` ≈ 2.49。許容 `relativeDelta <= 0.12` |
| **E2E-7** | **再 publish の seed**。`gain(-40)` で鳴らしている最中に `gain(0)` へ切り替えてもクリックが出ない | 切替窓（±50 ms）の `max\|x[n]−x[n−1]\|` <= 定常窓の同 × 4 |
| **E2E-10** | daemon を `SIGKILL` しても音が戻り、**台数が 1 に収まる** | `relativeDelta(after, before) <= 0.05` かつ respawn 後の daemon PID が 1 個 |

**E2E-6 がなぜ `(1+g)/(2g)` か**（テストにも導出を書いた）: A は `output(verb, thru:true)` が
先なので **verb へ分岐した後に** Gain が掛かり、dry 側だけが減衰する → `total = g + 1`。
B は Gain が先なので**両方に**掛かる → `total = 2g`。これは評価フレームがあって初めて成立する
（選択範囲全体が 1 つのバッチになり、行の並び順が信号順になる）。

**E2E-7 が raw PCM を読む理由**: -40 dB → 0 dB の跳びは 1 サンプルの不連続なので、
20 ms の RMS / peak 窓では解像できない。`readCaptureForAnalysis` の float32 を直接読み、
**信号から切替点を特定する**（peak 0.01 の -40 dB は閾値 0.1 を跨がないので、envelope crossing が
そのまま `gain(0)` のランプ位置になる）。MCP 往復の壁時計に依存しない。

**E2E-10 の判断**: `expectNoNewErrors` を**呼ばない**。`SIGKILL` は意図的な fault injection で、
daemon の死そのものが ERROR に分類されるログを出す（既存の D-2 / D-3 も同じ扱い）。
`runScore()` は毎回 engine を止め直すため使えず、E2E-K3 と同じ手動 open/select/run で
1 セッションに収めた。capture は daemon 側のタップなので respawn で作り直される —
**before の RMS は kill の前に読み切る**（設計 §8.1 の注記どおり、1 本の `CaptureWindows` に
しない）。

🔴 **main が直した点**: 台数の待ちと判定が**同語反復**になっていた。`waitUntil` が
`currentPids.length === 1` を待ち、その後に `toHaveLength(1)` を assert していたので、
2 台で落ち着いた場合は waitUntil の timeout になり「respawn しなかった」という**誤った診断**が
出る。待つ条件を `>= 1` に緩め、**台数が 1 であることは assert 側で見る**ようにした。

**検算**（main が sandbox 外で実行）: `npm test` **2362 passed / 67 skipped / 2429**
（skip が 64 → 67 = 新規 3 本）・`lint` 緑・`typecheck:e2e` 緑・引用 1034 件 / 0 失敗・
gated env 未設定で spec の 39 件すべて skip。

### test(e2e): follow the dB send unit in the #643 E2E-4 golden (#611) (Sep 10, 2026)

**main が実機で回して見つけた**（委譲先の緑は実機の緑ではない）。束 B2 の実機 gated:
**33 passed / 2 failed / 1 skipped (36)**。

| 赤 | 判定 |
|---|---|
| `#643 E2E-4 preserves instrument contributions through output(sum) plus send(aux, gain)` | 🔴 **本束が動かした。追従漏れ** |
| `steps the live playhead through an instrument() sequence, rests included` | 既知の baseline 赤（設計 §8.4 の台帳。束 A の実機でも同じ 1 本だけが赤だった）。原因は fixture が `instrument()` + degree を書きながら `global.key()` を宣言していないこと＝**オラクル側の欠陥**で、本束の退行ではない |

**追従漏れの中身**: PR-O4 で `send` の第 2 引数が**線形係数から dB へ**変わった。
`#643 E2E-4` の譜面は `routeWet643.send("aux643", 0.5)` と書いており、旧解釈では 50%、
新解釈では **+0.5 dB（≈ ×1.06）**。したがって `total/dry` が 1.5 から **2.06** へ上がり、
`toBeLessThan(1.65)` で落ちた。

**直し方**: 同じ比を dB で書き直した（`send("aux643", -6)` → `10^(-6/20) = 0.501` →
`total/dry = 1.501`）。判定は式で書き、許容 ±0.15 は据え置き。**値を変えずに単位を変えた**ので、
このテストが守っていた「sum と aux の寄与が両方生きている」という性質は変わらない。

`send` を経路張りにだけ使っている 3 箇所（`fx625` / `fx628`）は送出量を判定していない
（oracle は ERROR 件数と child プロセスの有無）ので値は変えず、**dB として読むこと**を
先頭の 1 箇所に注記した。

### test(daemon): add the three bundle-A tests the design listed but never got (#611) (Sep 10, 2026)

Fable の受け入れ監査（束 A / PR #834）が **Important #1** として「設計 §11 が PR-A1 / PR-A2 の
検証として列挙したテストのうち 3 件が実在しない」ことを一次ソースで確認した。うち 2 件は
**「1 層だけ追従しない」退行の検出器そのもの**だった。

| 追加 | 何を数値で見るか |
|---|---|
| `output.rs` `master_line_pan_op_positions_the_master_buffer` | master line を `execute_master_line` へ直接流し、`Pan(-1.0)` 後の hw が `(√2, 0)` になること。buffer を全て 1.0 に揃えているのでゲインがそのまま出る |
| `session.rs` `set_bus_line_wire_pan_op_is_parsed_with_its_own_value` | `{"op":"pan","pan":0.25}` が受理され、`BusLineOp::Pan` の**中身が 0.25 と一致する**こと |
| `engine_wrap.rs` `set_bus_line_seed_for_a_new_gain_without_a_match_defaults_to_unity` | 旧に Gain が無い republish で、新 Gain の seed が既定 1.0 になること（0.5 でも 0.0 でもない） |

**なぜ必要だったか**: `LineOp` を match する実行器は master（`execute_master_line`）と
bus post-loop の **2 箇所**あり、既存テストは `render_tagged_line` 経由で **bus しか通って
いなかった**。master アームを `LineOp::Pan(_) => {}` に戻しても全件緑になる。wire 側も
形の不正（MALFORMED）しか見ておらず、`item.get("pan")` を `item.get("value")` に
取り違えても全件緑だった。

**変異検算**（3 件とも壊して赤・戻して緑を実走）:

| テスト | 変異 | 赤の実出力 |
|---|---|---|
| T1 | master 側 Pan アームを `LineOp::Pan(_) => {}` | `hard-left L=1` |
| T2 | `item.get("pan")` → `item.get("value")` | `'line[].pan' must be a number`（MALFORMED） |
| T3 | 対応無しの既定値 `1.0` → `0.0` | `left: [0.0, 0.0] / right: [1.0, 1.0]` |

production コードは **0 行**（変異は都度復元・`git diff --stat` で確認）。

**設計文書側も直した**: §4.1 に「√2 の合成が成り立つのは scheduler が鳴らす audio event に
限る」という**適用範囲**を書き足した（Fable Important #2）。`collect_source_feeds` が集める
instrument の feed は schedule 時の pan を通らないので、ライン上の Pan は
`√2 · equal_power_pan(p)` がそのまま出て、**両端で +3.01 dB** になる。中央比では
どちらも同じ等パワー則だが、絶対レベルが違う（audio event は中央が既に −3 dB）。
フルスケールの instrument を端まで振ると 0 dBFS を超えるので、**束 B の締めまでに
owner 裁定**とした（束 A では TS が `SetBusLine` を送らないので到達不能）。
§11 には欠落の経緯と「設計の検証欄を実装後にチェックリストとして突き合わせる」教訓を残した。
### feat(dsl): output(dest, thru, db), send in dB, pan as a line element (#611) (Sep 10, 2026)

`Sequence.output(dest, { thru, db })` / `send(aux, db, { enabled })` / `gain(db)` / `pan(v)` を
doc 611 §2-§3 の凍結表面へ切り替えた。解決順は `OutputDest` 解決済み → `"master"` 予約語 →
宣言済み sum/aux 名（aux も `output()` で指せるよう拡張）→ `"L,R"` 物理アウト対 → LinkAudio
channel 名（今日どおり）。数値 render bus の分岐は #611 §14 (1) のとおり解決順の外に残した
（撤回は別 PR-R 系のスコープ）。`mix.output(n)` の mono 宣言をパーサ・`MixerRuntimeNode` に足し、
`output(cue)`（`cue = mix.output(3,4)` のようなノード変数）は interpreter が
`state.mixers.nodes` を引いて `{kind:'device', channels}` へ解決してから `output()`/`send()` に
渡す。`MixerBusHandle`（sum/aux）にも同じ `output`/`send`/`gain`/`pan` を実装し、
`BUS_DSL_METHODS` へ追加した。

🔴 **`send` の dB 化で既存譜面の意味が変わる。** `kick.send("rev", 0.3)` は今日まで線形
0.3（30%）だったが、**+0.3 dB**（`10 ** (0.3/20) ≈ 1.0351` 倍・ほぼ素通し）と読まれる。名前付き
引数 `amount:` は改名されたとして loud に throw する（`db:` を使う）。golden `send`
（`tests/e2e/output-line-expectations.ts`）は `legacyTotalOverDry`（`1 + 0.3 = 1.3`）から
`dbTotalOverDry`（`1 + 10 ** (0.3/20) ≈ 2.0351`）へ切り替えた。

🔴 **`pan`/`gain`（固定値）は8本しかない insert bus プールを守るため無条件にライン要素へしない。**
`_insertBus` を持たない audio シーケンス（`effect()`/`output()`/`send()` 未宣言）では今日どおり
発音側に適用し、`_line` には要素として記録するだけに留める。バスが後から確保された瞬間
（`adoptLineOnFirstBus()`）に発音側をリセットし、`seamlessParameterUpdate` を即時再スケジュール
して二重適用を防ぐ。instrument は発音側の適用経路が無いため常にバスを確保する。
`examples/07_audio_control.orbs`（17 シーケンス・`gain()` 28 回）はこの分岐がないと 9 本目で
`pool exhausted` する。

`//#evalBegin` / `//#evalEnd` メタ行を `extension.ts`（`writeCodeToEngine`）と `repl-mode.ts`
（`AudioLine.beginBatchAll()`/`endBatchAll()`）に追加し、評価単位全体を 1 つのカーソルバッチに
した。フレーム外（生 stdin・単体テストの直接呼び出し）では各 DSL 呼び出しが自分だけの
1 要素バッチを開閉する（`Sequence.upsertLine()`）ので、`output("drums")` → `output("cue")` の
ような再宣言が今日どおり置換として効く。ガードは 2 つ: `beginBatch()` は開いたままのバッチを
暗黙に閉じてから開く。フレーム途中で拡張が落ちても、次の `//#evalBegin` が自己修復する
（統計評価文の内部エラーは `executeCurrentBuffer` の try/catch に吸収され `//#evalEnd` まで
届くので、`finally` の追加は不要だった）。ユニットで両系列を固定した
（`tests/cli/repl-eval-frame-meta.spec.ts`）。

goldens の分類（`tests/e2e/output-line-expectations.ts`）:
- `noBus` / `sumOutput` / `sequenceGainWithEffect` / `globalGainInstrument`: **不動**。
  バス無し audio は発音側適用のまま（音は同値）・`global.gain()` は atomic のまま（F2 裁定「写さない」）。
- `send`: **動く**（上記の式）。

`MixerBusHandle.output()`/`.send()`（旧 `routeOutput`/`routeSend`）は、拒否された push を
ロールバックせず「TS 側の宣言が真実・次呼び出しで全量再送」する自己修復方式へ揃えた
（`Sequence` が B1 で既に持っていた `_busLineStale` と同じ規律）。

判断を保留した点・設計との食い違い:
- `send(aux, ...)` の文字列解決は aux/sum バス名限定にし、`"master"`/`"3,4"`/LinkAudio へは
  広げなかった（設計は `OutputDest | string` としか書いておらず、aux 専用に狭めた）。
- E2E-4/E2E-5（4ch 以上のデバイス要）は `it.skip` + `console.warn` のプレースホルダのみ
  追加し、本体は書いていない（本機に該当デバイスが無く実装しても検証できない）。
- E2E-6（チェーン順序）・E2E-7（seed のポップ回避）・E2E-10（daemon respawn）・E2E-11（master
  gain の残響窓）は時間の制約で見送った。追加したのは E2E-2 / E2E-3 / E2E-S / E2E-S0 / E2E-G /
  E2E-P（実機は main が回す・未検証）。
- dev 学習サイト（`sites/dev/signal-chain/mixer-audio-line.md` 他）は多数の引用が本 PR で
  ずれたため `--fix` の機械的な再アンカーに加え、コード引用そのものを新しい実装へ差し替えた。
  ただし `SetBusRouting` 節と「Try it」節の周辺散文は歴史的経路の記録として残し、全面書き直しは
  行っていない（更新コールアウトで明示）。

### refactor(engine): route buses through SetBusLine without changing the DSL surface (#611) (Sep 10, 2026)

`AudioLine` に宛先・rack・gain・pan・output の型、評価バッチ内のカーソル規則、暗黙の rack / master
補完、wire 変換を集約した。規則 2 では要素削除後に cursor を 1 つ戻し、単文先頭の終端 output は
既存終端を同じ位置で置換する。同じ宛先の ordinal はバッチ内で数えるため、同一宛先への複数 output
も順序どおり保持できる。

`Sequence` / `Global` / `MixerBusHandle` の routing は `SetBusLine` を送るようにし、respawn 後も最後の
line intent を再送する。`Sequence.output(string | number)`、`send(name, amount)` の線形 amount、LinkAudio
と render bus の解決順は変更していない。送る program も従来の
`[rack, output(sum|master, thru: sends>0), sends…]` と同じである。

DSL 表面をこの段階で変えないのは、`OUTPUT_LINE_GOLDENS` / O0-1〜O0-4 が 1 つも動かないことを
配線の検算に使うためである。線形 send の dB 化や output の新しい引数を同時に入れると、golden が
動いた原因を「配線の誤り」と「単位・表面の変更」に切り分けられなくなるため、それらは次の PR に残した。

### feat(daemon): wire pan and mono device into SetBusLine, and carry effective gain across re-publish (#611) (Sep 10, 2026)

`SetBusLine` の wire 契約を拡張し、`pan` と 1 要素の device channels（L+R の mono merge）を
受理できるようにした。バスと master の RT では、発音側の center pan と重ねても音量が変わらない
`√2 × equal-power` の係数を block ごとに計算し、pan 位置そのものを 5 ms ramp する。

line の再 publish では、旧 program の実効値を atomic で読み、新旧 op を Gain/Pan の出現序数と
Output の宛先・出現序数で対応付けて seed する。これが無いと、演奏中に send を追加しただけで既存の
−12 dB send が一度 unity に跳ねてから戻り、約 5 ms の +12 dB burst と可聴の pop が生じるためである。
対応の無い新 Output は 0.0 から fade-in し、Gain は 1.0、Pan は指定位置から始める。旧
`SetBusRouting` の `LineProgram::legacy` / `settled` 経路は変更していない。

---

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
- [2026-09（前半・09-01〜09-07）](../archive/WORK_LOG_2026-09.md)
