# Research + Design Draft: `.comp`（自動コンピング）と auto voice-leading

## メタ

- **ステータス**: 🟡 **設計ドラフト（pre-decision / 提案）**。これは確定仕様ではない。本ドキュメントの結論は `DESIGN_DISCUSSION_RECORD.md` の確定決定（#1-59）ではなく、**ユーザーレビュー前の提案**である。合意後に正本（specs-v2）へ昇格する。
- **日付**: 2026-06-14
- **関連**: Epic #224 / #259（`.comp` feature）/ #257（E2 voicing primitives, merged）/ 第六議論（DESIGN_DISCUSSION_RECORD §12）
- **優先度**: `.comp` は **WCTM(2026-08-07) のクリティカルパス外**。マクロ順は Pitch DSL（完了）→ `.orbslog`(#229) → WCTM。本ドラフトは「設計を先に練る」ための探索であり、実装着手の合図ではない。
- **調査方法**: WebSearch/WebFetch による3並列リサーチ（コンピングのリズム＋先行ソフト / ジャズボイシング＋音域 / ボイスリーディング理論＋アルゴリズム）。各主張は出典付き（Part 3）。証拠の薄い箇所は明示。

---

## Part 1 — 調査エビデンス

### 1.1 コンピングのリズム（「いつ弾くか」）

**二軸モデル（設計の鍵）**: コンピングのリズムは2つの独立した格子への配置として理解できる。

1. **メトリック格子**: 小節内の拍位置（Charleston, 2&4, off-beat 等）。「絶対位置でいつ鳴らすか」
2. **コード変更格子**: コード変更点からのオフセット。**アンティシペーション** = コード変更より 8分音符 1つ（−0.5 拍）早く先置き

実演はこの2軸の組合せ（例: 「Charleston をメトリック格子で弾き、各コードはアンティシペーションで半拍早く入る」）。

**標準リズムセル（語彙）**（Jens Larsen 他）:

| セル | 4/4 内の位置 |
|---|---|
| Charleston | beat 1 + 2& |
| Shifted Charleston | 全体を 8分後ろへ |
| Red Garland | 2& と 4&（裏拍専念、ダウンビート省略）|
| Quarter stabs | 表拍 2 / 4（Freddie Green 系）|
| Anticipated 4 | 次コード直前の 4& |

各セルはスイング8分グリッド上の **ON/OFF ビットマスク（8bit/bar）** として表現できる。

**スイング比**: 等分でなく長-短（≈ 1.5:1〜1.7:1、第1音が約 58–63%）。テンポ依存（速いほど straight に近づく）。「正解値」は単一でなく演奏者/テンポ依存（証拠は範囲合意のみ）。

**密度とスペース**: 密度はソリストの活動量に反比例（busy なら sparse、間があれば fill）。"laying out"（完全に弾かない）は一等の選択。2〜4小節ごとに戦略を変えるのが優れたコンピング。

**先行ソフト**:
- **iReal Pro / Band-in-a-Box**: スタイル駆動。BiaB はサンプルベース（RealTracks）で生成ではない。内部アルゴリズムは非公開。
- **TidalCycles / Strudel**: live coding で最も近い。**ランダムは「サイクル時刻の純関数」として決定論的**に実装され、同じコードは同じ出力を再現（バリエーションは時間シフトで作る）。ただしジャズコンピング専用の語彙は無い。
- **学術（RNN 等）**: リズム生成が弱点として明示されている。現状はルールベース + セルライブラリの方がコントローラブル。

### 1.2 ジャズ・ボイシング

**Rootless voicings（モダンジャズの中核）** — Bill Evans 系。ルートを省き上位4声を左手に収める。A形/B形が交替して内声移動を最小化（下から）:

| Chord質 | A形 | B形 |
|---|---|---|
| Maj7 | 3–5–7–9 | 7–9–3–5 |
| Dom7 | 3–**13**–b7–9 | b7–9–3–**13** |
| Min7 | b3–5–b7–9 | b7–9–b3–5 |
| m7b5 | b3–b5–b7–**R**（ルート復活）| b7–R–b3–b5 |

> **重要**: Dom7 では **5度が13度に置換**される（単なる省略でない）。m7b5 の "rootless" は事実上**ルートを含む**例外。→ 「rootless = ルート除去」だけでは jazz の rootless にならない。

**その他のファミリー**:
- **Shell**: root + 3rd + 7th（ガイドトーン）。度数フィルタ {1,3,7} で生成 = 既存 `.shell()` に対応。
- **Drop2/Drop3**: クローズポジションから上から N 番目を 1 オクターブ下げる（既存 `.close()`→`.drop(n)` パイプラインに対応）。
- **Quartal / "So What"**: 4度積み（P4–P4–P4–M3）。3度積みからは導出不可 → **新 constructor が必要**。
- **Upper Structure Triad**: 左手トライトーン {3,b7} + 右手トライアド。shell + triad の合成として表現可能。

**音域 / Low Interval Limit**: 低音域で濁る音程下限がある（minor 3rd は概ね **C3 以下で濁る**等）。Rootless の実用域は左手最高音が **C4–C5**、A2 以下は muddy。

**選択ヒューリスティクス**: ①ボイスリーディング最小化（最優先）②音域制約（LIL 違反を除外）③機能・密度に応じたファミリー選択（バンド=rootless / ベースソロ中=shell / モーダル=quartal / 高テンション=UST）④ii-V-I は A↔B 形の自動交替（3rd↔7th の交換で機械的に保証）。「ソリスト音域との連動」は定量アルゴリズムの公開文献が乏しく**証拠薄**。

### 1.3 ボイスリーディング

**古典原則**: 最小移動 / コモントーン保持（共有音は同一声部に残す＝変位ゼロ）/ 反行運動の選好 / 並行完全5度・8度の禁止 / 傾向音の解決（導音→主音、和音7度→次コード3度へ半音下行、V7 の三全音解決）。

**ジャズのガイドトーン・ライン**: 各コードの3度と7度が骨格。ii-V-I で「7度 → 次コードの3度（半音下）」の役割交替を繰り返し半音下行連鎖を作る。MTO 25.2（Smither）はガイドトーン空間を「総変位 ≤ 4半音、各声部 ≤ ic2」として形式化。

**アルゴリズム的定式化**: Tymoczko の幾何学で和音を点とし、ボイスリーディング距離 = **L1（各声部の半音変位の絶対値の総和、taxicab）**。等カーディナリティの最小VLは:

1. 両和音を半音高さでソート
2. n 通りの巡回シフト（cyclic rotation）の cost をそれぞれ計算
3. 最小の rotation を採用（crossing-free 性により n! でなく n 通りで最適）

> 証拠強度: L1 メトリックは MTO 16.1 で確認（中）。cyclic-rotation の peer-reviewed 一次資料には届かず（**薄**）。実装規模は小（〜8声）なので総当たり/greedy で十分。

**声部数不一致**: 古典では「ルート倍加 / 5度省略」。アルゴリズムでは phantom voice 追加 or 余剰声部 rest 化、一般には非バランス二部マッチング。

**Neo-Riemannian (P/L/R)**: 三和音間の最小変換（2音保持・1音移動）。三和音専用で7thには直接拡張不可。Tymoczko は「common-tone 保持を VL 効率より優先する」点を批判。

---

## Part 2 — 設計提案（pre-decision）

### 2.1 アーキテクチャの背骨: 既存の2軸に各サブモデルを載せる

OrbitScore は既に **eval-time・シンボリック**（§12.3 voicing）と **dispatch-time・確率的**（§12.4 randomness）の分離を持つ。`.comp` の各部品をこの軸に明示的に配置する:

| サブモデル | 軸 | 既存対応 |
|---|---|---|
| ボイシング選択（`.lead()` 経由） | **eval-time・シンボリック** | §6.1 voicing と同契約 |
| オクターブ散らし / thinning | **dispatch-time・確率的** | 既存 `.r` / `^r` |
| **リズム生成** | **dispatch-time・確率的（毎サイクル）** | （新規。下記 2.4）|

これにより緊張「構造=リズムはユーザが書く ↔ `.comp` が自動生成」は**解消**する: `.comp` がリズム木へ展開するのは `*n` や chord-spread が eval 時に構造へ展開するのと**同じ機構**であり、展開結果は依然として具体的なツリーになる。「構造=リズム」原則は破られない。`.orbslog` での freeze/編集は nice-to-have（load-bearing な正当化ではない）。

**リズムの「2段」モデル（2.1 ↔ 2.4 の橋渡し）**: 上表で「リズム生成 = dispatch-time・確率的」と書いたが、これは `.comp` 全体が dispatch でツリーを組むという意味ではない。既存 `.r` の**二段構造をそのまま踏襲**する:
- 既存 `.r`: `.r` 付きスタックは **eval 時に確定**（ツリー固定）し、**dispatch で毎サイクル間引きを再ロール**。
- `.comp`: **eval 時に「確率的 subdivision ノードを持つ具体的なリズム木」へ展開**（ここまでは `*n`/spread と同じ eval 時展開 ＝「構造=リズム」は保たれる）し、**dispatch がどの subdivision を発音するかを毎サイクル実現**する。

したがって §2.1（dispatch・確率的）と §2.4（subdivision の dispatch-time 可変）は矛盾せず両立する。両者を繋ぐのがこの2段モデルで、C2 の実装上の重心は「dispatch が *subdivision の有無そのもの* を実現できるか」に置かれる（下記 2.4）。

### 2.2 機能① `.lead()` — auto voice-leading（決定論・即設計可能）

**位置づけ**: §6.1 voicing operators と**同契約**の決定論的・eval-time・シンボリック変換。ただし単一スタックでなく**連続するスタック列**に作用する（直前ボイシングを文脈に取るため、play() レベル / シーケンスレベルの演算子）。

**アルゴリズム**（各スタック境界で）:
1. 直前スタックを半音に解決（§2.1 `resolve()`）
2. 次スタックをベースオクターブ（`^0`）で解決
3. 等カーディナリティ: ソート後 n 通りの cyclic rotation の L1 を評価し最小を選択 / 不一致: 二部マッチング（小規模なので総当たり可）
4. 選択された割当で各声部の半音変位が最小になるよう個別に `^N`（octaveShift）を付与
5. **出力は degree + `^N` のシンボリック表現**（実音へ解決して戻さない。§7-0 整合）

**重要な実装判断**:
- **計測はセミトーン、出力はシンボリック**: 度数は等間隔でない（IONIAN = [0,2,4,5,7,9,11]）ため、度数空間で最小化しても音高空間で最小にならない。必ず resolve 後のセミトーンで L1 を測る。
- **`.hold()` との関係**: `.hold()`（§5.3 コモントーン自動タイ）で保持される声部は **octaveShift=0 の hard constraint** としてオプティマイザに渡し、残り声部のみ最小化（`.hold()` が優先）。
- **`.root()` スコープとの関係**: 前後で `.root()` が異なると同じ度数でも別ピッチに解決される。よってコモントーン判定は**度数でなく解決後セミトーン**で行う。`^N` は `.root()` をまたいでもリセットしない（§2.4 確定）。

**正直な限界（明示すべき）**: 純粋な L1 最小化は §1.3 の古典原則を**保証しない**:
- 並行5度・8度を生み得る
- 傾向音解決（導音、7→3）を保証しない
- 反行運動を選好しない

→ `.lead()` は「**デフォルトで滑らか**（机上のスムーズさ = L1 最小）」の補助機能と位置づけ、傾向音解決等の音楽的要請はユーザーが明示 degree / voicing operator で制御する。これは OrbitScore の「ユーザー制御が主役・自動作曲ではない」哲学と整合する。

**命名候補**: `.lead()` は "lead voice / lead sheet" と紛らわしい。代替: `.voicelead()` / `.vl()`。→ ユーザー判断。

### 2.3 機能② `.comp` — 生成マクロ

3つの直交サブモデルの合成:

**(1) リズム生成** — *推奨: mode と同形のハイブリッド*。
- **subdivision グリッド primitive**: 小節のスイング8分グリッド（8 スロット/4-4）各位置に発音確率 [0,1] を割り当てる低レベル表現。
- **名前付きセルのライブラリ**: Charleston / Red Garland / quarter-stab 等を「グリッドへコンパイルされる var 群」として提供（教会旋法を `mode(...)` のライブラリ var として提供したのと**同じ形**）。
- パラメータ: `style`（セル語彙 + デフォルトのバンドル）/ `density`（0=laying out 〜 1）/ `swing`（0.5=straight 〜 ~0.65）/ `anticipate`（コード変更からのオフセット、既定 −0.5 拍）。
- **決定論モデルは #53 に従う**: seed なし・毎サイクル再ロール・再現は `.orbslog`。（Tidal 流の seed 付き純関数は魅力的だが、採用するなら**決定 #53 の再検討が必要**。本ドラフトでは #53 準拠を既定とし、seed は «#53 再検討を要する提案» として保留。）

**(2) ボイシング選択** — `.lead()`（2.2）と voicing primitives の上に乗る **stateful selection policy**:
1. 直前ボイシングを state として保持
2. 次コードの候補（rootless A形/B形, shell, 等）を列挙
3. LIL / target register 制約で候補を絞る
4. 直前との L1 最小の候補を選ぶ（ii-V-I の A↔B 交替はここから自然に導出）

**(3) オクターブ散らし / thinning** — 既存 `.r` / `^r` を再利用（dispatch-time）。

`.comp` のパラメータ面（暫定）: `style`, `density`, `swing`, `anticipate`, `register`（音域）, `voicing`（rootless/shell/quartal/auto）。

### 2.4 真に新しいアーキテクチャの一点（要注意）

2段モデル（2.1 の橋渡し）のうち、**eval 時の展開**は `*n`/spread と同種で新規性はない。新規なのは **dispatch 段が *subdivision の有無そのもの* を実現する**点である: `.r`/`^r` は**固定された subdivision の上で** presence/octave だけを毎サイクル振っていたのに対し、`.comp` では「ある subdivision を鳴らすか否か」が dispatch で変わる（発音される音の数だけでなく、リズムの割り方自体が毎サイクル動く）。これが本機能の唯一の真の新規アーキテクチャ点。実装時はここに設計の重心を置く（dispatch パイプラインが eval 展開済みの確率的 subdivision ノードを毎サイクル実現できるか、`.orbslog` が実現後の具体リズムをどう記録するか）。

### 2.5 `.rootless()` primitive ≠ jazz rootless voicing（明確化、コード修正ではない）

- マージ済みの `.rootless()` は「**ルートを構造的に除去する**」primitive として**正しく内部整合している**（spec も問題なし）。
- 一方 jazz の "rootless voicing"（A/B形、Dom7 の 5→13 置換、m7b5 のルート復活）は**上位レイヤーのテンプレート**であり primitive ではない。
- 設計方針: **primitive はそのまま**、jazz rootless は `.comp` のボイシング選択層 / chord ライブラリの**名前付きテンプレート**（例 `rootlessA(quality)` 等、または chord ライブラリ var）として提供する。`.rootless()` primitive を jazz rootless と取り違えないようドキュメントで明示（footgun 回避）。
- Dom7 の 5→13 のような度数置換が要るため、テンプレート層には «度数置換 `.sub(old,new)»` のような補助操作が要るかもしれない（要検討、新 primitive 候補）。

### 2.6 段階的スコープ（shippable に分割）

| 段階 | 内容 | 依存 | 性質 |
|---|---|---|---|
| **C1** | `.lead()` auto voice-leading（決定論・eval-time・シンボリック）| 既存 §6.1 + resolve() | 定義明確・即実装可・単独で有用。**別 issue 候補** |
| **C2** | リズムエンジン（subdivision グリッド primitive + 名前付きセル + density/swing/anticipate）| dispatch パイプライン拡張（2.4）| 設計面積大・真の新規点 |
| **C3** | 完全 `.comp` = ボイシング自動選択（rootless A/B 等）+ C2 リズム + thinning の合成 | C1 + C2 | selection policy |

`.lead()`(C1) は `.comp` 全体と切り離して単独で価値があり、独立 issue にできる。→ ユーザー判断。

---

## Part 3 — 未決事項（ユーザー判断 / 次の設計対話）

1. **段階分割の是非**: C1 `.lead()` を独立 issue として先に進めるか、`.comp` 一括設計にするか。
2. **命名**: auto voice-leading は `.lead()` / `.voicelead()` / `.vl()` のどれか。
3. **リズムモデル**: 「subdivision グリッド primitive + 名前付きセル ライブラリ」のハイブリッド推奨でよいか。
4. **seed**: コンピングのバリエーション再現に seed を導入したいか（導入するなら決定 #53 の再検討が必要）。本ドラフトは #53 準拠（seed なし）を既定とする。
5. **ボイシング選択の自動性の範囲**: どこまで自動（rootless A/B 自動交替）にし、どこからユーザー明示にするか。「ソリスト音域連動」は証拠薄のため当面スコープ外を提案。
6. **`.lead()` の音楽性限界**の許容: L1 最小は傾向音解決・並行回避を保証しない。これを「デフォルト滑らか + ユーザー制御」で割り切る方針でよいか。
7. **呼び出し / 入力面**: `.lead()` / `.comp` を**どう attach するか**（`seq.lead()` シーケンス既定か、`play(...).lead()` グループ単位か）、および**何をコード列として thread するか**。旋律と和音が混在するツリー（`value=content`、melody-vs-chord の型区別）で、どの要素が voice-leading / コンピングの対象になるか（スタック `[ ]` のみ? 単音はスキップ?）。実装者・ユーザーが最初に問う点だが Part 2 で未確定。

---

## Part 4 — 出典

### コンピングのリズム / 先行ソフト
- Jens Larsen — [7 comping rhythms](https://jenslarsen.nl/jazz-chords-the-7-comping-rhythms-that-really-matter/) / [10 examples](https://jenslarsen.nl/comping-rhythms-10-examples-you-need-to-know/)
- [Comping (jazz) — Wikipedia](https://en.wikipedia.org/wiki/Comping_(jazz))
- [The Jazz Piano Site — How to Comp](https://www.thejazzpianosite.com/jazz-piano-lessons/jazz-chord-voicings/how-to-comp/)
- [Jazz Library — Comping guide](https://jazz-library.com/articles/comping/)
- [Csound Journal — Swing](https://csoundjournal.com/issue21/swing.html) / [Open Music Theory — Swing](https://viva.pressbooks.pub/openmusictheory/chapter/swing-rhythms/)
- [TidalCycles — Randomness](https://tidalcycles.org/docs/reference/randomness/) / [Strudel — Random Modifiers](https://strudel.cc/learn/random-modifiers/)
- [Frontiers AI — RNN Jazz Accompaniment](https://www.frontiersin.org/journals/artificial-intelligence/articles/10.3389/frai.2020.508727/full)
- [Band-in-a-Box manual Ch.7](https://www.pgmusic.com/manuals/bbw2022full/chapter7.htm)

### ジャズ・ボイシング / 音域
- [The Jazz Piano Site — Rootless](https://www.thejazzpianosite.com/jazz-piano-lessons/jazz-chord-voicings/rootless-voicings/) / [PianoGroove — Rootless](https://www.pianogroove.com/jazz-piano-lessons/rootless-chord-voicings/) / [Piano With Jonny — Rootless complete](https://pianowithjonny.com/piano-lessons/rootless-voicings-for-piano-the-complete-guide/)
- [freejazzlessons — Dom7 rootless (5→13)](https://www.freejazzlessons.com/jazz-piano-chords-rootless-voicing/)
- [The Jazz Piano Site — So What Chord](https://www.thejazzpianosite.com/jazz-piano-lessons/jazz-chord-voicings/so-what-chord/) / [Upper Structures](https://www.thejazzpianosite.com/jazz-piano-lessons/jazz-chord-voicings/upper-structures/)
- [Piano With Jonny — Drop 2](https://pianowithjonny.com/piano-lessons/drop-2-piano-voicings-the-complete-guide/) / [Learn Jazz Standards — Drop 2](https://www.learnjazzstandards.com/blog/drop-2-voicings/)
- [filmmusictheory — Low Interval Limit](https://filmmusictheory.com/article/what-is-a-low-interval-limit/) / [Sweetwater — LIL](https://www.sweetwater.com/insync/low-interval-limit/) / [earldmacdonald — LH voicings range](https://www.earlmacdonald.com/jazz-piano-lessons/rootless-left-hand-piano-voicings/)
- [Open Music Theory — Jazz Voicings](https://viva.pressbooks.pub/openmusictheory/chapter/jazz-voicings/)

### ボイスリーディング理論 / アルゴリズム
- [Music Theory Authority — Voice Leading Principles](https://musictheoryauthority.com/voice-leading-principles/) / [Fiveable — Voice Leading Rules](https://fiveable.me/lists/voice-leading-rules)
- [Learn Jazz Standards — Voice Leading 101](https://www.learnjazzstandards.com/blog/voice-leading/) / [Piano With Jonny — Guide Tones](https://pianowithjonny.com/piano-lessons/guide-tones-piano-the-complete-guide/)
- [MTO 25.2 — Smither, Guide-Tone Space](https://mtosmt.org/issues/mto.19.25.2/mto.19.25.2.smither.html)
- [MTO 16.1 — Tymoczko, Geometrical Methods (L1/taxicab)](https://mtosmt.org/issues/mto.10.16.1/mto.10.16.1.tymoczko.html)
- [Lucio Cornejo — A glimpse into Voice Leading (cyclic rotation)](https://lucio-cornejo.github.io/post/a-glimpse-into-the-world-of-voice-leading/) / [arxiv:1508.05833 — Bergomi et al.](https://arxiv.org/abs/1508.05833)
- [Open Music Theory — Neo-Riemannian](https://viva.pressbooks.pub/openmusictheory/chapter/neo-riemannian-triadic-progressions/) / [Wikipedia — Neo-Riemannian](https://en.wikipedia.org/wiki/Neo-Riemannian_theory)
- [University of Puget Sound — Doubling Rules](https://musictheory.pugetsound.edu/mt21c/SummaryOfDoublingRules.html) / [Berklee Online — Voice Leading Paradigms](https://online.berklee.edu/takenote/voice-leading-paradigms-for-harmony-in-music-composition/)
