# 設計書: ラック形チェーンの gated E2E（#628 監査 F9 の充填）

- 起案: Fable（設計担当・2026-08-28）
- 対象: PR #639 の gated E2E 欠落 — **配列記法・N≥2 直列・標準 `Gain` が実機で一度も評価されていない**
  （実測: `orbitstudio-mcp-gated.spec.ts` 内の配列形は `fx625.effect([])` の 1 箇所のみ・`Gain(db` は 0 件）
- 正本: `docs/design/628-rack-chain-implementation-design.md` §6（R28-E1〜E10）と §1 完了条件 1 / 13 / 15
- 実装担当への注意: **本書はテスト設計のみ。並行機構を新設しない。** 積み先は既存の
  `tests/e2e/orbitstudio-mcp-gated.spec.ts`（`describe.skipIf(!gated)` 配下 = `ORBIT_GATED_ORBITSTUDIO=1`
  未設定なら自動 skip）。実装が本書から逸脱する必要が生じたら本書を先に更新する。

---

## 0. 前提（実ファイルで確認済みの現状）

| | 事実 | 根拠 |
|---|---|---|
| ハーネス | 1 回のアプリ起動を suite 全体で共有（`client` / `tmpRoot` / `workAudioDir` を後続 `it` が再利用） | `orbitstudio-mcp-gated.spec.ts:2576-2586` |
| 音のオラクル | `start_engine { capture_wav }` → 壁時計区間 → `analyzeWavBuffer(windowMs:100)` → 両端 400ms ガード付き区間 RMS → 比率 assert（許容 15%） | `:2634-2957`（`captureSegment` / `SEGMENT_GUARD_SEC` / `withinTolerance`） |
| gain オラクル | CLAP / VST3 の gain effect（state = `ORE1` magic + f64 LE・identity ごとに project.yaml へ事前登録） | `:2590-2632` |
| PID オラクル | daemon の spawn INFO 行から読む（rack child は `--plugin` を持たないため）。**比較は最新 1 個のみ** | `:186-232`（`rackChildPidsFromLog`） / `outproc_effect.rs:659` |
| ERROR 計数 | `<=` 比較のみ（`get_log` は固定 500 行窓で古い ERROR が押し出されるため厳密等価は禁止） | `:2690-2696` の教訓コメント |
| state 復元 | `[plugin-state] restoring '<identity>'` の**件数増加**を待つ（includes は過去分に誤マッチ） | `:2806-2836` |
| 実行時間 | `#625 R-E1〜R-E7` = 7 区間 + master 節で `TEST_TIMEOUT_MS(120s) * 2` 枠 | `:3111` |
| 既知の非対応 | 既存 3 failed は `UI_CLOSED_DONE` タイムアウト（#633 の範囲） | PR #639 本文 |
| `Gain` の CI 現状 | **`db_to_linear` の数理は既に ubuntu CI が守っている**（§5 で詳述） | `orbit-std-gain/src/lib.rs:315-360` + `rust-ci.yml` |
| ignored 実 Gain テスト | c05/c13/c14 は `#[ignore = "requires bundle-macos.sh"]` **かつ** `#[cfg(target_os="macos")]` — ubuntu CI では原理的に走らない | `orbit-effect-rack-child/src/tests.rs:560-743` |

---

## 1. この設計自身の完了条件

1. 設計書 §6 の R28-E1〜E10 の各行に disposition（実装 / 既存で充足 / 別 PR / unit 委譲）が付き、
   落とした行には根拠が書いてある（§2）。
2. 新規 E2E の各 assert に「**実装がこう壊れていても通ってしまう形**」の列挙と、その潰し方が
   対応づいている（§4）。
3. `Gain` の dB 契約を守る CI / ゲート経路が高度別に確定している（§5）。
4. 追加分の実行時間見積りがあり、既存 suite の枠に収まる（§7）。
5. `ORBIT_GATED_ORBITSTUDIO` 未設定での skip が保証されている（既存 `describe.skipIf` 配下に
   置くことで構造的に成立 — 新しいゲート機構を作らない）。

---

## 2. シナリオ選別（R28-E1〜E10 の disposition）

**選別の原則**: E2E が担うのは「配線の全長」（DSL テキスト → パーサ → wire → child → DSP → 音）だけ。
**ユニットが変異検証済みで守っている性質を E2E で二重に主張しない**。逆に、ユニットの視野に
構造的に入らないもの（同梱経路・実機の音・プロセスの生死）は E2E でしか守れない。

| # | 内容 | disposition | 根拠 |
|---|---|---|---|
| R28-E1 | 3 カテゴリ混在 N=3 チェーンの RMS 積 + 1 child | **実装**（ブロック1 seg2） | 本 PR の中心 capability が実機未証明。CLAP+VST3+標準 CLAP の同居・`std-plugins/` 同梱経路・`--chain` spawn はどのユニットも見ない |
| R28-E2 | 要素削除・PID 不変・drop の state 保存 | **実装**（seg5） | in-child 編集 + `registerSavedState` の実機配線。既存 R-E 群は length-1 の差し替えしか踏まない |
| R28-E3 | 再追加・state 復元・PID 不変 | **実装**（seg6） | occurrence 再利用（SC.10.3）の実機配線。復元 marker は identity 完全形で pin |
| R28-E4 | `enabled:false` の素通し | **実装**（seg3-4） | enabled が wire→child の skip まで届く配線はユニットでは TS 層（T9）と child 層（C4）に割れており、全長は未接続 |
| R28-E5 | 失敗注入 → 旧チェーン無傷 | **実装**（seg10・N=4 版） | 既存 R-E3 は length-1 同士。**部分構築（3 段成功 + 1 段失敗）の abort** は N≥2 でしか実機に現れない。追加コスト 1 評価分で安い |
| R28-E6 | 空チェーン → teardown + routing 継続 | **既存で充足** | `:2852-2877` が `effect([])` で実装済み（適応済み R-E6）。重複しない |
| R28-E7 | var ラックの値意味論（2 receiver） | **unit 委譲 + 部分実装** | 値 vs 参照・インスタンス非共有は T3/T4 が wire op 列（回数+引数）で変異検証済み。daemon 側は per-bus の既存機構（#625 で E2E 済）で新配線が無い。ただし **`var` 束縛の配列がパーサ→interpreter→適用まで実機を通る**ことは全長の一部なので、ブロック1 のメインチェーンを `var` 束縛で書くことで担保する（追加コストゼロ）。2 receiver 目の音響証明は落とす — 落とした場合に見えなくなるのは「TS 登記の共有バグ」だけで、それは T4 の守備範囲 |
| R28-E8 | master 経路の最小 oracle | **実装**（ブロック2） | 設計 §6 どおり「PID 不変 + ERROR 増 0」の最小形。配列形の master 適用は実機未踏 |
| R28-E9 | 標準 Gain のパラメータ再評価 | **実装**（seg9） | keep+params の全長（DSL 名前付き引数 → wire params → CLAP param 適用 → 音）はユニットの視野外。**ただし「keep であって reload でない」ことは E2E では観測不能**（§4-7）— それは C5 の守備範囲と明記する |
| R28-E10 | MCP `open_plugin_ui` の chain_path | **分割**: E10a（標準要素 → 明示エラー）= 実装（ブロック2）/ E10b（catalog 要素の open/close）= **#633 の stacked PR へ** | E10b の close は `UI_CLOSED_DONE` の腕（既知欠陥 1・#633）が直るまで構造的に落ちる。E10a はウィンドウを一切開かずに daemon の拒否文言だけを見るので今すぐ実装できる。§8 の前提条件（F10）に注意 |
| sum/aux 経路の N≥2 | **unit 委譲** | 設計 §6 自体が E2E 対象を seq（フル）+ master（最小）に限定している。sum/aux は `applyRack` 入口・bus 解決とも seq と同一コード（`mixer-manager.ts:367`）で、bus 単発の実機配線は既存 restore suite（`:1538` / `:1759`）が踏んでいる |

---

## 3. 新規テストの構成

新規 `it` を **2 本**追加する（既存 describe 配下・アプリ起動は共有なので boot コスト増ゼロ）。
既存 `#625 R-E1-R-E7` の it を膨らませない — あちらは「単発形の可観測挙動の保持」（完了条件 5）の
検出器としてそのまま凍結しておくのが役割上正しい。

### 3.1 ゲインの三つ組（false green を構造で潰す値選定）

**規則**（§4-2 の帰結）:

1. 全 stage 非 unity（unity は「透過している」と「適用されていない」が数値で区別不能 —
   `:2594-2599` の実測教訓の一般化）
2. **leave-one-out 積が相互に ≥25% 離れ、full 積からも ≥25% 離れる**（許容 15% に対し
   マージン 10% 以上。実測の定常ノイズは ≪1%: PR #639 の failedDry/B = 0.08% 差）
3. full 積 × busDry が既存の可聴フロア 0.002 を大きく上回る

**採用値**: A = CLAP effect state **0.8** / B = VST3 effect state **0.63** / **`Gain(db: -6)`**（linear ≈ 0.5011）

| 構成 | 積 | 最近傍との separation |
|---|---|---|
| full A·B·G | 0.2525 | — |
| B·G（A 欠落/bypass） | 0.3157 | 25.0%（vs full） |
| A·G（B 欠落） | 0.4009 | 27.0%（vs B·G） |
| A·B（G 欠落） | 0.5040 | 25.7%（vs A·G） |
| 単独 A / B / G | 0.8 / 0.63 / 0.5011 | full からいずれも ≥50% |

busDry ≈ 0.104（既存実測・`:3040-3047` の 6 桁一致モデル）に対し full 区間 RMS ≈ 0.0263 —
フロア 0.002 の 13 倍。

edb: -6 の選定にはもう 1 つ理由がある — **-20dB（設計 §6 の原案）だと full 積 0.0125 × busDry
≈ 0.0013 で可聴フロア 0.002 を割る**。原案の値をそのまま写すとフロア assert と矛盾する。
（正本 §6 からの逸脱ではなく、正本が「dB 直指定」としか定めていない自由度の中の決定。）

### 3.2 ブロック1: `#628 R28: rack chain audio mainline`（capture 付き・seq 経路）

事前準備は既存イディオムを流用: A/B の state ファイル（ORE1+f64LE で 0.8 / 0.63）を
`fx628/effect/<name>/0` の identity で project.yaml に登録 → `start_engine { capture_wav }` →
専用 seq/バス名（`fx628*`）で LOOP。

| seg | 操作（`evaluate_orbitscore`） | 予測 RMS（×busDry） | 付随オラクル |
|---|---|---|---|
| 1 busDry | routing まで宣言・チェーン無し | 1.0 | 非無音 (>0.01) |
| 2 full | `var rack628 = ["A", "B", Gain(db: -6)]` → `fx628.effect(rack628)` | 0.2525 | rack child spawn 行 **ちょうど +1**（3 段で 1 child）・A/B の restore marker 件数 +1 ずつ・ERROR ≤ |
| 3 bypass | インライン配列 `[plugin("A", enabled: false), "B", Gain(db: -6)]` | 0.3157 | PID 不変・`states/` ファイル数不変（bypass は保存しない） |
| 4 re-enable | enabled を戻す | 0.2525 | PID 不変・`states/` 不変・restore marker 件数不変（keep = 再ロードなし、の観測可能な影） |
| 5 drop B | `["A", Gain(db: -6)]` | 0.4009 | PID 不変・`states/` **ちょうど +1**・project.yaml `states:` に B identity が登記され実ファイル存在 |
| 6 re-add B | `["A", "B", Gain(db: -6)]` | 0.2525 | PID 不変・B の restore marker 件数 +1（identity は occurrence 0 の完全形で pin） |
| 7 drop Gain | `["A", "B"]` | 0.5040 | PID 不変・`states/` **不変**（標準は保存しない = SC.10.8 規範 6 の実機証明） |
| 8 re-add Gain | `["A", "B", Gain(db: -6)]` | 0.2525 | PID 不変・`states/` 不変・restore marker 件数**不変**（標準に復元は無い） |
| 9 param edit | `["A", "B", Gain(db: 0)]` | 0.5040（×1.996） | PID 不変・ERROR ≤・`states/` 不変（= R28-E9） |
| 10 failure | `["A", "B", Gain(db: 0), "/nonexistent/Issue628.vst3"]` | 0.5040（**不変**） | `isError=true` + 文言アンカー「`the previous chain is kept`」（説明部・§4-4）・PID 不変・プロセス生存 |
| 終了 | `effect([])` → stop → capture 解析 | — | （teardown は既存 R-E6 が主張済み・ここでは掃除のみ） |

RMS 判定は既存の `segmentRms` / `relativeDelta` / `withinTolerance=0.15` をそのまま使う。
全区間の実測値・窓系列・onset 数を assert より**先に** console へ出す（既存 `:2966-3024` の
イディオム — 1 つの assert で止まって実機実行を払い直さないため）。実行ログはファイルへ全文保存
（`dont-truncate-expensive-test-output`）。

**設計上の不変条件（アンチ no-op 規則）**: **隣接する区間の予測レベルは必ず ≥25% 離す**。
これにより「評価が黙って何もしなかった」（PID 不変・ERROR 0 のまま）はどの遷移でも RMS が
前区間に留まることで必ず赤になる。唯一の例外は seg9→10（失敗 = 不変が正しい）で、そこは
`isError` が no-op と失敗を区別する。

### 3.3 ブロック2: `#628 R28: rack master + MCP standard-element error`（capture 非依存・軽量）

1. **E8**: `global.effect(["A", Gain(db: -6)])` → rack child spawn +1（PID P_m）→
   `global.effect(["A"])` → **最新 PID = P_m のまま**・ERROR ≤。RMS は見ない
   （設計 §6「master 経路で最小 oracle」— master は全区間に乗算されるため、ブロック1 の
   区間表を汚さないようブロック1 の**後**に実行する）。
2. **E10a**: 1. のチェーンが `[A, Gain]` の時点で MCP `open_plugin_ui` を **Gain 要素**へ
   `{ receiver: "master", chain_path: [1] }` で発行（§8-1 の additive 裁定に基づく spec 形）→
   明示エラー。アンカーは説明部の安定句 **「no UI」/「parameters live in the DSL」**
   （`engine_wrap` 側文言・設計 §3.7-7）。ウィンドウは開かないので #633 の close 欠陥に依存しない。
   追加 1 assert: 同じ宛先へ `chain_path: [1]` と**食い違う `index`** を同時指定 → loud 拒否
   （§8-1 の両立規則そのものの実機確認・コスト 1 呼び出し）。
3. 後始末: `global.effect([])`。

---

## 4. false green の列挙と潰し（本設計の中核）

各行「壊れ方 → それでも通ってしまう素朴な設計 → 本設計での潰し」。

1. **`evaluate_orbitscore` の `ok` だけを見る** → 受理と実行は別物（実績: #523 でエディタ評価全滅
   をユニット全緑のまま出荷）→ 本設計の全 seg は RMS / PID / marker / states の**物理オラクル**を
   最低 1 つ伴う。`ok` 単独の assert は 1 箇所も置かない。
2. **unity gain の stage が黙って欠落**（RMS が変わらないので見えない）→ §3.1 規則 1-2。
   さらに部分積の全ペア ≥25% 分離により「どの 1 段が欠けても」「1 段だけしか動いていなくても」
   期待値と 15% 許容内で一致する別状態が存在しない。
3. **「PID 不変」が「何も起きなかった」と区別できない** → §3.2 のアンチ no-op 規則
   （隣接区間のレベルを常に変える）。PID 不変を単独で主張する assert は置かない。
4. **エラー文言の引数名アンカー**（引数名は先頭に出るので実装が入れ替わっても通る）/
   **捏造 mock 文言**（実文言と乖離しても緑）→ アンカーは実装が実際に投げる**説明部の句**に限定:
   seg10 = `the previous chain is kept`（`engine_wrap.rs:7551-7556` が全失敗形に付ける保証句）、
   E10a = `parameters live in the DSL`。実装時に該当行から**コピーして**使い、手で整えない
   （`rack_wire` の wire-pin テストと同じ規律）。
5. **`get_log` 固定 500 行窓の押し出し**で ERROR 厳密等価が偽陽性/偽陰性 → `<=` 比較のみ
   （既存教訓 `:2690-2696` を踏襲）。「ERROR が出た」ことの主張は件数でなく `isError` +
   文言アンカーで行う。
6. **restore marker の includes が過去の復元に誤マッチ** → 件数増加比較 + occurrence まで含む
   identity 完全形（`fx628/effect/<name>/0`）で pin。これにより **occurrence をテキストから
   数え直す退行**（T6/T7 の対象）が実機側でも「marker の identity が変わる」形で露出する。
7. **`enabled:false` が drop+load に脱糖されていても音は同じ**（state 保存→復元で音色も戻る）→
   **`states/` ディレクトリのファイル数スナップショット**で区別する: bypass（seg3-4）= 不変 /
   catalog drop（seg5）= ちょうど +1 / standard drop（seg7）= 不変。音で区別できない偽装を
   ファイルシステムの副作用で捕まえる。
8. **Gain の keep が drop+load（再構築）に化けても E2E は緑**（PID も RMS も同じ・state も無い）→
   **E2E では観測不能と明記し、主張しない**。「再構築しない」は C5（construction generation・
   変異検証済み）の守備範囲で、その C5 は `#[ignore]` なので §5-2 のマージ前ゲートが実行を保証
   する。E2E 側の seg9 が主張するのは「params が音になる・respawn しない・エラーを出さない」まで。
   同型として seg4 の「keep = 再ロードなし」も restore marker 件数不変という**影**しか見ていない
   ことを test コメントに明記する（marker はロード時の state 復元でしか出ないため、増えたら
   確実に reload だが、増えないことは reload 不在の証明ではない — 検出器は C5）。
9. **壁時計と録音タイムラインのスキュー**で隣接区間が混入 → 既存 `SEGMENT_GUARD_SEC=0.4` と
   「本物の信号（restore marker / spawn 行）を待ってから測る」（`:2731-2747`）を踏襲。
   独自の sleep 定数を新設しない。
10. **ゲート env 未設定で走ってしまう / 逆に常に skip** → 新規 it は既存
    `describe.skipIf(!gated)` の内側にのみ置く（新しいゲート分岐を書かない）。受け入れ時に
    `npm test`（env 無し）で skip 数が +2 されることを確認して PR 本文に記録する。
11. **`Gain.clap` が同梱されていないのに緑** → あり得ない構造にする: seg2 の spawn は
    manifest 全段ロード成功が READY の条件（child は 1 段でも失敗すると `LOAD_FAILED` で READY を
    出さない — `rack-child/lib.rs:414-447`）なので、同梱欠落は spawn 待ち timeout で必ず赤。
    偽装の余地はないが、**失敗時に原因へ迷わないよう** spawn 待ちの label に
    「std-plugins/Gain.clap の同梱を確認せよ」を含める。
12. **区間 RMS の集計が混在を隠す**（全窓一様 ×0.5 と、半分 dry 半分 ×0.25 が同じ平均になる）→
    既存イディオムどおり窓ごとの生系列と onset 数を console へ出す（判定は区間 RMS・診断は生系列）。

**E2E 自体の変異検証**: 全 seg の実機変異は費用対効果が合わない（1 変異 = build + gated 1 周）。
上の表が「変異の机上列挙」に相当するが、**紙上の検討だけで閉じない**ため、最も安い層（TS）で
2 件だけ実施して実出力を PR に添付する:
(i) TS の diff が enabled 差分を op に載せない変異 → seg3 が赤(RMS が full のまま)、
(ii) TS が standard の params を load op に載せない変異 → seg2 または seg9 が赤(db 既定値の音)。
どちらも「配線の全長でしか見えない」変異を選んでおり、child 単体・TS 単体のユニットでは殺せない。

---

## 5. `Gain` の dB 契約を CI で守る経路（高度の決定）

**まず事実の訂正**: 「`10^(db/20)` を `db/20` に壊してもどの CI 経路も検出しない」は**半分だけ正しい**。
`orbit-std-gain` は workspace member（`rust/Cargo.toml:24`）で `cfg(target_os)` ゲートが一切なく
（grep 実測 0 件）、`db_to_linear` の数理テスト（0dB=1.0 / -6dB≈0.50119 / floor=0.0 / 飽和）は
`src/lib.rs:315-360` にあり、`rust-ci.yml` の `cargo test --workspace --locked`（ubuntu）が
**現に実行する**。`db_to_linear` 本体の変異はここで赤になる。

**CI が本当に見ていないもの**は次の 3 つ:

| 穴 | 内容 | 現在の唯一の検出器 |
|---|---|---|
| (a) `StdGain::process` の音経路 | param 読み出し（atomic）→ gain 適用の audio コールバック本体。`db_to_linear` を正しく呼んでも、掛け忘れ・チャンネル取り違えは lib テストの視野外 | c14（`#[ignore]` + macOS） |
| (b) rack child ↔ Gain の統合 | `std-plugins/` 解決・param 名→id 写像・keep+params 無再構築 | c05/c13（`#[ignore]` + macOS） |
| (c) 同梱 artifact の実在とロード可能性 | bundle-macos.sh の出力がアプリ経由で本当に解決される | release.yml の存在ゲートのみ（ロードは見ない） |

**macOS ランナーの前提整理**（2026-08-28 追記・team-lead の指摘で更新）:
`release.yml:50` は既に **macos-14（Apple Silicon）** を使っており、しかも
`cargo build --release -p orbit-effect-rack-child` と `bundle-macos.sh --release` を
**既に実行している**（`:89-93`）。つまり「実 Gain テストを走らせる環境」は release パイプラインに
**既設**で、追加コストはテストバイナリの増分ビルド + 実行（1〜2 分）だけ。
ただし 2 つの制約がある:

- `release.yml` の `pull_request` トリガは **paths フィルタに `rust/**` を含まない**
  （`:31-37` — workflows / packages / scripts のみ）。**rust だけを触る PR では release smoke は
  走らない**。したがって release.yml へのテスト追加は「tag 時 + packages/scripts 系 PR 時」の
  ゲートであって、per-PR の全数ゲートではない。
- `rust-ci.yml` は冒頭コメントで「macOS ランナーはコスト高のため per-PR CI では回さない
  （owner 方針）」を明文化している。この方針の適用範囲は **per-PR CI** であり、release
  パイプライン（低頻度・既設 macos-14）には及ばない、と読むのが整合的。

**実測エビデンス（2026-08-28・team-lead 実行・owner の「ローカルで実機テストできないの?」
指摘を受けて）**:

```
$ bash rust/crates/orbit-std-gain/bundle-macos.sh
$ cargo test -p orbit-effect-rack-child --lib -- --ignored
test result: ok. 3 passed; 0 failed; finished in 67.35s
```

- **本 PR で初めて、出荷される `Gain` が実機で鳴ることを確認した**（c05/c13/c14 全 green）。
- 変異 `10^(db/20)` → `db/20` で**両方の検出器が実証済み**: 実機 3 件 all red +
  ubuntu 数理テスト 4 件 red。restore で両方 green（`cmp` で復元確認）。
  §5 冒頭の「数理ヘルパの変異は既に CI が殺す」は実測で裏付けられた。
- `gain_bundle_dir()` の debug ハードコードは**手元 debug 実行では問題にならない**
  （release プロファイルを指せない件は release.yml 経由の時だけ効く — 2. の下ごしらえは
  release.yml のためだけに要る）。

**決定（4 経路・機構の新設は release.yml への step 1 つのみ）**:

1. **(a) ubuntu per-PR: in-process 処理契約テスト — 実機 3 件が回るようになった今でも要る**。
   理由は担当の重複ではなく**実行頻度の非対称**: 実機 c05/c13/c14 は (b) では rust-only PR で
   走らず（paths フィルタ）、(c) は手動手順で、**per-PR に自動で走る検出器はこれだけ**。
   検出の高度も違う — in-process テストは**プラグイン自身の process 契約**を、c 系は
   **rack child 統合**を pin する（前者が赤なら原因はプラグイン側と即断できる）。
   実体: `orbit-std-gain/tests/contract.rs` は既に clack-host で自プラグインを
   **in-process 起動**している（dlopen 不要・`#[ignore]` 不要）。ここへ「activate →
   実バッファ 1 block process → -6dB で振幅半減 / 0dB で恒等」の**処理契約テスト**を 1 本
   足す。既存の `cargo test --workspace` ステップがそのまま拾うので **rust-ci.yml の変更は
   ゼロ**。※実装時確認の但し書きは維持: clack-host の in-process instance で audio processor
   まで進められなければこの 1 本を諦め、per-PR の (a) 相当は 3. に一本化する
   （残余ギャップとして PR 本文に明記）。
2. **(b) release.yml（macos-14・既設）へ実 Gain テストの step を追加**: 既存の
   rack-child + bundle ビルド step（`:86-93`）の直後に足す:
   ```yaml
   - name: Test rack child against the bundled Gain.clap (c05/c13/c14)
     run: ORBIT_STD_PLUGIN_DIR="$PWD/rust/target/release/std-plugins" \
       cargo test --release -p orbit-effect-rack-child --lib --manifest-path rust/Cargo.toml -- --ignored
   ```
   依存はすべて直前の step でビルド済みなので増分は **+1〜2 分**。これで「出荷される組み合わせ
   （release ビルドの child × release ビルドの bundle）」がタグを切るたびに検証される。
   **下ごしらえが 1 行要る（release.yml のためだけ）**: `tests.rs:633-635` の
   `gain_bundle_dir()` は `target/debug/std-plugins` を**ハードコード**しているため、
   `ORBIT_STD_PLUGIN_DIR` があればそれを優先する形に改める（`ActualFactory` は既に同 env を
   読む — `macos.rs:215` — ので規約の複製ではなく同じ規約への追従）。
3. **(c) マージ前ゲート（main の手元 macOS・per-PR の実行保証）— CLAUDE.md へ恒久追加する**:
   ```bash
   bash rust/crates/orbit-std-gain/bundle-macos.sh && \
     cargo test -p orbit-effect-rack-child --lib -- --ignored
   ```
   恒久追加が妥当と判断する根拠: (i) **実測 67 秒** — 既存マージ前ゲート
   （`build:clean` + アプリ再起動 + 実機 E2E で数分規模）に対して誤差。
   (ii) **条件分岐を付けない** — 「rust を触った PR のみ」等の条件付き手動手順は飛ばされる
   のがこの repo の実測クラス（列挙が一段手前で止まる型）。無条件の 67 秒の方が、条件判定の
   認知コストより安い。(iii) 本 PR で**実行済みエビデンス**が既にある（上記 3 passed +
   変異 red の実出力）ので、「手順として書いただけ」の状態を経由しない。
   debug ビルド同士なので `gain_bundle_dir()` の既定フォールバックで自己完結する。
   実行結果（3 passed）を PR 本文に記録する。
   `--lib` について: **`orbit-effect-rack-child` には現在 `tests/` ディレクトリが存在しない**
   （crate 直下は `Cargo.toml` と `src` のみ・`*_gated.rs` も無い — 実測）ので、今日の時点で
   #629 型の罠は**踏めない**。それでも `--lib` を明示するのは、将来 integration テストが
   増えた瞬間に `--ignored` の一括実行へ黙って合流する形を**最初から作らない**ため
   （#629 の教訓: `#[ignore]` は「遅い」と「実機要」の両方に使われ、`--ignored` は区別しない）。
4. **(d) end-to-end は本設計の R28-E1（seg2）が担う**: 実アプリ → daemon → child →
   `std-plugins/Gain.clap` ロード → 音、の全長。gated E2E がロード可能性の最終証明。

**owner 判断へ回す選択肢（推奨は「不要」— 67 秒実測でさらに強まった）**: rust-ci.yml への
**per-PR macOS ジョブ新設**。lean 構成（rack-child + std-gain + 依存のみビルド →
`--ignored` 実行）でも cold ~8-15 分 / rust-cache warm ~2-4 分、macOS ランナーは Linux 比
**10 倍課金**で、**全 rust PR の全 push** にかかる。それが (a)+(b)+(c) の三重に対して追加で
買うのは「人手ゲート (c) をすっ飛ばした場合の per-PR 自動検出」だけで、**同じものが手元で
67 秒で得られる**ことが実測済み。(c) は CLAUDE.md 上の必須手順なので、方針（rust-ci.yml
冒頭の owner 明文）を覆してまで買う価値は無いと判断する。覆す場合は owner の明示判断とする
（コスト方針の変更は設計書の権限外）。

**検証コマンド（実装完了時に全部回す・両 clippy が load-bearing）**:

```bash
cd rust && cargo clippy --workspace --all-targets --locked -- -D warnings          # default features
cd rust && cargo clippy --all-targets --features outproc-effect,outproc-instrument -- -D warnings
cd rust && cargo test --workspace --locked                                          # 数理 + 合成 stage
bash rust/crates/orbit-std-gain/bundle-macos.sh && \
  cargo test -p orbit-effect-rack-child --lib -- --ignored                          # 実 Gain 3 件
npm run typecheck:e2e && npm test                                                   # 型ゲート + skip 確認
ORBIT_GATED_ORBITSTUDIO=1 ORBITSCORE_MCP_PORT=39123 <gated E2E>                     # §3 の新ブロック
```

🔴 **feature 付き clippy は default 構成の証拠にならない**（pre-push フックは default features
で走る — 2026-08-28 実測: `--features outproc-effect,outproc-instrument` のみ回して push で
止められた・`clippy::vec_box`）。逆も真なので**必ず両方並べる**。

**却下した案**: Linux 向け `.clap` ビルド経路の新設（bundle-macos.sh と ActualFactory が
macOS 前提で、経路の新設は「新機構を作らない」に反する。(a) を in-process で拾えば残るのは
macOS 固有の統合だけになり、Linux 経路を作っても検出力が増えない）。
なお c05/c13/c14 の**テスト自体は書き直さない** — c14 は `10^(db/20)` → `db/20` の変異で
確実に赤になる良いテストで、欠けているのは実行経路だけ（team-lead の裏取りと一致）。
本節の 2.-3. はまさに「走らせる経路を作る」の具体化である。

---

## 6. 既存部材の再利用一覧（新設ゼロの確認）

| 部材 | 用途 | 位置 |
|---|---|---|
| `describe.skipIf(!gated)` / `appAvailable` | ゲート | `:275, :371` |
| `client` / `tmpRoot` / `workAudioDir` 共有 | boot 共有 | `:2576-2586` |
| ORE1 state ファイル + project.yaml 事前登録 | A/B のゲイン設定 | `:2603-2632` |
| `captureSegment` / `segmentRms` / `relativeDelta` / `SEGMENT_GUARD_SEC` | 音のオラクル | `:2640-2958` |
| `rackChildPidsFromLog` / `effectChildPids` / `processExists` | PID オラクル | `:186-244` |
| `countErrors` の `<=` 比較 | ERROR 増 0 | `:2633, :2690` |
| restore marker 件数比較 | state 復元 | `:2806-2836` |
| `requireCatalogFixtures` | カタログ名解決（一意 guard 込み） | `:297-330` |

新設するのは「`states/` ディレクトリのファイル数スナップショット」ヘルパ 1 つだけ
（`fs.readdirSync` の件数比較・テストファイル内のローカル関数で足りる）。

---

## 7. 実行時間の見積り

| 項目 | 概算 |
|---|---|
| ブロック1: engine start/stop + 10 区間（各 3.75s）+ spawn/marker 待ち | **100〜130s** |
| ブロック2: 評価 4 回 + spawn 待ち 1 回（capture 無し） | **20〜30s** |
| 合計追加 | **+2〜2.5 分** |

既存 suite は 8 it（うち最大の R-E が `TEST_TIMEOUT_MS*2 = 240s` 枠）。ブロック1 の timeout は
`TEST_TIMEOUT_MS * 3`（360s）を指定する — 区間 10 個は既存 R-E の 7 個より多く、240s 枠では
spawn 待ちが重なった時に不足する。ブロック2 は既定枠で足りる。アプリ起動を共有するため
boot コストの増加は無い。

---

## 8. 依存と順序

1. **F10（MCP `open_plugin_ui` の chain_path 化）— 裁定済み（team-lead 2026-08-28）:
   本 PR に入れる。ただし additive で**:
   - tool schema へ `chain_path` を**追加**する（spec 形）。**`index` は削除せず両方受理**。
   - 両方来たら `chain_path` を優先し、**両者が食い違う場合は loud に拒否**する
     （黙って片方を採らない — #583 の原則）。
   - `index` の**撤去**は表面の変更なので **#633 への申し送り + owner 判断**とする
     （spec に書いてあっても表面は勝手に確定させない — #625 の教訓。追加 = 乖離の解消 /
     削除 = 表面の変更、で性質が違う）。
   - 根拠の追加: core spec を `chain_path` に書き換えたのは本 PR の diff 自身
     （コミット `a83925cf`）であり、tool を `index` のまま出荷すると本 PR が自分で作った
     spec/実装乖離を残すことになる。
   - E10a はこの additive 形を前提に **`{ receiver, chain_path: [1] }`** で書く。
2. **#633（UI pump per-index）**: E10b（catalog 要素の open/close 実機）は #633 の PR に積む。
   #633 の設計書へ「E10b をこの表の形で足す」と申し送る（open → window 存在 → close →
   `UI_CLOSED_DONE` 完了、既存 #617 系オラクル流用）。
3. **監査 F4/F5（mailbox timeout / 死んだ mailbox への save）の修正**とは独立 — 本設計の
   シナリオは健全 child への 5s 内操作のみで、それらの故障経路を踏まない（踏ませる E2E は
   crash 注入が要るため unit（D6/D14 の拡張）の領分。ここで背負わない）。

---

## 9. 質問と裁定（全件決着・team-lead 2026-08-28）

- ~~**Q1**: F10（MCP tool schema の `chain_path` 化）を本 PR に入れるか~~ →
  **裁定: 入れる。ただし additive**（詳細は §8-1 に反映済み: `index` 併存・`chain_path`
  優先・食い違いは loud 拒否・`index` 撤去は #633 申し送り + owner 判断）。
- ~~**Q2**: R28-E7 の 2 receiver 音響証明の deferral を承認するか~~ →
  **裁定: 承認**。あわせて「メインチェーンを `var` 束縛で書いてパーサ経路を無償カバー」は
  採用（§3.2 seg2 のとおり）。軽量版（+10s）は**作らない** — 必要になってから作る。
- §5-1 の「clack-host in-process で audio processor まで進められるか」は**実装時確認のまま**
  とする裁定（先に確認して設計を確定させない — 実装が触れば 5 分で分かる）。進められなければ
  諦めて §5-3 に一本化し、残余ギャップを PR 本文に明記する。

---

## 10. 触ってはいけないもの

1. 既存 `#618 E1-E6` / `#625 R-E1-R-E7` の it 本体（完了条件 5「単発形の可観測挙動」の検出器。
   ここに rack 区間を継ぎ足さない）
2. `SEGMENT_GUARD_SEC` / `withinTolerance` / `TEST_TIMEOUT_MS` の既存値
3. capture / 解析ヘルパの実装（`analyzeWavBuffer` ほか）
4. ゲート機構（`describe.skipIf` の形・env 名）
5. `rust-ci.yml` の job 構成（§5-1 は既存 workspace ステップに**乗る**だけで yml を変えない。
   yml を変えるのは `release.yml` への step 追加 1 つ — §5-2 — のみで、per-PR CI のコスト方針
   （rust-ci.yml 冒頭の owner 明文）には触れない）
