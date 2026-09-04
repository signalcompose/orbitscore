/**
 * #611 §9 — 出口の一般化に入る**前**の音を、実機 capture の数値で固定する（PR-O0 / #543-a）。
 *
 * 🔴 **ここに書くのは「今の音」であって「正しい音」ではない。** 今日壊れている項目も
 * 壊れた値のまま入れる。PR-O2 / PR-O4 は**変わる行だけ**を後継の式へ切り替え、
 * 差分が式どおりであることが受け入れになる。
 *
 * ---
 *
 * ## 🔴 最初の測定は「音量」ではなく「窓に入ったヒット数」を測っていた（2026-09-04・監査で判明）
 *
 * `LOOP()` は既定で**次の小節境界まで待つ**（`quantize-manager.ts:70` の
 * `if (currentTime <= 0) return durationMs`・既定値は `'bar'`）。120 BPM 4/4 なので **1 小節 = 2000 ms**。
 * ところが最初の版は `run_selection` の **500 ms 後**に録り始めていたので、
 * **窓の大半が発音前の無音**で、入るヒット数が窓ごとに違っていた。
 *
 * その結果、設計 §9 の期待式と実測が食い違って見えた。**食い違いは engine ではなく測り方にあった**:
 *
 * | 当初の解釈（誤り） | 実際 |
 * |---|---|
 * | 「aux/dry は 0.3 でなく 0.678。位相・遅延のせい」 | dry 窓に 3 発・total 窓に 5 発入っていただけ。`send(0.3)` は**線形 0.3 ちょうど** |
 * | 「ラック併用が乗算モデルと 10% 違う。非線形要素がある」 | `Gain(db:6)` は **+6 dB ちょうど**、`Gain(6)×gain(-6)` は **unity ちょうど** |
 *
 * 検算（`kick.wav` は 1ch / 0.5 s / エネルギー 0.00757189、center pan で半分）: 当初の 4 つの
 * golden はすべて `sqrt(整数ヒット数 × 0.00378595 / 窓長)` と**有効 7 桁で一致**した。
 *
 * 🔴 **測定手法の欠陥を engine の性質だと結論しない。** 「未検証のモデルを assert しない」という
 * 方針自体は正しいが、その適用を誤ると**検証済みの一次ソースを「未検証」と呼ぶ**ことになる。
 *
 * ## 現在の測り方（#739）
 *
 * 1. 絶対 RMS 床で発音を待ってから capture のバイト長を時計にする
 * 2. guard 内の最初の onset に測定範囲をスナップし、8 × 500 ms を測る
 * 3. onset 数と gap 中央値を assert してから二乗平均 RMS を返す
 */

/** dB → 線形。 */
const dbToLinear = (db: number): number => 10 ** (db / 20)

/** 譜面の 1 ヒット周期。(60000 / 120 BPM) × 4 beats/bar / 4 slots/bar = 500 ms。 */
const HIT_PERIOD_MS = 500

const EXPECTED_ONSETS = 8

/**
 * 実機層の許容。**実測したノイズ床から決めた**（推測値ではない）。
 *
 * 🔴 **この層に bit 一致相当（1e-6）を置かない。** `docs/testing/E2E_HARNESS_SPEC.md` は
 * 回帰の固定を**オフライン決定論層**に、実機層を「**許容幅つきの意味論 assert**」に割り当てている。
 *
 * **2026-09-04 の実測**（settle 2600 ms・8 発の窓・オンセット数は 4 本とも固定できた状態・3 回実行）:
 *
 * 🔴 **値が二峰的に跳ぶ。比はいつも 1.069 = √(8/7)。**
 *
 * | 観測 | 2 回目 | 3 回目 |
 * |---|---|---|
 * | `noBus` の 2 セッション | 0.084825 / 0.084409 | 0.084677 / **0.090473** |
 * | `sumOutput` | 0.084642 | **0.090464** |
 * | `effectOnly/dry`（理論 1.995262315） | **1.995262230**（9 桁一致） | **2.132406**（×1.0687） |
 *
 * √(8/7) は **窓の実効長が 1 ヒット分（500 ms / 4000 ms = 1/8）ゆらぐ**ことを意味する。
 * オンセット数は 8 に固定できているので、ずれているのは**エネルギーを割る時間幅**の方である。
 * `rms()` は `Date.now()` で決めた区間を capture 時刻へ写して 20 ms 窓を集めるので、
 * この写像に 1 ヒット分の量子化が残っているとみられる。**セグメントごとに独立に乗る。**
 *
 * ⚠️ **一度「`seq.gain(-6)` は実は −5.42 dB」と結論しかけたが撤回した。**
 * `combined/dry` が 2 回とも 1.069 だったのを系統差と読んだが、
 * **同じ 1.069 が `effectOnly/dry` にも `sumOutput` にも出る**ので、このアーチファクトと区別できない。
 * 区別するには窓を長くして端の寄与を下げる必要がある（follow-up）。
 *
 * 🔴 **したがって期待値は理論式のままにし、許容をアーチファクトの幅に合わせる。**
 * 実測値をベタ書きすると、**アーチファクトを engine の性質として固定**してしまう。
 *
 * #739 で区間写像を capture のバイト時計へ移し、最初の onset に 8 周期の範囲をスナップした。
 * golden と既存の意味論許容はそのまま残し、2 セッションの再現性だけを 2% で別に固定する。
 */

/** RMS の絶対値。既存 golden の実機意味論許容。 */
const RMS_TOLERANCE = 0.12

/** aux との合算比（2 回で ±6%・部分的にコヒーレントな合流のため）。 */
const SEND_RATIO_TOLERANCE = 0.12

/** ラック単体の比。理論値に対する既存の実機意味論許容。 */
const RACK_RATIO_TOLERANCE = 0.12

/** ゲイン積の比に対する既存の実機意味論許容。 */
const GAIN_PRODUCT_TOLERANCE = 0.12

/** 音が出ていることの下限（無音ハーネスを緑にしないためのガード・#528）。 */
const AUDIBLE_FLOOR_RMS = 0.01

/** 譜面 3 の `send(aux, 0.3)` に書いてある係数。 */
const SEND_AMOUNT_AS_WRITTEN = 0.3

/** 全 golden 共通の録り方。オンセット数まで含めて 1 箇所で決める。 */
export const STEADY_CAPTURE = {
  captureMs: HIT_PERIOD_MS * (EXPECTED_ONSETS + 1) + 300,
  expectedOnsets: EXPECTED_ONSETS,
  guardSec: 0.15,
  hitPeriodSec: HIT_PERIOD_MS / 1000,
  audibleFloorRms: AUDIBLE_FLOOR_RMS,
} as const

export const OUTPUT_LINE_GOLDENS = {
  /** 譜面 1: バス無し（`kick_loop.orbs`）。PR-O2 の変更が動かしてはいけない。 */
  noBus: {
    channels: 2,
    /** 2026-09-04 実機（定常状態・8 発の窓）。2 セッションの平均。 */
    rms: 0.0846173,
    tolerance: RMS_TOLERANCE,
  },

  /** 譜面 2: `global.sum("o0sum611")` + `kick.output("o0sum611")`。PR-O2 が動かしてはいけない。 */
  sumOutput: {
    /** 2026-09-04 実機（定常状態・8 発の窓）。 */
    rms: 0.0846422,
    tolerance: RMS_TOLERANCE,
  },

  /**
   * 譜面 3: `send(aux, 0.3)`。PR-O4 で 0.3 が**線形係数から dB へ**読み替えられる。
   *
   * dry と aux は同じ信号のコピーで同じ経路を通って合流する（`output.rs` の
   * `*d += *s * send.gain`）。オンセット数を揃えれば **total/dry = 1 + 係数**が厳密に成立する。
   */
  send: {
    amountAsWritten: SEND_AMOUNT_AS_WRITTEN,
    /** 今日: 係数は線形。 */
    legacyTotalOverDry: 1 + SEND_AMOUNT_AS_WRITTEN,
    /** PR-O4 後: 同じ `0.3` が dB として読まれる。 */
    dbTotalOverDry: 1 + dbToLinear(SEND_AMOUNT_AS_WRITTEN),
    tolerance: SEND_RATIO_TOLERANCE,
  },

  /**
   * 譜面 4: `effect([Gain(db: 6)]).gain(-6)`。
   *
   * 🔴 **この行が固定するのは大きさであって順序ではない。** この譜面の `Gain(db: 6)` は
   * **標準プラグイン**（`packages/engine/src/signal-chain/rack.ts:23` で `kind: 'standard'`）で、
   * 実体は `rust/crates/orbit-std-gain/src/lib.rs:297` の `*o = i * gain` ＝ブロック定数の
   * スカラー乗算である。スカラー乗算は `seq.gain()` と**可換**なので、ゲインをラックの前に置いても
   * 後ろに置いても積は変わらない。**順序の主張は doc 611 E2E-6（aux タップ）が担う**（PR-O4）。
   *
   * この行が守るもの: PR-O2 がゲインを動かしたときに、**二重に掛かる・落ちる・段の幅を
   * 取り違える**といった大きさの事故が起きたら赤くなる。
   */
  sequenceGainWithEffect: {
    /** `Gain(db: 6)` のみ / dry。🔴 2026-09-04 実機は理論と**有効 9 桁で一致**した。 */
    effectOnlyOverDry: dbToLinear(6),
    effectOnlyTolerance: RACK_RATIO_TOLERANCE,
    /**
     * `effect([Gain(db: 6)]).gain(-6)` / dry。積は unity。
     *
     * ⚠️ 実測は 2 回とも 1.069 だったが、**同じ 1.069 が他の行にも出る測定アーチファクト**なので
     * 系統差とは断定できない（冒頭の注記）。理論値のままにして、許容でアーチファクトを吸収する。
     */
    combinedOverDry: dbToLinear(6) * dbToLinear(-6),
    combinedTolerance: GAIN_PRODUCT_TOLERANCE,
  },

  /**
   * 既存 #643 E2E-1 の観測（**そのテスト自体は PR-O0 では触らない**）。
   *
   * 🔴 **E2E-1 も同じ測り方の問題を抱えている可能性が高い。** E2E-1 は `captureSegment('unity')` を
   * `run_selection` 直後（settle 400 ms）に取るので、unity 窓は LOOP 起動前の無音を多く含む。
   * 2026-09-04 の 3 回の実測でも **`half` はほぼ動かない（0.08576 / 0.08579）のに `unity` が
   * 11% 動き、1 回は 0 だった** — 不安定なのは unity 側だけで、起動位相のばらつきと整合する。
   *
   * したがって「今日の half/unity 比」を golden として持たない。**PR-O2 は E2E-1 を green に
   * する前に、まず E2E-1 が定常状態を見ているかを確かめること**
   * （`docs/design/649-audio-line-design.md` §13 の測定ラダー）。
   */
  globalGainInstrument: {
    /** PR-O2 後の受け入れ: half/unity が `10^(-6/20)`。 */
    prO2HalfOverUnity: dbToLinear(-6),
    ratioTolerance: 0.05,
  },
} as const
