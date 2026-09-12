# 設計: `engine_wrap.rs` の分割 — #888 子 1 の**最初の 1 束**（統計・ヘルス・メトリクスのアクセサ）

**対象 issue**: #888（Epic・ファイルサイズの規律とネイティブ前の分割）子タスク 1・最初の抽出
**関連**: [`888-file-size-ratchet-design.md`](888-file-size-ratchet-design.md) §13（束の数え方・§13.8 抜け道・§13.9 未明文の制約）/ [`BUNDLE_BRANCH_WORKFLOW.md`](../development/BUNDLE_BRANCH_WORKFLOW.md) §5.1 / main のオリエンテーション（scratchpad `888-child1-orientation.md`）
**正本**: 本書は spec ではない。規律の正本は issue #888 本文と CLAUDE.md。本書は**最初の 1 束の実装設計**で、抽出後は `engine_wrap/stats.rs` の冒頭コメントが一次情報になる
**状態**: 設計（実装しない）・2026-09-12・ブランチ `888-file-size-ratchet`（子 0 の 3 コミット `04c5cb1e` / `e0a14637` / `50931ce0` を含む）で実測
**起案**: Fable（effort: high）。数値は**すべて scratchpad の複製ツリーで実際に抽出して測った**（`git diff --no-index` の residual・子 0 のカウンタ・`cargo test` / `clippy` / `fmt`）。机上の見積もりは含まない

---

## 0. 確定事項と、本設計が決めたこと

### 0.1 確定事項（再議論しない）

| # | 事項 | 出どころ |
|---|---|---|
| 1 | **4.0.1 は Rust 分割のみ・振る舞い不変**。検算は「既存テストの期待値を 1 つも変えていない」 | #888 コメント 1 |
| 2 | 閾値 = **コード行 500**。子 0 のラチェット（`tests/repo/file-size-ratchet.spec.ts` + `file-size-baseline.json`）が強制。現在の baseline: `engine_wrap.rs` = **6,418** | #888 本文・子 0 |
| 3 | **新しい抽象を発明しない。既にある兄弟モジュールへ、そこにあるべきものを戻す** | #888 受け入れ条件 4 |
| 4 | 分割で生まれる新ファイルは**同じ PR 内で 500 コード行以下**（「粗く割ってから細かく」は取れない） | 設計 §13.9 制約 1 |
| 5 | 外出しする test mod のファイル名は `tests.rs` か `tests/` 下でないと**測定対象になる** | 設計 §13.9 制約 2 |
| 6 | 🔴 **束の上限を residual で判定するかは owner 裁定待ち**（設計 §12 の 4）。最初の 1 束は**どちらの裁定でも成立する規模**にする（素の変更行でも 1,500 以下） | ブリーフ |
| 7 | 分割束は **1 束 = 1 元ファイル**（2 つの元ファイルを混ぜない） | 設計 §13.4 の 2 |

### 0.2 本設計が決めたこと（§3〜§7 で根拠を示す）

| # | 決定 | 節 |
|---|---|---|
| **E1** | 最初に切り出すのは main の見立てどおり**統計・ヘルス・メトリクスのアクセサ 40 メソッド**（`impl EngineWrap` の 85〜124 番目）。ただし範囲は**行 8972〜9550**（`clap_post_peak` の doc コメントから `output_channels` の `}` まで）。🔴 **8976〜9552 ではない** — 属性と doc コメントを置き去りにすると `#[cfg(feature = "clap-host")]` が隣の `load_sample` に付き替わって**別 feature でコンパイルが壊れる**（複製ツリーで実際に踏んだ） | §3 |
| **E2** | 行き先は **`rust/crates/orbit-audio-daemon/src/engine_wrap/stats.rs`**。`engine_wrap.rs` の**子モジュール**（`mod stats;`）として置き、`use super::*;` + `impl EngineWrap { … }` で包む。**兄弟モジュール（`src/engine_stats.rs`）にはしない** | §4 |
| **E3** | 🔴 **可視性の変更は 0 件**。子モジュールは親の private フィールド・private `use` に到達できるので、`pub(crate)` 化は 1 つも要らない。これは Rust の privacy 規則の帰結で、**複製ツリーの `cargo check` / `clippy -D warnings` / `cargo test`（CI と同じ feature 5 組 + `link-audio`）で実証済み** | §5 |
| **E4** | **インラインテスト mod は動かさない**（`outproc_health_tests` / `outproc_instrument_health_tests` は `engine_wrap.rs` に残す）。理由: (a) コード行に数えられないので目標に寄与しない、(b) 動かすと素の変更行が約 3,100 になり裁定 6 の「どちらでも成立」を破る、(c) 親の private 型・フィールドを直接触っているので移設は `use` の書き換え = residual を生む、(d) `tests/**` への移設と residual の扱いは子 0b で決める（設計 §13.9 の 3）。**テスト側の差分は 0 行** | §4.2 |
| **E5** | `mod stats;` の宣言位置は**ファイル先頭ではなく `impl EngineWrap { … }` の閉じ括弧の直後**（元の行 9813 の後）。先頭に置くと**ファイル全体の行番号が +2 ずれ、dev サイトの引用（`// file:start-end`）が約 20 箇所すべて動く**。閉じ括弧の直後なら動く引用は元々ずれる 2 箇所（×2 言語）だけ | §4.3 |
| **E6** | 検算は 6 段（§6）: 素の変更行 / `--color-moved` residual（**期待値は 13 行・中身まで固定**）/ テスト件数 `365 → 365` と `excluded` 行 `7,730 → 7,730` の不変 / CI と同じ cargo 5 組 + fmt + clippy / `npm test`（baseline を **6,014** に下げる）/ `npm run docs:check`（引用 2 箇所 ×2 言語を**手で検証して**再アンカー） | §6 |
| **E7** | この束は**小 PR**（draft・base = 子 1 の統合ブランチ）として出す。「その PR が足した E2E」は無い（DSL 表面を足していない）ので実機は束の締めで回す。統合ブランチ名と束の構成（`engine_wrap.rs` を何束に割るか）は main が決める | §6.6 |

---

## 1. 到達点（1 文）

**`engine_wrap.rs` から行 8972〜9550 の 579 行を `engine_wrap/stats.rs` へ塊のまま動かし、`engine_wrap.rs` のコード行を 6,418 → 6,014 に減らす。差分は「移動 579 行 + 意図して足した 13 行」だけで、テスト・呼び出し側・可視性・振る舞いは 1 行も変わらない。**

---

## 2. 現在地（一次情報・本書が前提にするもの）

| 事実 | 根拠 |
|---|---|
| `engine_wrap.rs` は 15,678 行・コード行 **6,418**・インライン test mod **7,730 行**（除外）・残りは空行/コメント | 子 0 のカウンタ（`tests/repo/code-lines.ts`）で本日実測 |
| 本体は単一の `impl EngineWrap`（行 5005〜9813・**141 メソッド**）。それ以外の top-level item は型・定数・自由関数・test mod | `grep -nE '^(pub… )?(fn\|struct\|enum\|impl\|mod…)'` の一覧（scratchpad） |
| 85〜124 番目のメソッド（`clap_post_peak` 〜 `output_channels`）は**属性・doc コメント込みで行 8972〜9550**。直前 8971 と直後 9551 は空行 | `sed -n '8955,8977p;9540,9556p'` で境界を目視 |
| この 40 メソッドは**すべて `pub fn`**。触るのは `self` の private フィールド 15 個（`engine` `clap` `clap_process_errors` `plugin_event_ring_overflow_count` `outproc` `outproc_frames_clamped` `outproc_instrument` `outproc_instrument_{child_errors,respawns,measurement_invalid,output_dropped}` `link` `link_egress_drops` `stream_stats` `started_at`）と `pub fn stream_config_snapshot`（同 impl の 138 番目・残す側）だけ。**private メソッドは 1 つも呼ばない** | 行 8972〜9550 の読解 + `self\.` の grep |
| `outproc_health_tests`（行 12570〜13149）と `outproc_instrument_health_tests`（13151〜13560）は `use super::{ChildLaunch, ChildSlot, EffectRole, EngineWrap, OutProcControl, …}` で親の private 型を引き、`wrap.outproc` / `wrap.outproc_instrument` を**直接代入**して accessor を叩く | 各 mod の冒頭 30 行 |
| リポジトリに `foo.rs` + `foo/` の子モジュール構成は**まだ無い**（`src/` 直下の dir は `bin/` のみ）。edition 2021 なので `mod.rs` は不要 | `find rust/crates -type d -path '*/src/*'` / `rust/Cargo.toml:39` |
| CI の cargo は **5 組**: `--workspace` / `--features clap-host` / `outproc-effect` / `outproc-instrument` / `outproc-effect,outproc-instrument`（`rust-ci.yml:88-117`）+ `cargo fmt --all --check` + 各組の `clippy --all-targets -D warnings`。`link-audio` は CI に無い（`ORBIT_LINK_DIR` が要る・default off） | `.github/workflows/rust-ci.yml` / `orbit-link-audio/build.rs:10-11` |
| dev サイトの検証される引用（`// path:start-end` のフェンス）で `engine_wrap.rs` の **8972 行以降**を指すのは 2 箇所 × 2 言語: `sites/dev/{,en/}rust-engine/index.md`（9765-9774・`render_offline`）と `sites/dev/{,en/}plugin-hosting/plugin-ui.md`（10474-10487・`PluginUiTarget`） | `grep -rnoE 'engine_wrap\.rs:[0-9]+-[0-9]+' sites/dev --include='*.md'` |
| 子 0b の `scripts/repo/move-residual.sh` は**まだ無い**（`scripts/repo/` 自体が無い） | `ls scripts/repo/` |

---

## 3. Q1 — 最初に切り出すグループ（E1）

**main の見立てに同意する。** 根拠は 3 つで、いずれも読んで確かめた。

1. **依存が最も薄い**: 40 メソッドは private フィールドの `lock` / `try_lock` / `load` と `Engine` の public メソッドしか使わない。`impl` 内の private ヘルパー（`lock_samples` `lock_active_notes` `push_plugin_event` 等 30 本）を**1 本も呼ばない**。他のグループはこれが成り立たない（例: 67〜84 のノート群は `lock_active_notes` / `push_outproc_instrument_event` / `public_plugin_note_error` を共有し、40〜54 のバス群は `device_dest_from_wire` 等を共有する）
2. **呼び出し側の変更が 0**: すべて `pub fn` で、inherent impl のメソッドは**どのモジュールで定義しても** `EngineWrap` が見える場所から同じ名前で呼べる。`session.rs` の 1 Hz ticker も `tests/protocol.rs` も無変更
3. **500 の制約に一発で収まる**: 579 行のうちコード行は **403**（doc コメントが多い）。`use super::*;` / `impl EngineWrap {` / `}` を足して **408**。§13.9 制約 1 のために割る必要が無い

### 3.1 🔴 範囲は 8972〜9550（8976〜9552 ではない）

オリエンテーションの「85〜124 番目」はメソッドの `fn` 行（8976〜9548）を指すが、**動かす単位は「属性 + doc コメント + 本体」**でなければならない:

- `clap_post_peak` の直前 8972〜8975 は `///` 2 行 + `#[cfg(feature = "clap-host")]` + `#[doc(hidden)]`。これを置き去りにすると **`#[cfg(feature = "clap-host")]` が次に残る `load_sample` に付き替わり**、`outproc-effect` ビルドで `load_sample` が消えて `session.rs:1765` が `E0599` になる。同時に `stats.rs` 側の `clap_post_peak` は cfg を失って `self.clap` が `E0609`（複製ツリーで**実際に両方出た**）
- 9552 は `load_sample` の doc コメント。持っていくと `stats.rs` の `impl` 末尾で `E0584`（何も document しない doc コメント）

**境界の機械的な定義**: 開始 = 直前のメソッドの `}`（8970）の**次の空行の次**、終了 = `output_channels` の `}`（9550）。削除する側は空行 9551 も一緒に消す（`}` と次の `///` の間の空行を 1 つに保つため）。

### 3.2 別のグループを推さない理由

| 候補 | 退けた理由 |
|---|---|
| 1〜24 `start*` / `build`（feature ごとの変種） | `build` / `finish_start` を全変種が共有し、`cfg` の組み合わせが最も複雑。**最初の 1 束で residual を測る**目的（設計 §13.5）には、cfg の面倒が無いグループの方が測定値が素直 |
| 125〜141 サンプル再生・render・transport | `lock_samples`（141 番目・private）を共有し、`LoadedSample` / `PlayHandle` / `short_uuid` が impl の**後ろ**（10425〜10869）にあるので、型も一緒に動かすか可視性を触るかの判断が要る。2 束目以降の題材 |
| 型・自由関数の塊（例: main が §13.7 で試した 2081〜2442 のバス型） | residual 2 行で成立することは既に main が実証済み。**未実証なのは「`impl` の一部を別ファイルへ出す」形**で、それを最初に測るべき |

---

## 4. Q2 — 移動する単位と行き先（E2 / E4 / E5）

### 4.1 行き先: `src/engine_wrap/stats.rs`（子モジュール）

```
rust/crates/orbit-audio-daemon/src/
  engine_wrap.rs            ← 残る（末尾近くに `mod stats;` を 1 行）
  engine_wrap/
    stats.rs                ← 新規（579 行の塊 + 8 行の枠）
```

`stats.rs` の枠（この 9 行が residual の大半で、**これ以外の `+` が residual に出たら異常**）:

```rust
//! `EngineWrap` の統計・ヘルス・メトリクスのアクセサ（#888 子 1・`engine_wrap.rs` から移動、振る舞い不変）。
//!
//! `engine_wrap` の**子モジュール**なので、親の private フィールド・private `use` に `use super::*` で到達する
//! （可視性の変更なし）。

use super::*;

impl EngineWrap {
    …（元の 8972〜9550 をそのまま・インデントも変えない）…
}
```

`engine_wrap.rs` 側（元の 9813 `}` の直後）:

```rust
}

/// 統計・ヘルス・メトリクスのアクセサ（`impl EngineWrap` の続き・#888 子 1）。
mod stats;

#[cfg(feature = "outproc-instrument")]
pub(crate) fn record_latest_state_after_save(
```

- `mod stats;` は **private でよい**。inherent impl のメソッドの可視性はメソッド自身の `pub` で決まり、定義されたモジュールの可視性に依存しない（実証: `session.rs` と `tests/protocol.rs` が無変更で通った）
- `mod stats;` に `#[cfg]` は付けない。feature ごとの出し入れは元どおり**各メソッドの属性**が担う（全 feature 組でコンパイル済み）
- ファイル名は `stats.rs`。`health.rs` / `observability.rs` でもよいが、メソッド名の語彙（`*_stats` / `stream_stats_arc`）に揃えた。**名前は抽象ではない**ので裁定 3 に抵触しない。ここは確信度が低い決定ではなく、単に軽い決定
- rustfmt は通る（`cargo fmt --all --check` が複製ツリーで無出力）。インデント 4 のまま動かすので `--color-moved-ws` の助けも要らない

### 4.2 インラインテスト mod は動かさない（E4）

`outproc_health_tests`（580 行）と `outproc_instrument_health_tests`（410 行）は accessor の対応テストだが、この束では**触らない**:

| 観点 | 事実 |
|---|---|
| ラチェットへの寄与 | **0**。インライン test mod はコード行に数えられない（子 0 の D2）。`engine_wrap.rs` の 500 行到達に無関係 |
| 素の変更行 | 動かすと 990 行 × 2（`-` と `+`）で合計 **約 3,150** になり、裁定 6「どちらの裁定でも 1,500 以下」を破る |
| 移設した時の residual | 2 つの mod は `use super::{ChildLaunch, ChildSlot, EffectRole, OutProcControl, …}` と `wrap.outproc` の**直接代入**で親の private 項目に触る。孫モジュール（`engine_wrap/stats/tests.rs`）なら見えるが `use super::super::…` の書き換えが要り、それは residual に出る |
| 置き場所の規約 | 設計 §13.9 制約 2（`tests.rs` / `tests/` 下）と制約 3（`tests/**` へ動かすと pathspec 限定の residual が膨れる。**「テストの移設は別 PR」か「全体 diff で moved を取る」かは子 0b で決める**）が未決 |
| 何を検証しているか | health accessor の**合算・try_lock・poison** の経路を `OutProcControl` を手組みして駆動する。accessor だけの単体ではなく `EngineWrap` の内部状態への注入テストなので、親に残るのが自然 |

したがって**テスト側の差分は 0 行**。これ自体が裁定 1「既存テストの期待値を 1 つも変えていない」の最も強い形になる（§6.3 で機械的に確かめる）。

**テストの移設は、子 0b で §13.9 の 3 が決まった後の別束**に送る（`engine_wrap.rs` の残り 7,730 行の test をどう置くかは、コード行 500 の目標とは独立の問題）。

### 4.3 `mod stats;` の位置（E5）

Rust の慣習ではファイル先頭の `use` の近くに置くが、ここでは **`impl EngineWrap` の閉じ括弧の直後**に置く。

- 先頭に置くと、それ以降の**全行が +2 ずれる**。dev サイトのフェンス引用（`// rust/…/engine_wrap.rs:start-end`）は `engine_wrap.rs` に **約 20 箇所**あり（`catalog.md` / `insert-bus.md` / `mixer-audio-line.md` / `signal-chain/index.md` …・各 2 言語）、`npm run docs:check` が全部 red になる。`--fix` は**別の関数へ着地しうる**（memory `citation-fix-can-land-on-the-wrong-function`・#853 で bot が 3 箇所の誤着地を発見）ので、動く引用は少ないほどよい
- 閉じ括弧の直後（元の 9813 の後）なら、ずれるのは元々ずれる 2 箇所だけ: 8972 以降を指す引用は削除で **−580**、9813 以降はさらに `mod` ブロック 3 行で **+3**（合計 −577）。**期待値**（複製ツリーで内容一致を確認済み）:

| 引用 | 変更前 | 変更後 |
|---|---|---|
| `sites/dev/{,en/}rust-engine/index.md`（`render_offline`） | `9765-9774` | **`9185-9194`** |
| `sites/dev/{,en/}plugin-hosting/plugin-ui.md`（`PluginUiTarget`） | `10474-10487` | **`9897-9910`** |

- 後続の束も同じ場所に `mod xxx;` を積む（「`impl EngineWrap` の続きはここ以下の子モジュール」と読める位置）。1 束ごとに先頭の行番号が動かないので、引用の再アンカーは**その束が動かした範囲の後ろ**だけで済む

---

## 5. Q3 — 可視性の変更を最小化する（E3）

**この束では 0 件。** 見積もりではなく、複製ツリーで次を通した結果:

| 検証 | 結果 |
|---|---|
| `cargo check -p orbit-audio-daemon --all-targets --features outproc-effect,outproc-instrument` | 緑 |
| 同 `--features clap-host` / default / `--features link-audio`（`ORBIT_LINK_DIR` 指定） | 緑（4 組すべて） |
| `cargo clippy -p orbit-audio-daemon --all-targets -- -D warnings`（outproc 両方 / clap-host / default） | 緑（unused import も無し） |
| `cargo fmt --all --check` | 緑 |

理由は Rust の privacy 規則そのもので、発明ではない: **private な item は「定義されたモジュールとその子孫」から見える。** `engine_wrap::stats` は `engine_wrap` の子なので、`EngineWrap` の private フィールドも、親の private な `use std::sync::Arc;` 等も、`use super::*;` の glob で見える（インラインの `mod tests { use super::*; }` が動くのと同じ仕組み）。

### 5.1 兄弟モジュール案（`src/engine_stats.rs`）を採らない理由

`lib.rs` に `mod engine_stats;` を足す形だと、`EngineWrap` の**フィールド 15 個に `pub(crate)`** が要る（親の private フィールドは兄弟から見えない）。これは「移動」ではなく「変更」で、residual に 15 行 + 構造体定義の diff が出る。子モジュールなら 0 行。**この差だけで子モジュール案に決まる。**

### 5.2 後続の束への含意（本束の決定ではないが、ここで測った事実）

- `impl` の private ヘルパー（約 30 本）は、**親に残す限り全子モジュールから見える**。だから「ヘルパーを呼ぶグループを子へ出す」だけなら `pub(crate)` は要らない
- 🔴 逆に**ヘルパーを子 A に動かし、子 B や親がそれを呼ぶ**場合は `pub(super)` が要る（兄弟の private は見えない）。後続の束で residual を押し上げるのは**この形だけ**なので、「ヘルパーは呼び手と同じ子に置く」か「親に残す」かを束ごとに決めればよい。オリエンテーション §4 の「約 30 本の `pub(crate)` 化」は**起きない**見込み

---

## 6. Q4 — 検算の手順（E6）

「既存テストの期待値を 1 つも変えていない」を、自己申告ではなく**出力で**示す。すべて main が sandbox 外で回す（委譲先の緑は根拠にしない）。

### 6.1 素の変更行（§5.1 の数え方・どちらの裁定でも要る）

```bash
git diff --stat <base>...HEAD -- rust/ | tail -1
```

**期待値: `591 insertions(+), 580 deletions(-)` = 1,171 行**（dev サイトの引用修正 4 箇所 × 2 行と baseline 1 行を足しても 1,200 弱）。1,500 以下。

### 6.2 `--color-moved` の residual（設計 §13.3 のコマンド。`move-residual.sh` は子 0b 待ちなので生で叩く）

```bash
git -c color.diff.new=green -c color.diff.old=red \
    -c color.diff.newMoved=magenta -c color.diff.oldMoved=cyan \
    -c color.diff.newMovedAlternative=magenta -c color.diff.oldMovedAlternative=cyan \
    diff --color=always --color-moved=zebra --color-moved-ws=allow-indentation-change \
    <base>...HEAD -- rust/crates/orbit-audio-daemon/src > /tmp/cm.txt
printf 'moved-=%s moved+=%s residual-=%s residual+=%s\n' \
  "$(grep -cE $'^\e\\[36m-' /tmp/cm.txt)" "$(grep -cE $'^\e\\[35m\\+' /tmp/cm.txt)" \
  "$(grep -cE $'^\e\\[31m-' /tmp/cm.txt)" "$(grep -cE $'^\e\\[32m\\+' /tmp/cm.txt)"
grep -E $'^\e\\[3[12]m[-+]' /tmp/cm.txt | sed -E $'s/\e\\[[0-9;]*m//g'   # residual の中身
```

**期待値（複製ツリーで実測）: `moved-=579 moved+=579 residual-=1 residual+=12`。** residual の中身は §4.1 の枠そのもの:

```
+//! `EngineWrap` の統計・ヘルス・メトリクスのアクセサ（…）      ← stats.rs の doc 4 行
+//!
+//! `engine_wrap` の**子モジュール**なので、…
+//! （可視性の変更なし）。
+                                                              ← 空行
+use super::*;
+                                                              ← 空行
+impl EngineWrap {
+}
-                                                              ← 消した空行 9551
+/// 統計・ヘルス・メトリクスのアクセサ（`impl EngineWrap` の続き・#888 子 1）。
+mod stats;
+                                                              ← 空行
```

- `moved+ ≠ moved−` なら §13.8 のケース F（複製）か D（消滅）
- **この 13 行以外の residual が 1 行でもあれば、移動に紛れた変更**（§13.6 のケース A/B/C）。レビュアーはその行だけ読めばよい
- 🔴 設計 §13.4 の 4(ii)「短い moved ブロックを residual 扱いにする K」について、この束は**1 ブロック 579 行**なので K の材料にならない。K は複数の小さな塊を動かす束で決める（本束では決めない）

### 6.3 「テストを 1 つも変えていない」の機械化

| 検査 | コマンド | 期待値 |
|---|---|---|
| test mod に触っていない | 子 0 のカウンタで `engine_wrap.rs` の `excluded` を前後比較（`countCodeLines(src,'rust').excluded`） | **7,730 → 7,730** |
| テスト件数が同じ | `cargo test -p orbit-audio-daemon --features outproc-effect,outproc-instrument -- --list \| grep -c ': test$'` を base と HEAD で | **365 → 365**（名前の一覧も `diff` で一致・複製ツリーで確認済み） |
| テストファイルの diff が空 | `git diff --stat <base>...HEAD -- 'rust/crates/orbit-audio-daemon/tests' 'tests/'` | **空** |
| `#[test]` の増減が無い | `git diff <base>...HEAD -- rust/ \| grep -cE '^[+-]\s*#\[test\]'` | **0** |

### 6.4 cargo（CI と同じ 5 組 + ローカルの macOS 分）

```bash
cd rust
cargo fmt --all --check
bash ../scripts/check-cfg-matrix.sh --clippy          # 4 象限の clippy -D warnings（ループを手書きしない）
cargo clippy -p orbit-audio-daemon --features clap-host --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo test -p orbit-audio-daemon --features clap-host --locked
cargo test -p orbit-audio-daemon --features outproc-effect --locked
cargo test -p orbit-audio-daemon --features outproc-instrument --locked
cargo test -p orbit-audio-daemon --features outproc-effect,outproc-instrument --locked
```

複製ツリーの実測（参考・本番は main が回し直す）: lib テスト **303 / 58 / 79**（outproc 両方 / default / clap-host）すべて緑、`--test protocol` **32 / 29** 緑、`outproc-effect` 単独・`outproc-instrument` 単独も緑。

🔴 `--test protocol` は `test-assets/audio/kick.wav` を**リポジトリ root 相対**で読む。複製ツリーで最初 7 件落ちたのは `test-assets/` を写し忘れた環境要因で、写したら全緑（memory `implementation-right-oracle-wrong` の型。赤を実装のせいにする前に環境を疑う）。

### 6.5 `npm test` と `docs:check`

- **baseline**: `tests/repo/file-size-baseline.json` の `engine_wrap.rs` を **6,418 → 6,014** に下げる（honesty 検査 (e) が**厳密一致**を要求するので、カウンタの実測値を写す。実装後に `npm test` の失敗メッセージが正しい値を印字する）。`engine_wrap/stats.rs` は 408 行なので baseline に**足さない**（500 以下の値は (f) で red）。baseline の diff は `-` 1 行 `+` 1 行だけ・**`+` 行の値が `-` 行より小さい**ことをレビュアーが見る
- **引用**: `npm run docs:check` が 2 箇所 × 2 言語で red になる。§4.3 の期待値（`9185-9194` / `9897-9910`）に**手で**書き換え、`--fix` を使うなら着地先の関数名を目視で照合する

### 6.6 実機（この束では回さない・束の締めで回す）

この束は DSL 表面も MCP 表面も足さない。`BUNDLE_BRANCH_WORKFLOW.md` §5.1 の小 PR のゲートは「CI + その PR が足した E2E + main が差分を読む」で、足した E2E は無い。実機 gated 全件と `.vsix` cold install は**子 1 の束 PR（統合ブランチ → main）の締め**で回す（#888 コメント 1「各リリースのゲート」）。

---

## 7. Q5 — この束でやらないこと

| やらない | 理由 |
|---|---|
| テスト mod の移設（`outproc_health_tests` 等） | §4.2。裁定 6 と §13.9 の 3 の未決 |
| 40 メソッドの並べ替え・doc コメントの手直し・`#[doc(hidden)]` の整理 | 1 行でも触ると residual に出て「純粋な移動」でなくなる。`[`Self::outproc_effect_stats`]` 等の doc リンクは同じ `Self` なのでそのまま解決する |
| 可視性の変更（`pub(crate)` / `pub(super)`） | §5。要らない |
| `session.rs` / `server.rs` / `tests/protocol.rs` の変更 | 呼び出し側は無変更で通る（実証済み） |
| 他のグループ（`start*` / バス / ノート / transport）の抽出 | 次の束。**2 つ目の子モジュールを同じ PR に入れない** — 最初の 1 束の意味は residual を「1 モジュール分」として測ること（設計 §13.5） |
| `mod.rs` の導入・`engine_wrap.rs` の改名 | edition 2021 では `engine_wrap.rs` + `engine_wrap/` で足りる。改名は全引用と全 `use` を動かす |
| `tests/repo/file-size-targets.ts` の pathspec / 除外の変更 | `engine_wrap/stats.rs` は既定の `:(glob)rust/crates/**/*.rs` に載る。子 0 の仕組みに手を入れない |
| `move-residual.sh` の作成 | 子 0b の仕事。本束は §6.2 の生コマンドで測る |
| K（短い moved ブロックの閾値）の決定 | §6.2。この束には材料が無い |
| 版の更新（4.0.1） | 子 1〜3 が揃ってから |

---

## 8. 実装指示（Codex 向け・受け取れる粒度）

**目的と成功条件**: `engine_wrap.rs` の行 8972〜9550 を `engine_wrap/stats.rs` へ移し、§6.1〜6.5 の期待値をすべて満たす。**振る舞い・テスト・可視性は変えない。**

**手順**（行番号はすべて**変更前**の `engine_wrap.rs`・`ab09244f` 以降の main + 子 0 で 15,678 行）:

1. `rust/crates/orbit-audio-daemon/src/engine_wrap/stats.rs` を新規作成。中身は §4.1 の枠 8 行 + **元の 8972〜9550 を 1 文字も変えずに**貼る + `}`。**インデントはそのまま（4 スペース）**
2. `engine_wrap.rs` から **8972〜9551**（末尾の空行込み）を削除
3. 削除後の `impl EngineWrap` の閉じ括弧（元の 9813・削除後は **9233**）の直後に、空行 + `/// 統計・ヘルス・メトリクスのアクセサ（`impl EngineWrap` の続き・#888 子 1）。` + `mod stats;` を挿入（§4.1 の形）
4. `tests/repo/file-size-baseline.json` の `engine_wrap.rs` を `6014` に（`npm test` が印字する実測値に合わせる）
5. `sites/dev/{,en/}rust-engine/index.md` の `// rust/crates/orbit-audio-daemon/src/engine_wrap.rs:9765-9774` を `9185-9194` に、`sites/dev/{,en/}plugin-hosting/plugin-ui.md` の `:10474-10487` を `9897-9910` に。フェンス内の引用本文は変えない
6. `docs/development/WORK_LOG.md` に 1 エントリ（束の 1 本目・residual の実測値を貼る）

**検証コマンド**: §6.1〜6.5 の全部。**報告には各コマンドの出力（residual の 13 行・テスト件数・baseline の diff）を貼る。** 「緑でした」だけの報告は受け取らない。

**やってはいけないこと**:
- 移動する 579 行の中を 1 文字も変えない（typo 修正・doc の追記・`use` の整理を含む）
- `use super::*;` 以外の `use` を `stats.rs` に足さない（足したくなったら親の `use` が足りない証拠で、それは本束の範囲外）
- `pub(crate)` / `pub(super)` を 1 つも足さない
- test mod を動かさない・`#[test]` を足さない
- `mod stats;` をファイル先頭に置かない（§4.3）
- 2 つ目の子モジュールを同じ PR に入れない
- 複製ツリーの `cargo test` が落ちたら、まず `test-assets/` の有無を疑う（§6.4）

**参照物**（scratchpad・main が読める）: `x1/after/engine_wrap.rs` と `x1/after/engine_wrap/stats.rs`（期待される結果そのもの）、`x1/residual-color-moved.txt`（期待される residual の生出力）、`x1/list-{before,after}.txt`（テスト一覧 365 件）。

---

## 9. 確信度と反証可能性

| 判断 | 確信度 | これを見れば誤りと分かる |
|---|---|---|
| E1 範囲 8972〜9550 で全 feature 組がコンパイル・テスト緑 | **高**（複製ツリーで実走） | 実 PR で `cargo test` の 5 組のどれかが赤。または `-- --list` の件数が 365 から動く |
| E3 可視性変更 0 | **高**（4 feature 組 + clippy で実証） | `E0616`（private field）/ `E0603` が出る。出るとしたら **`link-audio` 以外の未検証 feature**（`link-audio-verification`）だが、`link` フィールドは `link-audio` で検証済み |
| E2 residual = 13 行 | **中〜高** | 実 PR の `git diff <base>...HEAD` は `--no-index` と rename 検出が違うので、`mod stats;` 周りの数行が前後する可能性はある。**13 を大きく超える、または枠以外の行が出たら**その行が変更 |
| E4 テストを動かさない | **高**（判断の根拠は行数と裁定 6） | owner が「テストも同じ束で」と裁定すれば覆る。その場合は素の変更行 3,150 で residual 方式の裁定が前提になる |
| E5 `mod` の位置で引用の再アンカーが 2 箇所 × 2 言語 | **高**（内容一致を確認） | `npm run docs:check` が 4 件以外を red にする |
| §3.2 他グループを後回し | **中** | 2 束目で `pub(super)` が大量に要る、または `cfg` の変種で `mod` 側にも cfg が要ると分かれば、順序（何を先に出すか）を見直す。ただし本束の正しさには影響しない |
| 設計 §13.5 の反証条件（residual が素の変更行の 2 割以上なら再考） | — | 本束: 13 / 1,171 = **1.1%**。発火しない |

---

## 10. 採らなかった案

| 案 | 退けた理由 |
|---|---|
| 兄弟モジュール `src/engine_stats.rs` | フィールド 15 個の `pub(crate)` 化 = residual +15 と構造体の diff（§5.1） |
| `mod stats;` をファイル先頭へ | 引用 20 箇所が動く（§4.3） |
| accessor を `EngineWrap` から独立した `EngineStats` 型へ切り出す | **新しい抽象の発明**（裁定 3）。呼び出し側（`session.rs` の ticker）も変わり振る舞い不変の検算が弱くなる |
| 40 メソッドを 2 ファイル（`clap` 系 / `outproc` 系）に分ける | 408 行で 500 に収まるので割る理由が無い。割ると `mod` が 2 つ = residual と cfg の判断が増える |
| test mod を `engine_wrap/stats/tests.rs` へ同時に移す | §4.2 |
| 最初の 1 束で 2〜3 グループを同時に出す | 設計 §13.5「子 1 の最初の抽出で測る」— 1 モジュール分の residual を素直に測る方が、後続の束の算術（`residual ≈ 束の数 × 13`）の根拠になる |

---

## 11. 後続の束への申し送り（本束の決定ではない）

- **子モジュール方式は一般解**: 親に残る private ヘルパーは全子から見える。residual を押し上げるのは「子 A のヘルパーを子 B が呼ぶ」形だけ（§5.2）
- **`mod xxx;` は `impl` の閉じ括弧の直後に積む**（§4.3）。引用の再アンカーは動かした範囲の後ろだけ
- **境界は「属性 + doc + 本体」**（§3.1）。`fn` 行で切ると cfg が隣に付き替わる。実装者への行番号指定は必ず doc コメントの先頭行から
- **1 束 = 1 子モジュール**を保つと、residual の期待値を「枠 + `mod` 行」で**事前に書ける**（§6.2 の表）。事前に書けない residual が出る束は、何かを変えている
- 本束の後の `engine_wrap.rs` は **6,014 コード行**。内訳（子 0 のカウンタで本日実測）: `impl EngineWrap` **4,014 → 3,611**、`impl` より前の型・定数・自由関数 **1,756**、`impl` より後の自由関数・公開型 **648**。🔴 **`impl` を全部出しても 2,404 行残る**ので、500 に届くには `impl` の残り 6 グループ（`start*` 24 / デバイス 15 / バス 15 / instrument+UI 12 / ノート 18 / transport 17）だけでなく、`impl` 外の型・自由関数（バス型 / OutProc の role・slot 型 / plugin UI 型 / mailbox エラー変換）も兄弟または子へ出す必要がある。順序は 2 束目の設計で決める（`start*` 群の cfg 変種と `build` の共有をどう扱うかが最初の難所）
