# Research: LLM をジャズ・アンサンブルの実時間メンバーにする ── 先行研究に対する novelty と feasibility

## 調査日
2026-06-22

## 調査目的
WCTM の研究ビジョン ──「**LLM が（ジャズ）アンサンブルの実時間 即興メンバーになる**。その『耳』= engineered な実時間 DSP 特徴 front-end（onset / 拍位相 / tempo / energy / density / 和声文脈）、その『楽器』= 実時間で OrbitScore DSL をライブコーディング」── を、先行研究に照らして「確立 / precedent あり限定的 / 未踏」の3層で位置づける。**post-2.0 engine track のスコープ外**（別トラックの研究ビジョン）だが、今の engine 開発が将来どこに効くかを接地するための調査。

## 調査方法
`deep-research` ハーネス（built-in WebSearch/WebFetch・Gemini 非依存）。5 角度に分解 → 並列検索 → 25 ソース取得 → 118 claim 抽出 → **上位 25 claim を 3票の敵対的検証**（2/3 refute で棄却）→ 23 confirmed / 2 killed → 合成。107 エージェント。**注意: 検証予算で top-25 のみ検証**したため、後述の coverage gap がある。

---

## 結論サマリ（3層）

### 層1: 確立済み（CONCEPT として解決）
**実時間 interactive machine improvisation はジャズ/Afrological 系を含め 40 年の成熟した研究系列**。
- **George Lewis "Voyager"**（1987 初演 / 2000 文献）= 人間の即興を実時間解析し、応答 + 自律的な内発音を生成する**対等な共演エージェント**（伴奏でも score-following でもない・subject-subject）。〔Leonardo Music Journal 10, 2000〕
- **IRCAM の OMax → Somax → Somax2 → DYCI2 / ImproteK / OID**（2001–現在・Factor Oracle 2001-02 採用・Somax2 v2.7 2025）= **deployed な multi-agent reactive co-improvisation パラダイム**。〔IRCAM STMS / ERC REACH, Assayag〕
- **anticipatory（plan 認識）即興も確立**: ImproteK の "scenario"（事前のコード進行/形式に対する anticipation + reactivity の混成スケジューリング）〔ACM CiE 2017〕/ Raphael "Music Plus One / Informatics Philharmonic"（HMM score match + **Kalman フィルタで奏者の未来タイミングを予測**し phase vocoder で追従）〔CACM 2011〕。

### 層2: precedent あるが限定的（= 我々の「耳」と「認知」の両方に直撃）
- **engineered DSP 耳 = Somax2 が直接の precedent**（pitch/chroma/onset/tempo を実時間解析）。**だが生アコースティック・バンドに致命的な限界**を持つ:
  - audio pitch は **Yin = 明示的に monophonic 仮定**〔Borg Somax2 report 2019〕。
  - **自動 beat-tracking は SOTA ジャズ系 OID から意図的に「外された」**（ジャズの expressive micro-timing で信頼性が低く、**手動タッピングの方が確実**だったため）〔AIMC 2021〕。
  - **複雑ジャズの Automatic Chord Estimation（ACE）は未解決**で「**実時間 music-making システムに供給できない**」→ 和声は**ユーザー注釈**で与える（聴いていない）〔AIMC 2021 / MIREX 2024-25 でも未解決を裏付け〕。
  - OID は「録音セグメントを再結合再生するだけで**実時間リスニング能力が無く、共演者に律動的に追従できない**」〔AIMC 2021〕。
- **この系列の『認知』は全て formal-model / corpus 再結合**（Factor Oracle = 有限状態オートマトン、Somax2 2019 実装は n-gram で「**rather primitive**」と自認）。**明示的に ML/deep-learning ではない**（DL は将来拡張として名前が挙がるのみ）〔Borg 2019 / AIMC 2021〕。→ **「LLM を認知層にする」のが本物の novelty 軸**である根拠。

### 層3: 本調査で未確認 = genuine open gap（※「文献に無い」ではなく coverage gap）
**検証済み claim には、以下を裏付けるものが無かった**:
- (a) **LLM が実時間 in-loop の音楽認知層**として（フレーズ/セクション粒度の anticipatory で）動く事例。
- (b) **DSL のライブコーディングを action space** にする事例。
- (c) **end-to-end の統合**（engineered 耳 → LLM 認知 → live-coding DSL → 信頼できるアコースティック・ジャズ・バンドメンバー）。

→ この統合は **未踏に見えるが、本 claim セットでの coverage gap（不在の証明ではない）**。強い novelty 主張の前に**追加調査が必要**（後述 open questions）。ハードな未解決問題: **in-loop LLM latency / 生 polyphonic 入力への耳のロバスト性 / ジャズ和声推定・音源分離 / 評価方法の不在**。

---

## 具体数値（score-following 精度 ── ただし最易ケースのみ）
実時間 online score follower の note asynchrony 中央値 ~**60–91 ms**:
- ACCompanion OLTW: **60.6 ms 中央値**（25ms 以内 38% / 50ms 以内 63.3% / 100ms 以内 86.7%）。HMM 版は 645.7 ms と大幅劣化。〔arXiv 2304.12939, IJCAI 2023〕
- Matchmaker / OLTWArzt（(n)ASAP）: 中央値 **91.18 ms**（平均 183.56 ± 263.95 ms）。表現的変動の大きい Vienna4x22 では中央値 152 ms。〔arXiv 2510.10087, ISMIR 2025〕

**重大な caveat（数値は転移しない）**: これらは**ソロピアノ・固定譜面・MIDI/offline 整合の error metric（live latency ではない）**＝**最易ケースの天井**。click 無し・polyphonic・譜面無しのアコースティック・ジャズ・アンサンブルには転移しない → **feasibility の根拠でなく hard-problem の補強**として読む。参考: 人間同士のアンサンブル asynchrony は ~30–40 ms。

---

## 我々の novelty の正確な言い方（誠実版）
- 「**機械ジャズ即興そのもの**」は novel ではない（Voyager / OID 等）。
- 「**engineered DSP 耳**」も novel ではない（Somax2）── むしろ**先行研究はそこを諦めている**（手動タッピング・和声注釈）＝ロバストな耳は**未踏の frontier だが hard**。
- **novel 軸 = ① 認知層を LLM（ML）にする**（系列全体が formal-model なので clean な差分）**② action space を live-coding DSL にする ③ それらを end-to-end 統合してアコースティック・バンドメンバー化**。①②③ は本調査で先行例が surface せず（coverage gap）。
- 「多分誰もやっていない」は **この統合（①②③）に限定**して言うべき。機械即興・耳・anticipation 単体には precedent がある。

---

## OrbitScore engine 開発との接続（今の作業が将来どこに効くか）
※ engine track のスコープは侵さない。下は「将来の WCTM がこの土台に乗る」接続のみ。
- **計測 / 耳なし検証レイヤ（#307/#308/#313・verify ハーネス + librosa grounding）**: 検証で鍛える**計測語彙を source-agnostic に保て**ば、それが将来「耳」の front-end 語彙になる（先行研究の耳と同じ feature family = onset/chroma/onset/tempo）。**我々固有の engineering-asset 視点**＝研究者は audio engine を作らないので計測語彙の単一契約化は我々だけがやれる。
- **#300 recovery floor + egress b1 bridge**: in-process な Max external は crash で Max ごと落ちる（fault ③）。**薄い Max external ↔ 共有メモリ IPC ↔ standalone daemon（= b1 を Max に retarget）**にすれば **Max 統合 AND crash 隔離**が両立 ── これは今作っている daemon supervision + recovery + bridge そのもの。Max Summer School proposal が通れば Max 必須なので、この経路を de-risk している。
- **A4 LinkAudio（tempo 同期）**: 「時間の耳」に隣接（テンポ同期は同じ問題系）。
- **capture seam**: 実時間出力の耳なし検証 + 解析プリミティブを real stream に当てる field test。同じプリミティブが「耳」にも効く。
- **レイテンシ設計の示唆**: score-following でも ~60ms・人間同士 ~30-40ms なので、LLM を note 反射に置くのは不可。**速い決定論層（groove-lock）+ 遅い anticipatory LLM（フレーズ/セクション計画）の2層分離**が必須（ImproteK/Music Plus One の anticipation 設計と整合）。

---

## Open questions（強い novelty 主張の前に要追加調査 ── 本調査の coverage gap）
1. **2023–2025 の LLM 音楽エージェントを「実時間 in-loop パートナー」として使った例**の実態（action space = symbolic/audio/code・実測 inference latency・アンサンブル相互作用の試み有無）。本調査はソースを fetch したが verified claim に surface せず（検証予算 top-25 の都合）。要 targeted 検索。
2. **"AI live coder"（DSL/コードを action space に実演でライブコーディングする AI）の先行例**と実時間制約の扱い。同上。
3. **LLM が in-loop latency 予算を満たせるか**、満たすアーキテクチャ（2層分離）の具体。
4. **「信頼できるジャズ・バンドメンバー」の評価方法**。文献に「自由・譜面無し・アコースティック・アンサンブル musicianship」の確立指標は無い（精度指標は固定譜面を前提とする＝ビジョンが明示的に欠く前提）。

---

## 主要ソース（一次・peer-reviewed 中心）
- Lewis, *Too Many Notes: Computers, Complexity and Culture in Voyager*, Leonardo Music Journal 10 (2000).
- Borg, *Somax2* report (IRCAM DYCI2, 2019) — 聴取 front-end（Yin/chroma/onset/tempo）+ n-gram 認知。
- Nika, Chemillier, Assayag, *ImproteK: Introducing Scenarios into Human-Computer Music Improvisation*, ACM CiE (2017).
- Smailis, Andreopoulou, Georgaki, OID 評価 (AIMC 2021) — ACE 未解決 / beat-tracking 撤去 / 実時間リスニング無し。
- DYCI2 / Somax2（github.com/DYCI2・forum.ircam.fr）— deployed multi-agent。
- ACCompanion (arXiv 2304.12939, IJCAI 2023) / Matchmaker (arXiv 2510.10087, ISMIR 2025) — score-following 精度。
- Raphael, *The Informatics Philharmonic*, CACM (2011) — anticipatory accompaniment。
- （未検証だが取得済・要フォロー）LLM-music: arXiv 2502.21267 / 2506.14723 / 2312.03479 / 2403.12000 / Magenta RealTime / 2503.15498。live-coding AI: ICLC 2019 paper101 / Autopia (ICLC 2020) / arXiv 2409.07918 / 2106.14835。

## 棄却された主張（透明性のため）
- 「OID の Factor-Oracle 出力は jazz musician 評価で harmonic anticipation/voice-leading/form を欠く『melodic patchwork』」→ 検証 1-0（2 abstain・接続エラー）で**不採用**。
- 「最良の online score follower でも 50ms 以内に揃うのは ~44%」→ 検証 1-2 で**棄却**（ACCompanion の 63.3%@50ms と矛盾）。
