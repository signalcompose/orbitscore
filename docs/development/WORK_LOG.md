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

### fix(clap-host): stop warning on the normal path for effects without note ports (#860) (Sep 11, 2026)

束 B の最終ゲートで `auto-records and restores all five plugin receiver kinds` が落ちた。

```
AssertionError: default-baseline cycle must add no ERROR: lines
  → expected 10 to be less than or equal to 9

[daemon] WARN orbit_clap_host::controller: [orbit-clap-host] NotePortsExtension なし; port 0 を使用
```

## 正常系で警報が鳴っていた

`query_note_port_index`（`controller.rs:400`）は **すべての CLAP ロードで無条件に**
呼ばれる（`:246`）。**エフェクトが note ポートを持たないのは正常**で、port 0 という
フォールバックも CLAP の慣習どおり機能する。それを `warn!` で報せていた。

## なぜ ERROR 件数に乗るか

拡張は engine の stderr を**全行 `ERROR:` として**出力する（`extension.ts:1453`）。
これは**意図的な設計**で、#756 の記録が理由を書いている:

> `outputChannel.append('ERROR: ' + chunk)` と chunk 単位で前置していた。1 つの chunk に
> 複数行入ると 2 行目以降に `ERROR:` が付かず、gated E2E の ERROR 会計が**構造的に
> 過小カウント**する（= 偽緑）

つまり「実エラーを取りこぼさない」ために全行前置している。**分類側を緩めるのは筋が悪い**
（取りこぼす方向へ戻る）。

🔴 したがって**ノイズは源で止める**。`warn!` → `debug!`。
memory `stderr-is-classified-as-error` は「engine の warn は全部 ERROR 行」を
**4 回目の再発**として記録しているが、これまでの対処はテスト側だった。今回は発生源を直した。

## 失う情報

instrument が note ポートを持たない場合も debug になる。ただし port 0 のフォールバックは
機能するので、これは「動かない」ではなく「既定を使った」の報告であり、debug が妥当。

検証: `cargo fmt --check` 緑 / `cargo clippy -p orbit-clap-host --all-targets -- -D warnings` 緑 /
`cargo test -p orbit-clap-host --lib` **29 passed**。

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

### docs(link-audio): tell the truth about the deleted Link submodule and the unresolved fallback (#502) (Sep 10, 2026)

Fable 受け入れ監査（PR #840）の指摘を適用した。**Important 2 / Minor 4**。

#### 🔴 Important — 消した submodule を案内し続ける build script

`rust/crates/orbit-link-audio/build.rs` は Link のヘッダを
`packages/sc-link-audio/external_libraries/link` に既定で探し、無ければ
`git submodule update --init packages/sc-link-audio/external_libraries/link` を案内していた。
本束は `.gitmodules` と gitlink を消したので、**その案内はもう "no submodule mapping" で失敗する**。

`build.rs` の冒頭コメント自身が「Link submodule は **SC plugin と共有**する」と書いており、
**SC 専用ではなかった**。owner 裁定（`NATIVE_MIGRATION_2026-09.md` §12.5）は
`packages/sc-link-audio` を「**SC 専用なら**同時に削除」としていたので、共有物を消す判断は
明示的にはされていない。

| | |
|---|---|
| 出荷ビルド | **影響なし**。`link-audio` feature は default off |
| 新規クローン | `--features link-audio` が build.rs の panic で落ちる（実測: 新しい worktree に `link/include/ableton/LinkAudio.hpp` が存在しない） |
| 既存クローン | **成功してしまう**。gitlink を消しても git は submodule の作業ディレクトリを消さない。**手元の緑は証拠にならない** |
| CI | 検出不能。`rust-ci.yml` は ubuntu で、`build.rs` は `target_os != macos` で先に panic する |

**対処**: panic 文言を実態（`ORBIT_LINK_DIR` で Link の checkout を指す）に直し、
crate の扱いそのものを **#845** の裁定事項として立てた（main の推奨は crate の退役）。

#### 🔴 Important — リファレンス表が仕様と逆のことを書いていた

`sites/user/reference/methods.md`（ja / en）は LinkAudio 無効時に
「音はハードウェア出力に出て、警告が 1 回出ます」と**事実として断定**していた。
一方 spec §8.1 と `sites/user/midi/link-audio.md` は「設計の意図と実測が食い違っていて未決・
LinkAudio を前提にした演奏はしないこと」と書いている。**同じ束の中で矛盾していた。**
リファレンス側を「未決」に揃えた。

#### Minor

- **行番号での出典が既にずれていた**（`orbitstudio-mcp-gated.spec.ts:5113-5119` → 実際は 5252-5256）。
  main を merge するたびにずれるので、**行番号をやめて文言で参照する**ようにした
  （「A comment is not evidence of implementation behavior」で始まるコメント）。5 箇所
- 仕様の消し残し 3 件: 削除済みディレクトリを理由にフルパス表記を要求していた記述 /
  「Choose output device via command palette」（コマンドは本束で削除・現在は Engine view と MCP）/
  「buffer caching on the SC path」
- `sites/dev` の glossary（ja / en）が `ORBITSCORE_ENGINE` を**現行の環境変数として定義**し、
  `AudioEngineBackend` を「`SuperColliderPlayer` と `RustEnginePlayer` の両方が満たす」と
  書いていた。両方直した
- `sites/dev/**` の散文には同種が **107 行 / 20 ファイル**残っている。引用ブロックは
  付け替え済みで `docs:check` は緑だが散文が現在形。束の外へ切り出した（**#846**）
- 出荷 README の `✅ engine: rust (native)` と `numInputBusChannels` の記述は **#842 で解消済み**

#### 監査が「無し」と確認した主なもの

削除された識別子・設定キー・コマンド ID・MCP ツール名の残存参照（`build.rs` を除き 0）/
型検査を通らない経路（実行時 `require` は実在するモジュールのみ）/ `contributes.commands` 15 件 ⊆
`registerCommand` 18 件 / 旧 `SuperColliderPlayer` の public 面 19 メソッドの突合（Rust に無いのは
master effects・LinkAudio・device の 3 スタブで、いずれも本束が文書化済み）/ `sync-dist.js` の
写像（`rootDir: ./src` / `outDir: ./dist` と整合・read-only 実走で kept 440 / orphans 0）

### fix(engine): make each master effect warn, and stop audioDevice from promising a restart (#502) (Sep 10, 2026)

`/code:pr-review-team` ラウンド 1（4 レビュアー）の指摘を適用した。**Critical 1 / Important 2 /
Minor 1**、fixer は main（Codex は sandbox の EPERM で起動できなかった）。

#### 🔴 Critical — 2 つ目以降のマスターエフェクトが完全に無音で失敗していた

`RustEnginePlayer.addEffect` / `removeEffect` は `warnOnce('masterEffect', ...)` を
**discriminator 無しで**呼んでいた。`warningKey` は discriminator が無いと `kind` そのものを
キーにするので、**1 セッションにつき 1 回しか warn しない**。一方 `EffectsManager` は
`🎛️ Global: compressor(...)` を**無条件に**出す。したがって

```
global.compressor(...)   // warn が出る
global.limiter(...)      // ✅ に見えるログだけ出て、警告は出ない・音も変わらない
```

という普通のマスタリングチェーンで、2 つ目以降が**気づく手段なく落ちる**。
`(操作, effect 種別)` を discriminator にした。文言も「代わりに master バスへ
CLAP / VST3 プラグインを置け」まで言うようにした。

🔴 **既存テストがこの欠陥を固定していた**。`rust-engine-player.spec.ts` の
「master effect は 1 回 warn して no-op」は `expect(fxWarns.length).toBe(1)` で、
**3 種類の操作をして 1 回しか warn しないこと**を期待値にしていた。期待値を反転し、
種類ごと・操作ごとに warn すること（3 回）と、同じ操作の繰り返しは増えないことを固定した。

#### Important — `global.audioDevice()` が嘘の案内をしていた

`RustEnginePlayer.getCurrentOutputDevice()` は常に `undefined` を返すので、この DSL メソッドは
必ず `⚠️ Restart the engine to change audio device` を出して**何もしない**。再起動しても
変わらない。実際の切り替え経路は VS Code 設定 `orbitscore.audioDevice`（エンジンビュー /
MCP の `select_audio_device`）だけで、DSL からは配線されていない。
**行き先を名指しするメッセージ**に置き換えた。

#### Minor — `sync-dist.js` の `exists()` が全エラーを「不在」に畳んでいた

この判定はそのまま `fs.rm` の根拠になる。EACCES 等を不在に畳むと**正当な出力を消して
`.vsix` からモジュールが欠ける**（#654 と同じ形）。ENOENT だけを不在として扱い、
他は投げるようにした。

#### テスト — 出荷物の中身を決めるロジックにテストが 0 本だった

`pruneOrphanedOutputs()`（本束で新設）は `.vsix` に何が載るかを決めるが、
**間違えても npm test もビルドも緑のまま**通る。`sync-dist.js` を
`require.main === module` でガードして `require` 可能にし、
`tests/build/sync-dist-prune.spec.ts` に 7 件足した:
4 種類の接尾辞の削除 / `.tsx` 由来を残す / `.ts` 由来でない成果物に触らない /
空になったディレクトリを畳む / 入れ子を post-order で畳む /
生き残りがあれば親を残す / `sourceStemFor` の境界。

#### そのほか（comment-analyzer）

- `CONTRIBUTING.md` が `ORBITSCORE_ENGINE=sc` opt-out 経路を現在形で説明したままだった。
  README / CLAUDE.md / PROJECT_RULES / INDEX / CONTEXT7_GUIDE / TESTING_GUIDE は直っていて、
  **CONTRIBUTING.md だけ列挙から漏れていた**
- `README.md` と `CLAUDE.md` のテスト件数が 2026-09-02 の `2165 / 2233` のままで、
  本束が spec 7 本を消した後の値になっていなかった。**出典（日付・commit）付きで**
  `2271 passed / 58 skipped / 2329 total` に更新した

#### 指摘のうち採らなかったもの

- code-reviewer: Critical 0 / Important 0（型検査・全テスト・docs ビルド・`sync-dist.js` の
  実走まで確認した上で「配線漏れ無し」）
- pr-test-analyzer の Important 2（`chop-timing.spec.ts` の `sampleId` 未検証は本束が
  持ち込んだ後退ではない / docs:check 198 件は上記のとおり解消済み）

### refactor(build): prune the engine dist by source presence instead of by name (#502) (Sep 10, 2026)

`/simplify`（4 エージェント）の指摘を適用した。

**採用（altitude + efficiency の合流点）**: `packages/engine/scripts/sync-dist.js` の
`removeRetiredBackend()` は `audio/supercollider` / `supercollider-player.*` という
**SC 固有のファイル名を汎用ビルド道具の中に埋め込んでいた**。守りたかったのは
「`tsc --build` の増分は、ソースを消しても出力を消さない」ことであって SC ではない。
**`src` に対応する `.ts`（`.tsx`）が在るかで判定する `pruneOrphanedOutputs()`** に置き換えた。
次に何を消してもこのスクリプトを直す必要がない。1 ディレクトリ内は `Promise.all` で並行に
処理し、空になったディレクトリは畳む。`.ts` 以外から来た成果物には触らない。

旧 root-copy / bundle 経路が `engine/` 直下へ置いた `supercollider/` `scsynth/`
`audio/supercollider` は `tsc` の出力ではないので突き合わせでは拾えない。
**一度きりの移行掃除**として明示的に消す（コメントでそう書いた）。

**採用（消し残し）**: `ORBITSCORE_ENGINE=sc で SC に opt-out` を説明したままのコメントが
3 箇所残っていた（`interpreter-v2.ts` / `cli/repl-mode.ts` / `audio/rust-engine/index.ts`）。
env var も `resolveEngineKind()` も本束で消えているので、**存在しない経路を説明していた**。
`rust-engine-player.ts` の冒頭コメントは機械置換の跡で「既定（唯一の）バックエンド
（唯一のバックエンド）」と二重化していた。あわせて直した。
`packages/vscode-extension/package.json` は `keywords` と `scripts` から要素を消した跡が
空行 5 行として残っていたので削除した。

**見送り（理由を残す）**: `AudioDevice` 型（`audio/types.ts`）は `RustEnginePlayer` の
3 つのスタブ（常に `undefined` / `[]` / no-op）でしか使われておらず、同種の型が
`daemon-client.ts` の `AudioDeviceListEntry` と `mcp-server.ts` の `AudioDeviceInfo` にもある。
3 系統あるのは確かに冗長だが、**削除は `AudioEngine` インターフェースの変更**になり
凍結線の直前に入れる変更ではない。`AudioEngineBackend` の継ぎ目も、ネイティブ
OrbitStudio の新ライン（#827）で第 2 実装が来る見込みなので残す。

**検算**: `npm run build` 緑（`sync-dist.js` を実走）・`npm run lint` 緑・
`npm test` **2271 passed / 58 skipped / 2329**・引用チェック 934 件 / 0 失敗
（行シフト 4 件を `--fix` で再アンカー）。

### docs(spec): the LinkAudio fallback claim was a comment, not a measurement (#502) (Sep 10, 2026)

#833 で §8.1 に置いた警告ブロックは「daemon が `LINK_AUDIO_UNAVAILABLE` を返し、TS 側が
1 回だけ warn して継続する。出力は hardware のみ」と**断定していた**。これは
`rust-engine-player.ts` の `registerLinkAudioChannel` の**コメントの主張**であって、実測ではない。

`tests/e2e/orbitstudio-mcp-gated.spec.ts` に残っている記録によれば、2026-09-04 の main の
実機実行では `global.linkAudio()` 下の sequence の **capture RMS = 0**、かつ `get_log` に
`LINK_AUDIO_UNAVAILABLE` も gap 警告も出ていない。capture ベースの証明はこの理由で
取り下げられている。つまり**音が出ず、警告も出ない**。

仕様側を「設計の意図 / 実測」の 2 行表に書き換え、**どちらが正しいかは未決**であることと
出典を明記した。ユーザー学習サイト（`sites/user/midi/link-audio.md`）は #835 で既にこの
扱いになっており、**仕様だけが古い断定のまま残っていた**（memory
`one-layer-of-the-spec-lags-the-ruling` と同じ型）。

引用 4 件が行シフトで動いたので `--fix` で再アンカーした。

### docs(readme): rewrite the shipped README for the stable GitHub Release (#841) (Sep 10, 2026)

拡張版 stable リリース（#827 §12）の手順 4。`.vsix` に同梱される
`packages/vscode-extension/README.md` と root `README.md` を、**出荷物の実態**に合わせた。

**直した事実誤り 3 件**（いずれも出荷物に対して偽だった）:

| 箇所 | 旧記述 | 実測 |
|---|---|---|
| LinkAudio | 「OrbitScore acts as the Link tempo leader; Ableton Live follows OrbitScore's tempo」 | daemon の feature `link-audio` が default off。`copy-daemon-bin.sh` も `release.yml` も `--features outproc-effect,outproc-instrument` のみ。egress も §8.1.4 の tempo push も同じ feature に依存する |
| Intel Mac | 「Untested (bundled binary is universal but not actively verified)」 | `release.yml` の `VSIX_TARGET: darwin-arm64`。universal ではない。方針も Apple Silicon のみ |
| time-stretch / pitch shift | root README が `.time()` / `.fixpitch()` を Core Features に列挙 | `parser/types.ts:493` に「'time' and 'fixpitch' removed - not yet implemented」。#213 で defer 中 |

**追加**: `global.compressor()` / `limiter()` / `normalizer()` が native engine で no-op であることを
「Not in this build」表に明記した（#502 で唯一の実装だった SC synthdef が消えたため）。

**🔴 LinkAudio の記述を実測に合わせ直した（自分の初稿の誤り）**: 最初「音は hardware へ出る」と
書いたが、これは `rust-engine-player.ts` の**コメントの主張**であって実測ではない。
`tests/e2e/orbitstudio-mcp-gated.spec.ts` の記録によれば、2026-09-04 の実機実行では
`global.linkAudio()` 下の sequence の **capture RMS = 0**、かつ `get_log` に
`LINK_AUDIO_UNAVAILABLE` も gap 警告も出ていない。つまり**音が出ず警告も出ない**。
仕様（§8.1）とどちらが正しいかは未決なので、README には「未決であり LinkAudio を前提にした
演奏はしないこと」と書いた。ユーザー学習サイト（`sites/user/midi/link-audio.md`）は
#835 で既に同じ扱いになっていた。

**AU ホスティングの偽記載を削除**: walkthrough ステップ 4 が ja / en とも
「CLAP / VST3 / AU をホストできます」と書いていたが、`PluginFormat::from_env_value` は
`clap` / `vst3` **以外を Err で弾く**（`outproc_effect.rs:338-346`）。AU の child バイナリも
crate も存在しない。walkthrough の md と `package.json` の step description の両方を直した。
🔴 **walkthrough は `.vsix` に同梱されるので、これは出荷物の偽記載だった。**

**その他の追従**: `✅ engine: rust (native)` ステータスバー表示は #108 以降存在しない
（健全時はインジケータを出さない・`updateBundleStatus`）。コマンド一覧が 5 件しか載っておらず
プラグイン系・walkthrough・MCP 登録が抜けていた。設定一覧が 5 件で `engineDebug` /
`mcpServer.port` / `playheadPalette` が抜けていた。いずれも `package.json` の `contributes` から
実体を引いて書き直した。

**入手経路**: Marketplace / Open VSX には出さない（owner 2026-09-10）ので、
両 README とも **GitHub Release の `.vsix`** を先頭に置いた。

**版番号は据え置き**: 見出しから `(2.0.0)` を外して版に依存しない形にした。実際の版番号更新は
手順 5（owner 裁定）で行う。

### docs(spec): record that the global mastering effects are no-ops after the SC removal (#502) (Sep 10, 2026)

束 #840 を締める前の追従。`INSTRUCTION_ORBITSCORE_DSL.md` の Implementation Status は
`global.compressor()` / `limiter()` / `normalizer()` を **Completed Features ✅** に載せていたが、
実装は **SC の synthdef（`fxCompressor` / `fxLimiter` / `fxNormalizer`）だけ**で、#502 で
scsynth ごと削除した。`RustEnginePlayer.addEffect` は最初から
`⚠️  [rust-engine] master effect "..." is not supported yet (A4 era)` を 1 回 warn して
no-op に倒す実装で、**出荷される `.vsix` にはこの 3 つを実行する経路が無い**。

DSL 語彙（`signal-chain/runtime.ts` の `GLOBAL_DSL_METHODS`）には残っているため
**構文としては受理される**。表面から外すのは破壊的変更なので owner 裁定事項として保留し、
仕様側に警告ブロックを置いた（LinkAudio egress と同じ扱い）。代替は
CLAP / VST3 プラグインのラック（`global.effect(...)`）。

v2.0 の変更履歴側にも「SC と master effects はどちらも #502 で撤去、前者は Rust daemon に
置き換わり後者は代替なく no-op」を追記した。

**検算**: `sites/user/**` の compressor/limiter への言及は 2 件ともプラグイン effect
（`seq.effect()` / `sum("bus").effect()`）の話で、`global.compressor()` ではない。誤記なし。

### docs(readme): drop the deleted SuperCollider paths from the repository tree (#502) (Sep 10, 2026)

束 #840 を締める前の追従。root `README.md` のディレクトリ図が
`packages/engine/src/audio/supercollider/`・`packages/engine/supercollider/`・
`packages/sc-link-audio/` を**現存するものとして**描いていたため、実体に合わせた
（3 経路とも #838 / #836 で削除済み）。`vscode-extension/` が `packages/` の末子に
なったので罫線も直した。

残る `SuperCollider` の語（Phase 7 の完了表・#136 の merged 表・冒頭の「#502 で削除された」）は
**履歴の記述**なので残す。README 全体の書き換えは stable リリースの手順 4 で別途行う。

### refactor(engine): remove the SuperCollider backend implementation and its editor surface (#502) (Sep 10, 2026)

owner 裁定（#827 / #502・`NATIVE_MIGRATION_2026-09.md` §12.5）に従い、SC バックエンドの
TypeScript 実装と拡張の編集表面を削除した（PR-SC3b・PR-SC3a の同梱まわり削除の続き）。

**削除**: `packages/engine/src/audio/supercollider/`（event-scheduler / buffer-manager /
osc-client / scsynth-resolver / synthdef-loader / link-audio-channels / types / index）・
`supercollider-player.ts`・`packages/engine/supercollider/`（synthdef アセット）・未参照の
`test-sc-*.js` スクラッチ9本・孤立 `packages/engine/package-lock.json`・テスト7本
（SC専用5本 + `link-audio-dispatch`/`link-audio-channels`。後ろ2本は `EventScheduler` 等を
直接 import しており import 整理では済まなかった）。

**🔴 `AudioDevice` 型の退避**: エンジン非依存の共有型だったため、ディレクトリ削除前に
`supercollider/types.ts` から `audio/types.ts` へ移した。

**🔴 実行時 require の罠**: `extension.ts` の `resolveScsynthForUI()` は
`require('.../supercollider/scsynth-resolver')` を実行時に呼んでおり、`tsc` の型検査を
通らない経路（戻り値を `as` で型付け）だったためソースを消しても緑のまま実行時に落ちる。
この関数ごと削除した。

**`ORBITSCORE_ENGINE` を完全に撤去**: 選べる第2エンジンが無い以上、1択を選ぶ env var は
死んだ分岐。`EngineKind`/`resolveEngineKind()` を撤去し `createAudioEngine()` は常に
`RustEnginePlayer` を返す。`orbitscore.engine`/`orbitscore.scsynthPath` 設定・
`Force Kill scsynth` コマンド・SC gated だった `Select Audio Device` コマンド・MCP
`force_kill_scsynth` ツールを削除（`restrictedConfigurations` は空配列に）。`extension.ts` の
`getConfiguredEngineKind()` 各種ガードと SC 専用関数群を撤去し Rust 経路のみへ折り畳んだ。

`rust-engine-player.ts:945` 付近のコメントを実態に合わせた（`warnOnce('outputChannel', ...)`
の呼び出しは1箇所のみ — 旧コメントは `scheduleEvent`/`scheduleSliceEvent` も呼ぶと誤記していた）。
`supercolliderjs` devDependency も削除（SC の TS 実装が無くなったため）。

**テスト**: `SuperColliderPlayer` をモックに使っていたテスト16本を `RustEnginePlayer` 基準へ
書き換え（`chop-timing.spec.ts` は実インスタンス化のため `loadBuffer` の mock 戻り値も
実シグネチャ `{ sampleId }` に合わせた）。件数: 2329 passed / 58 skipped / 2387 total →
**2261 passed / 58 skipped / 2319 total**（削除7本ぶん -68 件）。

**残課題だったもの（解消済み・2026-09-10）**: `npm run docs:check` が本 PR の行番号シフト
（`extension.ts` -444 行等）で 198 件失敗していた。束の締めで `--fix` の再アンカーと
引用内容の手直しを行い、**934 件検証 / 0 失敗**になった（`502-sc-removal` の
`b9f6ded1` 時点・main 実測）。

**件数の但し書き**: 上の `2261 passed / 2319 total` は #838 単体を回した時の値。
束を締めた時点（`b9f6ded1`）の実測は **2271 passed / 58 skipped / 2329 total** で、
差の +10 は #839 以降に入ったテスト。README と CLAUDE.md にはこちらの値と出典を書いた。

### docs(sites): follow PR #836 — the scsynth bundle is gone from the shipped .vsix (#502) (Sep 10, 2026)

**追従元**: PR [#836](https://github.com/signalcompose/orbitscore/pull/836)（merge `f2fa0cf`・base `502-sc-removal`）/ **ブランチ**: `claude/docs-sync-pr836`

#836 は同梱・ビルド・ライセンスだけを扱い `sites/` は対象外だったため、dev site に残っていた「scsynth は `.vsix` に同梱される」という**現在形の記述**を ja / en 両方で追従させた。`glossary.md`（`scsynth` と `bundle (scsynth source)` の 2 項。後者は `sync-dist.js` が同期のたびに `engine/scsynth` を消すため当たらない）・`decisions/adr-003-scsynth-bundle.md`（撤去 warning を冒頭に新設・回避策 2「`npm run build:bundle`」の失効・Consequences revisited に「そして bundle は撤去された」節・深掘り候補 4 件を取り消し線）・`editor/vscode-architecture.md`（出荷 `.vsix` には `bundle` 候補パスだけでなく `require` 対象の `scsynth-resolver` モジュール自体が無い）・`audio/audio-file-playback.md`（`libsndfile.dylib` 非同梱）。

`packages/` `rust/` `tests/` は不変（ルーチンの禁止事項）。`verified-against` は据え置き（章全体を再検証していないため・STYLE_GUIDE の更新ポリシー）。

### chore(build): remove the bundled scsynth, its GPL plugin, and the packaging steps (#502) (Sep 10, 2026)

owner 裁定（#827 / #502）に従い、拡張の出荷物から bundled scsynth と GPL の
`OrbitLinkAudio.scx` を外した。現行 release workflow は `v*` タグを契機に Marketplace / Open VSX
へ publish するため、GPL バイナリを含む `.vsix` が stable タグから配布される前に同梱経路を閉じる必要があった。

**削除したもの**: `packages/sc-link-audio/` 全体とその2 submodule 定義、scsynth の LICENSE / NOTICE、
bundle 抽出・検証・OSC boot-timeout patch script。root / extension の build は engine の SynthDef を
コピーせず、engine 自身の `sync-dist.js` にあった同じコピー経路も閉じた。`.vscodeignore` も
scsynth / SynthDef / legal の keep 指定を持たない。PR-SC3b まで source に
残る SC backend の生成済み JS と JS OSC runtime も `.vsix` から除外した。当該 runtime は未削除
source / test の clean build に限って必要なため devDependency へ隔離し、出荷 runtime dependencies
からは削除した（source と test ごとの完全削除は PR-SC3b）。`sync-dist.js` は extension 向けコピー後に
生成済み SC backend を除き、旧 root-copy / bundle が残した ignored artifact も掃除する。

**release gate**: SuperCollider の install / extract / pre-package verify を削除した。post-package gate は
Rust daemon、OOP child、plugin scanner、engine runtime dependencies、標準 CLAP の検証も担うため残し、
scsynth の `verify-bundle.sh` 呼び出しだけを除いた。



---

### docs(sites): follow PR #833 — LinkAudio egress is not in shipped builds (#502) (Sep 10, 2026)

**追従元**: PR [#833](https://github.com/signalcompose/orbitscore/pull/833)（merge commit `58b8c1c`・base `502-sc-removal`）/ **ブランチ**: `claude/docs-sync-pr833`

#833 は spec と guide を直したが、**`sites/` は対象外**（PR 本文で明記）だった。#833 が §8.1 に
書き下ろした「LinkAudio egress は出荷ビルドに入っていない」という事実は、user site / dev site の
どちらにも届いていなかったため、そこを追従させた。

**直したもの**:
- `sites/user(/en)/midi/link-audio.md`: 冒頭に「配布版では Live に音が届かない」警告を追加。
  前提条件から **OrbitLinkAudio.scx**（#502 で削除済み）を落とし、「送出が有効なビルド」に置換。
  「プラグイン内で加算合成」→「送出側で加算合成」。「OrbitLinkAudio.scx プラグインがない場合」節を
  「音声送出が使えないビルドの場合」へ改題。テンポ push も同じ feature に載るため無効である旨を追記
- `sites/user(/en)/reference/methods.md`: `linkAudio()` / `linkAudio(SR)` / `output("name")` に
  🔴 を付け、配布版で送出が動かないことを注記。ja 側の `midiLatency(ms)` の説明にあった
  「SC とのタイミング合わせ」（en には無い）を「オーディオとのタイミング合わせ」へ
- `sites/dev(/en)/rust-engine/index.md`: wire command 表の `RegisterLinkAudioChannel` /
  `SetLinkTempo` 行に feature gate を注記し、「LinkAudio egress は出荷ビルドに入っていない」節を新設
  （`Cargo.toml` の `[features]` と `copy-daemon-bin.sh:109` を逐語引用）。frontmatter の
  `verified-against` を `58b8c1c` へ
- `docs/development/TRANSLATION_STATUS.md`: #833 が足した注記は「`502-sc-sites` で進行中」と
  書いていたが、当該 PR（[#832](https://github.com/signalcompose/orbitscore/pull/832)）は既に
  base へ入っている。着地済みの内訳（audio 2 章は削除・ADR 2 本は残す）へ書き換え、
  dev の表の III-1 / III-3 を `削除済み (#832)` に。章数の集計（`完了 39 章` と `総章数 29 章` が
  矛盾していた）も揃えた

**🔴 仕様と実測の食い違いを見つけた（決めていない・PR 本文に質問として出す）**:
#833 の §8.1 は「egress が無ければ hardware へフォールバックし 1 回 warn する」と書いているが、
`tests/e2e/orbitstudio-mcp-gated.spec.ts` の「**A comment is not evidence of implementation behavior**」で始まるコメントには、2026-09-04 の実機で
**capture RMS = 0・警告マーカーも無し**という逆の実測が記録されており、さらに
「`global.linkAudio()` 下の dispatch は `skip` か `link` で、capture できる `hardware` には
決してならない」とも書かれている。**どちらが正しいかは仕様の判断**なので直さず、
両サイトには「確定していない」と明記して両論を並べた。

**検証**: `npm run docs:build`（user / dev とも成功）・`npm run docs:check` **942 verified / 0 failed**
（追従前は 936）・`npx vitest run --dir tests --globals docs/` 5 passed。


---

### docs: retire the SuperCollider backend from the specs and guides (#502) (Sep 10, 2026)

**Issue**: #502（東 `502-sc-removal` の docs サブタスク `502-sc-docs`）/ **作業ツリー**: `.claude/worktrees/502-sc-docs`

main が `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` §8 で確定した事実に、他の docs の文言を揃えた。

**確定した事実**（main の §8 編集より）:
- **Rust `orbit-audio-daemon` が唯一のバックエンド**。SuperCollider (scsynth) opt-out 経路と
  `ORBITSCORE_ENGINE` 環境変数は #502（2026-09-10）で削除された（cutover #108 で既定化されてから
  約2ヶ月後）
- 🔴 **LinkAudio egress は出荷ビルドで動作しない**。SC 版（`OrbitLinkAudio.scx`）は #502 で削除、
  Rust 版（`orbit-link-audio` crate・GPL 隔離）は daemon の feature `link-audio` が default off の
  ため `scripts/copy-daemon-bin.sh` / `.github/workflows/release.yml` のどちらの出荷ビルドにも
  含まれていない。理由は Ableton Link が GPL-2.0-or-later で、有効化すると GPL が出荷バイナリの
  依存グラフに入り、SC を削除した理由と同じ問題を作るため

**やったこと**:
- `README.md` / `CLAUDE.md` / `docs/core/PROJECT_RULES.md` / `docs/core/INDEX.md` /
  `docs/core/CONTEXT7_GUIDE.md` / `docs/testing/TESTING_GUIDE.md` の現在形の可用性主張
  （「SuperCollider は opt-out backend」等）を実態に合わせて修正。`PROJECT_RULES.md` の
  「SuperCollider Integration Tests」節（削除される `tests/audio/supercollider-gain-pan.spec.ts`
  を名指し）は節ごと落として番号を詰めた
- `docs/research/SCSYNTH_BUNDLE_MANIFEST.md` / `SCSYNTH_STANDALONE.md` / `LINK_AUDIO_API.md`・
  `docs/testing/LINK_AUDIO_E2E_CHECKLIST.md` の冒頭に歴史記録ヘッダを追加（本文は不変）
- `docs/AUDIO_TEST_CHECKLIST.md` / `AUDIO_TEST_SETUP.md` / `docs/testing/PERFORMANCE_TEST.md`
  （cutover #108 以前の SC セットアップ手順で INDEX.md からリンクされていた）・
  `docs/testing/QA_2.0.0.md` / `QA_2.0.0_HUMAN_RUNBOOK.md`（SC 依存の実機手順を含む QA 記録）・
  `docs/user/en(ja)/GETTING_STARTED.md`（SC インストールを前提とする現行リンクのガイド）に
  同様の歴史記録／非推奨の注記を追加。既存の `USER_MANUAL.md` の DEPRECATED 表記はそのまま
- `docs/development/TRANSLATION_STATUS.md` に、`sites/dev/` の SC 関連章の削除・書き換えが
  別 PR（`502-sc-sites`）で進行中であることを明記
- `examples/22_rust_engine_parity.orbs` のコメント（`ORBITSCORE_ENGINE=sc` を使う旧手順）を
  Rust 単独運用に合わせて修正。`.orbs` の実行行は変更していない

**歴史記述は残した**: README の Phase 7 Achievements・ICMC v1.x bundle 節、
`docs/development/POST_2.0_*` / `docs/planning/` / `docs/design/` の移行計画・設計分析
（`NATIVE_MIGRATION_2026-09.md` §12.5 の「#502 実測と順序」を含む）は、現在形の可用性主張ではなく
決定の記録なので変更していない。`docs/specs-v2/IMPLEMENTATION_INSTRUCTIONS.md`（Epic #224 管理下）
と `sites/` は対象外（前者は本タスクの範囲外・後者は別 PR）。

**`docs:check`**: main の §8 編集で行番号がずれた `sites/dev(/en)/signal-chain/mixer-audio-line.md`
の引用 4 件を `node sites/dev/scripts/check-citations.mjs --fix` で再アンカーした。
本 PR 単独では 1032 verified / 0 failed、`502-sc-sites`（#832）を取り込んだ後は 936 verified / 0 failed（章の削除で引用が減ったため）。


---

### docs(sites): drop the SuperCollider chapters and de-anchor ADR citations (#502) (Sep 10, 2026)

**Issue**: #502（束の1本・PR-SC2）/ **ブランチ**: `502-sc-sites`（base `502-sc-removal`）

owner 裁定（2026-09-10・#827 / #502）で SuperCollider (SC) バックエンドをコードごと削除する。
コード削除 PR（PR-SC3a/3b）より先に、学習サイト（`sites/dev/`）が SC のコードを引用している
箇所を外した。`sites/dev/scripts/check-citations.mjs`（`npm run docs:check`）は引用ヘッダ
`// path:line-line` を実コードと文字単位で突合するため、コードが消えた瞬間に red になる。
引用を先に外しておけば、コード削除 PR は docs:check を壊さずに進められる。

**消したもの**: SC 専用の解説ページ2本（ja/en 各対）— `audio/supercollider.md`（旧 III-1）、
`audio/scsynth-bundle.md`（旧 III-3）。sidebar からも該当エントリを削除し、他ページから
これらへのリンク（12箇所）をすべて ADR への参照または地の文に置き換えた。

**残したもの**: ADR-001 / ADR-003（決定の記録）。冒頭に「コードは削除決定/削除済み」の
warning ブロックを追加し、引用ヘッダを `path:start-end` → `path Lstart-end` 形式に変えて
`check-citations.mjs` の検査対象から外した（コード本体は1文字も変更していない）。
`audio/audio-file-playback.md`（旧 III-2）は主題が SC 実装の詳細読解のままだが、他章から
参照され続けているため削除せず、同様に引用を無効化した上で残した。加えて `event-queue.md` /
`glossary.md` / `orientation/architecture-overview.md` / `orientation/what-is-orbitscore.md` /
`editor/vscode-architecture.md` / `index.md` / `STYLE_GUIDE.md` / `sites/user/.translation-glossary.md`
の「SC は opt-out で選べる」という現在形の記述を「削除決定（#502）」の過去形・注記に更新した
（cutover #108 等の歴史記述はそのまま残した）。

**確認**: `npm run docs:check`（936 citation(s) verified, 0 failed）／
`npm -w @orbitscore/dev-site run docs:build`（VitePress ビルド green、dead link 0）／
`npm test`（2329 passed, 58 skipped, 0 failed）。

**やっていないこと**: `packages/` `rust/` `scripts/` `tests/` `.github/` のコード削除は本 PR の
範囲外（PR-SC3a/3b で対応）。本 PR の時点では SC のコードはまだ存在する。

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
- [2026-09（前半・09-01〜09-08）](../archive/WORK_LOG_2026-09.md)
