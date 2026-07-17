/**
 * REPL (Read-Eval-Print Loop) mode for live coding
 */

import * as readline from 'readline'

import { InterpreterV2 } from '../interpreter/interpreter-v2'
import { parseAudioDSL } from '../parser/audio-parser'

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

/**
 * `//#selectAudioDevice` メタ行を処理し、相関用の 1 行 JSON を stdout に出す
 * （`{"selectAudioDevice":{"ok":true,"device":"..."}}` / `{"ok":false,"error":"..."}`）。
 * `interpreter.audioEngine` 経由（SC バックエンドは `selectAudioDevice` 未実装 = optional）。
 */
async function executeSelectAudioDeviceMeta(
  interpreter: InterpreterV2,
  device: string,
): Promise<void> {
  try {
    const audioEngine = interpreter.audioEngine
    if (!audioEngine.selectAudioDevice) {
      console.log(
        JSON.stringify({
          selectAudioDevice: {
            ok: false,
            error: 'selectAudioDevice is not supported by the current audio engine backend',
          },
        }),
      )
      return
    }
    const applied = await audioEngine.selectAudioDevice(device)
    console.log(JSON.stringify({ selectAudioDevice: { ok: true, device: applied } }))
  } catch (error: any) {
    console.log(
      JSON.stringify({
        selectAudioDevice: { ok: false, error: error?.message ?? String(error) },
      }),
    )
  }
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

  async function executeCurrentBuffer(clearOnIncomplete: boolean): Promise<void> {
    const code = buffer.trim()
    if (!code) {
      buffer = ''
      emptyLineCount = 0
      return
    }
    try {
      const ir = parseAudioDSL(code)
      const metaDir = extractDocumentDirectoryMeta(code)
      if (metaDir) sessionDocumentDirectory = metaDir
      await interpreter.execute(ir, {
        source: code,
        evalSource: 'human',
        documentDirectory: sessionDocumentDirectory,
      }) // §L1
      console.log('✓') // Success indicator
      buffer = ''
    } catch (error: any) {
      // 不完全入力（複数行の途中）は buffering を続ける（強制実行時は除く）
      if (
        !clearOnIncomplete &&
        (error.message.includes('EOF') ||
          error.message.includes('Expected RPAREN') ||
          error.message.includes('Expected comma or closing parenthesis'))
      ) {
        return
      }
      console.error(`[ERROR] ${error.message}`)
      buffer = ''
    }
  }

  async function handleLine(line: string): Promise<void> {
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

  return {
    pushLine(line: string): void {
      // handleLine は内部で全エラーを捕捉するが、防御としてチェーン自体も reject を握る
      // （1 行の異常で以後の入力が全停止しないように）。
      lineQueue = lineQueue
        .then(() => handleLine(line))
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
