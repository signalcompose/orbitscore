# OrbitScore Development Work Log - 2026-08 Archive

**Archive Period**: 2026-08（6.348-6.422）
**Note**: This is an archived version of the work log. For recent work, see [../development/WORK_LOG.md](../development/WORK_LOG.md)

---

### 🔴 本番前夜の無音障害と、そこから起票した 7 件 (Aug 31, 2026)

**SIGMUS 演奏（840）の直前に音が出なくなり、演奏が 1 時間以上止まった。**
原因調査と、そこから見えた構造的な課題の起票。

**Issue**: #661 #662 #663 #664 #665 #666 #667
**設計正本**: `docs/design/662-engine-visibility-and-limits.md`（コミット `563e1c1b` / `66a9871a`）

#### 原因（#661）

`orbitscore.audioDevice` を設定すると **オーディオコールバックが一度も回らず完全に無音**になる。

| daemon の起動引数 | daemon CPU | 音 |
|---|---:|---|
| `--audio-device 外部ヘッドフォン` | **0.0%** | ❌ |
| なし（システム既定） | 0.6〜1.0% | ✅ |

デバイス名の照合は成功しており（不一致なら stderr に警告が出るが出ていない）、
`default_output_config()` も通っている。**選択に成功したうえでストリームが死ぬ。**

#### 🔴 発見が遅れた理由は原因とは別にある

> エンジンは知っていた。誰も見られなかった。

エンジンは「どのデバイスを掴んでいるか」「コールバックが回っていないこと」
「Kontakt 7 本が CPU 95〜99% でレンダリング中であること」をすべて知っていたが、
**画面に出ていたのは「すべて正常」に見えるものだけ**だった
（`ok` / ERROR 0 / `✅ Global starting` / `🔄 loop queued`）。

この非対称を潰すのが #662（Audio Settings パネル）。

#### 切り分けを誤らせた 2 点（記録）

- **成功した `instrument()` ロードはログに何も出さない**（出るのは失敗時だけ）
- **child のプロセス名は `orbit-vst3-instrument-child`**（`Kontakt` でも `plugin-host` でもない）

この 2 つから「instrument が黙って無視されている」という誤った本命仮説が生まれた。
実際には Kontakt は最初から正常に鳴っており、**音が出口に届いていなかっただけ**。

🔴 **沈黙を「壊れている証拠」と読むのは、沈黙が正常な場合には成り立たない。**

#### 起票した 7 件

| | 内容 |
|---|---|
| **#661** | `--audio-device` が無音ストリームを作る |
| **#662** | Audio Settings パネル（傘）— 可視化・帰結表示・MIDI panic・再起動要否の属性化 |
| **#663** | スロットプールの動的拡張（上限の撤廃）。**#667 が前提** |
| **#664** | エフェクト挿入 + プラグイン UI を開く（セット・早めに） |
| **#665** | audio シーケンスで tie が無視される |
| **#666** | Splice 連携（公式 Splice Sounds VST3 経由） |
| **#667** | child が**アイドル時でも各 1 コアをビジーウェイト**で占有 |

#### #667 — アイドルで 99% はコードで裏が取れた

`orbit-vst3-instrument-child/src/main.rs:346` ほか **全 5 種の child**:

```rust
if cur <= last { std::hint::spin_loop(); continue; }
```

`std::hint::spin_loop()` は CPU への pause ヒントで**スレッドを譲らない**。
理由を書いたコメントは 1 つも無く、**RT 優先度も設定されていない**。

**1 プラグイン = 1 コアなので、#663 で上限を外しても実質の上限はコア数で決まる。**

#### 🔴 起案者（main）の誤り 2 件

いずれも **owner の指摘で調べ直して判明**した。issue の冒頭に残してある。

| issue | 誤り | 実際 |
|---|---|---|
| **#666** | 「Splice に公開 API は無いのでアプリ内検索・DL は作らない」 | **公式の Splice Sounds VST3 が存在**し、owner のマシンにインストール済みで、**OrbitScore のカタログにも載っていた**（`roles=['instrument']`）。検索語が悪く別物の Splice を拾っていた |
| **#665** | 「audio は常にスロットへ varispeed で詰められる」 | **`chop(n>1)` の時だけ**。rate 式の存在は確認したが、**そこに至る分岐を確認しなかった** |

**「式がある」と「常に適用される」を取り違えた。** 経路の分岐を確認してから書くこと。

#### 併せて仕様書を修正

`docs/core/INSTRUCTION_ORBITSCORE_DSL.md` §3 "Slice-to-Slot Fitting" は
varispeed のフィットを「default slot-fitting behavior」と書いており、
**`chop(n>1)` の時だけであることが読み取れなかった**。演奏側と main の両方が同じ誤読をした。

非 chop / `chop(1)` は**自然尺・自然音程で鳴りスロットを越える**（ワンショットとして有用な挙動）
ことを明記し、誤読が起きた経緯も注記として残した。

---

### docs: エディタホストとアプリサイズの調査 (Aug 30, 2026)

**Issue**: なし（調査記録）／関連 #656 #659
**成果物**: `docs/research/EDITOR_HOST_AND_APP_SIZE.md`

owner の「VSCodium は大きい。.vsix を使ってもっと軽い環境はないか」という問いへの調査。

**結論**: 自作しない。VSIX 配布 + 軽量化した VSCodium を同梱（owner の判断どおり）。

**根拠（実測）**:

- 拡張 9131 行のうち **vscode 非依存が 4726 行**（MCP サーバ 1395 行は `vscode.` の実呼び出しゼロ）。
  自作した場合の書き直しは 4405 行で、その中身はダイアログ・コマンドパレット・設定システム・
  ツリービュー — **テキスト編集ではない**。加えて VS Code が無料で提供している機能が全部自前になる
- **🔴 889MB のうち 334MB がソースマップだった**。実行時に読まれないデバッグ用ファイル。
  `workbench.desktop.main.js.map` 87MB / `sessions.desktop.main.js.map` 86MB ほか 29 個
- トリムして起動を実測: **889 → 555MB（マップ削除）→ 481MB（不要拡張も削除・46% 減）**。
  MCP 応答 6 秒 / 840.orbs 評価 / ERROR 0 / `running:true, liveCoding:true`
- **🔴 削除すると codesign が壊れる**（`code has no resources but signature indicates
  they must be present`）。手順は「ビルド → トリム → 署名 → notarize」の順に固定が必要

**検証の限界（doc §4.4 に明記）**: `debug: true` なしで起動したため `[STEP]` を確認していない。
実音も聴いていない（ログ上 ERROR 0 と transport running までの確認）。

**未確定**: 削る拡張の取捨。`typescript-language-features`（`perform/cue.ts` を編集するなら要）と
`mermaid-markdown-features`（56MB）は owner 確認が要る。判断の余地が無いのはマップ削除のみ。

**副次的な確定事項**: `.vsix` が機能の 100% を持ちアプリ側に固有実装が 1 行も無いため、
**アプリは製品ではなく配布形式**。この位置づけを保つ限り上流追従は rebase 一発で済み、
バージョンはアプリ版 = 拡張版で自動的に揃う。

---

### 6.422 fix: engine のランタイム依存が hoist で bundle から抜け落ちていた (Aug 30, 2026)

**発見経路**: #654 の実機ゲート。拡張を焼き込んで通常起動したら
`Cannot find module 'yaml'` でエンジンが起動しなかった。

#### 何が起きていたか

`scripts/install-engine-deps.sh` は `packages/vscode-extension/engine` の中で
`npm install` していた。このディレクトリは**ワークスペースの内側**なので、
root の `node_modules` に既にある依存を npm が「充足済み」と判断して
**root へ hoist し、bundle には書かない**。

`yaml` がまさにそれで、6つの宣言済み依存のうち 1 つだけが欠けていた:

| 依存 | bundle に入っていたか |
|---|---|
| `@julusian/midi` / `supercolliderjs` / `uuid` / `wavefile` / `ws` | ✅ |
| `yaml` | 🔴 **欠落** |

🔴 **ビルドは緑・vsix のパッケージングも成功・インストールも成功**して、
**エンジンの初回評価で初めて落ちる。** どの段階でも警告が出ない。

#### 直し方

1. **ワークスペースの外（`mktemp -d`）で `npm install` し、できた `node_modules` を移す。**
   temp dir の上にはワークスペース root が無いので、npm に hoist 先が存在しない
2. **宣言済み依存が全部着地したかを検証し、欠けていたら `exit 1`。**
   この故障はビルド時に見えず実行時にしか出ないので、検査をここに置くしかない

（同型の再発防止: [[green-tests-do-not-mean-it-compiles]] と同じ「緑は根拠にならない」型）

---

### 6.421 fix: #654 instrument シーケンスで playhead が動かなかった (Aug 30, 2026)

**Issue**: [#654](https://github.com/signalcompose/orbitscore/issues/654) / ブランチ `654-instrument-playhead`

#### 症状

840（SIGMUS 用の新曲・7層）を実機で鳴らしたところ、**`audio()` の gong 1層だけ**が
playhead（#390 の `play()` 引数ハイライト）を刻み、**Kontakt の 6 層は静止したまま**だった。

#### 原因 — 退行ではなく、最初から片翼だった

playhead の唯一の情報源である `[STEP]` 行を出しているのは
`rust-engine-player.ts:1559` の 1 箇所だけで、到達経路は**オーディオの 2 つのみ**:

- `daemon.playAt()` 成功後（発音スロット）
- `markerOnly` の休符スロット（`event-scheduler.ts` の `sliceNumber === 0` 分岐）

`argPath` は `TimedEvent` に存在し（`timing/calculation/types.ts`）、audio 側は
`event-scheduler.ts` がスケジューラへ渡している。しかし **MIDI 側は `sequence.ts` の
Stage C で捨てていた** — `ScheduledMidiNote` は `owner / port / channel / note /
velocity / detune / onTime / offTime` だけで、`argPath` を運ぶ場所が無い。

つまり #390 は audio 経路にしか配線されていなかった。

#### 変更（TS のみ・Rust 不要）

| ファイル | 変更 |
|---|---|
| `midi/midi-scheduler.ts` | `scheduleStepMarker(time, owner, argPath)` を追加。marker-only のアクションを既存キューへ積む |
| `core/sequence.ts` | `scheduleMidiEvents` の末尾で、`timedEvents` を 1 スロット 1 回だけ marker として積む |

設計上の判断:

- **`owner` を marker の queue owner に兼ねさせた** → `clearOwner()` / `stop()` で
  ノートと一緒に取り消される。停止後も行進し続ける playhead は、動かない playhead より悪い
- **休符 `0` とタイ `_` でも刻む** → audio 経路の marker-only 分岐と同じ。刻まないと
  「音符の所だけ飛ぶ」中途半端な playhead になる
- **stack は 1 スロット 1 marker にデデュープ** → `[ ]` は voice ごとに `TimedEvent` が出て
  すべて同じ `argPath` を持つため、素直に積むと同じスロットが 3 回光る
- **marker は `sendDelay` を足さないグリッド時刻に置く** → audio 側もグリッドを打つので、
  ポートごとの送出補正を混ぜると**層どうしを比べられなくなる**。playhead の存在理由そのものが崩れる
- **無名シーケンスでは出さない** → 文法の `seqName` は `\S+`。空名だと行が壊れて黙って捨てられる

#### テスト

`tests/core/sequence-midi-step-marker.spec.ts`（新規 7 件・実装前に red を確認）—
実 `MidiScheduler` を通し、`Sequence.run()` から end-to-end で marker 列を検証:
スロット順とグリッド時刻 / 休符 / タイ / stack のデデュープ / mute / stop / 無名。

**実機 E2E**: `tests/e2e/orbitstudio-mcp-gated.spec.ts` に
「`instrument()` シーケンスで playhead が休符も含めて刻む」を追加。
`[STEP]` は `shouldFilterLine()` が通常モードで output channel から除外するので、
**`start_engine({ debug: true })` で起動**して `get_log` から観測する（唯一の観測経路）。

これにより DSL カバレッジ・ラチェットの baseline が 19 → 16 に縮んだ
（`length` / `octave` / `run` が実機カバー済みになった）。

---

### 6.420 design: #649 オーディオライン設計を v3 まで — 3回とも実装を読まずに規則を発明していた (Aug 30, 2026)

**正本**: `docs/design/649-audio-line-design.md`（448行）/ 起案 Fable（3稿）・審査 main

#### 原理（owner 確定）

> **メソッドチェーンの順序が、オーディオラインでは決定論になる。**

**境界は「音が生まれる点」。** instrument も audio も、そこから先は同じ扱い。

DAW の `pre-fader` / `post-fader` / `post-pan` が 2〜3 値しか無いのは、**フェーダーが物理的に
1つで位置が固定されているから**。OrbitScore はチェーンを言語で書くので、**書いた場所が位置**になる。

owner:
> 技術仕様的にハードウェアを作っているわけではないわけだから、**ソフトウェアとしての言語
> としての表現で考える**方がいいのではないでしょうか。

#### 🔴 3回とも main が先に間違えた

| 稿 | 発明した規則 | 実際 |
|---|---|---|
| v1 | `send` の pre/post は **insert 基準** | **フェーダー基準**。Logic / Ableton / Bitwig の公式マニュアルが3社とも「フェーダーとパンに対して」と定義。Logic の **Post Pan** という第3の選択肢が決め手（パンが別ステージである証拠） |
| v1 | `gain` は**ラック内**（`.gain(-6)` ≡ `.effect([Gain])`） | **ラックの外**。ラックが1つのオブジェクトなのは**順序を決めるため**で、ゲインがその中にいる必然性はない |
| v2 | **像 = 評価**（単文でラインが置き換わる） | メソッドは**独立スライスを更新**。`kick.gain(-6)` 単独評価では `effect()` が呼ばれないので**何もアンロードされない**。**発明する必要がなかった規則** |

**原因はいずれも「実装を読まずに、あり得る規則を設計側で発明したこと」。**
設計は「あり得る規則」をいくらでも作れ、作った規則は自己整合しているので、
**読まずに書くともっともらしい設計が完成してしまう。**

#### 🔴 既存の調査・設計を読まずに始めていた（同日4回目の同型）

owner に2回指摘されて、ようやく読んだ:
- `docs/research/DAW_AUDIO_ARCHITECTURE.md`（28KB）— **5 DAW の比較と信号図が既にあった**
- `INSTRUCTION_ORBITSCORE_DSL.md` MX.1〜MX.5 — ルーティングモデルが既にあった
- `docs/development/POST_2.0_MIXER_DSL_DESIGN.html`（30KB）

**私が owner に「未決」として投げた2点は、すでに答えのある問いだった。**

#### v3 が実装を読んで確定した事実

1. **評価は3経路**（選択あり=そのまま / 選択なし=主語の全行 / MCP=呼び出し側任意）。
   すべて `writeCodeToEngine` に収束（`extension.ts:2884-2887` が明言）
2. 🔴 **エンジンは文書を持たない**（評価 = stdin へのテキスト断片）。
   **「再評価のたびにソースを読み直す」は物理的に不可能** —
   **main の仮説（テキストが位置の源だから新規則は要らない）を v3 が否定した**
3. メソッドは**完全に独立したスライス**を更新（`_auxSends` は Map・`_sumOutputBus` は別フィールド）

#### 設計（v3）

- 新設は **`_lineOrder`（要素キーの順列）1つだけ**。値は既存スライスに残る
- **カーソル規則**: 単文は値だけ更新・位置不変。主語ブロックは行順が位置になる
- **評価バッチ境界**: `//#evalBegin` / `//#evalEnd` を注入（`//#evalMark` #614 の3例目）
- **gain/pan = ラック外の native stage スカラー** → **child プロセスを増やさない**
  （v1 では send ごとにプロセスが増える設計だった）
- **wire は新コマンドゼロ**。RT 追加 ~40-60 行。**bit 一致は構造的に維持**

#### 分割 — B で止めても実害が解消する

**B-0**（測定ラダー）→ **B**（ラインモデル）→ C（多 stage）+ A（Pan std・並行可）

🔴 **B-0 を省略しない**: `global.gain()` が instrument に効かない**原因は未特定**。
静的配線は完全なので**動的事象**。**新モデルで E2E-1 を green にするだけでは、
旧経路の他の消費者が壊れたままになりうる。**

#### 併せて: #649 の原因説明を訂正

私が issue に書いた「post-loop が gain の後に stage を加算するから」は
**E2E-1 を説明しない**（E2E-1 の instrument はバスを経由せず `FeedDest::Hardware` で
gain ループの前に加算される）。**Fable が「特定し切れていない」と正直に書いたことで発覚。**

---

### 6.419 fix: レビュー5体の指摘を適用 — Critical 2件はいずれも実バグ (#652) (Aug 29, 2026)

`/simplify`（4観点・別途適用済み）に続き、`/code:pr-review-team`（Sonnet 4体）と
**Fable 監査を並行**で回した。

#### 🔴 Critical 1: 全ウィンドウが永久に開閉不能になる（**2体が独立に検出**）

`UiEventHub.open_cycle` は **1 child 内の全 window で共有**され、`UI_CLOSED{w}` を載せてから
`UI_CLOSED_DONE{w}` を載せるまで他 window の publish を止める。ところが
`RackController::collect_retired` は**世代の到達だけ**を見て stage を退役させ、
`UiService::Drop` は**ゲートを戻さない**。

**故障**: UI が開いている stage が APPLY で drop → close cycle 進行中に退役 →
`open_cycle` が `Some(w)` のまま残る → **同じ child の他の全ウィンドウが二度と開閉できない**。
エラーもログも出ない。

**直した位置**: `Drop` で塞ぐのではなく**退役条件**へ。設計 §4.8-(3) が
「child の防御 close が cycle を完走させる」としているので、**完走するまで退役させない**のが筋。

```rust
.retain(|dropped| dropped.publish_generation > adopted || !dropped.ui_is_settled());
```

`ControlStage::ui_is_settled()` を新設（既定 `true` = UI を持たない stage は妨げない）。

#### 🔴 Critical 2: コメントと実装が逆（本日の自作コード）

`sync_header` の失敗で `break Err(e)` していた。コメントは「失敗しても capture 自体は続ける」。
**1回の一時的な失敗で以降の音声が一切録れなくなる** — capture を一次資料にするという目的を、
その保険自身が壊していた。握り潰さず報告して継続する形へ。テストで固定。

#### 2体が収束した指摘

| 指摘 | 検出 | 対応 |
|---|---|---|
| **ヘッダが未 flush 分を過大申告**（`kill -9` で data が EOF を越える） | comment-analyzer / Fable | `flush()` を先に |
| `UiWindowKey` の doc が**実在しない区別**（"single-plugin effect children"）を語る | comment-analyzer / Fable | 訂正（effect は常に `Some`） |
| `pluginChainPath` が**「唯一の写像」を二重に主張** | comment-analyzer | 委譲であることを明記 |

#### 🔴 Fable の主指摘（Medium）: 拒否された token で簿記していた

daemon の binding 検査が「その index は window w1 に束縛済み」と拒否した時、TS は**自分が採番した
w2 で記録**していた。結果:

- DSL からの close は w2 で発行 → binding 不一致で必ず loud 失敗 → **二度と閉じられない**
- ユーザーが手で閉じてもイベントは w1 を運ぶ → 保存も拒否

拒否文言に daemon の保持 token が入っているので、**それを読んで実体へ再同期**する形にした。
S7 で固定し、**再同期を外すと red** になることも確認。

#### Fable が「実在」を確認した項目（不在証明）

設計 §1 の完了条件 1-9 と §5 の失敗モード表（P1-P14 / W1-W10 / H1-H6 / S1-S6 / E2E-2）は
**欠落行ゼロ**。`index_binding` の用途 (i)(ii) とも配線済み。
§4.7-(3)「`target.index` を帰属に使わない」も、残存4箇所すべてが**帰属ではない**ことを確認。

#### 検証

cfg 4象限すべて緑 / clippy（両 feature）exit=0 / rust 全 crate 0 failed /
lint exit=0 / **2158 passed**

---

### 6.418 test: 今日の是正を「知識」から「再現可能な仕組み」へ (Aug 29, 2026)

> 今回かなりテストなどの是正が出来てると思うのですが、**これをただの知識ではなく再現可能な
> 仕組みにする**様にしてください。（owner）

**文章は読まれない時がある。** 実際この日、CLAUDE.md に書いてある規律を**私自身が3つ破った**
（`npm run build` を飛ばす / 変異検証を最後の手段にすると書いた直後に実行 / DSL を足したら
E2E も足す）。規律を足す時は、**同時にそれを守らせる仕組みを足す**。

#### 1. DSL 網羅率のラチェット（`tests/e2e/dsl-e2e-coverage.spec.ts`）

**未カバーの語が増えたら red。減る分には落ちない。**

- 新しい DSL 語を足して E2E を書かなければ、**その語の名前を挙げて落ちる**
- baseline は**減らす方向にしか編集できない**（covered になったのに baseline に残っていたら
  「baseline を正直に保つ」検査が別途落とす）

**実証**: `SEQUENCE_DSL_METHODS` に架空の語を1つ足して E2E を書かない状態を作ると、
`expected [ 'brandNewDslVerb' ] to deeply equal []` で red。restore で green。

**書いた直後に仕事をした**: `global` 側にも未カバーが **8語**あることが判明
（`compressor` / `limiter` / `normalizer` / `linkAudio` / `audioDevice` ほか）。
前3つは master チェーンの語で、**#649 と同じ領域**にある。

#### 2. アサーション衛生（`tests/e2e/gated-assertion-hygiene.spec.ts`）

gated spec の**ソースを検査**して、弱いアサーションの型を機械的に探す:

- ERROR 件数の**厳密等価**（固定 500 行窓なので古い ERROR が流れ出るだけで落ちる・#625）
- capture するのに **rms を一度も見ていない**
- stale ガードが `resolveDaemonBinaryPath()` を**呼ばずに決め打ちへ戻る**

**書いた直後に実在の1件を検出**: `orbitstudio-mcp-gated.spec.ts:1403` の
`.toBe(errorCountBeforeMixer)`。`<=` へ修正した。

#### 3. cfg 4象限スクリプト（`scripts/check-cfg-matrix.sh`）

**同じ日に2回**、このループを手書きして壊した:

```bash
for F in "" "--features outproc-effect" ...; do cargo build $F; done
```

zsh は**引用されていない変数を単語分割しない**ので `--features outproc-effect` が1引数として
渡り、cargo が拒否する。「3象限が落ちている」と報告したが**実際は全象限緑**だった。

**測定手段が壊れていると、緑も赤も意味を持たない。** ループを1箇所へ閉じ込めた。

#### 既に仕組みになっていたもの（この日に効いた）

| 仕組み | 何回発火したか |
|---|---|
| `pretest:e2e:gated`（自動ビルド） | 手順そのものが消えた |
| DSL 語彙の分類テスト | **2回**（`pluginUiSessionForInstance` / `findPluginUiSession`） |
| pre-push の `cargo fmt` / clippy | **2回**（整形漏れ / 重複 `#[test]`） |
| stale ガード | 触って古くした状態で発火を確認 |

#### CLAUDE.md に対応表を追加

「規律 ↔ それを守らせる仕組み ↔ 違反するとどうなるか」を1つの表にした。

#### 検証

`npm test` **2157 passed**（+8）/ typecheck:e2e / lint とも exit=0 / cfg 4象限すべて緑

---

### 6.417 fix(e2e): 実機テストが古い daemon で走っていた — 手順を消して自動化した (#651) (Aug 29, 2026)

#### 🔴 今日の実機 E2E は、すべて 17:49 のバイナリで走っていた

`#651` のヘッダ修正が実機で効かず、**仮説を4つ立てて4つとも外した**。最後に
システム上の daemon を全列挙して確定した:

```text
probe=1  19:01  rust/target/release/orbit-audio-daemon                      ← ビルドしたもの
probe=0  17:49  packages/vscode-extension/engine/bin/darwin-arm64/...       ← 実際に動いていたもの
```

**拡張は daemon を同梱している。** engine が `<extension>/engine/dist/` から動くため、
`daemon-client.ts` の解決順で `<extension>/engine/bin/<platform>/` が当たる。
同梱コピーを更新するのは **`npm run build` の `build:copy-engine`**
（`scripts/copy-daemon-bin.sh`）で、`cargo build` では更新されない。

**私は `cargo build` だけ回して `npm run build` を飛ばしていた。**
CLAUDE.md のマージ前ゲートには `npm run build` と書いてある。**手順は存在し、私が守らなかった。**

#### 🔴 owner 判断: 手順が確実なら、手順そのものを消す

> これ手順が確実になったら手動ではない形にした方がいいですよね

**ガードは「忘れた」と言うだけで、忘れる余地を残す。**

`package.json` に **`pretest:e2e:gated`** を追加した。npm は `pre<script>` を自動で先に
実行するので、`npm run test:e2e:gated` を打てば**必ず** cargo build + npm build が走る。

```json
"pretest:e2e:gated": "cargo build --release --manifest-path rust/Cargo.toml -p orbit-audio-daemon --features outproc-effect,outproc-instrument && npm run build"
```

**実証**: 同梱バイナリに観測文字列を残した状態から、`cargo` も `npm run build` も打たずに
`npm run test:e2e:gated` だけを実行 → **観測文字列が 1 → 0**（pretest が作り直した）。

#### stale ガードは同梱パスへ修正（保険）

最初に入れたガードは `rust/target/release/` を見ており、**今日の事故を止められなかった**。
実際に spawn される同梱パスへ変更。vitest を直接叩いた場合の保険として残す。

#### #651 は直った

```text
以前:  data=0        estimated duration: 0.000000 sec
いま:  data=2310144  estimated duration: 5.013333 sec
```

**開けて聴けるようになった。** `data` が実データよりわずかに小さいのは設計どおり
（最後の 1 秒ぶんが次の patch を待っている状態で終了する）。

#### 🔴 観測手段そのものを確かめずに結論を出した（4回）

| # | 結論 | 実際 |
|---|---|---|
| 1 | 「`afinfo` が開けるので実害は小さい」 | 尺は **0 秒**だった |
| 2 | 「E2E が stale なバイナリを使っていた」 | 対象を**別のバイナリと取り違えていた** |
| 3 | 「`[capture]` 報告が無い = Drop が走っていない」 | `eprintln!` が `get_log` に**出ないだけ**だった |
| 4 | 「観測が空 = ループに到達していない」 | 同上 / `/tmp` に書けない可能性 |

**共通点: 観測手段が働いているかを確かめずに、その沈黙を事象の不在と読んだ。**
memory `swallowed-errors-are-not-absence` は**エラーの握り潰し**について書いてあるが、
**観測手段そのものには適用していなかった**。

**対処**: 観測を仕込む時は、**まず「必ず出るはずの1回」で経路を確かめる**。
今回は3回目（キャプチャの隣に書く）で初めて経路が保証された。

---

### 6.416 fix(capture): ヘッダを定期 patch + 🔴 stale artifact ガードを機械化 (#651) (Aug 29, 2026)

#### 何を直したか

キャプチャ WAV のヘッダは `finalize()` でしか patch されず、**プロセスが graceful に
落ちなければ size=0 の placeholder のまま**残っていた。実測では RIFF size=36 / data size=0 で
2.29MB のデータを抱えており、**macOS の `afinfo` も `estimated duration: 0.000000 sec`** と読む。
**owner が開いても無音**になる。

writer スレッドの drain ループで **約1秒ごとに header を patch** するようにした
（`sync_header`）。**いつ落ちてもその時点まで有効な WAV** になる。

#### 🔴 未解決: 実機ではまだ効かない

| | |
|---|---|
| `RiffWavWriter::sync_header` 単体 | ✅ 動く |
| `CaptureWriter` 経由のループ（実機と同じ経路） | ✅ **動く** |
| 実機 E2E のキャプチャ | 🔴 **効かない・理由不明** |

**2つの仮説を立てて2つとも外した**（「解析器がヘッダを無視できるから実害は小さい」→ 誤り /
「E2E が stale なバイナリを使っていた」→ 再ビルド後も同じ）。ここで打ち切り、#651 に残す。

#### 🔴 stale artifact ガード — 同じ事故を繰り返しているので機械化した

> これもなんども繰り返してるよ。（owner）

**「ビルドが届いていないバイナリを相手に測る」事故**を、注意ではなく**機械**で止める。

`tests/e2e/orbitstudio-mcp-gated.spec.ts` に、gated 実行の**モジュール読み込み時**に走る
チェックを置いた: `rust/target/release/orbit-audio-daemon` が `rust/**/*.rs` |
`Cargo.toml` より古ければ、**テストを1本も走らせずに落ちる**。原因ファイル名と両者の
タイムスタンプ、再ビルドのコマンドを出す。

**発火することを確認済み**（`touch capture.rs` → `Test Files 1 failed`・テストは0本実行）。

過去の同型:
- 2026-08-29（本件）: mtime 比較で「バイナリの方が新しい」と納得し、**再コンパイルが走るかを
  見なかった**
- 2026-08-01: pre-commit のビルドが **stash 退避中のソースから dist を焼き**、実機を壊した

mtime 比較は「rebuild が no-op か」より弱いが、**実行前に 1ms で終わる**。
弱い分は「疑わしきは落とす」側に倒す。

#### 変異検証について（owner 指摘）

> 変異必要なの？

**不要だった。** `sync_header` を壊して red を見る工程は、実機で「開けるか」を見れば済む話の
上に何も足していない。**ユニットテスト自体は機能テストなので残す**が、
**壊して確かめた工程が余分**だった。この日確定した規律（E2E → ログ → 最後に変異）を、
規律を書いた本人が直後に破った。

---

### 6.415 test(e2e): 実機で機能を確認し、🔴 マスターフェーダーが効いていないことを発見 (#633) (Aug 29, 2026)

#### ✅ #633 の機能は実機で緑

| | |
|---|---|
| **E2E-1** | 同一プラグイン2枚を同時に開き、**片方を閉じても他方が生存** |
| **E2E-2** | **index シフトをまたいで UI が開いたまま**、新 index で閉じられる（owner 原則 C-A） |
| 洪水 | **0 件**（前は 25ms 間隔で連続） |

E2E の初回失敗は**すべて私のテストの作り**だった: エンジン未起動 / `var global = init GLOBAL`
の欠落 / **UI を開く側に VST3 fixture を選んでいた**（ヘッドレスで `createView` が null）。

#### 🔴 発見: `global.gain()` が instrument にまったく効いていない

**キャプチャ WAV を残して自分で RMS を測った**結果（0.25秒窓）:

```text
3.50s rms=0.08660   3.75s rms=0.08860   4.00s rms=0.08864  ← この区間で gain(-6) を評価
4.25s rms=0.08864   4.50s rms=0.08857   5.25s rms=0.08854
```

**完全にフラット。** 効いていれば 0.044 へ落ちる。

##### 原因（両端に観測を仕込んで特定）

```text
[PROBE-TS]     gain() db=-6 amp=0.5011872 hasSetter=function
[PROBE-DAEMON] SetGlobalGain received value=0.5011872 ramp_sec=0
```

**送受信は正常。問題は掛ける順序だった。**

`orbit-audio-native/src/output.rs`:
- `936`: `engine.render_multi_feeds(hw, ...)` ← **ここで master gain を掛ける**
- `959`: post-loop の `BusTarget::Master` が **`hw` に直接加算** ← **gain の後**

**ミキサーの stage から master へ合流する音は master gain を素通りする。**
capture tap は「post 適用後の最終 hw（= device に出る実信号）」なので、**スピーカーも同じ**。

##### これは #643 の設計で「未設計」と記録した箇所そのもの

```text
audio / instrument  →   ミキサー          →   出力
    （source）        bus / AUX / insert       ？
                      ↑ §2-§9 で設計          ↑ 未設計
```

#### 🔴 owner の指摘: シーケンスのゲインも同じ誤り

> master gain を post-loop の後ろへ移すのが素直＜これはその通りだな。
> **シーケンスのゲインだって本来はそのはずですよね。**

| フェーダー | いまの位置 | あるべき位置 |
|---|---|---|
| `seq.gain()` | **イベント生成時**（insert より前） | **そのシーケンスの insert の後** |
| `global.gain()` | **stage 合流より前** | **全部合流した後** |

**両方とも、自分が支配すべきものより手前にある。** 帰結として
**「リバーブを掛けたままフェーダーだけ下げる」ができない**（残響比まで変わる）。
spec はこれを「既知の制約」と記録していたが、**制約ではなく構造の誤りだった**。

#### 🔴 テスト規律の確定（owner・この日の実証つき）

> MCP ツールを用意して**ユーザーと同じ動線で試験できるようにしているのは「確実な動作を確認
> するため」**。そのためにも変異テストより本来は **DSL を網羅した E2E を充実**して、そこで
> **実機の実行に問題がある場合で必要があって初めて**変異テストになる。

| 手段 | master gain の欠陥を捕まえたか |
|---|---|
| 変異検証 **35件**（80分以上） | ❌ **1件も** |
| ユニットテスト **2149件** | ❌ |
| **ユーザーと同じ動線のキャプチャ E2E** | ✅ **これだけ** |

**ログについての但し書き**: この欠陥は**異常系ではない**。各層は成功を返し ERROR は 0 行。
**ログは E2E の代わりではなく補完**として置く。

#### 🔴 DSL 網羅率を測った — seq 32語のうち 19語が実機で未評価

```text
cell comp defaultGain defaultPan density hold length loop midi
mute octave pan quantize root run unmute vel vl voicelead
```

`mute` / `pan` / `octave` / `vel` / `root` / `loop` が実機で一度も通っていない。
**今日 gain で起きたことが、この19語のどれでも起きうる。**

#### `ORBIT_KEEP_CAPTURES` を正式化

キャプチャ WAV を残す env を追加した。**これが無ければ欠陥に辿り着けなかった** —
ハーネスのアサーションは「窓の中の1つの数」しか見せないが、欠陥は窓の外にいることがある。

#### 副産物: キャプチャ WAV のヘッダが patch されない

RIFF size=36 / data size=0 のまま実データ 2.29MB。`CaptureWriter::Drop` で finalize する
設計だが、**daemon が graceful に落ちていない**ため走っていないと見られる。
標準ツール（QuickTime / Audacity / Python `wave`）で開けない。

---

### 6.414 fix(daemon): UI の宛先解決と帰属を配線する + 🔴 変異検証を PR の必須工程から外す (#633) (Aug 29, 2026)

**Issue**: [#633](https://github.com/signalcompose/orbitscore/issues/633)

#### 実装（工程 3-4・設計 §4.5 / §4.7）

`engine_wrap.rs` の route を per-window registry にし、`index_binding`（現 index → token）を
新設。TS 側は session 簿記を token キーへ移し、wire に `window` を足した。
**工程1-2 が置いた `None` が実 token に置き換わった。**

#### 🔴 owner 判断: 変異検証を PR のクリティカルパスから外す

> 変異テストにかけている時間が開発のかなりの時間を占めていて、**開発速度がすごく下がって
> いる**というのがとても問題だと思っています。**変異テストを入れることでの弊害の方が現状
> すごく大きく**なっていると考えています。

**実測**: この1 PR で**変異だけに 80分以上**（実装収束後: ラウンド1が43分・ラウンド2が40分超）。
うち**3分の1は同語反復**だった — 「per-window map を単一 lifecycle に戻す」「generation 照合を
削除」は、**機能そのものを消しているので落ちて当然**であり、何も証明していない。

**判断**: 工程 3-4 の変異検証を**途中で打ち切った**。実装は完了しており、残りは変異の積み増し
だったため。

#### 🔴 なぜ E2E が上位なのか — owner が理由を明文化した

> E2E テストというのは、エンドツーエンドで実行が確約されることで、**中のロジックがどういう
> 実装になっているかに関わらず、正しく振る舞っていることを保証する**テストだからです。

変異検証は「**テストが実装を見ているか**」を問い、E2E は「**振る舞いが正しいか**」を問う。
**出荷するのは振る舞いであって、テストの厳密さではない。**

#### 🔴 投資の順位（owner 確定）

> テストを書きたいというのが開発の趣旨ではなく、**機能開発をしたいのが開発の趣旨**。
> **仕様をきちっと作成し、その通りに作り、正しい振る舞いをまずは保証する**のが大事。

| 順位 | 何に払うか |
|---|---|
| 1 | **仕様を先に固める**（#643 が実測 — 仕様を詰めたから実装が速かった） |
| 2 | **仕様どおりの振る舞いを E2E で保証** |
| 3 | 機能テスト（TDD） |
| 4 | 変異検証（**クリティカルパス外**） |

#### 🔴 なぜ旧方針を2ラウンドも発注したのか — 設計書が規律を上書きしていた

**同日朝**に CLAUDE.md を3層へ書き換え「一律に変異検証としない」を撤回した。
ところが `628-ui-pump-per-index-design.md`（**前日に Fable が起案**）は §5 の表で
**35行すべてに変異を課しており**、main はそれに気づかず**撤回済みの旧方針で発注した**。

**設計書は起案時点の規律を写し取る。規律を改訂すると設計書だけが旧方針のまま残る。**

対処として CLAUDE.md に「**設計書は本規則を上書きできない**」節を新設した。§5 相当の表は
**テスト対象の一覧として読み、検証手段は規律側で決め直す**。

#### 併せて直したもの

Codex が `Global` に足した `pluginUiSessionForInstance` が **DSL 語彙分類テストに引っかかった**
（#528 を捕まえたテスト）。内部 API 側に登録。**private 宣言は実行時のプロトタイプには効かない。**

#### 今後の手段

| 目的 | 手段 |
|---|---|
| 「このテスト、何も見ていないのでは」 | `cargo-mutants --test-tool nextest --in-diff`（無人・差分のみ・**未導入**） |
| 振る舞いの保証 | **キャプチャ E2E** |
| 生成器に作れない変異（棄却案への差し戻し等） | 手書き・**PR あたり数件まで** |

#### 検証

`npm run build` / `lint` / `typecheck:e2e` すべて exit=0 / **2149 passed** /
clippy（両 feature）緑 / rust lib 全 crate 0 failed

---

### 6.413 fix(daemon): UI pump を per-window 化 — 設計の「未実測」仮説が実測で確定した (#633) (Aug 29, 2026)

**Issue**: [#633](https://github.com/signalcompose/orbitscore/issues/633)（#638 と1本の PR）
**設計正本**: `docs/design/628-ui-pump-per-index-design.md`（711行・起案 Fable / owner 決定）
**実装**: Codex（`gpt-5.6-sol` / effort xhigh）・**検証は main が sandbox 外で**

#### 何が壊れていたか

`UiEventPump` は **child 単位の単一 `UiPumpState`** を持ち、1 child に UI 1枚しか開けなかった。
child 側は #628 で index → window の多重レジストリへ一般化済みで、**非対称が残っていた**。

さらに実バグがあった: child は `{"index":0,"completion":"safepoint-completed"}` を送るが、
daemon の DONE 腕は `Some("safepoint-completed")` の**完全一致でしか受けない**。
**1枚目の close ですら Protocol error になり event ring の先頭が永久に詰まる。**
実機ではこのエラーが **25ms 間隔で洪水**を起こし daemon を飽和させていた。

#### 🔴 設計が「実測していない」と明記した仮説が、実測で再現した

設計 §7 の表 1 行目は ring デッドロックを **「確信度 中〜高・机上組み立て・実測していない」**
としていた。そこでブリーフで **「実装の前に H2 の再現 fixture を書き、再現するかを確認せよ。
再現しなければゲートは防御実装に格下げし設計書に追記せよ」** と条件を分けて発注した。

**結果: 再現した。**

| 観測 | 値 |
|---|---|
| w1 `UI_CLOSED` | seq 1（daemon ack 停止） |
| w2 `UI_CLOSED` | seq 2 |
| w1 timeout 後の DONE | **publish 不能**（seq 3 には `evt_ack >= 1` が要る） |
| ring 状態 | **`evt_seq=2 / evt_ack_seq=0`** |
| daemon | **`Blocked { seq: 1 }` を繰り返す** |

したがって **close-cycle 順序ゲートは防御実装ではなく必須**と確定した。

**教訓**: 設計に「確信度」と「反証方法」の欄があると、**発注を条件分岐にできる**。
「実装せよ」ではなく「確かめてから、結果に応じてこう実装せよ」と書けるので、
**推論に基づく設計判断が実装フェーズで検証される。**

#### 採った機構: 帰属と宛先の2レイヤ分離

> 「開いているウィンドウ」は位置の性質ではなく **open という行為の産物**である。

| 何を | どのキーで |
|---|---|
| **帰属**（イベント → session → 保存 identity） | **window token**。open から close まで不変 |
| **宛先**（コマンド → stage） | **chain_path**。発行時点の登記チェーンから引く |

位置（index）は APPLY で動く。**動く値を照合キーにすると「発行時点の index」と「ack 到着時点の
index」の一致を別途保証する仕組みが要る**。token は不変なので、その仕組みごと不要になる。

#### 変異検証 20件（P1-P14 / H1-H6）— すべて実 red 出力つき

P6 が象徴的: 変異を戻すと**実機で洪水を起こしていたのと同じメッセージ**が出る。

```text
indexed DONE が invalid completion Some("{\"window\":1,...}")
```

各件 `$TMPDIR` baseline へ restore し `cmp OK` を確認。

#### 🔴 main の検証が埋めた穴 — Codex が構造的に走らせられない28件

Codex は sandbox で **localhost bind ができない**ため、`orbit-audio-daemon/tests/protocol.rs`
の **28件が丸ごと実行不能**だった（迂回せず報告した — ブリーフの指示どおり）。

**main が sandbox 外で実行し 28 passed / 0 failed。** ここが委譲では埋まらない。

#### 本 PR に含まれない残り（工程 3-4）

`engine_wrap.rs` / `outproc_respawn_guard.rs` は **`None` を渡すだけの追随変更**に留めた
（19行）。route registry・`index_binding` の remap（§4.5）と TS の token 採番・帰属（§4.7）は
**次の発注**。いま入っている `None` はそこで実 token に置き換わる。

#### gated E2E 2本（main 担当・TDD で先に追加）

🔴 **オラクルは `open_plugin_ui` の戻り値ではなく `close_plugin_ui`**。close はセッションが
無いと失敗するので、**閉じられた = 開いていた**の証明になる。open の `ok` に assert しても
「受理した」しか言えない。

- **E2E-1**: 同一プラグインを2つ挿し `ui("名前")` → **2枚目を先に閉じ**、その後1枚目も閉じる
  （= 片方の close が他方を壊さない・完了条件1）
- **E2E-2**: `[A, B]` で B の UI を開き **A を落として B を index 2→1 にシフト** →
  **新しい index で閉じられる**（= owner 原則 C-A の生存と、帰属が位置でなくインスタンスに
  付いていること）

#### 検証

`cargo clippy --all-targets --features outproc-effect,outproc-instrument -- -D warnings` 緑 /
cfg 4象限すべて緑 / `cargo fmt --all --check` 緑（main が独立に再実行）/
daemon protocol **28 passed**（main が sandbox 外で）/ library unit: sandbox 101・
child-runtime 35・rack-child 15

---

### 6.412 feat(editor): 274個から探す入口と、名前の誤りを評価前に知る診断 (#638) (Aug 29, 2026)

**Issue**: [#638](https://github.com/signalcompose/orbitscore/issues/638)（#633 と1本の PR・owner 決定）

#### なぜ

実カタログは **342件**（effect **274** / instrument **74**・IK Multimedia だけで 130）。
**名前を覚えている前提の補完だけでは、この規模は扱えない。**

| 足りなかったもの | 入れたもの |
|---|---|
| 「何を挿すか**探している**」時の入口が無い | **Quick Pick**（`OrbitScore: Browse Plugins`） |
| `effect(["存在しない名前"])` が**評価するまで分からない** | **カタログ照合の診断** |

#### 1. Quick Pick

カーソルが `effect(` / `instrument(` の文字列の中にあれば**そこから role を取り**、打ちかけの
断片を置換する（**補完と同じ編集結果になる**）。文脈の外なら種別を訊いて `"名前"` を挿入する。

行は `filterCatalogEntries` を再利用して作る。**補完が挿入する文字列と1文字も違わないため**、
`format/name` / `vendor/name` の曖昧性解消がリストからの選択でも保たれる。

#### 2. カタログ照合の診断

エンジンの `resolveCatalogSpec` と同じ順で 4 種を分類する: **未検出 / vendor 曖昧 /
role 不一致 / v1 でホストできない format**。

🔴 **重大度は Error でなく Warning**。エンジンは実際に throw するが、**拡張の持つカタログは
キャッシュされたスナップショット**なので、名前が**正しくてまだスキャンされていない**ことがある。
Warning は「怪しい」と言うが、スナップショットに支えられない確信までは主張しない。

#### 🔴 拡張はエンジンを import できない — 重複を「検出可能」にする

拡張は **`.vsix` として単独出荷**するのでエンジンパッケージに依存できない。そこで解決規則を
**ミラーし、合意テストで固定した**: 1つのコーパス（18ケース）を**両実装に流し、受理・拒否が
一致することを assert** する。片方だけが変わればテストが赤くなる。
前例は `tests/vscode-extension/dsl-method-catalog.spec.ts`。

#610 が診断をエンジンパーサへ一本化したら、このミラーは**消える側**である。

#### 🔴 変異検証で、自分のテストが「間違った理由で通っていた」ことが判明

6変異のうち **2つが最初は生き残った**:

| 変異 | なぜ生き残ったか |
|---|---|
| path 接頭辞の判定を殺す | テストの `./local.clap` が**パス接頭辞と拡張子の両方**に該当し、片方が死んでも他方が拾う |
| state file 判定を殺す | `./tones/bass.vstpreset` も `./` で拾われる |

**3つの除外規則を、それぞれ単独でしか救えないケースで突き直した**
（`./racks/my-chain` / `MyPlugin.clap` / `bass.vstpreset`）。再実行で 3 件とも red。

**教訓**: 除外規則が複数あるとき、**すべてに該当する例で書いたテストは規則を区別できない。**
1規則につき1つ、その規則だけが救うケースを置く。

#### 変異検証（全10件・すべて red → restore で green）

診断側6件（標準プラグイン除外 / path 接頭辞 / 拡張子 / state file / vendor 曖昧 / role フィルタ）
+ Quick Pick 側4件（role フィルタ / ソート / insertText の曖昧性解消 / description の format）。

#### 設計チェックで見つけた設計正本の陳腐化（#633 側）

`docs/design/628-ui-pump-per-index-design.md` §4.7-(1) が「TS は `chain_path` を送っていない
（`packages/` の grep 0件）」としていたが、**設計執筆後に #628 の `3b634850` で解消済み**
だった（`daemon-client.ts` が `pluginChainPath()` で4経路すべてに送出）。設計書に訂正を追記。

---

### 6.411 fix: fixer 差分の再点検で3件 — うち2件は「訂正が不完全だった」 (#643) (Aug 29, 2026)

**Issue**: [#643](https://github.com/signalcompose/orbitscore/issues/643) / PR [#648](https://github.com/signalcompose/orbitscore/pull/648)

#### 見つかった3件（すべてコメント・実行時の影響なし）

| # | 内容 | 発見 |
|---|---|---|
| 1 | **コメントが文の途中で連結**（挿入文の末尾に元の文の続きがくっついた） | **main が自分で差分を読んで** |
| 2 | **「合流後」という不正確な表現が8箇所** + **WORK_LOG に誤主張が残存** | 同上 |
| 3 | **`reapplySourceRoutingAfterRespawn` の doc が私の新関数に付いた** | 再点検レビュアー |

#### 🔴 2 が示したこと: 訂正が不完全だった

6.410 で「誤記6箇所を訂正した」と報告したが、**同じ主張が別の言い回しで残っていた**:

- 「バスに入る前」→ 消した
- **「合流後に1回だけ」→ 残っていた**（gain は insert の前なので不正確）
- **「マスターを絞るとリバーブの掛かり方まで変わっていた…合流後に移したことで解消」→ WORK_LOG に残っていた**

**消すべきは表現ではなく主張。** 表現で検索すると取りこぼす。**主張を検索語にして残存を数える**
（`grep -c` で 0 を確認する）のが確実だった。

#### 🔴 doc の誤付着が今日5回目

| # | 内容 |
|---|---|
| 1-3 | 6.406 / 6.407 に記録（`peak_bits` 削除の取り残し等） |
| 4 | コメントの文中連結（本エントリ 1） |
| 5 | `reapplySourceRoutingAfterRespawn` の doc が新関数に付いた（本エントリ 3） |

**共通原因**: 挿入位置を「次の関数の直前」と考えると、**その関数が既に doc を持っている場合に
doc と関数の間へ入る**。関数定義行そのものをアンカーにしても同じ（doc は定義行の上にある）。

**対策として入れた検出**: 連続する doc ブロック（単行 doc の直後に別の doc が始まる）を
機械的に探すスクリプトを回し、**0 件**を確認した。今後の挿入後は同じ確認をする。

#### 再点検の結論

**Critical 0**。respawn の鏡像性・intent 先行記録の副作用・choke point の追加位置・
新しい throw が宣言時のみであること・テスト10本の強度は、いずれも問題なしと確認された。

#### 検証

`npm run build` **exit=0（型エラー 0）** / `npm run lint` **exit=0** / **2103 passed**

---

### 6.410 fix: レビュー5体の指摘を適用 — Critical 2件はいずれも main の書いた部分 (#643) (Aug 29, 2026)

**Issue**: [#643](https://github.com/signalcompose/orbitscore/issues/643) / PR [#648](https://github.com/signalcompose/orbitscore/pull/648)
**レビュー**: `/code:pr-review-team` 3体 + **Fable 並行**（`/simplify` は E2E が過半のためスキップ）

#### 🔴 Critical 2件 — 両方とも main が書いた部分

**1. daemon respawn 後にマスターゲインが unity へ戻る（退行）**

respawn の再適用リストは plugins / racks / busRoutings / sourceRoutings のみで、
**global gain が無かった**。daemon は新プロセスで `global_gain: 1.0` から始まる。

**この PR で畳み込みを外したので、これは本 PR が新設した退行**（旧実装はイベント側で
効いていたので respawn の影響を受けなかった）。しかも `Global.gain()` のゲッターは
**古い値を返し続ける**ので、「DSL 上は -6dB なのに実際は unity」が**エラーもログも無く**発生する。

さらに **main が書いたコメント「次の起動時に `global.gain()` が再評価されて設定される」は
存在しない経路の主張**だった。

→ `globalGainIntent` + `reapplyGlobalGainAfterRespawn()`（既存2つの**鏡像**）+ **テスト4本**。
変異2種（reapply 削除 / intent 記録の削除）で殺せることを確認済み。

**2. Signal Chain sugar が instrument を拒否したまま**

`routeOutputFromDsl` / `routeSendFromDsl`（`process-statement.ts` から呼ばれる **`output()` /
`send()` と同じ意味の別入口**）が `isNoteSequence()` のまま残っていた。
**「メソッドでは書けるが Signal Chain 構文では弾かれる」**状態。

→ 同じガード分割 + choke point 呼び出し + **テスト3本**。

#### 🔴 Fable が見つけた「差分に無いもの」3件

**A. 「insert の前に掛かる問題が解消」は誤り — spec に既知制約として書いてあった**

`INSTRUCTION_ORBITSCORE_DSL.md`:

> master gain ramp は per-sequence insert の**前**に適用される（DAW の「fader は insert 後」と逆）

実コードも `render_multi_feeds`（gain・`output.rs:936`）→ post-loop の `processor.process`
（insert・`:949`）の順で、**本 PR は変えていない**。にもかかわらず「解消した」と
**6箇所に複製**していた。**spec を読まずに書いた。**

→ 誤記を全て訂正し、正しい説明（変えていないこと・spec の既知制約であること）を追記。

**B. ガード3分岐のうち sum しか実装されていない**

設計 §12 は3分岐の扱いを定めているが、**数値 render bus と LinkAudio 分岐は byte-identical で
未変更**。`inst.output(2)` / `inst.output("LinkCh")` が**黙って記録される**（#644 の症状が
instrument にも開いた）。

→ **instrument 側の拒否を2分岐に追加**（設計で確定済み・owner 確認不要）+ テスト3本。
**midi 側は据え置き**（受理していた入力を弾く破壊的変更なので owner 確認事項・#644）。

**C. core spec が stale（規則6違反）**

spec は今も「note シーケンスへの `send()` と `output()` を依然拒否する」と書いていた。
→ **実装に合わせて更新**（3分岐の表・アドレスモデル `(instance, unit)`・#647/#611 への参照）。

#### 🔴 記録: 文字列置換で3回壊した（今日通算）

| # | 内容 |
|---|---|
| 1 | doc コメントの途中にヘルパを挿入（モジュール doc が関数に化けた） |
| 2 | 複数行 import の途中に import を挿入（構文エラー） |
| 3 | **変異の復元で `if (!this.daemon.isRunning()) {` が複数一致**し、別の場所（respawn ループ内）を書き換え → **型エラー507件** |

**共通原因**: `replace(old, new, 1)` は「最初の1つ」を置換するので、**一意でないアンカーは
静かに間違った場所を書き換える**。

**対策**: 置換の前に **`assert s.count(anchor) == 1`** を置く。3件目の復旧後はこれを徹底し、
以降の置換は全て一意性を確認してから実行した。

#### 検証（main が sandbox 外で実行）

`npm run build` **exit=0（型エラー 0）** / `npm run lint` **exit=0** /
`npm run typecheck:e2e` **exit=0** / **2103 passed**（ラウンド1前 2093 → **+10**）

---

### 6.409 test(e2e): #643 の実機検証が #633 のログ洪水に阻まれることを実測した (Aug 29, 2026)

**Issue**: [#643](https://github.com/signalcompose/orbitscore/issues/643) PR-2 / [#633](https://github.com/signalcompose/orbitscore/issues/633)

#### 実機 gated の #643 E2E 7本が緑にならない — 原因は #633

診断を仕込んで実機ログを取ったところ、**25ms 間隔で同一エラーが埋め尽くしていた**:

```text
UI_CLOSED_DONE seq 2 has invalid completion
  Some("{\"index\":0,\"completion\":\"safepoint-completed\"}")   role="effect"
```

**#633 の欠陥1番そのもの** — daemon の DONE 腕が完全一致でしか受けず、event ring の先頭が
永久に詰まる。**ログ洪水が daemon を飽和させ、effect の適用が届かない。**

WORK_LOG 6.399 が別テスト（`reports an ambiguous bare mixer name`）で
**「同欠陥のログ洪水による巻き添え」**として既に記録していた症状と同型。

#### 実装側の問題ではない根拠

**同じ実行で audio シーケンスの effect は効いている**（#625 R-E1-R-E7 が緑・`a/dry = 0.323`）。
instrument は**同じラック機構**（`sequenceEffect()`）を通るので、機構は動いている。

#### 処置

E2E 7本は**削除せず残す**（#633 が直れば自動的に検証になる）。ファイル冒頭に理由を記録した。
**E2E-1 は単位の誤りを修正** — `global.gain()` は **dB API**（`gain(valueDb?)`・-60..+12 にクランプ）
なのに、ブリーフに「`global.gain(0.5)` で RMS 半分」と書いていた。`1.0dB → 0.5dB` は RMS 比 0.944。
`0 dB → -6 dB` に修正（10^(-6/20) ≈ 0.501）。

#### 🔴 記録: 手動での実機起動に5回失敗して時間を使った

`orbs` CLI に `--extensionDevelopmentPath` と `ORBITSCORE_MCP_PORT` を渡しても MCP が立たず、
最後はアプリ自体が起動しなかった。**MCP は壊れていない** — 同じ実行で **9本が MCP 経由で成功**
している（プラグイン状態の復元・カタログ再スキャン・エフェクト差し替え）。

**教訓**: 「実機で確かめる」を**アプリを自分で起動すること**と考えたのが遠回りだった。
**すでに正しく起動できている仕組み（E2E）に観測点を足す**方が速い。
昨日の教訓（沈黙には観測を足す）は正しかったが、**観測を足す場所**の選び方を誤った。

#### 副次的に判明: gated E2E は単独実行できない

`-t "E2E-2"` で絞ると `beforeAll` のカタログ初期化が走らず、`catalogClapEffectPath` 未初期化で
落ちる。**1本を試すのに毎回全17本（3〜5分）**回す必要があり、切り分けのサイクルが遅い。
テスト基盤側の課題として記録（#630 と同種）。

---

### 6.408 feat(dsl): instrument に effect / output / send を解禁し、マスターフェーダーを直した (#643) (Aug 29, 2026)

**Issue**: [#643](https://github.com/signalcompose/orbitscore/issues/643) PR-2
**実装**: Codex（DSL 表面 + E2E）/ **main**（分類修正 + マスターフェーダー）
**差分**: 742 insertions / 28 deletions・**テスト 2080 → 2093**

#### 1. instrument の DSL 表面（Codex）

`effect()` / `output(sum)` / `send()` のガードを **midi / instrument で分割**し、instrument 側だけ解禁。
`SetSourceRouting { source, unit: 0, target }` を冪等に発行する choke point を、宣言順の両方向
（`instrument()` → `effect()` と逆）に置いた。respawn replay も既存 `busRoutings` の鏡像で実装。

**実機 E2E 7本**を `orbitstudio-mcp-gated.spec.ts` に追加（+398行）。

#### 2. 🔴 マスターフェーダーが誰にも効いていなかった（main）

owner 指摘:

> global.gain って各オーディオバス、インストバスに届く必要があるの？
> **だってミキサーの機能考えてみてくださいよ。**

**マスターフェーダーは**event 混合後に1回だけ**掛かるもので、各ソースへ配るものではない。**

調査の結果、実装は二重に誤っていた:

| | 旧実装 |
|---|---|
| audio シーケンス | `masterGainDb` を **イベントごとの gain に畳み込む**（`sequenceGainDb + masterGainDb`） |
| instrument | note 経路に畳み込みが**無い** → **マスターが一切効かない** |
| Rust の `set_global_gain` | **存在するが TS が一度も呼ばない**（定義のみ・呼び出し0件） |

**Rust 側には最初から正しい実装があった**（`render_multi` の gain ramp・`next_gain_frame` の
単一前進契約つき）。TS がそれを使わず、イベントへの畳み込みで辻褄を合わせていた。

**修正**: 4層に配線（`types.ts` / `engine-backend.ts` / `rust-engine-player.ts` / `global.ts`）し、
**畳み込みを除去**。`gainDbToAmplitude` で線形化して daemon へ送る。

**副次的に直ったもの**: 旧実装は **バスに入る前**に master を掛けていたため、
daemon の gain ramp（線形補間）が**一度も使われていなかった**のが使われるようになった。

🔴 **訂正（6.410）**: 当初ここに「バスに入る前に掛かる問題も解消」と書いたが**誤り**。
gain は今も insert の前に掛かる（spec の既知制約）。

`-Infinity`（完全無音）だけは畳み込みを残す — daemon の gain が 0.0 になるまでの ramp 中に
音が漏れるのを避けるため。

#### 3. 分類テストが正しく発火した（main）

Codex が追加した private メソッド2つ（`ensureInstrumentSourceRouting` /
`syncInstrumentSourceRouting`）が **DSL 語彙にも内部 API 除外リストにも無い**と検出された。

これは **#528 の再来を防ぐテスト**（`setDocumentDirectory` の誤分類でエディタ評価が全滅した事故の
再発防止）。**内部 API に分類**して解決。1つ目で止めず `InstrumentSourceRouting` を含む定義を
全 grep して2つであることを確認した。

#### 🔴 変異検証: マスターゲインは守るテストが1本も無かった

修正前、**配線を無効化する変異（常に 0dB を送る）が 2088件すべてを生き残った**。
テスト5本を追加し、実出力で確認:

```text
変異1（配線を無効化）              -> 2 failed / 3 passed
変異2（畳み込みを戻す）            -> 3 failed / 2 passed
復元後                              -> 5 passed
```

#### 🔴 変異検証の後始末で本体を2回失いかけた（記録）

| # | 誤り | 結果 |
|---|---|---|
| 1 | バックアップを `$TMPDIR` へ | **sandbox の内外でパスが違い、バックアップが存在しなかった**（memory 記録済みの罠を踏み直し） |
| 2 | `git checkout <file>` で変異を復元 | **未コミットの本体変更ごと巻き戻り**、マスターゲイン修正が2ファイルとも消えた。`git status` で気づいて再投入 |

**根本的な解**: 変異検証は**本体をコミットしてから**行う。ファイル単位の復元は、未コミットの
変更がある時に使えない。文字列単位で戻すか、コミット済みの状態を前提にすること。

#### 検証（main が sandbox 外で実行）

`npm run build` **exit=0（型エラー 0）** / `npm run lint` **exit=0** /
**2093 passed / 62 skipped**（PR 前 2080 → **+13**）

---

### 6.407 fix: レビュー5体の指摘を適用し、自分が作った Critical を1件直した (#643) (Aug 29, 2026)

**Issue**: [#643](https://github.com/signalcompose/orbitscore/issues/643) / PR [#646](https://github.com/signalcompose/orbitscore/pull/646)
**レビュー**: `/code:pr-review-team` 4体 + **Fable 並行投入**（最後に回さない・発見クラスが直交）

#### 結果

| レビュアー | Critical | Important |
|---|---|---|
| code-reviewer | 0 | 0 |
| silent-failure-hunter | 0 | 3（同一の横断的関心事） |
| pr-test-analyzer | 0 | 1（テスト20本追加・**「通るだけ」0本**） |
| comment-analyzer | **1** | 2 |
| **Fable** | 0 | **2**（テストの穴） |

#### 🔴 Critical は自分が作ったもの（doc 誤付着の3回目）

`peak_bits` を削除した際に doc の1行が残り、**次の関数 `spawn_effect_child` の説明の1行目**に
化けていた（「abs ピークを返す」）。

**同じ PR で doc 誤付着は3回目**で、しかも **WORK_LOG 6.406 に「1件あった」と自己申告した
その自己監査が、この3件目を見落としていた**。

#### 制御スレッドの silent detach（silent-failure-hunter Important）

replace の宛先移行で長さ一致を `debug_assert_eq!` が守っていたが、**release では `zip` が
黙って切り詰め**、移行漏れの unit が**リバーブごと外れる**（設計 §7 が名指しした故障そのもの）。

**推奨は `assert_eq!` だったが採らなかった** — 「効くようにする」は正しいが、**演奏中に daemon が
落ちる**のは owner 原則（エラーで止めない）に反する。**`tracing::error!` + 共通部分は移行**に変更。

**指摘は正しく、処方は違う**という判断が要る場面だった（#645 の「気づかせる」と「止める」の混同と同型）。

#### Fable が見つけたテストの穴2件 — どちらも「この PR 自身が変えたもの」

| | 生き残っていた変異 |
|---|---|
| **A-1** | `transport.cursor_frames = ...saturating_add(frames)` を**削除しても全 suite が通る** |
| **A-2** | `for unit in 0..unit_count` を `0..1` に**縮めても通る** |

`STUB_TRANSPORT` を実 transport に置き換えたのがこの PR の意味的変更点なのに、**前進を assert する
テストが1本も無かった**。**変更点と検証点がずれる**のは、テストを「機能」ではなく「触ったファイル」で
考えると起きる。

**変異検証の実出力**:

```text
変異1（transport 前進を削除）  -> source_transport_cursor_advances... FAILED
変異2（0..unit_count -> 0..1） -> every_reported_unit_contributes_a_feed FAILED
復元後                          -> 52 passed（cmp で復元一致を確認）
```

#### 適用しなかったもの（判断の記録）

| | 理由 |
|---|---|
| RT フォールバックの観測カウンタ（4箇所） | **ユーザーは音で気づく**（無音・途切れ）ので埋まるのは「理由」だけ。RT パスの3〜5関数にシグネチャ変更が要り、**「atomic 1本」と見積もった私が過小評価だった** |
| RT スタックの `ArrayVec<_, 512>` | **実測 16,384 バイト**。`MaybeUninit::uninit()` なので**初期化コストは無く**スタック消費のみ（512KB 級の約3%）。「放置したら誰が困るか」が書けない |
| Link 収集の二重実装（57行） | bit 一致の主張に関わる経路 |

#### 🔴 レビューの過程で、この PR の範囲外の欠陥が2件見つかった

| 内容 | issue |
|---|---|
| **ミキサーの出口が未設計** — `frames × output_channels > 8192`（**8ch @ 2048 など普通の構成**）で instrument が無音。バスは既にデバイス幅なので**配置だけで直る**（合流は `output.rs:957-960` の3行） | **#611**（改題: the mixer's output side） |
| **マルチティンバー未対応** — 受け皿は本 PR で完成したが**子プロセスが常に 1 出力**。`SetSourceRouting` で unit 1〜15 は**成功応答を返すが音は出ない** | **#647**（新規） |

owner 指摘で設計の欠落が判明した:

> オーディオやインスト → ミキサー（バス、AUX など様々なルーティング、**柔軟なアウトプット指定**）

**ミキサーは入口・内部・出口の3つを持つ。本設計が一般化したのは内部だけだった。**
入口は `(instance, unit)` で一般化したのに、**出口を固定のまま残していた**（対称性の欠落）。
設計文書に **§1.5** として記録。`Link` が唯一の出口として特別扱いされているのが未一般化の証拠。

#### コミット前に差分を読んで、自分の取りこぼしを2件見つけた

1. **やめたはずの RT カウンタが `post_processor.rs` に残っていた**（方針変更後に戻し忘れ）
2. **ログ文言が不正確** — 「keep their old routing」と書いたが、実際は**新 slot が Master のまま**

#### 検証（main が sandbox 外で実行）

clippy 4象限 **4/4 exit=0** / native **52 passed** / core **51** / daemon **239・39**

---

### 6.406 refactor: /simplify の指摘を適用し、その過程で cfg 象限の欠陥を1件作って直した (#643) (Aug 29, 2026)

**Issue**: [#643](https://github.com/signalcompose/orbitscore/issues/643) / PR [#646](https://github.com/signalcompose/orbitscore/pull/646)
**差分**: 20 insertions / 87 deletions（**純減**）

#### `/simplify` 4体の指摘を集約し、4件を適用

| 適用 | 内容 |
|---|---|
| **A** | **借用スパイクの残骸を削除**（67行）— 本番の `SourceDestCell::decode` を影で再実装しており、片方だけ直しても検出できない構造だった。**reuse と simplification の2体が独立に指摘** |
| **C** | `peak_bits` を共通化 — 一字一句同じ式が2箇所にあった |
| **D** | `sources.is_empty()` の分岐を削除 — core が等価を保証し bit 一致テストもあるのに、呼び出し側で場合分けし直していた |
| — | replace の宛先移行を2ループ→1ループ |

**保留**（理由つき）: RT スタックの `ArrayVec<_, 512>`（**実測 16,384 バイト**）/ Link 収集の
二重実装（57行）/ ヘルパ抽出・命名の統一（既存コードに波及）。前2件は RT パスの構造変更のため
owner 判断を待つ。

#### 🔴 C の共通化で cfg 象限を壊した（自己申告）

`peak_bits` を `outproc_effect` に置いたまま instrument 側から呼んだが、同モジュールは
**`#[cfg(feature = "outproc-effect")]` でゲート**されており、**instrument 単独ビルドが壊れた**:

```text
error[E0433]: cannot find `outproc_effect` in `crate`
note: the item is gated behind the `outproc-effect` feature
```

**ブリーフで「落としやすい」と名指しした罠に、自分で落ちた。しかも直し方を間違えて2回落ちた**:

| # | 症状 | 原因 |
|---|---|---|
| 1 | instrument 単独ビルドが壊れた | ヘルパを **effect ゲートの中**に置いた |
| 2 | **default（両方 off）で dead_code** | 1 を直す時に **cfg を外しすぎた** |

正解は `#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]` —
**呼び出し元と同じ条件**でゲートする。関数の doc に両方の罠を記録した。

#### 🔴 「4象限」と書きながら3つしか回していなかった

2 を見逃したのは、clippy を「両 feature / instrument 単独 / effect 単独」の3通りで回して
満足していたため。**default（feature を付けない）が列挙から落ちていた** — 組み合わせを
数える意識が「何を足すか」に向くと、「**何も足さない**」が候補から抜ける。
捕まえたのは pre-push フックだった。

**共通化は「どの軸で共通か」を確認してから行う** — この2つは「計算式が同じ」だけで、
「同じ条件でコンパイルされる」わけではなかった。重複を減らす変更が、より質の悪い結合
（cfg 象限をまたぐ依存）を作った。

#### 🔴 測定器が3回壊れていた

この作業中、**検証コマンド自体の誤りで3回誤報告**した:

| # | 誤り | 症状 |
|---|---|---|
| 1 | `cmd \| tail` の後で `$?` を読んだ | clippy が exit=101 なのに「exit=0」と表示 |
| 2 | `cargo build $F`（zsh） | **zsh は bash と違い、クォートなしの変数展開で単語分割しない**。`"--features outproc-effect"` が1引数として渡り `unexpected argument` で失敗 → 「4象限のうち3つが落ちる」と誤報告 |
| 3 | 出力を `/dev/null` へ捨てた | 失敗の原因が読めず、原因究明に往復した |

**#2 が本物の欠陥（cfg 象限）を2回隠した。** 個別実行と結果が食い違ったら、**まず自分の書き方を疑う**。
実装のバグより測定器のバグの方が発見が遅いのは、測定器を検証する仕組みが無いため。

#### 検証（修正後・すべて main が sandbox 外で実行）

| 項目 | 結果 |
|---|---|
| cfg 4象限ビルド | **4/4**（引数を明示・ループを使わない） |
| **clippy 4象限**（default / effect / instrument / 両方） | **4/4 exit=0** |
| daemon（両 feature） | **239 passed / 1 ignored** |
| native | **50 passed / 2 ignored**（スパイク削除で 51→50・意図どおり） |

**clippy は4象限すべてで回す** — CI（`rust-ci.yml`）は ubuntu で、単独 feature ビルドの
欠陥を捕まえないため。**default を含めて4つ**であることに注意（3つで止まって踏んだ）。

#### コミット前に差分を読んで、自分の修正の欠陥を2件見つけた

1. **`outproc_effect` モジュールの doc の途中にヘルパを挿入**していた — モジュールの説明が
   関数の doc に化けていた
2. `outproc_effect::peak_bits` が `crate::peak_bits` を呼ぶだけの**無意味な委譲**になっていた

どちらもテストでは検出できない（コンパイルも通る）。**差分を読む以外に発見手段が無い類**。

---

### 6.405 feat(audio): instrument をミキサーの source にした — PR-1 (#643) (Aug 29, 2026)

**Issue**: [#643](https://github.com/signalcompose/orbitscore/issues/643)
**設計正本**: `docs/design/643-mixer-foundation-design.md`
**実装**: Codex（gpt-5.6-sol / effort xhigh）/ **検証: main（sandbox 外）**
**差分**: 1502 insertions / 158 deletions（core 163 / native 728 / daemon 595 / protocol 128）

#### instrument が master への後付けから、バスの source になった

これまで instrument の音は `CompositePostProcessor` で **master バッファへ直接加算**されており、
バスグラフの外にいた。本 PR で **`render_multi` の内側・event 混合後・gain ramp の前**へ移し、
audio シーケンスと同じ場所で合流するようにした。

**帰結: `global.gain` が instrument に効くようになった**（従来は効いていなかった＝欠陥）。
位置の修正だけで消えるので、gain の手当ては入れていない。

#### 層ごとの変更

| 層 | 内容 |
|---|---|
| core | `render_multi_feeds` + `FeedDest`。既存 `render_multi` は `feeds=&[]` で委譲（bit 一致を固定） |
| native | `BlockSource`（二段式 render → output）/ `BlockTransport` / `SourceSlot` / `SourceDestCell` / 二パス feed 収集 |
| daemon 配線 | `OutProcInstrumentPostProcessor` を `BlockSource` へ改組・`CompositePostProcessor` 解体 |
| daemon 制御 | `SetSourceRouting { source, unit, target }`・replace / teardown の**全 unit** 宛先処理 |
| protocol | `session.rs` に parse + dispatch + 非対応 build の `UNSUPPORTED` |

宛先は `SourceDest { Master, Bus(usize), Link(usize) }` + `SourceDestCell` newtype で、
**エンコードを1箇所に閉じた**（帯域分割の生整数がコードから消えた）。

#### 借用の二段式（設計最大の不確実性を最初に潰した）

実装の冒頭にコンパイルスパイクを置いた。パス1で `iter_mut()` して全 source を render し、
パス2で `iter()` から `ArrayVec<(&[f32], FeedDest)>` を収集する形が**成立することを確認**してから
本実装に入った。`&mut` からの借用返しが不要になるため、単一 `render() -> Option<&[f32]>` より簡単。

#### 🔴 main の独立検証（sandbox 外・委譲先の報告は根拠にしない）

| 項目 | 結果 |
|---|---|
| `clippy --all-targets --features outproc-effect,outproc-instrument -- -D warnings` | exit=0 |
| cfg 4象限ビルド（none / effect / instrument / 両方） | **4/4** |
| `cargo test -p orbit-audio-daemon --lib` | **39 passed** |
| `cargo test -p orbit-audio-daemon --features outproc-effect,outproc-instrument --lib` | **239 passed / 1 ignored** |
| `cargo test --workspace` | exit=0・91 スイート ok・FAILED 0 |

daemon は **features 有無の両方**を回した（以前 `--lib` だけの件数を報告して実際と食い違った経緯があるため）。

#### 落としやすい2項目を main が差分で確認した

発注時に「配線で落ちやすい」と名指しした2件。**両方とも入っていた**:

- **replace の宛先移行**（`engine_wrap.rs:5706-5715`）— 全 unit を `zip` でコピーし旧 slot を
  Master へ戻す。長さの一致を `debug_assert_eq!` で固定
- **teardown のリセット**（`:5894-5896`）— 全 unit を Master へ。さらに **`if teardown.is_ok()` の時だけ
  `free_slot`** するので、**失敗した slot は隔離され free list に戻らない**（ログも
  "quarantined from free-list"）。「リセット漏れの slot を次のテナントが取る」経路は存在しない

#### gain 欠陥の実行証明（red → green）

```text
left:  [1065353216, 1065353216, 1065353216, 1065353216]   ← 1.0（gain が効いていない）
right: [1056964608, 1056964608, 1056964608, 1056964608]   ← 0.5（期待）
test result: FAILED. 0 passed; 1 failed

（修正後）
test output::tests::global_gain_scales_instrument_contribution ... ok
```

#### 途中で起きたこと（記録）

1. **Codex が2回停止して質問した** — いずれもブリーフの「sandbox で失敗したら迂回せず報告」に
   従った正しい挙動（リポジトリ外への spike 書き込み / `.git` ロック）。迂回させていたら、
   別の場所で通したものを「通った」と報告されていた可能性がある
2. **32時間前の #628 ジョブが `running` のまま残ってキューを塞いでいた** — 実プロセスは不在。
   status は自己申告なので stale になる。**ログの mtime を生存 signal にした監視**が45秒で検出
3. **README への追記を差し戻した** — ユーザー向け機能一覧に進行中の内部リファクタを
   「in progress」として載せていた（スコープ外）
4. **main の検証コマンド自体が壊れていた** — `cargo build ... | tail` の後で `$?` を読み、
   `tail` の exit を clippy の結果として表示していた。取り直して exit=101 が判明

#### スコープ外（設計文書にメモとして記録・issue 化しない）

子プロセスの N 出力 / 容量の撤廃 / 配線の表現力（Forward・Feedback）/ `_with_clap` の改名 /
LinkAudio の実配線。

---

### 6.404 design: ミキサーの土台と、その上に乗るオプションの責務を分けた (#643) (Aug 29, 2026)

**Issue**: [#643](https://github.com/signalcompose/orbitscore/issues/643)（改題: *separate the mixer foundation from the sources that ride it*）
**成果物**: `docs/design/643-mixer-foundation-design.md`（426行）
**Status**: 設計のみ・実装なし。Fable 起案 v1→v6・main 検収

#### 発端: instrument に per-part の処理が一切できなかった

`effect()` / `output()` / `send()` の3つとも note シーケンスで例外。原因は **instrument の音が
master バッファへ直接加算され、バスグラフの外にいた**こと（`outproc_instrument.rs:396-403`）。

spec は実装時期を「#517 S4 PR-1b（#522）」としていたが、**#522 の本文に instrument の insert bus
移設は書かれていない**（grep 0件）。**宛先の無い予定**として1ヶ月宙に浮いていた。

#### 設計が6回変わった — owner の押し戻しが誤った一般化を剥がした

| owner 指摘 | 設計への作用 |
|---|---|
| audio も instrument も同じバス仕様 | gain 非対称が**現状の欠陥**と判明（`global.gain` が instrument に効かない）。注入点が `render_multi` の**内側**へ |
| ちゃんとバスに載せれば解決では | gain の手当ては**不要**。位置を直せば自動的に消える |
| マルチを受けられるバスを今 | アドレス `(instance, unit)` を**今確定**（protocol は後から変えられない） |
| 土台とオプションの責務分離 | 境界表・grep 監査・`SetInstrumentBus` → **`SetSourceRouting`** |
| UI の制限がないぶん柔軟で危険な配線 | **Forward / Feedback の2種エッジ**。焼き込み3箇所を列挙 |

**設計は大きくならず、変わった**: callback → feed で core の追加は ~15 行に減り、pop 対策の機構は
借用構造に吸収されて消え、変異テストは E2E に置き換わった。

#### main の検収で確定させた事実（一次ソース）

instrument は audio event を出さない（`plugin-note-output.ts` にバス引数なし）/ `process_block` は
非ブロッキング（sleep・park・wait・recv・lock・spin が 0 件）/ `free_slots` は LIFO
（`engine_wrap.rs:2460`）/ `get_disjoint_mut` は rustc 1.97.0 で**実コンパイル確認** /
FTZ・DAZ は**未設定**（0 件）/ `STUB_TRANSPORT` 実在（`outproc_instrument.rs:49,388`）/
`send_gain_overrides` の相対 index（`:1706-1707,1760`）。

#### 見つかった既存欠陥

1. **`global.gain` が instrument に効かない** — マスターフェーダーが効かない音がある
2. **`output()` の3分岐のうちガードは1本だけ** — instrument の `output(1)` / `output("Kick Ch")` が
   **黙って通り音が従わない**（silent failure 2件）
3. `QA_2.0.0_HUMAN_RUNBOOK.md:77` が「拡張が `.orbslog` を生成する」と書いているが**拡張は
   `enableSessionLog()` を呼ばない**（CLI も opt-in・既定 off）

#### 実装計画

**実装 ~900-1100 行 + テスト ~900-1100 行・2 PR**（+ follow-up 1）。切り方は**検証手段の境界**:
PR-1 = Rust 4層（`cargo` で検証）/ PR-2 = TS + E2E（実機 OrbitStudio）。

---

### 6.403 docs(rules): 一律の変異検証ルールを3層方針へ置き換えた (Aug 29, 2026)

**Status**: `CLAUDE.md` のみ（+67 / -25）

#### 「新規テストは必ず変異検証」は owner 指示ではなかった

owner の指示は**目的だけ**だった:

> いくら作ってもテストが意味をなしてないと先に進めないので、テストの積み上げだけはしっかりしてください。

一律ルールは過去セッションが目的を手段へ翻訳したもので、**翻訳結果が `owner 指示` の見出しを
引き継いだため再検討されなくなっていた**。owner 本人の「指示した覚えがない」で発覚。

#### 撤回の根拠

旧版は #528（ハーネスが無音を出したのに警報が鳴らなかった）を**変異検証が要る根拠**として
引いていた。しかしあれは **E2E が信号を見ていなかった**事故で、キャプチャに RMS の
アサーションがあれば落ちた。**原因の帰属を一段間違えて、効かない規律を積んでいた。**

「タイミング条件と bit 一致は E2E に届かない」も誤り — **音はデジタルで取れる**し、条件は
DSL から駆動できる。

#### 置き換えた形

**大前提: 機能にはテストを書く（TDD）。型はテストの代替ではない**（軸が違う。owner 指摘の
category error を修正）。以下は機能テストに**加えて何を足すか**:

| 対象 | 追加で足すもの |
|---|---|
| 型が保証している誤り | **何も足さない**（型チェッカが保証することをテストで確かめない） |
| DSL から決定論的に駆動でき信号に出る振る舞い | 機能テストそのものを**キャプチャ E2E** に |
| 駆動できない／信号に出ない内部状態 | **変異検証** |

判定軸は「聞こえるか」ではなく **「DSL から決定論的に駆動できるか」**。

🔴 **指示を記録する時は、引用（owner の言葉）と解釈（手段）を見出しレベルで分けること。**

---

### 6.402 fix: 降格した後に、各 call site のレベルを監査し直した (#628) (Aug 29, 2026)

**Date**: 2026-08-29
**Issue**: #628 / PR #639 / #633
**Status**: ラウンド2（未レビュー分）完了

**PR の約 1/4（38 ファイル・+3379）が誰のレビューも通っていなかった**ため、
その範囲に絞った縮小レビューを回した（レビュアー 4 名 + Fable 監査）。
**Critical 0 / Important 4**（うち 1 件は誤りと判明）。**修正は owner 指示で Fable が担当**し、
**fix 差分の検証は main** が引き受けた（自分の修正を自分で監査させないため）。

### 🔴 WARN 降格が、同じ PR 内の可視化修正 2 件を無効化していた

根 3 で作った診断（`param_apply_errors` のドレイン / drop 時の UI close 失敗）が、
後続の `569b6140` で `WARN` を非エラー化したことにより **ERROR 計数オラクルから消えていた**。
`lib.rs` のコメントは「**a failed UI close must stay audible**」と明記しているのに、である。

**自分で可視化して、自分で消していた。**

### 分類器は変えない — レベルは事象の意味論で選ぶ

**警告は定義上エラーではない。** 欠けていたのは分類器ではなく、
**降格後に各 call site のレベルを再監査しなかったこと**。

> ユーザーへの実害（音の中断/ずれ・データ喪失・機能不全・RT 応答不能）が確定し、
> かつ ticker/RPC に**別表面を持たない**事象は `error!`。
> 自己回復済み・別経路で loud・診断のみは `warn!`。

**namespace で分ける案は採らない** — 騒がしかった `NotePortsExtension なし` は
**自分たちの crate（`orbit_clap_host`）から出ている**ので、その軸では元の問題が戻る。

Fable が `tracing::warn!` を **72 箇所全列挙**し、昇格は **5 件のみ**（残り約 60 箇所は
降格が正しい）。各所に「なぜ error か」を 1 行残した。

**main が分類器を実際に通して両立を実証**:

```
プラグインの雑音(WARN) → 非エラー: true      ← 雑音は黙る
昇格した診断(ERROR)   → 非エラー: false     ← 本物の失敗は見える
```

### silent-failure-hunter の Critical は誤りだった（main が一次ソースで確認）

「child crash → respawn の唯一の可観測シグナルを消した」は**成立しない**。**第 2 の表面がある**:
1 Hz ticker → `DaemonError` event（`session.rs:878-886`）→ `onDaemonError` の `console.warn`
→ Node では **stderr** → 拡張が**無条件に `ERROR: ` 接頭**（`extension.ts:1568`）→ countErrors。
**3 リンクとも実ファイルで確認。**

🔴 **main はこの Critical を裏取り前に owner へ報告した。** 委譲先の指摘も鵜呑みにしない、
という原則が自分に返ってきた形。

### main のコミットメッセージの事実誤認（comment-analyzer 発見）

`b1afc3dd` の「timeout が `MALFORMED_REQUEST` にマップされていた」は**誤り**。
旧実装は `WrapError::OutProcEffect` → `OUTPROC_EFFECT_RUNTIME`（`git show 08731645` で確認）。
`MALFORMED_REQUEST` を観測したのは **serde の `flatten` × `deny_unknown_fields` という
無関係のバグ**のログ。**実際の問題は「マップ先が違う」ではなく、timeout を含む全失敗が
「登記は無傷」と主張していたこと** — 指摘の方がより重い問題を正しく言い当てていた。
WORK_LOG を訂正（コミットメッセージは履歴のため据え置き）。

### テスト追加（`chain_path` の形状ガード）

5 条件（配列でない / 長さ≠1 / 非整数 / 負数 / `MAX_SAFE_INTEGER` 超過）を踏むテストが
**1 件も無かった**。`length !== 1` を `< 1` に変異させても全テスト green の状態だった。

**main の変異 2 種とも red**（`length 2:` / `not an integer:` とラベルが失敗理由に出る）。

### 🔴 ローカルで 1 件失敗するが、この PR の退行ではない（構成による証明）

`pipelined_host_with_real_child_is_gain_delayed_one_block` が macOS のこのマシンで落ちる。

| 証拠 | |
|---|---|
| 静穏時（load 2.96） | **2.96 秒で pass** |
| 負荷時（load 9.95） | 3 回とも fail（7.00 秒 = タイムアウト） |
| **CI（ubuntu）** | **pass** |
| **`orbit-audio-sandbox` への変更** | **`transport.rs` のコメント 9 行のみ・コード行ゼロ** |

コメントのみの変更なので **`sandbox-effect-child` のバイナリは HEAD と同一**であり、
**挙動が変わることは原理的にない**。テスト自身が `#520` で
「`cargo build` 直後の child は macOS のセキュリティ評価で数秒〜24 秒止まりうる」と警告している。

**負荷の出所は main の後始末漏れ**だった — Fable が起動した検証バッテリー
（`cargo test -p orbit-audio-daemon --features …`）が生き残っていた。
**エージェントを止めた ≠ そのプロセスが消えた。** 停止して消滅を確認した。

### 検証

`npm run build` 型エラー 0 / `npm test` **2080 passed** / lint 0 / `typecheck:e2e` 0 /
`cargo fmt --check` exit 0 / clippy **default・両 feature とも通過**

### 6.401 test: 変異 2 件を実機で殺し、完了条件 10 項目を照合した (#628) (Aug 28, 2026)

**Date**: 2026-08-28
**Issue**: #628 / PR #639
**Status**: **完了条件 Q4 の 10 項目すべて充足**。マージは owner 指示待ちで停止

### 🔴 変異検証（項目 6・実機）— 2 件とも red

| 変異 | 期待 | 実測 | 誤差 |
|---|---|---|---|
| keep op の `enabled` 差分を落とす | 0.3157 | **0.2556**（A が有効なまま） | 19.06% |
| standard の `params` を落とす | 0.2526 | **0.5040**（Gain が 0dB） | 99.52% |

2 件目は**ちょうど約 2 倍** — `Gain` が -6dB（線形 0.5011）ではなく既定の 0dB（線形 1.0）で
動いていることを音が示している。`DB_DEFAULT = 0.0` なので偶然の一致は無い。

**どちらも headless では両方 green だった。** 配線の全長
（TS → JSON-RPC → daemon → manifest → child → プラグイン状態 → 音の振幅）
のどこが切れても赤くなる形で、ユニットテストでは原理的に見えない。

Fable の事前予測（1 件目 delta 20%）と実測 19.06% がほぼ一致した。設計の数値モデルが実機と
合っている傍証になる。

### 🔴 Fable の手順指摘が正しかった: 変異は dist に載って初めて効く

> 変異は**ビルド済み配布物に載って初めて効く**。gated は実アプリ（dist）を駆動するので、
> ビルドを挟み忘れると変異が「生き残った」ように見える（実際は走っていない）

`変異 → npm run build → 再起動 → gated → restore → build → 再起動` を厳守した。
**1 変異 = build 2 回。** [[no-stash-during-hooked-commit]] の隣のクラス。

なお 1 件目は**型が `enabled` を必須にしていて単純削除がコンパイルを通らなかった**
（型で守られている）。意味的に同じ「差分を無視して常に `true` を送る」形に変えた。

### 🔴 復元が失敗した（記録）

変異 2 件目の restore が **`$TMPDIR` の食い違いで失敗**した:

- バックアップを取ったコマンド → **sandbox 内**の `$TMPDIR`
- 復元したコマンド → **`dangerouslyDisableSandbox` + background** で**別の `$TMPDIR`**

`cp` が `No such file or directory` で落ち、**変異が残ったまま**「green 確認」を走らせていた。
`cmp` による復元確認を入れていたので検出できた。

> **教訓**: [[mutation-backup-must-use-tmpdir]] は正しいが、**sandbox の内外で `$TMPDIR` が
> 変わる**条件が抜けていた。**復元は `git checkout` の方が確実** — バックアップファイルの
> 所在に依存しない。

### Fable の E2E レビュー（項目 4）— 指摘 0 件

§4 の false green 12 行すべてが実装で成立。特に:

- **`states/` の非同期登記**（Fable 自身が予告した flaky ポイント）は固定 sleep ではなく
  「ファイル数 +1 **かつ** manifest の B entry が旧パスと異なる **かつ** 実在」の 3 条件 poll
- seg6 が**保存 state からの復元を音で検証**する（設計より強い）
- アンカー 4 件とも実装原文と一致を grep で照合
- **main が入れた診断 2 件も機能する**と確認（label 一回評価の罠を正しく回避）

Fable の自己訂正 1 件: 設計書の「分離 25% ⇒ マージン 10%」は、実効マージンが**最悪 5pt**。
実測ノイズ ≲1% なので判定は揺るがない。

### 完了条件 10 項目すべて充足

実測は `docs/development/evidence/628-gated-evidence.md`（全区間の RMS・窓系列・onset）と
`docs/development/enumeration-13.md` に保存し、PR 本文から参照した。

owner 判断 3 点はすべて回答取得済み — (i) Cmd+Click の #633 移管 **承認** /
(ii) `WARN` を非エラーへ / (iii) `CLAUDE.md` マージ前ゲートに実 `Gain` テストを**恒久追加**。

### 6.400 chore: 列挙 13 本を回し、撤回済み API の残骸を 1 件消した (#628) (Aug 28, 2026)

**Date**: 2026-08-28
**Issue**: #628 / PR #639
**Status**: 完了条件 Q4 項目 7（列挙）完了

設計 §7 の列挙コマンド 13 本を最終コミットで再実行し、
`docs/development/enumeration-13.md` に**コマンドと件数**を記録した。

### 🔴 列挙が本物の残骸を 1 件見つけた（項目 10）

`resolveCatalogMethodCandidates`（`plugin-resolver.ts`）は**撤回された SC.10.9（メソッド形）
の残骸**で、**source 側に呼び出し元が 1 件も無かった**（dist の成果物と自身の export のみ）。

🔴 **前回の記録（コミット `4a08ecd6`）では「1」と記録されたまま未処置だった。**
件数を記録するだけで処置していなければ、列挙は機能しない。

**到達不能を実行で証明してから削除した**（grep だけを根拠にしない・
[[absence-claims-need-exhaustive-enumeration]]）:

```
削除後: npm run build 型エラー 0 / npm test 2079 passed / npm run lint 0
```

同じ grep が拾う `resolve.ts:74` の `kind: 'plugin'` は**残した** —
**診断用の名前衝突分類器**そのもので、設計が明示的に認めている用途。

### 項目 11 の 2 件は「残骸」ではなくガード本体

```
await expect(bus.ui(1 as any)).rejects.toThrow('numeric indexes are not supported')
```

**数値 index が拒否されることを検査する負のテスト**。grep が自分のガードを拾っているだけ。

> **この grep を「0 件でなければ不合格」と機械的に運用すると、ガードを消す方向の圧力になる。**
> 件数だけでなく中身を読むこと。記録にもそう明記した。

### owner 判断（3 点すべて回答済み）

| | 判断 |
|---|---|
| (i) Cmd+Click の #633 送り | **承認**（3 箇所に記録済み） |
| (ii) WARN 分類 | **分類器に `WARN` を追加**（実機で 7 件落ちた実測を提示） |
| (iii) `CLAUDE.md` マージ前ゲート | **恒久追加する**（実測 19〜67 秒・変異で red を確認済み） |

### 6.399 test(e2e): 赤 3 件すべてが単一の既知欠陥に帰着した (#628) (Aug 28, 2026)

**Date**: 2026-08-28
**Issue**: #628 / PR #639 / #633
**Status**: 実機ゲート 5 回。**赤は既知 1 件に起因する 3 テストのみ**

### 🔴 結論: 3 件すべてが `UI_CLOSED_DONE`（#633 送り）に帰着する

| テスト | 原因 |
|---|---|
| `drives real OrbitStudio end-to-end` | `UI_CLOSED_DONE (20000ms)` タイムアウト（直接） |
| `#618 E1-E6` | 同上（直接） |
| `reports an ambiguous bare mixer name` | **同欠陥のログ洪水による巻き添え** |

### 3 件目の分類に 3 回かかった（記録）

1. **5 秒 → 15 秒に延ばした** → 効かず。「待ち不足」という読みが外れた
2. **診断を仕掛けたが、仕掛け自体が壊れていた** — `waitUntil` の `label` に埋めた
   テンプレート文字列は**呼び出し前に一度だけ評価される**ので、ログ末尾は常に空だった
   （失敗メッセージが `Log tail:  after 15000ms` になっていた）。
   🔴 [[escalation-does-not-fix-opacity]] の「仕掛けた捕捉自体が壊れている可能性を先に疑う」
   がそのまま当てはまった
3. **catch 側で診断を組み立てる形に直して実測** → 原因が一目で分かった

```
errorsBefore=0 lastCount=0
--- log tail ---
ERROR: [daemon] … plugin UI event pump failed: plugin UI event protocol error:
UI_CLOSED_DONE seq 2 has invalid completion Some("{\"index\":0,\"completion\":\"safepoint-completed\"}")
（約 25ms ごとに繰り返し）
```

`errorsBefore=0 lastCount=0` は**窓の回転ではなく、そもそも一度も出ていない**ことを示す。
原因は **`get_log` の固定 500 行窓がこの洪水で埋まり**、曖昧性エラーが出ても即座に窓の外へ
押し出されること。**待ち時間の問題ではなかった。**

手で同じ DSL を評価すると診断は期待どおり出る（機構は正しい）。
`git diff main..HEAD` にこのテストの変更は 0 件（この PR の退行ではない）。

### この発見が #633 の優先度を上げる

既知欠陥は **UI close を壊すだけでなくログを溢れさせ、無関係なテストまで巻き込む**。
`drives real OrbitStudio end-to-end` が `UI_CLOSED_DONE` で落ちると、その
`stop_engine`（1194 行・テスト最終ステップ）に**到達しない**ため、
エンジンが状態を保ったまま後続テストへ流れる副作用もある。

### 実機ゲートの推移

| 回 | 結果 | 見つけたもの |
|---|---|---|
| 1 | 7 failed / 3 passed | `WARN` が `ERROR:` に分類される（F-a の予測が的中） |
| 2 | **3 failed / 7 passed** | **新規 2 ブロック green**・`#625` も復活 |
| 3 | 3 failed | この PR が変えた文言にアンカーが追随していなかった |
| 4 | 3 failed | 待ち延長は効かず・**診断の仕掛けが壊れていた** |
| 5 | 3 failed | **診断が働き、3 件すべてが既知に帰着すると確定** |

```
✓ #628 R28: rack chain audio mainline                    42343ms
✓ #628 R28: rack master + MCP standard-element error       550ms
```

### 6.398 fix: 警告はエラーではない（実機ゲートが 7 → 3 へ） (#628) (Aug 28, 2026)

**Date**: 2026-08-28
**Issue**: #628 / PR #639
**Status**: 実機ゲート 3 回実行。**新規 2 ブロックが green**。赤 3 件中 2 件は既知

### 🔴 実機ゲート 1 回目: 7 failed / 3 passed — 既存テストまで落ちた

原因は Fable が監査 F-a で予測し、main が「実機で測ってから決める」としていたもの:

```
ERROR: [daemon] 2026-08-28T12:19:01.534614Z  WARN orbit_clap_host::controller:
       [orbit-clap-host] NotePortsExtension なし; port 0 を使用
```

**プラグイン自身の正常動作の警告が `ERROR:` 行として記録され**、ERROR 件数が 15 → 17 に増えた。
根 3 で rack child に tracing subscriber を入れた副作用で、`orbit-clap-host` の中継が
un-silence されたため。**予測が当たった。**

同じログに**ラックが正しく動いている証拠**も出ていた:

```
[orbit-effect-rack] child spawned pid=62008
[plugin-state] restoring 'fx628/effect/CLAP Test Effect/0' from .../e2e-r28-catalog-a.state
[plugin-state] restoring 'fx628/effect/Gain Ω (Factory3 oracle)/0' from .../e2e-r28-catalog-b.state
```

**落ちていたのは音の正しさではなく診断行の分類だった。**

### 対処（owner 判断）: 分類器の非エラー集合に `WARN` を追加

**警告は定義上エラーではない。** 非エラー集合を `TRACE|DEBUG|INFO` →
**`TRACE|DEBUG|INFO|WARN`** へ（2 箇所）。行そのものは `get_log` に残る —
`console.error` ではなく `console.log` へ回るだけで、**診断が消えるわけではない**。

既存の `WARN → false` を期待していた 3 箇所を更新した。
🔴 **テストを緩めたのではなく決定が変わった**ので、その旨と発端を理由として残してある。
新規テストのアンカーは**実機で実際に踏んだ行をそのまま**使った（手で整えた文言を使わない）。

**main が変異検証**（両方向）:

| 変異 | 結果 |
|---|---|
| `ERROR` まで非エラーに緩める | red（2 件） |
| `WARN` を元に戻す（この修正の無効化） | red（3 件） |

### 🔴 2 回目: 3 failed / 7 passed — **新規 2 ブロックが green**

```
✓ #628 R28: rack chain audio mainline                    42581ms
✓ #628 R28: rack master + MCP standard-element error       538ms
```

**この PR の中心機能が、実機の音のアサーションまで通った。**
`#625 R-E1-R-E7`（既存のエフェクト差し替え）も復活。

### 3 回目: エラー文言のアンカーを実装に追随させた

`drives real OrbitStudio end-to-end` が
`current slot is 'X'; the UI was not opened` を期待していたが、**この PR のコミット
`3b634850` が実装側に `re-evaluate first;` を挿入**していた。
**文言を変えた PR がアンカーを更新し忘れていた** — 実機ゲートが捕まえた。

修正後、このテストは当該 assert を通過し `UI_CLOSED_DONE` まで進んだ（= 既知の赤）。

### 現在の赤 3 件

| テスト | 判定 |
|---|---|
| `drives real OrbitStudio end-to-end` | **既知** — `UI_CLOSED_DONE (20000ms)` タイムアウト（#633） |
| `#618 E1-E6` | **既知** — 同上 |
| `reports an ambiguous bare mixer name` | **未分類** — 1〜3 回目とも同じ形で失敗。ログに文言も `MustNotLoad` も一度も出ない |

3 件目は `-t` フィルタでの単独実行がスイート共有 boot を壊すため、その方法では切り分けられなかった
（`main gated phase must initialize the MCP client first`）。**継続調査中。**

### 検証

`npm test` **2079 passed**（+1・分類器のテスト）/ `typecheck:e2e` 0 / lint 0

### 6.397 test(e2e): ラックの実機テストを書き、数値設計を実機の手前で守る unit を置いた (#628) (Aug 28, 2026)

**Date**: 2026-08-28
**Issue**: #628 / PR #639
**Status**: 発注 B 実装完了。**実機ゲートの実行は未了**

計画 `628-plan-reset.md` の**発注 B**。設計正本は `628-gated-e2e-rack-design.md`（承認済み）。

### 1. ゲイン三つ組の定数 + 純 unit（設計 §2.2）

E2E 設計 §4-2 の要（**A=0.8 / B=0.63 / `Gain(db: -6)`**・部分積の全ペア ≥25% 分離）は
**値を 1 つ動かすだけで静かに崩れる**。期待比率表を `rack-chain-gain-expectations.ts` に
**一元化**し、E2E と unit が共有する。これで**実機に行く前に `npm test` で赤になる**。

🔴 **main が自分で変異 3 種を回した**（委譲先の報告は根拠にしない）:

| 変異 | 実出力 |
|---|---|
| A を `0.81` に | `full and withoutCatalogA must remain at least 25% apart: expected 0.2345… >= 0.25` |
| 標準を **`0dB`（unity）** に | `full and withoutStandard …: expected 0 to be >= 0.25` |
| **設計原案の `-20dB`** | `full-chain RMS must retain the designed audible-floor margin: expected 0.0052… >= 0.01` |

3 番目が効いている。**設計正本 §6 の原案 `Gain(db: -20)` を使うとこの unit が赤くなる** —
Fable が机上で見つけた「full 積が可聴フロアを割る」問題が、いま機械で守られた。
2 番目は「透過している」と「適用されていない」が数値で区別不能になる形を殺す。

### 2. gated E2E の新規 2 ブロック（673 行追加・8 件 → 10 件）

R28-E1〜E5 / E7〜E10a を実装。§4 の false green 12 行すべてに対応する assert を置いた
（対応表は Codex の報告に行番号つきで残っている）。要点:

- **`ok` 単独の assert は 1 つも無い** — 全区間を RMS 比率・PID・marker・state 副作用で判定
- **bypass と drop は音で区別できない**ので `states/` のファイル数で捕まえる。
  catalog drop は「**+1 かつ manifest 値更新かつ実ファイル存在**」が揃うまで poll
  （非同期登記による flaky を防ぐ）
- 文言アンカーは**実装からコピー**（`the previous chain is kept` 等）
- ERROR 件数は固定 500 行窓なので**すべて `toBeLessThanOrEqual`**

### 🔴 変異 2 件が headless では green だった（実機でしか殺せない）

要求した「catalog enabled だけ欠落」「standard load params 欠落」の 2 変異は、
**headless では両方 `15 passed`** だった。Codex はこれを**未達として正直に main へ引き渡した**
（迂回もテスト緩和もしていない）。**実機ゲートで取るのは main の担当。**

より広い変異（enabled 欠落全般）では既存 T9 が red になることは確認済み
（`Expected: "enabled": false / Received: "enabled": true`）。

### 設計からの逸脱 1 件（申告あり・main が中身を確認して承認）

**負荷時の `daemon ready line timeout after 10000ms` を 1 回だけ retry する起動補助**を追加。
CP2 で main が実機で踏んだ現象への対処。

main が実装を読んで確認した点: **本物の失敗を隠さない** —
新規に出たマーカー数が増えた場合だけ retry し、**別種の失敗も 2 回目の失敗も
output channel を添えて即座に赤**にする。retry 前に `stop_engine` して状態も戻す。

### 検証（main が sandbox 外で全幅）

`npm run build` 型エラー 0 / **`npm test` 2078 passed・失敗 0** /
lint 0 / `typecheck:e2e` 0 / clippy default・両 feature とも通過 / `cargo fmt --check` exit 0 /
**gated は env 無しで 10 件 skip**（通常の `npm test` を壊していない）

🔴 Codex の環境では `npm test` が **104 failed** に見えていた。原因は
**sandbox の `listen EPERM`**（localhost を使う既存テスト 4 ファイル）で、実体ではない。
Codex は迂回せず報告した。**sandbox の失敗を実体と混同しない。**

### 残り

**実機 gated の実行**（main・未了）。起動前ゲートと終了処理を含む手順は
scratchpad の `hw-loop-runbook.md` に固定した（CP2 で `LOOP` を止め忘れた欠陥への対処を含む）。

### 6.396 feat: MCP を chain_path 対応にし、Gain の dB 契約を CI で守る経路を作った (#628) (Aug 28, 2026)

**Date**: 2026-08-28
**Issue**: #628 / PR #639
**Status**: 発注 A 完了。**配列記法が実機で初めて動いた**

計画 `628-plan-reset.md` の**発注 A**（実機を起動せずヘッドレスで検収できる項目）。

### 実装 5 件

1. **MCP `open_plugin_ui` / `close_plugin_ui` の `chain_path` 対応**（完了条件 15(b)）。
   🔴 **additive** — `index` を削除せず、`chain_path` を優先し、**両方来て食い違えば loud 拒否**。
   `index` の撤去は表面の削除なので **owner 判断で #633 へ送済み**
2. `gain_bundle_dir()` が **`ORBIT_STD_PLUGIN_DIR` を尊重**（release ビルドの bundle を指せる）
3. **`release.yml`（macos-14 既設）に実 Gain テストの step**。`--lib` は load-bearing（#629）
4. **`orbit-std-gain/tests/contract.rs` に in-process 処理契約テスト** —
   activate → 実バッファ 1 block process → -6dB で半振幅 / 0dB で恒等。
   clack-host の in-process instance で audio processor まで進められた（**残余ギャップなし**）
5. 小修正 3 件 — テスト ID `c13` の重複解消（`c16`〜`c18` へ）/ `.any()` を回数検査へ /
   未使用の `unsafe impl Sync for AudioCell` を削除

### 🔴 起動前ゲートが型エラーを 1 件捕まえた（main のブリーフの穴）

`z.array(z.number().int())` を足したが、この拡張の **zod 型スタブには
`string`/`number`/`boolean` しか宣言が無く**、**`npm run build` だけが落ちる**状態だった。

**私の発注ブリーフの検証コマンドに `npm run build` が入っていなかった。**
`npm test` / `npm run lint` / `npm run typecheck:e2e` は**どれも
`packages/vscode-extension/src` を型検査しない**。スタブを使用実態に合わせ、
「使う builder を増やしたらここも増やす。漏れは build だけが落ちる」と理由をコメントに残した。

> **教訓**: 検証コマンドの一覧は「何を通せば安心か」ではなく
> **「どのゲートが何を見ていないか」**から作る。

### 🔴 CP2 — 配列記法が実機で初めて動いた

`bundle-macos.sh` + `npm run build:clean` → OrbitStudio をクリーン起動 → MCP 経由で評価:

```
kick.effect(["CLAP Test Effect", Gain(db: -6)])   → ok / ERROR 増加なし（1 → 1）
```

**child プロセスは 1 つだけ**で、`--chain <manifest>` で起動していた（旧 `--plugin <パス>` ではない）:

```
46309 orbit-effect-rack-child --shm ... --chain ...chain.json --sample-rate 48000
```

manifest の中身:

```json
{"version":1,"stages":[
  {"kind":"catalog","path":".../CLAPTestEffect.clap",
   "plugin_id":"com.signalcompose.clap-test-effect","state":null,"enabled":true},
  {"kind":"standard","name":"Gain","params":{"db":-6.0},"enabled":true}]}
```

**この PR の中心的な主張が実機で裏付けられた**: 1 レシーバに複数 insert /
1 child がチェーン全体を持つ / **3 カテゴリを構文で分ける**（文字列 → `catalog`・
大文字呼び出し → `standard`）/ `Gain(db: -6)` の引数が `params.db = -6.0` まで届く。

### 手で回す実機トライアルの手順に欠陥があった（owner 指摘）

**`LOOP` を張ったまま止め忘れ、音が鳴り続けた。** gated テストなら `afterAll` が
面倒を見る部分で、手で回したから抜けた。以後は
**起動 → 評価 → 観測 → `stop_engine` → プロセス消滅確認 → アプリ終了**を一組にする。

### 実機で 1 件観測（判断材料）

エンジン起動が一度 `DaemonStartupError: daemon ready line timeout after 10000ms` で落ちた。
daemon 単体では ready 行（`{"ready":true,"port":59760,...}`）を即座に出すことを確認済みで、
cargo のテストとビルドが並走していた時間帯だったため**負荷による超過**と見ている。

### 検証

`npm run build` **型エラー 0** / `npm test` **2076 passed** / lint 0 / `typecheck:e2e` 0 /
clippy default・両 feature とも通過 / `cargo test --workspace` **477 passed** /
daemon 両 feature **229 passed** / child-runtime 29 / std-gain 8+5 / `cargo fmt --check` exit 0

### 6.395 docs: 計画を立て直し、Cmd+Click を #633 へ移管した (#628) (Aug 28, 2026)

**Date**: 2026-08-28
**Issue**: #628 / PR #639 / #633
**Status**: 計画確定・owner 判断 2 件取得

owner から「一度状況を整理して開発プランを立て直す。**必要ならゴールをクリアする**」との
指示。main が状況を 130 行に整理し、Fable が `docs/design/628-plan-reset.md`（237 行）を起案。

### 🔴 Q2 — 反復を減らす打ち手は「回数」ではなく「1 回のコストと情報量」

前回の実機ゲートは **11 回反復して 6 件の欠陥**を出した。Fable がこれをクラス別に検分し、
**6 件全部が既に構造的に閉じている**ことを表で示した（main が実コードで裏取り済み）:

| 前回の欠陥 | 現在の状態 |
|---|---|
| serde `flatten` × `deny_unknown_fields`（2 回） | 共有型 1 箇所 + wire 実 payload の pin テスト |
| rack child が配布物に無い | `SPAWNABLE_CHILD_BINARIES` 台帳 + release gate |
| PID オラクル不作動（`--plugin`→`--chain`） | ログ由来オラクル + `rack-child-pid-oracle.spec.ts` |
| ERROR 件数の厳密等価（500 行窓） | `<=` イディオムに統一 |
| 台帳 A の漏れ | #548 ガードが捕捉 |
| （main）E2E の実行時 `ReferenceError` | `typecheck:e2e` ゲート新設（変異実証済み） |

**前回の反復を生んだクラスは再発しない。次の反復を生むのは新表面の未知だけ。**

打ち手は 3 層: (1) 起動前ゲート（両 clippy・両 feature テスト・実 Gain 67 秒・
**同梱物の `ls` 2 本**で「ビルドは通るが配布物に無い」を起動前に殺す）、
(2) **ゲイン三つ組を定数 + 純 unit 化**（値を 1 つ動かすと分離が静かに崩れる設計なので、
実機に行く前に `npm test` で赤にする）、(3) スコープ実行 + 全文ファイル保存。

🔴 **回数は約束しない。** 約束すると品質を削る圧になる。約束するのは 1 回のコストと情報量。

### owner 判断 2 件

1. **Cmd+Click（完了条件 15(a)）を #633 へ移管** — 承認。
   `SC.10.10` 規範 2 が定める**UI 起動の主経路**なので、勝手に動かさず owner 確認を取った
   （Fable が「これは owner 確定事項」と正しく止めた）。
   **理由**: Cmd+Click の終端である UI close 完了（`UI_CLOSED_DONE`）が #633 の既知欠陥で
   **この branch では壊れている**ため、いま実装しても実機確認の半分が #633 待ちになる。
   #633 が「UI 起動 3 経路の完成 PR」として E10b・`index` 撤去判断と一枚岩になる。
2. **WARN 分類と CLAUDE.md マージ前ゲート追加は、実機ゲートの実測後に判断** — 承認。

### 🔴 移管は 3 箇所に記録した（黙って落とさない）

- 親設計 `628-rack-chain-implementation-design.md` §1-15(a) に移管注記
- core spec `INSTRUCTION_ORBITSCORE_DSL.md` に**現在地 1 行**（spec が正本・乖離を作らない）
- #633 issue に 3 項目（Cmd+Click / E10b / `index` 撤去の owner 判断）

### Q4 — マージ可の定義を 10 項目、全部コマンドと観測可能条件で

曖昧語なし。特に項目 9 が良い設計: owner の判断 3 件について
**「本 PR では変えない」という回答でもマージ可。判断の所在が明示されていることが条件**。

### Q5 — 境界は移管 2 件を除き正しい。#634 に決定ゲートを 1 つ

#634（PDC 単独 PR）は「表面より機構が先」の既知手戻りクラスになる恐れがあるため、
#633 完了時に「#635 へ畳むか、観測可能な表面を完了条件に含めて単独維持か」の
**決定ゲートを 1 つ置く**（[[ux-surface-before-mechanism]] の予防）。

### 委譲の順序（§6 の実測を前提に）

**直列 2 発注**（並行しない — 本日同一ツリーに write 権 2 本が走った事故がある）:
発注 A（実機不要・ヘッドレス検収可能）→ 発注 B（E2E 一式）→ main の起動前ゲート → 実機ループ。
**実機ループ内の fix は委譲しない。**

### 6.394 fix: 「確定拒否」と「不明」を分ける述語を 1 つ入れた (#628) (Aug 28, 2026)

**Date**: 2026-08-28
**Issue**: #628 / PR #639
**Status**: 根2 完了。根4（実機を通す経路）は継続

レビューラウンド1の**根 2**。3 つの症状が**同じ 1 つの誤った前提**から出ていた:

> `effect-slot.ts` は `DaemonProtocolError` を「**確定拒否 = daemon の登記は無傷**」と
> 解釈して `uncertainRacks` に入れない。daemon 側の文言も
> `"...; the previous chain is kept"` と言っている。
> **この解釈が正しいのは、daemon が生きていて登記が本当に無傷なときだけ。**

### 症状 3 つ

| | 内容 |
|---|---|
| **A** | respawn 後の rack 再構築失敗が `console.error` だけで self-heal に載らない。**同じ行を何度再評価しても同じエラーが出続け、自己修復経路が存在しない**。既存の非ラック経路は `markPluginInactive` を呼んでいるのに、新設パスだけ対称のパスが無かった |
| **B** | APPLY の mailbox timeout が state 保存と同じ **5 秒**。`OPEN_UI` は「重い plugin の `createView` は 5 秒を正当に超えうる」として専用の上限を持つのに、**N 発の load を含む APPLY が 5 秒**。超過すると child は放棄を知らず commit しうる一方 daemon は確定 Err を返し、**音 = 新チェーン / daemon 台帳 = 旧 / TS 登記 = 旧** の三者乖離が固定する。旧実装のマップ先は `WrapError::OutProcEffect` → `OUTPROC_EFFECT_RUNTIME` で、問題は「マップ先が違う」ことではなく **timeout を含む全失敗が「登記は無傷（the previous chain is kept）」と主張していた**こと（🔴 訂正 2026-08-28: 本欄は当初「timeout が `MALFORMED_REQUEST` にマップされていた」と書いたが誤り。`MALFORMED_REQUEST` を観測したのは serde の `flatten` × `deny_unknown_fields` という無関係のバグのログだった。コミット `b1afc3dd` のメッセージにも同じ誤記が残るが履歴のため書き換えない） |
| **C** | 不健全な Active への rebuild が**死んだ mailbox に save を発行**し、5 秒 × drop 件数の末に APPLY 全体が Err。**設計が「第一級で高速化する」と謳った「クラッシュした犯人を配列から消して再評価」が、まさにその状況で失敗する** |

### 導入した述語（1 つで 3 箇所を揃える）

> **「daemon の登記が無傷である」と言えるのは、daemon がその要求を検分して確定的に拒否し、
> かつその間 child も daemon も生死を跨いでいないときだけ。それ以外の失敗はすべて
> 「不明（uncertain）」であり、次回は `rebuild` に倒す。**

**この repo が既に持っていた前例に乗せた** — `session.rs` のエラーコード体系には
`CLAP_NOT_LOADED` について「TS 層が actionable に判定できるようにする専用コード（#405）」と
書かれている。同じ形で **`OUTPROC_EFFECT_UNCERTAIN`** を足し、
`isEffectChainRegistryIntact()` を TS 側の単一の分岐点にした。

- 「確定拒否」と認めるのは `CommandMailboxError::CommandFailed` だけ。
  `Timeout` / `ChildExited` / `Poisoned` はすべて uncertain（**保守側に倒す**）
- respawn 失敗は**既存の `markPluginInactive` / `isPluginActive` seam** を通す
  （新機構を作らない。既存機構を借りるなら不変条件も継承する）
- **`APPLY_CHAIN_MAILBOX_TIMEOUT = 60s`** を新設（spawn の READY 待ちと同じ league）。
  `PLUGIN_STATE_MAILBOX_TIMEOUT` を流用しない
- 不健全と検分済みの Active には save を発行せず `latest_state` で代替

### 変異検証（すべて main が実行・両方向を潰した）

| 変異 | 結果 |
|---|---|
| 述語を常に `true`（元の欠陥を再導入） | red（2 件） |
| 述語を常に `false`（過剰に uncertain） | red（1 件） |
| `measurement_invalid` の検分を外す | red（1 件） |
| respawn 失敗時の `markPluginInactive` を消す | red（1 件） |
| `applyRackBody` の catch で uncertain を立てない | red（3 件） |

**緩めても厳しくしても落ちる**のが要点。過剰に uncertain へ倒すと毎回 rebuild になり
prepare-commit の利点が消えるので、そちらも守る必要がある。

### 🔴 main 自身の検証ミス（記録）

最初の変異が「生き残った」と出た。原因は**実行コマンドが狭かった**こと:

```
cargo test -p orbit-audio-daemon --lib                                             →  36 件
cargo test -p orbit-audio-daemon --features outproc-effect,outproc-instrument --lib → 229 件
```

daemon のテストの大半は feature の下にあり、**当該テストがそもそも走っていなかった**。
委譲先を「部分テストだけ回して報告した」と指摘した当人が同じことをしていた。
**feature 付きの数字と無しの数字を混ぜない。**

### あわせて直したもの（Fable 監査 F-b / F-c）

main が最終 fixer として書いた根1・根3 を Fable に監査させたところ、
**私のコメント 2 件が実装と食い違っていた**:

- `adopt_interlock`（テスト用 barrier）の上に、**棄却した別 atomic 案の説明**が残っていた
- 「`load_initial` は status を set しなくなった」「The Release store below」— どちらも事実と違う

コミットタイトルが「コメントが支えていた順序をコンパイラに支えさせた」なのに、
**残ったコメント自体が新たな嘘になっていた**。両方書き直した。

### 検証

clippy は **default features と feature 付きの両構成**で exit 0（default 構成は
`pre-push` で一度止められて気づいた。**feature 付きの clippy は default 構成の証拠にならない**）/
daemon **229 passed** / sandbox 87 / rack-child 15 / `cargo fmt --check` exit 0 /
TS **2071 passed 0 failed** / lint クリーン / `npm run typecheck:e2e` exit 0

### 残り

**この PR の中心機能（配列記法・N 段直列・`Gain`）は実機を一度も通っていない。**
根 4 の gated E2E 実装が最大の残件で、前回の実機ゲートは 11 回反復して 6 件の欠陥を出した。
owner の指示で Fable に開発プランを立て直させている（`docs/design/628-plan-reset.md` を起案中）。

### 6.393 fix: コメントが支えていた順序を、コンパイラに支えさせた (#628) (Aug 28, 2026)

**Date**: 2026-08-28
**Issue**: #628 / PR #639
**Status**: 根1・根3 完了。根2・根4 は継続

レビューラウンド1（`/code:pr-review-team` フル編成4名 + Fable 監査を**並行**）で
**Critical 8 / Important 10**。全件を main が実コードに当たって裏取りした。
指摘は18件だが**根は4つ**。本エントリはそのうち **根1と根3**を閉じた記録。

🔴 **指摘単位のローカルパッチは当てていない。** 根ごとに不変条件を1つ導入し、
全該当箇所をそれで揃えた（指摘単位のパッチは振動の主因）。

### 根1 — audio がまだ使っている stage が破棄されていた

`collect_retired()` が retired を1つ回収しただけで `pending_stage_drops` を**全部** clear し、
**世代の対応を検査していなかった**。

adopt は `pending.swap(null)` → `retired.compare_exchange` の**2步**で、その間は pending も
retired も null。この窓で `apply` が Busy 判定を通過し、新たに積まれた drop が直後の retired
回収の巻き添えで破棄される。audio は次のブロック境界まで（最大 ~10.7ms）その stage を指す
リストで `process_block` を続ける。`AudioCell` の SAFETY コメントが宣言した不変条件そのものが
破れていた。

**机上解析で確定させず、先に実行で証明した**:

```
collecting generation 1 must not destroy a drop published by generation 2
  left: 0    right: 1
```

UAF を実際に起こさず live 数で検出するので、テスト自体は安全。

**導入した不変条件**: apply が世代 G を publish したときに積んだ drop は、
**audio が世代 G を adopt し終えた後にのみ**破棄してよい。

### 🔴 変異が1つ生き残ったので設計を変えた（本エントリの主眼）

初版は世代を `ChainExchange` の別 `AtomicU64` に置いた。ところが変異
**「store を CAS の後ろへ動かす」が全テスト green のまま生き残った** —
順序が**誰も守らせられない規約**になっていた。

**世代を retire するリスト自身（`StageList::retired_at_generation`）に持たせた**。
ポインタの publication が世代を運ぶので、順序が型の性質になる。同じ変異はいま
**`no field on type *mut StageList`** でコンパイルを通らない。**壊し方のクラスごと消えた。**

> **教訓**: 変異検証は「テストが弱い」ことだけでなく「**設計が規約に依存している**」ことも
> 教える。生き残った変異に対しては、テストを足す前に**その壊し方を表現できなくする**道を
> 先に探す。

### 🔴 検証中に見つけた同型の順序問題（根3-3）

child が `LOAD_FAILED` を立ててから detail を書いていた。daemon は status を観測した瞬間に
detail を読むので、**先に status を見ると診断が黙って汎用メッセージに劣化する** —
根3が消そうとしている当のもの。

失敗の出口を1つに畳み、`load_initial` の内側で「detail → status」を固定。
**C8 がその順序を検査する**（detail を書く瞬間の status を記録し、まだ立っていないことを確認）。
変異（順序を戻す）で red を確認済み。

### 根3 — 診断を `get_log` に終端させた（4箇所）

**方針**: 「後で誰かが読む」計装を作るなら**読み手を同じコミットで配線する**。
読み手を書けないなら計装を作らない。

1. **`param_apply_errors` の読み手が workspace 全体で 0 件**だった。`/simplify` で
   `eprintln!` をカウンタに替えた際に報告側が丸ごと落ちており、しかもコメントは
   「main スレッドが読み出して報告する」と**2箇所で宣言していた** → サービスループが
   増分をドレインして `tracing::warn!`
2. drop 時の UI close 失敗の `let _ =` → `tracing::warn!`（音は止めない・loud にするだけ）
3. 初回 spawn/rebuild の **failed-index detail が消えていた**（mailbox 経由の2回目以降は
   通るので初回限定）→ shared region 経由で daemon へ渡し RPC の message に載せる
4. crash ログにプラグイン名を載せた（設計 §2.3 との乖離）

🔴 `eprintln!` は使わない — 拡張が daemon の stderr を**全部 `ERROR:` に分類する**ため
（同型の欠陥が4回再発している）。

### 根4の一部 — `tests/` に型検査ゲートが無かった

gated E2E に**実行時に必ず `ReferenceError` になる未定義変数**が出荷されていた
（`4a08ecd6` が `waitUntil` 化の際に宣言だけ消した）。ラック側を絞って gated を11回
回したので踏まなかった — **絞って回したことが穴になった**。

原因は構造側にあった: `tsconfig.eslint.json` は `tests/**` を include するのに、
**それに tsc を走らせる経路がどこにも無い**（build の references は packages 2つだけ・
eslint は未定義変数のような意味論エラーを見ない）。

`tsconfig.tests.json` + `npm run typecheck:e2e` + `code-review.yml` のステップを追加。
**変異で実証**（宣言を戻すと `TS2304` で red・restore で green）。
`tsconfig.eslint.json` を流用しないのは、あれが lint 支援用に `module: nodenext` を
上書きしており、build では出ない解決由来のエラーを packages に 5 件出すため。

### 変異検証（すべて main が実行）

| 変異 | 結果 |
|---|---|
| `retain` → `clear`（元の欠陥を再導入） | red |
| 不等号 `>` → `>=` | red（既存 C7 が殺す） |
| 世代の書き込みを CAS の後ろへ | **コンパイルエラー = 表現不能** |
| 刻む世代を `+1` | red |
| status を detail より先に立てる | red |

### 🔴 委譲で起きたこと（運用の記録）

1. **Codex が使えなくなった** — メモリ安全性の修正という主題が OpenAI 側のコンテンツ
   フィルタに引っかかる（"possible cybersecurity risk" の誤検知）。CLAUDE.md の規定どおり
   Sonnet subagent（xhigh）へ切り替えた
2. **発注が届いていなかった** — ジョブの `summary` が `--help`・`write=False`。
   **発注文がフラグとして解釈され本文が失われていた**。転送役の idle を「実行中」と
   読みかけた。→ **`--prompt-file` で本文を渡し `--write` を明示する**
3. **二重起動** — 転送役が自分で復旧を試み、main も並行で復旧して**同一ツリーに write 権を
   持つ Codex が2本**走った。cancel + **PID 消滅を確認**して収束
4. **Sonnet が同じ失敗を2回** — 1回目は肝心の1行を書かず（`dead_code` 警告として出ており
   **指示した最初の検証コマンド clippy を回していれば気づけた**）、2回目は不等号を誤り
   **既存 C7 を落としたまま報告**。規約どおり main が引き取った

> **教訓**: 「完了通知」「idle」はいずれも**終了の証拠にならない**。
> 受け入れ検証は必ず main が sandbox 外で回す。

### 検証

Rust 35/86/15 passed・failed 0 / clippy `-D warnings` exit 0 / `cargo fmt --check` exit 0 /
`npm run typecheck:e2e` exit 0 / lint クリーン / `npm test` **2069 passed 0 failed**

### 残り

- **根2**（「登記の無傷が確認できるか」という述語で3箇所を揃える）— ブリーフ準備済み・未着手
- **根4**（gated E2E の実装・MCP の `chain_path` additive 化・dB 契約の CI 3経路）—
  Fable の設計書 `docs/design/628-gated-e2e-rack-design.md`（358行）承認済み・実装未着手
- **PR 本文の実機検証の記述は訂正済み**（配列記法・N段直列・`Gain` は実機未通過）

### 6.392 refactor: /simplify が 6 件を出し、うち 1 件は私自身の浅い修正だった (#628) (Aug 28, 2026)

**Date**: 2026-08-28
**Issue**: #628 / PR #639
**Status**: 6 件すべて適用

`/simplify` の 4 エージェント（Reuse / Simplification / Efficiency / Altitude）を並行起動。

## 🔴 根本原因: wire 型が daemon / child で二重定義されていた

**Reuse と Altitude が独立に同じ結論へ到達**した。実機で**同じ serde 欠陥が 2 回出た**のは、
同じ型を 2 箇所に書いていたため。ユニットテストは両側とも緑で、**各々が自分の型を自分で
テストしていた**ので wire を跨いだ実物だけが落ちていた。

`orbit-audio-sandbox::rack_wire` に集約した。この crate を選んだ理由:

- **daemon と child の両方が既に依存**している
- **clack-free**（コードは memmap2 のみ）なので daemon の不変条件を壊さない
- 🔴 **本 PR は既に `CMD_APPLY_CHAIN` 等の定数をここに置いていた** — JSON の型だけが
  その原則から外れていた

集約の結果、`StageSpec` / `PlanStage` / `SaveDropped` / `enabled_by_default` は**各 1 箇所**に。
`flatten` × `deny_unknown_fields` の併用は**全 crate で 0 件**。

**外側の容器は経路ごとに分けた**（統合しかけて型エラーで気づいた）:

| 経路 | 要素配列のフィールド名 | 契約 |
|---|---|---|
| TS → daemon（JSON-RPC） | **`chain`** | protocol doc に明記・変えられない |
| daemon → child（`.apply.json`） | **`stages`** | 内部 |

**別のワイヤなので容器は別型が正しい。** 要素型を共有すれば欠陥のクラスは塞がる。

**副作用**: `serde_json` が sandbox 経由で可視になり、`u64: PartialEq<serde_json::Value>` の
impl が増えて既存テストの型推論が曖昧になった（`orbit-clap-instrument-child`）。型注釈で解消。

## 🔴 私自身の浅い修正への指摘（Altitude）

コミット 7 で台帳テストに `dir.join(...)` の抽出パターンを足したが、これは
**決め打ちの対象を変えただけ**だった:

| 版 | 決め打ちの対象 | 破れ方 |
|---|---|---|
| 初版 | **綴り**（`orbit-*-child`） | リネームで漏れた |
| その次 | **分岐の形**（match アーム） | 分岐なしの child で漏れた |
| **私の修正** | **解決の形**（`dir.join`） | 次の新しい形でまた漏れる |

ファイル自身のコメントが「初版は綴りを決め打ちして取りこぼした」と警告しているのを
**読んだ上で**同型を書いていた。

daemon に **`SPAWNABLE_CHILD_BINARIES`** を置き、**真実源を 1 つ**にした。新しい child を
足す開発者は配列への追記を強制され、正規表現の網をすり抜けられない。台帳テストが守る性質も
「抽出が縮んでいないか」から「**定数と実装が乖離していないか**」へ入れ替えた。
**この新しいガードが導入直後に偽陽性を 1 件出し**（`exe_label` の fallback 文字列 —
存在しない crate 名）、spawn 文脈に絞った。

## RT 違反（Efficiency）

`AudioChain::process_block`（**audio スレッド**）に `eprintln!` が入っていた
— 確保 + stderr ロック + write syscall。**atomic カウンタ**へ置換し、ログ出力は main
スレッドが行う形にした。エラー時にしか起きないパスで、**テストで踏まないぶん緩みやすい**。

## 有界性の無効化（Efficiency）

補完プロバイダが**文書の先頭から全行を materialize**してから 50 行の後方スキャナを
呼んでいた。**自分で設計した有界性を呼び出し側で台無しにしていた** — 数千行のファイルで
`"` を打つたびに全行をコピーする。読む範囲だけ切り出す形に。

## `remove()` の死骸撤去（Simplification）

DSL 語彙からは消えていたが、**実装チェーン全体（TS 11 箇所 + Rust）が到達不能なまま
残っていた**。

🔴 **「到達不能」を実行で実証してから消した**（peer の助言 —「机上推論だけで確定させない」）:

| 確認 | 結果 |
|---|---|
| DSL からの到達 | **3 レシーバすべてで dispatch が拒否**（実行して確認） |
| MCP tool | **0 件** |
| Rust `unload_outproc_effect_plugin` | **定義と自分のユニットテスト 2 件からのみ** |
| daemon の `UnloadPlugin` | **常にエラーを返すスタブ** |

**テストの主張と spec の矛盾**も解消した。テストは「host compatibility method として維持」と
書いていたが**その host は存在せず**、spec SC.10.3c は「即時に撤去する」と定めている。
T25 を「**呼ばれない**」から「**存在しない**」へ格上げ — 前者は実装の存在を許すが後者は許さない。

## コピペの一本化

`sameCatalogSpec` / `sameCatalogElement` → `sameCatalogIdentity` /
3 manager に複製されていた脱糖 → `toRackRecipe`（`effect-slot.ts` は「manager の複製を
一本化する」ために作られたファイルなのに、新規追加分だけが逆行していた）。

## 検証

`npm run lint` exit 0 / `npm test` **2069 passed 0 failed** /
clippy exit 0 / `cargo fmt` clean / 該当 crate **326 passed 0 failed**
（sandbox は 83 → 86 で共有型のテスト 3 件が加算）。

### 6.391 test: 列挙13本が E2E の取り残しを出した (#628 コミット8) (Aug 28, 2026)

**Date**: 2026-08-28
**Issue**: #628
**Status**: 完了（列挙13本を実行・記録）

完了条件 §1-12 の**列挙コマンド13本を全実行**し、件数を記録した（PR 本文へ添付）。

🔴 **列挙は「最後の確認」ではなく発見の道具だった。** 11 番（`.ui(数値 index)` は 0 件で
あるべき）が **6 件**残っており、うち 4 件は **E2E が旧構文 `drum.ui(1)` を使ったまま**
だった。実機ゲートを 4 回回しても見つからなかったものが grep 1 本で出た。

名前形（`drum.ui("CLAP Test Effect")`）へ移行し、**6 件 → 2 件**。残る 2 件は
「**撤回した形が拒否されることを検証するテスト**」で、これは残すのが正しい —
機能を消すだけだと**黙って無視される形に劣化する**ため、拒否を明示的に固定している。

## 列挙13本の結果（コミット `4a08ecd6` 時点）

設計が「0 件であるべき」とした項目:

| # | 項目 | 期待 | 実測 |
|---|---|---|---|
| 6 | DSL 語彙の `remove` | 0 | **0** |
| 10 | メソッド形解決の残骸 | 診断用のみ | **1**（§3.5-(5) が残すとした誘導診断） |
| 11 | `.ui(数値)` | 0 | **6 → 2**（撤回形の拒否テストのみ） |
| 13 | 旧補完 regex | 0 | **0** |

その他: OutProcControl 10 / 旧 child 参照 150 / `--plugin` 21 / mailbox 定数 31 /
wire メソッド名 87 / `chain_path` 24 / state manifest 6（全て `project-state-store.ts` 内）/
`EffectSlotLimitError` 11 / 標準プラグイン 37。

## 実機ゲートの最終状態

**3 failed / 5 passed。#625 の R-E1〜R-E7 は全通過。**

残る 3 件は**すべて `UI_CLOSED_DONE` のタイムアウトに起因**し、**#633（UI pump の
per-index 化）の範囲**。Fable が設計調査で予告した欠陥が実機で再現したもので、
PR-B として設計（711 行）が完成している。

### 6.390 fix: 実機ゲートが 5 件の欠陥を出した (#628 コミット7) (Aug 28, 2026)

**Date**: 2026-08-28
**Issue**: #628
**Status**: #625 の R-E1〜R-E7 が実機で全通過（残る失敗は #633 の範囲）

**ユニットテスト 2069 件 + 348 件がすべて緑のまま、実機では動かなかった。**
実機 gated E2E を 11 回反復し、毎回 1 つ深く進みながら欠陥を剥がした。

## 検出・修正した欠陥（5 件）

**1. serde の `flatten` × `deny_unknown_fields`（daemon 側）**

```text
[MALFORMED_REQUEST] effect chain apply failed at index 0 (CLAP Test Effect):
invalid ApplyEffectChain chain: unknown field `enabled`; the previous chain is kept
```

`EffectChainPlanStage` に `deny_unknown_fields` が付いており、`Load` は
`#[serde(flatten)]` で内側を展開している。**serde はこの併用を支持しない** — 外側の
deserializer は内側のフィールド名を知らないため `kind` / `path` / `enabled` が軒並み
unknown field になる。**全 effect 宣言が失敗していた。**

**2. 同（child 側）** — daemon 側を直した直後に同型が出た:

```text
parse …/apply.json: unknown field `kind` at line 1 column 302
```

**同じ設計を 2 箇所に写したため**。全 crate を走査して残りが無いことを確認した
（`flatten` を含む型で `deny_unknown_fields` を持つものは他に 0 件）。

**3. 🔴 `orbit-effect-rack-child` が配布物に入っていなかった**

daemon は自分の隣の `orbit-effect-rack-child` を探す（`outproc_effect.rs:454`）が、
`copy-daemon-bin.sh` が配っていなかった。**実機で effect 宣言が起動に失敗する。**
コミット 1 で「同梱経路」を作ったとき、標準プラグインだけを足して **child 本体を
足さなかった**（列挙が一段手前で止まった形）。release.yml の post-package gate にも追加。

**4. PID オラクルが rack child に効かない** — 13 箇所を移行（詳細は 6.389）

**5. ERROR 件数の厳密等価** — `get_log` は固定 500 行の窓なので、非エラー行が 1 行増えると
古い ERROR が押し出されて**件数が減る**。判定の意図は「新しい ERROR を出していない」なので
13 箇所を `toBeLessThanOrEqual` へ。

## 意味論の変化に合わせて更新した E2E（#625 R-E1〜R-E7）

旧テストが期待していた挙動は、**#628 が解消しようとした挙動そのもの**だった:

| 旧（#625 in-place 型） | 新（#628 prepare-commit） |
|---|---|
| 差し替え = プロセス交換（旧 child が消える） | **PID 不変**（in-child 編集 = dry 窓が消えた） |
| 失敗 = dry へ縮退 | **旧チェーンが無傷で鳴り続ける** |
| `remove("名前")` で外す | **`effect([])`**（配列から消す・SC.10.3c） |

🔴 **音での実測が決定的だった**: 失敗後の RMS が B と **0.08% 差**で一致
（`failedDry=0.049822` / `B=0.049780`）。**旧チェーンが本当に鳴り続けている**証拠であり、
prepare-commit が音として機能していることの実機証明。

区間名 `failedDry` は「失敗したら dry になる」という**旧仕様を名前に埋め込んでいた**ため、
意味論変更でラベルが嘘になった。名前は仕様を固定する。

## 検証

| 回 | 結果 |
|---|---|
| 1 | 6 failed / 2 passed（effect 宣言が全滅） |
| 2-10 | 4 failed / 4 passed（毎回別の欠陥） |
| **11** | **3 failed / 5 passed（#625 R-E1〜R-E7 全通過）** |

残る 3 件のうち 2 件は **#633（UI pump per-index 化）**の範囲で、
Fable が設計調査で予告した「rack child の close が daemon の DONE 腕に受理されず ring が
詰まる」が**実機で予告どおり再現**した:

```text
timed out waiting for UI_CLOSED_DONE (20000ms)
```

clippy exit 0 / daemon 226 passed / rack child 14 passed（回帰テスト 4 件追加）。

### 6.389 feat: ラックを DSL から書けるようにする (#628 コミット5〜6) (Aug 28, 2026)

**Date**: 2026-08-28
**Issue**: #628
**Status**: 完了（TS 層 = Codex / 拡張 = main / 検証 = main）

`kick.effect(["A", Gain(db: -6)])` と書けるようになった。編集は LCS で対応づき、
**対応した要素は音を止めずに生き続ける**。

## TS 層（Codex・T1〜T28）

- **配列リテラルの汎用化**: `var x = [...]` の chord 確定パースをやめ、汎用配列 AST を保持する
  束縛へ。**chord か rack かの分類は interpreter が行う**。既存 chord テストは無変更 green
- **3 カテゴリ解決**: `"文字列"` = カタログ / **大文字呼び出し** `Gain(db:n)` = 標準（静的
  レジストリのみ・**カタログを引かない**）/ **小文字呼び出し** `layer(...)` = 構造。
  カテゴリが構文で先に決まるため、**標準とカタログの名前衝突は構造的に存在しない**
- **`applyRack` + LCS 差分**: 識別子トークンは**カテゴリ付き**（`catalog:` / `standard:`）で、
  カテゴリ違いの同名は決して対応しない。**diff が空でも `ApplyEffectChain` を必ず発行する**
  （TS で短絡すると #626 の解消が TS 層で潰れる）
- **occurrence はロード時に割り当てて以後不変**（テキスト位置から数え直さない）
- **撤去**: `remove()`（SC.10.3c）/ メソッド形カタログ解決（SC.10.9）/ `ui(数値 index)`
  （SC.10.10.1）。撤回した形は**loud に拒否**する（黙って無視しない）
- **`ui()` 名前形**: 一致する insert を**すべて**開く（T27）
- **instrument ラック**: `instrument(layer([...]))` をパース・型付けまで受理・
  **裸配列に複数 instrument = 明示エラー**（T17）・単要素は単発形と等価

## 拡張（main・コミット6）

- 🔴 **ラック対応の補完スキャナ**: 現行は単一行 regex（`.effect("` 直後限定）で、
  **ラック配列・複数行・`layer` 入れ子では発火しない = 移行と同時に退行する**。
  有界の後方スキャナ（既定 50 行）へ置き換え、role は外側の動詞が決める形にした。
  **旧 regex は撤去**（列挙13番が 0 件）
- **E2E の PID オラクル**: 後述

## 🔴 設計 §6 の見落としを 1 件手当て

**既存 E2E の PID オラクルが rack child に効かない。**

| | 旧 child | rack child |
|---|---|---|
| 起動 | `--plugin <絶対パス>` | **`--chain <manifest.json>`** |
| 観測 | `pgrep -f <pluginPath>` | **捕まらない**（manifest は一時ファイル） |

R28-E1〜E10 は**すべて「child PID 不変 = respawn していない」を判定条件にしている**ので、
**10 シナリオが揃って成立しなくなる**ところだった。設計 §6 は「既存ハーネスを再利用」と
書いていたが、機構 B（`--plugin` → `--chain`）がその前提を壊していた。

daemon の `spawn_effect_child` に `tracing::info!` で PID を名乗らせ、`get_log` から読む
経路を作った。**MCP の tool 表面は増やしていない**（ERROR 計数・`[plugin-state]` 行と
同じ経路に揃う）。

🔴 **`eprintln!` で書くと ERROR に分類され、同じ E2E が見る「ERROR 増 0」を自分で落とす**
（#618/#625 で 4 回再発した罠）。`tracing::info!` は ISO timestamp + level 形式なので TS 側
router が非エラーとして受理する — これをテストで固定した。

## 検証（main が sandbox 外で実行）

| 検証 | 結果 |
|---|---|
| `npm run lint` | exit 0 |
| `npm test` | **2069 passed / 0 failed / 44 skipped**（145 files） |
| ワークスペース clippy（`-D warnings`） | exit 0 |
| 該当 4 crate の lib テスト | **348 passed / 0 failed** |

🔴 **Codex は sandbox で socket テスト（43 件）が走らず、迂回せず報告して停止した。**
「Codex は sandbox で daemon protocol が原理的に走らない = だから検証は main」の分担どおりで、
**main が回したら全件 green** だった。

**passed が 2075 → 2069 に減っている**が、これは撤去された機能のテストが消えたため
（`remove()` -24 / `ui(数値)` -23 / メソッド形解決 -16 / 旧補完 regex -5）。いずれも設計が
「撤回する」と明記した機能で、**撤回した形が loud に拒否されるテストは残っている**ことを確認した。

## main が追加したテストと変異検証（4 種横断・全 RED）

| 対象 | テスト | 変異 |
|---|---|---|
| ラック補完スキャナ | 17 | 分岐反転 11 / 回数 1 / 引数 4 / 構成 2 件 red |
| PID 通知の分類 | 2 | 分岐反転 2 / **受理を緩める** 6 件 red |
| PID オラクルの解析 | 7 | 引数・順序・分岐反転 各 1 件 red |

**「緩める方向の変異」を混ぜた**のが要点 — 判定を厳しくする変異は簡単に red になるが、
`return true` のような緩和は「テストが通りやすくなる」ので、それを検出できるかが本当の強度。

E2E 本体は gated で普段走らないため、**ログ解析部分だけを切り出して常時テストする**構成に
した（R28-E1〜E10 が揃ってこの関数に依存するため）。

### 6.388 feat: effect rack の daemon 配線 (#628 コミット4) (Aug 28, 2026)

**Date**: 2026-08-28
**Issue**: #628
**Status**: 実装・D1〜D15 変異検証完了（sandbox 制約による integration / Linux cross check の環境停止あり）
**Branch**: `628-rack-impl`

`EffectSlotEntry` に control/watchdog 所有の `ChainConfig` を追加し、master / named bus 共通の
`apply_outproc_effect_chain` を実装した。健全な Active+diff は rack mailbox の
`CMD_APPLY_CHAIN`、rebuild・抜け殻 Active は #625 の teardown → `--chain` manifest spawn、
空 chain は teardown → Empty を通る。`bus_actives` の単調 true、shutdown latch、quiesce の
SeqCst ペアは維持した。

wire に `ApplyEffectChain` を追加し、effect の `ReplacePlugin` / `UnloadPlugin` を明示退役。
state/UI の `chain_path` を flat stage index として `CMD_SAVE_STATE_AT` / `CMD_OPEN_UI_AT` /
`CMD_CLOSE_UI_AT` へ渡し、standard stage と nested path を明示拒否する。watchdog は respawn
時点の権威 chain（per-stage latest state を含む）から manifest を毎回書き直す。

検証: 指定 clippy は warning 0。daemon 224 passed / 0 failed / 1 ignored、sandbox 83 passed、
rack child 12 passed / 3 ignored。D1〜D15 は各表の不変条件を production 側で一時的に壊して
全件 red、復元後 green を確認した。workspace `cargo test` の protocol integration 28 件は
sandbox が loopback bind を `Operation not permitted` で拒否して停止。Linux cross check は
`alsa-sys` が cross `pkg-config` sysroot 未設定で停止し、いずれも権限・環境回避は行っていない。

**main の検収（sandbox 外で実行）**:

| 検証 | 結果 |
|---|---|
| ワークスペース clippy（`-D warnings`） | exit 0 |
| 該当 4 crate の lib テスト | **348 passed / 0 failed**（daemon 224 / sandbox 83 / child-runtime 29 / rack child 12） |
| **D1〜D15 変異ログの実物検分** | **15 件すべてに `test result: FAILED. 0 passed; 1 failed` + panic トレース**。各変異が対応する 1 件だけを殺しており §5.2 の 1:1 対応どおり |

Codex は sandbox 制約（`tests/common/mod.rs:44` の loopback bind 拒否）に当たった際、
**迂回せず報告して止まった**。ブリーフの指示どおりで、これは「Codex は sandbox で
daemon protocol が原理的に走らない = だから検証は main」という分担の根拠そのもの。

🔴 **委譲の監視について**: Codex への発注中、**監視の設計が壊れていて 64 分間停止に
気づかなかった**（companion の自己申告 `status` は kill 後も `running` のまま残るため、
待機ループが永久に発火しない）。ログの mtime を生存signal にした `watch-codex.sh` を作成し、
以後は 7 分沈黙で通知される。詳細は memory `watch-liveness-not-self-reported-status`。
この監視は claude-tools へ横展開した（ISSUE #292 / PR #293・`/utils:watch-codex`）。

---

### 6.387b 🔴 コミット2〜3 に欠陥が見つかった — UI close が daemon に届かない (#628) (Aug 28, 2026)

**Date**: 2026-08-28
**Issue**: #628
**Status**: 検出・裏取り済み（修正は per-index pump 設計とセットで後続）

**6.387 で「検証済み」として確定させたコミット `12676814` に、実機で必ず踏む欠陥がある。**

- **child が送る**（`orbit-child-runtime/src/ui_service.rs:111-115`）:
  `{"index":0,"completion":"safepoint-completed"}`（rack 経路 = index あり）
- **daemon が受ける**（`orbit-audio-sandbox/src/transport.rs:1398-1409`）:
  `Some("safepoint-completed")` / `Some("timeout-without-save")` の**完全一致のみ**。
  それ以外は Protocol error

→ **rack child の UI を閉じると 1 枚目ですら Protocol error になり、event ring の先頭が
永久に詰まる。**

**なぜ全テストを通過したか**: child 側の多重化は unit で証明され、daemon 側の受理も unit で
証明されていて、**その 2 つを繋ぐ層だけが誰にも触られていなかった**。699 tests green・
clippy exit 0・変異 6 種 RED をすべて通っている。core spec の
「壊れるのは配線であり、配線は E2E でしか見えない」の実例がまた 1 つ増えた。

**発見経路**: Codex がコミット 4 の実装中に「設計が『自然対応』とする前提と現コードが
一致しない」と報告して停止 → Fable の per-index 設計調査が具体化 → main が実コードで裏取り。

**あわせて判明した 2 件**:

1. **TS が wire に `chain_path` を送っていない**（`packages/` の grep 0 件）。daemon 側は
   読んで省略時 0 に倒す（`session.rs:323-345`）ので、**index≠0 が黙って 0 に化ける**
2. 多重 close × timeout 放棄で **ring がデッドロックする**可能性（Fable の机上解析・
   確信度「中〜高」。実装冒頭に再現 fixture を書いて反証する手順つき）

---

### 6.387c design: `UiEventPump` を per-index 化する設計（owner 決定 A）(#628) (Aug 28, 2026)

**Date**: 2026-08-28
**Issue**: #628
**Status**: 設計完了（起案 = Fable / 実装は後続）
**成果物**: `docs/design/628-ui-pump-per-index-design.md`（619 行）

**問題**: child 側だけ多重ウィンドウ化され、daemon の `UiEventPump` は **child 単位の単一
`UiPumpState`** のまま（`generation` / `pending_safepoint` / `abandoned_safepoint` /
`lifecycle` が各 1 つ）。`begin_open` は `lifecycle != Closed` を loud に拒否するので、
**1 child につき UI 1 枚しか開けない**。

実装設計書 §3.1-(6) の「daemon の UI pump は instanceId キーなので**多重に自然対応する**」
という記述は誤りで、決定表 #12 で確信度「**高**」とされていた項目だった。

**owner 判断（2026-08-28）: 案 A（pump を per-index 化）を採用。** v1 を 1 枚に制限する案 B は
spec SC.10.10.1（`ui("名前")` = 一致するもの全部を開く）を後退させるため不採用。

**設計の要点**:

- **`generation` は child 単位のまま。** ring は child につき 1 本なので、per-index 化は
  「1 つの事実の N 重複製」で**今回の事故と同型の乖離可能状態**を作る。index は別次元で持つ
- **ack 照合キーは `(generation, index, evt_seq)` の三つ組。** seq 単独でも現状は足りるが、
  **その十分性が他所の実装詳細に依存する**ため index を照合へ加え、取り違えを loud にする
- **`lifecycle` と `abandoned_safepoint` は per-index map。** 単一 `Option` だと 2 件目の放棄が
  1 件目を上書きし、遅着 ack が誤拒否される
- **冪等 open は pump に置かない。** PH.2c は「DSL は冪等 / MCP は非冪等」を要求しており、
  経路の知識は TS 層が持つ
- **TS ↔ daemon の写像は TS session 簿記が open 時に確定して保持**（§3.4-(5) の instanceId
  キー化は撤回）。「open 中 UI の index 不変」を不変条件として導入する

**確認済み事実 20 件（F1-F20・全行番号つき）と未確認 3 件（U1-U3）を分離**して記述されている。
前回の穴が「検証していない前提を書いた」ことから生まれたため、起案時に
「確認した項目には行番号を、していない項目には未確認と明記」を条件として課した。
失敗モード↔テスト対応表は 24 行（全行に変異つき・4 種横断）。

**owner 確認事項が 1 件残っている**: 「open 中の UI がある stage より前を drop/insert すると、
その UI は保存つきで自動 close される（自動 re-open なし）」を v1 挙動として受容するか。

### 6.387 feat: 1 つの child が N プラグインを直列に回す (#628 コミット2〜3) (Aug 27, 2026)

**Date**: 2026-08-27
**Issue**: #628
**Status**: 完了（実装 = Codex / 検証 = main）

ラック実装の心臓部。**1 bus = 1 child = 1 プラグイン**だった構造を、**1 child が N プラグインを
直列に回す**形へ変える。これができるとチェーン編集が child の respawn を伴わなくなり、
#625 の差し替え dry 窓が消える。

**`transport.rs`（`orbit-audio-sandbox`）**:

- `SharedRegion` の**末尾**に `active_stage_index: AtomicU32` を追加（既存 field のオフセット不変）。
  crash 時に watchdog がこれを読んで「どの stage で落ちたか」を stderr に出せる
- mailbox 定数 `CMD_APPLY_CHAIN=4` / `CMD_SAVE_STATE_AT=5` / `CMD_OPEN_UI_AT=6` /
  `CMD_CLOSE_UI_AT=7`。既存 1〜3 は instrument child と共有のため**番号温存**

**新 crate `orbit-effect-rack-child`（2014 行）**:

- CLAP / VST3 の両ホストを 1 binary にリンクし、stage list を直列に走査する。
  format は **path の拡張子だけ**で判定（manifest に `format` という語を持たせない = CAP.6-1）
- `standard` stage は **自 exe の隣の `std-plugins/<name>.clap`**（`ORBIT_STD_PLUGIN_DIR` で
  上書き可）へ解決。実体が CLAP であることは child 内部の知識に閉じる
- stage list の差し替えは **generation 付き `AtomicPtr` の 1 回 swap**。旧リストは
  **retire スロット経由で main スレッドが破棄**する（プラグイン破棄を audio 側で走らせない）
- `CMD_APPLY_CHAIN` は **prepare-commit**: load を全部済ませてから block 境界で 1 回 swap。
  途中失敗は旧チェーン無傷で abort し、failed index と原因を返す
- `UiService` を **index → window の多重レジストリ**へ一般化（同一 child 内で複数ウィンドウ）。
  同 index への再 open は冪等 no-op（`ui()` は楽譜に残り再評価のたびに走るため必須）

🔴 **Linux CI の罠に正面から対処されている**: 3 つのホスト/ランタイム依存をすべて
`[target.'cfg(target_os = "macos")'.dependencies]` に置き、**macOS 限定の `orbit-vst3-host` が
Linux の依存グラフに入らない**ようにしてある。#622 と PR #632 で 2 回踏んだクラス。

## 委譲と検証の経緯（記録）

実装は Codex（`--effort xhigh`）に発注した。**Codex は検証の途中で外部から kill され、
報告を返さないまま消えた。** 変異検証はその手前で止まっていた。

🔴 **私の監視が壊れており、64 分気づかなかった。** companion の自己申告 `status` を見ていたが、
kill されると `"running"` のまま残る（stale）ため、`until status != running` のループは
**永久に発火しない**設計だった。owner 指摘を受けて `watch-codex.sh` を作成 —
**生存signal をログの mtime にし、7 分沈黙で通知**する。memory
`watch-liveness-not-self-reported-status` に保存。

死因の切り分け: 最後に走っていた `cargo test -p orbit-child-runtime -p orbit-clap-host
-p orbit-audio-sandbox` を私が回したら **exit 0・数秒**で完了。**ハングではなく外部 kill**
と確定した（「1 時間応答なし」を即ハングと断定しないこと）。

**成果物は使える状態だったので、検証を main が引き継いだ**（もともと検証は main の担当）。

## 検証（すべて main が sandbox 外で実行）

| 検証 | 結果 |
|---|---|
| ワークスペース clippy（`-D warnings`） | exit 0 |
| ワークスペース全テスト | **699 passed / 0 failed / 36 ignored** |
| rack child のテスト | 12 passed + `#[ignore]` 3 件（実機 `Gain.clap` 使用）も pass |
| Linux ターゲット確認 | rack child / sandbox / child-runtime **OK** |

`orbit-clap-host` の Linux クロスだけは `alsa-sys` のビルドで落ちるが、これは
`orbit-audio-native → cpal → alsa` という**通常の依存**が ALSA ヘッダを要求するためで、
本 PR とは無関係（Codex は `orbit-clap-host/Cargo.toml` を触っていない）。CI は Linux
ランナーで見る。

## 変異検証（main 実施・4 種横断・全 RED）

| # | C 行 | 種別 | 変異 | 捕捉したテスト |
|---|---|---|---|---|
| M1 | C1 | 順序入替 | stage 走査を逆順 | C1 / C9 / C11 の 3 件 |
| M2 | C4 | 分岐反転 | `enabled` 判定を反転 | C1 / C2 / C4 / C6 / C11 の 5 件 |
| M3 | C9 | 呼び出し削除 | `active_stage.store` を削除 | C9 |
| M4 | C10 | 引数差し替え | `save_state_at` を常に index 0 へ | C10 |
| M5 | C12 | 引数差し替え | `.clap` を VST3 ホストへ誤配線 | C12 |
| M6 | C13 | 分岐削除 | `ORBIT_STD_PLUGIN_DIR` の上書きを無視 | C13 |

restore は `cmp` で完全一致を確認し、変異なしで green 復帰も確認。
**`#[ignore]` の 3 件（C5 / C13 実物 / C14）は実機 `Gain.clap` で pass** — コミット 1 で作った
標準プラグインが rack の中で実際に動き、**param 名 `db` が DSL 契約どおり引ける**ことの証明。

## レビューへの申し送り

`AudioChain::adopt_at_block_boundary` に **audio スレッドでの `panic!`** がある
（retire スロットが未回収なら panic）。`apply` 経路は publish 前に必ず `collect_retired()` を
呼び、`has_pending()` と `pending_stage_drops` の二重ガードがあるので設計上は到達しないが、
**踏めば child が落ちて音が止まる**。RT パスに panic を置く判断はレビューで問う価値がある。

### 6.386 feat: 標準プラグイン `Gain` — 同梱 CLAP としての初号 (#628) (Aug 27, 2026)

**Date**: 2026-08-27
**Issue**: #628
**Status**: 完了（crate + bundle + アプリ同梱 + 出荷ゲート）

ラック実装（Stage 1）のコミット 1。**同梱経路が通っていないと後段が標準プラグインを解決
できない**ため、ここが先頭になる。

**設計上の位置づけ**（SC.10.8 / 設計 §2.5）: 標準プラグインは「engine に DSP を抱えない」
という確定原則に沿って、**普通の CLAP プラグイン**として作る。rack child から見れば
カタログのプラグインと同じ 1 stage であり、特別な処理経路を持たない。違いは 3 点だけ:
**アプリに同梱される** / **UI を持たない** / **state ファイルを持たない**。

**新規 crate `orbit-std-gain`**:

- CLAP effect（stereo in/out）。param は `db` の 1 本のみ。範囲 -96〜+24 dB、既定 0（素通し）
- 🔴 **CLAP param 名 = DSL の名前付き引数名**（SC.10.8 規範 5-6）。`Gain(db: -6)` の `db` が
  そのまま CLAP param `db` へ写る。破っても**型エラーにならず無言で効かなくなる**
- `gui` / `state` 拡張を**宣言しない**。これが daemon 側の「標準要素への UI open / state save は
  明示エラー」の根拠になる
- 下限 -96 dB は**完全な 0.0** に落とす（微小な残響が「無音にした」stage から漏れないように）
- 非有限値は乗算の手前で潰す（RT スレッドに NaN の判断を残さない）

**bundle と同梱**:

- `bundle-macos.sh` が cdylib を `.clap` bundle へ組む。**plugin 名は手打ちせず `lib.rs` の
  定数から読み出す**（片方だけ直し忘れる形を作らない）
- `scripts/copy-daemon-bin.sh` が `std-plugins/Gain.clap` を **child 実行ファイルの隣**へ配置。
  child が `std-plugins/<name>.clap` で解決するため、置くだけで配線は不要。
  bundle はディレクトリなので #540 の code-signing キャッシュ問題を避けて毎回作り直す
- 🔴 **release.yml の post-package gate にも追加した**。packaging スクリプトのヘッダが述べる
  とおり、出荷物を実際に保証しているのはこの gate である。**同梱が落ちても
  ビルドもテストも緑のまま**で、DSL の `Gain(db: …)` が実行時に解決できずに落ちるだけなので、
  gate を足さずに packaging だけ足すのは「一段手前で列挙を止める」形になる

**検証**:

- ユニット 8 件 + contract 4 件 = **12 件 green**
- 🔴 **contract テストは in-process でプラグインを起こす**（`load_from_clack`）。dylib を
  dlopen しないのでビルド順に依存せず、`#[ignore]` も要らない
- **実ローダーでの確認**: `orbit-plugin-scan probe-artifact` が bundle を読み、
  `name: "Gain"` / `category: clap.plugin` / `audio-effect|utility|stereo` を返す。
  **`nm` で `clap_entry` が見えることはロードできる証明にならない**ので、
  ビルド直後と**同梱先の両方**で実ローダーに通した
- `cargo clippy --all-targets --features outproc-effect,outproc-instrument -- -D warnings`
  をワークスペース全体で green。Linux ターゲットは `-p orbit-std-gain` で green
  （ワークスペース全体の Linux クロスは `alsa-sys` がホストに ALSA ヘッダを要求するため
  ローカルでは不可。CI が Linux ランナーで見る）

**変異検証（壊し方 4 種を横断）**:

| 変異 | 結果 |
|---|---|
| (a) 分岐反転: 無音フロアの判定 `<=` → `<` | `the_floor_is_exact_silence_not_merely_quiet` **red** |
| (b) 引数差し替え: param 名 `db` → `gain` | ユニット + contract の**両方** red |
| (c) 呼び出し回数: params の `count` 1 → 2 | `the_only_param_is_named_exactly_as_the_dsl_argument` **red** |
| (d) 構成変更: `PluginGui` を登録 | **コンパイルエラー**（`PluginGuiImpl` 未実装）= 型が捕まえた |
| (e) 構成変更: 最小 GUI 実装を書いて登録 | `declares_neither_ui_nor_state` **red** |

🔴 **(b) が最初は contract テストを red にしなかった。** `info.name` を定数
`PARAM_DB_NAME` と比べていたため、**定数を書き換えると両辺が一緒に動いて緑のまま通る**
トートロジーだった。リテラル `b"db"` との比較を足して修正し、再実行で両方 red を確認。
(d) は型が先に捕まえたためテストが実行されず、テストが空回りしていないことを (e) で別途確認した。

restore 後は `cmp` でバックアップとの完全一致を確認し、全 12 件の green 復帰も確認済み。

### 6.385 spec: 実装より先に spec を #628 の到達点へ揃える（Stage 0）(Aug 27, 2026)

**Date**: 2026-08-27
**Issue**: #628
**Status**: 完了（設計書 §3.8 の 5 点すべて）

ラック形チェーンの実装（#628 Stage 1）に着手する前に、**設計書の完了条件 §1-9 が要求する
「spec 更新が実装より先」**を満たす工程。PR #632 は SC.10 の制定と core spec への移行注記
までで、**§3.8 が挙げる 5 点は手つかずで残っていた**。

🔴 **着手時に実ファイルで現況を照合したところ、PR #632 の本文が「core spec の誤りを訂正」と
宣言していた当の文が未訂正で残っていた** — PH.2b の「チェーンは将来拡張（エンジン内部は
順序付きリストで実装済み・DSL 側のガード解放のみ）」。宣言と実体のずれであり、grep 一発で
照合できる形だった。この文を信じて #522 を見積もると誤る（順序付きリストを持っていたのは
**TS 側の帳簿だけ**で長さは常に 1、daemon は 1 bus = 1 child なので**ガードを外しても
複数 insert は持てない**）。

**変更内容**（§3.8 の項番に対応）:

1. `INSTRUCTION_ORBITSCORE_DSL.md` PH.2 / PH.2b — 「チェーンは将来拡張」を SC.10 のラック形へ
   訂正。PH.2b には**何が誤りだったかを明示した訂正注記**を残した（同じ誤解を再生産しないため）。
   PH.2d に SC.10 の要点（後勝ち・LCS・削除は配列から・`enabled` は単位元・ラックは値・
   標準プラグイン）を要約として追加し、旧記述は「#625 時点の記述」として区切った。
2. 同 PH.2c — `ui([index][, open])` を **SC.10.10.1 の名前形**（無引数 = instrument /
   文字列 = 一致する insert をすべて開く）へ書き換え。主経路が Cmd+Click であること、
   DSL に残す理由が **LLM から駆動できること**である点も明記。PC.3 にラック配列内・
   複数行・`layer` 入れ子での補完発火（SC.10.10 規範 1）を追記。
3. `SIGNAL_CHAIN_DSL_SPEC_v1.md` SC.5 — **effect チェーンの編集が (i) prepare-commit 型へ
   昇格**し、**差し替えの dry 窓が消える**ことを明記。(ii) in-place 型が残るのは
   「チェーン → 空」の teardown・stream 停止・crash respawn の 3 経路だけ。`remove()` が
   #628 で撤去されたことへの相互参照も付けた。
4. `ENGINE_DAEMON_PROTOCOL.md` — **`ApplyEffectChain` を新設**（目標状態の全体を 1 コマンドで
   運ぶ・`keep`/`load` op・`catalog`/`standard`/`layer` の kind・`save_dropped`・
   `mode: diff|rebuild`）。`ReplacePlugin(role="effect")` と `UnloadPlugin` に**退役注記**。
   `GetPluginState` ほかに **`chain_path`（0 始まりの整数配列）** を追加。MCP
   `open_plugin_ui` も index から `chain_path` へ改めることを §8 に記載。
5. 同 core spec の plugin 経路 note-off 規定 — **instrument ブランチの無効化・削除**を強制
   note-off の発火ケースとして追記。**仕様の追記のみで runtime 実装は Stage 2**（#606 が作る
   flush 機構を発火点から呼ぶ・note-off 配送機構を二重に作らない）。

**副次的な注意**: 訂正注記に旧構文のリテラルをそのまま書くと、完了条件 §1-12 の列挙コマンド
（`.ui(` の数値形が 0 件であること）が**自分の注記に引っかかって偽陽性を出す**。リテラルを
含まない書き方へ直した。列挙で完全性を担保する設計では、**説明文もその列挙の対象になる**。

**検証**: 未完了を発見したときと同じ grep を再実行し、5 点すべてが解消したことを確認。
実装側に残る `.ui(数値)` は engine/src 3 件・tests 13 件で、これは Stage 1 のコミット 5 で処置する。

### 6.384 fix: spike テストが Linux で壊れていた（#622 と同じクラスを踏んだ）(Aug 27, 2026)

**Date**: 2026-08-27
**Issue**: #628
**Status**: 修正済み（Linux ターゲットで実測確認）

PR #632 の CI が `Clippy (default features)` で落ちた。原因は **main が足した Spike S のテスト**。

`orbit-vst3-host` は **crate 全体が `#![cfg(target_os = "macos")]`** なので、Linux では中身が
空になり `Vst3EffectProcessor` が解決できない。テストに同じ cfg を付けていなかった。

🔴 **#622 で直したのとまったく同じクラス**（child crate の cfg 不整合）である。しかも #622 の
修正時に「**macOS だけで検証しない**」を教訓として記録していたのに、**同じ日に同じ形で踏んだ**。

直接の原因は明確で、**`-p orbit-vst3-host` の単体テストだけを回して、default features の
ワークスペース全体（= CI が回す形）を確認しなかった**こと。

修正後は **Linux ターゲットで実測**してから push した（`cargo check --target
x86_64-unknown-linux-gnu --all-targets -p orbit-vst3-host`）。

### 6.383 spec+design: `ui()` を名前形で残し、設計を確定 (#628) (Aug 27, 2026)

**Date**: 2026-08-27
**Issue**: #628
**Status**: **owner 確認 0 件** — 設計完成（1109 行・失敗モード 62 件・決定 20 項目・完了条件 15）

#### `ui()` の決着（SC.10.10.1）

owner 判断: **残す。しかも effect でも使えるようにする**（理由: LLM は Cmd+Click できないので、
「instrument だけ DSL から開ける」形は LLM から見て実害になる）。

```js
cb.ui()                       // instrument
cb.ui("ValhallaRoom")         // 名前が一致する insert すべて
cb.ui("ValhallaRoom", false)  // 閉じる
```

🔴 **同名が複数あっても曖昧にならない — 選ばずに全部開くため。** #617 の設計方針
「複数同時オープンを制限しない」と一致し、**出現順を DSL 表面に出さずに済む**
（index 形は撤回のまま・Cmd+Click が主経路）。

#### 🔴 決定の含意を Fable が発見（誰も見ていなかった）

「一致するものを全部開く」は、`[A, A]` の同名 2 件で **同一 child 内に 2 枚同時**を意味する。
ところが現行は **child あたり 1 枚**（`ui_service.rs:91` が `window: Option<Box<dyn WindowHandle>>`・
main が実コードで確認）。

対処: 多重レジストリ（`HashMap<index, WindowHandle>`）へ改め、(a) 同 index への再 open は
**冪等 no-op**（`ui()` は楽譜に残り再評価のたびに走るため・PH.2c の「open は冪等」を継承）、
(b) child→host の close イベントに **index を積む**（event ring の型は変えず既存 arg を使う）。
失敗モード C15 を追加。

**名前 → path の解決は TS 側**（daemon に名前照合を持ち込まない — LCS を daemon に複製しない
決定 8 と同じ向き）。0 件一致は宣言中の insert 名を列挙する loud エラー、標準プラグイン名は
「standard plugins have no UI」。

#### Spike S を §9-1 へ反映

「実測済み・成立・縮退不要」。副次的に **§9-2（mailbox 占有）の確信度が中 → 中〜高**へ上がった
— ホスト機構のオーバーヘッドは 80µs で無視できる規模なので、占有時間は**実質プラグイン自身の
初期化時間の総和**と分かったため。重いプラグインで秒単位の可能性は残るので、timeout 確認と
2 段応答化のフォールバックは残置。

#### 列挙コマンドの誤検出対策

`ui(` の残骸検出を **`grep -rnE "\.ui\(\s*[0-9]"`（数値限定）**へ。名前形 `.ui("…")` と
無引数 `.ui()` に掛からず、**index 形の残骸だけを 0 件確認できる**。

### 6.382 spike: 設計の核心の前提を実測で確認（Spike S・#628）(Aug 27, 2026)

**Date**: 2026-08-27
**Issue**: #628
**Status**: **成功** — 縮退案は不要

設計書 §9-1 が「確信度: 中」として spike を指定していた前提を実測した。

#### 何を測ったか

ラック設計の中核は「**新インスタンスを side で構築している間、旧 stage list は audio スレッドで
処理を続ける = 音が途切れない**」である。これが成り立てば **#625 の dry 窓が消える**。

🔴 **この codebase には実績が無かった。** 現行 child は 1 インスタンス固定で、プラグインを
load するのは **READY を publish する前**（audio がまだ回っていない時）だけだったため。

#### 結果

```
[spike] worker is running (56 blocks). loading second instance now…
[spike] second load ok=true took=79.208µs
[spike] blocks before=56 after=682 (delta=626) faulted=false
```

| 観測 | 意味 |
|---|---|
| `ok=true` | audio 処理中に、同一プロセスで 2 つ目を load **できた** |
| `took=79.2µs` | load は **80 マイクロ秒**。1 ブロック（512 sample @48kHz ≒ **10.7ms**）よりはるかに短い |
| `delta=626` / `faulted=false` | 1 つ目は**止まらず、出力も壊れなかった**（毎ブロック sample-exact 素通しを検証） |

**縮退案（APPLY の load 中だけ audio を bypass）は不要**と判断できる。

#### 測定の限界（正直に）

- 測ったのは **GainOracle**（`out = gain * in` の最小プラグイン）。Kontakt のような重いプラグインの
  load は秒単位かかり得る。**「load が処理を壊さないか」を測ったのであって「load が速いか」ではない**
- **VST3 のみ**。CLAP は未測定（ただし CLAP の方が初期化は軽いので、厳しい方で通ったことになる）
- **1 回の実測**。タイミング依存は繰り返しでしか出ないので、Stage 1 では繰り返し実行を入れる価値がある

spike は `rust/crates/orbit-vst3-host/tests/spike_s_concurrent_load.rs` に **`#[ignore]` 付きで
残す**（通常のテストを壊さない）。前提が将来崩れた時に同じテストで再確認できる。

#### 設計の §10-1（`seq.ui()` の存廃）が確定待ち

Fable が帰属の誤りを訂正した（「再評価で開き直る」は #617 の動機ではなく、テキストに残ることの
**副次的性質**）。判断材料:

| | `cb.ui()` | Cmd+Click |
|---|---|---|
| #617 に明記の動機 2 点 | ✅ | ✅ **より直接的** |
| 再評価で開き直る | ✅ | ❌ |
| ラックの入れ子を指せる | ❌ | ✅ |
| LLM から使える | ✅ | ❌（MCP 経路のみ） |

Fable の推奨は**無引数 `cb.ui()` のみ存置**（instrument 専用・引数全廃）。owner 判断待ち。

### 6.381 spec: 標準プラグインを言語の語彙として分離し、カタログはメソッド形を撤回 (#628) (Aug 27, 2026)

**Date**: 2026-08-27
**Issue**: #628
**Status**: 仕様確定（SC.10.8 / 10.9 / 10.10 を追加・SC.10.7 は欠番）

owner 確認 3 件の議論から、**設計の前提が 1 つ変わった**。

#### 🔴 3 つのカテゴリが構文で分かれる

```js
kick.effect([
  "ValhallaRoom",        // 文字列        = カタログのプラグイン
  Gain(db: -10),         // 大文字呼び出し = 標準プラグイン
  layer([...]),          // 小文字呼び出し = 構造
])
```

きっかけは owner の指摘「**標準プラグインはメソッドに見えるようにすれば、プラグインとぶつからない
のでは**」。main は**標準プラグインもカタログの住人**だと暗黙に仮定しており、その前提を外すと
問題の形が変わった。

帰結:

- **接頭辞が不要**になった（`OrbsGain` → `Gain`）。カテゴリが違うので衝突しない
- 3rd-party の "Gain" は `"Gain"` と書けば取れる — **逃げ道が `vendor:` ではなく普通の書き方**
- 「標準が勝つ」規則が**常時発火する**という main の懸念は、そもそも競合しないので消えた

#### 標準プラグインは UI も state も持たない

パラメータを DSL に直接書くので、**保存すべき隠れた状態が無い**。差分では「パラメータ更新」の
対象で、state の保存・復元の対象外になる（設計が一段軽くなる）。

そして**最初から LLM が操作できる面**になる。3rd-party は UI で作った音が state に入るので
人間の領分 — 役割が分かれる（`mem:human-knobs-vs-llm-dsl-params`）。

#### 形式は CLAP

🔴 **main のライセンス主張は誤りだった。** 「VST3 は GPLv3 か Steinberg との独自契約」と
断定したが、owner の指摘で調べ直したところ **2025-10（VST 3.8）に MIT へ再ライセンス**されて
いた。ライセンス上の差は無い。

CLAP を採った理由は (a) 実装が軽い（C ABI・COM 風の参照カウント不要）— 標準プラグインは
**群として増える**予定なので効く、(b) **owner の指摘**「標準が CLAP なら、手持ち（VST3 中心）と
**混在チェーンが日常的に発生する**」= 機構の核心が通常使用で常に検証される。

#### カタログのメソッド形を撤回（SC.10.9）

実名は正規化すると見た目が変わり（`"FabFilter Pro-Q 3"` → `FabFilterProQ3`）、元の名前で
検索できない。さらに**残すと標準とカタログが同じ見た目になり**、カテゴリ分けが崩れる。
環境を移した時に壊れるのは**カタログ側だけ**なので、この区別には実用上の意味がある。

#### UI は Cmd+Click（SC.10.10）

ラックは入れ子になるので 1 次元の index では指せない。エディタは構文木の位置を知っているので
**書き手が数えなくてよい**。**PH.2c の `ui([index])` の index 表面は撤回**。MCP 経路は維持
（LLM は Cmd+Click できない）。

#### 補完は既に大半が実装済みだった

`plugin-catalog-reader.ts` / `plugin-catalog-completion.ts` が実在し、owner の過去の要求
（2026-07-17「文字列の中で打ち続けても絞り込まれること」）まで入っていた。ただし検出条件が
**`.effect("` の直後**に限定されているため、**ラック形にすると効かなくなる = 退行**する。
Stage 1 に含める。

#### 実装の分担（owner 承認 2026-08-27）

> **PR は 1 本のまま。Codex への発注は 3 つに割る。**

| 発注 | 内容 | 担当 |
|---|---|---|
| 1 | TS 層（LCS 差分・出現順のインスタンス固定・ラック値・パーサの 3 カテゴリ） | Codex |
| 2 | Rust 層（rack child・`CMD_APPLY_CHAIN`・daemon・shm） | Codex |
| 3 | 標準プラグイン基盤 + `Gain` + 補完 + Cmd+Click | **main**（同梱・エディタ挙動は sandbox で検証できない） |
| — | Spike S・E2E・変異検証・実機ゲート | **main** |

**Fable は実装に使わない**（自分の設計を自分で実装すると監査の独立性が消える）。
根拠: このセッションで実害を出した欠陥は**すべて「実行してみないと分からない」類**で、
Codex は sandbox で実機 E2E が原理的に走らない。実装者を替えても解決しないため、
既存の分担（Codex が書く → main が sandbox 外で検証）をそのまま使う。

### 6.380 design: ラックチェーンの実装設計（#628・Fable 起案 / main チェック）(Aug 27, 2026)

**Date**: 2026-08-27
**Issue**: #628 / #522
**Status**: 設計完了・**owner 確認 3 件が Stage 0 のゲート**

`docs/design/628-rack-chain-implementation-design.md`（880 行・失敗モード ↔ テスト 1:1 対応表 49 件）。

#### 🔴 機構を変えると、副産物として dry 窓が消える

#625 の「差し替え中は dry 素通し」は、**1 child = 1 プラグイン = プラグイン交換がプロセス交換**
だから存在した。rack child（1 child が N プラグイン）では**プロセスが生き残る**ので、
編集経路の失敗モデルは **(ii) in-place 型から (i) prepare-commit 型へ昇格**し、**窓自体が消える**。
失敗しても旧チェーンが無傷で鳴り続ける。E2E oracle も「編集で child PID 不変」
「失敗注入で RMS が編集前のまま」という強い形になる。

#### main のブリーフ指示が却下された（正当な理由つき）

main は「`LoadPlugin`/`ReplacePlugin`/`UnloadPlugin` を index 単位へ一般化」と指示したが、
Fable は per-index の逐次コマンド列を却下し **1 評価 = 1 `ApplyEffectChain`（keep/load/drop の
plan を運ぶ）** にした。理由: **逐次列は途中失敗で「半分だけ編集されたチェーン」を確定させ**、
index シフトの暗黙規約も生む。#625 で失敗モデルの複雑さに苦しんだ直後なので妥当と判断した。

#### #626 の扱いが「受容」から「条件付き受容」へ

1 child が N プラグインを持つと 1 つ落ちればチェーン全体が落ちる。これを受容するが、
**受容できるのは「同じ行の再評価 = 必ず復旧」を保証する場合のみ**と条件付けた。実体は 2 点:
(a) TS は**空 diff でも必ず** ApplyEffectChain を発行する（短絡すると復旧が TS 層で潰れる）、
(b) daemon は Active slot の child 健全性を検分し、抜け殻なら同一コマンド内で rebuild へ倒す。

**結果として #626 の effect 側は本設計が解消する**（完了条件 10）。instrument 側は issue に残る。

#### 段階は大きく取り、完了条件で締めた

owner 方針「保守的にならずに一気に実装が進むように。PR ごとにレビューの時間がかかるので」を
受け、**Stage 1 = 直列ラック一式を 1 PR**（shm + rack child + daemon + wire + parser + 診断 +
E2E + 旧 child 退役）とした。境界は「PDC を要するか」だけ。

代償として **完了条件 12「列挙コマンド一覧（9 本の grep）を実行し、コマンドと件数を PR 本文に
記録してからレビューを呼ぶ」**を固定。**#629 の列挙漏れ 3 回（うち 1 回はレビュー 5 体を通過し
CI だけが検出）への直接の対策**である。

#### main が裏を取った実測

- `orbit-plugin-scan` は `orbit-clap-host` と `orbit-vst3-host` を**両方リンクした 1 binary**
  （両ホスト同居の前例が実在する）
- `manifest.states[]` の読み書きは `project-state-store.ts` の **2 箇所だけ**（122 / 234 行）
- 拡張の診断は `diagnostics-analysis.ts` の**正規表現ヒューリスティック**（エンジンパーサと別実装）

#### 🔴 owner 確認 3 件（確認まで当該部分を実装しない）

1. **`effect("B")` を「ラック `[B]` と等価 = 完全な像」とするか**。帰結として
   `effect([A1,A2])` の後の `effect("B")` は A1,A2 を消す
2. **`remove()` の撤去方法** — 即削除か、1 サイクルの移行エラーか（推奨は後者）
3. **`gain` のみのラック**（`[gain(db:-6)]`）を v1 staged エラーにするか

DSL 表面なので、#625 の教訓（spec を根拠に自己完結しない）に従い owner 確認を必須にしている。

### 6.379 spec: ラック形エフェクトチェーンを SC.10 として制定 (#628) (Aug 27, 2026)

**Date**: 2026-08-27
**Issue**: #628 / #522
**Status**: 仕様確定（実装設計は別途 Fable 起案中）

owner との設計議論で、**削除・バイパス・チェーンを 1 つのモデル**として確定させた。
「これらはセットで考えるべき」（owner）という指摘が起点で、DAW を調べると実際に
**1 つのスロット状態モデル**として設計されていた。

参照 DAW は **Bitwig と Live**（owner 指定・どちらも insert 数が無制限）。

#### 確定した DSL

```js
kick.effect([
  "FabFilter Pro-C 2",
  plugin("FabFilter Pro-Q 3", enabled: false),
  layer([[], ["ValhallaRoom", gain(db: -10)]]),
  "FabFilter Pro-L 2",
])
```

`[...]` = 直列（どこでも同じ意味）/ `layer([...])` = 並列（effect・instrument 共通）/
`"名前"` = プラグインの糖衣 / `gain(db:)` = チェーンの要素 /
`enabled: false` = **その合成の単位元**（直列 = 素通し・並列 = 無音）。

- **削除は配列から消す**。`remove()` は撤回
- **後勝ち**。生き残りは **LCS**、**出現順はインスタンスに固定**（テキストから数え直さない）
- **ラックは値（レシピ）**。宣言だけではプラグインを起こさない
- 機構は **B**（1 child が N プラグイン・Bitwig の Together 相当）
- `layer` の実装は **PDC とセットで後続**（記法は今回確定）

#### 🔴 リサーチで決定的だった発見

**Live と Bitwig で「オフ」の意味が違う。** Live はデバイスをオフにしても
**メモリとレイテンシが残る**が、Bitwig の deactivate は **CPU・メモリ・レイテンシをすべて
解放**しつつ設定を保持する。

そして **OrbitScore は #625 で既に Bitwig の deactivate を実装していた**
（差し替え・削除の直前に state を自動保存し、同じ spec の再宣言で復元）。
**足りないのは機構ではなく語彙だった。**

#### 🔴 core spec の誤りを訂正

「チェーンは将来拡張（エンジン内部は順序付きリストで実装済み・DSL 側のガード解放のみ）」
— 順序付きリストが実装済みなのは **TS 側の帳簿だけ**で、daemon は 1 bus 1 child。
**ガードを外しても持てない。** #522 に着手する人がこれを信じると見積もりを誤る。

#### 議論で main の主張が覆った箇所

設計の質はここに出るので記録した（詳細は `docs/design/628-effect-chain-model.md` §7）:

| 当初の立場 | 覆した根拠 |
|---|---|
| 「宣言的モデルは危険」 | owner の**配列案**が「宣言が散らばる」前提を外した。UI が無い環境では隠れた蓄積の方が危険 |
| 「文字列形の方が短い」 | **実名で数えたら逆**（`FabFilterProQ3` 14 < `"FabFilter Pro-Q 3"` 19）。思い込み |
| 「木にすると同一性が足りない」 | **原因は木ではなく複数 insert**。平坦でも `[A,B,A]` から 1 つ消せば起きる |
| 「`as:` で明示キーを付ける」 | owner「名前が増えるのが辛い」→ **LCS + 出現順のインスタンス固定**で構文追加ゼロ |
| 「`selector` を兄弟として見込む」 | owner「有効無効で足りるのでは」→ **`enabled:` が A/B を包含**し「両方」「どちらも無し」も書ける |

逆に main が反対を通した箇所: **`vst("名前")` / `clap("名前")`**（CAP.6-1「プラグイン形式は
利用者に見えてはならない」・#552 で払ったコストを表面で無効化する）と、
**言語グローバルの `alias`**（楽譜がその人だけのものになり、共通語彙という目的に反する）。

#### 派生 issue

- **#630** — import の実機 E2E がゼロ（ユニット 22 件・E2E 0 件）
- **#631** — ユーザー定義エイリアスを import で配る（#630 がブロッカー）

### 6.378 fix: CI へ足した `--ignored` が実機依存テストを起こしていた (Aug 27, 2026)

**Date**: 2026-08-27
**Issue**: #622 / PR #629
**Status**: CI 修正後 `--lib -- --ignored` で **1 passed**（95.01s）

6.377 で「`#[ignore]` テストが CI で走らない」を直すために足したステップが、**CI を落とした**。

#### 何が起きたか

落ちたのは私が足した 95 秒テストでは**ない**（それは CI でも 95.00s / pass）。落ちたのは
`capture_realtime_gated.rs` の `examples22_realtime_capture_matches_schedule` — **実機オーディオ
デバイスを要する gated テスト**である。`-- --ignored` が、通常 skip されているそれらを
**まとめて起動した**。

#### 🔴 列挙漏れを、また同じ PR の中でやった

fix 再点検（サブエージェント）は「crate 内の `#[ignore]` は 3 箇所のみ（`link_audio.rs` 2 /
`engine_wrap.rs` 1）」と列挙し、安全と判定した。**その列挙は `src/` しか見ておらず、`tests/`
ディレクトリの統合テストを数えていなかった。** main はそれを検証せずに CI へ出した。

実際に数えると **`tests/*_gated.rs` に 28 件**あり、すべて「実機デバイス / 実プラグイン /
特定 env が要る」ものだった。

#### 構造（これが罠の本体）

**`#[ignore]` は「遅い」印と「実機が要る」印の両方に使われており、`--ignored` はその区別を
しない。** したがって「遅いテストを CI で回したい」という要求に `--ignored` で応えると、
必ず実機依存テストを巻き込む。

#### 修正

ステップに **`--lib` を足した**（lib のユニットテストだけを対象にする）。手元での実走も
最初からその形だったので、**CI ステップだけが実走と違う形になっていた**のが直接の原因。

#### 教訓

- **委譲先の列挙を鵜呑みにしない。** 「N 箇所しかない」は、どの範囲を見た N かを確認する
- **手元で実走した形と、CI に書く形を一致させる。** 手元は `--lib` 付き、CI は無しだった

### 6.377 fix: PR #629 レビュー ラウンド1 の指摘を方針として一括適用 (Aug 27, 2026)

**Date**: 2026-08-27
**Issue**: #622 / PR #629
**Status**: daemon lib **208 passed / 0 failed / 1 ignored**（`#[ignore]` も実走 95.00s で pass）

owner の「レビューしないでマージして大丈夫ですか？」で手順違反に気づき、`/code:pr-review-team`
ラウンド1（フル編成 4 名）+ **Fable 監査を並行**で回した。**Critical 2 / Important 3 / Minor 5**。

#### 🔴 3 者が独立に一致した誤り — キャッシュライン分離の虚偽

6.376 で「false sharing の懸念 → フィールドを struct 末尾へ」と記録したが、**`repr(Rust)` は
宣言順とメモリ配置順を保証しない**。comment-analyzer・Fable・code-reviewer が独立に指摘し、
**code-reviewer が `offset_of!` で実測**して決着した:

- `child_early_exit`（Mutex 込み・size 48）は **offset 0**（struct の先頭）
- RT が毎コールバック触る `fresh` は offset 48
- → **両方とも最初の 64 バイトに同居**しており、意図した分離は成立していなかった

しかも 🔴 命令形で 3 箇所に書いていたので、将来「対処済み」という誤った前提で読まれる形だった。
**`#[repr(C)]` は足さず、保証の記述を撤回**した（元の懸念自体が推測ベースで、非ホットパスと
確認済みのため）。

#### 🔴 型で封じたのに、封じられていることを誰も検証していなかった

pr-test-analyzer の指摘: `ChildEarlyExit` は「片方だけ動かす退行を表現不能にする」ために
新設したのに、**その不能性を検証するテストが無い**。既存の attach テストは試行が 1 回なので、
`arm_for_new_attempt()` を「フラグだけ倒す」に退行させても検出できない。

**実測で裏付けた**: 同じ変異に対し **旧テスト = 2 passed（素通り）/ 新テスト = red**。
指摘は「もっともらしい」ではなく事実だった。

#### 🔴 列挙の打ち切り（Fable・非重複）

`Command::new("sleep").arg("30")` が**テストコードに 7 箇所**残っていた
（`engine_wrap.rs` 3 / `outproc_effect.rs` 2 / `outproc_instrument.rs` 2）。いずれも
「殺されるまで生きる stub」= `slow-child.sh` と同じ契約で、**新スキャナの検出圏外**。

> WORK_LOG の「固定秒数を書ける場所を無くした」は fixture ディレクトリに限れば真、
> **テストコード全体では偽**（Fable）

main が自分で grep して 7 箇所を確認（`0.2` × 4 と `2` × 1 は「即死が役目」で別クラス）。

#### 適用した方針

> **① 書ける場所を 1 つに絞る。検出器を賢くしない。** `outproc_stub_child` に唯一の生成経路を
> 置き 7 箇所を移した。**秒数を渡す口が無い**。`perl -e 'sleep 20'` まで正規表現で潰す方向へは
> 行かない — 書ける場所が 1 つなら検出は単純でよい。
>
> **② 宣言と実体を一致させる。** 走査を**再帰化**し（`lib/` が盲点だった）、件数を `>= 2` から
> **`== 4` の厳密一致**へ。
>
> **③ 保証できないことを保証と書かない。** キャッシュライン主張を撤回。スレッド分担も
> 「control 側も**書き手**」と実際の呼び出しに合わせた。
>
> **④ 型で封じたなら、封じられていることをテストする。**

#### 変異検証（すべて実測）

| 変異 | 結果 |
|---|---|
| `arm_for_new_attempt` が理由を倒さない | 新テスト red / **旧テストは素通り** |
| 共有スニペット自身に `exec sleep 30` を足す | 再帰走査が**名指しで** red（旧走査は素通り） |
| `FAST_RESPAWN_THRESHOLD` 2s → 3s | `supervisor_resets_fast_fail_streak_after_a_survivor` が red |

3 番目は「定数を伸ばせば大きな声で落ちる」という**未実測だった主張**（pr-test-analyzer 指摘）を
事実に変えたもの。

#### レビュアー間の対立を裁定

**PID 再利用**について silent-failure-hunter は「永久に終了しない・孤児問題の再導入」、
Fable は**不同意**。**Fable を採用**した — PID は単調割当て + wraparound なので 1 秒以内の
再利用は非現実的で、仮に起きても偽者プロセスの寿命の間だけ（有界）。

#### `#[ignore]` テストを CI へ

「CI に `--ignored` ジョブが無く誰も実行しない」（pr-test-analyzer / Fable が一致）を受け、
`rust-ci.yml` にステップを追加。**手元で実走して 95.00s / pass を確認してから載せた**。
テキスト検査は script の**形**しか見ないので、`timeout 20 ...` や親監視ループ自体の破壊は
すり抜ける。この behavioral テストがその穴を埋める唯一の手段なので 95 秒を払う。

### 6.376 refactor: /simplify の指摘を方針として一括適用 (#622 / PR #629) (Aug 27, 2026)

**Date**: 2026-08-27
**Issue**: #622 / PR #629
**Status**: daemon lib **205 passed / 0 failed / 1 ignored** / clippy `--all-targets` 0 警告 / fmt 通過

owner の指摘「レビューしないでマージして大丈夫ですか？」で手順違反に気づき、`/simplify` を
規定どおり回した（4 エージェント並行）。**指摘単位のパッチにせず、方針を先に決めて一括適用**した。

#### 🔴 最大の発見（altitude）— 列挙を尽くしていなかった

**`record-respawn-args.sh` に `exec sleep 3600` が残っていた。** 6.375 と同じ罠で、しかも
孤児が**最大 1 時間**残る形。`slow-child.sh` の**利用者**は列挙したのに、**fixture ディレクトリ
自体を列挙していなかった**。さらに 6.375 で書いた退行テストは 1 ファイルしか見ておらず、
**この見落としを検出できない形**だった。

4 つすべてを列挙して分類した:

| fixture | 判定 |
|---|---|
| `exit-child.sh`（`exit 1`） | 正しい（即死が役目） |
| `slow-child.sh` | 6.375 で修正済み |
| `record-respawn-args.sh`（`sleep 3600`） | 🔴 同じ罠 → 修正 |
| `variable-lifetime-child.sh`（`sleep 2.2`） | **別クラス** — 触らない |

`variable-lifetime-child.sh` を例外にした根拠: 2.2s が守るのは `FAST_RESPAWN_THRESHOLD`(2s)
だが、**負荷は寿命を縮めない**（`sleep` は遅延しても短くならない）ので「黙って下回る」形には
ならず、定数を伸ばせば「生存者が出ない」で**大きな声で落ちる**。

#### 適用した方針

> **fixture の寿命は 2 種類しかない。**「殺されるまで生きる」ものは固定秒数を**書けない形**に
> する（共有スニペットで親の生死を見る）。「特定の秒数生きる」ものは、その秒数が守る Rust
> 定数と外れた時に**大きな声で落ちる**ことを確認した上でのみ許す。退行テストは**ディレクトリ
> 全体を走査**し、後者を明示的な例外リストで管理する — 1 ファイルだけを見る形にしない。
>
> **Rust**: 早期終了の「事実」と「理由」は**1 つの操作でしか動かせない形**にする。

- `tests/fixtures/lib/live-until-parent-exits.sh` を新設し、`slow-child.sh` と
  `record-respawn-args.sh` が読み込む形へ統一（固定秒数を書ける場所を無くした）
- 退行テストを `no_child_fixture_ends_after_a_fixed_wait` へ作り直し、**走査が 0 件になったら
  それ自体を失敗**にした（列挙が意味の源なので）
- `outproc_child_exit::ChildEarlyExit` を新設。公開するのは `arm_for_new_attempt()`（両方倒す）
  と `record(status)`（理由 → 事実の順）だけで、**片方だけ動かす書き方が表現できない**。
  置き場所は `outproc_child_exe` / `outproc_respawn_guard` の先例に倣った
  （「規則を 2 箇所に持つと片方だけ直し忘れる — #548 がその形のバグだった」）

#### レビューで浮かんだ潜在的なズレ

`child_early_exit` は spawn のたびに `false` へ倒されるのに、6.375 で足した理由は**倒されて
いなかった**。実害は出ていない（理由を読むのはフラグが true の分岐内だけで、理由を
フラグより先に書いているため）が、**不変条件が暗黙**だった。型に畳んで表現の問題にした。

#### 各エージェントの評価

| 角度 | 結果 |
|---|---|
| Reuse | ポイズニング回復を 4 箇所に手書き・既存 `lock_child_slot_recovering` と流儀が違う → 統合で解消 |
| Simplification | 約 50 行のコピペ → 型統合で解消。`OnceLock` 案は**リセット経路があるため不可**と判明 |
| Efficiency | **RT から Mutex をロックする経路は無い**（列挙で確認）。false sharing の懸念 → フィールドを struct 末尾へ |
| Altitude | 上記の見落としを検出 |

#### 変異検証

- `record-respawn-args.sh` を `exec sleep 3600` へ戻す → 新テストが**名指しで** red（旧テストは素通り）
- 走査対象 0 件のガードは、**実際に main のミス（ディレクトリの取り方）を即座に捕まえた**

### 6.375 fix: Rust CI flake の原因は fixture の固定寿命だった (#622) (Aug 27, 2026)

**Date**: 2026-08-27
**Issue**: #622
**Status**: daemon lib **205 passed / 0 failed / 1 ignored** / clippy `--all-targets` 0 警告 / fmt 通過

#622 は「未確認の仮説（机上で確定させるな）」として資源圧の話が書かれていたが、**実装を読むと
算術で決まる欠陥**だった。

#### 原因

`slow-child.sh` は `exec sleep 20` で**寿命が固定 20 秒**。一方この fixture が生き残らねば
ならない経路は 2 つの deadline にゲートされている:

| | 値 |
|---|---|
| child の寿命（`exec sleep 20`） | **20 秒** |
| `SETUP_DEADLINE`（Loading 観測までの許容） | 30 秒 |
| `CHILD_READY_TIMEOUT`（READY poll の許容） | 60 秒 |

**寿命の方が短い。** 速いマシンではテスト全体がミリ秒で終わるので表面化せず、CI が詰まって
セットアップが 20 秒を超えた時にだけ child が自然死し、READY poll が early-exit 分岐へ落ちて
`child exited before publishing READY` を返す。**#622 が記録した署名そのもの**である。

#529（effect 版・「1 本目が Loading から既に離脱」）とは原因が違うという issue の判断は正しく、
**署名が違えば原因も違った**。

fixture のコメントは「引数を無視して**生き続ける**」を契約と書いており、`sleep 20` はその
近似だった（元は `sleep 0.2` で、#573 の cascading respawn を受けて延ばした経緯）。
**deadline が 30/60 秒へ伸びた時に、その近似が黙って下回った。**

#### 修正 — 秒数を増やさず、寿命の概念を無くす

秒数を増やすのは先送りにしかならず、増やせばテスト異常終了時に**孤児がその時間だけ残る**
（このリポジトリでは実害がある）。そこで**親の消滅で終わる**形にした。

```sh
parent=$PPID
while kill -0 "$parent" 2>/dev/null; do
  sleep 1
done
```

両方の契約を実測: 親が生きている間は生存（4 秒観測）/ 親が消えたら自分も終了（**孤児なし**）。

#### 固定したもの（すべて変異で実証）

| テスト | 変異 | 結果 |
|---|---|---|
| `slow_child_fixture_has_no_fixed_lifetime` | fixture を `exec sleep 20` へ戻す | red |
| `..._outlives_the_deadlines_it_must_survive`（`#[ignore]`） | — | 実時間で deadline 超えを検査 |
| early-exit（effect / instrument） | エラーに終了理由を載せない | **両方** red |
| 同上 | watchdog が status を記録しない | red |

検出器は最初「`sleep N` がどこかにある」で書き、**ループ内のポーリング間隔を誤検出**した。
「**最後の文が固定待ちで終わる**」= #622 で退行した形だけを見るよう狭めた。

#### 診断（issue の「次の一手」）

`child exited before publishing READY` に**終了理由**を載せた。watchdog は既に
`tracing::warn!` へ status を出していたが、**呼び出し元へ返る `WrapError` には乗っていなかった**
ので、受け取った側から SIGKILL（資源圧で殺された）と child 自身のエラー終了を区別できなかった。
実ユーザーがプラグインの起動失敗を見る時にも効く。

`child_early_exit_status: Mutex<Option<String>>` を両ロールの stats に追加。書き手は watchdog
スレッド・読み手は control スレッドで**どちらも非 RT**。audio callback から触らないことを
コメントで明示した。

#### 副次的な観測

隔離 worktree の並行コンパイル下でのみ watchdog 系テスト 2 件が落ち、本体ツリーでは 2 回とも
pass した（#625 セッション）。**負荷依存**という観測は本 issue の仮説と符合する。ただし
「同時 child 数のピークが上がった」かどうかは**実測していない**ので仮説のまま残す。

### 6.374 fix: 正常な継続を ERROR として記録していた（4 回目の再発）(Aug 27, 2026)

**Date**: 2026-08-27
**Issue**: #625 / PR #627
**Status**: 実機 gated E2E が **1 failed** → 修正 → 再実行

マージ前ゲートの実機 gated E2E（8 件）で **R-E4 が落ちた**。「復旧は ERROR 行を増やさない」
というオラクルに対し、ERROR 行が 17 → 18 に増えていた。増えた 1 行はこれ:

```
ERROR: [effect-replace] ⚠️ Best-effort cleanup of the uncertain old effect for 'fx625' failed;
       replacement/removal will continue: [PLUGIN_STATE_TARGET_ERROR] effect child slot has no loaded plugin
```

**ラウンド1 の I-1 修正で足した `console.warn` が原因。**

#### 構造

拡張は engine プロセスの stderr を、**内容を一切見ずに**まるごと `ERROR:` を付けて出力
チャネルへ流す（`extension.ts` の `setupStderrHandler`）。Node の `console.warn` は stderr へ
書くので、**正常に継続する操作を warn で報告した瞬間に ERROR として記録される**。
同じファイルの兄弟通知（`[plugin-state] restoring`）が `console.log` なのはこの理由だった。

これは `af041307`「正常なプラグイン操作を error として記録するのをやめる」で直した欠陥の
**4 回目の再発**である。Rust 側は `8258c40a` で `orbit_child_runtime::notice` へ集約して
破れない形にしたが、**TS 側には同じ罠が残っていた**。

#### 対処 — 1 箇所を直さず、方針を全箇所へ

PR が追加した `console.warn` を列挙すると **3 箇所**あり、いずれも「正常に継続する」通知
だった（うち実機で発火したのは 1 箇所）。落ちた 1 箇所だけを直すのは指摘単位のローカル
パッチになるため、`effect-replace-notice.ts` を新設して**呼び出し側が stream を選べない形**
にし、3 箇所すべてを移行した（Rust の `notice.rs` の TS 版）。

`tests/core/effect-replace-notice.spec.ts` が **文言ではなくストリーム**を固定する。
`console.warn` へ戻す変異で 2 件とも red になることを実測した。

#### 🔴 この欠陥を誰が捕まえられなかったか

| 層 | 結果 |
|---|---|
| ユニットテスト（TS 2073 件） | 検出せず |
| `/code:pr-review-team` 4 名 | 検出せず |
| Fable 収束監査 | 検出せず |
| main の変異検証 8 種 | 検出せず |
| **実機 gated E2E** | **検出** |

理由は明快で、**ストリームの深刻度分類は engine の外（拡張）で起きる**からである。
engine のテストからは原理的に見えない。CLAUDE.md の「E2E が最重要」「壊れるのは配線であり、
配線は E2E でしか見えない」がそのまま実証された形。

### 6.373 test: 変異検証で見つけた3つの穴を塞ぐ + 収束監査 (Aug 27, 2026)

**Date**: 2026-08-27
**Issue**: #625 / PR #627
**Status**: TS **2073 passed** / Rust `teardown_guard` 4 passed / CI 4 check green（`c47813ca`）

レビュー ラウンド1 の修正（6.372 = `c47813ca`）が CI 緑になった後、**main 自身の変異検証**を
隔離 worktree で回した。`/code:pr-review-team` 4名 + Fable 監査を通過した差分に対して、
**テストの穴が3件**出た。いずれも「実装は正しいが、テストがそれを固定していない」型である。

#### 生き残った変異 3件

| 変異 | 種類 | 実害 |
|---|---|---|
| 復旧 catch の `existing ?? forgottenSlot` → `existing` | 引数差し替え | **2回連続で失敗すると忘れられた slot が失われる**。以後の復旧で音色が黙って消える（I-1 と同じ故障クラス） |
| `remove()` の `cleanupSlot` → `existing` のみ | ガード削除 | 忘れられた slot への `remove()` が**名前照合を飛ばす**。`remove("別名")` が通る |
| `done.store(false)` を `requested.store(true)` の**後**へ移動 | **順序入替** | **RT が返した本物の ack を control が消す**。成功した quiesce が timeout 扱いになり差し替えが不要に失敗する |

3件目は変異計画の時点で「落ちない可能性がある」と印を付けていたもの。**印を付けた変異が
実際に生き残った** — 順序が load-bearing なのに、テストは `latch_then_request` の
**戻り値だけ**を見ていて順序を見ていなかった。

#### 対処

- TS: `I-1b`（忘れられた slot の `remove()` でも名前を検証し旧 state を保存）と
  `I-1c`（2回連続失敗でも忘れられた slot を落とさない）を追加
- Rust: production 側の `between` フック（順序を観測するために**既に存在していた**もの）を
  **`done` 掃除の後・要求 publish の直前**へ移動。テストがその瞬間の `done` を観測する

**追加後に同じ変異を当て直して red を実測**した（TS: 各1件 red / Rust: M6 は1件・M7 は
**2件** red）。

#### Fable 収束監査 — 判定「収束」

非重複の指摘が1件。**`GetPluginState` の daemonTarget は slot 座標（role + bus）だけで、
そこに載っている plugin の identity を検証しない。** 「TS は失敗と判定・daemon は新テナントを
コミット済み」の状態が作れると、best-effort 保存が**新テナントの state を旧 identity の
ファイルへ無言で上書き**する。

Fable は失敗経路を列挙して**現在は到達不能**であることを示した（quiesce timeout → daemon は
旧のまま / teardown 後 attach 失敗 → slot は Empty で保存自体がエラー / WS 切断 → respawn 後の
空 slot）。決め手は **daemon の replace/load 経路に「コミット後に Err を返す」パスが無い**こと。

到達不能なので issue にはせず、**依存している不変条件と、それを壊す時に先にやるべきこと**を
`beforeReplaceForgottenSlot` の docstring に記録した。

また Fable は、変異3の正当性をメモリモデルの側から独立に証明した（RT の `done=true` は
`requested` の Acquire load の後にあり、その load は control の release store と
synchronizes-with するので、coherence 上 RT の true は control の false より後に確定する）。

#### 副産物の観測（#622 へ）

隔離 worktree で `supervisor_respawn_passes_the_state_saved_after_initial_spawn` と
`supervisor_resets_fast_fail_streak_after_a_survivor` が落ちたが、**本体ツリーでは2回とも
pass**。並行コンパイルの負荷で 5 秒ポーリングが間に合わなかった環境要因で、既知の Rust CI
flake #622 と同じ症状。**負荷依存**という観測は #622 に足す価値がある。

もう一つ、`cargo test`（統合テストバイナリを含む）が **`_dyld_start` で 13 分停止**した。
コンパイルではなくバイナリのロード段階での停止で、`--lib` に絞ると 0.5 秒で完了した。

### 6.372 fix: PR #627 レビュー ラウンド1 の指摘を修正 (Aug 27, 2026)

**Date**: 2026-08-27
**Issue**: #625 / PR #627
**Status**: TS **2071 passed** / Rust workspace 全クレート 0 failed / fmt・clippy 警告 0

`/code:pr-review-team`（4レビュアー）+ Fable 最終監査の指摘を重複排除して集約。
**Critical 0 / Important 6 / Minor 5**。うち **2 件は複数の目が独立に一致**した。

#### 横断的ポリシー（指摘単位のローカルパッチにしないため先に決めた）

> **「登記を忘れる」ことと「後始末を諦める」ことは別物である。**
> 忘れた slot の情報は保持し、次回の差し替えで `beforeReplace` を試みる。ただし旧が既に
> 消えている可能性があるので **best-effort**（通常経路は保存失敗＝中止のまま、復旧経路では
> warn して続行）。この非対称は load-bearing で、復旧時に中止すると E2E R-E4 が実証している
> 「再宣言だけで復旧する」が成立しなくなる。

#### Important 6 件

| # | 指摘 | 検出 |
|---|---|---|
| I-1 | 事前解体失敗の後、**state 自動保存と UI クローズが黙ってスキップ**（silent data loss） | silent-failure-hunter + code-reviewer（**独立に一致**） |
| I-2 | master の `remove()` 成功が **linkAudio 排他ゲートを再び開く** | Fable + pr-test-analyzer（**独立に一致**） |
| I-3 | 「audio thread はこれらに触らない」というコメントが**事実と異なる**（`quiesce_requested` は毎コールバック読まれる） | comment-analyzer |
| I-4 | **反証済みの仮説**が E2E コメントに残っていた（**3 箇所目**） | comment-analyzer + Fable |
| I-5 | spec が「再宣言だけで復旧」と**無条件に**約束していた（unrecoverable な attach 失敗は再起動が要る） | Fable |
| I-6 | 設計書の完了条件と**実際の E2E 被覆**の食い違い（seq 全量・master 最小・sum/aux は E2E ゼロ） | Fable + pr-test-analyzer |

I-1 は「**その契約が最も効いてほしい局面でだけ**破る」形だった。daemon 側は quiesce timeout /
already in progress / engine is stopping で**旧を無傷で保つ**のに、TS が登記を忘れるため
次の宣言で本物の teardown が起き、その直前の保存が一度も走らない。

#### 🔴 main のミス 3 件（この期間に発生・すべて訂正済み）

1. **Linux ビルドを壊した**（CI が fail）— python パッチが `fn main` の
   `#[cfg(target_os = "macos")]` を巻き込んで削除。**macOS でしか検証していなかった**うえ、
   **CI を確認せずに次へ進んだ**。修正したら 2 件目（テストモジュールの cfg 不整合）が出た
2. **自分が書いたテストにコンパイルエラー**（未使用代入・`-D warnings` で error）
3. **CI ランナーを macOS へ切り替えた** — owner 方針（コストが高いので回さない）を確認せずに。
   **指示（「Linux をターゲットから外していい」）を勝手に拡大解釈**した。差し戻し済み

#### CI の限界を明文化（ランナーは ubuntu のまま）

3 の差し戻しで残った事実: **ubuntu ランナーは child crate の
`#[cfg(not(target_os = "macos"))]` スタブしかコンパイルしない**ので、**出荷される macOS 実装は
この job では一度も検証されない**。#625 で落ちた時に捕まえたのもスタブ側の cfg 不整合だった。

ランナーは変えず、**この job が保証しないもの**を workflow のヘッダに明記した:
「green は移植可能な部分が壊れていないことの証明であって、出荷物が動くことの証明ではない。
後者は main が手元 macOS で回すマージ前ゲートが担う。**この job だけを根拠にマージしない**」。

### 6.371 refactor: /simplify の指摘を適用（規律を「破れない形」へ）(Aug 27, 2026)

**Date**: 2026-08-27
**Issue**: #625
**Status**: 挙動不変。TS **2069 passed**（件数一致）/ Rust workspace 全クレート 0 failed / clippy 警告 0

`/simplify` の 4 観点（reuse / simplification / efficiency / altitude）を並行で回し、
**採用 6 項目を適用・見送り 4 項目を明記**した。

#### efficiency は指摘なし — 設計の前提が差分で裏づけられた

`rust/crates/orbit-audio-native/`（RT コード）が**一切変更されていない**ことを確認。
「RT コード変更ゼロ」は案 (a) を採用した理由そのものなので、これが差分で裏づけられた意味は大きい。
outproc mutex の保持区間が quiesce 待ち・attach 本体の外である点も確認済み。

#### 🔴 最も重い指摘は **main 自身の直前の修正**に対するものだった（altitude #1）

`INFO ` の level トークン規約が **3 クレート 4 箇所に手書き**され、巨大な doc コメントまで
コピペで独立に存在していた。この規約は**すでに 2 回同じ障害を起こしている**
（#618 で instrument に手当て → #625 で effect が取り残されていたと実機で発覚）。

main は「同じ欠陥クラスが片方だけ直っていた」と指摘しておきながら、**その修正を手書きで
3 箇所に増やしていた**。CLAP 側の child は未対応で、**3 回目の再発が構造的に待っている**状態。

対処: `orbit_child_runtime::notice` に規約を集約し、**TS 側 router の受理条件をテストで固定**。
**手書きの前置を 1 つも残さない**（既存の instrument 側 2 箇所も置換）。
なお最初の置換で 1 箇所取りこぼし（複数行 `eprintln!` が grep パターンから外れた）、
**awk で複数行を連結して列挙し直して**確認した — 「他には無い」は列挙を尽くして初めて言える。

#### 採用した 6 項目

| # | 内容 |
|---|---|
| A | Rust: `replace_outproc_effect_plugin` / `unload_outproc_effect_plugin` に一字一句同一の約 35 行 → private ヘルパへ |
| B | TS: `uncertainReplacements`(Set) + `uncertainEffectBuses`(Map) の**2 並行コレクションを単一 Map へ** |
| C | TS: `remove()` が `declare()` の直列化キューを複製 → `enqueue()` を抽出 |
| D | TS: `hasAnyUncertain()` は呼び出し元ゼロの dead code → 削除 |
| E | TS: `unloadPlugin` の try/catch 重複 → `finally` + 台帳ヘルパ |
| F | Rust: `ReplacePlugin` の role 検証で同文言の `err()` が 2 回 → 1 回に |

#### この PR で 3 回出た形: 「守るべき規律」→「破れない形」

1. 同型 `Arc<AtomicBool>` の位置引数 → **名前付き struct**（取り違えがコンパイル不能）
2. level トークンの手書き → **共有ヘルパ**（形を間違える余地が消える）
3. uncertain の 2 並行コレクション → **単一 Map**（同期ずれが表現できなくなる）

B は整理であると同時に将来の欠陥クラスを潰す変更。分岐が増えたとき片方だけ更新すると
`unloadPlugin` が**誤った bus へ飛ぶ**構造だった。

#### 見送った 4 項目（理由つき）

| 見送り | 理由 |
|---|---|
| テストヘルパ（`REPLACE_RESULT` 等）の共通化 | **変異検証を通したばかりのテストをこの段階で動かしたくない** |
| E2E 診断ログの統合 | 整形の提案で価値が小さい |
| `prepareEffectReplacement` / `prepareInstrumentReplacement` の統合 | instrument 側の挙動に触れる。**乖離が残るのは事実**だが終盤のリスクが利得を上回る |
| `failurePolicy` / `EffectSlotEntry` の instrument 共通化 | 設計の決定 2・4 で確定済み |

altitude は後者 2 つについて「**むしろ適切な深さ**」と判断している。`failurePolicy` の 2 値は
role の言い換えではなく「スロットに間接層があるか / bus 名で位置固定か」という daemon 側の
構造差に対応し、spec にも失敗モデル 2 型として文書化済みであることを実コードで確認している。

### 6.370 fix(daemon): 正常動作が ERROR として記録される欠陥を 3 件（#625 実機 E2E で発覚）(Aug 27, 2026)

**Date**: 2026-08-27
**Issue**: #625（Stage D の実機実行で発覚。いずれも **#625 以前から存在**した欠陥）
**Status**: 実機 gated E2E **8 passed / 0 failed**（新規 R-E1〜R-E7 を含む）/
TS **2069 passed** / Rust workspace 全クレート 0 failed / fmt・clippy 警告 0

#### 🔴 実機 E2E を 11 回回して分かったこと

ユニット 2068 件・Rust 203 件が緑で、変異検証も 25 種以上通した状態で、**実機は 1 回目で
問題を出した**。しかも 3 件とも **#625 の変更由来ではなく、以前から存在していた**。

| # | 欠陥 | 発生頻度 |
|---|---|---|
| 1 | `orbit-vst3-effect-child` の `--plugin-id` 未使用通知が level を名乗らず ERROR に倒れる | **VST3 effect をカタログ名でロードするたび** |
| 2 | `orbit-vst3-host` の state 復元 best-effort 通知 2 件が同様 | **state 復元のたび** |
| 3 | stderr 分類器が `[orbit-...-child]` **終端のタグしか認めない** | host crate の通知は構造的に救えなかった |

3 件とも「**正常に動いているのにログ上はエラーに見える**」形。実害は
`get_log` の ERROR 件数を根拠にする診断の偽陽性、**LLM の自己検証経路の破壊**
（本プロジェクトは LLM を第一級ユーザーとして設計している）、本物のエラーが埋もれること。

**姉妹の instrument 側は #618 の時に同じ修正が入っており、effect 側だけ取り残されていた。**
既存 E2E も VST3 effect のロードや state 復元を通ってはいたが、**そこで ERROR 増分を検査して
いなかった**ため露見しなかった。今回のシナリオが「ERROR を増やさないこと」を主張して初めて出た。

3 件とも**メッセージ生成を関数に切り出して変異検証つきのテスト**を付けた（文言をテスト側に
手写しすると捏造の罠に落ちるため）。`INFO ` を落とすと red になることを確認済み。

#### E2E オラクルの是正 4 件（**緩めていない。1 件はむしろ強化**）

| # | 是正 | 理由 |
|---|---|---|
| 4 | 比較基準を `dryBaseline` → **bus アクティブの dry** へ | `dryBaseline` は 3 秒窓の先頭 1 秒が LOOP 開始レイテンシで無音（エネルギーきっかり 2/3） |
| 5 | **B を unity gain → 0.5** | 🔴 unity のままだと「B が正しく透過している」と「**B がロードされたが一度も適用されていない**」が数値として区別できない（実測で 10 桁一致した）。後者は変異検証で潰した `ChildLaunch.engaged` 配線切断そのもの |
| 6 | 測定窓に **400ms のガード** | 壁時計と録音タイムラインのスキューで、窓の末尾が次の操作（teardown）を拾っていた |
| 7 | 誤った因果説明 2 箇所を訂正 | 下記 |

#### 🔴 main が途中で誤った判断をした（記録として残す）

`b` 区間だけがエネルギー 1.5 倍になる現象について、main は「**製品側の異常・#624 と同じ
二重出力クラス**」と判断した。**誤りだった。**

窓ごとの生系列を出したところ、打点のピークは `b` も `recoveredB` も同じ 0.115 で、
**末尾 1 窓だけが 0.232（= dry の打点レベル 0.115/0.5）**だった。エネルギー比 1.5 は
この 1 窓だけで説明でき（`(5×0.115² + 0.232²) / (6×0.1155²) = 1.4986`）、機構は正しく
動いていた。

**教訓: 集計値は、まったく違う 2 つの状態から同じ数字を出す。**
「区間 RMS が 1.5 倍」に対して (a) 一様な増幅（製品の欠陥）と (b) 1 窓だけの混在（測定境界）が
同じ値を与え、**main も Fable も生系列を見るまで (a) に傾いていた**。
Fable の絶対値モデル（`kick.wav の RMS × 等パワーパン × (sum + send)` が 6 区間で 6 桁一致）は
強力だったが、**集計の粒度では届かない問い**だった。

先に待ちを**前**に足して効かなかったのも当然で、**汚染は末尾**にあった。

### 6.369 test(e2e): #625 Stage D — 差し替えと削除を音のオラクルで固定 (Aug 27, 2026)

**Date**: 2026-08-27
**Issue**: #625（Stage D = 実機 gated E2E）
**Status**: シナリオ追加。TS **2068 passed / 36 skipped**（skip +1 = ゲート無しで正しく skip）

`tests/e2e/orbitstudio-mcp-gated.spec.ts` に R-E1〜R-E7 を 1 シナリオ追加。並行機構は新設せず、
既存の capture / RMS 機構と `replaceGatedPluginFixtureSymlink` を再利用した。

#### 音のオラクル（「エラーが出ない」では示せない性質）

同一 WAV 内に `dry → A → B → failure dry → recovered B → restored A → removed dry` の区間を
記録し、停止後にまとめて区間 RMS を測る。

| # | オラクル |
|---|---|
| R-E1 | A（CLAP・state gain 0.25）が非無音の減衰レベル |
| R-E2 | **`bRms / aRms` が 3.2〜4.8**（gain 0.25 → 1.0 の約 4 倍）+ 新 PID 出現・旧 PID 消滅・ERROR 増 0 |
| R-E3 | 失敗注入で **`failedDryRms` が `dryRms` と一致** = 無音でも A でも B でもなく **dry**。音は止まらない |
| R-E4 | 再宣言だけで `recoveredBRms` が `bRms` と一致（再起動なし） |
| R-E5 | swap-back で **`restoredARms` が `aRms` と一致** = 自動保存した音色が実際に戻る + restore ログ |
| R-E6 | remove で `removedDryRms` が `dryRms` と一致かつ非無音 = **routing が生きている** |
| R-E7 | master 経路の PID 交代・ERROR 増 0（bus 系と slot が別物であることの実機確認） |

**R-E3 と R-E5 が要**。R-E3 は設計の失敗モデル (ii)「解体後の失敗は dry 縮退（無音にならない）」を
音で証明し、R-E5 は「差し替え直前の自動 state 保存」が音として復元されることを証明する。

#### フルパス直書きは 1 箇所のみ

R-E3 の失敗注入だけ（存在しないパスを daemon の失敗経路まで到達させる必要がある。カタログ名だと
TS 解決で先に落ちる）。理由をコメントに明記。**他の全宣言は `list_plugins` 由来のカタログ名**。

#### 担当の切り分け

Codex は**シナリオの作成まで**。実機（OrbitStudio.app・オーディオデバイス・MCP）は sandbox で
原理的に走らないため、**「実機で確認した」と書かせず**、確認できない事項を列挙させた。
実行は main が `ORBIT_GATED_ORBITSTUDIO=1` で行う。

### 6.368 feat(engine): #625 Stage C — remove() で effect insert を外す (Aug 27, 2026)

**Date**: 2026-08-27
**Issue**: #625（Stage C = 削除。実機 gated E2E は Stage D）
**Status**: TS **2059 → 2068**（+9）/ Rust daemon lib **202 → 203**（+1）/ sandbox 外で全スイート green

#### 実装

`remove("名前")` を 4 経路（`global.remove` / `kick.remove` / `sum|aux("x").remove`）で実装。

- daemon: `unload_outproc_effect_plugin`（replace の 1〜6 段 + load しない版）。
  slot が Empty なら冪等 `noop`。**`bus_actives` と bus 簿記には触らない**
- wire: `UnloadPlugin`（v1 は effect のみ受理）+ `ENGINE_DAEMON_PROTOCOL.md` 追記
- TS: `EffectChainMap.remove()`。**`declare` と同じ per-key pending キューへ直列に載せる**。
  名前不一致は throw（黙って別のものを消さない）。`BusPool.release` は呼ばない
  （`seq.output()` / `seq.send()` の routing が bus 名を参照し続けるため）

#### 🔴 main の全スイート実行で 3 件の失敗（3 回連続）

Codex の報告に無かった失敗が、main の sandbox 外実行で出た。落ちたのは
`dsl-method-catalog.spec.ts` = **VS Code 拡張の補完候補表が engine の DSL 語彙と一致すること**
を検査するテスト。`remove` を語彙 3 セットに足したのに補完表を更新していなかった。

**ガードが設計どおり働いた形**。放置すれば「`remove` は動くのにエディタの補完に出てこない」
という、通常のテストでは見えない劣化になった。修正は補完カタログ 3 箇所への 1 語追加 +
provider テストの期待値 1 箇所だったので、委譲往復に見合わず **main が直接修正**。

#### 語彙 3 セットの独立検証（#528 型の事故の本丸）

`remove` を **1 セットずつ独立に外す**変異を main が実施。3 セットとも red:

| 外したセット | 落ちたテスト |
|---|---|
| `GLOBAL_DSL_METHODS` | R23a + 内部 API 分類ガード + 補完表一致（global） |
| `SEQUENCE_DSL_METHODS` | R23b + 内部 API 分類ガード + 補完表一致（sequence） |
| `BUS_DSL_METHODS` | R23c + 補完表一致（bus） |

R23 を `R23a/b/c` に分割させたのが効いた。**まとめて 1 テストにすると 1 セット載せ忘れても
他で緑になり、その経路だけ実機で全滅する。**

#### テスト番号の衝突を是正

Stage B で追加した identity テストが `R18`〜`R21` を名乗っており、設計の失敗モード表で
`R19`〜`R23` が remove 関連に割り当て済みだったため衝突していた。
**`R12a`〜`R12d` へ改名**（R12「差し替え前の自動 state 保存」の経路別展開なので枝番が正しい）。
1:1 対応表が壊れたまま積むと、どのテストがどの失敗モードを守っているのか追えなくなる。

### 6.367 feat(engine): #625 Stage B — effect の差し替えを wire と DSL 層へ開通 (Aug 27, 2026)

**Date**: 2026-08-27
**Issue**: #625（Stage B = wire 公開 + TS 差し替え。`remove()` は Stage C・実機 E2E は Stage D）
**Status**: TS **2042 → 2059**（+17）/ Rust daemon lib 202（無変更）/ sandbox 外で全スイート green

#### 実装

daemon の `ReplacePlugin` を `role='effect'` に開き、TS 層を差し替え可能にした。
`global.effect(A)` → `global.effect(B)` / `seq.effect` / `sum|aux().effect` の **4 経路**が
エンジン再起動なしで差し替わる。

- `effect-slot.ts`: `failurePolicy: 'retain-on-reject' | 'forget-and-ensure'` を追加。
  **effect は失敗の種別を問わず登記を忘れて uncertain を立てる** — in-place 差し替えは
  「旧が既に消えているか」を呼び出し側から判別できないため。instrument は現行の
  `'retain-on-reject'` に固定して無変更
- `Global.prepareEffectReplacement`: UI close → 旧 state 保存 → 差し替え
- linkAudio 排他ゲートに `hasUncertain()` を追加（master の差し替え失敗後にゲートが緩むのを防ぐ）

#### 🔴 委譲先の green 報告と実測が食い違った（2 回目）

Codex は「focused な Stage B テストは全部 pass」と報告したが、**sandbox で全スイートを
回せていなかった**。main が sandbox 外で回すと **6 件 failed**。

内訳は「旧挙動（異 spec は拒否）を固定していた 4 つの spec」と、**#528 の再発防止ガード**
（全 public メソッドが DSL 語彙か内部 API に分類されることを検査する逆方向テスト）が
`prepareEffectReplacement` を未分類として捕まえたもの。**ガードが設計どおり働いた。**

修正方針は main が決めて渡した: **期待文字列を差し替えるだけの修正を禁止**した。
実際に返っていた `'Plugin replacement requires the Rust engine backend.'` は
**テストの mock に `replacePlugin` が無いから出るだけ**で、製品の挙動ではない。それを固定すると
「mock の作りを固定しただけのテスト」になる。代わりに mock へ `replacePlugin` を持たせ、
**差し替えが起きること**（呼び出し回数 + 引数）を固定し、テスト名も新しい意味論へ改名させた。

`EffectSlotLimitError` の S4 ポインタ書き換えテストは **削除を禁じ**、上流の手構築エラーによる
書き換え経路の検査を残したうえで、当該ケースを「異 spec はもう上限に到達せず差し替えになる」を
固定する形へ転用させた。

#### main の変異検証で 1 件の穴（経路の取り違え）

変異 5 種のうち 4 種は red。**1 種が生き残った**:

`SequenceEffectManager` の `beforeReplace` が receiver に `sequenceName` ではなく `'master'` を
渡しても **全 2055 件が緑のまま通った**。実害は、seq の差し替えで旧 state が
`master/effect/<name>/0` として登記され（正しくは `<seqName>/effect/<name>/0`）、
**旧 spec を再宣言しても音色が戻らない**（しかもエラーが出ない）。

原因は `prepareEffectReplacement` が **4 経路から呼ばれるのに identity を検証するテストが
1 経路分しかなかった**こと。**呼ばれた事実だけでは経路の取り違えを検出できない。**

修正では **実装を触らせなかった**（実装は正しく、足りないのはテスト）。4 経路を
**独立したテストケース**として追加させた（1 テスト内のループにすると最初の経路が落ちた
時点で残りが検証されない — Stage A で同じ問題が起きている）。

main の再検証（4 種・うち 2 種は Codex に伝えていない壊し方）で全て red を確認:

| 変異 | 検出したテスト |
|---|---|
| seq → `'master'`（前回の穴） | R19 |
| master → seq 名 | R12 / R13 / R15 / R18 |
| mixer の kind 入れ替え（sum ↔ aux） | **R20 と R21 の両方** |
| mixer の kind 接頭辞を落とす | R20 / R21 |

sum と aux は `makeKind` で同じコードを共有するため、片方だけのテストでは「4 経路を検証した」
ように見えて実は 3 経路分になり得た。**独立ケースであることが実行で確認できた。**

### 6.366 feat(daemon): #625 Stage A — effect insert を同一スロットで建て直す (Aug 26, 2026)

**Date**: 2026-08-26
**Issue**: #625（Stage A = Rust daemon。wire 公開と TS 配線は Stage B）
**Status**: Rust daemon lib **186 → 202**（+16）/ fmt・clippy(`--all-targets -D warnings`) 警告 0 /
sandbox 外で全ターゲット green（`tests/protocol.rs` の 28 件も含む）

#### 実装

`EngineWrap::replace_outproc_effect_plugin` を新設。`engaged=false` で dry 素通しへ落とし、
既存の quiesce ペア（stop/done）で RT の transport 離脱を ack で待ち、supervisor detach +
shm control reset のうえ**同一 shm へ新 child を attach** する。**RT コード（`orbit-audio-native`）は
無変更**。子プロセスの制御語彙に差し替えコマンドが無い（`CONTROL_RUN`/`CONTROL_QUIT` のみ）ため、
差し替えは必ず child の再 spawn になる。

`bus_actives` はどの経路でも触らない（一度 true にした bus を false へ戻すと、その bus に tag された
PlayAt イベントが消費されず retain される既存ハザードを踏むため）。

#### 検証の経過 — 委譲先の green 報告の後に **7 件の欠陥**が出た

| 発見者 | 手段 | 発見 |
|---|---|---|
| Codex | 変異 8 種（すべて「ガード・分岐を削除する」型） | 0（自分の変異はすべて自分のテストが検出） |
| **main** | 変異 **9 種**（引数の取り違え・配線切断・順序・回数・境界） | **5 件** |
| **Fable 監査** | 不在証明・API 意味論・設計整合 | **2 件（Important）** |

main の変異で出た 5 件:

1. **同型 `Arc<AtomicBool>` の位置引数取り違え**（`clear_quiesce_unless_shutdown`）— 入れ替えても
   型検査を通り、shutdown 競合時の復元先が `done` に化けて guard が**偽の ack** を掴む
2. 同じ欠陥クラスが **`OutProcTeardownGuard::new` にも残っていた**（1 箇所ずつ潰すと別の場所に残る）
3. `entry.engaged` を RT と別 Arc にしても全テスト緑 = **dry 窓の配線を実証するテストが無かった**
4. `ChildLaunch.engaged` を別 Arc にしても緑 = **プラグインがロードされても insert が一度も
   適用されない（音が恒久的に dry）**状態を誰も検出できなかった
5. guard の **latch 順序**（`shutdown` を `requested` より先に立てる）が、コメントで宣言されて
   いるだけでテストに守られていなかった

1・2 は**テストを足さず型で潰した**（引数を名前付き struct 1 つに畳み、取り違えを表現不能に）。
Codex は自主的に `OutProcEffectPostProcessor::new` にも同じ欠陥があることを見つけて潰し、
同型位置引数の**網羅列挙**（検索方法つき）を提出した。5 は Codex への修正が既に 2 回に達していた
ため、規律に従い **main が直接修正**（`latch_then_request` に抽出し中間状態を観測するテストで固定）。

#### Fable 監査の Important 2 件（変異検証では原理的に届かない層）

| # | 実害 | 対応 |
|---|---|---|
| **A-1** | tenant handoff で前 tenant の `measurement_invalid` が残る。クラッシュループした effect を差し替えて**復旧しても** health が daemon 再起動まで「計測無効」を報告し続ける | reset を追加 + テスト（変異検証済み）。instrument は同じ位置で既にリセットしていた = **借りた機構の不変条件を継承し損ねていた** |
| **B-1** | latch と clear が **store-buffering（Dekker）パターン**。`Release`/`Acquire` では再検査が stale な `shutdown=false` を読みうる → guard の要求が消え **ack 無し停止**。R27 が防ぐと主張する事象がメモリモデル層に残っていた | 4 アクセスを `SeqCst` 化（**両側揃えないと閉じない**）+ 理由をコメントに明記 |

🔴 **B-1 にはテストが無い。** 論理的インターリーブでは再現できない層で、`loom` 相当のモデル検査
でしか検証できない。設計書の失敗モード表には「この行の検出器はテストではなく**メモリ順序の指定**」
と明記し、`loom` 導入は follow-up 判断として §9-6 に残した。**テストが無いことを黙って通さない。**

#### 設計書の更新

失敗モード表を **27 → 33 行**（1:1 維持）。うち 2 行は検出器がテストではない（R28 = コンパイラ /
R33 = メモリ順序の指定）ことを列に明記。Stage B で踏む地雷 4 点を申し送りとして §7 に追記。

#### 教訓

**「変異が全部 red だった」は変異の種類に依存する。** Codex の 8 種はすべて「削除」型で、
削除を検出するテストは既にあった。**壊し方の種類を変えた瞬間に 5 件出た。**
さらに、変異検証そのものが届かない層（不在・メモリモデル）が 2 件あり、そこは別系統の目
（Fable）でしか見えなかった。

### 6.365 docs(spec): #625 Stage 0 — 差し替え・削除を spec 側に先行させる (Aug 26, 2026)

**Date**: 2026-08-26
**Issue**: #625（Stage 0 = 実装より先の spec 更新）
**Status**: docs のみ。実装は Stage A 以降

DocDD（spec が正本）に従い、実装前に仕様を更新した。effect の in-place 差し替えは
instrument の prepare-commit 型と**失敗モデルが異なる**ため、これを書かずに実装すると
spec に偽の文が残る（main レビュー指摘）。

| ファイル | 変更 |
|---|---|
| `docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md` | SC.3 規範4 の括弧書きを「SC.5 の失敗モデル (i) prepare-commit 型」への参照へ変更。SC.5 の v1 注記に **失敗モデル 2 型**（prepare-commit / in-place）を明記し、v1 実装済み範囲に「単一 insert の異 spec 再宣言 = 差し替え」と `remove("名前")` を追加 |
| `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` | **PH.2d を新設**（4経路共通の差し替え・削除の規則を1箇所に集約 = DRY）。PH.2 / PH.2b / MX.2 / MX.3 は PH.2d を参照する形へ |

#### 設計からの意図的な逸脱（1件）

設計 §7 Stage 0-3 は `docs/research/ENGINE_DAEMON_PROTOCOL.md` への
ReplacePlugin(role=effect) / UnloadPlugin の追記も Stage 0 に置いていたが、**Stage B/C の
wire 実装と同じコミットへ移した**。プロトコル**リファレンス**が存在しないメソッドを
記述する状態は、本 issue が直そうとしている「宣言と実体のずれ」と同じ種類の乖離になるため。
DSL の**仕様**（上表2ファイル）は従来どおり実装に先行させる。

### 6.364 docs(design): #625 effect insert の差し替え・削除の設計を確定 (Aug 26, 2026)

**Date**: 2026-08-26
**Issue**: #625（新規起票）
**Status**: 設計確定（実装未着手）。ベースライン TS **2042 passed** / Rust daemon lib **186 passed**

#### なぜ

#618（instrument の差し替え・PR #621 マージ済み）は owner の動機「変更出来ないのは準備の段階で辛い」の
**半分しか解いていない**。effect insert は一度挿すと engine 再起動なしに差し替えも削除もできず、
`global.effect()` / `seq.effect()` / `sum|aux().effect()` の3経路が恒久エラーで拒否する。
拒否文言が「chains (multiple inserts) are reserved」なのも誤答で、差し替えを頼んだ利用者に
チェーンの話を返していた。

#### 🔴 instrument の機構は流用できない

instrument は N 個の同質スロットプール + `instance_index`（名前→スロットの間接層）を持つため
「予備スロットへ prepare → 張り替えで commit」が成立した。effect は **bus 名でスロットが位置固定**
（`bus_slots` を RT の `InsertBusStage` が直接抱える）で間接層が無く、予備スロット方式が成立しない。

#### 採用機構: 同一 ChildSlot の in-place 建て直し（RT コード変更ゼロ）

`engaged=false` で dry 素通しへ → 既存 quiesce ペア（stop/done）で RT の transport 離脱を ack 待ち →
supervisor detach + shm control reset → **同一 shm へ新 child を attach**。
子プロセスの制御語彙に差し替えコマンドが無い（`CONTROL_RUN`/`CONTROL_QUIT` のみ）ため、差し替えは
必ず child の kill + 再 spawn になる。窓の間は**無音ではなく dry 素通し**（`outproc_effect.rs:365-367`）。

失敗モデルは instrument と異なる: 解体**前**の失敗は旧 insert 無傷、解体**後**の失敗は dry 縮退 +
forget-and-ensure（同じ宣言の再評価だけで復旧）。これは spec の一般則に反するため、**spec を先に改訂**する
（SC.5 に失敗モデル2型を明記し、SC.3 規範4 の括弧書きをそこへ参照させる）。

#### main レビュー（独立第二意見）で差し戻した2件

| # | 指摘 | 結果 |
|---|---|---|
| 1 | **quiesce フラグの所有権競合** — 差し替えの後始末 `requested=false` が、stream 停止時に同じ Arc を使う `OutProcTeardownGuard`（`outproc_effect.rs:781-797`）の quiesce を取り消す。guard は ack 無しで stream を止め、その後 attach が成功すると停止中の RT が shm を触る | control 側専用の第3フラグ `shutdown`（latch）を新設。guard が drop 冒頭で立て、差し替え側は手順0/6/7 で検査し、clear と競合したら `requested` を復元。**RT は読まないので RT 変更ゼロを維持** |
| 2 | **spec 更新の範囲不足** — SC.3 規範4 が失敗モデルを「SC.5 の後勝ち原則と同一」と一般則として書いており、in-place 方式は spec に偽の文を残す | SC.5 に失敗モデル2型を明記する案を採用。改訂文面まで設計書に記載 |

あわせて main が実ファイルで確認: `active_plugin_notes`（`engine_wrap.rs:207`）は insert/remove のみで
**reader が存在しない** → doc が主張する「live note 中は state 保存を fail-closed」は未実装。
本設計の自動 state 保存が演奏中に阻まれる懸念は無い（doc と実体のずれは follow-up）。
`OutProcTeardownGuard::new` の呼び出し箇所も 6 箇所すべてを列挙し直した（初稿は 1 箇所のみ）。

#### 成果物

`docs/design/625-effect-replacement-design.md` — 完了条件（曖昧語なし）/ 採用機構と却下2案 /
決定8項目 / **失敗モード 27 件 ↔ 受け入れテスト 27 行の 1:1 対応表（全行に変異列）** /
Stage 0-D の実装手順 / 触ってはいけないもの / 確信度の低い決定と反証方法。

### 6.363 fix(e2e): 実利用の経路へ全面的に寄せる — 標準プラグインディレクトリ + カタログ名 + audioPath (Aug 26, 2026)

**Date**: 2026-08-26
**Issue**: #618（PR-2 の続き）/ 派生 #623
**Status**: TS **2042 passed** / lint 0 / **実機 gated E2E 7/7 green**

#### 🔴 owner 指摘（3段階で深まった）

1. > effect やインストルメントがフルパスになってるのは改善したい
2. > **不便云々の前に E2E テストと利用の実態が乖離してることが問題だろ**
3. > **むしろ特殊なディレクトリに入れてるのがダメでしょ**

main は最初「名前でもロードできます（実装済み）」と答えて**論点を外した**。問題は機能の有無ではなく
**E2E が本番の経路を通っていないこと**。さらに fixture を tmp + `ORBIT_PLUGIN_PATH` に置くこと自体が
実態と違う（実ユーザーは標準ディレクトリに入れる）。

#### 変更（17箇所 + 設置方法）

| 対象 | 変更後 |
|---|---|
| instrument / effect 15箇所 | **カタログ名**（`list_plugins` から動的取得・ハードコードしない） |
| audio 2箇所 | **`global.audioPath()` + ファイル名** |
| fixture の設置先 | tmp + `ORBIT_PLUGIN_PATH` → **`~/Library/Audio/Plug-Ins/{CLAP,VST3}`**（標準） |

`ORBIT_PLUGIN_PATH` は起動 env から削除（継承値も明示的に除外）。
broken bundle も標準ディレクトリへ — 「**ユーザーのフォルダに壊れたプラグインがある**」状況こそが
rescan 失敗テストの実態。

**パス形式のまま残したのは「存在しないプラグイン」の失敗テストのみ**。カタログ名だと TS の
名前解決段階で落ち、daemon の rollback / エラー経路まで到達しないため。

#### 🔴 実利用の経路へ寄せた瞬間に欠陥が3件出た

1. **`--plugin-id` の警告**: カタログ解決は pluginId を**自動で補う**が VST3 は使わない。
   パス直指定では渡さないので**一度も踏まれていなかった**
2. **chunk 境界での行分割**: `onStderrData` が chunk をそのまま `split` するため、行が
   チャンクを跨ぐと後半が独立した「行」になり ERROR に分類される。
   → `createDaemonStderrLineRouter` として**純関数に抽出**して修正（クロージャ内では
   テストできない）。変異は両方向で red
3. **🔴 stale bundle の先勝ち**（Fable が実証）: `~/Library/Audio/Plug-Ins/CLAP/` に 7/28 の
   古いビルドが残留し、`clap.state` を持たない実体が**カタログ順の先頭**として選ばれていた。
   ロードも音も正常なので **state 保存まで進んで初めて分かる**

#### stale bundle 問題は製品の欠陥でもある（#623 起票）

**dedup は後勝ち（PC.5）なのに resolve は先勝ち**という方針の矛盾。同じプラグインを2箇所に
持つ実ユーザーは**どちらがロードされるか制御できない**。修正案3つを trade-off つきで #623 に整理。

緩和として E2E setup に「**その表示名のカタログ候補が全体で1件であること**」の検査を追加。

#### 安全策: owner のプラグインに触れない

`~/Library/Audio/Plug-Ins/VST3/` には owner 本人のプラグイン（242R / SuaraPortal）がある。
**固定名5パスの allowlist を通らない削除は例外を投げる**設計にし、ディレクトリ単位の削除・
glob・全 `.clap` 走査は書かない。実機実行後に owner のプラグインが無傷であることを確認済み。

正常 fixture は**ビルド成果物への symlink** なので staleness が構造的に起きない。

---

### 6.362 fix: E2E を本番経路（カタログ名）へ寄せ、そこでしか出ない欠陥2件を潰した (Aug 26, 2026)

**Date**: 2026-08-26
**Issue**: #618（PR-2 の続き）
**Status**: TS **2042 passed** / Rust daemon lib 186 passed / lint 0 / clippy 0 /
**実機 gated E2E 7/7 green（カタログ経路）**

#### 🔴 owner 指摘: 「不便云々の前に E2E テストと利用の実態が乖離してることが問題だろ」

main は最初「名前でもロードできます（実装済み）」と答えて**論点を外した**。owner の指摘は
**E2E が本番の経路を通っていない**こと。

実利用は `resolvePluginSpec` のカタログ分岐（名前 → パス + **pluginId の自動解決**）を通るが、
#618 の E2E はフルパス直指定で**その層をまるごと迂回**していた。
memory [[llm-drives-orbitstudio-through-dsl]]「**人間と同じ経路でないと意味がない**」に正面から反する。

→ E1-E6 をカタログ名での宣言に書き換え（機構は既存: `catalogFixtureDir` への symlink +
`ORBIT_PLUGIN_PATH` + `rescan_plugins`）。**名前は `list_plugins` から動的に取得**しハードコードしない。
E4（失敗ケース）だけパス形式を維持 — 存在しないカタログ名では TS の名前解決段階で落ち、
**daemon の rollback 経路まで到達しない**ため（Codex の判断・妥当）。

#### カタログ経路でしか出ない欠陥が2件出た

**① `--plugin-id` の警告**: カタログ解決は pluginId を**自動で補う**（名前解決の利点）が、
VST3 child はそれを使わず警告を出す。**パス直指定では pluginId を渡さないので一度も踏まれていなかった。**
ユーザーが避けられない経路で毎回出るため、level トークンを付けて情報扱いにした。

**② 🔴 chunk 境界での行分割**: `onStderrData` が chunk をそのまま `split('\n')` していたため、
**行がチャンクを跨ぐと後半が独立した「行」になり、level トークンを持たないので ERROR に分類**される。
カタログ化で行数が増えて境界がずれ、`state restored from ...(8 bytes)` の後半 `8 bytes)` だけが
ERROR として記録された。

→ **`createDaemonStderrLineRouter` として純関数に抽出**し（クロージャ内ではテストできない・
「配線はロジックと別にテストする」規律）、改行が来るまで持ち越す形に修正。
変異検証は両方向（持ち越しを捨てる / 未完の行を即 emit）で red を確認。

#### 教訓

**E2E が本番と違う経路を通っていると、その経路の欠陥は永久に見えない。**
今回カタログ経路へ寄せた瞬間に2件出た。どちらも「テストは緑なのに実態は壊れている」型。

---

### 6.361 feat(dsl): instrument の差し替えを DSL から（#618 PR-2） (Aug 26, 2026)

**Date**: 2026-08-26
**Issue**: #618（PR-2 = TS 表面 + gated E2E。PR-1 = #621 は daemon 機構）
**Status**: TS **2034 passed** / lint 0 / **実機 gated E2E 7/7 green**（#618 E1-E6 を含む）

#### PR-2 R2: **前の fix が置いた前提が両方とも壊れていた**（Critical + Important・fix 起因）

前の fix は2つとも「**ユーザーが気づいて再評価すれば収束する**」を前提に台帳を忘れる判断をした。
その前提が両方とも成立していなかった:

| 前提 | 実際 |
|---|---|
| ノート drop の警告で気づく | `warnOnce` の dedup が `stopAll()` まで残り、**2回目以降は完全に無音** |
| 次の `ui()` で収束する | 「already open を成功扱い」が**セッションを登録しない** → 簿記は空のまま |

1件目は、**前ラウンドで Critical と認定した「気づけない」状態を、今回追加した警告自身が
2回目以降は出せないという形で再生産**していた。

2件目は **#619 で main が書いたコードの欠陥**。当時は fast-path があるので
「既に開いている＝簿記にある」が前提だったが、簿記を忘れる経路を作ったことで
「簿記には無いが実際には開いている」状態が生まれ、そこを通ると `close_plugin_ui` が
**「もう閉じている」という誤った診断**で落ちる（実際にはまだ開いている）。

**ポリシー**: 「復旧できる」と主張する設計は、**その復旧経路が実在することまで含めて成立する**。
忘れる判断自体は正しい。**忘れた後の回復経路を実在させる**のが修正。

- `markPluginInactive()`: 非活性化のたびに `pluginInactive:<instance>` の dedup を落とす
  （「1回の非活性化につき1回警告」の意味論）
- `recordPluginUiSession()`: already-open を成功扱いした時に簿記を戻す。
  これにより **MCP の明示 close 等、別経路の stale も次の open で収束する**

**main 独自の変異**: 再 arm を外す → 新テスト red / セッション登録を外す → 新テスト red。

分類テストが新設ヘルパ `recordPluginUiSession` を捕捉（**今日3度目**）。内部 API として登録。

#### PR-2 レビュー: Critical 1（2つの帳簿が同じ不確実性に逆の判断をしていた）

silent-failure-hunter が発見。**差し替えが transport 失敗（daemon が commit したか不明）で
終わったとき**:

| 層 | 挙動 |
|---|---|
| TS 側 `chains`（`effect-slot.ts`） | `delete` して**忘れる**（再宣言で収束させる設計） |
| engine 側 `loadedPlugins`（respawn 復元キャッシュ） | **旧 A の spec を保持したまま** |

この後 daemon が respawn すると復元キャッシュが**旧 A で loadPlugin を再発行して成功**する。
音が戻るので正常に見えるが、**鳴っているのは B ではなく A**。reload 自体は成功しているので
`get_log` にエラーも警告も残らない ＝ **気づけない**。

**ポリシー**: 2つの帳簿は、同じ「不確実性」に対して**同じ判断**をしなければならない。
片方が「不明だから忘れる」と決めたのに、もう片方が「旧のまま覚えている」と、
**復元時に古い方が黙って勝つ**。

これで Critical-1（復元キャッシュ）と Important-2（曖昧な UI close 失敗で簿記が stale になり
`seq.ui()` が恒久 no-op ＝ **#619 と同型**）が同じ規律で塞がる。
UI 簿記の破棄が安全なのは、**#619 R4 で入れた「child の already-open を成功扱い」**があるため
（実はまだ開いていた場合も次の `ui()` が収束する）。

**Important-3（quarantine 警告の実機到達性）は今回対応しない**: quarantine を実機で誘発するには
drain ack のタイムアウトが要り、gated E2E で決定論的に作れない。機構は既存の warn 経路と同一。
理由をコードコメントに残した。

**main 独自の変異**: `loadedPlugins.delete` を外す → 新テスト red /
`forgetPluginUiSession` の呼び出しを外す → 新テスト red。
分類テストが新設ヘルパ `forgetPluginUiSession` を捕捉して落ちたので内部 API として登録
（**逆方向テストが2度目の仕事をした**）。

#### 🔴 E2E が実機でしか出ない欠陥を捕まえた（owner 強調「e2e もちゃんとやってね」）

E2 が「差し替えで ERROR ログが増えない」で落ちた。増えていた ERROR の正体:

```
[orbit-vst3-instrument-child] state restored from "...(8 bytes)"
```

**成功メッセージが ERROR として記録されていた。** child は daemon の stderr を継承する一方
`tracing` 依存を持たず、TS 側の分類器（`isDaemonNonErrorTracingLine`）は
level トークンの無い行を**既定で error 側へ倒す**設計だったため。

**これは PR-2 が持ち込んだ欠陥ではない** — state 付きの宣言・respawn でも同じ行が出るので
以前から ERROR カウントを汚していた。**ERROR 数をヘルスシグナルにする E2E を書いて初めて気づいた。**

修正: **child にも level トークンの規約を与える**（`LEVEL [orbit-*-child] ...`）。
成功行だけ `INFO` を名乗らせ、分類器はその形のみ非エラーとして認める。
level を名乗らない行・`ERROR`/`WARN` を名乗る行は従来どおり error 側（`plugin.process() failed` 等）。
child crate に tracing 依存を足さずに済む最小の形。

変異検証（両方向）: 規約の行を**外すと** red / パターンを**緩めて level 無しも通すと** red。

#### E2E は「何が鳴っているか」まで見る

Codex が**ブリーフの弱点を報告**してきた: 指定した CLAP/VST3 oracle は定常出力が
どちらも `sin * 0.25` で **RMS がほぼ同値**なので、「RMS が有意に異なる」は偽のアサーションになる。
代わりに VST3 の +7 半音 state を使い**基本周波数**で識別する形に変えていた。

```
E1/E2/E4/E5 の RMS > 0.03（非無音）/ E3 < 0.005（無音）
|e2Hz - e1Hz| / e1Hz > 0.25    音が「変わった」
|e4Hz - e2Hz| / e2Hz < 0.02    失敗後も B が鳴り続けている
|e5Hz - e1Hz| / e1Hz < 0.02    音色ループで A が戻った
```

E4・E5 は RMS では区別できず**周波数でしか証明できない**。指示より良い設計。
併せて旧 child の **PID 消滅**と `pluginChildPids(CLAP) == []` も確認している。

#### E2E 自体の変異検証

daemon の commit（`instance_index` 張り替え）を revert してビルドし直し、実機で再走 → **red を確認**。
**ただし発火したのは UI オラクル**（`open_plugin_ui` の target 解決）で、音のアサーションではない。
音の解析は capture 停止後の最後に走るため、手前のオラクルが先に落ちる。
**「E2E が変異を検出する」は成立したが、「音のアサーションが検出した」とは言えない**（事実として記録）。

#### main の検証で 1 件 red → 修正

分類テストが新設 private メソッド `prepareInstrumentReplacement` を捕捉して落ちた
（**逆方向テストが設計どおり機能**）。DSL から到達しない内部 API として登録。

---

### 6.361 feat(engine): instrument 差し替えの TS 表面 + gated E2E（#618 PR-2） (Aug 26, 2026)

**Date**: 2026-08-26
**Issue**: #618（PR-2 = TypeScript engine 表面・DSL orchestration・実機 E2E）

- `ReplacePlugin` を daemon client / `RustEnginePlayer` / `AudioEngine` へ公開し、成功後の
  respawn cache と active 状態を新 spec へ更新
- instrument 宣言だけが opt-in する `EffectChainMap` 差し替え経路を追加。他の effect 3 manager の
  1-slot 制約と `EffectSlotLimitError` は維持
- UI close → 旧 state 自動保存 → atomic replace → chain commit を直列化。daemon 明示拒否では旧 chain
  を保持し、transport 例外では次の `ReplacePlugin` ensure で収束する
- document directory 未設定と隔離 slot をユーザー可視 warning にし、旧音色の project.yaml 登記と
  新音色の state fallback 復元を接続
- T1–T11 の unit と format 跨ぎ（CLAP → VST3）の gated E1–E6 を追加

### 6.360 feat(daemon): instrument 差し替えの daemon 機構（#618 PR-1） (Aug 26, 2026)

**Date**: 2026-08-26
**Issue**: #618（PR-1 = spec delta + Rust daemon 機構。DSL 表面は PR-2）
**Status**: **daemon lib 175 passed / 0 failed**・R1-R11 全件実走・clippy 0・fmt OK・
変異検証は Codex 側 11 種 + **main 独自 6 種**

#### owner 提起で「note-off 先出し」を撤回した

> 切り替え時やインストルメント削除の時にノートオフ先出しだけど、これ、本当に必要か確認して。

調査の結論は **不要**（詳細は issue #618 のコメント）。要点:

- note-off は楽譜由来のイベントとしてスケジュール済み。旧 child は kill でプロセスごと死ぬので
  **鳴りっぱなしは原理的に起きない**
- 先出しすると、新インスタンスのロード失敗時に「旧は保持されるのに音だけ消えた」となり、
  spec の失敗モデル（prepare→commit・失敗時は旧が無傷）が壊れる
- DAW 調査で報告される stuck note は「同一インスタンスの deactivate → reactivate」か
  「生きている別の宛先への再ルーティング」で、**完全破棄のケースは含まれない**

**統一原則**: 強制 note-off が要るのは note の**発生源**が offTime より前に止まる場面
（#606 / MUTE / LOOP 除外 / play() 差し替え）であって、**宛先**が変わる場面ではない。
これにより #618 は **#606 への依存が消えた**。

#### 設計: main の (A) 推奨を設計者が一次ソースで覆した

`reset_after_child_exit` の SAFETY 注記が「旧 child の死亡確認後なので競合しない」と明記しており、
**1 slot = 1 shm = 1 child**。同一スロットでは prepare→commit が原理的に成立しない。
→ **(B) 予備スロットに立てて `instance_index` の指す先を張り替える**方式を採用。
commit = map の書き換え。commit 前に旧側を一切触らないので「失敗 = 何も起きなかった」が構造的に成立する。

#### main のレビューで設計の穴を1件塞いだ

設計 §3.3-a の「100ms ドレイン待ち・進まなければ諦めて続行」は**タイミング推測 + サイレントな諦め**だった。
note ring は **in-process の rtrb（slot 所有・tenant をまたいで生存）**で `reset_child_starting` の
対象外なので、諦めた場合に残渣が次のテナントへ届く。

→ 同じ PostProcessor にある**決定論的 ack ハンドシェイク**を使う形へ変更:
`engaged=false` → drain-and-discard 要求 → **状態で待つ** → タイムアウトなら loud に警告し
**その slot を free-list へ返さない**（隔離）。
残渣は旧 child へ**届けず捨てる** — 旧 child は直後に死ぬので届ける意味がなく、
届けようとしていたのは note-off 先出し思考の残滓だった。

#### 🔴 受け入れ検証で main が2つの穴を発見（effort ではなく受け入れ基準の不備）

**設計 §10 の失敗モード一覧と §9 のテスト表が突き合わされていなかった。**

| 変異（main 独自） | 当初の結果 | 対応 |
|---|---|---|
| Closed の spare を free-list へ返す | **全件 green**（穴） | **R10** 追加 → 再変異で red 確認 |
| teardown が respawn を誘発 | **テスト自体が無い**（穴） | **R11** 追加 → 再変異で red 確認 |
| commit を prepare の前へ | 6 件 red | — |
| `reset_control_run` を外す | R3 のみ red | — |
| `engaged=false` の順序を崩す | 全件 green | **観測不能と判断しテストは足さない** |
| supervisor の Drop を起こさせない | R11 + R1 red | — |

Closed の spare は `spawn_outproc_supervisor` 失敗時に生じ、**shm が unlink 済みで再利用不能**。
free-list へ返すと次のテナントが必ず失敗する。ガードは実装されていたが**テストが無かった**。

**教訓**: Codex は渡されたテスト表を過不足なく実装した。抜けていたのは受け入れ基準の側であり、
effort を上げても防げない類。**設計の失敗モード一覧の各項目にテスト行があるか**を
工程②（設計チェック）の必須項目にする。

#### /simplify（4観点並行）— 7件適用・変異検証で穴を1件発見

**3エージェントが独立に同じ重複を指摘**（slot 割当ロジックが2関数に逐語コピー）。
しかも既にエラー文言が `"all assigned"` と `"assigned or unavailable"` に分岐しており、
**ドリフトが始まっていた**。

| 適用 | 内容 |
|---|---|
| `allocate_slot` / `free_slot` | 割当と free-list 返却を `OutProcInstrumentControl` のメソッドへ集約 |
| **`detach_and_reset_control_run`** | **detach → reset の順序（安全条件）が2箇所に手書きだったのを集約**。既存の `retryable_attach_failure` からも呼ぶ |
| `SlotSignals` | 4つの `Arc<AtomicBool>` を構造体へ。**9引数コンストラクタと新規 clippy 抑制を解消**（同型引数は順序を間違えても型検査を通る） |
| `bus_param_invalid_for_instrument_role` | ReplacePlugin も既存純関数を使う |
| `SlotFixture.engaged` / `test_instrument_control` | テストのボイラープレート集約 |

**Altitude が「instrument 専用スコープは正しい」を実コードで裏取り**: effect スロットは
bus 名でグラフに焼き込まれ、「名前→slot の間接層」も「再利用できる空き slot」概念も存在しない。
いま `OutProcRole` へ持ち上げるのは呼び出し元1つでの早すぎる汎化。

**見送り**: RT フラグの状態列挙化（RT 意味論を変えるため別 issue）/ `lock_instrument_control`
（14箇所・差分外）/ `wait_until` 集約（本 PR 起源でない）ほか。

#### 🔴 main の変異検証で `free_slot` の不変条件が無防備と判明

| 変異 | 結果 |
|---|---|
| `SlotSignals` の drain / teardown フィールド取り違え | 5件 red（構造体化で検出力は落ちていない） |
| `allocate_slot` が free-list を再利用しない | 2件 red |
| **`free_slot` の二重登録ガード削除** | **全件 green**（穴） |

破れると **1つの slot が2テナントへ同時に払い出され、同じ shm を共有した child が2本立つ**。
抽出が生んだ穴ではなく**抽出前から呼び出し側2箇所に手書きされていた無防備なガード**だが、
名前が付いた今ならヘルパを直接テストできるので `free_slot_never_lists_the_same_index_twice` を追加。
LIFO 再利用順と「slots が空なら未割当プールから払い出さない」も同時に固定。
**ガード削除・LIFO→FIFO の2変異で red を確認済み。**

#### レビュー ラウンド1（Sonnet 4名 + Fable 監査を並行）: Critical 1 + Important 12

**Fable と Sonnet 陣の指摘は1件も重複しなかった**（前者=差分に無いもの、後者=差分に在るものの正しさ）。

| 出所 | 指摘 |
|---|---|
| silent-failure-hunter（**Critical**） | `replacements_in_flight` が commit ブロックの `?` 2箇所・teardown 後の `?`・パニックで漏れる。漏れるとその instance は**永久に**「already in progress」を返し、**この分岐にだけログが無く**復旧は daemon 再起動のみ = **気づけない** |
| code-reviewer | 同 Critical を独立再発見 + `allocate_slot()` 直後の `upgrade()` 失敗で **`spare_index` が漏れる** |
| **Fable F1（最重要の不在）** | **freed slot が前テナントの痕跡を持ち越す**: `VoiceTable`（reset は respawn 検知のみ・差し替えでは `respawn_count` が増えない）/ `measurement_invalid`（**`store(false)` が crate 内 0 件**）/ `probe_live_count`。**壊れた plugin を差し替えると計測無効フラグが無実の新テナントへ移り daemon 再起動まで消えない** = 差し替えの主用途でちょうど発火 |
| Fable F2 | `ReplacePlugin` に instrument-only build のパリティガードが無い（`LoadPlugin` にはある・#542 方針） |
| Fable F3 / comment-analyzer | spec の「commit の直前に保存」が wire 表面で実現不能 / docstring が失敗分岐を過小記述 |
| pr-test-analyzer | ensure 意味論の4分岐のうち**3つが未テスト**（特に冪等 no-op 分岐は削除しても1件も落ちない） |

#### ポリシー先行で一括適用（指摘単位のローカルパッチは禁止）

> **スロットは資源のバンドルである。** 差し替えは respawn と同型のイベント。(1) 取得と解放は
> 早期 return とパニックを跨いで対にする（RAII）(2) 前テナントの痕跡が残らない状態でのみ
> free-list へ返し、戻せないなら隔離する (3) ログにしか出ない失敗はサイレント障害として扱う

- `InstrumentReplacementReservation`（RAII）: in-flight と spare_index を**1つの予約**として表現。
  `Drop` が `ChildSlot` の4状態を分岐し、`Active`（spawn 済み未 commit）なら teardown まで実行、
  失敗すれば隔離してログを出す
- **`tenant_generation` を新設**（Codex の判断で main のブリーフを訂正）。main は
  「`respawn_count` を進めて既存 resync に乗せよ」と指示したが、**それは R11（teardown が respawn を
  誘発しない）が固定している診断値そのものを壊す**。別カウンタなら VoiceTable のリセット経路を
  再利用しつつ診断を汚さない
- `InstrumentSlotTeardownFailure` enum: 失敗理由を `bool` から構造化
- ensure 4分岐 / reset 失敗分岐 / bus ガードの配線 のテストを追加

#### 🔴 main の受け入れ検証で flake を1件発見（Codex は 186 passed と報告）

`r7_replacement_supervisor_respawns_the_new_plugin_spec` が**フルスイート6回中1回**失敗。
失敗時の args は `"--shm\n<path>\n"` だけで**プラグインのパスが書かれる前**の中身だった。
待機条件が `exists()` なのに fixture が `printf ... > file` で直接書いており、
**作成直後・書き終える前**を読んでいた。

- **単体では再現しない（0/40）** — フルスイートの並行負荷でのみ窓が開く。
  単体で測って「直った」と結論していたら誤判定だった
- 修正: fixture を**原子的な公開**へ（temp へ書いて `mv`）。`exists()` が「書き終わった」を意味するようになる
- **フルスイート24回で失敗0**

#### main 独自の変異検証（6種）

| 変異 | red になったテスト |
|---|---|
| RAII ガードの `Drop` を無効化 | R2 / R5 / R10 + `replacement_reservation_releases_in_flight_on_unwind` |
| commit の defuse を外す | R1 / R3 / R8 + reset 失敗テスト |
| `measurement_invalid` のクリアを外す | `tenant_handoff_resets_voice_bookkeeping_and_sticky_health` |
| `tenant_generation` を進めない | 同上 |
| RT 側が `tenant_generation` を見ない | 同上 |
| パリティガードの条件を殺す（**instrument-only build で**） | `replace_plugin_instrument_only_rejects_unsupported_instance_and_state` |

最後の1件は**両 feature で走らせて全件 green になり**、そのガードが instrument-only でしか
コンパイルされないことに気づいて構成を変えて取り直した。**変異が無効だったことに気づけたのは
「red にならなかった」を疑ったから。**

#### ラウンド2（fix-scoped 縮小レビュー）: Important 1件（**fix 起因**）

RAII 化の副作用で、**成功パスの in-flight 解除が `free_slot` と別ロックに分かれた**。
fix 前は1つのロック区間で両方やっていたが、fix 後は `commit_spare()` が in_flight を触らないため
**Drop が唯一の解除者**になり、最終ガードが落ちてから Drop がロックを取り直すまでの窓で、
同一 instance への並行 replace が「already in progress」で**偽に弾かれる**。

→ 成功パスの最終ガード内でも `replacements_in_flight.remove` を呼ぶ（`HashSet::remove` は冪等なので
Drop 側は失敗・パニック時の安全網として残す）。

**この指摘は変異検証で検出できない**（窓は関数内部にあり、呼び出し元から観測すると Drop は
必ず return 前に走るため、既存アサーションはどちらでも通る）。**並行スレッドからのみ観測可能**な
性質なので、テストを足すより不変条件をコメントで固定する方を選んだ。

#### ラウンド2 で「新規故障モードなし」と確認された点

- `Drop` はパニックしない（`lock_child_slot_recovering` は poison を recover・`unwrap()` なし）
  → 二重パニック→abort の懸念なし
- **ロック順序**: `reservation` が全ガードより前に宣言されているため、Rust の drop 順（宣言の逆順）で
  ネストしたガードが必ず先に落ちる。早期脱出4箇所を1つずつ辿って自己デッドロックなしを確認
- `Drop` は `spawn_blocking` のブロッキングプール上でのみ走り、**RT スレッドから呼ばれる経路はない**
- `tenant_generation` の `Relaxed` は `respawn_count` と同じ既存パターン

#### 検証コマンドの落とし穴

`cargo test -p orbit-audio-daemon` だけでは **33 tests しか走らず R1-R11 は feature gate で1件も実行されない**。
`--features outproc-effect,outproc-instrument` が必須。
Codex 報告（173）と main のベースライン（33）の食い違いで気づいた。

---

### 6.359 fix(engine): respawn 後の stale セッション簿記を解消し冪等 open を1箇所に集約 (#619 R2) (Aug 26, 2026)

**Date**: 2026-08-26
**Issue**: #617（PR #619 のレビュー Round 2 対応）
**Status**: **2019 passed / 0 failed**（+5）・**gated E2E 6/6 green**・lint 0・変異検証 4 種すべて 1 対 1 で red

#### Round 2 の指摘（Critical）は正しかった

`seq.ui()` の冪等ガード（`hasOpenPluginUi`）が **daemon respawn 後に stale になる**。
respawn はセッション簿記を意図的に残す設計（「次の open が上書きする」で回収）だったが、
冪等ガードがその回収経路自体を塞ぎ、**恒久的なサイレント no-op** になっていた。

#### 修正: 規則を 1 箇所（`openPluginUiIdempotent`）に集約し 3 層で防御

1. **fast path**: 簿記にあれば no-op（daemon に行かない）
2. **staleness 対策**: `setPluginUiClosedByRespawnListener`（`setPluginUiSafepointSaver` と同じ配線パターン）で、
   respawn が UI を閉じた瞬間に Global がセッションを破棄
3. **race の防御**: 判定後の隙間で child が「already open」を返したら成功扱い（権威は child の状態機械）。
   **already-open 以外は throw する**テストも置き、何でも飲み込む方向に倒れないことを固定

`//#pluginUi`（MCP 経由）と `seq.ui()` の両方が同じ実装へ委譲する（「同じ判定に規則を2つ持たない」）。

#### R2 のもう1つの指摘: stub 越しのテストを実装検証に置き換え

`hasOpenPluginUi` を stub していたテストを、**実セッション map + 実リスナ登録**を通す形に変更。
player 側（イベント→リスナ呼び出し）と Global 側（リスナ→セッション破棄）の両方の継ぎ目にテストを配置。

#### 変異検証（4 種・検出が 1 対 1）

| 変異 | red になったテスト |
|---|---|
| Global のリスナ登録を外す（Critical の再導入） | respawn 破棄テストのみ |
| player のリスナ呼び出しを外す | player 側テストのみ |
| already-open の catch を外す | race 防御テスト 2 件のみ |
| fast path を外す | no-op テスト 2 件のみ |

#### Round 3（fix-scoped・1レビュアー）: Critical 1件 → 修正済み

catch の第2文言 `OPEN_UI requires state == Closed` は **Rust 単体テストの assert メッセージ**で、
wire を流れる実エラーではなかった（レビュアーが rust/ を grep して発見・main が一次ソースで裏取り）。
child の UiCloseStateMachine が実際に返すのは `CLOSING_IN_PROGRESS_DETAIL = "closing-in-progress"` で、
`CommandMailboxError::CommandFailed` の Display 経由で TS に届く。**「捏造した mock 文言」
アンチパターンに自分で該当**していた — テストが実装の想定文言をそのまま写していたため検出不能だった。

- 修正: マッチ文字列を `closing-in-progress` に置換・コメントの「実機で実測」の主張も
  実際に実測した host 側エラー（`OPEN_UI requested while lifecycle is`）に訂正
- テストの mock 文言を実 Display 形式（`plugin state mailbox command 7 failed (result=2): ...`）に置換
- 変異検証: 2 つのマッチをそれぞれ外し、対応テストのみが red（1 対 1）

#### Round 4（fixer 差分の再点検）: R3 fix 自身が新しい Critical を持ち込んでいた

R3 で採用した実文言 `closing-in-progress` は、Rust 側 `open_command` が **OR 条件で3つの異なる
拒否理由を1つの文言に潰していた**: (1) state == Open（目的達成・成功扱いで正しい）
(2) state == Closing（UI は閉じていく・開いていない）(3) Closed だが ring 未 drain（開いていない）。
(2)(3) を成功扱いすると「開けなかったのに開いたことにする」本物のサイレント no-op になる。
さらに host 側マッチ `lifecycle is`（無限定）も同型の欠陥で `lifecycle is Closing` を飲んでいた。

**修正は Rust 側の根本から**（意味が違うものは wire でも違う文言にする）:

- `orbit-child-ui`: `ALREADY_OPEN_DETAIL = "already-open"` を新設し、`open_command` が
  state == Open では `already-open`、Closing / ring 未 drain では従来どおり
  `closing-in-progress` を返すよう分離（duplicate_open の rust テストも追随）
- TS 側は `already-open` と `lifecycle is Open`（`Opening` の前方一致を兼ね、`Closing` は
  不一致）のみ成功扱い。`closing-in-progress` / `lifecycle is Closing` は throw
- テスト +3（Closing throw / closing-in-progress throw / Opening 前方一致の裏取り）
- 変異検証 4 種（マッチを広げ戻す×2・外す×2）すべて対応テストのみ red

#### 保留（意図的）

- **Opening 同時 open race**（R4 最終再点検で確認・意図的受容）: `lifecycle is Opening` を
  成功扱いにするため、並行 open の先行者が最終的に失敗した場合、後続側は「開いた」と
  信じたまま resolve する。ただし先行者の失敗は先行者自身の呼び出し元に本物のエラーで
  届く（完全なサイレントではない）。二重待ち合わせ機構は detail 意味分離のスコープ外。
- **第3の「already open」信号**（既存挙動・fix 対象外）: プラグイン GUI 層自身が返す
  `editor GUI/view is already open`（スペース区切り）は、状態機械と実ウィンドウの食い違い
  でしか到達せず、TS のマッチに当たらず loud に throw される。保守的な既定として維持。
- `getSize` の許容コード（`kNotInitialized` のみ）が Kontakt 1 機種の実測に基づく点は R2 Important のまま維持。
  他プラグインが別コードを返した場合はコードを名指しした loud なエラーになり、その時に意図的に許容へ足す。
- ついで修正: `audio-slicer.spec.ts` の import/order warning（既存・1 行）と、
  分類テストへの `openPluginUiIdempotent` 登録 2 箇所。

---

### 6.358 feat(dsl): 楽譜からプラグイン UI を開く `seq.ui()` + Kontakt の controller fallback (#617 / #603) (Aug 26, 2026)

**Date**: 2026-08-26
**Issue**: #617 / #603
**Status**: **2014 passed / 0 failed**（着手前 1962・**+52**）・**gated E2E 6/6 green**・lint 0・`cargo clippy` 0・`cargo fmt` 0
・Rust host lib 9 passed・**実機で Kontakt の UI open/close/再open/2声同時を確認**

#### 🔴 gated E2E を実行して、main に潜んでいたプロダクトバグ2件を発見

**owner 指示で Fable に調査・修正を委譲**（通常は監査専任だが明示指示による例外）。
判断材料をブリーフ（97行）にまとめて渡した。

##### まず: main が既に赤かった

`git checkout main` して同じ E2E を回すベースラインを取った:

| 対象 | 結果 |
|---|---|
| **main（`5225a55a`）** | **3 failed / 3 passed** |
| 本ブランチ（修正前） | 3 failed / 3 passed（**失敗理由も完全一致**） |

**本ブランチは1件も壊していない。** red は本日マージした **PR #616** が入れたもので、
**CI は gated E2E を走らせないため誰も気づかなかった** — マージ前に実行していれば捕まえられた。

##### 真因は2件のプロダクトバグ + 2件の連鎖

Fable が**実測で独立性を先に確定**させた（テスト1の真因だけ直したら、他2件が無修正で green
= テスト1が `stop_engine` 前に abort してエンジンを汚す連鎖だった）。

**(a) `{"evalMark"` が log filter から漏れていた（#614 の抜け）**

`{"savePluginState"` / `{"pluginUi"` は除外済みなのに `{"evalMark"` が漏れており、
**診断本文ごと log ring に転写**されていた。1回の attach 失敗が `get_log` に2回現れ、
ERROR の前後比較が全部ずれる。

**(b) daemon の INFO tracing が `ERROR:` として記録されていた（#605 の抜け）**

#605 の「起動後 stderr 転送」が全行 `console.error` に流していたため、
`INFO orbit_audio_daemon: listening on ...` のような**正常ログが ERROR として計上**されていた。

🔴 **この行は本日のセッション中、実機確認のたびに目にしていた。** ERROR 件数を数える場面も
あったのに、**INFO が ERROR として出ていることに気づかなかった**。`get_log` の ERROR 前後比較は
**LLM の自己検証手段**でもあるので、ノイズで埋まると本物のエラーが埋もれる。

対処は ANSI を剥がして ISO timestamp + level token で判定し、
**読めない行（panic・生 print）は fail-loud に error 側へ倒す**。

**(d) RMS 許容 2% → 3%（測定の揺れ・故障ではない）**

無故障時 delta の実測分布 {0.17, 0.21, 0.62, 2.09, 2.14, 2.15}% は**二峰性で符号も両方向**、
pre 側の capture も揺れる = **キャプチャ窓の量子化（kick 1発ぶん）**であって復元劣化ではない。
2% はこのクラスタの内側で、**クリーンな状態でも5回中2回落ちていた**。

3% の根拠は**実測アンカー2点で挟むこと**: 最小実故障 4.11%（#587 実測）は 3% でも red /
最悪ノイズ 2.15% の 1.4 倍上。旧コメントの「noise floor 3.4e-6」は**再起動なし連続キャプチャ**の
値で、この比較には当てはまらない旨も注記に修正した。

##### 私（main）が先に直していた2件も正しかった

`instSeq.instrument(別プラグイン)` の差し替え拒否と `global.effect("nonexistent")` の
attach 失敗は、**#614 で `isError: true` が返るようになった**ための陳腐化。
テスト側を新しい意味論へ合わせるのが正しく、green で検証済み。

##### 別 issue に切り出したもの

**#620: 診断の誤帰属**（#614 の構造的な抜け）。`pendingDiagnostics` はマーカー間の
グローバル蓄積なので、**マーカー無しの投入経路（`run_selection`）が出したエラーが次の
`evaluate_orbitscore` の応答に付く**。LLM が「自分のせい」と誤認する。設計判断が要るため
本 PR では直さない。🔴 **着手時はまず実機で再現させること**（構造からの推論であり未観測）。

##### 補足: E2E 起動失敗の環境要因（ソケットパス 103 文字制限）

Fable の green を main が再現しようとしたら**アプリが起動しなかった**。`--verbose` を付けて
観測したところ一発で判明:

```
WARNING: IPC handle "...(scratchpad の長いパス).../1.12-main.sock" is longer than 103 chars
```

**Unix ドメインソケットのパスは macOS で 103 文字まで。** E2E に渡す `TMPDIR` を
scratchpad 配下（115 文字超）にしていたため、アプリがシングルトン用ソケットを作れず
起動中に死んでいた。**短いパス（`/tmp/claude/e2t`）に変えたら即起動**して 6/6 green。

先に疑った署名エラー（-67062）・プロセス衝突・Gatekeeper は**すべて外れ**。
[[escalation-does-not-fix-opacity]] — 見えない問題は推測を増やさず観測を足す
（`--verbose` 1 個で解けた）。**gated E2E の実行手順として「TMPDIR は短いパスを使う」を
ここに記録する。**

##### 検証

- **gated E2E 6/6 green（Fable 連続2回 + main 自身の再現1回）**
- `npm test` **2014 passed / 34 skipped / 0 failed**
- 変異検証: filter 除去 → red / INFO 判定を常時 true → 2 red・常時 false → 1 red

##### 併せて掃除したもの

`packages/engine/src/core/global.ts.backup`（2月付の残置バックアップ）が git 追跡されていた。
参照ゼロを確認して削除。

#### `/simplify` — 🔴 既存 provider との二重表示を発見

4エージェント（reuse / simplification / efficiency / altitude）を並行起動。
**altitude が最も重い指摘を出した。**

##### 🔴 同じ面に既に持ち主がいた

`extension.ts` の `completionProvider`（本作業より前から存在）が**すでに `.` を
トリガーに登録**しており、メソッドチェーンの文脈に応じて絞り込んだ**スニペット候補**
（`tempo(${1:120})` 等）を返していた。私はそれを確認せずに2つ目を足した。

実測で重複を確認:

```
OLD[global.]: beat,tempo,quantize,audioPath,gain,compressor,limiter,normalizer,
              effect,instrument,output,sum,aux,linkAudio,run,loop,stop
```

`global.` と打つと `tempo` が2つ（スニペット版とプレーン版）並ぶ状態だった。

##### ポリシー（指摘単位のパッチにしない）

> **「ドットの後のメソッド補完」の持ち主は既存 provider。** 既存は**文脈で絞る**という
> こちらに無い機能を持つので壊さない。新 provider は **既存が返さなかった語彙だけを補う**。
> 既存は手書きの候補表で語彙テーブルと同期していないため `ui`（#617）が出ない —
> その穴を埋めるのが役割。

`getContextualCompletions` の結果を除外集合として使い、二重表示を構造的に防いだ。
**二重が出ないこと自体をテストで固定**した（`overlap` が空であることを assert）。

##### 採った指摘

| 角度 | 指摘 | 対応 |
|---|---|---|
| **altitude** | **既存 provider と二重表示** | 除外フィルタ + 二重を禁じるテスト |
| altitude / simplification | 識別子を context と provider で**2回パース**し、**2つの正規表現が食い違う**（実測: `a.b.` は context 不発火・provider は `b`） | context に `identifier` を載せ、provider の正規表現を削除 |
| reuse | 宣言抽出3関数がデータ違いの重複 | `extractVarDeclarations(source, rhsPattern?)` に統合（既存の `extractTopLevelDeclaredNames` も寄せた） |
| simplification | Rust の二重 terminate の説明が3箇所で言い換え | `should_terminate_controller` に集約し、他はそこを指す |
| simplification | モックの `Text: 0` が未使用 | 削除 |

##### 採らなかった指摘

- **`setPluginUiHandler` をコンストラクタ引数へ** — 既存の
  `MidiManager.setPluginOutputFactory` と**同型**であり、reuse レビューも
  「正しい precedent の踏襲」と評価している。一貫性を崩す方が高くつく
- **`dsl-method-catalog.ts` を `require('../engine/dist/...')` に置換**（altitude 提案）
  — 検討したが**採らない**。同ファイルの既存 `require` 2箇所は
  **fallback を持つ**（失敗しても動く）のに対し、補完候補は**空になると機能が消える**。
  現在の「写し + 一致テスト」は乖離を **CI で必ず捕まえる**のに対し、`require` は
  `engine/dist` が無い開発状態で**黙って候補が減る**。トレードが逆
- **既存 `extractDeclaredBusNames` の全文スキャン**（efficiency が発見）— 本 PR が
  触っていない既存コード。記録のみ

##### efficiency は実測で「対応不要」

`document.getText()` + 抽出2本で **0.14ms/キーストローク**（1587行の実作品で計測）。
知覚閾値の3桁下なので、キャッシュも1パス化も入れない。**数値を出して否定した**判断を採る。

##### 変異検証（再実施）

| 変異 | 結果 |
|---|---|
| 二重表示フィルタを外す | **red**（2件） |
| `identifier` を空にする | **red**（4件） |
| helper の `rhsPattern` を無視 | **red**（5件） |

#### 追加: DSL メソッド補完（#495 第1段）

owner 追加要求: 「あと記述の補完も」。

##### 現状の穴

補完 provider は3本動いていたが、**埋まっていたのは文字列の中だけ**だった:

| 文脈 | 実装前 |
|---|---|
| `import { … }` / `import … from "` | ✅ |
| `output("` → sum 名 / `send("` → aux 名 | ✅ |
| `effect("` / `instrument("` → カタログ | ✅ |
| **`seq.` / `global.` / `sum("x").` の後** | 🔴 **無し** |

🔴 **その結果、今回足した `seq.ui()` は補完に出なかった。** engine 側に
`SEQUENCE_DSL_METHODS` という語彙テーブルがあるのに、補完がそれを見ていなかった。

##### 実装

- `dsl-completion-context.ts`: `kind: 'method'` を追加。`sum(...)`/`aux(...)` はその場で
  bus と判定し、変数名は provider が宣言を見て解決する
- `dsl-method-catalog.ts`（新規）: 候補表。**正本は engine 側**で、ここは写し
  （拡張は engine をプロセス境界越しに使う設計。`plugin-catalog-reader.ts` と同じ理由）
- 🔴 **写しの乖離をテストで固定**: engine の語彙と一字一句一致することを検査する。
  DSL にメソッドを足して候補表を更新し忘れると red（`ui` の乖離が実例）
- `extension.ts`: provider に `method` ケースを追加。**`.` をトリガー文字に追加**

##### 🔴 変異検証で2つの穴が出た

**穴1: provider 本体がテストで駆動できていなかった。** 当初は文脈検出だけをテストしており、
provider は `activate()` の中に埋まっていて呼べなかった。#614 の「配線はユニットテストの
視野の外」と同型なので、**`dslCompletionItemProvider` を named export に切り出し**、
`tests/mocks/vscode.ts` に登録捕捉を足して本体を直接駆動するテストを書いた。

**穴2: `.` トリガーを外す変異が生き残った。** provider を直接呼ぶテストでは、
トリガー文字が無くても通ってしまう。しかし実機では**打っても出てこない**。
`registerCompletionProviders` を export し、**登録内容（トリガー文字）を検査**して塞いだ。

| 変異 | 結果 |
|---|---|
| 候補表から `ui` を落とす（乖離の再現） | **red** |
| bus 候補から `ui` を落とす | **red** |
| `sum`/`aux` を bus と判定しない | **red** |
| global を sequence 抽出に混ぜる | **red** |
| 文字列の中でも発火させる | **red** |
| sequence と global の候補源を入れ替える | **red** |
| 未宣言の識別子にも候補を出す | **red** |
| bus 候補を sequence に差し替える | **red** |
| `method` ケースを丸ごと削除 | **red**（5件） |
| **`.` トリガーを外す** | 🔴 **最初は生存** → 登録テスト追加後 **red** |

##### 🔴 変異が適用されたことを毎回検証する

provider を module 直下へ切り出した際に**インデントが変わり**、変異スクリプトのアンカーが
一致せず **変異が一度も適用されないまま「全て green」**になった。危うく
「テストが弱い」と誤診するところだった。以後、変異適用は
`assert s.count(old) == 1` で**適用されたことを確認してから**実行する。

#### owner 要求（2026-08-25）

> DSL から UI を呼び出せるようにして欲しい。それが無いとセッティングするのが大変になる。

SIGMUS のデモは **VST（Kontakt）+ LLM 駆動**で、音色は事前セットする方針。したがって
**準備段階で音色を作って保存する工程**が要る。従来その工程はコンテキストメニュー（#474）か
MCP tool からしか起動できず、**楽譜を書きながら音色を追い込む**流れに乗らなかった。

#### 表面（owner 裁定）

```
cb.instrument("Kontakt 8.vst3")
cb.ui()          // instrument の UI（index 0）
cb.ui(1)         // 1つ目の effect の UI
cb.ui(0, false)  // 閉じる

sum("strings").ui(1)   // mixer bus の insert（既定 index 1）
aux("verb").ui(1)
```

- **レシーバに直接生やす**（`instrument()` / `effect()` と並べて書ける）
- **複数同時オープンを制限しない** — セッティング時に複数パートを並べて見る用途がある

機構は既存の `global.openPluginUi` / `closePluginUi` を**そのまま通す**（新しい経路を作らない）。
`MixerManager` は `Global` を知らない設計（循環参照回避）なので、`Global` 側から
`setPluginUiHandler` で注入した。未注入で `ui()` が呼ばれたら loud に失敗する。

🔴 **DSL 語彙（`SEQUENCE_DSL_METHODS` / `BUS_DSL_METHODS`）への登録を忘れない** — #528 では
ここを落として**ユニットテスト全緑のままエディタ評価が全滅**した。語彙から `ui` を外す変異を
テストが red にすることを確認済み。

#### #603 を同梱した理由

`seq.ui()` だけ入れても **Kontakt では UI が開かない**（実機で `edit controller is
unavailable` を再現）。owner の目的は「セッティングを楽にする」で対象は Kontakt なので、
**分けると「入ったが使えない」状態でマージすることになる**。owner 承認のうえ同梱した。

TEMP パッチ（「1260」の音色選定を完走した実績あり・#603 にコメント保全）は**そのまま当たった**。
issue が挙げていた「正式修正で必要なこと」を実施:

1. **TEMP コメント → 正規 doc**。単一コンポーネント plugin では component 自身が
   `IEditController` を実装するので `getControllerClassId` が失敗する、という機序と、
   **実測（Kontakt 8）で fallback 無しでは開けない**ことを書いた。
   🔴 SDK の条文は bindings に doc が無く C++ SDK が一次ソースなので、**推測の引用は書かず
   実測した事実を根拠にした**
2. **テスト（従来ゼロ）**: 二重 terminate 回避の判定を `should_terminate_controller()` として
   `Drop` から切り出し、実 COM 抜きで検証できるようにした

#### 🔴 変異検証

| 対象 | 変異 | 結果 |
|---|---|---|
| #617 | `seq.ui` の open/close を反転 | **red**（5件） |
| #617 | `seq.ui` の既定 index を 1 に | **red** |
| #617 | bus の receiverId から prefix を落とす | **red**（4件） |
| #617 | **語彙から `ui` を外す**（#528 の再発） | **red** |
| #617 | UI ハンドラの注入を外す | **red**（4件） |
| #603 | 判定を反転（共有時に terminate = 二重 terminate） | **red**（2件） |
| #603 | **常に true（= #603 以前の挙動）** | **red** |
| #603 | 常に false（controller を一切 terminate しない） | **red** |

#### 実機での確認

| プラグイン | `instrument()` | `ui()` |
|---|---|---|
| **Kontakt 8** | ok | **✓ open / close / 再open / 2声同時**（修正前は `edit controller is unavailable`） |
| BM-COZY / BM-DOPE | ok | ✓ 2つ同時に開く |
| 未ロードのスロット | — | ✓ **loud に失敗**（`no plugin instrument is declared`） |
| ARIA Player | ok | `createView returned null`（**プラグイン側の仕様**・エラーは正確に報告される） |

ログの `[vst3-view] getSize failed (5) before attach — using fallback size` は
**#603 が想定した経路そのもの**（attach 前にサイズを確定できない plugin を既定サイズで開き、
attach 後の `resizeView` に従う）。

#### 🔴 環境要因を実装の欠陥と誤認しかけた

2つ目の instrument ロードが **60 秒 timeout**（`OUTPROC_ATTACH_FAILED`）した。実装を疑う
ところだったが、owner の**「音源の USB ドライブを繋いでいなかった」**という指摘で解決。
BM-COZY のサンプルライブラリは `/Volumes/SSD4TB2503/Music/UJAM/BM-COZY` にあり、
**未接続では child が READY を返せない**。接続後は同じ操作が `ok`。

**テストが落ちたらまず実行環境を見る**（同日の CPU 飽和による false red と同型）。

---

### 6.357 fix(engine): #484 D1 argv テストのフレーク解消と、偽の SIGKILL 昇格報告の停止 (#520) (Aug 25, 2026)

**Date**: 2026-08-25
**Issue**: #520
**Status**: **1962 passed / 0 failed**（着手前 1929・**+33**）・全 suite 3回連続 green・lint 0・`cargo clippy` 0・`cargo fmt` 0
・Rust daemon lib 31 passed・**全 suite 計 14 回 green**

土台バンドル（#520 → #567 → #614 → #607）の 1 件目。着手の理由は、
セッション開始時の現状把握で `npm test` を 2 回回したところ **1 回目が fail した**こと。
落ちたのは #520 そのもので、**「全緑」という判定の土台が実際に揺れていた**。

#### 決定論的な再現（負荷待ちをやめる）

#520 は「約3回に1回」「高負荷時のみ」と記録されており、そのままでは fail-before を
示せない。そこで recorder script に `sleep 1` を挿し、**負荷で子プロセスの exit が遅れる
状況を機序として直接再現**した:

```
expected [Function] to throw error matching /daemon exited before ready/
  but got 'daemon ready line timeout after 500ms'
```

セッション開始時に観測した失敗と同一の文言。以後の検証はすべてこの変異で行った。

#### 原因1: 検証対象でない deadline にテストが依存していた

このブロックの検証対象は「argv に何が渡るか」であって「子プロセスが 500ms 以内に
exit すること」ではない。しかし `startupTimeoutMs: 500` が固定で埋め込まれており、
負荷時は **timeout が exit を追い越して別の reject 理由**（`ready line timeout`）になり、
文言まで固定した assert が落ちていた。

deadline は exit 観測で即座に抜けるので、**広くても正常時の所要時間は変わらない**。

当初は定数 `SPAWN_ARGV_STARTUP_TIMEOUT_MS = 10_000` に括り出したが、`/simplify` の
altitude レビューで **production 側に `DEFAULT_STARTUP_TIMEOUT_MS = 10_000` が既にあり、
かつ suite 全体でこのブロックだけが `startupTimeoutMs` を明示していた**ことが判明したため、
**上書き自体をやめて production 既定に委ねる**形に変えた。定数の複製は将来 production 側を
再調整したときに黙って乖離する。「小さい `startupTimeoutMs` を書き足すと戻る」理由は
コメントに残した（#491 と同じ方針）。

#### 原因2: 自然終了した child に SIGTERM を送り、偽の昇格を報告していた

#520 本文が症状として引用していた
`DaemonClient child did not exit within 500ms of SIGTERM; escalated to SIGKILL` は、
**私が触っていない C3 テストでも出ていた**ため別系統として追った。

`killChildGracefully` の早期リターンが `child.killed` のみを見ていた。これは
**「signal を送ったか」しか表さず、終了の有無を含まない**。自力で exit 済みの child に
SIGTERM を送っても `'exit'` は二度と発火しないので、**deadline 満了まで待たされた上で
「SIGKILL へ昇格した」と偽の診断を出す**。start 失敗時の cleanup がこの経路を通るため、
当該テストは実行のたびに 500ms を捨て、かつ診断を誤らせていた。

終了判定を `exitCode !== null || signalCode !== null` に変更。
偽の警告は **3 件 → 0 件**、テスト時間も 840ms → 330ms 台へ。

#### 🔴 変異検証 — 最初のテストは変異を生き残った

| 変異 | 結果 |
|---|---|
| (a) 新ガード（自然終了の検知）を削除 | 🔴 **最初は生き残った** → テスト修正後 **red** |
| (b) argv から `--audio-device` を落とす | **red**（既存 assert の検出力は維持されている） |
| (c1) 起動遅延のみ（production 既定に委ねた状態） | **green** — 負荷に耐えることの確認 |
| (c2) さらに `startupTimeoutMs: 500` を書き戻す + 起動遅延 | **red**（3 件とも） |

(a) が生き残った原因は、`vi.spyOn` の記録を **`mockRestore()` の後**に読んでいたこと。
`mockRestore()` は `mock.calls` ごとリセットするため、**ガードを外しても記録が空のまま
assert が通っていた**。復元より前に記録を取り出す形へ修正して red を確認した。
[[test-name-must-match-the-path-it-drives]] と同型で、名前と経路は正しいのに
**観測点だけがずれていた**ケース。

#### `/simplify` で採った指摘

| 角度 | 指摘 | 対応 |
|---|---|---|
| altitude | `SPAWN_ARGV_STARTUP_TIMEOUT_MS` は production 既定の複製。suite でここだけが上書きしていた | **上書きを削除**し既定に委ねた |
| reuse / simplification | 兄弟 spec（`rust-engine-player.spec.ts:221`）に `warn.mock.calls.some((c) => String(c[0]).includes(...))` の既存イディオムがある | そちらへ寄せ `messages` アキュムレータを削除 |
| simplification | 新規テストが argv テスト2本の**間**に挟まって対を分断していた | 2本の後ろへ移動 |

**採らなかった指摘**:

- **2つの early-return を1行に統合**（`child.killed || exitCode !== null || ...`）— `killed` は
  「signal を送ったか」、`exitCode/signalCode` は「終了したか」で**意味が違う**。統合すると
  「`killed` では足りない理由」を説明するコメントが宙に浮く
- **`isChildAlive()` を共有ユーティリティへ切り出す** — `extension.ts` に同型の述語が
  あるが**別パッケージ**で、共有 child-process ユーティリティが存在しない。1件のために
  パッケージ間の依存を作るのは割に合わない。代わりに **#532 への相互参照をコメントに追加**した

**PR に観察として残したもの**（issue は立てない）: `extension.ts` の `stopEngine` は
自然終了済みプロセスにも無意味な SIGTERM を送る。ただし当該経路は deadline 待ちを
持たないので**偽の診断は出ず、実害は「死んだ PID への1シグナル」に留まる**ため、
[[issue-only-for-real-impact]]（放置したら誰がどう困るかを1文で書けないなら立てない）に従った。

#### レビューラウンド1 — 2名が独立に同じ穴を指摘した

`/code:pr-review-team`（4名）と Fable 監査を並行起動。結果:

| レビュアー | Critical | Important |
|---|---|---|
| code-reviewer | 0 | 0 |
| comment-analyzer | 0 | 0 |
| Fable 監査 | 0 | 0 |
| pr-test-analyzer | **1** | 1 |
| silent-failure-hunter | 0 | **1**（pr-test-analyzer と同一） |

🔴 **指摘の実体**: 新規テストは「自然終了した child で**警告が出ない**こと」しか示していない。
これは **ガードが広すぎても同じ観測になる** — `if (true) return` に変えても、
昇格経路を丸ごと削っても、「警告が出ない」は成立する。
つまり **#520 の元バグが守っていた SIGKILL 昇格そのものには、テストが1件も無かった**。

孤児プロセスの前科（#607 / #448・daemon 19本残留）を持つコードベースでこれは通せない。

#### 対応: ガードの両方向を決定論的に固定する

**先にポリシーを決めた**（指摘単位のパッチにしない）:

> ガードには2方向（自然終了 → 早期リターン / 生存 → SIGTERM→SIGKILL 昇格）がある。
> 両方をユニットテストで押さえ、**判定はログの有無ではなく kill シーケンスの順序**で行う。
> 既存の統合テストは「実経路がガードに到達する」配線検証として残す。

実装は **#532（`extension.ts` の `stopEngine`）で実証済みの fake process パターンを踏襲**した
（`kill()` は `killed` を即 true にするが `exitCode`/`signalCode` は動かさない、という
Node の実挙動を再現する fake）。新しい流儀を発明していない。

🔴 **実 child で SIGTERM を無視させる案は破棄した** — `trap '' TERM` も
`process.on('SIGTERM', () => {})` も macOS 実機で**無視できず死亡した**（実測）。
机上で「効くはず」と書かずに測ったのが正解だった。

追加した3件（+ fake timers で 500ms の deadline を即座に進める）:

| テスト | 押さえるもの |
|---|---|
| 生存 child は SIGTERM → SIGKILL の順に昇格し報告する | 昇格経路の**存在**と**順序** |
| `exitCode` が立つ child にはシグナルを送らない | 第1項 |
| `signalCode` が立つ child にもシグナルを送らない | 第2項（独立） |

#### 🔴 変異検証（追加分・検出が直交した）

| 変異 | red になったテスト |
|---|---|
| (d) ガードを広げすぎる（`if (true) return`） | **昇格テストのみ** |
| (e) `signalCode` の項を落とす | **signalCode テストのみ** |
| (f) ガードを丸ごと削除 | **「送らない」2件のみ** |
| (g) 昇格先を SIGKILL でなく SIGTERM にする | **昇格テストのみ** |

4変異が**それぞれ対応する1件だけ**を落とした。どのテストが何を守っているかが1対1で対応する。

**採らなかった指摘**: pr-test-analyzer の Minor（「コミットが各ブランチを変異検証したと主張
している」）は**誤読**。そのような記述は無い（`git log` で確認済み）。

#### レビューラウンド2 — fix 差分の再点検でもう1つ穴が出た

ラウンド1の修正差分だけを1名で再点検（問いは2つ:「この修正が導入する新しい故障モードは何か」
「新コードはどの実行コンテキストで走るか」）。**Important 1件**:

🔴 **fake の `once` を no-op mock にしたため、「SIGTERM で素直に終了する」経路が一度も
走っていなかった。** `child.once('exit', onExit)` の登録を削る変異も、`onExit` の
`clearTimeout` を削る変異も**全件 green のまま生き残る**。実害は「行儀のよい child まで
毎回 500ms 待たされた上で SIGKILL され、偽の昇格警告が出る」。

対応: fake に **exit ハンドラを記録させて任意に発火**できるようにし、deadline 前に
'exit' を起こす4件目を追加した。

| 変異 | 結果 |
|---|---|
| (h) `child.once('exit', onExit)` の登録を削除 | **red**（新テストのみ） |
| (i) `onExit` の `clearTimeout` を削除 | **red**（新テストのみ） |

Minor 2件（private メソッドへの cast は #532 の前例と厳密には別技法 / fake timer の
理論的リーク）は記録のみ。**「#532 のパターンを踏襲」と書いたのは fake の形についてで、
private メソッドへの到達手段は本ファイル固有**である点を明確化しておく。

#### CI ブロッカー（本 PR とは無関係・owner 裁定で本 PR に同梱）

`main` の Rust CI が **`clippy::result_large_err`** で赤く、**全 PR のマージがブロック**
されていた。`session.rs:643` の `Result<(), tungstenite::Error>` の Err が 136 バイトで、
CI の stable clippy **1.98**（手元は 1.97）で新たに発火する。**本 PR の Rust 変更は 0 件**
なので main 由来と確定（`git diff main...HEAD --name-only` に `.rs` なし）。

owner 裁定は **Err の Box 化**（`#[allow]` や閾値緩和ではなく）。プロジェクト規約
「lint の閾値をコードに合わせて緩めない」に沿う。`Box<T>` は 8 バイトなので閾値 128 を
確実に下回る。呼び出し元は `server.rs:77` の1箇所のみで、`?` の変換は
`impl<T> From<T> for Box<T>` により**呼び出し元の変更なしで成立**した。

#### 🔴 実行環境の飽和で1回 false red が出た（本 PR の欠陥ではない）

作業中、全 suite の1回が `Test timed out in 5000ms` で落ちた。調査したところ
**マシンの `coreaudiod` が 907% CPU（10コア中9）で暴走**しており、CPU idle は 2% だった。
原因は **死んだプロセスの音声出力コンテキスト 65 個が `coreaudiod` に残留**していたこと
（`sudo killall coreaudiod` で解消・load 613 → 56・メモリも 9GB 解放）。

復旧後に測り直すと **43 テスト全体で 1121ms**（飽和時はうち1件だけで 5000ms 超過）、
全 suite 3回連続 green。**環境要因と確定**した。

🔴 **副産物**: 残留していた65個のうち1個を、**24日前から孤児化していた
`orbit-audio-daemon`** が握っていた。**#607（`stop_engine` の child kill 不全）の実害は
「プロセスが残る」ことではなく、`coreaudiod` に音声コンテキストを固定して CPU とメモリを
食わせ続けること**である。土台バンドル4件目の優先度が上がった。

#### CI ブロッカーは1件ではなく2件だった（clippy 1.98 の新規 lint）

`Box` 化を push したら **別の 1.98 新規 lint** が出た:
`clippy::chunks_exact_to_as_chunks`（`tests/capture_realtime_gated.rs:113`）。
CI は `-D warnings` かつ**最初の1件で停止**するので、このままだと1個ずつ出る。

🔴 **手元で再現できていなかった原因は2つ**:
1. 手元の clippy は **1.97**、CI は **1.98**（`rust-toolchain.toml` が無く CI は stable 最新を引く）
2. 手元の実行に **`-- -D warnings` を付けていなかった**（警告がエラー扱いにならず「clippy 0」と誤報告していた）

対処: **CI と同じ 1.98 を名前付きで導入**し（`rustup toolchain install 1.98.0`・既定の
stable は変えない）、**CI と同一の feature 5通り**を一括実行。
さらに **`-D warnings` を外した警告モードで全件を吐かせて**、隠れた指摘が無いことを確認した
（cargo は最初のエラーでそのターゲットを止めるため、エラーモードだけでは背後が見えない）。

**結果: ワークスペース全体・5通りすべてで指摘はこの1箇所のみ。**

修正は clippy の提案どおり `as_chunks::<4>().0.iter()`。副次的に
`try_into().unwrap()` の panic 経路も消えた。**1.97 / 1.98 の両方でコンパイルと fmt を確認**
（`as_chunks` は 1.97 でも安定）。

#### 🔴 反省: push して CI を待つ往復を1回無駄にした

CI が toolchain バージョン固有の lint で落ちた時点で、**即座に同じ toolchain を入れて
手元で再現するべきだった**。push → 待つ → 別の lint、を繰り返すのは
[[escalation-does-not-fix-opacity]] と同型（見えないものに対して試行を増やしても解決しない。
観測手段を先に揃える）。

**follow-up 候補**: `rust-toolchain.toml` での固定。今回の混乱は「CI が stable を無固定で
引く」ことに由来し、Rust の更新が黙って main を赤くする。owner と別途相談する。

#### 🔴 本丸: spawn 系フレークの真因は macOS のセキュリティ評価だった

`-D warnings` を通した後も **全 suite の 2〜3 回に1回**が落ち続けた。落ちるのは
`daemon-client.spec.ts`(#520 の当事者) だけでなく、**一度も触っていない
`plugin-catalog-reader.spec.ts`** と **Rust の `oracle_parity`** も同じだった。
症状はすべて「子プロセスの起動待ちが deadline を超える」。

推論を重ねず **spawn 遅延を直接測った**:

| spawn 対象 | p50 | max |
|---|---|---|
| 既存のシステムバイナリ (`/bin/echo`・120回) | **1.0ms** | **3ms**（100ms 超 0件） |
| 毎回新規作成した実行ファイル (40回) | **93.8ms** | 178ms |

さらに**同一（warm な）実行ファイルでも 40 回に1回ほど停止**する:
実測 **675ms / 3.8s / 9.0s / 24.6s**。CPU は load 2.8・idle 64% の健全時の値。

**原因**: macOS は新規作成された実行ファイルの spawn 時にセキュリティ評価
（Gatekeeper / XProtect / syspolicyd）を行う。テストは temp dir に実行ファイルを
書いて spawn するので、毎回これを払う。裾は数秒〜24 秒に伸びる（裾の原因は未特定）。

**これで全部つながった**:

| 落ちていたもの | 何をしているか | deadline |
|---|---|---|
| `daemon-client.spec.ts`（#520） | recorder script を新規作成して spawn | vitest 5s |
| `plugin-catalog-reader.spec.ts` | 偽 scan バイナリを新規作成して spawn | vitest 5s + 内部 timeout |
| Rust `oracle_parity` | ビルドしたての child を spawn | sandbox first_block 5s |

**#520 / #491 / #529 が個別 issue として追われてきたのは、同じ 1 つの原因を
別々の症状として見ていたからだった。**

#### 対策のポリシー（横断的関心事なので先に決めてから一括適用）

> 1. 実行ファイルの新規作成を **per-test から per-file へ**減らし、作成直後に **1 回だけ
>    空 spawn して評価を済ませる**（warm up）。待つのは**プロセス起動の成功まで**で、
>    exit を待ってはいけない（ハングし続けるフィクスチャがある）
> 2. それでも残る裾に対し、**検証対象でない deadline を実測の裾に耐える値**にする

TS は `tests/helpers/spawn-fixture.ts`（`createWarmExecutable` / `warmUpExecutable` /
`SPAWN_TEST_TIMEOUT_MS = 30_000`）、Rust は `orbit_audio_sandbox::warm_up_executable` に
同じ形で置いた。**新しい流儀を各所で発明していない。**

適用先:

| 対象 | 適用内容 |
|---|---|
| `daemon-client.spec.ts` audioDevice ブロック | `beforeAll` で 1 回作成 + warm up / argv は per-test で削除 / timeout 30s |
| 同 C3 ブロック | 同上 |
| `plugin-catalog-reader.spec.ts` | 実 spawn する3件に warm up + timeout 30s（`spawn` を mock する1件は対象外） |
| Rust `oracle_parity` | `child_exe()` で warm up + `first_block_timeout: 60s` の2段構え |
| Rust `host_child_integration` / `instrument_host_integration` | `child_exe()` で warm up（deadline 5s/2s はそのまま） |

**触らなかったもの**: `protocol.rs` の deadline は tokio の仮想時間と「これ以上メッセージが
来ないこと」の否定的 assert で、child spawn とは無関係。`plugin-catalog-reader` の
`spawn` を mock する1件も実 spawn しない。**deadline が検証対象そのものであるものは広げない。**

#### 検証

- **TS 全 suite 5回連続 green（1934 passed）** — 修正前は 2〜3 回に1回落ちていた
- Rust `orbit-audio-sandbox` + `orbit-vst3-effect-child` 3回連続 **109 passed / 0 failed**
- `oracle_parity` 単体 3回連続 green（正常時 0.38〜0.88s。60s の余裕は通常時のコストにならない）

#### 🔴 #607 を実機で再現し、根本原因を特定して直した

実機 E2E（OrbitStudio を起動し MCP を HTTP で直叩き）で、この PR が直した表面
（偽の `escalated to SIGKILL` = 0 件）を確認した際、**別の重大な事実**が出た:

```
🛑 Engine stopped
🛑 Engine process exited with code 0        ← engine は正常終了している
daemon PID 90513  PPID=1                    ← なのに daemon は孤児化して生存
音声コンテキスト保持者: ALIVE 90513 orbit-audio-daemon
```

**`stop_engine` は成功を報告し `engine_state` も `running:false` になるのに、daemon が
生き残って coreaudiod の音声コンテキストを握り続ける。**

##### 切り分け（推論でなく実測）

1. **拡張の 2 秒 SIGKILL とのレースか？** → engine にだけ SIGTERM を送って確認 →
   **daemon はやはり生存**。レースではない
2. **`quit()` が失敗しているのか？** → `shutdown()` と `DaemonClient.quit()` に一時 probe を
   入れて実機再実行:

```
[PROBE] shutdown entered interpreter=false
```

##### 根本原因

`cli-audio.ts` は `executeCommand()` の**戻り値**で `globalInterpreter` を代入し、
shutdown ハンドラはそれを見ていた。しかし **REPL / test など長時間モードでは
`executeCommand()` は返らない**。`execute-command.ts` のコメント自身が

> `// Note: startREPLMode() never resolves, so this never returns`

と明記している。したがって**拡張が使う live coding（REPL）モードでは
`globalInterpreter` は永遠に `null`**、shutdown ハンドラは `shutdown(null)` を呼び、
`if (interpreter)` ブロックごと飛ばして `process.exit(0)` へ直行していた。
**`audioEngine.quit()` は一度も呼ばれていなかった**（だから SIGKILL 昇格の警告も出ない）。

#448 の `main.rs` コメントが「まとまった graceful-shutdown 配線は本 issue のスコープ外・
別 issue 向き」と書いていた、その別 issue が #607 である。

##### 対策（ポリシー）

> **interpreter は生成した時点で publish する。コマンドの戻り値に依存しない。**

- `cli/active-interpreter.ts`（新規）: `setActiveInterpreter` / `getActiveInterpreter`
- `repl-mode.ts`: `startREPLMode` の `new InterpreterV2()` 直後と `startREPL(interpreter)` の
  冒頭で publish（どちらも返らない関数）
- `shutdown.ts`: `resolveShutdownInterpreter(getInterpreter)` を新設し、戻り値が null なら
  registry へフォールバック。`registerShutdownHandlers` がこれを使う

🔴 **フォールバックは `cli-audio.ts`（top-level・テスト不能）ではなく `shutdown.ts` に置いた。**
最初は `cli-audio.ts` に書いたが、**テストが実コードを通れず変異が生き残った**ため設計を変えた。

##### 🔴 変異検証 — 最初のテストは 2 つの変異を生き残った

| 変異 | 最初の実装 | 修正後 |
|---|---|---|
| (A) `??` フォールバックを外す | 🔴 **生存**（テストが式を手で複製していた） | **red** |
| (B) `startREPL` の publish を削除 | 🔴 **生存**（テストが `setActiveInterpreter` を直接呼んでいた） | **red** |
| (C) `audioEngine.quit()` の呼び出しを削除 | red | **red** |
| (D) 解決の優先順位を逆にする | （未実施） | **red** |

原因は [[test-name-must-match-the-path-it-drives]] と同型 —
**名前は配線を名乗っているのに、駆動していたのは手で複製した式**だった。
`resolveShutdownInterpreter` と `startREPL` を実際に呼ぶ形へ書き直して 4 変異すべてを殺した。

##### 実機での確認

| | 修正前 | 修正後 |
|---|---|---|
| `stop_engine` 後の daemon | 🔴 生存（PPID=1） | **✓ 1 秒で消滅** |
| 残存 daemon | 1 個 | **0 個** |
| 音声コンテキスト | 2（daemon が保持） | **1**（`arkaudiod` のみ・orbit 由来 0） |

**今日の CPU 暴走（coreaudiod 907%・残留 65 個）の発生源がこれで塞がった。**

#### #567: `get_log` の silent truncation を解消

`get_log` は要求値を**黙って** 500 行へ切り詰めていた（リングは 1000 保持しているのに）。
これはエンジン側エラーが現れる**唯一のチャネル**なので、黙って窓を狭められると
呼び出し元は「エラーが無かった」のか「見せてもらえなかった」のかを区別できない。
ERROR 件数の前後比較は窓が固定だと単調でなく、古い ERROR が流れ出るのと同時に新しい
ERROR が入ると**カウントが一致して false green** になる。

- 上限をリング実容量（1000）へ引き上げ
- **切り詰めたら `[get_log] truncated: ...` を先頭行で明示**（通知文言は ERROR カウントを
  汚さない語を選ぶ）
- 選択ロジックを **vscode 非依存の `log-ring.ts` へ切り出した** — `extension.ts` の
  非 export 関数のままでは**テストが実コードを通せない**（今日の教訓）

変異検証: 旧実装へ戻す / 通知だけ落とす / 通知に `ERROR` を混ぜる / 履歴不足でも誤報させる
→ **4種すべて red**。

#### #614: `evaluate_orbitscore` が評価結果を返すようにした

`ok` は「**stdin へ書けた**」しか意味しておらず、パース/実行エラーは stderr へ非同期に
出るだけだった。このプロジェクトは **LLM を第一級ユーザー**として設計しているのに、
LLM には `ok` しか届かない。実機 E2E で本セッションでも踏んだ:
`evaluate_orbitscore` が `ok` を返す一方、ログには `Variable not found: global`。

##### 「どこまで待つか」を時間で決めない

REPL は行を **FIFO** で処理する（#476）。コードの直後にマーカーを送れば
**マーカーに到達した時点で先行コードの評価は完了している**。settle 時間を待つ必要も、
長い評価（instrument 6 本の attach で 30 秒超）で誤検知することもない。

- engine: `//#evalMark {"requestId":...}` を既存メタ機構（`//#pluginUi` と同じ運び方）に追加。
  `executeCurrentBuffer` の 2 つのエラー経路で診断を記録し、マーカーで返してクリア
- 🔴 **マーカーは「提出の境界」**なので、未完のままバッファに残った入力を**強制実行してから**
  報告する。さもないと「何も実行していないのに ok」を返す（テストが実際にこれを暴いた）
- extension: `EvalMarkBridge`（`plugin-ui-bridge.ts` と同型）+ `evaluateForAgent` を async 化

##### 🔴 ユニットテスト全緑のまま、実機 E2E だけが配線の欠陥を捕まえた

最初の実装は `evalMarkBridge.handleLine` を **`{"pluginUi"` 分岐の中**に相乗りさせていた。
engine 側の応答は正しく出ていたが、`{"evalMark"` 行は prefix チェーンをすり抜けて
**一度も dispatch されず全て timeout**した。**ユニットテストは全件緑**。
専用の `else if` 分岐へ分離して解決。

> **配線はユニットテストの視野の外**という本プロジェクトの原則（[[dsl-feature-requires-e2e]]）が
> そのまま再現した。E2E を回していなければ「テストは緑だから直った」と誤報していた。

##### 変異検証

parse 診断の記録削除 / runtime 診断の記録削除 / mark 時のクリア削除 / 未完バッファの
強制実行削除 / `ok` を常に true / bridge の prefix ガード削除 → **6種すべて red**
（prefix ガードは最初 equivalent mutation で生き残ったため、キー位置の異なる JSON を
固定するテストを足して load-bearing にした）。

##### 実機での確認

| 投入 | 修正前 | 修正後 |
|---|---|---|
| パースエラーを含む楽譜 | 🔴 `ok` | `error: evaluation failed: [parse] Expected RPAREN but got AT at line 1, column 23` |
| 実行時エラー | 🔴 `ok` | `error: evaluation failed: [runtime] Variable not found: global` |
| 正常な楽譜 | `ok` | `ok` |
| 成功→失敗→成功 | — | 診断を引きずらない |

#### 採らなかったもの: argv の アトミック書き込み

当初は `> tmp` → `mv` で「存在＝完全」を構造的に保証する案を入れたが、**撤回した**。
親は child の `'exit'` を観測してから読むので、**部分読みは構造上起こり得ず、
変異でも落とせない**。証拠のない機構を残さない方針で削除した。

`vi.waitFor(existsSync)` は残した。#520 のもう一つの症状（`argv.txt` の ENOENT）は
過去に高負荷下で**実際に観測されている**ため保険として置くが、
**変異検証できない防御である**ことをコメントに明記した。

---

### 6.356 fix: PR #612 レビュー統合 — `output()` の宛先排他規則を spec に確定し、保護の穴を塞ぐ (Aug 1, 2026)

**Date**: 2026-08-01
**PR**: #612 / **Status**: **1929 passed / 0 failed**（レビュー前 1923・+6）・lint 0・
`cargo clippy --all-targets` 0・Rust workspace lib 14 crate 全緑

レビュアー5名（Sonnet 4 = 差分に**在る**もの / Fable = 差分に**無い**もの）を**並行**起動。
Critical 0 で収束したが、Important の指摘は横断的関心事に集約できたため
**修正前にポリシーを確定**してから一括適用した（指摘単位のローカルパッチは振動の主因）。

#### 🔴 ポリシー1: `output()` の宛先排他 — spec に §4.4.1 を新設

**発見（Fable 監査）**: `_renderBus` のフィールドコメントは
「**offline stem の宣言は既存の live routing を変えられない**」と不変条件を宣言しているのに、
実装はその直後で `_outputChannel` を破壊していた。spec（§4.4）は解決順しか定めておらず、
**再宣言時に何が残るか**が未定義だった。

**実害**: `global.linkAudio()` セッションで `kick.output("Kick Ch")` が稼働中に、
レンダ準備として `kick.output(1)` を書き足すと `_outputChannel` が消え、次の schedule で
`resolveDispatchChannel()` が throw して**ライブ中に kick が停止する**。

**確定した規則（一方向の非対称・意図的）**:

| 宣言 | `_renderBus` | `_outputChannel` | `_sumOutputBus` |
|---|---|---|---|
| `output(n)` | 設定 | **変更しない** | **変更しない** |
| `output(name)` | **クリア** | 設定 | 変更しない |
| `output(sumName)` | **クリア** | 変更しない | 設定 |

オフライン → live 方向を禁じるのは上記の実害のため。live → オフライン方向を許すのは、
offline が P2 まで走らないので stale を残さない方が良いため。

**これに伴い、私が P1 で追加した「排他性」テストは規則と逆の性質を固定していたので書き換えた**
（当初は実装から挙動を推測してテスト化しており、不変条件の側を読んでいなかった）。

#### 🔴 ポリシー2: 診断チャネルの保護は「tracing 経路」ではなく「subscriber 稼働後の全 stderr 書き込み」

**発見（silent-failure-hunter）**: #605 の保護は `main.rs`（binary）にあったため
**lib 側の `engine_wrap.rs` から使えず**、生 `eprintln!` が 2 箇所残っていた。
panic hook が `exit(1)` するようになった今、**「非 UTF-8 な env var を警告できなかった」
というだけで daemon 全体が終了する**経路になっていた。

`best_effort_stderr.rs` を crate 直下へ移し、`main.rs` / `engine_wrap.rs` の
生 `eprintln!` 4 箇所すべてに適用。起動前（subscriber 初期化より前）は対象外
—そこは書けなければ素直に落ちるのが正しい。

#### 🔴 ポリシー3: 「未完入力」判定はパース段のエラーにだけ適用する

**発見（silent-failure-hunter + Fable が独立に）**: `try` が `parseAudioDSL` と
`interpreter.execute` の**両方**を覆っていたため、`/\bEOF\b/` が実行時エラーにも作用していた。
実行時エラーの文言はユーザー由来の文字列を含むので、たとえば
`kick.audio("takes/EOF.wav")` の ENOENT が「未完入力」と誤判定され、
**完結した行が silent に保留されて #608 が別経路で再発する**。

parse を独立した `try` に分離。以後は「入力は完結している」ので、失敗しても必ず報告する。

#### 追加したテスト（すべて変異で red 確認）

| テスト | 殺す変異 |
|---|---|
| offline 宣言が live channel を保つ | 旧挙動（数値 output が channel を破壊）→ **red** |
| 同名 sum に解決された時に render bus を落とす | sum 分岐のクリア削除 → **red**（従来は 25 passed のまま生存） |
| 範囲外の拒否時に既存 routing を壊さない | 検査より前に状態を壊す → **red** |
| 実行時エラーが "EOF" を含んでも保留しない | 旧構造（execute にも EOF 判定）→ **red** |
| DSL テキスト経由の `output(n)`（新規ファイル） | 数値判定を落とす / 記録しない → **red** |
| `master` の必須性（serde は Option を None に既定化） | `REQUIRED` から master を外す → **red**（従来は 6 passed のまま生存） |

#### 私の裏取りで**覆した**指摘

**「sum 分岐が `_outputChannel` をクリアしない」は到達不能**だった。2 エージェントが独立に
「実害経路は実在する」と報告したが、`resolveDispatchChannel()` が `_outputChannel` を返すのは
LinkAudio 有効時のみで、**LinkAudio と sum bus は v1 で双方向に排他**
（`mixer-manager` の `declareBus` ゲートと `global.linkAudio()` のゲート）。issue 化は見送り、
spec §4.4.1 に不在の根拠を記録した。

#### コメント精度の修正（comment-analyzer / Fable）

- SIGABRT の再現回数 **11 → 14**（実測。04:57 に数えた時点では 11 で、その後の検証中に増えていた）。
  時刻窓も併記して検証可能にした
- VST3 `processMode` コメントの**過般化を訂正**。一次ソース（`ivstaudioprocessor.h`）の規定は
  「一致」ではなく「`kRealtime`↔`kOffline` の切替には `setupProcessing` が必須」。
  本 host の 2 値域では結果的に一致が必須になるが、`kPrefetch` を含む一般則ではない
- CLAP の「inactive でなければならない」という**根拠のない制約主張を削除**
  （`render.h` の `set` は `[main-thread]` のみ）。activate 前に呼ぶのは host 側の選択
- `REQUIRED` ループの存在理由を明記（`master` だけ `Option` なので serde に委ねられない）

#### 運用上の失敗（記録）

**レビューエージェントが共有 working tree を変異検証で書き換えた**（3 ファイル + 新規 probe
ファイル）。差分を保全した上で HEAD へ復元。`pr-test-analyzer` に「どの変異を殺すか示せ」と
依頼した以上、実際に変異を走らせるのは自然な行動であり、**共有ツリーで作業させない指示か
worktree の付与が必要**だった（発注側の設計ミス）。


### 6.355 feat(vst3): offline process mode を実装 — Codex が書いたテストの相手側が存在しなかった (#598 P1) (Aug 1, 2026)

**Date**: 2026-08-01
**Issue**: #598 P1
**Status**: `cargo clippy --all-targets` 0・workspace lib テスト全緑・
`orbit-vst3-host --test offline` **13 passed**・`npm test` 1923 passed

#### 🔴 発見（私の判定ミスの訂正）

P1 を「実質完成」と判定してコミットした後、**pre-push の clippy がコンパイルエラーを出した**:

```
error[E0432]: unresolved import `orbit_vst3_host::Vst3ProcessMode`
error[E0599]: no associated function `load_with_process_mode` ...
```

Codex は `orbit-vst3-host/tests/offline.rs` を新 API 向けに書き換えたが、
**その API をソースに実装していなかった**（WIP バックアップを検査し、
`Vst3ProcessMode` の出現は `tests/offline.rs` の中だけ・#603 TEMP パッチには 0 件、
= 私の逆適用で消したのではないことを確認）。

**判定が浅かった**: 「TODO 0 個 + daemon ハンドラ配線済み」で完成と見なしたが、
`npm test` も `cargo test -p orbit-audio-daemon --lib` も **`orbit-vst3-host` の
テストターゲットをビルドしない**。**「テストが緑」は「コンパイルが通る」を意味しない。**

#### 実装（CLAP 側との対称形に合わせた）

CLAP は `ClapRenderMode` / `configure_render_mode` として実装済みだったので、VST3 も同型に:

- `pub enum Vst3ProcessMode { Realtime（既定）, Offline }` + `as_vst3()`
- `Vst3EffectProcessor` / `Vst3InstrumentProcessor` に `load_with_process_mode(...)`。
  既存 `load(...)` は `Realtime` で委譲する薄いラッパ（呼び出し側は無変更）
- **P0 調査で特定済みの `processMode: kRealtime` ハードコード4箇所を全廃**
  （`ProcessSetup` 2 + `ProcessData` 2）。両 audio 構造体が宣言時の mode を保持し、
  `ProcessData` に載せ直す

🔴 **setup と process で同じ値を渡すこと**が要点。VST3 の契約上この2つは一致が前提で、
テスト用 oracle（gain / synth）は不一致を `kInvalidArgument` で弾く。
「オフラインだけ setup を変えて process を変え忘れる」取り違えの検出器になっている。

#### 変異検証（3種・すべて red）

| 変異 | 結果 |
|---|---|
| `Offline` を `kRealtime` に読み替え（mode が届かない） | **red**（2 failed） |
| `ProcessSetup` だけ realtime 固定（setup/process 不一致） | **red** |
| `ProcessData` だけ realtime 固定（逆向きの不一致） | **red** |

#### 教訓

**委譲先の成果を「完成」と判定する前に、ワークスペース全体をコンパイルする。**
`--lib` や個別パッケージのテストは、テストターゲットの型エラーを一切拾わない。
今回は pre-push の clippy が最後の砦になったが、これは偶然に近い。


### 6.354 refactor: /simplify pass — 重複ヘルパの共有化と wire deep clone の除去 (Aug 1, 2026)

**Date**: 2026-08-01
**Status**: **1923 passed / 0 failed**（pass 前 1921・+2）・lint 0・Rust daemon lib 30 passed

`/simplify` の4エージェント（reuse / simplification / efficiency / altitude）をブランチ全体
（3関心事・32ファイル）に並行適用した結果。

#### 適用した指摘

| 指摘 | 対応 |
|---|---|
| `render-score.ts` の `objectAt` が `rust-engine-player.ts` の `eventRecord` と同一 | 共有 `wire-validation.ts` へ抽出し**双方が import**（片方の private ヘルパをもう片方が読む＝依存の向きが逆、を避けた） |
| samples / buses の重複名チェックが同型コピペ（TS・Rust とも） | `ensureUnique` / `insert_unique` に集約 |
| `validate_render_score_params` の `params.clone()` が manifest 全体を deep clone | `RenderScoreManifest::deserialize(params)` で `&Value` から直接デシリアライズ |
| `runWithStallReport(line, run)` の高階引数が1通りしか使われていない | 引数を落として `handleLine` を直接呼ぶ |

#### 🔴 抽出したことで露見した穴（変異検証で発見）

`ensureUnique` に集約した直後の再変異で、**重複名チェックを無効化する変異が 20 passed のまま
生き残った** — samples / buses の重複名にテストが無かった（P1 実装時からの穴で、
ヘルパへ抽出したことで初めて可視化された）。

重複を許すと events の参照先が「どちらが勝つか」= manifest の解釈依存になり、
**レンダ結果が宣言順に silent に依存する**。TS・Rust 両側にテストを追加し、
それぞれの無効化変異が red になることを確認（TS 2 failed / Rust 5 failed）。

#### 見送った指摘（理由つき）

- **`write_line_best_effort` を `BestEffortStderr` に一本化**: 前者は1回のロックの下で
  「本文 + 改行 + flush」をアトミックに行うが、後者は `MakeWriter` 契約上呼び出しごとに
  ロックを取り直す。統合すると panic hook の1行に他スレッドの tracing 出力が割り込む余地が
  生まれ、**#605 が問題にした診断出力の破損を別の形で再現しかねない**
- **`_outputChannel` / `_renderBus` の判別共用体への統合**: P2 で `OfflineRenderSession` により
  出力先の概念自体が拡張予定。今統合すると二度手間になる（altitude エージェントの判断に同意）
- **`REQUIRED` ループを serde に委ねる**: 手書きループは
  「`RenderScore.events is required`」という位置つきの文言を出すためのもので、
  serde の `missing field` より診断が良い。テストもこの文言に依存している

#### 🔴 レビューチームへの申し送り（この pass の対象外・既存の問題）

`sequence.ts` の `output()` の **sum bus 分岐が `_outputChannel` をクリアしない**。
`main` 時点で既にそうなっており（`git show main:` で確認）この diff 由来ではないが、
`seq.output("kick")` → `seq.output("groupA")`（sum 宣言済み）の順で
`_outputChannel` に古い値が残り、LinkAudio モードで `resolveDispatchChannel()` が
古いチャンネル名を返し続ける経路が存在する。**正しさの問題なので `/simplify` では触らず、
`/code:pr-review-team` の判断に回す。**


### 6.353 feat(engine): #598 P1 — RenderScore manifest の DSL/wire を通し、TS↔daemon の契約を単一 fixture で固定 (Aug 1, 2026)

**Date**: 2026-08-01
**Issue**: #598 P1 / **Branch**: `598-p1-dsl-wire`
**Status**: **1921 passed / 0 failed / 34 skipped**（P1 着手前 1918・+3）・lint 0・
Rust daemon lib 29 passed

#### 実装（Codex）

- `output(n)` を既存 `output(name)` に統合（1..16 の整数のみ・同名 sum が優先・
  数値風の文字列は render bus として解釈しない）
- `RenderScore` manifest の TS 生成・検証・シリアライズ（`render-score.ts`）
- daemon 側の受け口・語彙解析・検証（`session.rs`）。ハンドラは
  `NOT_IMPLEMENTED: offline rendering is implemented in #598 P2` を返す（P1 の想定終端）

#### 🔴 main の変異検証で見つけた2つの穴（P1 の受け入れ基準未達だった）

**1. 「TS 生成 → daemon 検証」が実は検証されていなかった**

受け入れ基準は「manifest の round-trip（TS 生成 → daemon 検証）」だが、実際は
TS 側が TS→TS で round-trip し、Rust 側は**手書きの複製 JSON** を検証していた。
両者は互いを見ていない。

実証: `out_dir` を **TS 側だけ**一貫して `outDir` にリネームする変異が
**TS 19 passed / Rust 4 passed** で完全に生き残った — engine が daemon の受け付けない
payload を出す状態が、両側緑のまま成立する。

**対処**: `tests/fixtures/render-score-manifest.json` を **wire 契約の単一の正本**とし、
TS 側は `serializeRenderScore(createRenderScore(...))` の出力がこれと一致することを assert、
Rust 側は `include_str!` で同じファイルを読み `validate_render_score_params` に通す。
再変異で **TS 側リネーム → TS red / Rust 側リネーム → Rust red**（両方向）を確認。

**2. `_outputChannel` と `_renderBus` の排他性が未検証**

既存テストは**未設定からの初回宣言**しか通していなかったため、
「数値 output で `_outputChannel` をクリアする行」と「文字列 output で `_renderBus` を
クリアする行」を**それぞれ削除する変異が両方とも生き残った**（23 passed のまま）。
実害: `output(1)` → `output("master")` と書き換えても render bus が残り、score-mode で
意図しないバスへ出る。**再宣言（ライブコーディングの書き換え経路）**を通すテストを追加し、
両変異が red になることを確認。

#### 変異検証の一覧

| 変異 | 結果 |
|---|---|
| TS 側だけ `out_dir`→`outDir` にリネーム | 対処前 **生存** → 対処後 **red** |
| Rust 側だけ `out_dir`→`outDir` にリネーム | 対処後 **red**（診断文つき） |
| 未宣言 sample の参照チェック無効化 | red |
| 未宣言 bus の参照チェック無効化 | red |
| state の絶対パス要求を外す | red |
| 数値 render bus の上限（>16）を外す | red |
| 数値 output で `_outputChannel` を消さない | 対処前 **生存** → 対処後 **red** |
| 文字列 output で `_renderBus` を消さない | 対処前 **生存** → 対処後 **red** |

#### 分類の追加

`getRenderBus` を `signal-chain-dispatch.spec.ts` の内部 API リストへ（`@internal` の
純アクセサ・インタプリタからの参照ゼロ）。これが未分類で全 suite が 1 fail していた。

#### このコミットに含まれないもの

**#603 の TEMP パッチ（Kontakt UI・`vst3-host/src/{lib,view}.rs`・追加50行）は除外**。
逆適用が clean に通ることで「working tree の vst3-host 変更 = TEMP パッチのみ」を確認した上で
退避し、**パッチ全文と正式修正の要件を #603 にコメントとして保全**した。


### 6.352 chore(project): 「1260」提出完了 — やり残し・課題の棚卸し (Aug 1, 2026)

**Date**: 2026-08-01

**Soundcinema Düsseldorf 2026 に「1260」を締切内提出**（ステレオ 9:59.50 / 48kHz / 24bit /
−23.0 LUFS / TP −6.1 dBFS）。#546 の必須ループ（宣言→UI→音色→自動保存→復元→演奏）が
本番の音色選定 6 パートでそのまま使われ、実運用で初めて検証された。

#### やり残し・課題（棚卸し）

| 項目 | 追跡先 | 状態 |
|---|---|---|
| 未レビューコミット3本の PR 化 + レビューフロー | `e88d759` / `e505e40` / `892ae2b` | 🔴 次セッション最優先 |
| Codex #598 P1 WIP の検収（19ファイル未コミット・1 fail 同居） | #598 | 実装中 |
| #603 正式修正（TEMP パッチが working tree に適用中） | #603 | 実戦検証済み・整形待ち |
| one-shot RUN 終端の note-off 不達（VST 鳴り続け） | #606 | 新規 |
| stop_engine の child kill 不全（消滅確認なし） | #607 | 新規 |
| スタック全体 `@v` の仕様化 | #609 | owner 判断待ち |
| diagnostics とエンジンパーサの乖離 | #610 | 新規 |
| 7.1 の 8 ステム書き出し（オフライン・提出物用） | #598 | P0 完了・P1 実装中 |
| **realtime の 7.1 マルチアウト（本選 10/28 上演用）** | #611 | 新規・DSL 表面は #598 と共有 |
| gong の Kontakt 化 | 作品側 GONG_AS_INSTRUMENT 実装済み | state 待ち |

セッション詳細は Serena `session_2026-08-01_soundcinema_submission_and_6layer_debug`。


### 6.351 fix(repl): 行途中の構文エラーを「複数行入力の途中」と誤判定して silent に永久停止する本丸バグを修正 (#608) (Aug 1, 2026)

**Date**: 2026-08-01
**Issue**: #608 / **Commit**: `892ae2b`（コミット内 Refs #607 は当時未採番の誤記・正は #608）
**Status**: 新規 3 テスト passed・変異 3 種 red 確認・full suite 1917 passed（+5）

#### 事故と診断過程

パーサ未対応の記法（スタック全体への `[1,5,9]@v+10` — spec §2.5 は単音のみ定義）を
172 箇所含む 40KB の楽譜を run_selection したところ、途中の宣言までは実行されるが
以後がすべて沈黙。`ok` は返るが RUN も後続評価も実行されない。「instrument 同時4本
頭打ち」に見えたが本数は可変（4/3/2本）で、固定上限は存在しなかった。

診断は消去法で進めた（すべて実測）:

| 仮説 | 反証手段 |
|---|---|
| daemon の attach 直列化 / slot 枯渇 | 新規 gated harness で逐次・同時とも 6/6 成功 |
| Kontakt のプロセス数制限 | probe 6 プロセス同時起動、全成功 |
| engine event loop ブロック | `sample` で kevent アイドルを確認 |
| stdin 経路の破損 | CDP で stdin タップ — データ到達を目視 |
| daemon request 滞留 | CDP `queryObjects` で DaemonClient pending=0 |
| 宣言の await 滞留 | 同 EffectChainMap — cb/vc/pno 完了・**vla は呼ばれてもいない** |

決め手は停滞エンジンへ**空行2連を送る**実験（バッファ強制実行のトリガー）で、
`Expected RPAREN but got AT at line 10` が吐き出されたこと。

#### 原因

`repl-mode.ts` の不完全入力判定が `Expected RPAREN` の**文字列一致**を「未完」に
含めていた。このメッセージは `but got AT`（行の途中に不正トークン = 待っても完結
しない本物の構文エラー）でも出る。構文エラーを「未完」として silent に保留した結果、
以後の全入力が未完バッファへ合体しセッションが停止した。6.350 の stall レポーターが
鳴らなかったのは、バッファ保留が「実行中の行」ではなく監視の外だったため。

#### 修正

**「未完」= パーサが入力の終端（EOF）に達した場合のみ**、に一本化（`/\bEOF\b/`）。
`parse-statement.ts` の `Expected comma or closing parenthesis` 系 2 箇所には
トークン名 + 位置を付与（トークン名の無い文言は EOF と構文エラーを区別できない）。

変異検証: 旧判定復元 → red / EOF 判定ごと削除（過剰報告側）→ red / 文言劣化 → red。

#### 残課題（owner 判断・提案）

1. **スタック全体 `@v` を仕様に足すか** — 自然な表現で作品側の需要も実在するが、
   決定 #56/#57（per-note `@v`）の拡張になるため独断で実装しない
2. **拡張の diagnostics とエンジンパーサの乖離** — `[...]@v` を diagnostics は
   受理し、エンジンは弾く。診断がパーサと同じ文法を見ていない（別 issue 化予定）

### 6.350 fix(repl): 詰まった評価キューを沈黙させず、塞いでいる行を名指しさせる (#608) (Aug 1, 2026)

**Date**: 2026-08-01
**Issue**: #608（コミット内 Refs #607 は当時未採番の誤記）
**Status**: 新規 2 テスト passed・変異検証 4 種（うち 1 種が生き残ったのでテストを追加して潰した）

#### 症状

Kontakt を 6 声宣言したところ instrument のロードが 1 件未解決のまま残り、以後の
`global.start()` / RUN が**すべて「ok」を返しながら実行されず**、capture は無音のままだった。
原因の特定に数時間かかった直接の理由が**この沈黙**である。

#### 原因

`repl-mode.ts` の `pushLine` は全行を**単一の promise チェーン**へ載せる（#476 の FIFO
直列化）。設計は正しいが、**1 行が resolve しないと以後の入力が永久に待たされる**。
`pushLine` は `void` を返すので、呼び出し元（MCP の `evaluate_orbitscore` 等）には
成功に見える。

#### 修正: 打ち切らずに報告する

タイムアウトで打ち切らないのは、**正当な長時間処理が存在する**ため（instrument 6 本の
attach は実測 30 秒超）。閾値は daemon の `CHILD_READY_TIMEOUT`（60s）に合わせ、
「daemon 側の上限を超えてなお終わらない」ときだけ鳴らす。

報告には **(a) 塞いでいる行 (b) 背後で待っている行数 (c) 受理と実行は別である旨**を含める。
(a) が無いと何を直せばよいか分からず、(b) が無いと「1 行が遅い」のか
「セッション全体が死んだ」のか区別できない。

#### 変異検証

| 変異 | 結果 |
|---|---|
| 報告が永久に発火しない（間隔を巨大化） | **red** |
| 待機行数を報告しない | **red** |
| 塞いでいる行を名指ししない | **red** |
| 閾値を 1ms に縮める（誤報） | 🔴 **最初は生き残った** |

4 番目が生き残ったのは、無音テストが「一瞬で終わる行」を使っていたため。
**「遅いが正当な行」（30 秒）で押さえ直して**潰した。
[[test-name-must-match-the-path-it-drives]] と同型で、名前は正しいのに経路が違っていた。

#### 運用の失敗（記録）

このセッション中、コミット時に `git stash` で Codex の未完成 P1 を退避した。**その窓で
pre-commit hook がビルドを走らせ、#605 修正の入っていない dist（05:21:13）が焼かれた。**
作品セッション側で「`[daemon]` 行が再び消えた」と観測され、新しいバグとして追いかけられた。
**stash 中のビルドは、コミット対象でないソースから成果物を焼く。**

### 6.349 fix(daemon): 診断チャネルの故障で daemon が死ぬ経路を封鎖し、child READY 上限を実測に合わせた (#605) (Aug 1, 2026)

**Date**: 2026-08-01
**Issue**: #605
**Status**: daemon lib test **158 passed / 0 failed**・新規プロセステスト **1 passed**・
実機で Kontakt の state 復元が daemon 経由で初めて成功

#### 症状

Kontakt を `instrument(..., "states/strings.state")` で宣言すると child が READY を発行せず
attach がタイムアウトする。**state 無しでは成功する**という非対称があり、「state 復元が
child をフリーズさせている」ように見えていた。並行して daemon が SIGABRT で落ちていた
（`~/Library/Logs/DiagnosticReports/orbit-audio-daemon-*.ips` に **14 件**・04:03〜05:16 JST）。

#### 原因1: `CHILD_READY_TIMEOUT` が実測に対して短すぎた（本命）

daemon / child / shm をすべて外した gated probe
（`orbit-vst3-host/tests/kontakt_state_gated.rs`・新規）で**host 側の state 復元は健全**と判明:

| 条件 | 実測（release） |
|---|---|
| state 無しの load | 3.1s |
| state あり（1.33MB の component chunk 適用） | **4.3s** |
| 初回 dylib 検証（Gatekeeper・plugin ごとに一度） | 最大 20s |

**「READY を出さない」のではなく「間に合っていなかった」。** 上限 10s → **60s**。
根拠の内訳を定数のドキュメントに残した。

#### 原因2: 診断チャネルの故障がプロセスを殺していた

- `tracing_subscriber` の writer が `std::io::stderr` 直 — **書き込み失敗で panic**
- `install_fatal_panic_hook` 自身が `eprintln!` — **再 panic** し
  `panic_with_hook` の再帰検知が `process::abort()` を呼ぶ。よって `exit(1)` に到達しない

engine 側（`daemon-client.ts`）が起動完了時に daemon stderr の購読を切っており、
読み手の消えた pipe への書き込みが失敗していた。**engine 側で購読を維持**（蓄積だけ止めて
以後は `[daemon]` 付きで転送）し、**daemon 側は書き込み失敗で panic しない実装**に変えた。

**設計判断**: 診断チャネルの書き込みエラーは握りつぶす。通常なら禁じ手だが、ここは
**自分を診断するためのチャネルが診断対象を殺している**構図であり、ログ1行を失う代償より
daemon が生きて次の診断を出せることを優先した。音声処理・プロトコルの失敗は従来どおり
loud に落とす。

#### 変異検証（`tests/stderr_breakage.rs`）

`Stdio::piped()` の `ChildStderr` を drop して read 端を閉じ、接続でログを誘発してから生存を見る。
**fd を `close` するだけでは再現しない**（後続の `open` が fd 2 を再利用して書き込みが成功する）。

| 変異 | 結果 | daemon の終了状態 |
|---|---|---|
| A: tracing writer だけ差し戻し | **red** | exit=1（hook 修正で abort を免れる） |
| B: panic hook だけ差し戻し | 🔴 **green（生存）** | — |
| C: 両方差し戻し | **red** | **signal 6 = SIGABRT**（本番と同一署名） |

🔴 **変異 B は生き残る**: writer が直っていると panic 自体が起きず hook に到達しないため、
panic hook 側の修正は独立に検証できていない。production に panic 注入口を足す方が害が
大きいと判断して入れていない。この非対称はテスト本体に明記した。

#### 教訓

**診断が取れないこと自体が最大のバグだった。** 「stderr がどこにも出ない」を
2時間追ったが、その stderr を engine 側が切っていた。捕捉を仕掛けた `orbs-stderr.log` が
0 バイトだったのは、**仕掛けた fd 自体が壊れていた**からで、切り分けを空振りさせ続けた。

**推測を潰した順序**: 「setState デッドロック」「controller handshake 不足」「headless モーダル」
「child が eprintln で死ぬ」の4仮説はいずれも実測で反証された（前3つは probe の 4.3s 成功、
最後は child のクラッシュレポートが1件も無いこと）。

### 6.348 feat(mcp): #474 P4c — UI 開閉を MCP から叩けるようにし、実機で必須ループが通った (Aug 1, 2026)

**Date**: 2026-08-01
**Issue**: #474 / **Branch**: `474-p4c-mcp-tools`
**Status**: `npm test`（sandbox 外）= **1862 passed / 0 failed / 34 skipped**・
**実機 gated E2E = 6 passed / 0 failed**（実 OrbitStudio.app・160秒）

P4a(daemon) と P4b(engine) で経路は完成していたが**外から叩けなかった**。
P4c で MCP tool と REPL メタ行を足し、Epic #546 の必須ループが端まで通った。

#### 実装

- `open_plugin_ui(receiver, index, expectedName?)` — 完了 ack（view attach 完了）まで待つ
- `close_plugin_ui(receiver, index)` — 🔴 完了条件は **`UI_CLOSED_DONE` の受信であって ack ではない**
- receiver は sequence / `master` / `sum:<name>` / `aux:<name>`。**aux を含む**
- REPL メタ行 `//#pluginUi`（JSON payload の `action: 'open' | 'close'` で開閉を区別。
  設計時の `//#openPluginUi` / `//#closePluginUi` 2 本案は単一メタ行に統合）
- **誤爆ガード**: `expectedName` 不一致なら **daemon へ送らずに** loud エラー。
  index がずれて別プラグインの UI が開くと、意図しない側の音色が保存される
- **待ち受け順序**: DONE waiter を CLOSE_UI 送信より**前に**登録する。event pump と
  command response は独立タスクなので DONE が ack を追い抜く

#### 🔴 main の変異検証で1種が生き残った

Codex が7種（分岐 / 回数 / 順序 / 引数）を実走し全 red。**その上で main が3種を独自に回した**:

| main の変異 | 結果 |
|---|---|
| 完了を ack で名乗る | red |
| `timeout-without-save` を握り潰す | red |
| **respawn 中断を成功として resolve** | 🔴 **生存 → テスト追加後 red** |

child がクラッシュして再起動されると、その UI のセーフポイントは**実行されない**。
しかし close を待つ呼び出し元に `safepoint-completed` を返すと、**音色が一切保存されて
いないのに「保存完了」を受け取る**。既存の respawn テストはイベントハンドラ側
（保存・ack・再オープンをしないこと）しか見ておらず、**待っている呼び出し元**が
無検証だった。`rejects a pending close when a respawn takes the window first` を追加。

**今日3回とも、委譲先の「全変異 red」報告の後で main の変異が穴を見つけている。**

#### 🔴 実機 E2E で Epic #546 の受け入れ基準を満たした

`ORBIT_GATED_ORBITSTUDIO=1` で実 OrbitStudio.app を起動し、MCP 呼び出しだけで駆動。

| 検証 | 結果 |
|---|---|
| 誤爆ガードが**先に**失敗する（別ウィンドウが開く前） | ✅ |
| エラーに有効 index 一覧が含まれる | ✅ |
| `open_plugin_ui` でウィンドウが開く | ✅ |
| `close_plugin_ui` が `safepoint-completed` を返す | ✅ |
| **`get_log` に `timeout-without-save` が無い** | ✅ |
| 同じ**測定ピッチ**で instrument state が再起動復元 | ✅ |
| 🔴 **明示保存なしで5種すべてのレシーバが再起動復元** | ✅ |

**「外部 DAW 依存は絶対却下」と決めた必須ループ（宣言 → UI → 音色 → 自動記録 →
再起動で復元）が、実機で端から端まで通った。**
