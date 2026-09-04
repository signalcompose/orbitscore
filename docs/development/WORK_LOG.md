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

### docs: follow PR #737's dispatch-skip contract into the specs and both sites (Sep 4, 2026)

**追従元**: PR [#737](https://github.com/signalcompose/orbitscore/pull/737)（`645-contain-playback-throws` → main・マージコミット `ef140b1`）/ **ブランチ**: `claude/docs-sync-pr737`

#737 は `Sequence.resolveDispatchChannel()` の **throw を撤去**し、戻り値を
`DispatchTarget = { kind: 'hardware' } | { kind: 'link'; channel } | { kind: 'skip'; reason }`
の tagged union にした（`sequence.ts:103-106`）。LinkAudio セッションで `.output()` を持たない
発音 sequence は、**runtime error ではなく無音スキップ + `logSkipOnce()` のログ 1 行**になる。
**この意味論の変更が 4 つの文書に追従していなかった。**

#### 直したもの

| 場所 | 追従した内容 |
|---|---|
| `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` §8.1.2 | 「`.play()` した時点で **runtime error** を投げる」を削除し、無音スキップ + dedup ログ + `DispatchTarget` の説明に置換。**hardware への silent fallback を行わない**点は不変 |
| `docs/specs-v2/MULTICHANNEL_RENDERING_DESIGN_598.md` §4.4.1 | 「`resolveDispatchChannel()` が throw し、ライブ中に kick が**停止**する」→「skip 判定に落ち、**無音になる**」。非対称の理由（オフライン宣言が live routing を壊さない）は変わらない |
| `sites/dev/editor/execution-feedback.md`（日英）§6-8 | 「runtime では throw として現れる」「7 と 8 が Error なのは runtime で必ず throw するから」を訂正。`DispatchTarget` の引用と、`undefined` を union から外した理由（`catch { return undefined }` が黙って hardware へ流す事故を型で潰す）を追加。drift 表に #645 行 |
| `sites/user/midi/link-audio.md`（日英） | 「ランタイムエラーを発生させます」→「無音でスキップされ、理由がログに出ます」。巻き添え停止を避けるための変更である旨を 1 段落 |

🔴 **ユーザーから見た壊れ方が変わった**: 以前は例外が出て気づけたが、いまは**音が出ないだけ**である。
気づく手段はログ（`[ERROR] Sequence '<name>': … このシーケンスは無音でスキップします。`）と
編集時診断 `analyzeLinkAudioMissingOutput` の 2 つになる。user site にその旨を書いた。

#### 追従しなかったもの

- `docs/design/610-diagnostics-applicability-design.md` — 起案時点のスナップショット（本 PR の設計正本そのもの）
- `sites/user/reference/methods.md` の `output("name")` 行 — 「`global.linkAudio()` 宣言時**必須**」は今も正しい（要件は不変・違反時の挙動だけが変わった）

#### 手順 3 の指摘（直さず PR 本文へ）

- `tests/e2e/dsl-e2e-coverage.spec.ts:86-96` — `GLOBAL_UNCOVERED_BASELINE` から `linkAudio` が
  削除されたが、gated sources 内の `.linkAudio(` は
  `tests/e2e/orbitstudio-mcp-gated.spec.ts:4583` / `:4593` の **コメント 2 箇所だけ**である。
  同 PR で gated E2E 本体（`it(...)`）は #736 へ切り出されて存在しない。ラチェットの走査は
  ソース文字列 `/\.([a-zA-Z][a-zA-Z0-9]*)\s*\(/g` なのでコメントでも満たされる

### fix(studio): declare untrusted-workspace capability (#385 PR-S-T1) (Sep 4, 2026)

**Issue**: #385 / **ブランチ**: `385-untrusted-workspace-capability` / **PR-S-T1**

フォルダ無しの loose-file 起動（`orbs file.orbs`）は**未信頼の ad-hoc workspace** を作る。
`capabilities.untrustedWorkspaces` を宣言していない拡張はそこで activate されず、
利用者には「何も起きない」ようにしか見える。**実害は拒否ではなく沈黙**である。

owner 裁定（`docs/design/656-release-design.md` §16 (1)・2026-09-03）は **`supported: true`**
「一般的な DAW の挙動に併せて」。`"limited"` は撤回済みなので `startEngine()` に trust ガードは置かない。

#### 🔴 レビューで自分のテストが「何も証明していない」と分かった（2 段階）

**① ユニット側**: `restrictedConfigurations` を `?? []` でフォールバックしていたため、
**宣言が丸ごと消えても `for...of []` が 0 周して green** になっていた。
フォールバックを外し、取り出せない形なら**その場で落とす**ようにした。変異で実証:

| 変異 | 旧 | 新 |
|---|---|---|
| `restrictedConfigurations` を削除 | 2 件**素通り** | **3 件 red** |
| `audioDevice` を restricted に追加 | — | **2 件 red** |
| `supported: false` | — | **1 件 red** |

restore 後 6 件 green・`package.json` は `cmp` で復元一致。

**② E2E 側（本 PR では出さない・**#735** へ切り出し）**: 正本計画は PR-S-T1 に
**E2E-D1（実機）**を課している。書いて実機で回したところ **dev モードでは緑になったが、
`capabilities` ブロックを丸ごと削除しても緑のまま**だった。
🔴 **`--extensionDevelopmentPath` は workspace trust の制限を迂回する**ためで、
設計が `ORBIT_GATED_EXT_MODE=installed` を要求していた理由が実験で裏付けられた。

installed モード（vsix を焼いて `--install-extension`）に切り替えると、
**導入は成功するのに拡張が activate しない**（trust を無効にしても同じなので trust は原因ではない）。
ここは #385 の症状とは別の観測性の問題なので **#735** へ切り出した。6 実験の結果はそちらに残してある。

**副産物**: `orbs --install-extension` は**失敗しても exit 0 を返す**（壊れた vsix で
「Failed Installing Extensions」を出しながら 0）。exit code で判定してはいけない。

#### 🔴 地図だけでなく設計と実装プランにも反映した（owner 指摘）

> 地図だけでなく設計と実装プランにも反映してあるかな？？

最初は `DEVELOPMENT_MAP.md` §4.J しか直しておらず、**この PR 自身が #727 で直したばかりの型**
（規範を変えたのに写しが古い）を繰り返すところだった。3 文書を揃えた:

| 文書 | 直した内容 |
|---|---|
| `DEVELOPMENT_MAP.md` §4.J | #385（宣言・✅ 済）と **#735（実機検証・未着手）**の 2 行に分離。#735 は **#659 の後** |
| `656-release-design.md` §12 | **E2E-D1 の期待値を反転**（`running: true` / 音が出る / `not trusted` は 0 行）。**E2E-D2 は取り消し線 + 理由**（裁定 (1) で trust の有無が挙動を変えなくなり D1 と同判定になるため）。**§12.1 を新設**して 6 実験の結果と「成果物なしで成立する」の訂正を記録 |
| `IMPLEMENTATION_PLAN_2026-09.md` §1.9 | PR-S-T1 の件名から **`and refuse loudly` を削除**・`extension.ts` を触るファイルから除外（裁定 (1) で trust ガードが不要になり「断る」対象が無い）。実機 E2E を **PR-S-T3（#735）**として新規行に分離 |

**「issue を立てた」だけでは追跡されない。** 地図は所在、設計は判定条件、計画は工数と順序を持つので、
1 つでも古いままだと次の起案者がそこを読んで誤る。

#### reuse: マニフェスト読み取りを共有ヘルパーへ

`playhead.spec.ts:211` が既に同じ `package.json` を**別の書き方**（`new URL(…, import.meta.url)`）で
読んでいた。`tests/helpers/vscode-extension-manifest.ts` を新設し、**両方をそこへ寄せた**
（新設だけして重複を残すと 1 箇所が 3 箇所になる）。`playhead.spec.ts` 33 件は通ったまま。

#### 検証

`npm run typecheck:e2e` 0 / `tests/vscode-extension/` **430 passed** / lint 0。

---
### docs(planning): schedule the capture-window fix as PR-O2a (#739) (Sep 4, 2026)

**Issue**: #739 / owner 相談 2026-09-04「**忘れてしまうことだけは避けたい**」

PR-O2 の実機検証で見つけた**測定器そのものの欠陥**を、予定に組み込んだ。

#### 何が壊れていたか

`captureSegment` の既定は **settle 400 ms**（`run-score.ts:272`）。ところが
`LOOP()` の**小節量子化**（120 BPM 4/4 = 2000 ms）＋ **プラグインの attach 時間**で、
**音が出るのは約 3 秒後**。キャプチャの時系列 RMS を直接見て確定した:

```
0.00–3.00s  0.0000   ← 完全な無音
3.00s       0.1195   ← ここで初めて音が出る
3.75–5.00s  0.0886   ← 定常
```

🔴 **`global.gain(-6)` は楽器が一度も音を出す前に適用されていた。**
`unity` 窓は丸ごと無音・`half` 窓だけが実音 → **E2E-1 は「0 dB の音」を一度も測っていない**。
比が 1.36（下げたのに大きい）になり、**engine の欠陥に見えていた**。

#### 🔴 固定値で追いかける修正は反証済み

settle を 400 → 2600 ms にしたら unity が **0.0632 → 0** と**悪化**した。
区間が**キャプチャ末尾からの逆算**なので、実長が壁時計より短いと `fromSec` が負 → 0 クランプ →
**ファイル先頭（まだ鳴っていない区間）**を指す。**窓を後ろへ動かすと逆に前を測る。**

#### いつやるか — **PR-O2 の直前**（縦依存を伸ばす）

`PR-O1 → PR-O0 → **PR-O2a（#739）** → PR-O2`

| 理由 | |
|---|---|
| **循環しない** | 受け入れを「**窓に入るオンセット数**」にすれば、instrument が鳴っていなくても判定できる。「E2E-1 が緑」を受け入れにしない |
| **PR-O0 → PR-O2 と同じ規律** | 段 1 は「golden で固定してから engine を変える」。今回も**測定器を直してから測る** |
| **段 2 前でないと高くつく** | 影響は gated spec の **34 箇所**。段 2 の束は全部この窓で assert するので、計器が不確かなまま始めると全測定を疑い直すことになる |

#### 記録先

| 文書 | 内容 |
|---|---|
| **#739** | 実測データ・反証した修正・実装チェックリスト |
| `DEVELOPMENT_MAP.md` §4.A | 「測定器」の行を #649 の**上**に置いた（順序が読める形） |
| `IMPLEMENTATION_PLAN_2026-09.md` §1.1 | **PR-O2a** を PR-O2 の直前に挿入 |

---

### docs(site): follow PR #727's output-line spec revision into the user site and SC-2 (Sep 4, 2026)

**追従元**: PR [#727](https://github.com/signalcompose/orbitscore/pull/727)（`611-output-line-spec` → main・マージコミット `d8191d1`）/ **ブランチ**: `claude/docs-sync-pr727`

#727 は spec だけを動かした docs-only PR で、`sites/dev/signal-chain/` の 2 章（日英）は
同じ PR の中で追従済みだった。**追従が漏れていたのは「ユーザーが書く語」の側**である。

#### 直したもの

| 場所 | 追従した規範 |
|---|---|
| `sites/user/mixing/routing.md`（日英） | MX.3: `send()` の第 2 引数が **dB になる**（`0.3` → +0.3 dB のサイレント変更）/ MX.5 から「post-fader 固定」が**削除**され、タップ位置は「書いた位置」になった |
| `sites/user/reference/methods.md`（日英） | 同上 + MX.2.3: **数値レンダーバス `seq.output(n)` は撤回**された |
| `sites/dev/signal-chain/mixer-audio-line.md`（日英） | 「`seq.output()` の 3 分岐」節に MX.2.3（数値分岐の撤回）と MX.2.1（LinkAudio は解決順の**最後**）の注記 |
| `sites/dev/decisions/adr-002-dsl-v3-pivot.md`（日英） | core spec への行番号引用 2 件を再アンカー（`1933-1990` → `2112-2164`・`467-601` → `496-631`） |

🔴 **実装は 1 行も変わっていない**ので、user site の表と本文は**今日の書き方のまま**にして、
「仕様は変わったが未実装」という注記を足す形にした。表を到達点で書き換えると、
読者が今日書けないコードを読むことになる。

🔴 **`send` の単位変更はエラーにならず音だけが変わる**（線形 0.3 → +0.3 dB ≒ 素通し）。
user site の両言語に `danger` ブロックで明示した。

#### 再アンカーについての但し書き

adr-002 の 2 件は **#727 以前から既にずれていた**（§13 Versioning は #727 前も 1983 行目で、
引用は 1933-1990 だった）。#727 が core spec を +63 行伸ばしてずれが広がったので、
この機会に両方を現在の節境界へ合わせた。3 件目の `336-432`（§5 = 315-468）は
節の内側の抜粋なので触っていない。

#### 検証

`npm ci` / `npm run docs:build -w @orbitscore/user-site` / `npm run docs:build -w @orbitscore/dev-site` /
`npm run docs:check` の 4 本すべて green（citation 922 件検証・0 failed）。
### fix(engine): contain the two playback-path throws (#645 PR-D0) (Sep 4, 2026)

**Issue**: #645 / **ブランチ**: `645-contain-playback-throws` / **PR-D0**

`LOOP()` 経路の throw 2 箇所を封じ、スキップをログに出す。ライブ中に kick が止まる実害の修正。
実装は `sequence.ts` の `DispatchTarget = hardware | link | skip` の tagged union +
`resolveDispatchChannel()`（throw しない）+ `logSkipOnce`。ユニット **13 本**。

#### 🔴 「ログ行が一切出ない」は誤りだった（実機 4 サイクル分の記録を訂正）

前回までの記録は「`d645Skip` のログ行が**一行も出ない**」としていた。診断を出して実測したところ、
**出ていた**:

```
… このシーケンスは無音でスキップします。      ← ✅ skip は記録されている
🔄 d645Skip (loop queued, +1998ms to next quantize boundary)
⏹ d645Skip (loop stopped)                      ← 停止する
🎚️ d645Live: gain=-3 dB (seamless)             ← ✅ 兄弟は生きている
```

**PR-D0 が守るべき性質は 3 つとも満たされている**:

| 性質 | 実測 |
|---|---|
| skip が黙って消えない | ✅ 「無音でスキップします」がログに出る |
| throw しない | ✅ 同一ブロックの `d645Live` が自分の `(seamless)` を出している |
| 兄弟を巻き添えにしない | ✅ 同上 |

🔴 **「ログが出ない」と 4 サイクル書き続けたのは、診断を出さずに症状だけを見ていたから。**
[[escalation-does-not-fix-opacity]] のとおり、見えない時は観測手段を先に作る。

#### 落ちていたのは**テストの主張が実装の契約を超えていた**箇所（→ #736）

| # | 主張 | 実装の契約 |
|---|---|---|
| 1 | 停止中の `d645Skip` にも `(seamless)` が出る | `seamlessParameterUpdate()` は `isLooping() \|\| isPlaying()` **かつ** `scheduler.isRunning && loopStartTime !== undefined` の時だけ出す（`sequence.ts:278-281`）。**停止中は出ない** |
| 2 | dedup を **ERROR 総数**で数える | skip は **stderr → ERROR に分類される**（#625 で 4 回再発した系譜）ので**他の ERROR が混ざり、dedup の証明にならない**。数えるなら skip メッセージの出現回数 |

**実機 gated は #736 へ分離**（owner 裁定 2026-09-04）。外した理由を spec 内のコメントに残したので、
次に読む人が「E2E を書き忘れた」と誤読しない。

#### 3 文書に反映

| 文書 | 内容 |
|---|---|
| `DEVELOPMENT_MAP.md` §4.A | #645（実装・✅）と **#736（実機 E2E の主張・未解決）**の 2 行に分離 |
| `IMPLEMENTATION_PLAN_2026-09.md` §1.7 | PR-D0 の検証列を「ユニット 13 本」に。**PR-D1（#736）**を新規行に |

#### 検証

`npm test` **2205 passed** / `npm run typecheck:e2e` 0 / lint 0 /
`check-citations` 922 verified 0 failed。

---

### docs(spec): fix the implicit-master condition found by the independent re-audit (Sep 4, 2026)

**Issue**: #611 / **ブランチ**: `611-output-line-spec` / **PR-O1**（段 1 の縦依存 1 本目）

修正コミット後の最終状態だけを**独立に**再監査させた（前回の監査結果は渡していない）。
**Critical が 1 件出た** — 1 回目の監査が見ていなかったものである。

#### 🔴 Critical: send を書くと本流が master へ届かない条件になっていた

仕様の 2 箇所が、単独では正しいのに**組み合わせると壊れる**形になっていた:

| 場所 | 記述 |
|---|---|
| MX.2 | ラインに **`output` が 1 つも無い** sequence に暗黙の `output(master, thru:false, db:0)` を付ける |
| MX.3 | **`send` は `output(aux, thru: true, db:)` の糖衣**である |

`kick.send(verb, -12)` **だけ**を書いた行は、後者により「`output` が 1 つ存在する」ので
**暗黙 master が付かない**。`thru: true` の出口は分岐であって終端ではないから、
**dry がどこにも行き着かない** — センドを挿した瞬間に本流が消える。
MX.3 の実例そのものがこの 1 行だった。

正しい条件は「**`thru: false` の `output`（＝終端）が 1 つも無い**」。
設計 611 §2.6 の既定ストリップが
`[ラック → gain → pan → sends(=output thru) → output(master)]` と
**sends と終端を別々に並べている**のが意図の正本で、条件の側が書き間違っていた。
core spec MX.2 / 設計 611 §2.1 / 同 §3.4 の 3 箇所を揃えた。

🔴 **糖衣を定義したら、その糖衣が既存の条件式に何を代入するかを確かめる。**
「`send` は `output` の糖衣」と「`output` が無ければ master」は、
どちらも単独では正しく、**並べた時にだけ壊れる**。

#### 併せて直した 4 件（いずれも「規範を変えたのに写しが古い」型）

| # | 場所 | 内容 |
|---|---|---|
| 1 | `SIGNAL_CHAIN_DSL_SPEC_v1.md:30,144-145` | **同一ファイル内**のコード例が「宣言層・後勝ち」のまま。直下の規範 (2) は「信号層・2 要素として加算」に書き換え済みで、例と規範が逆を言っていた |
| 2 | `sites/dev/signal-chain/index.md`（日英） | 二層意味論の表が旧版のまま（gain / pan / 出力先を宣言層に置いていた）。`mixer-audio-line.md` は両言語で直したのに、**同じ章の index が漏れた**。🔴 `check-citations` はコードフェンス引用しか見ないので、**散文の陳腐化は機械では捕まらない** |
| 3 | `docs/design/610-diagnostics-applicability-design.md:455,463,611` | 「`output(<aux 名>)` は Error」と owner 裁定 ③（**aux も `output` で指せる**）が**正反対**。特に **E2E-D6 は期待値が仕様と逆**で、そのまま実装すると誤ったテストが資産に積まれるところだった |
| 4 | `docs/design/611-output-line-design.md:248,276` | §14 (1) で「数値 render bus は撤回」と裁定したのに、§3.3 手順 5 が「裁定まで現状の `_renderBus` 互換」のまま残っていた（自分の裁定に自分が追従していない） |

#### 独立再監査の価値（記録）

1 回目の監査後に修正を入れ、**その結果だけを見せて**別個体に監査させたところ、
1 回目が見ていなかった Critical が出た。**同じ差分を 2 回見るのではなく、
修正後の状態を新しい目で見る**ことに意味があった。

#### 検証

`check-citations.mjs` 922 verified / 0 failed（行番号のずれを `--fix` で再アンカー・4 件）。

---

### docs(spec): output as a line element — MX.1/2/2.1/2.2/2.3/3/4/5, SC.2.1/4, #649 §10-12 (Sep 4, 2026)

**Issue**: #611（+ #649 / #643 の設計文書追従）/ **ブランチ**: `611-output-line-spec` / **PR-O1**（段 1 の前提・docs のみ）

段 1（must-fix）の縦依存 `PR-O1（spec）→ PR-O0（golden）→ PR-O2（engine）` の 1 本目。
**仕様を先に確定させてから golden を取り、その後にエンジンの内部を変える**という順序を守るための PR。
コード・テストは 1 行も変更していない。

#### 改訂（`docs/design/611-output-line-design.md` §11 の表がスコープ）

| 文書 | 箇所 | 内容 |
|---|---|---|
| `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` | 節ヘッダ / MX.1 | 固定トポロジ（source → insert → sum → master ＋ send → aux の並列タップ）を撤回し、**ラインは 4 種の要素の列**（ラック / ゲイン / パン / 出口）と定義。「フェーダーという段は存在しない」を明記 |
| 同 | **MX.2**（全面改稿）| `output(destination, thru:, db:)`。`thru:` 既定 `false`・`db:` は dB・出口はラインの 1 要素であって終端ではない |
| 同 | **MX.2.1**（新）| 宛先の集合（master / sum / aux / 物理 ch 対 / render / LinkAudio）と**名前解決の順序**。`"master"` 予約語 |
| 同 | **MX.2.2**（新）| 複数 `output` と合算規則（解決後の宛先が同じなら加算・同一宛先 2 回は 2 要素） |
| 同 | **MX.2.3**（旧 MX.2.1 を置換）| 数値 render bus `output(n)` の**撤回**（裁定 611 §14 (1) = A）。宛先は `mix.render(...)` の宣言ノード。`mix.output(3)` は物理アウト mono 宛て |
| 同 | MX.3 | `send(name, db)`。**単位を線形 `amount` から dB へ**・`output(aux, thru: true, db:)` の糖衣であることを明記・「post-fader 固定」を削除 |
| 同 | MX.4 | 固定トポロジの記述を **forward-only + 配列順 = トポロジカル順**へ。kind による制限（sum→sum 等）を設けない |
| 同 | MX.5 | v1 制約から「send は post-fader 固定」を削除 |
| 同 | §8.1.2 | 🔴 `output("master")` は **LinkAudio channel 名にならない**（予約語が解決順の先頭）ことを追記 |
| `docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md` | SC.2.1 規範 (4)(7) | **出力エンドポイントと master もレシーバ**（`master.output(cue, thru: true)`）。`master` 予約が `output()` の文字列宛先にも及ぶ |
| 同 | SC.4 規範 (1) + staging 注記 | aux 名メソッドの値は **dB**。`send` は `thru: true` の出口の糖衣。「v1 は post-insert 固定」注記を #611 PR-O3/O4 の staging へ差し替え |
| `docs/design/649-audio-line-design.md` | §7.3 / §10 / §10.1 / §10.4 / §11 / §12 | **§10〜§12 は 611 設計へ移管**（バナー）。各項に「611 での扱い（正本）」を併記 |
| `docs/design/643-mixer-foundation-design.md` | §1.5 / §12 | 出口の欠落が #611 で埋まったことを追記。`output()` 3 分岐は解決順 1 本に統合された |

#### 🔴 設計文書の内部矛盾を 1 件解消（doc 611）

§1 と §2.6 が「`pan` は発音側のまま」と書いたままだったが、**§2.4b と §14 (4) の owner 裁定（Q-611-4 = B）で
`pan` はライン要素に覆っていた**。起案時の記述が裁定に追従していなかったもので、裁定側に揃えた
（ライン要素は 3 種ではなく **4 種**）。PR-O4 の実装者がここを読んで誤るのを防ぐため。

#### dev 学習サイトの追従（同 PR に畳んだ）

`sites/dev/signal-chain/mixer-audio-line.md` と `sites/dev/en/signal-chain/mixer-audio-line.md` が
**core spec の実例ブロックを逐語引用**していたため、`check-citations.mjs` が 4 件 red になった。

- 引用の再アンカー（`:1681-1685` → `:1729-1733` / `:1733-1735` → `:1793-1795`）
- **中身が変わった引用は手で直した**: `kick.send("rev", 0.3)` → `kick.send(verb, -12)`
- 散文の事実誤りを訂正: 「MX.5 は send は post-fader 固定を明記しています」は**もう spec に無い**。
  ⚠️ **実装は今も post-insert 固定**なので、「spec は変わったが実装は PR-O4 まで変わらない」ことを
  両ページに明示した（引用検査は散文を見ないので、ここは人が見るしかない）

**spec 側で宣言形の実例を復元**した（改稿で `global.sum("drum")` の例が落ちていた）。
素朴な 1 ファイル経路（ノード変数を作らない書き方）の保護は恒久方針なので、実例は仕様に要る。

#### user 学習サイトは変更しない

`sites/user/mixing/routing.md` の「send は post-fader 固定です」は**現在の実装の事実**であり、
挙動が変わるのは PR-O4。user docs は「今できること」を書く場所なので、そこで追従させる。

#### Fable 監査（独立第二意見）で Important 4 件・Medium 2 件を修正

監査は「① §11 改訂表の不在証明 ② owner 裁定との整合 ③ 実装との乖離の表示」の 3 問。
**指摘はすべて main が一次ソースで裏取りしてから直した**（エージェントの報告を鵜呑みにしない）。

| # | 指摘 | 裏取り | 対処 |
|---|---|---|---|
| 1 | 「sum ネスト不可」（MX.2.2 / MX.5）が MX.4「kind で制限しない」と真逆 | `engine_wrap.rs:5809-5813` に kind 検証が実在し、**コメントが MX.4 を出典として引用**していた | 規範（到達点）と v1 制約（今日）を**併記**。MX.4 に現在地注記を追加 |
| 2 | **SC.1 の二層意味論が MX.1 と正反対**（`gain` / `pan` / 出力先が宣言層・可換・後勝ち）。SC.4 (2) も「後勝ち」 | 差分を読んで確認。doc 611 §11 の改訂表に **SC.1 が入っていなかった**（列挙漏れ） | SC.1 の表と規範 (2) を書き換え、`gain` / `pan` / 出口を**信号層**へ。SC.4 (2) も追従 |
| 3 | 🔴 「`output("master")` は実装済み」という現在地注記が**誤り** | `sequence.ts:405-413` は sum にも render にも一致しない名前を **LinkAudio channel として記録**する。既存契約 `tests/core/sequence-output.spec.ts:167-179` を実行して確認（27 passed） | 予約語が実在するのは **wire（`SetBusRouting`）だけ**で、DSL 側で届くのは `.master` 糖衣のみ、と書き直した |
| 4 | MX.2.1 の「sum への出力先指定を**解除**して master へ戻す」は旧 `SetBusRouting` の部分適用の意味論で、MX.2.2「2 要素として両方加算」と矛盾 | `engine_wrap.rs:5766-5771` が部分適用（三状態）の出典 | 規範は「宛先 master へ解決」に統一し、「解除」は v1 の現在地へ隔離 |
| 5 | mono マージ係数 `(L + R) * 0.5` は **owner 裁定に無い**（裁定は「片側を捨てずマージ」まで） | doc 611 §14 (5) の原文を確認 | 規範表から係数を外し、設計文書（611 §5.3）へ委ねた |
| 6 | MX.2.3「撤回」に現在地注記が無く「今は数値形が拒否される」と誤読しうる | `sequence.ts:373-400` は `output(1)` を**受理して記録**する。`runtime.ts:245-250` は `mix.output(3)` を throw | 現在地注記を追加。追従していない 2 文書（PH 節の表・`MULTICHANNEL_RENDERING_DESIGN_598.md` §4.4）は **PR-R0** の担当として明記 |

Low の指摘（`gain` / `pan` 節が未追従・`_line` という TS の private 識別子が規範文に露出・
SC.0 の `.verb(0.3)` が dB 化後は「+0.3 dB ≒ 素通し」の例になる・SC.7 の「send の amount」・
`:1309` の「pre/post-fader tap」・doc 611 §0 裁定 4 の参照先誤記）も同時に処理した。

**レビュー方法**: 監査の推奨に従い `/code:pr-review-team` のフル編成は回さない
（差分にコードが無く、Sonnet チームの強み = 変異実走・実行接地が**実行対象を持たない**。
本 PR の失敗クラスは「spec と spec の不整合」「現在地注記の誤り」で、いずれも**差分に無いもの**を
読んで初めて見える）。plan §1.1 も PR-O1 の検証を「docs のみ（advisor レビュー）」と定めている。

#### 実機 gated baseline を実測（段 1 の受け入れ判定の起点）

**`npm run test:e2e:gated` → 10 failed / 10 passed (20)**・355.89s。

🔴 **WORK_LOG #713 の baseline（11 failed）から 1 件減っている** —
`auto-records and restores all five plugin receiver kinds across a restart without explicit saves`
が段 0 の束（#722）のマージで **failed → passed** になった。
したがって**本セッションの baseline は 10 failed** であり、#713 の値をそのまま使ってはいけない。

失敗 10 件（段 1 が減らす対象）: `drives real OrbitStudio end-to-end` /
**#643 E2E-1〜E2E-7**（7 件）/ `steps the live playhead through an instrument() sequence` /
`replaces a playing instrument across CLAP/VST3 (#618 E1-E6)`。

**この PR は docs のみなので、この 10 件を 1 件も動かさない**（動かすのは PR-O2 から）。

#### WORK_LOG のローテーション（本 PR の副産物）

本節を足したことで WORK_LOG が **2009 行**になり、`tests/docs/worklog-size.spec.ts`
（PROJECT_RULES §1a・上限 2000 行）が red になった。**閾値は上げずにアーカイブした**:
2026-09-01〜09-02 の 9 節（389 行）を `docs/archive/WORK_LOG_2026-09.md` へ移し、
本体末尾の索引と `docs/core/INDEX.md` の「Archived WORK_LOG」表の**両方**を更新した
（§1a の注記どおり、テストが突合するのは本体末尾の索引だけで INDEX.md は検査されない）。
番号付きの節（`6.423`〜`6.429`）は他文書からの参照を壊さないよう**番号のまま**移した。

#### 検証

| ゲート | 結果 |
|---|---|
| `npm test` | **2196 passed** / 48 skipped（main と同数・docs のみなので不変が期待値） |
| `npm run typecheck:e2e` | エラー 0 |
| `check-citations.mjs` | **922 verified / 0 failed**（監査対応で行番号が再び動いたので再アンカー） |

実機 E2E は**このPRの対象外**（コード変更が無く、DSL の観測可能な表面を 1 つも足していない）。
段 1 で実機の判定が変わるのは PR-O2 から。

---
### test(e2e): capture goldens for existing scores (#543-a) (Sep 4, 2026)

**Issue**: #543 (a) / **ブランチ**: `543-output-line-goldens` / **PR-O0**（段 1 の縦依存 2 本目）

PR-O2 が engine の内部幅と master gain の位置を変える**前**に、
`docs/design/611-output-line-design.md` §9 の「今日の音」を実機 capture で固定する。
production code は 1 行も変更していない。

実装は Codex（`gpt-5.6-sol` / effort high）に委譲し、**測定と検証は main が実機で**行った
（sandbox では daemon・MCP・実機 E2E が原理的に走らないため）。

#### 🔴 実機で 3 件の問題が出て、いずれも「主張をテストの実力に合わせる」方向で解決した

##### 1. ハーネスの起動判定が 500 行窓で壊れていた（helper の潜在不具合）

O0-3 / O0-4 が `daemon-backed REPL ready after 30000ms` で落ちた。engine は起動していた。
原因は `run-score.ts` が **`get_log` の固定 500 行窓の中でマーカー件数の増加**を見ていたこと。
窓が飽和すると新しい行を足しても**古いマーカーが同時に押し出される**ので件数が増えない。
**ERROR 件数を厳密等価で見ない規律と同じ理由**である。段 0 の helper に消費者が付いて初めて露見した。

修正: **`start_engine` 直前のログ末尾を錨**にし、その後ろに出た分だけを見る。

🔴 **一度「錨が流れたら判定できないとして待つ」形にしたのは誤りで `#628 R28` を壊した。**
錨は前の窓の**末尾**から取り、窓は**先頭から**落ちるので、末尾が消えているならそれより古い行は
すべて消えている — つまり今の窓は全部が新しい出力である。**実機に出さなければ気づかなかった。**
`helpers.spec.ts` にテスト 6 本。「錨を完全に無視する」変異で 2 本 red・restore 一致を確認した。

##### 2. fixture のバス名が既存テストと衝突していた

gated スイートは**同じ engine セッションを使い回す**ので、`global.sum("drum")` が既存テスト
（`:1955-1956` が `drum` を **sum と aux の両方**で宣言）と衝突して「ambiguous」になる。
**衝突したまま録ると、音が意図した宛先へ行かないのに golden が録れてしまう。**
`o0sum611` / `o0rev611` へ改名した。

##### 3. 🔴 最初の測定は「音量」ではなく「窓に入ったヒット数」を測っていた

**当初「設計 §9 の期待式が実機と合わなかった」と結論したが、誤りだった**（Fable 監査で判明）。
`LOOP()` は既定で**次の小節境界まで待つ**（`quantize-manager.ts:70`・120 BPM 4/4 で 2000 ms）のに、
録り始めが `run_selection` の **500 ms 後**だったので、**窓の大半が発音前の無音**だった。
入るヒット数が窓ごとに違い（dry 3 発 / total 5 発）、その差を engine の性質だと読み違えた。
検算: `kick.wav`（エネルギー 0.00757189）から、当初の 4 つの golden はすべて
`sqrt(整数ヒット数 × 0.00378595 / 窓長)` と**有効 7 桁で一致**する。`send(0.3)` は線形 0.3、
`Gain(db:6)` は理論と 9 桁一致で、**どちらの式も成立していた**。

🔴 **測定手法の欠陥を engine の性質だと結論した。** 「未検証のモデルを assert しない」という方針は
正しいが、適用を誤ると**検証済みの一次ソースを「未検証」と呼ぶ**ことになる。

**直した形**: settle を 1 小節 + 余裕（2600 ms）にして定常状態で録る / 窓長を**ヒット周期の
整数倍**（500 ms × 8）にして位相依存を消す / 🔴 **`onsets(name).length` を assert** して
ヒット数を固定する（これで初めて RMS が「1 ヒットあたりの音量」になる）。

##### 4. 🔴 同じ誤りを 2 度した — 窓長のゆらぎを「`seq.gain` の系統差」と読んだ

測り方を直した後、`Gain(db: 6)` は理論と**有効 9 桁で一致**したのに `combined/dry` だけが
**1.069**（理論 1.0 から 6.9%）で、**2 回の実行が 5 桁一致**した。これを
「`seq.gain(-6)` は実は −5.42 dB」と結論しかけたが、**3 回目を回して全行の比を並べたら撤回した**。

**同じ 1.069 = √(8/7) が `noBus` にも `sumOutput` にも `effectOnly/dry` にも出る。**
窓の実効長が 1 ヒット分（500 ms / 4000 ms = 1/8）ゆらぐ測定アーチファクトで、
セグメントごとに独立に乗る。**系統差とは区別できない。**

🔴 **再現性は系統差の証拠にならない** — 測定系の量子化も再現する。系統差だと言うには
「**同じアーチファクトが他の行に出ていないこと**」の確認が要る。期待値は理論式のままにし、
許容をアーチファクトの幅（12%）に合わせた。**実測値をベタ書きすると、アーチファクトを
engine の性質として固定してしまう。** follow-up（本 PR の範囲外）: 窓を 16 発へ伸ばすか、
`runScore` の区間→capture 時刻の写像から量子化を取る。

#### `/simplify`（4 観点のレビュー → 適用）

🔴 **reuse / altitude**: `startR28Engine`（gated spec）が**同じ壊れた件数比較をローカルに再実装**して
おり、**既存 20 本すべてがこの経路を使う**。判定を錨方式へ統一し `markerCount` を削除した。
**simplification**: 動的 `import()` → 静的 import・harness を縮小 / `relativeDelta` を 1 本化。
⏭️ **スキップ**: engine 再起動 3→1 の統合（テスト単位の独立を優先）。

🔴 **`startR28Engine` はレビューの推奨と逆の判断をした。** altitude は現状維持を支持したが、
その理由は「**最初の消費者が付く時に寄せる**」であり、**その消費者が本 PR で付いた**。
当時は両方とも壊れていたが、いまは**片方だけ直っている**。見送られたのは「約 60 行の統合」で、
ここで直したのは**判定ロジックだけ**（構造は動かしていない）。

#### 検証（すべて main が実機で）

`npm test` **2202 passed** / 52 skipped ・ `typecheck:e2e` 0 ・ `lint` 0 ・
`check-citations.mjs` **922 verified / 0 failed** ・ **実機 gated 24 件中 13 passed / 11 failed**
（**O0-1〜O0-4 は 4 本とも green**）。

失敗 11 件 = 🔴 **baseline 10 件**（`drives real OrbitStudio end-to-end` / `#643 E2E-1〜E2E-7` /
`steps the live playhead` / `#618 E1-E6`）**+ plugin-state restore 系 1 件**。restore 系は実行ごとに
**別のテストが落ちる**（5 回の実行で `auto-records…` と `restores a non-default sum-bus insert…`
が入れ替わった）。本 PR は restore を触っていないので既存の不安定さと考えるが、**裏取りはしていない**。
途中、起動判定の誤った修正で `#628 R28` を落としたが、訂正後は baseline どおり passed に戻っている。

### docs(spec): add RUN termination and offline render to the note-off firing cases (Sep 4, 2026)

**Issue**: #606（`must-fix`）/ **ブランチ**: `606-noteoff-firing-spec` / **PR-K-A0**（spec 先行）

`docs/design/634-pdc-layer-instrument-rack-design.md` §3 の実装（PR-K-A1 / A2）に入る前に、
**note-off の発火点**を仕様側で確定させる。コードは 1 行も変更していない。

#### 🔴 「flush が無い」は誤り — 配送機構は在る

地図 §4.B の記述は誤りで、`run-sequence.ts → sequence.ts → midi-scheduler.ts → plugin-note-output.ts`
の経路は**実在する**。壊れているのは**その周り**である（設計 §3.1 の穴 4 つ）。
したがって本 spec 改訂も「機構を足す」話ではなく、**発火点の列挙に 2 つ足す**話である。

#### 改訂

| 文書 | 箇所 | 追加 |
|---|---|---|
| `PITCH_DSL_SPEC_v1.1.md` | §7-2 realization rule 2（Active note tracking） | **一発 `RUN()` の終端** / **オフラインレンダの終端** |
| `INSTRUCTION_ORBITSCORE_DSL.md` | Note lifecycle の Active-note tracking | 同上（英語側） |
| 同 | **PH.4 All Notes Off** | 同じ発火点 2 つ + 🔴 **daemon 側の「最後の砦」** |

#### 🔴 発火点が増えても配送機構は 1 本

3 箇所すべてに同じ注記を置いた。**場面ごとに別の flush を作らない。**
設計 §3.2 の責務 3 層（TS scheduler = owner ごとの解放 / daemon = instance ごとの最後の砦 /
child = 触らない）を仕様の言葉に落とした形である。

**child に flush を置かない理由**も設計から引いた: child は自分が受けた note の簿記を持たず、
持たせると `(port_index, channel, key)` 参照カウント（PH.4）の**正本が割れる**。

#### daemon の「最後の砦」を仕様に書いた理由

engine が保留 note を解放し切る前に死ぬと、**daemon は active note を追跡しているのに読み手が
いない**（設計 §3.1 の穴 H4・読み手 0 箇所）。これは
「**鳴りっぱなしを検出できるのに止められない**」状態なので、仕様の側で義務として書いた。
実装は PR-K-A2（wire に新 RPC を足す = 一方通行）。

##### 🔴 粒度を書き足した（Fable 監査の指摘）

初稿は「daemon が自身の追跡集合から note-off を送れること」までしか書いておらず、**粒度が
無かった**。2 行上には「**1 シーケンスの停止に wildcard な解放を使わない**」という規範があるので、
**サミング（複数シーケンス → 1 インスタンス）が入った時点で両者が衝突して読める。**

書き足した内容: 最後の砦は **instance 単位（そのインスタンスの全 owner）**である。daemon は
owner の境界を持たないので、これは wildcard 禁止の**例外ではなく適用外** — 通常の owner 単位の
解放経路から呼んではならない。発火してよいのは **`global.stop()` / shutdown / engine 異常終了**の
3 場面だけで、いずれも「そのインスタンスで鳴ってよいものが 1 つも無い」場面である。だから
サミングが入っても**巻き込む相手が存在せず**、参照カウント判定が不要になる。

粒度を書かない仕様は、実装時に「便利な flush」として owner 単位の経路から呼ばれる。
**義務だけ書いて適用範囲を書かないと、規範どうしが後で衝突する。**

#### 検証

`npm test` 2199 passed / 49 skipped（docs のみなので不変）・
`check-citations.mjs` 922 verified / 0 failed（行番号のずれを再アンカー）。
### docs(planning): record the VST3 / CLAP conventions the scanner does not follow (Sep 4, 2026)

**地図**: `docs/planning/DEVELOPMENT_MAP.md` **§4.C** / **ブランチ**: `546-plugin-spec-conventions`
/ owner 2026-09-04・**バグではなく機能改善**

#### 🔴 最初、DAW の「振る舞い」を写して規格を読んでいなかった

owner:

> オービットスタジオで今 **dylib を名指ししているという状態自体が、ちょっと異常**。
> VST も CLAP も基本的には**作法があるはず**なので、その作法を地図のどこかに入れていく。
> 他のものが使えているので、**他を実装した後でも全然いい**。**バグではなくて機能改善・改修。**

> 僕が言ってるのが VST や CLAP の作法ではないというか、**作法をちゃんと調べてやりましょう**。

初稿はフォーラム・製品ドキュメントから **Ableton / Bitwig の振る舞い**を写しただけだった。
owner の指摘で規格を読み直したところ、**振る舞いの観察からは出てこない義務**が見つかった。

#### 規格が定める作法と現在地

| # | 規格（一次情報・**強度**） | 現在地 |
|---|---|---|
| 1 | **CLAP: `CLAP_PATH` を問い合わせる — `must`**（`clap/include/clap/entry.h` 逐語 "a CLAP host **must** query the environment for a CLAP_PATH variable"） | 🔴 `CLAP_PATH` は見ていない。ただし **`ORBIT_PLUGIN_PATH`（`:` 区切り）は既に読んでいる**（`lib.rs:200-211` `extra_scan_dirs_from_env`）ので、**同じ関数に 1 本並べるだけ** |
| 2 | **CLAP: 各ディレクトリを再帰的に探索 — `should`**（同上。1 と違い義務ではない） | 🔴 **非再帰**（`list_bundle_candidates` の doc・同 `:228`。テスト `:2197` が非再帰を固定） |
| 3 | **CLAP: 1 `.clap` に複数プラグイン。factory で descriptor 列挙 → plugin ID で生成** | ✅ **実装済み**（`orbit-clap-host/src/discovery.rs:105-120` 全列挙 / `lib.rs:540-566` 1 バンドル→複数エントリ / `discovery.rs:125-137` ID で選択）。同一性は `(format, path, pluginId)` の複合キー（`lib.rs:1028-1034`） |
| 4 | **VST3: `moduleinfo.json` は 3.7.5 で導入、3.7.8 で `Contents/` → `Contents/Resources/`**（cmake の `SMTG_MODULEINFO_PATH_INSIDE_BUNDLE` で版差を確認） | ○ 参照している（`lib.rs:110`）。⚠️ **`Contents/Resources/` しか見ない**（`lib.rs:842`）ので **3.7.5〜3.7.7 のバンドルは ProbePending 送り** |
| 5 | **同一性は ID（CLAP=plugin ID / VST3=CID）、path は「所在」。ID → ファイルの対応表は規格に無く、所在の解決はホストの責務** | 🔴 `instrument(path)` が生パス（`plugin-resolver.ts:76-80`） |
| 6 | 検証を走らせるタイミング | 🔴 手動のみ（起動時はカタログ JSON を読むだけ・`plugin-catalog-reader.ts:132-150`） |

**1 は既存関数への 1 行追加。2 も小さい。5 は作り直しの規模**なので他の実装の後（owner）。

🔴 **初稿は 3 を「❓ 未確認」、5 を「規格はパスを同一性にしない」と書いていた。**
前者は**実装を読めば分かることを読まずに未確認と書いた**（[[invent-rules-only-after-reading-the-code]] の再発）。
後者は**言い過ぎ** — 規格は path を禁じているのではなく、同一性の担い手が ID だというだけである。
「作法を調べる」は規格側だけでなく**自分の現在地も一次情報で確かめる**ことを含む。

#### 保証のタイミングについての整理

owner: 「Logic や Studio One も**読み込めるということを確認するだけ**で、起動時に全てのプラグインが
メモリに読み込まれているわけではない。**インサートした時だけメモリ空間に出てくる。**
なので起動時のチェックは**品質保証的なもの**」。

調査でも一致した — Ableton は VST3 を常時スキャンにし、**AU は Apple の `auval` に外注**している。
Bitwig は**保証しきれないことを認めて隔離で解く**（ホスティングモード 5 段階）。
**OrbitScore は既に Bitwig 型の out-of-process + crash isolation を採っている。**

🔴 **これは [[live-coding-forbids-workflow-interruptions]] と対になる。** 保証を起動時に寄せるからこそ、
**演奏時に確認を挟む必要が無い**。「評価時に trust を問う」設計は DAW と**二重に**違っていた
（① 確認を挟む ② 判断を実行時に置く）。
### fix(engine): contain the two playback-path throws and log the skip (Sep 4, 2026)

**Issue**: #645（must-fix）/ **設計正本**: `docs/design/610-diagnostics-applicability-design.md` §5 / **PR**: PR-D0（Sonnet フォールバック実装・Codex が sandbox 制約で2回起動失敗）

owner 指示（2026-08-29）: 「ライブコーディングなのでエラー出して止まるのは基本よくない。内部的にちゃんと掴んでログに出すとかして実行に影響を出さない、とかにすれば別に普通に E2E テストでカバーできますよね」。

#### 対象の 2 throw と到達経路（5 経路・すべて main で行番号を取り直し済み）

| # | 場所 | 経路 | 直したか |
|---|---|---|---|
| 1 | `sequence.ts` `resolveDispatchChannel()` | `run()` `:1744` / `loop()` `:1791`（eager・await 連鎖） | ✅ throw→`DispatchTarget`（`skip`）+ `logSkipOnce()` |
| 2 | 同上 | 🔴 `seamlessParameterUpdate` `:273` → `scheduleEventsFromTime` `:1584`。`gain`/`pan`/`audio`/`chop`/`tempo`/`beat`/`length`/`play` から同期で入る（issue 本文が書いていない経路・再現条件として最有力） | ✅ 同上 |
| 3 | 同上 | `unmute()` `:1865` → 同上 | ✅ 同上（呼び出し元のみで解決） |
| 4 | `loop-sequence.ts` `safeSchedule`（`:113-129`） | 既に catch 済み。文言のみ `[ERROR] Sequence '<name>': loop scheduling error:` へ揃える | ✅ 文言合わせのみ |
| 5 | `loop-sequence.ts:104` / `run-sequence.ts` 初回 schedule | 1 と同じ経路で解決済み | ✅ 追加対応不要 |
| 6 | `event-scheduler.ts` `resolveAudioFilePath()`（定義 `:16` 改・呼び出し元 `:106`/`:193`） | パス非絶対（内部エラー自称） | ✅ throw→`undefined` を返しログ、呼び出し元が `return` |

#### 直し方（設計 §5.3 が確定）

- `resolveDispatchChannel(): DispatchTarget`（`{kind:'hardware'} | {kind:'link',channel} | {kind:'skip',reason}`）を新設。**`undefined` は使わない** — 旧 `undefined`（hardware 経路）とエラー時の `undefined` が同じ値になると黙ってハードウェアから音が出る（#645 が名指しした「別種の驚き」）
- `scheduleEvents`/`scheduleEventsFromTime`（sequence.ts 側の private ラッパー）は `kind === 'skip'` で **スケジュールせず return**（そのシーケンスだけ無音、他は継続）
- `run()`/`loop()` の eager 呼び出しは throw ではなく `logSkipOnce()` を呼ぶだけに変更（早期検知は残す）
- `logSkipOnce()`: `_dispatchSkipLoggedFor` で理由文字列をキーに重複抑止。**理由が変わった時**と **`.output()` が新しいチャンネルを設定した時**にリセット。ループは毎小節この経路を通るので、抑止が無いと `get_log` の 500 行窓を 1 シーケンスが埋め尽くす
- `event-scheduler.ts`: `resolveAudioFilePath(audioFilePath, sequenceName): string | undefined` へ変更。呼び出し元 2 箇所で `if (!resolvedFilePath) return`

#### テスト

- ユニット 13 本追加（`tests/core/sequence-link-audio-integration.spec.ts`）: run()/loop() が reject でなく resolve すること・`DispatchTarget` の3 kind・`logSkipOnce` のインスタンス単位 dedup（同一理由の連続呼び出しは1回だけログ）・`.output()` 呼び出しでの dedup キー reset（white-box。公開 API では2回目の skip を再現できないため）
- 既存ユニット 3 ファイル改修（throw 前提のテストを `DispatchTarget` 前提へ書き換え）
- gated E2E 1 本追加（`tests/e2e/orbitstudio-mcp-gated.spec.ts` 末尾）: `global.linkAudio()` 下で `.output()` 無しの LOOP が無音スキップ + ログされ、**別の（`.output()` 済みの）sequence の LOOP を止めない**ことを capture RMS で確認。続けて path 2（`.gain()` mid-loop）が同じ evaluation block を落とさないことを、**別の** `evaluate_orbitscore` 呼び出しでの gain 変化（RMS 差分）で確認。ERROR 件数はループ4秒超（2小節超）でも高々 +4 に収まることを assert（dedup の回帰証跡）
- `tests/e2e/dsl-e2e-coverage.spec.ts`: 新 E2E が `global.linkAudio()` を実機で評価するため `GLOBAL_UNCOVERED_BASELINE` から `linkAudio` を除去（ラチェットは減る方向のみ許可）

#### 検証（sandbox 内・実機 E2E は main が別途実施）

`npm test`（2199 passed / 49 skipped）・`npm run typecheck:e2e`・`npm run lint`・`npm run build`・`sites/dev` の `check-citations.mjs --fix`（`sequence.ts`/`event-scheduler.ts`/`loop-sequence.ts`/`dsl-e2e-coverage.spec.ts` の行番号シフトで 26 件の引用が機械的にずれたため再アンカーのみ実施・本文の書き換えなし）はすべて green。

#### 追記（実機 gated E2E が落ちた・main 実測 2026-09-04・修正済み）

main の実機実行で E2E-645 が `timed out waiting for #645 dispatch-skip log line` で failed
（他 10 件は baseline と同一の pre-existing 失敗で無関係）。**実装本体は問題なし**、テスト
ハーネスの前提検証不足が原因:

- `run_selection`（`evaluate_orbitscore` と違い）は評価完了を待たず、`isError` は
  「アクティブなエディタが無い」等の**機械的失敗**しか捉えない — 提出コードの実行時 throw
  （`global.linkAudio()` の v1 相互排他 throw 等・`global.ts:411-422`）は `get_log` にしか
  出ない。既存の `expect(run.isError).toBe(false)` はこの throw を素通りさせていた
- 修正: `global.linkAudio()` を単独の `run_selection` に分離し、直後に `get_log` で throw
  文言の有無を明示チェック（見つかれば「①linkAudio 自体が失敗」と名指しして即座に fail）。
  最終の skip ログ待ち `waitUntil` も try/catch で包み、タイムアウト時に「①は否定済みなので
  ②skip が起きなかった/③ログが窓外に流れた」の切り分けと `get_log` 末尾をエラーに含める
- `tests/e2e/helpers/run-score.ts` の `startEngineForRun`/`waitForEngineState`（`runScore()`
  が内部で使っていた既存の堅牢な起動処理）を export し、engine の (再) 起動をそちらへ委譲
  （`capture_wav` 要求時は必ず stop_engine→wait-false→start_engine、daemon ready timeout の
  retry-once、`🎵 Live coding mode` マーカー確認まで待つ — 単なる `get_engine_state.running`
  より確実）

検証（再実施）: `npm test`（2199 passed / 49 skipped・変化なし）・`typecheck:e2e`・`lint`・
`build`・`check-citations.mjs`（import 追加による行番号シフトで 46 件が再びずれたため
`--fix` で再アンカー）すべて green。実機 gated E2E は未実施（main が別途実施）。

#### 追記2（capture RMS の前提が崩れていた・main 実測 2026-09-04 の2回目・修正済み）

上の修正で前提診断は効き、skip はログに出ることが確認された。しかし別の assert
（`d645Live` の capture RMS）が `expected 0 to be greater than 0.01` で failed。main の一次
情報調査: `rust/crates/orbit-audio-daemon/Cargo.toml` の `link-audio` feature は default off・
gated ビルド（`pretest:e2e:gated`）も `--features outproc-effect,outproc-instrument` で
link-audio を含まない。「LinkAudio でも hardware にフォールバックして鳴る」という前提は
`rust-engine-player.ts` の**コメント**に書いてあっただけで、実機ログに
`LINK_AUDIO_UNAVAILABLE`/gap warning が1件も出ておらず、**裏取りできていなかった**。

- 修正: capture RMS への依存を全廃。証明手段を TS engine 側の `console.log` マーカーへ
  切替 — `🔄 <name> (loop started/queued)`（`loopSequence()`、dispatch 結果によらず無条件で
  発火）と `🎚️ <name>: gain=<x> dB (seamless)`（`seamlessParameterUpdate()`、
  `scheduleEventsFromTime` の private wrapper が skip で早期 return しても、呼び出し元自身の
  ログ行は必ず届く）。いずれも daemon RPC より手前の TS 側イベントなので、LinkAudio が
  daemon にコンパイルされているかに依存しない
- `LOOP(d645Skip)` + `LOOP(d645Live)`（経路1）・`d645Skip.gain(-6)` + `d645Live.gain(-3)`
  （経路2）を**それぞれ1つの `run_selection`（= 1評価ブロック）**にまとめ、後続の sibling
  マーカーが実際に出ることを確認 — pre-#645 なら先頭の throw が同ブロック内の後続文の実行を
  止めていたはず、というこの PR の主張そのものを検証する構造にした
- 別の `evaluate_orbitscore` 呼び出し（`d645Live.gain(-1)`、ブロックをまたぐ後続評価が汚染
  されないことの確認）は `pan` ではなく `gain` を再利用 —
  `dsl-e2e-coverage.spec.ts` の `SEQUENCE_UNCOVERED_BASELINE` に `pan` が残っており、新規に
  `.pan(` を書くとラチェットの「baseline は減らす方向のみ」に抵触するため
- テスト名から誤解を招く要素は無いため維持（「sibling を止めない」という主張は log マーカーで
  引き続き証明できている）。実行時間もこの変更で短縮（audio 用の settle sleep 群を削除）

検証（再実施）: `npm test`（2199 passed / 49 skipped・変化なし）・`typecheck:e2e`・`lint`・
`build`・`check-citations.mjs`（今回は行番号シフト無し・0 failed）すべて green。実機 gated
E2E は未実施（main が別途実施）。

---

### docs(design): 詳細設計 11 本と実装プラン 2026-09 を起草 (Sep 3, 2026)

**Issue**: #611 / #694 / #598 / #672 / #634 / #428 / #610 / #662 / #656 / #668 / #679（設計のみ・実装なし）/ **ブランチ**: `claude/elegant-pasteur-l9gdrl`

owner 指示（2026-09-03）: 「① 詳細設計（`docs/design/`）と ② 実装プラン（PR 戦略）を作る。実装はしない。決まっていないところ以外は、そのまま作れる粒度で。曖昧さは owner 裁定待ちに隔離する」。

#### 成果物

| 文書 | 束 |
|---|---|
| `docs/design/611-output-line-design.md` | 出口の一般化（#611/#649/#543-a/#409/#647）— `output(dest, thru, db)`・`AudioLine`・`SetBusLine`・`LineProgram`・master ライン・engine 2ch 固定 |
| `docs/design/694-session-log-editor-path-design.md` | #694（設定 → env・`//#sourceFile`・`<DIR>/`・純度・v2）/ #695（`//#evalBegin/End` フレーム・複数 GLOBAL）/ #241（in-process replay・transport 駆動） |
| `docs/design/598-render-endpoint-design.md` | `mix.render(<path>)`・`%n`・合算 = 解決後パス・`RenderInstance`（実時間 stem）・`RenderScore` v2・評価列 × 仮想クロック driver・P3 差分 |
| `docs/design/672-plugin-boundaries-design.md` | 境界 5 本（3rd-party / 標準 / タップ / 標準シンセ / DSL）と残りのコア・`DslModule` / `HostContext`・2 spec の目次 |
| `docs/design/634-pdc-layer-instrument-rack-design.md` `428-timed-event-queue-design.md` `610-diagnostics-applicability-design.md` `662-performance-and-visibility-design.md` `656-release-design.md` `668-e2e-foundation-design.md` | subagent 起草 → main 検収（裁定の出どころ・path:line・裁定待ちの隔離を確認） |
| `docs/design/679-input-consistency-check.md` | 入力は着手しない裁定。今回の設計に矛盾が無いことを 12 観点で確認 |
| `docs/planning/IMPLEMENTATION_PLAN_2026-09.md` | 一方通行の判断 17 件 → PR 一覧（接頭辞 O/L/R/P/K/Q/D/V/S/E）→ 順序の根拠 → 段 0〜8 |

#### 設計上の主な判断（裁定の範囲内）

- フェーダー = 出口のレベル（裁定 ④）は「乗算 = 出口の op」なので位置ずれのクラスが消える。#649 の原因説明は撤回済み（コメント 1）なので E2E-1 は red-first
- render も log も「譜面からの相対」。`.orbslog` は今日 0 本なので `logVersion: 2` を今出す
- フレーム（`//#evalBegin/End`）は #649 §10.3 と #695 の**同一機構**（PR-L2 の 1 本）
- offline driver は最初から**評価列**を入力にする（`.orbs` = 1 eval・`.orbslog` = transport 順）。前提は Clock DI（core 17 箇所・挙動不変）
- コアは「境界の残り」として**列挙**で確定（#671 コメント 1 の 9:31 と整合）

#### 裁定待ち（設計に混ぜていない）

各文書の末尾節に隔離。地図 §9 の未決 9 件は埋めていない。新規に出た主なもの: `<DIR>/` の名前 / CLI のログ既定 / 数値 `output(n)` の退役 / プレースホルダ語彙 / 実時間 stem の issue の置き場 / A4 実行形態 / transport 書きの競合 / #674 表面 / midi の `output` 拒否。

#### 検証

docs のみ（コード変更なし）。`npm test` は未実行（変更対象外）。issue へは**コメントのみ**（本文・ラベル・close は触っていない）。

#### 追記（同日）: owner 裁定の反映

裁定シート（artifact）で owner が 66 問中 50 問に回答。推奨から変わったもの: 同一宛先の `output` は 2 要素として加算 / `pan` をライン要素に / mono 宛先は L+R マージ / `--until` は高速畳み込みを最初から設計 / `--verify` はイベント sidecar + assets hash / OSC はメッセージ値を `play()` に / `seq.root()` は note-name も受ける / `[...]@v` per-voice 分配 / `chop(n>1)` の tie は伸ばす / child の QoS を TIME_CONSTRAINT へ / node を同梱 / 標準プラグインの実装は WASM スパイク後。各設計文書の裁定待ち節と `IMPLEMENTATION_PLAN_2026-09.md`（W-18〜22・§4）へ反映。相談中 6 件はチャットで提示。

### 追記: Q-694-7 — 今日の `.orbslog` はリプレイに使えるか（実装を実走・同日）

owner: 「ログが出ていた時に再現に使える形になっている様に中身が見えなかった。実装を調べて
ちゃんとリプレイできるのか？それがないとオフラインレンダリングができないのでしっかり見て」

mock backend の `InterpreterV2` に、拡張が stdin へ書く形（`extension.ts:3013-3022` の注入込み）を
`createReplSession().pushLine` で流し、`Date.now` を差し替えてログを生成した（doc 694 §2b）。

**結論: そのままでは再現に使えない。** 欠落 11 件を `path:line` と生成ログの根拠つきで一覧化
（doc 694 §2b.3 G1〜G11）。owner の記憶「中身が見えなかった」は G1（注入で `code` が汚れる）・
G2（`untitled` が cwd に落ちる）・G3（1 行 = 1 eval で選択の形が残らない）の実体。**それに加えて**:

| 発見 | 実測 | 手当 |
|---|---|---|
| **`transport` が音楽時間ではない**（G6） | tempo 120→60 の 10 ms 後の stamp が `1:3.000` → **`1:2.010` に逆行**。LOOP の quantize も同式で「+2990 ms」待った | `TransportTimeline`（PR-L8）。quantize を乗せるかは 🔴 doc 694 §13 (8) |
| **プラグイン状態がログの外**（G7） | `stop()` の auto-snapshot と `//#savePluginState` が同じ相対パスへ上書き（版なし）。replay は後のセッションで上書きされた状態を読む | start/stop で `orbslog/<log>.states/` へ写す（PR-L9・🔴 §13 (9)）。**#598 P3（PR-R8）の前提** |
| 評価の結果・import 本文・MCP 由来の印が無い（G4/G5/G8） | REPL は `//#evalMark` で `ok` を計算済みなのに捨てている | `result` / `import` レコード + フレーム属性（PR-L7）|

plan: PR-L7/L8/L9 追加・PR-L4 は L7/L8 の後・PR-R5 は L8 の後・PR-R8 は L9 の後（W-23/24/25）。

同日の他の反映: Q-598-2 サラウンド → **B-lite**（N ch の render 器 + `output(at:, mono:)`・
エンコードは Logic。doc 598 §3.6・PR-R9）/ Q-610-5 確定（赤線 + その文だけスキップ）/
Q-656-1 `untrustedWorkspaces.supported: true`（DAW に合わせる）/ Q-656-2 #138 独立のまま。

**同日夕・残り 3 問が確定（すべて A・推奨どおり）**: Q-694-3 `--until` 境界ちょうどは適用済み /
Q-694-8 LOOP quantize も `TransportTimeline` に乗せる（tempo 変更後の境界の飛びを修正として記録）/
Q-694-9 プラグイン状態は start/stop で `orbslog/<log>.states/` へ写す。これで裁定シート 66 問は
すべて回答済み。doc 694 §0 に裁定 9〜11 を追加・plan §4 は「裁定待ち 0 件」。

**同日・ユーザー視点の到達点**（owner「各 PR が完了すると何が出来るのかユーザー視点で纏めて」）:
`docs/planning/USER_OUTCOMES_2026-09.md` を追加。plan §1 の 98 PR すべてに「完了するとできること」を
1 行ずつ、見え方（🎵 音・操作 30 / 👀 見える 25 / 🧱 土台 31 / 📄 仕様 12）と段を添えて記載。
「何も変わらない」PR はそのまま書く（土台の PR が続く週はそれが正しい状態）。

**同日・束ブランチ運用の採用**（owner「PR-O のような纏まりで stacked PR を積んで、纏まりが終わってから
レビューチームを走らせるのはどうか」→ 相談の結果、統合ブランチ方式で合意）:
`docs/development/BUNDLE_BRANCH_WORKFLOW.md` を追加。束ごとに統合ブランチを置き、小 PR は
CI + その PR の E2E 実機 + 目視の軽いゲートで入れ、統合ブランチ → main の束 PR で
`/simplify` → レビューチーム + Fable → 実機全件を 1 回だけ回す。束は 1,500 行以下で継ぎ目で切る
（OrbitScore は 7 束・フルレビュー 27 回 → 7 回）。純 stacked PR を採らない理由は squash との相性
（下の層が main に入るたび上の層の rebase が要る）。GitHub の stacked pull requests
（2026-07-30 公開プレビュー）は「層ごとにレビューを増やす」道具で目的が逆、プレビュー中は併用しない。
参照 17 件は URL の実在を確認（docs.github.com 等はプロキシで本文取得不可のため検索要約で確認）。
→ owner 了承（同日）で **#703** として別 PR に。bot の `if` は `claude-code-review.yml` **だけ**
（`code-review.yml` はジョブ名が `code-review` だがテスト CI 本体なので触らない）。plan §2.5 に束の割り当て表を追加。

---

### chore(meta): critical path の 27 issue に実装チェックリストを入れた (Sep 3, 2026)

**Issue**: #697 / **記法**: `docs/core/PROJECT_RULES.md` §1d

owner: 「地図でリンクしてる ISSUE に**実装内容のチェックリスト**を作って、実装時に**ちゃんと終わってるか**、
**終わってなければ理由は何か（変更になった、いらなくなったなど）をトラッキング**できるように」

#### 🔴 要点は「終わらなかった理由が残ること」

チェックが消える／黙って削られると**なぜやらなかったのかが次の人に分からない**。
本日それで実害が出た — **#506 の看板は SC.10.9 で撤回済み**だったのに、撤回が spec 側にしかなく
issue 本文が古いままで、main が **#680 を重複起票**した。

#### 記法（§1d）

```markdown
- [ ] 未着手
- [x] 完了 — PR #NNN / commit `abc1234`
- [x] ~~やらなくなった~~ — 🔴 **不要**: 理由（出どころ: MAP §4.X / #NNN / owner YYYY-MM-DD）
- [x] ~~形が変わった~~ — 🔴 **変更**: 何にどう変わったか（同上）
```

**項目を削除しない** / **完了には PR か commit** / **`[x]` は「解決済み」**（完了も「やらない」も。
**未解決だけが `[ ]`** なので**残数がそのまま残作業**）/ **理由には出どころ** /
🔴 **未決事項をチェックリスト化しない**（決めていないものを「やること」にしない）。

#### 対象 — 27 件（critical path のみ）

#543 #649 #645 #606 #634 #635 #636 #669 #659 #656 #661 #660 #662 #667 #663 #672 #671 #680
#428 #610 #644 #668 #694 #695 #679 #385 #611

**地図が参照する OPEN issue は 117 件**あるが、全件に入れると**更新されないチェックリストが 117 個**できる。

項目は**地図と issue 本文から導いた**。受け入れ基準は可能な限り**実測値**にした
（例: #649 は「`global.gain(-6)` で instrument の RMS が 0.08864 → 0.044」= #649 本文の実測）。

### docs(index): アーカイブ後の INDEX を追従させ、地図を目次に登録 (Sep 3, 2026)

**追従元**: PR #693（マージコミット `b9fad48`）/ **ブランチ**: `claude/docs-sync-pr693`

PR #693 は 9 本を `docs/archive/` へ移し、**現役ファイルからの参照リンクは全部直した**
（`INDEX.md` のリンク先も `../archive/...` に書き換わっている）。追従できていなかったのは
**目次の構造とラベル**の方で、2 点あった。

#### ① 移動した 8 本が「現役」の見出しの下に残っていた

`docs/core/INDEX.md:75-88`（追従前）は、見出し「設計ノート (`docs/design/`)」/
「Planning (`docs/planning/`)」の表に、リンク先だけ `../archive/` へ変わった行が
**現役の行と混在**していた。読者は見出しを信じて表を読むので、**アーカイブ済み文書を
現在の設計として読める**状態が残っていた — #696 が消そうとした「紛らわしいから」
そのものである。

現役（`643` / `649`）と分け、**アーカイブ済みの表を別に立てて「現在の正本」列**を持たせた。
列の値は移動時に各文書へ付けたバナー（例: `docs/archive/design/628-effect-chain-model.md:2`
「**現在の正本**: `SIGNAL_CHAIN_DSL_SPEC_v1.md` **SC.10**」）から採っており、新しい判断はしていない。

#### ② 🔴 `DEVELOPMENT_MAP.md` が目次に無かった

PR #693 が追加した本体（1388 行・**開発計画の正本**）が `INDEX.md` に**1 行も無く**、
Planning 節は**移動済みの 2 本だけ**を挙げていた。`grep` で確認した地図への参照は
リポジトリ全体で `PROJECT_RULES.md:34` の 1 箇所のみ。

地図 §0.2 は「**番号の検索ではなく、地図の見出しで探す**」を運用規則にしているが、
**その地図に目次から辿り着けない**。CLAUDE.md がセッション開始時の必読に挙げるのは
`INDEX.md` なので、ここに無いと運用規則が起動しない。地図と
`2026-09-03-issue-triage.md`（#696 が「現役」と明記）を Planning 節へ登録し、
§0.2 の起票規則を引用で添えた。

#### ③ 棚卸し記録が、同じ PR で覆されたラベル状態を載せたままだった

`docs/planning/2026-09-03-issue-triage.md:115` は「`foundation` と `release-gate` の **2 枚のみ**」と
書き、C5 の表（同 `:96`）は **#197 に `release-gate`** を付けている。PR #693 はこの両方を覆した —
**`must-fix` を新設して 3 枚**にし、**#197 のラベルは外した**（WORK_LOG 上の記述: 「🔴 3 件目は
main の誤り — #197 に `release-gate` を付けたとき #656 と突き合わせていなかった。ラベルを外した」）。

この文書は #696 が「**地図の入力として現役**」と明記して残したものなので、放置すると
現役の文書が古いラベル状態を主張し続ける。**表の行は棚卸し時点の記録として保存**し、
§5 に**追記**として 2 点の変更と「ラベルの現在の状態は地図を見る」を書いた
（`docs/design/` の設計書と同じく、記録の書き換えはしない）。

#### 追従不要と判断した層

- **DSL/言語仕様・ランタイム/MCP・OrbitStudio**: PR #693 の差分 22 ファイルは
  `docs/` と `sites/dev/` のみ。`packages/` の実装は 1 行も無い。唯一の `rust/` の変更は
  `spike_s_concurrent_load.rs:15` の**行コメント内のパス文字列**で、コードではない
- **`sites/dev/`**: 参照パス 6 箇所が ja / en 対で既に直っている（`sites/dev/signal-chain/index.md:27`
  と `sites/dev/en/signal-chain/index.md:28` など）。地図の裁定（出口の一般化・`send` の dB 化）は
  **未実装の決定**であり、dev サイトは実装の解説なので、書くと「実装されていない挙動」の記述になる
- **`sites/user/` / `docs/user/`**: ユーザーが書く語は 1 つも増減していない

---

### chore(docs): 正本が別にできた設計・計画文書を 9 本アーカイブ (Sep 3, 2026)

**Issue**: #696 / **MAP §0.3**

owner: 「仕様検討したドキュメントは、イシューになって地図に書かれたものは**アーカイブ**しておこうか。**紛らわしいから**。」

#### なぜ

同じ主題の文書が複数あると誤読が起きる。**実例**: 本日 main が **#506（plugin-as-method）を読まずに
#680 を重複起票**した。#506 の看板（メソッド形）は **SC.10.9 で撤回済み**だったが、
撤回が spec 側にしかなく issue 本文が古いままだった。

#### 基準 —「正本が別にできたもの」

| 移した文書 | 現在の正本 |
|---|---|
| `628-effect-chain-model.md` | **spec SC.10**（文書自身が「確定・SC.10 として制定済み」と明記） |
| `628-plan-reset` / `628-rack-chain-implementation-design` / `628-gated-e2e-rack-design` / `628-ui-pump-per-index-design` | **#628 / #633 CLOSED**（PR #639 / #652 で出荷済み） |
| `625-effect-replacement-design.md` | **#625 CLOSED**（PR #627） |
| `ROADMAP_2026.md` / `IMPROVEMENT_RECOMMENDATIONS.md` | **`DEVELOPMENT_MAP.md`**（地図 §0.3 が「歴史的スナップショット」と明記） |
| `2026-09-02-feature-map-comments.md` | **地図 §4 各節 + #679 / #680 / #681** |

**残したもの**（issue が OPEN・**正本がまだ他に無い**）: `643-mixer-foundation-design.md`（PR-3 = #645 が残る）/
`649-audio-line-design.md`（設計のみ・実装なし）/ `662-engine-visibility-and-limits.md`（未着手）/
`2026-09-03-issue-triage.md`（地図の入力として現役）。

#### 🔴 参照を全部直した — ここが本体

**移動して参照が切れると、探せなくなって同じ重複が起きる。**

現役ファイル 12 本の参照を書き換え（`INDEX.md` / `INSTRUCTION_ORBITSCORE_DSL.md` / `WORK_LOG.md` /
`DEVELOPMENT_MAP.md` / `SIGNAL_CHAIN_DSL_SPEC_v1.md` / `spike_s_concurrent_load.rs` /
dev サイト 6 本）+ **アーカイブ同士の相互参照 5 本**。

各文書の冒頭に「**アーカイブ。現在の正本は〜。新しい判断の根拠にしないこと**」を付けた。

#### 検証

- **現役ファイルから移動前のパスを指す参照: 0 件**（`grep`）
- `npm run docs:check` **904 引用 / 0 failed**
- `npm run docs:build` dev / user とも成功
- `git diff -M` で**リネームとして検出**（内容は移動・参照のみ書き換え）

---

### docs(planning): 入力の DSL 表面と、入力が入ると変わる性能の性質 (Sep 3, 2026)

**Issue**: #692 / **正本**: `docs/planning/DEVELOPMENT_MAP.md` §4.O.1・§4.P.1

#### 🔴 入力の経路は現在ゼロ（実測）

| | 結果 |
|---|---|
| cpal の入力ストリーム | **0 件**（`build_input_stream` / `default_input` とも） |
| デバイス列挙 | **`list_output_devices` のみ**・`maxOutputChannels` だけ返す |
| `rebuild_output_stream(…buffer_frames, device_name)` | **出力専用**。入力用の対は無い |
| `CallbackTimeStats` / `StreamStats` | **出力コールバックの所要時間**のみ。**往復を測る手段が無い** |
| `input` / `rec` / `record` | **DSL 語彙に 0 件** = 新しい主語 |

**#661 / #660 / #662-A が扱っているのは全部「出力側」。** 入力はデバイスの列挙・選択・レート・
バッファ・統計が**すべて新規**。

#### §4.O.1 入力が入ると変わること（owner 2026-09-03）

> 性能向上とともに**サンプリング周波数の変更やレイテンシー、バッファの調整**が必要になりますよね。
> **特にインプット系があると。**

- 🔴 **レイテンシーが「往復」になる**（入力バッファ + 処理 + 出力バッファ）。
  性能ゴール「64 / 32」は memory の記述が出力バッファと out-of-process の +1 block の話なので
  **片道として読める** → **往復の目標値は未決**（§9・owner 確認）
- **サンプルレートは入出力で一致していなければならない**。#662 の「🔴 再起動」の理由が 1 つ増える
- **入力バッファは新規**（出力は #368 / #662-D と同じ場所）
- **クロックのずれ（drift）は main の推測**。owner は言っておらず実装にも該当なし → **未検証と明記**

**順序への影響**: 入力は「測れるようになってから」だけでなく、**入力自体が測る対象を増やす**。
**#662-B は一度で終わらず、入力が入った後にもう一度広がる。**

#### §4.P.1 入力の DSL 表面（owner のスケッチ・確定ではない）

> サンプリングも**インプットからオーディオが渡される DSL で表現されるべき**なのでは？
> `input.rec(…).effect` のように**順番でドライの録音かウェットの録音かも決められる。**

🔴 **§4.A.1 の規則が入力側にもそのまま効く** — `rec` はライン上の要素で、**位置が dry / wet を決める**:

```
input.rec().effect("Reverb")     ドライを録る
input.effect("Reverb").rec()     ウェットを録る
```

**専用のフラグが要らない。** パンチイン / アウトは **`play()` と同じパターン**（owner 提案）で、
**録音専用の構文も要らない**。

**出口との対称**: `output(宛先, thru, db)` ↔ `rec(パターン, …)`。
**`thru` = 入力モニターは main の読み**（owner は言っていない）と明示。

**未決**（§9・詳細は着手時に詰める・owner「まだ詳細決めきれないとは思うけど」）:
`input` の位置づけ（**文の受け手は今 globals / sequences / mixer nodes の 3 種** — 4 番目にするか
シーケンスの一種か）/ `rec` の引数（`play()` はスライス番号だが録音は 2 値）/ 録ったものの命名（テイク）。

**main の読み**: `input` を #643 の**ソース（feed）の一種**と決めれば、入力ラインは出力ラインと
同じ土台に乗り、`rec` は `output` と同じ資格の要素になる — **対称性がそのまま実装の形になる**。

---

### docs(planning): 設定変数・性能・入力（レコーディング）を地図へ (Sep 3, 2026)

**Issue**: #692 / **正本**: `docs/planning/DEVELOPMENT_MAP.md` §4.H.1・§4.O・§4.P

owner の確認 3 件で、**2 つの欠落と 1 つの分類ミス**が見つかった。

#### ① 設定変数の一覧化（§4.H.1・新設）

owner「設定のところに**変数を取り出して設定する**、とか **MIDI パニックを流すためのボタン**とか入ってる？」

| | 結果 |
|---|---|
| MIDI panic | ✅ 入っている（バッチ C・`midi-output.ts:90` 実装済み・**配線のみ**） |
| 設定変数 | 🔴 **部分的**。#662 が名指しするのは **5 項目**だが、本番ソースの env 変数は **33 個** |

`GetStatus` は**状態だけ**を返す（`session.rs:1349-1360`: version / sample_rate / channels /
loaded_samples / active_plays / uptime / render_contentions）。**設定値は 1 つも返さない。**
起動引数として渡せるのは `--audio-device` と `--list-audio-devices` **だけ**。

**#156（prefix 統一）が一覧化の前提**（`ORBITSCORE_*` 5 / `ORBIT_*` 28 の不統一が表に出る）。
**#694 の実装先が #662 の設定面になる可能性**（`ORBITSCORE_SESSION_LOG` を拡張から渡す手段が無い件）。

#### ② 性能（§4.O・新設）

owner「**マルチスレッドちゃんと使えてる？メモリは有効に使えてる？**」「**性能向上は必要。効率化大事です。**」

🔴 **地図に 1 件も無かった**（grep 0 件）。#667 / #590 / #640 は §4.I に個別の不具合として
入っていただけで、**性能という軸が存在しなかった**。

**owner の 2 つの問いは、いま答えられない** — スレッド構成はソースから読めるが（cpal RT /
audio owner `output.rs:128` / capture writer / tokio / supervisor）、**実測が無い**。

| 分かっていること | 実測値 |
|---|---|
| メモリは**起動時に固定確保** | 64 stage × sample_rate × channels = **2ch@48k で約 24.6 MB**（8ch で 4 倍・`output.rs:1408`） |
| instrument は **1 インスタンス 1 child** | Kontakt 6 台 = child 6。**各 child が 1 コアを食い切る**（#667）→ **実質の上限 = コア数** |
| RT の post-loop | 配列順で**直列**（`output.rs:943-975`）。並列化は未検討 |

**性能は他の裁定の前提**（#663 本文「バッチ B → 本 issue の順。逆にしてはいけない」/
#667 本文「#663 の前にこれを直さないと、上限だけ外して実際には増やせない」）。
順序: **#662-A → #662-B（測る）→ #667（直す）→ #663（外す）**。

#### 上限を決めない — owner の 5 語を定数で照合

| owner の語 | 実体 | #663 の対象か |
|---|---|---|
| トラック数 | `MAX_INSERT_BUS_STAGES = 64` | ✅ |
| インスト数 | `MAX_INSTRUMENT_SLOTS = 32` | ✅ |
| エフェクト数 | ラック内 N に上限定数なし | △ |
| 🔴 **アウトプット数** | **1 ラインの出口 = 1**（`_sumOutputBus` 単一）/ render bus 16 / Link ch 64 | **1 と 16 は #663 に無い** → **§4.A.1 の裁定（複数 `output`）と正面から衝突** |
| パス数 | send は stage 64 に従属 | ✅ |

#### ③ レコーディング = 入力の録音（§4.P・新設）— main の分類ミス

owner「**いやインプットの話したじゃん**」「**リアルタイムサンプリングが自然と Opcode Vision や、
Ableton・Bitwig のようなレコーディング機能になるはずです**」。

🔴 **#679 は「レコーディング機能の前段」ではなく、レコーディング機能そのもの。**
昨日のコメントに「Ableton, Bitwig, Opcode Vision 的なオーディオの扱い」と**既にあった**のに、
地図は引用だけ載せて**結論を書いていなかった**。§4.L の 1 行に埋もれ、「録音」の語で引けなかった。

**スコープへの影響**: 「フレーズを 1 つ録る」だけ作ると、後で録音機能を別に足すことになる。

**「録る」を 3 種に分離**（混ざっていた）:

| | 何を記録するか | 節 |
|---|---|---|
| `.orbslog` + `replay --render` | **評価の記録**（因果）→ 後から音を作り直す | §4.A.3 |
| capture / `output(<file>)` | **出力の音**（現象） | §4.A.3 |
| **#679** | **入力の音**（楽器の演奏）→ DSL の素材 | **§4.P** |

🔴 **capture は engine 起動時にしか指定できない**（`extension.ts:2130` で env・
`StartCapture` / `StopCapture` の RPC は **0 件**）。**演奏中に録る操作が無い**ので、
書き出し側も「レコーディング機能」として未完成。

---

### docs(planning): 退行を守る軸を地図に追加 — 譜面 108 本のうち音が固定されているのは 7 本 (Sep 3, 2026)

**Issue**: #692 / **正本**: `docs/planning/DEVELOPMENT_MAP.md` §4.G.1

owner の指摘「**E2E で既存機能が壊れてないかを守る件は書かれてる？**」→ **書かれていなかった。**
§4.G は「語が E2E に出てくるか」（カバレッジ）だけを扱っていた。

#### 🔴 なぜ致命的か

**本日の裁定はほぼ全部が既存の意味を変える**うえ、全部「**評価は成功するのに音が変わる**」形:

| 裁定 | 壊れ方 |
|---|---|
| `send` を dB へ | `send("rev", 0.3)` の音量が変わる。**エラーは出ない** |
| フェーダー = 出口の属性 | `global.gain()` が効くようになる = **今の音と変わる** |
| master = 出力先の 1 つ | 既定が保てないと**無音か二重** |
| `output` の `thru` | 既定 `false` なら不変の**はず**（要検証） |

`ok` でも `get_log` の ERROR でも捕まらない。**capture の数値でしか見えない。**

#### 実測: 譜面 108 本のうち、音のレベルで固定されているのは 7 本

| 置き場 | 本数 | 音を固定しているか |
|---|---|---|
| `test-assets/scores/` | 66 | ❌ **パースに使うだけ** |
| `examples/` | 24 | `examples/22` の 1 本だけ |
| `test-assets/verify-fixtures/` | 4 | ✅ Leg 1 / Leg 2 |
| `tests/fixtures/mcp-e2e/` | 2 | ✅ gated |
| その他 | 12 | ❌ |

🔴 **mixer（sum / aux / send）・instrument・プラグイン・`global.gain()` を通る譜面の
「この音になる」は 1 本も固定されていない** — **本日の裁定が触るのは全部そこ**。

#### owner 指示（逐語・§4.G.1 の冒頭に置いた）

> また**変異テストが増えて時間ばかり浪費するのは絶対に避けたい**ので E2E テストは重要です。
> **変異テストより「実際に動くか？」を、MCP 経由、つまりユーザーと同じ形でテストする**のが重要です。

これは新方針ではなく **CLAUDE.md の規律の再確認**（地図が引いていなかった）。
検証手段の順位: 1 仕様 → **2 MCP 経由 E2E**（カバレッジ = §4.G / 退行 = §4.G.1）→ 3 機能テスト →
**4 変異検証 = PR 外**（無人 `--in-diff` か週次）。

🔴 **実証が今日の議論のど真ん中**: `global.gain()` が instrument に効かない欠陥を、
**変異 35 件（80 分超）もユニット 2149 件も 1 件も捕まえず、キャプチャ E2E の RMS 実測だけが捕まえた**。
それが **#649** — **今日その設計（フェーダー = 出口のレベル）で消そうとしている当のバグ**。

#### 実装前に固定するもの（順序の条件）

`send` の現在の音 / `global.gain()` の現在の音（**効いていない状態 = バグの記録**）/
`output` を書かない譜面の宛先 / `seq.gain()`。**固定していないと「変わったのが意図した分だけか」を判定できない。**

受け入れ基準は #649 本文の実測がそのまま使える: `global.gain(-6)` で instrument の RMS が
**0.08864 → 0.044**（半分）になること。

#### #543 の分割を提案

#543 の「オフライン決定論層（同一 `.orbs` → ビット一致 PCM・CI 常駐）」が**退行の固定そのもの**。
**(a) 回帰の固定 / (b) 二重台帳（カバレッジ）**に分け、**(a) を裁定の実装より先**に置いた。

---

### docs(planning): 書き出しの筋 — replay がライブとオフラインの橋である (Sep 3, 2026)

**Issue**: #692 / **正本**: `docs/planning/DEVELOPMENT_MAP.md` §4.A.3

owner の問い: 「**アウトプットの音は全てレンダリングできるように。各トラックパラでレンダリングしたり、
マスターをレンダリングしたり**」「**順番ごとに実行するのをどうオフラインレンダリングに繋ぐか**」
「ライブコーディングで作ったものを録音する時にオフラインが要る（例: **840 / 1260**）」。

#### 🔴 答えは既に設計にあった

`SESSION_LOG_SPEC_v1.md` §4:

```
orbitscore replay <log> --render out.wav   # オフラインレンダー（faster-than-realtime）
```

> リプレイヤーはエンジンから見て**もう一人の評価送信者**（VS Code 拡張と同じ口）。
> **エンジン側に専用経路を作らない。** 駆動は **`transport` 時刻**。

**owner の「タイミングが合わない」懸念は、Known Decision で原理的に解けている** —
「リプレイは**音楽時間駆動**（三重スタンプ）」（棄却案: 壁時計駆動・`IMPLEMENTATION_INSTRUCTIONS.md:138`）。

#### 地図の分類ミスを訂正

🔴 **#241（L2 replayer CLI）を §4.M「研究トラック・本番後に実施」に置いていたのは誤り。**
WCTM の文脈でそう書かれていたのを写しただけで、**実際にはライブ → オフラインの橋**である。
**§4.A へ移した**（§2 の全体図も `#598 P2 → #241 replay → #598 P3`）。

#### 書き出しの経路は 3 つあり、違いは「時計」であって「宛先」ではない

| 経路 | 何を書くか | 時計 | 状態 |
|---|---|---|---|
| capture（`ORBIT_CAPTURE_WAV`） | **master 1 本**（`render_block` の post 後 `hw`） | 実時間 | ✅ 実装済み |
| #598 render | per-bus stem | 高速 | **P1 のみ ✅**（`10f3594c`・PR #612）/ P2・P3 ○ |
| `replay --render` | セッション全体（評価列） | 高速 | spec のみ（#241 ○） |

**`replay --render` と #598 は別ではなく積** — `--render` = 何を流すか（ログ = transport 順の評価列）、
#598 P2 = どこへ書くか + 誰が駆動するか。**順序: #598 P2 → #241 → #598 P3。**

🔴 **owner の要求のうち「演奏しながら各トラックをパラで」は今日どこにも無い**（capture は master 1 本、
#598 はオフライン）。`thru: true` が効く場所であり、§7 に新規候補として立てた。

#### 840 / 1260 を録るのに足りないもの

① replayer（#241）② オフライン driver（#598 P2）③ per-bus（P1 ✅）
④ 🔴 **editor 経路のファイル名伝達** — `SESSION_LOG_SPEC_v1.md:80`「editor 経路は現状エンジンへ
ファイル名を渡さない（`setDocumentDirectory` はディレクトリのみ）ため v1 は
**`untitled.<timestamp>.orbslog`** フォールバック。**follow-up**」。
**840 / 1260 はエディタ経路なので、ログの名前が付かず後から特定できない。④ だけ issue が無い。**

#### instrument が render bus を拒否している理由

**出口の問題ではない。** #598 P3（instrument child のオフライン駆動）が要るため。
**出口を一般化しても消えない**（P3 まで `output(n)` は「受理して無音」）。

#### 追加の裁定（owner 2026-09-03）

**A** `send` は残す（機能は `output` と同じ意味論だが名前が直感的）/ **B** `send` も dB へ統一
（🔴 移行の手当ては未決）/ **C** master は `output` の出力先の 1 つ。

---

### docs(planning): 出口の一般化 — owner 裁定 4 件と、機能の持ち方の原理 (Sep 3, 2026)

**Issue**: #692 / **正本**: `docs/planning/DEVELOPMENT_MAP.md` §1b・§4.A.1・§4.N

地図の初版を owner が読み、**昨日・本日の議論の帰結が入っていない**と指摘。順に反映した。

#### 入っていなかったもの

1. **#681（GUI）が §4 に節を持っていなかった** — §1 と §8 に 1 行ずつあるだけで「いつ・何の後にやるか」が読めなかった → **§4.N** を新設
2. **LinkAudio のプラグイン化と「スルー」が繋がっていなかった** — 別々の節に並んでいるだけ
3. **「機能の持ち方」という原理が §4.E に埋まっていた** → **§1b** として上位へ

#### 🔴 §1b — コアは最小に保ち、機能はプラグインで足す

owner「オーディオエンジンの**コア機能以外のプラグイン化・モジュール化や DSL のプラグイン化**などで
**拡張性を担保してかつライセンス問題を解決**しましょう」。

**この立場は 2026-06-30 から存在していた** — `POST_2.0_PLUGIN_STRATEGY` §1「規格に乗れる所は乗り、
自分たちにしか作れない fundamental に希少な開発リソースを寄せる。**§2–§7 はすべてこのメタ原則の
インスタンス**」（引用を一次資料で照合済み）。地図の初版はこれを 1 領域の話として埋めていた。

**ライセンスは目的ではなく帰結。** #671 の拡張点が入れば、LinkAudio は CLAP へ・Link テンポは
DSL Plugin へ出せて **engine 本体から GPL が消える**（「隔離」から「外へ出す」へ）。
**未決**: 「コア」とは何か（`PLUGIN_STRATEGY` は fundamental に audio DSL を含むが、
#671 はその語彙をプラグインで足すと言う。線は #672 で owner 裁定）。

#### 🔴 出口の一般化（§4.A.1）— owner 裁定 4 件

> ラインは要素の列であり、`output(宛先, スルー, レベル)` もその 1 要素。**宛先に特別なものは無い**
> （master / sum / aux / Link / デバイス ch は同じ軸）。**フェーダーは出口のレベルであって段ではない。**

| # | 裁定 | 帰結 |
|---|---|---|
| ① スルーの既定 | **`false`** | 既存譜面の意味が変わらない |
| ② レベルの単位 | **dB** | 🔴 `send("rev", 0.3)` の線形が例外 = **静かに壊れる**（0.3 は線形 -10.5 dB / dB では +0.3 dB）。移行は未決 |
| ③ `output` が aux を指せるか | **指せる** | `send` との差 4 点の最後が消え、**`send` は糖衣になる**（畳むかは未裁定） |
| ④ フェーダーの持ち方 | **`output` の level。`gain` は残す** | `gain` = ライン全体 / `output(db:)` = その宛先へ行く分 |

未決: ⑤ フラグ名（main 推奨 `thru`）/ `send` を畳むか / ② の移行。

#### 検証で分かったこと（すべて一次情報）

- 🔴 **#649 のバグの正体**: master gain は core の render 内で per-frame ramp（`scheduler.rs:444-455`）、
  その**後**に post-loop が stage を `hw` へ**素のまま**加算（`output.rs:958` `*dst += *s`）。
  一方 `send` は同じ合流点で `*d += *s * send.gain`（`:965`）。**同じ場所で send だけが乗算を持つ。**
  level を出口の属性にすると乗算が合流点に固定され、**位置ずれがクラスとして起きえなくなる**
- **「宛先に特別なものは無い」は 2026-07-18 に決定済み**（SC.2.1 `var master = mix.output(1, 2)`・
  規範 (4)「バス自身もレシーバ」・決定 #78「master は出力エンドポイントの予約名」）。**未実装なだけ**
- **AUX の「戻り」は `send` の性質ではなく aux バス自身の性質**（MX.1）。`send` と `output` を分ける理由にならない
- **main の読みが 1 点外れた**: `GainManager` は「ライン全体」でも「master への送り」でもなく、
  `calculateEventGain` で**イベント生成時に畳み込む**（`event-scheduler.ts:106`）= 適用点が発音点

#### engine 側に残る制約（規則では消えない・#611 の仕事）

トポロジの固定順と sum ネスト不可（MX.4）/ master のステレオ固定（`transport.rs:60`）/
LinkAudio とミキサーの相互排他（PH.5）/ PDC 無し（#634）。

---

### docs(planning): 開発計画の地図を制定し、issue をその写像にする (Sep 3, 2026)

**Issue**: #692 / **正本**: `docs/planning/DEVELOPMENT_MAP.md`（Fable 起案・611 行）

#### なぜ作ったか

2026-09-03 の 1 日で main が**同じ内容の issue を 2 回重複起票**した（#686→#218 / #680→#506+#522）。
2 回目は 1 回目の反省を `PROJECT_RULES.md` に書いた**直後**。

owner 判断: **注意力の問題ではなく、121 件を並列に並べたまま順序も包含関係も無いことが原因。
地図を作り、issue をそれに合わせる**（既存番号は活かす = 案 A）。

#### 地図が持つもの

§0 運用規則（**番号ではなく地図の見出しで探す**）/ §1 再設計しない確定事項 / §2 依存グラフ /
§3 リリースまでの筋 / §4 領域別 13 節 / §5 Epic 裁定（**Epic issue は作らない。地図の節がその役割を持つ**）/
§6 統合一覧 / §7 新規候補 / §8 確定事項への提案 / §9 未確認一覧。

#### main の受け入れ検証で確認した 3 件

| Fable の主張 | 検証 |
|---|---|
| #506 のメソッド形は撤回済み → #680 を正本に | ✅ SC.10 規範 (4)「メソッド形で指す形は**撤回する**」（SC.10.9・owner 確定 2026-08-27） |
| #546 の「復元側は 1 行も無い」は古い | ✅ `packages/engine/src/core/project-state-store.ts:122` が `manifest.states[key]` を読む |
| #197 と #656 が矛盾 | ✅ #656 本文に「**vsix は基本リリースしない。**」 |

🔴 **3 件目は main の誤り** — #197 に `release-gate` を付けたとき #656 と突き合わせていなかった。ラベルを外した。

#### owner 決定 2 件（地図に反映）

1. **配布は `.app` と `.vsix` の両方**（Marketplace 経由かは未決）→ #656 の「vsix は出さない」を撤回
2. 🔴 **`must-fix` ラベルを新設** — 「リリースゲートというかバグフィックスで必ずやらないとダメなやつ」。
   `release-gate`（出荷物が成立しない）とは軸が違う。#661 / #606 / #645 / #649 / #385 に付与

---

### docs(index): 棚卸し記録を INDEX の Planning 表に載せる (Sep 3, 2026)

**追従元**: PR #690（マージコミット `84a2e95`）/ **Issue**: #689

PR #690 が追加した `docs/planning/2026-09-03-issue-triage.md` が
`docs/core/INDEX.md` の Planning 表（`docs/core/INDEX.md:213-217`）に載っておらず、
**目次から辿れない**状態だった。INDEX は CLAUDE.md が「すべてのドキュメントの目次（必読）」と
位置づけている入口なので、そこに無い文書は次の棚卸しで**もう一度同じ調査をやり直すことになる**。

行を 1 本足し、クラスタ C1〜C6 の見出しとラベル運用（`PROJECT_RULES.md` §1b）への導線を書いた。

**追従不要と判断したもの**: PR #690 は `packages/` / `rust/` を 1 行も触っていないため、
DSL 仕様（`docs/specs-v2/` / `docs/core/INSTRUCTION_ORBITSCORE_DSL.md`）・ユーザー向け語彙
（`sites/user/`）・内部構造（`sites/dev/`）はいずれも変化していない。

### chore(meta): issue 棚卸し 164→120 とラベル運用の制定 (Sep 3, 2026)

**Issue**: #689 / **記録**: `docs/planning/2026-09-03-issue-triage.md`

open issue が 164 件まで溜まり、タイトルだけでは生死が判別できない状態だった。**1 件ずつ実装と
突き合わせて** 44 件を処理（**164 → 120**）。

#### 🔴 最も古い issue が、最も正しかった

**#218**（2026-05-09）は「閾値超過に気づかないまま WORK_LOG が肥大化する」と予測しており、
**そのとおり 7.5 倍（14,926 行）になった**。しかも本日 main が同じ問題を **#686 として重複起票**
している（起票前の既存確認を怠った）。**タイトルだけ見れば「古い chore」だった。**

→ 棚卸しの作法を `PROJECT_RULES.md` §1c に明文化した（更新日で判定しない／閉じる根拠を残す／
残す場合も現存の証拠を残す／起票前に重複を確認する）。

#### 判定が変わった例

**#92（タイムストレッチ選定）**: `rubato` が入っているので完了に見えるが、**rubato はリサンプラ**で
`fixpitch()` が要求するピッチ保持のストレッチではない。#213 が未実装のまま = **選定は済んでいない**。

#### ラベル運用（`PROJECT_RULES.md` §1b）

🔴 **種別ラベルは足さない。** 164 件中 **162 件がタイトルに Conventional Commits の接頭辞を持つ**ため
二重管理になる。既存ラベルは **20% にしか付いておらず**、`icmc-blocker` のように**過ぎた期限を
名前にしたもの**が腐っていた（`legacy:` へ改名）。

新設は 2 枚のみ: **`foundation`**（他の issue の前提）/ **`release-gate`**（リリース前に必要）。
この 2 枚で「基礎 → その上」の順序が機械的に読め、設計の発注順が決まる。

#### 見えたクラスタ（設計の入力）

個別に着手すると同じ設計を繰り返す群を 6 つ記録した:
**C1 診断の整合**（#280/#644/#610/#255）/ **C2 プラグインの生存管理**（#418/#626/#637/#342）/
**C3 daemon 起動の失敗面**（#129/#383/#130/#367）/ **C4 時間の粒度**（#428/#680/#674）/
**C5 配布**（#656/#197/#184/#385/#659/#321）/ **C6 ミキサーの出力側**（#611/#409/#647/#598）。

🔴 **C4 は不整合が具体的**: パラメータは CLAP も VST3 も**サンプル精度で送れる**のに、
ノートは今も即時メソッド（`engine_wrap.rs:4455` に明記）。

---

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
- [2026-09（前半・09-01〜09-02）](../archive/WORK_LOG_2026-09.md)

## 2026-09-03: マージ後の head ブランチは自動削除（規則を owner の決定に合わせる）

#702 / #704 のマージで head ブランチが消えているのに気づき owner に確認 → 「増えすぎるし後からでも
追えるので自動で消すようにした」（owner 2026-09-03）。PROJECT_RULES の「ブランチは消さない」
（4 箇所）・CLAUDE.md の Branch Structure・BUNDLE_BRANCH_WORKFLOW（3 箇所）を「マージ後は
GitHub 設定で自動削除・履歴は merge commit から辿る」に訂正。統合ブランチも束 PR のマージ後に
消えてよい（自動削除はマージ後にしか動かないので、小 PR の base が途中で消えることはない）。

## 2026-09-03: PR #704 の追従監査（ドキュメント変更なし・指摘 3 件）

ルーチン「マージ済み PR にドキュメントとサイトを追従させる」を PR #704（`703-bundle-branch-workflow`
→ main・merge commit `3fa1150`）に対して実行。**追従すべきドキュメント変更は 0 件**。

- 差分 6 ファイルはすべて規約文書と CI 定義（`CLAUDE.md` / `docs/core/PROJECT_RULES.md` /
  `docs/development/BUNDLE_BRANCH_WORKFLOW.md` / `docs/planning/IMPLEMENTATION_PLAN_2026-09.md` /
  `docs/development/WORK_LOG.md` / `.github/workflows/claude-code-review.yml`）で、
  `packages/engine/` `rust/` `packages/vscode-extension/` に変更が無い。DSL の構文・意味論、
  MCP ツールの契約、OrbitStudio の評価経路のいずれも変わっていないので、
  `docs/specs-v2/` `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` `sites/user/` `sites/dev/` は追従不要
- `squash` → `merge commit` の訂正は差分内で完結している（リポジトリ全体を grep して、
  規約文書に旧記述の残りは無い。`sites/dev/en/signal-chain/index.md:1230` の "squashed" は
  信号処理の記述で無関係）

**追従できていない点として PR で報告した 3 件**（本ルーチンでは直さない）:

1. `CLAUDE.md:301` と `docs/development/BUNDLE_BRANCH_WORKFLOW.md:70` が小 PR のゲートで
   `ORBIT_GATED_ONLY` を既存の仕組みとして参照しているが、実装が無い。
   実在するのは `ORBIT_GATED_ORBITSTUDIO`（`tests/e2e/orbitstudio-mcp-gated.spec.ts:59`）で
   suite 全体の on/off。`ORBIT_GATED_ONLY` は `docs/design/668-e2e-foundation-design.md:891`
   の決定 D-4（未実装）
2. `.github/workflows/claude-code-review.yml` の最終実行は 2026-06-17（run #278）。
   今回足した `if: github.base_ref == 'main'` の効果を Actions で観測できない
3. PR #704 は最終 head `7f53a5d` の CI 完了を待たずにマージされている
   （CI 開始 10:29:37Z / マージ 10:29:39Z）。赤ではないが、マージ時点では未検証

## 2026-09-03: 束ブランチ運用の採用（#703）

owner との相談（PR #702 セッション）で、レビューの単位を PR から**束**へ変更。小 PR は束の
統合ブランチへ軽いゲート（CI + その PR が足した E2E を実機で + 目視）で入れ、統合ブランチ → main の
束 PR で `/simplify` → `/code:pr-review-team` + Fable → 実機 E2E 全件を 1 回だけ回す。
手引きは `docs/development/BUNDLE_BRANCH_WORKFLOW.md`（PR #702）。

| ファイル | 変更 |
|---|---|
| `CLAUDE.md` | 「PR レビューワークフロー」に「レビューの単位は束」節を追加。マージ前ゲートの対象・禁止事項 2 件・Branch Structure・Quick Workflow |
| `docs/core/PROJECT_RULES.md` | 「Git Workflow and Branch Protection」に統合ブランチと束の手順表・`Part of #N` / `Closes #N` の使い分け |
| `.github/workflows/claude-code-review.yml` | ジョブに `if: github.base_ref == 'main'`。bot レビューは束 PR だけ。`code-review.yml`（テスト CI）は触らない |
| `PROJECT_RULES.md`「Merging PRs」ほか | 🔴 **squash はリポジトリ設定で禁止**（#702 のマージで API が 405 "Squash merges are not allowed" を返した。main の履歴も merge commit）。旧記述の `--squash` を `--merge` に訂正し、束ブランチ運用の文書も merge commit 前提に統一 |

## 2026-09-03: 出口・レンダ宛先・コア境界の裁定を地図と issue に同期

**背景**: 地図 §9 の未決約 40 件を「owner が決めるもの / 調べれば分かるもの」に分けたところ、
出口まわりの数件がその場で裁定された。

**owner 裁定**:

1. **同じ宛先へ 2 回 `output` = 合算**。正確には「**解決後の宛先**が同じなら合算」
2. **master は終端ではなく単にアウト先の 1 つ** — `output(master, thru).output("3,4")` で
   master を 3/4 でモニターできる。🔴 **「終端」という概念が無い**ので、地図 §9 の
   「master ラインの終端の書き方」は**問い自体が消滅**
3. **render の宛先 = エンドポイント宣言**（`var stem = mix.render("stems/%n_%v.wav")`）。
   トラック別は **`%n` テンプレート**で宣言 1 行に畳む
4. **「コア」は先に定義しない。境界を引いた残りがコア**（#672 が「定義待ち」で止まらなくなった）
5. **入力系は今はやらない。** ただし「入力とは instrument が Audio I/O のインプットに
   なっただけ」= 新しい受け手を作らない、という置き場所は決着
6. **ログは ① 出力（#694）→ ② 本当にリプレイできるか確認（#241）→ ③ オフラインレンダ（#598）** の順

**main の誤りと訂正**:

- 「`send(` を使う譜面が 0 本だから移行不要」と書いた。owner 訂正:
  **「実装と実際の利用は関係ない」**。仕様が線形と定めている以上 dB へ直すのは実装の仕事で、
  既存資産の有無とは無関係。地図 §9 の「B の移行の手当て」は**未決ではなく作業**に降格
- (c)（エンドポイント宣言）を推した時、**トラック 30 本なら宣言 30 行**になる後退を見落として
  いた。owner の指摘で `%n` テンプレートに至った

**コードで確認したこと**: `%n` は実装可能。シーケンスは変数への代入時に名前を受け取る
（`packages/engine/src/core/sequence.ts:197-200` の `setName` → `stateManager.setName` +
`global.registerSequence`）。エラー文言も既にそれを使う（同 :354）。追加の記法は要らない。

**記録先**: 地図（§1・§1b.3・§4.A.3.1 新設・§9・§10）と issue #611 / #598 / #672 / #409 /
#679 / #694 の 6 本。issue 側には**実装チェックリストへの追加分**も書いた。

### 追記: 地図がリンクする open issue 70 本にチェックリストを充填（同日）

owner 指示:

> 地図でリンクしてる ISSUE に実装チェックリストを作って、実装時にちゃんと終わってるか、
> **終わってなければ理由は何か（変更になった、いらなくなったなど）をトラッキングできる**ように

6 班（sonnet subagent）に領域ごとに並行委譲。**39 本は同日早い時間に投稿済みだったため
重複を避け、残りに新規投稿**した。`PROJECT_RULES.md` §1d の書式に統一。

🔴 **変異検証はどのチェックリストにも既定で入れていない**（owner 2026-09-03 の投資順位:
① 仕様 → ② MCP 経由の E2E → ③ 機能テスト → ④ 変異検証は最後の手段）。

**エージェントが見つけた実質的な問題**（すべて地図 §9 に記録）:

| 発見 | 中身 |
|---|---|
| **移管先が宙に浮いている** | #474 の cmd+click は 2026-08-28 に #633 へ移管された記録があるが、**#633 マージ後もコード上は未実装**（grep 0 件）。移管したまま誰も持っていない |
| **地図と issue の食い違い** | #138 の吸収先 — 地図 §6.1 は「#656 へ」、#138 自身の棚卸しコメントは「#659 と統合が自然」。どちらも根拠つき |
| **枝番号の不整合** | #484 の「D4」が **issue 本文に一度も登場しない**（2026-07-26 指摘・未解決） |
| **本文が SC 時代のまま** | #213 の実装計画が SuperCollider 前提で、地図 §1「SC 退役」と矛盾 |
| **本文が古い** | #546 Phase 3 の復元側は本文が「読むコードが 1 行もない」のままだが、実際は完了済み |
| **未実装の確定** | `ORBIT_OUTPUT_BUFFER_FRAMES`（#368）は grep で未実装と確認 |

## 同日の追加裁定（本コミットに含む）

- 🔴 **ICLC には出さない**（owner）。藝大不採択の retarget 先が消え、**本番トラックから
  締切が無くなった** → 開発の順序は**地図 §3 のリリース道筋が唯一**になる
- 🔴 **WCTM の開発はこのリポジトリでやらない**（owner）。作品開発は WCTM 側セッションが持ち、
  必要な機能は**そこから機能要望として降りてくる** → 降りてきたら**普通の機能 issue** として
  扱う（「研究トラック」という別枠に入れない）。地図 §4.M の見出しを
  「研究・作品トラック（🔴 このリポジトリでは進めない）」へ変更

## 2026-09-03: 死んだ `.env.example` を削除（#708）

**実害**: sandbox 内でフック付きコミットが**必ず失敗**していた。

```
[FAILED] error: lstat(".env.example"): Operation not permitted
  ✖ lint-staged failed due to a git error.
```

Claude Code の sandbox は `./.env*` の読み取りを拒否する（秘密の保護）。`lint-staged` は
コミット前に `git stash` するので、`.env.example` を lstat した時点で落ちる。
🔴 **エラーが「git error」としか出ないため lint の失敗と紛らわしく**、本日の PR-E1 でも
原因調査に時間を使った。

**なぜあったか**: `9a7a7bae`（2025-10-26）で BFG により `.env` を履歴から削除した際、
テンプレートとして作られた。**その後、参照する仕組みが消えていた**:

| 確認 | 結果 |
|---|---|
| 中身 | Slack 通知用 env 4 個 |
| その env を読むコード | **0 件** |
| `.env` を読み込む仕組み | **`dotenv` 依存なし。何も読んでいない** |
| Slack 連携の実体 | **無い**（`slack` のヒットは SuperCollider の vendor と英単語のみ） |

**残した注意点**: `.gitignore` の `!.env.example` / `!.env.sample` / `!.env.template` は
**外部ツール管理ブロック**（`[code:security-patterns:fbe2794b]`・生成元はリポジトリ内に無い）
なので触っていない。したがって**将来 `.env.example` を再び置くと同じ問題が再発する**。

## 2026-09-03: stale ガードが再ビルド不能なファイルで発火していた（#713）

**実害**: 🔴 **実機 gated E2E が起動段階で全部落ちる。しかもガードが指示する対処では解消しない。**

```
Error: gated E2E: the daemon binary is older than the Rust sources, so this run would measure stale code.
  newest source: rust/crates/orbit-vst3-host/tests/spike_s_concurrent_load.rs
  binary:        2026-09-02T02:05:35.862Z
  source:        2026-09-03T00:53:01.573Z
```

指示どおり `npm run test:e2e:gated` を回しても `pretest` の cargo は
`Finished release profile in 0.21s` で**何もビルドしない**。当然で、そのファイルは
`orbit-vst3-host` の**統合テストターゲット**であり、`orbit-audio-daemon` のバイナリの
依存グラフに入っていない。**バイナリの mtime は永久に更新されず、ガードは永久に赤。**

**なぜ今まで出なかったか**: mtime は **`git checkout` で現在時刻に更新される**。
ブランチを行き来すると無関係な Rust ファイルが「最新のソース」になる。

**修正**（`assertDaemonBinaryIsNotStale`）: 走査から **`tests` / `benches` / `examples`** を除外。
別の cargo ターゲットなので daemon バイナリに入らない。⚠️ **`src/` は除外しない** —
daemon が依存するコードが新しければ、ガードは本来の役目どおり赤くなるべきである。

**仕組みで守る**（規律を文章で持たない）: `gated-assertion-hygiene.spec.ts` に検査 2 本。

| 検査 | red になる条件 |
|---|---|
| 除外の維持 | `tests` / `benches` / `examples` の除外が消えたら |
| **行きすぎの防止** | **`src` まで除外したら**（ガードの目的自体が失われる） |

**変異で両方向を確認した**（実出力）:

```
変異A: 除外を消す        → × keeps the stale guard off cargo targets it can never rebuild
変異B: src も除外する    → × still lets the stale guard see the sources the daemon is built from
restore 後              → Tests  5 passed (5)   ／ cmp で復元一致を確認
```

### 🔴 副産物: 実機 gated は現在 main で 11 件が意図的に red

ガードを直して初めて中身が走り、**20 件中 9 passed / 11 failed** だと分かった。
これは**退行ではなく、修正より先に書かれたテスト**である（一次情報:
`docs/design/649-audio-line-design.md` §B-0「**E2E-1 を先に書いて red 固定**」)。
修正は**段 1**（PR-O2 / #649・plan §3「段 1 の結果: `global.gain(-6)` が instrument に効く」）。

**したがって段 0 の小 PR のゲートは「実機 gated 全通し」にできない。**
正しい判定は **「失敗集合が before/after で同一」**（新しい失敗を作っていない）。
baseline（main + 本修正・2026-09-03 実測）:

```
#643 E2E-1〜E2E-7（7 件）
auto-records and restores all five plugin receiver kinds across a restart without explicit saves
drives real OrbitStudio end-to-end: diagnostics-on-open, run_selection, live edit, capture verification
replaces a playing instrument across CLAP/VST3 ... (#618 E1-E6)
steps the live playhead through an instrument() sequence, rests included
```

E2E-2 / E2E-3 の dry RMS が **ちょうど 0**、E2E-1 の比が **1.27**（gain が効いていない値）
という内容も、段 1 が直す欠陥と一致している。

## 2026-09-03: #713 のガード変更に dev 学習サイトを追従させた（docs のみ）

**対象**: PR [#714](https://github.com/signalcompose/orbitscore/pull/714)（merge commit `f006a51`）。
コード・テストは一切変更していない。

PR #714 は引用のアンカー（`// FILE:START-END` 形式の見出し行）を直したが、**引用を囲む本文**と
`## Sources` の行範囲は旧状態のままだった。`docs:check` は前者しか検査しないので、後者は
red にならずに残った。この 2 種を追従させた。

**本文の乖離 2 件**（どちらも #714 で挙動が変わった箇所を古い説明のまま記述していた）:

| 場所 | 旧記述 | 実態 |
|---|---|---|
| `sites/dev/rust-engine/capture-verification.md` / `sites/dev/editor/mcp-and-gated-e2e.md` | ガードは `rust/**/*.rs` \| `Cargo.toml` を走査 | `tests` / `benches` / `examples` を除外する（#713） |
| `sites/dev/editor/mcp-and-gated-e2e.md` | 「残り **2 本**」（アサーション衛生は 3 本） | #713 で 2 本増えて **5 本** |

両章に #713 の節を足した。走査除外の理由（別 cargo ターゲットなので daemon バイナリに入らない・
`git checkout` が mtime を動かすので解消不能な赤になる）と、`src/` を除外しない理由、
`gated-assertion-hygiene.spec.ts` の 2 本が両方向を留めていることを書いた。
ja / en 両方（STYLE_GUIDE のバイリンガル必須）。

**`## Sources` の行範囲**: ガードが 15 行伸びたので、`orbitstudio-mcp-gated.spec.ts` の
128 行目以降を指す参照はすべて +15 ずれていた。6 章 × ja/en で 12 ファイル分を直した
（`78-152` → `78-166`、`1434-1468` → `1449-1483` など）。境界行は実ファイルで確認済み。

**frontmatter**: 本文を実質的に足した 2 章（RE-4 / IV-3）の `verified-against` を
`69dc968` → `f006a51`、`verified-at` を `2026-09-03` に更新した（STYLE_GUIDE
「章本文を実質的に書き直したとき: 必ず最新 commit に更新する」）。

### 追従の過程で見えた、直していない点

このセッションでは**指摘のみ**（テスト・実装は変更しない方針のため）。詳細は PR 本文。

1. `tests/e2e/gated-assertion-hygiene.spec.ts:76-83` / `:89-93` は gated spec の**ソース文字列**を
   正規表現で見るだけなので、「除外ブロックを `walk(full)` の**後ろ**へ動かす」変異
   （除外が到達不能になり #713 の赤が戻る）で **2 本とも緑のまま**になる
2. 同 `:77` は式の**字面**に依存するので、`Set` へ畳む等の挙動不変なリファクタで red になる
3. `assertDaemonBinaryIsNotStale()` は `tests/e2e/orbitstudio-mcp-gated.spec.ts:164-166` の
   `gated && appAvailable` の下でしか呼ばれない。CI は全ジョブ非 gated なので、
   #713 で足した 15 行は**どこでも 1 行も実行されていない**

## 2026-09-03: PR #700 のドキュメント追従（ICLC 取り下げ / WCTM の持ち先 / §10 の表崩れ）

**追従元**: PR [#700](https://github.com/signalcompose/orbitscore/pull/700)（マージコミット `ca176f0`・head `f5b16d8`）。
docs のみの変更で、`CLAUDE.md` の本番トラック注記・`docs/planning/DEVELOPMENT_MAP.md`・本 WORK_LOG を更新していた。

**#700 が `CLAUDE.md` にしか書かなかったため、同じ注記を持つ他のドキュメントが古いまま残っていた:**

| ファイル | 何が古かったか |
|---|---|
| `docs/core/INDEX.md:39` | 「本番トラックは ICLC への proposal 提出方向へ retarget（年次・提出日・提出形態はいずれも要確認）」 |
| `docs/core/INDEX.md:207` | 同じ retarget 注記（WCTM 調査群の凍結セクション） |
| `docs/core/INSTRUCTION_ORBITSCORE_DSL.md:18` | 「ICLC 提出方向へ retarget（年次・提出日・形態は要確認）」 |
| `sites/dev/decisions/adr-001-supercollider.md:267` / `:314`（+ `en` 対訳） | 「Consequences revisited」の 3. 学術的文脈が ICLC retarget で止まっていた |

いずれも **ICLC 取り下げ（owner 2026-09-03）・本番トラックに締切が無い・WCTM 本体の開発は本リポジトリで進めない**
の 3 点へ書き換えた。`sites/dev` は日英両方を更新（STYLE_GUIDE のバイリンガル必須）。

**#700 が入れた表崩れも直した**: `DEVELOPMENT_MAP.md` §10 で、追記の箇条書きと更新履歴テーブルのヘッダ行の間に
空行が無く、GFM ではテーブルがリスト項目の遅延継続として吸われて**描画されない**状態だった
（`docs/planning/DEVELOPMENT_MAP.md:1463-1464`）。空行を 1 行入れただけで、本文は変えていない。

**追従しなかったもの**: #700 が記録した出口・レンダ宛先・`%n` テンプレートの裁定は、地図自身が
「spec への反映は §6.2 の改訂候補（owner 裁定で行う）」と書いているため `docs/specs-v2/` と
`docs/core/INSTRUCTION_ORBITSCORE_DSL.md` へは**反映していない**（実装も未着手で、DSL 表面は変わっていない）。


## 2026-09-03: PR #709 追従 — 失効した landmine 記述を更新

PR #709（`7d2df31`・上記 #708）で `.env.example` を削除した結果、
`docs/development/POST_2.0_VST3_HOSTING_PLAN.md:256` の landmine 記述が**失効した**。

| | 内容 |
|---|---|
| 旧記述 | 「`.env.example` は sandbox read-deny → `git diff` が誤って削除表示。`git status --short` が権威」 |
| なぜ失効か | ファイルが実在しなくなったため、この誤検知は起きない |
| 🔴 なぜ放置できないか | **実際に削除された今、この記述は「`.env.example` の削除表示は無視してよい」と読める** — 真の削除を sandbox の誤検知と取り違えさせる |

取り消し線で旧記述を残したうえで、解消済みであることと、`.gitignore:55-57` の
un-ignore 行が残っているため**再設置すると再発する**ことを追記した。

**追従不要と判断した層**（PR #709 の差分は `.env.example` 削除と WORK_LOG 追記のみ）:

| 層 | 判断 |
|---|---|
| DSL/言語仕様（`packages/engine/`） | 差分に含まれない。構文・意味論・`.orbslog` 形式に変化なし |
| ランタイム/MCP（`rust/`） | 差分に含まれない。MCP ツールの引数・返り値・エラー挙動に変化なし |
| OrbitStudio（`packages/vscode-extension/`） | 差分に含まれない。評価フロー・診断・補完に変化なし |
| `sites/user/` `sites/dev/` | 削除したファイルを参照する記述は 0 件（repo 全体 grep で確認） |

## 2026-09-04: ルーティンのドキュメント追従 PR を溜めない規則（#718）

**実害**: ルーティンが出したドキュメント追従 PR **9 本のうち 8 本が衝突**し、1 本ずつ手で解決した。

| PR | 結果 |
|---|---|
| #716 / #717 | **出てすぐ入れた → clean** |
| #688 / #691 / #698 / #701 / #705 / #710 / #711 | **溜めた → 全部衝突** |

**原因**: ルーティン PR の差分は**「追従した時点の main」に対して計算されている**。その後 main に
入る 1 コミットごとに陳腐化する。待たせている間に #709 / #714 / #716 と束の追従が入り、
`WORK_LOG` の追記位置・`INDEX` の項目・各ドキュメントの **`## Sources` の行範囲**と
**引用のアンカー**が全部ずれた。

🔴 **片側を捨てると情報が落ちる**ので、機械的な解決ができない。実例:

- **#688**: 「archive パスへの修正」（PR 側）と「ICLC 取り下げの追記」（main 側）が**同じ行**で衝突。
  両方が正しいので、パスは PR 側・文末は main 側を採った
- **#711**: `## Sources` は束側が最新だったが、`helpers/rack-child-pid.ts` の行は PR 側にしか無かった

**規則**（owner 合意）:

1. main に何かをマージしたら、**ルーティン PR が出た時点でその場で入れる**
2. 遅くとも **統合ブランチを main から切る前**に全部消化する
3. 🔴 **base の選び方**: 追従先のファイルが**束にしか無い**なら base は **統合ブランチ**にする。
   main を base にすると引用が実ファイルを指せず `docs:check` が落ちる（#711 が実際その状態だった。
   #717 はルーティン自身が正しく束を base にしていた）

**止めない理由**: 🔴 **ルーティンは機械が見ていない層を見ている。** `docs:check` は**引用のアンカー
しか検査せず**、引用を囲む**本文**と **`## Sources` の行範囲**は検査しない。#716 はまさにそこを
検出した（#714 でガードの走査範囲を変えたのに、本文は「`rust/**/*.rs` を走査」のまま）。

**自動マージにもしない**: #688 の本文には事実誤認があった（「vitest を回す CI チェックは 1 本も
存在しない」— 実際は `code-review.yml:26` が `npm test` を実行している）。人が読む前提は変えない。
