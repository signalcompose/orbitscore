# Research: Rust での 3rd-party プラグインホスティング（CLAP / VST3 / AU）feasibility

**調査日**: 2026-06-19
**文脈**: post-2.0 ネイティブエンジンを **Tracktion(C++/JUCE, GPL) でなく Rust 自作（既存 `rust/` = orbit-audio）で進める**最終判断の最後の関門。正本の判断記録は `docs/development/POST_2.0_ENGINE_AND_DISTRIBUTION.md`。
**調査方法**: deep-research harness（5 angle・一次情報 23 ソース → 105 claim 抽出 → 25 を 3 票敵対的検証 → 23 確認 / 2 反証）。一次情報＝各 crate の docs.rs/GitHub・CLAP/VST3 公式・維持者ブログ。

---

## 0. 結論

**Rust で 3rd-party オーディオプラグインをホストすることは、permissive 縛り・macOS Apple Silicon 主・既存 orbit-audio(cpal) 前提のいずれでも技術的に実現可能。** 3 標準すべてに維持された permissive な Rust binding が存在し、Rust 製 DAW がそれを使って実際にプラグインをホストしている前例もある。→ **engine = Rust に高確度で寄せられる。**

ただし「**binding/生態系が存在し動作例がある**」の確認であって「**フル機能ホストの production 実績**」ではない。残る証明は **CLAP 統合スパイク + RT 統合設計**（§G・open questions）。

**成熟度・工数の序列: CLAP ＞ AU ＞ VST3。** 最初の最小スパイクは **CLAP（clack-host + cpal）**が最有力で、orbit-audio の既存 cpal callback への統合経路も最短。

**★ 最大の発見: VST3 が MIT 単独ライセンス化**（VST3 SDK 3.8, 2025-10）。GPLv3/Steinberg-proprietary デュアルは廃止。→ **copyleft 回避を理由にした Tracktion フォールバックの主動機が消滅**。

---

## A. CLAP ホスティング（最成熟・first spike）（confidence: high / 3-0）

- **`clack-host`**（host 専用 crate）が **feature-complete**。`.clap` ロード(`PluginEntry::load`) → `PluginFactory` で列挙/instantiate → `PluginInstance` → `activate` → `StartedPluginAudioProcessor::process`（可変 buffer/SR）→ `InputEvents`/`OutputEvents`（`NoteOnEvent` 等）まで**高レベル安全 API で網羅**。**cpal 連携の動作 host example 同梱**。
- ライセンス: clack = **MIT OR Apache-2.0**、CLAP SDK(free-audio/clap) = **MIT 単独**。closed/商用に copyleft 義務なし。Bitwig/u-he も商用利用・費用契約不要。
- CLAP は stable ABI を定義し、host が要る能力が標準 extension に: `audio-ports`(I/O) / `params`・`param-indication`(自動化) / `note-ports`(note 入力) / `track-info` / `transport-control`（transport/tempo・**README が draft と明記**）。→ time-stretch 比のようなブロック毎パラメータ供給は params 経由で素直に書ける（transport 供給は draft 段階に留意）。
- **caveat**: pre-1.0（clack-host v0.1.0, 2026-05 更新）で active development → **API breaking 可能性**。cpal example は output-only（duplex 入力なし）なので effect でなく synth が検証向き。production 採用の確証は repo 上に無い。
- 出典: <https://github.com/prokopyl/clack> / <https://docs.rs/clack-host/latest/clack_host/> / <https://github.com/free-audio/clap>

## B. VST3 ホスティング（ライセンス障壁が消滅・ただし工数最大）（confidence: high / 3-0）

- **★ VST3 SDK は 3.8（2025-10-31 頃）以降 MIT 単独ライセンス**。Steinberg 公式逐語 *"Since version 3.8, VST 3 is licensed under MIT license"* / *"Licensing under GPLv3 and the Steinberg proprietary license is no longer available"* / *"Neither fees nor memberships are required. No need to sign any documents. The license is perpetual"*。→ **登録・署名・費用なしで closed/商用ホストを copyleft 義務なく配布可**。研究設問 B4 の前提（proprietary tier を選ぶ）自体が消滅。
- **Rust host 手段** = `vst3` crate（coupler-rs/vst3-rs, Micah Johnston 維持, **MIT OR Apache-2.0**）。libclang で C++ ヘッダから自動生成、host 側(`IHostApplication`/`IComponentHandler`)/plugin 側双方の全 API surface を露出。**ただし load→process→params→transport の高レベル hosting framework は無く、COM/host ロジックは全て unsafe で手書き** = 3 標準中**工数最大**。維持者が「closed-source host を含む C++ 同等ユースケース」を設計目標と明記。
- **caveat**: v3.8+ SDK が前提（旧版は歴史的 dual-license のまま）。VST2 ヘッダは別ライセンス（VST3-only host には無関係）。VST trademark/logo 使用は別途 Steinberg 規約。
- 出典: <https://steinbergmedia.github.io/vst3_dev_portal/pages/VST+3+Licensing/VST3+License.html> / FAQ / <https://github.com/coupler-rs/vst3-rs> / <https://micahrj.github.io/posts/vst3/>

## C. AudioUnit (AU) ホスティング on macOS（中間・permissive）（confidence: high / 3-0）

- **AUv2 primitive 層**: `coreaudio-rs`(v0.14.2, MIT/Apache) + 依存 `objc2-audio-toolbox`(Zlib OR Apache OR MIT)。`AudioComponentDescription` / `AUAudioUnit` / `AURenderCallbackStruct` / `AudioUnitConnection` / `AudioUnitSetProperty`/`AudioUnitRender` 等、AU instantiate・configure・render に必要な型/callback を露出。**turnkey な host layer は無し**（orchestration は実装者責務）。
- **AUv3 含む高レベル経路**: `objc2-avf-audio`(v0.3.2, permissive)。`AVAudioUnit` が AU を表す `AVAudioNode`、`instantiateWithComponentDescription_options_completionHandler` の**非同期 instantiation** で 3rd-party AU をロード。`kAudioComponentInstantiationLoadOutOfProcess` で **out-of-process/sandboxed AUv3** もロード可。
- **caveat**: out-of-process AUv3 の **discovery/registration**（enumerate 時に v2 しか見えない / "failed to find component" 等）は**言語非依存の Apple プラットフォーム側既知問題**。「API ができる」と「容易に動く」は別。
- 出典: <https://github.com/RustAudio/coreaudio-rs> / <https://docs.rs/objc2-audio-toolbox/> / <https://docs.rs/objc2-avf-audio/latest/objc2_avf_audio/struct.AVAudioUnit.html>

## D. 先行例（Rust で plugin を「ホストする」実在プロジェクト）

- **MeadowlarkDAW**（`clack` ベース・`Dropseed`）、`plugin_host`、`rust-vst3-host`（HelgeSverre）、Omni DAW、Swift+Rust AU 例（cornedriesprong）、rs-vst-host(blog)。→ **Rust で 3rd-party プラグインホストは実在**（特に Meadowlark が clack の実証）。nih-plug は「作る」側で別物。
- 出典: <https://github.com/MeadowlarkDAW/Dropseed> / <https://lib.rs/crates/plugin_host> / <https://github.com/HelgeSverre/rust-vst3-host>

---

## 4. 推奨（engine 確定 + スパイク順）

1. **engine = Rust（既存 `rust/`）で確定方向**。Tracktion の「turnkey ホスティング」優位は、CLAP ホスティングが Rust で成熟 + VST3 の MIT 化 + Tracktion 自体の GPL(freemium foreclose) で相殺。**copyleft 回避を理由に Tracktion へ戻す動機は消えた**。
2. **最小スパイク順 = CLAP → AU → VST3**（これは **de-risking ladder＝統合を最も安く実証できる順**であって、**ユーザーが欲しいプラグインの優先度ではない**。実プラグイン資産は AU/VST3 側に多く、**出荷価値は AU/VST3 のカバレッジに依存**する。ホスティング本体の作業量〔VST3 の COM 手書き・AUv3 registration の落とし穴〕は依然この先にある）:
   - **S1: CLAP**（`clack-host` + 既存 orbit-audio cpal callback に統合 → 実 CLAP 楽器を1つロードして発音 → render tap）。最短・最成熟。
   - **S2: AU**（`objc2-avf-audio` / AVAudioEngine。macOS プラグイン資産。AUv3 registration の落とし穴に注意）。
   - **S3: VST3**（`vst3` crate。MIT で license クリーンだが host ロジック手書き＝工数最大、最後）。
3. **Tracktion フォールバック条件**（弱い）: clack の pre-1.0 breaking が頻発 / CLAP 統合の RT が解けない、等が判明した時のみ再考。license 理由のフォールバックは不要に。

## 5. Caveats / 時間依存性
- **VST3 MIT 化は 2025-10（3.8）の極めて新しい変更**。検証中、誤った「2024-10 MIT 化」「proprietary 残存」の 2 claim が敵対的検証で 0-3 棄却された。**正しくは 2025-10**。判断は v3.8+ 前提で。
- **binding 存在 ≠ production 実績**。clack は pre-1.0。フル機能ホストの実績確証ではない。
- permissive 確認は各 binding crate / SDK 本体に対するもの。runtime でロードする 3rd-party プラグイン本体・Apple フレームワーク・VST 商標は別規約（host の copyleft 義務とは別）。

## 6. Open Questions（本ラウンド未確証・別途）

> **⚠️ リスク階層に注意**: 本調査が retire したのは **binding レベルのリスク**（「clack はプラグインをロード/process できるか」= 確認済）。だが **engine = Rust の賭けの本体は integration レベルのリスク** — 「プラグイン processing を orbit-audio の **ライブコーディング scheduler + （lock-free 化予定の）RT callback + 別プロセス WebSocket daemon** に RT 安全に載せられるか」で、これは本調査が**一切触れていない**別クラスのリスク。**S1 はこれを retire するために在る。**「binding が動く」≠「Rust に engine 確定」。

- **D7/G（統合設計・★最重要）**: 上記の通り orbit-audio の RT 経路へのプラグイン統合方式（同一 callback / 別スレッド / プロセス分離）が engine 判断の本丸。S1 着手前に設計検証。
- **E（time-stretch）**: Signalsmith Stretch の Rust binding は**存在の兆候あり**（ソースに `bmisiak/ssstretch` / `signalsmith-stretch` crate が登場）だが、ライセンス/品質/レイテンシ/FFI 詳細は 23 確認 claim に**含まれず未確証**。engine 内 sample ノードの stretch は別途調査。
- **F（配布）**: 任意 VST/AU をロードするホストの Mac App Store sandbox 不可 / notarize 直接配布・Steam の現実性は**本ラウンド未確認**（AUv3 out-of-process の registration とも絡む）。
- **D7/G（統合設計）**: orbit-audio の cpal callback + 別プロセス WebSocket daemon に対し、プラグイン processing を **RT 安全に統合する最適方式**（同一 callback / 別スレッド / プロセス分離）は一次証拠で未裏付け → **S1 着手前に設計検証**。

## 参考: 一次情報
- CLAP: clack(GitHub/docs.rs) / free-audio/clap
- VST3: Steinberg VST3 Licensing portal + FAQ / coupler-rs/vst3-rs / micahrj blog
- AU: coreaudio-rs / objc2-audio-toolbox / objc2-avf-audio(AVAudioUnit)
- 先行例: MeadowlarkDAW(Dropseed) / plugin_host / rust-vst3-host
