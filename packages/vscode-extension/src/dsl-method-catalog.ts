/**
 * DSL メソッド補完の候補表（#495 第1段）。
 *
 * 🔴 **正本は engine 側**（`packages/engine/src/signal-chain/runtime.ts` の
 * `SEQUENCE_DSL_METHODS` / `GLOBAL_DSL_METHODS` / `BUS_DSL_METHODS`）。
 *
 * ここに複製があるのは、拡張が engine を**プロセス境界越しに**使う設計だから
 * （`plugin-catalog-reader.ts` も同じ理由で "deliberately independent" と書いている）。
 * 拡張プロセスは engine のモジュールを import しない。
 *
 * 複製は乖離する。それを防ぐため **`tests/vscode-extension/dsl-method-catalog.spec.ts` が
 * engine の語彙と一字一句一致することを検査する**。DSL にメソッドを足してここを更新し忘れると
 * テストが red になる（`seq.ui()` を足したのに補完に出ない、を構造的に防ぐ）。
 */

/** `seq.` の後に出る候補。engine の `SEQUENCE_DSL_METHODS` と一致すること。 */
export const SEQUENCE_METHODS: readonly string[] = [
  'quantize',
  'tempo',
  'beat',
  'length',
  'gain',
  'defaultGain',
  'pan',
  'defaultPan',
  'output',
  'send',
  'midi',
  'instrument',
  'effect',
  'ui',
  'hold',
  'voicelead',
  'vl',
  'cell',
  'density',
  'comp',
  'gate',
  'vel',
  'octave',
  'root',
  'audio',
  'chop',
  'play',
  'run',
  'loop',
  'stop',
  'mute',
  'unmute',
]

/** `global.` の後に出る候補。engine の `GLOBAL_DSL_METHODS` と一致すること。 */
export const GLOBAL_METHODS: readonly string[] = [
  'tempo',
  'beat',
  'key',
  'midiLatency',
  'audioPath',
  'audioDevice',
  'setDocumentDirectory',
  'linkAudio',
  'effect',
  'instrument',
  'sum',
  'aux',
  'quantize',
  'gain',
  'compressor',
  'limiter',
  'normalizer',
  'start',
  'loop',
  'stop',
]

/** `sum("x").` / `aux("x").` の後に出る候補。engine の `BUS_DSL_METHODS` と一致すること。 */
export const BUS_METHODS: readonly string[] = ['effect', 'ui']
