# #967 — Pitch DSL の音高の乱数（`r` / `rr` / `random.<mode変数>`）設計

> **Status**: 確定（2026-09-25）。起案 = fresh Opus subagent（初版 → 改訂 r2）/ 審査 = main / 表面の決定 = owner。**§1 の決定は再議論しない。**
> **位置づけ**: 拡張版（OrbitScore）への機能追加。版は 4.3.0（minor）の想定。本書と spec の更新は docs のみで、**実装は後続 PR**。
> **関連**: [`../specs-v2/PITCH_DSL_SPEC_v1.1.md`](../specs-v2/PITCH_DSL_SPEC_v1.1.md) §2.1 / §2.2 / §6.2 / [`../specs-v2/DESIGN_DISCUSSION_RECORD.md`](../specs-v2/DESIGN_DISCUSSION_RECORD.md) §12.4・§16（決定 #80〜#84）/ [`../core/INSTRUCTION_ORBITSCORE_DSL.md`](../core/INSTRUCTION_ORBITSCORE_DSL.md) P.12。
> **別 issue に切り出した既存の穴**: `Xr(p)` 未実装 = [#968](https://github.com/signalcompose/orbitscore/issues/968) / `mode(0, …)` が NaN の格子になる = [#969](https://github.com/signalcompose/orbitscore/issues/969) / `seq.mode()` 未実装 = [#970](https://github.com/signalcompose/orbitscore/issues/970)。
> **検証手段の決め方**: CLAUDE.md「テストの積み上げ規律」の現行版に従う（機能テスト → キャプチャ E2E が本体。変異検証は使わない）。

---

## 1. 確定した決定（owner 2026-09-25）

owner の原文:「普通に `play(1,2,r,4...)` みたいにピッチ情報の 1 つとして `r` を入れればいいのでは？ で、それがなるかならないかは `rr` とか？」「`var r1 = randam.mode()` みたいにして複数のランダムのケースを作って置けるとなお良いよね」「上のが使えるなら `var r1 = randam.dorian` ってできるよね？」「いや組み込み変数じゃなくて定義した mode をそのまま使えないの？」「機能拡張版に追加する」「定義を渡すだけでいい」「あとは提案でいい」。

| # | 決定 | 由来 |
|---|---|---|
| K1 | 音高の位置に `r` を置く（`play(1, 2, r, 4)`）。値はその音のスコープの格子から一様に選ぶ: root スコープ = Ionian の 1〜7（変化記号・9/11/13 は含まない）/ mode スコープ = 格子の全長。短調は `.mode()` で書く | owner + 採用した提案 |
| K2 | 出現確率つきは `rr`（= `r` に `Xr` の `r` を付けたもの・確率 0.5）。`r.r` / `r.r(p)` でも書ける | owner + 採用した提案 |
| K3 | ランダム音源は `var X = random.<mode変数>` **だけ**。`<mode変数>` はユーザーが `var dorian = mode(...)` で定義したもの。組み込みの旋法に**依存しない**（`random.dorian` は定義なしでは動かない。決定 #58 の「教会旋法はライブラリの var 群として提供」は変えない — ライブラリが入れば、その var も同じく渡せる）。`random.mode(...)`（その場で格子を書く）と `random.mode(名前)` は入れない | owner（「定義を渡すだけでいい」） |
| K4 | 宣言の語は `random`（原文の `randam` は打ち間違い） | 採用した提案 |
| K5 | ランダム音源は root を持たない。root はその音のスコープから取る | 採用した提案 |
| K6 | `random.<mode変数>` は**定義時に格子を写し取る**（値渡し）。後で mode 変数を定義し直しても変わらない | 採用した提案 |
| K7 | `^N` は `r^1` でも `r1^1` でも**スティッキー**（通常の度数 `3^1` と同じ）。`r` はその時点の running range の中で選ぶ | 採用した提案 |
| K8 | ランダム音源の名前参照には `^N` / `^r` / `~` / `@v` / `@g` / `.r` / `.r(p)` を付けられる。**chord 変数・パターン変数の名前参照の意味は変えない**（§3.3） | 採用した提案 |
| K9 | 重複要素を持つ mode（`mode(1, 1, 1, 5)`）で**重み**を書くのを正式な書き方とする | 採用した提案 |
| K10 | ランダム声部を含む `[ ]` への `.close()` / `.open()` / `.shell()` / `.rootless()` はエラー。`.drop()` / `.invert()` は許可。`.voicelead()` はランダム声部を計算から外す | 採用した提案 |
| K11 | 振り直しは既存の `Xr` / `^r` と同じく、TimedEvent 1 件ごと・ループ反復ごと。seed は持たない | 採用した提案（決定 #21 / #50） |
| K12 | note シーケンスでは `play()` 直下の `r` も音高の乱数。audio シーケンスの意味は変えない（無音の slot のまま・警告だけ足す） | 採用した提案（運用規則 5） |
| K13 | `r` / `rr` は音高の位置で予約（`var r =` / `var rr =` はエラー）。`r`+数字の名前（`r1`）は、後ろに `%` が続かない限り名前として読む | 採用した提案 |
| K14 | 拡張版に追加する。版は minor（4.3.0 想定）。バージョンの bump は実装 PR で行う | owner |

棄却した案（決定ログ #80〜#84 と付録 A）: 候補リスト `r[…]`（初版の推奨）/ 範囲 `rC%N` / `( ).r` / 交替記号 `|` / `random.mode(…)` / `random.root(X).…` / 定義なしで動く組み込みの `random.dorian`。

---

## 2. 一次ソースで確認した事実（2026-09-25・main `c90bb157`）

### 2.1 現在のパース結果（実パーサで実測）

| 入力 | 今の結果 | 本設計での扱い |
|---|---|---|
| `p.play(1, r, 4)`（直下） | `r` → `{type: 'full-random'}`（gain/pan と同じ乱数値）。timing のどの分岐にも当たらず、**TimedEvent を作らない無音の slot**（実測: `[[1, 0, 666.7], [4, 1333.3, 666.7]]`・`calculate-event-timing.ts:116-325`） | note では音高の乱数にする。audio では無音の slot のまま |
| `p.play((1, r, 4))`（`( )` 内） | 名前参照 `chord_ref "r"` → 未定義として警告つきの休符（`resolve-chords.ts:99-106`） | 直下と同じ度数ノードに揃える |
| `p.play(r1)`（直下） | **パースエラー** `expected '%' after 'r1'`（`parser-utils.ts:106-115` → `parse-expression.ts:629-651`） | K13 で名前として読む |
| `p.play((1, r1, 4))` | `chord_ref "r1"` | そのまま |
| `p.play((1, r1.r(0.3)))` | 名前参照を 1 声部のスタックに包み、間引き 0.3（`parse-expression.ts:916-934`） | 1 声部の間引き = 出現確率。**今の構文のまま使える** |
| `p.play((1, r1r))` | `chord_ref "r1r"`（1 つの識別子 `tokenizer.ts:85-91`） | 出現確率には使えない。`r1.r` と書く（§5 W2） |
| `p.play((1, r@v100))` / `r~0.5` / `r^r` | パースエラー | 度数ノードとして修飾子を読む |
| `var r1 = random.dorian` | パースエラー `Expected INIT` | 空いている |
| 🔴 `var r1 = random.sum` | **ミキサー宣言として受理**（`parse-statement.ts:141-149` の先読み） | `random` の分岐を先読みより前に置く（§3.2） |
| `var mode = mode(1, 2)` / `var output = mode(1, 5)` | どちらも `mode_binding` | K3 で `random.mode(` を入れないので `random.mode` は常に「mode という名の変数」。衝突しない |
| 🔴 `var z = mode(0, 5)` | 格子 `[NaN, 7]`・period `NaN`（`degreeToSemitone(0)` が `IONIAN[-1]` を引く `degree-resolution.ts:33-37`） | #969。ランダム音源はこれを写し取ると NaN の音を引く |

### 2.2 実装の事実

| # | 事実 | 根拠 |
|---|---|---|
| F1 | パーサは audio と note を区別しない。区別は dispatch で行う | `sequence.ts:1523-1532` |
| F2 | 名前空間は 1 枚で、値の種類を `kind` で区別する（`chord` / `pattern` / `mode`） | `midi/chord/types.ts:34-37`、`global.ts:307-379` |
| F3 | chord は定義時に評価し（`global.ts:322-329`）、play() の中の名前は play() の評価時に解決する（`sequence.ts:1248-1256`）。`.mode(name)` だけは dispatch 時に名前で引く（`sequence.ts:1384-1391`） | K6 は chord 側に揃える |
| F4 | mode 変数は要素を半音オフセットにして格納する。綴りは定義時に失われ、重複は弾かない | `parse-statement.ts:34-41`, `:199-244` |
| F5 | mode スコープの解決: `lattice[(n-1) mod len] + period·⌊(n-1)/len⌋ + alteration`。`{1-9,11,13}` の制約は掛からない | `degree-resolution.ts:66-81` |
| F6 | group の `.root()` と `.mode()` は同じグループに同時に付けられない。mode は seq の既定 root に乗る | `parse-expression.ts:727-742`、決定 #59 |
| F7 | `seq.mode()` は実装されていない（PITCH §3 / §9.3 には書いてある） | `signal-chain/runtime.ts:37-71`、`sequence.ts:1186`。#970 |
| F8 | 既存の乱数は TimedEvent 1 件ごと・ループ反復ごとに独立に引く | `sequence.ts:1602`（`^r`）、`:1607`（`Xr` / `.r`） |
| F9 | `.r` は名前参照に付けると 1 声部のスタックに包む。スタックの確率は、自前の `Xr` を持たない各声部へ配られる（声部ごとに独立） | `parse-expression.ts:916-934`、`calculate-event-timing.ts:212-216` |
| F10 | 先行検証 `validateMidiDispatch` は書かれた度数を 1 回ずつ解決し、不正な度数・root を評価時に落とす | `sequence.ts:1419-1432` |
| F11 | `.voicelead()` は出力段で一度だけ絶対ピッチを計算する。voicing 演算子は評価時に働く | `sequence.ts:1434-1502`、`resolve-chords.ts:256-330` |
| F12 | audio の出力は `sliceNumber > 0` のイベントだけを鳴らす | `event-scheduler.ts:117`, `:219` |
| F13 | `.root.F` のプロパティ形を棄却した理由は「`F#` 等で破綻する」（`PITCH_DSL_SPEC_v1.1.md:113`）。`F#` は `IDENTIFIER F` + `ACCIDENTAL #` の 2 トークン（`tokenizer.ts:167-171`）。宣言できる変数名は常に 1 トークンの IDENTIFIER（`parse-statement.ts:103-104`。`b`+数字や `_` で始まる名前はトークナイザが別トークンにするので宣言できない `tokenizer.ts:172-186`） | `random.<mode変数名>` にはこの棄却理由が当たらない |
| F14 | 構文表面のラチェット: `DslSyntaxId` に足した構文は、実機 E2E の台帳が無いと red | `parser/dsl-surface.ts:5-35`、`tests/e2e/dsl-e2e-coverage.spec.ts:176-187` |
| F15 | `Xr(p)` はパーサに無い。`5r(p)` は `5r` と `( )` グループ `(p)` の並置になる（`5r(1)` は黙って度数 1 を 1 スロット足す） | `parse-expression.ts:458-462`, `:1315-1337`。#968 |

---

## 3. 意味論

### 3.1 文法

```
// 宣言（文）
random_binding := 'var' NAME '=' 'random' '.' MODE_NAME     // MODE_NAME: 定義済みの mode 変数（1 トークン）

// 音高の位置（play() の要素 / ( ) { } の要素 / [ ] の声部）— どこでも同じノード
rand_pitch     := ('r' | 'rr') mods                          // rr ≡ r + 出現確率 0.5（`rr` は 1 つの識別子なので予約語として読む。`r r` は r + 接尾辞 r として同じ意味）
source_ref     := NAME mods ['.r' ['(' p ')']]               // NAME がランダム音源に束縛されている時
mods           := ( '^' N | '^r' | '~' N | '@v…' | '@g…' | 'r' )*
```

- `rand_pitch` の後ろにも `.r` / `.r(p)` を付けられる（K2）
- `rrr` 以上は予約しない（ただの名前 → 未定義なら既存の警告つき休符・§5 W2 でヒント）
- `var r = …` / `var rr = …` はパースエラー（K13）

### 3.2 ランダム音源の束縛

- **宣言の位置づけ**: `var X = mode(...)` と同じ「値を名前空間へ登録する文」。`init` 系ではない
- **パーサ**: var の右辺の分岐に「`IDENTIFIER random` + `DOT` + `IDENTIFIER`」を足す。🔴 **ミキサー先読み（`parse-statement.ts:141-149`）より前**に置く（`random.sum` / `random.output` / `random.aux` の横取りを防ぐ）。これにより `random` という名前のミキサー（`var random = init global.mixer`）は作れなくなる（repo 内の `.orbs` に使用 0 件）
- **定義時の評価**（K6）: `mode` 変数を引き、格子と period を写し取って `BoundValue` に `{ kind: 'random', lattice, period, from: '<mode変数名>' }` を登録する（`types.ts:34-37` に `kind` を 1 つ足す）。`from` は診断と将来の譜面出力のために残す
- **定義時エラー**: 未定義の名前 / `chord` や `pattern` / 格子に NaN を含む（#969 が直るまでの防御）→ §5 E3〜E6
- **使う側の解決**: play() の評価時に、名前参照を `resolveName`（`resolve-chords.ts:92-135`）の `kind` 分岐で `kind: 'random'` として解決し、ランダム度数ノード（格子つき）に置き換える。以後はシンボリックなまま TimedEvent まで運ぶ（§7-0）

### 3.3 名前参照の修飾子（K8 の範囲の限定）

今の名前参照が受けるのは `^N` と `.r` / `.r(p)` だけ（`parseChordRef` `parse-expression.ts:1178-1190`）。パーサは名前の中身を知らないので、次のように分担する:

- **パーサ**: 名前参照の後ろの `^N` / `^r` / `~` / `@v` / `@g` を読んで、名前参照ノードに記録する
- **評価時**:
  - 名前が**ランダム音源**なら、修飾子をランダム度数ノードに移す。`^N` はスティッキー（K7）
  - 名前が **chord**・**pattern** なら、`^N` の意味は今のまま（chord = 構造的な全体シフト `PITCH_DSL_SPEC_v1.1.md:254` / pattern = 警告して無視 `resolve-chords.ts:125-127`）。`^r` / `~` が付いていたら**評価時エラー**。`@v` / `@g` は **#609（stack 全体への `@v`・未実装）で決める** — 本設計では決めず、#609 が入るまでは評価時エラーとする。いずれも今パースエラーになっている字面なので、既存の譜面の意味は変わらない（パーサは名前の種類を知らないので、**パースエラー → 評価時エラーへ段が移る**）

### 3.4 bare `r` と音源変数の関係

同じ仕組みで、**格子の出どころだけが違う**:

```
r             = その音のスコープの格子から選ぶ（mode があればその格子、無ければ Ionian 7 音 [0,2,4,5,7,9,11]）
random.dorian = dorian の格子から選ぶ（スコープの mode より優先。root はスコープから取る）
```

`random.dorian` を `.mode(aeolian)` のグループの中で鳴らした場合は `dorian` が優先する（テキストに書いてあるので）。`.root(5)` のグループなら 5 度の上の dorian になる（K5・決定 #59 と同じ考え方）。

### 3.5 選ぶ手順（出力段 Stage A・`sequence.ts:1580-1629`）

| 順 | 処理 | 根拠 |
|---|---|---|
| 1 | running range の更新: `^N` があればスティッキーに設定（K7） | PITCH §2.4、`sequence.ts:1593` |
| 2 | 格子を決める（§3.4） | `sequence.ts:1369-1391` |
| 3 | `k ∈ [1, len]` を一様に選ぶ | K1 |
| 4 | `k` をスコープの root で解決する。有効オクターブ = running range + `.oct()` + `^r` | `sequence.ts:1596-1605`、F5 |
| 5 | 出現判定: `rr` / `.r(p)` / 親スタックの `.r` | `sequence.ts:1607`、F9 |
| 6 | `@v` / `@g` / `~` を適用 | `sequence.ts:1610-1627` |

- 粒度は K11。`r*4` は 4 回の独立な選択（`*n` は並置 §6.5.1）。パターン変数を 2 回使えば 2 回
- 先行検証（F10）はランダム度数ノードについて**スコープ（root / key / mode）が解決できること**を確かめる。選ばれる度数は格子の中なので不正にならない

### 3.6 音域・オクターブとの合成

`k ≤ len` なので **`period` は選ばれる音に効かない**（`period·⌊(k-1)/len⌋ = 0`）。範囲を決めるのは格子の半音オフセットそのもの。

| 格子 | 選ばれる範囲（root からの半音） |
|---|---|
| 1 オクターブ内（`mode(1,2,b3,4,5,6,b7)`） | 0〜11 |
| 2 オクターブ（`mode(1,2,b3,4,#5,6,7,9,#11,b13,7^+1)` §2.2 `:92`） | 0〜23 |
| root より下を含む（`mode(1, 7^-1)`） | {0, −1} |
| 非オクターブ周期（`.period(19)`） | 格子の値そのまま |
| 12 音半音階（`mode(1,b2,2,b3,3,4,#4,5,b6,6,b7,7)`） | 0〜11 |
| 重複あり（`mode(1,1,1,5)`・K9） | 0 が 3/4、7 が 1/4 |

running range（`^N`）と `.oct()` はこの範囲をオクターブ単位で平行移動する。`^r` は選ばれた 1 音を ±1 オクターブ動かす。

### 3.7 度数 0・休符

- 格子に休符は入らない（#969 が直れば `mode(0, …)` はエラー）。したがって `r` / ランダム音源は**必ず音を出す**。鳴らない可能性があるのは `rr` / `.r` を付けた時だけ
- 検証層（SESSION_LOG §5）: `r` / ランダム音源の由来は「発音の事実とタイミングは一致・値は不問」の**構造比較**。`rr` / `.r` 付きは発音の有無も乱数なので**除外**

### 3.8 和音の中

- `[1, r, 5]`: 声部の 1 つがスコープの音階から選ぶ。`[r, r, r]` は 3 声部が独立（重なればユニゾン）
- 親スタックの `.r` はランダム声部にも配られる（F9）
- voicing と voice-leading（K10・DESIGN §12.4 の段の分離 — 評価時・一度だけの段は、実行時に決まる値を参照できない）:

| 機能 | 規則 | 理由 |
|---|---|---|
| `.drop(n)` / `.invert(n)` | 許可。書かれた位置（構造順）で数え、ランダム声部の構造的オクターブに加算する | 位置で数えるのでピッチが未確定でも決まる（§6.1 `:272`） |
| `.close()` / `.open()` | 評価時エラー | ピッチ順に並べ直す演算（`resolve-chords.ts:237-251`） |
| `.shell()` / `.rootless()` | 評価時エラー | 度数の同一性で選別する（`resolve-chords.ts:295-310`） |
| `.voicelead()` | ランダム声部を計算から外し、書いたオクターブのまま置く。決定的な声部だけで VL する | 既存の「VL は `.r` / `Xr` と独立」（§6.3 `:335`）と同じ向き |
| 外側の `-N` 除去 | ランダム声部は 1 声部として扱い、中の格子には及ばない | 字面一致（§6 `:253`） |

### 3.9 タイ

- `(r, _)`: 延びるのは**そのサイクルで選ばれて解決された音**（§5.1 `:213`。Stage B1 は Stage A の後 `sequence.ts:1633`）
- `.hold()` / 声部タイ `_n` の照合は解決後ピッチなので、選択後の音で照合される。`_r`（ランダム声部への声部タイ）はパースエラー

### 3.10 audio シーケンス（K12）

- 無音の slot のまま。timing で audio の TimedEvent を**作らない**（今の `full-random` と同じ。§2.1 の実測）。仮に作る実装を選ぶ場合も `sliceNumber` 0 なら鳴らない（F12）
- `( )` 内の `r` で出ていた「unknown name」警告の代わりに、§5 W4 を 1 回出す（音は変えない・診断だけ）

### 3.11 シンボリック保持（§7-0）

- TimedEvent には「格子（半音オフセット）+ 出どころの名前（`dorian` / スコープ）」を載せ、MIDI 番号化は出力段の最後で行う
- root スコープの bare `r` は選ばれた度数（1〜7）をそのまま綴りとして持つ。mode 由来は、既存の mode と同じく綴りが定義時に失われている（F4）— 本機能で新たに失うものは無い

---

## 4. 実装の変更点（後続 PR 向けの地図）

| 層 | 変更 | 起点 |
|---|---|---|
| パーサ | `r` / `rr` を度数ノードとして読む（`parseArgument` / `parseNestedPlayElement` / `parseStackElement` の IDENTIFIER 分岐の前） | `parse-expression.ts:95-139`, `:1285-1288`, `:1142-1143` |
| パーサ | `r<数字>` は `%` が続く時だけ乱数値（K13） | `parse-expression.ts:529-532`, `:629-651` |
| パーサ | 名前参照の修飾子（§3.3）。chord / pattern への `^r` `~` `@v` `@g` は**パースエラーから評価時エラーへ移る** | `parse-expression.ts:1178-1190` |
| パーサ | `r.r(p)` を許可（今は stack / chord_ref のみ） | `parse-expression.ts:916-934` |
| パーサ | `var X = random.<名前>`（ミキサー先読みより前） / `var r` `var rr` の予約 | `parse-statement.ts:101-149` |
| 名前空間 | `BoundValue` に `kind: 'random'` | `midi/chord/types.ts:34-37`、`global.ts:347-351` の隣 |
| 評価 | `resolveName` / `evaluateStackVoices` に `random` 分岐。voicing の K10 | `resolve-chords.ts:92-135`, `:143-178`, `:256-330` |
| timing | ランダム度数ノード → TimedEvent（格子つき・audio は `sliceNumber` 0） | `calculate-event-timing.ts:221-244` |
| 出力段 | Stage A で選ぶ（§3.5）/ 先行検証 / VL から除外 | `sequence.ts:1419-1432`, `:1451-1502`, `:1580-1629` |
| 表面の台帳 | `DslSyntaxId` に `'random-pitch'` と `'random-binding'` | `parser/dsl-surface.ts` |

---

## 5. 診断

基本線は評価時エラー（`evaluate_orbitscore` の `ok: false`）。エディタで書いている時の診断はテキスト解析（`diagnostics-analysis.ts`）で、パーサを通さない。

| ID | 条件 | 種別 | 文言案 |
|---|---|---|---|
| E1 | `var r = …` / `var rr = …` | パースエラー | `r / rr は音高の乱数として予約されています。別の名前を使ってください（例: var r1 = random.dorian）` |
| E2 | `var X = random`（`.名前` が無い）/ `random.` の後が識別子でない | パースエラー | `random の後に mode 変数の名前を書いてください（例: var r1 = random.dorian）` |
| E3 | `random.foo` の `foo` が未定義 | 定義時エラー | `random.foo: mode "foo" が見つかりません。先に var foo = mode(1, 2, b3, …) を書いてください` |
| E4 | `random.m7`（chord）/ `random.riff`（pattern） | 定義時エラー | `random.m7: "m7" は chord です。random. の後には mode 変数を書きます` |
| E5 | `(…).mode(r1)`（ランダム音源をスコープに渡した） | 評価時エラー | `.mode(r1): "r1" はランダム音源です。スコープには mode 変数を渡してください（.mode(dorian)）` |
| E6 | 格子に NaN を含む mode から音源を作った（#969 が直るまでの防御） | 定義時エラー | `random.z: mode "z" の格子が不正です（mode(...) に 0 は書けません）` |
| E7 | ランダム声部を含む `[ ]` への `.close()` / `.open()` / `.shell()` / `.rootless()` | 評価時エラー | `.shell() は r / ランダム音源の声部を含む和音には使えません（選ばれる度数が評価時に決まらないため）` |
| E8 | chord / pattern の名前参照に `^r` / `~`（§3.3）。`@v` / `@g` は #609 が決めるまで同じくエラー | 評価時エラー | `"m7" は chord です。^r / ~ はランダム音源と度数にだけ付けられます` |
| E9 | `_r`（ランダム声部への声部タイ） | パースエラー | `_ の声部タイは度数にだけ付けられます` |
| W1 | 格子が 1 音だけ・全要素が同じ | 警告 | `random.one は常に同じ音を選びます` |
| W2 | 未定義の名前 `r1r` / `rrr` | 既存の unknown name 警告にヒント | `… 出現確率は r1.r / r1.r(0.3) と書きます` |
| W3 | play() の中の mode 変数（今の警告 `resolve-chords.ts:111-117`） | 既存の警告にヒント | `"dorian" は mode です — スコープなら (…).mode(dorian)、ランダムな音なら var r1 = random.dorian` |
| W4 | audio シーケンスでの `r` / `rr` / ランダム音源 | 警告（音は今のまま無音） | `r は note シーケンスの音高の乱数です。audio シーケンスでは休符として扱います` |

重複（`mode(1, 1, 1, 5)`）は重みの書き方なので警告しない（K9）。

---

## 6. テスト計画

### 6.1 機能テスト（TDD・実装前に red を確認）

置き場所は `tests/midi/random.spec.ts` の隣（構文は決定的に、分布は多数回の統計で確かめる流儀）。

**パース（決定的）**: `p.play(1, r, 4)` / `(1, r, 4)` / `[1, r, 4]` が同じ度数ノード / `rr` と `r r`（同じ意味・トークン列は違う）/ `r^1`（スティッキー）/ `r^r` `r@v100` `r~0.5` / `r.r(0.3)` / `var r1 = random.dorian` / `var r1 = random.sum` がランダム音源（ミキサーにならない）/ `p.play(1, r1, 4)` が名前参照 / **回帰**: `seq.gain(r)`・`seq.gain(r1%3)`・`seq.pan(r0%10)` は乱数値のまま / E1・E2・E9。

**評価（決定的）**: E3〜E8 / 定義時に写し取る（`dorian` を定義し直しても `r1` が変わらない）/ `m7^1` の意味が今と同じ（構造的シフト）/ **audio の回帰**: `kick.play(1, r, 1)` のオンセット数と時刻が今と同じ。

**ディスパッチ（統計・既存の `onceOns` ハーネス・N=20）**:

| テスト | 判定 |
|---|---|
| `global.key("C")`・`r` | 出た音 ⊆ {60,62,64,65,67,69,71}、2 種以上。変化記号の音・9/11/13 が出ない |
| `(r, r, r, r).mode(aeolian)` | 出た音 ⊆ C エオリアン |
| `(r).root(5)` | 出た音 ⊆ G 上の Ionian |
| `3^1, r` | `r` が 72〜83 から出る（running range の中） |
| `r^1, 5` / `r1^1, 5` | 後続の 5 が +1 オクターブ（どちらもスティッキー・K7） |
| `var two = mode(1, 5)` / `var r1 = random.two` | 出た音 ⊆ {60, 67}、両方出る |
| `r1` を `.mode(aeolian)` の中で | `two` の格子が優先 |
| `var w = mode(1, 1, 1, 5)` の音源を N=200 | 60 の比率が 0.75 の近傍（二項分布の 99.9% 区間）— 重みの検査 |
| 2 オクターブの格子 | 0〜23 半音 |
| `rr` / `r1.r(0.3)` | 休むサイクルと鳴るサイクルが両方ある |
| `[1, r, 5].r(1)` | 1 と 5 は常に鳴る |
| `(r, _)` | 延びる音 = そのサイクルで選ばれた音 |
| `[1, r, 5]` + `.voicelead()` | ランダム声部の octaveShift が VL で書き換わらない |

**オラクルの識別力**: 「2 種以上出る」の判定を、1 音だけの格子（`random.one`）に回すと**落ちる**ことを 1 本で固定する。

### 6.2 E2E（実機・MCP 経由・キャプチャ）

- 積み先: `tests/e2e/orbitstudio-mcp-gated.spec.ts`（共有セッションのシナリオ）。音源は既存の pitch 判定と同じ `seq.instrument(<CLAP synth>)`
- DSL: `var two = mode(1, 5)` / `var r1 = random.two` / `s.play(r1, r1, …)` を 16 音以上、gate を長めに。bare `r` のシナリオは `(r, r, …).mode(two)` で同じ判定
- 観測: capture WAV を音ごとの窓に切り、`estimateFundamentalHz`（`packages/vscode-extension/src/wav-analysis.ts:207`）。判定式は既存の `440·2^((n−69)/12)`・許容 2%
- 判定: (1) すべての窓が C4 か G4 / (2) 両方が出る（偽陰性 2·0.5^16 ≈ 3e-5）/ (3) すべての窓に音がある / (4) `get_log` の ERROR 件数は `<=`
- 負の E2E: `var r1 = random.nope` で `ok: false` と E3 の文言
- 台帳: `DslSyntaxId` の `'random-pitch'` / `'random-binding'` を `capture-pitch` で登録（F14 のラチェットが強制）

---

## 7. 版と出荷

- 拡張版（OrbitScore）に追加する（K14）。版は **4.3.0（minor）** の想定で、bump は実装 PR で行う
- minor とする根拠: 既存の合法な譜面のうち挙動が変わるのは「`( )` 内の未定義の名前 `r` / `rr`（警告つきの休符）が音になる」と「`play()` 直下の `r`（note シーケンスの無音の slot）が音になる」だけ。repo 内の `.orbs` に該当は 0 件（`git ls-files '*.orbs' | xargs grep` で確認）。audio シーケンスの意味は変えない
- 実装箇所（`packages/engine`）は、ネイティブ版の計画で層 2 に当たる（`docs/planning/NATIVE_MIGRATION_2026-09.md:172-173`）ので、ネイティブ版にもそのまま引き継がれる

---

## 付録 A: 棄却した記法（決定 #80 の棄却案の詳細）

| 案 | 例 | 棄却の理由 |
|---|---|---|
| 候補リスト `r[…]`（初版の推奨） | `r[1, 3, 5]` / `r[m7, -5]` / `[1, r[3, b3], 5]` | owner が「音高の位置の `r` + 定義した mode」を選んだ。**将来の追加の候補として残す**: `r` の直後の `[` は今どの文脈でもパースエラー（`parse-expression.ts:1315-1337`, `:529-532`）なので、後から足しても既存の譜面を壊さない。利点は候補に `b3` / `#2` の綴りを持てることと、コード変数を候補にできること。短所は `[ ]`（同時発音）の意味が前の `r` だけで「どれか 1 つ」に反転すること |
| 範囲 `rC%N`（audio の `r0%10` と同形） | `r3%2` | 0（休符）・負数・10/12（不正度数）をまたぐ。変化記号付きの候補を書けない。なお audio の `r0%10` は random walk ではなく center ± range の一様乱数（`random-utils.ts:16-25`） |
| `( ).r` で 1 つ選ぶ | `(1, 3, 5).r` | `( )` は時間分割なので、`.r` を付けるとリズム構造が変わる |
| 交替記号 `\|` | `(1\|3\|5)` | 新しい記号（決定 #50 に反する）。`\|` は今トークナイザが黙って捨てる（`tokenizer.ts:277-279`） |
| `random.mode(…)` / `random.mode(名前)` | `random.mode(1, 2, b3)` | owner「定義を渡すだけでいい」 |
| `random.root(X).…` | `random.root(D).dorian` | root はその音のスコープから取る（K5）。group の root / mode 排他規則（F6）と逆向き |
| 定義なしで動く組み込みの `random.dorian` | `var dorian` を書かずに `random.dorian` が動く | owner「組み込み変数じゃなくて定義した mode をそのまま使えないの？」。🔴 これは `random.` に渡すものの話で、決定 #58 の旋法ライブラリ（未実装）そのものは棄却しない |
| ランダムウォーク（直前の音から ±n） | — | サイクルをまたぐ状態を持ち込む。既存の乱数はすべて状態なし（F8） |

## 付録 B: 起案の経緯

- 初版（候補リスト `r[…]` を推奨）→ owner の決定を受けて改訂 r2（`r` / `rr` / `random.<mode変数>`）→ main 審査を通過 → owner の最終決定（拡張版に追加・`random.<mode変数>` のみ・残りは推奨どおり）で本書を確定
- 起案の過程で見つけた既存の不整合: core spec P.12 の「`.r` は全声部を一緒に間引く」（実装は声部ごとに独立）/ core spec の「`r0%10` (random walk)」（実装は一様乱数）/ SESSION_LOG の「ランダム機能は存在しない」— いずれも本書と同じ PR で文書側を直す。パーサの穴（#968）・mode の NaN（#969）・`seq.mode()` 未実装（#970）は別 issue
