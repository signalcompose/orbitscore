/**
 * REPL (Read-Eval-Print Loop) mode for live coding
 */

import * as readline from 'readline'

import { InterpreterV2 } from '../interpreter/interpreter-v2'
import { parseAudioDSL } from '../parser/audio-parser'

import { setActiveInterpreter } from './active-interpreter'
import { REPLOptions } from './types'
import { shouldEnableSessionLog } from './session-log-gate'

/**
 * Start REPL mode for live coding
 *
 * This function creates a new interpreter, boots the audio engine backend
 * (default Rust daemon since cutover #108; SC via ORBITSCORE_ENGINE=sc),
 * and starts an interactive REPL where users can enter OrbitScore
 * commands line by line.
 *
 * @param options - REPL options (audio device, etc.)
 * @returns Never resolves (keeps process alive)
 *
 * @example
 * ```typescript
 * await startREPLMode({ audioDevice: 'Built-in Output' })
 * ```
 */
export async function startREPLMode(options: REPLOptions = {}): Promise<void> {
  console.log('🎵 OrbitScore Audio Engine')
  console.log('✅ Initialized')

  // Create a global interpreter
  const globalInterpreter = new InterpreterV2()
  // 🔴 #607: startREPLMode() は返らないので、戻り値経由では shutdown ハンドラに
  // 届かない。生成した時点で publish する（詳細は active-interpreter.ts）。
  setActiveInterpreter(globalInterpreter)

  // §L1 (#229): session-log は 2.0.0 では dormant（既定 off）。file-scoped ログが
  // 複数ファイルをまたぐライブセッションに合わない設計ミスマッチのため、session-scoped で
  // 再設計するまで明示 opt-in に退避（writer/API/ユニットは保持・resurrect 可）。
  // 詳細・redesign 北極星: docs/development/POST_2.0_ROADMAP_NOTES.md
  if (shouldEnableSessionLog()) {
    globalInterpreter.enableSessionLog({ cwd: process.cwd() })
  }

  // Boot the audio engine backend once at startup with optional audio device
  await globalInterpreter.boot(options.audioDevice)

  console.log('🎵 Live coding mode')
  await startREPL(globalInterpreter)
}

/**
 * Start REPL with an existing interpreter
 *
 * This function creates a readline interface and listens for user input.
 * Each line is parsed as OrbitScore DSL and executed by the interpreter.
 *
 * @param interpreter - Existing interpreter instance
 * @returns Never resolves (keeps process alive)
 */
/**
 * REPL メタ行 `//#documentDirectory <path>`（I3, #456）: エディタ統合（VS Code 拡張）が
 * 「開いているファイルのディレクトリ」を eval 単位で伝えるための帯域外チャネル。DSL 注入
 * （`global.setDocumentDirectory(...)`）は statements として import より後に評価されるため、
 * import の基準ディレクトリ（IM.6）はこのメタ行でしか先渡しできない。`//` コメントなので
 * DSL としても無害（tokenizer が読み飛ばす）— 戻り値では code から取り除かず、値だけ抽出する。
 * 複数あれば最後の値が勝つ。
 */
export function extractDocumentDirectoryMeta(code: string): string | undefined {
  let dir: string | undefined
  for (const line of code.split('\n')) {
    const m = line.match(/^\s*\/\/#documentDirectory\s+(.+?)\s*$/)
    if (m) dir = m[1]
  }
  return dir
}

/**
 * REPL メタ行 `//#selectAudioDevice <name>`（D2.5, #484）: エディタ統合が走行中エンジンの
 * 出力デバイスをライブ切替するための帯域外チャネル。`documentDirectory` と異なり DSL
 * statement には混ぜず、1 行単独で送られる想定（呼び出し側は eval バッファに積まず即時処理）。
 * `<name>` 省略（末尾空白のみ）はシステム既定への切替を意味する。
 */
const SELECT_AUDIO_DEVICE_META_RE = /^\s*\/\/#selectAudioDevice(?:\s+(.+?))?\s*$/

export function extractSelectAudioDeviceMeta(line: string): { device: string } | undefined {
  const m = line.match(SELECT_AUDIO_DEVICE_META_RE)
  if (!m) return undefined
  return { device: (m[1] ?? '').trim() }
}

const SAVE_PLUGIN_STATE_META_RE = /^\s*\/\/#savePluginState\s+(.+?)\s*$/
const META_REQUEST_ID_RE = /"requestId"\s*:\s*("(?:\\[\s\S]|[^"\\])*")/
const PLUGIN_UI_META_RE = /^\s*\/\/#pluginUi\s+(.+?)\s*$/

export interface SavePluginStateMeta {
  requestId: string
  sequence: string
  index: number
}

/** JSON payloadを使い、空白や記号を含むsequence名を壊さず相関IDも保持する。 */
export function extractSavePluginStateMeta(line: string): SavePluginStateMeta | undefined {
  const match = line.match(SAVE_PLUGIN_STATE_META_RE)
  if (!match) return undefined
  let value: unknown
  try {
    value = JSON.parse(match[1]!)
  } catch (error) {
    throw new Error(
      `invalid //#savePluginState JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('//#savePluginState payload must be a JSON object')
  }
  const payload = value as Record<string, unknown>
  if (typeof payload.requestId !== 'string' || payload.requestId.length === 0) {
    throw new Error('//#savePluginState requires a non-empty string requestId')
  }
  if (typeof payload.sequence !== 'string' || payload.sequence.length === 0) {
    throw new Error('//#savePluginState requires a non-empty string sequence')
  }
  if (!Number.isInteger(payload.index) || (payload.index as number) < 0) {
    throw new Error('//#savePluginState requires a non-negative integer index')
  }
  return {
    requestId: payload.requestId,
    sequence: payload.sequence,
    index: payload.index as number,
  }
}

/**
 * payload の JSON が壊れていても相関 ID だけは拾って応答を返すための救済抽出。
 * `//#savePluginState` / `//#pluginUi` 共通（requestId の運び方が同一のため 1 本）。
 */
function recoverMetaRequestId(line: string): string | undefined {
  const match = line.match(META_REQUEST_ID_RE)
  if (!match) return undefined
  try {
    const requestId = JSON.parse(match[1]!) as unknown
    return typeof requestId === 'string' && requestId.length > 0 ? requestId : undefined
  } catch {
    return undefined
  }
}

async function executeSavePluginStateMeta(
  interpreter: InterpreterV2,
  input: SavePluginStateMeta,
): Promise<void> {
  try {
    const saved = await interpreter.savePluginState(input.sequence, input.index)
    console.log(
      JSON.stringify({
        savePluginState: {
          requestId: input.requestId,
          ok: true,
          saved,
        },
      }),
    )
  } catch (error: any) {
    console.log(
      JSON.stringify({
        savePluginState: {
          requestId: input.requestId,
          ok: false,
          error: error?.message ?? String(error),
          ...(typeof error?.code === 'string' ? { code: error.code } : {}),
          ...(error?.details === undefined ? {} : { details: error.details }),
        },
      }),
    )
  }
}

export interface PluginUiMeta {
  requestId: string
  action: 'open' | 'close'
  receiver: string
  index: number
  expectedName?: string
}

export function extractPluginUiMeta(line: string): PluginUiMeta | undefined {
  const match = line.match(PLUGIN_UI_META_RE)
  if (!match) return undefined
  let value: unknown
  try {
    value = JSON.parse(match[1]!)
  } catch (error) {
    throw new Error(
      `invalid //#pluginUi JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('//#pluginUi payload must be a JSON object')
  }
  const payload = value as Record<string, unknown>
  if (typeof payload.requestId !== 'string' || payload.requestId.length === 0) {
    throw new Error('//#pluginUi requires a non-empty string requestId')
  }
  if (payload.action !== 'open' && payload.action !== 'close') {
    throw new Error("//#pluginUi action must be 'open' or 'close'")
  }
  if (typeof payload.receiver !== 'string' || payload.receiver.length === 0) {
    throw new Error('//#pluginUi requires a non-empty string receiver')
  }
  if (!Number.isInteger(payload.index) || (payload.index as number) < 0) {
    throw new Error('//#pluginUi requires a non-negative integer index')
  }
  if (payload.expectedName !== undefined && typeof payload.expectedName !== 'string') {
    throw new Error('//#pluginUi expectedName must be a string when present')
  }
  return {
    requestId: payload.requestId,
    action: payload.action,
    receiver: payload.receiver,
    index: payload.index as number,
    ...(payload.expectedName === undefined ? {} : { expectedName: payload.expectedName }),
  }
}

async function executePluginUiMeta(interpreter: InterpreterV2, input: PluginUiMeta): Promise<void> {
  try {
    const result =
      input.action === 'open'
        ? await interpreter.openPluginUi(input.receiver, input.index, input.expectedName)
        : await interpreter.closePluginUi(input.receiver, input.index)
    console.log(
      JSON.stringify({
        pluginUi: { requestId: input.requestId, action: input.action, ok: true, result },
      }),
    )
  } catch (error: any) {
    console.log(
      JSON.stringify({
        pluginUi: {
          requestId: input.requestId,
          action: input.action,
          ok: false,
          error: error?.message ?? String(error),
          ...(typeof error?.code === 'string' ? { code: error.code } : {}),
          ...(error?.details === undefined ? {} : { details: error.details }),
        },
      }),
    )
  }
}

/**
 * `//#selectAudioDevice` メタ行を処理し、相関用の 1 行 JSON を stdout に出す
 * （`{"selectAudioDevice":{"ok":true,"device":"..."}}` / `{"ok":false,"error":"..."}`）。
 * `interpreter.audioEngine` 経由（SC バックエンドは `selectAudioDevice` 未実装 = optional）。
 */
async function executeSelectAudioDeviceMeta(
  interpreter: InterpreterV2,
  device: string,
): Promise<void> {
  // JSON エンベロープの出力は 1 箇所に集約（3 分岐で個別に stringify すると
  // 将来のフィールド追加時に stdout 契約が食い違うリスクがある）。
  let result: { ok: boolean; device?: string; error?: string }
  try {
    const audioEngine = interpreter.audioEngine
    if (!audioEngine.selectAudioDevice) {
      result = {
        ok: false,
        error: 'selectAudioDevice is not supported by the current audio engine backend',
      }
    } else {
      result = { ok: true, device: await audioEngine.selectAudioDevice(device) }
    }
  } catch (error: any) {
    result = { ok: false, error: error?.message ?? String(error) }
  }
  console.log(JSON.stringify({ selectAudioDevice: result }))
}

/**
 * REPL の行処理セッション（#476 で分離・単体テスト可能に）。
 *
 * 【直列化の根拠 — #476】readline は 1 チャンクの複数行を同 tick で 'line' 連発する。
 * async ハンドラは互いを待たないため、素朴な実装では共有 buffer が「実行中の execute が
 * 終わる前に後続行で伸びる → 累積 buffer の重複実行・完了時 clear との競合で行が失われる」
 * （遅い await = plugin ロードで顕在化し、エディタの複数行実行が silent に壊れる）。
 * `pushLine` は FIFO promise チェーンに積むだけで、1 行の処理（execute 完了と buffer
 * 更新まで）が終わってから次の行に進む。`idle()` はキュー drain を待つ（テスト用）。
 */
export function createReplSession(interpreter: InterpreterV2): {
  pushLine: (line: string) => void
  idle: () => Promise<void>
} {
  let buffer = ''
  let emptyLineCount = 0
  // メタ行で受けた基準ディレクトリ（セッション内で最後の値が持続 — エディタ側は eval ごとに
  // 現在ファイルの dir を送るので、ファイル切替にも追従する）。
  let sessionDocumentDirectory: string | undefined
  let lineQueue: Promise<void> = Promise.resolve()
  /// 🔴 #607: 実行中の行が滞留していることを報告するまでの待ち時間。
  ///
  /// `pushLine` は全行を単一の promise チェーンへ載せるので、**1 行が resolve しないと
  /// 以後の入力が永久に待たされる**。`pushLine` は `void` を返すため呼び出し元
  /// （MCP の `evaluate_orbitscore` 等）には成功に見え、**`ok` が返るのに何も実行されない**
  /// という最悪の見え方になる（2026-08-01 に Kontakt を 6 声宣言して実際に発生）。
  ///
  /// タイムアウトで打ち切るのではなく**報告する**に留めるのは、長い処理が正当に存在するため
  /// （instrument 6 本の attach は実測 30 秒超）。閾値は daemon の `CHILD_READY_TIMEOUT`
  /// （60s）に合わせ、「daemon 側の上限を超えてなお終わらない」ときだけ鳴らす。
  const QUEUE_STALL_REPORT_MS = 60_000
  let queuedLines = 0

  async function executeCurrentBuffer(clearOnIncomplete: boolean): Promise<void> {
    const code = buffer.trim()
    if (!code) {
      buffer = ''
      emptyLineCount = 0
      return
    }
    // 🔴 #612 レビュー: **「未完」判定はパース段のエラーにだけ適用する。**
    // 以前は parse と execute を 1 つの try で覆っていたため、`/\bEOF\b/` が
    // **実行時エラーの文言にも作用**していた。実行時エラーはユーザー由来の文字列
    // （ファイルパス・識別子・daemon のエラー echo）を含むので、たとえば
    // `kick.audio("takes/EOF.wav")` の ENOENT が「未完入力」と誤判定され、
    // **完結した行が silent に保留されてセッションが停止する** — #608 と同じ故障が
    // 別経路で再発する。パースが終わった時点で「入力が完結していない」possibility は消える。
    let ir: ReturnType<typeof parseAudioDSL>
    try {
      ir = parseAudioDSL(code)
    } catch (error: any) {
      // 不完全入力（複数行の途中）は buffering を続ける（強制実行時は除く）。
      //
      // 🔴 #607: 「未完」と判定してよいのは**パーサが入力の終端（EOF）に達した**場合だけ。
      // 旧判定は `Expected RPAREN` を文字列一致で「未完」に含めていたが、このメッセージは
      // `Expected RPAREN but got AT`（= 行の**途中**に不正トークンがある本物の構文エラー）
      // でも出る。構文エラーを「未完」として silent に保留すると、以後の全入力が未完
      // バッファへ合体して**セッション全体が沈黙のまま永久停止**する — 実機で
      // `[1,5,9]@v+10`（パーサ未対応のスタック @v）1 行がライブセッションを丸ごと
      // 止めた（2026-08-01）。トークンが尽きたのでなければ、待っても文は完結しない。
      if (!clearOnIncomplete && /\bEOF\b/.test(String(error.message ?? ''))) {
        return
      }
      console.error(`[ERROR] ${error.message}`)
      buffer = ''
      return
    }

    // ここから先は「入力は完結している」— 失敗しても保留せず必ず報告してバッファを捨てる。
    try {
      const metaDir = extractDocumentDirectoryMeta(code)
      if (metaDir) sessionDocumentDirectory = metaDir
      await interpreter.execute(ir, {
        source: code,
        evalSource: 'human',
        documentDirectory: sessionDocumentDirectory,
      }) // §L1
      console.log('✓') // Success indicator
    } catch (error: any) {
      console.error(`[ERROR] ${error.message}`)
    }
    buffer = ''
  }

  async function handleLine(line: string): Promise<void> {
    if (PLUGIN_UI_META_RE.test(line)) {
      try {
        const input = extractPluginUiMeta(line)
        if (input) await executePluginUiMeta(interpreter, input)
      } catch (error: any) {
        const message = error?.message ?? String(error)
        const requestId = recoverMetaRequestId(line)
        if (requestId) {
          console.log(JSON.stringify({ pluginUi: { requestId, ok: false, error: message } }))
        } else {
          console.error(`[ERROR] ${message}`)
        }
      }
      return
    }
    if (SAVE_PLUGIN_STATE_META_RE.test(line)) {
      try {
        const savePluginStateMeta = extractSavePluginStateMeta(line)
        if (savePluginStateMeta) {
          await executeSavePluginStateMeta(interpreter, savePluginStateMeta)
        }
      } catch (error: any) {
        const message = error?.message ?? String(error)
        const requestId = recoverMetaRequestId(line)
        if (requestId) {
          console.log(
            JSON.stringify({
              savePluginState: {
                requestId,
                ok: false,
                error: message,
              },
            }),
          )
        } else {
          console.error(`[ERROR] ${message}`)
        }
      }
      return
    }
    const selectDeviceMeta = extractSelectAudioDeviceMeta(line)
    if (selectDeviceMeta) {
      // 単独の帯域外コマンド — eval バッファには積まず、進行中のバッファはそのまま維持する
      // （複数行入力の途中でデバイス切替が挟まれても壊れない）。
      await executeSelectAudioDeviceMeta(interpreter, selectDeviceMeta.device)
      return
    }
    if (line.trim() === '') {
      emptyLineCount++
      buffer += '\n'
      // 2+ 連続空行 = バッファ確定・強制実行
      if (emptyLineCount >= 2 && buffer.trim()) {
        await executeCurrentBuffer(true)
        emptyLineCount = 0
      }
      return
    }
    emptyLineCount = 0
    buffer += line + '\n'
    await executeCurrentBuffer(false)
  }

  /// 実行中の行が [`QUEUE_STALL_REPORT_MS`] を超えても終わらないあいだ、**繰り返し**報告する。
  ///
  /// 打ち切らないので意味論は変わらない。変わるのは「沈黙して詰まる」が
  /// 「詰まっている事実と原因の行が `get_log` に出る」になること。1 回だけでなく
  /// 反復するのは、詰まりが解消したかどうかを外から判断できるようにするため。
  const runWithStallReport = async (line: string): Promise<void> => {
    const startedAt = Date.now()
    const preview = line.trim().slice(0, 120)
    const timer = setInterval(() => {
      const seconds = Math.round((Date.now() - startedAt) / 1000)
      console.error(
        `[ERROR] REPL queue is still blocked after ${seconds}s by: ${preview}` +
          ` — ${queuedLines} line(s) are waiting behind it and will not run until it finishes.` +
          ` They are accepted but NOT executed.`,
      )
    }, QUEUE_STALL_REPORT_MS)
    // timer が event loop を生かし続けないようにする（CLI の終了を妨げない）。
    timer.unref?.()
    try {
      await handleLine(line)
    } finally {
      clearInterval(timer)
    }
  }

  return {
    pushLine(line: string): void {
      // handleLine は内部で全エラーを捕捉するが、防御としてチェーン自体も reject を握る
      // （1 行の異常で以後の入力が全停止しないように）。
      queuedLines++
      lineQueue = lineQueue
        .then(() => {
          queuedLines--
          return runWithStallReport(line)
        })
        .catch((e) => {
          // handleLine は既知エラーを内部で捕捉する。ここに来るのは想定外のみ —
          // 黙って握ると REPL が silent に劣化するため、必ず痕跡を残して続行する。
          console.error(`[ERROR] unexpected REPL queue failure: ${e?.message ?? e}`)
        })
    },
    idle(): Promise<void> {
      return lineQueue
    },
  }
}

export async function startREPL(interpreter: InterpreterV2): Promise<void> {
  // 🔴 #607: この関数も返らない。play/run/eval から REPL に入る経路でも publish する。
  setActiveInterpreter(interpreter)
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  })

  const session = createReplSession(interpreter)
  rl.on('line', (line) => session.pushLine(line))

  // Keep process alive indefinitely for interactive REPL
  // This is intentional: REPL mode is designed to run continuously,
  // listening for user input on stdin until the user terminates with Ctrl+C.
  // The readline interface will continue to emit 'line' events as long as
  // the process is alive. The shutdown handlers in shutdown.ts will handle
  // graceful termination of the audio engine backend when the user exits.
  // Note: This promise never resolves, which is the expected behavior.
  await new Promise(() => {})
}
