import {
  errorResult,
  type McpServerLike,
  resolveMcpPluginUiIndex,
  type ToolResult,
  z,
} from './mcp-sdk'
import type { OrbitScoreToolHandlers, PluginUiResult } from './mcp-types'

export function registerPluginTools(server: McpServerLike, handlers: OrbitScoreToolHandlers): void {
  const savePluginState = handlers.savePluginState?.bind(handlers)
  if (savePluginState) {
    server.registerTool(
      'save_plugin_state',
      {
        title: 'Save Plugin State',
        description:
          'Save the current state of a running plugin into the project states directory and ' +
          'register it in project.yaml. Address the current chain with receiver and index ' +
          '(the input field remains named sequence for compatibility): plain names select ' +
          'sequences, "master" selects the master output endpoint, and "sum:<name>"/' +
          '"aux:<name>" select mixer buses. Index 0 is a note-sequence instrument; effects ' +
          'start at index 1. ' +
          'Playback must be stopped.',
        inputSchema: {
          sequence: z
            .string()
            .describe('Receiver: sequence name, "master", "sum:<bus-name>", or "aux:<bus-name>"'),
          index: z.number().describe('UIH.5 chain index (instrument 0, effects 1-based)'),
        },
      },
      async (args) => {
        const sequence = typeof args.sequence === 'string' ? args.sequence : ''
        const index = typeof args.index === 'number' ? args.index : NaN
        if (!sequence || !Number.isInteger(index) || index < 0) {
          return errorResult('sequence and a non-negative integer index are required')
        }
        const result = await savePluginState(sequence, index)
        if (!result.ok) {
          return errorResult(
            JSON.stringify({
              error: result.error,
              ...(result.code ? { code: result.code } : {}),
              ...(result.details === undefined ? {} : { details: result.details }),
            }),
          )
        }
        return { content: [{ type: 'text', text: JSON.stringify(result.saved) }] }
      },
    )
  }

  const openPluginUi = handlers.openPluginUi?.bind(handlers)
  const closePluginUi = handlers.closePluginUi?.bind(handlers)
  if (openPluginUi && closePluginUi) {
    const pluginUiError = (result: Extract<PluginUiResult, { ok: false }>): ToolResult =>
      errorResult(
        JSON.stringify({
          error: result.error,
          ...(result.code ? { code: result.code } : {}),
          ...(result.details === undefined ? {} : { details: result.details }),
        }),
      )
    const receiverSchema = z
      .string()
      .describe('Receiver: sequence name, "master", "sum:<bus-name>", or "aux:<bus-name>"')
    const chainPathSchema = z
      .array(z.number().int().nonnegative())
      .length(1)
      .describe('Zero-based effect chain path; v1 requires exactly one non-negative integer')
      .optional()
    const indexSchema = z
      .number()
      .describe('Compatibility-only UIH.5 chain index (instrument 0, effects 1-based)')
      .optional()
    server.registerTool(
      'open_plugin_ui',
      {
        title: 'Open Plugin UI',
        description:
          'Open and attach the current plugin window addressed by receiver and zero-based ' +
          'chain_path. The legacy index remains accepted for compatibility; when both are ' +
          'provided they must identify the same effect. ' +
          'Returns only after the window exists. expectedName is an optional normalized-name ' +
          'guard that prevents opening a different plugin after chain indices shift.',
        inputSchema: {
          receiver: receiverSchema,
          chain_path: chainPathSchema,
          index: indexSchema,
          expectedName: z
            .string()
            .describe('Optional normalized plugin name that must match the current slot')
            .optional(),
        },
      },
      async (args) => {
        const receiver = typeof args.receiver === 'string' ? args.receiver : ''
        const expectedName = typeof args.expectedName === 'string' ? args.expectedName : undefined
        if (!receiver) return errorResult('receiver is required')
        const address = resolveMcpPluginUiIndex(args)
        if (!address.ok) return errorResult(address.error)
        const result = await openPluginUi(receiver, address.index, expectedName)
        return result.ok
          ? { content: [{ type: 'text', text: JSON.stringify(result.result) }] }
          : pluginUiError(result)
      },
    )

    server.registerTool(
      'close_plugin_ui',
      {
        title: 'Close Plugin UI',
        description:
          'Close the plugin window addressed by receiver and zero-based chain_path. The legacy ' +
          'index remains accepted for compatibility and must agree when both are provided. ' +
          'Returns only after ' +
          'UI_CLOSED_DONE, including the close-time state-save safepoint; the command ack alone ' +
          'is not completion.',
        inputSchema: { receiver: receiverSchema, chain_path: chainPathSchema, index: indexSchema },
      },
      async (args) => {
        const receiver = typeof args.receiver === 'string' ? args.receiver : ''
        if (!receiver) return errorResult('receiver is required')
        const address = resolveMcpPluginUiIndex(args)
        if (!address.ok) return errorResult(address.error)
        const result = await closePluginUi(receiver, address.index)
        return result.ok
          ? { content: [{ type: 'text', text: JSON.stringify(result.result) }] }
          : pluginUiError(result)
      },
    )
  }

  server.registerTool(
    'analyze_audio',
    {
      title: 'Analyze Audio',
      description:
        'Parse a WAV file (e.g. a capture_wav produced by start_engine) and report ' +
        'peak, RMS, and onset timing so audio can be verified objectively without ' +
        'listening. Pass window_ms to also get a per-window peak/RMS time series ' +
        '(for verifying temporal structure such as dry-first / steady-state). Pass ' +
        'per_channel to also get per-channel peak/RMS (for verifying pan / channel ' +
        'separation / bleed — the default analysis sums channels down to mono, which ' +
        'cannot distinguish them).',
      inputSchema: {
        wav_path: z.string().describe('Absolute path to the WAV file to analyze'),
        window_ms: z
          .number()
          .describe('Optional window size in ms for a per-window peak/RMS series (e.g. 10)')
          .optional(),
        per_channel: z
          .boolean()
          .describe(
            'Optional: also return channelWindows / channelRms (per-channel peak/RMS) ' +
              'instead of only the mono mixdown',
          )
          .optional(),
      },
    },
    async (args) => {
      const wavPath = typeof args.wav_path === 'string' ? args.wav_path : ''
      const windowMs = typeof args.window_ms === 'number' ? args.window_ms : undefined
      const perChannel = typeof args.per_channel === 'boolean' ? args.per_channel : undefined
      const result = await handlers.analyzeAudio(wavPath, windowMs, perChannel)
      if (!result.ok) {
        return errorResult(result.error)
      }
      return { content: [{ type: 'text', text: JSON.stringify(result.analysis) }] }
    },
  )

  server.registerTool(
    'list_plugins',
    {
      title: 'List Plugins',
      description:
        'List the installed CLAP/VST3 plugin catalog (#463 PC.1) — name, vendor, format, ' +
        'and roles (effect/instrument) for each entry — so an agent can pick real ' +
        'plugin names when composing effect()/instrument() calls. Returns an error ' +
        '(with a rescan hint) if the catalog has not been scanned yet.',
    },
    async () => {
      const result = await handlers.listPlugins()
      if (!result.ok) {
        return errorResult(result.error)
      }
      return { content: [{ type: 'text', text: JSON.stringify(result.plugins) }] }
    },
  )

  server.registerTool(
    'rescan_plugins',
    {
      title: 'Rescan Plugins',
      description:
        'Scan the OS plugin directories (and ORBIT_PLUGIN_PATH) and rewrite the plugin ' +
        'catalog using explicit child probes. Equivalent to the "Rescan Plugin Catalog" ' +
        'command. Returns per-artifact failure diagnostics, success/pending/failure counts, ' +
        'failure reasons, duration percentiles, timeout/crash counts, and factory descriptor versions.',
    },
    async () => {
      const result = await handlers.rescanPlugins()
      if (!result.ok) {
        return errorResult(result.error)
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              count: result.count,
              artifactCount: result.artifactCount,
              skipped: result.skipped,
              failures: result.failures,
              summary: result.summary,
            }),
          },
        ],
      }
    },
  )
}
