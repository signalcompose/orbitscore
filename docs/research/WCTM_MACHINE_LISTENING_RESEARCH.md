# Research: 機械の耳 — WCTM 実時間リスニング・形式理解の実装調査

## 調査日
2026-07-03

## 調査目的

WCTM（"Who Conducts the Machine?"・2026-08-07 藝大千住 第7ホール・上演10分）の最大ポイントである
**「AI がいかに楽曲の音を聞いて理解するか」**（機械の耳）について、pi ベース専用ハーネス採用
（[WCTM_AGENT_HARNESS_EXTERNAL_DATA_RESEARCH](WCTM_AGENT_HARNESS_EXTERNAL_DATA_RESEARCH.md)・決定 #60-#63）後の
実装アーキテクチャを確定するための判断材料を収集し、実装案 10 案を立案する。

前提制約（owner 指示 2026-07-03）: Cycling '74 Max 前提・必要なら Max オブジェクト開発可（最終手段）・
**手戻り最小・確実性優先**・本番まで約5週間（W6 = リハ#1）。本書はサーヴェイ + 計画案であり実装はしない。

## 調査方法

deep-research ハーネス（Workflow・**Sonnet 5 × 24 agents**・built-in WebSearch/WebFetch）。
7角度に分解 → 並列スイープ → load-bearing claim 93 件抽出 → **上位 16 件を敵対的検証**
（一次情報源への直接アクセスで REFUTE を積極的に試行）→ **CONFIRMED 8 / REFUTED 7 / UNCLEAR 1** → 完全性クリティーク → 合成。

> 検証の成果例: AI 検索要約が「BTrack はジャズライブで実戦投入」と**誤生成**していたことを README 直接取得で特定 /
> vb.aubio~ を「オンセット検出のみ」とした claim をソースコード直接確認で覆した（実は tempo/beat 推定メソッドを実装済み）/
> 「zsa.descriptors の Apple Silicon 対応情報なし」を公式パッケージページで反証。
> **二次情報・AI 要約の鵜呑みは本調査の規模でも 7/16 件の誤りを生んでいた。**

---

## 結論サマリ

1. **完全自動の耳で本番運用された頑健な先行例は存在しない。** 数十年の実戦（Voyager / OMax-ImproteK-Djazz / Music Plus One）はすべて「自動推定 + 人間の信頼度ゲート介入」または「人間タップ / 手動キュー」。IRCAM 自身がジャズ即興で自動ビートトラッキングを**撤退**させ手動タップに倒している（AIMC 2021 §3.1・一次確認済）。
2. **形式把握は特徴量ストリームからは創発しない。** ReaLJam（DeepMind 専用 RL モデル）でさえ「曲構造への配慮がない」と評価された実証データがある。**bar:beat + セクション/コード index の明示ラベル注入**が正当化される（spec §10.6 の推奨初期案 (a)+(b) を裏書き）。
3. **シンボリック側路（MIDI の耳）には 40 年の実戦前例がある**（George Lewis Voyager・1985-・pitch-to-MIDI）。guitar-to-MIDI（Jam Origin MG2 等）は最有力の耳のアップグレードだが、**ギタリストの楽器仕様（スチール弦か）と Apple Silicon 実機検証が先決**。
4. **和声一致度による位置検証**は構成要素（Fujishima PCP 類似度 1999・Nakamura 反復対応 HMM 2015 等）がすべて枯れている一方、**統合自体は前例のない新規設計**。リハーモナイズと位置ドリフトを区別できない構造的限界があり、粗い調域アンカー + 小節集約で緩和する。kill-criteria 付き挑戦枠。
5. **ピアノ bleed は耳の全層を汚染する**が、本作は加害源の MIDI が既知という文献にない好条件を持つ。物理定石（クリップマイク + ゲート）を土台に、**MIDI タイムスタンプ連動の解析窓マスク**が安価で新規性のある緩和策。
6. **spec 衝突を発見**: WCTM spec §2「Max が Link 駆動・エンジン追従」と実装済み #283「エンジンが Link テンポリーダー」は**主従が逆**。テンポ権限の向きは owner 決定事項（→ [実装案 doc](WCTM_LISTENING_IMPLEMENTATION_PROPOSALS.md) 決定事項 D2）。

---

# Part I: サーヴェイ結果

## 1. クロックの耳（ビートトラッキング）

### 確認できた事実

| 事実 | 確度 | 出典 |
|---|---|---|
| BTrack / BeatNet / madmom / Essentia をジャズライブ本番で使った一次報告は**不在**（敵対的再調査でも同結論・AI 要約の誤生成 1 件特定） | 検証済 | 各 README/論文直接確認 |
| IRCAM OID 系（OMax→ImproteK→Djazz）は自動ビートトラッキングを明示的に「撤退」し手動タップ採用 | 検証済 | Smailis et al., AIMC 2021 §3.1 |
| madmom の streaming 対応は未実装・未解決（2025-02 メンテナ発言） | high | CPJKU/madmom discussion #493 |
| BeatNet は設計上 causal（online）・粒子フィルタで原理上は多仮説事後分布を保持するが、**公開 API に信頼度スカラーなし**（内部の CRNN 活性化 0-1 + IG_THRESHOLD=0.4 は存在 = 露出は追加エンジニアリング） | 検証済 | arXiv:2108.03576 + ソース確認 |
| btrack_external（Max ラッパー）は 2017 年停止・Intel のみ。BTrack 本体は活発（v1.0.7, 2025-12・GPLv3・C++/CMake）→ arm64 は自前ビルド | high | GitHub 直接確認 |
| **vb.aubio~**（v7b1/vb-objects）は macOS Intel/ARM64 ネイティブ・aubio の onset **+ tempo/beat 推定**の両メソッドを実装済み（buffer~ 上のデータ解析） | 検証済（ソース確認） | github.com/v7b1/vb-objects |
| Max の Link package は読み取り安定・**Max からの tempo 書き込みは不安定**。ただしこれは Max 固有バグでなく Link プロトコルの合意メカニズム（last-writer 系 mesh）由来 | 検証済（訂正付き） | C74 フォーラム + Link 公式 doc |
| ドラムトリガー（Roland TM-2 等）の「クロストーク抑制」は**同時打点で片方のノートを意図的に欠落させる** | medium | 製品仕様 |

### 設計含意

- **クロックの耳を自動トラッキング単独に賭けるのは先行知見と不整合**。spec §2 の「信頼度ゲート」設計は正しいが、既製トラッカーは信頼度を公開 API で出さない → ゲート信号は自前になる。
- **⚠️ spec 衝突（要 owner 決定）**: spec §2 は「Max がビートトラッキング → Link 駆動・エンジン追従」だが、エンジンは #283 で **Link テンポリーダー**（last-setter-wins・Live のテンポは触らない運用）として実装済み。Max からの tempo push は上記のとおり不安定でもある。**「タップ/トラッカー → Bridge/エンジン経由で Link に set」**（エンジンの実証済み経路を再利用）の方が、Max から直接 push するより実装実績がある。

## 2. テクスチャの耳（楽器別特徴量）

### 確認できた事実

- **Puckette 系（bonk~ / fiddle~ / sigmund~）は Apple Silicon 向け再コンパイル済みで動作**（high）。ただし bonk~ はフィルタ数のライブ変更でクラッシュ報告 → 本番中パラメータ凍結。sigmund~ に明示的信頼度出力なし。
- **fluid.pitch~**（FluCoMa）: YinFFT/HPS/Cepstrum 選択可・**0-1 の明示的 confidence 出力**（検証済・公式リファレンス逐語確認）。単一ピッチ設計でポリフォニックでは信頼度低下と明記 → **信頼度低下をギターの単音/和音判別の代理指標に使える**（未実証の設計案）。
- **FluCoMa 本体**: BSD-3-Clause・v1.0.9（2025-08）・universal binary。ただし 2023-03 に助成終了、**コミュニティ保守**（本番直前サポートはフォーラム頼み = リスク認識）。fluid.onsetslice~ のレイテンシ = hop サイズ、fluid.chroma~ 等 = FFT サイズ。
- **Max 9.1（2025-10）で ABL DSP オブジェクト追加**（abl.dsp.pitchestimator~ 等・検証済）。新しく実戦報告皆無だが第一級の保守元（Cycling '74/Ableton）。
- zsa.descriptors: Max 8 期に無償版破損報告・**公式パッケージページに AS 対応記載はある**（検証で訂正）が資料が古く、新規採用は FluCoMa / ABL 優先が無難。
- ドラム分類: SMC-LAB/drumtranscription_maxmsp（KNN/k-means・ICASSP2013）は存在するが**単離音源前提**。帯域分割エネルギー判別（kick 低域/snare 高域）は軽量な実戦手法として存在するが、**アンサンブル被り環境での精度は未検証**（UNCLEAR）。
- **ピアノ bleed 対策の定石** = 物理（ピアノ内部の高指向性マイク + 蓋 + ゴボ）+ ゲート/エキスパンダー。適応フィルタ（LMS）は音楽信号に不適（信号漏れで目的信号ごと削る）・Wiener の方が有効（2016 研究）。RLS で 30-34dB 低減の 2026 プレプリントは**オフライン検証のみ**。
- **本作固有の好条件**: 加害源（ピアノ）の MIDI が完全既知。「既知 MIDI 駆動ピアノの被りを他マイクから引く」実演事例は不在（= 新規性）だが、**MIDI onset 時刻で解析窓の信頼度を下げる/マスクする**だけなら信号処理不要で安価（→ 案5）。

### 設計含意

「動いた」報告の確度順: ① fzero~（Max 本体組込 = AS 自動保証）② コミュニティ移植の bonk~/fiddle~/sigmund~ ③ FluCoMa（universal build 報告あり・直近確認は手薄）④ ABL 系（新しすぎ）。
**トランペット = fluid.pitch~（confidence 付き）+ クリップマイク**が第一候補。**critic 指摘: そもそも「楽器別」特徴量はクロス被りが無視できる前提であり、その前提自体を W3-W4 に実測で確定させるべき**（本調査最大の盲点）。

## 3. ハーモニーの耳（chroma・一致度スコアリング）

### 確認できた事実

- 「複雑ジャズの実時間 ACE は music-making に供給できない」（AIMC 2021）は**一次資料で原文確認**。2021-2026 に覆す反例は見つからず（不在の証明ではない）。
- **fluid.chroma~**: 実時間 12 次元 PCP・レジスター情報は失う・レイテンシは FFT サイズ依存（FFT4096 ≈ 93ms は機械的概算・実測値ではない）。
- **リハーモナイズ問題（構造的限界）**: 低い chroma 一致度は「位置ドリフト」と「正当なリハーモナイズ」を区別できない。ジャズでは後者が常態 → 厳密な voiced chord でなく**調域/ダイアトニック集合/scale-degree の粗いアンカー**を小節単位で集約評価するのが標準的緩和。
- **ピアノ支配問題**: ルームマイクの chroma は「人間の和声」でなく「機械自身の既知出力」を主に反映する（ピアノがアンサンブル最大音量）→ ギター専用マイク or 既知ピアノ出力の予測減算が建築上必要。
- 枯れた構成要素: Fujishima PCP コサイン類似度（1999）・Krumhansl-Schmuckler 調相関・HCDF（2006）・オンライン DTW（Dixon）・**Nakamura et al.（2015）の停止×再開確率分解による反復/スキップ対応 HMM（O(N)・反復検出で Antescofo を大差で上回る実測）**。
- Stark & Plumbley（ICMC 2009）実時間コード認識 Max external は実在（単一楽器・小語彙・GPL・2016 で停滞）。「単純小語彙は実時間で動く実績あり / 複雑ジャズ大語彙は未解決」を混同しない。
- **これらを統合した「リードシート事前知識 + 一致度で位置検証」システムの前例はゼロ**（角度3・4 の両調査で一致）。作るなら新規統合 = 未実証設計。

## 4. 形式内位置トラッキング（spec §10.6）

### 確認できた事実

- **頑健な実戦例は例外なく人間介在型**（high・load-bearing）。完全自動の形式位置推定で本番運用された前例は見つからず。
- **「Vamp till cue」= 数十年運用されてきた機械学習ゼロの解**: バンドリーダーの物理ジェスチャーでリピート終了を明示合図。WCTM のヴァンプドリフト問題に直接転用可能。
- Ableton Link は**形式の概念を持たない**（tempo/beat/phase のみ）→ bar counter + セクション管理は別レイヤー。
- **Antescofo**: 保守継続（1.0-599・2024-05・macOS x86/arm）だが、**自由即興の hands-free 実行機能はない**（設計者 Cont 明言）・反復/スキップは専用手法（Nakamura）に劣る・「入れれば位置が分かる」は成立しない。
- 音声-譜面アラインメントの明記された失敗モード =「似た音の繰り返し区間（コーラス）での誤検出」→ **AABA 形式はこのリスクの教科書例**。
- リアルタイムのドラムフィル検出・ストリーミング構造区分検出の実戦前例なし（研究はオフラインのみ）。

### 設計含意

spec §10.6 の推奨初期案（(a) オペレーター舵取り + (b) エンジン bar counter のハイブリッド）は**本調査で最も強く裏付けられた選択**。自動化はその上の「検証/警告レイヤー」として積む（置換ではない）。

## 5. シンボリック側路（MIDI の耳）

### 確認できた事実

- **George Lewis Voyager（1985-・数百公演）**: IVL Pitchrider（pitch-to-MIDI・1983）で管楽器を interval/amplitude ストリーム化。「audio 解析を回避する MIDI の耳」の最古・最実績の前例（ただし単音楽器）。
- **Guitar**: Jam Origin MIDI Guitar 2（$149.95・特殊 PU 不要・**MG3 はベータでベンダー自身が本番非推奨**・**Apple Silicon ネイティブ対応は公式文書から判然とせず要実機検証**）/ Fishman TriplePlay（~7-14ms・磁気式 = スチール弦のみ・アコースティックは公式非推奨）/ Roland GK-5（粘着装着可・低音弦 12ms+）。**ジャズの密なヴォイシング（9th/11th/13th/オルタード）での精度定量データは不在**。
- **⚠️ 前提確認が先決**: ギタリストの楽器（スチール弦か・エレクトリックか・ピックアップ装着許容か）が未確認のまま全てが宙に浮く。
- **Trumpet**: 専用 MIDI ソリューション不在は確認。ただし**単音 pitch-to-MIDI は 40 年枯れた技術**で、トランペット音域（≥ E3 ≈ 165Hz）はギター低音（E2 ≈ 82Hz）より周期検出に有利。「クリップマイク（DPA 4099 等・被り分離の確立手法）+ fluid.pitch~」は理論上成立するが**実演前例のない組み合わせ**。
- MIR の「semantic gap」概念 + Notochord 等のシンボリック生成の低レイテンシ実績が「MIDI イベント > audio 特徴量（LLM 文脈として）」仮説を間接支持（直接比較研究は不在）。

## 6. LLM 側の理解（表現・文脈設計）

### 確認できた事実

- **ReaLJam（DeepMind）のユーザー評価**: 専用 RL モデルでも「曲構造への配慮がほとんどない」「4小節パターンに気づかない」→ **和声・メロディ特徴の流し込みだけでは形式把握は創発しない**（実証データ・load-bearing）。
- **「Can LLMs Reason in Music?」**: 全モデルが Musical Form Extraction（形式・小節長の維持）で系統的に失敗。ただし「自力推論での失敗」であり「明示ラベルを与えたら改善するか」の直接検証は不在。
- **JAMMIN-GPT**: LLM に記法選択の自由を与えると依頼と不整合な記法を選好（chord-symbol バイアス）→ **出力スキーマを OrbitScore DSL に固定している WCTM 設計は正しい**。
- **Anthropic 公式プロンプトキャッシュ指針**（一次資料）: 厳密プレフィックス一致・static prefix（system + スキル + リードシート）+ rolling suffix（直近特徴量 + .orbslog 末尾）・最小キャッシュ長 1024-4096 トークン・静的部にタイムスタンプ混入厳禁。
- Opus 4.8 の mid-conversation system message = キャッシュを無効化せずオペレーター舵取りを差し込むチャネルとして使える。
- ReaLJam/StreamMUSE の 100ms 級は専用小型モデルの領分。**チャット型 LLM は数秒 = 「2-4 小節周期・quantize で次小節から効く」という WCTM 設計と整合**（先行研究の reflex/deliberation 分離とも一致）。
- 数値特徴量のテキストエンコーディングの音楽特化ベストプラクティスは不在 → 実装時に小さく A/B（表形式 vs 自然言語要約）。

## 7. カスタム開発経路

| 経路 | 特性 | 本番適性 |
|---|---|---|
| **node.script (Node for Max)** | **別 OS プロセス・クラッシュ隔離・自動再起動（最大5回・既定有効）**・npm 可（Essentia.js/Meyda は理論上動くが組合せ実績なし）・制御レートのみ | ◎ 小節単位集約と相性良 |
| v8/v8ui (Max 9) | 高速 JS だが **in-process**（Max ごと落ちる） | △ |
| C SDK / min-devkit | in-process・5週間でのゼロから新規開発の成功例は見つからず | ✗ 最終手段（owner 方針と整合） |
| RNBO | DSP/MIDI 特化・ML 推論/OSC ネットワーク I/O サポート記載なし | ✗ 用途外 |
| nn~ (ACIDS) | arm64 対応・TorchScript なら解析系も理論上可だが**公開 beat/onset モデル不在** = 自前 TorchScript 化の追加工数 | △ |
| Python daemon + OSC | 査読論文に採用実例あり・watchdog/再接続は自前 | ○ |
| Data Knot (旧 SP-Tools) | **alpha・M1 で Max クラッシュ報告（開発者も認知）** | ✗ クリティカルパス禁止 |

実戦知: **本番前にパッチを凍結し本番中は編集しない**（クラッシュは編集中に集中・凍結状態での長期無クラッシュ報告あり）。

## 8. 完全性クリティークが出した盲点（8点・要対応）

1. **kill-criteria 不在**: 各コンポーネントに「いつまでに・何が出なければ・何に切り替える」の日付・閾値・代替先がない → 案10 で解消。
2. **クロス被りの前提未検証**: 「楽器別」特徴量スキーマ自体が音源分離可能性の上に立つ。W3-W4 に 3 人の実測（各マイクへの漏れ込み量）で先に確定させる。
3. **会場音響での事前検証計画なし**: W6 リハが会場初回では調整時間ゼロ。W4-W5 に会場（or 近い空間）でマイク配置・残響の実地収録を 1 回。
4. **E2E レイテンシの通し合算なし**: 支配項は LLM 評価周期（2-4小節）。「遅延前提の音楽設計（先読み/アンティシペーション）」を早期に明文化。
5. **オペレーター認知負荷未検証**: 人間介入が「主たる制御機構」なのに 1 人が同時監視できるゲート数・反応速度が不明。模擬リハで実測し UI の警告数を設計。
6. **API 障害時の縮退**: エンジン側は原則2（LOOP 自己持続）で担保済みだが、Bridge/pi 側の「呼び出し失敗 → 直前パターン維持」の明示実装を確認。
7. **ATTYA 固有の脆弱箇所分析なし**: コード譜から chroma ベクトルを機械計算し、隣接コード間コサイン類似度が高い（=混同しやすい）遷移点をリスト化 → そこだけ人間合図に固定。
8. **MIDI 連動 bleed ゲーティング未検討**: ピアノ MIDI onset/duration を Bridge に共有し、該当時間窓の人間楽器特徴量の信頼度を機械的に下げる（適応フィルタより先の安価な暫定策）→ 案5。

---

---

## 実装案（別ドキュメント）

本調査に基づく**実装案 10・比較マトリクス・W3-W8 ロードマップ・owner 決定事項 D1-D4** は
[WCTM_LISTENING_IMPLEMENTATION_PROPOSALS.md](WCTM_LISTENING_IMPLEMENTATION_PROPOSALS.md) に分離した（2026-07-03）。

## 出典（主要一次情報源）

- Smailis, Andreopoulou & Georgaki, AIMC 2021（OID のビートトラッキング撤退・ACE 供給不能）
- arXiv:2108.03576 BeatNet（ISMIR 2021）/ CPJKU/madmom discussion #493 / github.com/adamstark/BTrack / github.com/v7b1/vb-objects（ソース直接確認）
- learn.flucoma.org/reference/pitch, /spectralshape, /chroma（逐語確認）/ github.com/flucoma
- Nakamura, Nakamura & Sagayama, IEEE/ACM TASLP 2015（反復/スキップ対応実時間追従）
- Duan & Pardo, ISMIR 2011（リードシート整合・オフライン）/ Stark & Plumbley, ICMC 2009（実時間コード認識 Max external）/ Fujishima 1999（PCP）
- George Lewis, Voyager（Cycling '74 インタビュー + 二次資料。書誌 *Leonardo Music Journal* 10 (2000) は既存社内調査 [WCTM_LLM_ENSEMBLE_LISTENING_RESEARCH](WCTM_LLM_ENSEMBLE_LISTENING_RESEARCH.md) の出典に依拠・本調査では未再検証）
- ReaLJam/ReaLchords（DeepMind）ユーザー評価 / JAMMIN-GPT（ISMIR 2023 LBD）/ ChatMusician / "Can LLMs Reason in Music?"
- Anthropic prompt caching 公式ドキュメント / Cycling '74 リリースノート（Max 9.1 ABL・v8/node.script）/ Ableton Link 公式ドキュメント
- 関連社内資料: `docs/specs-v2/WCTM_SYSTEM_SPEC_v1.md` §2-§4/§10・`WCTM_AGENT_HARNESS_EXTERNAL_DATA_RESEARCH.md`・`WCTM_LLM_ENSEMBLE_LISTENING_RESEARCH.md`（層1-3 の先行研究地図）

## 本調査の限界

- 検証は load-bearing 16 件のみ（93 件中）。未検証 claim は confidence 表示のまま扱うこと。
- 「見つからなかった」は不在の証明ではない（特にフォーラム・paywall 論文由来の実戦知）。
- レイテンシ数値の多くは非公式計測 or 機械的概算（fluid.chroma~ の 93ms 等）。実機スパイクで置き換える前提。
