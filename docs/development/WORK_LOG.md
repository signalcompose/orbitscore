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

### docs(649): follow the master line up in the spec and the dev site (Sep 5, 2026)

**Issue**: #649 / **ブランチ**: `claude/docs-sync-pr754` / **追従元 PR** [#754](https://github.com/signalcompose/orbitscore/pull/754)（merge commit `f2dadd9`）

マージ済み PR #754（#649 PR-O2・stereo 内部化 + master ライン）に、ドキュメントを追従させた。
**実装・テストは一切変更していない。**

#### 仕様（`docs/core/INSTRUCTION_ORBITSCORE_DSL.md`）

🔴 **PH.2b の既知の v1 制約が 1 つ解消され、順序が入れ替わった。**

| 変更前 | 変更後 |
|---|---|
| master gain ramp は per-sequence insert の**前**（DAW の「fader は insert 後」と逆） | master gain は **master ラック（PH.2）の後**。per-sequence insert も `global.effect()` も master gain の**手前**に来る（DAW と同じ並び） |

根拠は PR #754 の差分そのもの（`EngineWrap::set_global_gain` が core の scheduler ramp を
呼ばなくなり、`MasterLine`（rack → gain → デバイス配置）へ atomic store するだけになった）と、
設計正本 `docs/design/611-output-line-design.md` §5.2/§5.4「master のゲインは master ラインの
op としてラックの**後**に必ず来る」。

あわせて PH.4（instrument）の「`render_multi` の内側（event 混合後・**gain ramp の前**）で
合流する」から、production に存在しなくなった gain ramp への参照を外した。

#### dev 学習サイト（ja / en 両方）

- `sites/dev/rust-engine/index.md` — 「master ライン — engine の内部幅は常に 2ch」節を新設。
  `ENGINE_CHANNELS` / `place_master_into_device`（mono マージ・2ch memcpy・3ch 以上の 0 埋め）/
  `MasterLine::advance_gain`（構築時に確定する 5 ms ランプ）/ `EngineWrap::set_global_gain` を引用。
  `render_block_with_sources` の段数が 3 → 5 になったこと、ビット同一の条件が
  「ラック無し + gain 1.0 + 2ch デバイス」に変わったことを本文に反映
- `sites/dev/signal-chain/mixer-audio-line.md` — 「master gain の適用点が移った」節と
  「(5) 4 度目の読み直し」節を追加。(3)「master gain は今も insert の前」に解消の注記。
  E2E-1 が赤かったのは**オラクル**（`every(rms >= 0.01)` は LOOP の 80 ms の切れ目で
  原理的に満たせない）であって実装ではなかったこと、症状自体は `374e8b2d` で消えていたこと、
  PR-O2 が塞いだのは「ラックが生成した音が `global.gain()` を逃れる」残り半分であることを記載

両章とも `verified-against` を `f2dadd9` / `verified-at` を 2026-09-05 に更新した。

#### 追従不要と判断したもの

| 対象 | 理由 |
|---|---|
| `docs/specs-v2/` | master gain の適用位置に言及している箇所が無い（`grep "gain ramp\|master gain\|マスターゲイン\|global gain"` で 0 件）。SC.10 は順序ではなくラックの形を規定している |
| `sites/user/` / `docs/user/ja/USER_MANUAL.md` | `global.gain()` の適用位置を書いている箇所が無い。`sites/user/reference/methods.md` の `gain(dB)` は seq のフェーダーで、本 PR は触っていない |
| `docs/design/611-output-line-design.md` | PR #754 が §5.5 にオフラインレンダの注記を追加済み |

#### 検証

`npm ci` / `docs:build`（user・dev）/ `docs:check` — PR 本文に出力を貼付。

---

### fix(649): correct the attribution and add the test that actually guards the master line (Sep 5, 2026)

**Issue**: #649 / **ブランチ**: `649-stereo-internal-master-line` / **PR** #754

ゲート③（`/simplify` 4 体 + Fable 監査を並行）。**Critical 0 / Important 3**。
最大の指摘は「**この PR の Rust 差分を区別できる検証が存在しない**」だった。

#### 🔴 帰属の訂正 — E2E-1 が緑なのは本 PR の Rust 差分の効果ではない

Fable が `374e8b2d`（2026-08-29・**main に既に入っている**）を指摘した。そのコミット本文:

> instrument の音は `CompositePostProcessor` で master バッファへ直接加算されており、
> バスグラフの外にいた。これを `render_multi` の内側・event 混合後・gain ramp の前へ移し …
> **帰結: `global.gain` が instrument に効くようになった**

**推論で済ませず実機で反証した**（main の `rust/` + このブランチの `tests/`）:

```
✓ #643 E2E-1 applies global.gain(-6) … 9321ms
```

**main の rust でも緑**。つまり #649 の見出しの症状は 8/29 に main で消えており、E2E-1 が赤かったのは
**オラクルだけ**が原因だった。「段 1 の目的が証明された」という以前の報告は、事実（E2E-1 が緑）は
真だが**帰属が誤り**だった。

#### では本 PR の Rust 差分は何を直しているのか

**同じクラスの残り半分**。main では `global.effect()`（master ラック = `post`）が core の gain ramp の
**後**に走るので、**ラックが生成・変形した音は `global.gain()` を逃れる**。`MasterLine` は順序を
`rack → gain` に固定してこれを塞ぐ（設計 §5.2）。

🔴 **`Gain` のような線形ラックでは順序を区別できない**（乗算は可換）ので、DSL 経由の E2E では
測れない（`#611 O0-4` のテスト名「a linear rack cannot show order」がまさにこれ）。ユニットで押さえた:

```
master_gain_applies_after_the_master_rack_generates_sound
  FillPost(0.75) + gain 0.5 → hw = 0.375

変異（post と gain の順序を main の形へ戻す）:
  FAILED  master gain must attenuate what the master rack produced: [0.75, …]
```

**これが本 PR の Rust 差分を守る唯一のテスト**。あわせて `advance_gain` / `place_master_into_device`
（8ch の余剰チャンネル・mono マージ）にもユニットを足した。

#### `/simplify` の適用

| 指摘 | 直した形 |
|---|---|
| 🔴 **RT ホットパスで `hw` を二重に書いていた**（3 体が独立に指摘）— 全域 zero-fill の直後に `place_master_into_device` が全要素を上書き | zero-fill を削除し、余剰チャンネルの 0 埋めを配置関数の責務へ。2ch は `copy_from_slice` に。**64 frames × 2ch なら約 96,000 store/秒の無駄**だった |
| `ensure_buffer_len` が `MasterLine` と `InsertBusStage` で完全に同一 | 自由関数 `ensure_audio_buffer_len` へ集約 |
| `awaitSoundRestart` の 5 定数が 2 箇所に verbatim | `makeAwaitSoundRestart` ファクトリへ集約 |

#### Fable I-2 — 非 production feature が engine バッファをデバイス幅で解釈していた

`clap-host` は `ClapPostProcessor` に、`link-audio` は consumer に **`stream.channels`（デバイス幅）**を
渡していた。どちらも受け取るのは `master.buffer`（**常に 2ch**）なので、8ch デバイスでは frame 数が
1/4 になって音が化ける。`ENGINE_CHANNELS: usize = 2` を名前付き定数として公開し、両方をそれに揃えた。

production build には含まれない feature なので実害は無かったが、設計 §5.5 の
「events / feeds / stages はすべて 2ch」を**この 2 経路だけが継承していなかった**。

#### 検証

`npm test` 2251 passed / `typecheck:e2e` 0 / `lint` 0 /
`cargo test -p orbit-audio-native -p orbit-audio-daemon` **144 passed / 0 failed**（21 スイート）/
clippy **5 象限**（`clap-host` / `link-audio` を含む）全緑 / `docs:check` 926 verified 0 failed

---

### test(e2e): open the window after the sound restarts, not after a fixed settle (#649) (Sep 5, 2026)

**Issue**: #649 / **ブランチ**: `649-stereo-internal-master-line` / **PR** #754

**`#643 E2E-1` 〜 `E2E-7` の 7 本すべてが実機で緑**になった。落ちていたのは**判定側**で、
ミキサーの実装は最初から正しかった。

#### 実測（`ORBIT_KEEP_CAPTURES` で WAV を残し 20 ms 窓を並べた）

E2E-2 の capture:

```
0.00 – 3.06s  silent            ← 起動 + 小節量子化 + attach
3.06 – 4.98s  SOUND  max 0.1794 ← dry（0 dB）
4.98 – 5.06s  silent (0.08s)    ← LOOP の小節境界の切れ目
5.06 – 5.78s  SOUND  max 0.1794
5.78 – 7.08s  silent (1.30s)    ← dry.stop() → LOOP(wet) の量子化待ち
7.08 – 8.02s  SOUND  max 0.0899 ← wet
```

🔴 **比は `0.0899 / 0.1794 = 0.501`** — -6 dB の理論値ちょうど。**実装は正しい。**
落ちていたのは「wet の窓が 6.2 秒から開いて 85 窓中 46 窓しか可聴でない」という判定側だった。

#### 原因は 2 種類

| 原因 | 該当 | 直し方 |
|---|---|---|
| **窓が無音の上に開く** — `captureSegment` の発音待ちは**初回だけ**で、2 回目以降は固定 400 ms | E2E-2 / E2E-4 / E2E-6 | `waitForSoundRestart` を新設し、鳴らし直した後に**もう一度鳴り出すまで待つ** |
| **原理的に満たせない条件** — `every(rms >= 0.01)`（一度も途切れない） | E2E-7 | 他の 6 本と同じ `expectSegmentsSounding`（割合で見る）へ |

`waitForSoundRestart` は 2 段階:

1. **末尾が静かになるまで待つ**（前の LOOP が実際に止まった確認）。`quietTimeoutMs` 以内に
   静かにならなければ**そのまま次へ進む** — 切れ目なく続く譜面では静寂が来ないのが正しい
2. **末尾が可聴になるまで待つ**

`quietSec` は LOOP の小節境界の切れ目（**実測 80 ms**）より十分長く取る（0.3 秒）。短いと
段階 1 がその切れ目で成立してしまい、鳴り直しを待たずに返る。

🔴 **固定 settle を伸ばす形にしない。** 小節境界までの残り時間は評価のタイミング次第で
0〜1 小節ぶん変わるので、定数では追えない（前セッションで settle 2600 ms が反証済み）。

#### 実機（全件）

**5 failed / 21 passed（26 件）**。main baseline は **10 failed / 24**。

| 残る失敗 | 種別 |
|---|---|
| `drives real OrbitStudio end-to-end` | main baseline（**#760** で main を実測して確認） |
| `steps the live playhead` | main baseline（`Mixer bus name "drum" is ambiguous`） |
| `restores an MCP-saved …` | 環境要因の疑い（`Failed to cleanup old directories: ENOENT`） |
| `#606 E2E-K3` | **起動タイムアウト**（アサーション失敗ではない） |
| `#611 O0-4` | `snapped range must contain exactly 8 onsets; got 9`。**単独実行では緑**（`effectOnlyOverDry=1.9953` / `combinedOverDry=1.0000`）＝全件の文脈でだけ出る揺れ |

`npm test` 2251 passed / `typecheck:e2e` 0 / `lint` 0 / `docs:check` 926 verified 0 failed。

---

### test(e2e): fix the #643 audibility oracle — E2E-1 is green (Sep 5, 2026)

**Issue**: #649 / **ブランチ**: `649-stereo-internal-master-line`

🔴 **段 1 の目的「`global.gain(-6)` が instrument に効く」が実機のキャプチャ RMS で証明された。**

| | 失敗 |
|---|---|
| `main` baseline（同日・同一条件） | 10 / 24 |
| **#649（本コミット後）** | **8 / 26** |

`#643 E2E-1` / `E2E-3` / `E2E-5` が緑になった。新規の失敗 1 件は
`restored RMS 0.0307 vs 許容 0.03` の**境界落ち**で、実行ごとに揺れるプラグイン state 復元系。

#### 🔴 E2E-1 が赤かった本当の理由 — ミキサーではなくオラクル

`#649` のミキサー差分を載せても、E2E-1 は赤のままだった（退行ゼロ・改善ゼロ）。
`ORBIT_KEEP_CAPTURES` で WAV を残して実測したところ、**音も gain の変化も正しく写っていた**:

```
643-global-gain.wav  dur=7.96s
  0〜3.04s 無音（小節量子化 + プラグイン attach。#739 の記録どおり）
  3.04〜5.48s : 0.175〜0.179（持続音・安定）
  5.48s〜     : 0.087〜0.090   ← global.gain(-6)
  比 = 0.088 / 0.177 = 0.497   （-6 dB の理論値 0.501）
```

落ちていたのは前提条件 `windows(name).every((w) => w.rms >= 0.01)` だった。
0.01 未満の窓は **247 個中 11 個だけ**で、位置がすべて **4.96/4.98/5.00/5.02** と
**6.96/6.98/7.00/7.02** 秒。120 BPM の 1 小節は 2 秒なので **3.0 / 5.0 / 7.0 秒は LOOP の折り返し**で、
そこに **80 ms の切れ目**が入る。区間 2 秒は必ずこの境界を 1 つ含む。

**つまりこの条件は「音が出ているか」ではなく「一度も途切れないか」を見ており、
LOOP を跨ぐ限り原理的に満たせなかった。** 測りたいのは前者なので、
**大半の窓（既定 90%）が可聴であること**へ変えた。

#### 🔴 途中で 1 度、誤った修正を入れた（記録）

最初は「減衰音では全窓可聴を満たせない」と考え、**オンセット数**（`onsets(name).length >= 3`）に
置き換えた。実機は `got 0` で落ちた。理由は素材の取り違えで、#643 は**持続音**だった。
オンセット閾値は `max(全窓 RMS の中央値 × 4, 下限)` という**打楽器向け**の式で、実測すると:

| capture | 中央値 | max | 閾値 | オンセット |
|---|---|---|---|---|
| `643-global-gain`（持続音） | 0.0877 | 0.1794 | **0.3508** | **0**（閾値が max を超える） |
| `611-o0-no-bus-first`（打楽器） | 0.00001 | 0.3793 | 0.0200 | 15 |

同じ実行で O0-* が通り #643 が落ちる差は、**素材の違い**だった。

**推測で 2 回動くより、WAV を 1 回残した方が速かった。**

#### 残る #643 の 4 件は性質が違う

- **E2E-2 / E2E-4 / E2E-6**: `wet 34/85`・`sumAux 35/85`・`nextDry 52/85` と**区間の半分以上が本当に無音**。
  オラクルではなく、その経路で音が出ていない可能性がある
- **E2E-7**: `expected 7 to be greater than or equal to 8`（別のアサーション）

#### そのほか

`clap-host` feature でしかコンパイルされないテスト呼び出しが `EngineWrap::build` の
`master_gain` 追加に追従しておらず、pre-push の clippy が捕まえた。
🔴 **`check-cfg-matrix.sh` は 4 象限しか見ない**ので、`--features outproc-*` のビルドと
`npm test` が緑でもこの象限は一度もコンパイルされない。

### fix(661): close the review round-2 findings across all four layers (#661) (Sep 5, 2026)

**Issue**: #661 / **ブランチ**: `661-stream-liveness-instrumentation` / **PR** #748

ゲート③ ラウンド 2（`/code:pr-review-team` フル編成 4 体 + Fable 監査を並行）。
**Critical 0 / Important 5**（うち 3 体が同じ 1 件に収束）。設計パスを 1 つ置いてから一括で直した。

#### 設計パス P1 — ライブ切替の失敗を利用者にどう見せるか

分ける軸は「**いま鳴っている音を止めずに直せるか**」。表は
`packages/vscode-extension/src/engine-view.ts` の `SELECT_AUDIO_DEVICE_ERRORS` **1 箇所**に置き、
文言・再起動の要否・「既知かどうか」の 3 つをすべてそこから引く。

| code | 音 | Restart Engine |
|---|---|---|
| `AUDIO_DEVICE_UNAVAILABLE` | 鳴り続ける | ❌ 出さない |
| `AUDIO_DEVICE_STREAM_DEAD` | 鳴り続ける | ❌ 出さない |
| `AUDIO_DEVICE_SWITCH_UNAVAILABLE`（録音中） | 鳴り続ける | ✅ |
| `AUDIO_DEVICE_RATE_MISMATCH` | 鳴り続ける | ✅ |
| `AUDIO_DEVICE_SWITCH_RECOVERY_FAILED`（新設） | **止まっている** | ✅ |

🔴 これを直した理由: F4（名前不一致は縮退せず拒否）を実装したのに、**UI は未知コードとして
「Restart Engine」を提示**していた。再起動すると起動経路のポリシーで host 既定へ移るので、
**F4 が避けたかった「演奏中のタイプミスで音が内蔵スピーカーへ移る」を UI が自分で起こす**形だった。

`SwitchRecoveryFailed` を `primary` のコードへ畳むのもやめた。畳むと
`AUDIO_DEVICE_STREAM_DEAD` の「元の出力を継続します」が、**継続できていない**事象に付く。

#### 🔴 C-7 — 到達不能だった安全網を到達可能にした

`apply_device_switch` の「probe 成功 → 旧を pause → 新の build/play/confirm が失敗 → 旧を
`play()` で再開」は、**どのテストからも到達できなかった**。実ストリームを殺せる唯一のフォールト
`DeadRealStream` はプロセス全体に効き、daemon が起動できない（C-4 がそれを証明している）。

`StreamBuildStage { Startup, Switch }` と `OutputFault::DeadRealStreamOnSwitch` を足して到達可能にし、
gated Rust `C-7` を新設。**変異で赤を実測**:

```
変異なし                    : ok
guard.stream.play() を削除  : FAILED
  the old stream did not resume after a failed switch:
  before_rate=48, resumed_rate=0
```

`resumed_rate=0` = 旧ストリームは pause されたまま**恒久的に無音**。これが起きるのが最悪ケース。

#### E2E の判定を強くした

| テスト | 直前まで | 直した形 |
|---|---|---|
| **D-0** | `rms > 0` だけ | `output.device_name` が**要求名と一致**・`device_fell_back === false` |
| **D-2** | `rms > 0` だけ | `device_requested` が要求名・`device_fell_back === true`・`fallback_reason` に理由 |
| **D-1** | `toBe(before)` が両辺 undefined で**空振りで通る** | 先に `typeof … === 'string'` を固定。包含側も D-3 水準へ |
| **D-3** | 包含側が `ERROR:` 前置に依存（chunk 境界で**偽赤**） | 前置に依存しない `newLogLines` で数える |

🔴 D-0 は **#661 の受け入れテストそのもの**（「デバイス指定で音が出る」）なのに、`rms > 0` は
「何らかのデバイスから音が出た」しか言わない。このマシンは出力が実質 1 台なので、
**指定が無視されて既定に落ちても緑になっていた。**

デバイスの検査は**鳴っている間**に取る必要があった（`runScore` から戻った時点で engine は停止済みで
`get_engine_state` は `{running:false}` しか返さない）。1 度これで落ちてから直した。

#### その他

- `get_engine_state` の状態問い合わせ予算を 10 秒 → **2.5 秒**。`waitForEngine` はこのツールで
  `running` を 500 ms 間隔でポーリングするので、10 秒だと 30 秒予算で 3 回しか試せなかった
- 判定を `resolveEngineState`（`engine-state-bridge.ts`）へ切り出し、**3 分岐すべてに単体テスト**
  （停止中 / ブリッジが `ok:false` / ブリッジ自体が reject）
- 切替失敗のメッセージから `audio output init failed: ` の前置を落とした。**切替では何も init して
  いない**のに、ERROR ログ・`last_switch_failure`・MCP の返り値・UI 文言すべてに載っていた
- `engine-view.spec.ts` の入力を実形式 `[CODE] message` に揃えた（捏造した mock 文言だった）
- 設計 §4.5 に「1 回の失敗を 2 層が記録する」を明記。§6 受け入れ 7（**倍速になるか**）に結論を記載
- `docs/research/ENGINE_DAEMON_PROTOCOL.md` に `SelectAudioDevice` の失敗コード表を追加

#### §2.2「時間が倍速になるか」— 決着

**倍速にならない。ただしそれは `pause()` が 2 重に効いているから**で、リスク自体は実在した。
C-6 の実測（`--audio-device <既定の名前>` → host 既定へ切替）:

| 変異 | callbacks/s |
|---|---|
| 変異なし | **94**（等速） |
| (a) だけ削除 / (b) だけ削除 | 94（もう片方が効く） |
| **(a)(b) 両方削除** | **190**（ほぼ倍速） |

#### fix 差分の再点検（PROJECT_RULES §4）

`73b7abce..326e5fce` を 1 レビュアーで再点検。問いは 2 つだけ（新しい故障モード / 実行コンテキスト）。
**Critical 0 / Important 1**: 「`get_engine_state` の予算短縮が本番の観測性を下げる」。

一次ソースで裁定した結果、**予算では解決しない**:

`//#getEngineState` は REPL の `handleLine` の中で処理され、`createReplSession` の `pushLine` は
**全行を単一の FIFO promise チェーン**に載せる（`repl-mode.ts`「直列化の根拠 — #476」）。
instrument の attach は実測 30 秒超なので、10 秒でも 2.5 秒でも答えは返らない。伸ばして変わるのは
「同じ `statusError` を返すまでに何秒ブロックするか」だけ。

→ 2.5 秒は据え置き、コメントを **E2E 都合ではなく本番の根拠**に書き直して
`ENGINE_STATE_QUERY_BUDGET_MS` として定数化。本来の解決（状態問い合わせをキューの外で処理する）は
**#759** へ切り出した。

#### 別 issue へ分離（7 本）

**#755** `select_audio_device` が人間のクリックトグルを共有 /
**#756** `setupStderrHandler` の `ERROR:` 前置が chunk 単位 /
**#757** request 相関ブリッジが 5 本 625 行の重複 /
**#758** 捨てた旧ストリームの disconnect listener が共有 `StreamStats` に `device_lost` を書く /
**#759** `//#getEngineState` が評価キューの後ろに並ぶので長い await 中は状態が見えない

#### 検証（実機・sandbox 外）

```
gated Rust  C-1〜C-7  7 passed / 0 failed
gated MCP   #661 D-0 / D-2 / D-3  3 passed
```

🔴 `cargo test` を Bash の sandbox 内で回すと CoreAudio が塞がれ `Device::name()` が
backend error で落ちる（C-1 まで赤くなる）。実機オーディオのテストは sandbox 外で回すこと。

---

### refactor: apply the second /simplify pass to the device-liveness branch (#661) (Sep 5, 2026)

**Issue**: #661 / **ブランチ**: `661-stream-liveness-instrumentation` / **PR** #748

F4 の実装と D-1/D-3 の書き換えが 1 回目の `/simplify`（`b535527f`）より後に入ったので、
`b535527f..HEAD` を対象に 2 回目を回した（reuse / simplification / efficiency / altitude の 4 体）。
Efficiency は指摘なし（RT コールバック本体・`FIRST_CALLBACK_DEADLINE` の起動予算・1 Hz ticker の
いずれにも新しいコストは入っていない）。

#### 適用した 5 件

| 指摘 | 直した形 |
|---|---|
| `requireCatalogPaths()` が `requireCatalogFixtures()` の完全な部分集合 | 後者が前者を呼ぶ形にして、パス検査を 1 箇所に戻した |
| `--list-audio-devices` で既定デバイス名を取る 5 行が **3 箇所**（D-0 / D-2 / D-3） | `tests/e2e/helpers/audio-devices.ts` を新設（`listOutputDevices` / `defaultOutputDeviceName`） |
| `session.rs` の `OutputError` → protocol code の表が **2 箇所**（直接の `Output` と `SwitchRecoveryFailed.primary`） | `actionable_output_error_code` に集約。6 アーム → 1 アーム |
| `select_audio_device` の `reject_device_switch` が **5 箇所**に散っていた | `dispatch_device_switch` が「owner thread に届く前」の失敗をまとめて `Err` で返し、記録は 1 箇所 |
| 🔴 `resolve_output_device(.., allow_fallback: bool)` / `select_live_output_device(.., allow_dead_fallback: bool)` | **`DeviceFallbackPolicy { FallBackToHostDefault, RejectAndKeepCurrent }`** に置換 |

最後の 1 件が本命。`allow_fallback` と `allow_dead_fallback` という**別名の裸の bool 2 つ**が、
実は owner 裁定（起動時 = host 既定へ縮退／ライブ切替 = 元のデバイスへ復帰）という**1 つの二値
ポリシー**だった。位置引数の `true` / `false` は取り違えてもコンパイルが通るので、
**実装が裁定文と食い違っていた F4 と同じクラスの回帰**が再発しうる形だった。
CLAUDE.md「型で潰す」の適用例（兄弟コールバックを 1 本に畳むのと同型）。

#### 別 issue へ分離した 3 件

| # | 指摘 | なぜ #661 でやらないか |
|---|---|---|
| **#755** | `select_audio_device` がエージェント経路でも人間のクリックトグル（`resolveDeviceClickAction`）を共有していて、**現在のデバイス名を渡すと engine が止まる** | MCP の観測可能な挙動が変わる。D-3 のアプリ分割はこれの回避 |
| **#756** | `setupStderrHandler` の `ERROR:` 前置が **chunk 単位**で、同じ chunk の 2 行目以降が数えられない | **gated 全体の測定器**を動かす。#649 が baseline 比較の最中 |
| **#757** | request 相関ブリッジが **5 本 625 行**の重複（`engine-state-bridge.ts` で 5 本目） | 既存 4 ファイルの書き換えを伴い、無関係な経路に回帰リスクを持ち込む |

#### `cargo test --lib` が 1 回だけ落ちた（順序依存・修正済み）

`device_switch_result_records_failure_and_success_through_the_same_path` が
`captured log: ""` で落ちた。単体実行と再実行は緑。

原因は **`tracing` の callsite interest がプロセス全体で 1 つ**であること。並列に走る別テストが
同じ `tracing::error!` を subscriber の無い状態で先に踏むと `Interest::never()` がキャッシュされ、
捕捉が空になる。捕捉の直前に `tracing::callsite::rebuild_interest_cache()` を呼ぶ形にして、
`--lib` 全件を 3 回連続で緑にした（同型の捕捉テストは 2 箇所あるので両方に入れた）。

#### 検証

`npm test` **2260 passed / 57 skipped** / `typecheck:e2e` 0 / `lint` 0 /
`cargo test -p orbit-audio-native -p orbit-audio-daemon` **152 passed / 0 failed**（22 スイート）/
clippy **5 象限**（4 象限 + `clap-host`）全緑 / `docs:check` **926 verified・0 failed**
（`--fix` で行番号アンカーのみ再固定・16 ファイル）。

---

### test(e2e): split D-3 into its own app and count its failure on both layers (#661) (Sep 5, 2026)

**Issue**: #661 / **ブランチ**: `661-stream-liveness-instrumentation` / **PR** #748

#661 の残り 1 件だった gated `D-3` を実機で緑にした。2 つの別々の欠陥があった。

#### 1. 「切替」ではなく「トグル」になっていた

実機で `audio device deselected and engine stopped: expected false to be true`。
`selectAudioDeviceForAgent`（`packages/vscode-extension/src/extension.ts`）は
`resolveDeviceClickAction` を通しており、**要求デバイスが現在の設定と同じなら「選択解除」**
として扱う（UI のクリック挙動）。D-2/D-3 は同じ fault アプリを共有していて、そのアプリは
`orbitscore.audioDevice` に**既定デバイス名**を持つ。このマシンには出力デバイスが実質 1 台
なので「実在するが現在設定と違う名前」が選べず、D-3 の要求が必ずトグルになっていた。

根は **D-2 と D-3 で必要なアプリ構成が逆**であること:

| | 必要な起動構成 |
|---|---|
| D-2 | 起動時に名前付きが dead → 既定へ縮退して鳴る → **名前付きで起動** |
| D-3 | 演奏中の切替候補が dead → 旧のまま鳴り続ける → **現在の設定と違う名前を要求** |

D-3 を独立した `it.skipIf` に切り出し、`orbitscore.audioDevice: '__default__'` で起動して
既定デバイスを**名前で**要求する形にした（`portBase: 39800`）。`dead-probe-requested` は
「要求された」デバイスに効くので probe が死ぬ。設計 §6 にもこの制約を明記した。

#### 2. 1 回の失敗を 2 層が別々の文言で記録していた

上を直すと今度は `expected [ Array(1) ] to deeply equal []`。除外条件が daemon 側の文言
（`audio output device switch to "X" failed`・`engine_wrap.rs` の `record_device_switch_result`）
だけを見ていたため、engine 側が出す `❌ live device switch to "X" failed: …`
（`packages/engine/src/cli/repl-mode.ts`）が「想定外の ERROR」として残っていた。

- 除外は共通部分 `device switch to "X" failed` で行う
- **利用者に届いたか**は engine 側の文言で「ちょうど 1 行」を要求する。daemon の tracing
  ERROR 行は `outputChannel.append('ERROR: ' + chunk)` が **chunk 単位**で前置するため、
  同じ chunk の 2 行目以降には `ERROR:` が付かず ERROR 行として数えられない
- 落ちた時にデバイス名を含むログ行を全部出す。実機は 1 回 15 秒かかる

#### 検証（実機・sandbox 外）

```
#661 D-0 honors a real named output device and produces audible capture RMS   8255ms  ✓
#661 D-2 falls back from a dead named device at startup and stays audible    14265ms  ✓
#661 D-3 keeps the old stream playing when a live switch candidate is dead   13099ms  ✓
```

`typecheck:e2e` 0 / `eslint` 0 / `prettier --check` 通過 / `docs:check` 926 verified・0 failed。

**関連**: [[reviewers-judge-one-layer-only]]（層をまたぐ契約は片翼だけ見ても分からない）

---

### fix(daemon): keep the current device when a live switch names a missing one (#661 F4) (Sep 5, 2026)

**Issue**: #661 / **ブランチ**: `661-stream-liveness-instrumentation` / **PR** #748

🔴 **owner 裁定 2026-09-05**: ライブ切替で名前が一致しない時は **元のデバイスへ復帰**（縮退しない）。

Fable 監査 F4 が、**実装と設計 §3 の裁定文が食い違っている**ことを見つけた。
`resolve_output_device` の not-found 縮退（`output.rs:315-346`）が**切替経路でも無条件に効く**ため、
存在しないデバイス名を指定すると `ok:true` で **host 既定へ移っていた**。
演奏中に `"Pro Tools Aggregate"` をタイプミスすると内蔵スピーカーへ音が移る形だった。

- `resolve_output_device` に `allow_fallback` を足し、**切替経路では名前不一致・出力不可のどちらでも
  縮退しない**（起動時の縮退は据え置き）。値は既存の `allow_dead_fallback`（起動 `true` / 切替 `false`）
  をそのまま流用した — 「これは起動か」という同じ問いなので、フラグを増やさない
- 新エラー `OutputError::DeviceUnavailable` → プロトコルコード **`AUDIO_DEVICE_UNAVAILABLE`**
- 設計 §3 の確定事項表に裁定を追記

#### E2E D-1 を裁定に合わせて書き換えた

D-1 は**現在の「既定へ移る」挙動を明示的に期待していた**ので、実装と同じラウンドで直した。

- 拒否されること（`isError === true`・メッセージにデバイス名）
- 🔴 **縮退の痕跡（`❌ audio device fallback: requested "..."`）が出ていないこと**
- 増えた ERROR は「切替に失敗した」1 種類だけ（`newErrorLines` で行単位に判定）
- 🔴 **鳴っているデバイスが変わっていないこと** — `get_engine_state` の `output.device_name` を前後で比較。
  **この比較は同ラウンドで新設した bridge があって初めて書ける**（それまで `get_engine_state` は
  `{running}` しか返さなかった）

#### 検証（main が sandbox 外で実測）

- 🔴 **clippy 全 5 象限 green**（default / clap-host / outproc-effect / outproc-instrument / 両方）
- `cargo test --features outproc-effect,outproc-instrument` — lib **268 passed** / protocol **32 passed**
- `npm test` **2260 passed / 0 failed** / `typecheck:e2e` / `lint` exit 0 / `docs:check` **926 verified 0 failed**
- **実機での D-1 / D-3 / D-0 の確認は未実施**

### fix(daemon): keep the old output live while probing a switch candidate (#661 / PR #748 round 1) (Sep 5, 2026)

実機計測で、失敗する切替が本来の 3 秒 probe timeout より約 1.6 秒早く
`STREAM_CALLBACK_STALLED` fatal を発生させ、約 3.1 秒の無音を作ることが判明した。
`apply_device_switch` を **probe → 旧 stream の pause → build → play → confirm** に変更し、
probe 失敗では旧 stream を一度も pause しない。probe と `OutputStream::drop` の
pause-before-drop は維持した。

併せて、probe / real-stream の `StreamDead` を phase で区別し、旧 stream 再開失敗時も元の
失敗理由を保持した。`select_audio_device` の早期拒否も `last_switch_failure` に記録する。
MCP `get_engine_state` は相関 REPL bridge 経由で daemon `GetStatus.output` / `callback` を返す。
gated E2E には、注入なしの実名デバイス起動 + capture RMS、D-3 の不足していた capture 前提確認、
ERROR 上限、`STREAM_CALLBACK_STALLED` 非増加を追加した。名前不一致時の F4 挙動は owner 判断待ちの
まま変更していない。

#### 🔴 この欠陥をどう掴んだか（Fable の予測 → main の実測）

Fable 監査 F1 が「pause が probe より前にあるので、1 Hz の ticker が 2 tick 連続で停止と判定し
**偽の FATAL が決定論的に出る**」と機構から予測し、**反証用のスクリプトを添えて**きた。
main が sandbox 外で回した実出力:

```
[switch-start  2674ms] SelectAudioDevice -> "MacBook Proのスピーカー"
[EVENT  4172ms] STREAM_CALLBACK_STALLED  severity=warning
[EVENT  5172ms] STREAM_CALLBACK_STALLED  severity=fatal     ← 偽の FATAL
[stderr 5802ms] ERROR ... produced no callback within 3000 ms  ← 本物のエラー
```

**本物のエラーより 1.6 秒早く FATAL が出る。** 設計 §6 D-3 の「ERROR が 1 行」は成立しておらず、
実際は DaemonError 2 件 + stderr ERROR 1 件だった。だから D-3 のアサーションは `>=` に緩められていた
（症状に合わせて期待を緩めると、原因が見えなくなる例）。

同時に、**成功する切替が `last_switch_failure` を `null` に戻す**ことも実測で確認できた。

#### レビュアー間で解けた誤検知 2 件

silent-failure が「起動時フォールバックが ERROR でない」「ライブ切替が黙ってすり替わる」と HIGH で
報告したが、どちらも **Rust 層だけを見て TS 層を見落としたもの**だった。

- 起動時の縮退の利用者向け ERROR は `reportAudioOutput`（`rust-engine-player.ts:904-928`）が
  `console.error('❌ audio device fallback: ...')` で出す。engine の stderr は `get_log` で ERROR 行になる
- ライブ切替は `select_live_output_device` の第 4 引数 `allow_dead_fallback` が **`false`**
  （起動は `true`）なので、黙ってすり替わらず `StreamDead` を返して旧デバイスへ復帰する

code-reviewer がこの二層構成を追ったことで解けた。**単層だけ見て「未実装」と判定しない。**

#### 検証（main が sandbox 外で実測・Codex が走らせられなかったもの）

- `cargo test -p orbit-audio-daemon --features outproc-effect,outproc-instrument`
  — lib **268 passed** / **protocol 32 passed**（Codex は sandbox の loopback 禁止で 32 failed と報告していた）
- `npm test` **2260 passed / 0 failed**（loopback を要する HTTP 31 件と daemon-client 32 件も含む）
- `typecheck:e2e` / `lint` exit 0 / `docs:check` **926 verified / 0 failed**

### refactor(daemon): apply the /simplify pass to the device-liveness branch (#661) (Sep 5, 2026)

**Issue**: #661 / **ブランチ**: `661-stream-liveness-instrumentation` / **PR** #748

ゲート③の `/simplify`（4 体並行）。再利用観点は指摘ゼロで、`StreamConfigSnapshot` が既に
`device_requested` / `device_fell_back` / `fallback_reason` / `first_callback_ms` を持っており、
owner 裁定（縮退して鳴らし続ける + 理由を `GetStatus` に記録）の形が型に入っていることが確認できた。

#### 🔴 最重要 — owner 裁定が半分しか実装されていなかった（2 体が独立に指摘）

設計 §3 の確定事項は「起動時 = host 既定へ縮退／**ライブ切替 = 元のデバイスへ復帰**。
**どちらも ERROR ログ + `GetStatus` に理由**」。しかし**起動時の縮退だけ**が `GetStatus` に残り、
**ライブ切替の失敗は `apply_device_switch` の Err 腕で `record_stream_config` も `tracing::error!` も
呼んでいなかった**。理由は RPC のエラー応答と CLI の `console.error` 一回きりにしか存在せず、
**`GetStatus` をポーリングする MCP 経路（LLM / UI の主経路）からは切替失敗が見えない**状態だった。

- 成功・失敗を **`record_device_switch_result` 1 本**へ合流。失敗時は要求デバイス名と理由を
  `tracing::error!` に出し、`StreamConfigSnapshot.last_switch_failure` へ保存する
- `record_stream_config` は snapshot を丸ごと差し替え、コンストラクタが `last_switch_failure: None`
  を置くので、**成功した切替が古い失敗理由を確実に消す**（main が実装を読んで確認）
- 🔴 E2E の D-3 は「ERROR が増えないこと」ではなく「**ちょうど 1 行増えること**」
  （`countErrors(log) >= errorsBeforeExpectedFailure + 1`）へ更新された。
  **ログを出さない方向で辻褄を合わせていない**

#### 却下した指摘（理由を残す）

効率観点が「前置き probe が二重 open を生んでいるので、実ストリームの初回コールバックだけを
ゲートにせよ」と提案したが、**設計で一度検討して却下済み**だった。設計 §4.1:

> `play()` 直後だけに置いてはいけない。`start_output_inner` は `insert_buses` / `sources` を
> `RenderState` に **move** するので、dead 判定後に作り直すには回収が要る。参照循環により
> **名指しデバイスでは `Arc::try_unwrap` が永遠に失敗し、回収できない**。

コストも実測済みで **probe + 事後確認で +20〜40 ms**、`FIRST_CALLBACK_DEADLINE = 3000 ms` は
**失敗時にしか効かない**。読まずに発注していたら直せない状態を作っていた。

#### そのほか適用

未使用の `probe_ms` を削除／`resolved` / `play_and_confirm` / `finish_start` へ重複を集約／
gated テストと E2E の起動ボイラープレートをヘルパー化。

#### 🔴 main が直したもの — リファクタが持ち込んだ型退行

`prepareWorkspace` コールバック経由の代入になったことで、`catalogClapSynthPath` 等 4 件と
`kickLoopWorkPath` が `string | undefined` のままになり `typecheck:e2e` が 6 件の error を出した。
`npm test` は vitest が型を見ないので**緑のまま**で、[[consumerless-code-is-unprotected]] と同じ形。
既存の `requireCatalogFixtures()` を使う形へ寄せ、`requireKickLoopWorkPath()` を足した。

#### 検証（main が sandbox 外で実測）

- 🔴 **clippy を全 5 象限で実行**（default / clap-host / outproc-effect / outproc-instrument /
  outproc 両方）— **すべて green**。`check-cfg-matrix.sh` は 4 象限しか見ないので `clap-host` が漏れる
- `cargo test --features outproc-effect,outproc-instrument` — lib **267 passed**
- `npm test` **2251 passed / 0 failed** / `typecheck:e2e` / `lint` exit 0 / `docs:check` **926 verified 0 failed**

### fix(audio): gate output devices on callback liveness (#661 PR-V4) (Sep 5, 2026)

`--audio-device` で stream の build/play が成功しても callback が一度も来ず、無音のまま
daemon が起動成功していた問題に対し、`Engine` と callback-owned `RenderState` の生成前に
probe stream を開く liveness gate を追加した。probe は専用 `AtomicU64` を使うため、実 stream の
`StreamStats.callbacks` を汚さない。3 秒以内に callback が来ない名指し候補は起動時だけ host
既定へ 1 回縮退し、全候補 dead または実 stream の事後確認 dead は起動を失敗させる。

cpal 0.15.3 の名指し stream 参照循環に対して、`OutputStream::drop` は必ず内部 stream を
`pause()` してから field を破棄する。ライブ切替も旧 stream を先に pause し、新 stream の probe /
事後確認が失敗したら新 stream を pause+drop して旧 stream を再開する。異なる sample rate は
`AUDIO_DEVICE_RATE_MISMATCH` で拒否し、Engine の作り直しは行わない。

`GetStatus.output` に requested / fallback / reason / first callback ms を追加し、engine は正常時の
出力構成を INFO、縮退時だけ `❌ audio device fallback` を ERROR としてユーザーの `get_log` へ出す。
実機 gated Rust C-1〜C-6 と MCP D-1〜D-3 を追加した。

検証: Rust lib 105 passed / 2 ignored、daemon bin 7 passed、gated Rust はコンパイル成功、clippy
`--all-targets -D warnings` 成功、cfg 4 象限成功、`clap-host` build 成功、E2E hygiene 15 passed、
`typecheck:e2e` 成功。`link-audio` / `link-audio-verification` は worktree に Ableton Link submodule が
無く build.rs で失敗。実機 gated と C-6 の pause 除去変異は sandbox では実行しない。
### test(daemon): prove the all-notes-off ledger actually shrinks (#606 round-3) (Sep 5, 2026)

**Issue**: #606 / **ブランチ**: `606-run-termination-noteoff` / **PR** #738

fix 差分の再レビュー（4 体）。**指摘はすべて fix 起因**で、元差分起因の新規指摘は出なかった。

#### 🔴 最も重い指摘 — 中核の機構に検査が無かった

`plugin_all_notes_off` が**成功時に台帳から entry を除去することを検査するテストが 1 本も無かった**。
panic テストは `retain` ブロックに到達する前に止まるので、**ブロックを丸ごと削除する変異が全テストを通過**する。
放置すると台帳が永久に増え、次の解放で**死んだ note を送り続ける**。

- `plugin_all_notes_off_removes_every_released_entry_from_the_ledger` を追加。
  3 件解放して `released == 3` / `stale == 0` / `failed == 0` に加え、
  **`active_plugin_note_count() == 0`** と **ring へ 3 件届いたこと**を検査する
- 🔴 **変異で red を確認**: `retain` ブロック削除 → `left: 3 / right: 0`。
  このとき**既存の他 2 本は通ったまま**で、指摘が事実だったことも同時に裏付けられた

#### そのほか

- **重大度の逆転が半分しか直っていなかった**。`spawn_blocking` の `JoinError`（解放タスク自体が
  panic / cancel = **そもそも試みられていない**）が `warn!` のまま残っていたので `error!` に上げた
- bounded retry の「途中で成功する」分岐が、cfg を広げた後も**bare な `rtrb::Producer` を叩くだけ**で
  本番の `push_outproc_instrument_event`（instance 解決 + lock 分岐）を通っていなかった。
  容量 1 の ring を埋め、15 ms 後に consumer が drain する形で**実経路を通すテスト**を追加
- 設計書の `StopAll` 行参照が二度ずれていた（`2289-2292` → 実体は `2296-2299`）

#### 🔴 私の失敗 — 変異のバックアップに `git checkout --` を使った

未コミットの新テストごと巻き戻した。**git で戻せるのはコミット済みの内容だけ**で、
未コミットの追加があるときはファイル退避が正しい。生成スクリプトが残っていたので復旧できた。

#### 検証（main が sandbox 外で実測）

- `cargo test -p orbit-audio-daemon --features outproc-effect,outproc-instrument`
  — lib **259 passed** / protocol **32 passed**
- `cargo clippy --all-targets -- -D warnings` exit 0
- `npm test` **2251 passed / 0 failed** / `typecheck:e2e` / `lint` exit 0 / `docs:check` **926 verified / 0 failed**
- 実機 gated（`89e9d389`）: **10 failed / 16 passed・退行ゼロ**、`#606 T1` / `#606 E2E-K3` とも ✅

### fix(daemon): close review round-2 on the RUN-termination branch (#606) (Sep 5, 2026)

**Issue**: #606 / **ブランチ**: `606-run-termination-noteoff` / **PR** #738

レビュー 5 体のラウンド2。**実機の受け入れは先に達成している**（T1 / E2E-K3 とも緑・退行ゼロ）ので、
このラウンドで直したのは**診断・記録・テストの区別力**である。

#### 🔴 指摘が 1 件、レビュアー間で解けた

silent-failure が「panic 時に `SessionRegistration::drop` が解放しないので最後の砦が機能しない」（MEDIUM）、
pr-test-analyzer が「その経路にテストが無い」（Critical）と報告したが、Fable の経路列挙と
`main.rs:53-75` の実装で、**daemon の panic hook は `std::process::exit(1)` を呼び unwind しない**ことが分かった。
本番で Drop のフォールバック分岐には**到達しない**（そして daemon が死ねば `ParentWatch` で child も落ちるので音は止まる）。

ガード自体は将来の早期 return に対する保険として残し、**コメントを実体に合わせた**。

#### ポリシー A — 文書とコメントは実体を写す（5 件）

**この PR の fix 自身が作った不一致**だった:

- `clap-host` 単独ビルドは実装が `Ok(空 summary)` なのに、文書 2 箇所が `CLAP_UNAVAILABLE` のまま
- wire 例とフィールド説明に `failed` が無い（実装は常に返す）
- 設計 §3.5 の「quarantine 時は旧 child がまだ鳴っている可能性がある」という**前提そのものが誤り** —
  quarantine の全 variant で child は必ず殺される（`InstrumentChildSupervisor::drop` → watchdog が
  `CONTROL_QUIT` → `reap`）。実害は `released` の水増しに留まる。**#752 の scope に含めると明記**
- 設計 §4 の受け入れ表に T2 が残っていた（実装は**意図して置いていない**・理由はコード側にある）

#### ポリシー B — 診断は読める場所まで届かせる（2 件）

- **`GetStatus` に `active_plugin_notes` を追加**。設計 §1 H4 の問題意識が「台帳に読み手が 0 件」だったので、
  LLM が「stop 後に台帳が空か」を**ポーリングで確認できる**ようにした（`get_log` の 500 行窓に依存しない）
- 🔴 **main が Codex の差分を読んで 1 件直した**: 台帳が読めない（poison）時に **`GetStatus` 全体が失敗する**
  実装になっていた。それではデバイス・レート・uptime・render_contentions まで**異常時にこそ**失われる。
  **その 1 項目だけ `null` に縮退**させ、理由を ERROR ログに出す形にした（文書にも明記）
- disconnect trigger で「そもそも解放を試みられなかった」失敗が `warn!` だったのを `error!` に上げた
  （より軽い「一部の note の配送失敗」が `error!` で、重大度が逆転していた）

#### ポリシー C — テストは区別できる形に（2 件）

- 🔴 panic テストが台帳に **1 件しか注入しておらず**、「push 成功のたびにその場で remove」実装に変えても
  生き残っていた。**3 件注入**（配送成功済み / panic する / 未処理）に直し、変異で
  **`left: 2 / right: 3`** の red を実出力で確認
- 🔴 bounded retry の**「リトライ途中で成功する」分岐**が `#[cfg(feature = "clap-host")]` に閉じており、
  **本番構成（`outproc-instrument` 単体）ではコンパイルすらされていなかった**。cfg を広げ、
  `--features outproc-effect,outproc-instrument` で実走することを確認

#### 先送り（#752 に集約）

code-reviewer が `plugin_all_notes_off` 自身にも同型のレース（スナップショットと最終 `retain` の間の
NoteOn が消える）を見つけたが、**本番の daemon 接続は 1 本のみで RPC も直列化される**ため到達しない。
台帳に識別子を持たせる構造的な解は **#752** にまとめ、ここで部分的に変えない。

#### 検証（main が sandbox 外で実測）

- `cargo clippy --all-targets -- -D warnings` exit 0
- `cargo test -p orbit-audio-daemon` — protocol **29 passed** ほか全 green
- 同 `--features outproc-effect,outproc-instrument` — lib **257 passed** / protocol **32 passed**
- `npm test` **2251 passed / 0 failed** / `docs:check` **926 verified / 0 failed**

### refactor(daemon): apply the /simplify pass to the RUN-termination branch (#606) (Sep 5, 2026)

**Issue**: #606 / **ブランチ**: `606-run-termination-noteoff` / **PR** #738

ゲート③の `/simplify`（4 体並行）。効率観点は**指摘ゼロ**で、台帳のスナップショットは
stop/shutdown の cold path のみ、bounded retry は ring が空いていれば従来と同コスト
（closure 1 回・追加 allocation なし）と確認された。

#### 適用した 4 件

- **二乗平均の重複を解消**: `analysisTailRms` が式を再実装していた。#746 が
  `tests/e2e/helpers/capture-windows.ts` に `quadraticMeanRms` を切り出して main に入ったので、
  本ブランチを載せ替えて **import に差し替えた**（設計 §6.3）
- 🔴 **session カウンタを RAII ガードにした**（`SessionRegistration`）。`session_connected()` と
  `session_disconnected_is_last()` の間で read loop が **panic すると減算に到達せず**、
  `connected_sessions` が永久に加算されたままになる。そうなると**以後どの session が切れても
  最後の砦が二度と発火しない** — daemon が生きている限りずっと、である。
  同ファイルの `InstrumentReplacementReservation` と同じ「明示的な確定 + Drop の安全網」の形にした
- `wrap_err_to_protocol` の `OutProcInstrument` / `OutProcInstrumentStale` が同じ
  `ProtocolError` を返す完全重複だったので or-pattern に畳んだ
- `stopAll()` の 2 つの fire-and-forget が同一の catch ロジック（ログ文言だけ違う）を写していたので
  `warnUnlessDisconnected(label, err)` に切り出した

#### 適用しなかった 1 件と、その理由

`tailDelay = patternDuration + (scheduleTime - currentTime)` を `patternDuration + 100` に畳む案は
**採らない**。`scheduleTime` は 2 行上で `currentTime + 100` と定義されているので値は同じだが、
差で書いてあることに意味がある — **尻尾はイベントを実際に置いた原点から測る**必要があり、
`scheduleTime` の決め方が将来変わっても自動で追随する。この整合こそが「RUN 終端で音が止まる」の
前提なので、定数へ畳んで結合を切らない。**理由をコメントに書いた。**

テスト重複の指摘 1 件も見送った（アサーションを減らす方向なので）。

#### 先送りしたもの（設計 §6 に記録）

- 🔴 **台帳のキーを slot 同一性にする → #752**。`ReplacePlugin` のスナップショットと再ポイントの間に
  届いた旧 instance 宛 NoteOn は台帳に残り、次の `PluginAllNotesOff` が**新テナントへ NoteOff を送って
  鳴っている音を切る**。本 PR が直した欠陥の鏡像。**窓を狭めるだけでは閉じない**（`plugin_note_on` は
  push → 台帳 insert の順で、その間 control lock を持たない）。
  🔴 **本設計で「wire が名前しか運ばないから無理」と却下したのは誤りだった** —
  `push_outproc_instrument_event` は note の時点で名前→index を解決済みで、`tenant_generation` も既にある
- タイマーのライフサイクル管理点が 2 箇所に分かれている件（設計 §6.2）

#### 検証

- `npm test` **2251 passed / 0 failed**
- `cargo test -p orbit-audio-daemon --features outproc-effect,outproc-instrument`
  — lib **252 passed** / protocol **32 passed**
- `clippy --all-targets -- -D warnings` exit 0 / `typecheck:e2e` / `lint` exit 0

### fix(daemon): make the all-notes-off ledger survive its own failures (#606 round-1) (Sep 5, 2026)

**Issue**: #606 / **ブランチ**: `606-run-termination-noteoff` / **PR** #738

レビュー 5 体（Sonnet 4 + Fable）の指摘を 2 つの横断ポリシーへ集約して一括で直した。
指摘単位のローカルパッチは振動の主因なので置かない。

#### ポリシー A — 壊れた時に真因が残ること

台帳を **drain（取り切り）→ 失敗分を戻す**のをやめ、**clone → 送出 → 解放済みだけ除去**に向きを反転した。

- 🔴 旧実装はループ内で panic すると（`push_outproc_instrument_event` に
  `.expect("instance_index always maps to a pre-allocated slot")` がある）**台帳が丸ごと消え、
  二度と復元されなかった** — 最後の砦が最後の砦でなくなる。反転後は panic が「台帳が残る」＝安全側に倒れる
- 復帰用 `extend` と、そこにあった**無言の `poisoned.into_inner()`** が消えた（drain 側は大声の `Err`
  だったので扱いが非対称だった）
- `PluginAllNotesOffSummary` に `failed` を足し、配送に失敗しても **`Ok(summary)` を返す**。
  `Err` は台帳そのものが読めない（poison）時だけ。呼び手が知りたいのは「音が残ったか」で、
  それに答えるのは `failed > 0` という機械可読な数であって不透明な `Err` ではない
- 最初のエラーは released/stale/failed と一緒に `tracing::error!` へ 1 回だけ

#### ポリシー B — 暗黙の結合を検証する

台帳の鍵は**名前**だが、スロットの同一性は **index + 世代**である。この 2 つがずれる窓を塞いだ。

- 🔴 `ReplacePlugin` は `instance_index.insert(name, spare)` で**名前を新スロットへ向けた後**、
  teardown（最大 500 ms 待つ）を挟んでから名前一致で台帳を掃除していた。その窓で新テナントへ届いた
  NoteOn は同じ `(name, ch, key)` として台帳に入り、**巻き込まれて消える → その音が解放されず鳴りっぱなしになる**。
  **3 体のレビュアーが独立に指摘した唯一の項目**
- 修正: **再ポイントの前に**旧テナントの entry を写し取り、teardown 後は**その集合だけ**を消す。
  lock の入れ子は作らない（control を握ったまま台帳 lock を取らない）
- `push_outproc_instrument_event` を `push_with_bounded_retry` に載せた。in-process の兄弟は
  同じ物理状況（ring 満杯は一時的）に既に bounded retry を持っており、**片方だけ one-shot** だった
- 台帳 lock + poison 文言の 5 重複を `lock_active_notes` に集約（poison の扱いが構造として 1 つになる）

#### そのほか

- session 切断 trigger を「**最後の確立済み session が切れた時だけ**」に変更。台帳は daemon 全体で
  共有なので、2 つ目のクライアントが切れて 1 つ目の音が止まる形を避ける
- `clap-host` のみのビルドは空 summary を返す（`global.stop()` のたびの警告が消える）
- `engine_wrap.rs` の active-note 台帳コメントを実体に合わせた

#### 検証（main が sandbox 外で実測）

- `cargo clippy --all-targets -- -D warnings` exit 0
- `cargo test -p orbit-audio-daemon` — protocol **29 passed** ほか全 green
- `cargo test -p orbit-audio-daemon --features outproc-effect,outproc-instrument`
  — lib **252 passed** / protocol **32 passed** / `plugin_all_notes_off` 1 passed
- `npm test` **2224 passed / 0 failed**

🔴 Codex は sandbox で protocol テスト（loopback bind）を走らせられず 29 件 red と報告していた。
**同じテストが sandbox 外では全部 green** — 委譲先の赤も緑も main が回し直す。

### feat(audio): add daemon-side plugin all-notes-off fallback (#606 PR-K-A2) (Sep 5, 2026)

**Issue**: #606 / **ブランチ**: `606-run-termination-noteoff` / **PR-K-A2**

OOP instrument の active-note 台帳を drain して個別 `NoteOff` を送る
`EngineWrap::plugin_all_notes_off()` を追加した。配送関数はこの 1 本に集約し、明示
`PluginAllNotesOff` RPC と WebSocket session 切断直後の 2 箇所から起動する。これにより、
engine が異常終了して RPC を送れず daemon と instrument child だけが残る経路でも解放できる。
台帳 lock は drain 中だけ保持し、ring push 前に解放する。`ReplacePlugin` の旧 tenant entry は
teardown 成功時だけ除去し、quarantine 時は最後の砦が拾えるよう保持する。

TS は `RustEnginePlayer.stopAll()` の既存 `StopAll` の直後だけに flush を配線した。
空の要約は無言とし、`released` または `stale` が非 0 の時だけ stdout に要約を出す。
protocol/core spec に wire 契約と 2 trigger を記録した。

protocol / gated / TS テストは実装ファイルと分離して先に追加し、未実装状態で Rust は新 API
不在の E0599、Vitest は `pluginAllNotesOff is not a function` の red を確認した。sandbox の bind
制限下でも本体を実行できる socket 非依存 integration を実装後に補助追加した。実装後は Rust lib
（default: 39 passed、outproc-instrument: 131 passed / 1 ignored）、同 integration、対象 Vitest、
cfg 4 象限 clippy、E2E typecheck、lint が green。WebSocket integration は sandbox の loopback
bind が `EPERM`、実機 gated E2E は指示どおり未実行。全 `npm test` は 153 files / 2118 tests が
pass した一方、loopback 使用箇所が同じ `listen EPERM: operation not permitted 127.0.0.1` により
4 files / 106 tests fail（55 skipped）した。git metadata が親 worktree 配下にあるため sandbox が
`index.lock` を拒否し、要求された test-only / implementation の 2 commit は作成できなかった。

---

### test(e2e): make the phase sweep actually discriminate the float-family bug (#746 round-3) (Sep 5, 2026)

**Issue**: #739 / **ブランチ**: `739-capture-windows-follow-sound` / **PR** #746

ラウンド2 で入れた「500 位相スイープ」が、**守るべき欠陥を検出できていなかった**。

#### 何が起きていたか

ラウンド2 は「`onsets`（`w * WINDOW_SEC`）と `windows[].startSec`（`start / sampleRate`）が
**別の浮動小数の族**で、`>=` / `<` 比較が位相で 199/200/201 に揺れる」を整数バケット index への
統一で直し、500 位相スイープを常設した。

🔴 **main が変異検証したところ、ウィンドウ選択を元の族またぎ比較へ戻しても、そのスイープは緑のままだった。**

原因: スイープは**合成 WAV 内の打撃時刻を固定したまま capture 区間だけ**を 1 バケット内で動かすので、
`firstOnset` が実質 1〜2 値しか取らない。**ずれの発生源は絶対バケット index**（2 つの族の乖離は
`w` が大きいほど広がる）なので、区間を動かしても再現しない。

Codex が回した変異（`steadyRms` が NaN を返す）は「アサーションが結線されている」ことしか示しておらず、
**シナリオが欠陥を区別できるか**は示していなかった。

#### 直したこと

- **絶対 onset index を 1000 通り掃く**テストを追加。音を合成せず、`wav-analysis.ts` の 2 つの族を
  そのまま再現した stub を `steadyRms` / `measuredBucketCountForSteadyRms` に渡す
  （`resolveMeasuredRange` は `Pick<CaptureWindows,'windows'|'onsets'>` を取るのでスタブで足りる）
- 🔴 **変異で red を確認**: 族またぎ比較へ戻すと
  `expected [ 200, 199, 201 ] to deeply equal [ 200 ]` — Fable が実測した分布がそのまま出る。
  復元後 46 件 green（`cmp` で復元一致を確認）
- 500 位相スイープは**残す**（実音声の経路を端から端まで通す役）。ただしコメントに
  **「この変異はここでは生き残る」**と明記し、区別する役は新テストだと書いた

#### 同ラウンドで直した残り

- 500 位相スイープが `steadyRms` **本体**を全位相で呼ぶようにした（従来は診断関数だけで、
  onset 数一致・周期性・可聴床のアサーションを通っていなかった）
- `hitPeriodSec` が `ANALYSIS_BUCKET_SEC` の整数倍でなければ**明示的に throw**（暗黙の前提を検査）
- コメントの不正確 2 件（"four" → "five"、D-2 の根拠づけが下のテストに当てはまらない点）

#### 検証（main が本ツリーで実測）

- `npm test` **2238 passed / 0 failed**
- `typecheck:e2e` / `lint` exit 0
- `docs:check` **926 verified / 0 failed**
- 実機 gated: **`main` baseline 10/24 と失敗集合が完全一致 = 退行ゼロ**（同日・同一条件で baseline を取り直した）

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
- [2026-09（前半・09-01〜09-04）](../archive/WORK_LOG_2026-09.md)

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
