> ⚠️ **2026-06-19 更新**: 本書の Tracktion 寄り結論は **`docs/development/POST_2.0_ENGINE_AND_DISTRIBUTION.md` が更新**した。重心は **既存の自社 Rust ワークスペース `rust/` を発展させる**方向に移動（理由: ①既存 Rust エンジンが foundation を既にカバー ②ライセンス/収益 — GPL の Tracktion/JUCE は freemium を foreclose、permissive な Rust は温存）。本書の Tracktion / VSCodium / ライセンス整合の一次情報は引き続き有効。VSCodium 専用アプリ化方針は不変。

# Research: ネイティブ音声エンジン（Tracktion Engine 載せ替え）+ VSCodium 専用アプリ化 feasibility

**調査日**: 2026-06-18
**文脈**: 2.0.0 リリース後の OrbitScore 本体アーキ方向（WCTM とは別軸）。`memory: orbitscore-post2.0-native-engine-direction` の feasibility 裏取り。
**調査方法**: deep-research harness（5 angle 並列 web 検索 → 一次情報 22 ソース fetch → 99 claim 抽出 → 25 claim を 3 票敵対的検証 → 23 確認 / 2 反証 → 6 finding に統合）+ OrbitScore 自コードの seam 確認。
**一次情報優先**。投票が割れた箇所・未確証・反証は明示する。

---

## 0. 構想（調査対象）

- 現状: OrbitScore = TypeScript の DSL/パーサ/スケジューラ + **scsynth を OSC で駆動**して発音。
- 構想: **scsynth を Tracktion Engine（C++/JUCE）に載せ替え**、エディタを **VSCodium ベースの専用デスクトップアプリ**化。
- 制約: macOS (Apple Silicon) 主、OSS（GPL 許容）、出力は既存の **Ableton Link Audio publisher（`LinkAudioSink::commit`、RT-safe）**に接続。
- 原則: **engine 先・features 後**（audio 側機能は engine 確定まで深追いしない。MIDI/Pitch DSL は engine 非依存で並行可）。

## 1. 結論（サマリ）

**構想は技術的に妥当だが、本調査が裏取りできたのは「易しい半分」だけ**である。確証が集中したのは**低リスク側**（ヘッドレス駆動・ライセンス整合・出力 tap 点・別プロセス IPC 前例・VSCodium ビルド形態）。一方、**この載せ替えを動機づける核心 = 外部 VST/AU/CLAP プラグインのホスティング (A2)、VST GUI の Electron 共存 (B8)、N-API addon の message loop (A5)、fork 保守の定量 (B7)** は**本調査では未確証**。「実現可能（API が存在する）」と「ライブコーディング用途に実適合する」も別問題で、後者は実機スパイクが要る。

1. **Tracktion はヘッドレス駆動できる**。v3（2024-07）で非線形パフォーマンス向け **clip-launcher**（quantise launch / scene / clip slot / follow actions）を追加。`Engine`+`Edit`+`TransportControl` を GUI 非依存で駆動可。サンプル trigger・loop・generative randomize が実コードで確認できる。Edit/Clip モデルとライブコーディングの即時/generative は**潜在的衝突にとどまり致命的ではない**。
2. **ライセンスは全レイヤー GPL 系で整合**（OSS 路線なら成立）。ただし **JUCE は別途取得が必要**で、JUCE 8 は GPLv3 →**AGPLv3** へ移行済み（§13 ネットワーク開示義務に注意）。
3. **出力 tap 点は JUCE の `audioDeviceIOCallbackWithContext`** の `outputChannelData`（高優先度=RT スレッドで埋める post-mix バッファ）が現実的。
4. **接続形態は「別ネイティブプロセス + IPC」が de-risk 済みの本命**。scsynth 自体が OSC over TCP/UDP の別プロセス/network-IPC で、任意の OSC クライアントで駆動できる確立前例がある。**OrbitScore の既存 seam（`OSCClient`）にそのまま嵌まる**（§A5）。N-API addon 同居案は一次情報で未確証（open question）。
5. **VSCodium は fork ではなく「上流を clone+build するスクリプト群」**。hard fork より低保守な「rebuild upstream + patch」経路の参照実装になる。macOS 12+ arm64 公式サポート。
6. **最大リスク3点**: ① Edit/Clip モデル vs ライブコーディングの実適合 ② 接続形態（別プロセス IPC が本命だが addon 同居は未確証）③ AGPLv3 配布含意。**最初に潰すべきは「ヘッドレス Tracktion → audio callback の post-mix tap → `LinkAudioSink::commit`」の最小スパイク**（§推奨）。

---

## 2. Finding（質問別・出典付き）

### A1/A3/A6 — Tracktion のヘッドレス駆動・サンプル/stretch（confidence: high / 3-0）

- v3 release post 逐語: *"The big thing of course is the addition of a clip-launcher workflow for non-linear performances ... Launch clips quantised to timeline / Launch scenes for triggering multiple clips at once / Record to clip slots / Comprehensive follow actions"*。
- `tracktion_Clip.h` に `getLaunchHandle()` / `getLaunchQuantisation()` / `getFollowActions()` / `getClipSlot()` が実在。
- サンプル trigger = `Edit → AudioTrack → StepClip → SamplerPlugin`（tutorial 03、`sampler->addSound(...)`）。loop = `loopAroundClip(*stepClip)`。generative = `pattern.randomiseSteps()` / `randomiseChannel(...)`。playback = `edit->getTransport()` の `TransportControl`（`setLoopRange` / `looping` / `play`）で **timeline GUI 非依存**。
- time-stretch は v3 が *"Real-time audio time-stretching (with background thread read-ahead)"* を**内蔵**（`TimeStretch.cpp` が SoundTouch/RubberBand/Elastique を in-engine 統合、runtime-hosted plugin ではない）。`WarpTimeManager` が marker-based time-mapping をネイティブ提供。
- **注意点**: StepClip はサンプル trigger の唯一手段ではない（MIDI clip / WaveClip も可）。**ヘッドレス運用は `DeviceManager`/message thread/audio device 初期化を自前配線する必要**。**無償同梱の stretch は SoundTouch のみ**（Elastique/RubberBand は外部ライセンス）。
- 出典: <https://forum.juce.com/t/tracktion-engine-v3-released/62196> / tutorials 01・03 / `WarpTimeManager` doxygen / `tracktion_Clip.h`・`tracktion_TimeStretch.cpp`。

### A2 — 外部プラグインホスティング（VST3/AU/CLAP）（⚠️ 本調査では未確証）

**この載せ替えの動機そのものだが、今回の検証 25 claim に含まれず、一次情報で裏取りできていない。** 上の A1/A3/A6 で挙げた `SamplerPlugin` は Tracktion の**内蔵**サンプラーであって、外部プラグインのホスティングではない点に注意。

- **リスク評価（裏取りではなく推定）**: Tracktion Engine は商用 DAW **Waveform** の心臓部であり、Waveform は VST3/AU/CLAP を macOS（Apple Silicon 含む）でホストする。よって**ホスティング能力の存在自体は Tracktion の中核機能で、リスクは低いと推定**できる。ただし本調査は VST3/AU/CLAP の **macOS Apple Silicon でのスキャン・ロード・処理の成熟度**を一次情報で確認していない。
- **扱い**: 「低リスクだが未検証」。**スパイク S1 に実プラグイン 1 つのロードを含めて実証する**（§推奨）。Tracktion 内蔵機能のみで feasibility を語ると、載せ替えの理由を検証せずに「実現可能」と誤認するため。

### A4 — ライセンス整合（confidence: high / 主要部 3-0）

- Tracktion Engine LICENSE.md 逐語: *"published under a dual GPL3 (or later)/Commercial license."*
- JUCE master LICENSE.md 逐語: *"dual-licensed under the AGPLv3 and the commercial JUCE licence."*（7.x の GPLv3 から **8 で AGPLv3 へ移行**）。
- Ableton Link 逐語: *"dual licensed under GPLv2+ and a proprietary license."*
- AGPLv3 §13（GPLv3 §13 と対称）が GPLv3 作品との単一結合作品化を明示許可 → **OSS 路線なら法的に成立**。
- **重要な但し書き**:
  1. Tracktion の dual license は **JUCE を含まない**。README が *"you must make sure you have an appropriate JUCE licence from juce.com when distributing"* と明記 → **JUCE を別途 AGPLv3 で取得**する必要。
  2. JUCE 8 に無料 Starter tier（$0、~$20k 売上未満ならクローズドソース配布も非-AGPLv3 EULA で可）。「クローズド=必ず有償」は誤読。ただし AGPLv3 を選ばないなら JUCE 8 EULA に拘束。
  3. **AGPLv3 §13 はネットワーク提供時のソース開示義務**（GPLv3 に無い）を伴う。**配布形態（デスクトップ配布 vs ネットワークサービス）次第で含意が変わる**。
  4. Tracktion repo は BSD/MIT/ISC/BSL-1.0/CC0 等 3rd-party も同梱（GPL 互換だが宣言義務）。
- 出典: Tracktion・JUCE・Ableton Link の各 LICENSE.md / <https://www.fsf.org/bulletin/2021/fall/the-fundamentals-of-the-agplv3>。

### A6 — RT-safe な出力 tap（confidence: high / 3-0）

- JUCE 公式: `audioDeviceIOCallbackWithContext(..., float *const *outputChannelData, ..., int numSamples, ...)`。逐語 *"a set of arrays which need to be filled with the data that should be sent to each outgoing channel"* / *"the callback function must fill all the channels"* → 書き込み後に**完全な最終ミックスが存在**。逐語 *"repeatedly call ... on its own high-priority audio thread"*。
- RT 制約: *"implementations must be thread-safe and avoid blocking or dynamic allocations"*（malloc/lock/blocking 回避）。`LinkAudioSink::commit` は既存 research（`LINK_AUDIO_API.md` §1.4）で RT-safe 確認済みなので、この callback 内 commit は整合。
- **但し書き**: open() で未指定チャンネルは null ポインタ → tap 時に null チェック必須。これは**デバイス出力 callback**であり、Tracktion 内部ミックスをここへ落とすには**自前 callback 配線**が要る（claim は『接続点になり得る』と適切にヘッジ）。
- 出典: <https://docs.juce.com/master/classAudioIODeviceCallback.html>。

### A5 — 接続形態: 別プロセス IPC vs N-API 同居（confidence: high / 3-0）

- SC 公式 Server-Architecture 逐語: *"All commands are received via TCP or UDP using a simplified version of Open Sound Control (OSC)."* / *"The synth server and its client(s) may be on the same machine or across a network."*（同一マシンでもループバック = network-IPC）。
- ClientVsServer 逐語: *"it is possible to control the server from any other client which provides for OSC messaging (e.g. from Java, Python, Max/MSP, etc.)."* supercolliderjs(TS/JS)・Sonic Pi(Ruby+OSC)・FoxDot 等が前例。
- → **「別ネイティブプロセス + IPC で Tracktion を駆動」には確立された先行パターンがある**（N-API 同居案と対置される側）。
- **OrbitScore 側の実態（自コード確認）**: scsynth 統合は `packages/engine/src/audio/supercollider/` に隔離され、seam は `OSCClient`（`boot()` で spawn、`sendMessage(osc[])` でコマンド送出、`sendBufferLoad` で `/done` 待ち）。その上に `EventScheduler`/`BufferManager`/`SynthDefLoader`。**「別プロセス + IPC」案はこの seam に 1:1 で嵌まり、`OSCClient` を差し替えるだけで DSL/スケジューラは無傷**。
- **open question**: N-API addon で **JUCE の `MessageManager`/message loop を Electron プロセス内で回す際の既知問題**（スレッドモデル/event loop 競合）は今回のバンドルで一次情報未確証。→ **別プロセス IPC を de-risk の本命にすべき**根拠になる。
- 出典: <https://doc.sccode.org/Reference/Server-Architecture.html> / <https://depts.washington.edu/dxscdoc/Help/Guides/ClientVsServer.html>。

### B7/B8/B9 — VSCodium 専用アプリ化（confidence: high / 3-0）

- VSCodium README 逐語: ***"This is not a fork. This is a repository of scripts to automatically build Microsoft's vscode repository into freely-licensed binaries."*** / *"clone Microsoft's vscode repo, run the build commands, and upload the resulting binaries"* / *"licensed under the MIT license. Telemetry is disabled."*
- ビルドパイプライン: `.github/workflows` に Windows/Linux/macOS 分の `ci-build-*.yml` + `publish-*.yml` が公開 → **hard fork より低保守な「rebuild upstream + patch」経路の参照実装**。Supported Platforms に *"macOS 12 or newer arm64"*。
- **但し書き**: VSCodium はビルド時に脱 telemetry/リブランド patch を当てる（完全無改変ではない）。ワークフローは VSCodium 固有最適化で、コピペでなく適応が必要。
- **open question（未確証）**:
  - fork アプリ内で **VST/AU プラグイン GUI エディタウィンドウを Electron renderer と共存**させる具体手段（別ネイティブ OS ウィンドウ vs 埋め込み）が一次情報未確証。
  - **Cursor / Windsurf / Theia の上流リベース頻度・保守労力の定量比較**、macOS 署名/notarization/配布の具体手順が未調査。
- 出典: <https://github.com/VSCodium/vscodium>（fork の保守論点は Eclipse/EclipseSource の blog も angle に含むが一次は VSCodium repo）。

### C10 — Rust 自作案との比較（confidence: high / 3-0）

- Glicol README 逐語: *"a computer music language with both its language and audio engine written in Rust"*。開発者は外部エンジン委譲を明示拒否: *"instead of mapping it to existing audio lib like SuperCollider, I decide to do it the hard way: write the parser in Rust [and] write the audio engine in Rust"*。`glicol_synth` は `dasp_graph` 上の graph-based DSP。
- → **「Rust で DSL + 自作 audio エンジン」は単一言語アーキとして達成可能**という**存在証明**。
- **但し書き**: `dasp_graph` 依存でゼロ依存ではない。存在証明にとどまり、**Tracktion 載せ替え案との工数・リスク定量比較は一次情報で確証されず、設計判断として残る**。
- 出典: <https://github.com/chaosprint/glicol>。

---

## 3. 反証された主張（区別が重要）

1. *「StepSequencerDemo がヘッドレスで in-memory Edit を作る」*（1-2 で反証）— **デモ自体は GUI 入り**のため反証。ただし **API のヘッドレス駆動可能性は別 claim で 3-0 確認済み**（「デモが headless」≠「API が headless 駆動可」）。
2. *「SC は意図的に synthesis/control を分離して非-sclang 制御を許す設計」*（1-2 で反証）— 過剰解釈として反証。ただし**非-sclang 制御の事実自体は 3-0 確認済み**。

## 4. Caveats / 時間依存性

- **本調査は「載せ替えの動機（外部プラグインホスティング A2）」を検証していない**。確証は低リスク側に偏っている。「実現可能」と読む際は、§1・§A2 の通り **A2/B8/A5(addon)/B7 が未確証**である点を必ず併記すること。
- **JUCE ライセンスは 8 で GPLv3→AGPLv3 へ移行済み**（2026-06 master 確認）。9 以降で再変更の可能性 → **配布直前に LICENSE.md 再確認**。
- Tracktion v3 clip-launcher API は存在確認止まり。**ライブコーディング実適合（レイテンシ・ノートタイミング精度・runtime の Edit/Clip 挿入安定性）は別途実機スパイクが必要**。
- ライセンスの法的整合は一次情報で確認したが、**最終配布形態（特に AGPLv3 §13 のネットワーク提供該当性）とフル GPL 路線の弁護士確認は本調査の射程外**。
- 出典精度の注記: Ableton Link の引用ファイル名が `GNU-GPL-v2.0.md` とされた箇所は実際 `LICENSE.md`（内容は genuine）。AGPLv3 §13 の引用は GPLv3 §13 文言（両者対称で実質影響なし）。1 claim が JUCE を緩く「GPLv3」と表現していたが正確には AGPLv3/商用。

## 5. Open Questions（未確証・次段で潰す）

0. **A2（最重要・載せ替えの動機）**: Tracktion による **外部 VST3/AU/CLAP ホスティング**の macOS Apple Silicon での成熟度（スキャン・ロード・処理）。Waveform の中核機能なのでリスクは低いと推定するが、本調査の一次情報では未確認。→ **S1 で実プラグインを 1 つロードして実証する**。
1. **A5**: N-API addon で JUCE `MessageManager`/message loop を Electron 内で回す既知問題の一次情報。→ 別プロセス IPC が前例確立側なので、まず別プロセス案を de-risk 本命に。
2. **B8**: fork アプリ内で C++/JUCE エンジン + VST/AU GUI を Electron renderer と共存させる具体手段（別ネイティブ OS ウィンドウ vs 埋め込み）。
3. **B7/B9**: Cursor/Windsurf/Theia のリベース頻度・保守労力の定量比較、macOS 署名/notarization/配布の具体手順。
4. **C10**: Tracktion 載せ替え vs Rust 自作（Glicol 型）の工数・リスク定量比較。

---

## 6. 推奨（最初の de-risking スパイクと順序）

エンジンは全下流の起点なので、**editor（VSCodium）に着手する前に、engine の最大の未知数を最小コストで実証**する。

### スパイク S1（最優先・editor 非依存）

**「ヘッドレス Tracktion → 実プラグインを 1 つホスト → `audioDeviceIOCallbackWithContext` の post-mix tap → 既存 `LinkAudioSink::commit`」の最小経路**を実機で通す。

- 検証する未知数: ① Tracktion を GUI 無しで起動し DeviceManager/message thread を配線できるか ② サンプルを 1 つ trigger/loop できるか ③ **実 VST3 もしくは AU インストゥルメントを 1 つロードして発音させ、同じ tap に通せるか（= A2 の動機検証。サンプル再生だけだと scsynth の "parity" 確認に留まり、載せ替えの理由を検証しない）** ④ post-mix バッファを RT-safe に tap して既存 Link Audio publisher に流し、Ableton で受信できるか。
- これが通れば「scsynth の役を Tracktion が果たす」中核**と、外部プラグインを鳴らすという載せ替えの動機**が同時に裏取りできる。**VSCodium fork とは完全に独立**で、現行スタックを壊さず並行検証できる。

### スパイク S2（S1 が通ってから）

**接続形態の確定** — TS/Node から「別プロセス + IPC（OSC 相当）」で S1 のエンジンを駆動し、既存 `OSCClient` seam に差し替えで嵌まることを確認。N-API addon 同居は open question 解消まで保留。

### スパイク S3（engine 目処後・editor 軸）

専用アプリ化は確定方針（UX + 弄れる範囲）。本調査の発見は**その目標をより安く到達できる可能性**を示す — VSCodium が「fork ではなく上流 rebuild スクリプト群」だったことから、専用アプリ化は **「リブランド rebuild（VSCodium 流・低保守）」→「patch 付き rebuild（一部独自 UI）」→「hard fork（Cursor 流・高保守）」のスペクトラム**として段階的に選べる。**まず軽い側から**始め、VST GUI 共存（B8）の解が要求する分だけ重い側へ寄せれば、最初から hard fork 固定で保守コストを払う必要がない。「専用アプリにするか」ではなく「専用アプリ感をどの重さの手段で出すか」の判断。

### Tracktion vs Rust 自作の方針

資産再利用の観点では **Tracktion 採用が工数・リスクとも有利**（ホスティング/再生/ミキシング/stretch を丸ごと借りる）。代償は C++/JUCE 依存・Edit/Clip インピーダンス・AGPLv3(JUCE)。Glicol は「Rust 自作も可能」の存在証明だが DSP/ホスティングを全て作り直す巨大コスト。**S1 が通る限り Tracktion を本命**とし、S1 で致命的なインピーダンスが出た場合に Rust 案を再評価する。

---

## 参考: 一次情報ソース一覧

- Tracktion Engine v3 release: <https://forum.juce.com/t/tracktion-engine-v3-released/62196>
- Tracktion tutorials 01(Playback)/03(StepSequencer): <https://github.com/Tracktion/tracktion_engine/tree/master/tutorials>
- WarpTimeManager doxygen: <https://tracktion.github.io/tracktion_engine/classtracktion_1_1engine_1_1WarpTimeManager.html>
- Tracktion / JUCE / Ableton Link LICENSE.md（各 repo）
- FSF AGPLv3 解説: <https://www.fsf.org/bulletin/2021/fall/the-fundamentals-of-the-agplv3>
- JUCE AudioIODeviceCallback: <https://docs.juce.com/master/classAudioIODeviceCallback.html>
- SC Server-Architecture / ClientVsServer（OSC IPC 前例）
- VSCodium repo（rebuild-upstream パイプライン）: <https://github.com/VSCodium/vscodium>
- Glicol（Rust 自作の存在証明）: <https://github.com/chaosprint/glicol>
