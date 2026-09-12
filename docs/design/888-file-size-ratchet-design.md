# 設計: ファイルサイズのラチェット — #888 子 0「仕組みだけ入れる（振る舞い不変）」

**対象 issue**: #888（Epic・ファイルサイズの規律とネイティブ前の分割）子タスク 0
**関連**: `docs/planning/NATIVE_MIGRATION_2026-09.md` §2.4（Rust 資産はそのままネイティブ線へ渡る）/ `docs/development/BUNDLE_BRANCH_WORKFLOW.md` §5.1 / 既存ラチェット 3 本（`tests/docs/worklog-size.spec.ts` / `tests/e2e/dsl-e2e-coverage.spec.ts` / `tests/docs/planning-issue-state.spec.ts`）
**正本**: 本書は spec ではない。規律の正本は CLAUDE.md「テストの積み上げ規律」と issue #888 本文。本書は**子 0 の実装設計**であり、実装後は spec ファイルの冒頭コメントが一次情報になる
**状態**: 設計（実装しない）・2026-09-12・main `ab09244f`（4.0.0 出荷後・#884 / #885 マージ済み）で実測
**起案**: Fable（effort: high）。数値は本書のために書いた試作カウンタ（scratchpad・実装ではない）で本日測り直した。main の実測（ブリーフ §2・§3）と食い違う箇所は §2 に明記する

---

## 0. 裁定・確定事項と、本設計が決めたこと

### 0.1 owner 確定事項（再議論しない）

| # | 裁定 | 出どころ |
|---|---|---|
| 1 | **閾値 = コード行 500**。空行・コメント専用行・Rust のインライン `#[cfg(test)] mod` を数えない | #888 本文「ルール」 |
| 2 | コメントを除く理由: 日本語の長い根拠コメントを**意図的に**積んでいる。素の行数は「残したいもの」を罰する | 同上 |
| 3 | **ファイル単位は両言語で 1 つのラチェット**（`tests/repo/file-size-ratchet.spec.ts` + baseline）。関数単位は各言語の純正 linter（ESLint `max-lines-per-function` / clippy `too_many_lines`） | 同上「仕組み（2 軸）」 |
| 4 | ラチェットの規律は既存 3 本と同じ: **baseline は現寸で登録・増やす編集は red・減らす編集は緑** | 同上 |
| 5 | **Rust が先**（子 1〜3）・TS は後（子 4〜5） | 同上「なぜネイティブの前なのか」 |
| 6 | **4.0.1 は Rust 分割のみ・振る舞い不変**。検算は「既存テストの期待値を 1 つも変えていない」 | #888 コメント 1（版の切り方） |
| 7 | 新しい抽象を発明しない。既にある兄弟モジュールへ戻す | #888 本文「受け入れ条件」 |
| 8 | **子 0 に関数単位 linter を入れない**（CI が `-D warnings` なので即 red） | #888 コメント 2 / ブリーフ §5 Q4 |
| 9 | baseline は #884 / #885 のマージ後（= 4.0.0）に取る | #888 本文 |

### 0.2 本設計が決めたこと（§3〜§7 で根拠を示す）

| # | 決定 | 節 |
|---|---|---|
| D1 | コード行の判定は**行単位の状態機械**（普通 / 文字列 / raw 文字列 / テンプレート / ブロックコメント）で行う。正規表現の 1 行判定では足りない（複数行の raw 文字列が実在する） | §3.1 |
| D2 | Rust の除外は「**test 限定の `cfg` 属性が直前に付いた `mod name {`** から対応する `}` まで」。`#[cfg(test)]` と **`#[cfg(all(test, …))]` の両方**を test 限定と見なす。`#[cfg(any(test, …))]` は prod でもコンパイルされるので**数える**。`mod` 以外の item に付いた `#[cfg(test)]` は**数える** | §3.2 |
| D3 | 走査が終端で異常状態なら**例外で red**にする（黙って誤カウントしない）。誤りは常に「多く数える」側へ倒す | §3.3 |
| D4 | 測定対象は **`git ls-files` で列挙**し、Rust は `rust/crates/**/*.rs` から test 専用パス（`tests/` `examples/` `benches/` `build.rs` `src/**/tests.rs`）を除いたもの、TS は `packages/*/src/**/*.ts`。**`tests/**` は対象外**（子 0 では） | §4 |
| D5 | baseline は `tests/repo/file-size-baseline.json`。**閾値超過ファイルだけ**をパス→コード行数で持つ。ラチェット検査と honesty 検査の 2 本立て（既存 3 本と同型） | §5 |
| D6 | 関数単位 linter は子 0 の**直後・子 1 の前**に別 PR（子 0b）で入れる。閾値は**実測から 200**（残る違反 6 件を明示的に抑止し、抑止件数もラチェットにする）。100 への降下は子 5 の後に再計測して決める | §6 |
| D7 | 子 0 は**ソースを 1 行も動かさない**。`docs:check` は不要だが確認は走らせる | §7 |
| D8 | （Q6・main 提起）分割の束は **§5.1 の 1,500 行を「移動を除いた residual」で数える**ことを owner に提案する。判定器は自作せず **git 標準の `--color-moved`** を使う。スクリプトは子 0 ではなく**子 0b** に入れる | §13 |
| **D9** | 🔴 （2026-09-12 追加・レビューの結果）**TS の数え方は TypeScript のパーサで全件検算する**（`tests/repo/code-lines-oracle.spec.ts`）。D1 の状態機械は heuristic を含み、**入れ子テンプレートリテラルで黙って少なく数える**経路が実在した（D3 の契約違反）。heuristic を改良し続けるのではなく、**基準を言語の正規の実装に置く**。既知の差は shebang 行 1 件のみで、許容リストに明示する | §3.4 |
| **D10** | 🔴 （2026-09-12 追加・設計監査）D8 の residual 判定には**抜け道が 2 つある**（1 文の関数間移動 / 移動 + 複製）。ゲートに **`moved+ == moved−`** と**短い moved ブロックの residual 扱い**を足す。最終防波堤は裁定 6「既存テストの期待値を 1 つも変えていない」 | §13.8 |

---

## 1. 到達点（1 文）

**`npm test` が「500 コード行を超えるファイルが増えた / 超過ファイルが太った」を red にし、baseline を減らす方向にしか編集できず、Rust と TS が同じ数え方で 1 つの JSON に載っている**。子 0 の PR はこの仕組みと現寸の baseline だけを足し、ソースは動かさない。

---

## 2. 現在地（一次情報・本書が前提にするもの）

| 事実 | 根拠 | 本書 |
|---|---|---|
| Rust 149 ファイル・TS `packages/*/src` 132 ファイル（tracked） | `git ls-files`（2026-09-12） | §4 |
| Rust の `#[cfg(test)]` は 108 箇所。**同じ行に `mod` が続く形は 0 件**、属性行の次の行が `mod` なのが 64 件、残りは fn / trait メソッド / フィールド / 文に付いている | `grep -rn --include='*.rs' -E '#\[cfg\(test\)\]' rust/crates` と `-A1` の突合 | §3.2 |
| 🔴 **`#[cfg(all(test, feature = "…"))] mod …` が `engine_wrap.rs` に 20 箇所以上**ある（`effect_rack_tests` `:219` / `set_bus_line_tests` `:3088` / `outproc_health_tests` `:12569` …）。`#[cfg(all(test, target_os = "macos"))] mod tests` も child 3 本にある | 同 grep `-E '#\[cfg\((all\|any\|not)\(.*test'` | §3.2 の D2 の根拠 |
| `#[cfg(any(test, all(feature = …)))]` は `session.rs:24,496` / `engine_wrap.rs:2113` にあり、**prod でもコンパイルされる** | 同上 | D2（数える） |
| `#[cfg(test)]` と `mod` の間に別属性が挟まる例: `orbit-clap-host/src/discovery.rs:146`（`#[cfg(target_os = "macos")]`） | 同 grep `-A1` | §3.2（介在属性を許す） |
| **複数行にまたがる raw 文字列が 14 箇所**あり、中身は `{` で始まる JSON / XML（`outproc_effect.rs:1201` / `orbit-plugin-scan/src/lib.rs:2259` …）。**いずれも test mod の中** | `grep -E 'r#+"' \| grep -vE '"#+'` | D1（brace 追跡は文字列を飛ばす必要がある） |
| Rust のブロックコメント `/* */` は **2 箇所のみ**・どちらも 1 行内 | `grep -F '/*'` | §3.1（対応は要るが稀） |
| 行末 `\` で継続する通常文字列が 132 行 | `grep -E '"[^"]*\\$'` | D1 |
| TS: JSDoc `/**` 1,330 箇所・非 JSDoc `/*` 4 箇所・複数行テンプレートリテラルの開始 66 行・**正規表現リテラルにクォートを含む例が測定対象の中にある**（`packages/vscode-extension/src/dsl-completion-context.ts:73,118,203` — `= /…"…/` / 行頭 `/…"…/.exec(` / `aux: /…"…/g`。`tests/e2e/gated-sources.ts:135` にも） | grep と試作カウンタの例外（正規表現非対応の版はこの src ファイルで throw した） | §3.1（正規表現リテラルの扱い・直前トークン `=` / 行頭 / `:` の 3 形が実在） |
| `.eslintrc.cjs` は eslintrc 形式・`ignorePatterns` に `scripts/**` `vitest.config.ts`。`npm run lint` は `eslint . --ext .ts,.tsx` で **`tests/**` も対象** | `.eslintrc.cjs` / `package.json` | §6.3 |
| `clippy.toml` 無し・`[lints]` を持つ `Cargo.toml` 無し・CI は `cargo clippy --workspace --all-targets --locked -- -D warnings` | `grep -rn '^\[.*lints' rust` / `.github/workflows/rust-ci.yml:64` | §6.2 |
| 🔴 **`rust/clippy.toml` に `too-many-lines-threshold = 150` を置くと閾値が効く**（`orbit-audio-sandbox` で 4 件 → 2 件・メッセージが `192/150`） | 本日実測（別 `CARGO_TARGET_DIR`・実験後に削除） | §6.2 |
| 🔴 **clippy.toml を変えただけでは診断がキャッシュから再生される**（1 回目の実験は同じ 4 件が `…/100` のまま出た。`cargo clean -p` 後に再実行して初めて変わった） | 同上 | §8.4 の検証手順 |
| clippy の `too_many_lines` は**空行とコメント専用行を除いて数え、文字列の中身は数える**。判定は `line_count > threshold`。既定 100・`too-many-lines-threshold` | `clippy_lints/src/functions/too_many_lines.rs` / `clippy_config/src/conf.rs`（master） | §3.1（数え方を揃える）/ §6 |
| clippy の設定ファイルは `CLIPPY_CONF_DIR` → `CARGO_MANIFEST_DIR` → `.` の順に起点を取り、**親ディレクトリへ遡って** `.clippy.toml` / `clippy.toml` を探す | `clippy_config/src/conf.rs`（master） | §6.2（workspace root に置いてよい） |
| `docs:check` の `--fix` は「行がずれただけ」の引用を**内容一致で再アンカー**する | `sites/dev/scripts/check-citations.mjs:184-241` | §6.4（子 0b でソースを動かす時） |
| `npm test` は `packages/engine` の `vitest run --dir ../../tests` なので **`tests/repo/` は新設するだけで発見される** | `packages/engine/package.json` `test` | §8.1 |
| pre-commit は `lint-staged`（eslint --fix / prettier）→ `npm test` → `npm run build` | `.husky/pre-commit` | §8.4 |

### 2.1 ブリーフの数値との突合（試作カウンタ・2026-09-12）

ブリーフ §2 の clippy 25 件、§3 の素の行数（Rust 34 / TS 13）は**そのまま前提にした**（測り直していない）。
一方、#888 本文の「prod 行」の表は**本書の数え方と一致しない**ので、ここで訂正しておく:

| ファイル | issue 本文「prod」 | 素の行数 − `#[cfg(test)]` mod のみ | **本書の数え方**（空行・コメント・`cfg(test)`/`all(test,…)` mod 除外） |
|---|---|---|---|
| `orbit-audio-daemon/src/engine_wrap.rs` | 14,828 | 14,820（除外 859 行） | **6,418**（除外 7,730 行・**実装の確定値**。起案時の試作は 6,407） |
| `orbit-audio-daemon/src/session.rs` | 3,028 | — | **2,605** |
| `orbit-audio-native/src/output.rs` | 3,399 | — | **2,573** |
| `orbit-vst3-host/src/lib.rs` | 2,960 | — | **2,388** |
| `orbit-plugin-scan/src/lib.rs` | 1,901 | — | **1,652** |
| `orbit-audio-sandbox/src/transport.rs` | 2,167 | — | **1,413** |
| `packages/vscode-extension/src/extension.ts` | 3,875 | — | **2,779**（**実装の確定値**。起案時の試作 3,004 は正規表現リテラル未対応による過大・§5.1 の裁定） |
| `packages/vscode-extension/src/mcp-server.ts` | 1,403 | — | **1,161** |

main も独立に概算カウンタで同じ結論に達している（2026-09-12・6 ファイル中 5 ファイルで `total − prod` がインラインテスト行数と完全一致）。**main の値（`engine_wrap.rs` 12,638）と本書の 6,407 の差は `all(test, …)` mod の扱い**（main は `#[cfg(test)]` 直書きのみ除外 = 本書の試作の `plain` 方針で 12,630・8 行差は境界行の扱い）。どちらを採るかは §3.2 の D2 で決めている。

読み取れること: issue 本文の prod 値は「素の行数から `#[cfg(test)]` 直書きの mod を引いた値」で、**空行・コメントは引いておらず、`all(test, …)` の mod も引いていない**。`engine_wrap.rs` の差 8,400 行のうち約 6,900 行が `all(test, feature = …)` の test mod である。**ルール（裁定 1）は変えていない。数値だけが変わる。** 子 1 の目標値を issue から引く時はこの表を使うこと。

🔴 **本書の起案中に踏んだ落とし穴（§4.1 の根拠）**: 試作の一括実行では `extension.ts` と `mcp-server.ts` が**列挙から落ちて**baseline に現れなかった。原因は `git ls-files 'packages/*/src/**/*.ts'` が **109 件**しか返さないこと（実数 132）。git の既定 pathspec は `*` が `/` をまたぐ一方、`src/**/*.ts` は `**/` の後に区切りを要求するので **`src/` 直下のファイル 23 件が落ちる**（`extension.ts` / `mcp-server.ts` / `version.ts` …）。`:(glob)` magic を付けると 132 件になる（本日実測）。**列挙の穴はカウンタの穴より見つけにくい**（落ちたファイルは赤にならない）ので、§9.2 L-1 で件数と特定ファイルの存在を検査する。

---

## 3. Q1 — コード行の定義と実装

### 3.1 定義（両言語共通・D1）

**コード行** = 空白・コメント以外の文字を 1 文字でも含む行。ただし:

| 事象 | 扱い | 根拠 |
|---|---|---|
| 空行・空白のみ | 数えない | 裁定 1 |
| `//` `///` `//!` で始まる行（先頭空白は無視） | 数えない | 裁定 1。`///` `//!` は `//` の接頭辞なので特別扱い不要 |
| `/* … */` が行内で閉じ、他にコードが無い行 | 数えない | 同上 |
| 複数行ブロックコメントの**内側の行**・`*/` だけの行 | 数えない | 同上 |
| **コードの後ろに行末コメント**がある行 | **数える** | コードがある |
| 複数行の文字列 / raw 文字列 / テンプレートリテラルの**内側の行** | **数える**（中身が `//` や `*` で始まっていても） | 文字列はコード。clippy の `too_many_lines` も文字列を数える（§2） |
| 文字列の中の `//` `/*` `{` `}` | コメント・brace と見なさない | 誤認すると (a) コメント扱いで数え漏れ (b) brace 追跡が壊れて除外範囲が崩れる |
| TS の正規表現リテラルの中の `'` `"` `` ` `` `//` `/*` | 文字列・コメントと見なさない | **測定対象の `dsl-completion-context.ts:73,118,203` で実在**（正規表現非対応の試作はこのファイルで throw した）。`tests/e2e/gated-sources.ts:135` にも |

**実装は行単位の状態機械**（`tests/repo/code-lines.ts`・純関数 `countCodeLines(source, lang): { code, excluded }`）:

- 状態: `normal` / `string(quote)` / `raw(hashes)`（Rust `r"…"` `r#"…"#` `br#"…"#`）/ `template`（TS `` ` ``）/ `block`（`/* … */`）
- `normal` で `//` に当たったら**その行の残りを捨てる**（行コメント）。`/*` で `block` へ
- `string` はエスケープ `\x` を 2 文字で飛ばし、対応する引用符で閉じる。**行をまたいでよい**
- `raw` は `"` の直後に `#` が `hashes` 個続いた時だけ閉じる
- Rust の `'`: 文字リテラル `'x'` / `'\n'` / `'"'` / `'{'` を 1 トークンとして飛ばす。マッチしなければライフタイム（`'a`）として 1 文字進める
- TS の正規表現リテラル: `normal` で `/` に当たり、直前の非空白文字が `( , = : [ ! & | ? { } ; +` または行頭、または直前の語が `return` / `typeof` なら**正規表現**として扱い、`[…]` クラス内を除いて次の未エスケープ `/` まで飛ばす。それ以外の `/` は除算
- **行の判定**: その行で `normal` 状態のまま非空白文字を 1 つでも消費したら code。行の途中で `string` / `template` / `raw` に入った行、または前の行から文字列状態で入った行も code

正規表現 1 本で足りない理由は §2 の一次情報にある: (1) 複数行 raw 文字列が 14 箇所・その中身が `{` で始まる、(2) 行末 `\` の継続文字列 132 行、(3) 正規表現リテラルの中のクォート。**ただし完全なトークナイザも要らない** — 型・構文・式の理解は一切不要で、必要なのは「文字列とコメントの境界」だけ。上の状態機械は試作で 100 行弱、Rust 149 + TS 323 ファイルを例外 1 件（正規表現リテラル・上表で対応済み）で通した。

**既知の弱点（正直に）**: TS の正規表現判定は発見的（heuristic）である。ECMAScript では `/` が正規表現リテラルか除算かは**構文文脈**（goal symbol）で決まり、直前トークンだけでは決まらない。破れる箇所（2026-09-12 の設計監査が列挙・repo の src には実例 0 件）: (a) `)` の後（`if (x) /re/` は仕様上 regex・実装は除算） (b) `=>` の後（`>` が文脈集合に無い） (c) `return` / `typeof` 以外のキーワード（`case` `in` `of` `instanceof` `yield` `await` `void` `delete` `throw` `else` `do`） (d) 行頭の `/`（除算の継続行なら誤り） (e) テンプレートの `${…}` 内の入れ子バッククォート。

🔴 **起案時に書いていた「誤判定の帰結は §3.3 の例外で red になる（黙って通らない）」は誤りだった**（2026-09-12 の設計監査 I-2・main が再現）。誤判定で文字列状態に入っても、**以降の同種クォートが偶数個なら状態は normal に戻り、throw せずに黙って通る**。同様に**入れ子テンプレートリテラル**は backtick が偶数なら throw せず、**文字列の中身の行を行コメントと誤認して少なく数える**（実測: 期待 5 行 → 4 行）。§3.3 が禁じている「少なく数える誤り」に到達する経路が実在した。

**したがって heuristic の改良では足りない。** 対策は §3.4。

### 3.4 🔴 TS は言語の正規の実装で全件検算する（D9・2026-09-12 追加）

§3.1 の弱点は、字句解析の heuristic を改良し続けても**構成的には消せない**。
個々の弱点を追いかける代わりに、**基準を外に置く**:

**`tests/repo/code-lines-oracle.spec.ts`**: `typescript`（既に devDependency）の**パーサ**に解析させ、
葉トークンが占める文字を持つ行を「コード行」とするオラクルを作り、
**測定対象の TS 全件**について `countCodeLines(src, 'ts').code` と突き合わせる。ずれたら red。

```ts
const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
// 🔴 JSDoc ノードを除外しないと JSDoc コメントがコード行として数えられる
//    （kind が FirstJSDocNode..LastJSDocNode の範囲）
// 葉ノード（getChildCount === 0）の [getStart, getEnd) が実トークンの占有範囲。
// トークン外 = trivia（空白・コメント）なので、「実トークンの文字を含む行」= コード行。
```

**既知の差は 1 件だけ**（2026-09-12 の設計監査が 132 件全件で実測）:
`packages/engine/src/cli-audio.ts` = 実装 17 / オラクル 16。差は **shebang 行 `#!/usr/bin/env node`**
（TS パーサは trivia 扱い・実装はコード扱い）。**多く数える側なので安全**。
これは**明示的な許容リスト**として spec に置き、**それ以外のずれは 1 件でも red** にする。
🔴 **許容リストを増やす編集はレビューで止める**（他のラチェットの baseline と同じ規律）。

**Rust には同等のオラクルが無い**（`syn` 等を持ち込むのは子 0 の範囲を超える）ので、
状態機械の既知の弱点を文書化し、**安全側（多く数える / throw）に倒れること**を確認するに留める。
裏取りとして、設計監査が awk で「test 限定 cfg mod を持つファイル数」を独立列挙し **59 = 59** で一致を確認している。

---

### 3.2 Rust の `#[cfg(test)] mod` の除外（D2）

**除外する範囲** = 次の 3 つが連続した所から、対応する `}` まで:

1. **test 限定の `cfg` 属性行**: `#[cfg(test)]` または `#[cfg(all(test, …))]`（`all(` の**先頭要素**が `test`）。行はこの属性だけ（先頭空白と行末空白を除く）
2. 0 行以上の**別の属性行**（`#[…]` で始まる行。`discovery.rs:146` の `#[cfg(target_os = "macos")]` や `#[allow(…)]`）
3. `mod name {`（`pub` / `pub(crate)` 付きを含む。**同じ行に `{`**。§2 のとおり repo 内の `mod … {` 88 件はすべてこの形）

3 が `mod name;`（ファイル外出し）や `fn` / `impl` / フィールドなら**除外しない**（属性行も含めて普通に数える）。

`{` `}` の追跡は §3.1 の状態機械の `normal` 状態でだけ行う（文字列・コメント・文字リテラル `'{'` の中の brace は見ない）。depth が 0 に戻った行までを除外行とする。

**なぜ `all(test, …)` も除外するか**（owner の文言は「インライン `#[cfg(test)] mod`」）:
`#[cfg(all(test, feature = "outproc-effect"))]` は「`cargo test` かつ feature 有効」でしか展開されず、**prod バイナリに 1 行も入らない**。裁定 1 の趣旨（テスト行は分割の対象ではない・ネイティブ線へ渡る資産の大きさを測る）に照らして `#[cfg(test)]` と区別する理由が無い。`engine_wrap.rs` では 20 箇所以上がこの形で、除外しないと **6,200 行の test コードが prod として計上される**（§2.1）。逆に `any(test, …)` は prod でも展開されうるので数える。

**なぜ item 単位の `#[cfg(test)]` は数えるか**: owner の裁定は「mod」であり、item 単位は 40 行程度（`engine_wrap.rs` の trait メソッド宣言・`new_stats()` 等）で結果に効かない。brace 追跡を item にまで広げると `impl` ブロックの途中や式の中（`engine_wrap.rs:5745` の `#[cfg(test)] crate::test_tracing::install_interest_anchor();` は**文**）を扱うことになり、単純さを失う割に利得が無い。**数える側に倒す**（D3 の原則）。

**`#[cfg(all(feature = "x", test))]`（`test` が先頭でない）は数える**。repo に実例は無く、来たら「多く数える」側なので害は無い。実例が出たら §3.2 の 1 を「`all(…)` の要素のどれかが `test`」に広げる（1 行の変更）。

### 3.3 終端不変条件（D3）

ファイル末尾で状態が `normal` でない、または除外 mod の depth が 0 に戻っていないなら、`countCodeLines` は **throw** し、spec はそのファイル名と行番号を出して red になる。理由:

- 黙って数えると「文字列状態のまま最後まで」= 以降の行が全部 code 扱い（多く数える）か、逆にブロックコメント状態のまま = 全部数えない（**少なく数える = ラチェットの穴**）。後者を許さない
- `dsl-e2e-coverage.spec.ts` の A-3 が `KEYWORDS.size > 0` で真空緑を防いでいるのと同じ思想

誤りの向きの原則: **迷ったら数える**。多く数える誤りは baseline に載って可視化される。少なく数える誤りは見えない。

---

## 4. Q2 — 測定対象の範囲（D4）

### 4.1 列挙は `git ls-files`

`child_process.execFileSync('git', ['ls-files', '-z', '--', <pathspecs>], { cwd: repoRoot })` で列挙する。fs の glob + 除外リストは採らない。

根拠: `vitest.config.ts` のコメントが示すとおり、除外リストは「既定を手で再現したら黙って穴が開く」型の事故を起こす。`git ls-files` なら `node_modules` / `dist` / `rust/target` / `.claude/worktrees` / 未追跡の `packages/sc-link-audio/`（本日 untracked で存在）を**列挙の定義として**除外できる。CI は git checkout の上で走る。

🔴 **pathspec は必ず `:(glob)` magic 付き**で書く（`':(glob)packages/*/src/**/*.ts'`）。既定の pathspec は `**` を正しく扱わず、`src/` 直下の 23 ファイルを落とす（§2.1・本日実測。`rust/crates/**/*.rs` は偶然 149 件で一致したが、それは全 `.rs` が `crates/<name>/` の下にあるからで、同じ穴がある）。
真空防止: 列挙結果が Rust 100 件未満または TS 100 件未満なら throw（現状 149 / 132）。加えて L-1 で `packages/vscode-extension/src/extension.ts` と `rust/crates/orbit-audio-daemon/src/engine_wrap.rs` が列挙に**含まれる**ことを名指しで検査する（落ちても赤にならない穴を、既知の代表で塞ぐ）。

### 4.2 対象

| 言語 | pathspec（`git ls-files`） | さらに除外するパス | 現状の件数 |
|---|---|---|---|
| Rust | `:(glob)rust/crates/**/*.rs` | `**/tests/**` `**/examples/**` `**/benches/**` `**/build.rs` `**/src/**/tests.rs` | **95**（= 149 − tests 50 − examples 2 − build.rs 1 − `src/tests.rs` 1。🔴 起案時は 96 と書いていたが**算術の誤り**で、実測も 95・spec のコメントも 95。2026-09-12 に main が訂正。`src/bin/` 6 件と workspace 外の `orbit-link-audio` 3 件を**含む**） |
| TS | `:(glob)packages/*/src/**/*.ts` | （無し。`.d.ts` は現在 0 件・来たら対象） | 132 |

**含めるもの**の根拠:
- `src/bin/`（`sandbox-host.rs` 629 コード行）: 出荷物ではないが**ソース**である。除外する積極的理由が無い
- `orbit-link-audio`（workspace 外・GPL 隔離）: 我々が保守する Rust ソース。3 ファイルとも 500 未満で baseline に入らない
- `orbit-vst3-*-oracle`（test 用プラグイン・693 / 685 行）: test **用**だが prod として build されるクレート。数える側に倒す

**除外するもの**の根拠:
- `src/**/tests.rs`（`orbit-effect-rack-child/src/tests.rs`・755 行）: `#[cfg(test)] mod tests;` でファイルに出したインライン test mod そのもの。インライン mod を数えないのにファイルへ出した途端に数えるのは**逆のインセンティブ**（外出しは望ましい方向）。`test_tracing.rs`（133 行）は test 支援コードだが名前規則に合わないので数える（小さく無害）
- Rust `tests/` `examples/` `benches/` と TS `tests/**`: **子 0 では対象外**。理由は 4.3

### 4.3 🔴 `tests/**` を子 0 で対象外にする理由（この決定は確信度が中）

試作カウンタの実測: TS `tests/` は 15 ファイルが 500 超で、最大は `tests/e2e/orbitstudio-mcp-gated.spec.ts` の **5,522 コード行**。Rust `tests/` は `protocol.rs` 1,266 / `instrument_host_integration.rs` 737。

これらを baseline に載せると、ラチェットの契約（§5: 超過ファイルは baseline 値を 1 行も超えられない）により **gated spec に E2E を 1 本足しただけで red** になる。CLAUDE.md「DSL を足したら E2E も足す」と真正面から衝突し、しかも**今この瞬間に別エージェントが gated E2E を積んでいる**（bundle-a-tests / b2-missing-e2e）。gated spec の分割は #668 PR-E1（`gated-sources.ts`）で受け皿が用意済みだが、それは別の作業である。

「狭すぎると穴が開く」に対する答え: 穴は**テストファイルの肥大**であり、それは (a) 分割の受け皿が既にある、(b) 振る舞いに影響しない、(c) 子 0 の「即日緑・振る舞い不変」を守る方が優先、の 3 点で子 0 では受け入れる。**子 5 の後に `tests/**` を第二の対象として同じ仕組みに足す**かどうかを owner に問う（§12）。仕組み側は pathspec を 1 行足すだけで対応できるように書く（§8.1）。

**反証可能性**: owner が「テストも今から数える」と言えば、この節は覆る。その場合 baseline は +17 件になり、gated spec への E2E 追加は分割とセットになる。

---

## 5. Q3 — baseline の形式とラチェットの契約（D5）

### 5.1 形式: `tests/repo/file-size-baseline.json`

```json
{
  "threshold": 500,
  "files": {
    "packages/engine/src/audio/rust-engine/daemon-client.ts": 804,
    "rust/crates/orbit-audio-daemon/src/engine_wrap.rs": 6418
  }
}
```

- **閾値超過ファイルだけ**を載せる（`KNOWN_STALE_BASELINE` / `SEQUENCE_UNCOVERED_BASELINE` と同じ「違反の一覧」）。全ファイルを載せる案は採らない（§10）
- キーは repo root からの相対パス・**辞書順**・1 行 1 エントリ（diff が 1 ファイル 1 行になる）
- 値はそのファイルの**現在のコード行数**（§3 の数え方）
- `threshold` を JSON に持つのは spec 側の定数と二重化しないため。spec は JSON の値を読む（500 以外なら red・§5.2 の (f)）

現寸（**実装のカウンタが出した確定値**・2026-09-12・main が検証済み）: **25 件**（Rust 15 / TS 10）

> 🔴 **この表は 2026-09-12 に main が裁定して差し替えた。** 起案時の試作カウンタの値とは 25 件中 8 件で食い違い、
> **すべて実装側が正しい**と判定した（§11「§5.1 の 25 件の数値」の反証条件がそのまま発火したケース）。裁定の根拠:
>
> - **TS 10 件**: TypeScript 自身の**パーサ**を独立オラクルにして測り（`ts.createSourceFile` の葉トークンが占める文字を印し、JSDoc ノードは除外）、**実装の値と 10/10 完全一致**。試作の `extension.ts` 3,004 は **2,779** が正しい（試作は正規表現リテラルを扱えず状態が壊れていた）
> - **Rust**: main が独立に `#[cfg(test)] mod` の除外レンジを列挙し、4 ファイル中 3 件で実装と完全一致。唯一ずれた `engine_wrap.rs` は **main の列挙の側のバグ**だった（`"…{scanned}… {EXPECTED_SCANNED}…"` という Rust のフォーマット文字列の `{` `}` を brace として数え、`mod outproc_load_error_test_support`（11792 行〜）を **12279 行で早期終了**していた。実際の終端は **12557 行**で、差の 278 行が実装との差と正確に一致した）
>
> **正本は `tests/repo/file-size-baseline.json`。** 以下はその写しである（乖離したら JSON が正しい）。

```
rust/crates/orbit-audio-daemon/src/engine_wrap.rs            6418
rust/crates/orbit-audio-daemon/src/session.rs                2605
rust/crates/orbit-audio-native/src/output.rs                 2587
rust/crates/orbit-vst3-host/src/lib.rs                       2388
rust/crates/orbit-plugin-scan/src/lib.rs                     1652
rust/crates/orbit-audio-sandbox/src/transport.rs             1416
rust/crates/orbit-audio-daemon/src/outproc_effect.rs          812
rust/crates/orbit-effect-rack-child/src/lib.rs                714
rust/crates/orbit-audio-daemon/src/outproc_instrument.rs      705
rust/crates/orbit-vst3-synth-oracle/src/lib.rs                693
rust/crates/orbit-vst3-gain-oracle/src/lib.rs                 685
rust/crates/orbit-sandbox-spike/src/bin/sandbox-host.rs       629
rust/crates/orbit-child-runtime/src/ui_service.rs             571
rust/crates/orbit-effect-rack-child/src/macos.rs              531
rust/crates/orbit-audio-sandbox/src/events.rs                 520
packages/vscode-extension/src/extension.ts                   2779
packages/engine/src/core/sequence.ts                         1369
packages/engine/src/audio/rust-engine/rust-engine-player.ts  1224
packages/vscode-extension/src/mcp-server.ts                  1161
packages/engine/src/core/global.ts                           1103
packages/engine/src/parser/parse-expression.ts               1000
packages/engine/src/audio/rust-engine/daemon-client.ts        804
packages/engine/src/core/global/effect-slot.ts                783
packages/engine/src/parser/parse-statement.ts                 648
packages/engine/src/interpreter/process-statement.ts          554
```

（起案時の試作では一括実行で 23 件しか出ず、列挙漏れで `extension.ts` / `mcp-server.ts` が落ちていた — それが §4.1 の `:(glob)` 要求の出どころである。実装のカウンタで **25 件**が出ることが §8.4 検証 5 の合格条件で、2026-09-12 に達成を確認した。）

### 5.2 契約 — 何が red になるか

`tests/repo/file-size-ratchet.spec.ts` は 2 つの `it` を持つ（既存 3 本と同型: ラチェット + honesty）。

**(A) ラチェット** `it('does not let a file grow past the threshold or past its baseline (ratchet)')`
対象ファイルごとに `allowed = baseline.files[path] ?? threshold` とし、`code > allowed` のファイル一覧が `[]` であることを期待する。red になる事象:

| 事象 | 判定 | メッセージが指示すること |
|---|---|---|
| (a) baseline に無いファイルが 500 を超えた（新規ファイル・既存の成長どちらも） | red | 分割する。**baseline に足して通してはいけない** |
| (b) baseline にあるファイルが baseline 値を超えた | red | 分割する（または増分をよそへ）。**値を上げて通してはいけない** |
| (c) baseline にあるファイルが baseline 値以下（減った・同じ） | 緑（A では） | — |

**(B) honesty** `it('keeps the baseline honest (every entry is real, current, and above the threshold)')`
以下のどれかで red:

| 事象 | 判定 | メッセージが指示すること |
|---|---|---|
| (d) baseline のファイルが存在しない（消えた・改名した） | red | エントリを消す（残骸を残さない） |
| (e) baseline 値 > 実際のコード行数（減ったのに baseline が古い） | red | **値を実際の数に下げる**（緩みを残すと次の成長がそこまで黙って通る） |
| (f) baseline 値 ≤ threshold、または `threshold !== 500` | red | 500 以下の値は意味を持たない（その行は消す）。閾値は裁定 1 |
| (g) baseline のファイルが §4 の対象外パスにある | red | エントリを消す |

(e) は「減らす編集は緑」に一見反するが、既存 3 本も **stale なエントリは red** にしている（`dsl-e2e-coverage` の "keeps the baseline honest"・`planning-issue-state` の "every baseline entry still exists"）。緩みを許すと (b) の「値を超えた」判定が骨抜きになる。減らした PR は baseline の数字も下げる（1 行の編集・失敗メッセージに**正しい値を印字**する）。

**(A) と (B) を合わせると baseline 値 == 実際の値**が緑の唯一の状態になる。それでも 2 本に分けるのは、失敗メッセージが「太った」と「古い」で指示が逆だから。

### 5.3 「増やして通す」ができない、とは

仕組みで止まるのは (a)(b)(e)(f)。**baseline の数字を実際の値と一緒に上げる編集**（ファイルを 10 行太らせて JSON も +10）は仕組みでは止まらない — 既存 3 本も同じ（`SEQUENCE_UNCOVERED_BASELINE` に語を足せば通る）。止めるのはレビューで、**baseline の diff に `+` が付いた行は「値が増えた」か「エントリが増えた」のどちらかしかない**ので、レビュアーは JSON の diff を見るだけでよい。この 1 行を spec の冒頭コメントと `BUNDLE_BRANCH_WORKFLOW.md`（§8.3）に書く。

git の base ブランチと突き合わせる案（CI で `git show origin/main:tests/repo/file-size-baseline.json` と比較）は採らない: テストがネットワークと shallow clone に依存する（`planning-issue-state.spec.ts` が GitHub API を叩かないのと同じ理由）。

---

## 6. Q4 — 関数単位 linter をいつ・どの形で入れるか（D6）

### 6.1 実測（前提の更新）

ブリーフ §2 の clippy 25 件に加えて ESLint 側を本日測った（main の実測と同じ invocation・`packages/*/src`・閾値 100・`skipBlankLines` / `skipComments`）: **15 件 / 10 ファイル**。

| ファイル | 件数 | 関数の長さ | 分割対象（子 4〜5）か |
|---|---|---|---|
| `vscode-extension/src/mcp-server.ts` | 3 | 594, 167, 105 | ★ |
| `vscode-extension/src/extension.ts` | 4 | 167, 150, 125, 117 | ★（#887） |
| `engine/src/interpreter/process-statement.ts` | 2 | 138, 112 | ★（「ほか」・554 行で baseline 入り） |
| `engine/src/core/global/effect-slot.ts` | 1 | 211 | ★ |
| `engine/src/timing/calculation/calculate-event-timing.ts` | 1 | 187 | |
| `engine/src/cli/repl-mode.ts` | 1 | 175 | |
| `engine/src/parser/tokenizer.ts` | 1 | 124 | |
| `engine/src/audio/rust-engine/daemon-client.ts` | 1 | 118 | ★ |
| `vscode-extension/src/completion-context.ts` | 1 | 118 | |
| `engine/src/core/global/sequence-registry.ts` の `NaN` 表示 | — | （ルール未定義の警告・違反ではない） | |

**Rust と同じ結論**: 15 件中 11 件は分割対象にあるが、4 件は分割と無関係なファイルにある。clippy 側は 25 件中 15 件が分割対象外（ブリーフ §2）。

さらに、閾値別の残存件数（`> N`）:

| 閾値 | clippy（Rust） | ESLint（TS `src`） | ESLint（TS `tests/`） |
|---|---|---|---|
| 100 | 25 | 15 | （未計測・洪水は確実） |
| 150 | 12 | 6 | — |
| **200** | **4**（`session.rs` 1022・471 / `output.rs` 222 / `sandbox-host.rs` 367） | **2**（`mcp-server.ts` 594 / `effect-slot.ts` 211） | **30 / 22 ファイル** |

### 6.2 決定: 子 0b（子 0 の直後・子 1 の前）で閾値 200 で有効化し、残り 6 件を明示抑止する

**なぜ子 0 に入れないか**: 裁定 8。加えて、有効化には**ソースの編集**（抑止コメント）が要り、子 0 の「ソースを動かさない」を破る。

**なぜ「子 1〜3 の後」ではなく「子 1 の前」か**: 分割 PR が関数 lint の**下で**書かれるべきだから。lint が無いまま `engine_wrap.rs` を割ると、割った先に 100 行超の関数がそのまま運ばれ、後から lint を入れる時に**分割 PR で触ったばかりの場所へ抑止を撒く**ことになる。「大物に集中している」という見込みは否定された（ブリーフ §2）ので、分割の副産物を待つ理由も消えた。

**なぜ閾値 200 か**: 実測から決めた（owner が挙げた選択肢「閾値を実測から決める」）。200 で残る 6 件のうち **5 件は分割対象**（子 2 / 子 5）、分割と無関係なのは spike クレートの `sandbox-host.rs` 1 件だけ。つまり 200 は「**明示抑止が分割の進捗で自然に減っていく**最大の閾値」である。150 だと残り 18 件・うち分割対象外が 10 件で、抑止コメントの撒き先が広がる。100 は owner の最終目標として残す（§6.5）。

**閾値を現寸の最大値（Rust 1,022 / TS 594）にして「即日緑」にする案は採らない**: ファイルが 500 コード行で止まる以上、594 行や 1,022 行の関数は**新規には物理的に書けない**。閾値がファイル上限より大きい関数 lint は何も止めない（§10）。

**有効化の形**:

| 言語 | 設定 | 場所 | ソース編集 |
|---|---|---|---|
| Rust | `[workspace.lints.clippy] too_many_lines = "warn"` + 各 member の `[lints] workspace = true`（22 crate・`orbit-link-audio` は workspace 外なので対象外） | `rust/Cargo.toml` + 各 `Cargo.toml` | 無し（manifest のみ） |
| Rust | `too-many-lines-threshold = 200` | **`rust/clippy.toml`**（新規。親ディレクトリ遡りで全 crate に効く・§2 で実測） | 無し |
| Rust | 残る 4 関数に `#[allow(clippy::too_many_lines)] // #888-fn: <分割予定の子番号 or 理由>` | `session.rs` ×2 / `output.rs` / `sandbox-host.rs` | **4 行** |
| TS | `'max-lines-per-function': ['error', { max: 200, skipBlankLines: true, skipComments: true, IIFEs: true }]` | `.eslintrc.cjs` `rules` | 無し |
| TS | `overrides: [{ files: ['tests/**/*.ts'], rules: { 'max-lines-per-function': 'off' } }]` | 同 | 無し |
| TS | 残る 2 関数に `// eslint-disable-next-line max-lines-per-function -- #888-fn: <理由>` | `mcp-server.ts` / `effect-slot.ts` | **2 行** |

CI は `-D warnings` なので `warn` で十分（ローカルは warn・CI は error・エディタの rust-analyzer にも出る）。`-W` を CI の引数に足す案は採らない（ローカルと CI と rust-analyzer で見えるものが違う）。

🔴 **`tests/**` を ESLint の対象から外す理由**: `npm run lint` は `eslint .` で `tests/**` も見る。`max-lines-per-function` は `describe(() => {…})` のコールバックも関数として数えるので、閾値 200 でも **30 件**出る（§6.1）。テストの `describe` の長さは関数の長さの問題ではない。`overrides` で切る（`ignorePatterns` に足すと他のルールまで消えるので使わない）。

### 6.3 抑止件数のラチェット（「忘れない仕組み」）

子 0b で `tests/repo/function-size-suppressions.spec.ts` を足す:

- `git ls-files` で §4.2 の対象ファイルを列挙し、`allow(clippy::too_many_lines)` と `eslint-disable-next-line max-lines-per-function`（`eslint-disable`（ファイル全体）も含む）の出現行を集める
- **件数が baseline（6）を超えたら red**・各行に `#888-fn:` マーカーが無ければ red（理由の無い抑止を許さない）
- `rust/clippy.toml` の `too-many-lines-threshold` と `.eslintrc.cjs` の `max` を読み、**200 を超えたら red**・キーが無ければ red（ルールを外すと red）
- honesty: baseline（6）> 実際の件数なら red（減ったら baseline も下げる）

これで「抑止を足して通す」「閾値を上げて通す」「ルールを外して通す」の 3 経路が全部 red になり、**忘れる形が存在しなくなる**。閾値の**降下**（200 → 100）は、この spec の定数を下げる編集として PR に現れる。

### 6.4 子 0b の `docs:check`

抑止コメント 6 行はソースを動かすので `npm run docs:check` が要る。1 行の挿入は「行がずれただけ」なので `--fix` が内容一致で再アンカーする（§2）。**`--fix` の後に diff を読む**（memory: `--fix` は別の関数へ着地しうる — 内容が変わった時の話だが、確認は省かない）。

### 6.5 100 への降下（owner 裁定待ち・§12）

子 5 の後に再計測し、(a) 200 のまま置く / (b) 150 / (c) 100 + 抑止、を owner が選ぶ。100 にすると Rust 21 件・TS 13 件の抑止が要り、その多くは分割対象外のファイル（`events.rs` / `discovery.rs` / `calculate-event-timing.ts` …）に散る。**降下の判断は分割の進捗と独立**（ブリーフ §2 の結論）。

---

## 7. Q5 — 子 0 でやらないこと（D7）

| やらない | 理由 / 行き先 |
|---|---|
| ソースコードの分割・移動・改名 | 子 1〜5 |
| `#[allow]` / `eslint-disable` の追加 | 子 0b（§6.2） |
| `clippy.toml` / `[lints]` / `.eslintrc.cjs` の変更 | 子 0b |
| `tests/**` を測定対象に入れる | §4.3・owner 裁定待ち（§12） |
| baseline を「減らす」 | 子 0 は現寸登録のみ。1 件でも減らすとソースを動かすことになる |
| 関数単位の閾値降下 | §6.5 |
| CI ワークフローの変更 | 不要。`npm test` に spec が乗る（`rust-ci.yml` は触らない） |
| baseline の自動書き換えモード（`--update` / env） | 採らない（§10）。失敗メッセージが正しい値を印字する |
| 「純粋な移動」の residual を出すスクリプト | 子 0b（§13.4）。子 0 は測るだけで、分割の道具を含めない |
| `docs/core/PROJECT_RULES.md` の改訂 | 規律の正本は issue #888 と CLAUDE.md。運用の 1 行は `BUNDLE_BRANCH_WORKFLOW.md` §5.1 に足す（§8.3）だけ |

子 0 はソースを 1 行も動かさないので `docs:check` は理論上不要だが、**PR のチェックリストとして走らせる**（緑であることを確かめて報告する）。

---

## 8. 実装指示（Codex 向け・子 0）

### 8.1 新規ファイル

| パス | 責務 |
|---|---|
| `tests/repo/code-lines.ts` | **純関数** `countCodeLines(source: string, lang: 'rust' \| 'ts'): { code: number; excluded: number }`。§3.1〜3.3 の状態機械。副作用なし・fs を触らない。終端不変条件違反は `Error` を throw（メッセージにファイル内の行番号と状態） |
| `tests/repo/code-lines.spec.ts` | `countCodeLines` の機能テスト（§9 の表 F-1〜F-14 を**文字列フィクスチャ**で。実ファイルは読まない） |
| `tests/repo/file-size-targets.ts` | `listMeasuredFiles(repoRoot): Array<{ path: string; lang }>`。`git ls-files -z` を `execFileSync` で呼び、§4.2 の pathspec（**`:(glob)` 付き**）と除外を適用。真空防止（Rust < 100 または TS < 100 で throw）。**pathspec は配列定数 `MEASURED_PATHSPECS` に置き、`tests/**` を後から 1 行で足せる形**にする |
| `tests/repo/file-size-baseline.json` | §5.1 の形式。**実装のカウンタで生成した現寸**（§5.1 の **25 件**と一致するはず） |
| `tests/repo/file-size-ratchet.spec.ts` | §5.2 の (A)(B)。冒頭コメントに「なぜ」（#888 本文の要約・§5.3 のレビュー規則・§4.3 の `tests/**` 除外の理由）を既存 3 本と同じ密度で書く |

### 8.2 spec の要点（読み違えを防ぐ）

- `repoRoot = path.resolve(__dirname, '../..')`（`planning-issue-state.spec.ts` と同じ）
- `git ls-files` の `cwd` は `repoRoot`。出力は `\0` 区切りで、末尾の空要素を捨てる
- (A) の失敗メッセージには **超過ファイルごとに `path: code / allowed`** を並べ、末尾に「baseline に足す・値を上げる編集は禁止。分割する」を書く
- (B) の失敗メッセージには**修正後の JSON 行をそのまま印字**する（例: `"rust/crates/…/session.rs": 2590,`）。値が 500 以下になったエントリは「この行を消す」と書く
- baseline の読み込みは `JSON.parse` し、`threshold === 500` を (B) で検査する
- 1 ファイルでも `countCodeLines` が throw したら、その spec は**そのファイル名を含めて**失敗する（`try/catch` で握らない・§3.3）
- 対象ファイルの読み込みは `fs.readFileSync(path, 'utf8')`。CRLF は `\r` を空白扱い（§3.1）

### 8.3 ドキュメント（子 0 の PR に含める）

- `docs/development/BUNDLE_BRANCH_WORKFLOW.md` §5.1 に 1 段落: 「`tests/repo/file-size-baseline.json` の diff に `+` 行があれば、それは『値が増えた』か『エントリが増えた』のどちらかで、どちらもレビューで止める」
- `docs/development/WORK_LOG.md`（必須）
- CLAUDE.md「これらは仕組みで強制されている」の表に 1 行（`ファイルは 500 コード行を超えない` / `tests/repo/file-size-ratchet.spec.ts` / `超過が増えたら red（ラチェット）`）。**表への 1 行追加のみ**（全面書き換え禁止）

### 8.4 検証（main が sandbox 外で回す・Codex の緑は根拠にしない）

1. `npx vitest run --dir tests --config vitest.config.ts tests/repo` — 新規 spec がすべて緑
2. `npm test` — 全件緑（既存の件数 + 新規分）
3. **変異（手書き・PR あたり数件の枠内）**: (i) baseline の 1 エントリの値を +1 → (B)(e) が red、(ii) 値を −1 → (A)(b) が red、(iii) エントリを 1 つ消す → (A)(a) が red、(iv) 存在しないパスを足す → (B)(d) が red、(v) `threshold` を 600 → (B)(f) が red。**5 つとも実出力を報告に貼る**（restore 後の緑も）
4. `npm run lint` / `npm run docs:check` — 緑（ソースを動かしていないことの確認）
5. 🔴 **baseline が §5.1 の 25 件と一致する**こと（`extension.ts` **2,779** / `mcp-server.ts` 1,161 を含む）。件数が 23 なら列挙が `src/` 直下を落としている（§4.1 の pathspec）。値が違うなら §3 の数え方との差を特定してから進む（試作カウンタは scratchpad にあり、main が突き合わせに使える）
6. 実機 E2E: **不要**（テストとドキュメントのみ・ソース不変）。ただし束の規律により PR の CI 全件緑を確認する
7. `git status` — `rust/clippy.toml` や `Cargo.toml` に変更が**無い**こと（子 0b の先取りを混ぜない）

### 8.5 やってはいけないこと

- ソース（`rust/crates/**` / `packages/*/src/**`）を 1 行も変えない。改行・空白も変えない
- baseline を**手で減らさない**。実装のカウンタが出した値をそのまま載せる
- 対象範囲に `tests/**` を入れない（§4.3）
- `countCodeLines` に「分からない時は数えない」分岐を入れない（§3.3・迷ったら数える）
- fs の glob で列挙しない（§4.1）
- `vitest.config.ts` の `exclude` を触らない
- 既存 3 本のラチェット spec を触らない

### 8.6 差分の見積もり

spec 2 本 + 純関数 1 本 + 列挙 1 本 + JSON 1 本 + docs で **400〜600 行**。上限 1,500 行に対して余裕がある。

---

## 9. 失敗モード = テスト対象の一覧

🔴 検証手段は CLAUDE.md「テストの積み上げ規律」で決め直す。ここは**対象の列挙**であり、「変異」列は候補に過ぎない。

### 9.1 `countCodeLines`（機能テスト・文字列フィクスチャ）

| # | 入力 | 期待 |
|---|---|---|
| F-1 | 空行・空白行のみ | code 0 |
| F-2 | `// …` `/// …` `//! …` だけの行 | code 0 |
| F-3 | `let x = 1; // 注` | code 1 |
| F-4 | 3 行のブロックコメント（`/*` / ` * …` / ` */`） | code 0 |
| F-5 | `let s = "a"; /* 注 */` | code 1 |
| F-6 | Rust: `let s = r#"{` / `"x": 1` / `}"#;` の 3 行 | code 3（文字列内の `{` `}` で除外追跡が動かない・`"x"` を文字列開始と見ない） |
| F-7 | Rust: `"…\` 継続 / `…"` の 2 行 | code 2 |
| F-8 | Rust: `#[cfg(test)]` / `mod tests {` / `fn t() {}` / `}` + 前後に prod 行 | code = prod 行数・excluded 4 |
| F-9 | Rust: `#[cfg(all(test, feature = "x"))]` + mod | 同上（除外される） |
| F-10 | Rust: `#[cfg(any(test, feature = "x"))]` + mod | **除外されない**（全行 code） |
| F-11 | Rust: `#[cfg(test)]` / `#[allow(dead_code)]` / `mod tests {` … | 除外される（介在属性） |
| F-12 | Rust: `#[cfg(test)]` / `fn helper() {}` | 除外されない（2 行とも code） |
| F-13 | Rust: 文字リテラル `'{'` `'"'` とライフタイム `'a` を含む行 | code 1・状態が壊れない |
| F-14 | Rust: test mod の中に `'}'` と `"}"` がある | 除外の depth が正しく 0 に戻る |
| F-15 | TS: 3 行のテンプレートリテラル（内側の行が `// x` で始まる） | code 3 |
| F-16 | TS: `const re = /(['"\`])/g` | code 1・throw しない |
| F-17 | TS: `const y = a / b / c // 注` | code 1 |
| F-18 | 閉じない文字列・閉じないブロックコメント・閉じない test mod | **throw**（メッセージに行番号） |
| F-19 | Windows 改行 `\r\n` | `\n` と同じ結果 |

### 9.2 `listMeasuredFiles`

| # | 事象 | 期待 |
|---|---|---|
| L-1 | 実 repo で呼ぶ | Rust ≥ 100・TS ≥ 100・`tests/` `examples/` `benches/` `build.rs` `src/tests.rs` `tests/**` を含まない・`src/bin/` と `orbit-link-audio` を含む・**`packages/vscode-extension/src/extension.ts`（`src/` 直下）と `rust/crates/orbit-audio-daemon/src/engine_wrap.rs` を含む**（pathspec の `**` 事故を名指しで塞ぐ・§4.1） |
| L-2 | 列挙が閾値未満（`git` が無い等） | throw |

### 9.3 `file-size-ratchet.spec.ts`（§8.4 の変異 5 件がそのまま対応表）

| # | 事象 | 期待 |
|---|---|---|
| R-1 | 現寸 | (A)(B) 緑 |
| R-2 | baseline 値 +1 | (B)(e) red・メッセージに正しい値 |
| R-3 | baseline 値 −1 | (A)(b) red |
| R-4 | エントリ削除 | (A)(a) red |
| R-5 | 架空パスを追加 | (B)(d) red |
| R-6 | `threshold: 600` | (B)(f) red |
| R-7 | 値 400 のエントリを追加 | (B)(f) red |

---

## 10. 採らなかった案

| 案 | 採らない理由 |
|---|---|
| 1 行ごとの正規表現でコメント判定（トークナイザ無し） | 複数行 raw 文字列 14 箇所・継続文字列 132 行・正規表現内クォートが実在（§2）。brace 追跡が文字列の `{` で壊れる |
| 本物のパーサ（`@typescript-eslint/parser` / `syn` 相当）で AST から数える | Rust 側に JS から使えるパーサが無い。両言語で同じ数え方にするには自前の軽い層が要る。必要なのは文字列とコメントの境界だけで、型・構文は要らない |
| `cloc` / `tokei` を呼ぶ | 外部バイナリ依存。`#[cfg(test)] mod` の除外ができない |
| Rust の除外を `#[cfg(test)]` 直書きに限定 | `engine_wrap.rs` の test mod の大半が `all(test, feature = …)`。除外しないと 6,200 行の test を prod として計上（§2.1・§3.2） |
| item 単位の `#[cfg(test)]` も除外 | 40 行程度で結果に効かず、`impl` / 式の中まで brace 追跡が要る（§3.2） |
| fs の glob + 除外リストで列挙 | `vitest.config.ts` が示した「既定を手で再現して穴が開く」型（§4.1） |
| 全ファイルをパス→行数で baseline に載せる | 300 行の JSON になり、500 未満のファイルの増減で diff が汚れる。ラチェットの契約に寄与しない |
| 超過ファイルの**パスだけ**の配列（値なし） | 超過ファイルの**成長**を止められない（`engine_wrap.rs` が 6,418 → 7,000 でも緑）。裁定 4「増やす編集は red」を満たさない |
| baseline 値 ≤ 実際 を許す（緩みを許容） | 次の成長が緩みの分だけ黙って通る。既存 3 本も stale を red にしている（§5.2） |
| `--update` / env で baseline を自動書き換え | テストが作業ツリーへ副作用を持つ。23 件なら失敗メッセージの印字で足りる |
| base ブランチの baseline と CI で突合 | shallow clone / ネットワーク依存（§5.3） |
| `tests/**` を子 0 から対象に入れる | E2E 追加が即 red（§4.3） |
| 関数 lint を閾値 = 現寸最大（1,022 / 594）で子 0 に入れる | ファイル上限 500 の下では何も止めない・見かけだけの有効化（§6.2） |
| 関数 lint を子 3 の後に入れる | 分割 PR が lint の無い所で書かれ、後から分割したての場所へ抑止を撒くことになる（§6.2） |
| 関数 lint を CI の `-W` 引数で有効化 | ローカル・rust-analyzer で見えない。「エディタに出る」（裁定 3 の利点）を失う |
| ESLint の `tests/**` を `ignorePatterns` で外す | 他のルールまで消える。`overrides` で当該ルールだけ切る（§6.2） |
| 閾値を 100 で入れて 40 件を抑止 | 抑止が分割対象外のファイル 20 本に散り、`docs:check` の再アンカー範囲も広がる。owner の最終目標としては残す（§6.5） |

---

## 11. 確信度と反証可能性

| 決定 | 確信度 | 何を確かめれば誤りと分かるか |
|---|---|---|
| D1 状態機械で足りる | 高 | 実装のカウンタが対象 228 ファイルのどれかで throw する（→ §3.1 に足りない状態がある） |
| D2 `all(test, …)` も除外 | 中〜高 | owner が「`#[cfg(test)]` 直書きだけ」と裁定する。または `all(test, …)` の mod が prod でコンパイルされる構成が見つかる（`cargo build` で当該 mod のシンボルが出る） |
| D2 item 単位は数える | 高 | item 単位の `#[cfg(test)]` 行が 1 ファイルで 500 行判定を左右する（現状 `engine_wrap.rs` で 16 行・左右しない） |
| D3 終端で throw | 高 | throw が誤検知で頻発する（正規表現判定の弱点・§3.1）。頻発なら判定を強化する |
| D4 `git ls-files` | 高 | CI / 手元で git が無い環境でテストが走る（現状無い） |
| D4 `tests/**` 除外 | **中** | owner が「テストも数える」と言う。または `tests/` の肥大が実害（レビュー不能・vitest の起動遅延）を出す |
| D5 超過のみ・値付き・equality | 高 | 25 件の baseline 編集が頻繁すぎて摩擦になる（分割 PR ごとに 1〜2 行の編集を想定・許容範囲） |
| D6 閾値 200・子 0b | **中** | 200 の抑止 6 件を撒いた後、子 1〜3 の分割で `session.rs` / `output.rs` の 3 件が消えない（設計が関数分割を伴わない）。または owner が 100 を即時と裁定する |
| §4.1 `:(glob)` で列挙が完全 | 高 | 実装の列挙が 132 / 149 と一致しない、または L-1 の名指しが落ちる |
| §5.1 の 25 件の数値 | ~~中~~ → **決着（2026-09-12）** | 🔴 **反証条件が発火し、main が裁定した。** 25 件中 8 件が試作と食い違い、**すべて実装側が正しい**（TS は TypeScript のパーサを独立オラクルにして 10/10 一致・Rust は main の独立列挙で 4 件中 3 件一致、残り 1 件は main 側のバグと特定）。§5.1 の表を実装値に差し替え済み |
| §6.2 `[workspace.lints]` が rust-analyzer に出る | 中 | rust-analyzer が `[lints]` を読まない版がある（cargo 1.74+ で読む・手元 1.97） |

---

## 12. owner に問うこと（子 0 の着手は待たない）

1. **`tests/**` を測定対象に入れる時期**（§4.3）: 子 5 の後に第二の pathspec として足すか、入れないか
2. **関数閾値の最終値**（§6.5）: 200 のまま / 150 / 100。子 5 の後に再計測して提示する
3. §2.1 の訂正表を issue #888 本文に反映してよいか（prod 値の列を「コード行」に置き換える）
4. 🔴 **分割の束の数え方**（§13）: `BUNDLE_BRANCH_WORKFLOW.md` §5.1 の 1,500 行を、分割 PR では「移動を除いた residual」で数えることを認めるか。**子 1 の着手前に要る**（子 0 / 0b は待たない）

---

## 13. Q6 — 分割の差分量と束の上限 1,500 行の衝突（main 提起・2026-09-12）

### 13.1 問題

分割対象 6 ファイルのコード行は本書の数え方で **17,038**（§5.1 の Rust 上位 6 件の和）。500 行に収めるには約 14,000 コード行を動かし、コメントと付随するインラインテストを含めた素の行では 2〜3 万行。移動は `-` と `+` の両方に出るので **変更行は 5〜6 万**になり、§5.1 の 1,500 行で割ると **40 束前後**。各束にフル編成のレビューが付く現行運用では回らない（main の見積もりと同じ）。

### 13.2 §5.1 の上限が守ろうとしているもの（一次ソース）

`BUNDLE_BRANCH_WORKFLOW.md:62-64`: 「束 PR の差分が大きいほど**レビューの精度が落ちる**」「**レビューが読む量は変更行**なので、上限の判定もそちらに揃える」。

つまり上限の単位は「レビュアーが読む行」である。分割 PR でレビュアーが読むべきものは:

| PR の種類 | レビューが問うこと | 読む行 |
|---|---|---|
| 通常の PR | このロジックは正しいか | 変更行すべて |
| 純粋な移動 | **本当に純粋な移動か**・境界は妥当か | **移動として機械判定できなかった行（residual）**と、ファイル一覧 |

「純粋な移動か」は機械が答えられる。したがって **residual で数えることは §5.1 の趣旨（読む量）に沿う**のであって、上限を緩めるのではない。

### 13.3 判定器は自作しない — git の `--color-moved` で足りる（本日実測）

`git diff --color-moved=zebra --color-moved-ws=allow-indentation-change` は、**同じ diff の中でファイルをまたいで移動したブロック**を（インデント変化を許して）検出し、色で区別する。自前の「削除行の多重集合 == 追加行の多重集合」照合は、`use` 行・`pub(crate)` 化・インデントの正規化を発明することになり、**発明した正規化の誤りが検証できない**。git の実装を使えば発明が要らない。

実測（scratchpad で合成した before / after。`mod effect_slots { … }` 156 行を新ファイルへ外出し + 残った側に `1 → 2` の論理変更を 1 箇所仕込む）:

```
素の変更行（§5.1 の数え方）: added=161 removed=160 total=321
--color-moved 後:            moved-=156 moved+=156 residual-=4 residual+=5
residual の中身: `use super::*;` / `mod effect_slots;` / `mod effect_slots {` /
                 `impl Engine {` … `pub fn tick(&self) -> u32 { 1 }` ⇄ `{ 2 }`  ← 仕込んだ論理変更
```

**321 行の差分が 9 行の residual に落ち、仕込んだ論理変更はその 9 行の中に残った。** 短い行（`}` / `use x;`・20 英数字未満）は git が移動と認めないので residual に出る = **多く数える側に倒れる**（§3.3 と同じ原則）。移動しながら書き換えた行（`pub fn` → `pub(crate) fn` 等）も residual に出る — それはまさにレビューが見るべき行である。

### 13.4 決定（owner 裁定待ち・§12 の 4）

1. **§5.1 に 1 段落足す**: 「分割（純粋な移動）の束は、`scripts/repo/move-residual.sh <base>...<head>` が出す **residual 行数（moved を除いた `+`/`-` の合計）で 1,500 を判定する**。素の変更行は記録するだけ」
2. **束の切り方**は行数ではなく**ソースファイル単位**にする: 1 束 = 1 つの元ファイルからの抽出（`engine_wrap.rs` は 6,418 行なので 2〜3 束に割ってよい。ただし **2 つの元ファイルを 1 束に混ぜない**）。理由は #888 コメント 1 の「退行が出た時に bisect しないと帰属できない」と同じ
3. 分割束の**マージ前ゲート**（既存に加えて）: (a) residual を PR 本文に貼る、(b) **テストパスに限定した residual が `use` / `import` 行だけ**であること（裁定 6「既存テストの期待値を 1 つも変えていない」の機械化: `move-residual.sh <base>...<head> -- 'tests/**' 'rust/crates/*/tests/**'` の residual を `^[+-]\s*(use |import )` で篩って残りが 0）、(c) `cargo test` / `npm test` / 実機 gated 全件
4. 🔴 **residual だけでは足りない。ゲートを 2 つ足す**（§13.8 の実測による・2026-09-12 追加）:
   - **(i) `moved+ == moved−` を要求する。** 不一致は「消して 2 回足した」= 複製（ケース F）か「移動先を作り忘れた」（ケース D）
   - **(ii) 短い moved ブロック（K 行未満）は residual として数える。** git は「20 英数字以上」なら **1 行でも**移動ブロックと認めるので、**1 文を関数 A から B へ移す**（＝振る舞いが変わる）変更が residual 0 で通る（ケース E）。K は子 1 の最初の抽出で決める
5. **スクリプトは子 0b に入れる**（子 0 は測定だけ・分割の道具は持たない。子 1 の前に要る点は関数 lint と同じ）。中身は §13.3 のコマンドを `-c color.diff.*` で色を固定して呼び、ANSI を篩って 4 つの数を出すだけ。
   🔴 **`--color=always` は必須**（無いとパイプ先で色が 0 個になり moved 検出が黙って消える。全行が residual になるので「落ちる側」だが原因が分かりにくい）。zebra は `newMovedAlternative` にも塗るので**両方の色を数える**こと。
   **単体テストは `git diff --no-index` で合成ディレクトリ 2 つを比較**する（repo の状態に依存しない）。
   🔴 **フィクスチャは §13.6 の 5 ケース + §13.8 の 2 ケース = 7 件すべて**を入れること
6. 「上限どおり 40 束」は採らない。**根拠**: §5.1 の趣旨（読む量）に照らして、機械が保証した移動行はレビュアーが読まない行である。読まない行で束を割っても精度は上がらず、束の締めごとに払うレビュー費用（`/simplify` + チーム + Fable 監査）だけが 40 倍になる

### 13.5 反証可能性

- `--color-moved` が実際の分割（`engine_wrap.rs` の 1 モジュール抽出）で residual を**素の変更行の 2 割以上**残すなら、判定器として弱く、切り方を再考する（子 1 の最初の抽出で測る）
- residual に**論理変更が紛れて通る**ケースが見つかったら、この方式は撤回する。**ブロックの途中の 1 行を変える実験も本日実施**: 移動した 156 行の中央の `+ 20` を `+ 21` にしたところ、`moved-=155 moved+=155` になり、変えた行の `-`/`+` の対が residual に出た（ブロックは分断されて前後が別々に moved 扱い）。子 0b のフィクスチャにこの 2 ケース（末尾外の論理変更・移動ブロック内部の 1 行変更）を入れる
- git の要件: `--color-moved-ws=allow-indentation-change` は git 2.19+（手元と CI runner はいずれも新しい）

### 13.8 🔴 residual 方式の 2 つの抜け道（設計監査が発見・main が再現・2026-09-12）

§13.6 の 4 ケースと §13.7 の実素材検証は、**いずれも「ブロックを塊のまま動かす」形**だった。
設計監査が**塊を崩す 2 型**を試したところ、どちらも仕込みが residual に出なかった。main が再現済み。

| ケース | 仕込み | moved+ / moved− | residual | 検出できるか |
|---|---|---|---|---|
| **E: 1 文を関数間で移動** | `engine.set_bus_gain_and_publish(bus, gain);` を `alpha()` から `beta()` へ（**振る舞いが変わる**） | 1 / 1 | **0** | ❌ 件数も一致するので (i) では捕まらない |
| **F: 消して 2 回足す（移動 + 複製）** | 30 行の mod を消し、`keep.rs` と `dup.rs` の**両方**に 30 行ずつ | **60 / 30** | 3（`mod keep {` `}` `mod keep;`） | ✅ (i) `moved+ == moved−` が破れる |

**E が効く理由**: git の `--color-moved=zebra` は「**20 英数字以上**」の行なら **1 行でも**移動ブロックと認める
（git の diff-options ドキュメントの該当項）。したがって「意味のある 1 文」はちょうど
移動として吸われる大きさである。

**対策は §13.4 の 4(i)(ii)**。(i) は F を、(ii)（短い moved ブロックを residual 扱い）は E を捕まえる。
**2 つは相補的で、両方要る。**

🔴 **そして最終防波堤は裁定 6「既存テストの期待値を 1 つも変えていない」である。**
ケース E は振る舞いを変えるので、**既存テストが落ちる**（落ちなければテストが弱いという別の問題）。
機械的な residual 判定は**レビューの入口を絞る道具**であって、意味論の保証ではない。

**反証**: `git diff --no-index --color=always --color-moved=zebra --color-moved-ws=allow-indentation-change`
で上の 2 ケースを再実行し、residual に仕込みが出れば本節は誤り。

### 13.9 子 1〜3 への未明文の制約（設計監査 M-9 / M-10）

1. 🔴 **分割で生まれる新ファイルは、同じ PR 内で 500 コード行以下でなければならない。**
   §5.2 (A)(a)「baseline に足す禁止」の帰結で、**「粗く割ってから細かく」の 2 段階は取れない**
2. **外出しする test mod のファイル名は `tests.rs` か `tests/` ディレクトリ下にすること。**
   §4.2 の除外は名前規約に依存しているので、`bus_tests.rs` のような名前だと**測定対象になり**、
   500 行を超えれば red になる
3. `move-residual.sh … -- 'tests/**'` は **pathspec で絞った diff の中でしか moved を検出しない**。
   src 側の inline test を `tests/**` へ移すと純粋な `+` になり residual が膨れる（落ちる側なので安全）。
   「テストの移設は別 PR」と決めるか、全体 diff で moved を取ってから path で篩うかを**子 0b で決める**

### 13.10 `git ls-files` が index を見ることの帰結（設計監査 M-7）

`git ls-files` の既定は `--cached`（index の全 tracked ファイル）なので:

- **未追跡の新規ファイルは `git add` するまで測られない。** pre-commit は staged 後に走るのでコミットは
  守られるが、**`git add` 前の手元 `npm test` は緑になる**
- **作業ツリーで消したが index に残るファイル**は `readFileSync` の ENOENT で throw（隠れない）

### 13.6 main による独立検証（2026-09-12・別素材 + 敵対的ケース 4 件）

§13.3 の主張を main が**別の合成素材**で再現し、さらに「この方式が壊れる条件」を探した。
**4 ケースすべてで仕込みが residual に出た。**

素材: `before/a.rs`（162 行・うち `#[cfg(all(test, feature="outproc-effect"))] mod effect_slots` が 152 行）
→ `after/a.rs`（10 行）+ `after/effect_slots.rs`（151 行）。残る側に `tick() { 1 } → { 2 }` を仕込む。

| ケース | 素の変更行 | moved+ | residual | 仕込みは residual に出たか |
|---|---|---|---|---|
| 基本（純粋な移動 + 外側の論理変更 1 行） | 307 | 151 | **5** | ✅ `tick() { 1 } → { 2 }` |
| **A: 移動ブロック中央の 1 行を書き換え** | — | 150 | 7 | ✅ `helper_75` の `+7 → +8` の対 |
| **B: 移動ブロックから 1 行を削除** | — | 150 | 6 | ✅ 消えた行が `-` で出る |
| **C: 移動ブロックに新規行を忍ばせる** | — | 151 | 6 | ✅ `+fn smuggled_backdoor()` |
| **D: 外出し先を作り忘れ（行が消滅）** | — | **0** | **156** | ✅ residual が爆発してゲートが落ちる |

**307 変更行 → residual 5 行（1.6%）。** §13.5 の反証条件（「素の変更行の 2 割以上なら再考」）に対して十分な余裕がある。

🔴 **子 0b のフィクスチャは §13.5 の 2 件ではなく、上の 5 件すべてを入れること**（main 指示）:

- **C（挿入）** は「移動に紛れて新しいコードを入れる」という最も危険な形。`moved+` は 151 のまま変わらない
  （= 件数では気づけない）が、`+` 行は residual に出るのでレビュアーの目には入る
- **D（消滅）** は「分割したつもりで行が失われた」形で、#888 の目的そのものに関わる。
  `moved+ = 0` と residual 爆発の**2 つの信号**が同時に立つ

**色の固定（`-c color.diff.newMoved=…` 等）は必須**。既定色のままだと moved と normal の区別が環境依存になる。
判定に使った実コマンドと出力は scratchpad の `movetest-results.md` にある。

### 13.7 🔴 実素材での検証 — §13.5 の反証条件への回答（main・2026-09-12）

§13.5 は「実際の `engine_wrap.rs` の最初の抽出で residual が**素の変更行の 2 割以上**残るなら
判定器として弱く、切り方を再考する」を反証条件に置いていた。**子 1 を待たずに main が測った。**

素材: `rust/crates/orbit-audio-daemon/src/engine_wrap.rs`（15,678 行）から
**2081〜2442 行（バス関連の型と関数・362 行）を `bus_lines.rs` へ外出し**し、
元ファイルには `mod bus_lines;` と `use bus_lines::*;` の 2 行を入れた。

| | 値 |
|---|---|
| 素の変更行（§5.1 の数え方） | **686** |
| moved+ / moved− | 362 / 362 |
| **residual** | **2** |
| residual 比率 | **0.3%**（反証条件は 20%） |

residual の中身（全件）:

```
+mod bus_lines;
+use bus_lines::*;
```

**residual は「意図して足した 2 行」ちょうどで、移動した 362 行は 1 行も残らなかった。**
§13.5 の反証条件は発火せず、**方式は実素材で成立する**。

### 意味（束の算術）

residual は「新しい `mod` 宣言 + `use` + 可視性の変更」にほぼ比例し、**移動量には比例しない**。
したがって §13.1 の「素の変更行 5〜6 万 → 40 束前後」は、residual で数えると
**桁違いに小さくなる**（この抽出の比率がそのまま効くなら 1〜2 束の規模）。

🔴 ただし **§5.1 の改訂は owner の規則**（#799）なので、これは §12 の 4 に上げた裁定の
**材料**であって決定ではない。子 1 の着手前に owner の裁定が要る。

### 数え方の但し書き

`--color-moved` を付けた diff と付けない diff は similarity の解き方が違うため、
`moved+ + moved− + residual` は素の変更行と一致しない（本件では 726 vs 686）。
**判定に使うのは residual の絶対値**であって、比率は目安として読むこと。
