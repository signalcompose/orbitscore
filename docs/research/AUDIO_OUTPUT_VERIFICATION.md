# Research: オーディオ出力の自動検証 — DSL 静的スケジュール vs レンダリング PCM の突き合わせ

## 調査日

2026-06-21

## ステータス

調査記録（**論文化の可能性あり**）。実装は #307、研究トラックは #308。発端は #304 / PR #305（native audio parity）の検証が owner の耳に依存したこと。

## 関連

- #304 / PR #305 — native audio parity（pan / chop 領域再生 / per-slice gain）。本研究の発端。
- #307 — audio capture + programmatic verification harness（実装）。
- #308 — 本研究記録（paper potential）。

---

## 1. 研究課題と着想

### 課題

音楽ライブコーディング DSL（OrbitScore）は、ソースから **静的に発音スケジュールを計算できる**（各イベントの onset サンプル位置・レベル dBFS・pan・slice 境界）。一方、その通りに**実際に音が出ているか**の検証は、従来 **人間の耳**に依存していた（#304 の pan/slice/gain は owner の ear verdict で確認）。

### 着想

> オーディオも所詮デジタルデータ（interleaved な f32 PCM）。1 サンプルずつ読めば、定位・レベル・領域境界・タイミングはすべて**バッファ上の算術**で検証できる。

したがって、**レンダリング後の PCM を解析し、DSL が静的に計算した期待スケジュールと突き合わせれば、聴かずに客観検証できる**。これは:

- **pan** → L/R チャンネルの RMS 比が等パワー則 `equal_power_pan(p)` と一致するか
- **chop 領域** → `[offset, offset+dur]` 内のみエネルギー・外は無音か
- **per-slice gain** → スライス間 RMS 差が指定 dB 差と一致するか
- **timing** → onset フレーム位置が期待サンプル位置と一致するか（matched filter で sub-sample 精度）

を**自動 pass/fail のエビデンス**に変える。

---

## 2. 上位フレーミング: LLM の自己 PDCA パイプライン

本機構の本質は「オーディオのテスト手法」にとどまらない。**LLM エージェントの自律 PDCA ループ（Plan-Do-Check-Act）の Check 段を、オーディオ領域で人間不在に成立させる機構**である。

| 段階 | 内容 |
|---|---|
| **Plan** | LLM が DSL / エンジンを実装（期待スケジュールも DSL から導出） |
| **Do** | オフラインで決定論レンダリング → PCM |
| **Check** | 実 PCM を静的スケジュールと突き合わせ（**人間の耳が不要**） |
| **Act** | 差分（onset 遅れ・レベル誤差・定位ずれ）から自己修正 |

従来、オーディオ/グラフィクスのような**知覚信号ドメインでは Check に人間の評価が必須**で、これが自律反復のボトルネックだった。Check を機械可読化することで、**LLM が audio で PDCA を閉じられる**。

→ tier (c)（後述）自体が前例に乏しいうえに、**「LLM 自己検証ループ × audio(知覚信号)」**という上位フレーミングはさらに前例が薄い。これが論文の中心的貢献になりうる。

---

## 3. 用語・枠組み: golden-model conformance testing

隣接分野（特にハードウェア/DSP 検証）の確立した語彙で本機構を記述できる:

- **Golden Reference Model (GRM)** = DSL の静的スケジュール計算（権威ある期待値の源）。HW 検証では "executable functional specification" とも。
- **Device Under Test (DUT)** = オーディオエンジンのレンダラ。
- **Scoreboard / Checker** = 両者の出力をサンプル/イベント単位で許容誤差つき比較する検証器。
- **Co-simulation** = 同一スティミュラスで GRM とレンダラを並走させ出力を比較。

→ 正式な枠組み名: **"golden-model conformance testing of an audio renderer against its symbolic schedule"** / **"specification-as-oracle schedule conformance testing"**。

**重要原則（差分検証の成立条件）**: GRM（DSL スケジュール）と DUT（レンダラ）は**コードを共有してはならない**。共有すると同じバグを両者が持ち、差分が出ない。スケジュール計算はレンダラと独立に導出する。

---

## 4. 先行研究サーベイ

DAFx / NIME / ISMIR / SMC / ICMC / arXiv / ACM + 実ツールを4観点で並列調査した。

### 4.1 隣接分野の成熟手法（手法は既にある）

- **ハードウェア/DSP 検証（最も直接的・5/5）**: GRM/DUT/scoreboard/co-simulation（UVM/TLM）。浮動小数 or 固定小数のリファレンスモデルを実装とサンプル単位で比較。DSP ブロックでは MATLAB/Python の float リファレンス vs 固定小数 DUT。許容 = ±1 LSB / RMS 誤差境界 / ULP。
  - Verification Academy "Golden Model" 用語集: https://verificationacademy.com/cookbook/doc/glossary/golden_model
  - ISP UVM with TLM Reference Model, arXiv:1408.1150
  - TheHuzz（GRM ベース processor fuzzing）, USENIX Sec '22, arXiv:2201.09941
- **MPEG audio conformance（数値許容の gold standard・5/5）**: ISO/IEC 11172-4。ISO 公開の C リファレンス実装の出力を golden とし、DUT をサンプル単位比較。2段階許容: **fully compliant** = RMS(diff) < 2⁻¹⁵/√12 ≈ 8.81e-6 かつ max|diff| ≤ 2⁻¹⁴ ≈ 6.10e-5 / **limited** = RMS < 2⁻¹¹/√12 ≈ 1.41e-4。出力は [-1,+1] 正規化。
  - https://www.underbit.com/resources/mpeg/audio/compliance/
- **graphics reftest（許容の二層モデル・3/5）**: Mozilla/WPT の reftest。テスト対象技術を使わない独立リファレンスと比較。`fuzzy(minDiff-maxDiff, minPixelCount-maxPixelCount)` で「どれだけ違う」×「何ピクセル」を分離 → onset 許容（±N サンプル）と振幅許容（±ε dBFS）の二層に対応。SSIM（構造的類似度）も。
  - https://firefox-source-docs.mozilla.org/layout/Reftest.html
- **compiler differential testing / oracle problem（語彙・4/5）**: Csmith（Yang et al. PLDI 2011）。複数実装の出力一致で oracle を作る。**model-based testing**: 実行可能モデルが期待出力（oracle）を生成 → 本件はこのパターン（authoritative spec model 1 個 vs 実装 1 個の非対称版）。
  - Csmith, PLDI 2011: https://users.cs.utah.edu/~regehr/papers/pldi11-preprint.pdf
- **audio 数値許容の実務**: null test（位相反転して加算→残差が無音なら bit-exact。リファクタの同一性証明に有効だが、1 サンプルずれや 0.2dB 差で大きな残差＝スケジュール準拠検証には不向き）/ `numpy.testing.assert_allclose(atol, rtol)`（audio は near-zero 無音があるので atol 必須）/ ULP / null-test。

### 4.2 音楽オーディオの検証実態 — 3層

| Tier | 検証対象 | 普及度 |
|---|---|---|
| **(a) symbolic / event 層** | DSL → イベント列（onset 時刻・値・長さ）。エンジンはブラックボックス | **普通**（既定） |
| **(b) レンダリング音 vs 固定リファレンス** | レンダ → 保存済み golden / impulse / checksum と比較 | **稀** |
| **(c) レンダリング音 vs DSL の意味的スケジュール** | score から期待 onset/level/pan を導出し WAV を assert | **先行事例が見つからない** |

- **(a)**: TidalCycles（`compareP`/`comparePD` でパターンのイベント列を比較・SuperDirt/scsynth は起動しない）/ Strudel（hap を JSON snapshot）/ Sonic Pi（scsynth テストは TODO）/ FoxDot。
- **(b)**: **Faust `impulse-tests`**（impulse 応答を **解析式リファレンス**〔MATLAB/Octave〕と比較 = 解析的期待値。ただし DSP プリミティブで scheduler ではない・4/5）/ **Csound soak**（出力の **MD5** をベースラインと比較 = 任意の変化は検出するが「onset が 3ms 遅れた」とは言えない）/ **DawDreamer**（`np.allclose(atol=1e-7)` でフィデリティ assert）/ **SuperSonic**（Sam Aaron・scsynth 再実装・1400+ テストに "timing tests + audio output tests"。ただしエンジン単体検証で DSL スケジュール→audio 写像ではない・closest in live-coding）/ **W3C WPT Web Audio**（`OfflineAudioContext` でレンダ → spec 定義の式から計算した期待サンプルと per-sample 比較。DSP ノードで scheduler ではない・3/5）。
- **(c)**: 本サーベイ範囲で **未発見**。

### 4.3 最近接の学術先行研究: Antescofo / IRCAM モデルベーステスト

**Poncelet & Jacquemard（IRCAM/Inria）** — score-based interactive music system のモデルベーステスト。最も学術的に厳密な「音楽システムの時間的振る舞いを spec 駆動で検証」する仕事。

- mixed score（何がいつ起きるべきかの形式仕様）→ IR → **Timed Automata（Uppaal）** → カバリングテスト入力 + **各ケースの期待出力を形式モデルから計算** → Antescofo の実出力と比較 → 判定。
- 比較対象は **イベントのタイミング**（電子イベントの trigger 時刻）であって **生 PCM 波形ではない**。
- 文献: ICMC-SMC 2014（hal-01021617）/ ACM SAC 2015（hal-01097345）/ JNMR 45(2) 2016（doi:10.1080/09298215.2016.1173707）/ PhD thesis 2016。

→ **symbolic-spec-as-oracle の発想は完全に一致**するが、**audio renderer の一段上（イベント trigger 層）で止まり、レンダリング PCM には到達しない**。本件の (c) との差分はまさにここ。

### 4.4 計測手法（onset / level / pan）

我々のケースは**期待時刻が既知**（"detection-with-prior"）なので blind MIR より遥かに簡単。DTW/score-following は過剰（warp が無い）。

- **timing（主・matched filter）**: 各 onset の既知グレイン波形テンプレートと相互相関（`scipy.signal.correlate`）→ ピーク位置で **sub-sample 精度**。フレームベース onset 検出器（librosa hop=512 → 11.6ms）より高精度。誤差 = `T_detected − T_sched`。集計: mean=系統オフセット、std=jitter、max=最悪値。
- **blind cross-check（副）**: librosa `onset_detect(units='samples', backtrack=True)` / aubio（complex 既定）/ madmom（`OnsetEvaluation` が誤差 mean/std を直接出力・window=25ms）/ mir_eval（F値・window 可変、既定 50ms は人手アノテーション由来の慣習でオフラインレンダにはもっと厳しくできる）。
- **level**: onset 窓の RMS → dBFS（`20·log10(rms)`）。BS.1770/LUFS（pyloudnorm / Rust `bs1770` crate）は 400ms 積分で短イベント不適、per-onset は窓 RMS が単純。
- **pan**: ステレオ窓の L/R RMS から等パワー則 `λ=cos(α), ρ=sin(α), α=π/4·(p+1), λ²+ρ²=1` を逆算。中央 = 1/√2 ≈ 0.707（−3dB）。
- **設計上の注意**: 密なイベントは尾部が per-segment RMS を汚染するので、検証用フィクスチャ（テストスコア）はイベントを十分離し・チャンネル別に明確な定位・イベント間に無音を置く。

### 4.5 LLM agentic 自己検証と audio の空白

**(i) 自己改良フレームワーク（text/code で成熟）**: Self-Refine（Madaan et al. NeurIPS 2023・自己批評のみ＝grounded でない）/ Reflexion（Shinn et al. NeurIPS 2023・環境 feedback を verbal 化）/ Self-Debugging（Chen et al. 2023・unit test 実行）/ CRITIC（Gou et al. 2023・外部ツール結果）/ AlphaCodium（Ridnik et al. 2024・test pass/fail）/ SWE-Agent（Yang et al. 2024・bash/test 実行）。

**(ii) 決定的な原則 — grounded な Check は「必須」**:
- **CRITIC**: 外部ツール（検索 API・コード実行）を外すと自己修正は「marginal improvement or even deterioration」。
- **Huang et al., "LLMs Cannot Self-Correct Reasoning Yet," ICLR 2024**: 外部 feedback 無しの純粋な自己批評は**精度を下げる**（正答が誤答に反転する方が多い）。
- → **Check を客観・実行可能な oracle に grounding することが信頼性の前提**。本機構（PCM↔静的スケジュール）はまさにこの「audio 領域の客観 oracle」を作る試み。

**(iii) シミュレーション波形を oracle にする最近接構造**: RTL/HDL エージェント（PEFA-AI・ACE-RTL 等・LLM→Verilator 波形→比較）/ AnalogAgent（SPICE トレース）/ EnvTrace（実行トレース整合・synchrotron 制御）。**構造は一致するが電気・科学計測領域で audio ではない**。

**(iv) audio/music エージェントの Check は主に人間 or LLM 知覚判断**: MusicAgent（EMNLP 2023・評価は subjective）/ WavJourney（人間聴取）/ WavCraft（ループ無し）/ Audio-Agent（onset 精度は post-hoc 評価でループ内 oracle でない）/ **AudioGenie（ACM MM 2025・Check が大規模 audio-LM の知覚判断＝主観。CRITIC/Huang の知見ではこれは不安定）** / **SMART（2025・最近接 3/5・symbolic→audio をレンダし美的モデル評点を RL 報酬に。ただし訓練時 RL・主観的美的 oracle・golden schedule との点対点比較なし）** / SignalLLM（audio タスク無し）/ MaxMSP コード生成ベンチ（信号比較なし）。

**(v) 知覚ドメインの人間ボトルネック（明示された課題）**: "The Observability Gap"（arXiv:2603.26942）= 「コード論理と知覚結果の間に深い因果鎖がある領域では output-only 評価では不十分」← DSL→エンジン→PCM はまさにこれ。音楽生成評価サーベイ（Kader et al. 2025）= 客観指標と人間知覚の相関が低い／レンダ出力に対する評価枠組みが未整備。

→ **空白**: 「LLM が **audio を PCM で客観 Check** し、**DSL の静的スケジュール（golden model）と点対点で突き合わせ**、**推論時に自律ループを閉じる**」事例は本サーベイで未発見。最近接 SMART は訓練時 RL × 美的報酬で golden schedule 無し、RTL 系は電気領域、AudioGenie は LLM 知覚判断（grounded でない）。

---

## 5. 新規性の主張

**「レンダリング音 ↔ DSL 静的スケジュールの突き合わせをエンジンに内蔵した自己検証」（tier c）は、本サーベイ範囲で直接の先行事例が見つからない**（absence-of-finding・確信度 medium-high・存在しない証明ではない）。

部品は個別に既出:
- symbolic-spec-as-oracle（Antescofo・Faust）
- オフライン決定論レンダ（至る所）
- レンダリング PCM のサンプル assert（WPT Web Audio）
- 許容窓つき onset 評価（MIREX）

**新規な合成** = これら全層を1本のパイプラインに閉じること:
1. DSL が静的にスケジュール計算（onset サンプル・per-channel gain・pan・slice 境界）= oracle
2. エンジンが headless 決定論レンダ → PCM
3. PCM 解析（matched-filter onset / per-channel RMS / 等パワー pan 準拠）で層 1 と突き合わせ
4. **本番と同じエンジンがテストモードで自己出力を自己スケジュールに対して assert**

**さらに上位の新規性（§2・LLM 自己 PDCA）**: code 領域の agentic ループで確立した「Check は客観・実行可能 oracle に grounding すべき」原則（CRITIC / Huang et al. ICLR 2024）を、**audio 信号領域へ移植**する。すなわち「鳴っているか？」という本来主観的な知覚 Check を、**物理レベルの客観計算**（PCM onset ±許容 / per-channel RMS ±dB / 等パワー pan 則）に変換する。この変換が中核的知的貢献で、**audio を人間-耳ボトルネックなしに LLM の自律 PDCA 反復へ載せる**。

サーベイ判定: **[LLM agent + 音楽/audio DSL + レンダリング PCM 解析 + 静的 symbolic スケジュール + 推論時自律改良ループ] を組み合わせた事例は未発見**。最近接は SMART（訓練時 RL・主観美的報酬・golden schedule 無し）/ RTL 系（電気領域）/ AudioGenie（LLM 知覚判断＝grounded でない）で、いずれも本機構の核（決定論的 PCM↔静的スケジュール conformance を推論時 Check にする）と異なる。確信度 medium-high・absence-of-finding。

---

## 6. 実装ブループリント

```
GRM（DSL スケジュール計算・TS/Rust）
  各 note: { onset_sample, duration_samples, level_dBFS, pan, slice_region }

DUT（Rust オーディオエンジン）
  同一シーケンスを PCM にレンダ（AudioBackend seam の capture backend = 決定論オフライン）

Scoreboard / Checker
  各 onset N: matched filter で T_detected → error = T_detected − N
              窓 RMS → dBFS を level_dBFS と比較
              L/R RMS 比 → 等パワー pan を pan と比較
  無音区間: RMS ≤ noise floor（例 −90 dBFS）

許容階層（MPEG conformance + HW 検証より）
  Tier 1（bit-accurate path）: null test 通過（同一バイト）
  Tier 2（数値準拠）: RMS(diff) < 2⁻¹⁵/√12 ≈ −101 dBFS
  Tier 3（知覚準拠）: RMS(diff) < 2⁻¹¹/√12 ≈ −77 dBFS

CI gate（案）
  max|timing error| < 閾値（例 5ms、sample-accurate engine なら << 1 sample）
  全 level 誤差 ±0.5 dBFS 以内
  全 pan 誤差 ±0.05 以内
```

既存資産の再利用: `AudioBackend` trait（`rust/crates/orbit-audio-daemon/src/backend.rs`・`StubBackend` 前例）/ `orbit-audio-native` の RMS/dB assert 前例（resampler test）/ Rust `audio-processor-testing-helpers` crate（`assert_f_eq`/`test_level_equivalence`）。

入口: ① Rust の end-to-end ハーネス（実 WAV ロード→既知タイムライン render→assert・既存 scheduler ユニットテストの拡張）→ ② CLI `play --capture out.wav`（TS→daemon→render の全経路）。

---

## 7. 論文ポテンシャル

- **貢献**: (1) 音楽 DSL × scheduler × PCM レベルで閉じる golden-model conformance self-verification の初の定式化・実装。(2) それを **LLM エージェントの自律 PDCA の Check** として位置づけ、audio の人間-耳ボトルネックを除去する枠組み。
- **理論的動機（grounding）**: agentic 自己修正は **客観・実行可能な oracle が必須**（CRITIC でツール除去すると劣化 / Huang et al. ICLR 2024 で純粋自己批評は精度低下）。本機構は「audio の客観 oracle」を提供し、この既確立原則を**知覚信号領域へ拡張**する。
- **venue 候補**: NIME / ICMC / SMC / DAFx（音楽計算）、または cs.SE/cs.AI（LLM agentic + executable feedback の crossover）。LLM4MA（ISMIR 系ワークショップ）も交差点。
- **差別化**: audio 側 = Antescofo（イベント層で止まる）・Faust（DSP プリミティブ）・WPT（DSP ノード）・golden-master（prior render）/ LLM 側 = SMART（訓練時 RL・主観美的）・AudioGenie（LLM 知覚判断）・RTL 系（電気領域）。本機構の核「**DSL の意味的スケジュールを oracle に、scheduler が生成した PCM を証拠層にして、エンジン内蔵で推論時に自己検証する**」はいずれとも異なる。

---

## 8. 注意・限界

- **absence-of-finding ≠ 不在の証明**。obscure なプロジェクトは除外できない。確信度 medium-high。
- **許容は校正値**。MPEG 閾値は codec 復号（線形演算）由来で、非線形合成には別途校正が要る。
- **知覚品質は耳の領分**。客観量（レベル・定位・タイミング・領域境界・包絡）は機械化できるが、「音楽的気持ちよさ・音色」は人間評価が残る。本機構は**パリティに効く性質の自動化**が射程。
- ChucK / RTcmix の内部テストは浅い確認のみ（分類に不確実性）。

---

## 9. 引用一覧

### golden-model / 差分検証 / 形式
- Verification Academy: Golden Model — https://verificationacademy.com/cookbook/doc/glossary/golden_model
- ISP UVM with TLM Reference Model — arXiv:1408.1150
- TheHuzz, USENIX Sec '22 — arXiv:2201.09941
- Csmith, Yang et al. PLDI 2011 — https://users.cs.utah.edu/~regehr/papers/pldi11-preprint.pdf
- Metamorphic Testing — https://en.wikipedia.org/wiki/Metamorphic_testing
- MPEG-1 Audio conformance (ISO/IEC 11172-4) — https://www.underbit.com/resources/mpeg/audio/compliance/
- Mozilla Reftest — https://firefox-source-docs.mozilla.org/layout/Reftest.html
- SSIM, Wang et al. IEEE TIP 2004 — https://www.cns.nyu.edu/pub/eero/wang03-reprint.pdf

### 音楽システムのテスト / 検証
- Poncelet & Jacquemard, "Model Based Testing of an Interactive Music System," ACM SAC 2015 — https://hal.science/hal-01097345
- Poncelet & Jacquemard, "Test Methods for Score-Based Interactive Music Systems," ICMC-SMC 2014 — https://inria.hal.science/hal-01021617
- Poncelet, "An Automatic Test Framework for Interactive Music Systems," JNMR 45(2) 2016 — https://www.tandfonline.com/doi/full/10.1080/09298215.2016.1173707
- Peters, Place, Lossius, "An Automated Testing Suite for Computer Music Environments," SMC 2012 — https://jamoma.org/publications/attachments/smc2012-testing.pdf
- Chaudhary, "Automated Testing of Open-Source Music Software with OSW and OSC," ICMC 2005
- Aaron, Orchard, Blackwell, "Temporal Semantics for a Live Coding Language," FARM 2014 — https://www.cs.kent.ac.uk/people/staff/dao7/publ/farm14-sonicpi.pdf
- Wotawa & Valentan, "On the Automation of Audio Plugin Testing," IEEE QRS 2021 — https://ieeexplore.ieee.org/document/9724773/

### ツール / 実装
- Faust impulse-tests — https://ccrma.stanford.edu/~jos/aspf/Summary_FAUST_Program_Testing.html
- Csound — https://github.com/csound/csound （tests/soak, MD5）
- DawDreamer — https://github.com/DBraun/DawDreamer
- SuperSonic（Sam Aaron）— https://github.com/samaaron/supersonic
- W3C Web Platform Tests / Web Audio — https://github.com/web-platform-tests/wpt/tree/master/webaudio
- Plugalyzer — https://github.com/CrushedPixel/Plugalyzer
- pluginval — https://github.com/Tracktion/pluginval
- REAPER gold-reference + SoX null test — https://forum.juce.com/t/automated-testing-with-reaper-on-macos/65905
- JUCE DSP Testbench — https://github.com/AndrewJJ/DSP-Testbench
- audio-processor-testing-helpers (Rust) — https://crates.io/crates/audio-processor-testing-helpers
- SOF Project Testbench — https://thesofproject.github.io/latest/developer_guides/testbench/test_audio_quality.html

### MIR / 計測
- librosa — https://librosa.org / onset_detect
- aubio — https://aubio.org
- madmom（OnsetEvaluation）— https://madmom.readthedocs.io
- mir_eval — https://github.com/mir-evaluation/mir_eval
- Essentia — https://essentia.upf.edu
- Böck, Krebs, Schedl, "Evaluating the Online Capabilities of Onset Detection Methods," ISMIR 2012 — https://zenodo.org/records/1416036
- Böck & Widmer, SuperFlux, DAFx 2013 — https://www.dafx.de/paper-archive/2013/papers/09.dafx2013_submission_12.pdf
- Bello et al., "A Tutorial on Onset Detection in Music Signals," IEEE TSA 2005
- MIREX Audio Onset Detection — https://www.music-ir.org/mirex/wiki/2021:Audio_Onset_Detection
- ITU-R BS.1770 — https://www.itu.int/rec/R-REC-BS.1770 / pyloudnorm — https://github.com/csteinmetz1/pyloudnorm
- Pan laws (CMU) — http://www.cs.cmu.edu/~music/icm-online/readings/panlaws/panlaws.pdf

### LLM agentic 自己検証 / grounded feedback
- Self-Refine, Madaan et al. NeurIPS 2023 — https://arxiv.org/abs/2303.17651
- Reflexion, Shinn et al. NeurIPS 2023 — https://arxiv.org/abs/2303.11366
- Teaching LLMs to Self-Debug, Chen et al. 2023 — https://arxiv.org/abs/2304.05128
- CRITIC, Gou et al. 2023 — https://arxiv.org/abs/2305.11738
- **Huang et al., "LLMs Cannot Self-Correct Reasoning Yet," ICLR 2024** — https://arxiv.org/abs/2310.01798
- AlphaCodium, Ridnik et al. 2024 — https://arxiv.org/abs/2401.08500
- SWE-agent, Yang et al. 2024 — https://arxiv.org/abs/2405.15793
- Voyager, Wang et al. 2023 — https://arxiv.org/abs/2305.16291
- Pan et al., "Automatically Correcting LLMs (survey)," 2023 — https://arxiv.org/abs/2308.03188
- "When Can LLMs Actually Correct Their Own Mistakes?" 2024 — https://arxiv.org/abs/2406.01297
- The Observability Gap, 2026 — https://arxiv.org/abs/2603.26942

### LLM × audio/music エージェント
- MusicAgent, Yu et al. EMNLP 2023 — https://arxiv.org/abs/2310.11954
- WavJourney, Liu et al. 2023 — https://arxiv.org/abs/2307.14335
- Audio-Agent, Wang et al. 2024 — https://arxiv.org/abs/2410.03335
- AudioGenie, Ren et al. ACM MM 2025 — https://arxiv.org/abs/2505.22053
- SMART（symbolic→audio aesthetic reward）, Hang et al. 2025 — https://arxiv.org/abs/2504.16839
- SignalLLM, Ke et al. 2025 — https://arxiv.org/abs/2509.17197
- Benchmarking LLM Code Gen for Audio (MaxMSP), Banar & Demeyer 2024 — https://arxiv.org/abs/2409.00856
- A Survey on Evaluation Metrics for Music Generation, Kader et al. 2025 — https://arxiv.org/abs/2509.00051

### LLM × シミュレーション oracle（構造的最近接）
- EnvTrace（execution trace alignment）2025 — https://arxiv.org/abs/2511.09964
- AnalogAgent（SPICE feedback）2025 — https://arxiv.org/abs/2603.23910
- PEFA-AI（RTL generation）2025 — https://arxiv.org/abs/2511.03934
