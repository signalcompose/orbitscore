<div id="title-block-header" class="header">

<div class="docmeta">

{"type":"meta","doc":"PITCH_DSL_SPEC","version":"1.1","status":"E1-E6 as-built","date":"2026-06-14","authors":"Yamato (decisions) / Claude (drafting)"}

</div>

</div>

# OrbitScore Pitch DSL Specification — v1.1 “MIDI Integration”

**Status**: E1–E6 as-built — pitch / chords + voicing / randomness / key-center register / section variables / per-note expression / mode scope are implemented and test-covered (synced to DESIGN_DISCUSSION_RECORD decisions \#47–59). §3 group-chain modifiers and any later phases are tracked separately, not asserted as done here. **Date**: 2026-06-14 (orig. 2026-06-12) **Authors**: Hiroshi Yamato (design decisions) / Claude (drafting) **Relation to existing docs**: - Extends `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` (v3.0, single source of truth) - Supersedes the pitch system of `docs/archive/DSL_SPECIFICATION_v1.0_MIDI.md` (chromatic degree system) - Implements ROADMAP_2026.md v1.1 “MIDI Integration” (Epic \#132) with a revised DSL design

------------------------------------------------------------------------

## 0. Design Principles (normative)

1.  **構造=リズム、値=コンテンツ**: v3.0 の不変条件を維持する。`play()` のネスト木が時間分割を、要素の値が内容を表す。audio シーケンスでは値=スライス番号、MIDI シーケンスでは値=度数。`0` = 休符は両者で共通。
2.  **メロディと和声は同一ストリームに同居する**: ハーモニーを独立したタイムライン(グローバルなコード進行レーン)として持たない。和声は度数スタック `[ ]` として旋律と同じ play() 内に書かれる。ピッチコンテキスト(root/mode)はリズム木のグループに付くレキシカルスコープであり、時間的な参照ではない。
3.  **MLTS との整合**: ピッチコンテキストがリズム木の内部にあるため、ハーモニックリズムも層ごとに独立する。共有グリッドをいかなる形でも再導入しない。
4.  **クオリティは表記が持つ**: 基底意味論(root スコープ)では度数表記が音程クオリティを自己完結的に表す。`b3` はどの文脈でも「ルートの短3度上」。スコープ宣言を遡らないと実音が分からない設計(scale-index 方式)は基底には採用しない。
5.  **コードシンボルを構文に持たない**: コードは度数スタックの値(bare `[...]` 値、#48)であり、命名はユーザー変数に委ねる。
6.  **記譜可逆性**: 本 DSL の根底にある問題定義は「譜面を簡単に書くための DSL の不在」である。内部表現(ネスト分割木 + シンボリックピッチ)は記譜構造(連符の入れ子 + 音名スペリング + タイ/スラー)とほぼ同型であり、この同型性を実装上も保存する(§7-0)。譜面生成は本仕様のスコープ外だが、その可能性を閉じる実装判断を禁止する。

------------------------------------------------------------------------

## 1. MIDI Output Declaration

``` js
seq.midi("IAC Driver Bus 1", 1)   // (portName, channel 1-16)
```

- portName は CoreMIDI 出力ポート名と部分一致(case-insensitive substring match)で解決。複数一致時は最初のポート + warning diagnostic。不一致時はエラー(利用可能ポート一覧を提示)。
- `seq.midi()` を宣言したシーケンスは MIDI シーケンスとなり、`play()` の値は度数として解釈される。`audio()`/`chop()` との併用はエラー。
- **SC オーディオ経路との併走は可**(LinkAudio のような排他制約は設けない)。
- **Plugin instrument 出力(#425)**: note 出力宣言には `seq.midi()` のほか、ホストされたプラグインを出口にする `seq.instrument(path)` がある(構文の正本: core spec `INSTRUCTION_ORBITSCORE_DSL.md` の Plugin Hosting 節)。いずれの出口でも `play()` の値は度数として解釈される。

### Sequence-level parameters

``` js
seq.gate(0.8)      // デフォルトゲート長(スロット長に対する比)。default: 0.8
seq.vel(96)        // デフォルトベロシティ 1-127。default: 96
seq.octave(4)      // 基準オクターブ。度数1のオクターブ配置。default: 4 (C4=60基準)
```

### Global parameters

``` js
global.key("C")          // 数値 root の基準キー。音名トークン
global.midiLatency(20)   // MIDI 送出への固定オフセット(ms)。SC 経路との耳合わせ用。default: 0
```

### Key-center register: `global.key("D4")` (E3)

``` javascript
global.key("D4")   // tonic = D, base octave 4 (degree 1 = D4 = 62)
global.key("Bb5")  // tonic = Bb, base octave 5 (degree 1 = Bb5 = 82)
global.key("C")    // 数字なし → ピッチクラスのみ。base octave は既定 4 のまま
```

- `global.key()` は音名トークンに加え、末尾の数字で**ベースオクターブ**(度数1の配置)も宣言できる(E3、#253)。曲全体のレジスターを一箇所で決める設計。
- **オクターブの優先順位**: `seq.octave(N)`(明示) \> key オクターブ(`global.key("D4")`) \> 既定 4。`seq.octave()` があれば key オクターブを上書きする。
- 数字を伴わない `global.key("D")` は従来どおりピッチクラスのみを設定し、オクターブは既定(4)のまま。ピッチクラスは数字の有無で変わらない(`"C"` = C4=60、`"C3"` = C3=48、同じ C)。

------------------------------------------------------------------------

## 2. Pitch Resolution Semantics

### 2.1 Root scope (基底意味論)

度数 = **Ionian 基準のインターバル語彙** + 変化記号。

    IONIAN = [0, 2, 4, 5, 7, 9, 11]   // semitones for degrees 1..7

    resolve(degree n, alteration a, range o):
      semitones = IONIAN[(n-1) mod 7] + 12 * floor((n-1) / 7) + a
      pitch     = rootPitch + semitones + 12 * o
      // o = 現在の running pitch range (§2.4 の ^N が設定。default 0、play() 先頭でリセット)

- `a`: `b` = -1, `#` = +1, `bb`/`##` = ±2。重複可だが diagnostic で warning(2個まで)。
- **受理される度数 = `{1-9, 11, 13}`**。`1-7` = Ionian スケール度数、`8` = オクターブ上のルート(8va、`1^1` と等価)、`9/11/13` = テンション(`2/4/6` の +1オクターブと同ピッチクラス。式から自然に導出: 9 = IONIAN\[1\] + 12。メロディでも明示使用可)。
- **`10, 12, 14` および `15` 以上は *エラー***(diagnostic: 「オクターブは `^N` で書く。例 `3^1`」)。リニアな高数字は非音楽的で可読性が悪いため受理しない (v1.1 は本機能の pre-release ゆえ後方互換は取らない)。コードトーンのオクターブ上は `^N` pitch range(§2.4)で書く。
- `0` = 休符。
- `rootPitch` は現在の root スコープ(§3)が決める。度数1のオクターブは `seq.octave()` \> key オクターブ(`global.key("D4")`, E3/§1) \> 既定 4 の優先順位で決まり、MIDI ノート番号は `rootPitch = 12 * (octave + 1) + rootPitchClass`(C4=60 規約)。

### 2.2 Mode scope (ユーザー定義ピッチ格子)

``` js
var dorian      = mode(1, 2, b3, 4, 5, 6, b7)
var holdsworth1 = mode(1, 2, b3, 4, #5, 6, 7, 9, #11, b13, 7^+1)   // 2オクターブモード
var custom      = mode(1, 2, b3, ...).period(19)                    // 反復周期の明示(半音数)
```

- mode の定義要素は **root スコープの度数表記**で書く(Ionian 基準 + b/# + `^`/`~` 修飾)。つまり mode は root 意味論の上に定義される格子。
- mode スコープ内では、メロディーの度数 n は**格子への純粋なインデックス**: `pitch = lattice[(n-1) mod len] + period * floor((n-1) / len)`。
- `period()` 省略時は格子の**最大半音位置**(最終要素とは限らない)から次のオクターブ境界へ切り上げて推定(7音教会旋法なら 12)。非昇順・基音より下の要素(例 `mode(1, 7^-1)` の `-1`)があっても 0/負の周期にならないよう最大値を基準にし、最低でも1オクターブを保証する。非オクターブ周期・マイクロトーナル(`~` デチューン併用)も許容。
- **mode スコープでは 2↔︎9 のテンション折り返し規則は成立しない**(格子が 7 音とは限らないため)。ドキュメントで明示すること。
- mode 内の変化記号 `b3` 等は「格子の該当インデックスの音から半音変位」として解決する。
- 教会旋法はライブラリ(事前定義 var 群)として提供。言語プリミティブではない。

### 2.3 Root の指定

``` js
.root(F)      // 音名トークン: C, C#, Db, D, ..., B (字句レベルで # / b を含む音名を許容)
.root(3)      // global.key() のメジャースケール上のダイアトニック度数 (key C → E)
.root(b6)     // 非ダイアトニック度数 (key C → Ab)。解決規則は §2.1 と同一(再帰適用)
```

- **`global.key()` 未宣言時、数値 root はエラー**(音名 root のみ可)。事故防止を優先。
- `.root()` の指定はメソッド形のみ。プロパティ形(`.root.F`)は採用しない(`F#` 等で破綻するため)。

### 2.4 Event modifiers: `^N` pitch range / `~` detune

``` js
3^1        // pitch range を +1 に設定(スティッキー、以降持続)
3^3        // 3オクターブ上を一発(+ は省略可、^+3 と等価)
3^-1       // 下方向は符号で
1^0        // base range に戻す
0^2        // 休符に付けて無音で音域だけ +2 に
b7~-0.25   // デチューン(半音単位、ピッチベンドで実現。bendRange は将来課題、当面±2半音固定)
```

**`^N` = スティッキー pitch range(音域状態)。**音または休符 `0` に付き、その地点から **running range** を base+N オクターブに設定する。`play()` 内では**読み順(時間順)に持続**し、以降のすべての度数に効く(統一ルール: range +1 で `2`=D5, `9`=D6)。

- **リセット契機**: 各 `play()` の先頭(base = range 0 に戻る)/ 後続の `^M` / `^0`。それ以外では持続。
- **`^` は必ず音/休符に付く**。独立した `^N` マーカー(裸の `^1`)は構文エラー。音域だけ静かに変えるときは `0^N`。
- **符号**: `^+N` の `+` は省略可(`3^3` ≡ `3^+3`)。下方向は `^-N`。
- **`^N`(linear/persistent)と `.oct(N)`(lexical/group、§3, Phase 2)は別軸の道具**。`^N` は読み順でフラットに持続し、`.root()` やグループ境界では**リセットしない**(range と root は直交。グループ単位で音域を閉じたいときは `.oct(N)`)。*※ `.root()` グループとの相互作用は DESIGN_DISCUSSION_RECORD §9.4 で linear と確定。*
- **running range が走るのは play() の*時間軸(メロディ)要素列***。要素がコード/スタック(`[...]` / `chord()`)のとき、running range はそのコード全体の音域を決め、コード内の各声部の `^N`(§6 のヴォイシング、例 So What)は**その声部の構造的オクターブ配置**として range の上に重なる。コード内 `^N` は running range を変えない(コードは1スロット)。

### 2.5 Event modifiers: `@v` velocity / `@g` articulation

``` javascript
5@v110          // 絶対ベロシティ 110 (1..127)。seq.vel() を上書き
5@v+20  5@v-30  // seq.vel() への相対(アクセント / 弱化)。加算後に 1..127 へクランプ
5@g30           // アーティキュレーション = ゲート PERCENT: 30 = 0.30 (スタッカート)。seq.gate() を上書き
5@g120          // 120 = 1.20 (レガート寄り、スロットを超えて鳴る)
5@v100@g30      // 合成可。^N / ~ / r とも直交
```

- **`@v` = ベロシティ**(決定 \#56/#57、E5)。絶対 `@v<n>`(1..127)または相対 `@v+<n>`/`@v-<n>`(`seq.vel()` に加算しクランプ)。アクセントはベロシティの増減であり専用トークンを持たない。
- **`@g` = アーティキュレーション**をゲート**パーセント**で表す(`@g30` = 0.30、`@g120` = 1.20)。`{ }` レガートと同一軸上の per-note 値で、100 超は次スロットへ食い込む(レガート寄り)。当該ノートの `seq.gate()` を上書きする。`{ }` を併用した場合は `{ }` レガートが `@g` を上書きする(legato が優先。例: `{5@g120}` は `@g120` ではなく `{ }` のオーバーラップ量で鳴る)。
- **整数(パーセント)引数**を採るのは、小数点がレキサーでトークンを分断するのを避けるため(`@g0.3` ではなく `@g30`)。同一ノートで重複指定した場合は last-wins(警告なし)。
- 絶対長さ修飾 `@u`(v1.0 の `@U`)は**非対応**(#41)。長さはリズム木+タイが持つ。
- ランダム化の per-note 修飾 `r`(要素確率)/ `^r`(ランダムオクターブ)も同じく per-note 修飾子だが、スタックの `.r` thinning と**同一プリミティブ**のため §6.2 にまとめて定義する。

------------------------------------------------------------------------

## 3. Scope Rules

`.root()` / `.mode()` はリズム木のグループ(丸括弧)へのメソッドチェーンとして付く。

``` js
seq.play(
  (9, 5, (3, 1), [1,3,5,7]).root(2),
  ((1, b3).root(b6), 5, 1).root(2),    // 内側の .root(b6) がその半拍だけ優先
  (1, 5, 1, 5),                         // 指定なし → シーケンス既定
)
seq.root(C)   // シーケンス既定のピッチコンテキスト
```

1.  **解決順位**: 内側グループ → 外側グループ → シーケンス既定(`seq.root()` / `seq.mode()`) → エラー(既定未設定で度数が現れた場合は diagnostic)。
2.  **無指定区間はシーケンス既定に戻る**(直前スコープの維持はしない。stateless を優先)。
3.  **タプル並置への適用**: `(...)(...).root(X)` のチェーンは**並置全体に掛かる**。並置されたグループは時間的には兄弟(各々が自身のスロットを保持)のまま、ピッチコンテキストのみ共有する。これが「複数小節で1コード」の標準記法。改行は字句的に無意味(現行仕様の multiline 規則を継承)なので、長いスパンは縦書きが推奨形:

``` js
piano.play(
  (0, m7, 0, m7)
  (0, m7, 1, 0)
  (7, m7, 0, 0)
  (0, m7, 0, m7).root(3),     // 4小節を III ルートで共有。カンマがスコープ終端
  (0, m7, 0, m7)
  (1, 0, 5, 0).root(6),
)
```

- **チェーンは並置を閉じる**: メソッドチェーンが付いたグループ列の直後にカンマなしで `(` が続く場合はパースエラー(diagnostic: “expected comma after chained group”)。`.root()` 後のカンマ忘れを構文段階で検出する。
- **既知のリスク**: `.root()` とカンマの両方を書き忘れると、後続ブロックに静かに併合される(構文上合法のため検出不能)。緩和策として VS Code 拡張で root スコープ単位のセマンティックハイライト(同一スコープの並置範囲の可視化)を実装すること。
- 同型反復の冗長性は反復 `*n`(§6.5)で解消する: `(0, m7, 0, m7)*4.root(3)`。

4.  **同一グループへの重複指定**(`.root(2).root(5)` のチェーン連結、または root と mode の同時指定)は **diagnostic エラー**。last-wins は採用しない(ライブ差し替え時の消し忘れが無音の事故になるため)。ネストによる上書きのみが合法な上書き手段。
5.  `.root()`/`.mode()` チェーンの後に他の play modifier が続く場合の評価順は左から右(ただし v1.1 時点で他の play modifier は未実装)。

------------------------------------------------------------------------

## 4. Brackets

![](data:image/svg+xml;base64,PHN2ZyB2aWV3Ym94PSIwIDAgODgwIDI1MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIiByb2xlPSJpbWciIGFyaWEtbGFiZWw9IuODquOCuuODoOacqOOBqOaZgumWk+i7uOOBruWvvuW/nCIgc3R5bGU9Im1heC13aWR0aDoxMDAlO2hlaWdodDphdXRvO2ZvbnQtZmFtaWx5OiYjMzk7SGlyYWdpbm8gU2FucyYjMzk7LCYjMzk7WXUgR290aGljJiMzOTssc2Fucy1zZXJpZjsiPgogIDxzdHlsZT4KICAgIC5ue2ZpbGw6I0ZGRkZGRjtzdHJva2U6IzE2MTgxRDtzdHJva2Utd2lkdGg6MS4zO30KICAgIC5ucntmaWxsOiNGRkYzRjI7c3Ryb2tlOiNCNDIzMUY7c3Ryb2tlLXdpZHRoOjEuMzt9CiAgICAudHtmb250LXNpemU6MTNweDtmaWxsOiMxNjE4MUQ7fQogICAgLnR0e2ZvbnQtc2l6ZToxM3B4O2ZpbGw6IzE2MTgxRDtmb250LXdlaWdodDo2MDA7fQogICAgLnN7Zm9udC1zaXplOjExcHg7ZmlsbDojNUE1QTYwO30KICAgIC5le3N0cm9rZTojMTYxODFEO3N0cm9rZS13aWR0aDoxLjE7ZmlsbDpub25lO30KICAgIC50bHtzdHJva2U6IzE2MTgxRDtzdHJva2Utd2lkdGg6MS40O30KICAgIC50aWNre3N0cm9rZTojMTYxODFEO3N0cm9rZS13aWR0aDoxLjE7fQogICAgLnNlZ3tmaWxsOiNGMkYyRUY7c3Ryb2tlOiMxNjE4MUQ7c3Ryb2tlLXdpZHRoOjEuMTt9CiAgICAuc2VnUntmaWxsOiNGRkYzRjI7c3Ryb2tlOiNCNDIzMUY7c3Ryb2tlLXdpZHRoOjEuMTt9CiAgPC9zdHlsZT4KICA8dGV4dCB4PSIyMCIgeT0iMjgiIGNsYXNzPSJ0dCI+cGxheSggMSwgKDMsIDUpLCBbMSwzLDVdLCAwICkucm9vdCgyKSDigJQg5pyo5qeL6YCg44Go5pmC6ZaT6Lu444Gu5a++5b+cPC90ZXh0PgogIDwhLS0gdHJlZSAtLT4KICA8cmVjdCB4PSIzMzAiIHk9IjQ2IiB3aWR0aD0iMTIwIiBoZWlnaHQ9IjI2IiBjbGFzcz0ibiIgLz48dGV4dCB4PSIzNTIiIHk9IjY0IiBjbGFzcz0idCI+YmFyICgxLzEpPC90ZXh0PgogIDxwYXRoIGNsYXNzPSJlIiBkPSJNMzkwLDcyIEwxMjAsMTA0IiAvPjxwYXRoIGNsYXNzPSJlIiBkPSJNMzkwLDcyIEwzMzAsMTA0IiAvPjxwYXRoIGNsYXNzPSJlIiBkPSJNMzkwLDcyIEw1MjAsMTA0IiAvPjxwYXRoIGNsYXNzPSJlIiBkPSJNMzkwLDcyIEw2ODAsMTA0IiAvPgogIDxyZWN0IHg9IjkwIiB5PSIxMDQiIHdpZHRoPSI2MCIgaGVpZ2h0PSIyNCIgY2xhc3M9Im4iIC8+PHRleHQgeD0iMTEyIiB5PSIxMjEiIGNsYXNzPSJ0Ij4xPC90ZXh0PgogIDxyZWN0IHg9IjI4NSIgeT0iMTA0IiB3aWR0aD0iOTAiIGhlaWdodD0iMjQiIGNsYXNzPSJuIiAvPjx0ZXh0IHg9IjMwMCIgeT0iMTIxIiBjbGFzcz0idCI+KCAzLCA1ICk8L3RleHQ+CiAgPHJlY3QgeD0iNDcwIiB5PSIxMDQiIHdpZHRoPSIxMDAiIGhlaWdodD0iMjQiIGNsYXNzPSJuciIgLz48dGV4dCB4PSI0ODIiIHk9IjEyMSIgY2xhc3M9InQiPlsgMSwgMywgNSBdPC90ZXh0PgogIDxyZWN0IHg9IjY1MCIgeT0iMTA0IiB3aWR0aD0iNjAiIGhlaWdodD0iMjQiIGNsYXNzPSJuIiAvPjx0ZXh0IHg9IjY3MiIgeT0iMTIxIiBjbGFzcz0idCI+MDwvdGV4dD4KICA8cGF0aCBjbGFzcz0iZSIgZD0iTTMxMCwxMjggTDMwMCwxNTAiIC8+PHBhdGggY2xhc3M9ImUiIGQ9Ik0zNTAsMTI4IEwzNjAsMTUwIiAvPgogIDxyZWN0IHg9IjI3NSIgeT0iMTUwIiB3aWR0aD0iNDYiIGhlaWdodD0iMjIiIGNsYXNzPSJuIiAvPjx0ZXh0IHg9IjI5MyIgeT0iMTY2IiBjbGFzcz0idCI+MzwvdGV4dD4KICA8cmVjdCB4PSIzNDAiIHk9IjE1MCIgd2lkdGg9IjQ2IiBoZWlnaHQ9IjIyIiBjbGFzcz0ibiIgLz48dGV4dCB4PSIzNTgiIHk9IjE2NiIgY2xhc3M9InQiPjU8L3RleHQ+CiAgPCEtLSB0aW1lbGluZSAtLT4KICA8bGluZSB4MT0iNjAiIHkxPSIyMTQiIHgyPSI4MjAiIHkyPSIyMTQiIGNsYXNzPSJ0bCI+PC9saW5lPgogIDxyZWN0IHg9IjYwIiB5PSIxOTYiIHdpZHRoPSIxOTAiIGhlaWdodD0iMTgiIGNsYXNzPSJzZWciIC8+PHRleHQgeD0iMTM1IiB5PSIyMDkiIGNsYXNzPSJzIj4xICgxLzQpPC90ZXh0PgogIDxyZWN0IHg9IjI1MCIgeT0iMTk2IiB3aWR0aD0iOTUiIGhlaWdodD0iMTgiIGNsYXNzPSJzZWciIC8+PHRleHQgeD0iMjc4IiB5PSIyMDkiIGNsYXNzPSJzIj4zICgxLzgpPC90ZXh0PgogIDxyZWN0IHg9IjM0NSIgeT0iMTk2IiB3aWR0aD0iOTUiIGhlaWdodD0iMTgiIGNsYXNzPSJzZWciIC8+PHRleHQgeD0iMzczIiB5PSIyMDkiIGNsYXNzPSJzIj41ICgxLzgpPC90ZXh0PgogIDxyZWN0IHg9IjQ0MCIgeT0iMTk2IiB3aWR0aD0iMTkwIiBoZWlnaHQ9IjE4IiBjbGFzcz0ic2VnUiIgLz48dGV4dCB4PSI0NzgiIHk9IjIwOSIgY2xhc3M9InMiPjErMys1IOWQjOaZgiAoMS80KTwvdGV4dD4KICA8cmVjdCB4PSI2MzAiIHk9IjE5NiIgd2lkdGg9IjE5MCIgaGVpZ2h0PSIxOCIgY2xhc3M9InNlZyIgZmlsbC1vcGFjaXR5PSIwLjMiIC8+PHRleHQgeD0iNzAwIiB5PSIyMDkiIGNsYXNzPSJzIj5yZXN0ICgxLzQpPC90ZXh0PgogIDx0ZXh0IHg9IjYwIiB5PSIyNDAiIGNsYXNzPSJzIj7jg43jgrnjg4ggPSDopqrjgrnjg63jg4Pjg4jjga7nrYnliIbjgILmnKjjga/jgZ3jga7jgb7jgb7oqJjorZzjga7jg6rjgrrjg6Dmp4vpgKAo6YCj56ym44Gu5YWl44KM5a2QKeOBq+WvvuW/nOOBmeOCiyjoqK3oqIjljp/liYcgNjog6KiY6K2c5Y+v6YCG5oCnKTwvdGV4dD4KPC9zdmc+)

| 記法 | 意味 | 時間 | MIDI 実現 |
|----|----|----|----|
| `( )` | 時間分割(既存) | 親スロットを要素数で等分 | — |
| `[ ]` | スタック(同時発音) | 全要素が親スロット全長を共有 | 同時 note-on |
| `{ }` | レガートグループ | `( )` と同一の分割規則 | note-off を次の note-on の後に送る(オーバーラップ) |

- `[ ]` の各要素は**独立にサブツリーを展開できる**: `[1, (5, 3, 2, 1)]` = 度数1を保持しつつ同一時間内で 5,3,2,1 のラインが走る(一パート内ポリフォニー)。実装は TimedEvent 生成を要素ごとに並列再帰させる。
- `{ }` のオーバーラップ量は実装定義(推奨: 次 note-on の 10-30ms 後に note-off)。グループ末尾の音は通常の gate 規則に従う。
- `{ }` 内に `[ ]` がある場合、スタック全声部がオーバーラップ対象。

------------------------------------------------------------------------

## 5. Ties, Slurs, Voice Leading

### 5.1 Event-level tie: `_` (単独トークン)

直前イベントを 1 スロット延長(再トリガーなし)。ネスト内でも機能: `play(1, (_, 3))` = 度数1が 1.5 スロット。

- **スコープ境界をまたぐタイ**: 発音時に解決されたピッチを保持する(再解決しない)。II 上で発音した 9度(E)を V7 の小節頭まで延ばすと、その E は G7 上では結果的に 13 として響く——コモントーンの機能再解釈が定義から導出される。
- パターン先頭の `_` は「前サイクル末尾からの持ち越し」(LOOP 時)。RUN 一発目など先行音が存在しない場合は休符として扱う。

### 5.2 Voice-level tie: `_` 接頭辞(スタック内)

``` js
(0, [1, b3, _5, _b7], 0, m7).root(6)
```

- `_5` = 「解決後のピッチと同じ音がこのシーケンスで現在発音中なら note-off/note-on を抑制して延長、なければ通常発音」。
- 照合は**解決後ピッチの一致**で行う(前和音の声部位置との対応ではない)。声部数が異なる和音間でも意味が壊れず、ライブ差し替え時は発音側にフォールバックするため事故にならない。

### 5.3 `.hold()` — 自動コモントーンタイ

``` js
piano.hold()   // 連続するスタック間のコモントーンを自動でタイする
```

- 効果範囲は**スタック間限定**(単音の同音連打には適用しない。適用すると repeated note が全てタイになりリズムが消えるため)。
- 意味論は §5.2 の自動適用として定義する(基底仕様は増えない)。
- シーケンスレベルおよびグループレベル(`(...).hold()`)で指定可。

### 5.4 Slur

和音・旋律の滑らかな接続は `{ }` で表す。声部ごとに独立したグライド(voice-per-channel)は MPE の領域であり **v1.1 スコープ外**(v1.0 仕様の `mpe` フラグを将来の参照点とする)。

------------------------------------------------------------------------

## 6. Chord Values

``` js
var m7      = [1, b3, 5, b7]      // ルート未束縛の度数スタック(値)。bare [ ] が chord 値(#48)
var m7omit5 = [m7, -5]             // spread + 除去
var m7add9  = [m7, 9]              // spread + 追加
var so_what = [1, 11, b7^+1, b3^+1, 5^+1]
import chords                              // 標準ライブラリ: m7, maj7, dom7, m7b5, dim7, sus4, ...
```

- chord 値は play() / スタック内に置かれた時点のスコープ(root/mode)で解決される。コンテキスト(root)とは別物: root はコンテキスト、chord は値。
- **Spread**: スタック `[ ]` の中に chord 値を置くと展開される。定義サイト(`var x = [m7, 9]`)と使用サイト(`play([m7, 9], ...)`)で同一規則。
- **除去 `-`**: `-5` は展開後のスタックから**字面一致**する要素(`5`)を除去する。解決後ピッチでの照合は採用しない(`-3` が文脈依存になり予測不能なため)。一致要素が無い場合は no-op + warning diagnostic。
- `m7^+1` = スタック全体を 1 オクターブシフト(単音の `^` と同一文法のトークン修飾)。
- **コンテンツ構築**(構成音の追加・除去)はビルダー API(`.add()`, `.omit()`)を**採用せず**、すべて値合成(spread + `-` + 明示定義)で表現する。和音の**構成音そのもの**は値の領域。
- **ヴォイシング**(同じ構成音の**オクターブ配置**を組み替える操作: drop2 / 転回 / open / close 等)は別軸の抽象として後置演算子で提供する(§6.1、決定 \#49/#51)。当初は明示定義(`var m7drop2 = [5^-1, 1, b3, b7]`)のみとしたが、リードシートのヴォイシング再現が冗長になるため、**構成音を変えずに配置だけを上げ下げする**演算子を後から導入した。これらはコード名シンボルではない(構成音は依然として度数スタックの値)ため、設計原則5「コードシンボルを構文に持たない」と矛盾しない。

### 6.1 Voicing operators (E2)

``` javascript
[1,3,5,7].drop(2)      // 上から2番目の声部を1オクターブ下げる (drop2)
[1,3,5,7].drop(2,4)    // 上から2番目と4番目を下げる (drop2&4)
[1,3,5,7].invert(2)    // 下2声を1オクターブ上げる (転回)
[1,3,5,7].open()       // オープン: close の後、上から2番目を1オクターブ下げる
[1,3,5,7].close()      // クローズ: 全声部を最近接の昇順に詰める
[1,3,5,7].shell()      // シェル: ルート/3度/7度(ガイドトーン)のみ
[1,3,5,7].rootless()   // ルートを除く
m7.drop(2)             // コード変数にも適用可
```

- **決定論的・評価時・シンボリック**: 各演算子は per-voice `^N`(オクターブシフト)または声部フィルタへの糖衣であり、§7-0 のシンボリックピッチを保ったまま `.root()`/`.oct()` と合成する。実音へ解決してから動かすのではなく、度数+octaveShift のまま組み替える。
- **「上から N 番目」は構造順(記譜上の昇順)で数える**。`[1,3,5,7].drop(2)` は上から2番目の声部(5)を octaveShift −1 → 1, 3, 5<sub>−1</sub>, 7。`.invert(2)` は下2声(1, 3)を +1 する。
- **open / close**: `.close()` は全声部を1オクターブ内の最近接昇順に詰める。`.open()` = close した上で上から2番目の声部を1オクターブ下げ、ピッチ順に並べ直す(1オクターブ超のスパン)。
- **shell / rootless**: `.shell()` はルート・3度・7度のガイドトーンのみ残す。`.rootless()` はルートを除く。
- メソッド形・括弧必須(`.hold()` と同様)。`.drop(...)`/`.invert(n)` は位置引数を採り、それ以外は引数なし(余分な引数は diagnostic エラー)。声部数を超える位置(4声に `.drop(9)`)は warning + スキップ。
- ヴォイシングは per-voice の表現(`@v`/`@g`/`Xr`/`^r`)を温存する(配置を動かしても元のノートの修飾は失われない)。

### 6.2 Randomness: `Xr` / `.r` / `^r` (E2)

``` javascript
(1, 3, 5r, 7)       // Xr: その要素が確率的に鳴る or 休む(既定 0.5)
[1,3,5,7].r         // スタック間引き: 各声部が ~50% でこのサイクルに鳴る
[1,3,5,7].r(0.3)    // 間引き確率を指定(0..1。範囲外はエラー)
5^r                 // ^r: このサイクルのランダムオクターブ(±1)
```

- `r` は**1つのプリミティブ**で、付く位置によって意味が決まる: 要素直後 `Xr` = その要素の発音確率(既定 0.5)、スタック直後 `.r`/`.r(p)` = スタックの間引き、`^` と組んだ `^r` = ランダムオクターブ ±1。
- **ランタイム・サイクル毎に再抽選**: dispatch の各ループ反復で振り直す。`.orbslog` は実行記録であって結果の録音ではないため、再生時も振り直し、シードは持たない(決定 \#50/#52/#53)。
- **最小声部の保証はない**: `.r` は全声部が落ちて無音になるサイクルも許容する。
- 要素自身の `Xr` はスタックの `.r(p)` に優先する: `[1, 3r, 5].r(1)` は**度数 1 と度数 5** が常に鳴り(スタックの `.r(1)`=確率 1.0)、**度数 3** は自身の `3r`(0.5)に従う(test: `tests/midi/random.spec.ts`)。

### 6.3 Auto voice-leading: `.voicelead()` / `.vl()` (comp C1)

``` javascript
([1,3,5], [5,7,2]).voicelead()   // 連続コードを最小移動で再ボイシング(C→G で B が B3 へ降りる)
seq.voicelead()                   // シーケンス既定としても可(alias: seq.vl())
([1,3,5], [5,7,2]).vl()           // .vl() は .voicelead() の別名
```

- `.voicelead()`(別名 `.vl()`)は連続する**コード stack**を、直前のコードに対し**総声部移動が最小**(L1 / taxicab、Tymoczko)になるよう各声部のオクターブを置き直す。**構成音(ピッチクラス)は不変**でオクターブ配置のみ変わる。`.root()`/`.oct()` と同じスコープチェーン機構で、**グループ単位 `(...).voicelead()` と シーケンス既定 `seq.voicelead()` の両方**に付けられる。
- **決定論的・一度だけ計算**。ただし §6.1 voicing と違い**絶対ピッチ(root context)を要する**ため、eval 時ではなく**出力段で一度走る**(root context は dispatch で解決される)。結果は各声部の `octaveShift` としてシンボリックに書き戻され、\`^N\`(running range)・`.oct()`・`^r` はその上に加算される(§7-0 維持)。乱数間引き(`.r`/`Xr`)とは独立(VL は常にコード全体を見る)。
- 対象は **同一 onset の 2声部以上**(=コード)。単音はスルー(アンカーにもならない)。**最初のコード**は記譜どおりのオクターブに置かれ(アンカー)、以降のコードが直前から最小移動でリードする。各声部の記譜 `^N` オクターブは VL が**包摂**する(VL がオクターブ配置を担うため。`rangeSet` もクリアし running range を汚さない)。*注: onset でグループ化するため、`[1, (5,3,2,1)]` の held 音 + アルペジオ先頭音のような「同 onset の別声部」も1コードとして扱う(稀な併用)。*
- **声部数アルゴリズム**: 等数はソート後 n 通りの cyclic rotation の L1 最小(Tymoczko、MTO 16.1)。声部数不一致は C1 簡略化として min(n,m) 声部を lead し、余剰声部はオクターブ 0 のまま(完全な bipartite/doubling は C2+)。コモントーンは距離 0 で残るため自然に保持される(「crossing-free」はソート時の対応関係の性質で、各声部独立の octave-snap 後は絶対音高の順序が入れ替わりうる。ピッチクラスは常に不変)。
- **音楽性の限界(明示)**: L1 最小は**傾向音解決(導音・7→3)も並行5度/8度回避も保証しない**。本機能は「デフォルトで滑らか + 細部はユーザー制御」という位置づけで、傾向音や声部独立性が要るときは明示 degree / voicing operator で書く。

------------------------------------------------------------------------

### 6.4 Comping rhythm: `.comp()` / `.cell()` / `.density()` (comp C2a)

``` javascript
piano.midi("IAC", 1).octave(4)
piano.comp([1,3,5], [5,7,2])              // 1 引数 = 1 小節のコード。既定セル charleston で展開
piano.cell("quarters").comp([1,3,5])      // 名前付きセルを選択(charleston/redgarland/offbeats/quarters/twofour)
piano.density(0.6).comp([1,3,5])          // セル無しは density(0..1)で onset を生成(0=laying out)
piano.comp([1,3,5], [5,7,2]).voicelead()  // §6.3 と直交合成(コンプされた各コードがボイスリードされる)
```

- `.comp(c1, c2, …)` は**各引数を1小節ぶんのコード**として受け取り、コンピングのリズム**セル**で各小節を展開する**マクロ**。N 個のコード → N 小節(`length` は N に設定)。展開結果は**通常の play パターン**(`( )` 等分割の入れ子)なので、コード解決・タイミング・`.voicelead()` がそのまま合成される(パーサ変更なし。コンピングの*知能*=どのセル/ボイシングを選ぶかは DSL でなく LLM バンドメイト側スキルの担当 — comp C3 は DSL スコープ外)。
- **セルは meter 非依存の固定分割**: 各セルは固有のスロット数(Charleston=8, quarters/twofour=4)を持ち、その数だけ小節を**等分割**して onset スロットにコードを置く。スロット数を meter から導出しないため、偶数グリッドのセルを**奇数拍子に乗せると意図的なポリメーター**(例: 8-against-3)が小節単位で生まれる(バグでなく機能)。多層時間構造(各スロットをさらに `( )` 分割)と掛け算できる。meter は小節の**実時間長**だけを決め、セルは**何等分するか**だけを決める。
- **標準セル**(Jens Larsen / Freddie Green / Red Garland 由来): `charleston`(8分割, beat1 + 2&)・`redgarland`(8分割, 2& + 4&)・`offbeats`(8分割, 全ての裏)・`quarters`(4分割, 全拍 = flat-four)・`twofour`(4分割, beat 2 & 4)。未知のセル名は警告して density にフォールバック。
- **密度モード**: `.cell()` 未指定で `.density(d)` のみのとき、既定グリッド(8分割)に `round(d×8)` 個の onset を等間隔配置する(`d=0` は完全な無音 = laying out、`d=1` は全スロット)。`.cell()` と `.density()` の両方未指定の素の `.comp()` は `charleston` を既定とする。
- **音価は `gate` で制御**: off スロットは rest。各 stab は1スロットを `gate` 比で発音する(調査: 標準コンピングは Freddie Green 的に**歯切れよく短い**のが基本で、pad/legato の持続は別スタイル)。「空けば次の onset まで伸ばす」持続コンピングは将来オプション(タイ `_` 機構の上に乗る。密度連動の選択は LLM スキル側 = C3)。
- 対象は任意の play 要素(コード stack `[ ]` でも単音でも可)。単音はリズムだけが乗る(ボイスリードは §6.3 のとおり単音をスルー)。引数ゼロは警告して no-op。

------------------------------------------------------------------------

## 6.5 Repetition `*n` and Pattern Variables (ドメイン共通)

本節の機能は**リズム木の構造操作**であり、ピッチ意味論に依存しない。MIDI シーケンスと audio シーケンス(値=スライス番号)の両方で同一に機能する。

### 6.5.1 反復 `*n`

``` js
x*n  ≡  x を n 回並置したもの
```

- x が裸のイベントの場合は単元グループ `(x)` とみなす: `1*3` ≡ `(1)(1)(1)`。
- **カンマへの書き換えではなく並置への書き換え**である(カンマは root スコープ境界のため)。したがって `riff*4.root(3)` は4回分すべてに root が掛かる。
- `n` は整数 1 以上。`*0` は diagnostic エラー、`*1` は恒等。
- 後置演算子(`*n`・メソッドチェーン)は左から右に適用: `(a)(b).root(2)*2` = ルート付きセル全体の2回反復(合法)。
- audio 例: `kick.play((1, 0, 1, 0)*4)` = 4小節分の反復を1グループで記述。

> **TidalCycles との相違(要ドキュメント明記)**: Tidal の `*` はスロット内分割(同一スロット内で n 回=速度 n 倍)、スロット占有の反復は `!`。OrbitScore の `*n` は**スロットを n 個占有する反復**(Tidal の `!` 相当)。スロット内反復が必要な場合はネスト `(1, 1)` で書く。

### 6.5.2 パターン変数

``` js
var riff = (1, 0, (3, 5), 7)            // 裸タプル束縛。コンストラクタ不要
var fill = (7, (5, 3), 1, 0)
var A    = (1, 0, 5, 0).root(3)          // チェーン込みの束縛も値として合法
var AA   = (1, 0, 5, 0)(0, 5, 1, 0)      // 並置の束縛 → 使用箇所に複数兄弟としてスプライス

seq.play(riff*3, fill)
seq.play(A, A, riff.root(6), fill.root(5))
```

- **評価時値渡し**: 変数の置換は `play()` の評価時点で行われる。`riff` を再定義しても、走行中のパターンには影響せず、`play()` 行の再実行で反映される。リアクティブ束縛(再定義の自動伝播)は採用しない(quantize との相互作用と暗黙状態の増加を避ける)。
- 変数が単一グループなら1スロット(トップレベルなら1要素)を占有、並置なら複数兄弟としてスプライス。
- chord 値(§6)との区別: chord はスタック(縦)の値、パターン変数はツリー(横)の値。どちらも play() 内で参照される値だが型が異なる。

### 6.5.3 Section variables (E4)

``` javascript
var A = (1, 0, 5, 0), (5, 0, 1, 0)   // トップレベルのカンマ = セクションのセル区切り(2小節)
var B = (1, 0).root(3), (5, 0)       // セルごとに .root() 等のチェーンも付けられる
seq.play(A, A, B, A)                  // AABA の楽曲フォームを書く
```

- パターン束縛(`var`)の**トップレベルのカンマ**は、複数小節からなる**セクション**のセル区切りとして解釈する(§6.5 Q2 を \#254 で改訂)。`var A = (bar1), (bar2)` は2つのセルを持つ。
- 使用箇所では各セルが**兄弟としてスプライス**される: `play(A, A, B, A)` は `A` の各セルを展開して AABA 構造を書く。
- カンマは(`play()` 内と同様に)直前の root スコープ並置ランを終端する。各セルは独自の `.root()`/`.mode()` チェーンを持てる。

------------------------------------------------------------------------

## 7. MIDI Realization Rules

0.  **Symbolic pitch preservation (記譜対応の前提)**: TimedEvent パイプラインは**シンボリックなピッチ情報(度数・変化記号・octave shift・解決に用いた root/mode コンテキスト・タイ/レガート属性)を保持**し、MIDI ノート番号への解決は MIDI 出力アダプタの最終段でのみ行う。解決済みノート番号だけを流す設計は禁止。理由: 度数表記は音名スペリング(D#/Eb の区別)・タイ・スラーを一意に保存しており、将来のリアルタイム譜面生成エピック(人間奏者の駆動。本仕様のスコープ外)がこの情報に依存する。MIDI 番号化した時点でこれらは不可逆に失われる。
1.  **Note lifecycle**: 各イベント → note-on(vel)、`slotDuration * gate` 後に note-off。tie は note-off/on ペアの抑制、legato は note-off の遅延。
2.  **Active note tracking**: シーケンスごとに発音中ノート(pitch, channel)を追跡。以下で確実に解放する:
    - `LOOP()` からの除外・`MUTE()`・`play()` 差し替え時: 当該シーケンスの保留ノートに note-off
    - `global.stop()` / エンジン終了 / クラッシュハンドラ: 全チャンネルに CC123 (All Notes Off) + CC120 (All Sound Off)
3.  **Quantize との関係**: 既存仕様(§5 quantize)に従う。`play()` 差し替えが quantize 待機する間も現行パターンのノートは正常に off される。
4.  **Scheduling**: TS 側 lookahead スケジューラ(RtMidi は即時送信のみのため)。推奨 lookahead 50-100ms、タイマー駆動 + ドリフト補正。`global.midiLatency()` を送出時刻に加算。
5.  **Detune `~`**: ピッチベンドで実現。同チャンネル同時発音中の異デチューンは不可(warning)。本格対応は MPE(スコープ外)。

**出力アダプタへの適用(#425)**: 本節の realization rules は MIDI 出力に限らず、任意の note 出力アダプタ(plugin instrument 経路を含む)に適用される。plugin 経路の置換規則: CC123/CC120 は使えないため All Notes Off = active note の列挙 → note-off の逐次送出。detune `~`(rule 5)は pitch bend 経路がないため v1 では実現不能(warn + skip)。rule 0 のシンボリックピッチ保持は plugin 出力アダプタにもそのまま適用される。

------------------------------------------------------------------------

## 8. Out of Scope (v1.1)

- MPE / voice-per-channel グライド
- per-event **絶対長さ**修飾(v1.0 の `@U` 系) — 引き続き非対応(#41。長さはリズム木+タイが持つ)。*※ per-note ベロシティ `@v` / アーティキュレーション `@g` は v1.1 で実装済み(§2.5)。*
- CC / Program Change 出力(ROADMAP には記載あり。v1.1.x で追加)
- 8音以上のコレクションでの mode テンション規則(当面 root スコープ + b/# で書く)
- VST/AU ホスティング(v3.0+ \#95) — **scope 移管(#425)**: plugin hosting の DSL 構文(CLAP effect/instrument)は core spec `INSTRUCTION_ORBITSCORE_DSL.md` の Plugin Hosting 節が正本(本仕様のスコープ外のまま)
- MIDI 入力

------------------------------------------------------------------------

## 9. Examples (normative reference)

### 9.1 3-6-2-5, 1 chord/bar, key C

``` js
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.key("C")
global.start()

import chords

var piano = init global.seq
piano.midi("IAC Driver Bus 1", 1).octave(4).gate(0.7)
piano.length(4)
piano.play(
  (0, m7, 0, m7).root(3),
  (0, [1, b3, _5, _b7], 0, m7).root(6),
  (0, [m7, 9], 0, [m7, 9]).root(2),
  ([1, 3, b7, 13], 0, 0, [1, 3, b7, b13]).root(5),
)

var bass = init global.seq
bass.midi("IAC Driver Bus 1", 2).octave(2).gate(0.9)
bass.length(4)
bass.play(
  (1, 0, 5, 0).root(3),
  (1, 0, 5, 0).root(6),
  (1, 0, 5, 0).root(2),
  (1, 0, (5, b5), 0).root(5),
)

var lead = init global.seq
lead.midi("IAC Driver Bus 1", 3).octave(5).vel(96)
lead.length(4)
lead.play(
  (5, _, (b3, 1), b7).root(3),
  (1, _, {9, 1, b7}, 5).root(6),
  (9, 11, 9, _).root(2),
  (_, 13, (3, 9), 1).root(5),
)

LOOP(piano, bass, lead)
```

### 9.2 2小節1コード(並置 + root 共有)

``` js
piano.play(
  (0, m7, 0, m7)(0, m7, [_1, _b3, 5], 0).root(3),
  (0, m7, 0, m7).root(6),
)
```

### 9.3 ユーザー定義モード

``` js
var holdsworth1 = mode(1, 2, b3, 4, #5, 6, 7, 9, #11, b13, 7^+1)
lead.mode(holdsworth1)        // シーケンス既定として
lead.play((1, 4, 8, 11), (9, _, 5, 2))
```

### 9.4 ポリメーター × ハーモニックリズムの干渉(MLTS 拡張)

``` js
bass.beat(7 by 8)   // bass のコードチェンジは自身の 7/8 小節構造に従い、
                    // 4/4 の piano とは位相がずれて周期的に干渉する
```

------------------------------------------------------------------------

## 10. Open Questions (実装中に確定)

1.  `(1)(2)` 並置の現行パーサー挙動の確認(§3.3 の前提)。兄弟展開でない場合は並置意味論の定義から着手。
2.  `{ }` オーバーラップ量の既定値(リスニングテストで決定)。
3.  ~~mode の `period()` 推定規則の境界ケース(最終要素が `^`/`~` 修飾を持つ場合)~~ → **確定(E6)**: 格子の最大半音位置を基準に次オクターブ境界へ切り上げ、非昇順・基音以下の要素があっても最低1オクターブを保証(`mode(1, 7^-1)` → period 12。§2.2)。
4.  `import chords` の名前空間設計(グローバル束縛か `chords.m7` か)。当面はグローバル束縛 + 衝突時 warning を推奨。
5.  ~~括弧のドメイン非依存性~~ → **確定(2026-06-12)**: audio シーケンス内の `[ ]` は v1.1 では **diagnostic エラーとして予約**する(“not yet supported in audio sequences”)。黙って無視せずエラーにすることで構文を予約し、将来の開放(複数スライスの同時トリガー=レイヤリング)を純粋な追加変更にする。GitHub Issue 化して先送り。関連 Issue として、トランジェント検出ベースの `slice()`(等分 `chop` に対するアタックポイント分割)も別途起票し相互参照する(`[ ]` audio 開放と組み合わせるとスライスレイヤリングが可能になるため)。
