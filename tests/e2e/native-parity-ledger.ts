/**
 * パリティ台帳（設計 848 §1.2 D-1・§10.2）: 凍結版 gated suite の `it` 題名を全件分類する。
 *
 * - **`parity`**: 題名が確かめているのが DSL の実行結果（音・診断・状態）か、人か LLM の能力なら
 *   `native-required`。拡張版の形だけを確かめる題名は `not-applicable`（`reason` 必須）。v4.4.0 の
 *   56 題名を読んだ結果、`not-applicable` は 0 件（設計 §1.2 D-1 の予備判定と同じ）
 * - **`needsEditor`**: エディタのツール（`EDITOR_TOOLS`）を直接か helpers 経由で呼ぶ。headless では
 *   自動 skip（D-3）。**手で書くが、spec が構文木の解析と突き合わせる**（`gated-suite-analysis.ts`）
 * - **`app`**: `own` = 自前でアプリを起こす / `shared` = 最初の題名（`MAIN_PHASE_TITLE`）が起こした
 *   アプリと、その題名が残した状態（カタログの走査の結果など）に依る
 *
 * 母集団は `PARITY_BASELINE_TAG` 時点の題名（設計 §1.2: 基準タグは 1 か所から読む）。凍結版に例外が
 * 入ってタグが進んだら、その PR で定数を進め、増えた題名を分類する（未分類は spec が red にする）。
 *
 * 拡張版と共存する間だけの台帳（台帳 P-09）。
 */

export const PARITY_BASELINE_TAG = 'v4.4.0'

export type ParityTarget = 'vscode' | 'headless' | 'native'

export interface ParityEntry {
  title: string
  parity: 'native-required' | 'not-applicable'
  /** `not-applicable` の理由（`native-required` には書かない）。 */
  reason?: string
  /** 何を確かめている題名か（DSL の結果か・能力か）。 */
  basis: string
  needsEditor: boolean
  app: 'own' | 'shared'
}

/** 共有のアプリを起こし、カタログの走査などの状態を残す題名（suite の先頭）。 */
export const MAIN_PHASE_TITLE =
  'drives real OrbitStudio end-to-end: diagnostics-on-open, run_selection, live edit, capture verification'

export const PARITY_LEDGER: readonly ParityEntry[] = [
  {
    title:
      'drives real OrbitStudio end-to-end: diagnostics-on-open, run_selection, live edit, capture verification',
    parity: 'native-required',
    basis:
      '能力: 文書を開く → 診断・run_selection・編集・保存・capture の検証（人と LLM の基本の動線）',
    needsEditor: true,
    app: 'own',
  },
  {
    title: '#643 E2E-1 applies global.gain(-6) to a playing instrument at about half the 0 dB RMS',
    parity: 'native-required',
    basis: 'DSL の結果: instrument と mixer（gain / rack / send / 差し替え）の音を capture で測る',
    needsEditor: true,
    app: 'shared',
  },
  {
    title: '#643 E2E-2 applies a -6 dB sequence rack to an instrument at about half dry RMS',
    parity: 'native-required',
    basis: 'DSL の結果: instrument と mixer（gain / rack / send / 差し替え）の音を capture で測る',
    needsEditor: true,
    app: 'shared',
  },
  {
    title: '#643 E2E-3 attaches effect() during instrument playback without a gap or spike',
    parity: 'native-required',
    basis: 'DSL の結果: instrument と mixer（gain / rack / send / 差し替え）の音を capture で測る',
    needsEditor: true,
    app: 'shared',
  },
  {
    title: '#643 E2E-4 preserves instrument contributions through output(sum) plus send(aux, gain)',
    parity: 'native-required',
    basis: 'DSL の結果: instrument と mixer（gain / rack / send / 差し替え）の音を capture で測る',
    needsEditor: true,
    app: 'shared',
  },
  {
    title: '#643 E2E-5 keeps the sequence effect applied while replacing a playing instrument',
    parity: 'native-required',
    basis: 'DSL の結果: instrument と mixer（gain / rack / send / 差し替え）の音を capture で測る',
    needsEditor: true,
    app: 'shared',
  },
  {
    title: '#643 E2E-6 resets a released slot so its next instrument tenant starts dry',
    parity: 'native-required',
    basis: 'DSL の結果: instrument と mixer（gain / rack / send / 差し替え）の音を capture で測る',
    needsEditor: true,
    app: 'shared',
  },
  {
    title: '#643 E2E-7 keeps an instrument with no mixer declaration audible at legacy dry RMS',
    parity: 'native-required',
    basis: 'DSL の結果: instrument と mixer（gain / rack / send / 差し替え）の音を capture で測る',
    needsEditor: true,
    app: 'shared',
  },
  {
    title: '#633 E2E-1 opens a UI for every matching insert, and closing one leaves the other open',
    parity: 'native-required',
    basis: '能力: 同じプラグインを複数挿した時のプラグイン UI の開閉',
    needsEditor: false,
    app: 'shared',
  },
  {
    title:
      '#633 E2E-2 keeps an open UI open when an earlier insert is dropped, and closes it at its new index',
    parity: 'native-required',
    basis: '能力: 同じプラグインを複数挿した時のプラグイン UI の開閉',
    needsEditor: false,
    app: 'shared',
  },
  {
    title:
      '#939 E2E opens only the plugin under the cursor when the same plugin is inserted twice around a standard Gain',
    parity: 'native-required',
    basis: '能力: カーソル下のプラグインの UI を開く（open_plugin_ui_at_cursor）',
    needsEditor: true,
    app: 'shared',
  },
  {
    title: '#941 E2E opens the fourth identical plugin after a nested plain array',
    parity: 'native-required',
    basis: '能力: カーソル下のプラグインの UI を開く（open_plugin_ui_at_cursor）',
    needsEditor: true,
    app: 'shared',
  },
  {
    title: '#940 E2E floats the plugin window only while the host is frontmost',
    parity: 'native-required',
    basis:
      '能力: プラグイン窓がホストの前面化に追従する（ホストはアプリ。窓の層の観測はハーネスが差し替える）',
    needsEditor: false,
    app: 'shared',
  },
  {
    title:
      'rescans catalog v2 through MCP, reports a broken bundle, and preserves a known CLAP fixture',
    parity: 'native-required',
    basis: '能力: プラグインカタログの再走査と、壊れたバンドルの報告',
    needsEditor: false,
    app: 'shared',
  },
  {
    title: 'reports an ambiguous bare mixer name through run_selection and get_log',
    parity: 'native-required',
    basis: 'DSL の結果: 曖昧な mixer 名の診断が run_selection と get_log に出る',
    needsEditor: true,
    app: 'shared',
  },
  {
    title: 'shows a nested play() update in get_log after run_selection (#964)',
    parity: 'native-required',
    basis: 'DSL の結果: 入れ子の play() の更新が get_log に出る',
    needsEditor: true,
    app: 'shared',
  },
  {
    title: 'resolves a file import from evaluate_orbitscore against the .orbs directory (#966)',
    parity: 'native-required',
    basis: 'DSL の結果: evaluate_orbitscore の基準ディレクトリ（IM.6）で import が解決される',
    needsEditor: true,
    app: 'shared',
  },
  {
    title: 'steps the live playhead through an instrument() sequence, rests included',
    parity: 'native-required',
    basis: 'DSL の結果: playhead（transport.step）が休符を含めて進む',
    needsEditor: true,
    app: 'shared',
  },
  {
    title:
      'restores an MCP-saved non-default instrument state across an engine restart with the same measured pitch',
    parity: 'native-required',
    basis: '能力: plugin state の保存と、engine の再起動をまたぐ復元',
    needsEditor: false,
    app: 'shared',
  },
  {
    title:
      'restores a non-default sum-bus insert across restart through its prefixed receiver identity',
    parity: 'native-required',
    basis: '能力: plugin state の保存と、engine の再起動をまたぐ復元',
    needsEditor: true,
    app: 'shared',
  },
  {
    title:
      'auto-records and restores all five plugin receiver kinds across a restart without explicit saves',
    parity: 'native-required',
    basis: '能力: plugin state の保存と、engine の再起動をまたぐ復元',
    needsEditor: true,
    app: 'shared',
  },
  {
    title:
      'replaces a playing instrument across CLAP/VST3 with audio, state, process, failure, and UI oracles (#618 E1-E6)',
    parity: 'native-required',
    basis: 'DSL の結果: 再生中の instrument の差し替え（音・state・プロセス・失敗・UI）',
    needsEditor: false,
    app: 'shared',
  },
  {
    title:
      'replaces and removes playing effects with audio, state, process, failure, routing, and master oracles (#625 R-E1-R-E7)',
    parity: 'native-required',
    basis: 'DSL の結果: 再生中の effect の差し替えと除去（音・state・プロセス・経路）',
    needsEditor: false,
    app: 'shared',
  },
  {
    title: '#628 R28: rack chain audio mainline',
    parity: 'native-required',
    basis: 'DSL の結果: rack chain の音と、標準要素のエラー文言',
    needsEditor: false,
    app: 'shared',
  },
  {
    title: '#628 R28: rack master + MCP standard-element error',
    parity: 'native-required',
    basis: 'DSL の結果: rack chain の音と、標準要素のエラー文言',
    needsEditor: false,
    app: 'shared',
  },
  {
    title: '#611 O0-1 keeps the no-bus kick_loop RMS deterministic across two capture sessions',
    parity: 'native-required',
    basis: 'DSL の結果: mixer の音量・send・pan・gain の数値を capture で固定する',
    needsEditor: true,
    app: 'shared',
  },
  {
    title: '#883 X1 keeps an output-less audio sequence silent beside an explicit reference',
    parity: 'native-required',
    basis: 'DSL の結果: output() の経路（音が出る・出ない）',
    needsEditor: true,
    app: 'shared',
  },
  {
    title: '#883 X2 makes output() and output("master") audibly equivalent to the no-bus path',
    parity: 'native-required',
    basis: 'DSL の結果: output() の経路（音が出る・出ない）',
    needsEditor: true,
    app: 'shared',
  },
  {
    title: '#883 X3 routes a sum-only send without leaking an implicit dry copy to master',
    parity: 'native-required',
    basis: 'DSL の結果: output() の経路（音が出る・出ない）',
    needsEditor: true,
    app: 'shared',
  },
  {
    title: '#883 X4 does not publish a declared sum whose own output is absent',
    parity: 'native-required',
    basis: 'DSL の結果: output() の経路（音が出る・出ない）',
    needsEditor: true,
    app: 'shared',
  },
  {
    title: '#883 X5 makes explicit-output instruments audible and output-less instruments silent',
    parity: 'native-required',
    basis: 'DSL の結果: output() の経路（音が出る・出ない）',
    needsEditor: true,
    app: 'shared',
  },
  {
    title: '#883 X6 reports only the two intended output-routing diagnostics on open',
    parity: 'native-required',
    basis: 'DSL の結果: 出力の経路の診断が開いた時に出る',
    needsEditor: true,
    app: 'shared',
  },
  {
    title: '#883 X8 keeps an output-less MIDI sequence on the hardware dispatch path',
    parity: 'native-required',
    basis: 'DSL の結果: output() の経路（音が出る・出ない）',
    needsEditor: true,
    app: 'shared',
  },
  {
    title: '#611 O0-2 pins the explicit sum-output RMS so PR-O2 cannot move it',
    parity: 'native-required',
    basis: 'DSL の結果: mixer の音量・send・pan・gain の数値を capture で固定する',
    needsEditor: true,
    app: 'shared',
  },
  {
    title: '#611 O0-3 pins send(0.3) as a dB coefficient: total/dry = 1 + 10 ** (0.3 / 20)',
    parity: 'native-required',
    basis: 'DSL の結果: mixer の音量・send・pan・gain の数値を capture で固定する',
    needsEditor: true,
    app: 'shared',
  },
  {
    title:
      "#611 O0-4 pins the magnitude of today's effect([...]).gain(-6) (a linear rack cannot show order)",
    parity: 'native-required',
    basis: 'DSL の結果: mixer の音量・send・pan・gain の数値を capture で固定する',
    needsEditor: true,
    app: 'shared',
  },
  {
    title:
      '#611 E2E-2 pins output(verb, thru: true, db: -12).output(master): total/dry = 1 + 10 ** (-12/20)',
    parity: 'native-required',
    basis: 'DSL の結果: mixer の音量・send・pan・gain の数値を capture で固定する',
    needsEditor: true,
    app: 'shared',
  },
  {
    title: '#611 E2E-3 proves send(aux, db) === output(aux, thru: true, db) (same magnitude)',
    parity: 'native-required',
    basis: 'DSL の結果: mixer の音量・send・pan・gain の数値を capture で固定する',
    needsEditor: true,
    app: 'shared',
  },
  {
    title: '#611 E2E-S/E2E-S0 pins two simultaneous sends and a disabled (gain 0) send',
    parity: 'native-required',
    basis: 'DSL の結果: mixer の音量・send・pan・gain の数値を capture で固定する',
    needsEditor: true,
    app: 'shared',
  },
  {
    title: '#611 E2E-G pins LineOp::Gain: kick.gain(-6).output(drums) reaches the daemon-side line',
    parity: 'native-required',
    basis: 'DSL の結果: mixer の音量・send・pan・gain の数値を capture で固定する',
    needsEditor: true,
    app: 'shared',
  },
  {
    title:
      '#611 E2E-P pins LineOp::Pan: hard-left silences the right channel, and center keeps the sqrt(2)-normalized level of an un-panned line',
    parity: 'native-required',
    basis: 'DSL の結果: mixer の音量・send・pan・gain の数値を capture で固定する',
    needsEditor: true,
    app: 'shared',
  },
  {
    title:
      '#611 E2E-6 pins that output(verb, thru: true) before vs. after effect([Gain]) changes the mix: total_B is exactly 2g of plain and total_A/total_B sits inside [(1-g)/2g, (1+g)/2g]',
    parity: 'native-required',
    basis: 'DSL の結果: mixer の音量・send・pan・gain の数値を capture で固定する',
    needsEditor: true,
    app: 'shared',
  },
  {
    title:
      '#611 E2E-7 keeps a republished bus gain seeded, so gain(-40) -> gain(0) mid-playback ramps instead of clicking',
    parity: 'native-required',
    basis: 'DSL の結果: mixer の音量・send・pan・gain の数値を capture で固定する',
    needsEditor: true,
    app: 'shared',
  },
  {
    title:
      '#611 E2E-10 recovers steady RMS and exactly one daemon process after a daemon SIGKILL respawn',
    parity: 'native-required',
    basis: 'DSL の結果: mixer の音量・send・pan・gain の数値を capture で固定する',
    needsEditor: true,
    app: 'shared',
  },
  {
    title: '#606 T1 releases a RUN instrument at natural termination',
    parity: 'native-required',
    basis: 'DSL の結果: ノートの解放（自然終了・engine の切断）',
    needsEditor: true,
    app: 'shared',
  },
  {
    title: '#606 E2E-K3 releases notes when SIGKILL disconnects engine but daemon survives',
    parity: 'native-required',
    basis: 'DSL の結果: ノートの解放（自然終了・engine の切断）',
    needsEditor: false,
    app: 'shared',
  },
  {
    title: '#967 random binding emits both C4 and G4 across onset-tracked capture windows',
    parity: 'native-required',
    basis: 'DSL の結果: random の音高が capture の両方の窓に出る',
    needsEditor: true,
    app: 'shared',
  },
  {
    title: '#967 bare random pitch emits both C4 and G4 across onset-tracked capture windows',
    parity: 'native-required',
    basis: 'DSL の結果: random の音高が capture の両方の窓に出る',
    needsEditor: true,
    app: 'shared',
  },
  {
    title:
      '#974 a chord variable holding r1.r(1) emits both C4 and G4 across onset-tracked capture windows',
    parity: 'native-required',
    basis: 'DSL の結果: random の音高が capture の両方の窓に出る',
    needsEditor: true,
    app: 'shared',
  },
  {
    title:
      '#967 E3 rejects random.nope through evaluate_orbitscore with the mode-source diagnostic',
    parity: 'native-required',
    basis: 'DSL の結果: random の誤用の診断',
    needsEditor: true,
    app: 'shared',
  },
  {
    title:
      '#611 E2E-4/E2E-5 (needs >=4ch device) — thru: false terminates the chain, and a physical multi-output split is -20dB relative to master',
    parity: 'native-required',
    basis: 'DSL の結果: thru: false と物理多出力の分割（4ch 以上のデバイス）',
    needsEditor: true,
    app: 'own',
  },
  {
    title: '#779 startup sweep unlinks orphaned outproc shm but keeps live ones',
    parity: 'native-required',
    basis: '能力: 異常終了の後始末（取り残しの共有メモリの掃除）',
    needsEditor: false,
    app: 'own',
  },
  {
    title: '#661 D-0 honors a real named output device and produces audible capture RMS',
    parity: 'native-required',
    basis: '能力: 出力デバイスの選択・起動時の退避・切り替えの失敗',
    needsEditor: true,
    app: 'own',
  },
  {
    title: '#661 D-2 falls back from a dead named device at startup and stays audible',
    parity: 'native-required',
    basis: '能力: 出力デバイスの選択・起動時の退避・切り替えの失敗',
    needsEditor: true,
    app: 'own',
  },
  {
    title: '#661 D-3 keeps the old stream playing when a live switch candidate is dead',
    parity: 'native-required',
    basis: '能力: 出力デバイスの選択・起動時の退避・切り替えの失敗',
    needsEditor: true,
    app: 'own',
  },
  {
    title: '#966 clears the previous evaluate_orbitscore base when IM.6 has no candidate',
    parity: 'native-required',
    basis: 'DSL の結果: IM.6 の候補が無い時に前回の基準を消す',
    needsEditor: true,
    app: 'own',
  },
]

/**
 * ターゲットでこの題名を skip する理由（skip しないなら null）。gated suite の `beforeEach` が読む。
 *
 * - `vscode`: 何も skip しない（凍結版・今日のまま）
 * - `native`: `not-applicable` を skip する
 * - `headless`: `needsEditor` を skip する。`shared` の題名は、`MAIN_PHASE_TITLE` が skip される時は
 *   それが残す状態が無いので skip する（題名ごとの `needsEditor` では表せない依存）
 */
export function paritySkipReason(
  title: string,
  target: ParityTarget,
  ledger: readonly ParityEntry[] = PARITY_LEDGER,
): string | null {
  if (target === 'vscode') return null
  const entry = ledger.find((candidate) => candidate.title === title)
  if (!entry) return null
  if (entry.parity === 'not-applicable') return `not-applicable: ${entry.reason}`
  if (target === 'native') return null
  if (entry.needsEditor) return 'needs-editor: headless has no editor client (D-3)'
  const main = ledger.find((candidate) => candidate.title === MAIN_PHASE_TITLE)
  if (entry.app === 'shared' && main && paritySkipReason(main.title, target, ledger) !== null) {
    return 'needs the main phase: it is skipped on this target and left no shared app or state'
  }
  return null
}
