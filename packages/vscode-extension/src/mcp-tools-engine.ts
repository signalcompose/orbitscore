/**
 * engine 系の MCP ツール 7 本（#887 束 F・`mcp-server.ts` の `buildServer` から移した）。
 *
 * 🔴 **`registerTool` の呼び出し本文は 1 行も書き換えていない。**
 * `buildServer` が 616 コード行の単一関数で 500 の閾値を満たせなかったため、
 * `session.rs` の前例に倣ってドメイン単位の `register*Tools` へ切った（設計 §5.2 / D5）。
 *
 * 🔴 **呼ばれる順序が MCP の `tools/list` の順序である。**
 * `buildServer` は engine → editor → plugins → docs の順で呼ぶこと
 * （理由は `mcp-tools-editor.ts` の `registerDocsTools` の doc）。
 */
import { errorResult, type McpServerLike, toToolResult, z } from './mcp-sdk'
import type { EvaluateResult, OrbitScoreToolHandlers } from './mcp-types'

/**
 * #966: name the base directory the evaluation used, so an agent sees a wrong base
 * immediately instead of as a distant `[SAMPLE_NOT_FOUND]`. The text still starts with
 * `ok` / `error:` as before; `documentDirectory` absent (code never sent) adds nothing.
 * `null` means no base was sent — the engine's REPL keeps the base of its previous evaluation,
 * so the text says so instead of claiming there is no base (core spec IM.6).
 */
export function evaluateToolResult(result: EvaluateResult): ReturnType<typeof toToolResult> {
  const base =
    result.documentDirectory === undefined
      ? ''
      : ` (documentDirectory: ${
          result.documentDirectory ?? 'not sent — the engine keeps its previous base'
        })`
  return result.ok
    ? toToolResult({ ok: true, message: `ok${base}` })
    : toToolResult({ ok: false, error: `${result.error}${base}` })
}

export function registerEngineTools(server: McpServerLike, handlers: OrbitScoreToolHandlers): void {
  server.registerTool(
    'evaluate_orbitscore',
    {
      title: 'Evaluate OrbitScore',
      description:
        'Send OrbitScore (.orbs) source to the running engine live-coding session — ' +
        'the equivalent of "Run Selection" in the editor. The engine must be started ' +
        'first (via the Start Engine command). Waits for the engine to finish evaluating ' +
        'the submitted code and reports the result: ok only when the engine raised no parse ' +
        'or runtime diagnostics. A failure lists the diagnostics, so you do NOT need to poll ' +
        'get_log to find out whether your score was accepted. Relative paths (import, ' +
        'audio(), plugin state files) resolve against the directory of document_path if ' +
        'given, else the active OrbitScore editor, else the first workspace folder; the ' +
        'result names the directory that was used. Pass document_path when the code belongs ' +
        'to a file that may not be the active editor (e.g. while a person is performing in ' +
        'another tab) — it avoids switching their editor with open_file.',
      inputSchema: {
        code: z.string().describe('OrbitScore source to evaluate'),
        document_path: z
          .string()
          .describe(
            'The .orbs file this code belongs to (absolute or workspace-relative). Its ' +
              'directory becomes the base for relative paths. Must be an existing file.',
          )
          .optional(),
      },
    },
    async (args) => {
      const code = typeof args.code === 'string' ? args.code : ''
      const documentPath = typeof args.document_path === 'string' ? args.document_path : undefined
      return evaluateToolResult(await handlers.evaluate(code, { documentPath }))
    },
  )

  server.registerTool(
    'start_engine',
    {
      title: 'Start Engine',
      description:
        'Start the OrbitScore audio engine (the native Rust daemon). Equivalent to ' +
        'the "Start Engine" command. Must be called before evaluate_orbitscore. ' +
        'Pass capture_wav to record the master output to a WAV file (capture seam) ' +
        'so the produced audio can be verified without listening. Pass debug: true ' +
        'for the "Start Engine (Debug)" command variant (verbose engine logging).',
      inputSchema: {
        capture_wav: z
          .string()
          .describe('Absolute path to write a whole-stream WAV capture of the master output')
          .optional(),
        debug: z
          .boolean()
          .describe('Start in debug mode, equivalent to "Start Engine (Debug)"')
          .optional(),
      },
    },
    async (args) => {
      const captureWav = typeof args.capture_wav === 'string' ? args.capture_wav : undefined
      const debug = args.debug === true
      const options = captureWav || debug ? { captureWav, debug } : undefined
      return toToolResult(await handlers.startEngine(options))
    },
  )

  server.registerTool(
    'stop_engine',
    {
      title: 'Stop Engine',
      description: 'Stop the OrbitScore audio engine. Equivalent to the "Stop Engine" command.',
    },
    async () => toToolResult(await handlers.stopEngine()),
  )

  server.registerTool(
    'get_engine_state',
    {
      title: 'Get Engine State',
      description:
        'Report engine process state plus the daemon GetStatus output and callback snapshots.',
    },
    async () => {
      const state = await handlers.getEngineState()
      return { content: [{ type: 'text', text: JSON.stringify(state) }] }
    },
  )

  server.registerTool(
    'list_audio_devices',
    {
      title: 'List Audio Devices',
      description:
        'List audio output devices. Not implemented for the Rust engine today ' +
        '(tracked separately — doc 662 §6 / #660); returns an error explaining that ' +
        'the system default output is used instead.',
    },
    async () => {
      const result = await handlers.listAudioDevices()
      if (!result.ok) {
        return errorResult(result.error)
      }
      return { content: [{ type: 'text', text: JSON.stringify(result.devices) }] }
    },
  )

  server.registerTool(
    'select_audio_device',
    {
      title: 'Select Audio Device',
      description:
        'Select the audio output device. Selects a device and powers on the engine if ' +
        'it is off, switches live if it is already running, and deselects/stops when ' +
        'the selected device is submitted again. The choice is persisted to ' +
        '"orbitscore.audioDevice".',
      inputSchema: {
        device: z.string().describe('Device name as reported by list_audio_devices'),
      },
    },
    async (args) => {
      const device = typeof args.device === 'string' ? args.device : ''
      return toToolResult(await handlers.selectAudioDevice(device))
    },
  )

  server.registerTool(
    'configure_flash',
    {
      title: 'Configure Flash',
      description:
        'Set the "Run Selection" flash feedback settings (count, duration, color, ' +
        'custom_color) — equivalent to "Configure Flash" in the command palette. ' +
        'Only provided fields are changed; omitted fields keep their current value. ' +
        'Returns the resulting effective configuration.',
      inputSchema: {
        count: z.number().describe('Number of flashes (1-5)').optional(),
        duration: z.number().describe('Duration of each flash in milliseconds (50-500)').optional(),
        color: z
          .string()
          .describe('Flash color theme: selection | error | warning | info | custom')
          .optional(),
        custom_color: z
          .string()
          .describe('Custom flash color in hex format, e.g. #ff6b6b (used when color: "custom")')
          .optional(),
      },
    },
    async (args) => {
      const result = await handlers.configureFlash({
        count: typeof args.count === 'number' ? args.count : undefined,
        duration: typeof args.duration === 'number' ? args.duration : undefined,
        color: typeof args.color === 'string' ? args.color : undefined,
        customColor: typeof args.custom_color === 'string' ? args.custom_color : undefined,
      })
      if (!result.ok) {
        return errorResult(result.error)
      }
      return { content: [{ type: 'text', text: JSON.stringify(result.config) }] }
    },
  )
}
