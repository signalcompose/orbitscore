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

### 6.317 fix(test): CI フレーク #529 の真因（ETXTBSY）を特定し構造的に除去 (Jul 29, 2026)

**Date**: 2026-07-29
**Status**: ✅ 真因特定 + 除去（**真の検証は CI が握る** — 後述）

### 真因は CI の実測で判明した — 診断改善が機能した

PR #570 の CI で #529 が再発し、**PR #561 で入れた診断計装が原因を吐いた**:

```
first LoadPlugin call finished before the poller ever observed ChildSlot::Loading
(slot is now Empty, after 2 polls / 5.079915ms); its result was
Err(OutProcEffect("spawn outproc child \"/tmp/orbit-outproc-effect-6243-3.sh\":
                  Text file busy (os error 26)"))
```

**ETXTBSY**。#529 本文の「✅ 有力な機序」が**そのまま当たっていた**:

| 本文の予測 | 実測 |
|---|---|
| 「`Loading` に到達しなかった」のではなく「**既に離脱していた**」 | ✅ `slot is now Empty, after 2 polls / 5.079915ms` |
| spawn 失敗 → `Loading → Empty` に即座に戻る。窓はサブミリ秒 | ✅ 5ms で 2 polls しか回っていない |
| CI で断続的に spawn が失敗する既知の原因: **ETXTBSY** | ✅ `Text file busy (os error 26)` |
| 実エラーが握り潰されて deadline timeout panic に化ける | ✅ **改善後は join して実エラーを載せたので即座に判明** |

診断改善が無ければ、今回も「never reached ChildSlot::Loading within 30s」という
**原因を何も語らない panic** になっていた。**対症でなく診断を先に直した判断の実証**。

### 機序（独立裁定で検証・確信度 85-90%）

1. スレッド A が `.sh` を書き込み用に open している
2. その最中に別スレッドが `posix_spawn`（`clone(CLONE_VM|CLONE_VFORK)` + `execve`）する
   → **子は A の write fd を継承する**
3. A は close して chmod し、その `.sh` を exec する
4. しかし**継承した子がまだ exec 前で write fd を握っている**ため、Linux カーネルの
   `deny_write_access` / `i_writecount` チェックに引っかかり **ETXTBSY**

**`O_CLOEXEC` は無効化しない** — CLOEXEC が閉じるのは**その子自身が exec した瞬間**で、
fork〜exec の窓では継承 fd は生きている。

**ETXTBSY の write-count 拒否は Linux 固有**（POSIX では optional・macOS/XNU は事実上チェックしない）。
**Apple Silicon ローカルで一度も再現せず ubuntu-latest でだけ出る**という観測履歴と整合する —
**ローカル再現失敗は負荷不足ではなく OS 差**だった。

### 棄却した案（いずれも一次情報で確認）

- **生存済みバイナリを使う**（当初 main の推奨）→ ❌ `CARGO_BIN_EXE_<name>` は
  **integration test / bench のビルド時にしか設定されない**。当該テストは lib unit test なので
  コンパイルエラーになる。**main が Cargo 仕様を確認せずに推奨していた**（#529 で訂正済み）
- **`LazyLock` で1回だけ生成** → ❌ 初回アクセスは他テストが既に並走中に起きる。窓の縮小に留まる
- **global mutex で直列化** → ❌ プロセス内の**全 fork**（特に **watchdog respawn スレッド**）が
  lock に参加する必要があり、本番コード変更が要る（方針違反）
- **fsync/close を挟む**（#529 本文の1案目）→ ❌ **無効**。`fs::write` は返る前に既に close している。
  問題は「閉じ忘れ」ではなく「**閉じる前に他スレッドの fork が fd テーブルごと複製した**」こと

### 採用: コミット済み fixture スクリプト

`write_slow_child_script` / `write_exit_child_script` を廃止し、
`rust/crates/orbit-audio-daemon/tests/fixtures/{slow-child,exit-child}.sh` を
`env!("CARGO_MANIFEST_DIR")` 起点で参照する（git に **100755** でコミット）。

**構造的解決である理由**: ETXTBSY の必要条件は「exec 時点でその inode を write-open している者が
存在すること」。fixture は**テストプロセスの生存中に誰も一度も write-open しない**ので、
継承させる write fd がそもそも発生しない。**確率を下げるのではなく前提条件を消している**。

各テスト末尾の `remove_file(child_exe)` は削除（共有 fixture を消すと並走テストが壊れる）。

### 変異検証で「他にも5件が同じ機序を抱えていた」ことが判明

fixture パスを存在しないものに変える変異で **6件が red**:

- `effect_load_outproc_concurrent_call_fails_fast_on_loading`（#529 の当該テスト）
- `effect_load_outproc_early_exit_fast_fails_and_keeps_retry_shm`
- `effect_load_outproc_role_mismatch_retries_same_slot`
- 上記3つの instrument 版

つまり **#529 として観測されていたのは氷山の一角**で、同じ機序の潜在フレークが他に5件あった。
裁定の「`write_exit_child_script` も同時に置き換えるべき」という指摘どおり。

### 検証

- `cargo test --workspace --locked` ✅ 382 passed / 0 failed
- `--features outproc-effect` ✅ 138 / `--features outproc-instrument` ✅ 113 /
  `--features outproc-effect,outproc-instrument` ✅ 179（いずれも 0 failed。CI が走らせる全組み合わせ）
- `cargo fmt --check` ✅ / `cargo clippy --workspace --all-targets -- -D warnings` ✅

🔴 **ローカルの緑は修正の証明にならない** — このフレークは Linux 固有で macOS では再現しない。
ローカルで確認できるのは「退行していないこと」だけで、**真の検証は CI が握る**。

**反証条件**: fixture 化後もなお ETXTBSY が出たら、この機序は誤りで**外部 writer を疑い直す**。
PR #561 の診断計装を残したのは、そのときの自白装置として。

### 6.315 test: prove the tone loop on real hardware — PR #563 のレビュー〜出荷 (Jul 29, 2026)

**Date**: 2026-07-29
**Status**: ✅ PR #563 MERGED（merge commit `01563c4`）

6.314 の続き。`/simplify` → レビュー3ラウンド → Fable 独立監査3回 → 実機 E2E → **全長 E2E** まで。
Rust 366 → 382、TypeScript 1757 → 1773。

**Epic #546 の音色ループを実機で証明した**（`tests/e2e/orbitstudio-mcp-gated.spec.ts`）:

offset 7 の state で attach → 発音 → MCP で保存（**バイト同値**を確認）→ `stop_engine` →
`start_engine` → **保存物を公開 DSL 経路 `instrument(path, savedPath)` で指す** → capture WAV の
基本周波数が一致。判定は解析のみで**人間を介在させない**。

実機での変異検証（理論値どおり）:

| 変異 | 結果 |
|---|---|
| 通常 | Cycle A / B とも **392.00Hz** |
| `statePath` を落とす | `restored 261.63Hz must match saved 392.00Hz` |
| 手組み state を offset 0 に | `Cycle A 261.63Hz must be offset-7 pitch 392.00Hz` |

261.63Hz は default(C4)、392.00Hz は offset 7。**2つの変異がそれぞれ別のアサーションを殺す**
（前者は復元経路の検証、後者は「弱いテストへの転落」を防ぐ砦）。

## 実機・独立監査でしか見つからなかった3件

**1. env ゲート設計が false green を生む（実装前に発見）**

「oracle に env で非 default の音色を持たせる」案を検討したが、env はアプリプロセスに一度入ると
`stop_engine`→`start_engine` を跨いで**外せない**（daemon が extension host の env を継承）。
すると**復元が壊れていても同じピッチが鳴る**。独立監査の裁定で実装前に棄却し、
テスト側で state を手組みする方式に変更した。

**2. gated E2E が1ヶ月前の CLAP バンドルを検証していた**

VST3 oracle は `package-oracle.sh` でその場ビルドするのに、CLAP は `fs.existsSync` で
**存在確認するだけ**だった。**存在は鮮度を意味しない** — `target/release/` にあったのは
#557（CLAP oracle に `PluginStateImpl` を足した PR）より前の 6/27 のバンドルで、
`CLAP_EXT_STATE を持たない` で保存が落ちた。CLAP も同じくその場ビルドする形へ揃えた
（`8810f47`）。

**3. 度数が根音未宣言で解決できず、音が一度も鳴っていなかった**

`play(1)` は MIDI 度数で `global.key(...)` が要る。**`evaluate_orbitscore` はすべて
`isError: false` を返していた**が、エンジン側で解決に失敗していた。`get_log` の ERROR デルタを
見るアサーションが無ければ「無音」で落ちて原因究明から始まっていた。
規律「`ok` は受理しか意味しない・`get_log` を見よ」がそのまま効いた実例。

## レビューで実測により塞いだ穴

`/code:pr-review-team` が**変異を実行して4件の生存**を検出した（推測ではない）:

- `save_state_command` の IO エラー分岐 — テスト fixture が共有 seam を使わず**手書き複製**を
  残していたため、書き込み失敗を成功として ack しても全件 green だった
- `bytesWritten <= 0` ガード — **`NaN <= 0` は false** なので `Number(undefined)` が素通りし、
  壊れた保存が「成功」として登記されていた
- per-sequence effect の `effects[index - 1]` オフセット
- DSL 語彙の分類テストが**和集合判定**で、`savePluginState` の露出を検出できなかった

加えて「保存した state が**次の respawn で復元される**」という機能の存在理由そのものが
全レイヤーで無検証だった（既存テスト名は respawn を検証するかに読めたが、実際は
`latest_state` の**値**しか見ていなかった）。本番と同じ seam を通す因果テストを追加した。

## その他

- sidecar 掃除の失敗で mailbox スロットが解放されず、respawn 経路で踏むと
  **プラグイン state を二度と保存できない daemon** になっていた。掃除の結果を保持してから
  必ず解放し、その後にエラーを返す形へ（復帰しつつ loud のまま）
- 4つの child に重複していた save-state handler を共有層 `save_state_command` へ集約
- spec の stale な「host 側の発行経路は未実装」注記を更新（**この PR がその発行経路**）。
  UIH.5 に v1 スコープ注記（sum/aux 未対応・**解決順を暗黙に決めない**理由）を追加

## 残課題（追跡）

- **#565**: VST3 instrument の out-of-process 音声が**全層で未検証**（CLAP には
  `instrument_parity_gated.rs` があるが VST3 には無い）。Epic #546 の完了条件に含めた
- **#541**: 起動時の自動復元は「テストが無い」のではなく**実装が無い**
  （`project.yaml` の `states:` を読むコードが1行も無い）。実装されたら本 E2E の
  「savedPath を手で渡す」1行を消すだけで受け入れテストになる
- **#564**: sum/aux バス insert の state 保存（アドレス指定の名前空間が未決）

---

### 6.314 feat(engine): save live plugin state through MCP #562 (Jul 28, 2026)

**Date**: 2026-07-28
**Status**: ✅ 実装・変異検証完了（sandbox の loopback / process-list 制約を除く）

#562 の plugin state 保存経路を、4形式の実 child から daemon / TS engine / REPL / VS Code
extension を経て MCP `save_plugin_state(sequence,index)` まで接続した。自動復元は #541 に残し、
保存成功時の `project.yaml` 登記までを本変更に含めた。

**mailbox / child lifecycle**:

- host 側 `CommandMailboxHost` を追加。production timeout は単一の
  `PLUGIN_STATE_MAILBOX_TIMEOUT = 5s` とし、実測 elapsed をエラーへ含める
- ack 待ち中は mutex を保持しない。単一未処理、完全一致 ack、publish 順、
  `CMD_ARG_BYTES` / NUL / UTF-8 / 絶対パス境界を一元化
- timeout 後は遅延 ack または child death/reset まで poisoned のまま保持し、遅延 write の
  sidecar は ack/reset 後にだけ削除
- 初回 attach / effect watchdog / instrument watchdog の3経路を同じ coordinator へ配線。
  `try_wait() == Some` で旧 child の死亡確認後に failure ack → reset → replacement spawn の順を強制

**4形式 parity / daemon**:

- VST3 / CLAP effect host と child に state capture / READY 前 restore / mailbox service を追加
- VST3 gain oracle と CLAP test effect を共通 `ORE1 + f64 gain` state にし、保存値 0.25 が
  実 process child から戻る配線テストを追加。既存 instrument 2形式と合わせ4形式を実証
- sample scheduler は `active_count_strict()`、instrument は control-side active-note 集合を使い、
  判定不能を含め演奏中の保存を fail-closed に拒否。自動 stop はしない
- child READY、slot role/bus/instance、非空・実ファイル長一致を検証後、同一 directory の一意
  sidecarを atomic rename + directory fsync。成功後は supervisor と共有する `latest_state` を更新
- daemon protocol を `0.2` に上げ、`GetPluginState` と専用 error code 群を追加

**TS / project / MCP**:

- UIH.5 `(sequence,index)` を current chain から daemon target と SC.5
  `<receiver>/<role>/<normalized-name>/<occurrence>` へ同時解決。master effect は
  `{sequence:"master",index:1}`、audio source index 0 は明示拒否、無効 index は有効な
  role / normalized name 一覧を返す
- state 本体成功後だけ `project.yaml` の `states:` を atomic 更新。未知の top-level field は保持し、
  state filename は SC.5 tuple の JSON/base64url で衝突なく生成
- REPL meta は request ID 付き JSON、extension bridge は Map 相関・timeout・process death drain を
  実装。MCP は daemon code/details を `isError:true` で保持
- gated OrbitStudio E2E に、VST3/CLAP × instrument/effect の4保存、演奏中拒否の非停止性、
  `project.yaml`、無効 index、`get_log` の新規 `ERROR:` なしを追加

**変異検証（`$TMPDIR` backup → 変異 → red → 復元 → `cmp` 一致）**:

| クラス | 変異 | red の観測 |
|---|---|---|
| 分岐反転 | transport guard を反転 | 演奏中要求が resolve して拒否テスト red |
| 呼び出し回数 | daemon save を2回呼ぶ | `toHaveBeenCalledTimes(1)` が 2 で red |
| 順序 | manifest を state 保存より先に確定 | daemon 失敗後に新SC.5 keyが残り red |
| 引数差し替え | instrument instance を `default` に変更 | `plugin:lead` routing 差分で red |
| lifecycle | 保存後の `latest_state` 更新を削除 | supervisor 共有 Arc が `None` のままで red |

**検証**:

- `cargo test --no-run -p orbit-audio-daemon --features outproc-effect,outproc-instrument` ✅
- daemon feature build: lib 134 / main 7 passed。protocol integration 28件は sandbox が
  `127.0.0.1` bind を `EPERM` にするため setup で実行不能
- `cargo test --workspace --exclude orbit-audio-daemon` ✅
- 4 child mailbox wiring: VST3 effect 1 / CLAP effect 1 / VST3 instrument 2 /
  CLAP instrument 4 passed
- `cargo fmt --all --check` / `cargo clippy --workspace --all-targets` ✅
- `npm run build` / `npm run lint` ✅（lint は既存 warning 2件、error 0）
- state / REPL / bridge の network-free Vitest 13 passed。MCP HTTP 16件と WebSocket mock 群は
  同じ loopback `EPERM`。指定の全 Vitest は WebSocket `listening` 待ちで停止するため中断
- gated real OrbitStudio E2E は「unprompted 実行禁止（実 GUI・可聴音）」契約に従い未実行
- `pgrep -f "orbit-.*-child"` は sandbox の process-list 拒否で確認不能

---

### 6.313 test(daemon): make the #529 flake self-diagnosing instead of silent (Jul 28, 2026)

**Date**: 2026-07-28
**Status**: 🔄 PR 準備中

#529 の flake は「原因を何も語らない 30 秒 timeout」に化けていた。**症状を消す修正ではなく、
次に落ちたときに真因を自白させる修正**（Fable が 2026-07-27 に一次ソース読解で確定した方針）。

**なぜ 30 秒待つのか（既に棄却された仮説を再掲）**:

- ❌ 「ポーリングが相手を飢餓させる」— worker の critical section は µs オーダー
- ❌ 「CI が遅くて spawn が間に合わない」— `Loading` は **spawn より前**に設定される
- ✅ **`Loading` に到達しなかったのではなく、既に離脱していた**。spawn 失敗で
  `Loading → Empty` にサブミリ秒で戻り、5ms 間隔のポーラーが窓を丸ごと見逃す

**決定的な欠陥**: 1本目のエラーは `join()` でしか回収されないのに、join は**ループの後**。
実エラーが握り潰されて timeout panic に化けていた。

**修正**（テスト内で閉じる・**本番コード無変更**）:

- 待ちの条件を「`Loading` を観測 **or** worker が終了」に。終了していたら **join して実エラーを
  message に載せる**
- deadline assert に**反復回数と実測 elapsed** を追加（Fable が「決定的判別方法」とした計装。
  数千回なら本当にスケジューリング問題、数回〜数百回ならランナー停止）
- 同型の待ちがもう1箇所あったので同時に適用

**レビューで直した自分の欠陥（Fable 指摘・4件）**:

1. 🔴 **コンパイルできていなかった**（`SlotKind` 未定義）。`cargo check` はテストコードを
   含まないため素通りしていた。**`cargo test --no-run` で検出すべきだった**
2. メッセージが「`Loading` を**一度も設定しなかった**」と断言していたが、「設定後に離脱した」
   経路では**虚偽**になる。主張できるのは「ポーラが観測する前に worker が終了した」ことだけ
3. もう1箇所は「join してエラーを載せる」とコメントしながら**join せずに落ちて**いた
   — #529 の原因そのものを再演していた
4. pid 再読が無く TOCTOU で虚偽メッセージが出る窓があった

**変異検証**: `select_child_exe` を Err にして「`Loading` を一度も設定しない」経路を再現。
修正前なら 30 秒後に無言で落ちるところが、**7.5ms で実エラーつきで落ちる**ことを確認:

```
first LoadPlugin call finished before the poller ever observed ChildSlot::Loading
(slot is now Empty, after 2 polls / 7.5585ms);
its result was Err(OutProcEffect("MUTATION: select_child_exe forced failure"))
```

> ⚠️ **環境差**: spawn 失敗を強制する変異は、**私の環境では通り**（ポーラが `Loading` の窓を
> 捉えた）、**レビュアーの環境では両サイトとも 8/8 で新しい診断つきに落ちた**。
> spawn の ENOENT 検出は fork/exec 実装依存で負荷・スケジューリングに敏感なため、
> どちらも起こりうる。**1回の観測から「通ってしまう」と一般化して書いたのは誤り**だった。
>
> なお site 2 の pid 再読（TOCTOU 対策）は、レースを踏ませる合成実験を 30 回試しても
> **一度も再現しなかった**。理屈上は正しいが窓が極めて狭く、#529 の実際の原因だった
> 可能性は低い。コストはほぼゼロなので残す。

**この issue はクローズしない**: 診断の改善であって症状の除去ではない。
spawn 失敗そのものは残るので flake は再発しうる。

**検証**: daemon 132 passed（両 feature）/ 対象テスト 10 回連続 green / workspace 全 green /
fmt clean / clippy 0。

---

### 6.312 feat(clap): CLAP state parity — 同じループテストが両形式で green #557 (Jul 28, 2026)

**Date**: 2026-07-28
**Status**: 🔄 PR 準備中

Epic #546 の中核制約「**プラグイン形式に依存しない**」の履行。受け入れ基準
「VST3 と CLAP の両方で同じ E2E が green（oracle synth で無人化）」を child + IPC 層で満たす。

**着手前の縦割り**（コード確認済み）:

| 能力 | VST3 | CLAP |
|---|---|---|
| state 復元 | instrument のみ対応 | **`--state` を明示 bail** |
| state 取得 | host 関数 + IPC（#555） | **`CLAP_EXT_STATE` 参照ゼロ** |

**実装**:

- `orbit-clap-host`: `ClapInstrumentProcessor::capture_state()` / `apply_state_bytes()` を
  `CLAP_EXT_STATE`（clack の `PluginState`）経由で追加。**意味論を VST3 とそろえる** —
  拡張が無い / save 失敗 / **空 state** はすべて `Err`（`Ok(vec![])` にしない）
- `orbit-clap-instrument-child`: `--state` の bail を外して**復元**を実装。
  適用は **READY を publish する前**に行う（READY 後だと「復元前の既定音色で 1 ブロック鳴る」窓ができる）
- 同 child が `service_command_mailbox` を呼ぶようにした。#556 で共有層へ引き上げてあるので、
  **ack の publish 順序・未知 kind の扱い・detail の切り詰め禁止は自動的に継承される**
  （handler を書くだけで済む、という #556 の設計主張がここで実際に効いた）
- `clap-test-synth` oracle: テストが1本も無かったので VST3 oracle と対称に5本追加。
  あわせて **VST3 oracle にも対称の契約 pin テストを追加**した（4本 → 5本）

**🔴 形式間の契約を固定する**: 両 oracle が同じ magic（`ORC1`）・同じ長さ（8）・同じバイト並びを
使うことを、**両 oracle の `state_encoding_matches_the_cross_format_contract`** で固定した。
別ワークスペースなので定数を共有できないため、**両側を同じリテラルに pin する**のが唯一の橋渡しになる。
どちらか一方の定数を変えれば、その側のテストが red になる。

> ⚠️ **`/simplify` の指摘で修正**: 当初は CLAP 側にしか pin テストを置いておらず、
> 「両 oracle で固定した」という記述が**誤り**だった。CLAP の定数を CLAP のリテラルと
> 比べるだけの自己言及的な pin で、**VST3 側の定数が変わっても何も red にならなかった**。
> VST3 oracle にも同じテストを追加し、片側だけの契約破り（magic 変更 / 長さ変更）が
> 実際に red になることを変異で確認した。

「VST3 と CLAP で同じ E2E」という受け入れ基準は、この契約が守られて初めて意味を持つ。

**配線テスト**（`orbit-clap-instrument-child/tests/mailbox_wiring.rs`・VST3 側と同構造）:
本番 child バイナリを実際に spawn し、`--state` で 7 半音を復元して起動 →
mailbox 経由で吸い上げ → サイドカーが復元値と一致するか検証。デバイス不要・無人。

**変異検証（4種・すべて red・切り分けも確認）**:

| 変異 | 結果 |
|---|---|
| (a) mailbox 呼び出しを無効化 | 2件とも red（**テストが loud skip で空回りしていないことの証明でもある**） |
| (b) 分岐反転（`CMD_SAVE_STATE` を未対応に） | 保存テストのみ red |
| (c) `--state` の復元を無効化 | 保存テストのみ red |
| (d) 引数差し替え（別パスへ書く） | 保存テストのみ red |

oracle 側も4種すべて red（magic 検証の迂回 / `note_on` がオフセットを無視 /
バイト順の変更 / 長さチェックの境界ずらし）。

**検証**: workspace 全 green / `clap-test-synth` 5 passed / fmt clean / clippy 警告 0。

**レビュー（`/simplify` + レビュー3本 + Fable）で直したもの**:

- **形式間の契約 pin が CLAP 側にしか無かった** — CLAP の定数を CLAP のリテラルと比べるだけの
  自己言及的な pin で、**VST3 側の定数が変わっても何も red にならなかった**。
  VST3 oracle にも同じテストを追加し、片側だけの契約破りが red になることを変異で確認
- **READY 前に復元する不変条件が守られていなかった** — `apply_state_bytes` と
  `publish_child_ready` を**入れ替えても配線テストが両方 green** だった（変異検証で判明）。
  `load()` に state を畳んで**正しい呼び方を1箇所に強制した**
  （VST3 の `load(..., state: Option<&[u8]>)` と同じ形。CLAP だけが別呼び出しでリスクを抱えていた）

  > ⚠️ **ラウンド2で訂正**: 当初「順序ミスを**表現できなくした**」と書いたが**言い過ぎ**だった。
  > `apply_state_bytes` は `pub` のままなので、`load(.., None)` してから後で呼ぶ逆行コードは
  > 今でも書ける（レビュアーが実際に書いて確認）。ただしその逆行は破損 state のテストが拾う。
  > 「表現不能にした」のではなく「**正しい呼び方を1箇所に集約し、逆行はテストが拾う**」が正確。
- **空 state ガードが無防備だった** — oracle が常に非空を返すため踏めず、VST3 側は
  「無防備である」とコメントで自覚するに留まっていた。oracle に「何も書かずに成功を返す」
  モードを足して**実際に踏んで殺せるようにした**（規格上、state を持たないプラグインが
  0 バイト + `true` を返すのは違反ではないので、架空の状況ではない）
- **失敗系の実証がゼロだった** — 「復元に失敗したまま READY になって既定音色で鳴る経路は無い」
  ことをコードでは読み取れるが、**裏付ける実行結果が両形式とも無かった**。破損 state で
  READY が立たず非ゼロ終了することを実証するテストを追加
- 陳腐化した assertion メッセージ（「CLAP child would bail on it」= **本 PR が偽にした前提**）を訂正
- `activate` 後に `load` する点が VST3 と**非対称**であることを明記（規格上は適法だが、
  サードパーティ CLAP での検証は残課題）

**テストの脆さも解消**: 空 state テストが `detail.contains("空")` と**日本語の文言に結合**していた
（文言を英語化しただけで無関係に red になる）。メッセージを `EMPTY_STATE_FROM_PLUGIN` 定数にして
実装とテストが同じものを見る形にし、**①ガードを外すと red ②文言だけ変えても green** の
両方向を実測で確認した。

**追加の変異検証（2種・すべて red・切り分けも確認）**: 空ガードを外す → 空 state テストのみ red /
復元失敗を握りつぶす → 破損 state テストのみ red。

> ⚠️ **CI の非対称（記録のみ）**: `rust-spike/` は CI のワークスペース外なので、
> **CLAP oracle の契約 pin は CI で走らない**。配線テストも macOS 限定で CI は ubuntu のみ。
> 実質の防波堤は main workspace 側の手書きリテラルとマージ前ゲートで、機械的強制ではない。

**残**: effect 側の state（両形式とも引数すら無い）・param 列挙/設定・UI hosting。
host（daemon）側の発行経路も未実装のままで、これは spec UIH.2 の規律
（単一未処理コマンド・respawn 時の reset・演奏停止中のみ発行）を満たす PR が担う。

---

### 6.311 fix(ci): build `outproc-instrument` alone — it was broken on main (Jul 28, 2026)

**Date**: 2026-07-28
**Status**: 🔄 PR 準備中

**症状**: `cargo check -p orbit-audio-daemon --features outproc-instrument` が
**main でコンパイルエラー2件**で失敗していた（#551 / #556 とは無関係の既存欠陥。
両ブランチと main で同じ2件が出ることを確認済み）。

**原因**: `load_distinguishes_existing_instance_from_pool_exhaustion` テストが
`load_outproc_instrument_plugin` を呼ぶが、このメソッドは
`all(outproc-effect, outproc-instrument)`（both build）でのみ定義される。
**テスト側の cfg が呼び先より緩かった**。

**実害の範囲**: 出荷経路（`release.yml` / `copy-daemon-bin.sh`）は**常に both build** なので、
壊れた成果物が出荷されることはない。困るのは `--features outproc-instrument` 単独で
`cargo test` を叩いた開発者で、理由の分からないエラーに当たる。

**なぜ気づかれなかったか（本質）**: CI が `outproc-effect` は検査するのに
**`outproc-instrument` を一度もビルドしていなかった**。壊れたのがまさに CI の死角にある
feature だった。cfg を直すだけでは同じ形で再発する。

**対応**:

- テストの cfg を呼び先に合わせる（`#[cfg(feature = "outproc-effect")]` を追加）
- **CI に4ステップ追加**: `outproc-instrument` 単独の clippy / test と、
  **出荷時に実際に使う組み合わせ**（`outproc-effect,outproc-instrument`）の clippy / test

**ガードの実証**: cfg 修正を元に戻して退行を再現したところ、**新ステップは error 3件で落ち、
既存ステップ（`--features outproc-effect`）は 0 件で素通り**した。追加したステップが
実際に検出力を持つことを実行結果で確認している。

**検証**: 3組み合わせ（`outproc-instrument` / `outproc-effect` / 両方）すべて
clippy 警告 0・test green。

---

**同時に塞いだ別の穴: vitest が `.claude/worktrees/` の複製 spec を拾う**

gated E2E を回そうとして `vitest run tests/e2e/orbitstudio-mcp-gated.spec.ts` と書いたところ、
**実機 OrbitStudio が7個同時起動し、daemon が19本残留した**（2026-07-28）。

原因: vitest の位置引数は「発見済み全ファイルへの正規表現フィルタ」であり、パス指定ではない。
`.claude/worktrees/agent-*` には subagent が作ったブランチのフルコピーが残っており、
同名の spec が7本存在していた。gated spec のヘッダコメントはこの危険を警告しているが、
**何も強制していなかった**（同種の事故は WORK_LOG 6.x にも記録がある）。

`vitest.config.ts` に `exclude` を追加して discovery から外した。
**実測: 発見ファイル数 7 → 1**（exclude を外して再計測し、7 に戻ることも確認済み）。

> ⚠️ **レビューで見つかった二次被害**: 最初 `['**/node_modules/**', '**/dist/**', ...]` と
> **既定値を手打ちで再現**したが、`test.exclude` に配列を渡すと vitest の `defaultExclude` は
> **マージされず丸ごと置き換わる**（`@vitest/utils` の `deepMerge` が配列を mergeable から
> 除外している）。結果、`**/.{idea,git,cache,output,temp}/**` や `**/cypress/**` の除外が
> 黙って消えていた — **この PR が塞ごうとしている穴と同じ形の穴**を別の場所に開けていた。
> `.cache/` に spec を置くと実際に拾われることを実測で確認し、
> `[...configDefaults.exclude, '**/.claude/worktrees/**']` へ修正した。
> 修正後、①`.cache/` が除外される ②worktree 除外が維持される
> ③通常の発見数（1735）が変わらない、の3点を実測。

**CI ステップの検出力（レビュアーが個別に測定）**: 追加した4ステップのうち
`outproc-instrument` 単独の clippy と test の**2つが対象バグを直接検出**し、
残る2つ（出荷時の組み合わせ）は**このバグは検出しないが別の懸念を守る**ため飾りではない。
なお WORK_LOG が「error 3件」としていたのは、正確には **E0599 が2件**＋要約行の計3行。

---

### 6.310 feat(daemon): GetPluginState IPC — ループの保存側 #555 (Jul 28, 2026)

**Date**: 2026-07-28
**Status**: 🔄 PR 準備中

Epic #546 **Phase 1**。DAW ループの**保存側**を作る。

**現状の欠落**: 復元側（spawn 時 `--state`・#540 P2）は存在するが、**実行中の child から
state を吸い上げる経路が無かった**。`orbit-vst3-host` に `MemoryStream` + `getState` の
パターンはあったが（`sync_component_state`）、**バイト列として外へ出す公開 API が無い**。
つまり「宣言 → 音色変更 → **記録** → 終了 → 再起動 → 同じ音」の**記録**が欠けていた。

**実装**（`PLUGIN_UI_HOSTING_SPEC_v1.md` UIH.2 / UIH.3 準拠）:

- `transport.rs`: **コマンドメールボックス**（`cmd_seq` / `cmd_kind` / `cmd_arg` /
  `cmd_ack_seq` / `cmd_result` / `cmd_result_len` / `cmd_result_detail`）。既存の
  `control`（RUN/QUIT）は teardown で reset されるため**別フィールドにする**（spec UIH.2 の理由）
- 可変長 state は shm を通さず**サイドカーファイル経由**（host が `cmd_arg` にパスを書き、
  child がそこへ書く）。`SharedRegion` は固定サイズ POD で数十 MB を運べない
- `Vst3InstrumentProcessor::capture_state()`: `IComponent::getState` をバイト列で返す。
  **空 chunk は `Err`** — サイズ 0 を「成功」として上位へ渡すと音色を失う
- child: メインループでコマンドを1件処理。**未知の kind も ack で知らせる**（silent 無視しない）

**実行モデルとの関係**: spec UIH.1 は「state 操作はメインスレッド」を要求する。**現状 child の
メインスレッドは audio spin loop なので、そこで処理すれば spec 準拠**（`control` を見るのと
同じ seam）。Phase 2 で audio を別スレッドへ退避したら、コマンド処理は自然に Cocoa runloop
側へ移る。→ **Phase 2 を待たずに実装できる。**

**変異検証（3種・すべて red）**: ①収まらない値を切り詰めて書く（**別パスへの書き込みを招く**）
②NUL 終端が無くても先頭から読む ③非 UTF-8 を lossy で受理する。

**検証**: この段階の件数はコマンド併記が無く再現できなかったため、節末の実測表に一本化した。

**🔴 ループ通し E2E を追加（受け入れ基準の中核）**:
`orbit-vst3-host/tests/offline.rs` の `state_round_trip_reproduces_the_same_pitch`。
**デバイス不要・無人・周波数解析だけで判定**する:

1. 既定（offset 0）で鳴らす → 基本周波数が**仕様式** `voice_frequency_hz(69, 0)` と一致
2. state を適用して起動 → 周波数が仕様式と一致し、**かつ 1 と明確に違う**
   （違わなければ復元の成否を音で判定できない、を明示アサート）
3. **記録** = `capture_state()` で実行中インスタンスから吸い上げ
4. **再起動** = 記録した state で新インスタンスを起こす
5. **同じ音**: 周波数が 3 の記録前と一致し、仕様式とも一致

期待値は実装値ではなく**仕様の式から導出**する（E2E_HARNESS_SPEC の改ざん耐性）。
oracle crate に `rlib` を追加してテストから式を参照できるようにした。

**変異検証（4種・すべて red）**: ①`getState` が state を返さない ②`setState` が
オフセットを適用しない ③`capture_state` が chunk の末尾を取りこぼす ④`seek` を省く。

> ⚠️ **`capture_state` の空チェック（`bytes.is_empty()` → `Err`）は現時点で無防備**。
> oracle は常に非空を返すためこの経路を踏めず、当該分岐を消す変異はどのテストでも
> 殺せないことを実測で確認した。塞ぐには「`getState` が何も書かない」モック plugin が要る。
> 当初この穴を「長さを固定する別テストで殺した」と記録していたが**誤り**で、
> その別テスト（`capture_state_returns_exactly_the_oracle_state_length`）が実際に守るのは
> **取りこぼしと余剰**であり、空 chunk 経路ではない。テスト名とコメントも実態に合わせた。

**🔴 IPC そのものを実プロセス越しに検証（`/simplify` altitude 指摘で発覚）**:
上記のループ通しテストは `capture_state()` を**同一プロセス内で直接呼ぶだけ**で、
本 PR の新規コードの大半（メールボックス・child のポーリング）を**一度も通っていなかった**。
「#555 = GetPluginState **IPC**」と称しながら IPC が未検証という状態だった。

対応として、フォーマット中立の servicing を `orbit-audio-sandbox` へ引き上げた:

- `service_command_mailbox(region, handler)` — ポーリング・ack の Release publish・
  **未知 kind を黙って捨てない**・**detail を切り詰めない**という**プロトコル不変条件を一手に持つ**。
  4つの child バイナリ（`orbit-{vst3,clap}-{instrument,effect}-child`）に分散させると、
  同じ publish 順序を4箇所で守り続ける必要が生じる
- child 側は `handler` にフォーマット固有の処理だけを書く（VST3 は `capture_state` + ファイル書き）
- テスト fixture の `sandbox-instrument-child` も同じ関数を使うため、**実プロセス・実 shm 越しに
  プロトコルを踏むテスト**が書けるようになった（`instrument_host_integration.rs` に4件）

**変異検証（4種の壊し方・すべて red・切り分けも確認）**:

| 変異 | 殺したテスト |
|---|---|
| (a) 分岐反転（未知 kind を OK にする） | `unknown_command` / `consecutive` |
| (b) 呼び出し削除（ack を書かない） | 4件すべて（host が永久待ち → タイムアウト） |
| (c) 順序・残留（detail をクリアしない） | `consecutive` のみ |
| (d) 引数差し替え（`len` を常に 0） | `save_state` / `consecutive` |

(c) が狙い撃ちのテスト1件だけを落とすことも確認した（各テストが別々の性質を守っている）。

**検証**（コマンドと実測値・crate 単位の合計）:

| コマンド | passed |
|---|---|
| `cargo test -p orbit-audio-sandbox` | 61 |
| `cargo test -p orbit-vst3-host` | 16 |
| `cargo test -p orbit-vst3-synth-oracle` | 4 |
| `cargo test -p orbit-vst3-instrument-child` | 9（本 PR で新設） |
| `cargo test -p orbit-audio-daemon`（既定 feature） | 64 |

`cargo test --workspace` 全 green / `cargo fmt --all` clean / `cargo clippy --workspace --all-targets` 警告 0。

> ⚠️ 当初この節に書いていた「sandbox 47 / daemon 123」は**どのコマンドでも再現しない数値**だった。
> feature フラグ次第で件数が変わるため、**コマンドを併記しない件数は検証の役に立たない**。

**🔴 本番 child の配線を実プロセスで検証（pr-test-analyzer が変異で実証した穴）**:
`service_command_mailbox` の呼び出しを `if false { ... }` で包む変異が**全テスト green のまま
通過した**。fixture (`sandbox-instrument-child`) はプロトコルを検証するが `capture_state()` を
呼ばないため、**本番 child の配線はどこでも守られていなかった**。

対応: `orbit-vst3-instrument-child/tests/mailbox_wiring.rs` を新設。本番 child バイナリを
実際に spawn し、`--state` で既知のオフセット（7半音）を**復元**して起動 → メールボックス
経由で**吸い上げ** → サイドカーが復元値と一致することを確認する。実プラグイン（synth oracle）
を実 VST3 ホストでロードした上で shm を往復する。**デバイス不要・無人**。

package 手順は oracle 自身の `package_bundle()` に移した（`orbit-vst3-host` の
ループ通しテストと共有。手順が変わったとき片方だけ直し忘れる形を避ける）。

**変異検証（4種・すべて red・切り分けも確認）**:

| 変異 | 結果 |
|---|---|
| (a) メインループの呼び出しを無効化（**従来どこも殺せなかった変異**） | 2件とも red |
| (b) 分岐反転（`CMD_SAVE_STATE` を未対応として返す） | 保存テストのみ red |
| (c) 実プラグインを見ずに固定バイト列を書く | 保存テストのみ red |
| (d) 引数差し替え（要求と別のパスへ書く） | 保存テストのみ red |

**spec 逸脱の解消**（規則6: spec が正本）:

- **fsync**: UIH.3 は「書き込み → fsync → ack」を要求するが実装は `std::fs::write` のみだった。
  `write_sidecar()` を共有層に置いて `fsync` まで行う。ack が「ディスクに載った」を意味しないと、
  電源断で「登記簿は新しい state を指すが実体は古い」状態になりうる
- **`cmd_result_len`**: 実装が新設した専用フィールドが UIH.2 の表に無かった → spec に追記
- **単一未処理コマンド契約**と**respawn 時の mailbox reset** を UIH.2 の規律に MUST として明記。
  後者は「replacement child が前世代宛のコマンドを実行し成功で ack する」経路（silent-failure
  レビューの指摘）。**host 側の発行経路が未実装のため現在は未到達**なので、投機的な実装は
  避け、発行経路を足す PR が同時に満たす制約として spec に固定した
- サイドカーの**削除責務は host** であることを UIH.3 に明記

**`write_cstr_field` の穴**: 埋め込み NUL を含む値を受理していた（read 側は最初の NUL で切る
ので「切り詰めない」保証が黙って崩れる）。拒否側に倒し、**保証をコメントではなくコードで守る**
形にした。変異検証済み。

**スコープの明示（#555 の宣言との差分）**: issue #555 のスコープには「daemon 側: 保存を要求して
ack を待つ経路」も含まれていたが、**本 PR には入っていない**。上記の respawn / タイムアウト /
単一未処理コマンドの規律は、その配線 PR が満たすべき前提として spec 側に置いた。

**混入の除去**: 作業ツリーにあった #557（CLAP state parity）の未完成コードが `git add -A` で
本 PR のコミットに紛れ込んでいた。`rust-spike/` は CI のワークスペース外でビルドされないため
**CI をすり抜けた**（実際にコンパイルエラー3件）。差分から除去し、patch として退避してある。

**ラウンド2レビュー（Critical 0 / Important 2・両方対応済み）**:

- **`fsync` が audio spin loop と同じスレッドに乗る**: ラウンド1の `std::fs::write`（page cache 止まり）を
  `sync_all()` に強化した結果、演奏中に `SAVE_STATE` が来ると次の audio slot が数 ms〜数十 ms 遅延し
  dropout を生みうる。**現状は発行元が無く未到達**なので投機的な実装は避け、
  spec UIH.3 に「audio 専用スレッド分離が済むまで host は演奏停止中にのみ発行する（MUST）」を明記した
- **oracle bundle の出力パス競合**: `package_bundle()` を共有層へ引き上げたことで、
  **別クレート＝別プロセス**から同じ固定パスへ `rm -rf` する形を新たに作ってしまっていた。
  `cargo test` は既定で逐次実行のため現状は表面化しないが、別ターミナルでの並行実行や
  `cargo nextest` で即座に踏む。出力先をプロセスごとに分けて競合そのものを消した。
  **2クレートのテストを実際に同時実行して両方 green を確認**（分離前は同一パスを奪い合う）

**変異検証（レビュアーが独立に再実行・6種すべて red）**: 主張した4種に加え、
`cmd_result_len` の改竄と**サイドカーへの余分バイト追記**（長さ検証が効くか）も red だった。

> ⚠️ **構造的な制約（既存・本 PR の欠陥ではない）**: `mailbox_wiring.rs` は
> `#![cfg(target_os = "macos")]` で、Rust CI は `ubuntu-latest` のみ。**この配線テストは
> CI で一度も走らない**（VST3 関連テスト全般に共通）。退行検出はマージ前ゲートの
> 手動実行規律に依存している。macOS ランナーの追加は別 issue 相当。

**残**: 本 PR は VST3 instrument のみ。CLAP / effect への展開は形式中立の要件（CAP.6 の項目2「必須能力は全形式で揃える」）として後続。
`service_command_mailbox` を共有層に置いたので、CLAP child は handler を書くだけで済む。
UI 経路（#474）と `project.yaml` 永続化（PRJ）も残る。

### 6.309 feat(oracle): VST3 synth oracle に観測可能な state 意味論 #553 (Jul 28, 2026)

**Date**: 2026-07-28
**Status**: 🔄 PR 準備中

Epic #546 **Phase 1** の最初の項目。受け入れ基準「VST3 と CLAP の両方で同じ E2E が green
（**oracle synth で無人化**）」の前提を作る。

**なぜ最初にこれか**: ループ（宣言 → 音色変更 → 記録 → 再起動 → 同じ音）を**無人で検証**するには、
「state を変えると音が変わる」「state が往復する」プラグインが要る。実プラグインは人間の UI
操作が要るため無人化できない。**oracle がこの性質を持って初めて以後の全フェーズの検証が閉じる。**

**現状の問題**: `setState` / `getState` は `kResultOk` を返すだけのスタブで、音は
`440 * 2^((key-69)/12)` の固定式。**state を変えても音が同じ**なので復元の成否を音で判定できなかった。

**実装**: **state = 半音単位のピッチオフセット**（`i32`）。

- `voice_frequency_hz(key, offset)` を**仕様の式・単一の真実**として公開し、テストはここから
  期待値を導出する（E2E_HARNESS_SPEC「期待値は仕様の式から導出する」= 改ざん耐性）
- `encode_state` / `decode_state`（magic `"ORC1"` + i32 LE）。**magic 不一致・長さ不足は
  `None` を返し黙って 0 に倒さない** — 復元したつもりで別の音になるのを防ぐ
- `setState` / `getState` を `IBStream` 経由で実装（不正入力は `kResultFalse`）
- `note_on` がオフセットを実際に使う

**変異検証（5種・すべて red）**: ①`note_on` がオフセットを無視（**配線を切る**）②encode で
offset を落とす ③magic 検査を外す ④長さ検査を外す ⑤式の符号を反転。

> ①が重要: 純関数 `voice_frequency_hz` のテストだけでは、`note_on` がそれを無視していても
> green のまま通る。**配線はロジックと別にテストする**（#551 で同型の穴を踏んだ教訓）。

**検証**: oracle 4 tests passed / fmt clean / clippy 0。

---

### 6.308 fix(build): bundle orbit-vst3-effect-child #548 (Jul 28, 2026)

**Date**: 2026-07-28
**Status**: 🔄 PR 準備中

**実害**: 出荷された OrbitStudio で VST3 エフェクトを使うと child の spawn が失敗していた。
daemon は `ORBIT_EFFECT_FORMAT=vst3` のとき `orbit-vst3-effect-child` を spawn しようとする
（`outproc_effect.rs:84`・既定パスは daemon と同一ディレクトリ）のに、`copy-daemon-bin.sh` の
再ビルド一覧にも copy 一覧にも含まれていなかった。

**実機で再現・修正を確認**:

```
修正前: ERROR: Failed to load plugin: [OUTPROC_EFFECT_RUNTIME] spawn outproc child
        ".../orbit-vst3-effect-child": No such file or directory (os error 2)
修正後: 52012 .../engine/bin/darwin-arm64/orbit-vst3-effect-child
        --plugin /Library/Audio/Plug-Ins/VST3/Tape Echo v6.vst3 ...
```

**なぜ既存テストで検出できなかったか**: gated テスト（`outproc_effect_vst3_gated.rs:28`）は
自前で `cargo build -p orbit-vst3-effect-child` してから走るため、**バンドル経路を通らない**。
ソースツリーを見るテストでは同じ穴が再発する。

**修正**:
1. `scripts/copy-daemon-bin.sh` の cargo 再ビルド一覧と `copy_binary` 一覧の両方に追加
2. **二重台帳の回帰テスト**（`tests/vscode-extension/bundled-child-binaries.spec.ts`）:
   台帳A = daemon Rust ソース中の child 名リテラル / 台帳B = コピー対象 + バンドル実体。
   A ⊆ B を検査するので、**daemon に format を足すと自動的に要求が増える**

**変異検証（5種・すべて red を確認）**: ①`copy_binary` 削除（元のバグ再現）②`cargo -p` 削除
（stale コピー・#487 再発）③バンドル実体のみ削除 ④daemon literal のリネーム ⑤抽出パターン破壊。

> **④で初版テストの欠陥が発覚**: `orbit-[a-z0-9-]+-child` と綴りを決め打ちしていたため、
> リネームすると**台帳Aが黙って縮んで pass** していた（silent partial coverage）。
> 綴り非依存のパターンに変え、**モジュールごとの抽出件数**を検査するよう修正した。

**#552 も同時に修正**（owner 判断: テスト負債になる前に潰す）: effect の plugin format が
`ORBIT_EFFECT_FORMAT` による **process-global** だったため、CLAP と VST3 のエフェクトを
同一チェーンに混在できなかった。**プラグイン形式は利用者に見えてはならない実装の詳細**
（CAP.6-1）であり、instrument 側（`from_plugin_path`）と同じ per-plugin 解決へ揃えた。
`select_child_exe` トレイトの seam は既にあり、effect 実装が no-op だっただけ。

**🔴 変異検証で配線の穴が発覚**: 純関数 `child_exe_for_attach` のユニットテスト3件を書いても、
**`select_child_exe` を no-op に戻す変異（= 元のバグそのもの）が green のまま生き残った**。
純関数と load 経路を繋ぐ**配線**は別物であり、instrument 側と対称の配線テスト
（`effect_select_child_exe_swaps_default_child_by_extension`）を追加して初めて red になった。

**altitude レビューで出荷ゲートの穴も発覚**: `.github/workflows/release.yml` の
post-package gate（`for CHILD_BIN in ...`）が `orbit-vst3-effect-child` を検査しておらず、
**本バグの再発を防ぐはずのセーフティネット自身が同じ欠落を抱えていた**。ビルド一覧
（`:89`）と gate（`:141`）の両方を修正し、テストの台帳を release.yml まで拡張した。

**検証**: TS 1739 passed（+4）/ fmt・clippy clean /
**env を一切設定せずに VST3 エフェクトが `orbit-vst3-effect-child` を起動**することを実機で確認。

**`/simplify` の指摘を反映（3エージェントが一致して挙げた重複）**:

effect 側に新規追加した `from_plugin_path` / `child_exe_for_attach` は、instrument 側の
同名関数と**列挙型名以外は逐語的に同一**だった。doc コメント自身が「instrument 側と同一規則」
「effect 側と対称」と互いを参照し合っており、**規則を直したとき片方だけ直し忘れる運用**に
頼っていた。#548 がまさに「片方だけ入っていなかった」バグである以上、同じ形を増やすのは筋が悪い。

`outproc_child_exe` モジュールへ規則そのものを抽出し、各 role は**binary 名の対だけ**を渡す形に:

- `is_vst3_plugin_path` / `child_exe_for_attach(current, plugin, clap_name, vst3_name)`
- ログ用の `exe_label`（両 supervisor で重複していた6行）も集約
- 抽出の結果、両 enum の `from_plugin_path` が**デッドコードになったので削除**した
- unit テストは削除した内部メソッドではなく**公開の入口** `child_exe_for_attach` 経由へ付け替えた
  （実際に attach で使われる経路を守る形になる）

**変異検証（4種・すべて red）**: (a) 拡張子判定の反転 (b) 明示指定ガードの無効化
(c) clap/vst3 名の入れ替え (d) ディレクトリを捨てて sibling 解決を壊す。
**いずれも effect と instrument の両方のテストが落ちた** — 規則が本当に共有されている証拠。

**doc の誤りも訂正**: `ORBIT_EFFECT_FORMAT` の存置理由を「gated テストが使うため」と
書いていたが、repo 全体を grep すると**利用者は本ファイルとドキュメントのみ**で、gated テストは
`OutProcEffectConfig` を直接組み立てており env を経由しない。実態（無効値の loud な起動失敗という
既存挙動を黙って変えないため）に書き換えた。

**検証**: Rust workspace 全 green（daemon は `--features outproc-effect,outproc-instrument` で 132 passed）/
TS 1739 passed / fmt・clippy clean。

### 6.307 docs(specs-v2): Phase 0 設計 spec 3本 正本化 #547 (Jul 28, 2026)

**Date**: 2026-07-28
**Status**: ✅ **PR #550 MERGED**（main `cab5c85`・2026-07-28・#547 CLOSED）

**内容**: Epic #546 Phase 0（設計確定）の成果物を spec として正本化。owner が5論点を承認し、
**プラグイン形式に依存しない UX** が中核制約として追加されたことを受けた設計。

- **`docs/specs-v2/PLUGIN_CAPABILITY_ABSTRACTION_v1.md`（新規・CAP.n）**: 形式中立の能力抽象。
  能力一覧（state get/set・dirty・param・preset・UI）・VST3/CLAP/AU 対応表・スレッド境界の契約・
  ループの定義（受け入れの単位）
- **`docs/specs-v2/PLUGIN_UI_HOSTING_SPEC_v1.md`（新規・UIH.n）**: child 実行モデル変更
  （メインスレッドを Cocoa runloop へ・audio を別スレッド退避）・制御語彙拡張（コマンド
  メールボックス）・可変長 state のサイドカー運搬・ウィンドウ所有の統一・アドレッシング・故障モード
- **`docs/specs-v2/PROJECT_FILE_SPEC_v1.md`（新規・PRJ.n）**: `project.yaml` の登記モデル・
  離散セーフポイント方式・復元の単位・優先順位・LLM 対称 MCP 面
- INDEX.md に「VST ワークフロー」spec set の節を追加
- 6.306 の Status をマージ済みへ更新

**🔴 一次ソース照合の結果（設計判断の根拠）**:

- **dirty 通知は VST3 / CLAP の両方に存在する。ただし双方ともプラグインが呼ぶ義務が無い**
  - VST3 `IComponentHandler2::setDirty`（`vst3-0.3.0/src/bindings.rs:6752`）—
    SDK 原文 `ivsteditcontroller.h:311-314`: *"Tells host that the plug-in is dirty
    (something besides parameters has changed since last save), if true the host should
    apply a save before quitting."*
  - CLAP `clap_host_state.mark_dirty`（`clap/ext/state.h`）
  - → **依存できないため離散セーフポイントを基本方式**とし、dirty は受け口を両形式に
    実装した上でセーフポイントを増やす任意の最適化として扱う。変更検知ポーリングは不採用
- **VST3 の `IPlugFrame` は `resizeView` の1メソッドのみ**でウィンドウを閉じた通知が無い。
  CLAP は floating 対応のため `clap_host_gui.closed(was_destroyed)` を持つ →
  両形式とも child 所有 `NSWindow` へ埋め込み、閉じた検出を単一経路に統一
- **CLAP は state 用途を規格として区別**（`CLAP_STATE_CONTEXT_FOR_PROJECT` / `FOR_PRESET` /
  `FOR_DUPLICATE`）— #541 の「登記 vs preset」の切り分けを規格側が裏付けている

**🔴 Fable 独立監査 2 ラウンド（同日）— 実害級の誤りを計3件訂正**:

ラウンド1（初版に対して・5件）:
- **最重要**: 初版は「**VST3 に state dirty 通知は存在しない**」としていたが**誤り**。
  ホストコールバック interface の列挙を `IComponentHandler` で止め、`IComponentHandler2` を
  見落としていた（#527 で記録した「登録済み4ハンドラはすべて正しい」型の誤りと同型）。
  決定①の結論は不変だが**根拠を「VST3 に無いから」→「両形式とも任意だから」へ差し替え**
- 他4件: 登記キーとアドレッシングの不一致 / UI クローズの経路分岐と冪等性 /
  embedded 非対応 CLAP の未規定 / リサイズ応答義務の欠落

ラウンド2（ラウンド1の修正に対して・**修正が新たに持ち込んだ誤り2件を含む**）:
- **A-1（実害級）**: 登記キーの例を `kick/effect/0` と **chain index ベース**で書いてしまい、
  SC.5 規範(1)「(レシーバ, 正規化名, レシーバ内の同名出現順)」と食い違っていた。SC.5 規範(4)(5)
  によりコメントアウト → 再評価で index はずれるため、**delay に reverb の state が適用される**
  silent failure の入口だった → SC.5 の三つ組へ修正し、UIH.5 の位置アドレスとは層が違う
  （揮発的コマンド引数 vs 永続キー）ことを両 spec に明記
- **A-2（実害級）**: `setFrame` を `attached` の**後**に置いていた。SDK 原文
  （`iplugview.h:146`）: *"Note that in this call the plug-in could call a
  IPlugFrame::resizeView ()!"* — attach 中のリサイズ要求を取りこぼす順序だった → 順序を修正し、
  `onSize` 呼び返し義務（`:177-178`）も追加
- **A-3**: child→host の自発イベント経路が語彙に無く、dirty 受信と child 起点クローズが
  セーフポイントを起動できなかった → UIH.2 に `evt_seq` / `evt_kind` / `evt_ack_seq` を追加
- **A-4**: 「Closing 中の要求は無視」が CLOSE_UI の ack を返さず host が永久待機しうる →
  「no-op + 成功 ack」と明記
- 軽微2件（CAP.0 の stale 参照 / CAP.6-7 に「確定後は spec へ反映」）

ラウンド3（fix-scoped・**ラウンド2 で新設したハンドシェイク自体に3件**）:
- **F-1**: 「host の保存完了を待つ」の待ち手が child メインスレッドで、応答（SAVE_STATE）を
  処理するのも同じスレッド → **ブロックすれば必ずデッドロック**。緩く実装すれば保存スキップ。
  完了シグナル（`evt_ack_seq`）の意味も未定義だった
- **F-2**: 経路①のフック点を `windowWillClose` と明記していたが、AppKit が閉じ始めた**後**の
  通知であり、保存の往復を挟めない。VST3 `removed()` は SDK 原文（`iplugview.h:151-152`）
  *"The parent window of the view is **about to be** destroyed"* で親破棄**前**が契約 → 順序が壊れる
- **F-3**: イベント欄を単一スロットで定義したため「取りこぼさない」規律と自己矛盾
- → **UIH.2a（非同期ハンドシェイクのポリシー節）を新設**して一括修正: ①ブロックしない
  （状態機械 + runloop 復帰）②`evt_ack_seq` = host 側処理の完結と定義 ③`UI_CLOSED` は
  取りこぼし不可・`STATE_DIRTY` は合流可 ④紳士協定を作らない（3経路を同一手続きに）。
  UIH.4c をフェーズ A / B の非同期継続へ改稿し、経路①を `windowShouldClose` へ変更
- 併せて: PRJ.4 にファイル名の可逆エンコード要件（`a-b/c` と `a/b-c` の衝突防止）、
  CAP.3a の列挙に `currentPreset` KVO を追加

ラウンド4（owner 指示で上限超過・ハンドシェイクに限定・敵対的）:
- **F-D1（確定デッドロック）**: 経路②が**条文3つから機械的に導ける循環待ち**になっていた。
  UIH.2 規律3（単一メールボックス・ack を待つ間 次を投函しない）+ CLOSE_UI の ack を
  フェーズ B へ遅らせた設計 + `evt_ack_seq` の前進に SAVE_STATE の往復が必要、の3つが噛み合い、
  **host は SAVE_STATE を投函できず child は保存完了を待ち続ける**。症状は
  「`close_plugin_ui` が返らずウィンドウも閉じられない」
  → **ack の意味を二段化**（ポリシー2 新設: コマンドの ack は「受理」であって「完了」ではない）。
  完了は `UI_CLOSED_DONE` イベントで別に通知する
- **F-D2（未規定）**: `Closing` 中の child crash / respawn、host 停滞時の脱出条件が無かった
  → 故障時の脱出条件を表で規定（respawn はメールボックスをリセット・host は登記を触らない /
  host 停滞はタイムアウトで loud + 保存なしクローズ / コマンドにもタイムアウト）
- **D-2（不変条件の継承漏れ）**: 「既存の `seq_tag` / `SLOTS` と同じ」と書きながら、
  その核である slot 再利用ガード（`transport.rs:25-27`・**破れると UB**）を継承していなかった。
  「一周しそうなら合流」という近似表現は**投函済みスロットの書き換え**＝ cross-process の
  torn read と読めた → 不変条件を明記し、合流は child ローカルの pending フラグに限定。
  消費者のいない `UI_RESIZED` は削除（リングを塞ぐだけ）
- **D-3**: 変異検証に4項目追加。最重要は「**規律3 を忠実に守る host モックで経路②を完走**」—
  モックが規律3 を守らないと **F-D1 があっても全項目 green のまま出荷される**

ラウンド5（owner 指示・収束）:
- **F-E1（順序違反）**: フェーズ B のトリガを「`evt_ack_seq` の**前進**」と書いたが、
  同カウンタは全イベント共用。クローズ直前の `STATE_DIRTY` の ack でも前進するため、
  **UI_CLOSED の保存前に解放が走る** → トリガを「`UI_CLOSED` 自身の seq への到達」に限定
- **F-E2a**: host 停滞タイムアウト時の完了通知が無く、MCP `close_plugin_ui` が永遠に完了
  判定できなかった（loud 報告の運搬先も未定義）→ タイムアウト経路でも `UI_CLOSED_DONE` を
  `evt_arg`=timeout つきで投函する1手で3つの穴を閉じた
- **F-E2b**: respawn 時リセットの**主体と順序**が未規定 → host が行う（既存
  `reset_control_run`・`transport.rs:301` と同じパターン）。順序も固定
- **F-E3（データ競合）**: 不変条件は転記したが **Release/Acquire プロトコルを落としていた**。
  鏡像元 `transport.rs:7-9` が明文で定義しているもの → publish プロトコルを表で明記
- 併せて `Closing` 中の `OPEN_UI` を failure ack と規定、変異検証を3項目追加

ラウンド6（収束確認・G-1 の3点(a)(b)(c)はすべて問題なし）:
- **F-G1（データ競合の暗黙依存）**: ラウンド4の改稿で「host は未処理スロットを**順に**処理して
  `evt_ack_seq` を進める」の行を**削除していた**（`git diff c99f81d` で確認）。この行が無いと
  `evt_ack_seq >= s - EVT_SLOTS` の再利用判定が成立せず、host が s-1 を飛ばして s を ack すると
  **child が host の読み取り中スロットへ書き込む**（Release/Acquire では防げない）
  → 「`evt_ack_seq = s` は s 以下すべての完結を意味する・追い越し禁止」を明文化
- **F-G2（取りこぼし）**: `UI_CLOSED_DONE` の再試行規定が無く、`EVT_SLOTS` の下限も未転記
  （鏡像元 `transport.rs:59`「2 以上であること」）→ 取りこぼし不可イベントの再試行を一般化し、
  `EVT_SLOTS >= 2` を明記
- 併せて軽微2件（「死の確認」= プロセス終了でありハング検知ではない / タイムアウト経路の
  arg は「スキップできる」ではなく「判別できる」）と変異3項目を追加

ラウンド7（**収束**・H-1 = 削除行の全数照合は合格 = 「柱落とし」の3連続が止まった）:
- **F-H1**: 正常な teardown（`CONTROL_QUIT`）が in-flight ハンドシェイクと交差した場合が未規定
  → 再試行中の `UI_CLOSED_DONE` が QUIT による child 終了で永遠に投函されず
  `close_plugin_ui` がハングしうる。**唯一残っていた紳士協定**（自らのポリシー5 に反していた）
  → 「host は QUIT を立てる前に in-flight を解決する」を脱出条件表に追加
- 非ブロッキング指摘も採用: `STATE_DIRTY` の in-flight を最大1件に固定し、
  **リング占有の上限を静的に 3 に確定**（`EVT_SLOTS = 3` なら見送りが原理的に起きない）
- Fable 総括「これが入ればハンドシェイク全体について指摘できる実害級は尽きる」

**教訓（3つ・memory 化済み）**:
1. 「既存機構と同じ方式を使う」と書くとき、**その機構の不変条件も一緒に継承する**。
   名前だけ借りると、元が潰したレースを再導入する
2. さらに **「不変条件を継承する」だけでも足りない**。機構の安全性が何本の柱で成立して
   いるかを数え、全部を転記する（今回は不変条件を転記した直後に、同じ機構の
   Release/Acquire を落としていた）
3. **改稿時は `git diff` の `-` 行を読む。** 足したものだけ確認して満足しない。
   ラウンド6 で、自分が前に書いた前提行を削除していたことが判明した（「柱を落とす」3回目）

**AU の一次確認（Codex 到達不能につき自力実施）**: macOS SDK ヘッダで対応表の AU 列を確定。
`fullState`（preset 用）と `fullStateForDocument`（ドキュメント用・*"Hosts saving documents
should use this property"*）を**規格として区別**しており、CLAP の `FOR_PRESET` / `FOR_PROJECT`
と同型 → **3形式のうち2つが区別を持つ**（PRJ.7 を強化）。一方 **AU に dirty 通知は無い**
（通知面を全列挙・`dirty` の語が AudioToolbox ヘッダ全体に存在しない）→ 離散セーフポイント
方式が3形式すべてで成立する唯一の共通解であることが確定。

**実装の現状（コード確認・是正対象）**: state 復元は VST3 instrument のみ（CLAP は
`--state` を明示 `bail!`）／state 取得は VST3 も IPC 未接続・CLAP は `CLAP_EXT_STATE` 未使用／
effect の state は両形式とも引数すら無い／param 列挙・GUI は両形式とも未実装／
**`orbit-vst3-effect-child` が `copy-daemon-bin.sh` のバンドル対象から漏れており VST3
エフェクトが out-of-process で動かない**。

**カタログ層の実測（MCP `list_plugins` / `rescan_plugins`）**: スキャン総数 338 に対し
catalog は 79 件（23.4%）。259 件が `moduleinfo.json` 欠如で skip され、その大半がエフェクト
（TR5 / iZotope / UAD / Kontakt 7,8 / Massive X 等）。「effect の候補が出ない」の主因。

### 6.306 docs: design principles + E2E harness spec 正本化 #544 (Jul 28, 2026)

**Date**: 2026-07-28
**Status**: ✅ **PR #545 MERGED**（main `3ad1c3f`・2026-07-28・#544 CLOSED）

**内容**: 2026-07-28 の owner 設計議論で確定した規範を docs へ昇格（#544）。

- **`docs/core/DESIGN_PRINCIPLES.md`（新規）**: ①LLM-first（「LLM が使えない機能 = このソフト
  ウェアの敗北」・すべての能力はプログラマブル面が先・UI は人間向けビュー・UI 専用例外は
  一度きりの初期化イベントに封じ込め）②人間製成果物への依存禁止（外部 DAW `.vstpreset`
  却下の一般化）③人間と LLM の対称ワークフロー（同じ state に合流・同じ永続化）
  ④意図（.orbs）と登記（プロジェクトファイル）の分離
- **`docs/testing/E2E_HARNESS_SPEC.md`（新規）**: DSL 網羅 E2E の規範（#543）。仕様書駆動・
  **二重台帳の機械監査**（仕様セクション ↔ fixture / 実装 dispatch ↔ fixture・CI 赤）・
  2層構造（オフライン決定論層 = 網羅 / 実機 MCP 層 = 配線代表）・観測タイプ必須・無人実行・
  改ざん耐性（期待値は仕様の式から導出・変異スイープ自動化）・学習サイト双方向監査
- INDEX.md 更新・6.304/6.305 の Status をマージ済みへ更新

**設計議論の記録先**: #541（プロジェクトファイル = 機械が書く登記簿・YAML `states:` のみ・
DAW ループ受け入れ基準）/ #543（ハーネス）/ #474（UI hosting・設計未決）

### 6.305 feat(engine): plugin state restore = sound selection #540 P2 (Jul 28, 2026)

**Date**: 2026-07-28
**Status**: ✅ **PR #542 MERGED**（main `58e16bc`・2026-07-28・#540 CLOSED）。実機 E2E PASS 済み（実 Kontakt + 実 state での音色確認は #546 Phase 3 の受け入れ E2E で実施）

**内容**: `seq.instrument(path[, pluginId][, statePath])` で保存済みプラグイン state
（`.vstpreset` / raw chunk）を復元し**音色を選択**できるようにする。UI なしで音色問題を解く
（音作りは外部 DAW / 将来の #474 UI、選択は OrbitScore 内で完結）。

**設計: spawn 時 CLI 引数（IPC 拡張ゼロ）**:
- child `--state <file>` → load 後・READY publish 前に適用。失敗はハードエラー
  （default 音のまま黙って鳴らさない）。**respawn でも同引数で再適用**される
- `.vstpreset` parser を orbit-vst3-host に新設（header 48B + List chunk table・
  Comp/Cont 抽出・magic 無しは raw chunk 扱い・magic ありで壊れていれば明示エラー）。
  復元順序は VST3 公式 FAQ: component setState → controller setComponentState →
  controller setState。class ID は照合しない（byte-order 誤検知 > 利得・plugin 自身が拒否する）
- wire: LoadPlugin `state_path`（instrument 専用・effect に付けば MALFORMED）。
  **state はロード identity の一部**（同 plugin 別 state の再宣言 = 差し替え要求 → v1 拒否）
- DSL: 第2引数の拡張子ヒューリスティック（`.vstpreset`/`.state` = state・他 = pluginId）+
  3引数明示形。相対パスは document directory 基準（検索パス不使用）
- CLAP は明示エラー（Kontakt = VST3 が本命・後続で clack state ext）

**spec**: PH.1 に state 引数を追記。PH.4 の「後勝ち差し替え」規範に v1 staging 注記を追加
（現実装は明示拒否・履行先 #522 SC.5）。

**検証**:
- Rust: orbit-vst3-host 6 passed（parser 4種 + 既存2）・daemon lib 120 passed
- **変異検証**: (C) Comp チャンク不採取 → 2件 red / (D) chunk 境界チェック除去 → 1件 red。復元後全緑
- TS フルスイート **1728 passed / 29 skipped**（+5: state 解決・identity・ヒューリスティック）

**Commit**: `d2bb780`

### 6.304 feat(engine): per-sequence instrument instances #540 P1 (Jul 28, 2026)

**Date**: 2026-07-28
**Status**: ✅ **PR #542 MERGED**（main `58e16bc`・2026-07-28）

**背景**: 2026-07-29 の作品制作（owner）に「シーケンスごとに別 instrument」と「音色の変更」が
必須。instrument はアプリ全体で1台（daemon `Mutex<Option<...>>` / TS 単数ガード）だった。

**設計**: **instrument slot pool** — audio graph / shm / note ring は stream 起動時に固定で
焼かれるため、effect の per-bus slot と同方式で **N slot（`ORBIT_OUTPROC_INSTRUMENT_SLOTS`・
default 8）を起動時に事前確保**し、`LoadPlugin` の `instance` param で slot を割当てる。
動的グラフ変更を回避。idle slot は engaged=false で即 return（コストほぼゼロ）。

**Rust**: `OutProcInstrumentControl` を `slots: Vec<InstrumentSlotEntry>` + `instance_index` に
再構成。`CompositePostProcessor.instruments` Vec 化。both / instrument-only 両起動経路を pool
ループ化。`PluginNoteOn/Off` に `instance` param（未割当 instance へは明示エラー — 旧単数時代は
ring に積んで黙って捨てられていた）。pool 枯渇は env-var ヒント付き明示エラー。
health は全 slot 合算・stats accessor は互換（slot 0）+ `outproc_instrument_stats_for(instance)`。

**TS**: note 側 `resolveNoteTarget()` が既に per-note で `plugin:<seqName>` port を運んでいた事実を
利用し、**`PluginNoteOutput` の port をそのまま wire の instance に転用**（scheduler 層は無変更・
rtmidi/IAC 経路に不接触）。`PluginInstrumentManager` を per-seq key 化（宣言 instance も同じ
`plugin:<seqName>` 規約）。`RustEnginePlayer` の cache / self-heal / respawn replay を
instance キー化（`pluginKey()`）。

**検証**:
- Rust lib 120 passed（+3 新規: slot routing / unknown-instance / pool 枯渇 vs 既存 instance 区別）
- **変異検証**: (A) instance 無視・常に slot 0 → 3件 red / (B) 枯渇チェック除去 → 1件 red。復元後全緑
- TS フルスイート **1723 passed / 29 skipped**（+1。IAC 保護対象 sequence-midi-dispatch 13件は無傷で全緑）

**Commit**: `1dae696`

### 6.303 chore(test): vitest を単一バージョンに統一 #531 (Jul 27, 2026)

**Date**: 2026-07-27
**Status**: ✅ 完了（PR #539 MERGED `dc080e2`）

**内容**:
同一リポジトリに vitest が2系統インストールされていた（`packages/engine` = 2.1.9 /
ルート = 3.2.6）。PR #527 で `vscode` の alias を持つ**共有 `vitest.config.ts` をルートに新設**し
両スクリプトから参照するようにしたため、**1つの設定ファイルが2つのメジャーバージョンから
読まれる**状態になっていた。

**対応**: `packages/engine` から vitest 依存を落とし、ルートの hoisted 版のみを使う。
両経路とも 3.2.6 に統一。`package-lock.json` は 232 行削減。本番コードは無変更。

**検証（すべて条件を揃えて実測）**:

| 検証 | 結果 |
|---|---|
| `npm test`（cwd=packages/engine） | 1722 passed / 29 skipped（**件数変化なし**） |
| ルートからの実行 | 270 passed |
| **CI 相当環境（隔離 worktree・`engine/dist` なし）** | 1722 passed / 29 skipped |
| 両経路の vitest | **3.2.6 に統一** |

2.x → 3.x で**テストが silently skip される**可能性があったため、件数が1件でも減ったら
停止する条件を委譲時に課した。減っていない。

**発注側の失敗（記録・本日3度目の同種）**: 隔離 worktree での検証中、
**変更あり / origin/main の2つの worktree で `packages/engine/node_modules` の
リンク状態が違っており、条件が揃っていない比較**をした。`uuid` はそこにしか無いため
リンクが効いていない方だけが落ち、それを見て「変更起因の退行」と**誤って断定した**。
条件を揃え直したら両方 1722 passed。**検証手順そのものを検証していなかった。**

**#537 の教訓を適用した点**: 本体の `packages/vscode-extension/engine/` を mv で退避する方法は
使わず、`git worktree` の隔離コピーで CI 相当環境を作った（退避方式は中断されると環境が壊れる）。

### 6.302 fix(test): ユニットテストのビルド生成物依存を解消 #537 (Jul 27, 2026)

**Date**: 2026-07-27
**Status**: 🔄 レビュー待ち

**内容**:
PR #535 のマージ後、**CI で main が赤くなった**。

**症状**: `start-engine-for-agent.spec.ts` の成功パスが CI（Linux）でのみ失敗し、
`ok: true` を期待して `ok: false` を受け取る。

**原因（実証済み）**: このテストは `child_process.spawn` **のみ**をモックし、本物の
`startEngine()` プリフライトを通す。そのプリフライトの `resolveDaemonForUI()` が
`require('../engine/dist/audio/rust-engine/daemon-client')` を呼ぶが、
**`packages/vscode-extension/engine/` は gitignore されたビルド生成物**である
（`.gitignore:47`）。そして `.github/workflows/code-review.yml` は
**`npm test` を `npm run build` より先に**実行する。よって CI のテスト時点で
`engine/dist` が存在せず、daemon 解決に失敗して `startEngine()` が false を返す。

**修正**: `require` の境界を `engine-startup-runtime.ts` に切り出し、ユニットテストが
そこを差し替えられるようにした。本番の挙動は不変（呼び出しを1段挟むのみ）。

**fail-before / pass-after を隔離 worktree で取得**:

| | CI 相当環境（`engine/dist` なし） |
|---|---|
| 修正前（`origin/main`） | **4件以上 FAIL**（`engine-command-awaits.spec.ts` の全テスト） |
| 修正後 | **1722 passed / 29 skipped** |

**CI ログは最初の失敗しか見せておらず、影響範囲を過小評価していた** — 実際は当該 spec の
全テストが同じ原因で落ちていた。

**発注側の失敗（記録）**:

1. **CI 確認とマージを同一コマンドで実行した**。`code-review fail` を見た時には既に
   マージ済みだった。`merge --admin` の指示は「CI を見なくてよい」ではない。
   **少なくとも失敗の存在を報告してから実行すべきだった**
2. **検証手順が環境を壊しうる形だった**。「`engine/dist` を退避して `npm test`」という
   条件を課したが、これは中断されると環境が壊れる。実際 API 529 エラーで Codex が中断され、
   `dist.bak` のまま取り残された。**`git worktree` で隔離コピーを作るべきだった**
   （ラウンド2のレビュアーは同じ状況で自主的にそうしていた）
3. **swap 中の一瞬を観測して「復元されていない」と誤報した**。1回目の観測は
   Codex が退避・復元している最中で、環境は無事だった。慌てて報告した

**検証**: `npm test` 1722 passed / 29 skipped・CI 相当環境でも 1722 passed・
`tsc --build` 通過・lint エラー0。

### 6.301 fix(extension): engine プロセスライフサイクルの残穴を塞ぐ #532/#533/#534 (Jul 27, 2026)

**Date**: 2026-07-27
**Status**: 🔄 レビュー中（新フロー初適用）

**内容**:
PR #527 の受け入れ監査（Fable）が見つけた**既存バグ2件**と、同 PR のコードに残った Minor 1件。
いずれも #528 の物語の直接の続き（孤児デーモン・UI と実体の乖離）で、
**内部レビュー5ラウンドと bot レビューを通り抜けた**もの。

**#533 — `ChildProcess` 本体の `'error'` ハンドラが未登録**: `startEngine()` は
stdout / stderr / exit / stdin-error の4つを登録するが、**`engineProcess.on('error', ...)` が
無かった**。実害は2つ: (1) EventEmitter の規約上リスナ不在の `'error'` は throw され
uncaughtException になる (2) **spawn 失敗時は `'exit'` が発火しない場合があり**、
`engineProcess` が `killed === false` のまま残留して `get_engine_state` が `running: true` を
返し続けるのに実体が無い（#528 が潰した乖離の鏡像）。

既存4ハンドラと同じ様式で `setupErrorHandler` + `applyEngineError`（identity ガード付き）を追加。

**さらに `startEngineForAgent` の spawn 後チェックがこの経路を検出できないことが判明**。
Node は spawn 失敗を `process.nextTick` で遅延 emit するため、同期チェックでは間に合わない。
`async` 化して1 tick 待ってから再チェックする形にした。

**この機構を実証で確認した**（コメントの主張を鵜呑みにしない）:

```
順序: ["error:ENOENT", "after-our-nextTick"]
killed: false / exitCode: -2
```

`'error'` は後から積んだ `nextTick` より先に処理される（FIFO の主張は正しい）。同時に
**`killed: false`** も確認でき、**旧実装が成功を返していたというバグの前提そのもの**が
裏付けられた。

**#532 — `stopEngine()` の SIGKILL エスカレーションが dead code**: `subprocess.killed` は
「**シグナル送信に成功したか**」であり「終了したか」ではない（`@types/node` が明言）。
SIGTERM 送信成功で `killed === true` になるため `!proc.killed` は恒偽で、**SIGKILL は絶対に
発火しなかった**。`proc.exitCode === null && proc.signalCode === null` に修正。

**#534** — `logHandlerFailure` が `outputChannel` の null 時に `?.` で無音 no-op になる点を
`console.error` フォールバックで塞ぎ、crash-containment コメントの断定
（「拡張ホストがクラッシュする」）を不確定な書き方に改めた（bot と受け入れ監査で主張が
食い違っており、どちらとも確定していないため）。

**main 側の受け入れ検証で見つけた自分の誤り**: 変異 #532 の1回目で「221件すべて緑＝検出
できない」と読みかけた。`grep -c MUTATION` が 1 を返したので適用済みと判断したが、
**それは行数を数えただけで狙った行に当たった保証ではない**。行を明示して当て直したところ
正しく red になり、委譲先の報告が正しく**私の検証が誤っていた**と判明した。
6.299 で「変異の適用を確認せよ」と学んだが、**確認の粒度が甘かった**。
今後は「マーカーの有無」ではなく**変異後の当該行そのものを表示**する。

**迷子ファイル**: リポジトリ直下に `packages/vscode-extension/src/extension.ts` と同一内容の
未追跡 `extension.ts`（149KB）が残っていた（lint エラー1件の原因）。削除済み。
`git add -A` していたら混入していた。

**検証**: `npm test` 1709 passed / 29 skipped（1696 → +13）・`tsc --build` 通過・lint エラー0・
実機 gated E2E 1 passed・孤児デーモン 0。

**レビュー運用**: 本 PR から新フロー（チーム1ラウンドと Fable 監査を**並行**起動 → 修正前に
設計パス → 同一ラウンド内で fix 再点検 → provenance で打ち切り）を初適用する。
計測のため**指摘の provenance 内訳（original-diff 起因 / fix 起因）を記録**する
（claude-tools#291 の検証データになる）。

### 6.295 fix(extension): engine 再起動時の孤児化と capture 要求の握り潰しを修正 #528 (Jul 27, 2026)

**Date**: 2026-07-27
**Status**: 🔄 レビュー中（PR #527 に同梱）

**内容**:
gated E2E の音声アサーションが「27秒キャプチャ・peak 0」で落ちていた件（#528）を追ったところ、
**ハーネス起因の1件と本番バグ2件**が出た。テストを直す過程で本番の欠陥が見つかった形。

**(1) フィクスチャの深さ喪失（ハーネス）**: `kick_loop.orbs` は
`audioPath("../../../test-assets/audio")` という**相対形そのものがアサーション**で、
`setDocumentDirectory` が「編集中ファイル自身のディレクトリ」を基準に解決することを証明している
（ファイル内コメントに明記）。#392 でこれを**フラットな tmpRoot へコピー**したため `../../../` が
tmp の外へ登り、`[SAMPLE_NOT_FOUND]` → 無音キャプチャになっていた。パスを絶対化すると意図した
アサーションが死ぬため、**tmpRoot 配下にディレクトリ深さを再現**する形で修正した。

**(2) exit ハンドラが identity を確認していない（本番バグ）**: `setupExitHandler` は
どのプロセスの exit かを問わず `engineProcess = null` 等を実行していた。Node の `'exit'` は
非同期に届くため、**stop_engine → start_engine を素早く行うと、既に spawn 済みの新 engine の
ハンドルを古いプロセスの exit が消す**。結果デーモンは鳴ったまま孤児化し、UI は "Stopped"、
`stop_engine` でも落とせず evaluate も不通になる。デバイス変更やハング後の再起動という
日常操作で踏む。実際、修正前の失敗実行はオーディオデバイスを掴んだデーモンを毎回1つずつ
残していた（次の実行の自動起動が失敗する二次被害まで観測）。`engineProcess !== process` の
時は後片付けを行わないガードを追加。

**(3) capture 要求の握り潰し（本番バグ・silent failure）**: `startEngineForAgent` は engine が
既に走っていると `ok: true, 'engine already running'` を返し `captureWav` を**黙って捨てて**いた。
capture は spawn 時の `ORBIT_CAPTURE_WAV` でしか有効化できないため、呼び出し側は録れていると
信じたまま capture.wav を読む段で ENOENT に遭う（agent には原因不明の失敗に見える）。
拡張は activate 時に engine を自動起動するので**これは例外ではなく既定の経路**。明示エラーに変更。

**(2') 同一バグクラスの横展開（`/simplify` altitude 指摘）**: (2) を直しただけでは片手落ちで、
**同じ機序の兄弟ハンドラが無防備**だった。`stdout` の `'data'` ハンドラは古い process の残バッファが
遅れて届くと、新 engine のライブ playhead 装飾を消し、status bar を巻き戻し、stale な
`//#selectAudioDevice` 応答を新 engine の待ち行列に FIFO マッチさせる（#501 review Critical #1 が
exit 経路について懸念していたのと同じ機序）。`stdin` の `'error'` ハンドラも identity 未確認で
`drainAll` を呼んでいた。いずれも identity ガードを追加。**ログの転記は無条件のまま残した** —
停止中 engine の最終出力は診断上むしろ必要で、守るべきは共有状態への書き込みだけのため。
`stdin` ハンドラは他と同じ体裁の `setupStdinErrorHandler()` に切り出した。

なお altitude レビューは follow-up 候補も挙げた（`selectAudioDeviceBridge` の generation-aware 化 /
状態リセット三つ組みの重複 / `isEngineRunning()` を使わない重複条件 / spawn 時限定オプションの
中央検証）。いずれも本 PR のレース修正とは軸が違うため見送り。

**テストの積み上げ**:
- E2E に自動起動 engine の停止 → capture 付き再起動の手順を追加（(2) を回帰カバー）
- E2E に「走行中の capture 付き start_engine は失敗する」ステップを追加（(3) を回帰カバー）
- engine が上がらなかった場合に output channel を例外へ添える診断を追加
- **ミューテーション検証**: audioPath を存在しないディレクトリに倒すと `peak: 0` で落ち、
  (3) のガードを外すと `engine already running` で落ちることを実測。両アサーションが
  load-bearing であることを確認した
- `test:e2e:gated` スクリプトを追加。vitest にパスを渡すと**フィルタ文字列**として解釈され
  `.claude/worktrees/` 内の古いコピーまで一致し、実機 OrbitStudio を7個同時起動していた。
  `--dir tests` でグロブ基点を固定した

### 6.300 fix(extension): 例外隔離の自己防御と containment の対称化 #527 レビューR5対応 (Jul 27, 2026)

**Date**: 2026-07-27
**Status**: 🔄 bot レビュー待ち（PR #527）

**内容**:
ラウンド5は **Critical 0 / Important 0**。ラウンド4の Important 2件はいずれも CLOSED と
判定され、**内部レビューが収束した**。判定はレビュアーが自ら変異を実行して再現したもので、
差分の読み直しによる自己申告ではない（順序反転で23件緑のまま / 実体入れ替えで1件のみ red）。

`get_log` 経路も実装まで裏取りされた: `outputChannel` は `activate()` で生成され
`pushLogRing` にタップされてリングバッファに載るため、ハンドラが発火しうる時点では
null になり得ない（null になるのはテストが注入した場合のみ）。つまり try/catch は形を変えた
握り潰しではなく、エージェントから観測可能な loud failure である。`vi.mock` のリークも
`tests/vscode-extension/` 配下60ファイル1000テストを実行して否定された。

**残る Minor 3件のうち2件を本 PR で閉じた**:

1. **`logHandlerFailure` 自身の自己防御** — `outputChannel.appendLine` が throw すると、
   その例外が catch ブロックから再脱出し**まさに防ごうとした拡張ホストのクラッシュを起こす**。
   内部 try/catch で包み `console.error` にフォールバックした。Fable も独立に同じ穴を
   指摘しており（「loud failure の定義を `get_log` から観測可能に置くなら、その経路自体が
   optional chaining で切れるのは自己矛盾」）、二者が別経路で同じ結論に達した。
2. **`setupStderrHandler` の containment 対称化** — 他3ハンドラに付けたコメントが
   「このハンドラ内のあらゆる例外が拡張ホストを落とす」と一般論として述べているのに、
   stderr だけ未適用だった。同じ形で包んだ。

**見送った1件**: 人間ユーザーへの可視性が Output パネルのみ（トースト無し）。旧挙動
（ホストクラッシュ）は確かに loud だったが、**それを可視性の手段とは呼べない**。
エージェント向けには `get_log` で十分 loud であり、トースト追加は別の UX 判断とした。

**Fable の bot レビュー判断**: 「受ける。ただし `ded6a84`（前回 bot 通過時点）以降の
**本番コードのみ**にスコープを絞る」。根拠 — 前回通過後に約2,100行（本番 TS は
`extension.ts` +333 / `engine-lifecycle.ts` 新規252）が積まれ、しかもその内容は
「TS データモデルのリファクタ」ではなく**プロセスライフサイクル**であり、本プロジェクトの
事故史で「ユニットテストと机上レビューが最も弱い」と実証済みのコードクラス。よって
「レビュー機構は差分規模に見合わせる」原則は **bot 実施を支持する側**に働く。
内部レビュー5ラウンドは強いが全員 Claude 系であり、系統の異なる目の限界費用は低い。
テストインフラは変異検証の方がレバレッジが高いので bot スコープから除外。

**E2E に足さないと決めた点**: Fable は「`🛑 internal error` マーカーが gated E2E の
`get_log` からアサートされているか」を確認せよと述べたが、**この経路は実機で意図的に
起こせない**（ハンドラ内で例外を起こすには fault 注入が要る）。ユニットテストで押さえるのが
妥当と判断し、E2E には足さない。できないことを「やった」と報告しないための明示。

**変異検証（main 側で独立に再実行・適用確認つき）**: (1) `logHandlerFailure` の内部
try/catch を外す → 1件 red / (2) `setupStderrHandler` の catch を外す → 1件 red。
いずれも restore で25件緑に復帰。**6.299 の反省を踏まえ、変異がファイルに実際に適用された
ことを確認してからテストを走らせた。**

**検証**: `npm test` 1696 passed / 29 skipped（1694 → +2）・`tsc --build` 通過・lint エラー0・
実機 gated E2E 1 passed・孤児デーモン 0・CI 4チェック全 green。

### 6.299 fix(extension): ハンドラ例外の隔離と、存在しない契約に依存したテストの是正 #527 レビューR4対応 (Jul 27, 2026)

**Date**: 2026-07-27
**Status**: 🔄 レビュー中（PR #527 に同梱）

**内容**:
ラウンド4は **Critical 0 / Important 2**。pr-test-analyzer は20種の変異を実走させ、
ラウンド3の指摘を全件 CLOSED と判定し新規指摘なし（stdout 7 / exit 6 / stdin 2 の全スロットを
個別に no-op 化して全て red、`transportStatusText` の4文字列を個別に破壊して全て red、
テスト用 seam に嘘をつかせる変異でも即 red）。残る Important 2件はいずれも 6.298 で
私が持ち込んだもの。

**Important 1 — silent failure を潰して、より悪い故障を作っていた**: 6.298 で足した
`transportStatusText` の網羅性ガード（`throw`）は **stdout の `'data'` ハンドラ内**で走るが、
`extension.ts` には `process.on('uncaughtException', ...)` も当該リスナを包む try/catch も
無かった。Node のストリーム emit から同期的に例外が抜けると、**OrbitScore だけでなく
拡張ホストのプロセス全体（他の拡張も含む）が落ちる**。status bar の破損を防ぐために
ホスト全体を落とすのでは割に合わない。

さらにこれは**より広い既存の危険**を照らしていた — ガード固有ではなく、stdout / exit / stdin
ハンドラ内の**あらゆる例外**が同じ経路でホストを落とす。3つのリスナ本体を try/catch で包み、
`logHandlerFailure()` がマーカー付き（`🛑 internal error in <handler名>:`）+ スタックトレースで
output channel に記録する形にした。**握り潰しではない** — このプロジェクトでは
「エンジン側のエラーは output channel にしか出ない」が原則で、`get_log` から観測できることが
loud failure の定義である。`transportStatusText` の `throw` は意図が正しいのでそのまま残した。

**Important 2 — 正しいコードで落ちるテストを作っていた**: 6.298 の
`clearEngineState` ⇄ `clearAllPlayheads` swap 検出は「どちらが先に走ったか」に依存していたが、
**この2つに順序の契約は存在しない**。`applyEngineExit` の docstring を実読して確認した ——
identity ガードの理由しか書かれておらず、順序には一切言及がない。将来「装飾を消してから
状態を null にする」という等しく正しい並べ替えをすると、欠陥が無いのにテストが落ちる。

`vi.mock` の pass-through spy で `setupExitHandler` に渡される実 effects オブジェクトを捕獲し、
`clearEngineState()` / `clearAllPlayheads()` を**個別に呼んで**固有の副作用を検証する形に
置き換えた。**受け入れ条件を2つ課した**: 実体の入れ替えで red / `applyEngineExit` 内の
呼び出し順を反転しても green のまま（＝存在しない契約に依存していないことの証明）。
両方とも main 側で実測した。

**レビュアー同士の対立を一次情報で裁定**: 順序テストの頑健性について
code-reviewer は「文書化されていない実装詳細への依存」、pr-test-analyzer は
「文書化済みの契約なので頑健」と判定が割れた。main 側で docstring を実読し、
**pr-test-analyzer の主張が誤り**であることを確認して code-reviewer の指摘を採用した。
委譲先の判定を鵜呑みにしない受け入れ検証規律が効いた事例。

**変異検証（main 側で独立に再実行）**: (A) `clearEngineState` ⇄ `clearAllPlayheads` の実体
入れ替え → 1件 red / (B) `applyEngineExit` 内の呼び出し順を反転 → **23件 green のまま** /
(C) stdout ハンドラの catch を再 throw に変更 → 1件 red
（`expected [Function] to not throw an error but 'TypeError: ...' was thrown`）。
いずれも restore で全緑に復帰。

なお (A) は**1回目の変異が pattern 不一致で当たっておらず**、「23 passed」を検出失敗と
誤読しかけた。実ファイルの形を確認して当て直した（try/catch 導入でインデントが変わっていた）。
**変異が実際に適用されたことを確認せずに緑を読むと、検証したつもりで何も検証していない。**

**検証**: `npm test` 1694 passed / 29 skipped（1691 → +3）・`tsc --build` 通過・lint エラー0・
実機 gated E2E 1 passed・孤児デーモン 0。

### 6.298 test(extension): 配線カバレッジの過大申告を是正 #527 レビューR3対応 (Jul 27, 2026)

**Date**: 2026-07-27
**Status**: 🔄 レビュー中（PR #527 に同梱）

**内容**:
ラウンド3（Critical 2 / Important 2 / Minor 4）への対応。ラウンド2の C2 / C3 / I4 / I5 は
独立検証で CLOSED と判定されたが、**C1（配線）は NOT CLOSED** だった。

**「配線をテストした」は過大申告だった**: 6.297 で配線テストを新設したが、レビュアーが
変異を実際に走らせた結果、**約13スロット中7つが今も無検出で入れ替え・空実装化できる**ことが
判明した。

| 生き残った変異 | 見逃した原因 |
|---|---|
| `clearEngineState` ⇄ `clearAllPlayheads` の入れ替え | 両方が無条件に走るため「最終状態」しか見ておらず、**どちらがやったか**を区別していない |
| `setupStdoutHandler` の `handleStep` / `clearSequence` / `clearAllPlayheads` / `handleSelectAudioDeviceLine` を全部 no-op 化 | 7つの実エフェクトのうち配線テストがあるのは `setTransportStatus` だけだった |
| ログ/診断4系統（`transcribeLog` / `logExit` / `logStdinError` / `warnMalformedSelectAudioDeviceLine`）を個別に no-op 化 | `outputChannel` の**出力内容**を検証するテストが皆無だった |

特に痛いのは最後の `warnMalformedSelectAudioDeviceLine` — **6.297 で「stale でも消えないように」
直した診断そのもの**で、呼ぶか否かの純粋ロジックは厚くテストされているのに、実際に
output channel へ出る配線は誰も検証していなかった。

**対応**: `clearAllPlayheadDecorations` の独立観測用 seam を追加し、`editor.setDecorations` が
呼ばれた**瞬間**に `engineProcess` が既に null かを記録することで「`clearEngineState` が先に
走ったか」という順序を観測できるようにした（両者は相互非依存なので最終状態では区別できない）。
stdout の4エフェクトには playhead timeout 数 / active range 数 / `DeviceSwitchBridge.send()` の
実解決を使った独立アサーションを、ログ4系統には fake `outputChannel` に実際に append された
**文言の内容**検証を追加（文言は実装を読んで部分一致で検証・捏造なし）。

**`setTransportStatus` の網羅性ガード（Important 2）**: 三項演算子だったため `'playing'` 以外が
来ると**黙って `'ready'` 側に落ちる**。現在の呼び出し側はリテラルのみで型に守られているが、
この畳み込みを「取り違えを表現不能にする」と説明したのは**スロット入れ替えについてのみ真**で、
不正入力は防がない。`transportStatusText(state, debugMode)` を `switch` +
`default: { const _exhaustive: never = state; throw }` で実装し直した。

**E2E の無意味な追加を撤回（Minor 1）**: 6.297 で足した「debug 拒否後の `running === true`」は、
capture 拒否と**同一の early return** を通るため検出力を増やしていなかった。削除した。
E2E は足せばよいというものではない、という自戒として記録する。

**変異検証（main 側で独立に再実行）**: (A) `clearEngineState` ⇄ `clearAllPlayheads` 入れ替え →
1件 red / (B) `warnMalformedSelectAudioDeviceLine` を no-op 化 → 2件 red /
(C) `transportStatusText` を三項に戻す → 1件 red。いずれも restore で全緑に復帰。

**検証**: `npm test` 1691 passed / 29 skipped（1678 → +13）・`tsc --build` 通過・lint エラー0・
実機 gated E2E 1 passed・孤児デーモン 0。

**申し送り**: 委譲先が `audio-device argv` テストの flaky な失敗を1度観測している（再実行で緑・
本変更と無関係）。main 側の3回の `npm test` では再現せず。

### 6.297 test(extension): 配線をテスト可能にし、弱いアサーションを潰す #527 レビューR2対応 (Jul 27, 2026)

**Date**: 2026-07-27
**Status**: 🔄 レビュー中（PR #527 に同梱）

**内容**:
ラウンド2（Critical 3 / Important 3 / Minor 4）への対応。ラウンド1の指摘は4レビュアーとも全件
CLOSED と判定された一方、**新規テスト自体に穴が見つかった**。

**「変異検証をやった」は壊し方が1種類に偏っていた**: 6.296 では「ガードを無効化する」変異
（5種）で red を確認したが、レビュアーが**別種の変異を実行して3つが生き残る**ことを示した。

| 生き残った変異 | 見逃した原因 |
|---|---|
| bridge を同じ行に2回呼ぶ | `toHaveBeenCalled()` が回数を見ていない |
| `handleStep` 後の `continue` を削除 | 同上（引数も見ていない） |
| `applyEngineExit` の副作用順序を逆転 | 個別 mock のみで順序を見ていない |
| `stale` 引数を `true` に固定 | current × パース失敗の経路が未カバー |

FIFO キューを消費する副作用（`DeviceSwitchBridge.handleLine`）では**回数がそのまま正しさ**。
`toHaveBeenCalledTimes` / 引数検証 / `mock.invocationCallOrder` で全4種を殺せるようにした。
教訓は CLAUDE.md に固定（変異は最低4種 = 分岐反転・回数・順序・引数）。

**stale な正常行が「malformed」と誤報されていた（2レビュアーが独立に指摘）**: 6.296 で足した
診断に鏡像の欠陥があった。`recognized = isCurrent && handleSelectAudioDeviceLine(...)` は
`&&` の短絡で stale 時に**パースを試みることすらせず**、完全に正しい JSON も「malformed
（chunk-boundary split の疑い）」と報告していた。stop → start のたびに偽警告が出続け、
**本物の破損が起きた日にその警告が無視される** — 診断を足した目的そのものを壊す。
「妥当な JSON か」（`parseSelectAudioDeviceResultLine` による純粋判定）と「FIFO を触ってよいか」
（`isCurrent`）を分離した。

**配線（wiring）にテストが無かった（owner 指示で本 PR 内に取り込み）**: 純関数へ抽出しても、
純関数と本物の副作用を繋ぐ配線は無防備なまま。`() => void` 型の兄弟コールバックは
**取り違えても型チェックを通り、ユニット・E2E とも全件 green**。当初 #530 に切り出したが、
owner 指示（「このフォローアップは早めに確実に…しっかり塞いで再発防止」）により本 PR で対応:

1. **型で潰す** — `setPlayingStatus()` / `setReadyStatus()` を
   `setTransportStatus(state: 'playing' | 'ready')` 1本に畳み、取り違えを**表現不能**にした
2. **`vscode` モックで実際に叩く** — `tests/mocks/vscode.ts` と `vitest.config.ts` の alias を新設し、
   `extension.ts` の `setup*Handler` を直接呼んで配線を検証（`tests/vscode-extension/
   extension-wiring.spec.ts`・9件）。`extension.ts` にはテスト専用 export を追加し、用途と
   「本番コードから呼ぶな」を明記

なお `showStoppedStatus` / `refreshEngineView` は毎回両方呼ばれるため、**最終状態だけを見る
素朴なアサーションでは入れ替え変異を検出できなかった**（委譲先が一度実装してから気づき、
発火順序を記録する方式に作り直した）。

**受け入れ検証で見つけた設定の脆さ（main 側で修正）**: 委譲先は alias を
`packages/engine/vitest.config.ts` に置いたが、これは **cwd 依存**で `npm test`
（cwd=packages/engine）でしか効かない。リポジトリルートから走らせると
`Cannot find package 'vscode'` で落ちる（`test:e2e:gated` はルートから走る）。
設定をルート `vitest.config.ts` の単一正本に寄せ、両スクリプトに `--config` を明示して
起動パス非依存にした。

**変異検証（5種・すべて main 側で独立に再実行）**: (a) bridge 二重呼び出し / (b) `continue`
削除 / (c) `applyEngineExit` 順序逆転 / (d) `stale` 引数固定 / (e) `extension.ts` の
`showStoppedStatus` ⇄ `refreshEngineView` 配線入れ替え —— いずれも対応テストが red、
restore で green。(e) は `expected [ 'refresh', 'status-stopped' ] to deeply equal
[ 'status-stopped', 'refresh' ]` で検出。

**検証**: `npm test` 1678 passed / 29 skipped（1664 → +14）・ルートからの単独実行も 9 passed・
`tsc --build` 通過・lint エラー0・実機 gated E2E 1 passed・孤児デーモン 0。

**残存ギャップ**: `clearEngineState` / `clearAllPlayheads` 同士の入れ替えは順序ベースの検証を
まだ入れていない（`clearEngineState` は `engineProcess` の null 化という個別の観測可能な
副作用でのみ検証）。

### 6.296 refactor(extension): engine ライフサイクルの判断を vscode 非依存に抽出 #528 レビュー対応 (Jul 27, 2026)

**Date**: 2026-07-27
**Status**: 🔄 レビュー中（PR #527 に同梱）

**内容**:
6.295 に対する `/code:pr-review-team` ラウンド1（Critical 2 / Important 5 / Minor 3）への対応。

**Critical 1 — identity ガードにテストが1件も無かった**: しかも E2E は stop 後に
`waitForEngine(false, ...)` で完全停止を待ってから起動するため、**守るべきレース窓を
テスト自身が消していた**。

当初「狭いタイミング窓に依存するので決定論的テストは書けない」と申告したが、これは
問題の切り分けが誤っていた。**ガードは純粋な状態比較であり、テストにタイミングは要らない** —
古いプロセスのハンドラを登録 → 現役を別プロセスに差し替え → 古い方でイベント発火、で
決定論的に再現できる。真の障害はハンドラが module-private かつ vscode 密結合だったこと。

そこで `packages/vscode-extension/src/engine-lifecycle.ts`（**`vscode` を import しない**）を
新設し、既存の `device-switch-bridge.ts` / `playhead.ts` と同じ抽出様式に揃えた:

- `applyEngineStdoutChunk(output, lines, isCurrent, effects)`
- `applyEngineExit(code, isCurrent, effects)`
- `applyEngineStdinError(message, isCurrent, effects)`
- `decideStartEngineForAgent(engineRunning, options)`

可変状態（`engineProcess` 等）への代入は `extension.ts` 側のコールバックに残し、新モジュールは
状態を持たない。副作用の順序と `drainAll` の理由文字列は逐語で保存した。

**Important 1 — `debug` に同じ silent-discard バグが生きていた**: `captureWav` だけを特別扱い
したため、走行中の `start_engine({ debug: true })` は `ok: true` を返して verbose ログが付かない
ままだった。`debug` も spawn 時限定（`--debug` を spawn 時にのみ渡す）。両方を
「spawn 時限定オプション」として一括で拒否する形に統合。

**Important 2 — 宣言した不変条件を実装が破っていた**: 「ログの転記は無条件」と書きながら、
malformed な `//#selectAudioDevice` 行の警告はガード内側にあり stale では消えていた。しかも
消えるのはチャンク境界で JSON が割れる再起動近傍 —— この警告が存在する理由そのものの場面。
診断であって状態変更ではないので、ガードの外へ出した（stale である旨も文言に含める）。

**Important 4 — コメントが実装を過大に述べていた**: 「拡張は activate 時に engine を自動起動する
ため既定の経路」と書いたが、`autoStartConfiguredRustEngine` は保存済みデバイスが無ければ
早期 return する。さらに実読の結果、`saved !== '__default__'` のときだけ接続チェックが働き、
`__default__` は無条件で通ること、この関数は `startEngine()` を直接呼び `startEngineForAgent` を
経由しないことも判明した（「このブランチに到達する」という表現自体が不正確だった）。

**変異検証（5種・すべて main 側で独立に再実行）**:

| 変異 | 結果 |
|---|---|
| stdout の stale ガード無効化 | stale テスト red |
| `debug` を spawn-only 判定から除外 | debug テスト red |
| stale 時に診断を出さないよう変更 | stale テスト red |
| `applyEngineExit` の identity ガード無効化 | exit stale テスト red |
| `applyEngineStdinError` の identity ガード無効化 | stdin stale テスト red |

いずれも restore で green に復帰。**委譲先の変異検証報告を鵜呑みにせず、main 側で全件を
再実行して裏を取った**（受け入れ検証規律）。

**E2E 追加**: 拒否直後に `running === true` を確認（拒否分岐が engine を teardown する変異を殺す）、
`debug` 拒否の回帰ピン、`get_log` 自身が失敗しても元のタイムアウトと失敗理由の双方を残す診断、
ヘッダの起動方法を `npm run test:e2e:gated` に更新。

**検証**: `npm test` 1664 passed / 29 skipped（1654 → +10）・`tsc --build` 通過・lint エラー0・
実機 gated E2E 1 passed・実行後の孤児デーモン 0。

**委譲の経緯**: 実装は Codex に発注したが、追加分の発注時点で Codex スレッドがブロック状態
（全プロセス CPU 0.0%・ファイル変化なし）だったため、owner 指示のフォールバック
（Sonnet subagent）に切り替えた。

### 6.294 refactor(engine): plugin 宣言のチェーン化 + instrument 仕様の矛盾解消 #517 S4 PR-1a (Jul 27, 2026)

**Date**: 2026-07-27
**Status**: 🔄 レビュー中（PR #527）

**内容**:
S4（#522）の第1段。**TS のデータモデルのみ・挙動不変**で、spec 更新を先行させた（運用規則6）。
`EffectSlotMap`（1レシーバ = 1 insert 固定）を、チェーンと role を表現できる `EffectChainMap` に
置き換える。**上限は 1 のまま維持**（解除は wire と RT の変更が要るため PR-1b）。

4層（RT / daemon / wire / TS）を1 PR で動かすとレビューが機能しないため（S3 はより小さい差分で
Critical 8件）、リスク境界で分割した。挙動不変なので「既存テストが緑のまま」であること自体が
正しさの証拠になる。

**仕様の矛盾を解消（`b5e2798`）**: SC.3.1 規範(4)「instrument は…**後勝ち（差し替え）**」と
core spec PH.4「異 path への差し替えは**エラー**」が正面から矛盾していた（#522 は instrument に
一切触れておらず、仕様完全性検査で検出）。**上方向に解消** — PH.4 の立場は「エンジン全体で
1 インスタンス」の帰結であり、複数インスタンス化で前提ごと消えるため。

**フォーマット調査（一次情報）**: 旧「同 path 共有」は daemon の `AlreadyLoaded` 制約に合わせた
TS 側 dedup だったが、**共有を成立させる機構がフォーマット側に無い**ことを確認した。CLAP は
`clap_plugin_preset_load` がインスタンス丸ごとにしか効かず、持続的な param 問い合わせ
（`clap_plugin_params.get_value`）にもスコープが無い。`clap_host_track_info.get` が単数の track を
返すことからも 1 インスタンス = 1 トラック前提。VST3 は Unit 機構で per-part を表現できるが
**opt-in** で、本実装は未対応。つまり旧 dedup は**共有の利点を実現する機構を持たないまま、
preset / param / note が混ざる欠点だけを負っていた**。

**サミングとマルチティンバーを別概念として規定**: 合流するのは note ストリームであって
プロセス共有ではない（owner 指摘）。後続 stage を **#524（サミング・Units 非依存）/
#525（マルチティンバー）/ #526（voice 分離）** として issue 化。

**合流点の移設を spec に記載（`2ff0af4`）**: instrument の音声は master の post processor で
add-mix されており **seq バスグラフを一切通らない**。このため SC.0 の
`lead.Serum(...).TALReverb4(...).subout` は #522 の5項目を全部実装しても動かない。
#522 の題目「SC.0 の完全実行」には移設が必須で、要件から漏れていた（実装は PR-1b）。

**`/simplify`（`228646f`）**: altitude の指摘1件が3件をまとめて閉じた — `duplicateError: () => Error`
は型の約束が片方の分岐でしか機能していなかった（effect では Error が捨てられ `.message` だけ
再包装、instrument ではそのまま throw）。`duplicateMessage: () => string` に縮小しエラー型の決定を
map が持つ形にしたところ、reuse と simplification が別々に指摘した throw の重複も消えた。
あわせて到達不能な `maxLength` ガードを削除し、同型の隣接引数（`normalizedName` と
`resolvedPath` がどちらも `string`）を `PluginDeclaration` に集約した。

**pr-review-team ラウンド1（`ff4a335` / `93ac319`）— Critical 0・Important 6**:

- **並行 self-heal の競合**（2名が独立に再現）: 同一キーへの `declare()` が並行に走ると両方が
  同じ `existing` を `replacing` として `issueLoad` を呼び、**オブジェクト同一性**判定により
  後着のエントリが黙って捨てられる。さらに追跡側が失敗し追跡漏れ側が成功すると
  `chains.delete(key)` が走り、**daemon にプラグインが生きているのに「何も宣言されていない」と
  報告する**。`pending: Map<K, Promise<void>>` でキー単位に直列化。
  > 根本原因は本 PR 由来ではない（旧実装も無条件 `set` = 最後勝ちで同種の弱点）。ただし本 PR は
  > 同一性ベースの置換に変えたことで「**後着の実ロードが成功しても TS 側に一切反映されない**」
  > という新しい取りこぼしの形を追加していた。
- **`instanceId` にテストが1件も無かった**: 定数に置換しても全1634件が通過。S4 の設計は
  「respawn を跨いで ID が不変であること」に依存するのに、値を assert するテストが皆無だった。
  > fixer が最初に書いた保持テストは**変異検証で潜り抜けた**（occurrence が偶然同じ文字列に
  > 再計算される）。`receiverId` が毎回別文字列を返すモックに差し替えて再設計した。
  > **変異検証を要求していなければ、守っていないテストが入っていた。**
- **`normalizePluginInstanceName` にテストが無かった**: 恒等関数に置換しても全件通過。
  あわせて Windows パスで `instanceId` にパスが混入するバグを修正。
- **spec が未実装の挙動を実装済みのように記述**（2名が独立に指摘・PH.1 / PH.4 / SC.3.1）:
  このプロジェクトは SC.5 に「**v1 のエラーは stage 表記を含む**（ユーザーがいつ使えるように
  なるかを知れるようにするため）」と規約を明文化しており、追記だけがそれに従っていなかった。
  「v1 の現在地 / 理由 / 実装時期」ブロックを3箇所に追加し、エラー文言にも stage 表記を付けた。
- **誤った出典**: 「#523 の調査」は誤り（#523 は S3 のバス名ルーティング PR で該当調査を含まない）。
  #408/#409 型の**3回目の再発**。`#527 の調査` に訂正
- ファイルヘッダ「three managers」→「four」

**ラウンド2 — Critical 0・Important 1**:
ラウンド1の修正は独自のストレス実行でも破れなかった（500回呼び出し・200×20キー並行後も
`pending.size === 0`・reject が後続を汚染しない）。CLAP の記述も上流ヘッダと逐語照合された。

唯一の新規指摘は**私が書いたコメントの誤り** — `KNOWN_PLUGIN_EXTENSIONS` に
「新 format を足す時はここだけを変える」と書いたが、**同じファイルの `validatePluginExtension()` が
独立にハードコードした if チェーン**で判定しており、この配列を参照していなかった。将来 `.au3` を
足すと「パスとしては認識され名前も生成されるのに、ロードだけ拒否される」不整合が起きる。
`SUPPORTED_PLUGIN_EXTENSIONS`（ロード可能）と `RESERVED_PLUGIN_EXTENSIONS`（AU 予約）に分け、
`KNOWN_PLUGIN_EXTENSIONS` と `KNOWN_PLUGIN_FORMATS` を**そこから派生**させて実際に単一正本にした。

**検証**: 全 suite **1652 passed / 29 skipped**（S4 前 1634 + 新規18）・`tsc --build` exit 0・
lint エラー0

**関連**: #517（統括）・#522（S4）・#527（本 PR）・#524 / #525 / #526（後続 stage）・
#523（S3）・#409・#484

### 6.293 feat(engine): Signal Chain バス名メソッドのルーティング写像 #517 S3 (Jul 26, 2026)

**Date**: 2026-07-26
**Status**: 🔄 レビュー前（実装完了・#521）

**内容**:
バス名メソッドを既存の send / output 経路へ写像し、SC.4 のルーティング意味論を実行可能にした。
あわせて S1 / S2 から持ち越した義務6件を片付けた（いずれも S3 の実装で必ず触る箇所）。

計画: Codex 起案 → Fable 独立第二意見 → 判断3件を owner 承認 → 確定（#521 コメント）。

**Q1: 括弧なし単独文を SC.1(1) の等価性に載せる（義務 a）**:
根本原因は「括弧の有無を interpreter に伝える情報が AST に無い」ことだった。`.drums` と
`.TALReverb4()` はどちらも `args: []` に潰れており区別できなかった。`invocation: 'bare' | 'call'`
を主呼び出しと全 chain hop に持たせ、分岐を行列で total にした:

| | mixer sum/output | mixer aux | plugin | DSL method |
|---|---|---|---|---|
| bare | 出力先指定 | 明示エラー（kind） | `Name()` を案内 | **従来どおり `callMethod`** |
| call | 明示エラー（kind） | send | plugin dispatch | 従来どおり |

既知 transport（`start` / `stop` / `loop` / `run` / `mute`）は従来の AST を維持する。
**`bare × DSL method` のセルは Fable が「計画の行列に無い」と指摘したもの**で、抜けると
`kick.unmute` 等の既存動作が壊れる。回帰テストで固定した。

S2 で「transport 経路に state を渡す」案を却下した理由（括弧なしの `kick.TALReverb4` が
プラグイン dispatch され SC.4 決定 #77 に反する）は、この形では発生しない。

**Q2: await 可能なルーティング経路（SC.2 規範5）**:
`.verb(0.3)` / `.drums` / `.master` が評価 promise から await され、daemon の DAG / kind /
逆 stage 拒否が伝播する。既存の同期契約は不変。Sequence と MixerBusHandle の双方が
レシーバになれる（SC.2 規範4 の `verb.Plugin().master`）。

> **訂正（レビュー #523 comment-analyzer の指摘）**: 当初ここに「routing 状態と full-state
> payload 構築は共有 primitive に集約し、双方から使う」と書いたが、**実装はそうなっていない**。
> Sequence 側は `_sumOutputBus` / `_auxSends` + モジュール関数 `buildRoutingSends()`、
> MixerManager 側は `routings` Map + `route()` 内のインライン変換で、同型のロジックを
> それぞれが個別に持つ（`Map<string, number>` → `{bus, gain}[]` の変換が2箇所）。
> `6e96c31` が集約したのは **Sequence 内部の2箇所（`pushBusRouting` / `syncBusRouting`）の
> 重複のみ**。両者の統合は #522 で検討する。

**`.master` — 予約語で hardware/master へ復帰**:
`SetBusRouting` の `output` に予約語 `"master"` を渡すと sum への出力先指定を解除する。
`output` の省略は従来どおり「変更なし」で、三状態を表現する。

形式は**予約語を採用**（Codex の推奨は null 三状態だったが Fable が却下理由の誤りを実証）:
wire 上の bus 名はプール名のみでユーザー宣言名は乗らないため衝突しない。`engine_wrap.rs` に
予約コメントが既にあり、native のエンコードも `1 = Master` を持っていた。Rust 側の変更は最小限で、
エンコード計算を検証段階へ寄せた（master は bus 索引を持たないため、従来の「検証は索引を返し
ストア段階で +2」の分業では表現できなかった）。実装により無効化された予約コメントも実態に更新した。

**Q3: 暗黙 master と文字列形バス名の語彙統合（義務 b・c）**:
Global ごとの「有効 mixer node view」を canonical lookup に一本化。解決順は registry の明示ノード →
同じ Global の文字列形 sum/aux → 明示ノードが無い場合のみ暗黙 master(1,2)。**同じ defaulting を
2箇所で再実装しない。**`sidechain:` も同じ lookup。

**暗黙 master の抑制は明示ノードのみで判定する**（Fable 指摘の追補3）。文字列形宣言を「明示」に
含めると `global.sum("drums")` だけのファイルで `master` が語彙から消えて**互換破壊**になる。

**Q4: Global 横断性（義務 d）**:
Global 一致を canonical lookup の**必須引数**に。別 Global の同名ノードは語彙として見えず
routing target にも使えない。

**Q5: SC.5「後勝ち」（義務 e）→ S4（#522）**:
staging と明文化し（spec 更新は `62f6bc9`）、kind / channel / Global 変更のエラーに
**`S4 (#522)` の stage 表記を追加**した。

**Q6: エラー文言債務（義務 f）**:
- **文言スニッフィングを型付きエラーへ**: `EffectSlotLimitError` / `EFFECT_SLOT_LIMIT`。従来の
  正規表現は Global の実文言 `one master insert` にマッチせず、**S4 案内が付かないバグだった**
  （#521 コメントに実測記録）。テストが捏造文言で通していたため検出できなかった
- 捏造 mock 文言のテストを廃し、実 manager の文言で検証する
- string-form API に selector を渡した場合の案内を plugin method 形に更新
- catalog 不在メッセージに typo 確認の案内を追加

**send のタップ位置 → S4（#522）**:
SC.4 規範3 は v1 では post-insert 固定。core spec MX.3 が以前から staging を宣言しており SC.4 側に
反映した（`62f6bc9`）。v1 は 1 insert 制限でタップ点の区別が意味を持たず、複数 insert のスロット
index と不可分。

**テスト**:
- fail-before 4件 → pass-after 21件（`signal-chain-dispatch.spec.ts`）
- Rust: `reserved_master_output_resets_the_routing_atomic` を含む9件通過
- **追補2・3 のテストを main が追加**（実装は正しかったがテストが無かった）: `kick.verb()` の
  amount 省略が明示エラーになること / 文字列形宣言が暗黙 master を抑制しないこと。
  **両方ミューテーションで検出力を確認**

**`/simplify` 4観点（`6e96c31`）**:
4観点すべてが `resolveEffectiveMixerNode` を指摘（`resolveMixerNode` の再実装・1回の dispatch で
2回呼ばれ2回目はハンドルを確保して捨てる）→ 削除して委譲。receiver の owning Global 解決を
`resolveReceiverGlobal()` に集約。`MixerManager.route()` が `routings` を **await 前に**書き換えて
いた点を成功後コミットに修正。`buildRoutingSends` は private メソッドで足すと S2 の逆方向テストが
prototype 表面として検出したため（`private` は実行時に残る）モジュール関数へ。

**pr-review-team ラウンド1（`73d21d7`）— CI 全 pass のまま Critical 6件**:
4レビュアー全員が実行して再現。うち2件は2名が独立に同一指摘へ到達。**C1〜C4 はこの PR が
退治対象に掲げた silent pass-through と同型**で、過去5回再発したパターンがパーサーの chain
継続チェックと aux 引数ループという**新しい2箇所**で再現していた。

- **C1 `invocation` の伝播漏れ**: `processGlobalStatement` / `processMixerNodeStatement` が
  `applyMethodChain` に渡しておらず常に `'call'` に落ちていた。`global.TALReverb4`（括弧なし）が
  拒否されず黙ってプラグイン呼び出しになり、逆に正当な `verb.master` が誤って拒否される
- **C2 非 master output の誤配線**: `kind === 'output'` だけを見て `channels` を無視し、
  `mix.output(3, 4)` への配線が無警告で master(1,2) へ流れていた → channels が `[1,2]` でなければ
  #484 D4 を案内する明示エラーに
- **C3 bare 始まりチェーンの脱落**: 新設した非 transport の bare 分岐が `parseMethodChain()` を
  呼んでおらず、`kick.drums.pan(0.5)` の `.pan(0.5)` が構文解析段階で消えていた（エラーなし）。
  関数名も実態と乖離していたため `parseBareMethodReference` に改名
- **C4 aux `amount:` の重複**: named `amount:` が `amount === undefined` を見ず無条件上書き。
  `verb(0.3, amount: 0.9)` は 0.3 が消え、逆順は例外という非対称 → `classifyPluginArguments` と
  同型の `seen` セットを**再実装せず流用**
- **C5 不変条件のテスト欠落**: `MixerManager.route()` の「daemon 受理後にコミット」に対し、
  変異（`set` を await 前へ戻す）を入れても全 suite グリーンだった → 1回目 reject → 2回目 resolve で
  「拒否分がマージされていない」ことを検証するテストを追加し、**変異で落ちることを確認**
- **C6 doc が機能を否定**: `audio/types.ts` が「v1 では hardware に戻す手段が無い」のままで、
  `Global.setBusRouting` がそこを権威として参照していた → 三状態の記述に訂正

Important: `"master"` 名の sum/aux 宣言が予約語を無警告でシャドウ（**決定 #78** として spec 化・
出力エンドポイントの `master` 命名は正当なので sum/aux のみ拒否）／`!global && explicit` が
SC.4 の Global 分離をバイパス（`executeModuleIR` が import 元と同じ state に `processGlobalInit` を
呼ぶため、node が存在するなら `currentGlobal` は必ず設定済み = 到達不能を実証して削除）／
明示宣言形の cross-Global 分離が未検証（変異で確認）／`EffectSlotLimitError` が手組み mock 経由
でしか検証されていない（実 manager 経路のテストを追加）。

**テストは236行追加・0行削除** — 実装を通すために既存アサーションを緩めた箇所はない。

**pr-review-team ラウンド2 — Critical 0・Important 1**:
4レビュアーで再検証。ラウンド1修正はすべて実行による裏取りで健全と確認された。

- **最大の懸念（パーサーの `skipNewlines`）は問題なし**: 2名が独立に検証。`kick.drums\nkick.pan(0.5)`
  は2文に正しく分離し、`kick.drums\n.pan(0.5)`（次行が先頭ドット）が chain になるのは
  **括弧あり経路（本 PR 未変更）の `kick.audio(1)\n.pan(0.5)` と同一挙動**。C3 修正は既存経路と
  対称にしただけで、新しい飲み込み経路は作っていない
- **C2 ガードは chain 2ホップ目以降でも発火**: `kick.verb(0.5).alt` で reject され、かつ
  `setBusRouting` が1回だけ呼ばれた（1ホップ目は正常完了）ことまで実証
- **C4 の `seen` は total**: `null` / 配列 / ネストオブジェクト / **name が undefined の named_arg**
  （パーサーが生成し得ない壊れた IR）等10種以上を投入し全て例外
- **fixer の自己申告した変異検証2件を独立に再現**: 15変異のうち14を新規テストが検出
- **`applyMethodChain` の全4呼び出し元を確認**: `processMixerHandleStatement` のみ `invocation` を
  渡していないが、`MixerHandleStatement` 型に該当フィールドが無く文法上 `sum(...)` / `aux(...)` は
  常に括弧付き（bare 形が存在しない）ため、見落としではなくスコープ外

**Important 1件（修正済み）**: 非 master output ガード `left !== 1 || right !== 2` を
`left !== 1` だけに緩める変異が全 suite グリーンのまま通った。既存テストが使う非 master output は
`mix.output(3, 4)`（`left=3`）のみで、**`left===1` かつ `right!==2` のケースが未検証**だった
（`mix.output(1, 3)`）。テストを追加し、**変異を入れて実際に落ちることを確認**した。

> **誤検出の切り分け**: レビュアー1名が「新規の master reserved テストがフル suite で落ちた」と
> 報告したが、**当該テストは `makeGlobal()` で毎回新しい Global を作る同期的な throw
> アサーションのみ**（async / FS / タイマーを含まない）で、負荷で落ちる構造がない。同時刻に
> 別レビュアーが `name === 'master'` ガードを `if (false && ...)` で無効化する変異を作業ツリーに
> 置いていたため、その瞬間の計測だった。ガード健全な状態でフル suite を2回連続実行し
> **1632 passed / 失敗0** を確認済み（並行レビューの副作用であり、フレークでも実装の欠陥でもない）。

**実機駆動で見つけた Critical（#519 S2 由来の回帰・テストが緑のまま壊れていた）**:
OrbitStudio をビルドして実際に評価したところ、**エディタからの評価がすべて失敗していた**:

```
ERROR: Unknown chain method "setDocumentDirectory" on Global.
```

拡張は `audio()` を編集中ファイル基準で解決させるため、**全評価の先頭に
`global.setDocumentDirectory("<dir>")` を DSL ソースとして注入する**（`extension.ts`・MCP の
evaluate 経路も同じ）。ところがこの名前が `GLOBAL_DSL_METHODS` に無く、S2 の「未知メソッド =
明示エラー」が注入行を弾いていた。

**S2 の逆方向テストが防ぐはずだった失敗モードそのものを、除外リストへの誤分類で通していた**:
当該テストは「全 prototype メソッドが DSL 語彙か内部 API 除外リストのどちらかに分類される」ことしか
検査しないため、`setDocumentDirectory` を除外リストに入れた時点でテストは緑になり、
**実行時経路だけが壊れる**。ホストが DSL として注入する以上これは内部 API ではないので、
`GLOBAL_DSL_METHODS` へ移し、除外リストから外した理由をコメントで残した。

注入される実際の形を DSL として評価する回帰テストを追加し、**語彙から外すと
`Unknown chain method` で落ちることを確認**した。main も同じ状態なので S2 マージ以降
エディタ評価が壊れていたことになる（`/simplify` も pr-review-team 2ラウンドも、
実機で動かすまで検出できなかった）。

**実機確認**: 修正後、`kick.verb(0.3)`（aux send）・`kick.drums`（sum への出力先指定）・
`drums.master`（hardware 復帰）が実エンジンでエラーなく評価された。

**comment-analyzer が検証した主張（すべて実測と一致）**: 「236行追加・0行削除」／「1631 passed」／
「S3 前 1611」（`62f6bc9` を worktree で実行）／README の「1617 passed」（`db01cd8`）／
Rust 9件／`engine_wrap.rs` の `1 = Master` エンコード／`db01cd8` が `EffectSlotLimitError` の
導入コミットであること／`73d21d7` が到達可能で孤児参照が他に無いこと／SC.2 規範(4) と SC.3.1 の
引用が原文と一致すること。**issue 番号は #484 の「D4」を除く全件が件名と整合**。

> **`#484 D4` — PR 由来ではない既存の文書間不整合（#484 に記録・owner 判断待ち）**:
> 本仕様書（正本）は `#484 D4` をマルチチャンネル出力の着地点として参照し専用の表の行まで持つが、
> **issue #484 の本文・コメントに「D4」は存在しない**（実在は D1 / D2 / D2.5 / D3 / D3.5 / D5、
> かつ最も近い D5 = 複数デバイス同時出力は owner 裁定で取り下げ済み）。main の本番エラーメッセージ
> （`runtime.ts:289`）とテスト（`mixer-runtime.spec.ts:212`）も同じ文字列を前提にしているため、
> **本 PR だけ表記を変えると仕様正本と main から乖離して不整合が増える**。既存表記を踏襲し、
> (a) #484 に D4 を切る / (b) 枝番号を落とす の判断を #484 のコメントで仰いだ。

> **既知フレーク（本 PR と無関係）**: `daemon-client.spec.ts` の #484 D1 argv テスト2件は
> **#520** で追跡中。本ブランチは当該テストも `daemon-client.ts` も触っていない（差分空）。
> 根因は「spawn した shell の書き込みを待たずに読む」レースで、#520 の「全 suite 同時実行時のみ」
> という記述より広く、**負荷が高ければ単独実行でも落ちる**（本セッションで観測）。

**検証**: 全 suite **1632 passed / 29 skipped**（S3 前 1611・レビュー修正で +15）・
`tsc --build` 通過 / lint エラー0 / `cargo test` 全 crate green /
`cargo fmt --check` 通過 / `cargo clippy --all-targets` 警告なし

**関連**: #517（統括）・#521（S3）・#523（PR）・#522（S4 = Rust プロトコル拡張の受け皿）・
#518（S1）・#519（S2）・#409（`sidechain:` / `outs:` の実配線）・#484 D4・#520（既知フレーク）

### 6.292 feat(engine): Signal Chain チェーンメソッドの解決とディスパッチ #517 S2 (Jul 26, 2026)

**Date**: 2026-07-26
**Status**: 🔄 レビュー中（PR #519・#518 の上に stacked）

**内容**:
Phase B (#514) で実装されたが**どこからも呼ばれていなかった** `signal-chain/resolve.ts` の
`resolveChainName()` を実際のディスパッチに配線した。

- チェーンメソッド名を「DSL メソッド / ミキサー名 / プラグイン名 / unknown」に解決
- `plugin` → 既存 `effect()` / `instrument()` へディスパッチ
- `mixer-name` → S3 で実装される旨の明示エラー
- `unknown` → **明示エラー**（`callMethod` の `console.error` + receiver 返却を廃止）
- dual-role プラグインは曖昧エラーとし、文字列形の逃げ道を案内
- named args の段階別エラー: 実パラメータ / `preset:` / `enabled:` → S4、`sidechain:` / `outs:` → #409
  （初版は `outs:` を #408 としていたが誤り。後述のラウンド2で訂正した）
- curated DSL 語彙リスト（`GLOBAL_DSL_METHODS` / `SEQUENCE_DSL_METHODS` / `BUS_DSL_METHODS`）を導入。
  実メソッドの機械列挙だと `getState` や scheduling API まで DSL 語彙として最優先解決されるため

**プラグイン選択は既存 resolver を再利用（SC.3.2）**:
仕様はメソッド形と文字列形の一致を要求している。独自に絞り込まず、named 引数から
文字列形と同じ spec 文字列を組み立てて `resolveCatalogSpec` に渡し、その解決結果の
roles だけで dispatch を決める。

**解決とディスパッチはチェーンの実行点に置く**:
`applyMethodChain`（S1 が唯一のチェーン実行点と定め、すでに `guardBusChain` を実行している場所）
から新規 `signal-chain/dispatch.ts` を呼ぶ。`callMethod` は3引数の機械的な invoker のまま。
`guardBusChain` は必ず解決より先に実行する（バスの未対応メソッドが S1 の staged エラーで
落ちる性質を維持するため）。

**レビュー経緯（`/simplify` 4観点 → `91f4070`）**:
初回実装（`3c173b9`）は `resolveCatalogSpec` を再利用せず独自に再実装しており、
**文字列形と実際に食い違っていた**:
- 文字列形は `"format/name"` と `"vendor/name"` を排他的に扱い曖昧エラーを出すのに、
  新実装は `format:` と `vendor:` を独立に AND で絞っていた
- 両方指定時、role 判定は AND で絞った候補集合に基づくのに最終 spec は片方の修飾子しか
  残さないため、**role 判定の根拠とは別の entry が解決され得た**
- role 曖昧性を修飾子適用前の集合で計算していたため、ベンダーごとに role が異なる同名
  プラグインで誤った案内（「effect と instrument で曖昧」）が出ていた。正しくは「ベンダーが曖昧」

**設計判断（Fable・採用しなかった案とその理由）**:
初回実装の `callMethod(obj, method, args, state?)` は、S1 が3回の再発の末に排除した失敗モード
（渡し忘れると silently 効かない）を引数を鍵に再現していた。

「`state` を必須にする」案は**仕様違反の副作用**を持つため却下した。パーサは括弧なしの
`kick.foo` を任意の識別子で TransportStatement にするため、sequence transport 経路に `state` を
渡すと**括弧なしの `kick.TALReverb4` がプラグイン dispatch される**ようになる。仕様は括弧なしを
「sum / output 名 = 出力先指定」に予約しており（SC.4 決定 #77）、プラグイン呼び出しは括弧つき
（SC.3.1）。型チェックの安心と引き換えに未検討の文法拡張を裏口から入れることになる。

**efficiency**: `resolveChainName` は `dslMethods.has()` を最初に見て早期 return するが、
その引数を組み立てる時点でカタログの読み込みと全走査が既に終わっていた。`.play(1)` のような
プラグイン名になり得ない呼び出しでも毎回 `fs.statSync` とカタログ全走査（実測: 200件で約30µs、
1000件で約130µs／呼び出し）が走っていた。DSL メソッドとして解決できた時点でカタログに触らない
形にし、プラグイン名の索引もカタログ単位でキャッシュした。

**逆方向テストの追加**: `Sequence` / `Global` の全 prototype メソッドが、DSL 語彙か明示的な
内部 API 除外リストのどちらかに分類されることを検査する。従来は「列挙した名前が実在する」しか
見ておらず、実在するのに未登録のメソッドを検出できなかった（プラグイン名と衝突すると黙って
plugin dispatch へ流れる silent shadowing のリスク）。

**pr-review-team ラウンド1**: Critical 1・Important 7・Minor 6。Critical は
**プラグイン呼び出しが位置引数を黙って捨てる**（`kick.TALReverb4(0.5)` で 0.5 が消え、
デフォルト値でロードされる。再現済み）。#517 で同じ「silent 素通り」の病が**5回目**で、
毎回「既存の検証を再利用せず必要な分岐だけ再実装した結果、想定しなかったケースが抜けた」
という同じ形。

**ラウンド1の修正（`861153e`）**: 個別対処ではなく構造で閉じた。permissive なループを
`classifyPluginArguments` に置き換え、全引数を走査して named_arg でなければ即エラー、
named_arg なら `switch` で必ずいずれかに落ち、**`default` が S4 エラーを投げる**。
素通りする経路が構造的に存在しない。あわせて:
- `processArguments` の `format:` / `vendor:` 素通りを明示エラーに戻した（プラグイン
  dispatch はこの関数を通らないため、到達するのは実在 DSL メソッドへの stray な
  selector のみ。素通りさせると resolver が「第2の pluginId を渡すな」という見当違いの
  エラーを出していた）
- カタログ不在を「タイポ」と区別し、`orbit-plugin-scan` の案内に到達させた
- テスト追加: `outs:` エラー / バス・Global の role 不一致 / `global.SomeEffect()`
- バスレシーバのエラーに実バス名 / `pluginNames` を実 `Set` に / 陳腐化コメント3件を修正

**ラウンド2**: Critical 0。silent-failure 観点は**クリーン**（`null` / 配列 / 名前欠落の
named_arg など、パーサが生成し得ない形も含めて10種類を実際に流し、全てが throw することを
確認。`ChainDispatch` が2要素の判別共用体であるため両分岐に跨る第三の経路が型として
存在しないことも確認）。Important 2件:
- **チェーン中間ホップのガード順序テストが、実際にはそれを検証していなかった**
  （`bus.TALReverb4().gain(0.5)` はレシーバが最初からバスのため、ループ前の一括ガードで
  弾かれる。ループ内のガードは一度も効いていない。2名が独立に発見、うち1名はスパイで
  `effect` が0回しか呼ばれないことを確認）
- 仕様書の `outs:` の依存 issue 番号が誤り（#408 はテンポ/トランスポート state の配線で
  multi-out と無関係。正しくは #409 = マルチバス音声搬送で、sidechain と multi-out の
  両方を担う）。**仕様書由来の誤りで、実装のエラーメッセージにも伝播していた**

**ラウンド3（`05c88f3`）**: Critical 0・Important 2。
- **`sidechain:` と `outs:` のアサーションが両者を区別できていなかった**。#409 への統一で
  両者が同じ issue 番号を指すようになり、`/#409/` だけでは取り違えを検出できない状態に
  なっていた（レビュアーがメッセージを入れ替えて33件すべてが通ることを実証）。
  **当初の修正（引数名でアンカー）は効いていなかった** — エラー文は
  `named argument "sidechain:" in ...` の形で引数名を先頭に必ず含むため、説明部分が
  入れ替わっても通る。実際に変異させて初めて判明した。差異のある箇所（stage 句）を
  狙う形に直し、**2ファイルで個別に**ミューテーション確認した（同じ `#409` を出す分岐が
  `dispatch.ts` と `evaluate-method.ts` の2箇所にあり、テストも別）
- WORK_LOG 6.292 の自己矛盾（概要行が `outs:` → #408 のまま）を訂正

**ラウンド4**: Critical 0・Important 1。
- **再発防止の注記自体が誤ったエントリ番号を指していた**（6.243 と書いたが正しくは 6.242）。
  「誤った issue 番号が次の読者を誤導する」問題への対策が、同じ誤りを犯していた
- 弱いアサーションの罠を**クラスとして掃き出し**、他に同型の組が無いことを確認。
  `preset:` / `enabled:` / 任意パラメータが同じ `/S4/` を共有しているのは**同一の
  `default` 分岐**から出ているためで、分岐が割れていない以上入れ替えようがない
  （「同じ文言を共有すること」自体は欠陥ではなく、**別々の分岐が区別できない**ことが欠陥）
- 3名すべてが収束と判定

**検証**: 全 suite 1610 passed / 29 skipped（3回連続で同一）・lint エラー0・build 通過

> ラウンド4で追加した `sidechain:` / `outs:` の統合アサーションは既存の `it()` ブロック内に
> 足したため、テストケース総数は変わらない（vitest は `it` 単位で数える）。

**関連**: #517（S2）・#518（S1・stacked base）・#514（Phase B）・#409（`sidechain:` / `outs:` の実配線）・#484 D4

> **注**: #408 は「テンポ/トランスポート state の Engine への配線」であり、`outs:` とは無関係。
> 同じ取り違えは **6.242**（2026-07-12）でも発生しており、design doc §4.2(b) の
> 「#408 と同様に defer」という誤参照を owner 確認の上で訂正した記録がある。
> **#408 を multi-out 系の依存として書かないこと**。

### 6.291 feat(engine): Signal Chain ミキサー宣言の実行 #517 S1 (Jul 26, 2026)

**Date**: 2026-07-26
**Status**: ✅ レビュー収束（PR #518・owner マージ指示待ち）

**#517 のスコープ改訂（owner 決定・重要）**:
当初は「Phase C = TS 側の写像のみ / Rust 側拡張は Phase D」の分割だったが、事前調査で **SC.0 の例は TS 側の写像だけでは原理的に実行できない**ことが判明（下記）。owner 判断により **Rust 拡張を取り込み、SC.0 完全実行までを #517 の到達点**とし、S1〜S5 に分割した。本項はその S1。

**調査で確定した制約**（Codex 起案 + Fable 独立検証・いずれも一次ソース確認）:
- 1レシーバ=1insert がハードコード（`effect-slot.ts:84-98` / `sequence-effect-manager.ts:92` / `mixer-manager.ts:142`）。daemon の `LoadPlugin` はチェーン位置を持たない（`daemon-client.ts:378`）
- プラグインのパラメータ設定経路が存在しない（`audio/types.ts:70-75` / `daemon-client.ts:384-391` / `session.rs:884-999`。`protocol-types.ts` の `CommandMethod` union に param set/enumeration/preset/bypass なし）
- send のプリ/ポスト位置を表現できない（routing state にタップ点の概念なし）
- `syncBusRouting()` は fire-and-forget（`sequence.ts:412-429`）→ SC.2 規範5 の「評価時に明示エラー」には await 可能経路が要る

**S1 の内容**:
- `InterpreterState` に mixer registry を追加。新規 `signal-chain/runtime.ts` に集約
- `MixerInit` → 同一 Global の卓への冪等な handle 取得（SC.2 規範1）
- `MixerNodeDecl` → `mix.sum`/`mix.aux` を既存 `Global.sum()`/`Global.aux()` へ、`mix.output(ch, ch)` を endpoint メタデータへ写像
- mixer node をレシーバとする文の dispatch（SC.2 規範4）
- `declaredNames()` に mixer 宣言を追加
- 未解決レシーバ・output エンドポイントへのメソッド呼び出しを明示エラー化（SC.3.3）
- LinkAudio 排他ゲートを、バスを確保しない宣言にも適用（両方向）
- 名前空間の衝突検出（global / sequence / mixer handle / mixer node の全交差）
- 仕様の誤記修正: SC.0 の `kick.audioPath(...)` → `audio(...)`（`Sequence.audio()` が正・`audioPath` は Global の検索パス設定）

**暗黙 master(1,2) の扱い（SC.2 規範6・決定 #75）**:
名前解決時の**遅延解決**とし registry には登録しない。`execute()` は REPL の評価単位ごとに呼ばれ `InterpreterState` は評価をまたいで持続するため、評価単位ごとの先読みにすると宣言ブロックとトラック行を別評価した際に誤登録する。spec は静的な「ファイル」単位で書かれておりライブ増分評価との橋渡しに明文がないため、**spec 追記は follow-up**。

**レビュー経緯（PR #518・`/simplify` + pr-review-team 4ラウンド）**:
本レビューで **4つの実バグ**が出た。いずれも「不完全な経路を黙って飲み込む」同一の病で、**同じ穴が3回、別々の入口から再発**した:
1. 既定チャンネルの output だけが黙る非対称（`/simplify`）
2. バスが `effect()` 以外を飲み込む・宣言形（ラウンド1）
3. 同じ穴が裸の文字列形 `sum("drums").gain(0.5)` から（ラウンド2）
4. 同じ穴がターゲット接頭辞形 `global.sum("drums").gain(0.5)` から（ラウンド3）

3回目で2名のレビュアーが独立に「強制が値ではなく呼び出し箇所に付いているのが根本原因」と診断。箇所ごとのパッチをやめ、**構造的修正**へエスカレーションした（`9d2e412`）:
- `MixerBusHandle` に module-private Symbol の brand を付与（`Sequence` も `effect()` を持つため duck typing では誤検知し得る）。TypeScript が全 `MixerBusHandle` に brand を要求し、Symbol は未 export のため外部から偽造不能
- チェーンの唯一の実行点 `applyMethodChain` が `callMethod` の直前に毎回 `guardBusChain` を実行。ハンドラ側の「検証を呼ぶ義務」を撤去
- 閉包の根拠: `chain?:` を持つ statement 型は3つのみ、そのハンドラ4つはすべて `applyMethodChain` を通る、外部の `callMethod` は transport の4箇所（コマンド名固定・チェーンなし・非バス受け手）のみ
- fail-fast は分岐2（受け手が Global で次が `sum`/`aux`）が担い、分岐1（受け手が既にバス）が強制を担う。分岐2 を失っても劣化は原子性のみ

**テストの検出力はミューテーションで検証**（暗黙 master の遅延解決・output レシーバの明示エラー・10個の衝突ガード・共有ヘルパの2呼び出し元・原子性の分岐・衝突メッセージのアサーション）。レビュアー側も独立に17回のミューテーションを再実行して確認。

**検証**: 全 suite 1594 passed / 29 skipped・lint エラー0・build 通過・CI 4/4 pass

**follow-up**: `callMethod` の素通り自体（全レシーバに波及するため別 issue）/ `requireGlobal` と `processSequenceInit` の既存素通り / brand のシリアライズ境界（現状バスハンドルはプロセス内のみ）/ 増分評価下の暗黙 master 規則の spec 追記

**関連**: #517（S1）・#514 / PR #515（Phase B）・#511（P0）・#484 D4・#409

### 6.290 test(daemon): outproc loading テストの flake 除去 #491 (Jul 18, 2026)

**Date**: 2026-07-18
**Status**: ✅ 完了（PR #516 MERGED main `0a484ad`）

**内容**:
- `effect_load_outproc_concurrent_call_fails_fast_on_loading` が CI で2回 flake（#489 発見・PR #515 で再発。いずれも Rust 非接触の変更で fail、rerun で pass）
- 原因: セットアップ（child spawn）完了待ちの deadline 2s が、検証対象の性質でないのに高負荷 runner で spawn 遅延に負けて panic する作り
- fix: `outproc_load_error_test_support` に `SETUP_DEADLINE = 30s` 定数を導入し、セットアップ待ちポーリング2箇所（Loading 遷移待ち・child spawn PID 待ち）に適用。ポーリングは条件成立で即抜けるため正常時の所要時間は不変。本命の regression guard（2本目が mutex 待ちせず 1s 未満で fail-fast する assert）は無変更
- ローカル: outproc テスト 38 passed・fmt/clippy 緑

**関連**: #491（Closes）・#489 / PR #515（再発観測）

### 6.289 feat(engine): Signal Chain notation layer — parser + shared resolution #514 (Jul 18, 2026)

**Date**: 2026-07-18
**Status**: ✅ 実装（Phase B・表記層のみ・レビュー前）

**内容**:
- Signal Chain DSL（SIGNAL_CHAIN_DSL_SPEC_v1・決定 #64-77）の Phase B。P0(#511) ゲート通過済み・Fable 実装前相談で設計確定
- tokenizer に COLON を追加し、named arguments（SC.3: `HogeComp(threshold: -18, sidechain: duck)`）を実装。値は number/string/boolean/識別子 ref（`{type:'ref'}` で遅延解決）。`outs: {...}` マップは #408 まで明示エラー
- mixer 宣言（SC.2.1）: `var mix = init global.mixer` → `MixerInit`、`mix.output(1,2)` / `mix.sum` / `mix.aux` → `MixerNodeDecl`。sum/aux の括弧付きは明示エラー
- `import * from`（SC.2.2・決定 #72）: star import をパース。names は契約検査のみで実体は共有空間評価のため、既存 interpreter でそのまま実行可能と確認
- プラグイン呼び出しはパーサ変更なし（既存 MethodChain が任意名・括弧なし末尾を受理済み）。「文法は静的・語彙は動的」の解決は新設 `signal-chain/resolve.ts`（純関数: normalizeCatalogName + resolveChainName、DSL メソッド > ミキサー名 > カタログの優先順位と衝突報告）に集約。補完/診断/Phase C interpreter が共用する
- 新形状の実行は明示エラー（SC.3.3 silent 無視禁止）: named arg 到達・mixer 宣言到達で「Phase C で実装」を throw。既存挙動は厳密に不変
- spec SC.2 規範(3) に「既知 DSL メソッド最優先」を追記（spec 先行更新・shadow 防止の実装決定として明文化）
- テスト `tests/audio-parser/signal-chain-syntax.spec.ts` 新設（SC.0 例の fixture 含む 14件）。全体 1563 passed・lint エラー 0

**関連**: #514（Phase B）・#506 / #495 / #511 / 次=Phase C（既存 manager への写像）

**レビュー経緯（PR #515）**:
- /simplify 4観点 → fix 2件適用（boolean 判定を ParserUtils 再利用・mixer_node_decl リテラル統合）+ resolve.ts 先行実装の意図注記
- pr-review-team round-1（3名）→ **Critical 1件**: named_arg の Phase C ガードが method 存在チェック後にあり、プラグイン名呼び出し（実在メソッドでない）で「Method not found」素通りに吸われ到達不能 → processArguments 先行実行に修正（`047ac57`）+ テスト5件補強
- round-2 検証: 順序変更の純関数性確認・fail-before/pass-after を旧コード checkout で実機検証・**Critical 0 / Important 0 収束**。CI 4/4 pass
- follow-up 注記（PR コメント）: 既存 method-not-found 素通りが新文法で load-bearing になる件は Phase C の resolver 配線で明示エラー化 / tokenizer `:` の silent skip → parse エラー顕在化は意図的方向

### 6.288 refactor+fix(vscode): #512 補完の /simplify + pr-review-team 収束 (Jul 18, 2026)

**Date**: 2026-07-18
**Status**: ✅ レビュー収束（round-2 で Critical 0 / Important 0）・owner マージ指示待ち

**内容**:
- `/simplify` fix 適用（`db030ba`）: sequence/global メソッド補完面が既存 completionProvider と重複し候補が二重表示 → 新規2面を削除しメソッド補完を既存 provider に一本化（補完面は6→4面）。未参照 `quoteStartChar` を削除
- pr-review-team round-1（code-reviewer + silent-failure-hunter + pr-test-analyzer、経済則で4→3名）Important 3件を修正（`4b710e0`）: busArg 正規表現をドット必須化（`output("` 等の誤発火防止・回帰テスト付き）、import-names の catch を readFile のみに縮小し outputChannel へログ、`filterDslCandidates` のテスト追加
- round-2 検証レビュアー1名で全 fix の解消と fail-before/pass-after を確認、Critical 0 / Important 0 で収束
- skip した efficiency/simplification findings は PR #513 コメントに follow-up として注記（#495 Phase E の AST 化で解消予定）
- テスト 1549 passed / lint エラー 0

**関連**: #512（Phase A）・PR #513

### 6.287 feat(vscode): DSL 文脈補完を6面へ拡張 #512 (Jul 18, 2026)

**Date**: 2026-07-18
**Status**: ✅ 実装済み（`7364726`）

**内容**:
- VS Code 拡張に vscode 非依存の `dsl-completion-context.ts` を追加し、コメント／無関係な文字列内を除外する regex 文脈検出を実装
- `import { ... }` の import 元 top-level 宣言、`from "..."` の workspace `.orbs` 相対パス、`seq.`／`global.` の既知メソッド、`output("...")` の `global.sum()` 名、`send("...")` の `global.aux()` 名を補完
- import 宣言抽出は engine の `declaredNames` と同じく top-level `var` 宣言を静的に列挙し、VS Code provider 側だけがワークスペース／ファイル I/O を担当
- 純関数テストを追加（6面・コメント/文字列誤爆・top-level／bus 宣言抽出）。`npm run build` は成功、`npm test` は exit 0、追加テスト 4/4 pass。`npm run lint` は既存2警告のみ（新規変更は警告なし）

**関連**: #512（Phase A）・#463 C3

### 6.286 docs(spec): specs-v2 を Markdown 正本へ移行 #507 (Jul 18, 2026)

**Date**: 2026-07-18
**Status**: ✅ 完了（pandoc HTML→gfm 逆変換 + 残骸掃除 + fidelity チェック）

**内容**:
- アーティファクトが Markdown を直接レンダリングできるようになり「手書き HTML 正本」の根拠が消えたため（owner 決定・#507）、specs-v2 の HTML 5 本を .md 化して HTML を削除（PITCH_DSL / SESSION_LOG / WCTM / IMPLEMENTATION_INSTRUCTIONS / SIGNAL_CHAIN）。DESIGN_DISCUSSION_RECORD.html は .md が既に正本のため削除のみ
- fidelity チェック: タグ除去テキストの文字集合比較で HTML 側にしか無い文字は各ファイル 0.1〜4%（エンティティ・記号類）・見出し/コード/表は保存。WCTM の埋め込み SVG アーキテクチャ図は md 内にインライン保存
- pandoc 残骸（span/重複タイトル）を掃除。リポジトリ内の .html 参照を全て .md へ更新（CLAUDE.md「HTML が正本」→「Markdown が正本」含む）
- 補足: pandoc 禁止則は「md→HTML 再生成でテーマ破壊」方向の話であり、今回の逆変換（HTML を捨てる）には非該当

**関連**: #507（Closes）

---

### 6.285 docs(spec): Signal Chain DSL 正本制定 #506 (Jul 18, 2026)

**Date**: 2026-07-18
**Status**: ✅ 正本制定（owner との設計対話で決定 #64-#77 を確定・実装は #495 と同時設計で未着手）

**内容**:
- `docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md` 新設 — effect()/instrument()/文字列ルーティングを置き換える表記体系の正本
  - プラグイン名メソッド `receiver.PluginName(param: value)`（名前付き引数 = #460 オートメーションの静的端点）
  - 二層意味論（宣言層 = 可換な集合 / 信号層 = 順序を持つ列）
  - ミキサー first-class 宣言（`var mix = init global.mixer` → `mix.output(1,2)/sum/aux` 派生・卓の import レイヤリング・`import * from` 採用）
  - ノード型がメソッドの意味を決める（aux 名 = send / sum・output 名 = 本流の出力先・括弧なし）
  - ライブ意味論（再評価 = パラメータ更新・ブロック置き換え・コメントアウト = バイパス）
- DESIGN_DISCUSSION_RECORD §15 に決定ログ #64-#77 と経緯を追記
- 既存の文字列形 API は全て互換存置（素朴経路の恒久保護）

**関連**: #506・#495（同時設計）・#460・#497・#484 D4

---

### 6.284 fix(engine): VST3 effect の名前解決/補完受理 #504 (Jul 18, 2026)

**Date**: 2026-07-18
**Status**: ✅ 実装（PR #505・レビュー1名+検証1名で収束・実カタログ検証済み）

**内容**:
- owner 実機で `sum("bus").effect("` の補完が 0 件 → 原因 = effect に残る「CLAP のみ」ゲート（spec PH.3 の古い記述）。daemon は VST3 effect 配線済み（#397/#445・select_child_exe の拡張子読み替え）のため spec 先行更新の上で撤去
- PC.2 に `format/名前` 限定記法（clap/Name・vst3/Name）。format 名と同名 vendor が両方成立する場合は明示の曖昧性エラー
- 補完: 同名衝突は vendor+name キーで format 分割・残衝突は vendor/name ラベルにフォールバック。実カタログで effect 候補 71 件
- メソッド補完の静的リストに現行 API（effect/instrument/output/sum/aux）追加 — mixer graph 以前のリストのままで sum の後に effect が出なかった
- 派生記録: #474 = 右クリック本命は「挿してあるエフェクトの上で UI を開く」・挿入は補完 retrigger の疑似ドリルダウン・#495 に文脈判定要件が3件具体化

**関連**: #504（Closes）・#463・#474・#495

---

### 6.283 feat(orbitstudio): 選択=電源モデルの Engine ビュー #484 D3.5 (Jul 18, 2026)

**Date**: 2026-07-18
**Status**: ✅ 実装（計画は owner 承認済みアーティファクト・実装 Codex 4タスク・受け入れ監査済み）

**内容**:
- Engine ビューを「選択=電源」モデルへ転換: デバイス一覧を停止中も常時表示（D1 の `--list-audio-devices` 軽量列挙）・クリック状態機械 `resolveDeviceClickAction`（OFF時クリック=保存+起動 / ON時別デバイス=D2.5ライブ切替 / 選択中再クリック=解除+停止+設定クリア）
- 選択の三値化: 未設定=OFF / `__default__`=システム既定で ON / デバイス名=指名 ON（旧「空=既定にチェック」廃止）
- activate 時の自動 ON: 保存デバイスの**実在を列挙で確認してから**起動（不在=警告して起動しない・保存値は保持）・自動再スポーンなし・起動後5秒以内の exit は通知。deactivate + ParentWatch で終了時 OFF
- Engine 行=電源トグル（OFF は選択保持=一時停止）・Debug チェックボックス（`orbitscore.engineDebug`）
- UI 出口の一元化: welcome の Start/Debug/Stop 撤去・rust 時のステータスバー QuickPick 廃止（クリック=ビューを開く）・非常口はビュー最下部「Recovery」セクション（折りたたみ・Restart Engine / Reload Window）のみ・右クリックメニューは誤操作防止で不採用
- MCP `select_audio_device` も同状態機械（LLM からも選択=電源が成立）
- 派生決定: SC 退役 #502（フォールバック対象ですらない・opt-in も閉じる方向）・D5 複数出力は取り下げ（OS の Aggregate Device 責務）・WebviewView 化は #503（設定が固まってから）

**関連**: #484（残 = D4: バッファ/SR/入力）・#502・#503

---

### 6.282 feat(orbitstudio): Engine ビュー/MCP からの走行中デバイス切替 #484 D2.5 (Jul 17, 2026)

**Date**: 2026-07-17
**Status**: ✅ 実装（Sonnet 委譲・headless 実機で JSON ブリッジ確認）

**内容**:
- REPL メタ行 `//#selectAudioDevice <name>`（name 省略 = システム既定）を新設。#456 の `//#documentDirectory` 前例を踏襲しつつ、eval バッファに積まない帯域外処理（複数行入力の途中に挟まっても壊れない）。結果は 1 行 JSON `{"selectAudioDevice":{"ok":...}}` で stdout に相関出力
- `AudioEngineBackend` に optional `selectAudioDevice?()` を追加（RustEnginePlayer は D2 の daemon RPC を接続・SC は未実装のまま）
- 拡張: Engine ビューのデバイスクリックが、rust エンジン走行中はライブ切替を先に試行（成功 = 「switched to X」・capture 中 = 「録音中は切替できません」+ Restart 提案・その他失敗 = 従来の再起動フローへフォールバック）。stdout 行との相関は FIFO resolver + 10s タイムアウト
- MCP `select_audio_device` の rust 経路を「未対応エラー」から同ブリッジ経由のライブ切替に変更
- テスト +20（メタ行抽出/セッション統合/結果行パース/エラー翻訳）。1524 passed

**関連**: #484（残 = バッファサイズ・サンプリングレート・多ch・入力 = D4）

---

### 6.281 feat(engine): 走行中のオーディオデバイス切替 #484 D2 (Jul 17, 2026)

**Date**: 2026-07-17
**Status**: ✅ 実装（Codex + Sonnet 協働・実機切替 11〜99ms）

**内容**:
- native: `RenderState`（link/insert_buses/post）を Arc<Mutex> で callback と制御スレッドが
  共有（callback は try_lock・競合時は zero-fill + render_contentions カウンタ）。
  `rebuild_output_stream()` が同じ Engine/RenderState で新デバイスの stream を再構築
- daemon: **audio owner thread** 設計 — `cpal::Stream` は !Send のため、stream 所有を
  専用 OS スレッドに固定し、EngineWrap は Send+Sync な mpsc Sender だけ持つ。
  `SelectAudioDevice` RPC（空文字 = 既定へ）。全 6 feature 変種に一様適用
- capture 有効時は AUDIO_DEVICE_SWITCH_UNAVAILABLE で明示拒否（正直エラー）
- TS: daemon-client / rust-engine-player に selectAudioDevice 公開

**実機**: sine ループ再生中にスピーカー ⇔ Pro Tools Aggregate ⇔ 既定を切替 —
99ms/34ms/11ms・uptime 連続・loaded_samples/active_plays 保持・daemon 無再起動。

**残（D2.5）**: Engine ビュー/MCP からの即時切替接続 — 拡張 → 走行中 daemon への制御
チャネルが未存在（engine とは DSL-eval stdin のみ）。`//#selectAudioDevice` メタ行
（#456 の前例踏襲）で橋渡しする設計を提案として記録。

Refs #484


### 6.280 feat(orbitstudio): Engine ビューにデバイス表示/選択 #484 D3 (Jul 17, 2026)

**Date**: 2026-07-17
**Status**: ✅ 実装（D2 走行中切替は次段 — 選択は「次回起動時に適用」と正直に明示）

**内容**:
- daemon `--list-audio-devices` 軽量モード（cpal 列挙のみ・stream 非開 = hotfix の教訓で
  ハングリスク回避・JSON 1 行出力で即 exit）
- Engine ビューを TreeDataProvider 化（#483 の基礎）: 停止中は welcome ボタン・起動中は
  Engine 状態（クリックで toggle）+ Output Device 一覧（展開時 lazy 取得・ポーリングなし）
- デバイス選択 → `orbitscore.audioDevice` 設定（新設・machine-overridable）書き込み。
  起動中なら再起動を提案。設定の正 = VS Code 設定（.orbitscore.json は後方互換 fallback —
  palette/MCP の旧 write 経路の統合は follow-up）

**検証**: Rust 7 tests・TS 13 tests・tsc/lint/build green。実機: `--list-audio-devices` が
2 デバイス（MacBook Proのスピーカー default / Pro Tools Aggregate I/O）を返し即 exit。

Refs #484 #483


### 6.279 feat(orbitstudio): plugin catalog 補完 + rescan 3面 + MCP #463 C1b/C3 (Jul 17, 2026)

**Date**: 2026-07-17
**Status**: ✅ 実装（#463 完結・バケット A 1本目完了）

**内容**:
- **補完（PC.3）**: `.effect("` / `.instrument("` の引数位置でカタログ候補（name・vendor/format
  detail）。**タイプ中も絞り込み**（owner 要件 — 部分入力マッチ + range 明示で VS Code の
  prefix/fuzzy フィルタが効く）。effect は PH.3 どおり CLAP のみ・instrument は roles 適合
- **rescan 3面（C1b）**: palette コマンド + `.orbs` 右クリックメニュー + MCP `rescan_plugins`。
  設計変更 = daemon 経由でなく拡張が `orbit-plugin-scan` を直接 spawn（crash 隔離バイナリの
  ため daemon を経由する必然なし）。バイナリは copy-daemon-bin.sh + release gate に追加
- **MCP（PC.4）**: `list_plugins` / `rescan_plugins`（handler seam 必須メンバー）

**検証**: 拡張 tests 160（+11: 部分入力 `effect("Sca` → Scaler 絞り込み含む）・全体 1495
passed・tsc/lint clean。実機: スキャナ spawn → count 79・bundle 5 バイナリ確認。

**既知**: 実カタログに CLAP effect が 0 のため effect 補完の実データ経路は unit のみ
（CLAPTestEffect は標準外ディレクトリ — ORBIT_PLUGIN_PATH で追加可能）。

Refs #463


### 6.278 feat(dsl): plugin catalog 名前指し #463 C2 (Jul 17, 2026)

**Date**: 2026-07-17
**Status**: ✅ 実装（バケット A 先頭・owner の「フルパスをどうにかしたい」に応答）

**内容（PC.2 準拠）**: `kick.effect("TAL Reverb 4")` / `seq.instrument("Scaler 3")` —
- 判別 = path-direct 形 or 既知拡張子 → 従来 path 解決（不変）・それ以外 → カタログ名
  （audio 系 looksLikePath は不使用 — vendor 修飾が `/` を含むため専用判別）
- 一致 = NFC/case-insensitive/trim・曖昧は候補列挙エラー・`"vendor/name"` 修飾
- 解決 = (path, pluginId) の組を LoadPlugin へ・名前指し + pluginId 引数の併用はエラー
- format 優先 = verb 受理内で CLAP > VST3・受理不能は専用エラー・未ヒットは rescan 案内
- カタログ読取 = plugin-catalog.ts（mtime キャッシュ・`ORBIT_PLUGIN_CATALOG` で注入可）

**意図的挙動変更**: 既知拡張子なしの裸名（例 `effect.wav`）は拡張子エラーでなくカタログ
解決へルーティング（PC.2 の規範・既存テスト 2 件を `./` 付きに更新）。

**検証**: 新規 25 tests・全体 1473 passed・tsc/lint clean。実カタログ（79 entries）で
"Scaler 3" → VST3 path + CID 解決・"Mic Room"（VST3-only）を effect() で専用エラー確認。

Refs #463


### 6.277 fix(native): device 解決の CoreAudio ハングを解消 #484 hotfix (Jul 17, 2026)

**Date**: 2026-07-17
**Status**: ✅ 修正・確認 E2E 全 PASS（owner 指示の「バグ確認 E2E」が main の P0 を検出）

**発見**: マージ直後の確認 E2E で engine 起動が ready line timeout。スタック採取で確定 —
`resolve_output_device` の `host.output_devices()` は cpal 内部で各デバイスの
supported_output_configs を probe（AudioUnit + CreateIOProcID 生成）し、Aggregate
デバイス等で CoreAudio 内ブロック。boot が設定デバイス名を渡すようになったため
**OrbitStudio の既定起動が壊れていた**（環境依存で顕在化 — D1 実装時の実機検証は通過
していた）。

**修正**: 起動クリティカルパスは probe なしの `host.devices()` 名前照合のみに。config
検証は選択後の stream 構築（1 台のみ）に委ねる。3 ケース（実在名/不在名/指定なし）で
即 ready を確認。

**確認 E2E（アプリ経由・全修正の再検証）**: #476 = effect 入りファイル一括実行 →
peak 0.35355 一致 / #478 = soundDetected true（onset 1）+ windows 2197・steady 0.3536 /
#480 = stale 偽装 → 503 + rebuild hint → 復元 200 / #487 = ビルド時 rebuild 走行確認。

**既知 Minor**: daemon stderr のデバイス fallback 警告が拡張ログに未転送（可視性・別途）。

Refs #484


### 6.276 feat(daemon): audio device enumeration + startup selection #484 D1 (Jul 17, 2026)

**Date**: 2026-07-17
**Status**: ✅ 実装・実機検証済み（D2 = 走行中切替 / D3 = 拡張 UI・MCP 配線は別 PR）

**内容**: owner MUST 要件（デバイス選択）の第1段。
- `ListAudioDevices`（JSON-RPC）: cpal output device 列挙 `{name, isDefault,
  maxOutputChannels, defaultSampleRate, direction}`（direction は将来の入力用予約）
- `--audio-device <name>` の起動時 honor: 完全一致 → 該当デバイスで stream 構築・
  不在 → 利用可能デバイス一覧付き警告 + デフォルト縮退（従来の「not yet honored」
  WARNING を撤去）。layering は capture_path と同型（env は engine_wrap に集約・
  native crate は明示引数）
- TS: daemon-client に listAudioDevices + audioDevice option・rust-engine-player の
  boot(outputDevice) が実際に渡すように

**検証**: Rust unit 8（名前解決・argv parse）+ TS 4・clippy/fmt/feature 組み合わせ green・
npm 1448 passed。実機: ListAudioDevices が実デバイス 2 件（MacBook Proのスピーカー
default / Pro Tools Aggregate I/O）を返却・不在名で警告 + 縮退起動を確認。
（監査メモ: release バイナリの strings 検査は 16 byte リテラルの即値比較最適化で
偽陰性になる — 機能スモークが正・ParentWatch #479 と同じ教訓）

Refs #484


### 6.275 docs(spec): MX.2 の「未宣言名はエラー」を実挙動に整合 #477 (Jul 17, 2026)

**Date**: 2026-07-17
**Status**: ✅ spec 修正（トリアージ = spec 側が誤り）

**内容**: 品質チェック E2E で MX.2「未宣言名はエラー」と実装（sum 非該当名は LinkAudio
channel として記録 + 警告 = §8.1.2 の既存挙動）の矛盾を検出（#477）。トリアージ:
「後から global.linkAudio() を宣言する」既存ワークフローを壊す実装厳格化より、spec の
overstatement を訂正するのが正 — MX.2 を「記録 + 警告（ハードエラーではない）」に修正。

Refs #477

---

### 6.274 fix(mcp): analyze_audio — soundDetected 偽陰性修正 + 窓分析 #478 (Jul 17, 2026)

**Date**: 2026-07-17
**Status**: ✅ 修正

**内容（LLM の「耳」の強化）**:
- soundDetected: 旧判定は ≥3 onsets を要求し one-shot 1 発（peak 0.7）を false と誤報
  （品質チェック E2E で実測）→ ≥1 onset + peak > 0.05 に修正
- `window_ms` オプション追加: per-window peak/RMS 系列を返し、MX.5 の「dry 先行 →
  干渉定常」のような時間構造を MCP 経由で検証可能に（従来はローカル python 直読みに
  フォールバックしていた = MCP 実装漏れ枠の解消）

**検証**: 新規 3 tests（one-shot 検知・窓系列の時間構造・省略時は系列なし）+ 既存
wav-analysis/docs-http 72 tests green。

Refs #478

---

### 6.273 chore(build): bundle 前に daemon+child を再ビルド #487（#479 の真因対策）(Jul 17, 2026)

**Date**: 2026-07-17
**Status**: ✅ 修正

**#479 の調査結論（実測）**: ParentWatch のコードバグではなく **stale バイナリ**が真因。
orphan ×3 は全て #462 修正前のビルド（バイナリ内に ParentWatch 文字列 0 ヒット・mtime が
修正コミットより古い）。現行ソースの fresh build は daemon SIGKILL 後 1 秒以内に child 退出
（実機 fail-before/pass-after 確認）。4 child crate は同一機構・divergence なし。

**対策**: copy-daemon-bin.sh が cargo の使える環境では bundle 前に daemon + 全 child を
release 再ビルドする（incremental・実測 6 秒）。cargo 不在は従来の best-effort（警告付き）。
検証は機能テストで実施 —
bundled release バイナリで daemon SIGKILL → 元 child が退出(PASS)・TS respawn 機構が
新 daemon + effect を自動復元することまで確認(release はシンボル strip のため strings
検査は無効・当初の文字列確認記述を訂正)。

Refs #487 #479 #462

---

### 6.272 fix(mcp): stale dist（base 不一致）検出ガード #480 (Jul 17, 2026)

**Date**: 2026-07-17
**Status**: ✅ 修正

**内容**: docs 配信に `isDocsDistStale()` を追加 — index.html に `base + '/assets/'` 参照が
無い dist（base 変更前の古いビルド）は、未ビルト時と同じ 503 + rebuild 手順の actionable
メッセージに落とす（従来は壊れた素 HTML を黙って配信）。mtime キャッシュでリクエスト毎の
同期 read を回避。unit 4 件（正常/不一致/不在/mtime 再検査）+ 既存 docs-http 36 件 green。

Refs #480

---

### 6.271 fix(engine): REPL 行処理の FIFO 直列化 #476 (Jul 17, 2026)

**Date**: 2026-07-17
**Status**: ✅ 修正・実機再現シナリオ PASS

**内容**: readline の同 tick 連続 'line' イベントを FIFO promise チェーンで直列化
（`createReplSession` として分離・単体テスト可能に）。旧実装は async ハンドラが互いを
待たず、共有 buffer が「実行中 execute 完了前に伸びる → 累積 buffer の重複実行・
完了時 clear との競合」を起こす構造だった（unit テストは旧実装で fail する形で
ピン留め: 全行 1 回ずつ順序実行・失敗行が後続を失わない・不完全入力の buffering 維持）。

**根因の訂正（issue に反映）**: 当初の「effect 入りファイル一括実行で無音」の実機再現は、
E2E ドライバの set_selection 境界の取り違え（end_char 省略 = end_line の行頭 → 最終行
RUN が選択外）が混入していた。競合自体は構造的に実在（汚れセッションでの誤エラーも同根）。

**検証**: 新規 3 tests・全体 1436 passed。ヘッドレス REPL で全行実行確認。実機
（OrbitStudio + MCP・正しい選択）で effect 入り 9 行ファイル一括実行 → capture peak
0.35355（オラクル一致）。

Refs #476

---

### 6.270 chore(qa): docs-driven 実機 E2E + 学習サイト最新化 #481 (Jul 17, 2026)

**Date**: 2026-07-17
**Status**: ✅ 品質ゲートフェーズ（owner 方針: docs の主張 ⇔ 実装 ⇔ 教材 ⇔ MCP 面の
4 者を実機で突き合わせる。切れ目のスコープ）

**実機 E2E（OrbitStudio + MCP・SOUND CONFIRMED）**:
- import プロジェクト（editor 経路・I3 メタ行）: peak 0.70711 オラクル一致・IM.4 module
  相対 audio パス実機確認・契約エラー表出確認
- sum insert（CLAPTestEffect）: 0.35355 一致 / aux send: dry 先行 0.7071 → 干渉定常
  0.4965（MX.5 の no-PDC 記述どおり）
- MCP 12 ツール疎通（open/select/run/edit_replace/save/get_document_text 等）

**炙り出した発見（全て issue 化）**: #476 REPL 複数行バッファ競合（遅い await で後続行
消失）・#477 MX.2 と LinkAudio fallback の spec 矛盾・#478 analyze_audio の耳の限界・
#479 ParentWatch 不全（orphan effect-child ×8 が CPU 95% 空回り）・#480 stale dist 配信

**学習サイト**: user サイトに mixing/effects・mixing/routing・projects/import（日英 6 章 +
sidebar）を新設 — スニペットは本日の実機 E2E 通過分を verbatim 使用。**エンドユーザー
サイトの配信を追加**（MCP server が /orbitscore/ で sites/user を配信・dev は
/orbitscore/dev/ のまま・最長プレフィックス routing）。導線 = 目立つボタン類は user
サイト（orbitscore.openDocs 新設）・dev はパレットのみ（owner 指示・「個人学習ノート」
表現は「技術解説ラーニング」へ）

**spec 同期**: IM/PC の Status 行の stale（「未実装」のまま）を実装事実に更新

Refs #481


### 6.269 feat(rust): plugin catalog scanner C1 — orbit-plugin-scan #463 (Jul 17, 2026)

**Date**: 2026-07-17
**Status**: ✅ 実装（実機スモーク済み・daemon 配線 C1b / DSL 解決 C2 / 補完 C3 は別 PR）

**内容**: カタログスキャナを**独立バイナリ** `orbit-plugin-scan` として新設（crash 隔離・
#397 の isolation 原則）。標準ディレクトリ + ORBIT_PLUGIN_PATH（非再帰）を走査し
`~/.orbitscore/plugin-catalog.json`（atomic write）を生成。

**設計変更（owner 実害報告に基づく・spec へ反映済み）**: VST3 の probe fallback（実ロード）
はコンテンツ依存プラグインがネイティブダイアログを出す実害が出たため**撤去**。v1 は
moduleinfo.json のみ（Steinberg の trailing-comma 方言は string-aware ストリッパで対応・
Audio Module Class のみエントリ化・Sub Categories で role 推定）。CLAP は既存 discovery に
vendor/features を追加して利用。

**検証**: 新規 20 unit + orbit-clap-host 21 green・clippy/fmt clean。実機スモーク:
ダイアログなしで完走・VST3 335 バンドル中 79 エントリ化 / 256 skip（moduleinfo 無し・
summary で開示）。CLAP は実機に 0 個のため fixture のみ（既知の残テスト）。

**残**: skip 256 の解消 = UI 抑止付き probe（C1b 検討）・daemon ScanPlugins 配線・C2/C3。

Refs #463


### 6.268 docs(spec): plugin catalog spec 起草（PC.1-PC.5）#463 (Jul 17, 2026)

**Date**: 2026-07-17
**Status**: 📝 spec 起草（docs のみ・実装は C1-C3 で別 PR）

**内容**: owner 発案「名前とかメーカーとかから自動補完」を plugin カタログ + 名前指し +
エディタ補完として仕様化。core spec に「Plugin Catalog」節を新設。

**主要決定**:
- カタログ = OS 標準ディレクトリ + ORBIT_PLUGIN_PATH のスキャン。キャッシュ
  `~/.orbitscore/plugin-catalog.json` が正本・スキャンの持ち主 = daemon（probe 資産 #397）
- 名前指し: path-direct 形/既知拡張子 → 従来 path 解決（不変）・それ以外 → カタログ名。
  曖昧は候補列挙エラー・`"vendor/name"` 修飾・CLAP > VST3 優先・role 検査
- 補完はキャッシュ読取のみ（engine 起動不要）・MCP list_plugins / rescan_plugins
- 段階導入 C1（scan+cache）→ C2（DSL 解決）→ C3（補完+MCP）

Refs #463


### 6.267 refactor(engine): unify effect-slot pool + self-heal across 3 managers #468 (Jul 17, 2026)

**Date**: 2026-07-17
**Status**: ✅ 実装（既存テスト全 green = 挙動ピン留めの下で統合）

**内容**: `PluginEffectManager` / `SequenceEffectManager` / `MixerManager` に ~15 行ずつ
複製されていたパターンを `effect-slot.ts` に一本化:
- `resolveEffectSpec()` — validate → LinkAudio gate → resolve（順序 load-bearing）
- `EffectSlotMap<K>` — 冪等再宣言 + respawn 後 self-heal（isPluginActive=false → 再ロード）+
  install/rollback（自分の宣言のみ削除）。master insert は 3 引数呼びを維持（既存契約）
- `BusPool` — prefix 連番 + free-list（失敗が pool を恒久消費しない #461 根拠を共通化）

SequenceEffectManager は buses（passthrough 含む routing 用割当）と slots（実 insert）を
分離し、「昇格/self-heal 失敗時は bus を返却しない・新規割当失敗のみ free-list へ返す」
固有ロールバックを catch 側に残した。MixerManager は sum/aux を同型 KindState 2 面に。

**検証**: 既存の manager 系テスト（global-plugin-effect / sequence-effect /
global-mixer-sum-aux 等）を変更せず全 green・全体 1425 passed。

Refs #468 #467
### 6.266 feat: import I3 — REPL メタ行で基準ディレクトリを帯域外先渡し #456 (Jul 17, 2026)

**Date**: 2026-07-17
**Status**: ✅ 実装（unit 検証済み・OrbitStudio 実機 MCP E2E は別途 = owner「あとでもいい」）

**問題**: VS Code 拡張は基準ディレクトリを `global.setDocumentDirectory(...)` の **DSL 注入**
（statements として実行）で渡すが、import 文（IM.2）はどの statement よりも先に評価される
ため、拡張 REPL 経由の import は IM.6 ガード（基準未解決エラー）に落ちる。

**解決**: REPL プロトコルにメタ行 `//#documentDirectory <path>` を追加（帯域外チャネル）。
- engine (repl-mode.ts): `extractDocumentDirectoryMeta()` で抽出し `execute()` の
  `documentDirectory` option に渡す（セッション内で最後の値が持続 = ファイル切替追従）。
  `//` コメントなので DSL として無害（tokenizer が読み飛ばす）
- extension (extension.ts writeCodeToEngine): メタ行を常に先頭へ prepend。既存の DSL 注入
  は残す（audio() 既存経路の実績を変えない・同値の冪等再設定）

**検証**: 新規 6 tests（抽出・重複時 last-wins・空白/スペースパス・DSL 無害性・メタ経由
import 解決）。全体 1431 passed。拡張 tsc --noEmit clean。

**残**: OrbitStudio 実機 MCP E2E（task 化済み・Agent Bridge の SOUND CONFIRMED ループ再利用）

Refs #456

### 6.265 feat(engine): file import declaration — parser + interpreter (I1+I2) #456 (Jul 17, 2026)

**Date**: 2026-07-17
**Status**: ✅ 実装・実機 E2E 済み（spec = IM.1-IM.6・PR #469 マージ済みの正本に準拠）

**内容**:
- **parser (I1)**: `import { names } from "./file.orbs"` を既存 `import chords` と同一キーワードで
  分岐パース（次トークン `{` = file import）。パス検査（`./`|`../` 開始・`.orbs` 必須）・
  先頭領域検査（非 import 文の後の import はエラー）。IR は `fileImports` 別バケット
  （評価順序の規範を担保）
- **interpreter (I2)**: `process-file-import.ts` 新設。realpath ベースの module cache
  （ダイヤモンド 1 回評価）・循環検出（entry 含む stack）・契約検査（IR 静的宣言列挙 vs
  names）・transport 禁止（IM.3）・module 評価中は documentDirectory を module dir に
  差し替え（IM.4: audio() は呼び出し時即時解決のためこれで成立）・entry の宣言は常に最後
  （IM.2 評価順序）
- REPL/部分 eval: sourceFile 無しは documentDirectory 基準・どちらも無ければエラー（IM.6）

**検証**: 新規 spec 17 tests（parser 7 + interpreter 10: merge/契約/循環/自己 import/
ダイヤモンド/transport 拒否/transitive パス/REPL 基準/基準なしエラー）。全体 1420 passed。
実機 E2E: module（`./sine_880.wav` = module 相対）を entry が import → RUN → capture
peak 0.70711（オラクル一致・IM.4 実機確認）。

**残（I3・別 PR）**: VS Code 拡張の import 行対応（診断抑制・保存時再評価の動線）。

Refs #456

### 6.264 docs(spec): import 宣言の spec 起草（IM.1-IM.6）#456 (Jul 17, 2026)

**Date**: 2026-07-17
**Status**: 📝 spec 起草（docs のみ・実装は I1-I3 で別 PR）

**内容**: DocDD に従い、実装前に core spec（INSTRUCTION_ORBITSCORE_DSL.md）へ
「Import / Project 構成」節を新設。設計種 = POST_2.0_MIXER_DSL_DESIGN.html §8。

**主要決定**:
- 構文 = `import { name, ... } from "./file.orbs"`（名前列挙 = 契約検査・`.orbs` 必須・
  既存 `import chords` と文法判別で共存）
- 意味論 = **グラフの合成**: 名前キー reconciliation（MX.1 と同一原理）に乗せ、
  再評価 = 再束縛（hot-reload identity）。`var global = init GLOBAL` は import 先にも
  書ける（冪等・standalone-evaluable）
- project/performance 分離: import されたファイルは宣言専用（transport はエラー）
- パス解決 = 各ファイル自身のディレクトリ基準（audio() 含む・規範）
- 循環 = エラー・ダイヤモンド = 1 回評価・v1 はモジュールスコープなし（export は予約）

**根拠調査**（Explore・実コード裏取り）: `import` は tokenizer/AST で stdlib 専用に既存予約
（parse-statement.ts）・名前空間はフラット Map（interpreter/types.ts）・名前キー再利用は
process-initialization.ts に既存 — 「import = 名前一致 merge」は既存 reconciliation 機構の
自然な拡張として成立する。

Refs #456

**Date**: 2026-07-17
**Status**: ✅ 実装・実機 E2E 済み（PR 作成・レビューフローへ）
**Branch**: `459-mixer-graph-impl`
**Commits**: M0 spec = PR #466（マージ済・MX.1-MX.5）/ M1 `3029545` / M2 `95d3fc9` / M3 `7b70b1b`

#434 の insert bus 基盤の上に DAW ミキサー構造（group/send-return）を実装。
設計 = Fable main（issue #459 コメントが決定記録・fan-out は event 複製でなく
bus 処理段の copy 加算 = render_multi 無変更が核）。実装 = Sonnet xhigh ×3 + main 監査。

**M1（core）**: InsertBusStage に output_target/sends・validate_bus_topology
（前方参照のみ = 配列順がトポロジカル順・ネスト/循環が構造的に不可）・
is_render_target 分離（member だけ active な sum が中継点として生きる）。
closed-form unit（sum ×0.5・send dry+wet ×0.75）・既存テスト無変更 green。

**M2（daemon）**: BusKind（Insert/Sum/Aux）プール・実行時 routing の atomic overlay
（routing_override + 全後方 slot 事前確保の send_gain_overrides = RT は Relaxed load のみ）・
SetBusRouting protocol（前方参照 + kind + 有限 gain を non-RT 検証・部分適用なし）。
**実機 gated: insert→sum→aux カスケード全段厳密半減 0.70711→0.35355→0.17678→0.08839**。

**M3（DSL）**: MixerManager（global.sum()/aux()・ハンドル .effect()）・
seq.output()（sum 解決 + insert 未宣言時の pass-through 自動確保）・
seq.send()（累積・全状態冪等再送）・set_bus_routing での activation・
parser に裸 sum()/aux() 受理。

**実機 E2E（DSL・capture）**:
- **sum oracle: peak 0.35355 厳密一致**
- **aux oracle: 窓解析で send 実効を実証** — 第1窓 0.7071（dry のみ・wet は OOP
  pipeline 1 block 遅延）→ 定常 0.4965（dry+位相シフト wet の干渉）。素朴期待値
  1.06 との差 = **MX.5 の既知制約（PDC なし）の実観測**（spec と実挙動が一致）

**検証**: npm test 1397 / rust 3構成 80/56/115 / gated（mixer 新設 + bus/both 退行なし・
実機）/ clippy --all-targets / fmt。

### 6.262 feat(engine): seq.effect() per-sequence insert — S1〜S3 完走 #434 (Jul 17, 2026)

**Date**: 2026-07-17
**Status**: ✅ 実装・実機 E2E PASS（PR 作成・レビューフローへ）
**Branch**: `434-per-sequence-effect-insert`
**Commits**: `42edbc1`(S1) / `2fba667`(S2) / `84c64b5`(spec PH.2b) / `450a7e0`(S3)

owner 最優先要望（mem: owner-wants-seq-effect-per-track）の履行。設計 = Fable main
（S0 spike + issue #434 コメントに確定記録・owner 指示により advisor 相談なし）。
実装 = Codex（S1）→ Sonnet xhigh フォールバック（S2b/S3・Codex sandbox EPERM）。

**S0 spike（性能ゲート）**: 64f budget ≈1.33ms に対し 1 OOP effect の callback max
= 64µs（~4.8%）・stale 0% → per-bus 直列 OOP 成立を実測確認。

**S1（core・挙動不変）**: InsertBusStage（named bus + ordered stages）を render
パイプラインへ。bus 0 個で bit-identical・**未登録 bus tag の永久 retain landmine 対策**
（登録 bus は processor 未 attach でも pass-through で event 消費）を fail-before/
pass-after で固定。LinkAudio 併用時も render_multi 1回。

**S2（daemon N-slot）**: bus id キーの per-bus effect slot 群（専用 shm/child/watchdog/
stats）・LoadPlugin `bus` param・effect-only/both 両経路・StreamGuard が全 bus guard 保持。
受け入れ監査で3点修正（attach 中の outproc mutex 長期保持 / gated の計測手段が
engaged=false 設計と矛盾 / both gated の pipeline 1 ブロック遅延 race）— いずれも
**実機 RUN が検出**（#445 の教訓の再現）。gated bus 2/2 実機 PASS（**ratio 0.50000**・
bus 隔離・child 回収）・both/effect gated 退行なし。

**spec 先行（DocDD）**: core spec に **PH.2b** 新設（処理順 = per-seq insert → master mix
→ global.effect・1 seq 1 insert・bus プール上限 8・PDC 非対応等の v1 制約明記）。

**S3（DSL 配線）**: 既定 bus プール（ORBIT_EFFECT_BUS_POOL・seq-bus-0..7）・PlayAt
`bus` param（channel と排他）・TS SequenceEffectManager + `Sequence.effect()`（note seq
は v1 エラー）・insertBus の scheduling 全経路配線。**実装中に respawn 後 plugin
再ロードの単一キャッシュバグを発見修正**（複数 plugin で最後の1つしか復元されない →
role:bus キー Map 化）。

**実機 E2E（DoD）**: sine_880.wav を `drums.effect(CLAPTestEffect.clap)` あり/なしで
capture 比較 → **peak ratio = 0.50000 厳密一致**（0.70711 → 0.35355）。DSL →
LoadPlugin(bus) → PlayAt(bus) → render_multi bus routing → OOP child gain →
master sum の全経路を客観実証。

**検証**: 3 feature 構成 lib（67/56/102）・workspace build/clippy/fmt・
npm test 1354 passed / 0 failed・gated 3 スイート実機 PASS。
### 6.261 feat(vscode): docs entry point 全部入り（Activity Bar / Webview panel / Walkthrough）#457 (Jul 17, 2026)

**Date**: 2026-07-17
**Status**: ✅ 実装（PR 作成・レビューへ）
**Branch**: `457-docs-entry-points`

owner 決定「どれもあっても困らない」= #450（status bar + openDevDocs）に加え、学習サイトへの
入口を全部入りで用意。前提資産（#450・不変）: `orbitscore.openDevDocs` コマンド・MCP HTTP サーバの
`/orbitscore/dev/` static 配信・status bar `$(book) Docs`。

- **Activity Bar view container**: `contributes.viewsContainers.activitybar` に OrbitScore
  コンテナ（`media/icon-activitybar.svg`）+ `contributes.views` の Learning view（`viewsWelcome`
  で 3 ボタン: Open Learning Site (Browser) / Open in Editor / Start the Walkthrough）。
  TreeView 本実装（章ツリー）は #451（サイト構成確定後）の follow-up と明記
- **Webview panel**: 新コマンド `orbitscore.openDevDocsPanel` — `vscode.window.createWebviewPanel`
  で editor タブに `<iframe src="http://127.0.0.1:<port>/orbitscore/dev/">` を全画面表示
  （CSP で `frame-src http://127.0.0.1:*` を明示・retainContextWhenHidden・シングルトン管理・
  MCP サーバ未起動時は openDevDocs と同文言でエラー表示）
- **Walkthrough**: `contributes.walkthroughs` に `orbitscore.learnOrbitScore`（新コマンド
  `orbitscore.openWalkthrough` から起動）。v1 4 ステップ（Open Learning Site→
  onCommand:orbitscore.openDevDocs / Start the Engine→onCommand:orbitscore.toggleEngine /
  Run your first sound→onCommand:orbitscore.runSelection / Explore plugin hosting→
  completionEvents なし・手動チェック）。ステップ本文は `media/walkthrough/*.md` に
  日本語+英語併記（package.nls ローカライズより工数が軽いため採用・両言語を1ファイルに集約）
- **既存導線維持**: status bar / openDevDocs は不変。`.orbs` を開いている時の
  `editor/title` メニューに `$(book)` ボタン（`orbitscore.openDevDocs`）を追加
- 検証: `npm run build` green・vscode-extension テスト 130/130・変更 ts ファイル lint クリーン
- 妥協点: 4番目のステップ（Explore plugin hosting）は `onLink` completionEvent の VS Code 側
  対応が不確実なため completionEvents を省略し手動チェックに倒した

### 6.260 feat(mcp): dev learning site のローカル配信 + MCP ツール + OrbitStudio 導線 #450 (Jul 17, 2026)

**Date**: 2026-07-17
**Status**: ✅ 実装（PR 作成・レビューへ）
**Branch**: `450-mcp-dev-docs-serving`

owner 要望「learning site をユーザー/LLM がローカル参照できるように。MCP サーバに
機能的に組み込み、ブラウザ経由・MCP 経由で見れるように。OrbitStudio からワンクリック」。
実装 = Codex 委譲 + main の受け入れ監査（base 整合の修正1件）。

- **static 配信**: 拡張内 MCP HTTP サーバ（mcp-server.ts・127.0.0.1）に
  `sites/dev/.vitepress/dist` の配信を追加。**配信 prefix = SITE_BASE
  （`/orbitscore/dev/`）と一致させる**（dist 内の asset/ナビ URL は base 絶対
  パスのため、他 prefix では全 asset が 404 になる — 受け入れ監査で検出し
  `/docs` は 302 redirect に変更）。path traversal 防御（decode → `..`/`\` 拒否 →
  resolve 後に root 内検証）・Host-header allowlist は `/mcp` と共通・dist 不在時は
  503 + ビルドコマンド案内
- **MCP ツール**: `get_dev_doc(path)`（ソース md を site 相対パスで取得）・
  `search_dev_docs(query, limit)`（md 全文の case-insensitive 検索・
  {path,line,excerpt}）。LLM がサイト本文を直接参照できる
- **OrbitStudio 導線**: `orbitscore.openDevDocs` コマンド + status bar `$(book) Docs`
  ボタン（MCP サーバ起動時のみ表示・`vscode.env.openExternal`）
- unit テスト: resolveDocsRoot / resolveDocsFilePath（traversal・%2e%2e）/
  readDevDoc / searchDevDocs（.vitepress 除外）
- 検証: npm run build green・vscode-extension テスト 122/122・変更ファイル lint クリーン
- 関連: #451（サイト内容の 2026-07 追随・日英・E2E 兼用カリキュラム）が別トラックで進行

### 6.259 docs: Plugin Hosting docs 同期（#421 / #445 実装事実の反映） #449 (Jul 17, 2026)

**Date**: 2026-07-17
**Status**: ✅ 完了
**Branch**: `449-docs-plugin-hosting-sync`

DocDD 監査で、#421（VST3 instrument production・PR #447 マージ済）と #445（VST3 effect
child READY handshake・PR #446 マージ済）の実装事実が docs に反映されていない遅れを検出。
以下を修正:

- `docs/core/INSTRUCTION_ORBITSCORE_DSL.md`: PH.3 の format 受理表を role 別（instrument =
  `.clap`/`.vst3`、effect = `.clap` のみ）に更新。Not Yet Implemented セクションと
  Plugin Hosting 節ヘッダに #421 / #445 の参照と、VST3 instrument の先送りスコープ
  （CC / per-note expression / tempo #408）を追記。
- `docs/testing/TESTING_GUIDE.md`: VST3 Instrument Gated Fixture Tests 節を新設
  （`orbit-vst3-instrument-child` ビルド手順 + gated テストコマンド + oracle 期待値 0.25）。
- `docs/user/ja/USER_MANUAL.md`: Plugin Hosting（CLAP / VST3）節を新設（ユーザー向け構文・
  対応フォーマット表）。
- `CLAUDE.md`: Test Status / npm test コメントのテスト件数を現状（1333 passed, 29 skipped,
  1362 total）に更新。

### 6.258 feat(vst3): VST3 instrument production — Pitch DSL が VST3 で鳴る実機 E2E #421 (Jul 16, 2026)

**Date**: 2026-07-16
**Status**: ✅ 実装・実機 E2E PASS（PR 作成・レビューフローへ）
**Branch**: `421-vst3-instrument-production`
**Commits**: `25e5360` (Stage 1) / Stage 2 / Stage 3 / `a09d7fb` (Stage 4)

Epic #424 の CLAP instrument 経路（#427）を VST3 に横展開。単一 PR + Stage ごとの
細かいコミットで実装（owner 確定方針・overnight 自律走行）。実装 = Codex fresh
スレッド×4（Stage 分割・自己完結ブリーフ）+ main の受け入れ監査。

**スコープ = note on/off のみ**。CC→IMidiMapping / per-note expression / tempo(#408) は
owner 設計セッションへ明示先送り（PR に doc 化）。

**Stage 1（orbit-vst3-host）**: `Vst3InstrumentProcessor` 新設 — instrument 判定
（audio in=0/out>0・event input bus 必須・effect は NotInstrument で明示拒否）、
headless EditController + IConnectionPoint、event input bus の明示 activateBus、
note on/off を積む `HostInputEventList`（IEventList 実装）、process は add-mix
（CLAP 版と同意味論）、teardown は effect の規律踏襲。

**Stage 2（orbit-vst3-instrument-child 新 crate）**: clap 版の transport ミラー
（event slot 消費・in-order seq・output window/spill・publish_child_ready）。
**VST3 に NOTE_END が無い非対称は child 内で吸収**: NoteOff/NoteChoke 処理時に
同 addr/sample_offset の synthetic NoteEnd を output window へ書く（host の
(port,channel,key) 参照カウント簿記は無改変・Fable 確定設計）。wildcard は 0 丸め、
NoteChoke は velocity 0 の NoteOff 化。push API に sample_offset 追加。

**Stage 3（テスト）**: `orbit-vst3-synth-oracle` 新設（clap-test-synth の SineVoice
ミラー・振幅 0.25・package-oracle.sh）+ offline テスト（発音→0.25±0.01→note off→無音、
effect 拒否の負テスト）+ `outproc_instrument_vst3_gated.rs`（CLAP 版ミラー3本）。
**gated 実機 RUN 3/3 PASS**: post_mix_peak=0.25000・synthetic NOTE_END で
probe_live_count 0 復帰・SIGKILL respawn 回復。

**Stage 4（daemon + DSL 配線）**: attach 時に拡張子で instrument child を選択
（.vst3 → orbit-vst3-instrument-child・それ以外は従来どおり CLAP child。
デフォルト名 child の同ディレクトリ差し替え = 対称・冪等な純関数）。
`validatePluginExtension` を role 対応化（instrument = .clap/.vst3・effect = .clap のみ）。
release.yml / copy-daemon-bin.sh に VST3 child 同梱。

**受け入れ監査で Codex 実装から2点修正（実機 gated RUN で検出・#445 の教訓が的中）**:
① 拡張子 validation が CLAP gated の raw .dylib attach を破壊 → 未知拡張子は
reject せず CLAP child へ ② child exe 再導出が current_exe 基準でテストハーネス
（deps/ 配下）を壊す + retry 後に .clap へ戻らない → 親ディレクトリ基準の対称読み替えに。
fail-before/pass-after: CLAP gated 0/3 → 3/3。

**実機 E2E（DoD・self-run は owner 常時許可の範囲）**:
.orbs（`global.key("C")` + `seq.instrument("SynthOracle.vst3")` + `play(1,3,5,8)` +
`RUN(synth)`）を配布構成 release daemon + cli-audio.js + `ORBIT_CAPTURE_WAV` で実行 →
**capture peak = 0.25000（厳密一致・synth 既知振幅）**。CLAP baseline も同手順で
0.25000（経路パリティ）。DSL → LoadPlugin(role=instrument) → 拡張子ベース child 選択 →
VST3 child → IEventList note on/off → sine 発音 → master bus の全経路を客観実証
（スピーカー実再生込み）。
※ ハーネスの学び: `play()` はパターン buffering のみで発音には `RUN(seq)` が必要
（WORK_LOG 6.x 既知の RUN/LOOP 忘れ silent 再現を踏んだ）。

**検証**: cargo workspace build / clippy -D warnings / fmt・daemon unit 54 + protocol 28・
CLAP gated 3/3 + VST3 gated 3/3（実機）・npm test 1333 passed / 0 failed。
既知 flake: offline テスト初回ビルド時の oracle packaging 並行競合（既存パターン・
Stage 1 以前から存在・再実行で安定 green）。

**/simplify（4観点並行・PR #447）**: reuse/efficiency/altitude = クリーン判定。
simplification 2件適用（oracle packaging ヘルパー統合・NoteOff/NoteChoke 分岐統合）。
適用後 gated 3/3 実機再RUN green（`2389f12`）。

**/code:pr-review-team（round 1-3・収束）**:
- round 1（4レビュアー並行）: Critical 2（plugin-resolver doc 例の stale シグネチャ /
  select_child_exe 配線の CI テスト欠如）+ Important 4（ガード早期 return の stale
  input events / event_decode_error_count 未ミラー / child 選択の log なし /
  process() tresult 破棄）+ テスト増強2件 → fixer 一括適用（`a34fce0`・
  classify_event 純関数抽出 + unit テスト5本含む）
- round 2（収束チェック）: 残余 Important 1（decode counter が ticker 経路まで
  届いていない）+ Minor 2 を検出 → 7-tuple 化 + 新 WARNING
  `OUTPROC_INSTRUMENT_EVENT_DECODE` 配線等で解消（`beedd24`）
- round 3: **全 RESOLVED・新規指摘なし・Critical/Important = 0 で収束**
- CI 4/4 pass（fmt/clippy/test・code-review・packaging・license gate）
- 各 round 後に CLAP/VST3 gated 実機再RUN で退行なしを確認
- 既知 flake: 高負荷時（並行 cargo と競合）に voice-leading / random 等の
  timing 依存 spec が落ちる。隔離再実行で毎回 green を確認済み

**状態**: PR #447 open・レビュー収束済み・CI green。マージと Epic #424 クローズは
owner 指示待ち（overnight 自律走行の停止点）。

### 6.257 feat(daemon): DoD 配線 — TS ガード撤去 + cross-role reject + 配布 feature + DSL 実機 E2E #431 PR-3 (Jul 16, 2026)

**Date**: 2026-07-16
**Status**: ✅ 実装・**Epic #424 DoD 実機達成**（PR 作成・レビューフローへ）
**Branch**: `431-oop-dod-wiring`
**Commit**: [PENDING]

Epic #424 の最終 PR。実装 = Codex（Stage A/B + E2E 発見バグ修正）。

**Stage A（ガード配線の付け替え）**:
- TS: `assertNoCrossPluginDeclaration` 撤去（v1 排他の根拠 = daemon 単一 slot が PR-2 で解消）
- daemon: in-process clap-host に cross-role reject 新設（`ClapControl.loaded_role` 記録 +
  `CLAP_CROSS_ROLE_REJECTED`・撤去だけだと silent 置換になる #431 の罠に対応）。
  in-process LoadPlugin は role 必須化
- 受け入れ監査で clap gated テストのコンパイル破綻を検出し修正

**Stage B（配布 feature 方針・#431 scope e 確定)**:
- release daemon = `--features outproc-effect,outproc-instrument`（OOP both）。
  in-process clap-host は dev/gated 専用
- child binary 2本を .vsix に同梱（daemon の sibling 解決規約・追加配線不要）+
  release.yml post-package gate に fail-loud 検証追加

**E2E 発見バグ（production ブロッカー）**:
- 配布構成 daemon が `ORBIT_EFFECT_PLUGIN not set` で boot 不能（from_env の eager 時代の遺物）
  → Config.plugin を Option 化・plugin env 任意化・eager 系は None 明示エラー

**Epic #424 DoD 実機達成**:
- .orbs（`global.effect(CLAPTestEffect.clap)` + `seq.instrument(CLAPTestSynth.clap)` +
  `play(1,3,5,8)`）を cli-audio.js + 配布構成 release daemon で実行
- baseline（instrument のみ）capture peak **0.25000**（synth 既知振幅）/
  effect+instrument 同時 peak **0.12500**・**ratio 0.50000 厳密一致**
- 「DSL から CLAP effect 1 つ + instrument 1 つを同時ロードし、Pitch DSL の note で演奏し、
  両方が実機で鳴る」= **DoD の文言通りを客観実証**（スピーカー実再生込み）

**検証**: 3構成 lib（51/50/82）+ 全ターゲットコンパイル + clippy + TS 1330 passed

### 6.256 feat(daemon): OOP effect × instrument 共存 #431 PR-2 (Jul 16, 2026)

**Date**: 2026-07-16
**Status**: ✅ 実装・実機検証済み（PR 作成へ）
**Branch**: `431-oop-both-roles-coexistence`
**Commit**: `02ddca5`

Epic #424 の PR-2。`outproc-effect × outproc-instrument` の compile-time 排他を解消し、
1つの daemon で両 role を同時ホスト可能に。実装 = Codex 委譲（2 Stage 分割）。

**プロセス知見**: Codex は当初フルリファクタを3回連続で完走できず停止。原因 = PR-1c の
全履歴を引き継いだ --resume スレッドの実行ウィンドウ圧迫。**fresh スレッド + 自己完結
ブリーフ + Stage 分割**（Stage 1 = ジェネリック化のみ / Stage 2 = both 配線）で解決。

**Stage 1（ジェネリック化・挙動不変）**:
- `trait OutProcRole`（Stats/Supervisor 関連型 + spawn/detach/role_matches/stats アクセサ）
  + `EffectRole`/`InstrumentRole` marker
- `ChildLaunch<R>`/`ChildSlot<R>` 化・単一 role 型エイリアス撤去・`load_outproc_plugin_impl<R>`
- 既存テスト 48+47 が無変更で全パス = 挙動不変の証明

**Stage 2（both 配線）**:
- `CompositePostProcessor`: instrument add-mix → effect serial insert の固定順・RT 経路
  alloc/lock なし（output.rs 無改変）
- `start_outproc_both()`: shm×2・processor×2・slot×2・単一 stream。StreamGuard は
  teardown guard×2（stream 前）+ child guard×2（stream 後）
- session.rs: both ビルドで role='effect'/'instrument' 両受理 → role 別 slot へ dispatch
- buffer_frames 優先規則: 両 env が異なる値ならハードエラー（silent 優先禁止）+ unit テスト
- instrument×effect の compile_error ペアのみ削除（clap-host/link-audio 排他は維持）

**検証**:
- 3構成フルスイート: effect 48 / instrument 47 / both 63 + clippy×3 + fmt 全グリーン
- **both 実機 gated E2E PASS**: instrument 発音（fresh=3・probe live）→ effect serial
  insert（post/dry ratio **0.50000** 厳密一致）が単一 callback で同時動作（2.10s）
- single-role gated 回帰 全7本実機 PASS（parity / kill-test / stale-rate / attach-retry×2 /
  発音 / respawn）— リファクタによる単体 role 退行なし

**次**: PR 作成 → レビューフロー → PR-3（DoD 配線: TS ガード撤去 + in-process reject +
配布 feature + 実機 E2E）→ Epic #424 DoD 宣言

### 6.255 fix(daemon): OOP attach 失敗の fast-fail + retry 可能化 #441 PR-1c (Jul 16, 2026)

**Date**: 2026-07-16
**Status**: ✅ 実装・検証済み（PR 作成へ）
**Branch**: `441-oop-attach-fast-fail-retry`
**Commit**: `b09a45e`

Epic #424 DoD ゲート項目。PR #440 レビュー4体 + Fable 裁定で確定した attach エラー処理の
一体的2欠陥（child 早期 crash が10秒 timeout でしか検出されない / 訂正可能なユーザーミスが
slot を daemon 再起動まで殺す）を解消。実装 = Codex 委譲4周（main = Fable が実装前設計を
確定し、diff 精読 + 検証で各周を受け入れ）。

**実装（7ファイル・+383/-33）**:
- (b) fast-fail: stats に `initial_attach_pending` / `child_early_exit`（AtomicBool）を追加。
  watchdog は初回 attach 中（pending=true **かつ** shm `child_status != READY`）の child exit を
  respawn せず `child_early_exit` を publish して終了。ready-ack ループがこれを poll し、10秒
  timeout を待たず即エラー。READY 到達済み crash は従来の respawn 経路（レース回避の二重条件は
  Fable レビューで発見 → Codex 2周目で修正）
- (a) retry 可能化: supervisor に `detach_keep_shm()`（`unlink_shm` フラグで shm unlink をスキップ
  する teardown）を追加。role mismatch / timeout / early-exit の3分岐を `Closed` から
  `Empty(launch)` 復帰へ変更（unlink 所有権は launch に戻る = PR-1b `c436a22` フリップ前提の
  再設計）。teardown が書いた `CONTROL_QUIT` は新 helper `reset_control_run` で `CONTROL_RUN` へ
  戻す（残留すると次 incarnation の child が即終了する）。`open_shared` 失敗・supervisor spawn
  失敗は真の daemon 破損なので `Closed` のまま
- (e) エラーコード細分化: `WrapError::OutProcAttachFailed`（retryable）/ `OutProcSlotClosed`
  （恒久）を追加し、`wrap_err_to_protocol` で `OUTPROC_ATTACH_FAILED` / `OUTPROC_SLOT_CLOSED` に
  分離（#405 `CLAP_NOT_LOADED` の前例に倣う）。TS 側が機械判別可能に
- transport: `CHILD_STATUS_LOAD_FAILED` の decision record コメントを PR-1c 実装後の実態に更新

**テスト**:
- fast-fail unit（`exit 1` スタブ・実プラグイン不要）: 5秒未満で `OutProcAttachFailed` +
  slot Empty + shm 残存 + control RUN を検証
- retry unit（role mismatch 経由・`exec sleep 20` スタブ + テスト側 `publish_child_ready` 注入）:
  1回目失敗 → 同一 slot で2回目 Active 成功。同期合図は `current_child_pid` 遷移
  （Loading 観測だと `reset_child_starting` に READY が wipe される flake window → Fable 指摘で修正）
- gated E2E ×2（effect / instrument・実機）: typo path → 即エラー（<10s）→ 正しい path 再送 →
  成功・音声処理確認。**実機 RUN 済み**（effect 2.59s / instrument 2.75s PASS）
- 回帰: post-READY crash respawn テスト（lib）+ kill-test gated 実機 RUN（respawn 復帰・
  ratio 0.50000・measurement_invalid false）PASS
- fail-before/pass-after 変異実証: early-exit チェック無効化 → fast-fail テスト failure（10s 退行）、
  role-mismatch arm を Closed 化 → retry テスト failure を確認後、復元して green
- フルスイート: effect / instrument 各 feature 全テスト + sandbox 49 + clippy 3本 + gated compile
  全パス（ホスト実行）

**次**: PR 作成 → /simplify → /code:pr-review-team → bot review → PR-2（共存）へ

### 6.254 feat(daemon): 実際の post-boot attach #431 PR-1b (Jul 14, 2026)

**Date**: 2026-07-14
**Status**: ✅ 実装・検証済み（PR 作成へ）
**Branch**: `431-oop-plugin-coexistence`

PR-1a（substrate: engaged ゲート・child readiness handshake）の上に、実際の post-boot
attach を実装。Codex 委譲（設計は PR-1a と同一セッションの Fable 承認済み D1-D7 の
延長のため、新規 advisor 相談は省略・トークン節約優先の owner 指示に従う）。

**実装（5ファイル・+547/-96）**:
- `ChildSlot`（`Empty/Loading/Active/Closed`）による遅延 supervisor 生成。daemon 起動時は
  supervisor 無し、初回 `LoadPlugin` で spawn。`StreamGuard._child_guard` は
  `Arc<Mutex<ChildSlot>>`（control 側は `Weak` 参照）で teardown 順序
  （`_outproc_teardown → _stream → _child_guard`）を維持
- `session.rs` の `LoadPlugin` ハンドラに role 検証つき OOP 実行時受け口を追加。初回 spawn・
  同一 path 冪等 Ok・異なる path は reject
- ready-ack: `child_status` を Acquire poll → READY 確認 → `child_flags` で role 一致検証
  （10秒 timeout）してから応答。spawn 直前に `reset_child_starting` で前 incarnation の
  READY 残留を除去（PR-1a doc コメントの申し送り事項に対応）
- `engaged` を `false` 構築 → ready-ack 完了後に Release store で `true` へ遷移
- Codex 自己修正: `StreamGuard` 先行 drop でも `EngineWrap` 側の strong `Arc` が
  supervisor を延命しうる点を発見し teardown 順序を厳密化

**検証**: Codex 実行環境（loopback bind 禁止のサンドボックス）では `tests/protocol.rs`
28件が環境制約で FAIL したが、build/fmt/clippy は green・daemon unit 36件は green。
main が非サンドボックスで独立再検証: `cargo test --workspace --features
outproc-effect`/`outproc-instrument` 両方 **0 failed**（protocol 含む全 green）・
fmt --check・clippy -D warnings 両 feature green。Codex 環境固有の loopback 制約が
原因であり実装バグではないことを確認。

**/simplify（4観点並行レビュー・3件完了→1件（altitude）は advisor 呼び出しで45分超
応答なしのため main が SendMessage で生存確認 → 応答なし → TaskStop）**:
- simplification と efficiency が**独立に同一の設計不整合**へ収束（Important 相当）:
  `load_outproc_plugin`（`engine_wrap.rs`）が `child_slot.lock()` の `MutexGuard` を
  shm open・child spawn・supervisor spawn・**ready-ack poll ループ（最大10秒）**・
  最終状態遷移まで関数末尾まで一度も drop せず保持していた。これにより2件目以降の
  `LoadPlugin` 呼び出し（`Arc<EngineWrap>` は複数クライアント接続間で共有）は、
  意図された `ChildSlot::Loading`（「in progress」で即座に reject する設計・D4 要件）
  に到達する前に `.lock()` 自体で最大10秒ブロックされ、`Loading` 分岐が実質到達不能な
  dead code になっていた（`let _ = engaged.load(...)` という無意味な読み捨てもその症状）
- main が直接修正（fixer 委譲が同様に応答不能になったため self-fix）: `Loading` 書き込み
  直後に `drop(slot)` してロックを解放し、shm open・spawn・ready-ack poll ループは
  ロック外で実行。各エラーパス・成功パスで `child_slot.lock()` を再取得してから終端状態
  （`Empty`/`Closed`/`Active`）を書き込む形に変更。`ChildSlot::Loading` から未使用になった
  `engaged` フィールドを削除（dead_code 警告解消）。teardown は `child_slot` の `Arc` を
  保持するだけで `.lock()` しないため、ロック解放中に他の書き込み主体は存在せず、
  再取得後も `Loading` のままであることが構造的に保証される
- reuse: 修正要求なし（poll-until-deadline パターンの重複は test-only スコープの既存
  helper と production コードの型不一致により置き換え不可・将来的な技術的負債として
  記録のみ）
- 検証: `cargo build`/`test`（両 feature・0 failed）・`fmt --check`・`clippy -D warnings`
  （両 feature）全 green を main が非サンドボックスで確認
- **テスト方針の訂正（2026-07-14・PR-1b レビュー Q3 / Fable 裁定 確信度90%）**: 当初ここに
  「2件目の `LoadPlugin` が Loading 中に即座に reject されることを検証する統合テストは、実 child
  プロセス spawn を要する gated テストとしてしか書けない」と記したが**不正確だった**。(1)
  `ChildSlot::Loading` を直接注入すれば「in progress」reject の D4 意味論は実プロセスゼロで
  unit test できる（後述の (c) で追加）。(2) `f36e99c` の lock-scope 修正が対象とした「2件目が
  `.lock()` で最大10秒ブロックせず即座に Loading を観測する」並行タイミング性質の検証は直接注入では
  fail-before/pass-after を満たさない（実プロセス spawn が要る）が、それも READY を書かず sleep する
  ダミー実行ファイルで**非 gated・CI 実行可能**に書ける（＝gated 必須ではない・「実プロセス spawn が
  要る」と「gated（要 CLAP dylib/audio device）」の混同だった）。この並行タイミングテストは flaky
  リスクを踏まえ PR-1c（#441）で検討する。

---

**PR-1b レビュー結果と追加対応（2026-07-14・PR #440）**:

`/code:pr-review-team` 相当の4体（code-reviewer / silent-failure-hunter / pr-test-analyzer /
comment-analyzer）を PR #440 に対して実行。深刻度評価が割れたため **Fable 裁定**（難所の一発判断・
確信度85%）を仰いだ。要点:

- **裁定 Q1**: 「plugin path の typo → 10秒待ち → `ChildSlot::Closed`（daemon 再起動必須）」は
  Epic #424 DoD「完全に動く」の運用面を塞ぐ**真の欠陥**（Epic 内で必ず直す）。ただし PR-1b 単独を
  ブロックする Critical ではなく **packaging の問題**。silent-failure-hunter の「非対称に根拠なし」
  という論拠は誤り（`Closed` は shm unlink 所有権設計の帰結）だが、深刻度評価は正しい。
  code-reviewer の「確信度45・Minor未満」は較正ミス。
- **裁定 Q2 + owner 追認**: (c) エラーパステスト + (d) doc/decision record は **PR-1b（本 PR）に積む**。
  (a) 失敗 slot の retry 可能化 + (b) child 早期 crash の fast-fail + (e) エラーコード細分化は
  **PR-1c（#441・Epic #424 DoD ゲート項目）** へ。「Epic 内 PR への移動は DoD ゲート内側であり
  ゴールポスト下方修正ではない／Epic 外 follow-up へ送って DoD 宣言するのが下方修正」という線引き。
  #441 は #431/#424 にコメントで DoD ゲート項目として明記（マージより先に可視化）。

**(c) エラーパス unit test（実プロセス不要・Codex 委譲）**: `engine_wrap.rs` の
`outproc_health_tests`/`outproc_instrument_health_tests` に共有ヘルパー
`outproc_load_error_test_support` 経由で各 feature 4テスト（計8）を追加:
① open_shared 失敗 → `Closed` 遷移 ② spawn 失敗 → `Empty` 復帰（2回試行で retry 可能を実証）
③ `Closed` 拒否 ④ `Loading` 拒否（同一 path 保持を確認）。いずれも終端 variant を `matches!` で
検査し fail-before/pass-after を満たす（main が open_shared パスの `Closed` 書き込みを一時変異させ、
対応テストが「Closed 期待」で落ちることを実証・revert 済み）。

**(d) doc 訂正**: `transport.rs` の module doc「host 側 poll は未実装・PR-1b で追加」を「実装済み」に
更新。`CHILD_STATUS_LOAD_FAILED` doc に decision record を追記（PR-1b は reset-only 実装・try_wait
生死判定と fast-fail/retry 可能化は PR-1c(#441) 移管）。

**検証（main が非サンドボックスで再実行）**: `cargo test -p orbit-audio-daemon --lib` 両 feature
各 **40 passed**（従来36 + 新規4）・fmt --check・clippy -D warnings 両 feature green。委譲時の
教訓: 初回 background 委譲は成果物が作業ツリーに landing せず、codex-companion のタスク追跡が
shared session の古いスレッド結果を返した。foreground（`--wait`）で再委譲し、**`git status`/
`git diff` で作業ツリーの実変更を一次情報として確認**してから受け入れた。

---

**`/code:pr-review-team 440` 収束（2026-07-14・Skill 経由・state file 監査証跡あり）**:

Round 1（4体並行 + CI PASS）で新規 finding 3件 → fixer（Agent tool・sonnet）委譲 →
Round 2（selector 再実行 → fresh 4体で再レビュー）で **Critical=0 / Important=0 /
security checklist ALL PASS に収束**（iteration 1回）。

- **Critical（修正済み）**: `load_outproc_plugin` の `ChildSlot::Active` 冪等ガードが
  `path` のみ比較で `plugin_id` を無視。同一 path・別 plugin_id（bundle 内の別サブプラグイン）
  の `LoadPlugin` が**古い plugin_id のまま黙って `Ok`** を返していた（silent-failure-hunter
  検出・code-reviewer も sub-80% で同箇所を指摘・main が `session.rs` の `params.get("plugin_id")`
  から呼び出し側可変であることを裏取りして Critical 確定）。修正: match arm を3本に分割
  （同 path+同 plugin_id=冪等 Ok / 同 path+別 plugin_id=replacement 拒否 / 別 path=既存拒否）。
- **Important（修正済み・2件)**: ① `f36e99c` lock-scope 修正の regression test 不在 →
  READY を publish しない slow-child shell script fixture で「1本目が ready-ack poll 中に
  2本目が `Loading` を即観測して <1s で fail-fast する」ことを検証する並行テストを追加
  （6.254 前段で「PR-1c で検討」とした件を本 PR で前倒し実装）。② `Active` arm 3種
  （冪等再送 Ok / plugin_id 差し替え拒否 / path 差し替え拒否）の直接テスト不在 →
  `spawn_outproc_supervisor` + sleep スタブ fixture で追加。計8テスト（4種 × 両 feature）。
- **Minor（修正済み）**: `Drop for ChildLaunch` の shm `remove_file` 失敗を `let _ =` で
  握り潰し → `tracing::warn!` でログ。
- **スコープ規律**: `Closed` 遷移の retry 可能化・fast-fail・エラーコード細分化は
  **#441（PR-1c）へ移管済みのため fixer プロンプトで明示的に out-of-scope 指定**し、
  再レビュー時も再報告を抑止（churn 防止）。
- **受け入れ検証（main）**: fixer の green 報告を鵜呑みにせず差分精読 + 非サンドボックスで
  `cargo test --lib` 両 feature 各 **44 passed**・fmt --check・clippy -D warnings 両 feature
  green を再実行。Critical 修正は **fail-before/pass-after を変異で実証**（ガードを
  `path` のみ比較に一時変異 → `active_rejects_plugin_id_change` が失敗 → revert で pass）。
- **Round 2 特記**: code-reviewer は新規並行テストを単独15回再実行して flake なしを確認。
  pr-test-analyzer の残 Minor 1件（sleep 30 スタブが `CONTROL_QUIT` 非応答のため supervisor
  Drop の `REAP_TIMEOUT` 2s × 6テストの CI 時間増・決定論的でリーク無し）と
  silent-failure-hunter の sub-80% 提案（script を `exec sleep 20` にして PID 曖昧性除去）は
  非ゲート項目として記録のみ（必要なら #441 で同梱検討）。
- **bot feedback**: reviews/comments とも空・check-run 全 success（`bot_feedback_read` 記録済み）。

---

**@claude bot review（scoped）+ 対応（2026-07-14・コミット `53db770` 後）**:

advisor 相談（opus フォールバック・確信度80%）の推奨に従い、bot review を**並行性シーム3点に
スコープ限定**して起動（(a) lock-release-during-poll の不変条件 / (b) ready-ack と
`reset_child_starting` の Acquire/Release 順序 / (c) in-flight load と teardown の競合。
テスト群と WORK_LOG は内部レビュー済みとして対象外を明示）。bot は 7分27秒で完了し
**(a)(b) は airtight と判定**。指摘3点（いずれも non-blocking）:

1. 終端 blind write に `debug_assert!` の防波堤を推奨（defense-in-depth）
2. **(c) で理論上の競合を発見**: StreamGuard が in-flight load 中に drop されると、成功パスの
   `Ok` 返却直後に関数ローカル `Arc` drop が最後の強参照となり attach 直後の child が同期
   teardown される（「成功応答=生きた plugin」が崩れる）。現行配線（main.rs のプロセス寿命
   `_stream_guard`・gated テストの関数スコープ `_guard`、main が grep で全数確認）では到達不能
3. round-1 fix が導入した `tracing::warn!` が、失敗パスの二重 unlink（supervisor が先に unlink →
   `ChildLaunch::drop` が NotFound）で毎回偽 WARN を出す observability regression

**advisor 確認（opus・2回目）**: 指摘3=修正（90%）・指摘1=同梱修正（88%）・指摘2=契約として
doc 化+tracking 記録のみ（85%）。再レビューは「軽量検証で代替せず /simplify + pr-review-team を
回す（小差分なら速く収束することで規模適合を満たす）・2周目 bot は不要（3変更はすべて bot 自身の
指摘の実装）」との裁定。

**修正（fixer 委譲 → main 受け入れ検証）**: ① 終端 write 6箇所に debug_assert ② StreamGuard
契約を doc comment 化 ③ Drop の NotFound フィルタ。main が差分精読 + 両 feature 各44 passed +
fmt + clippy green を再実行して受け入れ。

**/simplify（4観点並行・2件適用）**:
- simplification/reuse/altitude が独立に同一指摘: 6箇所の逐語同一 debug_assert ブロック →
  `debug_assert_slot_loading(&ChildSlot)` ヘルパーに抽出（約30行→7行）
- **altitude が bot 指摘3の修正をさらに深化**: NotFound の error-kind フィルタは症状への
  パッチであり、既存イディオム（成功パスの `cleanup_shm_on_drop = false`）を所有権移転済みの
  3分岐（supervisor spawn 失敗・role mismatch・timeout）にも適用するのが正: `drop(supervisor)`
  直後に flag を false へ倒し、`ChildLaunch::drop` は無条件 warn に復帰（NotFound が本来の
  異常シグナルとして回復。open_shared/spawn 失敗の sole-unlinker パスは true のまま）。
  reuse の副次観察（フィルタ版は他3箇所の同型 Drop と発散する）とも整合
- efficiency / doc comment: clean
- 検証: 両 feature 各 44 passed・fmt・clippy -D warnings green（main 再実行）

**`/code:pr-review-team 440` 2周目（`c436a22` 後・収束確認）**: 4体レビューで
comment-analyzer の medium 1件のみ（supervisor spawn 失敗分岐のコメントが unlink 実施者を
「supervisor の startup cleanup」と誤帰属 — 実際は `spawn_outproc_supervisor` 自身の
エラーパス cleanup が unlink する。main が outproc_effect.rs の3エラーパスで裏取り）。
fixer がコメント2行を修正 → 再レビュー4体全て No findings で **Critical=0/Important=0/
security ALL PASS に収束**（bot への対応返信・#441 への StreamGuard 契約 tracking 記録済み）。

### 6.253 feat(daemon): SharedRegion 拡張 + engaged ゲート導入 #431 PR-1a (Jul 14, 2026)

**Date**: 2026-07-14
**Status**: ✅ 実装・受け入れ監査 GO（PR 作成・レビューフローへ）
**Branch**: `431-oop-plugin-coexistence`
**Commit**: `e68e746`

Epic #424 の DoD「1 effect + 1 instrument を DSL から同時にロードして演奏」を達成する
最後のピース #431（OOP post-boot attach + effect/instrument 同時使用）の第一段。
実装規模が大きいため 3 PR に段階分割（PR-1: substrate → PR-2: 共存 → PR-3: DoD 配線）し、
PR-1 をさらに 2 段階（1a: 非侵襲的準備・1b: 実際の post-boot attach）に分割した前半。

**グラウンディングの核心発見（Sonnet subagent・path:line 裏取り済み）**:
- transport 層（`SharedRegion`）は各 child が専用 shm ファイルを持つため既に N-child 対応
  （構造変更不要）
- 真のギャップ = `PostProcessor` に engaged ゲートが無いこと。child 不在時
  `PipelinedEffectHost::process_block` の READ 分岐は `seq_tag` 一致が一度も無いため
  `primed` が永久 false のまま `0.0` で埋める（**恒久的無音**。単なる起動時の一時的事象ではない）
- 合成順序は構造的に確定: instrument = add-mix・effect = overwrite。
  `instrument → effect` の順で 1 つの `CompositePostProcessor` に包めば
  `output.rs` は変更不要（単一 `Box<dyn PostProcessor>` スロットのまま）
- `role` は Rust 側に概念ごと存在しない（greenfield）。`LoadPlugin` の OOP 実行時受け口も
  存在しない（起動時 env のみ）

**Fable 実装前相談（GO・D1-D7 一発判断・全判断根拠は path:line で裏取り済み）**:
- engaged ゲートは processor 側（`teardown_requested` と同じ既存イディオム。host は
  cross-thread atomic を持ち込まず純状態機械のまま）
- 遅延 supervisor は `Arc<Mutex<ChildSlot>>` 共有 + StreamGuard 側 takeover guard
  （PR-1b で実装）
- ready ack は「child ready + role 検証通過」を control thread が確認してから Ok
  （note ring drain を engaged 内に置くことで #410 型の data-loss race を構造的に排除）
- 冪等性: 同一 path+role の再送は冪等 Ok・異なる path のみ reject
- **見落とし発見**: TS ガード撤去だけでは不十分——in-process daemon にも cross-role reject が
  必要（撤去のみだと silent plugin 置換が起きる）。PR-3 に反映

**PR-1a 実装（Codex 委譲・8ファイル・+167/-4・非侵襲的）**:
- `SharedRegion`（`transport.rs`）に `child_status`/`child_flags`（`AtomicU32`）を
  **既存フィールド末尾に追記**（ABI 互換保持）。child readiness handshake の定義のみ
- effect/instrument 両 child binary: load 成功直後に `child_flags`（has_audio_input 判定）→
  `child_status = READY` の順で Release store
- `ClapEffectProcessor`/`ClapInstrumentProcessor` に `has_audio_input()` accessor 追加
  （in-process 経路の既存判定関数 `HostAudioBuffers::has_audio_input()` への単純委譲）
- `OutProcEffectPostProcessor`/`OutProcInstrumentPostProcessor` に `engaged: Arc<AtomicBool>`
  ゲート追加（`teardown_requested` チェックの後・処理委譲の前）。
  **本 PR では全既存起動経路が `engaged=true` で構築するため挙動は1bitも変わらない**

**受け入れ監査（Fable・GO・Minor 1件）**:
- ABI 互換性・Release/Acquire 順序・engaged ゲート配置・`has_audio_input` 委譲を全て
  一次コード精読で確認
- **mutation による fail-before/pass-after 実証**: engaged ゲートを一時除去して実行 →
  新規 disengaged テスト 2 件が red（effect: data 不変アサート失敗・instrument:
  callback_count アサート失敗）→ 復元（shasum で byte-identical 確認）で green
- Minor 1件（`CHILD_STATUS_LOAD_FAILED` が未使用の予約値であることの doc 追記）を適用
- **PR-1b への申し送り2点**: ①respawn は同一 shm 再利用のため前 incarnation の READY が
  残留する（poll ロジックは spawn 前 STARTING リセット or try_wait 併用が必須）
  ②`engine_wrap.rs` は engaged の Arc を保持しておらず、LoadPlugin から flip するには
  `ChildSlot` 構造に clone を持たせる変更が必要

**検証**: `cargo test --workspace --features outproc-effect`（protocol 28件含む）・
`--features outproc-instrument` 全 green・`cargo build --features clap-host` green・
fmt/clippy（両 feature）green・`cargo deny --offline check` green。

**/simplify（4観点並行レビュー→dedup→3件適用・スキップなし）**:
- `engine_wrap.rs`: `start_outproc_effect`/`start_outproc_instrument` の3連続
  `Arc<AtomicBool>` 引数のうち `engaged` をインライン `Arc::new(...)` から named local
  （`let engaged = ...`）化。3引数が同型のため取り違えリスクを軽減
- `outproc_instrument.rs` の `mod tests`: `outproc_effect.rs` に既にある
  `engaged(value: bool) -> Arc<AtomicBool>` helper と対称の関数を追加し、4箇所の
  `Arc::new(AtomicBool::new(...))` 直書きを置換（reuse・両ファイルのテスト記法を統一）
- `transport.rs`: effect/instrument 両 child binary で重複していた
  「flags 判定 → `child_flags` store → `child_status` store」の unsafe ブロックを
  `pub unsafe fn publish_child_ready(region: *mut SharedRegion, has_audio_input: bool)`
  に抽出し、child 側は1行呼び出しに簡素化（重複2箇所→共通関数）
- 挙動変更なし（named local 化・helper 抽出・関数抽出のみ）。再検証（cargo build/test
  両 feature・fmt --check・clippy -D warnings 両 feature・cargo deny check）全 green

**/code:pr-review-team round 1（4レビュアー + CI・Critical 1件/Important 4件→全適用）**:
- CI 3/3 pass（code-review・fmt/clippy/test・license/dependency gate）
- **Critical**（comment-analyzer）: WORK_LOG の `**Commit**: \`5eebf16\`` が
  到達不能な孤立コミット（自己参照ハッシュ埋め込みの手順ミスの残骸）を指していた。
  実際の初回実装コミット `e68e746` に修正
- **Important**（code-reviewer・pr-test-analyzer・silent-failure-hunter が独立に
  同一の核心へ収束）: 新規関数 `publish_child_ready`（transport.rs）に直接のユニット
  テストが無く、`has_audio_input` の true/false 分岐が未検証だった → 両分岐を
  直接検証するテストを追加
- **Important**（pr-test-analyzer）: instrument 版 `disengaged_passes_dry_without_
  updating_stats` テストが event ring を空のまま検証しており、この PR の設計動機
  そのもの（engaged=false 中は note event を drain せず data-loss race を防ぐ）を
  一度も踏んでいなかった → note を1件 push し、process() 後も未消費のまま残ることを
  assert する形に強化
- **Important**（comment-analyzer）: `OutProcEffectPostProcessor::new` の doc が
  新規引数 `engaged` を列挙していなかった → 追記（`OutProcInstrumentPostProcessor::new`
  は doc 自体が無かったため新設）
- **Important**（silent-failure-hunter）: `CHILD_STATUS_LOAD_FAILED` の doc が
  「host は `child_status == STARTING` のまま child が消えたことで判別する」という
  前提を述べていたが、これは初回起動でのみ成立する。respawn は shm を再 truncate
  しないため、一度 READY に達した後の respawn 失敗では前 incarnation の READY が
  残留する — doc 自身が防ごうとしていた silent failure の芽を doc 自身が見落として
  いた（PR-1a の受け入れ監査が「Minor: doc 追記」として済ませていた項目の中身が
  不完全だった）→ respawn 注意文を追記
- Minor 4件（engaged docの予言的記述の重複緩和・engine_wrap.rs のステップコメント
  漏れ・WORK_LOG 差分行数の実測補正 `+164/-4`→`+167/-4`・doc 語順整理）も全て適用
- fixer が新規テスト2件それぞれで fail-before/pass-after 実証: `publish_child_ready`
  の `child_flags` store を一時除去 → red（`left: 0 / right: 1`）→ 復元で green。
  instrument disengaged テストは `!engaged` 分岐に一時的な ring drain を追加 →
  red（`left: Err(Empty) / right: Ok(NoteOn {..})`）→ 復元で green
- main が独立再検証: 両新規テストを個別実行して pass を確認（sandbox 外実行含む）・
  cargo build/test 両 feature（0 failed）・fmt --check・clippy -D warnings 両
  feature・cargo deny check 全 green

**/code:pr-review-team round 2（4レビュアー・round 1 修正の検証）— Critical/Important 0件で収束**:
- 4レビュアー全員が round 1 の6修正（Critical 1件・Important 4件・Minor 4件）の
  適用内容を実ファイル精読・mutation 注入・実行確認で検証し、**新規の Critical/
  Important 指摘なし**
- pr-test-analyzer: 両新規テストに意図的な回帰を注入（`has_audio_input` 分岐反転・
  engaged チェック順序入れ替え）→ 両方とも red を確認 → 復元で green。tautological
  でない有効な回帰ガードであることを実証
- silent-failure-hunter: 自身の round 1 指摘2点（respawn 注意文・engaged 不可視性）
  が「コード修正」「記録のみで妥当」とそれぞれ適切に扱われたことを確認。**non-
  blocking watch item**: `disengaged_passes_dry_without_updating_stats`
  （outproc_instrument.rs）を120回試行中1回だけ flake を観測（同一バイナリ内の
  他テスト（実子プロセス+watchdog スレッドを使う `supervisor_respawns_child_on_
  unexpected_exit` 等）との干渉が疑われるが未特定・再現不可）。本 round の修正が
  原因ではなくブロッカーでもないため、PR-1b 以降で再現した場合のフォローアップ
  として `cargo nextest`（プロセス単位分離）での切り分けを申し送り
- CI 3/3 pass 継続。Critical=0・Important=0・CI green で `/code:pr-review-team`
  の収束条件を満たした

**flake watch item の実証（advisor 指摘: 不在証明は机上でなく実証で確定・PR#417
教訓の適用）**:
- advisor に相談: 複数レビュアーが round 1/2 を通じて別々に観測した異常（作業ツリーの
  一時的な engaged ゲート除去・`eprintln!` 混入・`publish_child_ready` テストの
  初回 FAILED→`cargo clean` で green・disengaged テストの120回中1 flake）は
  互いに無関係ではなく、**4レビュアーを同一 working tree 上で並行実行し、各自が
  mutation テスト（ソース書き換え→cargo→revert）を行ったことによる交差汚染**が
  根本原因という指摘。bot レビューに出す前に「隔離環境での再現」を実証すべきとの
  助言
- 実証: `cargo test -p orbit-audio-daemon --features outproc-instrument --lib`
  を単体フィルタで120回・フル `--lib` スイート（並行テスト有効・silent-failure-
  hunter が flake を観測した条件と同一）で60回、計180回連続実行 → **全 green
  （fail 0件）**。加えて別途200回ループも試行したが、確認できた「失敗」は全て
  `if cargo test ...; then rm -f ...; else echo FAIL; fi` という repro スクリプト
  自身の実装上、**pass した run のログファイルが `rm -f` される直前の一瞬を
  観測しただけ**（実際にファイル内容を読むと該当テストも含め全て `ok`）と判明
  ——本物の test failure ではなく repro スクリプトの race だった
- 結論: 該当 flake は**隔離再現せず**。silent-failure-hunter の元の1回の観測も、
  advisor の仮説どおり並行 cargo プロセス間の競合（build lock 待ち・target dir
  共有）による環境ノイズであった可能性が高いと判断し、watch item を「解決
  （環境ノイズと確定・コード側の対応不要）」にクローズ。methodology の申し送り:
  今後レビューエージェントに mutation テストをさせる場合は `isolation: "worktree"`
  を必須にする（共有 tree だと reviewer 自身が偽シグナルに振り回される）

### 6.252 feat(dsl): seq.instrument() — Pitch DSL note の daemon 配線 #427 (Jul 14, 2026)

**Date**: 2026-07-14
**Status**: ✅ 実装・受け入れ監査 GO・実機 E2E で DoD 達成（PR 作成・レビューフローへ）
**Branch**: `427-clap-instrument-dsl-wiring`
**Commit**: `3d5aa7e`

#425 確定構文の instrument 側を実装。Pitch DSL v1.1 の note 出力を daemon の
`PluginNoteOn`/`PluginNoteOff` へ振り向け、「DSL の度数から CLAP instrument が鳴る」を
初めて成立させた。Epic #424 Stage 1 の後半。

**設計（Fable 実装前相談 GO・統合点7つを事前特定）**:
- **`MidiOutput` interface が seam**: `PluginNoteOutput implements MidiOutput` により
  度数解決・gate/tie/legato・voicelead・スケジューラを既存 MIDI 経路と完全共有
  （新規実装は出力アダプタのみ）
- `isNoteSequence()` 新設（= isMidi ∨ isInstrument）: 意味論6箇所を置換・出力先4箇所は
  明示分岐。`isMidi()` の意味（RtMidi 出力）は不変
- `scheduleMidiEvents` は fork せず `resolveNoteTarget()` でパラメータ化
  （instrument = plugin scheduler・channel 1→wire 0・**sendDelay 0 = midiLatency 非適用**）
- 第2 `MidiScheduler`（plugin 用）を MidiManager が保持し **start/stop/panic の既存連鎖に
  組み込み**（global.stop() で instrument も止まる = PH.4）
- detune warn+skip は Stage A の per-sequence once-flag + ゼロ潰し（pitchBend 非 enqueue）
- 順序保証: `pluginNoteOn/Off` は **ws.send 前に await を置かない契約**（daemon read loop の
  逐次性と合わせ「同期 send 順 = 演奏順」・コメントで明文化）・未接続 drop は ❌ log
- effect⇔instrument の双方向早期エラー（同一 path 含む・#431 で撤去のチェック項目を
  #431 本文に追記済み）・linkAudio 双方向・`loadedPlugin` キャッシュに role 保存
  （respawn 後に effect として復元される事故の芽を排除）

**実装（Codex 委譲・罠7点 🔴 明示）**: 21 files changed, 784 insertions(+), 45 deletions(-)・新規3モジュール
（plugin-note-output / plugin-instrument-manager / 各テスト）+ VS Code 診断免除。
逸脱なしと報告され、監査で全遵守を確認。

**受け入れ監査（Fable・GO）**: PH.1-PH.6 全項目適合・罠7点全遵守・
**既存 MIDI 経路は bit-equivalent 判定**（instrument 未宣言時 isNoteSequence は恒等・
effect wire は同一バイト列・751 テスト再実行 green）・await-before-send 契約を独立再検証。
Minor 4 件（detune の直接スパイ検証等）は非ブロッカーとして PR レビューへ。

**検証**: `npm test` **1327 passed / 0 failed / 29 skipped**（+22 新規・main 環境）。

**実機 gated E2E（DoD 達成・self-run 許可の範囲）**:
`global.key("C")` + `seq.instrument("CLAPTestSynth.clap")`（**バンドルディレクトリ・
#433 修正入り daemon**）+ `play(1, 3, 5, 8)` → 実発音。capture 計測
**peak = 0.2500（厳密一致）** = clap-test-synth の既知振幅で PR #422 実機検証と同一
シグネチャ。DSL → LoadPlugin(role=instrument) → PluginNoteOn/Off → CLAP synth →
master bus の全経路を客観実証。eager 検証も実地確認（key 未宣言で宣言時ハードエラー）。

**/simplify（4観点並行・2エージェントが API stall で1回失敗し再実行・適用4件/スキップ多数）**:
- 適用: ①**effect⇔instrument 排他 guard を Global に集約**（altitude 指摘・
  `Global.linkAudio()` と同型のパターンに揃え、相互コンストラクタクロージャの
  前方参照脆弱性を解消。fixer 自身が実装中に「自分の宣言も誤検査する」バグを
  発見し「相手 manager のみ検査」に修正）②`isNoteSequence()` の使い漏らし3箇所
  （activeScheduler/scheduleEventsFromTime/scheduleEvents）を統合（reuse+simplification
  一致）③`PluginNoteOutput.noteOff` の送信ロジック重複を `sendTrackedNoteOff` に統合
  （reuse+simplification 一致）④`daemon-client.ts` の余剰 `.then(() => undefined)` 除去
- スキップ（理由つき）: PluginEffectManager/PluginInstrumentManager の共通基底化
  （#431/#434 で作り直される層への過剰投資 — altitude 自身が「正しい抑制」と評価）／
  MidiManager・ActiveNoteTracker の共通化（同理由）／テストヘルパー共通化（既存慣習・別課題）
- 適用後検証: `npm test` 1327 passed / 0 failed・lint 変更ファイル新規指摘ゼロ

**/code:pr-review-team round 1（4レビュアー並行 + CI）**:
- code-reviewer PASS（レース窓・7分岐すべて独立追跡）
- silent-failure-hunter: HIGH 2件（drop ログのレート制限なし・respawn 失敗後も
  pluginActive 未確認で送信継続）+ MEDIUM 3件（interface メソッド欠如時の完全サイレント
  経路・guard バイパス可能な public getter・detune once-flag のリセット契約未文書化）
- pr-test-analyzer: Important 1件（`clearEvents` の instrument 分岐 = PH.4 の note 解放
  義務そのものが未テスト）+ Minor 5件
- comment-analyzer: doc 更新漏れ4件（`linkAudio()`/`midi()` JSDoc・spec バナーの
  「未実装」放置・WORK_LOG diffstat 誤り）
- fixer 適用: 既存 `warnOnce`/`GapKind` 機構に乗せてレート制限（HIGH×2 解消）・
  `getPluginInstrumentManager()` 削除しテストを Global 経由に統一（guard バイパス解消）・
  `clearEvents` instrument 分岐のテスト追加・interface メソッド欠如時の console.error 追加・
  doc 更新4件（spec バナー = #426/#427 実装済みに更新・#428 のみ残と明記）
- 検証: `npm test` **1330 passed / 0 failed / 29 skipped**（+3）・lint 変更ファイル新規指摘ゼロ

**round 2（silent-failure-hunter 再検証）**: HIGH 2件・MEDIUM 2件とも解消を確認
（機能面まで検証・guard バイパス経路が repo 全体で 0 件であることを grep で確認）。
新規は LOW 1件のみ（`warned` ラッチのリセットが `stopAll()` のみで respawn 時に
再アームしない — ただし他の unconditional ログが episode レベルの可観測性を
既に担保しており non-blocking と評価・**#437 起票**）。**Critical/Important = 0・
CI 4/4 pass**。silent-failure-hunter round1 の MEDIUM Finding5（detune once-flag の
リセット契約未文書化）は **#438 起票**（複数レビュアーが独立指摘・実害なしの
ドキュメント/テスト債務として follow-up 化）

### 6.251 fix(daemon): discovery の macOS .clap バンドルディレクトリ解決 #433 (Jul 14, 2026)

**Date**: 2026-07-14
**Status**: ✅ 実装・実機 E2E 済み（PR 作成・レビューフローへ）
**Branch**: `433-clap-bundle-dir-discovery`
**Commit**: `610bef4`

#426 実機 E2E で発見した統合ギャップ（discovery が `.clap` バンドルディレクトリを
そのまま dlopen して失敗）の修正。市販 CLAP プラグイン（Surge XT / FabFilter 等）は
全てバンドル形式のため、実プラグイン対応の前提。

**実装の経緯（2ラウンド・監査が上流資産を発見）**:
- Round 1（Codex）: 手組みの `resolve_dylib_path`（stem 候補 → 単一ファイル fallback →
  0/複数エラー）+ `BundleExecutableNotFound` variant。テスト4件・全検証 green
- **Fable 受け入れ監査（GO + Important 発見）**: pinned clack-host（rev `f874e858`）に
  **`PluginEntry::load(path)` が既存**で、NSBundle（Info.plist の CFBundleExecutable）に
  よる正規の macOS 解決を上流実装済みと一次ソースで確認（`host/src/entry/library.rs:120-148`）。
  CLAP 契約（dlopen = 実行体・entry init = 元バンドルパス。本家 entry.h L93 で確認）も
  手組み実装は正しかったが、手組みには CFBundleExecutable ≠ stem + `.DS_Store` 混入で
  誤エラーになる実運用上の穴。監査は follow-up 化も可としたが、
  **#433 の目的そのもの（実プラグインが完全に動く）+ 資産再利用の観点で即リワークを選択**
- Round 2（Codex resume）: `open_bundle` を `PluginEntry::load(path)` に置換（実質1行 +
  契約コメント）。手組み解決・`BundleExecutableNotFound`・`NullBundlePath`・CString 処理を
  削除（約40行減）。テストを plist つき4系統に再構成: stem 一致 /
  **CFBundleExecutable ≠ stem（NSBundle 正規解決の検証・手組み版より強い保証）** /
  実行体不在エラー / flat-file 後方互換。plist 無しバンドルも NSBundle が stem から
  推定してロード成功することを手動確認（自動テスト対象外）

**検証（main 環境・非サンドボックス）**:
- `cargo test --workspace` 全 green（failed 0・orbit-clap-host 24 件・daemon protocol 28 件含む）
- fmt / clippy / deny 全 green
- **実機 E2E（fail-before/pass-after）**: fail-before = #426 E2E での
  `dlopen(<bundle dir>): not a file` エラー（WORK_LOG 6.250 記録済み）→ pass-after =
  同じバンドルディレクトリ path で `global.effect()` → LoadPlugin 成功・
  **peak ratio = 0.5000（厳密一致・gain 0.5 の closed-form signature）**
- 監査も fail-before を独立実測（旧挙動へ一時復元で新テスト 2 件が #426 と同一症状で red）

**owner 対応（同日）**:
- **#434 起票**: `seq.effect()`（per-track insert）— owner 要望「正直 seq でのエフェクトは
  入れて欲しかった」を受け、Epic #424 DoD 達成後の最初の CLAP 深掘り項目として明文化
  （前提 = #431 の部品・新規部分 = per-sequence バスのタップ）
- ゴール再確認: 「CLAP effect + instrument が完全に動く」まで横展開に入らない
  （#433 → #427 → #431 → Epic #424 DoD 実機実証）

**/simplify（4観点・適用2件/スキップ2件）**:
- 適用: ①**ubuntu CI fail の実修復** — テスト fixture（TempDir 等）が Linux で dead code
  になり clippy --all-targets -D warnings が fail していた → `mod tests` 全体への単一
  `#[cfg(target_os = "macos")]` で cfg 重複7箇所の解消と CI 修復を同時に達成
  ②orbit-clap-spike（移植元・凍結）の `open_bundle` に「#433 で上流 API に置換済み」の
  パンくずコメント（将来のコピペによるバグ再導入防止）
- スキップ: TempDir 手組み（workspace 慣行4例目・tempfile 依存なし・rule-of-five 待ち）／
  bundle-macos.sh のテンプレート化（spike 2例のみ・rule-of-three 前）
- reuse / efficiency は clean（上流 API 置換で entry cache 経路は不変・追加コストは
  control plane の stat 1回のみ）

**/code:pr-review-team round 1（4レビュアー + CI）**:
- CI 4/4 pass（cfg ゲート修正で ubuntu clippy 回復）。comment-analyzer ≈ PASS
  （全 claim を pinned ソース + 本家 entry.h で裏取り）。エラー経路も PASS
  （NullBundlePath 削除で失われた failure mode なし・DSL への observability 不変）
- **3レビュアーが同一 Important に収束**: fixture 依存の3テストがサイレント skip で
  偽 PASS になる（dylib 未ビルド時に assertion ゼロで green・CI は macOS ゲートで
  未実行のため回帰検知が実質ゼロ）
- fixer 適用: リポジトリ既存の gated 慣行に準拠 — `#[ignore = "needs a built test CLAP
  dylib..."]` + 未ビルド時は build 手順つき panic（loud fail を fixture 退避で実測）。
  `cargo test -p orbit-clap-host --lib` = 21 passed / 3 ignored（正直な表示）・
  `-- --ignored` = 3 passed。WORK_LOG の hash/文言補正・TESTING_GUIDE に
  fixture 事前ビルド手順を追加

### 6.250 feat(dsl): global.effect() — CLAP effect の DSL 疎通 #426 Stage 1 (Jul 14, 2026)

**Date**: 2026-07-14
**Status**: ✅ 実装・受け入れ監査済み（実機 gated DoD = 可聴確認は後続。#431 起票・Epic #424 段階化）
**Branch**: `426-clap-effect-dsl-wiring`
**Commit**: `5d8e1ba`（feat 本体）+ `0bdb35b`（/simplify 適用）

#425 で確定した `global.effect(path[, pluginId])` を TS 側に実装し、daemon の実行時
`LoadPlugin`（in-process clap-host 経路）へ配線した。Epic #424 Stage 1 の前半。

**グラウンディングで判明した構造ギャップ（plan-affecting）**:
- daemon に OOP effect/instrument の実行時ロードコマンドが無い（`outproc-*` は起動時 env のみ・
  `main.rs` が WS サーバー開始前に `EngineWrap::start()` を同期実行）。実行時 `LoadPlugin` は
  in-process `clap-host` feature 専用
- 4-way pairwise `compile_error!` により effect+instrument の同時使用不可 → **Epic #424 DoD は
  daemon 側作業なしに達成不能**
- release build は plugin feature 全て無効（`--features` なし）

**Fable 一発判断（2026-07-14・確信度 高・案A/B/C 比較）**:
- **案C ハイブリッド採用**: #426/#427 は in-process `clap-host` 経路で単体 DoD を通す
  （今日の daemon で唯一の DSL 駆動実行時ロード経路・PH.4 の AlreadyLoaded 意味論は
  この経路の実装そのもの）。wire 契約（`LoadPlugin`/`PluginNoteOn/Off`）は backend 中立で、
  OOP 化後も TS/DSL 層は不変（`plugin_note_on/off` が既に両 backend に配線済みの実績）
- 案B（env 注入）棄却: REPL 再宣言不能・「宣言時 eager ロード」が boot 時 config に退化
- **`role: "effect"` param を初回から送る**（将来の OOP attach での child 選択に必須の wire を
  先行確定。daemon は `params.get` 方式で未知 field を無視 = コスト 0）
- **#431 起票**（OOP post-boot attach + 排他解消 + 配布 feature 方針 = Epic #424 Stage 2。
  **Epic DoD「effect+instrument 同時演奏」は #431 で達成**）・Epic #424 body に段階化注記を追記

**spec 追従（spec-first・同ブランチ）**:
- PH.2 に「同一 path+pluginId の再宣言は冪等」を明確化（ライブコーディングのファイル全体
  再評価を壊さないため。PH.4 instrument 冪等と同じ原理。owner 承認済みの「2回目エラー」は
  チェーン防止の意図であり、異なる path/pluginId のみエラーとする精緻化）
- PH.6 の排他解消ポインタを #426/#427 → #431 に更新

**実装（Codex 委譲・2 ラウンド）**:
- Round 1: `PluginEffectManager`（拡張子検証→linkAudio 排他→resolvePathDirect 解決→
  冪等/エラー→eager load・失敗ロールバック・並行呼び出しは load Promise 共有）、
  `Global.effect()` chainable、`DaemonClient.loadPlugin()`（camelCase 変換・role: "effect"）、
  `RustEnginePlayer.loadPlugin()`（CLAP_UNAVAILABLE → 「--features clap-host build が必要」
  マッピング）、LinkAudioManager 逆方向排他（callback 注入）、`resolvePathDirect` export、
  テスト 13 件（global 11 + daemon-client 2 + mock server ハンドラ）
- Round 2（受け入れ監査 Important 指摘 B-1 の fix）: **daemon crash→respawn 後に plugin
  master insert が黙って消える silent failure** を修正 — `loadedPlugins` キャッシュ +
  `respawnLoop` の `sampleIds.clear()` 直後に再発行・失敗は ❌ ERROR で observable・
  キャッシュ保持で次回 respawn 再試行。**fail-before/pass-after 実証**（修正 revert で
  2 テスト red「Number of calls: 0」→ 復元で green）

**受け入れ監査（Fable・条件付き GO → fix 反映で解消）**:
- spec 適合全項目 ✅・wire 正しさ（session.rs 突合・role 無害）✅・並行/ロールバック/
  コンストラクション順 by construction 安全 ✅・スコープ外変更なし ✅
- 逸脱メモ: `daemon-client.loadPlugin` の role 固定は #427 で引数化が必要（既知・許容）

**検証（main 環境・非サンドボックス）**: `npm test` 1294+ passed / 0 failed（Codex sandbox の
73 failures は loopback listen EPERM の偽陰性と確認）・`npm run lint` の 10 errors は
未変更の SC SDK submodule 翻訳 .ts（既存）のみ。

**/simplify（4観点並行・適用6件/スキップ3件）**:
- 適用: ①`daemon-client.loadPlugin` 戻り値型を `PluginLoadResult` に統一 ②console.error を
  ファイル慣行 `❌ [rust-engine]` に統一 ③`loadedPlugins` Map → 単一 `loadedPlugin?` フィールド
  （v1 単一 insert 保証により Map は常に 0/1 エントリ・JSON.stringify キー削除）
  ④linkAudio 排他 guard を `Global.linkAudio()` に移動し `LinkAudioManager` を zero-arg に復元
  （callback 注入の前方参照の脆さを解消）⑤テスト fixture 定数化 ⑥拡張子検証+path 解決を
  `plugin-resolver.ts`（`resolvePluginPath`）に切り出し — **#427 の `seq.instrument()` が再利用**
- スキップ（理由つき）: respawn テストの MockDaemonServer 経由書き直し（fail-before/pass-after の
  実証由来を保全・#427 で再訪）／backend replay seam の全面再設計（#431 が daemon 層を作り直す
  ため過剰投資）／effect 側 linkAudio チェックの Global 移動（エラー順序の挙動変更になるため）
- 適用後検証: `npm test` 1296 passed / 0 failed・lint 変更ファイル新規指摘ゼロ

**/code:pr-review-team round 1（4レビュアー並行 + CI）**:
- CI 4/4 pass。code-reviewer = PASS。指摘: Critical 2（silent-failure-hunter:
  respawn 再ロード失敗後に冪等キャッシュが幻の成功を返す残存経路 / comment-analyzer:
  /simplify で resolve が linkAudio チェックより前に移動しエラー順序が変化 —
  両 commit の実挙動差を実証しての検出）・Important 3（エラー変換 catch 3分岐未テスト×2
  レビュアー一致・WORK_LOG の dangling hash・linkAudio JSDoc 記載漏れ）・Minor 5
- fixer round 1 適用: C1 = `pluginActive` フラグ + optional `isPluginActive?()` +
  冪等キャッシュヒット時の self-healing 再発行（`issueLoad` 共通化・エンジン未対応時は
  従来 no-op で後方互換）/ C2 = validate → linkAudio gate → resolve の順序復元
  （load-bearing コメント + `validatePluginExtension` export + 回帰テスト）/
  I1 = catch 3分岐のテスト追加 / I3 + Minor 群 = JSDoc・コメント整備
- 適用後: `npm test` **1304 passed / 0 failed**（テスト 16+5 件に増強）・lint 新規指摘ゼロ

**/code:pr-review-team round 2（収束確認）**:
- comment-analyzer = **CONVERGED**（全指摘解消・新 docstring/コメントの実挙動一致・
  回帰テストの非空虚性まで確認）
- silent-failure-hunter = Critical 2 件とも解消を **fail-before/pass-after で再実証**
  （修正前コミット 0bdb35b に新テストを移植して red 5 件 → 修正後 21/21 green）。
  新規 LOW 1 件（`loadPlugin()` catch の `pluginActive` 明示リセット漏れ —
  現状無害だが非局所的不変条件が脆弱）→ 1 行 + 回帰テスト 1 件で即時適用
- **収束: Critical/Important = 0**・CI 4/4 pass・最終 `npm test` **1305 passed / 0 failed**
- セキュリティ面: 新規依存なし・secrets なし・network surface 変更なし・
  license/dependency gate CI pass

**実機 gated E2E（DoD 達成・2026-07-14・self-run は owner 常時許可の範囲）**:
- advisor 判断: bot レビュー不要（独立視点 5 系統済み・残余リスクは静的レビューで
  捕捉不能な実機 E2E ギャップ）+ **effect 経路の E2E は #426 クローズのゲート**
  （#427 は PluginNoteOn/Off の別経路のため束ねられない）→ マージ前に self-run 実施
- 手順: `cargo build --release -p orbit-audio-daemon --features clap-host` +
  `clap-test-effect`（固定 gain 0.5・挙動既知の oracle プラグイン）を flat-file
  `.clap` 化 → `ORBIT_AUDIO_DAEMON_PATH` + `ORBIT_CAPTURE_WAV` で
  `cli-audio.js play` を baseline / `global.effect()` あり の 2 回実行し capture 比較
- **結果: peak ratio = 0.5000（厳密一致・gain 0.5 の closed-form signature）**。
  RMS 比 0.566（−4.94dB・前後無音の希釈込み）。DSL → daemon LoadPlugin →
  in-process CLAP host → master insert の全経路が実機で音を処理したことを客観実証。
  スピーカー実再生も両 run で確認。**Issue #426 の DoD 達成**
- **副産物の発見 → #433 起票**: daemon discovery は path をそのまま dlopen するため
  macOS 標準の `.clap` バンドル**ディレクトリ**を解決できない（市販プラグインは
  全てバンドル形式）。E2E は flat-file 形式で回避。mock では捕捉不能な
  統合ギャップの実物（advisor の予測どおり）。実プラグイン運用前に要対応
- 注記: `rust/target/release/orbit-audio-daemon` は E2E 用に clap-host feature 付きで
  上書きビルドした状態（plain 構成が要る場合は再ビルド）

**残作業**: なし（#426 スコープ完了・マージはユーザー指示待ち）。次 = #427（instrument +
Pitch DSL 接続。`daemon-client.loadPlugin` の role 引数化・#433 の bundle 解決を含む）。

### 6.249 docs(dsl): plugin effect/instrument DSL 構文確定 — #425 Option A 決定 + spec 反映 (Jul 13, 2026)

**Date**: 2026-07-13
**Status**: ✅ 構文確定・spec 反映済み（実装は #426/#427/#428 のスコープ・本 Issue ではコードを書かない）
**Branch**: `425-plugin-dsl-syntax`
**Commit**: `81d65e6`

`POST_2.0_VST3_HOSTING_PLAN.md` §6 で「effect が実機で動いてから owner と確定」と据え置かれていた
plugin DSL 構文（Option A）を確定した。Epic #424（CLAP plugin DSL wiring）の最初の1手。

**確定した構文（骨子）**:
- **instrument**: `seq.instrument(path[, pluginId])` — `.midi(port, ch)` と同型の
  「種別宣言＝出口宣言」verb。`.audio()`/`.midi()` と相互排他。instrument シーケンスは
  note シーケンス（度数解釈・リズム木・realization rules を MIDI と共有）。
- **effect**: `global.effect(path[, pluginId])` — master bus 単一 insert（v1）。
  **§6 素描の `seq.effect()` から意図的に逸れる非対称**を採用: 現配管の seam が
  master bus 単一 insert のため、per-seq 構文は「全シーケンスに掛かるのに 1 つに
  紐づいて見える」意味論の乖離になる。`seq.effect()` は将来拡張として予約（verb 名共有・非互換なし）。
- **format**: 拡張子判定（`.clap`/`.vst3`/`.component`）・verb は format 非依存。
  v1 受理は `.clap` のみ（`.vst3`/`.component` は予約エラー — #426 が VST3 配線を背負わないため）。
- **エラー方針**: 宣言時 eager ロード + ハードエラー（warn+no-op にしない。
  instrument の silent failure 防止・#405 の正直エラー方針と整合）。
- **多重宣言**: instrument はエンジン全体 1 インスタンス（v1）。同 path 共有は
  TS ブリッジ側 dedup（daemon は `AlreadyLoaded` エラー）・異 path 2 つ目はエラー。
- **v1 スコープ外**: param/CC 制御（EQ-from-DSL は M2 param path 成熟後に別途確定）、
  detune `~`（pitch bend 経路なし・warn+skip）。

**プロセス（役割分担フローどおり）**:
1. **エビデンス収集**（Sonnet subagent ×2 並行）: ①既存 DSL 構文の慣習
   （リフレクション dispatch・パーサー変更不要・`.audio()`/`.midi()` の排他パターン、
   §7 Known Decisions に既決なし = greenfield 確認）②daemon 配管の実 API
   （`LoadPlugin`/`PluginNoteOn/Off` スキーマ・単一スロット・4-way compile-time 排他・
   WORK_LOG 6.248 の接続ギャップ 5 点）。
2. **Fable 検証**: 条件付き GO。修正 5 点 — (1) 「再呼び出しは置換」は事実誤認
   （実際は `AlreadyLoaded` エラー・`controller.rs:219-225`）(2) 異 path エラーと
   再宣言の文言矛盾の解消 (3) 「Pitch DSL 全 verb 適用」の過大主張を実現マトリクスに緩和
   (4) 追加決定点 D7-D10（linkAudio 排他・note-off 意味論・eager ロード・ハードエラー）
   (5) PITCH_DSL_SPEC への最小 3 変更が必要（core spec :814-817 の権威順位
   「specs-v2 が勝つ」— 放置すると正本階層が新機能を形式的に否定する）。
   全て反映済み。確信度: D1/D3/D5/D6 高・D2 中〜高（各判定に反証条件つき）。
3. **owner 設計セッション**: 3 論点を確認 — instrument = `seq.instrument(path)`（推奨どおり）、
   effect = `global.effect(path)`（推奨どおり）、エラー方針 = ハードエラー（推奨どおり）。
   D3-D9 は推奨提示に異論なしで確定。

**spec 反映（spec-first・実装より先）**:
- `docs/core/INSTRUCTION_ORBITSCORE_DSL.md`: 新セクション「Plugin Hosting
  (CLAP effect / instrument)」（PH.1-PH.6・構文確定/未実装マーカーつき）+
  「Not Yet Implemented」2 箇所更新 + `## Implementation Status` 見出しを補い構造明確化。
- `docs/specs-v2/PITCH_DSL_SPEC_v1.1.md`: §1 に plugin instrument 出力の相互参照、
  §7 に出力アダプタ適用注記（CC123/120 → note-off 列挙・detune v1 不能・rule 0 適合）、
  §8 に scope 移管注記（構文の正本 = core spec）。

**反証可能性（この決定が覆りうる条件・Fable 検証より）**:
- daemon に multi-instance / unload-reload / per-play insert が近期に入る → D4 のエラー意味論は緩められる
- C1（pitch モデル再設計）が note 発行層を書き換える → D1 の接続点は再検討（Epic #424 反証条件 1）
- M2 param wire が #426/#427 より先に実装される → D5（param 据え置き）は前倒し可

**レビュー（docs-only 規約に従い advisor 代替 = opus 独立監査で方法を決定）**:
full pr-review-team / @claude bot は不要（コード 0 行・空振りリスクのみ）と判定し、
fresh agent 差分監査 + owner 最終確認を採用。監査結果 = ブロッカーなし
（D1-D10 + 吸収項目の反映漏れなし・相互参照全件正確・§7 rule 番号一致）。
Low 指摘 1 件（§8.1.2 の MIDI 例外に instrument の鏡写しがない）を反映済み。

### 6.248 feat(engine): CLAP instrument daemon 縦貫通 — #419 output event 配線 + #420 production 統合 (Jul 13, 2026)

**Date**: 2026-07-13
**Status**: ✅ 実装・実機検証済み（owner 許可済み gated audio を Opus main が自ら実行）
**Branch**: `420-clap-instrument-daemon-integration`

PR #417（M2 instrument IPC substrate・#416）のマージ後、Fable一発判断（「VST3 instrument〔#421〕に直行せず、既存 CLAP 経路の daemon production 統合を先行させる」）に基づき着手。「DSL/CLI → orbit-audio-daemon → OOP instrument child → 実際に発音」の縦貫通を1本通した。

**設計確認（advisor GO・blocking 2点の事前指摘）**:
1. **child の store 順序が concurrency の核心**: `output_events`/`output_event_count` を先に書き、その後 `seq_tag`/`seq_done` を Release publish しなければ host 側の seqlock 読み手が torn/stale read を起こす（PR #417 で潰した race と同型）。
2. **overwrite ではなく sum**: instrument の PostProcessor は `data`（engine render 済み master。`LoadSample`/`PlayAt` の音を含む）を上書きしてはならない。scratch バッファで instrument 出力を受けて `data` に加算する必要がある（見落とすと sample 再生が無音化し、note のみ送る v1 テストでは露見しない）。

**段階的実装（4段階・各段階を Opus main が差分精読 + 検証コマンド再実行で受け入れ）**:

- **Part 1（#419・commit `3e67fd1`）**: `orbit-clap-instrument-child` が実 CLAP plugin の NOTE_END/NOTE_CHOKE output event を M2 wire に書き戻す。`process_block_core`（`orbit-clap-host`）に `Option<&mut EventBuffer>` の回収経路を追加（`None` で既存2経路は無変更）。
  - **fail-first の自己検証で advisor 指摘の重みを実地確認**: 1回目の反転試行は無害な入れ替え（`write_slot` は依然 reader より前に実行）で green のままだった。load-bearing な性質（payload 書き込みが reader より前に完了しているか）を正しく反転させ直して RED（`live_count` 1≠期待値0）→ 正順に戻して GREEN・diff クリーンを確認。「advisor の同意は不在証明の裏取りにならない」を実地で再確認した一例。

- **Part 2（#420・commit `7278f38` の一部）**: `orbit-audio-daemon` に新規 feature `outproc-instrument`（default off・clack-free）を追加。`OutProcInstrumentPostProcessor` は instrument 出力を scratch で受けて `data` に加算（sum）。`spawn_instrument_child`/`InstrumentChildSupervisor` は effect版の watchdog/respawn パターンを流用。note wire は既存 WS `PluginNoteOn`/`PluginNoteOff` を流用し、`PluginEvent`→`NeutralEvent` 変換は control 側のみ（audio thread は ring から pop するだけ）。4者（`link-audio`/`clap-host`/`outproc-effect`/`outproc-instrument`）を `compile_error!` で相互排他。
  - **Codex 実行環境固有の偽陰性を切り分け**: Codex は「24件の protocol テストが loopback bind PermissionDenied で red」と報告したが、Opus main の環境では同じテストが全 green だった。Codex 自身のサンドボックスの network bind 制限であり、コードの不具合ではないことを確認した。

- **Part 3a（respawn 簿記リセット・commit `7278f38` の一部）**: watchdog の `respawn_count`（生成カウンタ）を audio thread が毎ブロック観測し、変化を検知したら `PipelinedInstrumentHost::on_child_respawned()` を呼ぶ（lock-free・単一 reader/writer）。fail-before/pass-after を Opus main が自ら再現（配線無効化で RED、復元で GREEN）。

- **Part 3b（gated 実機発音確認・commit `7278f38` の一部）**: `outproc_instrument_gated.rs` 新規作成。note-on/off で発音、SIGKILL→watchdog respawn→新 child での発音復帰を実機で検証するハーネス。`OutProcInstrumentStats` に `post_peak_bits`（f32 abs peak・fetch_max）を追加。

- **Part 3c（advisor 指摘への対応・commit `7278f38` の一部）**: Part 3b の実機テストは「音が出た」ことのみ実証しており、**#419 の output event が cross-process で host の voice 簿記に実際に届くかは未検証**（`rust-spike/clap-test-synth` が NOTE_END を一切 emit していなかった）と advisor が指摘。`clap-test-synth` に NOTE_END emission を追加し、`OutProcInstrumentStats` に固定 probe key（A4/ch0/port0）の `live_count` を毎ブロック publish する `probe_live_count` を追加。gated テストに「note-off 後3秒以内に probe_live_count が0に復帰する」assertion を追加し、cross-process 経路の実証を完成させた。

**実機検証結果（Opus main が自ら実行・owner 許可済み gated audio・振幅0.25の控えめな音量）**:
```
post_mix_peak:       0.25000  (note-on 後。clap-test-synth の期待振幅と一致)
probe_live_count:    0        (note-off 後3秒以内に0復帰 = NOTE_END の cross-process 配送を実証)
respawn_count:       0 → 1    (SIGKILL 後 watchdog が新 child を spawn)
post_respawn_peak:   0.25000  (新 child で発音復帰)
measurement_invalid: false
child_proc_errors:   0
```

**検証**: `cargo build/test/fmt/clippy`（`outproc-instrument` feature 込み）・workspace 全体（default features）を Opus main が全段階で独立に再実行し green を確認。Codex サンドボックス由来の偽陰性2件を切り分け済み。

**教訓**:
1. **fail-first は「反転させたつもりが無害だった」ケースに気づけるかが本質**。1回目の反転が偶然 green のままだったことに気づかず「再現できなかった」で済ませていたら、実際には load-bearing でない性質を検証したことになっていた。
2. **委譲先（Codex）の実行環境と自分の実行環境は別物**。「委譲先 red・自分 green」を機械的に「委譲先の報告が誤り」と決めつけず、両方で再現して切り分ける。
3. **advisor は「発音した」で満足せず「その発音経路が検証したかった性質を実際に通っているか」を問う**。実機で音が出ても、それが証明したい cross-process 経路（NOTE_END 配送）を通っていなければ、意図したカバレッジにならない。

**役割**: grounding・設計たたき台・advisor 相談・段階分け＝ Opus main。**実装は一貫して codex（`/codex:rescue`、同一スレッド継続）に委譲**（Part 1→2→3a→3b→3c の5往復、うち1回は codex 自身がスコープ拡張の許可を確認してから着手）。差分精読・検証コマンド再実行・fail-first/fail-before の再現・実機 gated audio 実行（owner 許可済み）は全て Opus main が独立に実施。

**Commits**: `3e67fd1`（#419）, `7278f38`（#420）

**PR #422 レビュー（`/code:pr-review-team`・round 1-4）+ #420 成功条件の明示回答**:

- round 1-3（fixer 3 round・MAX_ITERATIONS=3 上限）: critical 1件（event_cursor 永久スタック類似の output-event overflow 未配線）+ important 数件を修正・全て Opus main が差分精読 + 検証コマンド再実行で受け入れ。
- round 4（最終再レビュー）: comment-analyzer がstale comment 1件（`tests/protocol.rs:728` が round3で統合済みの `outproc_instrument_health()` ではなく旧名 `outproc_instrument_output_health()` を参照）、pr-test-analyzer が important 1件（`InstrumentChildSupervisor::spawn` の `open_shared` 失敗時cleanupパスにその分岐を踏むテストが無い）+ minor 2件（`_respawn` 警告テストの re-arm 非対称・`current_child_pid` 更新のCI実行可能な assertion 不在）を指摘。code-reviewer/silent-failure-hunter は指摘0。
- **advisor 相談の結果（第一次対応）**: 反復上限到達で4巡目のfixer roundは回さず、(a) round2で導入され round3の統合後は本番から一切呼ばれなくなっていた `outproc_instrument_output_health()`（自身の4ユニットテストのためだけに存在するdead code）を削除、(b) 上記stale commentを修正、(c) `open_shared` 失敗時cleanupの専用テスト（`outproc_effect.rs` の同型テスト `supervisor_spawn_reaps_first_child_on_open_shared_failure` を1:1で移植）を追加——を Opus main が単発クリーンアップとして実施（fail-before/pass-after を自ら再現して検証）。`_respawn` re-arm非対称と `current_child_pid` CI assertion の2 minor項目は当初 advisor の推奨に基づきフォローアップ issue **#423** へ切り出した。
- **owner 指摘によるやり直し**: 「follow-up issue へ切り出すのは `/goal`（#420の完全完了）に対するゴールポスト移動であり、その前に Opus/Fable へエスカレーションして目的達成に努力すべき」という owner の指摘を受け、consult-delegation スキルの「難所の一発判断」層として **Fable** に再判断を依頼。Fable は実ファイルを読んだ上で「両minor項目とも本PR新規コード内のギャップであり、修正コストが issue 化コストを下回る（re-arm検証は兄弟テスト移植で~28行、PID assertionは`first.id()`事前捕捉+`poll_until`で~10行）」として **今すぐ修正すべき**と判断（確信度90%/85%）。owner の追加指示（「mainは指揮者に徹し、直接Editせず、Fableの具体的な修正仕様をCodexに委譲せよ」）に従い、Fableに詳細な修正仕様（変更箇所・追加コード・期待値の根拠）を作成させ、その仕様をそのまま Codex（`/codex:rescue`）に委譲して実装。Opus main は Codexの実装差分がFable仕様と完全一致することを確認した上で、検証コマンド（対象テスト単体・`outproc-instrument` feature込み全体・default全体・fmt・clippy）を自らの環境で独立に再実行し全green を確認（Codex自身の実行環境では protocol テストが sandbox の loopback bind 制限で偽陰性になったが、Opus main の環境では green — 本PR内で複数回観測している既知の環境差異）。結果、**#423からは項目1-2を削除し、項目3-5（構造的重複・watchdog busy-loop・EventSpillFifo）のみ残す**（pre-existing/スコープ外の既知事項のみが正当な先送り対象）。
- **#420 成功条件「Pitch DSL v1.1 が note 供給源としてそのまま使えるか」への回答**: **そのままでは使えない**。調査の結果、Pitch DSL v1.1 の note 出力は `packages/engine/src/midi/rtmidi-output.ts`（`@julusian/midi` 経由の実MIDIハードウェア出力）のみを通り、今回追加した `orbit-audio-daemon` の `PluginNoteOn`/`PluginNoteOff` WebSocket経路とは完全に別系統（TypeScript側に該当メソッドの呼び出し箇所は0件）。`daemon-client.ts` の transport 自体は method-agnostic なので運べるが、DSL側の配線が存在しないだけで「新経路を丸ごと作る」規模ではない。接続に必要な差分: (a) DSLへのプラグイン割当構文の追加、(b) `MidiOutput` 相当の新バックエンド（daemon-client への `PluginNoteOn`/`Off` 変換）、(c) 値域変換（velocity 1-127→0.0-1.0・channel 1-16→0-15）、(d) 出力先選択ロジック、(e) daemon呼び出しの非同期性と既存スケジューリングのレイテンシ整合。本PRのスコープには含めず、別issueで対応する（Issue本文の「DSL構文自体の確定は別・後回しで良い、Option C判断どおり」という既存の運用と整合）。
- **#420 成功条件「tempo-sync な instrument（arp・LFO等）を想定するなら #408（M2 transport-context live tempo 供給）も引き取る必要が出る可能性」への回答**: 本PRの実機検証は `clap-test-synth`（tempo非依存の固定sine）のみで、arp/LFO 等 tempo-sync が要る instrument は対象外だったため、**#408 は本PRでは不要と判断し引き取らなかった**。tempo-sync instrument を実際に統合する段になったら改めて要否を判断する。
- **owner 追加指摘「Pitch DSL の『使えない』はゴールポスト移動では」+ WebSocket architecture への疑問 → 実装計画全体の見直し**: owner から「CLAP effect/instrument がPitch DSLも含めてOrbitStudioから使えることを一つのパイプラインとして先に通すべき。さもなくば土管が増えるだけで開発ステップとして危険」という指摘を受け、Fableに2段階でエスカレーション。①WebSocket上のnote dispatchがarchitecturally正しいか（`PlayAt`の`time_sec`先読み設計と`PluginNoteOn/Off`の即時発火の非対称を検証）→ 「transport自体は正しいが、timing modelはPlayAtの仕組みをまだ採用していない、既知の記録済みgap」と判定（確信度85%）。②実装計画全体（Epic #292配下）のプラグイン→DSL疎通の優先順位を見直し → 「CLAP effect（PR #397）もCLAP instrument（#420）もDSLから一切消費されていない（`LoadPlugin`呼び出し0件）。`POST_2.0_VST3_HOSTING_PLAN.md` §6のOption A確定という既存の終了条件がPR #397で既に満たされているのに issue化されずに見過ごされていた」と発見、**#421（VST3 instrument）より先にDSL疎通を完了すべき**と判断。owner承認を得て、Epic #292配下に新規 **Epic #424**（CLAP effect+instrument DSL疎通）+ 子issue **#425**（DSL構文確定・Option A）→ **#426**（CLAP effect疎通）/ **#427**（CLAP instrument疎通+Pitch DSL v1.1接続）→ **#428**（PluginNoteOn/Offタイミング精度向上）を作成し、Epic #292・#421の依存関係を更新（#420→#424→#421の順）。
- **作成したissue群の妥当性をFableに再検証させた**: 内容はほぼ忠実だが2点の事実誤りを検出——(a) #424・#421・#292 が「#420は完了済み/マージ済み」と先回りして書いていた（実際はPR #422はまだOPEN・マージ待ち）、(b) #421・#292 の「#419・#416レビューで2件のバグは統合を試みて初めて発覚」という記述が、実際は#419のみ統合試行で発覚・#416の2件はレビューで発見、という区別を圧縮しすぎていた。両方修正済み。任意の改善提案（反証可能性3条件の明記）も#424に追記した。

### 6.247 fix(engine): M2 Equal分岐の seqlock 型再検証を追加（Fable指摘対応・#416） (Jul 13, 2026)

6.246 で Fable が指摘した「`Ordering::Equal` 分岐のレースを M1 前例でスコープ外にした判断は事実誤認」への対応。`event_cursor` drain ループの `Equal` 分岐に、record 適用後の `seq_tag` 再 Acquire load を追加し、変化していれば `Ordering::Greater` と同じ回復（`event_cursor_recycled` 増分・`voices.reset_all()`・`event_cursor = submitted`）を適用する seqlock 型再検証を実装。共有ロジックは `recover_from_recycled_slot()` ヘルパに抽出し、両分岐が同一の回復パスを呼ぶ。

- **fixer が自ら advisor に相談し、コメントの過大主張を訂正**: 初稿は「再検証が一致すれば読み取り中の recycle は無かったことが保証される」と書いていたが、実際に `sandbox-instrument-child.rs` の書き込み順序（`output_events`/`output_event_count` を先に書き、`seq_tag` を Release store するのは最後）を確認した結果、「read の途中で始まったが、まだ自身の `seq_tag` store に到達していない recycle」はこの再検証でも検出できないことが判明。コメントを「レースウィンドウを狭めるものであり、完全に閉じるものではない」という正確な記述に修正した。
- **残存ギャップの許容根拠**: この簿記は observational のみ（音声経路には影響しない）。`decode()` が record 構造を検証するため、torn read は「妥当に見えるが誤った event」にデコードされるか、`event_decode_error_count` の増分で検出されるかのいずれかに帰着する。
- **決定論的テストは断念（正当な理由あり・advisorで確認）**: 単一スレッド・同期的な `process_block` 呼び出し内で、2回の `seq_tag` Acquire load の間には純粋な計算しか無く、その間に別スレッドが実際にメモリを書き換えない限り不一致は起こり得ない。これを強制するテストは本質的にタイミング依存でflakyになるため、既存の `backlog_catch_up_consumes_every_sequence_exactly_once_in_order`（`Greater`分岐の類似ケースで同じ立場を取っている）と同じ判断で見送った。`Equal` 分岐を通る既存テスト群が happy path を確認済み。
- 全35 orbit-audio-sandbox unit test + gated stress + gated parity（2テスト）を Opus main が独立に再実行して確認。
- **役割**: 発見・修正方針の提示＝ Fable（owner 指名の独立レビュー）。**実装＝ pr-review-team の fixer subagent**（実装中に自らadvisorへ相談しコメント精度を検証）。検証の裏取り＝ Opus main。
- **状態**: この修正でレビューループを終了。次: 最終確認の再々レビュー1回→CI/bot feedback確認→ユーザーへの完了報告（マージはユーザーの明示指示待ち）。

### 6.246 fix(engine): M2 レビュー追加指摘対応 + Fable独立検証（#416） (Jul 13, 2026)

6.245 の修正後、`/code:pr-review-team` の再々レビューで5件の追加指摘（stale field doc comment・RT-unsafeなeprintln!・新規テストの前提realism・backlog_catch_upの状態未assert・voices.increment順序）が出た。**advisor は「反復ループが `/code:pr-review-team` の MAX_ITERATIONS=3 を超えて発散している」と判断し、最終1ラウンドで確実な項目のみ対応し残りは追跡issue化する方針**を確認。同時に owner の要請で **Fable（`claude-fable-5`）に独立レビューを依頼**し、この方針・特に「Equal分岐のレースはM1と同型だからスコープ外」という判断が正しいかを一次情報ベースで検証させた。

- **最終ラウンドで対応**: (1) `event_cursor` フィールドの doc comment を、否定された安全性主張から実際の回復ロジック（Greater分岐）の説明に書き換え。(2) round3で追加した `eprintln!`（RT-unsafe・audio callback から呼ばれる `drain_to_event_buffer` 内）を差し戻し、`debug_assert!` のみに戻した。(3) 新規テスト `recycled_slot_resyncs_event_cursor_and_resets_voices` の前提を、`submitted` を実際の `process_block` 呼び出しで正当に `next+SLOTS` まで進めてから `seq_tag` を poke する構成に修正（従来は到達不可能な前提だった）。(4) `backlog_catch_up_consumes_every_sequence_exactly_once_in_order` に非flakyな `event_cursor_recycled <= 1` assertion を追加。(5) `voices.increment()` の呼び出し順序問題（同一呼び出し内で今 submit した NoteOn が古い gap 用の reset に巻き込まれて消える）を、想定より小さな変更で修正可能と判明したため即修正（NoteOn の簿記反映を drain ループ全体の後に遅延）。
- **Fable の検証結果（重要な訂正）**: 「Equal分岐のレースは M1 の既存パターンと同型だからスコープ外」という判断は**事実誤認**と判明。M1（`host.rs`）の audio 読み取りは `target = submitted-1` に密結合しており、`SLOTS>=2` の compile-time assert と `seq_request` の唯一の書き手が host 自身であることから、recycle が構造的に不可能（証明可能な時間的排他）。一方 drain ループの `next` は `submitted` から分離しており、Greater分岐が実証したのと同種のレースにさらされている。ただし修正は安価（Equal分岐で record 適用後に `seq_tag` を再 Acquire load し、変化していれば Greater分岐と同じ回復ロジックを適用する ~6行の seqlock 型再検証）と判定、被害範囲は簿記のみで音声出力には影響しないことも確認。`voices.increment()` 順序問題は許容できるトレードオフ（修正不要）と判定したが、fixer側の判断で既に対応済みだった。
- Fable の指摘（Equal分岐の seqlock 型再検証）を追加ラウンドとして委譲・適用（詳細は本エントリに続くコミットで記録）。
- 全34+ orbit-audio-sandbox unit test + gated stress + gated parity を Opus main が独立に再実行して確認。
- **教訓**: レビューループが反復上限を超えて発散し始めたら、advisor の「収束させて報告」という判断に従いつつ、技術的に確信度の低い判断（特に「前例があるからスコープ外」という類の判断）は独立した第三者（Fable）でもう一段検証する価値がある。今回、advisor 自身も一度誤り、その誤った waiver の根拠を Fable が正しく指摘した — 単一の相談先を鵜呑みにせず、根拠が薄い判断は複数経路で裏取りする運用が機能した。
- **役割**: 5件の追加指摘の発見＝ 4並列レビュアー。ループ発散の判断・最終ラウンドのスコープ確定＝ advisor 相談の上 Opus main。**実装（5項目）＝ pr-review-team の fixer subagent**（item5 の実装過程で fixer 自身が advisor に相談し `Ordering::Equal` 分岐との相互作用も含めて正確に処理）。**独立検証＝ Fable**（owner の指名）。検証の裏取り＝ Opus main。
- **状態**: 最終ラウンド完了・裏取り済み。Fable 指摘の追加ラウンドへ。

### 6.245 fix(engine): M2 event_cursor 永久スタックの実バグを発見・修正（#416） (Jul 13, 2026)

PR #417 の `/code:pr-review-team` 再レビュー（round1修正後）で、code-reviewer が `event_cursor` drain ループの並行性懸念を指摘。**当初 Opus main + advisor は「到達不能・false positive」と結論したが、これは誤りだった**。fixer が実際に検証コマンドを実行した過程で、**既存の正当な回帰テスト `backlog_catch_up_consumes_every_sequence_exactly_once_in_order` が実際に問題の分岐（`Ordering::Greater`）を3/3回踏むことを発見**し、advisor 経由でエスカレーション。

- **誤った証明の原因**: 「`seq_done <= submitted` は常に成立し、危険な閾値（`seq_done >= next + SLOTS`）に届くには lag が `SLOTS+1` 以上必要」と推論したが、`self.submitted` は drain ループの**直前**（同一 `process_block` 呼び出し内）で `new_seq` に更新される。この更新後は `seq_done <= submitted` が `seq_done <= new_seq` を意味し、lag=SLOTS ちょうどで危険な閾値と一致してしまう — 「submitted は呼び出し中固定」という誤った前提が証明の穴だった。
- **なぜテストが green のまま埋もれていたか**: `backlog_catch_up_consumes_every_sequence_exactly_once_in_order` は child が shm に直接書いた raw event を確認するのみで、host 自身の `event_cursor`/`VoiceTable` 状態を一切 assert していなかった。
- **実際の障害**: lag が SLOTS に達した状態で、child が host の作業（同一呼び出し内の `seq_request` 更新）を追い越して該当 slot を再周回し終えると、`seq_tag[slot]` が `next` より大きい値を示す。`seq_tag` はその slot について以後増加する一方なので、単純に break するだけでは `event_cursor` がその値に**恒久的に**スタックし、以後のセッション全体で NoteEnd/NoteChoke 簿記更新が silent に失われる — §7-11 が保証するはずの「簿記がリークしない」が実際には崩れる本物のバグだった。
- **修正方針（advisor 確認済み・submit/play 意味論は変更しない）**: 案（submit guard を event_cursor にも連動させる）は play/timing 意味論変更になり spec 更新が必要なため不採用。代わりに、既存の `output_note_end_dropped_count` → `reset_all()` という回復パターンをそのまま `Greater` 分岐に適用: 新規 host側カウンタ `event_cursor_recycled` を増分・`voices.reset_all()`（保守的に全簿記ゼロ化）・`event_cursor = submitted`（回復不能な gap を諦めて追いつく）。wire/SharedRegion は無変更（`PipelinedInstrumentHost` 自身の `pub` フィールドとして追加、既存の `fresh`/`stale`/`stall`/`frames_clamped` と同型）。
- 決定論的回帰テスト `recycled_slot_resyncs_event_cursor_and_resets_voices` を追加（`backlog_catch_up` は実 child 相手の非決定的観測だったため、これが初めての決定的repro）。修正前 fail・修正後 pass を確認済み。
- 全34 orbit-audio-sandbox unit test + gated stress + gated parity（`instrument_parity_gated.rs` の2テスト、dylib を自らビルドして実行）を Opus main が独立に再実行して確認。
- **教訓**: 「推論による安全性証明」は lock-free コードでは信用しきらず、実行結果（既存テストの green/red）で裏取りする。今回は fixer が愚直に検証コマンドを流したことで誤った証明が露呈した。advisor 自身も「自分の証明が誤りだった」と訂正している — 一発の advisor 相談を鵜呑みにせず、後続の実証結果と矛盾したら再度エスカレーションする運用が機能した。
- **役割**: 懸念の発見＝ code-reviewer（re-review）。当初の誤った棄却＝ Opus main + advisor（訂正済み）。**実際の検証コマンド実行によるバグ発覚＝ fixer**。エスカレーション判断・修正方針確定＝ advisor 相談の上 Opus main。**実装（構造体拡張・回復ロジック・回帰テスト）＝ pr-review-team の fixer subagent**。検証の裏取り＝ Opus main。
- **状態**: 修正・裏取り完了。次: WORK_LOG コミット→push→`select-reviewers.sh` 再実行→4エージェント再々レビュー→Critical/Important=0確認。

### 6.244 fix(engine): M2 `/code:pr-review-team` 指摘対応 + 先送り3件の追跡強化（#416） (Jul 12, 2026)

PR #417 の必須レビュー手順 `/code:pr-review-team`（code-reviewer/silent-failure-hunter/pr-test-analyzer/comment-analyzer の4並列レビュー）で見つかった指摘に対応。owner から「先送りが多いと未追跡の負債になる」と懸念が出たため、修正可否の判断すべてを advisor と再確認した。

**3レビュアー間で判定が割れた争点**: 実 `orbit-clap-instrument-child`（Stage5）が実 CLAP plugin の output event（NOTE_END 等）を `output_events` wire に一切配線していない問題を pr-test-analyzer が発見・silent-failure-hunter も近接箇所を独立指摘したが、code-reviewer は「Stage6 で defer 済みと doc に明記されている」として却下していた。**advisor で検証した結果、この根拠は誤り**（Stage5 の WORK_LOG は「output方向はStage6で着手」と記録していたが、実際にStage6で配線されたのは合成 child のみで、実 CLAP child は今日まで未着手のまま）。code-reviewer の内部 advisor 呼び出しがこの誤った前提を引き継いでいたため、却下は採用しなかった。

**最終トリアージ（advisor 2回・owner 懸念を受けた再確認込み）**:
- **即時修正（3件）**: (b) `instrument_host.rs` の output-drain ループで `decode()` の `None`（真の decode 失敗）が `event_decode_error_count` を計上していなかった catch-all を分離 — CRITICAL・回帰テスト追加（修正を戻すと fail することを fixer が自ら確認）。(c) `orbit-clap-instrument-child/main.rs` で `push_neutral_event` の戻り値（翻訳不能 event の可視化）を握り潰していた箇所を、design doc §4 が明示的に許容する「既存 `event_decode_error_count` の再利用」で解消（新規 wire counter は追加せず）。(d) `events.rs` の `VoiceAddr.note_id` doc comment が §4.7 の条件付き再スコープと矛盾したまま unconditional な規約を主張していた stale comment を修正。
- **先送り（1件・3重にアンカー）**: 実 CLAP instrument child の output event 配線（上記争点）。正しい修正は M1 effect と共有する `process_block_core`（本 PR 無変更）のシグネチャ変更を要し、`orbit-clap-instrument-child` はまだ production 経路として spawn されない（Phase 3 で初めて使われる）ため #416 スコープ外と判断。owner の「未追跡の負債」懸念に対応するため、**単なる doc 注記では不十分**と advisor に指摘され、(1) 専用 issue **#419** 新規作成 (2) design doc §4.2 output方向にスコープ外注記追加 (3) `ClapInstrumentProcessor::process_block` にコード内コメントでアンカー (4) PR #417 の本文に既知の制約として明記、の4点セットで対応。
- **同じ観点で #418（respawn resume-semantics・前回セッションで doc 注記のみだった）も retrofit**: `orbit-clap-instrument-child/main.rs` の `let mut last = 0u64;` 初期化箇所にコード内コメントで #418 をアンカーし、doc 注記だけに留まっていた状態を是正。
- **見送り（判断のみ・issue化せず）**: `VoiceTable::indices()` の範囲外 addr 無視（increment/note_end/choke で対称・既存の観測専用テーブル設計の一部）、`drain_to_event_buffer` の `debug_assert!(false)`（Stage4 で意図的に導入した、現状到達不能な回帰ガード）。
- workspace 全体 fmt/clippy/test を Opus main が独立に再実行して確認（fixer の自己申告に加え、4ファイルの diff を全て読んでロジック一致を確認）。
- **役割**: 4レビュアーの起動・所見の対立解消・トリアージ（何を直し何を先送りするか、先送りの追跡強化方法）＝ advisor 2回相談の上で Opus main。issue作成・doc注記・PR本文更新 = leader action として Opus main が直接実施。**コード修正3件+コメントアンカー2件 = pr-review-team の fixer subagent（Agent tool・Codex ではない）に委譲**（`/code:pr-review-team` skill 規約どおり）。
- **状態**: fixer 適用完了・裏取り済み。次: `select-reviewers.sh` 再実行→再レビュー（Critical/Important=0 の確認は再レビューで裏付ける・自己宣言しない）。

### 6.243 refactor(engine): M2 `/simplify` 指摘対応（#416） (Jul 12, 2026)

PR #417（M2 instrument IPC substrate）の必須レビュー手順 `/simplify`（4並列クリーンアップagent: reuse/simplification/efficiency/altitude）の指摘に対応。

**修正した3件**（RT安全性・効率性の実欠陥。in-scope の新規コードのため修正が妥当と判断）:
- `orbit-clap-instrument-child/src/main.rs`: `decode_slot_events` が毎ブロック `Vec::with_capacity` でヒープ確保していた RT-safety 違反を解消。呼び出し側提供の sink（`&mut Vec<NeutralEvent>`）に書き込む方式に変更し、既存の clamp/invalid-skip ロジックを純関数として保ったまま production hot loop でバッファを再利用（ループ外で1回 `Vec::with_capacity(MAX_EVENTS_PER_BLOCK)` するのみ）。あわせて `event_buf`（CLAP `EventBuffer`）の事前確保も、ダミー event を4096回 push する手動ループから `EventBuffer::with_capacity()`（`orbit-clap-host` から新規 re-export）に置き換え。
- `orbit-audio-sandbox/src/instrument_host.rs`: `VoiceTable::choke()` に `note_end()` と同じ fast-path（addr が完全 specific なら単一セル直接アクセス、wildcard を含むなら `for_matching` 全走査）を追加。specific choke が他キーに影響しないことを確認する回帰テストを追加。
- `orbit-clap-instrument-child/tests/instrument_parity_gated.rs`: 何の効果もない pre-warm 残骸（push 直後に clear、ループ1周目でも再度 clear されるため無意味）を削除。

**スキップした4件**（理由を分けて記録）:
- `PipelinedInstrumentHost`/`PipelinedEffectHost`（`host.rs`）の slot-protocol 重複、`offline.rs` の sync driver 重複、`ClapInstrumentProcessor`/`ClapEffectProcessor`（`effect.rs`）の重複 — **いずれも修正には既存 M1 コード（`host.rs`/`offline.rs` の既存関数/`effect.rs`）への変更を要する**。全 Stage の委譲ブリーフで一貫して「M1 は無変更」と明記してきたスコープ規律（design doc §4.6）に従い、#416 の diff 範囲外として見送り。
- `EventBackingRing`/`EventSpillFifo`（Stage3・本PRで新規追加）の構造的重複 — reuse/altitude/simplification の3agentが独立に収斂した指摘。**この2つは両方とも本PRの新規コードであり、M1スコープ外という理由は使えない**。テスト済みのRT-safe型を landing 間際に再構成するコストが、スタイル上のDRY化の利益に見合わないと判断し、意図的な先送り（premature-abstraction回避）として見送った。将来のfollow-up候補として記録するのみで、今回は issue化しない（軽微な将来リファクタ候補のため）。
- 全32 orbit-audio-sandbox unit test + workspace全体 fmt/clippy/test を Opus main が独立に再実行して確認（Codexの自己申告のgreenを鵜呑みにせず、4ファイルの diff を全て読んでロジックを確認済み）。
- **役割**: 4クリーンアップagentの実行・所見統合・修正要否の判断（M1スコープ外 vs 新規コードでの意図的先送りの区別）＝ advisor 確認の上で Opus main。**実装（3ファイル4箇所）＝ codex 委譲**。
- **状態**: `/simplify` 完了。次 `/code:pr-review-team`。

### 6.242 docs(engine): M2 respawn resume-semantics ギャップを専用issueに切り出し（#416） (Jul 12, 2026)

6.241 で発見した「respawn 後の in-order child が historical seq を再処理する」設計限界について、design doc §4.2(b) のスコープ外注記が「#408 と同様に defer」と記していたが、**#408 の実際のスコープは tempo/transport-context live state の供給側**（Engine/Scheduler への tempo 読み出し可能 state 実装）であり、respawn resume-semantics とは無関係だったことが owner からの確認で判明。#409（multi-bus audio）・#410（load-confirm race）も同様に無関係。

- このギャップを追跡する issue がどこにも存在しない状態だったため、専用 issue **#418**（`feat(engine): M2 instrument child respawn resume-point handshake (#416 follow-on)`）を新規作成。背景・スコープ（resume point の受け渡し機構の設計候補2案・respawn直後の簿記整合の扱い）・着手条件（本番 supervisor 実装段階）を記載。
- design doc §4.2(b) の誤参照（「#408 と同様の扱い」）を「追跡: #418」に訂正。
- **状態**: 記録漏れの是正のみ。実装は着手せず、引き続き #416 スコープ外（#418 で追跡）。

### 6.241 feat(engine): M2 Stage6 Part B2 — 枯渇時note保護 + gated stress（#416） (Jul 12, 2026)

M2 instrument IPC substrate（Issue #416）の Stage6 Part B2（最終パート）。§7-11(a)(b)(c)（枯渇時note保護）・§7-8（gated stress@32f）を実プロセスで実測し、**§7 の12項目すべてを充足**した。

- `sandbox-instrument-child` に `--crash-after <N>` を追加（N seq 処理直後に非ゼロ終了コードで異常終了）。
- テスト専用の `RespawnHarness`（`instrument_host_integration.rs` 内・M1 `EffectChildSupervisor` の考え方を参考にした薄い汎用実装。daemon crate には依存しない）: 別スレッドで `Child::try_wait()` を2ms間隔でポーリングし、異常終了を検知したら同一引数で再spawnして `respawn_count` を進める。teardown は watcher停止→QUIT送信→2秒猶予でreap→強制killの順（`EffectChildSupervisor` と同じ「watchdogを先に止める」規律）。
- §7-11(a): `EVENT_BACKING_CAPACITY` 超のバーストで真の drop を発生させ、sticky-flag による `NoteChoke{WILDCARD}` 注入が実 child まで届き正常に処理されることを確認。
- §7-11(b): `--synthetic-output-burst` に `EVENT_SPILL_CAPACITY` 超の値を指定し、output側の真のdropを発生。`output_event_dropped_count`/`output_note_end_dropped_count` の増分→host側一括リセット→以後19ブロックにわたり遅延NoteEndが `live_count` を負値化させず0に飽和し続けることを確認。
- §7-11(c): `RespawnHarness` でchildを crash→respawn させ、`host.on_child_respawned()` 呼び出しで簿記が0にリセットされること・respawn後の新規NoteOnが正しく1から計数されることを確認。
- §7-8: 32frameブロックで10,000ノート同時バースト＋2,000ブロックにわたる持続高頻度event（67 events/block・約100,500 events/sec相当）を流し、`input_event_dropped_count`/`output_event_dropped_count` が終始0であることを確認（gated・実行時間0.15秒）。
- **レビューで respawn の設計限界を発見・スコープ外と判断**: respawn後の in-order child は常に `last=0` から再開するため、`seq_request` までの historical seq を逐次再処理する（M1 effect child の skip-jump とは異なる）。長時間セッションでは無制限の再処理コストを招きうるが、resume point の受け渡し機構は本番 supervisor が実装される段階（#416 スコープ外・#408 と同様に defer）の課題であり、§7-11(c) が要求する「簿記がリークしないこと」自体は充足している（テストはNoteOff前にcrashさせる構成のため二重処理の影響を受けない設計になっており、advisorとの確認でこの限界がテストの見せかけの green ではないことを検証済み）。設計doc §4.2 (b) にスコープ外注記として追記。
- 全31 unit + 7 (非gated統合) + 1 (gated stress) test が green（Opus main が独立に `cargo fmt`/`clippy`/`test` を再実行、gated stress test も自ら実行して確認。加えてコード自体（respawn harness・`--crash-after`・sticky注入の呼び出しタイミング）を読んで裏取り）。
- **役割**: grounding（既存 `EffectChildSupervisor`/Part A/B1 のパターン調査）＝ Opus main。**実装本体（`--crash-after`・respawn harness・4テスト）＝ codex 委譲**。委譲後、Opus main が独立検証に加え respawn replay の設計限界を発見し、advisor で「§7-11(c) の要求範囲外・#416 スコープ外」であることを確認した上で doc に明記。
- **状態**: **Stage6 完了。§7 受け入れ基準12項目すべて充足。** 残 landing: `cargo deny check` を含む workspace 全体ゲート（本セッションで一度も実行していない）→ WORK_LOG → PR → /simplify → /code:pr-review-team → owner GO でマージ。

### 6.240 feat(engine): M2 Stage6 Part B1 — 合成instrument child + 実プロセス統合テスト（#416） (Jul 12, 2026)

M2 instrument IPC substrate（Issue #416）の Stage6 Part B1。実プロセスを使った production-path 統合テストを追加し、§7-4（round trip・TransportContext含む）・§7-10（input/output双方向 spillover決定論）・§7-12（in-order回帰）を実測した。

- 新規合成 child `sandbox-instrument-child`（`orbit-audio-sandbox/src/bin/`・`sandbox-effect-child.rs` と同パターン）: 実 CLAP プラグイン不要。in-order 消費（§4.6）・NoteOff→NoteEnd の1:1応答・`EventSpillFifo` 経由の output 転送窓詰め込み。テスト専用の `--synthetic-output-burst <N>` 診断経路も持つ（下記参照）。
- **委譲中に Codex が2件の設計矛盾を自ら検出し実装を停止・報告した**（いずれも「不明点は実装せず質問する」規律が正しく機能した例）:
  1. 「1 NoteOff→1 NoteEnd」の1:1契約と、input側 window（`MAX_EVENTS_PER_BLOCK`）による上限がある限り、output側 spill FIFO（§7-10 output方向）が構造的に発火し得ないという矛盾。→ **診断専用の `--synthetic-output-burst`**（起動後最初の1件の NoteOff だけ追加で N 件の NoteEnd を生成する・通常起動では完全無効）を承認して解消。
  2. `EventBackingRing::drain_into()` が spill event の `sample_offset` をクランプせず、既存 Stage3 unit test（`spillover_is_lossless_and_deterministic`）がその「保持」動作を明示的にロックしている一方、§4.2 は spill event の offset=0 クランプを要求する矛盾。→ **`EventBackingRing` 自体は変更せず、`PipelinedInstrumentHost::process_block` の呼び出し側で `backlog_before = event_ring.len()`（push前のring長）を記録し、drain 結果の先頭 `backlog_before` 件（＝過去ブロックからの真の持ち越し分）だけを offset=0 にクランプ、それ以降（同一呼び出し内で新規push→即drainされた新鮮な event）は元の offset を保持する**方式を承認。Part A で既にコミット済みのテスト（`midi(3)` の offset 保持を期待）を壊さないことを確認した上での判断（ring を一律クランプする代案は Part A の正当な既存テストと矛盾するため不採用）。
  3. `input_event_spilled_count`/`output_event_spilled_count`（§7-10 が要求する健全性カウンタ）が Part A では未配線だった点も本タスクで解消（host側=drain後のring残数、child側=詰め込み後のFIFO残数を、それぞれ block ごとに累積加算）。
- §7-12（in-order回帰）のテストは、child未起動のまま host 側で2ブロック submit → 3ブロック目で意図的に stall（submit guard不成立）させ、その後 child を起動して catch-up させる構成。stall 中に ring へ積まれた event が失われず、child 起動後に正しい順序で配送されることを実プロセスで確認。「途中の seq を skip したら fail する」oracle は `output_note_ends` ヘルパの `seq_tag[slot]==seq` assert が暗黙に兼ねる（skip されていれば该当 slot の `seq_tag` が未設定のまま assert が落ちる）。
- 全31 unit test + 4 (M1既存) + 4 (M2新規) integration test が green（Opus main が独立に `cargo fmt`/`clippy`/`test` を再実行し、加えてコード自体（backlog clamp のロジック・synthetic burst の1回限り発火・spilled counter の意味論）を読んで確認）。
- **役割**: grounding（`sandbox-effect-child.rs`/`host_child_integration.rs` の既存パターン調査）＝ Opus main。**実装本体（synthetic child・統合テスト4本・カウンタ配線）＝ codex 委譲**。委譲中に Codex 自身が発見した2件の設計矛盾は、Opus main が一次ソース（既存テスト・design doc）を確認した上で解決方針を判断し、同一 Codex スレッドを `--resume` で継続させて反映。差分は Opus main が独立に再実行・精読して裏取り済み。
- **状態**: Stage6 Part B1 完了。残 Part B2（枯渇時 note 保護 §7-11 a/b/c・gated stress @32f §7-8・respawn harness）・landing。

### 6.239 feat(engine): M2 Stage6 Part A — PipelinedInstrumentHost（#416） (Jul 12, 2026)

M2 instrument IPC substrate（Issue #416）の Stage6 Part A。host 側で初めて event 機構を本番コードに組み込む新規構造体 `PipelinedInstrumentHost`（`orbit-audio-sandbox/src/instrument_host.rs`）を実装した。

- アーキテクチャは既存 `PipelinedEffectHost`（`host.rs`）の submit/read/slot-guard/repeat-previous パターンをそのまま踏襲（§4.6 の指示「host: SUBMIT/READ は無変更」通り）。新規なのは: event backing ring（Stage3実装済み `EventBackingRing`）から `input_events` 転送窓への drain、sticky-flag 枯渇時の `NoteChoke{WILDCARD}` 窓先頭注入、`TransportContext` 転送（`tempo_bpm=0.0` 含む）、`output_events` からの NoteEnd/NoteChoke 読み取りによる `VoiceTable`（§4.7 で確定した `(port,channel,key)` 参照カウント方式）の増減・一括リセット。
- **委譲後の独立検証で voice 簿記の silent leak バグを発見**: 初版実装は NoteEnd/NoteChoke の読み取りを audio 出力の `ready` 判定（`target = submitted-1` の単発チェック）と同じ分岐内に置いていたため、ある block の output が「ready と判定される、その一度きりのタイミング」に間に合わなければ、その block の NoteEnd は二度と読まれず voice カウントが永久に漏れ続ける構造だった。audio は repeat-previous で代替可能だが、event の減算は機会が一度きりで非対称だった。現行 `SLOTS=2` では偶然 stall 経由で顕在化しないが、`transport.rs` 自身のコメントが「実機計測で 3 になりうる」としており、`SLOTS>=3` では実際に起こりうる。
- advisor に検証を依頼し、独立した `event_cursor`（audio の `target` から切り離し、`seq_tag` が visible になるまで同じ seq を再チェックし続ける単調カーソル）への分離を確認・修正委譲。安全性の根拠: instrument child は §4.6 で in-order 消費必須のため全 seq の `seq_tag` を必ず publish する。submit guard（`seq_done >= new_seq - SLOTS`）により、ある slot が次に再利用される前に必ず `seq_done` がその slot の旧 occupant の seq に到達し、child が `seq_tag`/`seq_done` を同時に store する規律により、その時点で `seq_tag` も既に visible になっている（M1 effect child の latest-jump ポリシーには適用不可・instrument の in-order だからこそ成立する分離）。修正前は fail し修正後は pass する回帰テスト（`delayed_note_end_is_drained_after_its_audio_target_has_moved_on`）を追加。
- 全 31 unit test + 4 integration test が green（Opus main が独立に `cargo fmt`/`clippy`/`test` を再実行して確認）。
- **役割**: grounding（`PipelinedEffectHost`/`EventBackingRing`/`EventSpillFifo` の既存 API 調査・§4.6/§4.7 との整合確認）＝ Opus main。**実装本体（`instrument_host.rs` 新規・`VoiceTable`・sticky 注入・簿記更新）＝ codex 委譲**。委譲後、Opus main が読解でバグを発見 → advisor で妥当性検証 → 修正内容を再度 codex に委譲（安全性根拠・修正前 fail の確認を要求）→ 差分・検証コマンドを自ら再実行して裏取り、の2段委譲となった。
- **状態**: Stage6 Part A 完了。残 Part B（合成 instrument child + §7-4,8,10,11,12 統合テスト群）・landing。

### 6.238 docs(engine): M2 §4.7 — host 側 voice 簿記キーを (port,channel,key) に確定（#416） (Jul 12, 2026)

M2 instrument IPC substrate（Issue #416）Stage6 着手前のレビューで、設計doc §4.2(a)「note_id は monotone 採番・再利用しない」という前提が現行実装のどこにも存在しないことが判明した。Stage4 の `PluginEvent::to_neutral_event`（`orbit-clap-host/src/events.rs`・regression test でロック済み）は既存 `Pckn` 挙動を保持するため常に `note_id: -1`（wildcard）のみを発行する。

- owner に案A（`(port,channel,key)` 参照カウント方式・Stage4 無変更）と案B（Stage4 を修正し host が実 note_id を採番）の2択を提示 → owner が Fable への一発判断を選択。
- Fable 判断: **案A採用**。理由は (1) 簿記の目的（leak 検出・respawn/枯渇時リセット）に per-instance identity は不要で計数で足りる、(2) CLAP 自身も note_id なしの `Pckn`（port/channel/key specific・note_id wildcard）が第一級動作モード、(3) 案Bは Stage4/Stage5 で確定済みの sample-exact 回帰なし・A/Bパリティを re-open するコストに見合わない、(4) 一括リセット後の遅延 NoteEnd は saturating decrement で無害に吸収される（簿記は観測専用・音響経路を制御しない）。
- §3 `VoiceAddr.note_id`／§4.2(a) の「monotone 採番」規約は「host が実 note_id を発行し始めた時点から拘束力を持つ条件付き invariant」に再スコープ。§7 受け入れ基準11(b) の文言も参照カウント方式に合わせて修正。
- **format 横断性の確認（owner からの追加質問）**: この判断が CLAP 固有でなく VST3/AU にも成立するかを owner に問われ、既存の §1.1 grounding table（fresh agent が CLAP/VST3/AU 一次ソースから列挙済み）を再確認。AU の voice identity は「MPE ch / MIDI2 per-note（scalar id なし）」と既に記録されており、§3 の `VoiceAddr` コメントも VST3=`noteId+channel+pitch`（CLAP と同型）・AU=cable+MPE channel 近似（scalar id 自体が無い）と整理済みだった。→ host 側簿記キーの決定は VST3/AU child 実装時にも変更不要であることを §4.7 に追記して明記。
- Stage6 実装方針として `VoiceKey{port_index,channel,key}` の Rust 定義・increment/decrement/一括リセットの振る舞いを doc に明記（Codex 委譲ブリーフの直接の入力となる）。
- **役割**: owner が案A/B の選択を Fable に委任 → Fable が一発判断 → Opus main が判断内容を design doc §4.7 に転記・§1.1/§3 との整合を確認して format 横断性を裏取り。実装（Rust コード）はまだ着手していない（次の Codex 委譲の対象）。

### 6.237 feat(engine): M2 Stage5 Part B — instrument child + A/B parity（#416） (Jul 12, 2026)

M2 instrument IPC substrate（Issue #416）の Stage 5 Part B。Part A（`ClapInstrumentProcessor`）を使い、新規 OOP instrument child + offline event driver + 実 dylib（`rust-spike/clap-test-synth`）での A/B parity gated test を実装し、**§7 受け入れ基準5を実測で充足**した。

- 新規 crate `orbit-clap-instrument-child`（`rust/crates/orbit-clap-instrument-child/`）: `orbit-clap-effect-child` と異なり、`SharedRegion` の event slot を **in-order**（§4.6）に消費する — `last+1..=cur` を昇順処理し、中間 seq を skip しない（effect child の「`cur` へ latest-jump」ポリシーとは根本的に異なる）。純関数 `in_order_seqs`/`decode_slot_events` に分離し、実 dylib 不要な CI 実行可能な unit test でカバー（境界値・4096件 clamp・不正 kind のスキップと `event_decode_error_count` 増分）。
- `orbit-audio-sandbox::offline` に新規関数 `render_instrument_through_child_sync_with_options` を追加（既存 `render_through_child_sync_with_options` は無変更）。block ごとの `NeutralEvent` 列を `input_events[slot]`/`input_event_count[slot]` へ直接 publish する 1-outstanding 同期ドライバ（`EventBackingRing`/`EventSpillFifo` は使わない・小規模 event 列の offline parity 専用・容量超過の扱いは Stage 6 の範囲）。
- **A/B parity（オラクル方式の判断）**: `clap-test-synth` は f32 位相累積で正弦波を生成するため、独立計算の `sin()` recomputation では丸め誤差が乗り bit-exact 一致しない（advisor 指摘）。in-process 側（`ClapInstrumentProcessor` に同一 event 列を直接注入）と OOP child 側（本 driver 経由）を突き合わせる A/B parity 方式を採用し、`max_abs_diff == 0.0` を実測（gated test `instrument_parity_gated.rs::real_clap_instrument_oop_event_parity`・128 frames×4 block・NoteOn(key=60)→NoteOff・両側とも非無音を確認済み）。
- output 方向（`NoteEnd` 等の child→host 逆翻訳）・`EventBackingRing`/`EventSpillFifo` の配線には触れていない（`clap-test-synth` は output event を一切生成しないため不要・Stage 6 に切り出し済み）。
- **役割**: grounding（`clap-test-synth` 発見・in-order 規律の設計根拠確認）・advisor 相談（Stage5/6 のスコープ境界・オラクル方式）＝ Opus main。**実装本体（新規 crate・offline driver・gated test）＝ codex 委譲**。委譲後は Opus main が `cargo build --workspace`/`fmt`/`clippy`/`test`（`orbit-audio-sandbox`/`orbit-clap-instrument-child`）に加え、**実 dylib（`rust-spike/clap-test-synth`）をビルドして gated A/B parity test を自ら実行**し green を再確認（他の Stage と同様、報告を鵜呑みにせず一次証拠で裏取り）。
- **状態**: Stage 5 完了（§7 受け入れ基準5 充足）。残 Stage 6（round trip・spillover決定論・枯渇時note保護・in-order回帰・gated stress @32f・§7-4,8,10,11,12）・landing。

### 6.236 feat(engine): M2 Stage5 Part A — ClapInstrumentProcessor（#416） (Jul 12, 2026)

M2 instrument IPC substrate（Issue #416）の Stage 5 は、実装前に advisor へスコープ確認した（§7-5 は「単一 child + closed-form oracle test-synth の event 列→波形」であり、`EventBackingRing`/`EventSpillFifo` の配線・output 方向 translate は Stage 6（§7-4,8,10,11,12）の範囲で Stage 5 には含めない、と整理）。Stage 5 は Part A（`orbit-clap-host` 側 API）と Part B（新規 child + offline event driver + gated A/B parity test）に分割し、本エントリは Part A。

- `orbit-clap-host` の `process_block_core`（`processor.rs`）は instrument の add-mix 分岐（`has_audio_input()==false`）を既に実装済みだったが、既存 `ClapEffectProcessor::process_block` は常に `InputEvents::empty()` を渡すため note event が一切プラグインに届いていなかった（`rust-spike/clap-test-synth` という closed-form oracle 用の最小 CLAP instrument dylib は #293 で既に存在していたが、この欠落のため接続されていなかった）。
- 新規 `ClapInstrumentProcessor`（`instrument.rs`）を追加。`ClapEffectProcessor` と同一の Drop 順（`plugin` を `_instance` より前に宣言・teardown 正当性）を踏襲しつつ、`process_block(&mut self, data, events: &EventBuffer)` が `events.as_input()` を `process_block_core` に渡す点のみ差分。`push_neutral_event`（Stage4）を `orbit-clap-host` の公開 API として re-export。
- **役割**: grounding（既存 instrument 分岐・`clap-test-synth` 発見）・advisor 相談（スコープ確定・オラクル方式の判断）＝ Opus main。**実装本体 = codex 委譲**。委譲後の差分は Opus main が `cargo build --workspace`/`fmt`/`clippy`/`test -p orbit-clap-host` で再検証。
- **状態**: Part A 完了。次 Part B（新規 `orbit-clap-instrument-child` crate・in-order event 消費ループ・`orbit-audio-sandbox::offline` の event 対応 driver・A/B parity gated test）。

### 6.235 feat(engine): M2 Stage4 — orbit-clap-host neutral event translate（#416） (Jul 12, 2026)

M2 instrument IPC substrate（設計 #398・実装 Issue #416）の Stage 4。Stage 1-3（wire 型・`SharedRegion` event slot・host backing ring/child spill FIFO）に続き、`orbit-clap-host` 側に `NeutralEvent` ⇔ CLAP event の双方向 translate を実装した（設計正本 §7 受け入れ基準3）。

- `PluginEvent::to_neutral_event` で既存 in-process の `NoteOn`/`NoteOff` を `NeutralEvent` へ変換。`push_neutral_event` で `NeutralEvent`（NoteOn/NoteOff/NoteChoke/NoteExpression/ParamValue/ParamMod/ParamGestureBegin/ParamGestureEnd/MidiRaw/Midi2）を clack `EventBuffer` へ翻訳する host→child 方向の共通関数を追加。`drain_to_event_buffer` の内部実装を新関数経由にリファクタ（シグネチャ・既存の sample-offset=0・`EventFlags::IS_LIVE`・Pckn 構成〔`port_index` は wildcard でなく Specific〕は不変・regression test でロック）。
- **v1 で意図的に drop する2ケース**: `PolyPressure`（CLAP に対応する独立 event も note-expression type も無い）、`NoteEnd`/`LegacyMidiCcOut`（child→host 専用の output-only variant・host→child 方向への混入は呼び出し側のロジックエラー）。いずれも `push_neutral_event` は panic せず `false` を返す（`EventRecord::decode()` の `None` パターンと統一）。
- `param_id: u64 → ClapId` は `u32` 幅超過・`u32::MAX` sentinel を `None` として drop。`NeutralExpressionId → NoteExpressionType` は7 variant を exhaustive match（数値 cast に頼らない）。
- vendored clack（rev `f874e858`）の `CoreEventSpace::from_unknown` が `ParamGestureBegin`/`ParamGestureEnd` の `TYPE_ID` を欠落させている実装ギャップを一次ソースで確認（テストは `as_event_for_space` による直接 downcast で回避・production コードには影響なし）。Stage5 以降で output 方向の読み取りを実装する際の留意点として記録。
- **役割**: grounding（clack API 調査・§7 受け入れ基準の解釈）・advisor 相談（実装計画確定前・regression の要点＝既存 Pckn `port_index` が Specific である点の保持）＝ Opus main。**実装本体（`events.rs` 全体・テスト）＝ codex 委譲**（`/codex:rescue`）。委譲後の差分・claims（clack gap 含む）は Opus main が一次ソースで裏取り。
- **検証**: `cargo fmt -p orbit-clap-host --check` / `cargo clippy -p orbit-clap-host --all-targets -- -D warnings` / `cargo test -p orbit-clap-host`（18 passed）/ `cargo test -p orbit-audio-daemon --lib --features clap-host engine_wrap`（18 passed・既存 `PluginEvent` 消費側の regression なし）全て green。
- **状態**: Stage4 完了。残 Stage5（CLAP instrument child・closed-form oracle test-synth）・Stage6（統合テスト群）・landing。

### 6.234 docs(engine): M2 landing-review fixes — Fable overflow/param_id decisions + advisor verify（#398） (Jul 12, 2026)

M2 設計 doc（PR #399）に対する landing 前レビューを Fable fresh agent に依頼し、判定 LAND-WITH-FIXES（5 blocker + 準blocker）を得て全て反映した。owner 確認後、blocker のうち2件（新しい設計判断）は owner 指名で Fable に一発判断を委ね、確定後 advisor で内部整合性を verify した。

- **クラスX（既存決定の安全側の明記・Q1-Q6 再決定なし）**: `decode()` の検証範囲を `kind` タグだけでなく payload 内の nested enum（`NeutralExpressionId` 等）まで拡張明記（§3 + §7 item2）。host の `output_event_count` 読み取りに `MAX_EVENTS_PER_BLOCK` clamp を明記（M1 の `n_frames` clamp 規律と同型）。§7 受け入れ基準に3テスト追加（全variant round-trip・spillover決定論・枯渇時note保護）。親plan `POST_2.0_VST3_HOSTING_PLAN.md` の Q5矛盾（bus arrangement「含める」記述）を解消。#400/#401 を CLOSED に更新。
- **クラスY（owner-owned micro-decision・Fable 一発判断 2026-07-12）**:
  - **output方向（child→host）の overflow policy**: 3 format とも output event が render 呼び出し内の同期出力である（producer=consumer が child の同一スレッド）という事実の発見により、input 側の host backing ring と対称にする案・単純 drop-newest 案のいずれでもなく、**child プロセスの通常メモリに置く固定容量 spill FIFO**（shm 不要・lock-free SPSC 不要）を採用。host 側の防衛はタイムアウト強制解放（voice id 衝突リスク）ではなく、**note_id monotone 採番 + supervisor respawn=implicit all-voices-end** の2規約で NoteEnd 喪失を「不可聴の簿記リーク」に格下げして無害化する設計に転換。
  - **`param_id` の意味論**: `ParamBody.param_id`/`GestureBody.param_id` を u32→u64 に拡張し、child native format id（CLAP `clap_id`=u32・VST3 `ParamID`=u32・AU `AUParameterAddress`=u64、いずれも一次 SDK ヘッダで接地確認）の zero-extend として運ぶ方式を採用。host 発行の論理 index 案は、CLAP `rescan()`/VST3 restructure 時に host/child 両側の対応表を in-flight event と競合しながら差し替える新たな契約面を生むため不採用。wire サイズコストは rustc 実測で厳密にゼロと機械検証済み（`_pad: u32` が既に u64化に必要な4バイトを予約していたため）。副産物として `EventPayload`/`EventRecord` のサイズ見積り（`raw:[u8;24]`・≈32B/≈512KB）が現行定義でも既に stale だったことが判明し、正しい値（32B/40B/≈640KB）に訂正。
- **advisor による doc 内部整合性 verify**: grep では拾えない3件の不整合（host backing ring と child spill FIFO のサイズ記載矛盾・output方向 lock-free の前提〔3 format render 同期〕が本文に未記載・`VoiceAddr.note_id` 定義に monotone 採番 invariant の相互参照がない）を検出し、いずれも設計変更を伴わない1行修正で解消。
- **役割**: landing前レビュー=Fable fresh agent（zero-context・doc+正本のみで判定） / owner-owned micro-decision の判断材料整理=Opus main / 決定=Fable（owner 指名の一発判断）+ owner確認 / 内部整合性 verify=advisor。**codex 委譲なし**。
- **状態**: PR #399 の body を Q1-Q6 + 新2決定の DECIDED 反映に最新化し ready for review 化（`gh pr ready`）。マージは owner の明示 GO 待ち（`gh pr merge` は未実行）。

### 6.233 docs(engine): M2 transport 容量設計を「溢れても失わない」方式に確定（#398） (Jul 12, 2026)

6.222 に続き、M2 の残り open question のうち Q3(sample offset)を owner が即決、Q4(transport 容量・overflow policy)を大幅な設計転換を経て確定した。残る open question は Q5・Q6 の2問のみ。

- **当初案「64個/ブロック・drop-oldest」への owner 懸念**: 「実験的な用途で見えない天井になりかねない」。grounding agent（opus）が JUCE(MidiBuffer=容量無制限で動的成長)・Apple AUv3(MIDIEventList=可変長・旧MIDIPacketListは最大65536byte)・JACK MIDI(固定2048byte/cycle・drop+count・`jack_midi_get_lost_event_count`)・VST3(validator上限~2048events/block相当)を調査し、64が業界水準を大きく下回ることを裏付けた。
- **Fable 判断①（容量アーキテクチャ）**: drop-oldest は捨てられるイベントに `NoteOff` が含まれうるため stuck note（音が鳴りっぱなしで止まらない）を生む構造的欠陥と指摘。「上限を大きくする」でなく「**溢れても失わない**」設計へ転換 — per-block 転送窓(`MAX_EVENTS_PER_BLOCK=4096`・根拠=統計的典型性でなく`MAX_FRAMES`と揃えた「1 sample/event」のアーキテクチャ飽和点)+ backing ring(65,536 slot・lossless spillover・超過分は次ブロックへ)。真の drop は backing ring 枯渇時のみ・drop-newest・NoteOff等はサイレント drop 禁止(sticky flagでnote-choke注入)。可視化は`event_dropped_count`/`event_spilled_count`を非音響channelで(音は変えない)。
- **owner の再度の問い直し**: 「本当に上限を作る形でよいか」「既存CLAPホストの同種欠陥を今直すべきでは」「アーキ全体の監査は要らないか」。
- **Fable 判断②（実コード確認込み）**: ①time-budget(天井なし)方式は不採用— 転送コピーが軽すぎて時間は希少資源にならず、決定論的検証文化(sample-exact oracle parity)と衝突するため4096+spilloverを維持。②既存in-process CLAP ring(`engine_wrap.rs`)は producer が非RTスレッドと判明、bounded retryだけで安価にlossless化できるため**今すぐ独立issueで着手**(#400)。③`Engine::with_scheduler`のlock競合時silent zero-fill(`engine.rs`)を新規発見、contention counter追加のみで可視化(#401)。④exhaustive監査は不要・見つかった2件をissue化+再発防止は「新規bounded構造導入時の宣言原則」(producer thread種別/overflow policy/可視化counterの3点を明記)の成文化で足りると判断。
- **owner がFableのコスト意識を指摘**: 「監査不要」判断についても「Fableは高コストなので、もっと安いやり方で本当に不要か検討し直せ」→ fresh general-purpose agent(opus・低コスト)にTS層(未走査だった領域)+grepパターン非依存の手書きqueue探索を委譲（詳細は別entryで記録）。
- **doc反映**: §4を全面改訂（容量設計原則・二段構造・spill時のsample_offset再タイミング規約・新規bounded queue宣言原則・既存コード欠陥2件への参照）。§6 Q3/Q4をDECIDEDに更新。§7受け入れ基準にgated stress test(@32f・10Kノート同時バースト・event_dropped_count==0)を追加。冒頭の設計経緯節に今回の経緯を追記(次セッションのwhiplash防止)。
- **役割**: grounding(JUCE/JACK/VST3業界調査)=fresh agent(opus) / 容量アーキ決定=Fable(2回・owner指名) / 決定所有=owner+Opus main。
- **状態**: Issue #400(既存CLAP ring lossless化)・#401(engine.rs contention可視化)を作成済み・M2(#398)とは独立スコープとして即実装着手。M2の残open questionはQ5(bus arrangement defer)・Q6(tempo同期defer)の2問のみ。

### 6.232 docs(engine): M2 wire 設計を named superset union で確定（owner+Fable判断）（#398） (Jul 12, 2026)

6.221 の DRAFT に対し owner が「DSL→IAC Bus MIDI のように、規格ごとに pluggable に翻訳する薄い共通層の方がいいのでは」と疑問提起。この議論を通じて `POST_2.0_GAMMA_M2_DESIGN.md` の wire 設計方針（旧 Q1/Q2）を確定させた。

- **owner の疑問が突いた3軸分解**: 「format-neutral」は①意味論カバレッジ ②wire型構造(named か opaque か) ③コード構造(共有か per-format か)の独立した3軸だった。正本 §3(STYLE=CLAP型に寄せるな)と `VST3_HOSTING_PLAN.md` §1(SCOPE=機能を除外するな)は①②の一部だけを縛る別軸の制約で、対立していなかった（advisor が一旦「薄い core」に振れたのは①②③を混同した overcorrection・自己訂正で撤回）。
- **grounding agent（opus）の追加事実**: 「superset にする」の文言は正本 §3 の原文には無く、8日後の派生 doc `VST3_HOSTING_PLAN.md`（PR #395）で追加された gloss だった。JUCE・UAPMD 等の実在する複数規格ホストは「名前のついた薄い共通層(MIDI/UMP)＋各規格側で翻訳」を採用しており、「規格ごとに不透明な byte payload」の実例は見つからず。
- **Fable 一発判断（owner 指名で `Agent(subagent_type: "general-purpose", model: "fable")` 起動）**: 候補A(意味論に named tagged union)採用・候補B(規格ごとの opaque payload)不採用。理由: host/child は同一ビルド前提のため B の「host が型を知らない」利点は成立せず、実装すると A の再発明に堕ちる。**M1 類推の訂正**: M1 host は完成済み音声を運ぶだけの dumb pipe だったが、M2 host(DSLスケジューラ)は note/param イベントの生成者であり意味論から逃げられない。「pluggable」の正しい置き場所は wire ではなく child 側の honor 段階(既存 Q1 原則)と child バイナリの追加。
- **owner 確定（2026-07-12・「いいと思うよ」）**: 候補A採用・MIDI2 明示的に必須。§2/§3(旧Q1/Q2)を DECIDED として記録し、以後蒸し返さない。
- **型設計の安全性修正（Fable 指摘）**: `#[repr(C, u8)]` enum を共有メモリから直接 transmute しない（crash した child の不正 discriminant が UB になる・M1 unsafe 監査文化と整合）。`EventRecord{kind: u32, sample_offset, payload: EventPayload}` + POD union + 検証付き `decode()`/`encode()` に変更。ergonomic な `NeutralEvent` enum はロジック層専用（shm には直接置かない）。
- **doc 冒頭に「設計経緯」節を新設**（advisor の provenance 記録要請どおり・[[verify-review-convergence-provenance]]・次セッションの whiplash 防止）。
- **役割**: grounding=fresh agent(opus・2並列起動) / 枠組み検査=advisor(3往復) / 難所の一発判断=Fable(owner 指名) / 決定所有=owner+Opus main。**codex 委譲なし**。
- **状態**: 残る open question は Q3(sample offset必須=推奨済)・Q4(transport容量・overflow policy・side-channel設計)・Q5(bus arrangement=defer推奨)・Q6(tempo同期=defer推奨)の4問のみ。owner サインオフ後に実装着手。

### 6.231 docs(engine): Phase 2 — M2 instrument IPC substrate 設計 DRAFT（#398） (Jul 12, 2026)

VST3 hosting Phase 0+1（PR #397 MERGED・main `e6476e2`）の次の関門 = **Phase 2 = M2 instrument IPC substrate の SPEC 作業**（`POST_2.0_PLUGIN_STRATEGY.html` §3 の唯一の plan-affecting 決定 = M2 IPC を CLAP イベント形に寄せず format-neutral に仕様化）。Issue #398 / branch `398-vst3-phase2-m2-ipc-design` で DRAFT doc `docs/development/POST_2.0_GAMMA_M2_DESIGN.md` を執筆。owner は就寝中のため、決定を先取りせず open question として明示した状態で停止（[[consult-layering-by-error-type]] の層分け運用）。

- **grounding（fresh agent・opus・一次ソース直読）**: CLAP `free-audio/clap` `events.h`/`note-ports.h`・VST3 `steinbergmedia/vst3_pluginterfaces` `ivstevents.h`/`ivstnoteexpression.h`/`ivstparameterchanges.h`・AU/CoreMIDI macOS SDK ヘッダを直接読み、3 format の event/param/note-expression surface（note_id・per-event sample offset・note-expression 7種・per-voice param modulation・MIDI1/MIDI2/UMP・sysex・NoteChoke/NoteEnd 等）を横断列挙。IR 設計はさせず事実列挙のみに限定（grounding ≠ deciding）。
- **advisor 2 往復**: ①アプローチ承認 + 4点補強（Q1 を「wire意味論=今superset」「child適用=段階的」に分離する軸・note_id 等の具体欠落例・neutral wire は `orbit-audio-sandbox`（clack-free）の POD にすべき制約・固定長 event slot が要求する capacity/overflow policy）。②draft 後の superset 完全性検査で **grounding にあり §3 案から脱落していた2点（VST3 `ChordEvent`/`ScaleEvent`・transport/musical context の tempo/beat/tsig 同期）+ param automation の canonical 表現未記載 + 受け入れ基準の「CLAP instrument child は現存しない」未明示**を検出 → 全て doc に反映（Chord/Scale は意図的除外を明記して defer、transport/musical context は新設 Q6 として owner 判断に諮る〔サイレント除外にしない〕、param automation は discrete point 列が 3 format の superset である旨を明記、受け入れ基準に「新規 deliverable」「closed-form oracle 必須」を追記）。
- **doc 構成**: neutral event wire 型の具体案（`#[repr(C)]` tagged union `NeutralEvent`・`VoiceAddr` によるwildcard対応アドレス指定）+ `SharedRegion` への event slot 拡張案（M1 の per-slot `seq_tag`/`n_frames` パターンを踏襲）+ 未決の owner 判断 6問（Q1 分離原則の確定・Q2 neutral IR 戦略・Q3 per-event sample-offset 必須化・Q4 transport layout 具体値/overflow policy・Q5 bus arrangement honor スコープ・Q6 transport/musical context の wire 包含可否）+ Phase 3 受け入れ基準 draft。
- **役割**: grounding=fresh agent(opus) / 枠組み・superset 完全性検査=advisor / 設計所有・decision drafting=Opus main。**codex 委譲なし**（正本の禁止どおり）。
- **状態**: DRAFT のまま commit・push・draft PR 作成のみ実施。`/simplify`・`/code:pr-review-team`・merge は回さない（決定 pending の docs-only 変更のため）。owner サインオフ後に Phase 2 実装（`orbit-audio-sandbox` 型定義・SharedRegion 拡張）着手・Phase 3（VST3 instrument）は M2 landing まで引き続き禁止。

### 6.230 docs(wctm): retarget deadline + relax Max-mandatory premise (#414) (Jul 12, 2026)

藝大コンサート（Max サマースクール・イン・藝大 2026 / 2026-08-07）不採択に伴い、WCTM 関連ドキュメントから「ハード締切 2026-08-07」と「Max 必須（参加条件）」の前提を除去（Issue #414、統括 #413）。**内容の再設計はせず**、藝大版の設計本文はスナップショットとして保持。

- **確定事実は「藝大不採択」のみ**。ICLC への proposal 提出（≈8/15）は年次・提出日・提出形態（work / work+paper、paper は ICMC 別提出も検討）いずれも要確認扱いで、硬い日付に置換しない（advisor 指摘: 硬い前提を別の硬い前提で置換すると同型のバグを再生産する）。
- **ナビ = 本文修正**: `CLAUDE.md` §現在進行中 / `docs/core/INDEX.md`（+ research 凍結ポインタ）/ `INSTRUCTION_ORBITSCORE_DSL.md` / `POST_2.0_*` 6箇所（MASTER_PLAN ×2 / PLUGIN_STRATEGY / NEXT_STEPS / ROADMAP_NOTES / ORBITSTUDIO_PLAN）の締切参照を retarget ポインタ（#413）へ更新。
- **正本 = 入口ノート + 本文凍結**: `WCTM_SYSTEM_SPEC_v1.md` / `IMPLEMENTATION_INSTRUCTIONS.md` の冒頭に前提変更ノートを追加し meta の concert/deadline を訂正。§0 分業原理・週次計画（W1–W6 / SPReAD / リハ#1）等の本文は藝大版スナップショットとして保持。§7 Known Decisions は再議論しない（締切・Max 必須は外部与件であって決定ログ #1-32 ではない）。
- **凍結（本文無変更）**: `docs/research/WCTM_*` 7本 + `DESIGN_DISCUSSION_RECORD.md`。旧前提のスナップショットとして意図的に保存（記録改変は文脈破壊）。
- `docs/WCTM/ARCHITECTURE.html` は `.gitignore` 済・別ブランチ `wctm-architecture-docs` 管理のため本 PR の対象外。
- **統括 Issue #413 新設**（WCTM/ICLC トラックの受け皿・stub）。Epic #224 本文更新 + #240 相互参照。将来方向（private レポ接続・論文・orbitstudio 集約）は #413 で追跡。
- 着手前に advisor に方針を諮問し、POST_2.0_* 6箇所の欠落補足・硬い日付の再置換回避・§7 非抵触・入口ノート方式の健全性を確認済み。

### 6.229 refactor(engine): dedupe ClapControl test wiring + flatten match (#412 /simplify) (Jul 12, 2026)

6.228（#411 実装）に対する `/simplify` 4並列レビュー（reuse/simplification/efficiency/altitude）で3本が独立に収束した指摘を修正（PR #412）。

- **reuse/simplification/altitude 独立一致**: `loaded_engine()`/`loadable_engine()` が `ClapControl` 構築（event ring・cmd channel・stats 2種）を個別に重複実装していた。共通セットアップを `wire_clap_control()` に抽出し両ヘルパーから呼ぶよう変更（ヘルパー自体は altitude レビュー指摘の通りマージせず、両者の目的の違い〔`plugin_loaded` 事前セットの有無〕は維持）。
- **simplification 指摘**: `ClapCommand` は現状 `LoadPlugin` 1バリアントのみなので、`match cmd { ClapCommand::LoadPlugin { .. } => {...} }` を irrefutable `let` pattern に平坦化しネストを1段削除。
- **simplification 指摘（一部見送り）**: `if let Err(err) = result { panic!(...) }` を `assert!(result.is_ok(), "{result:?}")` に統一する提案は、実際にビルドして確認したところ `LoadedPluginSummary` が `Debug` 未実装のためコンパイルエラーになることが判明。本番コードへの `#[derive(Debug)]` 追加は本 PR のスコープ外（本番コード非変更の制約）のため、元の `if let Err` パターンを維持し、Debug 未実装ゆえの意図的な差異であることをコメントで明記した。
- **検証**: `cargo build -p orbit-audio-daemon --features clap-host`・`cargo test -p orbit-audio-daemon --features clap-host --lib`（31 passed）・`cargo clippy --features clap-host --all-targets -D warnings`・`cargo fmt --check` すべて green。

### 6.228 test(engine): cover load_plugin success flag update (#411) (Jul 12, 2026)

`EngineWrap::load_plugin()` の成功分岐が `plugin_loaded` を true にすることを、実際の `LoadPlugin` コマンド送信と reply channel の往復で検証する unit test を追加。従来の `loaded_engine()` はテスト内でフラグを直接注入していたため、成功分岐の `store(true, ...)` が削除・反転されても検出できなかった穴を埋めた。

### 6.227 test(engine): PluginNote load-gate 回帰テストの空洞化を修正 + CLAP_NOT_LOADED error code（#405） (Jul 12, 2026)

6.226（#405 の実装）に対する `/code:pr-review-team` 4並列レビュー（code-reviewer / pr-test-analyzer / silent-failure-hunter / comment-analyzer）で、回帰テストが実は #405 のガードを検証できていないこと等が判明（PR #407）。

- **問題（Critical・pr-test-analyzer + code-reviewer 独立指摘）**: `assert_rejected_before_load` は `f(&wrap).is_err()` の弱い assertion のみで、`plugin_loaded` ガード（#405 本体）を丸ごと削除しても `clap: Mutex::new(None)`（test backend）経由で `WrapError::ClapUnavailable` が返るため `is_err()` は変わらず成立してしまう。ガードを検証していない空洞化テストだった。
- **修正**:
  - 汎用 `WrapError::Clap` の代わりに専用 variant `WrapError::ClapNotLoaded(String)` を追加し、`push_plugin_event` の未ロードガードがこれを返すよう変更。`session.rs` の `wrap_err_to_protocol` に `CLAP_NOT_LOADED` を追加（既存の `CLAP_UNAVAILABLE`/`CLAP_RUNTIME` と同パターン）。
  - `assert_rejected_before_load` を `matches!(result, Err(WrapError::ClapNotLoaded(_)))` に変更（`ClapUnavailable` と区別可能になり、ガード削除で確実に fail する）。**自己検証**: ガードを一時的にコメントアウトし `cargo test --features clap-host plugin_load_gate_tests` で `note_on/note_off_before_load...` の2テストが実際に `Err(ClapUnavailable(...))` で fail することを確認 → 復元 → 再度緑を確認。
  - positive-path テスト追加（PR #406 の private フィールド直接注入手法を踏襲）: `loaded_engine()` ヘルパーで `make_event_ring`/`ClapProcessorStats::new`/`CallbackTimeStats::new`/`mpsc::channel` から実 `ClapControl` を構築し `wrap.clap`/`wrap.plugin_loaded` に直接注入。`note_on_after_load_reaches_ring`/`note_off_after_load_reaches_ring` が `Ok(())` に加え consumer 側で実イベント到達まで検証。
  - monotonic invariant（finding 4・`plugin_loaded.store` は**本番コード**中1箇所のみ。テストヘルパー `loaded_engine()` の直接注入分を除く）は軽量テスト `plugin_loaded_flag_stays_true_across_multiple_events` を追加（複数回 push 後もフラグが true のまま）。reset 経路が無いため runtime test でこれ以上の検証余地はない。
  - **再レビューで判明した2件の軽微指摘**: (a) comment-analyzer 指摘 — 上記コメントが「全ファイル中1箇所」と書いていたが実際は grep で2箇所ヒット（本番+テストヘルパー）するため文言を訂正（本コミットで対応・ロジック変更なし）。(b) pr-test-analyzer 指摘（5/10・非blocking） — `load_plugin()` 実際の成功分岐（`plugin_loaded.store(true, ...)`, L624）を通るユニットテストが無い（`loaded_engine()` は直接注入でこの分岐を迂回）。既存コードの穴で本フェーズの新規劣化ではないため、Issue #411 で追跡（advisor 判断: 両者とも Critical/Important の閾値未満・収束をブロックしない）。
  - 残存レース開示（MEDIUM・silent-failure-hunter）: `push_plugin_event` 直前と `session.rs` の `handle_plugin_note` 直前のコメントに、LoadPlugin 応答成功〜audio thread への実インストールの間の狭い window で同種の false-success が残りうることを明記（Issue #410 で追跡・修正は scope 外）。
- **検証**: `cargo build --features clap-host -p orbit-audio-daemon` OK / `cargo test --features clap-host -p orbit-audio-daemon --lib` 20 passed / `cargo test -p orbit-audio-daemon`（default features、sandbox 外実行）12 lib + 19 protocol + 1 smoke + 7 verify_schedule_pcm 全 green（sandbox 内は loopback bind が `PermissionDenied` で偽 fail — 既知パターン）/ `cargo clippy --features clap-host -p orbit-audio-daemon -- -D warnings` clean / `cargo clippy -p orbit-audio-daemon -- -D warnings`（default）clean。
- **役割**: レビュー=`/code:pr-review-team` 4並列（code-reviewer / pr-test-analyzer / silent-failure-hunter / comment-analyzer） / 実装=Sonnet 5 subagent（model: sonnet 明示指定・自己検証込み）/ 委譲判断・検証方針策定=main（advisor 相談込み）。コミット trailer（`Co-Authored-By: Claude Sonnet 5`）が実装 agent の身元と一致。

### 6.226 fix(engine): プラグイン未ロード時の PluginNoteOn/PluginNoteOff 嘘成功応答を修正（#405） (Jul 12, 2026)

M2 instrument IPC substrate（#398）の容量設計を検討する過程で、fresh agent（opus）による拡張監査が発見した、容量とは無関係の別種の欠陥。

- **問題**: `PluginNoteOn`/`PluginNoteOff` をプラグインロード前に送ると、audio thread は plugin が無ければ event を drain して捨てる（既存の意図的設計・fire-and-forget ring）一方、**protocol 層は `{"status": "note_on", "key": k}` という成功応答を返してしまう**。単なるデータ欠落より悪い「嘘の成功応答」で、呼び出し側は「鳴った」と誤信する。
- **修正**: `EngineWrap` に `plugin_loaded: Arc<AtomicBool>`（feature `clap-host` 専用・他の `clap`/`link`/`outproc` フィールドと同パターン）を追加。`load_plugin` 成功時に `true` を立て、`push_plugin_event` の冒頭でこれを確認し、未ロードなら ring に触れる前に即座に `WrapError::Clap("no plugin loaded...")`（protocol code `CLAP_RUNTIME`）を返す。hot-unload 機構が存在しないため「一度成功したら true のまま」というシンプルなモデルで足りる（精密な非同期状態追跡はしない）。
- **検証**: 新規 unit test 3本（`EngineWrap::build`〔private・同一モジュール内テストからアクセス可〕を使い実 device/実 ClapControl 無しでガードだけを検証: 未ロード時の NoteOn/NoteOff がエラーを返すこと2本 + フラグの初期値が false であること1本）。`cargo build`(default/clap-host/outproc-effect)・`cargo clippy --all-targets -D warnings`(同3構成)・`cargo fmt --check`・`cargo test --workspace`(全緑)・`cargo deny check licenses`(ok)を確認。既存の gated test（`clap_host_gated.rs`）は load 成功後に note を送るため無影響。
- **役割**: 発見=fresh agent(opus) / 実装・検証=Opus main(直接実装)。
- **状態**: M2(#398)とは独立スコープ。PR 作成 → owner マージ待ち。これで今回の M2 検討過程で見つかった副産物（#400/#401/#404/#405）すべて実装・PR化完了。

### 6.225 refactor(engine): outproc_health アクセサ統合 + frames_clamped の test seam 追加（#406） (Jul 12, 2026)

PR #406（6.224 の frames_clamped 可視化）に対する `/simplify` 4並列レビュー（reuse/simplification/efficiency/altitude）が独立に収束した2件を修正。

- **Finding 1（simplification + efficiency の独立一致）**: `EngineWrap::outproc_health()` と新設 `outproc_frames_clamped()` が同一 tick 内で同一 `self.outproc` mutex に対し個別に `try_lock()` + `.snapshot()` していた（冗長ロック・かつ2呼び出しが同一スナップショットを観測する保証が無い＝片方 `WouldBlock` で 0 を返す間にもう片方が非ゼロを観測しうる）。`outproc_health()` の戻り値を `(u64, u64, bool)` → `(u64, u64, bool, u64)` に拡張し、単一の `try_lock` + `snapshot` で4 signal（`child_process_error_count`/`respawn_count`/`measurement_invalid`/`frames_clamped`）を返すよう統合。独立 `outproc_frames_clamped()`（有効/無効ビルド両方の実装）を削除し、`session.rs` のticker loop を4要素destructureに更新（呼び出し箇所は `rg` で `session.rs:163` の1箇所のみと確認済み）。
- **Finding 2（reuse + altitude の独立一致・履歴根拠あり）**: `link_egress_drops`+`link_egress_drops_arc()`（PR #331）・`clap_process_errors`+`clap_process_errors_arc()`（PR #340）に既に確立していた「counter field + `#[doc(hidden)] *_arc()` injection accessor + `tests/protocol.rs` latch test」パターンが `frames_clamped` には無く（非 outproc-effect ビルドの stub が固定 `return 0`）、default feature build でこの signal を exercise するテストが存在しなかった。altitude レビューが指摘した通り `frames_clamped` は gated 実機テストの現実的な駆動経路も無い（outproc_health の他3 signal は kill-test で強制可能）ため、test seam は「あれば尚良い」ではなく必須。`outproc_frames_clamped: Arc<AtomicU64>` フィールド（unconditional）+ `outproc_frames_clamped_arc()`（`#[doc(hidden)]`・unconditional）を追加し、consolidated `outproc_health()` の frames_clamped を `s.frames_clamped + injected` で合算。`tests/protocol.rs` に `daemon_error_warning_on_outproc_frames_clamped`（`daemon_error_warning_on_link_egress_drop`/`_clap_process_error` と同型・発火 + latch 非再発火を検証）を追加。**scope外**: 既存3 signal（`OUTPROC_EFFECT_ERROR`/`RESPAWN`/`INVALID`）への同種seam retrofit はこのPRの対象外（frames_clamped固有の穴のみ埋める）。
- **検証**: `cargo build`(default/outproc-effect/clap-host 3構成) / `cargo test --lib`(outproc-effect) / `cargo test --test protocol`(default・20 passed、うち新規1件) / `cargo clippy --workspace --all-targets -D warnings`(default) + 同(outproc-effect) + 同(clap-host) / `cargo fmt --all` すべて green。
- **役割**: 発見=`/simplify` 4並列レビュー(独立収束) / 実装・検証=Opus main(直接実装)。
- **状態**: PR #406 への追加コミット。

### 6.224 fix(engine): out-of-process effect の frames_clamped カウンターを可視化（#404） (Jul 12, 2026)

M2 instrument IPC substrate（#398）の容量設計を検討する過程で、fresh agent（opus）による拡張監査（#400/#401 の Fable 発見を受けた TS層+grepパターン非依存の追加調査）が発見した箇所。

- **問題**: `orbit-audio-sandbox`（out-of-process effect transport・`MAX_FRAMES=4096`）で、1ブロックがこれを超えると末尾を無音化し `frames_clamped` カウンターに記録する仕組みは既に実装済み（`OutProcEffectStats::frames_clamped`・`snapshot()` にも含まれる）だったが、`EngineWrap::outproc_health()` が返すタプルに含まれておらず、他の兄弟カウンター（`CLAP_PROCESS_ERROR`・`OUTPROC_EFFECT_ERROR`等）と違って daemon の 1Hz ticker に一度も配線されていなかった。
- **修正**: 既存タプルを変更せず、新規 `EngineWrap::outproc_frames_clamped()` accessor（`outproc_health` と同じ try_lock 規約）を追加し、`ERROR_CODE_OUTPROC_EFFECT_FRAMES_CLAMPED`（新設）で 1Hz ticker に配線。カウント自体のロジックは `orbit-audio-sandbox` 側で既にテスト済みのため、今回は plumbing のみ（新規 unit test は追加せず、既存の `outproc_health()` と同型の untested accessor パターンに合わせた）。
- **検証**: `cargo build`(default/outproc-effect/clap-host)・`cargo clippy --all-targets -D warnings`(同3構成)・`cargo fmt --check`・`cargo test --workspace`(全緑)・`cargo deny check licenses`(ok)を確認。
- **役割**: 発見=fresh agent(opus) / 実装・検証=Opus main(直接実装)。
- **状態**: M2(#398)とは独立スコープ。PR 作成 → owner マージ待ち。

### 6.223 fix(engine): ENGINE_LOCK_CONTENTION の WouldBlock/Poisoned 混同を修正（PR #403） (Jul 12, 2026)

PR #403（#401 の実装）に対する `/simplify` 4並列レビュー（reuse/simplification/efficiency/altitude）で altitude レビュアーが発見し、コード直接確認で確定した実バグ。`orbit-audio-core::Engine::with_scheduler`/`render_multi` の `Err(_)` ワイルドカードが `std::sync::Mutex::try_lock()` の `WouldBlock`（一時競合・次ブロックで自己修復）と `Poisoned`（別スレッド panic による永続破損・`clear_poison()` 呼び出し箇所なしで恒久化）を同一カウンタ・同一 fallback に混ぜていた。poison すると `contention_count` が以後ずっと増え続け、daemon の WARNING メッセージ「this self-heals next block」が実際には二度と真にならない状態のまま無限に再発火する欠陥だった。

- **実装**: `Engine` に `poisoned: Arc<AtomicBool>` を追加し `with_scheduler`/`render_multi` の match 節を `Err(TryLockError::WouldBlock)`（`contention_count` 増分のみ）と `Err(TryLockError::Poisoned(_))`（`poisoned.store(true, Relaxed)` のみ）に分離。両分岐とも RT スレッドのため `tracing::warn!` 等のブロッキング処理は行わない（非ブロッキング atomic write のみ）。`is_lock_poisoned()` accessor を追加。
- **daemon 配線**: `ERROR_CODE_ENGINE_LOCK_POISONED`（新設・**FATAL** severity）を追加し、`EngineWrap::engine_lock_poisoned()` → 1Hz ticker で `device_lost` と同じ fire-once latch パターンで発火。FATAL 選定根拠: このコードベースの FATAL は session を終了しない（`device_lost_reported=true` 後も ticker は StreamStats を出し続ける）ため「恒久障害だが daemon 生存」を表す severity として一貫する。poison は render 全体 + `schedule`/`stop`/`stop_all`/`set_global_gain` の制御系 API も道連れにする点で `OUTPROC_EFFECT_INVALID`（effect 経路のみ凍結・WARNING）より重く、`device_lost` に近いため FATAL とした。
- **テスト seam**: `Engine::contention_count_arc()`/`poisoned_arc()`（`#[doc(hidden)]`、`StreamStats::record_xrun` と同形の直接注入 — 生の atomic なので link/clap のような additive 分離 counter は不要）を追加し `EngineWrap` に delegate。`tests/protocol.rs` に `daemon_error_warning_on_engine_lock_contention`/`daemon_error_fatal_on_engine_lock_poisoned` を追加（latch 検証込み）。加えて `orbit-audio-core::engine::tests` に、別スレッドで実際に panic させ Mutex を genuine-poison する unit test を追加し、`poisoned` フラグが `contention_count` を汚染しないことを実際の poison で確認。
- **ドキュメント cleanup**: field doc とアクセサ doc の重複を解消（simplification レビュー指摘）、`render_multi_routes_by_channel_tag` テストの「決定論的に競合を起こせない」という古いコメントを削除（後続テストで実際に決定論的検証済みのため矛盾していた）。
- **検証**: `cargo build`(core / daemon default / daemon clap-host)・`cargo test`(core --lib 45件・daemon --lib 13件・daemon --test protocol 21件、全緑)・`cargo clippy --workspace --all-targets -D warnings`・`cargo fmt --check` を確認。
- **役割**: 発見=`/simplify` 4並列レビュー（altitude が主犯、reuse/simplification が付随指摘）/ 実装・検証=Opus subagent（advisor で設計レビュー後に commit）。
- **状態**: PR #403 に追加コミットとして push 済み。

### 6.222 fix(engine): Engine lock 競合の silent zero-fill を可視化（#401） (Jul 12, 2026)

M2 instrument IPC substrate（#398）の容量設計を検討する過程で、Fable の拡張レビューが新たに発見した箇所。`orbit-audio-core::Engine::with_scheduler`/`render_multi` は RT 競合（`try_lock` 失敗）時に出力バッファを silent zero-fill する既存設計（lock-free 化は別 Issue で defer 済み・自己修復する障害）だったが、発生を可視化する仕組みが一切なかった。

- **実装**: `Engine` に `contention_count: Arc<AtomicU64>` を追加し、`with_scheduler`/`render_multi` 両方の `Err(_)`（try_lock 失敗）分岐で増分。`lock_contention_count()` accessor を追加。
- **daemon 配線**: `EngineWrap::engine_lock_contention_count()` → `ERROR_CODE_ENGINE_LOCK_CONTENTION`（新設）→ 既存の 1Hz ticker パターンに配線。
- **検証**: 新規 unit test 2本（`inner` は同一モジュール内テストから直接 lock 可能な private field のため、同一スレッドで guard を保持したまま `render`/`render_multi` を呼び、try_lock 失敗を人工的に発生させて検証。std::sync::Mutex は非再入なので別スレッド spawn 不要）。`cargo build`(default/clap-host/outproc-effect)・`cargo clippy --all-targets -D warnings`(orbit-audio-core含む4構成)・`cargo fmt --check`・`cargo test --workspace`(全緑)・`cargo deny check licenses`(ok)を確認。
- **付随調査**: 同セッションで fresh agent(opus)による拡張監査（TS層+grepパターン非依存のRust手書きqueue探索）を実施し、TS層には同種欠陥なし・新たに2件発見（`orbit-audio-sandbox`の`frames_clamped`カウンター未配線／プラグイン未ロード時のNoteOn/NoteOffが嘘の成功応答を返す）→ 別途 issue化予定。LinkAudio側の`MAX_LINK_CHANNELS`(64)の debug_assert は、control側(`register_channel`)が同じ上限を既に error として強制しているため構造上到達不能と判断し見送り。
- **役割**: 発見=Fable(実コード確認込みレビュー) / 実装・検証=Opus main(直接実装)。
- **状態**: M2(#398)とは独立スコープ。PR 作成 → owner マージ待ち。

### 6.221 fix(engine): in-process CLAP event ring を bounded retry で lossless 化（#400） (Jul 12, 2026)

M2 instrument IPC substrate（#398）の transport 容量設計を検討する過程で、既存の in-process CLAP event ring（`orbit-audio-daemon/src/engine_wrap.rs` の `push_plugin_event`・1024 slot）に同種の欠陥（満杯時 drop-newest だが可視化カウンタなし・NoteOff drop で stuck note の可能性）が見つかり、Fable のレビューで「producer が RT スレッドでないため bounded retry だけで安価に lossless 化できる」と判明したため、M2 とは独立した issue として即着手した。

- **実コード確認**: `push_plugin_event` の呼び出し元は `session.rs` の WS command handler（tokio async task・control スレッド）であり RT audio スレッドではない。consumer（`processor.rs` の `drain_to_event_buffer`）は毎 audio callback で ring を全量 drain するため、最大 1 callback 周期（buffer 設定によって ~1.3〜93ms）待てば空きが保証される。
- **実装**: `push_with_bounded_retry<T>`（`rtrb::Producer<T>` 汎用・純粋関数・mutex 非依存）を新設し、最大200回・1ms間隔（≈200ms上限）で retry。真にタイムアウトした場合のみ `plugin_event_ring_overflow_count`（新規 `Arc<AtomicU64>`・`clap_process_errors` と同型の unconditional health-signal フィールド）を進めてエラーを返す。`push_plugin_event` はこのヘルパーを呼ぶだけに簡素化。
- **可視化**: `ERROR_CODE_PLUGIN_EVENT_RING_OVERFLOW`（`protocol.rs`）を新設し、既存の 1Hz ticker（`CLAP_PROCESS_ERROR` 等と同型パターン）に配線。
- **tokio ワーカー保護**: bounded retry で `plugin_note_on`/`plugin_note_off` が最大 ~200ms ブロックしうるようになったため、`session.rs` の `PluginNoteOn`/`PluginNoteOff` handler を `LoadPlugin` と同じ `tokio::task::spawn_blocking` パターンで包み、tokio ワーカースレッドを塞がないようにした。
- **検証**: 初回コミットで新規 unit test 3本（`plugin_event_ring_retry_tests`・即座に成功／consumer drain 後に成功／真の overflow で counter 増分）を追加。以降 PR #402 の pr-review-team 反復（/simplify・カバレッジギャップ是正・`handle_command` dispatch 一本化）で `plugin_event_ring_retry_tests` に fatal outcome 早期リターン 1本を追加し、さらに `push_plugin_event_tests`（clap 未初期化時の `ClapUnavailable` 2本）・`plugin_note_spec_*`（配線 pin 2本）・`handle_plugin_note_*`（fn-pointer dispatch・spawn_blocking join-error 2本）・`tests/protocol.rs` の統合テスト（ring overflow warning 1本）を追加し、累計で新規 unit/integration test 11本。clap-host feature 下で全て PASS。`cargo build`(default/clap-host/outproc-effect)・`cargo clippy --all-targets -D warnings`(同3構成)・`cargo fmt --check`・`cargo test --workspace`(全緑)・`cargo deny check licenses`(ok)を確認。
- **役割**: 発見=Fable(実コード確認込みレビュー) / 実装・検証=Opus main(直接実装・小規模のためサブエージェント委譲なし)。
- **状態**: M2(#398)とは独立スコープ。PR #402 iteration 3 レビュー収束（silent-failure-hunter/pr-test-analyzer/code-reviewer）を反映して cleanup 済み → owner マージ待ち。

### 6.220 fix(engine): VST3 host unsafe memory-safety 監査 + hardening 3件（#397） (Jul 11, 2026)

中核の手書き unsafe COM FFI（`orbit-vst3-host/src/lib.rs`・80 unsafe blocks）に対し、`/code:pr-review-team`（汎用 correctness）が構造的に狙わない **memory-safety/UB 次元**の外部第二意見を実施。@claude bot は pr-review-team と同一モデルファミリで盲点が相関するため除外し、**codex（cross-family）+ fresh Opus（非著者）を並列 adversarial 監査 → advisor で tie-break**（[[consult-layering-by-error-type]] の分担）。

- **判定: memory-safety blocker なし**。codex の唯一の blocker 主張「F1 = `process_block` の `&self` + self バッファへの raw `*mut` = aliasing UB」は **false positive**。advisor が rule-dispositive に判定: `&self`（run_process の receiver）は構造体バイト（Vec の ptr/len/cap ヘッダ）を freeze するが、**別割り当てのヒープ要素は freeze しない**（retag は Vec 内部 `NonNull` 越しにヒープを追わない）+ run_process は当該 buffer を `&[f32]` として再借用しない → raw 書き込みは健全。/simplify で alloc 除去したばかりの RT hot path を**非バグで churn しない**（codex の restructure 案は将来 slice 再借用が入った時への任意 future-proofing に留める）。
- **hardening 3件（非 blocking・owner scope 判断で in-PR 修正）**:
  - **4a**（fresh Opus が捕捉・著者 codex は「バス一致」の思い込みで見逃し = authorship-decorrelation の payoff）: `verify_primary_bus_is_stereo` に **negotiated `getBusArrangement` popcount 検証**を追加。`getBusInfo().channelCount==2` は満たすが実際の arrangement popcount>2 の非適合プラグインが固定 2-wide `channelBuffers32` を OOB index するのを防ぐ。`getBusArrangement` 非 ok 時は getBusInfo にフォールバック（`Option<i32>`）し over-reject を回避（回帰なし）。
  - **3a/3b**（両監査一致・`process_stereo` = offline/probe 経路）: 入力を self scratch に copy して **writable provenance** 化 + `frames > load-max` guard（`ProcessBlockTooLarge`）+ `run_process` の `numSamples` を `i32::try_from`→`kInvalidArgument` で checked cast 化。
  - **F4 却下**: `ComPtr::from_raw`=owning・`createInstance`=+1 で balanced（Opus が com-scrape-types source で裏取り）。
- **検証（Opus 非サンドボックス）**: fmt=0 / clippy --workspace（+clap-host/outproc-effect）clean / test --workspace 全 0 failed（daemon `protocol` 19・`oracle_parity` sample-exact 2 PASS = per-fix で挙動不変）/ deny ok。F1 の RT hot path aliasing 構造は無改変（run_process が buffer を slice 再借用しない不変条件を維持）。
- **役割**: 監査=codex + fresh Opus 並列 / tie-break=advisor / 実装=codex 委譲（main が差分レビューで 4a の `getBusArrangement` 非 ok→reject の over-reject 回帰リスクを捕捉し softening 指示）/ 検証=Opus 非サンドボックス。
- **受け入れ**: 新 SHA の Linux CI green を確認してから完了。

### 6.219 fix(engine): VST3 host 系を macOS 限定に cfg-gate — Linux CI リンク失敗を解消（#397） (Jul 11, 2026)

PR #397 の Rust CI `fmt / clippy / test`（`ubuntu-latest` = Linux）が **Test ステップでリンク失敗**していた（head `2df6fc4`）。真因: `orbit-vst3-host` が `core-foundation-sys` 経由で CoreFoundation（macOS framework）シンボル（`CFBundleCreate`/`kCFAllocatorDefault`/`CFBundleGetFunctionPointerForName` 等）を参照 → Linux に該当シンボル無し → 実行ファイル最終リンクで undefined symbol。clippy が通っていたのは最終リンクしないため。VST3+CoreFoundation は原理的に macOS 専用なので、Linux では該当コードを不在にする（in-place cfg gate）。

- **gate 対象（`cargo metadata` で機械的に列挙・全 host リンクターゲット）**:
  - `orbit-vst3-host/src/lib.rs`: crate-root `#![cfg(target_os = "macos")]`（Linux は空 lib・CF 参照消滅）
  - `orbit-vst3-host/src/bin/vst3_probe.rs`（bin）: 全 item に per-item `#[cfg(macos)]` + 非 macOS stub `fn main() -> ExitCode`（空 main 不可のため）
  - `orbit-vst3-host/tests/offline.rs`: `#![cfg(macos)]`（非 `#[ignore]` の 4 テスト = Linux リンク失敗の主因）
  - `orbit-vst3-host/Cargo.toml`: `core-foundation-sys` を `[target.'cfg(target_os = "macos")'.dependencies]` へ（Linux 依存グラフから脱落）・`vst3` は unconditional 据置（純 Rust・gain-oracle も引く）
  - `orbit-vst3-effect-child/src/main.rs`（bin）: per-item `#[cfg(macos)]` + 非 macOS stub main
  - `orbit-vst3-effect-child/tests/cli.rs`・`real_plugin_gated.rs`: `#![cfg(macos)]`
- **据置（正当性を一次情報で確認）**: `oracle_parity.rs` は host 非参照（`orbit_audio_sandbox` のみ）で **gate しない** — Test1 は Linux で `package-oracle.sh`（`set -euo pipefail` + `.dylib` ハードコード → `.so` 環境で `exit 1`）により loud-skip、Test2 は純 sandbox で **Linux 実行される貴重な cross-platform カバレッジ**。gain-oracle（CF 非依存 cdylib）・daemon（vst3 非依存・child は名前 spawn）も無変更
- **検証（Opus 非サンドボックス・macOS-local）**: `fmt --all --check`=0 / `clippy --workspace --all-targets --locked -D warnings`（+ clap-host/outproc-effect feature）clean / `test --workspace --locked` 全 test result **0 failed**（daemon `protocol` 19 passed = サンドボックスの loopback 偽 fail を回避）/ `oracle_parity` 2 テスト PASS（sample-exact 維持 = per-item cfg が macOS item を落としていない証拠）/ `deny check licenses` ok
- **レビュー（三層収束・[[consult-layering-by-error-type]]）**: fable（fresh file-reading agent）が完全性で 2 ターゲット漏れ（vst3_probe bin・offline.rs）を捕捉 → advisor（Opus 4.8）が枠組みで「macOS-green ≠ Linux-links / 受け入れは新 SHA の Linux CI green」を指摘 → Opus fresh general-purpose 監査が 5 観点すべて合格を一次情報で裏取り
- **役割**: 計画=Opus / 実装=codex 委譲（fresh・差分は仕様通り）/ 検証・監査=Opus 非サンドボックス + fresh agent
- **受け入れ**: macOS-local 無退行は実測済。**完了は「新 SHA の Linux `rust-ci.yml` green」を確認するまで保留**（この gate が修正の本来目的を検証する唯一の経路）

### 6.218 fix(engine): VST3 host PR #397 レビュー収束 — bus honest 化・CI 緑・テスト補完（#397） (Jul 10, 2026)

PR #397 の `/code:pr-review-team`（4 レビュアー並列: code-reviewer/silent-failure-hunter/pr-test-analyzer/comment-analyzer + CI）で挙がった Critical/Important を 0 に収束。独立 round-2 再レビューで裏取り（自己判断で宣言しない）。

- **CI 緑化**: `orbit-clap-host/discovery.rs:63-66` の冗長 `&`（clippy 1.97 `useless_borrows_in_formatting`・この PR の diff 外の既存問題が CI を塞いでいた）を除去
- **Critical**: crate doc（`orbit-vst3-host` lib.rs/Cargo.toml）を「Phase 0 spike/offline」→ Phase 1 production に更新 / `PluginFormat::from_env_value`・`default_child_name` の unit test 追加 / `ChildStats` の非 gated テスト追加（synthetic child で `processed`/`process_errors` を assert・dry-passthrough 誤 PASS 穴の CI 側ガード）
- **Important（挙動変更・bus honest 化）**:
  - `verify_primary_bus_is_stereo`（I1）: load 時に primary(index0) バスが stereo でなければ reject。silent audio corruption を explicit load-fail に。instrument は input 検査を skip・multi-bus の stereo bus0 は通す
  - `activate_primary_bus_only`（I2）: activate を index0 バスのみに（`run_process` が 1 バスしか記述しない契約と一致・多バス OOB 回避）+ activateBus 失敗を eprintln
  - `bundleEntry` false → `Err(BundleLoad)`（I3）: get_factory 前に abort（JUCE 準拠・success 側は `bundle_exit_called` 正しく設定）
  - `process_block` guard・`is_ok` の unit test 追加 / field-order コメント正確化 / `real_plugin_gated.rs` の壊れた cross-ref 修正
- **検証（Opus 非サンドボックス）**: oracle sample-exact PASS（挙動不変）+ daemon gated C1-C3 PASS（stale [64f]&[32f] 0.000%）+ **フル sweep v2（733s・333個）**: Effect 268 PASS + Instrument 58 PASS・**genuine crash 0**・test ok。**I1 の唯一の影響 = MIDI Guitar 3（8ch input bus）を honest に load-reject**（silent 誤処理の解消）。UJAM Beatmaker 7 が Crash→Instrument に回復。fmt/clippy/deny clean
- **役割**: レビュー起動/統合/収束判定=Opus（pr-review-team skill）/ fix 適用=sonnet5 委譲（session 上限で途中終了も実質完了・Opus が検証）/ 実機再測定=Opus 非サンドボックス
- **残**: advisor 相談 → bot（@claude）second-opinion → owner マージ判断

### 6.217 perf(engine): VST3 host /simplify — RT hot-path alloc 除去で stale 0%（#397） (Jul 10, 2026)

PR #397 の `/simplify`（4 cleanup agent 並列: reuse/simplification/efficiency/altitude）で確定した cleanup を `orbit-vst3-host/src/lib.rs` に適用（sonnet5 委譲・単一ファイル 150+/166-）。

- **① RT alloc 除去（efficiency・最重要）**: `process_block` が毎ブロック `ParameterChanges::empty()`×2 + `EventList::empty()`×2（`ComWrapper::new`=Arc heap 確保）していた → `load()` で field 構築し再利用
- **② process context cache**: `IProcessContextRequirements` の毎ブロック COM query → `load()` で 1 回 query して flags を field cache
- **③ `run_process` helper 抽出**: `process_stereo`/`process_block` の `ProcessData` 組立重複を集約（3 agent 一致指摘）
- **④-⑥**: dead field `max_samples_per_block` + no-op Drop 除去 / `json_escape` per-char Vec 除去 / `probe_plugin` 4段ネスト平坦化
- **skip（follow-up/低価値）**: effect-child transport loop 共有化（merged clap crate に触れる）・CfString/CfUrl generic 化・test 信号式/extract_* prologue
- **検証（Opus 非サンドボックス）**: oracle sample-exact 両テスト PASS（挙動不変）+ **daemon gated 再実行で stale rate 改善**: C1 fresh 1129/1129(100%)・C3 [64f]&[32f] とも **stale_pct 0.000%（前 0.162%/0.105%）**。RT alloc 除去が実測で timing を締めた。fmt/clippy/deny clean

### 6.216 test(engine): VST3 Phase 1 daemon 経路 gated + フル arm64 sweep PASS（#381） (Jul 10, 2026)

Phase 1 の VST3 を **① production daemon 経路（supervisor/pipelined/respawn/RT）** と **② 全 arm64 プラグイン machinery** の 2 面で実機検証。offline smoke（6.215）が「child+transport が実プラグインを生き延びるか」を、本項が「production driver 層」と「全体カバレッジ」を担う（advisor が B/C は役割分担と判定・step-back 無し）。

- **順序判断（advisor/Fable）**: 「daemon で全 sweep 1 回」案は `outproc_effect_gated.rs` が device 束縛＋実時間＋parity assert 非汎用の三重で非現実的 → **B（offline 全 sweep・純計算）→ C（daemon を代表数個）** が最適・手戻り無しと確定
- **C = daemon 経路 gated（`orbit-audio-daemon/tests/outproc_effect_vst3_gated.rs`・新規・feature `outproc-effect`・全 #[ignore]）**: CLAP 版 `outproc_effect_gated.rs` を VST3 にミラー。production コード無改変（`PluginFormat::Vst3`/`ORBIT_EFFECT_FORMAT` は Phase 1 実装済み）
  - **C1 parity**（VST3 gain oracle gain=1.0）: ratio **1.00000**・fresh_delta 1117/1128・errors 0 → PASS
  - **C2 kill→respawn**: respawn 0→1・fresh after respawn 18→259・ratio 1.0 → PASS
  - **C3 stale-rate**: [64f] 0.162% / [32f] 0.000%・cb_max ~31µs（20ms 予算内）→ PASS
  - **C4 commercial smoke**（env `ORBIT_EFFECT_PLUGIN` 駆動）代表 4 effect: Guitar Rig 7 / Reaktor 6 / Ozone 11 / Vinyl すべて crash-free・respawn 0・errors 0 → PASS（Vinyl は ratio 1.033 で実 DSP 着色が可視・Reaktor は patch 未ロードで無音=想定内）
  - **warm-up fix**: C1/C2 の固定 sleep（CLAP から verbatim の 800/600ms）は VST3 の CFBundle load latency に不足し fresh=0 で false-fail → **wait-until-productive ポーリング + delta 測定**に修正（post-respawn の同根欠陥も修正・test-only・production 無改変）
- **B = フル arm64 sweep（offline・非サンドボックス・914.5s・333プラグイン）**: **Effect PASS 271 + Instrument PASS 49 = 320 PASS・genuine crash 0**
  - Crash 分類 10 = すべて **probe 20s timeout hang**（実 crash でない）。**120s 再 probe で決着**: UJAM Beatmaker `BM-*` 7 は `loaded:true/audio_in:0/audio_out:16` で**正常ロード（16-out instrument・sample content で 20s 超過しただけ）= 回復**。残 3（Komplete Kontrol=NI 全ライブラリ scan / USYNTH / Virtual Pianist=UJAM 大量 content）は >120s の激重 load で、**いずれも instrument（Phase 1 effect スコープ外・Phase 3 の async load 課題）**
  - Skip 3 = Intel-only（MODO BASS / Philharmonik 2 / Super 8）を arm64 フィルタが正しく除外
  - **確定カバレッジ**: arm64 **Effect 271 全 PASS・genuine crash 0**（Phase 1 スコープ実質 100%）/ Instrument 49+回復7=56 ロード可・3 は分単位 load の host-wrapper/巨大音源
- **役割**: 計画/順序判断=Opus（advisor 経由）/ C 実装+warm-up fix=sonnet5 委譲 / 実機計測（C1-C4 + フル sweep）=Opus 非サンドボックス
- **残**: 10 slow-loader の long-timeout 再 probe（owner 判断）・PR 化（/simplify + pr-review-team・トークン都合で延期中）

### 6.215 test(engine): VST3 Phase 1 gated 実機検証ハーネス + curated smoke PASS（#381） (Jul 10, 2026)

Phase 1 の OOP effect 経路を **実市販プラグイン（NI/iZotope arm64）** に通す gated 検証ハーネスを実装し、curated 代表セットで非サンドボックス実測 PASS。合成 oracle（sample-exact 済）に対し、実プラグインは closed-form が無いため **machinery smoke**（load/process/isolation が crash 0 で生き延びるか）に限定。musical DSP correctness は owner listening の follow-on として分離（誠実な wording をコメント/サマリに明記）。

- **設計ゲート = advisor(Fable) + adversarial-review(codex) の 2 レビュー**を実装前に通した。主要指摘を反映:
  - **dry-passthrough 誤 PASS の穴**（process() 失敗時に child が入力を素通し→出力=入力で有限値になり従来の出力検査を誤 PASS）→ child 統計を露出して `process_errors==0` と `processed==期待ブロック数` を assert
  - **timeout に plugin load 時間が食い込む**（初回ブロックは load を含む）→ 初回だけ長い deadline
  - **分類は out-of-process**（instrument crash が effect ゲートに混入しない）→ 既存 `vst3_probe` の JSON `audio_in` で分類
- **A（`orbit-audio-sandbox/offline.rs`・既存非破壊で追加）**: `render_through_child_sync_with_options(..., RenderOptions{first_block_timeout, block_timeout}) -> (Vec<f32>, ChildStats{processed, process_errors})`。既存 4 引数 `render_through_child_sync` は既定 opts の薄いラッパ（6 caller 非破壊）。stats は最終 `seq_done` Acquire 後・QUIT 前に読む（happens-before: child は fetch_add を seq_done Release より前に実行）
- **B（`orbit-vst3-effect-child/tests/real_plugin_gated.rs`・#[ignore]）**: `vst3_probe`（別プロセス・20s timeout・std のみ）で分類 → **effect(audio_in>0)=ゲート / instrument(audio_in=0)=informational / probe crash・load-fail=surfaced 非 gating**。effect は sine を block[64,128]で駆動し crash 無し・process_errors 0・processed 一致・有限・abs≤8 を要求。loaded effect がゲートを破った時のみ panic。plugin 選択は env（`ORBIT_GATED_VST3_PLUGINS` / `_DIR` / `_ALL` / `_MAX`）+ curated 既定
- **実測（Opus・非サンドボックス・curated 11個・34.5s）**: effect 8（Reaktor 6/Guitar Rig 7/Ozone 11/Neutron 5/RX 11 Voice De-noise/Nectar 4/Vinyl/Relay）全 PASS・**process_errors 0**、instrument 3（Kontakt 8/Massive X/FM8）informational PASS・crash 0。objc duplicate-class / qt.qml ログはプラグイン自身の良性警告で実 crash 0
- **役割**: 計画確定=Opus（orchestrator）/ A レビュー+B 実装+全ゲート検証=sonnet5 委譲 / 実機計測=Opus 非サンドボックス。fmt/clippy/build/非gatedテスト/deny すべて clean
- **残**: daemon 経路（`ORBIT_EFFECT_FORMAT=vst3` の supervisor/pipelined/respawn/stale）の gated は別途（C・adversarial-review が「手離れ」に必須と判定）。フル sweep（`ORBIT_GATED_VST3_ALL=1`）は owner 判断

### 6.214 feat(engine): VST3 Phase 1 — production OOP effect（daemon 統合）（#381） (Jul 8, 2026)

in-process 実証済み VST3 host を daemon の out-of-process サブストレート（crash 隔離・respawn）に載せた。CLAP effect child と対称。codex 実装・Opus 非サンドボックス検証。

- **`orbit-vst3-effect-child`（新）**: `orbit-clap-effect-child` の transport loop 対称コピー・処理部のみ `Vst3EffectProcessor::process_block` に差し替え・clack 非リンク。CLI（--shm/--plugin/--plugin-id/--sample-rate）と protocol は同一
- **`Vst3EffectProcessor::process_block`（追加）**: interleaved stereo を planar scratch 経由で VST3 process()・bus 判定で overwrite(effect)/add-mix(instrument)。setProcessing kNotImplemented 許容・setBusArrangements advisory は維持
- **daemon supervisor 汎化**: `OutProcEffectConfig` に `PluginFormat{Clap,Vst3}`・`from_env` が `ORBIT_EFFECT_FORMAT`（既定 clap で後方互換）で child_exe 選択。spawn/watchdog/respawn は無改変
- **検証（Opus・非サンドボックス）**: offline oracle parity `vst3_gain_oracle_oop_child_is_sample_exact_passthrough` PASS（共有メモリ経由 OOP child で sample-exact）+ in-process closed-form PASS。CLAP 非退行（child 4 + supervisor 9 tests）。fmt/clippy/deny clean
- gated 実機 harness（`real_plugin_gated.rs`・#[ignore]）は owner 同席・トークン回復後に Opus が非サンドボックス実行
- レビュー（/simplify + pr-review-team）はトークン都合でマージ前に延期実施

### 6.213 docs(engine): プラグインホスト実装ノウハウ（VST3/AU/CLAP 共通責務）（#381） (Jul 8, 2026)

owner 要望（AU/CLAP 混在の将来価値）で、VST3 Phase 0 の実証知見を format 共通のホスト責務として一般化。`docs/development/POST_2.0_PLUGIN_HOST_KNOWHOW.md`。

- **中核原則**: 商用ホストは optional/advisory メソッドの非 OK 戻り（kNotImplemented/kResultFalse）を致命扱いにしない（VST3 SDK/JUCE 準拠）
- **責務対応表**: モジュールロード / host context / component-controller 接続 / I/O バス調停 / 非OK戻り許容 / process データ完全性 / teardown を **VST3（実証）↔ AU（推論）↔ CLAP（orbit-clap-host 一部裏取り）** で対応づけ
- VST3 の 4 修正を一次事実として記録 + 計測ノウハウ（サンドボックス水増し・1 plugin 1 process・arch 除外）+ Phase 1+ 申し送り（厳密 buffer 整合・instrument 経路）
- エビデンス強度を明記（VST3=実測 / AU=推論 / CLAP=一部裏取り）

### 6.212 fix(engine): VST3 setBusArrangements advisory 化 — arm64 端 2 も解決（#381） (Jul 8, 2026)

arm64 の残 2 エッジケースを解消し、arm64 商用 VST3 を実質全カバー。

- **Komplete Kontrol = 実は既に loaded**（instrument・audio_in 0/out 16）。「fail」は sweep 分類の綾（Phase 0 が instrument を process しないだけ）＝真の失敗でない
- **ARIA Player = `setBusArrangements failed: 1`(kResultFalse) で hard-fail**。research どおり setBusArrangements は advisory（JUCE も致命扱いしない・プラグイン既定 arrangement で動作）→ **最終失敗を非致命化**（1 行相当・plugin 既定 arrangement で続行・厳密 buffer 整合は Phase 1）
- **実測（Opus・非サンドボックス）**: ARIA Player = loaded:true（instrument）。回帰なし（Ozone/Reaktor 継続）。clippy/deny clean
- kNotImplemented(6.211)・setBusArrangements(本件) いずれも「商用 host は optional/advisory メソッドの非 OK 戻りを致命にしない」という同一教訓

### 6.211 fix(engine): VST3 setProcessing kNotImplemented 許容 — iZotope 全回復（#381） (Jul 8, 2026)

`/ask-codex:research` → 1 行修正で iZotope クラッシュ… ではなく fail を解消。

- **research 発見**: `setProcessing` の戻り `3` = **`kNotImplemented`**（vst3-rs tresult: OK=0/False=1/InvalidArg=2/NotImplemented=3）。iZotope は setProcessing 未実装で kNotImplemented を返すだけ＝**VST3 的に合法**。JUCE も非致命扱い。ホストの `is_ok()` が 3 を hard error にしていたのが唯一のバグ（iZotope は壊れていない）
- **修正（Opus・1 行）**: `setProcessing` 結果が `kNotImplemented` ならロード失敗にしない
- **実測（Opus・非サンドボックス）**: Vinyl/Ozone 11/RX 11/Neutron 5/Vocal Doubler/Relay = **全て load+process 成功**。NI 回帰なし（Bite/Reaktor 6 継続）
- **到達点**: crash 0・NI 回復・iZotope 回復 → arm64 ほぼ全カバー（残=Intel-only 3個のみ）。教訓=商用 host は optional メソッドの kNotImplemented を成功扱いに（SDK/JUCE 準拠）
- 全 sweep 最終数値は継続実測

### 6.210 feat(engine): VST3 CFBundle load path — NI 全回復・iZotope は残課題（#381） (Jul 8, 2026)

`/ask-codex:research`（一次調査）→ codex:rescue 実装で NI クラッシュを解消。

- **research 発見**: NI SIGSEGV の主因 = `BundleEntry(ptr::null_mut())`（NI ランタイムが CFBundleRef から resources/frameworks/license path を解決するため null deref）。前回 de-risk が効かなかった真因
- **実装（codex）**: macOS bundle ロードを CFBundle 正規経路に（CFBundleCreate→LoadExecutable→GetFunctionPointerForName・**実 CFBundleRef を BundleEntry に渡す**）+ component-controller ハンドシェイク（controller 生成/initialize/setComponentHandler/IConnectionPoint connect/state 同期）+ process データ完全化（空 IEventList/IParameterChanges/ProcessContext/canProcessSampleSize）。`core-foundation-sys 0.8`（MIT/Apache・allow list 内）採用・`libloading` 除去。oracle sample-exact 維持・fmt/clippy/deny green（codex 報告）
- **実測（Opus・非サンドボックス・代表）**: **NI 7/7 が crash→load 成功**（Battery 4/FM8/Massive/Kontakt 8=instrument load・Reaktor 6/Guitar Rig 7/Bite=effect load+process）。owner 最重要 Kontakt/Massive/FM8 が動く。**iZotope は setProcessing:3 のまま未解決**（Vinyl/Ozone/RX/Neutron・別要因＝bus 再調停詳細 or objc 衝突）
- 全 sweep の回復数は継続実測中。次 = iZotope root-cause + full sweep 数値

### 6.209 feat(engine): VST3 de-risk — host context + bus 調停は NI/iZotope を救わず（#381） (Jul 8, 2026)

owner 最重要ベンダー NI/iZotope 救済の de-risk（Phase 1 前倒し）を codex に委譲実装し Opus が非サンドボックス実測 → **効果なし**。

- **実装（codex・oracle 非退行）**: 最小 IHostApplication（getName + IMessage/IAttributeList createInstance）を `initialize` に渡す（null 廃止）+ bus arrangement 調停（getBusArrangement→setBusArrangements→activateBus・mono/stereo 既定）。oracle sample-exact 維持・fmt/clippy/deny green
- **実測（Opus・非サンドボックス）**: sweep BEFORE=AFTER 完全同一（188/109/36）。直接 probe でも NI（Battery 4/FM8/Massive）= SIG11 crash のまま・iZotope（Vinyl/Ozone 11）= `setProcessing:3` fail のまま
- **結論**: 「host context で NI・bus 調停で iZotope が直る」推定は**実証で否定**。両者は深い要因（NI=Native Access/ランタイム依存・iZotope=objc class 重複/特殊調停）を要し軽い拡張では解けない
- **arch 分類追加**: Intel-only（arm64 なし）= MODO BASS/Philharmonik 2/Super 8 は「アーキ非対応＝除外」（ホスト fail でない・Rosetta 終息前提で arm64-native 対象）
- de-risk コードは branch 保持（host context/bus 調停自体は Phase 1 で必要な正しい方向・非退行）。ノウハウ doc は「成功後」の owner 指示によりペンディング（task #4）

### 6.208 feat(engine): VST3 Phase 0-0b host spike — GO verdict (188/333 effects host) (#381) (Jul 8, 2026)

VST3 hosting Phase 0（#381）の 0b（手書き COM host spike）を codex に委譲し実装完了 → **GO 判定**。verdict doc = `docs/development/POST_2.0_VST3_STEP0_SPIKE.md`。

- **0b 実装（codex 委譲・独立検証済み）**: `orbit-vst3-host` に手書き COM host（dlopen→GetPluginFactory→IComponent→IAudioProcessor→setupProcessing→setActive→setProcessing→process→逆順 teardown・field 宣言順で drop 順確定・`getBusCount(kAudio,kInput)` で effect/instrument 判定）。追加 dep `libloading=0.8`（ISC・allow list 内）
- **① sample-exact PASS（独立再検証）**: gain oracle を param なし→恒等・param 0.5→`to_bits()` 厳密 bit-exact。skip なしで実 dylib ロード比較
- **② 実市販プラグイン ABI 適合 PASS（独立再検証・非サンドボックス）**: V-Pan / ARC 4 / AmpliTube 5 が load→process→drop 成功（processed:true・NaN/Inf/発散なし）。実 Steinberg-SDK 製プラグインで process() 実走 ⇒ binding ABI が実 SDK と適合（owner の「相互一貫的に間違い」懸念クリア）
- **compatibility sweep（実コレクション 333 個）**: 最小ホストで **effect 処理OK 188/333(56%)・load 成功 237/333(71%)**・instrument 49・host-limit fail 59・**genuine crash 36(11%)**・hang 0
- **🔴 サンドボックス汚染を発見・是正**: codex 初回 sweep はコマンドサンドボックス下で crash=220(66%) と誤出力（`/bin/ps` ブロック等でプラグイン init が SIGKILL → 偽 crash）。**非サンドボックスで再走 → 真の crash は 36（6倍水増しが解消）**。V-Pan/ARC 4/AmpliTube 5 は sandbox=crash → 非sandbox=PASS に反転。教訓: VST3 sweep はサンドボックス外で計測
- **genuine crash 36 = ほぼ全て Native Instruments**（Kontakt/Massive/FM8/Reaktor/Guitar Rig/Maschine/NI Solid・VC 系）→ 均一 ABI バグでなく NI ランタイムが host context 前提を要求と推定
- **Phase 1 作業項目を特定**: (1) null host context → 最小 IHostApplication 実装（crash 36 の主因・NI 回復の鍵）(2) bus arrangement 未調停（setBusArrangements/activateBus）→ host-limit 59 の主因（iZotope setProcessing:3）(3) 単一 stereo 固定の解消。いずれも Phase 0 gate 非該当（gate は代表実プラグインで通過）
- **独立検証**: fmt/clippy(`-D warnings`)/deny(licenses ok)/`cargo test -p orbit-vst3-host`（①② skip なし PASS）を Opus が再実行し全 green

### 6.207 feat(engine): VST3 Phase 0-0a license audit PASS + gain oracle scaffold (#381) (Jul 8, 2026)

VST3 hosting Phase 0（#381）の 0a（license 監査）を実行し PASS。0b（host spike）の sample-exact oracle をスキャフォールドした。

- **0a license 監査 PASS（STOP gate クリア）**: 新 crate `orbit-vst3-host` に `vst3 = "0.3"` を追加し `cargo tree` を実測 → 全 transitive 依存 = `vst3 v0.3.0` → `com-scrape-types v0.1.1` の 2 crate のみ（bindgen/clang-sys 系なし・plan の予測どおり）。両者とも `MIT OR Apache-2.0`（展開済み Cargo.toml source で一次裏取り・vst3 は LICENSE-APACHE/MIT 同梱）で deny.toml allow list 内。`cargo deny check licenses` = **licenses ok**。**deny.toml 書き換え不要**（STOP 条件の allow list 改変は発生せず）
- **oracle 発見 → SDK ビルド不要化**: 市販 VST3 は gain smoothing で block 1 が sample-exact にならず・マシンに VST3 SDK 無し、という制約だったが、`vst3` crate が**純 Rust の `examples/gain.rs`（`out = gain × in`・smoothing なし）を同梱**。これを vendored した crate `orbit-vst3-gain-oracle`（cdylib）を作成 → `package-oracle.sh` で macOS `.vst3` バンドル（`target/vst3-fixtures/GainOracle.vst3`・gitignore 下）に生成。`GetPluginFactory`/`BundleEntry` エクスポート確認済み。**既知挙動を我々が持つ oracle**（binary は commit しない・script で再現）
- **spec 強化（owner レビュー反映・spec-first）**: Phase 0 受け入れ基準を **2 系統**に書き換え。① sample-exact oracle（自作 gain・data-path 意味論）+ ② **実市販プラグイン load-bearing**（ABI 適合）。🔴 理由 = Rust プラグイン ↔ Rust ホストは同じ `vst3` crate の ABI 解釈を共有 → **相互に一貫して間違っていても ① は PASS しうる**。② が実 Steinberg SDK 製プラグインとの適合を担保。さらに **compatibility sweep**（`/Library/Audio/Plug-Ins/VST3/` 全 VST3 を best-effort で load→process→drop し pass/fail/crash/hang マトリクスを診断出力・gate ではない）を追加。★北極星 = 市販 VST3 コレクション全体の互換性（owner「最終的には全部試す」）
- **残**: 0b host spike（手書き COM で load→process→drop・`orbit-clap-host` 対称）= codex 委譲予定。① sample-exact + ② 実プラグイン + sweep + verdict doc（`POST_2.0_VST3_STEP0_SPIKE.md`）で Phase 0 完了条件

### 6.206 docs(engine): VST3 hosting implementation plan — effect + instrument, symmetric to CLAP (#395) (Jul 8, 2026)

VST3 プラグインホスティングの実装計画 doc（`docs/development/POST_2.0_VST3_HOSTING_PLAN.md`）を起こした。owner 意図の核心 =「**音源系プラグインとエフェクト系プラグインの両カテゴリをホスト**」（VST3/CLAP 併用ではない）・VST3 主眼・既存 CLAP 資産と対称。実装は `/codex:rescue` 委譲前提で、codex が会話文脈なしで迷わない粒度（各 Phase を実在ファイルの path:line → 手順 → offline 優先の受け入れ基準 → STOP gate で記述）。

- **一次確認**: VST3 SDK = MIT 単独（3.8 以降）/ `vst3` crate = MIT OR Apache-2.0（v0.3.0 で binding source 同梱・libclang 依存消滅）→ permissive 規律（deny.toml allow list）と整合。#381 Step0 の STOP 条件には非該当
- **既存 CLAP 資産の実ファイルアンカー確認**: `PostProcessor` trait（共通 seam）/ effect・instrument 分岐 = `processor.rs:133 has_audio_input()` / OOP transport `orbit-audio-sandbox`（CLAP 非依存・**VST3 で無改変流用可**）/ `orbit-clap-effect-child`（child 対称元）/ daemon supervisor `OutProcEffectConfig::from_env`
- **段階化（advisor 検証済み・effect と instrument の準備状態を平坦化しない）**: Phase 0 = in-proc offline spike（#381・🛑 dep-tree license 監査 + sample-exact 1 block）→ Phase 1 = production OOP effect（M1 substrate 流用・codex-ready）→ **Phase 2 = M2 instrument IPC 設計（🔴 Opus+owner の spec 作業・codex 委譲禁止・format-neutral 決定を保持）**→ Phase 3 = VST3 instrument（M2 landing 後）
- **技術チェック 2 点を明記**: (1) `vst3` の全 transitive 依存を `cargo tree` で実監査（推測禁止）(2) effect/instrument 判定は CLAP の `has_audio_input` でなく **VST3 bus count**（取り違えると silent-but-wrong）
- **DSL は non-blocking**: engine は CLI/env 駆動で完結（既存 CLAP も env のみ）。構文 3 案提示 + 推奨（Option C 当面据え置き → effect 動作後に Option A verb スタイルを owner 確定）
- **owner レビュー反映（framing 訂正）**: §1 を「CLAP/VST3/AU を**同じパイプラインで併用**する engine」へ書き直し。effect は insert = **混在フォーマットの直列チェーン**（例 `AU → CLAP → VST3`）、instrument は per-format 単体。「VST3 主眼・CLAP と対称」= VST3 を最優先で追加する兄弟実装の意味（他 format を捨てない）と明記。CLAP は first-class（良質 OSS CLAP をバンドルしたい）。effect 多段チェーン化を design item として追記（現 substrate は単一 insert・Phase 1 は chain-ready に留める）
- **codex research で framing を evidence 裏取り（§8 追加）**: ①effect=直列 insert チェーン（Ableton/Bitwig/JUCE `AudioProcessorGraph`）②format 混在=architecturally 確認（REAPER が VST3/CLAP/AU ホスト・JUCE `AudioPluginInstance`／caveat: 混在順 verbatim 例は推論・**Bitwig は AU 非対応**）③**instrument framing 訂正**（source ノード・「1 track=1 instrument」は host 不変条件でない）④process 界面 format-neutral 確認 ⑤**I/O サーフェス完全カバーが必須**（audio bus multi-out/sidechain・note/MIDI in+out・CC・param・note expr/MPE/MIDI2 を宣言どおり honor・CLAP audio-ports/note-ports/params・VST3 getBusCount/setBusArrangements/IEventList/IParameterChanges・AU AUAudioUnit）。owner 要件「各プラグインの CC/MIDI/audio I/O を宣言どおりカバー」を #5 で裏取り → **Phase 2 M2 IPC を「full surface superset」と規定**（note-on/off に痩せさせない）+ audio transport は宣言 bus arrangement を honor（現 M1 単一 stereo sum は既知 gap）
- **Bitwig サンドボックス裏取り（owner「理想は Bitwig・プラグインは sandbox 化」）**: 一次ソース（bitwig.com learnings/support）で確認 = プラグインを **audio engine と別プロセスで sandbox**・crash 隔離 + `Reload Plug-in` 復帰・5 modes（Within Bitwig/Together/By Manufacturer/By Plug-in/Individually）・VST2.4/VST3/CLAP 全 OS ホスト・CLAP は Bitwig+u-he 共同開発。**OrbitScore の γ sandbox spike + M1 `EffectChildSupervisor`（out-of-process spawn/watchdog/respawn）は既にこの同型** → §1 に「アーキ北極星 = Bitwig 型 per-plugin サンドボックス」callout + §8 evidence rows 追加。VST3/AU 追加 = 同 substrate に child を足すだけ = 構造的に Bitwig に自然に寄る

### 6.205 fix(vscode-extension): pr-review-team round 1 — save_file headless-hang guard (#394) (Jul 8, 2026)

PR #394 の `/code:pr-review-team` round 1（4 専門レビュアー並列: code-reviewer ×2 / silent-failure-hunter / pr-test-analyzer / comment-analyzer）。**Critical=0**。**Important=1** + Minor 数件を対応。全 suite グリーン維持。

- **silent-failure（Important）**: `save_file` の `document.save()` が **untitled/no-path バッファでヘッドレス時に無限ハング**（"Save As" ダイアログ待ち）— ログも残らずエージェントには沈黙に見える（#392 の動機＝ヘッドレス live-jam 回収がまさにこの穴）。`doc.uri.scheme !== 'file'` ガードで早期に loud fail。加えて save 失敗（false 返却 / throw）を output channel にログ（`get_log` で可視化）+ `openFileForAgent` に倣い try/catch を追加
- **comment（Minor）**: `get_document_text` の description が `get_editor_state` のフィールド列挙で `language` を落としていた → 追加
- **test（Minor）**: gated E2E に **isDirty no-op 分岐**の検証を追加（clean な状態で2回目の `save_file` → `'no changes to save'` を確認）— このガードが存在する唯一の理由の novel logic を固定
- 据え置き（既知/pre-existing）: active-editor スコープの取り違えリスク（path 版は #392 で follow-on と明記済み）
- **既知の限界（durable 記録）**: scheme ガードは全ダイアログ経路を塞がない — file-scheme のドキュメントでも `save()` が **disk-conflict（ロード後にディスク側が変更）や上書き確認**で対話ダイアログにブロックし得る。timeout 未実装。現状の MCP tool 面（全編集が `open_file` → `edit_replace` 経由）では unreachable のため defer。tool 面拡張時に再評価（docstring にも明記）
- レビュアーは既存スラッシュコマンドの内蔵指定どおり Sonnet（comment-analyzer は Haiku）で起動・オーケストレーション/検品は Opus main。code-reviewer 2 体とも「16→18 ツール整合・Host allowlist 不変・sibling パターン準拠」を実機ビルド + 全 suite 実行で裏取り

### 6.204 feat(vscode-extension): MCP save_file / get_document_text — persist live-jam edits to disk (#392) (Jul 8, 2026)

#388 Agent Bridge の follow-on（#392）。MCP `edit_replace` はエディタバッファのみを書き換えディスク保存しない（auto-save もオフ）ため、ライブセッション終了後に演奏された最終状態のファイルを agent が回収できなかった（2026-07-07 の live jam では osascript Cmd+S で救出＝Accessibility 権限依存で headless 不可）。エディタ配管ツール2本を追加:

- **`save_file`**: アクティブドキュメントを `document.save()` で保存。`isDirty` ガードで分岐（未変更なら no-op で ok・保存 fsPath を message に）— `document.save()` が clean 時に false を返すか true を返すかの曖昧さを無害化。dirty で save が false のときだけ error
- **`get_document_text`**: アクティブドキュメントの全文を構造化して返す（`{ path, text }`・no-editor 時は両 null）。既存 `get_editor_state` は path/cursor/selection/lineCount/isDirty のみで本文が取れず、`edit_replace` 適用確認・diff 検証に使えなかった問題を解消
- 両ツールとも **active-editor 限定**（既存 `edit_replace`/`get_editor_state` と一貫）。issue の「(or path 指定)」版は今回作らず follow-on 扱い
- 配線: `mcp-server.ts`（`DocumentText` 型 + `OrbitScoreToolHandlers` + `buildServer` 登録）、`extension.ts`（`saveFileForAgent`/`getDocumentTextForAgent` + handlers）。error 封筒は `toToolResult`、snapshot は `get_editor_state` と同型の inline JSON を再利用（新規ヘルパー無し）
- テスト: stub suite を 16→18 ツールに更新 + `get_document_text` round-trip 1本追加。gated E2E に「`edit_replace` 後の buffer を `get_document_text` で確認 → `save_file` → ディスク上の内容に置換が反映されていることを検証」ステップを追加
- **spec**: WCTM_SYSTEM_SPEC §3.1 は WCTM 演奏ランタイムの概念的ツール例（`get_performance_features`/`evaluate_orbitscore`/`get_session_tail`）で拡張ホスト側の現行ツールを網羅列挙していないため、エディタ配管ツール追加に spec-first 更新は不要と判断
- 実装は Sonnet 委譲、計画・検品は main（Opus）。ビルド + 全 suite 1281 passed / 29 skipped（回帰なし）+ lint clean + gated E2E クリーンにスキップ確認
- **/simplify**（4 観点並列）: reuse/simplification/efficiency = 変更なし。**altitude 1件を適用** — gated E2E が tracked fixture（`kick_loop.orbs`）を直接開いて `save_file` で上書きし `afterAll` の `writeFileSync` で restore する band-aid だった → 既存 `tmpRoot` scratch dir にコピーして開く方式へ（basename 保持で path 断定 assertion は維持）。capture + restore ブロックを削除し「プロセスクラッシュ / restore 失敗で tracked file が dirty のまま残る」リスククラスを構造的に解消（net LOC 減）

### 6.203 docs: pr-review-team round 2 convergence record (#393) (Jul 8, 2026)

round 2 = 独立検証 2 体（fix 検証 + regression sweep）で **Critical=0 / Important=0 を裏取り**し収束。両者が round 1 の全 5 修正を RESOLVED 判定（Host 検証は正規クライアント通過をテストで確認・anchorFit 遷移ログはエッジのみ発火・armDelay の代数を手計算とテスト双方で検証・tempo 変更テストの 1500 境界も再導出で一致）。唯一の Minor（palette 経路が write 失敗時も flash する）を `cd08d5d` で修正（不達時は警告ログのみで早期 return）。最終 CI 4 チェック全 pass・全 suite 1280 passed。マージは owner 指示待ち。

### 6.202 fix: pr-review-team round 1 — DNS-rebinding guard, observability, contract tests (#393) (Jul 8, 2026)

/code:pr-review-team round 1（4 専門レビュアー並列: code-reviewer / silent-failure-hunter / pr-test-analyzer / comment-analyzer・計 Critical 3 / Important 9）への対応。全 suite 1280 passed（+12 テスト）。

- **DNS rebinding 保護**（code-reviewer Important）: MCP サーバーは 127.0.0.1 bind だが Host 検証が無く、rebind したドメインからの same-origin fetch で全ツール面が到達可能だった → `handleHttp` 冒頭に loopback Host 許可リスト（`127.0.0.1/localhost/[::1]:<port>` 完全一致）+ 403 + テスト。SDK の `allowedHosts` は deprecated（外部層推奨）のため自前実装
- **anchorFit 劣化の可視化**（silent-failure Critical）: 回帰フィット棄却で `daemonNowSec` が #389 修正前の単一 anchor 推定へ静かに落ちる → 遷移端（劣化/復帰）で warn/log（boot 直後の初回 fit 成立は抑制）
- **evaluate の盲目 ok**（silent-failure Critical）: `writeCodeToEngine` が boolean を返すようになり、engine 死後の stdin 不達で `evaluate_orbitscore` が `ok:false` を返す + no-op 時は Output に警告。「ok = stdin 到達まで（パース/発音は別）」の契約をコメントで明文化。engine 側 ack は既録の follow-on（WORK_LOG 6.189）のまま
- **MCP teardown の握り潰し**（silent-failure Important）: dispose 時の transport/server close 失敗を log へ
- **lag キャッチアップの可視化**（silent-failure Important）: OS sleep/GC stall 後の zero-delay 連射（+ 下流 drift guard による bar 落ち）が無痕跡だった → `armDelay` が大幅遅延（> patternDuration）を 1 episode 1 回 warn。**lead は `min(LOOP_TIMER_LEAD_MS, patternDuration/2)` に短縮**（sub-lead パターンの恒常 zero-delay 連射を防止・code-reviewer Minor）
- **テスト増強**（pr-test-analyzer Critical/Important）: `fitAnchorSamples` を export し直接単体 5 本（2点補間/量子化ノイズ平均化/汚染窓 slope 棄却/退化分散/n<2）— 本番ホットパスの数値ロジックがテストのダークパスだった問題の解消。+ tempo 変更時の grid 再アンカー / sub-lead floor / `register_mcp_server` の条件付き登録 + args round-trip / argPath の scoped・pitch・modified
- **コメント是正**（comment-analyzer Important ×3）: ①「AUDIBLE time」→「grid time（実音は一様に ~50ms lookahead 後・シーケンス間で整合）」に 3 ファイル修正 ② stateless 500 の帰属を分離（SDK の 400 と自前 catch-all の 500）③ `findPlayArgRangeForPath` の null 契約に malformed パスを明記

### 6.201 refactor: /simplify cleanups for PR #393 (Jul 8, 2026)

PR #393 の /simplify（4 観点並列レビュー: reuse/simplification/efficiency/altitude）の指摘 6 件を適用。全 suite 1268 passed 維持。

- **efficiency（最重要）**: `daemonNowSec()` が dispatch 毎に O(30) の最小二乗フィットを再計算していた → フィットは窓が変わる `onStreamStats`（1Hz）で一度だけ計算し `anchorFit` にキャッシュ、`daemonNowSec()` は O(1) 評価に（`fitAnchorSamples` 純関数へ抽出・respawn 時は fit も破棄）
- **efficiency**: stdout チャンクの `split('\n')` 二重実行を 1 回に統合（`filterStdout` は唯一の caller に畳んで削除）
- **reuse/simplification**: mcp-server.ts の error 封筒を `errorResult()` に一本化（evaluate_orbitscore は `toToolResult` 直呼び・inline 重複 5 箇所を解消）
- **simplification**: flashLines の死んだ中間変数（`isWholeLine`/`range`）をインライン化 / loop-sequence の arm delay 式を `armDelay(boundary)` closure に集約（2 箇所の式が乖離しない）
- **altitude**: `[STEP]` marker の**クロスパッケージ契約テスト**追加 — 実 emit 行を extension 側 `parseStepLine` に往復させ、emitter 書式のドリフトをテストで検出（rust-engine-player.spec）
- skip（レビュー agent 自身が defer 妥当と判定）: playhead の文法スキャナの parser 統合（degrade 設計で被害有界・MVP 妥当）/ STEP イベントの MCP 公開（#392 系 follow-on の設計ノート）

### 6.200 docs(sessions): record first Claude live-coding jam — MLTS 5-minute set (#388) (Jul 7, 2026)

`sessions/claude/20260707-mlts-live-jam/` を新設し、Claude が Agent Bridge MCP 経由で OrbitStudio を駆動した初のライブコーディングセッション（owner 同席・実況付き）を保存。`live_jam.orbs`（演奏された最終バッファ・6 メーター 3/4〜11/8・8 時間スケール・4 階層ネスト・tempo 132）+ `playhead_check.orbs` + README（セット構成表・MLTS の道具立て・運用の学び）。

- 学び①: `LOOP(a, b)` は**グループ宣言**（列挙外 seq は自動停止）— 単発 LOOP(x) の積み重ねはレイヤー追加にならない（序盤に誤用・owner 指摘で修正）
- 学び②: MCP `edit_replace` は**バッファ編集のみでディスク保存しない** — 記録は osascript Cmd+S で救出。`save_file`/`get_document_text` ツールを #388 follow-on として issue 化
- 同日完成の playhead #390（per-seq 色・ネスト点灯）と #389 ヨレ修正の実地デモを兼ねた

### 6.199 chore: commit .mcp.json — Claude Code ↔ OrbitStudio MCP wiring (#388) (Jul 7, 2026)

`register_mcp_server`（#388）が生成する `.mcp.json`（`http://127.0.0.1:39123/mcp` への HTTP ポインタのみ・秘密情報なし）を owner 判断でリポジトリにコミット。新しい Claude Code セッションが `mcp__orbitscore__*` ツールを最初から掴めるようになる。前提 = OrbitStudio が `ORBITSCORE_MCP_PORT=39123` で起動していること（未起動時は接続失敗するだけで無害）。

### 6.198 fix(engine): sawtooth timing jitter — grid-anchored loop timer + anchor regression (#389) (Jul 7, 2026)

#389 の 2 機構（issue コメントの調査で確定済み）を両方修正。**受け入れ基準（120bpm kick 四分 LOOP を 2 分以上・サンプル精度解析で mean|dev| < 1ms・のこぎり波消失）を達成**: 150 秒 capture 実測で **mean|dev| = 0.52ms / max|dev| = 2.0ms / std 0.80ms**（fix 前は同一測定で稼働 126-156s 帯 mean 8.35ms / max 18ms・外挿で無限成長）。beat0 の単調成長・2 小節周期 ±5.3ms 段差ともに消失（全 298 onset が ±2ms 帯・トレンドなし）。

- **機構 A: LOOP タイマーのグリッドアンカー化 + lead 発火**（`loop-sequence.ts`）: 非アンカー型 `setTimeout(patternDuration)` 再アームは発火遅れが単調蓄積（実測 +0.19ms/小節・約 90 分で崩壊水準）し、小節頭イベントが「enqueue 時点で過去」→ 即時 dispatch で小節頭だけ遅れる構造だった。修正: 再アーム delay を絶対 grid からの逆算（`nextScheduleTime + patternDuration − LOOP_TIMER_LEAD_MS − now`）にし、境界の **100ms 前**に発火して次小節を future に enqueue（1ms poll が grid どおり dispatch）。mute 中は nextScheduleTime が意図的に stale なので素の patternDuration 待ち（負 delay ホットループ回避）。tempo/beat/length 変更・quantize・unmute 再baseline の意味論は不変。
- **機構 B: anchor の最小二乗回帰**（`rust-engine-player.ts`）: StreamStats の `now_sec` は `cursor_frames/sample_rate` でブロック長（512f ≈ 10.67ms）に下方向量子化されており、単一 last-wins anchor だと 1Hz tick とブロック位相のうなり（4 tick = 2 小節周期）がそのまま発音時刻に転写されていた。修正: 直近 30 サンプル（≈30 秒窓）の `(tsMs, daemonSec)` に LSQ フィット（`daemonNowSec()` が傾き+切片で推定・量子化ノイズは平均化で ~0.6ms 級・wall↔device のレート差も傾きで吸収）。窓 <2 / 傾き異常（[0.95, 1.05] 外）は従来推定へフォールバック。respawn 時は establishSession が窓を破棄（新旧 daemon の transport を混ぜない）。フィット直線の定数バイアス（~半ブロック）は grid 安定性に無害（lookahead 50ms 内）。
- **テスト**: `loop-sequence-resilience.spec.ts` に fake-timer 2 本（lead 発火 + baseTime grid 維持 / 30ms コールバック lag が翌 delay 970ms で吸収され境界位相不変）。全 suite 1268 passed。実測系（capture + onset 解析）は session scratchpad の `jitter_repro_driver.js` / `deviation_series.js` / `analyze_wav_fine.js` で再現可能。

### 6.197 feat(vscode-extension): nested playhead resolution + drop playheadSeqColors setting (#390) (Jul 7, 2026)

6.196 の nested argPath を extension 側で解決し、`(1, 1)` 内部の各要素を個別点灯させる。owner 目視確認済み（2026-07-07・drum.play(1, (1, 1), 1, 1) でネスト内半拍点灯 + hat 従来どおり・「めちゃくちゃループがわかりやすくなった」）。

- **`findPlayArgRangeForPath(text, seq, "1.0")`（playhead.ts 新規）**: dot パスを段階的に降りて該当要素の文字範囲を返す。降下は「要素全体を占める時分割グループ `( )` / `{ }`」のみ（stack `[ ]` は 1 視覚単位・`(A)(B).oct(1)` のようなグループ連なり/チェーンは close 位置チェックで降りない）。**graceful degradation**: 深い segment が解決できなければ解決できた最深の祖先範囲を返し、トップレベル index 切れのみ null（誤った引数を光らせない）。既存 `findPlayArgRanges` と分割コアを `splitGroupElements`（閉じ括弧 index 付き）に共有化。
- **extension.ts**: `showPlayheadStep` を topIndex 方式からパス解決に置換。
- **`orbitscore.playheadSeqColors` 設定を削除（owner 判断）**: per-seq 色の固定は DSL 機能 `seq.color()`（#391）として実現予定で、settings 面は不要になるため。当面は palette の first-come 使い回し。`colorForSeq` の seqColors override seam は #391 が食わせる口として温存（純関数・テスト維持）。
- テスト: playhead.spec.ts に findPlayArgRangeForPath 7 本追加。全 suite 1266 passed。

### 6.196 feat(engine): nested argPath — dot paths tagged inside the timing walk (#390) (Jul 7, 2026)

`[STEP]` marker の argPath をトップレベル index からフルパス（"1.0" = 第2引数グループ内の第1要素）に拡張。owner 要望「ネストが気になる」対応。

- **タグ付けを walk 内へ移動**: 6.194 の後付け `floor(startTime/slotDuration)` 方式を廃止し、`calculateEventTiming` に `argPathPrefix` を追加 — 各再帰が自要素 index を積む（timing 計算は無変更・observational のまま）。nested / legato / scoped / modified-nested は降下、number / pitch / tie / 休符 leaf はフルパス付与。
- **stack `[...]` は 1 視覚単位**: 全 voice（subdivide する voice subtree 含む）に stack 自身の slot パスを付与 — singleton 再帰が作る ".0" は voice のテキスト位置と対応しないため。
- テスト: `tests/timing/arg-path.spec.ts` 新規 7 本（flat/nested/二重 nested/休符/stack/legato/tie）+ timing-calculator.spec の toEqual 期待値に argPath を追記。

### 6.195 feat(vscode-extension): live playhead highlight — per-seq vivid colors, rest steps, agent selection collapse (#390) (Jul 7, 2026)

engine の `[STEP]` marker（6.194）を消費して、再生中の `<seq>.play(...)` の**発音中引数をリアルタイムにハイライト**する live playhead の MVP。owner 目視確認 3 ラウンド（初版→ビビッド化→休符対応）を MCP 駆動（`playhead_visual_drive.js`・node driver）+ AskUserQuestion で回して収束。

- **`src/playhead.ts`（新規・vscode 非依存の純ヘルパー）**: ① `parseStepLine` — `[STEP] <seq> <argPath> <atEpochMs>` の厳密パース ② `findPlayArgRanges` — 文書テキストから最初の `<seq>.play(...)` のトップレベル引数の文字オフセット範囲を抽出（ネスト `()[]{}` 内のカンマは分割しない・境界ガードで `mydrum.play`/`foo.drum.play` を誤マッチしない）③ `PLAYHEAD_PALETTE`（32色）+ `colorForSeq`/`normalizeHexColor`/`paletteIndexForSeq` — 色解決。
- **`extension.ts` 配線**: `setupStdoutHandler` が RAW stream から `[STEP]` をパース（Output channel へは `shouldFilterLine` で非表示）→ `atEpochMs` まで delay（dispatch は lookahead 先行のため）→ 対象引数を decoration。`⏹ <seq>`（seq 停止）/`✅ Global stopped`/engine 停止・exit/deactivate でクリア。
- **per-seq ビビッドカラー（owner 要望）**: 初版の theme find-match 色は「薄すぎ・選択に埋もれる」→ 50% alpha 塗り + 実線ボーダーの高彩度色に変更。色は「解決済み色文字列ごとに 1 decoration type」を lazy 生成し、seq には first-come 序数 `% palette.length` で割り当て（palette 長変更に耐性）。
- **32色パレット（owner 要望）**: 東京メトロ・都営の路線色 13 + JR 東日本線区色 + Kelly/Green-Armytage 系の高識別色で 32 色。隣接割り当てが色相で離れるよう並べ替え済み。
- **ユーザー設定**: `orbitscore.playheadPalette`（配列・color-hex → 設定 UI/settings.json でスウォッチ+ピッカー）と `orbitscore.playheadSeqColors`（seq名→色の固定マップ・palette より優先・スロット消費なし）。`onDidChangeConfiguration` で decoration type を破棄→再生成（リロード不要で反映）。package.json の default と `PLAYHEAD_PALETTE` の同期はテストで強制。
- **agent 選択の畳み込み（owner 要望）**: MCP `run_selection` 実行後に selection を active 端へ collapse — set_selection の残存選択が playhead を覆い隠す問題の解消。人間のパレット/キーバインド実行は従来挙動のまま。
- **テスト**: `tests/vscode-extension/playhead.spec.ts` 27 本（パース/範囲抽出/色解決/palette 同期）。全 suite 1253 passed。
- **owner 目視確認済み（2026-07-07）**: 2 seq 同時（drum=丸ノ内線レッド・hat=東西線スカイブルー）で独立巡回・休符 0 も点灯・選択自動解除。
- 残（follow-on 候補）: ネスト subdivision のハイライト（argPath "1.0" は文法予約済み）/ DSL 内カラー指定（`seq.color("#…")` + DocumentColorProvider で .orbs 内カラーピッカー — owner 発案・DSL 仕様側の設計が必要）/ 同名 seq の複数 play() 呼び出し（現状 first-match）。

### 6.194 feat(engine): [STEP] playhead markers — argPath threading + rest marker events (#390) (Jul 7, 2026)

live playhead（6.195）の engine 側。dispatch 済み play イベントを `[STEP] <seqName> <argPath> <atEpochMs>` として stdout へ発行する（emission-only — timing/音響への影響ゼロ）。

- **argPath threading**: `TempoManager.calculateEventTiming` の後段で各 TimedEvent に由来 play() 引数のトップレベル index を付与（bar 等分の `floor(startTime/slotDuration)` で復元・timing walk 本体は無変更）。`Scheduler.scheduleEvent/scheduleSliceEvent` に optional 引数として貫通。
- **RustEnginePlayer**: dispatch（daemon `PlayAt`）成功後に `emitStepMarker` — epoch は「発音予定時刻」（`startTime + play.time`・dispatch は lookahead 先行のため extension 側が遅延表示）。
- **休符 (0) も巡回（owner 要望「0も選択していいのでは？無音を処理してるわけだし」）**: event-scheduler は従来 `sliceNumber > 0` のみ schedule（"0 is silence"）→ 休符スロットは optional の `scheduler.scheduleStepMarker?.(time, seq, argPath, gainDb)` で **marker-only イベント**として enqueue。daemon への dispatch なし・`[STEP]` のみ発火。gainDb には同スロットの mute/master 合成値を渡し、**mute 中は音イベントと同様に marker も skip**（amplitude ガード共有・一貫性）。SC backend は未実装のまま（optional 面・`?.` 呼び出し）。
- **テスト**: `tests/core/event-scheduler-step-marker.spec.ts`（新規 4 本 — rest marker 配線/mute -Infinity/argPath なし旧イベント互換/optional 面欠如の耐性 + fromTime 過去ガード）+ `rust-engine-player.spec.ts` に 3 本（音 STEP 随伴/marker-only は LoadSample/PlayAt なし/mute skip）。

### 6.193 fix(vscode-extension): whole-line flash + revealRange — MCP run_selection flash was invisible (#388) (Jul 7, 2026)

owner 観察「MCP 経由の選択実行だとフラッシュが見えず、いつ実行されたのか分かりづらい」の修正。

- **根本原因はルーティングではなく色の衝突**: MCP 経路は必ず `set_selection`（非空選択）→ `flashLines()` の `isWholeLine = selection.isEmpty` が false → decoration が**選択文字範囲だけ**に、既定 `flashColor: 'selection'` = `editor.selectionBackground` で塗られる。native の選択ハイライトと同色同範囲のため**点滅が視覚的に無変化**。キーボード派はカーソルのみ（空選択）で whole-line 塗りだったので見えていた。手動で範囲選択して Cmd+Enter した場合も同じく見えなかったはず（既存の未報告エッジケース・同時修正）。
- **修正**: ① `flashLines()` の `isWholeLine` を常に true（選択の上でも行全体が確実に光る）② flash 前に `editor.revealRange(..., InCenterIfOutsideViewport)` — subject-block 自動検出（選択なし）で実行範囲が画面外のとき flash が見えない副次ギャップも解消。
- **検証**: tsc/eslint green・mcp-server.spec 8/8。実機（OrbitStudio 再起動 → MCP 駆動）で **owner 目視確認: 複数行（1-10行）と単一行の whole-line フラッシュ両方 visible**（2026-07-07）。
- 意義: agent がいつ実行したかが人間に見える = human-in-the-loop の観測性（WCTM の共演場面でも必須の UX）。

### 6.192 feat(vscode-extension): register Claude Code MCP server from OrbitStudio (#388) (Jul 7, 2026)

owner 提案「OrbitStudio の CLI 登録（Install 'orbs' command in PATH）と同じように、MCP 登録も OrbitStudio から」を実装。scope は User / Project を選択可能。

- **`mcp-registration.ts`（新規・純関数）**: `buildMcpServerUrl(port)` / `mergeMcpJson(existing, port)` — 既存 `.mcp.json` を保全マージ（他サーバー・他キー維持・**corrupt JSON は throw して絶対に上書きしない**・2-space indent + 末尾改行）。
- **palette コマンド `orbitscore.registerMcpServer`**（🔌 Register Claude Code MCP Server）: port 未設定（0）なら InputBox（既定 39123・1-65535 検証）→ `ConfigurationTarget.Global` に保存して継続。scope QuickPick → **Project** = workspace root の `.mcp.json` へマージ書き込み / **User** = `claude mcp add --transport http --scope user orbitscore <url>`（CLI 不在は案内エラー・cwd=workspace root・30s timeout）。optional args `{scope, port}` で prompt skip（agent/E2E 用）。
- **MCP ツール `register_mcp_server({scope, port?})`**（parity 原則・計 17 ツール）: コマンドと同一実装 `performMcpRegistration` に委譲。port 省略時は稼働中サーバーの実 port（env 起動でも真値）。handler は `OrbitScoreToolHandlers` の optional member（既存テスト stub の型互換のため・実ホストでは常に供給）。
- **`claude mcp add` は CLI 2.1.202 で実検証**: `-t/--transport (stdio|sse|http)`・`-s/--scope (local|user|project)`。同名エントリは silent overwrite（重複検出ガードは他バージョン向け保険）。
- **テスト**: `tests/vscode-extension/mcp-registration.spec.ts` 9/9 pass（fresh/保全マージ/URL 更新/corrupt throw/出力形状）+ 既存 mcp-server.spec.ts 回帰 8/8。tsc/eslint green・headless smoke で tool 出現 + args round-trip PASS。
- **実ホスト検証（実 OrbitStudio・2026-07-07）**: MCP 経由 `register_mcp_server({scope:'project'})` → workspace root に正しい `.mcp.json` 生成を確認。生成物のコミット可否は owner 判断（untracked のまま）。Claude Code 本体クライアントの接続確認は次の新規セッションで（`.mcp.json` は session 起動時読み込み）。

### 6.191 test(vscode-extension): MCP server test suite + gated OrbitStudio E2E (#388) (Jul 7, 2026)

Agent Bridge の機能保証をテスト資産として永続化（owner 方針: 「テストがあることで機能の保証をするのが筋」・examples はテスト題材にしない）。Sonnet 委譲で作成、gated E2E は main session が実機実行。

- **`tests/vscode-extension/mcp-server.spec.ts`（8 tests）**: stub handlers 全 16 member + 実 HTTP JSON-RPC。initialize/tools-list（16 ツール名 + スキーマ）/round-trip/isError 変換/**multi-session regression（3 クライアント連続・live で踏んだバグの再発防止）**/no-session 404/非 `/mcp` 404/dispose 後 ECONNREFUSED。
- **`tests/vscode-extension/wav-analysis.spec.ts`（6 tests）**: 合成 float32 WAV builder（無音/0.5s 間隔クリック/未 finalize ヘッダ/int16 拒否/mono）。
- **`tests/e2e/orbitstudio-mcp-gated.spec.ts`（opt-in gated: `ORBIT_GATED_ORBITSTUDIO=1`）+ `tests/e2e/helpers/mcp-client.ts` + fixtures `tests/fixtures/mcp-e2e/`**: 実利用の形の E2E — OrbitStudio.app 起動 → `open_file`(diagnostic fixture) + `get_diagnostics`（**#384 の behavioral 検証: 編集なしで診断が返る**）→ `open_file`(kick_loop) → 全選択 `run_selection`（実 palette 経路）→ `edit_replace` tempo 120→180 → 行選択再実行 → `get_log` → `stop_engine` → capture 解析で **0.5s 帯と 0.333s 帯の onset が両方存在 = テキスト編集が音を変えたことを機械検証**。
- **実行結果**: 非 gated 14 pass / gated 1 skip（CI 安全）。**gated 実機 RUN = PASS（16.2s・2026-07-07）** — tempo 再評価が LOOP 中の seq を in-place で retune する仮定も実機で成立。
- **エラー経路 probe（実ホスト・11 本）**: engine 未起動 run_selection / 不在ファイル open_file / no-match・空 find の edit_replace / 不在 WAV analyze_audio / 範囲外 configure_flash / rust kind の select_audio_device（正直なエラー）→ 全て clean な isError。**get_log の monkey-patch が実ホストで populate されることを確認**（実装時の未検証事項を解消）。`set_selection` の範囲外行は vscode `validatePosition` により silent clamp（エラーにならない・観察事項）。

### 6.190 feat(vscode-extension): 12 remaining MCP tools — editor ops, palette parity, observability (#388) (Jul 7, 2026)

ツール総数 16。Sonnet 委譲で実装（tsc/eslint/stub smoke 全 green）。

- **Editor 系（実利用経路）**: `open_file` / `set_selection`（1-based・`validatePosition` 変換・end 省略で cursor collapse）/ `run_selection`（実 `orbitscore.runSelection` command 呼び出し = ブロック収集・setDir 注入・flash 込み）/ `edit_replace`（literal find/replace・`all` オプション）/ `get_editor_state`。
- **Palette 残り**: `start_engine` に `debug?` 追加（Start Engine (Debug) を吸収）/ `force_kill_scsynth` / `list_audio_devices` + `select_audio_device`（`selectAudioDevice()` を `detectAudioDevices`+`writeAudioDeviceConfig` に分解共有・probe scsynth の cleanup を list のみの呼び出しでも実行するよう改善・rust kind では正直に未サポートエラー）/ `configure_flash`（package.json と同じ range 検証・**workspace-scoped**: agent 由来の設定変更を Global に漏らさない意図的選択）。
- **観測系**: `get_diagnostics`（`vscode.languages.getDiagnostics` ラップ・1-based・severity 文字列化）/ `get_log`（`outputChannel.appendLine`/`append` を activate 時に一度だけ monkey-patch → 1000 行 ring buffer・default 50 / cap 500）/ `analyze_audio`（`wav-analysis.ts` の `analyzeWavBuffer`）。
- **`wav-analysis.ts`（新規・純関数）**: daemon capture 形式（RIFF float32）の解析 — peak/RMS/onset 検出（20ms 窓・200ms min gap）・未 finalize ヘッダ耐性。MCP ツールとテストの共有 seam。

### 6.189 fix(vscode-extension): per-session MCP transports + start_engine capture_wav (#388) (Jul 7, 2026)

live 検証（実 OrbitStudio 駆動）で踏んだ実バグの修正と、観測面の第一歩。

- **per-session transport**: 単一共有 transport は最初のクライアントが唯一の session 枠を恒久消費し、以後のクライアント（Claude Code の再接続を含む）は `Bad Request: Mcp-Session-Id header is required` で全滅する（live で観測・2026-07-07）。initialize リクエストごとに transport+McpServer を生成し `mcp-session-id` header で routing する方式に変更。`onsessioninitialized`/`onsessionclosed`/`transport.onclose` で session map を管理。multi-session regression probe（3 クライアント連続）で PASS。
- **`start_engine({capture_wav?})`**: capture seam（#307/#365）を MCP から使えるように。engine spawn env に `ORBIT_CAPTURE_WAV` を注入し、daemon が master 出力を whole-stream WAV 録音 → agent が聴覚なしで音声を客観検証できる（EDH 起動時 env の小細工が不要になり、OrbitStudio でもそのまま機能する）。
- **E2E 実績（実 OrbitStudio）**: Phase 2 B1 の `OrbitStudio.app` を `orbs` CLI + `--extensionDevelopmentPath` + 隔離 data/ext dir で agent が起動 → MCP up → `start_engine → evaluate → stop_engine` フルループを agent 単独で駆動。**capture 解析（48kHz stereo float32・6.43s）が全サンプル 0 = 無音を検出** → 「evaluate ok ≠ 発音」を機械的に証明（耳の代替の初仕事）。
- **無音の根本原因（Sonnet 診断・A/B 検証済み）**: engine バグではなく snippet の誤り。`play()` は**パターン設定のみ**（spec §7 Setting vs. Application・`INSTRUCTION_ORBITSCORE_DSL.md:497`）で、発音には `RUN(seq)`/`LOOP(seq)` が必要。`LOOP(drum)` 追加後の再駆動で **SOUND CONFIRMED**: peak 0.9989・onset 6 発・間隔 [0.500, 0.500, 0.500, 0.500, 0.480]s = 120bpm 四分音符と完全一致（譜面との客観照合まで耳なしで完了）。
- 学び: ① bundled daemon バイナリの鮮度は capture 等の新機能の前提（daemon が #365 以前の 7/3 ビルドだった → cargo rebuild + copy-daemon-bin.sh で解消。`strings <bin> | grep ORBIT_CAPTURE_WAV` で機能存在を確認できる）。② REPL の `✓` は「パターン buffering」と「実発音」を区別しない（agent 駆動では RUN/LOOP 忘れが silent に再現しやすい・UX 改善候補）。

### 6.188 feat(vscode-extension): MCP control server — evaluate_orbitscore tool (first slice) (#388) (Jul 7, 2026)

Claude Code から OrbitScore を MCP 経由で駆動する制御面（WCTM_SYSTEM_SPEC §3「Agent Bridge」）の第一スライス。owner の狙い = examples を含む全機能を Claude 自身が E2E で叩いて検証し「耳を1つ不要にする」+「test = eval」基盤。§4.2 の通り harness-neutral（後で pi が同じ MCP を consume）。

- **`packages/vscode-extension/src/mcp-server.ts`（新規）**: 拡張ホスト内に MCP サーバー（Streamable HTTP・SDK `@modelcontextprotocol/sdk@1.29.0`）を立て、`127.0.0.1:<port>/mcp` で待受。第一ツール `evaluate_orbitscore(code)` を登録。handler は vscode 非依存の `OrbitScoreToolHandlers` seam に分離（pi 再利用のため）。
- **stateful セッション**: MCP ライフサイクル（initialize→tools/list→tools/call）は複数 POST に跨るため、`sessionIdGenerator: () => randomUUID()` で initialized 状態を保持。stateless（当初案）だと 2 発目以降が未初期化で 500 になることを standalone probe で実証 → stateful に修正。
- **SDK は runtime require で読み込む**: SDK は exports-only ESM/CJS dual、拡張は `moduleResolution: node`（node10）で static import の subpath 型解決不可 → 既存の engine module と同じ runtime-require イディオムで CJS 解決。小さな typed shim を当て tsconfig は無変更。
- **`extension.ts`**: `runSelection` の stdin 送出（setDir 注入 + `engineProcess.stdin.write`）を `writeCodeToEngine(rawCode, documentDir?)` に抽出し、editor コマンドと MCP ツールで**同一経路**を共有。MCP handler `evaluateForAgent(code)` は engine-running ガード（runSelection と同一）+ workspace root を documentDir に。activate で `orbitscore.mcpServer.port`（config・default 0=無効）が有効時のみ起動、deactivate で停止。
- **config `orbitscore.mcpServer.port`** 追加（dev/agent-integration 用・0=無効・machine-overridable）。
- **検証**: standalone probe（`scratchpad/mcp_server_probe.js`）で compiled `dist/mcp-server.js` を stub handler で起動し HTTP JSON-RPC で initialize/tools/list/tools/call を実行 → **PASS**（tools/list に正しい JSON Schema `code:string` required、tools/call で handler が正確にコード受信）。tsc `--noEmit` PASS・eslint clean。**editor→engine→音の E2E は次段（実 OrbitStudio + owner 同席）**。
- 残（follow-on）: 残り 6 コマンドパレットツール + 観測系（get_diagnostics / get_state / capture 系）/ .vsix bundling（拡張初の runtime 依存 = SDK+zod、packaged .vsix 化時は esbuild bundle が要る）/ DNS-rebinding 保護。

### 6.187 fix(vscode-extension): run diagnostics on open/close/activation, not only on change (#384) (Jul 7, 2026)

OrbitStudio Phase 2 (#378) の IDE チャネル probe（`getDiagnostics`）中に発見したバグ。診断が `onDidChangeTextDocument` にのみ配線され、**ファイルを開いただけでは診断が計算されない**（CLI から `.orbs` を開く・タブ復元・activation 時の初期文書はいずれも 1 度編集するまでエラー/警告が出ない）。

- **判定源の単一化**: `isOrbitscoreDocument(document: { languageId })` を `diagnostics-analysis.ts` に切り出し（純関数・vscode 非依存で単体テスト可能）。inline の `languageId === 'orbitscore'` を置換。
- **4 サイト配線**（`extension.ts` activation）:
  - `onDidOpenTextDocument` → `updateDiagnostics`（開いた瞬間に診断）
  - `onDidChangeTextDocument` → 既存（`isOrbitscoreDocument` に統一）
  - `onDidCloseTextDocument` → `diagnosticCollection.delete(uri)`（閉じたら診断クリア＝stale 診断を残さない）
  - activation 時の初期パス: `vscode.workspace.textDocuments` を走査。拡張は `onLanguage:orbitscore` で activate するため、起動のトリガーとなった文書は既に開いており `onDidOpenTextDocument` が発火しない → 初期パスで拾う。
- **検証**: `tsc --noEmit` PASS。behavioral 検証（開いた直後に `getDiagnostics` が返る）は IDE チャネル probe で行う予定（次の OrbitStudio 起動時にまとめて実施）。
- ブランチ: owner 指示により Phase 2 ブランチ `378-phase2-b1-rebuild` 上で修正。

### 6.186 feat(vscode-extension): engine-kind branching — rust-default UI, scsynth sites gated (#377) (Jul 7, 2026)

cutover #369 で native Rust daemon が既定音声エンジンになった後も、`extension.ts` には scsynth 前提のコードが 4 箇所残っていた（scsynth 非同梱の OrbitStudio 成果物では毎回エラーになる landmine）。「scsynth の物理的有無」でなく「**engine kind**」で分岐させ、silent fallback は作らない（Issue #136 strict mode 踏襲）。

- **helper 新設**: `getConfiguredEngineKind()`（`extension.ts`）。`orbitscore.engine` を読み、`'sc'`（trim + lowercase）のみ SC、それ以外（未設定・未知値含む）は `rust` に正規化。engine 側 `resolveEngineKind`（`packages/engine/src/audio/engine-backend.ts`）の正規化と一致させ、UI/engine 間で挙動がズレないようにした。
- **4 サイトを engine kind で分岐**:
  - `updateBundleStatus()`: `rust` kind では `resolveScsynthForUI()` を呼ばず non-error 表示（`$(check) engine: rust (native)`）。
  - `maybeShowBundleNotice()`: `rust` kind では `resolveScsynthForUI()` を呼ぶ前に early return（scsynth 不在通知を抑制）。
  - `startEngine()`: `rust` kind では scsynth pre-check をスキップし `env.ORBITSCORE_ENGINE='rust'` を明示 set。`sc` kind では既存 pre-check を維持しつつ **`env.ORBITSCORE_ENGINE='sc'` を明示 set**（従来の `delete env.ORBITSCORE_ENGINE` は cutover 後は landmine — cutover が「未設定」の既定を rust に反転させたため、`delete`（unset）は**常に**（拡張ホストが起動時に継承した env の有無とは無関係に）rust になる。訂正: 2026-07-07 PR #366 レビュー I1）。
  - `selectAudioDevice()`: `rust` kind では `resolveScsynthForUI()` を呼ぶ前に明示的な warning message + outputChannel log を出して return（サイレントに壊れたコマンドを残さない。device 選択の Rust 版実装は今回スコープ外）。
  - config listener（`onDidChangeConfiguration`）: `orbitscore.scsynthPath` に加え `orbitscore.engine` の変更でも `updateBundleStatus()` を再実行するよう配線。
- **default flip**: `package.json` の `contributes.configuration.orbitscore.engine` を enum `["sc","rust"]`/default `"sc"` → enum `["rust","sc"]`/default `"rust"` に変更（rust-default UI が cutover 後の実態と一致）。README の設定表も同期。
- **release.yml**: `.github/workflows/release.yml`（runner=`macos-14`、Apple Silicon）に Rust toolchain セットアップ（`dtolnay/rust-toolchain@stable` + `Swatinem/rust-cache@v2`）+ `cargo build --release -p orbit-audio-daemon --manifest-path rust/Cargo.toml` を「Build engine + extension TypeScript」ステップの**前**に追加。既存 `scripts/copy-daemon-bin.sh`（`npm run build` → `build:engine` 経由で呼ばれる・daemon バイナリ不在時は warning+exit 0 の best-effort）はこの順序保証で daemon を拾えるようになる。post-package 検証ステップに `engine/bin/darwin-arm64/orbit-audio-daemon` の同梱 + 実行属性チェックを追加（fail-loud）。**scsynth 関連ステップ（brew install / build:bundle / verify:bundle）は無改変で維持**（owner 暫定判断: scsynth 同梱は Phase 1 据え置き）。
- **孤立ファイル削除**: `packages/vscode-extension/syntaxes/orbitscore.tmLanguage.json`（旧 MIDI DSL grammar・`contributes.grammars` は `orbitscore-audio.tmLanguage.json` のみ参照・repo 全体 grep で他参照なしを確認）を `git rm`。`docs/development/POST_2.0_ORBITSTUDIO_PLAN.md` の cleanup チェックリスト項目に対応。
- **暫定判断（owner 確認待ち）**: ① `selectAudioDevice()` の Rust エンジン向け実装（device enum）は未着手 — 現状は warning message で明示的に「未サポート」を返すのみ（documented gap として先送り）。② scsynth 同梱（release.yml の brew install/bundle/verify ステップ）は本 Phase では据え置き — Studio 集中方針([[orbitscore-post2-0-native-engine-direction]]参照)次第で今後見直し。
- **検証**: `npm run build`（root）緑（daemon バイナリ同梱の copy も再確認）。`npm test` 1192 passed / 28 skipped（変化なし）。`npm run lint` は既存 baseline と同一の 10 errors（vendored SuperCollider SDK `packages/sc-link-audio/external_libraries/` 配下の tsconfig 未包含ファイルへの parsing error・本変更と無関係）+ 1 warning（`tests/audio/audio-slicer.spec.ts` の import/order・pre-existing）のみ — 変更前 stash 比較で同一件数を確認済み。
- **PR #366 レビュー修正ラウンド（2026-07-07）**: C1（`getConfiguredEngineKind()` の resolver 不読 catch を無条件 rust から raw のローカル正規化へ）、C2（`DaemonClient.resolveDaemonBinary` を `resolveDaemonBinaryPath()` として export・候補順/内容は無改変・`resolveScsynthForUI()` と対称の `resolveDaemonForUI()` を新設し `updateBundleStatus()`/`startEngine()` の rust 分岐に daemon pre-check を追加）、C3（spawn `'error'` → `DaemonStartupError` 経路の実 spawn テスト追加）、C4（daemon-client.ts の spawn error コメントを Node v22 実装確認結果に訂正）、C5（`copy-daemon-bin.sh`/`.vscodeignore` の stale「SC が既定」記述を rust 既定に更新）、I1（本エントリと `extension.ts` の delete-env landmine 説明の条件付けを無条件表現に訂正）、M1（`package.json` description 更新）、M2（`release.yml` の `pull_request.paths` に `copy-daemon-bin.sh` 追加）を適用。検証: `npm run build` 緑・`npm test` 1195 passed / 28 skipped（+3 新規テスト・悪化ゼロ）・`npm run lint` は既存 baseline と同一件数のまま。
- **Round 2 独立再レビュー（code-reviewer + silent-failure-hunter）**: silent-failure 側は Critical/Important=0 を一次証跡（compiled dist の実 require 実測・engine-backend ソース照合）付きで確認。code-reviewer 側が新規 Important 1 件を検出 — `resolveDaemonBinaryPath` が `existsSync` のみで **exec bit を見ておらず** scsynth 側 `isExecutableFile` と非対称（.vsix 展開でパーミッションが落ちた bundle 等で「緑チェック → spawn EACCES 後追い失敗」が再発）。対応: 候補の viability 判定を `isExecutableFile` 相当（executable regular file・scsynth-resolver と同一規則）に変更（非 viable 候補は従来の existsSync 不在時と同じく次候補へフォールスルー）。C3 テストは「exec bit あり・shebang interpreter 不在」バイナリ（execve → 非同期 spawn 'error' ENOENT）に差し替えて spawn 'error' リスナー経路のカバレッジを維持（root 実行環境でも成立）+ 非実行候補が選ばれないことの unit テストを追加。

### 6.185 feat(vscode-extension): bundle native audio daemon into .vsix, zero-config resolve (#306) (Jul 3, 2026)

Issue #306（限定スコープ第一版）。installed .vsix から `orbit-audio-daemon`（rust engine, opt-in）を**ゼロ設定で解決**できるようにする。**SC は default のまま据え置き**（rust は opt-in・default を倒さない）。

- **daemon バイナリ同梱**: 新規 `scripts/copy-daemon-bin.sh`（darwin-arm64 のみ・自己位置解決で CWD 非依存）を root `build:copy-engine` と `packages/vscode-extension` の `build:engine`/`build:engine:clean` に配線。`rust/target/release/orbit-audio-daemon` が無い場合は **warning + exit 0**（best-effort・大半の `npm run build`/CI は cargo を持たないため既存 SC-only ビルドを壊さない）。配置先 `packages/vscode-extension/engine/bin/darwin-arm64/orbit-audio-daemon`。`.vscodeignore` に `!engine/bin/**` を追加。
- **path 自動解決**: `DaemonClient.resolveDaemonBinary`（`packages/engine/src/audio/rust-engine/daemon-client.ts`）の候補リスト末尾に、compiled JS 自身からの相対パス（`__dirname` から 3 階層上 `<extension>/engine/` + `bin/${process.platform}-${process.arch}/orbit-audio-daemon`）を追加。既存 4 候補（explicit path / `ORBIT_AUDIO_DAEMON_PATH` / monorepo release / monorepo debug）は無改変・順序も変えず最後に足す。packaged 状態で `resolveDaemonBinary(undefined)` を実行し、バイナリ在での解決・不在での正しい fail を実測確認済み（monorepo 4 候補は `packages/vscode-extension/engine/` 配下からは元々マッチしないことも実測で確認）。
- **engine 選択 UI（dog-food 用）**: `contributes.configuration` に `orbitscore.engine`（enum `sc`|`rust`, default `sc`）追加。`extension.ts` の `startEngine()` で読み取り、`rust` なら `env.ORBITSCORE_ENGINE='rust'`、それ以外は**明示的に `delete env.ORBITSCORE_ENGINE`**（拡張ホストが元々持っていた env を上書きし、SC default を確実に守る）。
- **version**: `packages/vscode-extension/package.json` を 2.0.0 → 2.1.0。README に `orbitscore.engine` 設定行 + darwin-arm64 限定の注記を追加。
- **検証**: `npm run build`（root）+ `npm test`（1188 passed/28 skipped, 変化なし）緑。`packages/vscode-extension` 側の実 CI パス（`npm run build` → `build:engine`→`install-engine-deps.sh`→daemon copy）を再現して `.vsix` を packaging、`unzip -l` で `engine/bin/darwin-arm64/orbit-audio-daemon` 同梱と実行属性保持を確認。ローカルビルドの daemon はスタンドアロン実行で起動 JSON プロトコル応答まで確認（音声デバイス不在は sandbox 環境の制約でこの検証の対象外）。
- **未解決/フォローアップ**: ①`.github/workflows/release.yml` は現状 `cargo build` を実行しないため、**CI が生成する .vsix は daemon 未同梱のまま**（今回はローカルでビルドしたバイナリでのみ検証）。② daemon バイナリは Apple Developer ID 署名・notarize 未実施（scsynth は SuperCollider 本家の既存署名を保持しているのに対し daemon は新規ビルド）。ローカルビルドは quarantine xattr が無く実行できるが、**ダウンロードされた .vsix では Gatekeeper に阻まれる可能性がある**（未検証）。両者とも本 Issue のバウンデッドスコープ外として次フェーズに持ち越し。

### 6.184 feat(engine): capture seam — realtime WAV tap on production daemon master output (#364) (Jul 3, 2026)

cutover #108 の load-bearing = **耳なし実時間検証の基盤**。#307（CLOSED）で offline capture（`orbit-audio-verify`）は完成済で、本 PR は残りの **realtime 経路**（production cpal callback の master 出力を WAV にタップ）を配線する。正本 = `POST_2.0_PLUGIN_STRATEGY.html` §4 / `POST_2.0_NEXT_STEPS.html` §6・設計記録 = serena `capture_seam_307_design_2026-06-30`（owner 2 決定 + advisor 是認）。

**設計（S1 `PostMixSink` パターンの延長）**:
- **tap 点** = `orbit-audio-native/src/output.rs::render_block` の末尾、`post.process(hw)` の **後** の最終 `hw`（= device に出る clean な f32・OS ボリューム/ハード前なので録音**レベル**はシステム音量非依存で offline render と一致。ただし WAV 全体は device 起動 latency 分だけ**位相がずれる**ので、gated harness は検出 onset にアンカーして相対比較する〔sample 単位の完全一致ではない〕）。既存 `RingTapSink`（RT 安全・wait-free・満杯時 drop カウント）を producer に再利用。
- **配線** = `start_output_inner` に第4の optional 経路として追加。**排他 feature 群（link-audio / clap-host / outproc-effect）と直交**で、どの経路でも最終 `hw` をタップする（全 4 変種で build 確認）。
- **注入方式 = A（owner 確定）**: `ORBIT_CAPTURE_WAV=out.wav` の env（daemon-start config / whole-stream）。B（runtime per-play）は follow-on。
- **WAV writer = 自前 minimal RIFF（owner 確定・新規 dep ゼロ）**: 32-bit IEEE float（format tag 3・量子化なしで exact round-trip）。off-thread writer thread が ring を drain（RT 契約なし）。
- **drop 順**: `OutputStream` に `_capture` を `_stream` の **後** に宣言 → stream 停止（callback 停止）→ writer が ring 残りを drain → WAV finalize。

**新規モジュール** `orbit-audio-native/src/capture.rs`: `RiffWavWriter`（streaming・placeholder header → finalize で size patch・write error 時も best-effort finalize で header を実サイズへ patch）/ `CaptureWriter`（`create` が `(RingTapSink, CaptureWriter)` を返す・`finish()`→`CaptureReport{frames_written, dropped_samples}`・`Drop` で stop→join→finalize）。env 解決（`ORBIT_CAPTURE_WAV`）は native ではなく **daemon 層**の純関数 `engine_wrap::resolve_capture_path`（testable・trim 済み・非 UTF-8 は operator へ報告して無効化）→ `capture_path_from_env` が担い、解決済み `Option<PathBuf>` を native へ typed で渡す（`OutProcEffectConfig` / `buffer_frames` と同じ層分け）。

**検証（`drops==0` を検証前提に = silent-failure ガード）**:
- capture unit（native・非 gated CI 被覆）: header round-trip / lossless round-trip / drop カウント検出 / finish なし drop の finalize / **不正 path での create fail-fast**（ring/thread を確保する前に Err）/ **`render_block` の post-ordering pin**（post 適用後の hw を capture することを post スタブ 0.75 で検証＝実 device 抜きで「順序が逆なら無音を録る」を CI で回帰防止）。
- capture path 解決（daemon・非 gated）: `resolve_capture_path` の unset/空/空白のみ/実 path/前後空白 trim を pin。
- **realtime gated**（`tests/capture_realtime_gated.rs`・`#[ignore]`・実 device 要）: 実 cpal stream を実時間で回し `ORBIT_CAPTURE_WAV` で examples/22（`examples22_parity` golden）を録音 → 検出 onset にアンカーして pan（5 イベント〔slice×2 含む〕を `pan_from_lr_rms` で独立逆算）+ gap 無音 + IEEE-float stereo format を assert。**teardown 前に `guard.capture_drops()==Some(0)` を assert** し、さらに `load_wav` が **WAV data チャンク size（bytes 40..44）と物理 body 長の一致を検証**する（finalize 失敗による header 破損を loud に落とす silent-failure ガード＝壊れた WAV で PCM assert が偽通過するのを防ぐ）。**実機 RUN PASS（9.92s / 10.06s・drops=0）**。厳密 gain dB 差は同一サンプルを使う offline `per_event_gain` fixture が担保（examples22 は voice ごとにサンプルが違い RMS 直接比較不可）。
- 既存全緑: `cargo build --workspace` + daemon 3 feature variants / `cargo test --workspace`（native 28 / daemon protocol 19 + verify 7 / verify 23 等）/ clippy `-D warnings` clean / fmt clean。

**委譲**: 自前 RIFF writer + off-thread writer（隔離モジュール・純）は Sonnet subagent に並列委譲、output.rs の RT callback 配線・StreamGuard teardown 順は Opus 保持（CLAUDE.md §5 委譲規律）。

**follow-on（seam→hardening の段階分け・outproc の #341→#342 と同型）**: ① capture drop の **live operator 監視**（session.rs の 1Hz ticker に `capture_drops>0` を配線し `ERROR_CODE_CAPTURE_DROPPED_SAMPLES` を出す）は EngineWrap への drops accessor 追加が要るので別 PR。本 PR は teardown 時 `eprintln` + gated `drops==0` assert で surface 済。② producer（`RingTapSink::commit`）の `is_abandoned()` による writer 死検出は LinkAudio と共有する RT プリミティブに触れるため別 PR で扱う（本 PR は harness の長さ検証 + drops で実証済ケースをカバー）。③ writer thread の **terminal I/O error の machine-assert**: mid-stream write error が finalize 前に回復し truncation が tail slack 内に収まると、header と body は self-consistent なので data-chunk 長検証では捕まらない（現状 `Drop` の `eprintln` で observable・silent ではないが gated test は未 assert）。`drops` と同型に `capture_write_error()` accessor を足して gated harness が `drop(guard)` 前に assert する形が follow-on（disk-full 実機再現が要るので別 PR）。`/simplify` + `/code:pr-review-team`（iteration 2・独立 4 レビュアー再確認）の指摘（silent-failure CRITICAL＝data-chunk 長検証 / post-ordering 未テスト / untrimmed path）は本 PR 内で解消し、**Critical/Important=0 に収束**。

### 6.183 docs(research): LLM composition skill research — small-epoch plan (#374) (Jul 4, 2026)

LLM に OrbitScore DSL でリフ（クルディッシュ・ダンス型）を作曲させる「作曲スキル」の実装方法を deep research（**Sonnet 5 × 13 agents**・Orient + 3角度 + 敵対的検証 6 件 [C4/R1/U1] + 批評→改訂）で調査し、`docs/research/WCTM_COMPOSITION_SKILL_RESEARCH.md` に**エポック計画 E0-E6 + owner 決定 8 点**を記録。

**最重要訂正（Orient）**: 「Pitch DSL v1.1 は Phase 1 開発中」という session 前提は**古い** — 実際は **Phases 1/2/3/R/4 実装・テスト済み**（2.0.0 同梱・WORK_LOG 6.131）。**リフを書く機能ブロッカーは無く E0（新規コードゼロ・`midi-run` で今日試聴可能）が即動く**。Epic #224 の子 issue チェックリストは stale（要 owner 確認）。

**設計の柱（一次検証済み）**: Libretto（12%→39%/62%→94% の bounded revise ループ）と AI TrackMate が独立に収斂した「**フィードバックは生数値でなく音楽的自然言語で返す**」/ Grammar Prompting（部分 BNF の in-context 提示）/ 様式忠実度は LLM 単体で届かない（隣接証拠 40%）→ **人間キュレーションが実質品質ゲート** / **E4 動機検出器のスコアを生成ループのゲートに使わない固定制約**（検出器にしか聴こえない曲への循環防止・論文候補 = Schuller vs Givan の記号データ検証）。E0→E3 が床・どの kill でも床は残る構造。

### 6.182 docs(plan): OrbitStudio implementation plan — cutover to VSCodium build (#373) (Jul 4, 2026)

cutover 済み main を起点に OrbitStudio（VSCodium 版）完成までの実装計画を `docs/development/POST_2.0_ORBITSTUDIO_PLAN.md` に固定（owner 指示 2026-07-04・**後続の Opus セッションがコールドスタートで実行できる粒度**）。Sonnet 5 workflow（4並列読込 [設計docs/extension コード実態/GitHub 状態/WCTM 土台要件] → 起草 → **批評 9 観点 → 改訂**）で作成。

**構成**: Phase 0 spike（stock VSCodium への .vsix side-load + Claude 拡張動作の 2 STOP gate・issue #301 の stale body を即修正）→ Phase 1（#366 landmine + #306 daemon bundle + **`resolveScsynthForUI()` 全 4 箇所**の engine-kind 分岐 — 批評が原案の 2 箇所見落としを捕捉 L149-174/L184-201/L699-708/L836-862・(A) Studio 向け scsynth 非同梱 / (B) 通常 .vsix の 2 系統を同一コードベースの分岐で両立）→ Phase 2（B1 リブランド rebuild・ツールチェーン spike 先行・**gate = 2.0.0 QA Epic #278 チェックリスト転用**で B2/B3 エスカレーションを客観化・Gatekeeper 偽陰性注意）→ Phase 3（署名/notarize — CODESIGN_PIPELINE から転用可能なのは codesign 構文のみで .app バンドル署名は別カテゴリと明記・Apple Developer Program は owner 専管）→ Phase 4（WCTM 非依存ガード 4 点・CLI 実行テストで裏付け）。

**機能組み込みレジストリ**（17 項目・status = prerequisite/owner-decision/post-beta/out-of-scope）と **owner 決定事項 9 点**を分離 — 実際の組み込み可否は owner 判断（計画は確定しない）。**WCTM 誤結合防止を明記**: OrbitStudio は本番（08-07）のいかなる経路にも登場しない・pi SDK 埋め込みは本番後。provenance 注意（マージ順の記録）: PLUGIN_STRATEGY.html は本計画作成時点で PR #363 未マージ（2026-07-04 マージ済み）・#301 body は engine-first pivot 前の stale（更新済み）。

### 6.181 docs(research): WCTM ear-PDCA research — sideman as synthetic ground truth (#371) (Jul 4, 2026)

owner 提起の 4 仮説（①sideman を合成 ground-truth 生成器に耳の PDCA ②一曲特化 ③OrbitScore DSL を理解基盤に ④音空間の捕捉）を deep research（**Sonnet 5 × 16 agents**・sideman リポジトリ直接調査 + 4角度スイープ + 敵対的検証 8 件 [C3/R5] + **批評 22 攻撃 → 改訂**の 2 周）で検証し、`docs/research/WCTM_EAR_PDCA_RESEARCH.md` に提案 A-G + 推奨シーケンス + owner 確認事項 4 点を記録。

**主要判定**: 仮説 1 は**記号/ラベル層に限定して成立**（生音特徴量の較正は合成では埋まらない — AAM 合成コード認識 97%→実転移ジャンル依存劣化・ピアノ転写 -16.55 F1 の音響過適合等が一次裏付け）。一曲特化は Music Plus One（per-piece HMM 較正）の数十年前例あり・ただしリハーモナイズ耐性の前例は不在。**循環の罠**（sideman で校正し sideman で評価）は実在の測定現象 → 独立ホールドアウト（owner 実演奏録音）+ 「較正セット単体精度で内部判断しない」規律を案E として必須化。検証の成果 = sideman に**バッチドライバ 2 種が実装済み**と判明（「未実装」claim を REFUTED・工数が下がる訂正）・`NoteEvent.source` が OrbitScore evalSource 概念を既に参照。

**master switch**: 全 pre-0807 判定は「ATTYA が本番曲」という未確認前提 → owner 確認が Day 0。既存 W3-W8 ロードマップ（6.180）のゲートは置換せず追加の検証ケースとして積む。sideman は UNLICENSED/private → 静的スナップショット凍結・本番ランタイム非バンドルのガバナンス境界を全案共通で宣言。

### 6.180 docs(research): WCTM machine-listening deep research + 10 implementation proposals (#371) (Jul 3, 2026)

WCTM の最大ポイント「AI がいかに楽曲の音を聞いて理解するか」（機械の耳）を deep research（**Sonnet 5 × 24 agents**・7角度並列スイープ → load-bearing claim 93 件 → **敵対的検証 16 件: CONFIRMED 8 / REFUTED 7 / UNCLEAR 1** → 完全性クリティーク）で調査し、`docs/research/WCTM_MACHINE_LISTENING_RESEARCH.md`（サーヴェイ）と `docs/research/WCTM_LISTENING_IMPLEMENTATION_PROPOSALS.md`（**実装案 10 + 比較マトリクス + owner 決定事項 4 点**・owner 要望で別ファイルに分離）に記録。owner 指示（2026-07-03・Fable セッション）= サーヴェイと実装計画案の立案のみ・実装しない。

**主要な結論**: ①完全自動の耳で本番運用された頑健な先行例は不在 — 数十年の実戦は全て human-in-the-loop（IRCAM 自身がジャズで自動ビートトラッキングを撤退・手動タップ採用 = AIMC 2021 一次確認）②形式把握は特徴量から創発しない（ReaLJam 実証）→ 位置明示ラベル注入が正解 ③MIDI 側路は Voyager 40 年の前例 = guitar-to-MIDI が最有力の耳アップグレード ④和声一致度位置検証は構成要素は枯れているが統合は前例ゼロ = kill-criteria 付き挑戦枠 ⑤ピアノ bleed には「加害源 MIDI 既知」という文献にない好条件 → MIDI 連動解析窓マスクが費用対効果最良。

**spec 衝突を発見**: WCTM spec §2「Max が Link 駆動・エンジン追従」vs 実装済み #283「エンジンが Link テンポリーダー」= 主従逆転。テンポ権限の向きは owner 決定事項 D2 として記録（推奨 = タップ/トラッカー → Bridge/エンジン経由で Link set・実証済み経路再利用。Max からの直接 push は Link プロトコル特性により不安定と検証済み）。

**検証の成果**: AI 検索要約の誤生成 1 件を README 直接取得で特定（「BTrack ジャズ実戦」は捏造）・vb.aubio~ が onset のみでなく **tempo/beat 推定も実装済み**とソース直接確認で判明（案2 の第一候補に昇格）・zsa.descriptors の AS 対応は公式ページに記載ありと反証。二次情報の鵜呑みは 16 件中 7 件の誤りを生んでいた。

**推奨 = 案10 段階的統合**: 床（案1 operator-first + 案5 bleed マスク + 案6 LLM 文脈設計）を確実に敷き、挑戦枠（案2 confidence-gated auto beat / 案3 MIDI ears / 案4 位置検証）は kill-criteria 付きで積む — kill はレイヤーごと落とすだけで床は無傷 = 手戻り構造ゼロ。W3 に owner 決定 D1-D4 + クロス被り実測、W6 リハ#1 は「検証済み構成の確認の場」にする（初見の場にしない）。

### 6.179 feat(engine): cutover #108 — default audio backend を Rust に切替 (SC 温存) (Jul 3, 2026)

post-2.0 の到達点。native Rust daemon を**既定の音声バックエンド**にする engine-level cutover。owner GO（2026-07-03）を受けて実行。

**parity 根拠（実測・推論でなく RUN）**:
- offline 3層 22テスト PASS: interpreter schedule（leg2）/ core render（数学オラクル）/ daemon render（verify_schedule_pcm・例22/varispeed/LinkAudio 含む）。
- coverage matrix（22 examples 横断）: 例が使う audio 機能に **genuine gap なし**。timing は interpreter が絶対時刻に焼き込むため backend 非依存。
- **runtime dispatch fitness**（SC fire-now 対 daemon schedule-ahead・advisor 指摘の本当の門）: gated `real-daemon-timing` を default/64f/32f で実測 → 全て ahead-of-cursor・**xruns=0**・polymeter parity。anchor drift は buffer 縮小で単調に締まる（6.7→2.4→0.7ms）。

**変更**:
- `engine-backend.ts` `resolveEngineKind`: `sc`/`supercollider` → SC（opt-out）、それ以外（未設定含む）→ **rust**（既定反転）。
- `create-audio-engine.ts`: 既定 rust・SC は opt-out のメッセージ/doc に更新。
- `rust-engine-player.spec.ts`: 反転後の契約（未設定=rust・sc/supercollider=opt-out）に spec 更新。
- full suite 1189 pass（SC 既定に暗黙依存するテストは無し）。

**scope 境界**: engine-level default のみ。VS Code UI 既定（`orbitscore.engine`）+ .vsix 再ビルドは #366 の post-cutover 仕上げ。scsynth の**完全退役は別後段**（#108 も「parity 確認後に deprecate」と分離）。flip は**リバーシブル**（`ORBITSCORE_ENGINE=sc`）。

out-of-scope（cutover blocker でない）: `.time()` pitch保存stretch/`.fixpitch()` → #213・master fx → 未使用。

### 6.178 docs(wctm): change production runtime to a pi-based dedicated harness (Jun 28, 2026)

**Branch**: `claude/agent-external-data-harness-yob87g`
**変更ファイル**: `docs/specs-v2/WCTM_SYSTEM_SPEC_v1.md` §4 全面改訂 + §3.2 / §10 / ヘッダ改訂注 / 構成図凡例、`docs/specs-v2/IMPLEMENTATION_INSTRUCTIONS.md`（W-Runtime / ロードマップ図 / known-decisions 表）、`docs/specs-v2/DESIGN_DISCUSSION_RECORD.md` §14 新規（決定 #60–#63）。

**経緯**: laiso「Pi Coding Agent」記事を起点に大和が「このハーネスで外部データの受け取りをエージェント側で可能にできるのでは」と提起。設計対話の結論として **WCTM 本番ランタイムを Claude Code 二段構え（旧 decision #29）から pi（@mariozechner/pi-coding-agent）ベースの OrbitScore 専用ハーネスに確定**。

**なぜ変えたか（詳細は DESIGN_DISCUSSION_RECORD §14）**:
- **Claude Code は push を実行に持ち込めない**: MCP プロトコルは server→client push を持つが、Claude Code は `resources/updated` 未実装（#7252）・push 受信しても agent 不達（#33679/#36665）。WCTM の「小節到着が特徴量を駆動する」push 型本質要件と非両立。
- **自前イベントループ（pi）なら** 「小節到着→コンテキスト組立→Messages API 発火」を書け、外部データがターンを駆動できる（変わるのはターンを誰が発火するか）。
- **開発コスト**: 開発ツール（Claude Code）と本番ランタイム（pi）を分離すれば、A で測った数字は本番経路に移植不能（測定妥当性）+ 二重実装回避 + リハ中の柔軟性 → pi-first が有利。「即日動く」は薄いスケルトンで確保。
- **専用ハーネスの価値**: customTools で OrbitScore 語彙＝エージェントの道具（§6 橋）、SDK で orbitstudio 埋め込み、.orbslog をネイティブ作業記憶に。演奏ハーネス＝作曲ハーネスを共有コアに（本番後一般化）。

**核心の未解決問題（§14.5、要 大和確認）**: 「今どこを演奏しているか」= 形式内位置（bar:beat + セクション/コード）の検出。特徴量はテクスチャを与えるが形式位置を与えない。推奨初期案 = オペレーター舵取り + エンジン小節カウントのハイブリッド位置ラベル。本番の自律度は大和判断。

**据え置き**: Agent Bridge（脳なし MCP）・統一評価経路は不変。**コード変更なし（docs のみ）**。
### 6.177 feat(engine): γ M1 PR-B — real CLAP effect child + shared 1-block core (#357) (Jun 27, 2026)

γ M1 の **PR-B**。PR-A の transport の上に、**実 CLAP effect plugin を隔離 child プロセスで host** し、offline A/B parity を実 effect で確認する。設計正本 = `docs/development/POST_2.0_GAMMA_M1_DESIGN.md` §4.4/§4.6/§5(a)/§6。実装前に advisor 相談（① clack single-thread lifecycle を最初に証明 ② merged-RT 委譲を独立 commit 化 ③ closed-form oracle 採用）。

**抽出した共有資産（`orbit-clap-host`）**:
- `process_block_core(plugin, buffers, steady, input_events, data) -> bool` = 1-block CLAP 適用カーネル（effect=serial overwrite / instrument=add-mix 分岐・入出力配線は成功時のみ・steady 更新）。`ClapPostProcessor::process()` の effect/instrument 本体をこれに**委譲**（byte-identical）し、新規 `ClapEffectProcessor` も同じカーネルを使う = 二重実装を排除（設計 §4.4）。
- `instantiate_activate(...)` = discover→instantiate→activate→start_processing の load 経路を `ClapHost::load_plugin`（daemon）と `ClapEffectProcessor::load`（child/parity）で共有抽出。
- `ClapEffectProcessor` = **single-thread** effect-only ラッパ（`load → process_block → drop`）。daemon は activate=main / process=audio の別スレッド構成だが child は 1 スレッド直列。フィールド宣言順（`plugin`→`_instance`）で drop 順 = stop_processing→deactivate を同一スレッドに収め、carry-forward #1 の wrong-thread teardown を構造的に sidestep。

**新規 child crate** `rust/crates/orbit-clap-effect-child`（`orbit-clap-host`+`orbit-audio-sandbox` 両依存）= PR-A gain child の gain 乗算を `ClapEffectProcessor::process_block` に差し替え。transport protocol（per-slot `seq_tag`/`seq_done`）は gain child と同一。input slot→scratch（ループ前確保=RT安全）→in-place effect→output slot。**依存の向きは child→transport のみ**で `orbit-audio-sandbox` は child crate に依存せず clack-free を維持（`cargo tree -p orbit-audio-sandbox` に clack 不在 = fault 隔離の不変条件・設計 §4.6）。

**検証（advisor sequencing）**:
- **基礎証明（最初に実行）**: `effect_processor_smoke_gated`（`orbit-clap-host`）で single-thread の load→process_block→drop が実 test-effect で成立・出力 = 0.5×入力。child crate を建てる前にこの foundation を確証。
- **PR-B Done（gated・offline・device 不要）**: `effect_parity_gated`（`orbit-clap-effect-child`）= **closed-form oracle**（OOP child 出力 == `input*0.5` を `max_abs_diff==0.0` で sample-exact・transport+CLAP 同時検証）+ **A/B parity**（in-process side A == OOP side B）。oracle は両側同一コードでなく独立な数学的解と突き合わせる点で in-proc-vs-OOP より強い（advisor ③）。
- **merged-RT 委譲の非回帰（独立 commit・前後計測）**: gated daemon test を委譲の**前後で実行**し byte-identical を確認 — effect `ratio 0.50000` / synth `post_mix_peak 0.25000` が一致（callback_count の ±1 は固定 sleep 窓内の cpal callback 回数のゆらぎ）。
- **workspace 全体**: `cargo test --workspace --features clap-host` 全緑（device あり: core 42 / daemon 8+protocol 19 / native 24 / sandbox 14 / verify 23 / clap-host 12 / spike 7+3 等）/ `cargo clippy --workspace --all-targets --locked -D warnings` + `-p orbit-audio-daemon --features clap-host` clean / `cargo fmt --check` clean。実 CLAP の gated 検証は test-effect dylib（workspace 非 member）ビルド要のため `#[ignore]`・CI backstop は PR-A gain parity（clack 非依存）。daemon spawn/watchdog/respawn 統合は **PR-C**（PR-A 同様 daemon の実 stream 統合は無改変）。

**PR-B round-1/2 review 収束（`/simplify` + `/code:pr-review-team`）**: `/simplify` の cleanup（`InstantiatedPlugin.note_port_index` 重複除去 / no-op rename 除去 / child loop の slot index/offset hoist）適用後、`/code:pr-review-team` を回し round-1 指摘を fixer pass で解消、round-2 で 4 reviewer 全員が **Critical=0 / Important=0** を独立確認（自己申告でなく独立再レビューで裏取り）。
- **silent-failure Critical（child が `process_block` の bool 戻り値を破棄＝CLAP 失敗が child で不可視）→ MINOR 格下げ + 解消**: `process_errors` カウンタで集計しループ終了時に `eprintln` 報告（RT loop に IO を入れない）。child→host の health signal を `SharedRegion` に乗せるのは **PR-A の frozen transport を触る**ため見送り、**PR-C で §4.5 supervision signal 群と一緒に設計**（child は PR-C まで本番 consumer 無し = severity 妥当・advisor 判断）。残存（異常終了時の未報告 / host stderr 可視性）も PR-C 前提として tracking。
- **`#[must_use]`（Important）→ 完全解消**: `process_block` / `process_block_core` 両方に付与。daemon `process_ok` 束縛 / child `if !...` / parity・smoke の `assert!` の全 call site が戻り値を消費。
- **test gap → CLOSED**: ① partial-block を実 CLAP で検証（parity を `assert_oop_parity` 化し 512f 倍数 + 300f 端数=128+128+44 の 2 ケース・最終 `n_frames < block_frames`）② 新コードの初の**非 gated CI 被覆**（`tests/cli.rs` の child 引数バリデーション 4 ケース[--shm/--plugin/未知/値なし] + `controller.rs::instantiate_activate_nonexistent_path_is_err`＝discovery 失敗が panic でなく Err 伝播・dylib/device 不要で CI 実行可）。「CI で test-effect dylib をビルドして gated parity を回す」は norm（gated=実機 RUN）に合致し PR-C の CI 配線と一体設計が適切なため follow-on。instrument 分岐の offline 検証も PR-C。
- **comment 精度**: BufferSize::Fixed 契約の RT-safe caveat cross-ref（processor.rs）/ Cargo.toml の依存方向を能動形に / main.rs:93 SAFETY 追記 / parity doc の partial 条件を `n_frames < block_frames` に訂正（`< MAX_FRAMES` は両ケースで真＝区別しない）。
- **@claude bot レビュー（scoped）+ clack teardown 機構の source 検証**: 内部収束後、advisor 判断で重点2点（single-thread teardown drop 順 / `process_block_core` byte-identical 委譲）に絞り bot レビュー → 両点 no-blocker。ただし advisor 指示「API 契約 claim は pinned source で裏取りしてから cite」に従い `effect.rs` の drop-順 rationale を clack（pinned rev `f874e858`）で検証したところ、**当初コメント（及び bot が是認した rationale）が機構的に不正確**と判明: `StartedPluginAudioProcessor` は Drop を持たず stop_processing は呼ばない。実 teardown は `plugin`/`_instance` が共有する `Arc<PluginInstanceInner>` の**最後の Arc drop 時に `PluginInstanceInner::Drop`** が stop_processing→deactivate→destroy をまとめて実行（`host/src/plugin/instance.rs:232`）。`PluginInstance::Drop`（`host/src/plugin.rs:399`）は**唯一所有者のときだけ** inner を drop し、さもなくば wrong-thread teardown 回避のため**意図的に leak**する。よって field 宣言順 `plugin`→`_instance` は load-bearing で**正しい**が、逆順の failure mode は crash でなく **silent leak**（smoke/parity は順序が逆でも緑）→ コメントが順序を守る唯一のガード。コメントを Arc-sole-owner 機構に**訂正**し、clack bump 時に再確認すべき2 Drop site を anchor（コード挙動は単一スレッド teardown で検証済＝不変・doc-only 訂正）。
- 再検証: fmt / clippy（workspace + daemon clap-host・-D warnings）clean・非 gated 全緑（cli 4 + controller unit + lib 13）・gated 全緑（parity[partial 込み] + smoke）・daemon byte-identical 維持（effect ratio 0.50000 / synth peak 0.25000 = `#[must_use]`/doc 変更は codegen 不変）。

### 6.176 feat(engine): γ M1 PR-A — out-of-process sandbox transport crate (#355) (Jun 27, 2026)

γ 本実装（#354）を owner 2026-06-27 決定で **M1（effect 隔離）/ M2（instrument+automation・spike-first）に段階化**したうちの **M1 の PR-A**。advisor 相談（設計 checkpoint）+ 3 サブシステムの並列探索（spike transport / clap-host seam / verify harness）を経て設計。設計正本 = `docs/development/POST_2.0_GAMMA_M1_DESIGN.md`。

**新規 production crate** `rust/crates/orbit-audio-sandbox`（spike `orbit-sandbox-spike` から **transport だけ**昇格・計測 scaffolding は持ち込まない）:
- `transport`: 親子共有 `SharedRegion`（file-backed mmap MAP_SHARED + SPSC ping-pong）。**N-slot-generic**（`slot_offset = seq % SLOTS` / outstanding guard `seq_done >= new_seq - SLOTS` / 配列 `BUF_LEN*SLOTS`）= advisor #1: cross-process `repr(C)` 構造に slot 数を焼き付けず、PR-C の 2 vs 3 決定を **`SLOTS` const 1 つの変更**で済ませる（`seq & 1` は 2 のべき乗専用だった）。`control` flag で child を clean 終了。**memmap2 のみ依存**（native/cpal/clack 非依存 = 依存隔離が fault 隔離の鏡）。
- `host::PipelinedEffectHost`: 候補B 状態機械（submit `data`→ 前ブロック read で in-place 上書き・spin なし）。stale = **repeat-previous**（owner 決定・直前 good block 再出力でクリック回避）。RT-safe（alloc/lock/syscall なし・last-good 事前確保・生ポインタは atomic field 参照と slot 単位 copy のみ）。
- `bin/sandbox-effect-child`: gain child（clack 非依存・実 CLAP child は PR-B）。A/B parity の OOP 側相手。
- `offline`: cpal 非依存の同期ドライバ（submit→spin 待ち→read）+ A/B parity primitive（`max_abs_diff` / `render_in_process_gain`）。

**検証 3 分割**（advisor #2: offline は同期で repeat-previous を構造的に exercise できない → 別建て）:
- **(a) audio 正しさ**: 2 層。① tests/host_child_integration.rs = **production path の CI root-of-trust**: 実 `PipelinedEffectHost`（候補B 状態機械）+ 実 spawn child + 実 mmap を cpal 無しで統合し、各 callback 間で `seq_done` を追いつかせて毎回 fresh path に当て、入力を gain 倍し **ちょうど 1 block 遅延**させた結果に **sample-exact 一致**（決定論）。本番で実際に走る両プロセス半分を一緒に動かす唯一の CI テスト。② tests/parity.rs = transport + **同期ドライバ**の sample-exact A/B（diff=0.0・64/256/300/512f）。①が pipelined host を、②が transport（mmap+SPSC+slot index）を検証する別役割（parity.rs の同期ドライバは本番では使わない経路なので、これ単独を production カバレッジと誤読しない）。両方 audio device 不要で **CI 実行可**。
- **(b) pipeline 状態機械**: host.rs の **mock-child**（seq_done を制御）unit test で steady-state +1block 遅延 / repeat-previous（seq_done 保留→last-good 再出力）/ stall（child 停止→slot 再利用待ち）を決定論検証。
- **(c) RT stale-rate 32-64f**: gated 実機（PR-C）。

advisor #3（gain child を PR-A に昇格＝parity 相手）/ #4（M1 = master-effect 単独 post-processor・chaining は M2+・spec 明記）/ #5（sample-exact parity 採用）も反映。daemon adapter（`impl PostProcessor`）+ spawn/supervision は PR-C へ（PR-A は daemon 無改変・自己完結）。

**検証**: 新 crate の `cargo test`（unit 7 + offline 2 + parity 2 + host_child_integration 1 = 全緑）/ **workspace 全体 `cargo test --workspace` 全緑**（新 member 追加後の回帰確認・advisor 指摘）/ `cargo clippy --workspace --all-targets -D warnings` clean（const assertion 化で `assertions_on_constants` 解消）/ `cargo fmt --check` clean / `cargo deny check licenses bans` ok（memmap2/anyhow は permissive・spike で vetted 済）。CI は Rust gated 非実行のため (a)(b) の offline/integration が CI 根拠・RT 実機 stale-rate は PR-C gated。

**PR-A round-1 review 対応（per-slot メタデータ・PR #356）**: `/code:pr-review-team` round-1 の load-bearing 指摘（code-reviewer の per-slot メタデータ不在・可変 buffer findings を subsume）を advisor 設計検証の上で修正。**spike #351 の child が `cur > last` で latest 処理だったことを確認**し（silently diverge しない）、その discipline を維持したまま `SharedRegion` に **per-slot `seq_tag: [AtomicU64; SLOTS]`** と **per-slot `n_frames: [AtomicU32; SLOTS]`** を追加（単一 `n_frames` を置換）。host READ は `seq_done >= target` でなく `seq_tag[slot(target)] == target`(Acquire) で fresh 判定し、「latest 処理」で skip された中間 seq の **false-fresh を防止**（global monotone な seq_done では skip 検知不能・観測 counter = PR-C の slot 数決定指標を保護）。copy 長は `n_frames[slot(target)]` で clamp し可変 buffer の stale tail を防ぐ。`seq_done` は submit guard 専用に残す。child/offline/mock の三者を同一 per-slot プロトコルへ同期（advisor #1: mock を実 child と別プロトコルにすると unit test が phantom を検証する）。**追加テスト**: skip-not-false-fresh（load-bearing・旧 seq_done 判定なら false-fresh していたケース）/ recovery-after-stall / submit-guard-exact-boundary / over-BUF_LEN-clamp / open_shared の missing-file・too-small。comment-analyzer の SAFETY 修正（offline.rs:70 が guard でなく scope の `mmap` が backing を生かす旨に訂正・他 SAFETY 完全化）。supervision 3 件（child ExitStatus 捕捉 / 親死亡 watchdog / crash-vs-timeout 診断）は `TODO(PR-C)` で defer（supervisor consumer が未在）。再検証: `cargo test -p orbit-audio-sandbox`（13 unit + 1 integration + 2 parity 全緑）/ `cargo test --workspace` 全緑 / clippy -D warnings clean / fmt clean / `cargo deny check` ok。

**PR-A round-2/3 収束（PR #356）**: round-2 で pr-test-analyzer の Critical 1（read-clamp の差分検出テスト欠如 = 固定フレーム既存テストは alloc_zeroed で slot tail が 0.0 のため regression を捕捉できない）に対し `pipelined_read_clamps_to_target_slot_frames` を追加（slot 末尾に sentinel 9.0 を仕込み、現 callback が target より大きい buffer を要求しても sentinel が漏れないことを検証 = clamp を `copy=count` に退行させると失敗する真の差分テスト）。Drop の silent-failure 2 件（try_wait の Err アームを timeout と分離 / remove_file 失敗ログ）+ safe fn 3 つの `# Safety`→`# Note` も対応。round-3 で 4 reviewer 全員が **Critical 0 / Important 0** を独立確認（収束は self-declare でなく独立再レビューで裏取り）。`cargo test -p orbit-audio-sandbox` 14 unit 全緑。

**⚠️ spike 数の provisional 性を設計doc に記録（advisor 指摘）**: per-slot `seq_tag` 機構は **PR-A の新規**で spike #351 には無い。spike は `seq_done`-only プロトコル（false-fresh on skip）を計測したので、その `pipelined_stale` / 「32f feasible」verdict は real glitch を **undercount**（skip が最も起きる 32f に集中）している。よって spike 数を slot 決定の根拠にせず、**PR-C の gated 実機計測を corrected `seq_tag` プロトコル下でやり直してから 2 vs 3 slot を決める**旨を `POST_2.0_GAMMA_M1_DESIGN.md` §5 (c)・§6 PR-C 行・新規注に明記。correct path（`seq_tag`）は単一スレッド mock + 同期統合テストのみで、**実並列下は未計測**（PR-C で計測）。

### 6.175 spike(engine): γ latency policy fork — pipelined solves 64f (#350) (Jun 27, 2026)

γ staging の次段（Step0 #348 の後）。Step0 verdict §6 の **latency policy fork を計測して決める**（"run before you plan"）feasibility spike。owner 方針（DAW 並み小バッファ性能が目標）により 64f/32f を edge case ではなく性能ゴールとして扱う。

`orbit-sandbox-spike` の `sandbox-host` に 3 モードを追加して計測:
- **候補 A**（`--child-rt-priority`）: child の spin スレッドを mach `THREAD_TIME_CONSTRAINT_POLICY`（RT）へ（mach2・macOS 限定 target 依存）。
- **in-process 対照**（`--in-process`）: child を使わず callback 内で直接合成し floor を測る。
- **候補 B**（`--pipelined`）: host は spin せず block N を渡し N-1 を読む。ping-pong バッファ（input/output 各 2 slot・`seq&1` で uniform index・child も変更）+ 2-outstanding guard（`seq_done >= new_seq-2`）。判定軸 = **stale 率**（callback_max ではない・advisor 指摘）。

**計測（MacBook Pro arm64・44100Hz・release・同一機材）**:
- **候補 A は棄却**: 64f で worst callback_max ~2〜2.75ms（縮まず）、ある run で 154 overruns（≈223ms 無音）に不安定化。連続 spin スレッドへの time-constraint は macOS demote を招く。→ tail は child プリエンプト由来ではない。
- **in-process 対照**: 64f worst callback_max = **6µs（0.41%）**。→ ~2ms tail は OS/driver floor ではなく **sandbox round-trip 待ち固有**。owner 主張「ネイティブ楽器=in-process は小バッファ OK」を実機で裏付け。
- **候補 B が解く**: callback_max は 32〜256f すべてで ~3.5〜8µs（**<0.5% budget**）= tail 消滅。stale 率 = 256/128f 0% / 64f ≈0.11%（15s・11/10330）/ 32f ≈0.45%（31/6861）。stall は 64f+ で 0・32f で数件。

**Verdict = 候補 B（one-block-pipelined）採用**。out-of-process sandbox を 32f まで小バッファで feasible にする。代償 = 1 block 遅延 + stale <0.5%（@32-64f・production は repeat-previous）+ 32f で slot 再利用圧（slot 3 化を検討）。同期設計の「≥256f 下限」制約は pipelined では外れる。verdict = `docs/development/POST_2.0_GAMMA_LATENCY_FORK_SPIKE.md`。次 = γ 本実装で pipelined 採用 → event/param IPC → daemon 統合 → cutover #108。

### 6.174 spike(engine): γ out-of-process sandbox feasibility — Gate1/Gate2 verdict (#348) (Jun 27, 2026)

post-2.0 native engine の **γ（out-of-process sandbox）** フェーズ Step0。正本 `POST_2.0_NEXT_STEPS.html` の staging 指示「γ は単一 /goal にせず『daemon CLAP 統合（#340/#341 完了）→ sandbox スパイク』と段階化」に従い、feasibility spike（実装ではなく stop&report ゲート付き）を実施。

**新規 crate** `rust/crates/orbit-sandbox-spike`（publish=false・2 binary）:
- `sandbox-host`: cpal 出力 RT callback で 1 ブロックを共有メモリ越しに child に渡し gain を掛け戻させる round-trip を **bounded spin**（timeout 付き）で待つ。別スレッド watchdog が child の死を検知し clean child を respawn。
- `sandbox-child`: 隔離エフェクトプロセス。`--crash-after-blocks` で自発 segfault し Gate2 を駆動。
- 同期は file-backed mmap(MAP_SHARED) 内の `seq_request`/`seq_done` atomic の SPSC Acquire/Release ハンドシェイク（新規 sync crate 不要・futex 非依存）。計測ハーネスは `orbit-clap-spike`（#295 baseline）の bucket histogram p99 / callback_max を流用。

**Gate1（warmed・synchronous・各 buffer 3 回・MacBook Pro arm64・44100Hz）**: 判定軸は worst-case `callback_max ÷ budget`（`overruns` は CoreAudio が xrun を発火しないため不可・#295 fence）。
- 512f（budget 11.6ms）: worst callback_max 2.15ms = 18.5% → **PASS**。
- 128f（2.9ms）: 2.83ms = 98% → 余裕ゼロ（reliably safe とは言えない）。
- 64f（1.45ms）: 4.15ms = 286% → **違反**。
- mean/p99 は µs（mean 6〜21µs / p99 大半 <0.5ms）。**worst-case tail（~2〜4ms）は buffer サイズ非依存の定数**（scheduling jitter＝child/host のプリエンプト由来）→ budget がこれを上回る必要があり、同期設計は実質 **≥256 frame の buffer 下限**を強制。tail はプロセス隔離ではなく**同期 round-trip 設計の代償**。

**Gate2（crash 封じ込め + watchdog 復帰）= PASS**: child SIGSEGV → **host プロセス生存**（C-ABI segfault をプロセス境界で封じ込め）→ watchdog respawn → audio-flow 復帰（`recovered=true`・peak 0.25）。512f は budget 内 recovery（overrun 0）で無音落ちすら無し。64f は bounded spin が callback を timeout で頭打ち（deadlock 無し）・gap 中 数十 callbacks が glitch-to-silence（respawn 窓 ≈ 数十 ms）。**未証明**: plugin 内部状態（preset/automation）の復帰（child は stateless gain）。

**Verdict = FEASIBLE**（両ゲート PASS）。低 buffer の tail は既知・対処可能な設計制約で blocker ではない。**latency policy の fork（spike の output・事前に決めない方針どおり）= 「synchronous + child RT 優先度」 vs 「one-block-pipelined」**（どちらも本 spike では未計測の candidate・γ 実装で計測して決める）。verdict は `docs/development/POST_2.0_GAMMA_SANDBOX_SPIKE.md` に記録。advisor が verdict 解釈を確認（4 点の scoping 修正を反映）。`/simplify` + `/code:pr-review-team`（4 レビュアー）で全 Critical/Important を解消: input data race（live child が timeout 超過時の UB）を **1-outstanding request モデル**で構造的に排除・`measurement_invalid` sentinel で respawn 失敗/検知エラー/watchdog panic の誤データを可視化（authoritative に見える誤 go/no-go を防止）・`child_processed` の warm-up 汚染除去・p99 overflow saturation テスト追加。defer: event/param IPC・複数 plugin・境界越え automation・本番 daemon 統合（cutover #108）。

### 6.173 docs(engine): S1b-1 low-latency strict floor 32/64 frame verdict (#295) (Jun 27, 2026)

pre-γ hardening スプリント PR B（#295 = S1b low-latency strict test + dynamic hot-install follow-up）。owner 再パッケージで risky な #295 を #342 系から分離した独立 PR。

**重要な発見**: 計測ハーネス `orbit-clap-spike` は S1b-1（`--buffer-frames` で `BufferSize::Fixed` 強制）も S1b-2（`--hot-install-after-secs`）も**実装済**で、§13 が既に 128/256 frame を実証済。owner 拡張（2026-06-26）の **32/64 frame 実用下限**が未カバーだったため、それを埋める **計測 + verdict（docs-mostly・本番コード変更なし）**。

**計測**（MacBook Pro 内蔵 Output・arm64・macOS 26.5.1・44100Hz・`CLAPTestSynth` release dylib・8s）:
- release static: 256=8.8µs(0.15%) / 128=9.2µs(0.32%) / **64=9.2µs(0.63%)** / **32=6.3µs(0.87%)** — 全 `resize=0`・`xrun=0`・`peak=0.25`。
- debug worst-case: 64=27.4µs(1.89%) / 32=52.7µs(7.26%)。
- hot-install(release・+3s): 128=#1034/6.4µs / 64=#2069/13.5µs(0.93%) / 32=#4136/5.9µs — install 後発音・`resize=0`。

**verdict = PASS（強い余裕・リスク柵 不発火）**: device は 32 frame まで `BufferSize::Fixed` を honor（realloc 経路に到達せず）。release 32 frame で budget の 0.87%、worst-case でも 7.26%。hot-install ハンドオフは 32/64 でも成立。#295 のリスク柵「device が 32/64 を honor しない / 持続 xrun」は発火せず。

**精度フェンス**（過大主張回避・advisor 指摘）: ①低レイテンシは spike 経由のみ計測可（daemon は `BufferSize::Default` で buffer 非強制・spike-at-32 は同一 process 経路の proxy）②hot-install の daemon 実モデルは `clap_host_gated` が本筋、spike `--hot-install` は機構の二次 proof ③spike は `orbit-clap-host` でなく自前旧 host コピー（統一リファクタは本 PR スコープ外）。

**レビュー**: docs-mostly のため advisor 指針で軽量経路（comment-analyzer + advisor・/simplify + /code:pr-review-team は skip）。`clap_lowlatency_gated.rs` 等の新規 gated test は追加しない（spike が反復可能ハーネス・gold-plating 回避）。`docs/development/POST_2.0_A0_RT_INTEGRATION_DESIGN.md` §13「S1b-1 拡張」+ ヘッダ status + retired-assumptions 注記を更新。

### 6.172 chore(engine): rescan warn-only + teardown busy-wait verdict (#342-#2 / #342-#3) (Jun 27, 2026)

**Date**: 2026-06-27
**Status**: ✅ 実装完了（PR レビュー前）
**Branch**: `342-rescan-warn-teardown-verdict`
**Issue**: #342（項目2・項目3）
**スプリント**: Pre-γ hardening スプリント PR A（#342-2 + #342-3 を1 PR に束ね・owner 承認）。B = #295 は独立。

軽量 2 項目を1 PR に束ねた（owner 判断・§2 の「#342 を1 PR に束ねる」override）。リスクのある #295 とは切り離す。

**#342-#2: audio-port rescan warn-only（`orbit-clap-host/src/host.rs`）**
- `HostAudioPortsImpl::rescan`（AudioPortRescanFlags）は S1 で no-op（`is_rescan_flag_supported=false` 広告済）。
- plugin が動的にポートを変えると構築時固定の `is_effect`（`has_audio_input`）が陳腐化しうる。サイレントを避け **warn ログ1文**を追加して可視化（`flags` を Debug 出力）。
- **動的ポート対応そのものは作らない**（#342 項目2 の将来作業）。note/param rescan は対象外（is_effect 陳腐化は audio ports 固有）。

**#342-#3: teardown busy-wait は据え置き（verdict・`orbit-audio-daemon/src/clap_host.rs`）**
- `ClapTeardownGuard::drop` の `sleep(2ms)` poll は **変更推奨なし**（現結論）。guard は非 RT スレッド（`main()` 非 async）で走り、RT audio thread は `done` を atomic store するだけ。Condvar 置換は notify 時に RT thread へ mutex を強いて **RT を悪化**させる。
- 将来 async context から `StreamGuard` を drop する場合のみ async yield / atomic-wait に変える旨を**コードコメントで明記**（将来の誤った "fix" を防ぐ）。コード logic 変更なし。

**ローカル検証**: fmt（`--all --check`）clean / clippy（clap-host + daemon clap-host・`-D warnings`）clean / test（clap-host 11 + daemon protocol 19 ほか・0 failed。protocol の loopback bind は sandbox 制限で要 sandbox-off 実行）。

**レビュー（/simplify）**: 4 agent（reuse/simplification/efficiency/altitude）。reuse+efficiency+altitude が一致して **warn-once latch** を指摘（unthrottled warn は misbehaving plugin の繰り返し rescan でログ flood）。`OrbitHostMainThread` に `bool` フィールド `warned_rescan_unsupported` を追加し warn-once 化（main-thread 専用なので atomic 不要・`session.rs` の `device_lost_reported` 慣習を再利用）。host.rs コメントは warn メッセージとの重複を削り latch の根拠に絞った。clap_host.rs の #342-#3 verdict コメントは altitude が「load-bearing な anti-footgun・clean」と判定し維持（simplification の「1行圧縮」より altitude を採用）。

**レビュー（/code:pr-review-team）**: code-reviewer / silent-failure-hunter / pr-test-analyzer = **Critical/Important=0**。comment-analyzer のみ **Critical 1 + Important 2**（#342-#3 verdict コメントの事実誤り）を指摘し、一次情報で裏取りして全て採用・修正:
- **C-1**: 「`main()` の非 async スコープで drop」は誤り。`_stream_guard` は `async fn run()`（`#[tokio::main]` multi_thread・worker 2）末尾・`server::serve().await` 返却後に drop = **tokio worker の async context**。teardown 中 worker を最大 TEARDOWN_TIMEOUT(500ms) ブロックしうるが、通常は RT thread が即 `done` を立て数 ms で抜け・shutdown フェーズなので許容（`done` を立てる cpal callback は worker と独立で deadlock しない）→ コメント訂正。
- **I-1**: 「RT thread は `done` を atomic store するだけ」は過小。実際は stop_processing(CLAP 仕様=RT 必須)+buffers 解放+install ring drain も行う（processor.rs で確認）→ コメント訂正。
- **I-2**: 「Condvar は notify 時に RT thread へ mutex を強いる」は技術的に誤り（`Condvar::notify_one` は `&self`・mutex 保持不要）。真の RT 不適理由は notify の syscall(futex/psynch_cvsignal) レイテンシ → コメント訂正（code-reviewer は mutex 説を是としたが comment-analyzer が正しい・一次情報で裁定）。
- Minor 対応: pr-test-analyzer の「real plugin 不要で latch を単体テスト可」を採用し `rescan_warn_latches_after_first_request`（`AudioPortRescanFlags` を trivially 構築・UFCS 呼び）追加。silent-failure の「再要求 flags の観測性」を `else { tracing::debug!(...) }` で対応（warn flood 回避・debug は既定抑制）。
- 再検証: fmt/clippy clean・clap-host 12 + daemon protocol 19 ほか 0 failed。

### 6.171 fix(engine): drain install ring on teardown to prevent plugin-instance leak (#342-#1) (Jun 26, 2026)

**Date**: 2026-06-26
**Status**: ✅ 実装完了（PR レビュー前）
**Branch**: `342-install-ring-drain`
**Issue**: #342（#340 follow-on hardening・①install-ring teardown drain）

#340 review が「install-ring teardown drain / wrong-thread stop_processing 残余」を #342 に分離していた。
本 PR で一次情報（clack `f874e858` + rtrb 0.3.4）を精読し、**リスクの実体を確定**したうえで最小修正した。

**確定した実体 = wrong-thread UB ではなく「リーク」**:
- `StartedPluginAudioProcessor` は `Arc<PluginInstanceInner>` で `Drop` impl を持たない（process.rs:401）。drop は Arc 減算のみで plugin code を呼ばない。
- `PluginInstance::Drop`（plugin.rs:399-410）は **sole Arc owner のときだけ** teardown し、processor handle が残存すれば意図的に **leak** する（wrong-thread teardown を避ける clack の設計）。
- `PluginInstanceInner::Drop`（instance.rs:232-254）→ active なら `deactivate_with`（is_started なら stop_processing → deactivate → destroy）を **その drop が走るスレッド**で実行。
- rtrb `RingBuffer::Drop`（lib.rs:233-242）は未消費スロットを drop するが、Producer/Consumer 共有 Arc の **最後の drop 時のみ**発火。
- 帰結: Consumer（cpal `_stream`）が先に drop（refcount 2→1・未 drop）、Producer（clap・`host.shutdown()` の**後**）drop で初めて InstallMsg が drop される。よって `host.shutdown()`（= PluginInstance drop）時点で processor Arc が ring 越しに残存 → sole owner でない → **instance leak（deactivate/destroy 永久未呼出）**。
- 発生条件: plugin load → install 着地前に teardown（teardown 分岐が hot-install pop より前で early-return する窓）。狭いエッジだが実在のリーク。

**採用 A: drain-and-drop（owner 承認）**:
- cpal teardown 分岐で `drain_install_ring`（install ring を pop 全消費 → InstallMsg を cpal スレッドで drop = Arc 解放・benign）。
- これで `host.shutdown()` より前に processor Arc が解放され、`PluginInstance::Drop` が sole owner となって stop_processing+deactivate+destroy を **clap スレッド（= start_processing と同一）**で正常実行する。
- spec 記述「専用スレッドへ handoff」は Arc 解放による暗黙 handoff で達成（実 teardown は clap スレッド）。新規 channel 不要・最小差分。spec deviation は §1 rule に従い owner 承認 + 本ログで記録。

**テスト**:
- drain を generic 関数 `drain_install_ring<T>(&mut Consumer<T>)` に切り出し、`DropCounter` で「全 pop + 全 drop + ring 空」を決定論検証（real plugin 不要）。
- gated 実機 RUN（CoreAudio + test-synth/effect dylib）で正常 teardown 経路の非回帰を裏取り: synth peak 0.25 / effect ratio 0.50000・teardown panic/UB なし完了。

**ローカル全 green**: fmt clean / clippy `-D warnings`（clap-host + daemon clap-host）/ cargo test workspace 0 failed（新規 drain test 含む）/ gated synth+effect GREEN。

**CI（#326 で入れた Rust CI が #342-#1 を検証）**: `fmt / clippy / test`・`license / dependency gate`・`code-review` 3 チェックすべて SUCCESS。

**レビュー（/simplify + /code:pr-review-team）**:
- `/simplify`（4 agent）: drain_install_ring の戻り値 `u64`→`()` 簡素化（production で破棄・テストは DROPS+空で等価）/ Drop に install ring 非空検知ログ追加（altitude: 既存 plugin 検知と対称化）。reuse/efficiency は clean。
- `/code:pr-review-team`（code-reviewer / silent-failure-hunter / pr-test-analyzer / comment-analyzer）: **Critical=0 / コード Important=0**。code-reviewer は 4 観点（drain ordering・RT 安全・Drop スレッド・doc 正確性）すべて clack/rtrb ソースで検証。
  - 「Important」ラベル 2 件はいずれも doc/test-comment レベル: ① doc「Arc 減算のみ」が ordering-contingent（silent-failure I-1 + comment-analyzer）→ StreamGuard field 順 + host が Arc 保持の不変条件を doc に明記。② 実 leak シナリオは real plugin + 非決定 race で自動テスト不可（pr-test-analyzer・accepted structural gap）→ 単体テスト + gated テストに非カバー注記。
  - Minor 対応: Drop ログの因果文言是正 + `slots()` 占有数追加（code-reviewer + silent-failure M-2）/ 単体テストに empty-ring ケース追加。
  - 見送り: 正常経路 drain の silent 性への RT-path tracing（agent 自身の atomic 推奨と矛盾・benign event・Drop backstop で異常系は可視化済み）。

**advisor 収束相談（2026-06-26）**: 収束**確立**（第2フル ラウンド不要・provenance は transcript の skill 起動 + CI green on ccaa240・#326 と同論理）。**@claude bot = ordering 不変条件 + clack Drop/Arc 相互作用に絞った scoped review が妥当**との助言。

**@claude bot scoped review（2026-06-27・owner GO 後に起動）**: load-bearing な正当性（正常 teardown 経路）を一次情報まで降りて検証し **Critical/Important=0 で確認**。リーク解析（wrong-thread UB → leak 再フレーム）正しい / drain が `host.shutdown()` 前に走る（field drop 順 + `teardown_done` 後書きスピン）/ drain 時点で `PluginInstance` Arc 生存（refcount 0 非到達）/ drain は RT benign、すべて ✅。
- **bot の non-blocking 観察を post-bot advisor consult で精査 → bot の framing は誤りと判定**: bot は「panic-during-load corner はいずれの経路でも deactivate 未呼出 / 本 PR が新規導入したものでない」としたが、これは false。正しくは（advisor + 当方分析）**clap スレッドが load 中に panic した場合に wrong-thread deactivate の質が main（drain なし版 = `install_rx` drop）→ RT（drain 版 = audio thread）に変わる新挙動**。極稀（load 中 panic 要）+ 既存 panic-時 leak 病理に乗る + 正常経路では非発生 → #342-#1 スコープ外。**#342 項目4 として追跡**（コードで guard する場合は code change で再レビュー要）+ `drain_install_ring` doc に corner note 追記。
- **再レビュー不要（advisor）**: コード変更は doc コメント追記のみで load-bearing logic 不変。8-agent ループの再走は不均衡。マージは owner の明示指示待ち（self-merge 禁止）。

---

### 6.170 ci(rust): wire Rust workspace into CI — fmt / clippy / test / cargo-deny (#326) (Jun 26, 2026)

**Date**: 2026-06-26
**Status**: ✅ 実装完了（PR レビュー前）
**Branch**: `326-ci-rust-job`
**Issue**: #326（post-2.0 engine track / γ・cutover #108 前の hardening + CI 負債解消）

これまで CI は `code-review.yml`（npm/TS のみ）で **Rust を一切検証していなかった**。#340 で「CI green ≠ Rust 検証」が
繰り返し問題になった（gated 実機 RUN とローカル cargo が唯一の根拠）。本 PR で Rust workspace を PR ごとに CI 検証する。

**前提クリーンアップ（CI ゲートを green にするため必須）**:
- **fmt drift 19 ファイル**を `cargo fmt --all` で解消（Rust CI 不在で fmt が変更ファイルにしか当たっていなかった。
  `cargo fmt --all` は workspace-exclude の `orbit-link-audio` も整形＝CI の `--check` と一貫）。純整形コミットに分離。
- **clippy 警告**を解消（auto-fix: redundant closure / div_ceil / collapsible if 等 + 手動 3 件: orbit-clap-spike の
  `sort_by`→`sort_by_key(Reverse)` / `if x>0 {a/x}`→`checked_div().unwrap_or(0)` ×2）。挙動不変。

**workflow（`.github/workflows/rust-ci.yml`・2 job）**:
- `rust`（ubuntu）: libasound2-dev（cpal/ALSA）→ dtolnay/rust-toolchain@stable + Swatinem/rust-cache@v2 →
  `cargo fmt --all --check` / `clippy`（default & clap-host）`--all-targets --locked -- -D warnings` /
  `cargo test`（default & clap-host）`--locked`（gated は `#[ignore]` で自動 skip・CI に device 無し）。
- `cargo-deny`（ubuntu）: taiki-e/install-action → `cargo deny check`。default グラフ(link-audio off)が GPL-free を assert。

**スコープ判断**: GPL feature `link-audio`（build.rs が `target_os != "macos"` で error）は ubuntu でビルド不可かつ
GPL 隔離方針のため **CI では有効化しない**（default グラフ = permissive + cross-platform に保つ）。実機 gated テストは
CI で走らない（audio device 無し）。

**ローカル全 green 確認**: fmt clean / clippy `-D warnings` clean（default + clap-host）/ cargo test 全通過
（default + clap-host・非gated）/ cargo-deny `advisories+bans+licenses+sources ok` / `--locked` OK /
verify テストの WAV fixture は git-tracked（CI で `cargo test` 可）。

**CI が炙り出した harness bug の修正（#326 の価値そのもの）**: 初回 CI で `protocol.rs` の 7 テストが
**ubuntu のみ** fail（macOS ローカルは green）。全て実 `LoadSample`(kick.wav) 後のコマンド reply 待ちで
`common/mod.rs` の `recv_reply_with_events` が「64 messages 以内に reply 来ず」で panic。root cause は
**scan budget の数え漏れ**: `for _ in 0..64` が全メッセージを数える一方、`StreamStats`（1 Hz ticker が
`start_paused` の auto-advance で reply 前に積む noise）を budget から除外していなかった（コメントは
「budget 圧迫回避」を主張していたが events vec から外すだけで loop counter には効いていなかった）。
ubuntu の scheduling 差で reply 到達前に 64 を超過。修正 = **`StreamStats` を budget に数えない**
（非 StreamStats を 64 で cap・anti-hang の絶対上限 backstop 併設・reply 未達時は何を見たかを panic に出力）。
挙動は behavior-preserving（macOS 19/19・ubuntu は push で検証）。修正後 CI で `fmt / clippy / test` 1m43s green
（7 テスト含む全 19 が ubuntu でも pass）= 仮説確定。

**cargo-deny job の network 堅牢化**: 同 CI で `license / dependency gate`（cargo-deny）が 10s で fail。原因は
依存・config ではなく **crates.io sparse-index 取得の transient flake**（`cargo metadata` の index 更新が
HTTP2 framing / SSL unexpected eof）。`rust` job は rust-cache で registry が温まり network 依存が低い一方、
**cargo-deny job は toolchain/cache 無しで毎回 cold fetch** していた。対策: cargo-deny job に
`dtolnay/rust-toolchain@stable` + `Swatinem/rust-cache@v2` + `CARGO_NET_RETRY=10` を追加（registry を温め
cold fetch への露出を減らす）。修正後 CI で両 rust job + code-review すべて green（cold cache でも cargo-deny 通過）。

**レビュー（/simplify + /code:pr-review-team）**:
- `/simplify`（reuse/simplification/efficiency/altitude 4 agent）: reuse 1件適用（harness の `"StreamStats"` リテラル →
  既存 const `protocol::EVENT_STREAM_STATS`）。他は意図的な複雑さ（診断 state・二重 cap・YAML job 重複）として clean 判定。
- `/code:pr-review-team`（code-reviewer / silent-failure-hunter / pr-test-analyzer / comment-analyzer）: **Critical=0**。
  Important 3件を修正:
  1. (silent-failure) harness 診断: 別 ID reply で budget 枯渇時、reply は `event` を持たず `"<reply-or-other>"` の
     羅列になる → `event=<名>` / `reply(id=<id>)` を区別記録。budget/backstop も const 化（panic メッセージと同期）。
  2. (comment) `analysis.rs` / 3. `pan_real_wav.rs`: rustfmt 整列で設計根拠コメントが直前 `let` 行の trailing comment
     列に帰属して見える問題 → 空行挿入で独立コメント化（fmt 安定確認済）。
  - Minor: `protocol.rs` の `"StreamStats"` も const 化 / `config.rs` の不正確なソートコメント訂正
    （存在しない sample-rate ソートの記述を削除）/ workflow の retry コメントを具体値非依存に修正。
  - 見送り（理由付き）: teardown timeout backstop（現 count backstop で十分）/ `deny.toml` の `unknown-git`
    （#326 スコープ外・clack git dep に warning が出る恐れ）/ `workflow_dispatch`（GitHub UI の Re-run で代替可能・前提誤り）。

---

### 6.169 feat(engine): daemon CLAP integration — in-process plugin hosting (#340) (Jun 26, 2026)

**Date**: 2026-06-26
**Status**: ✅ 実装完了 + pr-review-team round 2 + @claude bot で Critical/Important=0 収束（gated 実機テスト 2 本 GREEN・owner マージ待ち）
**Branch**: `340-daemon-clap-integration`
**Issue**: #340（post-2.0 engine track / Epic #292・Path A = γ の前提 + cutover #108 の背骨）

spike で実証した in-process clack-host を本番 daemon `orbit-audio-daemon` に統合し、effect plugin が
daemon 経由で RT-safe に audio を加工できるようにした。**Step0 検証 = COMMIT 判定**（fork せず）:
spike の「Mutex vs lock-free」前提は古く、両経路とも `engine.render` の同一 `try_lock` を通り plugin は
構造上 Mutex-free。clack は pre-1.0 だが git pin で clean build。effect 型 CLAP plugin も最小実装で成立。

**アーキ（clack 境界）**: native は permissive な mixing core を保ち clack に依存しない。`PostProcessor`
trait（`&mut [f32]` を in-place 変換）を native に置き（既存 `PostMixSink`/`AudioBackend` inversion を
踏襲）、clack 実体は permissive crate `orbit-clap-host` に隔離。daemon が `clap-host` feature 配下で
`ClapHost`(!Send) を**専用 OS スレッド**で所有し、plugin の hot-install は wait-free ring 経由で audio
thread に渡す。

**effect topology（serial insert）**: instrument（parallel add-mix）と区別。
- `HostAudioBuffers::has_audio_input`（audio 入力ポートの有無）で経路分岐。
- effect: engine の interleaved 出力を plugin の planar 入力へ de-interleave コピー
  （`set_input_from_interleaved`）→ process → 出力で hardware sum を**上書き**（`replace_cpal_buffer`）。
- instrument: 入力を無音化（`set_input_silent`）→ process → 出力を add-mix（`add_to_cpal_buffer`）。
- mux/downmix は `fill_muxed_from_main_output` に集約し add/replace で共有。

**carry-forward 3（A0 §13・RT 正確性）= 解決**:
1. teardown は StreamGuard の field drop 順で強制（`ClapTeardownGuard` が audio thread で
   `stop_processing` → stream 停止 → 専用スレッドで instance deactivate）。**通常 teardown 経路の**暗黙 Drop の
   wrong-thread stop_processing（strict plugin で UB）を回避。⚠️ shutdown + device-loss + install-race が
   同窓で重なる narrow 残余（install ring の未消費 `InstallMsg` が非 RT スレッドで drop）は本 PR では未解決・
   追跡 issue #342 の focused follow-on PR で対応（両レビューが Minor 認定・実害極小）。
2. `request_callback` は `Arc<AtomicBool>` で lock-free（mpsc の alloc+mutex を排除）。
3. CLAP `EventBuffer` は ring capacity でサイズ固定し RT realloc を防止（debug_assert で検出）。

**Done 証拠（実機 gated・A0 §6: CoreAudio+cpal は xrun 不発火 → RT 健全性は callback 実測時間）**:
- effect gated（`clap_effect_gated.rs`・two-phase ratio）: baseline 0.70711 → effected 0.35355 =
  **ratio 0.50000**（EFFECT_GAIN=0.5 ちょうど）。入力配線死=~0 / replace 欠落=~1.5 を判別する設計で、
  de-interleave 入力 + replace 出力の両方が機能している証拠。callback max 859µs（budget ~10.8ms の ~8%）。
- synth gated（`clap_host_gated.rs`・PR1 回帰）: post_mix_peak 0.25・callback max 449µs。
- cargo workspace 全 green / clippy・fmt clean / npm 1188 passed（SC default path 不変）。

**スコープ外（fence）**: γ の out-of-process sandbox は対象外（次フェーズ）。`link-audio` と `clap-host`
は当面排他（1 callback での render 順序統合は defer・`compile_error!` で弾く）。audio `play()` 意味論・
SC default path は不変。

**/code:pr-review-team（4専門・round 1）**: code-reviewer/silent-failure-hunter/pr-test/comment を並行起動。
Important 修正 = effect process 失敗時の 1-block 無音化（`process_ok` で出力配線を gate し失敗時は dry 素通し）/
`ClapPostProcessor` Drop で plugin 残留を error log（carry-forward #1 検知点）/ double-load guard
（`AlreadyLoaded`）/ `parse_midi_channel` レンジ検証 / eprintln→tracing / mutex-poison を warn で区別。
test 追加（非ステレオ mux ×5・post_peak 不変式・CLAP error code/channel）。**Commit 8fa7c41**。

**/code:pr-review-team（4専門・round 2）**: round-1 で足した新規コードを再レビュー。**Critical 0 / Important 3**:
1. (code-reviewer opus) `config.rs` `main_port_index` が CLAP ループ index を保存するが `discovered` は
   `get()==None` をスキップした filtered list → 早いポート欠落 + 後のポート IS_MAIN で境界外参照 → audio
   thread（cpal C callback）で panic = プロセス abort。push 直前の `discovered.len()` を保存して修正。
2. (silent-failure-hunter opus) `process_error_count` が production で write-only（誰も読まない）→ effect=dry /
   instrument=無音 の失敗が不可視。既存 1Hz ticker に `CLAP_PROCESS_ERROR` WARNING を配線
   （`LINK_EGRESS_DROP` パターン踏襲・defer せず実配線）。
3. (pr-test-analyzer) `ClapTeardownGuard` timeout 経路に unit test 欠如 → 実 plugin 不要の timeout/early-exit
   test 2 本追加（deadlock 防止保証・while 条件反転検知）。
Minor 採用: velocity を 0.0..=1.0 に clamp / pre-load note が黙って drop される旨の doc note / gated に
double-load `AlreadyLoaded` assertion / コメント正確性 3 件（`Sender` は Send+Sync で Mutex 理由は rtrb
`Producer` の `&mut`+`!Sync` / carry-forward #1 は本 PR で解決済み・TODO 文言修正 / config warn 括弧は input
fallback のみ該当）。3 経路（effect-error-bypass / double-load / Drop-log）は全レビュアーがコード精読で正しいと
確認・clack source で carry-forward #2/#3 を裏取り。**CI は Rust を実行しない**（npm のみ）ため検証はローカル
cargo + gated 実機 RUN が根拠: clap-host 10 + daemon lib 8（新 teardown ×2 含む）+ 統合 18 + smoke/pcm green・
clippy 新規警告0・fmt clean・gated effect ratio 0.50000（callback_max 481µs）/ synth peak 0.25（263µs）。

**advisor checkpoint ②（Done 宣言前）**: round-2 で足した `CLAP_PROCESS_ERROR` ticker 配線が「全 ticker
DaemonError は注入 seam + テストを持つ」というコードベースの慣習を破っていた（`LINK_EGRESS_DROP`/xrun/device_lost は
全て seam 付き）→ 注入カウンタ `clap_process_errors`（本番常に 0）+ `clap_process_errors_arc()` seam +
`daemon_error_warning_on_clap_process_error` 統合テスト（発火 + 累積数 + latch 非再発火・両 feature config pass）を
追加（`40d0f6f`）。daemon lib 8 + protocol 19 green。

**@claude bot second-opinion（load-bearing seam `8fa7c41..40d0f6f`）= Critical/Important 0**: 4 重点領域
（main_port_index index 修正 / `CLAP_PROCESS_ERROR` 配線 / teardown seam / effect-instrument routing）と 3 proof-only
経路（effect-error-bypass / double-load / Drop-log）を独立精読し、内部 pr-review-team の評価と一致を確認。CI(npm)
`code-review pass`（40d0f6f）。**申し送り Minor 3 件 → 追跡 issue #342**（cutover #108 前の CLAP-hardening: ①install-ring
teardown drain で wrong-thread stop_processing 残余ケース ②動的ポート rescan ③async teardown 時の busy-wait）。

---

### 6.168 docs(notation): MLTS real-time score-display design note (#339) (Jun 26, 2026)

**Date**: 2026-06-26
**Status**: ✅ 設計記録（discussion record・実装なし）
**Branch**: `337-mixer-dsl-design`（docs のみのため同ブランチに同梱・owner 指示）
**Issue**: #339
**成果物**: `docs/development/POST_2.0_NOTATION_DSL_DESIGN.html`

post-2.0 のリアルタイム/静的 譜面表示（MLTS notation）の設計をブレストし記録。三輪氏（音楽家）の
「譜面表示できる？」が発端 → 本物の五線譜が要る・Pitch DSL のみ対象。

**核心 = MLTS（Multi-Layered Temporal Structure）**: 層ごと beat/tempo 独立で小節線が非整列にずれ込む
（polymeter）。現代西洋記譜は共有小節線前提で、VexFlow 素・OSMD・Verovio・MusicXML・LilyPond でも
native に書けない → レンダラ自作必須。

**ライブラリ判断 = VexFlow**（MIT・programmatic で小節線を自前配置＝MLTS に必須・active v5・SVG+CSS アニメ）。
OSMD 不採用（MusicXML/整列小節前提・VexFlow の上）/ Verovio 不採用（LGPL+整列前提+WASM 重）/ publication=
LilyPond だが MLTS は LilyPond でも frontier → MLTS は拡張 VexFlow が正攻法（live+publish 統一）。

**real-time = 自前**（engine が timing 駆動・VexFlow は描画+カーソル overlay・cursor は transport から駆動）。
**データブリッジ = engine 非依存**（interpreter getState の timedEvents+pitch / resolveDegree / per-seq
beat/tempo/length / transport / midi-run / isMidi・最小は polling+WS で core 改変ゼロ）。

**home（後決め・優先は engine cutover）**: 2.0.0 .vsix には載せない / engine 完成後 2.1.0 .vsix で engine
切替 → OrbitStudio を待たず可能性 or OrbitStudio パネル。notation は engine 非依存で home 柔軟。
**当面の優先 = engine cutover（Path A→γ→#108）**。notation build は cutover 後。

**研究新規性**: MLTS 記譜に標準なし → 視覚言語の設計自体が貢献（論文の芽）。

**スコープ**: 本エントリ = 設計記録のみ・実装なし。明日 demo の最小スクリプト（pitch DSL→VexFlow 静的描画）は
gauge-by-progress の脇 spike（engine 開発を邪魔しない範囲・scratchpad）。

### 6.167 docs(engine): mixer / routing / effects / automation / module DSL design note (#337) (Jun 24, 2026)

**Date**: 2026-06-24
**Status**: ✅ 設計ノート作成（discussion record・実装なし）
**Branch**: `337-mixer-dsl-design`
**Issue**: #337
**成果物**: `docs/development/POST_2.0_MIXER_DSL_DESIGN.html`（手書き HTML・既存 specs スタイル）

post-2.0 engine track の **DSL 側未設計領域**（mixer / routing / effects / automation / module）を
owner とブレストし、設計ディスカッション記録として HTML に固定した。engine 側ホスティング（γ/δ）は
`POST_2.0_NEXT_STEPS.html` §3 にあるが、それを DSL からどう叩くか（plugin 呼び出し / effect chain /
send-return / aux / automation / ファイル分割）は未設計だった。

**統合軸**: **reconciliation key = 名前**（宣言的グラフ + 名前キー差分適用。routing / effect ハンドル /
module identity / recovery を束ねる）。

**確定**（このブレスト）: ルーティングの向き=常に source が行き先を指す / routing 4 ノード（source・
sum(group)・aux(send-return)・output(終端)）+ output 2 ドメイン（audio / data=IAC）/ chain 順=信号フロー
（source 先頭・inst=音源置換・play=パターン直交・send 位置=tap）/ automation 3 層（時間決定論 pre-render /
control-rate signal modulation / semantic=north-star 対象外）/ Global 2 分割（project=永続グラフ /
performance=live param tempo 等）/ SOLO(a,b,c)=集合キーワード（RUN/LOOP/MUTE の group-diff 再利用・
multi-solo がタダ）/ mixer 未挙げ項目 全部 in（solo・sidechain入力・PDC・metering・nesting）/
capture seam の用途 3 つ（検証・recovery ギャップ・render/mastering）/ VST は format-agnostic DSL で δ で差込。

**未決 / OrbitStudio-era / engine 必須**は HTML §11 決定台帳に仕分け記録。

**プロセス**: docs-only のため full PR レビュー（simplify + pr-review-team）はオーバーエンジニアリング
（CLAUDE.md）→ スキップ。正規仕様化・実装は別 issue。HTML は well-formed 検証済。

### 6.166 test(engine): A4-PR4 active-loops across-respawn e2e — full DSL / interpreter-driven (#335) (Jun 23, 2026)

**Date**: 2026-06-23
**Status**: ✅ 実装完了（レビュー前）
**Branch**: `335-active-loops-across-respawn-e2e`
**Issue**: #335（A4 PR4・#321 の 4-PR 計画の最終手）
**正本**: `docs/development/POST_2.0_NEXT_STEPS.html` §4（A4 末）/ §5（active-loops follow-up 行）

A4 の最後の1手。#300（recovery floor）が proxy + 構造論で足りるとして**意図的に defer** した
「実 `loop()` を interpreter 駆動で動かし real daemon を respawn 跨いで継続する」検証を、
A4 完了時点で full DSL 全部入りで consolidation する（recovery consolidation・defer backlog 一掃）。

**スコープ（test-only・production 変更ゼロ）**:
- 既存 `tests/audio/rust-engine/real-daemon-recovery.spec.ts`（#300 gated kill-test）を **scaffold に拡張**。
- 実 `InterpreterV2` に、onDispatch を得るために直接構築した実 `RustEnginePlayer` を注入
  （= `createAudioEngine(rust)` と同じ player・leg2 の RecordingScheduler 注入と同じ seam）。
  spec の「createAudioEngine 経由」= 実 interpreter + 実 player 経路の意（§4/§5 を spec-first で明確化）。
- fixture = full DSL（pan / chop 領域 / per-event gain / **varispeed rate≠1.0** / LinkAudio output
  channel / tempo leader）の `LOOP()` を回す `.orbs`。

**scout question の結論（observability seam）**:
- `daemonPid` / `getDaemonStatus()` / `injectDaemonFault()` / `isRunning` は player に public 既存・
  `onDispatch` も options に既存 → **観測 seam は既存**（§6 の production 追加例外は不成立）→ test-only。
- 観測境界: `DispatchInfo` は timing + `gain` + sample のみ surface。**pan / rate / output_channel は
  `daemon.playAt` へ渡り respawn 跨ぎで exercise されるが onDispatch/GetStatus に出ない**ため値は
  state-assert しない（per-param 正しさは PR1-3 offline + 下記 rate guard が担保・capture は §6 で OUT）。

**テスト構成（2 層）**:
- 非gated（CI 常時・daemon 不要）= fixture-integrity guard: RecordingScheduler で interpreter の
  スケジュールを取り、`toDaemonParams` で **chopd=varispeed rate 2.0 / kick・snare=rate 1.0 /
  pan 3 値 / gain 3 値** を機械チェック（"full DSL" 主張が hollow にならない保証）。
- gated（`ORBIT_REAL_DAEMON=1`・ローカル）= recovery e2e: LOOP() → 実 daemon SIGKILL（mid-loop）
  → auto-respawn → **dispatch 継続を state-level に assert**（liveness/新 pid / transport 再 anchor /
  onset clip なし / 複数 sample で loop 群復帰 / per-event gain 保持 / fresh daemon 状態）。
- daemon は default build（feature `link-audio` OFF）。setLinkTempo / output channel は warn-once
  no-op（hardware bus へ）で loop を stall させないことを実機で確認（LinkAudio 自体の recovery は
  観測 seam 不在のため非検証）。

**検証**:
- gated kill-test を **ローカルで 3 回連続 PASS**（各 respawn attempt 1/5・~5.6s）。
- 非gated guard PASS / npm 全緑（**1188 passed | 28 skipped**）/ cargo `--workspace` 全緑（rust 無変更）。
- SC 既定経路 無改変 / audio `play()` 意味論 無改変 / production code 無変更。

**主な変更ファイル**:
- `tests/audio/rust-engine/real-daemon-recovery.spec.ts`（#335 拡張・非gated guard + gated e2e）
- `docs/development/POST_2.0_NEXT_STEPS.html`（§4/§5 を「createAudioEngine 経由」= 実 player 注入と
  spec-first で明確化・"stretch"→"varispeed"）

A4 完結（PR4 マージ）で #300/#304 の defer backlog は一掃（残るは capture seam と bot Finding 4
= quit backoff の 2 件のみ・いずれも trigger 待ち）。

**レビュー（/simplify）**: 4 cleanup agent（reuse/simplification/efficiency/altitude）適用 —
recovery 不変式を `assertRecoveryInvariants` ヘルパに抽出（#300 runKillTest と #335 で共有・
~25 行重複を解消）/ 非gated guard の `toDaemonParams` を play ごと 1 回にキャッシュ。
skip: 公開 `dispose()` 追加（§6 scope fence = 観測 seam でなく lifecycle・cast は shutdown.ts 前例で
許容）/ `if(!preKillPid)throw`（dead でなく TS narrowing・コメント追記）。適用後 gated 4 テスト全緑。

**レビュー（/code:pr-review-team）**: 4 専門 reviewer（code-reviewer/silent-failure-hunter/
pr-test-analyzer/comment-analyzer）。Critical 0。Important 3 を解消 →
① afterEach を try/finally 化（seq.stop() throw 時も実 daemon を quit・leak 防止）/
② recovery wait を件数（killMark+N）から **sample 多様性（3 seq 全復帰）** に直結し `postSamples===3`
（chopd が 8 ev/bar と密で件数 wait だと kick/snare 復帰前に満たされる decoupling を解消・flake 除去 +
全 loop 復帰を検証）/ ③ chop(1) は slice 経路を bypass する旨へコメント修正（comment-analyzer）。
併せて Minor: uptime 判定を wall-clock 経過基準へ（長い recovery 待ちでの margin 痩せ対策）/ teardown
cast を不在 throw + `?.` 除去で silent-skip 防止 / pan を厳密値 set で固定 / "per-event"→"per-sequence"
gain ラベル統一。skip: post[0] stale（SIGKILL 即時で sub-ms 窓・post[0] discriminator 維持）。
適用後 gated 4 テスト全緑（#335 stricter `===3` を複数回安定 PASS）。

### 6.165 feat(engine): A4-PR3 Link tempo leader — Rust daemon + TS wire (#333) (Jun 23, 2026)

**Date**: 2026-06-23
**Status**: ✅ 実装完了（レビュー前）
**Branch**: `333-linkaudio-tempo-leader`
**Issue**: #333（A4 PR3 Link tempo leader）
**PR**: #334

`global.tempo()` を Ableton Link セッションに push し OrbitScore を Rust 経路
（`ORBITSCORE_ENGINE=rust`）の Link tempo leader にする。SC 経路は既に動作中（#283）で、
本 PR は Rust 経路の no-op を実装して parity を埋める（net-new・新規 GPL 面ゼロ）。
tempo FFI（`set_tempo`/`session_tempo`）は A4-2b で GPL 隔離 crate に既存だったため、
残作業は wire + handle-ownership/threading + tempo-change re-anchor に絞られた。

**Rust 実装（threading seam・Opus 直列・advisor 設計確認済）**:
- **論点1 handle 共有 = 案A + newtype**: `orbit-link-audio/src/lib.rs` で `LinkAudioOutput` を
  `Arc` 共有可能化（`unsafe impl Sync` 追加・SAFETY を「app-state path=control / audio-state
  path=consumer の disjoint thread role を Link が内部同期」で根拠付け）。control 側は
  `LinkTempoControl(Arc<LinkAudioOutput>)` newtype で `set_tempo` のみ公開し audio-state
  メソッド（commit/capture_beat/session_tempo）を型レベルで隠蔽（`set_tempo` は `pub(crate)`）。
- **論点3 re-anchor = poll-based**（advisor が当初の explicit 推奨を撤回）: `egress.rs` で consumer が
  毎 pump `session_tempo()` を poll し、変化検出で segment baseline（`seg_anchor_beat`/
  `seg_anchor_produced`/`beat_per_frame`）を切り替える。Link は last-setter-wins なので自分の push も
  他ピア（Ableton 等）の変更も追従する（explicit を包含・control→consumer 同期配線不要）。**`capture_beat()`
  を再呼びしない**連続 carry（ring latency 位相誤差の再導入を回避・advisor の load-bearing detail）。
  境界での beat 連続 + slope 変化を単体テストで固定（`reanchor_is_beat_continuous_and_changes_slope`・
  `reanchor_slowdown_reduces_slope_but_keeps_continuity`）。
- **論点2 blocking = spawn_blocking**: `session.rs` の `SetLinkTempo` arm が `set_tempo`（内部
  `captureAppSessionState`・非RT・block しうる）を LoadSample と同様 spawn_blocking で隔離する
  （tokio worker を塞がない・app-state path を audio スレッド外で実行する Link 制約も満たす）。
- daemon `link_audio.rs`: `LinkAudioControl` が `LinkTempoControl` を保持、`consumer_loop` は
  `Arc<LinkAudioOutput>` を所有（teardown = `orbit_link_destroy` は app-side cleanup〔enable(false)+
  delete〕で audio-thread 非依存＝shim 確認済のため、last-Arc-drop が consumer 外でも安全）。
  `engine_wrap.rs`: `set_link_tempo(&self)`（feature 有 = `as_ref` で `set_tempo` / 無 =
  `LINK_AUDIO_UNAVAILABLE` stub）。
- **lifecycle 決定（MVP）**: tempo-lead は Link subsystem up（feature `link-audio` 起動・
  `LinkAudioControl` spawn 済）を要する。active channel 0 でも可。channel 完全非依存の単独 leader への
  decouple は defer。
- **license**: tempo API は既に `orbit-link-audio` 内＝**新規 GPL 面ゼロ**。`cargo deny check licenses`
  ok（default graph GPL-free 維持）。

**Rust テスト**: `orbit-link-audio` 9 passed（re-anchor 連続性 2 件含む）/ daemon lib 6 passed +
integration 18 passed / `cargo test --workspace` 緑。

**TS 実装内容**:
- `protocol-types.ts`: `CommandMethod` union に `'SetLinkTempo'` を追加（Rust daemon 名と一致）
- `daemon-client.ts`: `setLinkTempo(bpm: number)` メソッドを追加 — `this.request('SetLinkTempo', { bpm })` パターン
- `rust-engine-player.ts`: `GapKind` に `'linkTempo'` 追加・`freshWarned()` に `linkTempo: false` 追加・`setLinkTempo` no-op を実装に差し替え（`LINK_AUDIO_UNAVAILABLE` = warn-once 握り潰し、`LINK_AUDIO_RUNTIME` = rethrow）
- `mock-daemon-server.ts`: `MockDaemonHandlers` に `SetLinkTempo?: MockHandler` 追加
- `daemon-client.spec.ts`: 2 テスト追加（bpm params 送信・UNAVAILABLE 変換）
- `rust-engine-player.spec.ts`: 3 テスト追加 + defaultHandlers に SetLinkTempo デフォルト追加（registerLinkAudioChannel と対称）

**技術的決定**:
- GapKind を `'linkTempo'` で分離（`outputChannel` と共用しない）— channel 登録と tempo push は独立した warn サイレンス単位
- defaultHandlers() の SetLinkTempo デフォルトが LINK_AUDIO_UNAVAILABLE を投げる — boot() 単体で warn-once パスを自動カバー
- Rust 側依存点: method 文字列 `'SetLinkTempo'`・params `{ bpm: number }` が確定済みインタフェース

**テスト結果**: 全 1187 テスト green（27 skipped は既存）

**レビュー（/simplify・4 観点並列）**: reuse / altitude = clean（altitude は poll-based re-anchor を
「the strongest altitude win」と評価）。適用 2 件:
- **simplification**: egress.rs の anchor / re-anchor が同じ 4 フィールド更新を重複 →
  `start_segment(anchor_beat, produced, bpm)` ヘルパに集約（segment invariant を 1 箇所に）。
- **efficiency**: `session_tempo()` を per-channel `pump_once` で N 回読んでいた → consumer_loop の
  round ごと 1 回に hoist し `pump_once(&output, session_tempo)` へ snapshot を渡す（session-global な
  値の N FFI reads/round → 1・correctness は各 channel が自分の `last_bpm` と比較で保持）。
- skip: F-1（commit 内の二重 `captureAudioSessionState`・ABI 変更が要る design-level・informational）/
  エラー文字列重複の const 化（never-parsed の cosmetic）/ `set_link_tempo` の mutex lock（tempo 変更は
  稀で benign・audio-side disjoint は無傷）。
- 適用後: orbit-link-audio 9 passed + daemon lib 6 passed + clippy clean（diff 内）。

**レビュー（/code:pr-review-team・4 agent 並列 + CI）**: CI green（Build / code-review）。Critical 0。
Important 6 件を fixer で解消（advisor 確認後）:
- **SF-1（silent-failure）**: shim `orbit_link_set_tempo` が void で **false-positive success** → `int` 返り値化し
  `LinkAudioOutput::set_tempo -> bool`・`false` を `WrapError::LinkAudio`(runtime) に昇格。push が silent fail
  すると MIDI（`global.tempo()` free-run）と Link-audio egress（古い session tempo を poll）が別 tempo に乖離
  するのを防ぐ。既存 `LINK_AUDIO_RUNTIME` taxonomy に乗る・**新規 GPL 面ゼロ**。
- **CR-1（code-review）**: `commit_channel`/`capture_beat` を `pub(crate)`（egress.rs のみ）。`session_tempo`/
  `register_channel`/`set_enabled` は cross-crate で daemon が呼ぶため `pub` 維持。SAFETY コメントを
  「型で締まる分（pub(crate)）」と「呼び出し規律で守る分（pub・consumer/control thread）」に正直に書き分け。
- **CR-2**: bpm に sanity 上限 `MAX_LINK_BPM=999`（`+Inf` 伝播 / `beat_per_frame` overflow 防止・下限なし）。
- **CM-1（comment）**: /simplify の hoist で stale 化した struct doc（「tempo poll は pump_once」）を修正。
- **PT-1（pr-test）**: re-anchor trigger を pure `reanchor_beat_on_change` に抽出し device-free に sequence
  テスト（anchor→steady→change→epsilon→capture 例外。trait/mock は over-engineering として回避・advisor）。
- **PT-2**: `validate_bpm` を pure 抽出 + 単体テスト。
- comment 改善 3 件（SAFETY に `session_tempo` Thread-safe:no 追記 / teardown コメントを「最後の Arc」/
  engine_wrap の `as_ref` を interior mutability 説明に）。
- 検証: orbit-link-audio 10 + daemon lib 7 + integration 18 passed・clippy clean（diff 内）。
- **再レビュー（silent-failure + pr-test 再実行・advisor 指示の one-time closure check）**: SF-1 / PT-1 / PT-2 すべて
  **resolved** を再確認。新規 SF-2（global.ts:265 の `.catch` が opaque log）は **defer**: `DaemonProtocolError` が
  `super(`[${code}] ${message}`)`（errors.ts:45）で code+message をレンダーするため既に有用＝opaque でない。warn-once
  再設計は never-path（set_tempo は no-peer でも success・Link 例外でのみ false）への過剰設計 + global.ts は SC/Rust
  共有のため **reject**（advisor）。SF-3（pre-existing・Minor）= shim `orbit_link_session_tempo` の catch に fprintf を
  追加し set_tempo と observability を対称化（1行）。SF-4 benign（None は production unreachable）。**内部レビュー
  closed**（毎修正後の再レビューは LLM が必ず新指摘を出す非終了ループ＝substance 収束で閉じる・advisor）→ 外部
  closure は @claude bot（load-bearing seam: unsafe Sync の call-discipline / FFI bool contract / poll re-anchor）。
- **外部レビュー（@claude bot・load-bearing seam スコープ・3m57s）**: 3 点すべて ✅ 問題なし — ① `unsafe impl Sync`
  健全（型レベル + 抽象層で cross-thread 誤呼びが閉じている）② FFI bool contract end-to-end（false-positive success
  なし・false は全段 rethrow・ピン留めテスト付き）③ poll re-anchor continuity（tempo 変化点で `new_anchor` が旧 slope の
  beat と同値＝数学的に連続・`capture_beat()` 非再呼びで ring-latency 誤差を再導入しない）。実質的 blocking なし。唯一の
  minor = SAFETY コメントに `num_peers`（test-only・Thread-safe:yes）が未言及 → 1 行追記で対応。**Critical/Important=0・
  bot 承認**。owner マージ待ち（self-merge しない）。

### 6.164 feat(engine): A4-2b-2b dynamic N-channel LinkAudio registration (pool + readiness race / #331) (Jun 23, 2026)

**Date**: 2026-06-23
**Status**: 🚧 WIP（core N-channel egress 実装完了・実機 multi-channel 層B PASS）。branch `331-linkaudio-dynamic-registration`（未マージの 2b-2a #330 にスタック）
**Parent**: #331（design 決定は issue コメント）/ 2b-2a #330（owner マージ待ち）

**スタック注意**: 本 branch は未マージ・owner 未承認の #330（`329-linkaudio-egress-rtrb`）上にスタック。owner が 2b-2a をレビューで変更したら rebase する。

**design-first（advisor 2 round）の 2 決定**:
- **Fork 1（RT-safe N-slice）= ArrayVec**: callback で render_multi 引数 `&mut [(&str,&mut[f32])]` を per-callback stack `ArrayVec<_, MAX_LINK_CHANNELS>` で組む（fresh local＝call-body lifetime で借用が通る・heap alloc なし）。「closure 所有・clear 再利用 Vec」は **コンパイル不可**（captured Vec は固定 lifetime・`&mut` invariant）。core API 追加も棄却（core が native 型 `LinkChannelActivate` を知ると permissive 境界を汚す）。**gating spike**（`arrayvec_n_channel_slice_builds_from_pool_without_heap`）で call-body `&mut` 借用を実証済。`arrayvec` は MIT/Apache。
- **Fork 2（readiness race）= readiness flag**: load-bearing は benign window でなく **never-drained ring**（consumer が登録しない slot に callback が push・partial-failure で N では reachable）。per-slot `Arc<AtomicBool> ready` を consumer が **Link 登録完了後に set**、callback は ready の channel のみ render_multi/commit 対象にする → never-drained-ring が**構造的に不可能**（登録失敗→ready 立たず→push せず）。コスト = slot ごと relaxed load 1 回。

**実装**:
- native `output.rs`: `LinkChannelActivate` に `ready: Arc<AtomicBool>` / `LinkEgress { channel: Option } → { channels: Vec }`（cap `MAX_LINK_CHANNELS`=64 で control 強制・callback で log しない＝RT 安全）/ `render_block` を ArrayVec N-channel + skip-not-ready 2-pass（render_multi → 借用解除 → sink commit）。link 有り時は 0-ready でも `render_multi(hw, &[])`（`engine.render` に落とすと channel-tagged event が hardware に bleed）。`pub const MAX_LINK_CHANNELS`。
- orbit-link-audio `egress.rs`: `LinkChannelEgress` の **`LinkAudioOutput` 所有を解消**（consumer thread が 1 output を持ち複数 egress を回す）・`pump_once(&mut self, output: &LinkAudioOutput)`・**per-channel anchor を維持**（各 channel が自分の first-pump で capture・session 単位に hoist しない＝advisor Point 2）。
- daemon `link_audio.rs`: `consumer_loop(output, ...)` が `Vec<LinkChannelEgress>` を保持、register cmd で Link 登録→egress push→**ready.store(true)**、全 egress を pump。`LinkAudioControl.registered: HashSet<String>`（冪等）+ cap（`ChannelLimit` error）。`RegisterCmd`/`LinkChannelActivate` に `ready` 共有。`ConsumerState` 状態機械を削除。
- **検証**: full workspace 19 ok・cargo-deny default GPL-free 維持・clippy clean・**multi-channel 層B 実機 PASS**（`layer_b_multi_channel_egress_received`: 2 channel 登録→各 receiver が独立に kick.wav egress 受信・1.7s）+ 単一 channel 層B（2回登録冪等）も維持。

**error-code 分割（本 commit・#329/#331 follow-up を解消）**: `WrapError` を `LinkAudioUnavailable`（feature `link-audio` 無効ビルド / test backend）と `LinkAudio`（runtime 失敗 = `ChannelLimit`/`RegRingFull`/`ConsumerGone`/mutex poison）に分割。`session.rs` が前者を `LINK_AUDIO_UNAVAILABLE`・後者を `LINK_AUDIO_RUNTIME` に map。TS `rust-engine-player.ts` は **`LINK_AUDIO_UNAVAILABLE` のみ** warn-once で握り潰し、`LINK_AUDIO_RUNTIME` 他は rethrow（N-channel で ChannelLimit が reachable 化＝runtime 失敗を feature-gap と誤認しない）。これで S3 が runtime まで含めて完成。test 更新（mock 既定 = UNAVAILABLE / player は UNAVAILABLE 握り潰し + RUNTIME rethrow / daemon-client）。stale な `LINK_AUDIO_ERROR` コメント 4 箇所も更新。TS build 緑・全 spec 緑（52 + 全 1179 passed）。

**PR #332**（base=`329-linkaudio-egress-rtrb` にスタック）作成 → **/simplify 適用**（`b2c2736`: per-channel commit_fail_streak バグ修正〔channel-global は masking〕+ render_block 述語 hoist + overflow debug_assert）→ **pr-review-team 2 round で収束**: round-1 = code-reviewer 0 Crit/Imp（readiness flag Relaxed 順序・two-pass 整合・error-code split 全 clean）/ pr-test-analyzer 3 Important test gap → pure 関数抽出（`channel_egress_active`/`registration_decision`）+ 単体テスト + `wrap_err_to_protocol` テストで解消（`61c6c3c`）/ silent-failure Minor（warn を channel 名に・`channel_id()` 削除）/ comment-analyzer 2 Important + 1 Minor コメント修正（`1367a0e`）。round-2 = code-reviewer + pr-test-analyzer とも **収束確認・0 Crit/Imp**。CI green（`61c6c3c`）・full workspace 19 ok・cargo-deny GPL-free・TS 1179 passed・multi-channel 層B 維持。

**@claude bot（N-channel concurrency 限定・GPL 隔離は #330 から不変で skip）= 3 問すべて承認**: Q1 readiness flag Relaxed で never-drained-ring 排除（ready=true 観測時 consumer は push+pump 到達済・piggyback 依存ゼロ・rtrb acquire/release）/ Q2 mid-callback false→true は benign（commit される scratch は確定ゼロ＝silence 1 block・beat は produced-frames で永続 desync なし）/ Q3 N egress × 1 output は hazard なし（single consumer thread sequential・per-egress 分離・`&output` immutable）。**新規指摘なし**。CI SUCCESS on HEAD `844f846`。

**follow-up 3 件を #332 に畳む（owner 判断「先にやる」）**: ① **#2 scheduleEvent/scheduleSliceEvent の stale「not wired」warn を削除**（egress 配線済みで誤誘導・feature-gap は registerLinkAudioChannel が authoritative・`a82d037`。stopAll 再 arm test は masterEffect vehicle に切替）② **#1 VerificationReceiver lifetime を PhantomData で型強制**（host-outlives-receiver を compile-error 化・2b-2b で receiver call site 増＝now-relevant・両 gated path 緑・`a5614f8`）③ **#3 LinkEgressStats: ring-drops を 1Hz ticker で surface**（silent-failure が 2a+2b で挙げた・control が drop counter clone 保持→`total_ring_drops`→EngineWrap→session ticker が増加で `LINK_EGRESS_DROP` WARNING DaemonError event・`4d9dd44`）。**⚠️ 追加分（`7777c27`+`e916cdc`）の当初レビューは hand-roll だった（2026-06-23 訂正）**: `7777c27`=/simplify 由来の `registered: HashMap<String, Arc<AtomicU64>>`（name→drop counter）統合、`e916cdc`=IMPORTANT 2（TS `daemon-error` 未購読 / `LINK_EGRESS_DROP` integration test 欠如）反映、は前セッションで実施したが、レビューは `/code:pr-review-team` skill でなく reviewer サブエージェントを Agent tool で直接 spawn する **hand-roll（CLAUDE.md 禁止）** で行われ、`e916cdc` 後の収束 round も bot レビューも無かった。transcript provenance で確認（`@claude` bot 19:54Z < follow-up commit 21:41/22:14Z・実 skill 起動は 19:19Z が最後）。**正規レビューでやり直し（2026-06-23）= `/simplify` + `/code:pr-review-team` 3 round + `@claude` bot で Critical/Important=0 収束**: 検出・修正 = (a) **silent-failure**: `link_egress_ring_drops` の `try_lock().ok()` が WouldBlock/Poisoned を同一視し poison 時 `LINK_EGRESS_DROP` を恒久抑制 → `match` 分岐・poison は `warn!`（`c66079d`）(b) **test gap 3**: `total_ring_drops` 集約の Arc-identity unit test / `LINK_EGRESS_DROP` latch 非再発火 / `onDaemonError` respawn 再購読の単発（`c66079d`）(c) **comment 矛盾**: `link_egress_drops` の「`record_xrun` と同型」誤記を訂正 + DRY helper `daemon_error_event`（`cf17272`）(d) **Round2**: respawn test の `waitFor` 誤キー `timeout`→`timeoutMs` + fatal→`console.error` 被覆（`0f50c0f`）。検証: daemon 18 passed（両 feature config・新 link-audio unit test 含む）/ TS player spec 40 passed / cargo check 両 config clean / cargo-deny `licenses ok`。defer = poison 経路 test（Minor 4/10・poison 注入 seam 過剰・`warn!` で observability 確保）。

**PR2b 完了**（2b-1 #328 MERGED + 2b-2a #330 owner マージ待ち + 2b-2b #332 owner マージ待ち）。**owner handoff（merge 順）**: **#330 を先にマージ** → #332 は base を main に retarget。2 PR・順序あり・両 green。**マージは owner の明示指示待ち**。**残 follow-up**: 完全な LinkEgressStats（per-channel breakdown 等）は CLAP 統合/cutover #108 前の拡張余地。

### 6.163 feat(engine): A4-2b-2 LinkAudio egress — design + Q4 gate + shim beats_at_begin (WIP / #329) (Jun 23, 2026)

**Date**: 2026-06-23
**Status**: 🚧 WIP（design-first 完了 + Q4 gate POSITIVE + 第1増分 = shim beats_at_begin 改修・standalone 3 緑）。本ブランチ `329-linkaudio-egress-rtrb` 継続中
**Parent**: #321 / A4-2b-1（#327・PR #328）**MERGED**（`f8ab0de`）

**背景**: A4-2b-2 = 実 LinkAudio egress（音が実際に Ableton/Link に届く半分）。GPL crate `orbit-link-audio`（#324・PR #325 MERGED）を実配線。

**design-first（3 scout + advisor）**: 3 スレッド lock-free アーキ確定 — ① cpal callback(permissive・!Send): render_multi で hardware + N channel buf を埋め per-channel rtrb producer へ push ② GPL consumer thread(feature 裏・Send): rtrb consumer drain → commit_channel（= Link "audio thread"）③ control(EngineWrap): registration command を ring 経由で配る。rtrb は permissive↔GPL の物理境界（Producer=Send→callback / Consumer=Send→consumer thread・clap-spike scout で両 Send 確認）。

**Q4 gate（層B headless 検証可否）= POSITIVE**: 同一プロセス内 **2 LinkAudio インスタンス** loopback spike を実機実行 = `maxPeersA=1 maxPeersB=1 / channel_seen=1 / received=318 callbacks / frames=39750`（discovery ~550ms）。A(sink) commit を B(source) が headless 受信成功。→ **層B は headless で gate 可能**（テストで 2 つ目の LinkAudio を receiver に）。単一インスタンス自己 loopback は不可（`channels()` は peer のみ・自 sink は self-list せず）。CI（Linux/network 制限）では multicast 不安定 → #300 kill-test と同じ **gated pattern**（local 実行・CI skip / discovery timeout）。

**advisor の split（#329 コメントに記録）**: 2b-2 は racy 3-thread で最難部 offline 検証不可 → **2b-2a = 最小実証 egress**（shim beats_at_begin + GPL consumer + render_multi を callback に配線〔RT refactor は 2b-2a〕+ 1 channel end-to-end + gated 層B/manual・**drop = 永久 beat desync なので produced-frame anchor or drop で mandatory re-anchor**）/ **2b-2b = dynamic mid-stream registration**（2 cmd-ring + pool slot-activation + race を隔離）。channels は boot 時 stream 構築で静的になり得ない（mutable registry 必須）。

**beat anchoring（advisor・empirically-validated）**: session tempo 1 回 capture（default 120）→ 線形再構成 `beats_at_begin = beat_anchor + (produced_frames - frames_anchor) × (bpm/60)/sr`（per-block "now" を使わず ring latency 位相ずれを避ける）。`sr` は render/device SR = commit の sampleRate。tempo-change re-anchor は PR3（premature）。**層A 検証不可**（PCM は beat timestamp を持たない）→ 層B（2 インスタンス受信の Info.beginBeats）/dog-food。

**増分 1**: shim `orbit_link_commit_channel` に `beats_at_begin: f64` 引数追加（内部の `beatAtTime(clock().micros())` 削除・`captureAudioSessionState` は bh.commit の state 用に残す）。hpp/cpp/Rust FFI/wrapper/smoke test 更新。

**増分 2（GPL consumer + beat anchoring・本 commit）**: shim に anchor 用 getter `orbit_link_capture_beat`/`orbit_link_session_tempo`（consumer thread = audio thread から 1 回 capture）。`LinkChannelEgress`（egress.rs）= rtrb `Consumer<f32>` を drain → `beats_at_begin` を **produced-frames から線形再構成**して commit。**advisor の最大 catch（drop = 永久 beat desync）を解決**: `produced_frames = drained + dropped`（drop counter 算入）→ drop 後も beat が producer の真の位置を追う（drained-only だと恒久ずれ）。beat 再構成を **Link 非依存の純関数**（`produced_frames`/`reconstruct_beat`）に分離し unit-test（drop-desync 防止を pin・計 7 緑）。orbit-link-audio に rtrb 依存追加（permissive・consumer 側）。

**増分 3（層B receiver shim + 実 egress 実機証明・本 commit）**: shim に **verification 専用** receiver（`LinkAudioSource` wrapper・`OrbitRecv`・`orbit_link_recv_*`。production egress は sender-only〔spec §8.1〕なので receiver は出荷せず headless 検証専用）。gated 層B テスト `layer_b_egress_received_by_inprocess_receiver`（`#[ignore]`・local で `--ignored` 実行・CI は multicast 不安定で skip）= 同一プロセスに A=sender egress / B=receiver の 2 LinkAudio を立て、`LinkChannelEgress` 経由の **実 commit** を B が headless 受信することを検証。**実機で PASS**（既知 0.2 サンプルが ring→drain→beat 再構成→Link commit→receiver まで到達）。**2b-2a egress core = 実音が Link receiver に届くことを proven**。通常 `cargo test` 7 passed + 1 ignored。

**増分 4（RingTapSink を native へ port・本 commit）**: orbit-clap-spike の `RingTapSink`/`PostMixSink` を `orbit-audio-native/src/link_audio_ring.rs` へ port（rtrb 境界の **producer 側**・permissive）。`push_partial_slice` で wait-free push・満杯時は drop カウント（GPL consumer の produced-frames 算入と対）。native に rtrb 依存追加（permissive）。unit-test 2（push/consume・drop カウント）= native 18 緑・cargo-deny default GPL-free 維持。**これで rtrb 境界の producer(native)/ consumer(orbit-link-audio `LinkChannelEgress`)が両方揃った**。

**増分 5（render_multi を cpal callback に配線・本 commit）**: `orbit-audio-core` に `Engine::render_multi`（try_lock 競合で hardware + 全 channel buffer をゼロ＝既存 silent-drop 規約を multi-buffer に拡張）。native `output.rs` を refactor — `LinkChannelActivate`（control が ring 生成・scratch 事前確保して reg-ring 経由で callback へ渡す activation メッセージ）/ 私有 `LinkEgress`（reg-ring consumer + 単一 channel〔2b-2a〕）/ `render_block`（reg-ring を drain→render_multi で hardware + channel scratch を 1 パスで埋め→`RingTapSink::commit` で ring push・`link` 無しなら従来 `engine.render` でビット同一）/ `start_default_output_with_link_egress(reg_capacity)`（`Producer<LinkChannelActivate>` を返す・feature 裏 daemon 用）。4 sample-format branch は全て `render_block` 経由に統一。native 18 緑・full workspace 19 ok group 回帰なし・clippy clean・daemon `--features link-audio` ビルド可・cargo-deny default GPL-free 維持。

**増分 6（daemon 配線 + 実 callback 駆動 層B 実証・本 commit）**: daemon に `#[cfg(feature="link-audio")] mod link_audio` を新設。① `LinkAudioControl`（control-side）= `LinkAudioOutput` を生成・enable し **GPL consumer thread** を spawn（`consumer_loop`: `Waiting(LinkAudioOutput)→register_channel→id→Active(LinkChannelEgress)` の状態機械・pump ループ）。`register_channel` で `RingTapSink` 生成→ **consumer+drops を mpsc で consumer thread へ / sink+scratch を reg-ring で callback へ**。② `LinkAudioGuard`（drop で shutdown フラグ store(true)+join＝明示 teardown・drop 順非依存・A0 §13）。③ EngineWrap: feature 時 `start()` が `start_default_output_with_link_egress`+`LinkAudioControl::spawn`→`StreamGuard{_stream, _link}`（field 順は意図的: stream を先に止めてから consumer thread を join・rtrb はどちら順でも UB なしだが無駄な drop を避ける）。`register_link_audio_channel`（非 feature は stub で `LINK_AUDIO_ERROR`）。`now_sec` 委譲を追加。④ session.rs `RegisterLinkAudioChannel` command + `wrap_err_to_protocol` に `LinkAudio` arm。⑤ orbit-link-audio に feature `verification-receiver`（default off）= receiver を `pub mod verification`（`VerificationReceiver`）に単一ソース化（lib.rs の私有複製を除去・self-test も feature gate）。⑥ daemon feature `link-audio-verification`（default off）+ **実 callback 駆動の 層B unit test**（`EngineWrap::start()` 実 cpal+consumer thread→register→receiver 購読→kick.wav を channel=loopD に tag して `play_at`→**実 callback が render_multi で channel buffer を埋め ring へ**→consumer drain→Link commit→receiver 受信）。

**層B Done 基準 = 実機 PASS（1.56s）**: 合成 ring feed（既証明）ではなく本 sub-PR の新規コード（`render_block`/`render_multi` in callback + EngineWrap consumer 配線）を end-to-end で通す。前提として callback が headless で **tick**することを native probe `start_default_output_callback_ticks_headless` で実機確認（stream が開くだけでなく now_sec が前進＝render が回る）。`cargo test -p orbit-audio-daemon --features link-audio-verification -- --ignored`。**回帰**: full workspace 19 ok・cargo-deny default GPL-free 維持（verification/link-audio-verification とも default off で default graph 不変）・clippy clean（default/feature 両方）・daemon default ビルド可（stub）。

**beat anchor の既知 constant offset（advisor #4・PR3 defer）**: `pump_once` は anchor を first-pump-with-data（T1）で capture するため ~1 ring-fill 分の latency が anchor に焼き込まれる。これは **drift ではなく一定オフセット**（全 block が同一 anchor を共有し produced_frames で整合）で Link の latency model 内。修正済みの drop-desync バグとは別物。tempo-change re-anchor と合わせ PR3。

**増分 7（TS 配線で .orbs から到達・本 commit）**: TS `protocol-types.ts` の `CommandMethod` に `RegisterLinkAudioChannel` 追加 / `daemon-client.ts` に `registerLinkAudioChannel(channel)` メソッド（`request('RegisterLinkAudioChannel', {channel})`）/ `rust-engine-player.ts` の `registerLinkAudioChannel` を **実 daemon call + try/catch** に（daemon が link-audio 無効ビルド〔既定 permissive daemon〕なら `LINK_AUDIO_ERROR` で reject されるので throw せず warn-once して継続＝channel tag は維持・出力は hardware のみ）。`setLinkTempo` は PR3。TS build 緑・rust-engine-player.spec 緑（MockDaemonServer が未知 method `RegisterLinkAudioChannel` を error 応答 → player catch → warn の経路で従来 assertion 維持）。

**PR #330 作成 → /simplify 適用済**（commit `07c442e`）。

**pr-review-team round-1 修正（本 commit・PR #330）**: 4 専門レビュアー（code-reviewer / silent-failure-hunter / pr-test-analyzer / comment-analyzer）の Critical=0・Important=8 を解消。
- **C1（RT-safety・最重要）**: 同名 channel の**再登録**で callback 側の旧 `LinkChannelActivate`（ring producer）が **RT スレッド上で drop** され ring 不整合で無音化。TS は `sequence.output()` の eager + dispatch で**冪等前提に複数回**登録する設計なので実バグ。`LinkAudioControl` に `registered_channel: Option<String>` を持ち `register_channel` を冪等化（同名再登録は no-op・別名は 2b-2a 単一 channel scope で log+no-op）。層B テストを 2 回登録に拡張して回帰 pin。
- **S1**: `consumer_loop` が `pump_once` の `CommitResult` を全捨て → `CommitFailed`/`ChannelNotFound` を throttle warn（streak=1 と 1000 ごと）。`NoSubscriber` は通常状態で silent。
- **S2**: consumer 側 `register_channel`（Link）失敗を `warn`→`error` に昇格（2b-2a は唯一の登録機会＝以後 dead）。
- **S3**: TS `registerLinkAudioChannel` の catch を `DaemonProtocolError && code==='LINK_AUDIO_ERROR'` に限定し、**別 error class**（daemon 死亡 `DaemonConnectionError` / transport / quit）は rethrow（feature-gap と誤ラベルしない）。**正確には**: `RegRingFull`/`ConsumerGone` も `session.rs` で `LINK_AUDIO_ERROR` に collapse されるため依然握り潰される — ただし 2b-2a は冪等 guard で単一登録＝`RegRingFull` 到達不能・`ConsumerGone` panic site なしで **latent**。error code 分割（`LINK_AUDIO_UNAVAILABLE` vs `LINK_AUDIO_RUNTIME`）は **2b-2b の must-fix**（#329 にコメント記録）。
- **T1/T2/T3**: `Engine::render_multi` の channel routing 非 gated unit test 2 件 / `DaemonClient.registerLinkAudioChannel` の request 送信 + LINK_AUDIO_ERROR 変換テスト / player の warn-once（LINK_AUDIO_ERROR）+ rethrow（その他）+ 受理時 no-warn テスト。MockDaemonHandlers に `RegisterLinkAudioChannel` 追加（既定 = feature 無し daemon を模し LINK_AUDIO_ERROR）。
- **M5**: consumer thread spawn の `.expect` を `LinkAudioError::ThreadSpawn` で Result propagate。
- **M7/M8/M9**: コメント正確性（verification.rs SAFETY に host-lifetime 注記 / link_audio.rs "tokio" ラベルを「daemon tokio task から呼ぶ」に / engine_wrap.rs `link` field doc を「Mutex で `&self` を可能にする」に訂正）。
- **回帰**: full workspace 19 ok・cargo-deny default GPL-free 維持・clippy clean・TS 1179 passed/27 skipped・層B 実機 PASS（2 回登録の冪等性込み）。
- **follow-up（diff 外・本 PR では触らず）**: scheduleEvent/scheduleSliceEvent の `outputChannel` warn は egress 配線前の placeholder（"egress is not wired yet"）で、egress 配線後は stale 化し得る。signal は `sequence.output()`（registerLinkAudioChannel の feature-gap warn or not-enabled warn）が authoritative なので機能影響は無いが、メッセージ整合は別 PR で。

**次（残り）**: advisor → load-bearing な GPL egress なので @claude bot レビュー → 修正確認。**dynamic registration の pool + readiness race は 2b-2b**。**レビューで surface 済**: receiver は verification 専用（sender-only・spec §8.1）だが C++ shim に常時リンク / register_channel 部分失敗 seam（advisor #3）/ beat anchor constant offset（advisor #4・PR3 defer）。

### 6.162 feat(engine): A4-2b-1 single-pass multi-buffer render + channel_name wire (post-2.0 A4 / #327) (Jun 23, 2026)

**Date**: 2026-06-23
**Status**: ✅ 実装 + 全テスト緑（core 39〔既存 35 + render_multi 4: 空channels=render ビット同一 / 1パス routing+sum / **transport 1回進行** / 未登録 channel drop〕・daemon 全緑〔protocol 17 に wire smoke 1 追加〕・full cargo workspace 全緑・npm 1174 passed〔TS wire テスト +7〕）
**Branch**: `327-single-pass-multibuffer-render`
**Parent**: #321（A4 meta）/ A4-2a（#324・PR #325）は **MERGED**（`f68a4d2`）

**背景**: A4-2（GPL 隔離）を advisor 助言で permissive/GPL seam で 2分割。本 PR = **A4-2b-1（permissive・offline 可・単独 merge 可）**: single-pass multi-buffer render + per-event `channel_name` wire + 層A 決定論検証。GPL・rtrb・実 egress は **A4-2b-2** へ。**split 根拠**: offline 決定論検証できる render core を「headless 検証できないかもしれない GPL egress（層B・Ableton/link #50）」の後ろに gate しない。

**mode 所有（scout 確定）**: `Sequence.resolveDispatchChannel()`（`sequence.ts:1136`）が hardware-vs-Link を **TS 側で完全解決**（MIDI/非linkAudio → undefined=hardware / linkAudio + `.output(name)` → channel 名 / linkAudio で `.output()` 欠如 → throw）。**daemon は mode-agnostic**: `channel_name = Some(name)` → Link routing tag / None/空 → hardware。daemon に mode flag 不要。

**実装**:
- **core `Scheduler::render_multi(hardware_out, channels: &mut [(&str, &mut [f32])])`**: 1パスで全 event を走査し hardware_out（channel=None）と各 named channel buffer を同時に埋め、**transport（cursor / master gain ramp / 完了 event 掃除）を1回だけ進める**。N× render_channel の transport 二重進行を恒久解消。既存の per-event 混合を `mix_event_into` に抽出し `render_filtered`/`render_multi` で共有（`render_filtered` は behavior-preserving refactor = 既存 35 テストで bit-identical 担保）。master gain ramp は全バッファに **1回だけ**進めて適用（バッファごとに進めると ramp 多重進行で desync）。未登録 channel の event はどこにも出ない（render_channel の unmatched skip と一致）。`channels` 空なら render() とビット同一。
- **wire（per-event channel_name・mode-agnostic）**: `RustEnginePlayer.scheduleEvent/scheduleSliceEvent` が `outputChannel` を `ScheduledPlay` に格納 → `executePlayback` が `daemon.playAt(..., channel)` へ → `DaemonClient.playAt` が非空時のみ PlayAt JSON に `channel` 追加（空/欠如は省略）→ daemon `session.rs` が `params["channel"]` を解析（""/absent→None coerce）→ `engine.play_at(... channel)`（現状 None 固定を置換）。`engine_wrap.play_at`/core scheduler の channel 層は A4-1 で構築済。
- **本番 render 無改変**（hardware fallback 維持）: render_multi は offline 検証のみで production cpal callback への配線は A4-2b-2。linkAudio mode の event は 2b-2 まで hardware に流れる（A4-1 と同挙動・regression なし）。`registerLinkAudioChannel`/`setLinkTempo` の warn/no-op も維持（egress 未配線で warn は accurate）。

**層A 検証**: core の render_multi cursor-1回進行 determinism（double-advance 修正の実証）+ 1パス routing+sum + 空=render ビット同一 + 未登録 drop。daemon wire smoke（`play_at_with_channel_is_accepted`: PlayAt with channel が session parse を通り PlayStarted = wire が channel を運び parse がエラーにならないことを pin。routing 自体は core/harness が担保・rate と同型の wire 経路ガード）。TS は daemon-client/rust-engine-player の channel 転送を mock で assert（+7）。

**委譲（#298 profile）**: core render_multi（load-bearing single-pass・Opus 直列）+ daemon seam（Opus）+ 検証ゲート（Opus）。TS wire（固定 IF 内の pattern clone + test 配線）= Sonnet 並列・Opus が契約（`channel` JSON field）所有 + 統合検証。

**/simplify（4観点）**: `next_gain_frame` 抽出（ramp 状態遷移の verbatim 重複を `apply_master_gain` と `render_multi` で集約・drift 防止・behavior-preserving）/ render_multi doc 精緻化（「channels 空=render() ビット同一」は channel タグ event が無い場合のみ）。target_idx 二段は borrow-checker 必須で clean、TS spread は idiomatic と確認。**cargo fmt は `-p` でスコープせず workspace 全体を整形し無関係 churn を生むため、編集ファイルのみ revert + 対象 crate のみ fmt し直した**（教訓）。

**/code:pr-review-team（4専門レビュアー・収束）**: Critical 0。Important 2 を反映 = ① **render_multi の ramp 経路 0% 未検証**（全テストが ramp_frames=0 開始）→ `render_multi_gain_ramp_advances_once_and_applies_to_all_buffers` 追加（ramp 1回進行 / hw・channel gain 一致 / channel に gain 適用 を pin・comment が警告する「per-buffer 多重進行 desync」を捕捉）② **`render_channel` doc が render_multi を現在形で『使う』と過剰主張**（実際は production caller 無し）→「A4-2b-2 で移行予定」に時制修正 + `Engine::render_channel` doc 整合。Minor 反映: テスト名 `_is_dropped`→`_is_silent`（実態=無音・event は retain）/ TS warn 文言 `(A4)`→`(A4-2b-2)`「tagged but hardware only」/ render_multi doc に buffer 長前提（release 未チェック・interleaved stride・呼び出し元責任）注記。**2b-2 へ defer**: unknown-channel の retain/drop/diagnostic policy（RT で sampled counter）/ debug_assert の release 安全化（hard-stop でなく RT 安全に）/ RT opts（channel→idx precompute・steady-state gain hoist・start_frame guard を lookup 前に）/ wire→parse→tag の強化検証。非文字列 channel の strict error は lenient optional-param 規約（rate/pan）と一貫で skip。

**スコープ外（A4-2b-2）**: rtrb 本番化（RingTapSink/PostMixSink を permissive 側へ・Producer=native/Consumer=GPL consumer thread）+ GPL consumer が drain→commit_channel + beat anchoring（cumulative-frames から beatsAtBufferBegin 決定論再構成・shim を beats_at_begin 引数化）+ 実 Link commit + production render を render_multi に切替 + registerLinkAudioChannel 実装（dynamic registration: `.output()` は post-start に出現しうる→固定 max-channel pool + 登録 command ring を cpal callback 冒頭 drain）+ 層B headless 受信試行。**beat anchoring は層A 検証不可**（PCM は beat timestamp を持たない）→ 層B/dog-food。**drop policy**: ring 十分サイズ化・万一 drop は re-anchor + log（silent desync 禁止・hard-stop 禁止）。**lock-free 化 = rtrb egress 境界**（scheduler の Arc<Mutex>+try_lock 据え置き）。PR3 tempo / PR4 e2e。

### 6.161 feat(engine): A4-2a GPL isolation crate orbit-link-audio + SC-free C++ shim + cargo-deny gate (post-2.0 A4 / #324) (Jun 22, 2026)

**Date**: 2026-06-22
**Status**: ✅ 実装 + 全テスト緑（orbit-link-audio standalone 2〔FFI smoke: 構築/channel 登録/silence commit no-op/不正 id/tempo/teardown + 内部 null 拒否〕・default workspace `cargo test` 全緑〔回帰なし〕・daemon `--features link-audio` ビルド緑・npm 全緑〔TS 無改変〕）
**Branch**: `324-link-audio-gpl-isolation`
**Parent**: #321（A4 meta）/ 正本: `POST_2.0_NEXT_STEPS.html §3/§4`

**背景**: post-2.0 engine-first / A4（LinkAudio）の permissive-first 第2増分。A4-2（GPL 隔離）は load-bearing かつ大きいため advisor 助言で **PR2a（license-critical gate）/ PR2b（render+rtrb+実 audio+wire）に内部 split**。本 PR は PR2a。

**Step0 ゲート（stop&report・実機検証）= GREEN**:
- **submodule**: `external_libraries/link` populated・tag `Link-4.0`（SHA e9a2e414）・`include/ableton/LinkAudio.hpp` に full audio+tempo API・header-only。
- **SC-free compile**: `<ableton/LinkAudio.hpp>` を SuperCollider 非依存で単独コンパイル成功。
- **link+run**（advisor 指摘で compile に留めず実行まで）: macOS frameworks（CoreFoundation/CoreServices/Security/SystemConfiguration）でリンク → `LinkAudio` 構築 → `enable`（discovery thread・numPeers=0）→ `LinkAudioSink` 登録 → `captureAudioSessionState`/`beatAtTime` → **`BufferHandle::commit()` 実呼び出し（egress FFI surface・no-peer no-op）** → `setTempo`/`commitAppSessionState`（PR3 surface）→ teardown clean・exit 0・hang/prompt なし。
- **license**: Link = `GPL-2.0-or-later / commercial` dual（`external_libraries/link/LICENSE.md` + DSL spec §8.1）。

**本 PR（A4-2a）の実装**:
- 新 crate `rust/crates/orbit-link-audio`（`license = "GPL-2.0-or-later"` 明示・workspace の FairTrade を継承しない・`publish = false`・`[workspace] exclude` で **非 member**）:
  - SC-free C++ shim（`shim/orbit_link_shim.{hpp,cpp}`）を `build.rs`（`cc` crate・`warnings(false)`）で static lib 化 + macOS frameworks link。include 順序の不変条件（LinkAudio.hpp を Link.hpp より先）を踏襲。`packages/sc-link-audio` の SC 結合実装を参照に SC-free 化。
  - C-ABI: `orbit_link_create`/`destroy`/`enable`/`num_peers`/`register_channel`/`commit_channel`（egress 表面・呼び出しスレッドが LinkAudio "audio thread"）/`set_tempo`（PR3 用）。
  - Rust FFI 宣言 + safe wrapper `LinkAudioOutput`（`unsafe impl Send`・`CommitResult` enum）。
- `cargo-deny` + `rust/deny.toml` 新設: default feature グラフ（link-audio off）が GPL-free を assert。allow に permissive + FairTrade のみ・**GPL は意図的に非掲載**。検証: `cargo deny check licenses`（default）= pass / `--all-features`（link-audio on）= **GPL-2.0-or-later rejected で fail**（leak 検出が機能することを逆方向で確認）。
- `orbit-audio-daemon`: `[features] link-audio = ["dep:orbit-link-audio"]`（default off）+ optional path-dep。**本番 render には未配線**（PR2b）。

**設計の要点（advisor 反映）**:
- **Ableton Link は vendored C++（build.rs/cc 経由）で cargo crate ではない** → cargo-deny は Link の GPL を直接は見えない。cargo-deny の役割は ① third-party crate の GPL/copyleft 混入防止 ② orbit-link-audio（GPL 明示）が default graph に現れないこと。**真の保証は構造的**（permissive core は依存行ゼロ・単独コンパイル可）で cargo-deny は backstop。
- **exclude が唯一の正解構成**: GPL crate を member にすると cargo-deny が常時 fail。exclude で非 member 化すると default root から外れ（pass）、permissive crate が誤依存すれば dep として graph に入り検出される。非 member なので package fields はハードコード（FairTrade workspace から意図的に分離）。
- **commit の audio-thread**: rtrb で cpal thread と分離した **GPL consumer thread** が LinkAudio "audio thread" になる（PR2b 配線）。ring latency は beat anchoring に乗るが tempo leader ゆえ可聴上無害（精度要件なし・PR2b/層B で精緻化）。

**/simplify 適用（4観点並列）**: ① shim の単一フィールド `ChannelEntry` ラッパを削除し `vector<unique_ptr<LinkAudioSink>>` に直接化 ② `CommitResult::InvalidArgs` → `ChannelNotFound`（実態=未登録 channel id に即した名前。enum 自体は PR2b consumer drain で no-op/committed 区別が load-bearing なので維持）③ build.rs に Link ヘッダ(`include/ableton`)の `rerun-if-changed` + `ORBIT_LINK_DIR` 上書き（submodule bump 時の stale 回避 + checkout 非依存）。reuse=clean（`thiserror="2.0"` 直書きは exclude 構成の必然）。**PR2b へ defer**: per-block `captureAudioSessionState()` の cache 化（hot path・commit が no-op の PR2a では未顕在・advisor Q4 の決定論 beat 再構成と統合）/ `floatToInt16` の inline・vectorization 確認。**owner へ flag**: cargo-deny gate の CI 配線（現 CI は cargo 非実行 → gate は手動のみ。Rust CI job 追加は infra 判断）。

**/code:pr-review-team 適用（4専門レビュアー並列・2 round で収束）**: round-1 = code-reviewer Critical 1（`commit_channel` の source-slice overread = `maxNumSamples` は宛先上限で src 境界でない → shim に `buf_len` 引数 + `min(num_frames*num_channels, buf_len, maxNumSamples)` clamp + Rust debug_assert）/ Important（① 4 つの extern "C" に例外ガード不在 = C++ 例外が境界越え UB → 全て try/catch ② `bh.commit()==false` が `NoSubscriber` に alias → `-2`=`CommitFailed` 分離 ③ `new()` null peer テスト追加）/ comment Critical（"audio-thread surface" が threading contract を満たすかのような過剰主張 → PR2b scope + Thread-safe:no に修正）。round-2 = 全 4 レビュアー **Critical/Important = 0**（fix が新 bug を生まないことを独立検証: buf_len 引数順序 hpp/cpp/Rust 一致・`-2` mapping end-to-end・隔離 3 leg 健全）。round-2 Minor 反映: destroy/num_peers の silent catch にログ / commit match に明示 `-1` + 未知 sentinel debug_assert / commit コメントの no-op スコープ正確化。**PR3 concern（defer）**: void `set_enabled`/`set_tempo` の `Result` 化（tempo-lead 配線時）。**CI 環境制約**: code-review CI = pass / MERGEABLE・BLOCKED（review 承認待ち）。

**@claude bot レビュー（load-bearing なので起動・scope を GPL 隔離/FFI/SC-free に明示）**: 🔴 1件 = `orbit_link_destroy` の `delete link` が try/catch 外（ファイル冒頭の「Link 呼び出しは throw しうる」前提と矛盾・`~OrbitLink`→`~LinkAudio` が noexcept(false) なら extern "C" 越え UB）→ `delete` も例外ガードで修正。🟡 = ① C++ の `num_frames*num_channels` unsaturated（Rust は saturating）→ **buf_len clamp が吸収して memory-safe**（コメント明記・コード変更不要）② `deny.toml unknown-git="allow"`（clack git dep に現状必要・allow-git リスト化は別 PR・defer）③ `[advisories]` に vulnerability=deny 既定の注記追加。bot 確認済 = GPL 隔離 3層・FFI 例外ガード（delete 除く）・buf_len 三段 clamp・unsafe Send・SC-free 性。

**Done（PR2a 受け入れ基準・達成）**: ✅ default `cargo build`/`test` 緑（orbit-link-audio 非ビルド）・✅ `cargo build -p orbit-audio-daemon --features link-audio` 緑・✅ cargo-deny default = GPL-free pass / leak で fail・✅ permissive crate に依存行ゼロ（構造的境界）・✅ 既存テスト全緑（npm + cargo）・SC 既定経路 無改変・audio `play()` 意味論 無改変。**audio egress 証明は PR2b・tempo lead は PR3**。

**PR2b/PR3 設計 carry-forward（advisor 2026-06-22・本 PR では実装しない・失わないよう記録）**:
- **① beat anchoring**: commit で "now"（`clock().micros()`）を buffer-begin の beat として渡すと、ring latency 分の位相ずれ（receiver 側で δ ずれる）になる。**tempo leader であることは beat 配置と直交で、これを無害化しない**（当初コメントの「tempo leader なので無害」は誤った根拠 → 本 PR でコメント訂正済）。PR2b で cumulative-frames-drained から `beatsAtBufferBegin` を決定論再構成する（efficiency review の指摘と一致）。
- **② threading 分離**: 「GPL consumer thread = Link audio thread」は **未検証の仮定**（link+run gate は peer 無しで実時間 timing を検証できない）。さらに `set_tempo`（`captureAppSessionState` = app-thread・block しうる）は `commit`（audio-thread）と同一スレッドに置けない → **PR3 の tempo 経路は PR2b の egress と別スレッド**。shim が両方を露出していても共有スレッドは前提にしていない。
- **③ PR2b は fresh design**（mechanical 継続ではない）: mode 所有 = `Sequence.resolveDispatchChannel` を読んで TS が hardware-vs-Link を解決し daemon を mode-agnostic に保てるか確認 / RingTapSink の synced 経路 drop は **hard-error 化**（silent drop は beat desync）/ 上記 anchoring・threading。design-first（scout + advisor）で着手する。

**スコープ外（後続）**: PR2b（single-pass multi-buffer render + rtrb 本番化〔synced 経路の drop は hard-error 化〕+ 実 audio routing + wire〔session.rs channel_name + TS stubs〕+ `Sequence.resolveDispatchChannel` の mode 所有確認）/ PR3（tempo leader + 層B）/ PR4（across-respawn e2e）。

### 6.160 feat(engine): A4-1 named-channel routing + sum-by-name on rust mixer (post-2.0 A4 / #322) (Jun 22, 2026)

**Date**: 2026-06-22
**Status**: ✅ 実装 + cargo workspace 全緑（core 単体 5〔routing 分離 / sum 2x / unknown 無音 / unrouted skip / unfiltered 全混合〕+ verify harness 2〔routing 分離・sum-by-name +6dB を実 WAV + region_rms/db_difference で〕。TS 変更ゼロ = npm 影響なし）
**Branch**: `322-linkaudio-routing-sum`
**Parent**: #321（A4 meta）

**背景**: post-2.0 engine-first の parity gap 充填 #2（A3 = PR #320 マージ済の次）。`.orbs` の `outputChannel`（LinkAudio・#209）を Rust 経路で鳴らす A4 の **permissive-first 第1増分**。正本: `POST_2.0_NEXT_STEPS.html §3/§4`。

**Step0（3 偵察 + web spike + advisor + owner 決定）**:
- **parity か net-new か = net-new 確定**: 動く SC 音参照なし（#209 OPEN・`orbitPlayBufLink` SynthDef 未定義）+ scsynth UGen 経路は Rust 非適用 + Rust に tempo 概念皆無・`LinkAudioSink` 無し。Done は「SC 一致」にできず、層A 決定論受信が correct の定義。
- **GPL 面**: 既存 `packages/sc-link-audio` の `link_audio_facade.hpp` は型エイリアスのみ・`channel_registry.cpp` は SC ガード依存でそのまま FFI 不可。`rusty_link` は GPLv2+ かつ標準 Link（tempo）のみで LinkAudio(audio) を wrap しない。→ A4-2 で薄い SC-free C++ shim を新規し sum-by-name は permissive Rust 側に残す（advisor 指摘で GPL 面最小化）。
- **lock-free**: `PostMixSink`/`RingTapSink`/`rtrb` は `orbit-clap-spike`（S1 スパイク）に実証済だが本番未配線。A4-2 で本番へ移植（lock-free 化 + permissive↔GPL 境界を兼ねる）。
- **受信検証**: `LinkAudioSource`（in-process 受信 API）存在だが Link discovery は UDP multicast 依存で同一プロセス/CI 不安定（Ableton/link #50）・SC 側も headless 受信未検証。

**owner 決定（2026-06-22）**: ①検証境界 = 層A headless + **層B も headless 試行**（discovery 不成立なら手動 fallback を報告・stop&report）②GPL 隔離 = feature-gated 薄 crate in-process（default off）③staging = permissive-first 4 分割（PR1 routing+sum → PR2 GPL crate+shim+cargo-deny → PR3 tempo leader → PR4 across-respawn e2e）。

**本 PR（A4-1）の実装**:
- `orbit-audio-core`: event に `channel: Option<String>` タグ追加（`ScheduledSample`/`ActiveSample` + `with_channel`）。`render` を `render_filtered(out, channel_filter)` に refactor（filter=None で従来の hardware sum とビット同一）+ `render_channel(out, name)`（同名 channel は自然加算 = sum-by-name・DSL §8.1.2）。`Engine::render_channel` / `schedule_with_play_id` に channel を thread。
- `orbit-audio-daemon`: `EngineWrap::play_at` に `channel` 引数 + `render_offline_channel`（層A 決定論受信側・cpal 非依存）。wire（protocol channel_name 解析）は A4-2 へ（session.rs は `None` 固定）。
- 「耳」活用: 既存 verify ハーネス（#307/#311 の `region_rms`/`db_difference`）に per-channel PCM を通し routing 分離 + sum-by-name +6dB を実 WAV で検証。

**運用**: GPL/Ableton Link を一切導入しない permissive 増分。SC 既定経路 無改変・audio `play()` 意味論 無改変。Rust workspace は CI fmt/clippy 非 gate（追加コードは周囲スタイルに整合）。

**/simplify 適用（4観点並列）**: ① `render_offline`/`render_offline_channel` を `render_offline_inner(closure)` に共通化 ② `Engine::render`/`render_channel` を `with_scheduler` ヘルパに集約 ③ altitude 指摘で `Scheduler::render_channel` を `pub(crate)` に絞り直接の外部アクセスを閉じる（`Engine::render_channel` は pub + `#[doc(hidden)]` で daemon の `render_offline_channel` から呼ぶため cross-crate 可能）。「混在呼び出し禁止」は呼び出し元責任の prose 規約でアクセス制御では強制されない（A4-2 で RT 配線後に再評価）④ テスト `body` クロージャを `rms_avg` ヘルパに hoist。efficiency = クリーン。test 構造重複（reuse minor）は test 閾値で skip。

**/code:pr-review-team 適用（4専門レビュアー並列）**: code-reviewer = Critical/Important 0。silent-failure / comment-analyzer 指摘 = `Scheduler::render_channel` doc + 本 WORK_LOG ③ の「crate 外へ露出しない」が過大主張（Engine::render_channel は pub・daemon が使用）→ 修正済。pr-test-analyzer 指摘 = sum-by-name が同一 onset のみ → `render_channel_sums_same_name_at_staggered_onsets`（非ゼロ `dst_offset_frames` の `+=` を pin）を追加。latent: transport 二重進行 invariant は prose のみ（production caller 無し）→ A4-2 の single-pass multi-buffer で恒久解消。空文字列 channel `""` vs `None` の wire 意味論は A4-2 で確定。

### 6.159 feat(engine): slice varispeed parity — chop rate≠1.0 on rust engine (post-2.0 A3 / #319) (Jun 22, 2026)

**Date**: 2026-06-22
**Status**: ✅ 実装 + 全テスト緑（npm 全緑・cargo workspace 全緑。core 単体6 = varispeed 5〔rate=1.0 ビット同一 / 倍 / 半 / invalid / fade*rate〕+ stop_all 1、統合 varispeed 1、StopAll protocol 1、TS rate/stopAll/Gap5。PR レビューで fade*rate テスト + stopAll エラー可視化を追加）
**Branch**: `319-slice-varispeed`

**背景**: post-2.0 engine-first の次フェーズ（cutover #108 までの parity gap 充填の1つ目 = A3）。#304（PR #305）が「見かけの parity を作らない」ために rate≠1.0 を 1回 warn + 自然尺に倒した箇所を、実機で尺合わせ再生する。正本: `POST_2.0_NEXT_STEPS.html §4 A3`。

**Step0（2 spike + advisor + owner 決定）**: ① **Signalsmith Rust binding spike** = `signalsmith-stretch`(MIT) が存在し proceed 可（早期採用・production 実績は自前）。② **DSL 意味論 spike**（spec + SC 一次資料）で **核心の再構成**: slice rate≠1.0 の SC parity は SC `PlayBuf.ar(rate: sliceDur/slotDur)` = **純 varispeed（ピッチも動く）**で、pitch-preserving stretch は SC 経路に存在しない → **parity を埋めるのに Signalsmith は不要**。一方 `fixpitch()`/`time()` は SC 未実装の **net-new #213 機能**（Signalsmith FFI + license gate 新設 = 高リスク）。③ 前提誤り訂正: 「cargo deny / deny.toml 前例あり」は事実誤認（リポジトリに不在）。

**owner 決定（2026-06-22・blast radius が決め手）**:
- **Q1 = varispeed-only**。A3 = slice rate≠1.0 varispeed（Rust 内部完結・SC 経路/共有 DSL 表面に非接触・新依存ゼロ）+ 織り込み3件。**fixpitch()/time()/Signalsmith/cargo-deny は #213 follow-on へ分離**（手戻りゼロ: varispeed primitive を後で再利用）。
- **Q2 = time()=varispeed + 将来 stretch() 予約**（spec 方向を記録）。「rate 変化=varispeed」一貫。pitch-preserving は fixpitch+time の合成で得られる。

**varispeed 設計（advisor 承認）**: `ScheduledSample.rate` + 分数読み位置 `read_pos: f64` を導入し、core render を「source を `rate` 倍歩幅で分数走査 + 線形補間」に変更。**rate=1.0 で frac=0 → 元サンプルにビット同一**（既存 slice/pan/fade テスト無改変で通る厳密な一般化）。fade は出力時間（slice_len/rate）で数える。`rate = sliceDuration / eventSlotDuration`（SC `calculatePlaybackRate` と同形）を TS 側で計算し daemon へ送る。出力尺 = `effective_len_frames / sr / rate`（PlayEnded もこの出力終端）。

**seam（TS→daemon→core を一貫）**: `rust-engine-player.ts`（`resolveSliceRegion` を warn から rate 算出へ・`toDaemonParams`/`executePlayback` が rate を渡す・GapKind から `slice` 除去）→ `daemon-client.ts`/`protocol-types.ts`（PlayAt に rate）→ `session.rs`（rate 解析・pan 同様 reject せず 1.0 丸め）→ `engine_wrap.rs`（出力尺 /rate）→ `engine.rs`/`scheduler.rs`（varispeed render）。spec-first で `INSTRUCTION_ORBITSCORE_DSL.md`（slice-fit varispeed §3 + time()/fixpitch()/stretch() §12）と `ENGINE_DAEMON_PROTOCOL.md`（PlayAt rate + StopAll）を先に更新。

**織り込みフォローアップ3件**:
- **daemon hard-stop-all（global）**: core `Scheduler::stop_all()` + daemon `StopAll` コマンド + TS `stopAll()` 配線（disposed/respawning/未接続では skip）。varispeed の rate<1.0 長尺 voice が global stop を跨いで鳴り続けるのを断つ。**per-sequence selective stop（`clearSequenceEvents` の play_id 追跡）は明示 defer**（balloon 厳禁・要 owner 判断＝#319 コメント記録）。
- **Gap5**: quit-during-respawn の CI テスト（mock・respawn backoff 中の quit が clean に終わる）。
- **bot Finding 2**: connect 時 error の二重ログ修正（永続 onError を open 後に attach・connect once を open で detach）。

**検証（Done 基準＝offline 決定論 PCM）**: core 単体（rate=2.0 で倍勾配・rate=0.5 で補間・rate=1.0 ビット同一・invalid rate 丸め）+ **統合**（`verify_schedule_pcm.rs`: 同一 slice を rate=1.0/2.0 で実 `play_at`→render し rate=2.0 が半尺で終わることを PCM の信号終端比で確認）+ StopAll protocol + TS（rate 送信・stopAll・Gap5）。capture seam は含めない（offline で足りる・#300 Step0 の決定を維持）。

**明示 defer**: fixpitch()/time()/Signalsmith/cargo-deny → #213 / capture seam / A4 LinkAudio / γ / cutover #108 / per-sequence hard-stop。

### 6.158 feat(engine): recovery floor — daemon supervision + auto-respawn + 最小 recovery contract (post-2.0 α / #300) (Jun 22, 2026)

**Date**: 2026-06-22
**Status**: ✅ 実装 + 全テスト緑（npm 1162 passed / 27 skipped・cargo daemon 全緑）+ **gated kill-test 2/2 PASS**（SIGKILL hard-death / InjectFault panic clean-exit）
**Branch**: `300-recovery-floor-daemon-supervision`

**背景**: post-2.0 engine track の最初の `/goal2`。owner 決定（2026-06-21・「機能より fundamental を先に」）= α recovery floor（fault ①）。**CLAP/Rust daemon が落ちても TS engine / アプリ全体が引きずられて落ちない**ことを保証する。後続 in-process 楽器（β〜）の安全網でもある（fault ③ = 1st-party in-process crash は①の respawn でのみ捕捉）。pan/slice/per-slice gain は goal1 #304 で実装済 = 再実装しない。正本: `POST_2.0_ENGINE_AND_DISTRIBUTION.md §2.2/§2.5/§7`・アーキ決定 #298（fault 3層 §4）。

**接地した設計前提（コード調査で裏取り）**: 「active loops」を定義する状態は**全て TS 側に在る** — ループの再スケジュールは TS の `setTimeout`（`loop-sequence.ts`・daemon 非依存）、発火待ちキューは `RustEnginePlayer.scheduledPlays`+`liveSequences`。daemon が持つのは disposable な3つ（loaded samples / in-flight voices / transport clock）だけ。→ owner 前提（**権威保持者は TS・daemon は disposable**）が成立。よって supervisor は生存側 = `RustEnginePlayer` に置く（DaemonClient を所有し session 状態の権威を持つ唯一の自然な設置点）。

**Step0 owner 決定（4問・全て推奨案で確定）**:
1. recovery contract = #300 のまま確定（balloon させない）。replay すべき隠れ state は無く（global gain は rust 経路未使用・output device は default）、**active loops のみ replay + 再 anchor だけ**で満たす。
2. fault 注入 = **kill -9（hard-death）+ gated panic コマンド（clean-exit/panic-hook 経路）**。「misbehave synth を segfault に拡張」は daemon が CLAP を非ホスト（daemon CLAP 統合は明示 defer の後続段）なので daemon を殺せない → owner と再設計。supervisor から見れば kill -9 と C-ABI segfault は ws drop に収束。
3. kill-test = **ローカル実機 + 記録した手動 validation（gated・既定 skip）**。CI gate にしない（実プロセス kill は CI で flaky/危険・librosa cross-check と同パターン）。
4. PCM 可聴ギャップ数値化（play --capture seam）は **含めない・state-level Core のみ**（#307 で明示 defer の重い増分）。

**設計（advisor 承認）**:
- **検出（両系統が単一経路に収束）**: `DaemonClient` が「quit() 由来でない ws close」を `daemon-died` event で emit。`intentionalClose` フラグで意図的 quit と crash を区別、`wasRunning` で起動成功後の close のみを死と判定。clean exit（panic hook→exit1）も hard death（segfault/SIGKILL・hook 素通り）も**どちらも ws close に収束**。kill -9 時の ws `error`（ECONNRESET）は永続 listener で吸収し unhandled throw による TS 巻き込みを防ぐ。
- **supervisor（`RustEnginePlayer`）**: `daemon-died` → respawn（single-flight・backoff・上限5回）→ `establishSession`（getStatus 再 anchor + StreamStats off→on 再購読）。同一 DaemonClient を再利用し配線を安定化。
- **唯一 load-bearing な不変式 = 再 anchor の「順序」**: 死後 `clockAnchor` は死んだ daemon の transport（例 2s）を指す。再 anchor 完了**前**に dispatch すると新 daemon（transport=0）へ「2 秒先」を送り 2 秒の desync。→ `respawning` フラグで再 anchor 完了まで `executePlayback` を guard（dispatch を drop = one-shot drop / gap・catch に頼らず順序保証）。`sampleIds` は破棄して lazy 再ロード、`durations` は file 由来で保持。
- **active loops 復帰 = 構造的**: poll ループと TS の loop timer は死を跨いで生存 → respawn 後は自動的に新 daemon へ dispatch 再開。
- **上限到達時**: TS プロセスは落とさず（recovery floor の最終保証）poll ループだけ止め fatal を一度だけ出す。

**fault seam（gated）**: daemon に `InjectFault` コマンド（`ORBIT_DAEMON_ALLOW_FAULT_INJECTION=1` のときだけ受理・既定無効）。panic→panic hook→exit(1)+stderr DaemonError = TS が検出すべき clean-exit 経路を実プロセスで通す。hard-death は外部 SIGKILL（daemon コード0行・panic hook 素通り = C-ABI segfault の忠実な代理）。

**kill-test（#300 受け入れ gate・invariant ベース・実時間 kill は非決定的なので exact-match しない）**: `tests/audio/rust-engine/real-daemon-recovery.spec.ts`（PRODUCTION モード = player が daemon を spawn・所有し supervisor が実際に respawn する経路）。transport を ≥2s 進めてから kill（advisor: t≈0 だと stale anchor≈fresh anchor でバグが隠れる）。検証: (1) liveness=poll 生存・新 pid・loops 復帰、(2) **transport 再 anchor**=復帰後 daemonNowSec が kill 直前より大きく下がる（stale anchor を引きずらない・唯一 load-bearing）、(3) onset clip しない=lead≈lookahead、(4) daemon-side 状態クエリ=fresh uptime / sample 再ロード / active_plays 健全。CI-safe な supervisor 状態機械テスト（mock・respawn 成功/上限失敗の2本）も `rust-engine-player.spec.ts` に追加。

**主な変更**: `DaemonClient`（`intentionalClose`/`daemon-died`/`socket-error` 吸収/`childPid`・`injectFault` seam/handshake orphan-reject 修正）、`RustEnginePlayer`（supervisor: `respawning`/`disposed`/`respawnPromise`・`establishSession`・`respawnLoop`・guard・`onPlaybackError` を respawn 任せに変更・`daemonPid`/`injectDaemonFault`/`getDaemonStatus` seam）、`session.rs`（gated `InjectFault`）、`protocol-types.ts`（`InjectFault` method）、`mock-daemon-server.ts`（`dropConnections`）。

**/simplify（4観点並列）**: 適用 = ① respawnLoop を try/finally で `respawning=false` 単一リセット化 ② dead な `inflightLoads.clear()` 削除（rejected 時に `.finally` で自己削除済み）③ `delay()` inline 化 ④ `InjectFault` の kind 二重デフォルトを unit コマンドへ collapse（YAGNI）⑤ `socket-error` 診断 emit に house style 注記。altitude は構造（supervisor 配置 / detection seam / 同一 client 再利用 / 3フィールド / @internal seam / handshake catch）を affirm。skip = waitFor/定数抽出（gated 統合テストは兄弟 timing.spec と同じく self-contained が house style）・`delay`↔SC `sleep` 統合（SC 経路無改変）。

**/code:pr-review-team（4専門・round 1）**: **Critical 1**（code-reviewer opus + silent-failure-hunter が独立に同一指摘）= respawn の `establishSession` 中に新 daemon が即死すると、getStatus の DaemonConnectionError を anchor=0 で吸収して誤って成功宣言 → 再死の daemon-died が single-flight に吸収され respawnPromise 解決 → 二度と respawn されず dispatch 永久 drop（recovery floor が黙って死ぬ）。修正 = respawnLoop で establishSession 後に `!isRunning()` を確認し retry（`continue`）。Important = `onPlaybackError` に DaemonQuitError 追加 / `socket-error` ghost event を console.warn 可視化 / test gap（再 anchor 不変式・in-flight one-shot 非再発火・quit が respawn 抑制）。Minor = `void ensureRespawn` の安全網 catch / quit の空 catch ログ化。CI-safe mock テスト4本追加（再 anchor desync・one-shot 非再発火・**re-death 回帰**・quit 抑制）。code-reviewer は残りの状態機械（respawning stuck / double-respawn / quit during respawn / intentionalClose race / 順序）を sound と確認。CI（build + code-review bot）pass。**round 2（独立再レビュー）**: code-reviewer(opus) は Critical 修正を実証検証（該当行を revert → re-death テストが wedge/timeout → 回帰テストに牙があると確認）し **CLEAN**。test-analyzer も 4 新テストを非 vacuous と検証し Critical/Important 0。silent-failure の Important 1（`ws-close-error` emit が無 consumer = 実質 silent。round-1 の onError console.warn 化と整合させ console.warn へ）+ Medium 1（re-death `continue` の warn 追加）+ polish（one-shot テストに settle 猶予）を follow-up で解消 → **Critical/Important = 0 に収束**。

**`@claude` bot second-opinion（advisor 推奨・PR #294 前例で internal の blind spot を検出した実績）**: load-bearing seam に絞って起動。**Blocking issue なし**・load-bearing invariant 表は全 ✅（intentionalClose 判別 / wasRunning / handshake catch / respawning finally 順序 / re-death continue / sampleIds vs inflightLoads / single-flight / quit teardown / InjectFault gate）。Finding 1（actionable）= `request()` が CLOSING window で plain Error を投げ `onPlaybackError` の silent-drop を抜け misleading ログ1回（S2 既知 Finding F・correctness ではない）→ `DaemonConnectionError` 化で解消。Finding 3 = executePlayback ガードのコメントが post-guard TOCTOU は catch 任せである旨に触れていない → コメント精度化。Finding 2（connect 時 error の二重ログ・cosmetic）/ Finding 4（quit backoff latency・非問題）は bot 自身が後回し合理的と判断 → defer。

**検証の境界（正直な明記）**: 「active loops 復帰」は **RustEnginePlayer レベルの continuous-stream プロキシ（gated kill-test + mock テスト）+ 構造論**で検証している。loop の再スケジュールは `loop-sequence.ts` の setTimeout（純 TS・daemon 非依存）なので daemon 死の影響を受けず、生存した poll ループへ scheduleEvent し続ける → respawn 後に新 daemon へ自動的に dispatch 再開、が構造的に成立する。ただし **実 `loop()` を `createAudioEngine` 経由 full interpreter で respawn 跨ぎさせる end-to-end は未実施**（S2 の timing parity が「直接駆動・end-to-end 未実施」と境界を明記したのと同型）。閉じる場合は gated e2e テスト1本で足りる（optional・owner 判断）。

**follow-up note（非ブロック・code-reviewer round 2 で sound 確認済）**: Gap 5 = `quit()` が respawn の backoff 中（~150ms）に着地するケースの CI テストは未追加（`disposed` checkpoint + `await respawnPromise` で正しいと確認済・consequence は narrow window の cleanup race のみ）。

**明示 defer**: out-of-process per-plugin isolation（γ・fault ②）/ β audio DSL⊇pitch / time-stretch / LinkAudio(A4) / cutover #108 / play --capture seam（PCM 可聴ギャップ数値化）。

**post-#300 計画 doc + drift 監査（owner 依頼・本 PR 同梱）**: マージ前に「第1増分後の実装計画」を新規 `docs/development/POST_2.0_NEXT_STEPS.html`（snapshot 2026-06-22・MASTER_PLAN の前向きたたき台）に集約 = ①到達点（A0/S1/S1b/S2 + #304 + #300）②**cutover #108 までの parity gap**（#304 が warn/no-op に倒した time-stretch=A3 / LinkAudio=A4 / master effects=γ）③#300/#304 で意図的に defer した小粒の follow-up トラッカー（play --capture seam / Gap5 quit-during-respawn / active-loops e2e / daemon hard-stop-all / bot Finding 2・4）④次 /goal 候補（contained な A3/A4 を先に・γ は段階化、owner 判断）。仕様 drift 監査（agent）= **specs-v2 / core spec は engine/recovery 非言及で drift 無し**、recovery は DSL 意味論を変えないので core spec にセクション不要。事実 status の drift のみ本 PR で修正（done マーク）: ENGINE_AND_DISTRIBUTION §2.2「auto-respawn 未実装」→ 実装済 / §2.5・§7 第1増分=done / A0 §14 pan=done + Finding F 解消 / MASTER_PLAN.html §2・§3・§9 第1増分=done。既存正本の「次フェーズ=X」決定は書かず新 doc を参照（次の選択は owner にティーアップ）。Epic #292 本文 status はマージ後に gh で更新。

**owner 決定（2026-06-22・advisor 反映）を NEXT_STEPS.html に追記**: ① **次フェーズ順序 = A3 time-stretch → A4 LinkAudio**、各フェーズの自然な拾い所にフォローアップを織り込み A3+A4 完了で backlog 一掃（A3: daemon hard-stop-all〔stretch で長尺 voice〕+ Gap5 + Finding2 / A4 末: active-loops e2e〔capture 非依存の state-level〕）。残るは capture と Finding4 のみ（意図的）。② **capture seam は A3 に畳まない**（stretch 検証は offline で足りる・#300 Step0 の「含めない」決定を覆さない）。capture は 2 独立 trigger=（a）dog-food の可聴ギャップ実測〔前倒しうる〕/（b）耳なし実時間検証基盤〔cutover までに確実〕。③ **計測/耳なし検証レイヤ（#307/#308/#313 verify ハーネス + librosa grounding）を再利用資産として再ラベル**（新トラック発明せず）。④ **north-star: (C) score-following / アルゴリズム的「聴く」/ LLM 演奏計画は WCTM 別トラックの研究ビジョン**（engine スコープ外）。依存方向 = engine→計測語彙→(C)、責務境界 = engine は計測語彙をクリーンに保つだけ・(C) の alignment/入力/streaming は抱えない。共有=特徴抽出の語彙 / 用途別=配管。新規性は「DSL 譜面整合 + LLM 計画駆動」の統合部分に限定（score-following 自体は確立 MIR）。先回り実装はしない（投機的一般化の禁止）。

**Commit**: 7aabde7（実装 + /simplify cleanup）/ ff4259c（pr-review-team round 1）/ ff9bb72（round 2 → Critical/Important=0 収束）/ + bot follow-up + post-#300 計画 doc・drift 監査

### 6.157 verify(audio): retroactively self-verify #304 (examples/22 params) via harness — close #307 (#316) (Jun 21, 2026)

**Date**: 2026-06-21
**Status**: ✅ 実装 + 全テスト緑（cargo daemon verify_schedule_pcm 4 / verify 30 / npm 1161 passed）。#307 の受け入れ基準（examples/22 を耳なし PCM 検証）を達成
**Branch**: `316-verify-examples22-goal1`

**背景**: harness epic #307 の受け入れ基準に「examples/22（pan/slice/per-slice gain）を capture して PCM アサーションで #304 を遡及的に自己検証（耳に依存しない裏付け）」がある。phase 1〜3（#310/#312/#314）でハーネス・assertion lib・tier-c・librosa grounding は揃ったが、**#304 の実 deliverable を耳なし検証する最終増分が未達**だった。本増分でこれを満たし #307 をクローズ（完了済み phase-2 #311 も併せて）。

**examples/22 の制約**: `examples/22_rust_engine_parity.orbs` は 4 voice 同時並行の dog-food デモで、各拍に複数 voice が重畳し L/R RMS がミックスになり per-event の pan/gain を分離不能（研究 §4.4）。→ **生ファイルに per-event assert を当てない**。

**設計（advisor 承認・(A) offline）**: examples/22 と同じ素材（kick/snare/hihat/arpeggio）+ #304 の実パラメータ（pan -0.6/+0.6/0/+0.2・gain -3/-6/-9/-4・chop(1) 全体 と chop(2) 領域）を **de-overlap した検証 fixture** `examples22_parity.orbs` に組み、phase-2 の 2 本足で検証。tempo 120 / length 4 / 16 要素 → 0.5s grid（spec: length(2)→8要素 と同型・subdivision は play 要素数で決まり chop と独立）。kick@0s / snare@2s / hat@4s / chopd slice1@6s・slice2@7s（rate=1.0）。

**2 本足**: Leg 2（TS）= InterpreterV2 schedule vs **手書き独立オラクル**（onset/gainDb/pan/slice を .orbs+DSL 仕様から導出・トートロジー回避）。**length>1 を harness で初めて通したが独立オラクルと一致**（interpreter が length>1 を正しく処理）。Leg 1（Rust）= golden → 実 `EngineWrap::play_at` offline render → PCM で **pan を atan2 独立逆算（kick -0.6 / snare +0.6 / hat 0 / chopd +0.2）+ chop(2) 領域 + イベント間無音** を検証。

**gain の扱い（正直に）**: gain 値（-3/-6/-9/-4）は**異なるサンプル間で RMS 比較不能**（固有レベルが違う）ため Leg 1 では検証しない。gain は Leg 2（gainDb/linear の計算）+ phase-2 per_event_gain（同一サンプルの dB 差を実レンダで）でカバー済み。

**スコープ外**: 生 examples/22 の literal smoke（examples/ 配下・別パス・重畳で friction 高く弱い検証）は見送り、de-overlap fixture で acceptance を満たす。CLI `play --capture`（#307 ②・重い）は /goal2（#300）へ defer（#307 が「capture は respawn 後の可聴ギャップ計測に効く」と明記）。

**意義**: 以後の audio 増分（#239 slice / #213 time-stretch / effects）が「耳」でなく PCM で機械検証可能に。#307 が「capture は daemon respawn 後の可聴ギャップを PCM で測れる → goal2 検証に効く」と明記しており、goal2（#300 recovery floor）への橋にもなる。

**/simplify（4観点並列）**: reuse/efficiency は重複・無駄なし（既存 phase-2 パターン踏襲）。altitude の 1 件のみ適用 = Rust `tail_trim` を動的式 `(span/4).min(600)`（本 fixture では全 span≥2400 で常に 600）から既存 fixture と対称な固定 `600` に簡約（挙動同一）。chopd assert のループ化等は「明示の方が読みやすい」で leave-as-is。

**/code:pr-review-team（4専門・1 round 収束）**: Critical/Important=0。code-reviewer がオラクル全値（onset/gain linear+dB/pan raw+daemon/chop offset/sentinel）を .orbs+DSL 仕様から**独立再導出して一致確認**（循環でない裏付け）。Minor 3件適用: ① Leg1 ループ前に `assert_eq!(events.len(),5)` ガード追加（兄弟 per_event_gain テストと対称・golden truncation 時の vacuous green 防止）② `.orbs` の無音間隔表記を正確化（chopd slice1-slice2 間は 0.5s）③ slice 領域「内容」正しさは `chop_region_real_wav.rs` が担う旨の layering 注記。bot は新規外部主張なしで skip（advisor カリブレーション = verify 系は proportional）。

**Commit**: b763abc（実装）+ /simplify cleanup + pr-review-team follow-up

### 6.156 feat(verify): phase-3 — ground measurement primitives against librosa (blind cross-check) (#313) (Jun 21, 2026)

**Date**: 2026-06-21
**Status**: ✅ 実装 + 全テスト緑（cargo daemon+verify / npm 1159 passed）+ cross_check 3 fixture PASS（leader 独立再現）
**Branch**: `313-verify-phase3-librosa-cross-check`

**背景**: phase 1（#307/6.154）・phase 2（#311/6.155）の tier-c 検証が信頼してきたのは、ハーネス自身の**測定プリミティブ**（`orbit-audio-verify`: `region_rms` / `pan_from_lr_rms` の atan2 逆算 / `detect_onset_threshold`・`detect_onset_matched`）。これまでプリミティブは Rust 単体テスト（既知アンカー）でしか裏付けが無く、誰も**独立 MIR ツールと突き合わせていなかった**。tier-c の土台がプリミティブの正しさに乗っているため、librosa を独立 oracle に置いて**プリミティブ層で GRM 独立性を成立させる**（差分検証）。研究記録 = #308 / `docs/research/AUDIO_OUTPUT_VERIFICATION.md` §4.2/§4.4。

**独立性の質を正直に書き分ける（中核）**:
- **onset = アルゴリズム独立（本丸）**: librosa の spectral-flux peak-picking は ours（threshold / matched-filter）と別アルゴリズム。真の差分。librosa の検出値は ours とも scheduled とも異なる独立値（per_event_gain loud で librosa=4608, ours=scheduled=4800）。
- **level = 実装独立**: librosa も `sqrt(mean(x²))`（式は同じ）。捕まえるのは生 PCM 読み込み（`np.fromfile` の interleave/reshape）・channel 取り出し・dtype の**配管**。「RMS の数学を独立に再導出した」とは主張しない。
- **pan = 実装独立**: librosa 由来 per-ch RMS から atan2 逆算（atan2 は純粋数学・`analysis.rs` のアンカーで別途 pin 済）。grounding は per-ch RMS の一致に帰着。

**seam（WAV codec を検証対象に混ぜない）**: Rust example `export_verify_pcm`（`orbit-audio-daemon`・example は dev-dep `orbit-audio-verify` を使える唯一の置き場）が phase-2 fixture を本番 `EngineWrap::play_at` でオフライン決定論レンダ → `CapturedAudio.data` を**生 LE interleaved f32** でダンプ（`.gen/`・gitignore・再生成可能）+ 自プリミティブ測定値を `<fixture>.rust.json`（committed）に出力。Python `cross_check.py` が生 PCM を `np.fromfile(dtype='<f4')` で読み **librosa を numpy 配列に直接**かけて突き合わせ、`<fixture>.compare.json`（committed）を出力。

**onset 3-way**（ours / librosa / 既知スケジュール）: librosa 単独は hop=512≈10.7ms で弱いオラクル → scheduled を strong ground truth に据え librosa を独立 witness に。許容 = ours↔sched ±2ms(96fr) / librosa↔sched ±15ms(720fr) / level 相対 ≤3% / pan ±0.05。

**結果（全 fixture PASS・leader 独立再現 exit 0）**: level lRelErr=0.0（窓一致で配管確認）/ pan Δ=0.0（left/mid/right=−1/−0.5/+1）/ onset ours 0〜+9fr（attack fade 無しでほぼ sample-accurate）/ librosa −64〜−448fr 先行（spectral-flux+backtrack の系統傾向・全件許容内）。`chop_region` の spurious 4 は chop 内部境界の再立ち上がり（scheduled 全件マッチで verdict 不変）。**librosa デフォルト `frame_length=2048` は減衰信号で ~30% 系統ズレ**→窓長明示が必須（py-crosscheck が発見・修正）。

**CI 方針（owner 確定）**: **CI gate にしない**。版固定 `requirements.txt`（librosa==0.11.0 等）+ committed script + 本記録 + `tests/audio/verify/phase3/README.md` の Recorded validation。理由: librosa/numba は版脆弱・onset は frame 解像度で gate だと flaky・回帰は既存 Rust アンカーテストがカバー。self-test（`--selftest`）で機構の正常/異常検出を回帰ガード。

**委譲**: Opus = cross-check 設計（突き合わせ量・許容校正・onset 3-way・GRM 独立性の書き分け・export seam・README/契約・統合/再現確認）。Sonnet = Rust example（render+生f32ダンプ+自測定JSON）/ Python script（librosa 測定+比較）+ 版固定 requirements。leader が selftest cleanup の footgun（`.gen` rmtree で実 PCM 巻き添え）を修正。

**/simplify（4観点並列 + 適用）**: in-file の簡約を適用（named const 化 `BLOCK_FRAMES`/`BODY_HEAD_OFFSET`/`ONSET_SEARCH_MARGIN`・未使用 `panRaw` 削除・`play_span` ヘルパ抽出・matched 分岐コメント / Python: spurious 件数のベクトル化・冗長 `status` 変数と重複 `mkdir` 除去・`_rms` ヘルパ・異常系 selftest を `run_fixture` に統一）。値は不変（rust.json / compare.json バイト一致を確認）。**reuse 最大指摘 = `render_golden`/golden 型 ~80行が phase-2 test と逐語複製**は defer: dedup には merged phase-2 test 改変 + daemon 本体への feature flag + orbit-audio-verify の dev-dep→optional 昇格が必要で reviewed diff の外。両 harness を触る focused follow-up とする（追跡 = #315）。

**/code:pr-review-team（4専門エージェント並列 + 反復）round-1**: Critical 1 + Important 4 を反映。① **selftest 再設計**: 各検出器を 1 ケース 1 摂動で単独 flip 検証（level/pan/onset-ours/onset-librosa）+ spurious assert。従来は L/R 等倍摂動で **pan 検出器が未検証**（Critical）・librosa_matched/空 onset 経路も未駆動だった。② **`detect_onset_matched` を scheduled 真値と整合確認**（従来は Rust が出力するのみで Python 未消費＝「4 プリミティブ grounding」が過大主張）。③ **PCM frame 数を `rust.json["frames"]` と照合**（stale/truncated PCM の silent pass を防ぐ）。④ robustness: `onsetFrameThreshold=null` の TypeError ガード / near-zero RMS 相対誤差の分母 floor / `_selftest*` gitignore / コメント精密化。CI gate 無し方針ゆえ selftest が唯一の自動ガードなので各検出器の単独 flip 検証が要。**round-2**: ⑤ selftest の単独 flip を compare.json の **per-metric フラグで assert**（verdict bool は disjunctive で isolation を保証しない）、⑥ **matched-FAIL 経路を selftest でカバー**（`_selftest_onset_matched`）+ Rust 側で per_event_gain[0] の matched が None なら **expect で loud に**（silent null = grounding 消失を防ぐ）、⑦ burst2 コメント修正。**round-3** で両 reviewer が収束確認（Critical/Important=0）。収束推移: round-1 (C1+I1〜I4) → round-2 (I-A・I-B = round-1 の selftest 強化の深化) → round-3 (0)。

**CI 補足（owner 2026-06-21）**: 現状 CI gate にしないが**将来導入予定**。導入時は版固定 venv を job 化し `export_verify_pcm`→`cross_check.py`（exit code gate）を回す（生成物は決定論）。

**スコープ外（後続）**: 上記 render_golden dedup（両 harness 共有・#315）/ CLI `play --capture out.wav`（決定論 offline-clocking）/ madmom フルスイート / 広い DSL 機能網羅（polymeter/quantize onset）/ 知覚指標 / CI 導入。selftest の残 Minor（`ours=None`・空 onset の guard 分岐の edge path 未テスト・sev 2-3）は意図的に追わない（検証ツールの guard 分岐で収束に影響なし）。

**Commit**: 03c7088（実装）+ 4871fe6（/simplify）+ pr-review-team round-1 follow-up

### 6.155 feat(verify): phase-2 tier-c — interpreter schedule vs rendered PCM (two-leg) (#311) (Jun 21, 2026)

**Date**: 2026-06-21
**Status**: ✅ 実装 + 自動テスト全緑（cargo --workspace / npm）+ clippy clean。tier(c) を end-to-end で閉じる第2増分
**Branch**: `311-audio-verification-phase2-tier-c`

**背景**: phase 1（#307/PR#310・6.154）は core レンダラ（Scheduler）を直接検証した。phase 2 は **interpreter が .orbs から計算したスケジュール（native 経路）を2本足で検証**し、tier(c)（レンダリング音 ↔ DSL 意味的スケジュール）を engine 層から閉じる。研究記録 = #308。

**2本足（advisor 指摘で循環の罠を断つ）**:
- **Leg 2（interpreter の計算が正しいか）**: `RecordingScheduler` 注入の `InterpreterV2` で fixture .orbs を実行 → 生の構造スケジュール（onset/gainDb/pan/slice index・total）を **.orbs + DSL 仕様から手書きした音楽単位オラクル**と比較。解決済み daemon param 同士の比較はトートロジー（slice offset/duration が両者同式）になるため**生のまま**比較。`calculateEventTiming` + DSL→schedule を直接テスト。
- **Leg 1（renderer が忠実に再生するか）**: 構造スケジュール → 本番共有 `toDaemonParams` で解決 → golden JSON → Rust が実 `EngineWrap::play_at` でオフライン決定論レンダ → phase-1 analysis で PCM 検証。pan は atan2 独立逆算、**slice 領域は golden の offset/duration を再導出しない**（GRM 独立性）。

**seam（本番経路と共有・drift 防止）**:
- TS `RustEnginePlayer`: 発音変換を private `toDaemonParams` に lift（executePlayback と検証で**同一変換**: gainDbToAmplitude / pan÷100 / resolveSliceRegion）。`seedDuration` + `DaemonPlayParams` 型 + `ScheduledPlay`/`SliceSpec` export。behavior-preserving（rust-engine 24 + daemon-client 10 緑）。
- TS `InterpreterV2`: audioEngine 注入 option（既定不変・SC 経路無改変）。
- Rust `EngineWrap::render_offline`: cpal 不使用の block 駆動。play_at の sec→frame / resolve_slice_region を経た出力を捕捉（phase-1 が飛ばした層）。

**決定論化の発見**: `preparePlayback` が `scheduler.isRunning` を要求（RecordingScheduler.start で立てる）、`runSequence` が `baseTime = (Date.now()-startTime)+100`（RUN 先読み）→ **fake timers で Date.now() 凍結**し記録 time = musical onset + 100 を決定論化。

**fixture（3機能・判別力）**: `pan_three_voices`（hard-left/中間-50/hard-right・中間値が線形則を判別）/ `chop_region`（chop(2) grid 一致 rate=1.0・slice 領域の出力/無音）/ `per_event_gain`（gainDb -3/-9 の 6dB 差）。golden JSON は committed・staleness guard（`UPDATE_GOLDEN=1` で再生成）。

**検証**: TS Leg 2 **6 passed**（pan/chop/gain × 2）+ Rust Leg 1 **3 passed**（verify_schedule_pcm）。cargo --workspace 全緑 / npm test 1159 passed / **0 failed**（SC 既定 `SuperColliderPlayer` / `event-scheduler.ts` + daemon 実時間経路 + audio play() 意味論 無改変）。clippy clean。

**委譲**: Opus = seam（toDaemonParams lift / InterpreterV2 注入 / render_offline / 2本足構造）+ pan spine の end-to-end 疎通（決定論化の発見含む）。Sonnet = chop/gain fixture の複製。

**スコープ外（後続）**: CLI `play --capture out.wav`（daemon offline render-to-WAV）/ librosa 相当 blind cross-check / 広い DSL 機能網羅。

**Commit**: 301338e (spine) / 16e6434 (chop+gain)

### 6.154 feat(verify): audio output verification harness — capture + PCM assertion lib (#307) (Jun 21, 2026)

**Date**: 2026-06-21
**Status**: ✅ 実装 + 自動テスト全緑（cargo --workspace / npm）+ clippy clean。#304 の pan/領域/per-slice gain を **耳でなく PCM 解析で自動裏付け**
**Branch**: `307-audio-verification-harness`

**背景**: #304（PR #305）の native audio parity は OSC 値 parity と scheduler ユニットで固めた一方、「.orbs を end-to-end で鳴らした実レンダリング PCM」の確認は **owner の耳に依存**した。研究記録 #308（`docs/research/AUDIO_OUTPUT_VERIFICATION.md`）の tier (c)（レンダリング音 ↔ 静的スケジュールの突き合わせ）を **engine 層から着地させる第1歩**。

**設計（advisor 承認）**:
- **capture seam = `Scheduler` 直接駆動**。pan/領域/gain/末尾fade はすべて `orbit-audio-core::Scheduler::render` に入っており、それが DUT そのもの。`Engine` 経由（try_lock の理論上 drop）や daemon の `play_at`（sec→frame 変換 = tier(c) 射程外・protocol test で別途カバー）を通さず、最も決定論的な核を block 分割で回す。**実 WAV 要件は loader でロード→`Scheduler.schedule`→render で満たす**。
- **GRM 独立性（差分検証の成立条件）**: checker は core の `equal_power_pan` / `resolve_slice_region` を **import しない**。pan は L/R RMS から `atan2` で独立逆算（レンダラは cos/sin）、領域境界・gain 比の期待値はテスト側に手計算で直書き。同式を共有すると同一バグが両側に乗り差分が消えるため。

**新規 crate `orbit-audio-verify`**（lib 依存は core のみ / native は dev-dep）:
- `capture.rs` — `CapturedAudio` + `capture(scheduler, channels, total_frames, block_frames)`。block 分割で `dst_offset_frames`（実 cpal callback のイベント境界またぎ）も通す。core 無改変のため channels は引数渡し。
- `analysis.rs` — `region_rms` / `channel_rms` / `region_peak` / `channel_peak` / `linear_to_db` / `db_difference` / `pan_from_lr_rms`（atan2 独立逆算）+ tolerance 定数（`PAN_TOLERANCE=0.05` / `GAIN_DB_TOLERANCE=0.5` / `SILENCE_FLOOR_DB=-90`、本レンダラは完全線形ゆえ MPEG 系非線形校正不要）。
- `onset.rs` — `detect_onset_threshold`（閾値立ち上がり）/ `detect_onset_matched`（matched filter 相互相関・整数フレーム）/ `fade_slope_is_linear`（最小二乗の正規化 RMSE で線形 release 判定）。

**遡及検証テスト（#304 を PCM アサートで裏付け）**:
- `tests/pan_real_wav.rs` — 実 WAV `sine_440.wav` を hard-left/center/hard-right でレンダ → L/R RMS から pan 逆算（±0.05）。
- `tests/chop_region_real_wav.rs` — 実 WAV `arpeggio_c.wav` で領域 on/off（領域外は厳密 0）+ 合成 ramp で offset 同定（読んだ source フレーム == offset+local）。
- `tests/per_slice_gain.rs` — 同尺・同素材・中央パンで線形 gain だけ変えた 2 イベント、body 窓 RMS の dB 差 == 指令比（±0.5 dBFS）。
- `tests/onset_fade_capture.rs` — capture 経路で onset 検出（block 境界またぎ）+ 末尾 fade の線形性。

**委譲（§5/§7 規律）**: Opus が capture seam / analysis コア（pan 逆算・tolerance）/ GRM 独立性 / spine（実 WAV pan）を凍結 → Sonnet が onset/fade 本体・残り遡及テスト・フィクスチャを並列実装。

**検証**: orbit-audio-verify **23 unit + 7 integration = 30 passed**（PR #310 レビューで判別力強化 +4: 中間 pan 値・fade 終端値・db_difference 退化分岐・region_peak/should_panic）。cargo --workspace 全緑（core 23 / daemon 14+1 / native 16 / clap-spike 7・回帰なし）。npm test 1153 passed / 25 skipped / **0 failed**（SC 既定 `SuperColliderPlayer` / `event-scheduler.ts` 無改変・audio play() 意味論不変）。clippy clean。

**PR**: #310（`/simplify` + `/code:pr-review-team` 4 専門 → Critical/Important=0 収束。CI code-review pass）。

**スコープ外（後続増分）**: CLI `play --capture out.wav`（TS→daemon→render 全経路）/ DSL 静的スケジュールを GRM にした end-to-end tier (c) / librosa 相当の blind cross-check。

**Commit**: 8759187

### 6.153 docs(research): audio output verification — DSL static schedule vs rendered PCM (#308) (Jun 21, 2026)

**Date**: 2026-06-21
**Status**: 調査記録（論文化の可能性あり）
**Branch**: `308-audio-verification-research`

#304 の audio parity 検証が owner の耳に依存したことを発端に、「**DSL が静的計算したスケジュール（onset サンプル/レベル dBFS/pan/slice 境界）を golden reference とし、オフラインレンダした実 PCM を解析して自動突き合わせ**」する自己検証機構の deep research（4観点並列 + LLM 角度の追加1本）を実施し、`docs/research/AUDIO_OUTPUT_VERIFICATION.md` に記録。

- **枠組み**: golden-model conformance testing（GRM=DSL スケジュール / DUT=レンダラ / scoreboard=突き合わせ）。手法は HW/DSP 検証・MPEG conformance で成熟。
- **新規性**: tier (c)（レンダリング音 ↔ DSL 意味的スケジュールのエンジン内蔵突き合わせ）は先行事例未発見。最近接の学術先行研究 = Antescofo/IRCAM のモデルベーステストだが**イベント時刻層で止まり PCM 非到達**。
- **上位フレーミング**: これは **LLM の自己 PDCA（Plan-Do-Check-Act）の Check を audio で人間不在に成立させる機構**。agentic 自己修正は客観 oracle が必須（CRITIC / Huang et al. ICLR 2024）で、本機構は「audio の客観 oracle」を提供。`[LLM agent + 音楽 DSL + PCM 解析 + 静的 symbolic スケジュール + 推論時自律ループ]` の組み合わせは未発見。
- 実装は #307（capture backend + assertion lib + CI gate）。本研究は #308。

**Commit**: bc6f76a

### 6.152 feat(engine): native audio parity increment — pan / slice / per-slice gain (#304) (Jun 21, 2026)

**Date**: 2026-06-21
**Status**: ✅ 実装 + 自動テスト全緑（cargo --workspace / npm）+ owner ear verdict 取得（pan/slice/per-slice gain いずれも rust で SC 同等に可聴）+ OSC 実値 parity 観測
**Branch**: `304-audio-parity-increment`

post-2.0 engine-first の第1増分（最初の `/goal`）。S2 で defer した audio gap のうち **pan / chop 領域再生 / per-slice gain** を native daemon 経路に実装し、`ORBITSCORE_ENGINE=rust` opt-in の裏で dog-food 可能にした。SC 既定経路は無改変。

- **pan**（SC `Pan2` と同じ equal-power 則・中央 = -3dB / 1√2）: core scheduler render に等パワー定位を実装。daemon PlayAt の `pan`（既に protocol 仕様化済み・実装が追いついていなかった）を配線。TS は DSL の -100..100 を daemon の [-1,1] へ変換して送る。`scheduleEvent` の「pan 未対応」warn を撤去。
- **chop 領域再生**（region-only・rate=1.0）: PlayAt に `offset_sec` / `duration_sec` を追加（spec 先行で `ENGINE_DAEMON_PROTOCOL.md` 更新）。core は ActiveSample に slice 領域（start/len）を持ち、領域だけを読む。SC `orbitPlayBuf` と同じ末尾 fadeout（`min(8ms, dur×4%)` 線形 release）でクリック防止。TS `scheduleSliceEvent` を実装（slice 領域は lazy load 後に `executePlayback` で解決）。物理 slice ファイル（`audioSlicer`）は live 未使用の dead path のため native では再現しない（startPos 領域読みのみ）。
- **per-slice gain**: 各 slice event の gainDb が daemon PlayAt の gain に独立反映され、core render の per-event `active.gain` で適用される（新機構不要）。
- **rate≠1.0（slice 尺→スロット尺の varispeed = time-stretch）は本増分の対象外**。検出時は 1 回 warn し、slice は自然尺（rate=1.0）で鳴らす（time-stretch 増分 #213/#239 へ defer）。`chop()` は「現状 scsynth 仕様をそのまま採用」（owner）が、rate フィットは roadmap の time-stretch 境界に従い defer。

**用語整理（owner 確認）**: `chop()` = n 等分（既存・本増分）。`slice()`（`recycle()` でも可）= Re-Cycle 型のトランジェント/無音検出による文節切り = #239（将来 β）・本増分対象外。

**主な変更ファイル**:
- Rust: `orbit-audio-core/src/scheduler.rs`（pan equal-power + slice 領域 + fadeout）, `engine.rs`, `orbit-audio-daemon/src/engine_wrap.rs`（slice 出力尺で PlayEnded 補正）, `session.rs`（offset/duration parse + 検証）
- TS: `rust-engine/daemon-client.ts`, `rust-engine/rust-engine-player.ts`（pan/slice 配線 + `resolveSliceRegion`）
- docs: `docs/research/ENGINE_DAEMON_PROTOCOL.md`（PlayAt に offset_sec/duration_sec）
- tests: core に pan 4件 + slice 3件、`rust-engine-player.spec.ts` を pan/slice 新仕様へ更新

**テスト結果**:
- cargo --workspace: 全緑（core 21 / daemon protocol 13 / smoke 1 / native 16 / clap 7）
- npm test: 1153 passed, 25 skipped, 0 failed（回帰なし・SC 既定無改変）

**並行成果**: DAW 標準機能リサーチ（`docs/research/DAW_AUDIO_ARCHITECTURE.md`）= 基礎後の routing/effects 層 roadmap 入力（insert 順序 = engine core の graph 管理 / EQ 等 = CLAP plugin / PDC が insert 順と不可分）。

**SC parity 検証（owner）**: `ORBITSCORE_ENGINE=rust` で examples/22・pan sweep（-60→+60 等パワー）・per-slice gain 階段を ear 確認 → いずれも SC 同等（「パワー感も変わらない」= equal-power 一致）。さらに SC 既定経路を `ORBIT_SCSYNTH_PATH` で起動し、SC が scsynth に送る `/s_new`（amp/pan/startPos/duration）と rust が daemon `playAt` に送る値が**バイト一致**することを OSC ログで観測（耳の A/B 以上に厳密なパラメータ parity）。

**Done のスコープ線引き（owner 確認 2026-06-21）**: audio parity（pan/slice/per-slice gain）は **CLI 経路**（`node cli-audio.js` + `ORBITSCORE_ENGINE=rust`）で実証。CLI と .vsix は同一の `RustEnginePlayer`→daemon コードを通るため音は同等だが、**パッケージ済み .vsix からのゼロ設定 daemon 解決は未対応**（`resolveDaemonBinary` は repo 相対パス + `ORBIT_AUDIO_DAEMON_PATH` を探索。.vsix は env 未設定だと未解決。build:copy-engine も daemon 未同梱）。これは distribution 課題として **#306** へ分離（最終形 OrbitStudio/VSCodium の配布で扱う。.vsix は途中の dog-food シェル）。暫定 dog-food は `ORBIT_AUDIO_DAEMON_PATH` 設定で可能。

**残**: time-stretch / LinkAudio / α recovery floor は後続増分。daemon の .vsix/OrbitStudio 解決は **#306**。examples/22 が `RUN`（one-shot ≈2秒）で audition しづらい点は polish 候補（本増分の Done には非該当）。

**post-review cleanup（/simplify）**: 4観点 cleanup agent の指摘を behavior-preserving に適用 —
slice 長 clamp を core の `resolve_slice_region` に集約し scheduler の render 尺と daemon の
PlayEnded 尺の単一情報源化 / 等パワーパンを `schedule()` で precompute して RT render から
trig（sin/cos）と output_channels 分岐を排除 / render の `gain*env` を frame 単位へ hoist /
session.rs の PlayAt param 抽出を `param_f64` ヘルパーで集約 / 旧 spec の `Math.pow` を
`gainDbToAmplitude` に置換。SKIP: TS slice 数式/pan の SC `event-scheduler.ts` との共通化（保護対象の
SC 経路を触るため follow-up）。検証: cargo --workspace 58 緑 / npm 1153 緑 / 変更ファイル clippy クリーン。

**pr-review-team（round 1）修正**: code-reviewer の Important（engine_wrap が生 `requested_len_frames` を
scheduler へ渡していた → clamp 済 `effective_len_frames` を渡し render/PlayEnded の一致を call site で保証）/
silent-failure-hunter（`ensureLoaded` が sampleRate 不正時に無言で slice→全体再生 degrade → ソースで warn）/
comment-analyzer（slice の旧「skip」コメントを領域再生実装済みへ更新）/ pr-test-analyzer（`resolve_slice_region`
境界・ステレオ slice の channel stride・`duration_sec<0` 拒否の3テスト追加）。検証: cargo 61 緑 / npm 1153 緑。

**pr-review-team（round 2）**: round-1 修正を独立再レビュー。code-reviewer/comment-analyzer/pr-test-analyzer は
0 件（#R1 の effective_len_frames は全ケースで render/PlayEnded 一致・3 新テストも算術的に正しく load-bearing と確認）。
silent-failure-hunter が sibling edge を 1 件検出（`ensureLoaded` が sample_rate のみ検証し `frames` 未検証 →
`frames=NaN` だと `NaN<=0===false` で fallback guard 素通り）→ `frames` 有限・非負も検証 + `resolveSliceRegion`
guard に `!Number.isFinite` を defense-in-depth 追加。検証: npm 1153 緑。

**Commit**: d3be514（実装）, 9282e6c（log ref）, +simplify cleanup, +pr-review fixes（round 1/2）

### 6.151 docs(post-2.0): correct roadmap to engine-first (supersede OrbitStudio-first framing) (#302) (Jun 21, 2026)

**Date**: 2026-06-21
**Status**: ✅ docs/spec のみ（HTML タグバランス検証済・残存矛盾なし）
**Branch**: `302-roadmap-engine-first`（PR 予定・docs-only）

6.150（#298/#299）で記録したアーキ §2.1–2.4（楽器=in-process / effects+3rd-party=plugin / audio DSL⊇pitch / egress）は**不変**。だが #299 のロードマップ框（土台2本・OrbitStudio 先・2.0.0 parity on scsynth）が **SUPERSEDED** となったため engine-first に訂正。

- **振り子の収束（advisor 整理）**: 「OrbitStudio 2.0.0 parity 先決」を「scsynth を Studio に同梱」と誤読（2.0.0 の*体験*と*実装 scsynth* を混同）したのが原因で engine-first ⇄ OrbitStudio-first を往復した。**確定 = engine-first**（master plan 本来の方針）。
- **緊張を解く鍵**: `ORBITSCORE_ENGINE=rust` opt-in が既にある（S2）→ native を opt-in の裏で育て **今の .vsix で dog-food**（scsynth 同梱なし・throwaway ゼロ）→ cutover #108 → OrbitStudio が native を載せる。「使える」と「無駄ゼロ」が両立。
- **確定ロードマップ**: ① native を opt-in 裏で育てる（第1増分 = pan/slice/per-slice gain + α recovery floor #300）→ time-stretch/LinkAudio/γ sandbox/δ 3rd-party → cutover #108 → ② OrbitStudio(VSCodium) on native（scsynth 載せない・CLI+Claude 拡張必須・#301）→ ③ β audio DSL⊇pitch / audio 機能は後。engine の Studio 向け範囲 = サンプラー(in-process)+plugin host(effects)・scsynth 同等ではない。
- **更新ファイル**: POST_2.0_ENGINE_AND_DISTRIBUTION.md（§2.5 / §7 / status banner）, POST_2.0_MASTER_PLAN.html（banner / spine / §3 / Track A 表 / Track B / §9）。
- **関連 issue 再整理**: #301（OrbitStudio）= native の上・cutover 後・最初の /goal でない / #300（α）= engine 第1増分の構成要素 / #302（本訂正）。
- **最初の `/goal`** = engine 第1増分（pan/slice/per-slice gain + α recovery floor）。owner が /goal セット済。

**Commit**: dd5412b（PR #302）

### 6.150 docs(post-2.0): record engine architecture decision — in-process instruments + sandboxed plugins + audio egress (#298) (Jun 21, 2026)

**Date**: 2026-06-21
**Status**: ✅ docs/spec のみ（コア実装なし）。HTML タグバランス検証済
**Branch**: `298-post2.0-engine-arch-decision`（PR 予定・docs-only レビュー）

post-2.0 engine track（A0+S1+S1b #294 / S2 #297 MERGED）後の**次フェーズ設計を owner と確定**し、`POST_2.0_MASTER_PLAN.html` / `POST_2.0_ENGINE_AND_DISTRIBUTION.md §2` の確定決定を再訪して接地し直した。決定は owner 主導 + advisor 2回 + CLAP 一次情報（context7 `/free-audio/clap`）で検証。

- **決定軸 = 「DSL 表現力の着地点に flatten 境界を作らない」**。§2 の結論「楽器系 DSP は engine 内」は**維持**するが、*根拠*を「MIDI 駆動 hosted plugin では表現が落ちる」→「楽器は DSL 表現力の着地点だから flatten 境界を経由させない」に**置換**（ホスト対象は CLAP≠MIDI 1.0 で旧根拠は崩れた）。
- **配置**: 楽器（サンプラー/audio DSL）= **in-process（crown jewel・非交渉）** / effects + 3rd-party = **out-of-process sandboxed plugin**。判定 = DSL が per-note/per-slice 制御を要する→楽器側 / 純 audio→audio→plugin 側。
- **protocol ≠ placement**: 「MIDI を経由しない」はプロトコル（CLAP リッチイベント / `com.orbitscore.*` 超集合拡張）の話で in/out いずれでも可。in-process の真の利点は「表現力が自由に進化 + 税ゼロ」。
- **audio DSL ⊇ pitch DSL**（DSL 設計制約）: pitch モデル(C1)を audio DSL の真部分集合として設計。pitched synth は MIDI/MIDI2.0 で足りる（超集合投資はサンプラーが正当化）。
- **fault 3層**: ①app が daemon 死を生存（recovery floor）②daemon が 3rd-party crash を生存（out-of-process sandbox・未構築）③1st-party in-process crash は①でのみ捕捉。
- **egress（楽器でなく音を出す）**: (A)楽器 egress=standalone 出荷は劣化（別製品）/ (B)音 egress 無劣化 = **b1 薄い bridge プラグイン + standalone エンジン（主案・transport は free-running/follower/leader は standalone 専用）** / b2 engine 埋め込み（後付け）/ LinkAudio は非DAW 補助。制約: engine を clean に埋め込み可能に保つ。
- **ロードマップ（owner 再優先順位化・同セッション後半）= 土台2本 → 改良層**: 土台 = **① VSCodium化（OrbitStudio・2.0.0 parity が先決・最初の /goal = issue #301）+ ② ネイティブ音声エンジン（α #300 → γ sandbox → δ 3rd-party → cutover・①と並行可）**。改良層（土台の後・集中して）= **β audio DSL⊇pitch（+#213）/ audio 機能（slice/stretch）**。master plan の「Track B は engine の後（A1–A2 後）」を撤回し VSCodium を土台前倒し。β は改良層へ後置。旧 advisor 枠組み（"大転換"/"note 毎 IPC tax"）は overstated として棄却。
- **更新ファイル**: `POST_2.0_ENGINE_AND_DISTRIBUTION.md`（§2 全面書き換え + §6 に「2.0.x patch は v2.0.0 タグから分岐」+ §7/§8 をシーケンス/caveat 更新）、`POST_2.0_MASTER_PLAN.html`（Start-here バナー + 依存スパイン + §3 最初の1手 + Track A 表 + §6/§9/§10）。
- **持ち越し to-do 消化**: 「2.0.x patch は v2.0.0 タグから分岐」を §6 に明記。
- **最初の `/goal`（α か β）は別 issue で起草**（本 issue は docs/spec のみ）。

**Commit**: 494b1a7（PR #298）

### 6.149 feat(engine): S2 — daemon dispatch seam parity proof (SC stays default) (#296) (Jun 20, 2026)

**Date**: 2026-06-20
**Status**: ✅ TS 1144 pass / cargo test --workspace 全緑 / 実機 timing verdict = PASS
**Branch**: `296-daemon-dispatch-seam-parity`（PR 予定）

post-2.0 **S2**（master plan §4-A）。TS interpreter の音声ディスパッチを SuperCollider `OSCClient` seam から **Rust daemon（orbit-audio-daemon WebSocket）駆動**へ差し替え可能にし、timing parity を実証。**SC は出荷既定のまま**、Rust は `ORBITSCORE_ENGINE=rust` で opt-in（master plan §6 .vsix feature-freeze）。

- **スコープ確定（advisor×2 + ユーザー確認）**: posture = **parity proof（SC default 維持）**。#108「デフォルトを Rust に（cutover）」は後続フェーズへ defer（pan/slice/LinkAudio/time-stretch を欠く engine に出荷既定を移すのは時期尚早）。pan は S2 から defer（ファンダメンタル vs 機能詰め込みの分離）。
- **seam（Opus 判断・確定）= バックエンドレベル**: `AudioEngineBackend`（`Scheduler` + AudioEngine 面）を新設し、`SuperColliderPlayer` と新規 `RustEnginePlayer` が**ともに**満たす。`InterpreterState.audioEngine` を具象型→interface 化、`createAudioEngine()` が env で分岐。**既存 SC 経路は無改変**（1129 既存テスト無傷）。
- **lean daemon scheduler**: SC EventScheduler は LinkAudio/bufnum/`/s_new` 結合が重いため再利用せず、独立の最小スケジューラ（1ms poll を mirror）を新設。
- **timing モデル = poll-and-fire-now + 定数 lookahead**: SC=fire-now / daemon=schedule-ahead（自前 transport clock）を、poll 発火時に `playAt(daemonNowSec + lookahead)` で繋ぐ。clock anchor は StreamStats(1Hz) の transport now_sec で継続補正。
- **実機 timing verdict（ground-truth = observer 接続の StreamStats）**: lead `time_sec − trueNow` ≈ **min 38–48ms / max 48–58ms（全て正 → onset clip しない）**、anchor drift max ≈ **3–12ms**、inter-onset 誤差 max ≈ **2–7ms（相対 timing 保存）**、xruns **0**、transport rate ≈ **1.00**（複数 run の幅・gated は境界 assert）。→ load-bearing unknown を retire。
- **polymeter 実証**: 同 gated spec で seqA=400ms / seqB=300ms（3:4）を同時走行 → 各 inter-onset 誤差 ≤7ms・xruns 0 で**独立に保存**（parity を by-construction でなく demonstrated に）。境界: `.orbs` の full interpreter end-to-end は未実施（DSL→Sequence の周期計算は不変 TS 層・MIDI↔audio 同期は startTime/TransportClock 無改変で by-construction 維持）。
- **feature gap は boundary で明示**（見かけの parity を作らない）: pan≠0 → 1回 warn + 中央定位 / slice → 1回 warn + skip / outputChannel(LinkAudio) → 1回 warn + hardware fallback / master effects → 1回 warn + no-op。内部 `ScheduledPlay` は pan を保持（param-complete）。
- **テスト**: 新規 unit 22件（MockDaemonServer）+ gated 実機 spec 2件（timing / polymeter・`ORBIT_REAL_DAEMON=1`）。cargo test --workspace 全緑（core 14 / daemon protocol 13 + smoke 1 / native 16 / clap-spike 7）。
- **観測 hook**: `RustEnginePlayer` に `onDispatch`（telemetry / timing 計測・送信前に wallMs/daemonNowSec を coherent 採取）を追加。
- **PR レビュー（/simplify + /code:pr-review-team）反映**: getStatus 失敗の空 catch に warn 追加 / daemon 切断時は poll を停止し単一通知（console.error flood 回避・teardown race は isRunning ガードで抑制）/ master effects の silent no-op を warn 化 / ロード中 clear の再チェック追加。
- **A0 doc §14 に S2 verdict を記録**。DSL/MIDI 意味論は無改変（core spec 変更不要）。

### 6.148 review(spike): @claude bot second-opinion 対応 + PR レビュー規則を CLAUDE.md 化 (#294) (Jun 20, 2026)

**Date**: 2026-06-20
**Status**: ✅ #3 fix + S2/A4 carry-forward 記録 / build+test 緑 / 再レビュー不要（advisor 判断）
**Branch**: `293-clap-hosting-a0-s1`（PR #294）

internal pr-review-team（4観点×複数周）+ /simplify 通過後、**advisor に相談 → `@claude` bot に RT/clack correctness を scoped second-opinion 依頼**。bot が **internal が拾わなかった CLAP-spec-subtle な Important 3件**を検出（Critical 0）。いずれも spike の PASS verdict に無影響（テストシンセが当該パスを踏まない）:
- **#1 teardown スレッド**: `drop(stream)` で `stop_processing()` が main thread から呼ばれる（CLAP は audio thread 要求）→ S2 で `deactivate_and_stop_stream()` パターン。
- **#2 `request_callback` の `mpsc::send`**（alloc+lock）: プラグインが `process()` から呼ぶと RT 違反 → S2 で lock-free 通知。
- **#3 `EventBuffer` realloc 不変条件**: spike に `debug_assert!(len <= 1024)` regression guard 追加（**唯一の即時 fix**）。
- **advisor 判断**: S2 は daemon 統合の fresh 実装でこの spike binary のコピーではない → #1/#2 は spike を patch せず **A0 §13 に S2/A4 carry-forward として記録**（正しいパターンを残し S2 が一度で正しく作る）。**再レビュー不要**（debug_assert + doc 記録は docs-only 例外）。
- **CLAUDE.md（project + user）に PR レビューワークフロー規則を追記**: コード変更時は `/simplify` → `/code:pr-review-team`（Critical/Important=0 まで反復）を **MUST USE SLASH COMMAND**、通過後 advisor 相談 → bot review、docs のみは advisor とレビュー方法相談。
- **discontinued な `/code:autopilot` セクションを project CLAUDE.md から削除**（hook bypass の precedent は PR レビュー規則の「理由」に salvage）。

### 6.147 refactor(spike): /simplify 指摘を適用（behavior-preserving cleanup） (#294) (Jun 20, 2026)

**Date**: 2026-06-20
**Status**: ✅ build clean / unit test 7 pass / static+hot 実走回帰なし
**Branch**: `293-clap-hosting-a0-s1`（PR #294）

`/simplify`（reuse / simplification / efficiency / altitude の 4 cleanup エージェント並列・Skill tool 経由）の指摘を Phase 2 で適用:
- **A** `discovery.rs`: bundle ロードの unsafe FFI を `open_bundle()` に抽出（2関数の重複解消・unsafe 集約）。
- **D** `sink.rs::CountingSink::commit`: peak を per-sample `fetch_max`（2048回/callback）→ local fold して 1 atomic。
- **G** `audio.rs`: hot-install path を `self.install(msg)` に統一（install ロジックの重複解消）。
- **I** `buffers.rs`: channel count を既存 `total_channel_count()` 利用（dead_code 解消）。
- **J** `host.rs`: 未読の dead state（`PluginCallbacks` / `OnceLock`）削除・`initializing` を trait default に。
- **K** `audio.rs`: 未読の dead field `sink_frames` 削除（per-callback fetch_add も除去）。
- **L** `main.rs`: pump の `else` を共通後続に hoist。
- **H** `PostMixSink::commit` の「format は構築時固定」設計意図を doc 化（A4 向け）。**M** テスト名を sample 数に整合。
- **skip（理由付き）**: config fallback 統合（input/output の asymmetry が意図的）/ parse_args helper（clap 依存回避が意図的・borrow 複雑化）/ muxed 2パス（altitude が mux 構造を妥当と確認・RT 検証済）。
- RT hot path（`audio.rs::process`）はクリーンと 4 エージェントが確認。全変更 behavior-preserving。

### 6.146 fix(spike): pr-review-team 指摘対応（Critical 1 + Important 6） (#294) (Jun 20, 2026)

**Date**: 2026-06-20
**Status**: ✅ Critical/Important = 0 / unit test 7 追加 pass / 実走回帰なし
**Branch**: `293-clap-hosting-a0-s1`（PR #294）

`/code:pr-review-team`（code-reviewer / silent-failure-hunter / pr-test-analyzer / comment-analyzer 並列）の指摘を一括修正。**RT hot path の実バグは無し**（latent alloc は Fixed buffer / port rescan 非対応 / 低イベント率で防御済）:
- **Critical**: `hist_us` フィールド doc が stale（1µs/63µs → 50µs/51.2ms に修正・S2 監視の根拠数値）。
- **Important**: ① `plugin.process` のエラーを `process_error_count` で可視化 ② `event_scratch` 容量を event ring（1024）に合わせ comment を正直化 ③ driver thread panic を fatal 化（無効計測を握り潰さない）④ パース不能な plugin id を log（誤解を招く "No plugins found" 回避）⑤ `p99_ns()` 境界 unit test 4 件 ⑥ `ensure_buffer_size_matches` の RT eprintln を `cfg(debug_assertions)` gate。
- **Minor**: `buffers.rs` doc メソッド名 / config fallback log + is_input 型修正 / `_=>{}` 防御 fill / pump Disconnected log / request_callback コメント / hot-install≥measure 警告 / installed_at off-by-one コメント。
- **追加 unit test**: p99 境界 4 / CountingSink abs-peak + RingTapSink drop / add_to_cpal_buffer の ADD-mix 不変条件（A4 差し替え点）= 計 7 件 pass。
- security: secrets なし・`unsafe` は plugin loading の inherent・network/auth なし・全 deps permissive。

### 6.145 feat(spike): S1b — 低レイテンシ + release + dynamic hot-install を実証 (#295) (Jun 20, 2026)

**Date**: 2026-06-20
**Status**: ✅ S1b 完了（3 caveat retire）/ 既存テスト緑
**Branch**: `293-clap-hosting-a0-s1`（PR #294 に追加）
**Issue**: #295（Epic #292）

S1（PR #294）が retire していなかった3項目を `orbit-clap-spike` に CLI を足して実証:
- **S1b-1 低レイテンシ + release**: `--buffer-frames` 追加。128/256 フレーム（2.9/5.8ms budget）で xrun 0・resize 0・発音。**release + 128 frame で callback max 10.8µs（budget の 0.37%）**。小バッファほど相対余裕が大きい。
- **S1b-2 dynamic hot-install**: `--hot-install-after-secs` 追加。engine-only で stream 開始→稼働中に主スレッドで `activate`+buffers→`StartedPluginAudioProcessor`(Send) を **wait-free rtrb ring で audio thread に move→callback が一度 pop して install**（A0 §8 の所有権ハンドオフ）。install at callback #862(256f)/#1722(128f)=期待値、**move は alloc/lock なし・install callback で時間スパイク無し（max 45–49µs）**・install 後に発音。static 経路も回帰なし。
- **実装**: `OrbitAudioProcessor` の plugin/buffers を `Option` 化し static/hot を統一。`InstallMsg` は全 Send。
- A0 doc §13 に結果記録・§12 caveat を retire 更新。**残る未実証**: ノードグラフ / OutputEvents / sample-accurate offset / F32 のみ / hot-uninstall。

### 6.144 feat(spike): S1 — CLAP hosting を orbit-audio cpal callback に RT 統合（verdict=PASS） (#293) (Jun 20, 2026)

**Date**: 2026-06-20
**Status**: ✅ S1 verdict = **PASS（feasibility→proof）** / 既存テスト緑（Rust lib 16 + TS 1129）
**Branch**: `293-clap-hosting-a0-s1`
**Issue**: #293（Epic #292）

post-2.0 クリティカルパス先頭 S1 を実走し RT 安全性の verdict を確定。A0 §4 のアーキ（同一 cpal callback / プラグイン Mutex 外 / rtrb event seam / PostMixSink tap / static-load）を実装。
- **実装**: `rust/crates/orbit-clap-spike`（host・ワークスペース member・`publish=false`）= clack 公式 cpal example を headless 移植 + orbit-audio `Engine` 合算 + rtrb note seam + `PostMixSink`(Counting/RingTap) + 計測モード。`rust-spike/clap-test-synth`（独立 crate・自作 CLAP synth・良性/`CLAP_TEST_SYNTH_MISBEHAVE=1` で 4MB alloc+50ms lock の故意違反）。clack を `f874e85` git pin。
- **委譲（§7）**: synth と host 実装を Sonnet subagent 2 本に並列委譲（A0 §4 = 固定 interface）。**実走・計測・verdict は Opus が実ゲートで実施**（計測バグ 2 件を Opus が修正: p99 ヒスト域 64µs→51ms、発音証明 peak 出力追加）。
- **結果**: good 60s 持続 = **xruns 0 / callback max 509µs（budget 23ms の 2.2%）/ peak 0.25 発音 / resize 0**。misbehave 12s = callback 数 2594→**24 崩壊**・mean **494ms**・max **1.94s** で違反を決定的に検知。→ good の clean は実証検知できる計測上の clean。
- **★重要知見**: macOS CoreAudio + cpal は callback が 2 秒ブロックしても **err_fn xruns が発火しない**（good/bad 両方 0）。→ **xruns 単独は RT 違反検知に使えない**。production 監視は callback duration ベースにする（S2 以降・`StreamStats` に callback-time 分布追加）。A0 §12 に記録。
- **license gate（Opus・§1）**: 新 deps（clack-host/extensions/common/clap-sys/libloading/objc2/rtrb）全 permissive。closure に純 GPL/AGPL 無し（MPL=symphonia 既存・r-efi は MIT/Apache 選択）。
- **Caveat（S1b/S2 へ）**: 1024 フレーム（高レイテンシ）・debug build・static-load のみ・F32 のみ・単一プラグイン。dynamic hot-install / 低レイテンシ厳格テストは未実証。
- Stop&Report 条件（clack breaking / RT 不能 / tap 不成立）いずれも非該当。

### 6.143 chore(docs): WORK_LOG ログローテーション（2026-05 末尾 + 2026-06 前半をアーカイブ） (Jun 20, 2026)

**Date**: 2026-06-20
**Status**: ✅ 整合のみ（`PROJECT_RULES.md §1a` 準拠・欠落/重複なし検証済）
**Branch**: `293-clap-hosting-a0-s1`

main WORK_LOG が 140K（100KB 閾値超）に肥大したため月別アーカイブを実施:
- **最新 20 セクション（6.123–6.142）を main に保持**、古いものを月別に退避。
- **`docs/archive/WORK_LOG_2026-06.md` 新規**: 6.90–6.122（33 セクション）。
- **`docs/archive/WORK_LOG_2026-05.md` に追記**: 6.87–6.89（May 09–10 分・newest-first で 6.86 の上に挿入）。
- main footer に 2026-06 リンク追加。連続性検証で 6.64–6.142 が全て1回ずつ存在を確認。
- 結果: main 1424 行/140K → **325 行/32K**。

### 6.142 docs(post-2.0): A0 RT 統合設計 + Epic #292 / Issue #293 起票 (Jun 20, 2026)

**Date**: 2026-06-20
**Status**: 🟡 A0 設計完了 / S1 は Rust toolchain 未インストールで実行ブロック（Stop & Report）
**Branch**: `293-clap-hosting-a0-s1`
**Issue**: #293（親 Epic #292）

post-2.0 のクリティカルパス先頭 A0+S1（CLAP hosting）に着手。`POST_2.0_MASTER_PLAN.html` + 探索ノート + research を一次ソースに、既存 `rust/` エンジン（cpal callback / Scheduler / daemon）の実コードを照合して A0 設計 doc を作成。
- **Epic #292**「Post-2.0 Native Engine & OrbitStudio」+ 子 **#293**「A0+S1 CLAP hosting」を起票（B/C 子は投機的なので未作成）。
- **A0 doc** (`docs/development/POST_2.0_A0_RT_INTEGRATION_DESIGN.md`): スパイクの仮説＋kill-criteria として記述（「音が出た」では verdict 不可）。主要決定:
  - process() = **同一 cpal callback**（clack 公式 cpal example が同形）。プラグインは **Mutex 外**所有で silent-drop 回避。
  - イベント seam = **`rtrb`** lock-free SPSC ring。tap = **`PostMixSink` trait**（S1=stub / 実 LinkAudio=A4）。
  - **LinkAudioSink の解釈確定**: goal 文言「tap→`LinkAudioSink::commit`」は Rust LinkAudio が A4（S1 下流）のため成立不能 → S1 は tap 点＋RT-safe sink trait（stub）を証明、実体は A4。
  - ブロックサイズ: cpal `BufferSize::Fixed` 要求 + 事前確保（`activate()` の max_frames 整合）。
  - 受け入れ: ≥60 秒持続で xrun=0 + CPU 時間軸計測 + **故意 RT 違反プラグイン**で計測自体の有効性検証。
- **clack-host 実物検証**（GitHub 一次・2026-06-20）: v0.1.0 / MIT OR Apache-2.0 / deps 全 permissive・GPL なし / edition 2024・**MSRV 1.85.0** / cpal host example 同梱。
- **Stop & Report**: ローカルに `rustc`/`cargo`/`rustup` が無い（`~/.cargo`・homebrew・login shell いずれも不在）。S1 実装には **Rust ≥1.85 のインストールが前提** → ユーザー判断待ち。
- advisor 1 回相談（設計 + 委譲 + ambiguity の扱い）。

### 6.141 docs(post-2.0): post-2.0 マスター計画ドキュメント（HTML）(#289) (Jun 20, 2026)

**Date**: 2026-06-20
**Status**: ✅ ドキュメントのみ（レビュー反映済・HOLD: Epic/実装 Issue は承認後）
**Branch**: `289-post2.0-master-plan`

新規セッションが post-2.0 を実行に移せるよう、探索ノート3本（`POST_2.0_ROADMAP_NOTES` / `..._ENGINE_AND_DISTRIBUTION` / `..._PITCH_MODEL_NOTES`）+ research を一次ソースに統合した `docs/development/POST_2.0_MASTER_PLAN.html`（手書き HTML）を作成。`specs-v2/IMPLEMENTATION_INSTRUCTIONS.md` を範にコールドスタート実行可能な形（Start here → §1 不変条件 → §2 依存スパイン → §3 最初の1手 A0+S1 → §4 3トラック → §5 ゲート/停止条件 → §7 Delegation Profile → §8 運用規則 → §9 Epic 提案 → §10 Open Questions）。
- **確信度勾配を保持**（engine=DECIDED / hosting=FEASIBILITY / pitch=SPEC-FIRST / song=TENTATIVE）。advisor 2 回相談（構成 + Opus/Sonnet 切り分け）。
- **§7 Delegation Profile（Opus/Sonnet）**: 判定ルール1つ（Sonnet=IF 確定＋検証容易 / Opus=seam・判断 or 誤答が検証をすり抜ける）+「**委譲は Opus が実ゲートで検証**」を本セッションの実例（Sonnet 監査 5 件見落とし→bot 6 件目）で裏付け。
- **レビュー反映**: (a) Track A スコープ境界（MIDI/IAC は engine 非依存・接点は `TransportClock` のみ）/ (b) ライセンス節（自コード=コンポーネント別自由 / 依存=permissive が不変条件 / 現状 Source-Available v1.0 維持 / 名称統一は横断 TODO・#ops 共有済）。
- WCTM(#224) とは別トラック・締切なし。

### 6.140 docs(user): VitePress MIDI ピラー6ページを英訳 (#287) (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ ドキュメントのみ（`vitepress build` 緑・dead link 無し）
**Branch**: `287-translate-midi-en`

#237(PR #286) で追加した JA MIDI ピラー6ページに対し、EN スタブ（`sites/user/en/midi/` の「Translation pending」）を**実英訳に置換**。EN サイトの他10ページは翻訳済みで、かつ `en/reference/methods.md` §6 が `/en/midi/` を full documentation として参照していたため、その穴を解消。
- 翻訳6ページ: index / pitch-dsl / mode-scale / voicing / link-audio / quantize（計 902 insertions）。sonnet agent に委譲 → main がレビュー。
- 既存 EN（`en/reference/methods.md` §6・`en/basics/`）の用語・スタイルに整合。**DSL コード構文は不変**、コード内コメントのみ EN 化。frontmatter・`:::` admonition・内部リンク（`/midi/`→`/en/midi/`）・post-2.0 VOLATILE 警告を保持。
- 監査済みの技術事実（gate 0–1 クランプ / `^r`=-1/0/+1 / `.open()`=close→drop2 / `.mode()`+`.root()` 併用不可 / `^N` の degree 7 例）が翻訳でも正しく保持されていることを spot-check で確認。日本語残り0行・stale `/midi/` 絶対リンク無しも検証。

### 6.139 docs(user): bot second-opinion で gate(1.2) の誤記を修正 (#237) (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ ドキュメント修正のみ（`vitepress build` 緑）
**Branch**: `237-doc-reconciliation-2.0.0`

PR #286 に @claude bot を docs↔実装の精度スコープで second-opinion レビュー依頼。内部監査（6.138）が見落とした **1 件**を検出・修正:
- **index.md gate 表**: 「`1.2`＝次の音と重なる（レガート寄り）」とあったが、`seq.gate()` は `[0,1]` クランプ（`sequence.ts:487` `Math.max(0, Math.min(1, value))`）で `gate(1.2)` は無言で `1.0` になる。`1.2` 行を削除し、「上限 1.0・オーバーラップは `{ }` レガート」を案内する `::: info` 注記に置換。
- bot は他の全照合項目（メソッドシグネチャ・度数式・`^N`・voicing 演算・comp セル名・quantize 挙動・LinkAudio 制約）+ 6.138 の修正4件を実装一致と独立確認。
- bot の任意プロセ提案（`comp()` のチェーン評価順の注記）は未検証のため見送り（精度パス中に未確認記述を足さない方針）。

### 6.138 docs(user): VitePress ピラーページの正確性監査で 4 mismatch を修正 (#237) (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ ドキュメント修正のみ（`vitepress build` 緑・dead link 無し）
**Branch**: `237-doc-reconciliation-2.0.0`

sub-agent が 6.136 で書いた VitePress 6 ページをエンジン実装と突き合わせる正確性監査（sonnet agent + main の二重チェック）を実施し、**4 件の乖離を修正**:
1. **pitch-dsl.md `^N`**: degree 8 の構造的 +1 オクターブを見落とし、sticky シフト例の音名が 1 オクターブ誤り（`8=C5`→実際 C6、`8^0=C4`→実際 C5）。構造的オクターブの罠を避けるため例を degree 7／degree 1 に書き換え（`sequence.ts:917-927` + `degree-resolution.ts:96-102` で裏取り）。
2. **mode-scale.md**: 例が `.mode(dorian).root(2)` を使用していたが、`.mode()` と `.root()` は同一グループに併用不可（`resolveScopeToContext` で相互排他・`seq.mode()` 既定も無い）。「グループごとのモード切替」と「`.root()` 単独のルート移動」の 2 例に分割。
3. **voicing.md `^r`**: 実装は `Math.floor(random*3)-1`＝`{-1,0,+1}` 一様（約 1/3 で移動なし）だが「±1 oct 上 or 下に移動」と記載 → 「-1/0/+1（0=移動なし）」に訂正。
4. **voicing.md `.open()`**: 実装は close→上から 2 番目の声部を 1 oct 下げる（Drop 2、`resolve-chords.ts:314-318`）だが「オープンポジション」のみ → 正確な定義に。
- 残り 30+ クレーム（drop/invert/shell/rootless/voicelead/comp/cell/density/quantize/linkAudio 等）は実装と一致を確認（mismatch 無し）。「ビルド成功 + リンク解決」は正確性の代理指標にすぎず、挙動クレームの実装照合が本質という advisor 指摘に基づく監査。

### 6.137 docs(user): reconcile README.md + 拡張 README を 2.0.0 へ整合 (#237) (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ 整合のみ（コード変更なし・テスト 1129 緑）
**Branch**: `237-doc-reconciliation-2.0.0`

ルート `README.md` が 2.0.0 と正面衝突する drift を解消（spec より drift が深かった）:
- MIDI を「Migration Notice（MIDI→audio 移行中）」「Legacy MIDI-Based (Deprecated)」「CoreMIDI/IAC Bus = not implemented」の **3 か所で死んだ機能扱い** → 2.0.0 の現役ピラーへ訂正。
- ヘッダを audio+MIDI 両出力に。Core Features に「🎹 MIDI & Pitch (2.0.0)」節追加（MIDI output / Pitch DSL / comp / LinkAudio / quantize）。「DAW Integration: VST/AU (planned)」→ LinkAudio 実装済に。
- Current Implementation Status を「2.0.0 is released」+ ピラー一覧に。歴史的詳細（audio phases / ICMC v1.1.0 / Phase 6-7 achievements / legacy MIDI phases）は `<details> Development history` へ退避。
- Technology Stack に MIDI(CoreMIDI/IAC)・Ableton Link を追加し「not implemented」行を削除。USER_MANUAL を canonical→**deprecated**（学習サイトを正規リンクに）。テスト数を「1129 passed, 23 skipped (1152) — 2.0.0」に更新。`v3.0`/`2.0.0-dev` の version label を一掃。
- `packages/vscode-extension/README.md`（.vsix の顔・最終更新 5/6 で 2.0.0 ピラー記載 0）: 「New in 2.0.0」節（5 ピラー）追加、`v1.x`→`2.0.0`、User Learning Site リンク追加。
- ライセンス節・examples 音楽内容は不変。#138 cold-install は実状況不明のため `⏳ Pending` 保持。

### 6.136 docs(user): VitePress user site に 2.0.0 ピラーページ追加 (#237) (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ ドキュメントのみ（`vitepress build` 成功・dead link 無し）
**Branch**: `237-doc-reconciliation-2.0.0`

`sites/user/` に 2.0.0 の 5 ピラー解説を追加（JA 6 ページ + EN 6 スタブ）:
- `midi/` (JA): index（MIDI 出力・IAC 準備・`seq.midi/octave/vel/gate`・`global.key/midiLatency`）/ pitch-dsl（度数・変音記号・`^N` スティッキー・`[ ]` コード・`*n`・パターン/セクション変数・`{ }` レガート・`_` タイ・`@v`/`@g`）/ mode-scale（`mode()` ラティス・グループ適用・`.root()` スコープ）/ voicing（drop/invert/open/close/shell/rootless・ランダム・`.voicelead()`・`.comp()`/`.cell()`/`.density()`）/ link-audio（`linkAudio()`・`output()`・テンポリーダー・MIDI 共存）/ quantize（`global/seq.quantize()`・RUN は常に即時）。
- EN は `en/midi/` に「翻訳保留・JA 参照」スタブ 6 件。
- `reference/methods.md`（JA/EN）に §6 MIDI 出力を追加。`sidebar.ts` に「MIDI とピッチ表現（v2.0.0）」節（JA/EN）追加、「困ったときは / Help」を 15/16 に繰り下げ。
- root/key/scale 関連ページに「post-2.0 で見直し予定」警告ブロック。session-log は opt-in（dormant）の一行注記のみ。

### 6.135 docs(user): deprecate USER_MANUAL ja/en → VitePress (#237) (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ deprecate バナーのみ（本体は履歴保持）
**Branch**: `237-doc-reconciliation-2.0.0`

`docs/user/ja|en/USER_MANUAL.md` は完全に pre-2.0（audio-only・新ピラー 0・en は `brew install supercollider` のまま）。先頭に **DEPRECATED バナー**を追加し VitePress user site（`sites/user/`）へ誘導。本体は履歴として保持（削除しない）。

### 6.134 docs(spec): SoT spec を 2.0.0 実態へ整合 (#237) (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ 整合のみ（コード変更なし）
**Branch**: `237-doc-reconciliation-2.0.0`

post-2.0 の前提として、3観点ドリフト監査（Pitch DSL / core+LinkAudio+session-log / version+status）の結果を `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` に反映（75+/34-）:
- **version**: ヘッダを「OrbitScore 2.0.0 — DSL Specification」+ `ENGINE_VERSION 2.0.0 / DSL_VERSION 1.1` 明記。
- **§12/§13**: Completed に quantize・session-log(dormant) 追加 / Not-Yet に slice(#239)・audio `[ ]` stack(#238) 追加 / 「Deferred: @v expression」は stale 削除（E5 実装済）/ テスト数を脱ハードコード。
- **構造**: 重複していた `## 8.` を解消し §9–§13 へ renumber（cross-ref も更新）。P.11/P.12 の番号順を修正。
- **core §1–§8**: §7 underscore methods を「2.0.0 未実装」明記 / §1 singleton（変数名でreuse）/ §2 key()=実装済・tick()=未 / §6 formats に aif・flac 追加・48k/24bit ハードコード削除 / §5 `global.start()` は即時 / §8.1.2 MIDI 除外(#282) + warn 毎回 / §8.1.3 fallback warn は再生時 / §8.1.4 **Live→OrbitScore tempo は未実装**（leader-push のみ #283）。
- **VOLATILE（post-2.0 redesign pending）**: P.1/P.5 root/key/scale に注記 + `POST_2.0_PITCH_MODEL_NOTES.md` ポインタ。P.5 の `seq.root(C)` 誤例を `seq.root(1)`+「seq は数値のみ・#280」へ。`seq.mode()` は group のみと訂正。P.4 mode period=highest element、`.r`=per-slot を明記。

### 6.133 chore: @claude bot レビューの low 指摘対応 + 初回ノート遅延を #285 で追跡 (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ build 緑 / 1129 passed | 23 skipped
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

PR #281 の `@claude` bot レビュー（結論「マージブロッカー無し・round-1/2 fix を追認」）の非ブロッカー指摘に対応:
- `packages/engine/supercollider/setup.scd`: 末尾改行追加（cosmetic・複数回指摘）
- `scripts/qa-midi-smoke.sh`: `perl -e "sleep ${DWELL}"` → `perl -e 'sleep $ARGV[0]' -- "${DWELL}"`（env 値が perl コードとして展開されるのを回避）
- **[Medium] 初回ノート最大2秒ブロック**（plugin-present の lazy probe・`timeoutMs=2000`）は **#285 で post-release 追跡**（2.0.0 ブロッカーではない。plugin-absent は boot 配線済みで回避済み）。

### 6.132 chore(deps): npm audit fix — resolve shipped `ws` (high) before 2.0.0 (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ build 緑 / 1129 passed | 23 skipped
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

2.0.0 リリース前の dependabot 対応。**.vsix に出荷される production 依存**を切り分けて非破壊修正:
- `npm audit fix`（semver 互換のみ・`package-lock.json` のみ変更）で production の **`ws`(high: memory disclosure / DoS)** 等を解消。
- 修正後の production audit: **6 moderate のみ**（すべて supercolliderjs(alpha) の transitive。非破壊では直せず upstream 待ち。攻撃面は localhost scsynth 接続のみで実リスク低）。**出荷物の high/critical は 0**。
- 残る critical 1 / high は **devDependency（vitest/eslint/build 等・.vsix 非同梱）**。`--force`（破壊的）を要しリリース toolchain を不安定化させ得るため post-release / dependabot PR で追跡（2.0.0 はブロックしない）。

### 6.131 release(2.0.0): drop -dev, finalize 2.0.0 — last feature .vsix (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ build 緑 / 1129 passed | 23 skipped / simplify + pr-review-team(Critical=0/Important=0) + security PASS
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

`2.0.0-dev` → `2.0.0` に確定。v1.1.1 以降の新ピラー（MIDI 出力 / Pitch DSL / comp / session-log / LinkAudio）を束ねた**最後の機能 .vsix リリース**（post-2.0 は専用アプリ OrbitStudio へ移行。`docs/development/POST_2.0_ROADMAP_NOTES.md`）:
- `packages/engine/src/version.ts`: `ENGINE_VERSION` `2.0.0-dev` → `2.0.0`
- `packages/vscode-extension/package.json`: version `2.0.0-dev` → `2.0.0`（= .vsix 版）
- 配布は **GitHub Release のみ**（marketplace は後日・#197 PAT 未登録）。merge 後に tag + Release。
- session-log は dormant（既定 off・#229 redesign は post-2.0）/ #280（`seq.root(note-name)`）は known issue（post-2.0 の root 後置一本化で解消予定）。
- 残 QA（実音 H 項目・学習サイト walkthrough）は OrbitStudio へ defer（Epic #278 disposition）。

### 6.130 fix(link-audio): pr-review-team round 2 — clear in-flight probe map on stopAll + log best-effort catches (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ build 緑 / 1129 passed | 23 skipped
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

round-2 再レビュー（code-reviewer + silent-failure-hunter）で round-1 の Critical/Important が全解消と確認。round-1 の並行ガード fix が導入した新規 Important 1 件 + minor を修正:
- **Important**: `stopAll()` で `resolvingChannel`（in-flight probe memo）が未クリア → stop-then-play の狭いレースで stale 結果共有 → `this.resolvingChannel.clear()` 追加。
- minor: `stopAll()` で `warnedAboutMissingPlugin=false` リセット（次セッションで plugin 不在 warn 復活）/ `setLinkTempo` の空 catch → warn（global.ts の round-1 fix がこの層で握り潰されていた）/ `ensureLinkAudioChannelRegistered` の空 catch → warn（防御的）。

→ pr-review-team は **Critical=0 / Important=0** に収束（round 1 fix → round 2 verify → round 2 新規 Important を本コミットで修正）。

### 6.129 test(link-audio): pr-review-team round 1 — close test-coverage gaps (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ 1129 passed | 23 skipped（+18 tests・regression 0）
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

pr-test-analyzer の Critical/Important カバレッジギャップを補完:
- TA1 `OSCClient.registerLinkAudioChannel`: /done→true / timeout→false / transport error→rethrow（`tests/audio/osc-client-register.spec.ts`）
- TA2 `loadLinkAudioSynthDef`: file 不在→false/送信0 / 両在→`/d_recv` 2回順序 / keepalive 欠如→1回+warn（`tests/audio/synthdef-loader.spec.ts`）
- TA3 session-log gate: `shouldEnableSessionLog()` を `cli/session-log-gate.ts` に抽出（play/repl から使用・挙動不変）+ 全分岐 test（`tests/cli/session-log-gate.spec.ts`）
- TA4 `output()→registerLinkAudioChannel` 配線（`sequence-output.spec.ts` の mock + assert）
- TA5 `resolveLinkAudioChannel` が transport error で throw せず hardware fallback（`link-audio-dispatch.spec.ts`）
- TA6 `boot()` が load 失敗時に `setLinkAudioPluginAvailable(false)` + warn（`supercollider-player-boot.spec.ts`）

### 6.128 fix(link-audio): pr-review-team round 1 — correctness/robustness fixes (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ build 緑 / 1111 tests passed / C++ cmake compile 検証済
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

`/code:pr-review-team`（code-reviewer/silent-failure-hunter/pr-test-analyzer/comment-analyzer）の Critical/Important を修正（テスト追加は別コミット）:
- **Critical**: `orbit_link_audio_out.cpp` の `g_beatAnchorSet`/`g_anchorBufCounter`/`g_anchorMicros` を `PluginLoad` でリセット（scsynth プロセス内再起動時の符号付きアンダーフロー → beat 破綻を防止）。
- **Important**:
  - `event-scheduler.stopAll()`: `linkAudioPluginAvailable=null` リセット（次セッション再 probe）。
  - `supercollider-player.boot()`: `loadLinkAudioSynthDef()` 戻り値を `setLinkAudioPluginAvailable(false)` に配線（plugin 不在時の 2000ms lazy timeout 解消）。
  - `event-scheduler.resolveLinkAudioChannel()`: per-channel 並行ガード（in-flight memo）+ 2本目以降の登録 boolean 捕捉（timeout は warn + fallback）。
  - `osc-client.registerLinkAudioChannel()`: catch を timeout（`false` latch）と transport error（rethrow → `null` 維持で再 probe）に分離。
  - `synthdef-loader`: keepalive `.scsyndef` 欠如時の warn。
  - `event-scheduler.stopAll()`: `void freeNode` → `.catch`+warn。
  - `global.pushLinkTempoIfLeading`: 空 `.catch(()=>{})` → warn。
  - stale コメント（"boot pipeline が flip" 系）を実態（null=未 probe / boot は load-fail 時のみ false / lazy probe が true）に修正。

### 6.127 refactor(engine): /simplify pass の挙動不変クリーンアップを適用 (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ build 緑 / 1111 tests passed
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

2.0.0 finalize 前の `/simplify`（4 agent: reuse/simplification/efficiency/altitude）の**挙動不変な品質 fix のみ**を適用:
- `diagnostics-analysis.ts`: `.output()` と `.midi()` の重複スキャン2パスを**単一パス**に統合（keystroke ごとの hot-path コスト削減・分類結果は不変）。3 agent 一致指摘。
- `synthdef-loader.ts`: 4箇所の inline `setTimeout` を private `sleep(ms)` に抽出（delay 値据え置き）。

**skip（simplify スコープ外＝挙動変更/correctness → pr-review-team へ回送）**:
- altitude #1: `g_beatAnchorSet`(C++) が scsynth 再起動で未リセット → 負オフセットの恐れ。
- altitude #2: `stopAll()` で `linkAudioPluginAvailable` 未クリア（セッション跨ぎの stale state）。
- altitude #4: boot の `loadLinkAudioSynthDef()` 戻り値未配線 → plugin 不在時に初回 dispatch で 2000ms timeout。
- C: event-scheduler の冗長 `has()` ガード（agent 間で見解割れ・リスク回避で保留）。
- D: `removeEffect` の `/n_free` 直送 → 新 `freeNode()` 置換（diff 外の既存行のため保留）。

### 6.126 docs(post-2.0): engine/pitch/song/distribution 方向 + Rust hosting research を記録 (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ 記録のみ（実装なし・探索段階/未確定・post-2.0）
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

**内容**: 2.0.0 以降の方向性を大和さんと議論し durable 化（WCTM とは別トラック）。
- `docs/development/POST_2.0_ROADMAP_NOTES.md` — engine-first / 全体方向 / features deferred / session-log redesign 北極星。
- `docs/development/POST_2.0_PITCH_MODEL_NOTES.md` — root/key/scale + song(arrange) 層の再設計（root=後置一本化〔絶対=音名/相対=大文字ローマ〕, key=2軸カスケード頂点, conductor 等）。
- `docs/development/POST_2.0_ENGINE_AND_DISTRIBUTION.md` — engine=Rust(既存 `rust/`) 方向 / 薄いホスト+DSPプラグイン / Fair Trade 内部基盤 / freemium⟺permissive / 層構造 monetization / Steam+notarize 配布 / OrbitScore=言語・OrbitStudio=アプリ。
- `docs/research/NATIVE_ENGINE_TRACKTION_VSCODIUM.md`（結論は ENGINE_AND_DISTRIBUTION が更新）/ `docs/research/RUST_PLUGIN_HOSTING.md` — Rust 3rd-party ホスティング feasibility（CLAP>AU>VST3・VST3 は SDK 3.8 で MIT 単独化・engine=Rust 確定方向、残る証明は CLAP 統合スパイク+RT 統合設計）。

### 6.125 fix(session-log): make .orbslog dormant (opt-in) for 2.0.0 finalize (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ build 緑 / session-log ユニット 26 件緑
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

**背景**: 6/18 ライブで `.orbslog` が生成されない / LinkAudio 送出トラックが記録されない不具合。原因は現行が **file-scoped**（`<basename>.<stamp>.orbslog`）で、複数ファイルをまたぐ1セッションに合わない**設計ミスマッチ**。finalize 中にパッチせず dormant 化し、redesign（session-scoped・全トラック捕捉・L2 replay #241/分析 #242 対応）は post-2.0 へ（`POST_2.0_ROADMAP_NOTES.md`）。

**変更**:
- `cli/play-mode.ts` / `cli/repl-mode.ts` の `enableSessionLog()` を **`ORBITSCORE_SESSION_LOG=1` の opt-in 裏に退避**（既定 off・既存 `ORBITSCORE_DEBUG` と prefix 整合）。
- writer (`core/session-log/`) / API / 26 ユニットは**保持**（resurrect 可）。

### 6.124 feat(link-audio): OrbitScore を Link テンポリーダーに (#283) (Jun 18, 2026)

**Date**: 2026-06-18
**Status**: ✅ 実装・テスト済（実機受け入れは大和さん: `global.tempo(72)` eval → Ableton BPM 追従を目視）
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

**要望（大和）**: `global.tempo()` を設定すると Ableton が追従してほしい = OrbitScore を Link テンポリーダーに。

**設計（advisor 承認・「軽い方の道」）**: plugin が tempo を push する → `global.tempo == Link tempo`
が構造的に保証 → MIDI(global.tempo 自走) と Audio(Link beat) が**自動で揃う**。scheduler を
Link beat 駆動に作り変える必要がない（その逆方向 follower 強化の方が重い）。

**実装**:
- C++ `ChannelRegistry::setLinkTempo(bpm)`: app スレッドの `captureAppSessionState()` →
  `setTempo(bpm, clock().micros())` → `commitAppSessionState()`。audio スレッドの
  `captureAudioSessionState` と並行安全（Link の app/audio session-state 分離の正規用法）。
- C++ `/cmd /orbit/setLinkTempo <bpm>` ハンドラ（同期・/done 不要、bpm を 20..999 で検証、
  `getf` が int/float 両対応）。PluginLoad で登録。
- engine: `OSCClient.setLinkTempo` → `EventScheduler.setLinkTempo` → `SuperColliderPlayer.setLinkTempo`、
  `AudioEngine.setLinkTempo?`、`Global.pushLinkTempoIfLeading()` を tempo()/linkAudio()/start() から呼ぶ
  （ファイル順 tempo→linkAudio を吸収するため3点）。

**制約（重要・本番ルール）**: Link は last-setter-wins。OrbitScore が唯一のテンポ設定者である間だけ
MIDI/Audio が揃う。**Live 側でテンポを動かすと Link tempo が global.tempo と乖離し MIDI がドリフト**
（scheduler は Link に追従しない）。本番は「テンポは OrbitScore のコードで設定、Live のテンポは触らない」。

**検証**: unit（global.tempo→setLinkTempo 送信 / linkAudio off は非送信 / ファイル順吸収 /
start 再アサート / 任意能力欠如で throw なし、EventScheduler 委譲）。全 1111 passed（+7）。
.scx に `/orbit/setLinkTempo` シンボル + vsix 同梱を確認。**実機受け入れ（Ableton BPM 追従の目視）は大和さん**。

**Commit**: fdbfc10

### 6.123 fix(link-audio): MIDI シーケンスを LinkAudio strict-mode から除外 (#282) (Jun 18, 2026)

**Date**: 2026-06-18
**Status**: ✅ 修正・テスト済（実機再テストは大和さん）
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

**発見**: IAC(MIDI) + LinkAudio(Audio) 共存サンプル（examples/19）の MIDI 部分を
`LOOP(piano, inner, bass)` した時点で runtime error:
`Sequence 'piano' has no .output() channel set, but global.linkAudio() is enabled.`

**原因**: `Sequence.run()`(sequence.ts:1205) と `loop()`(1249) が `resolveDispatchChannel()`
を **`isMidi()` ガード無しで** eager 呼び出し。schedule 経路(1115/1185)は MIDI で早期
return するが eager validation は通らず、LinkAudio strict-mode の「`.output()` 必須」が
MIDI シーケンスにも誤適用されていた。VS Code 診断 `analyzeLinkAudioMissingOutput` にも同型バグ。

**仕様（共存は正本で支持済み・spec 変更不要）**:
- DESIGN_DISCUSSION_RECORD #14「MIDI と SC オーディオは併走可 / 排他にする技術的理由がない」
- IMPLEMENTATION_INSTRUCTIONS「MIDI に LinkAudio 型の排他は適用しない」
- core spec §8.1.2「全ての**発音** sequence が `.output()`」← 発音=オーディオ限定

**修正**:
1. engine `resolveDispatchChannel()` 冒頭に `if (this.isMidi()) return undefined`（全4呼出点を一括で MIDI 安全化）。
2. vscode-extension `analyzeLinkAudioMissingOutput` で `.midi(` を持つ名前を orphan から除外。

**検証**: ユーザーの throw を正確に再現する unit test（MIDI+linkAudio+no output →
`resolveDispatchChannel()` が undefined / audio は throw 継続）+ 診断テスト（MIDI 非 flag /
混在ファイルで audio のみ flag）。全 1104 passed（+5）。engine dist と extension dist
（vsix 同梱）の両方に反映を確認。

**Commit**: 5dc2975

## Archived sections

Older entries have been archived by month for readability:

- [2025-09](../archive/WORK_LOG_2025-09.md)
- [2025-10](../archive/WORK_LOG_2025-10.md)
- [2026-02](../archive/WORK_LOG_2026-02.md)
- [2026-04](../archive/WORK_LOG_2026-04.md)
- [2026-05](../archive/WORK_LOG_2026-05.md)
- [2026-06](../archive/WORK_LOG_2026-06.md)
