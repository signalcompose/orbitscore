/**
 * 層 2 の写しの MCP 層（`buildServer` + `mcp-tools-*`・設計 848 §6）を、stub の handler と SDK の
 * クライアントで確かめる。凍結版 `tests/vscode-extension/mcp-server.spec.ts` のツールの節を移した。
 *
 * 移していないもの: HTTP の節（multi-session・Host の 403・404・dispose）。v1 に TCP の `/mcp` は
 * 無く、MCP は中継の stdio で話す（§6）。
 *
 * 足したもの: 凍結版で同期だった 5 本の handler が Promise を返しても同じ応答になること /
 * handler が投げた失敗が `errorResult` と同じ封筒になること / docs 系が `DocsToolSource` を読むこと。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildServer } from '../../packages/session/src/mcp/build-server'
import type { DocsToolSource } from '../../packages/session/src/mcp/mcp-tools-editor'
import type {
  AnalyzeAudioResult,
  CommandResult,
  DocumentText,
  EditorState,
  ListPluginsResult,
  OrbitScoreToolHandlers,
  RescanPluginsResult,
} from '../../packages/session/src/mcp/mcp-types'

import { connectMcp, type McpTestClient } from './helpers/mcp-test-client'

interface RecordedCall {
  name: string
  args: unknown[]
}

/** 凍結版の spec と同じ stub（任意の 5 本は持たない）。 */
function createStubHandlers(overrides: Partial<OrbitScoreToolHandlers> = {}): {
  handlers: OrbitScoreToolHandlers
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const record = (name: string, args: unknown[]) => calls.push({ name, args })
  const emptyState: EditorState = {
    path: null,
    languageId: null,
    cursor: null,
    selection: null,
    lineCount: null,
    isDirty: null,
  }
  const defaults: OrbitScoreToolHandlers = {
    evaluate: (code, options) => {
      record('evaluate', [code, options])
      return { ok: true }
    },
    startEngine: (options) => {
      record('startEngine', [options])
      return { ok: true, message: 'started' }
    },
    stopEngine: () => {
      record('stopEngine', [])
      return { ok: true, message: 'stopped' }
    },
    getEngineState: () => {
      record('getEngineState', [])
      return { running: true, liveCoding: false }
    },
    listAudioDevices: () => {
      record('listAudioDevices', [])
      return { ok: true, devices: [] }
    },
    selectAudioDevice: (device) => {
      record('selectAudioDevice', [device])
      return { ok: true }
    },
    configureFlash: (options) => {
      record('configureFlash', [options])
      return {
        ok: true,
        config: { count: 3, duration: 150, color: 'selection', customColor: '#ff6b6b' },
      }
    },
    openFile: (path) => {
      record('openFile', [path])
      return { ok: true }
    },
    setSelection: (range) => {
      record('setSelection', [range])
      return { ok: true }
    },
    runSelection: () => {
      record('runSelection', [])
      return { ok: true }
    },
    editReplace: (args) => {
      record('editReplace', [args])
      return { ok: true, message: '1' }
    },
    getEditorState: () => {
      record('getEditorState', [])
      return emptyState
    },
    saveFile: () => {
      record('saveFile', [])
      return { ok: true, message: 'saved: /tmp/stub.orbs' }
    },
    getDocumentText: () => {
      record('getDocumentText', [])
      return { path: null, text: null }
    },
    getDiagnostics: (path) => {
      record('getDiagnostics', [path])
      return []
    },
    getLog: (lines) => {
      record('getLog', [lines])
      return ['[info] log line 1', '[info] log line 2']
    },
    analyzeAudio: (wavPath) => {
      record('analyzeAudio', [wavPath])
      const result: AnalyzeAudioResult = {
        ok: true,
        analysis: {
          format: { audioFormat: 3, channels: 2, sampleRate: 48000, bitsPerSample: 32 },
          frames: 0,
          durationSec: 0,
          peak: 0,
          rms: 0,
          onsets: [],
          onsetGaps: [],
          soundDetected: false,
        },
      }
      return result
    },
    listPlugins: () => {
      record('listPlugins', [])
      return { ok: true, plugins: [] }
    },
    rescanPlugins: () => {
      record('rescanPlugins', [])
      const result: RescanPluginsResult = {
        ok: true,
        count: 0,
        artifactCount: 0,
        skipped: [],
        failures: [],
        summary: {
          success: 0,
          pending: 0,
          failure: 0,
          failureReasons: {},
          durationMs: { p50: null, p95: null, max: null },
          timeouts: 0,
          crashes: 0,
          factoryVersions: {},
          cacheHits: 0,
          probeAttempts: 0,
        },
      }
      return result
    },
  }
  return { handlers: { ...defaults, ...overrides }, calls }
}

/** 任意の 5 本を足した、ネイティブ版と同じ形の handler（§6: 28 本すべてを登録する）。 */
const FULL_OPTIONAL: Partial<OrbitScoreToolHandlers> = {
  savePluginState: () => ({ ok: true, saved: {} }),
  openPluginUi: () => ({ ok: true, result: {} }),
  closePluginUi: () => ({ ok: true, result: {} }),
  openPluginUiAtCursor: () => ({
    ok: true,
    receiver: 'lead',
    index: 1,
    chain_path: [0],
    normalizedName: 'Echo',
    site: { line: 1, startCol: 13, endCol: 19 },
  }),
  registerMcpServer: () => ({ ok: true }),
}

function stubDocs(overrides: Partial<DocsToolSource> = {}) {
  const get = vi.fn(async (site: string, relativePath: string) => `# ${site}:${relativePath}`)
  const search = vi.fn(async (site: string, query: string, limit: number) => [
    { path: `${site}.md`, line: limit, excerpt: query },
  ])
  return { docs: { get, search, ...overrides } as DocsToolSource, get, search }
}

let mcp: McpTestClient | null = null

async function start(
  handlers: OrbitScoreToolHandlers,
  docs: DocsToolSource = stubDocs().docs,
): Promise<McpTestClient> {
  mcp = await connectMcp(buildServer('0.0.0-test', handlers, docs))
  return mcp
}

afterEach(async () => {
  await mcp?.close()
  mcp = null
})

/** 設計 848 §6 の 28 本（凍結版の `buildServer` に全 handler を渡した時の順序）。 */
const ALL_28 = [
  'evaluate_orbitscore',
  'start_engine',
  'stop_engine',
  'get_engine_state',
  'list_audio_devices',
  'select_audio_device',
  'configure_flash',
  'open_file',
  'set_selection',
  'run_selection',
  'edit_replace',
  'get_editor_state',
  'save_file',
  'get_document_text',
  'get_diagnostics',
  'get_log',
  'save_plugin_state',
  'open_plugin_ui',
  'close_plugin_ui',
  'open_plugin_ui_at_cursor',
  'analyze_audio',
  'list_plugins',
  'rescan_plugins',
  'get_dev_doc',
  'search_dev_docs',
  'get_user_doc',
  'search_user_docs',
  'register_mcp_server',
]

describe('the copied MCP layer (design 848 §6)', () => {
  it('initialize answers serverInfo orbitscore with the given version', async () => {
    const client = await start(createStubHandlers().handlers)
    expect(client.client.getServerVersion()).toEqual({ name: 'orbitscore', version: '0.0.0-test' })
  })

  it('tools/list with every handler is the 28 tools of design §6, in order', async () => {
    const client = await start(createStubHandlers(FULL_OPTIONAL).handlers)
    expect((await client.listTools()).map((tool) => tool.name)).toEqual(ALL_28)
  })

  it('tools/list without the optional handlers keeps the frozen 23-tool order', async () => {
    const client = await start(createStubHandlers().handlers)
    const optional = new Set([
      'save_plugin_state',
      'open_plugin_ui',
      'close_plugin_ui',
      'open_plugin_ui_at_cursor',
      'register_mcp_server',
    ])
    expect((await client.listTools()).map((tool) => tool.name)).toEqual(
      ALL_28.filter((name) => !optional.has(name)),
    )
  })

  it('evaluate_orbitscore requires code:string and takes an optional document_path', async () => {
    const client = await start(createStubHandlers().handlers)
    const tool = (await client.listTools()).find((t) => t.name === 'evaluate_orbitscore')!
    expect(tool.inputSchema.required).toEqual(['code'])
    expect(tool.inputSchema.properties.code.type).toBe('string')
    expect(tool.inputSchema.properties.document_path.type).toBe('string')
  })

  it('evaluate_orbitscore round-trips the exact code and document_path', async () => {
    const { handlers, calls } = createStubHandlers()
    const client = await start(handlers)
    const code = 'global.tempo(140)\nLOOP(drum)'
    expect(await client.call('evaluate_orbitscore', { code })).toEqual({
      content: [{ type: 'text', text: 'ok' }],
    })
    await client.call('evaluate_orbitscore', { code: 'x', document_path: 'piece/piece.orbs' })
    expect(calls.filter((c) => c.name === 'evaluate').map((c) => c.args)).toEqual([
      [code, { documentPath: undefined }],
      ['x', { documentPath: 'piece/piece.orbs' }],
    ])
  })

  it.each([
    [{ ok: true, documentDirectory: '/ws/piece' }, false, 'ok (documentDirectory: /ws/piece)'],
    [{ ok: true, documentDirectory: null }, false, 'ok (documentDirectory: none)'],
    [
      { ok: false, error: 'evaluation failed: [runtime] x', documentDirectory: '/ws/piece' },
      true,
      'error: evaluation failed: [runtime] x (documentDirectory: /ws/piece)',
    ],
    [
      { ok: false, error: 'engine is not running — start the engine first' },
      true,
      'error: engine is not running — start the engine first',
    ],
  ] as const)(
    'evaluate_orbitscore names the base directory it used: %j',
    async (result, isError, text) => {
      const client = await start(createStubHandlers({ evaluate: () => result }).handlers)
      const response = await client.call('evaluate_orbitscore', { code: 'x' })
      expect(Boolean(response.isError)).toBe(isError)
      expect(response.content[0]?.text).toBe(text)
    },
  )

  it('save_plugin_state keeps the compatible sequence field and daemon code/details', async () => {
    const savePluginState = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, saved: { path: '/songs/states/sum-drum.state' } })
      .mockResolvedValueOnce({
        ok: false,
        error: 'mailbox timed out',
        code: 'PLUGIN_STATE_TIMEOUT',
        details: { elapsed: 5 },
      })
    const client = await start(createStubHandlers({ savePluginState }).handlers)
    const ok = await client.call('save_plugin_state', { sequence: 'sum:drum', index: 1 })
    expect(JSON.parse(ok.content[0]!.text)).toEqual({ path: '/songs/states/sum-drum.state' })
    const failed = await client.call('save_plugin_state', { sequence: 'master', index: 1 })
    expect(failed.isError).toBe(true)
    expect(failed.content[0]!.text).toContain('PLUGIN_STATE_TIMEOUT')
    expect(failed.content[0]!.text).toContain('"elapsed":5')
    expect(savePluginState.mock.calls).toEqual([
      ['sum:drum', 1],
      ['master', 1],
    ])
  })

  it('open/close plugin UI forward exact arguments once and map chain_path to the index', async () => {
    const openPluginUi = vi.fn().mockResolvedValue({ ok: true, result: { opened: true } })
    const closePluginUi = vi.fn().mockResolvedValue({ ok: true, result: { closed: true } })
    const client = await start(
      createStubHandlers({ ...FULL_OPTIONAL, openPluginUi, closePluginUi }).handlers,
    )
    await client.call('open_plugin_ui', { receiver: 'lead', index: 0, expectedName: 'Massive-X' })
    await client.call('open_plugin_ui', {
      receiver: 'master',
      chain_path: [1],
      expectedName: 'Echo',
    })
    await client.call('close_plugin_ui', { receiver: 'master', chain_path: [1] })
    expect(openPluginUi.mock.calls).toEqual([
      ['lead', 0, 'Massive-X'],
      ['master', 2, 'Echo'],
    ])
    expect(closePluginUi.mock.calls).toEqual([['master', 2]])
    const conflict = await client.call('close_plugin_ui', {
      receiver: 'master',
      chain_path: [1],
      index: 1,
    })
    expect(conflict.isError).toBe(true)
    expect(conflict.content[0]!.text).toContain(
      'index 1 conflicts with chain_path [1]; chain_path selects compatibility index 2',
    )
    expect(closePluginUi).toHaveBeenCalledTimes(1)
  })

  it('returns the cursor command failure through the standard MCP error envelope', async () => {
    const client = await start(
      createStubHandlers({
        ...FULL_OPTIONAL,
        openPluginUiAtCursor: () => ({ ok: false, error: 'The cursor is not on a plugin name.' }),
      }).handlers,
    )
    expect(await client.call('open_plugin_ui_at_cursor')).toEqual({
      content: [{ type: 'text', text: 'error: The cursor is not on a plugin name.' }],
      isError: true,
    })
  })

  it('list_plugins / rescan_plugins round-trip and surface a missing catalog as isError', async () => {
    const plugins: ListPluginsResult = {
      ok: true,
      plugins: [
        {
          name: 'Surge XT',
          vendor: 'Surge Synth Team',
          format: 'clap',
          path: '/clap/SurgeXT.clap',
          pluginId: 'surge-xt',
          roles: ['instrument'],
        },
      ],
    }
    const listPlugins = vi
      .fn()
      .mockReturnValueOnce(plugins)
      .mockReturnValueOnce({ ok: false, error: 'plugin catalog not found' })
    const { handlers } = createStubHandlers({ listPlugins })
    const client = await start(handlers)
    expect(JSON.parse((await client.call('list_plugins')).content[0]!.text)).toEqual(
      plugins.plugins,
    )
    const missing = await client.call('list_plugins')
    expect(missing.isError).toBe(true)
    expect(missing.content[0]!.text).toBe('error: plugin catalog not found')
    const rescanned = JSON.parse((await client.call('rescan_plugins')).content[0]!.text)
    expect(rescanned).toMatchObject({ count: 0, artifactCount: 0, skipped: [], failures: [] })
  })

  it('a { ok: false } result is isError with text starting with "error:"', async () => {
    const client = await start(
      createStubHandlers({ stopEngine: () => ({ ok: false, error: 'boom' }) }).handlers,
    )
    expect(await client.call('stop_engine')).toEqual({
      content: [{ type: 'text', text: 'error: boom' }],
      isError: true,
    })
  })

  it('get_engine_state includes daemon output and callback snapshots', async () => {
    const state = { running: true, liveCoding: true, output: { device: 'x' }, callback: { n: 1 } }
    const client = await start(createStubHandlers({ getEngineState: () => state }).handlers)
    expect(JSON.parse((await client.call('get_engine_state')).content[0]!.text)).toEqual(state)
  })

  it('register_mcp_server is listed only with the handler and round-trips scope / port', async () => {
    const registerMcpServer = vi.fn().mockResolvedValue({ ok: true, message: 'registered' })
    const client = await start(createStubHandlers({ registerMcpServer }).handlers)
    expect((await client.listTools()).map((tool) => tool.name).at(-1)).toBe('register_mcp_server')
    expect(await client.call('register_mcp_server', { scope: 'user', port: 1234 })).toEqual({
      content: [{ type: 'text', text: 'registered' }],
    })
    expect(registerMcpServer).toHaveBeenCalledWith({ scope: 'user', port: 1234 })
  })
})

describe('layer-2 differences from the frozen MCP layer (design 848 §6)', () => {
  /** 凍結版で同期だった 5 本を Promise で返す（中継は RPC で満たすので、同期では返せない）。 */
  it('the five formerly synchronous handlers answer the same when they return a Promise', async () => {
    const editor: EditorState = {
      path: '/ws/a.orbs',
      languageId: 'orbitscore',
      cursor: { line: 1, character: 1 },
      selection: null,
      lineCount: 3,
      isDirty: false,
    }
    const text: DocumentText = { path: '/ws/a.orbs', text: 'global.tempo(140)\n' }
    const diagnostics = [{ path: '/ws/a.orbs', diagnostics: [] }]
    const selected: CommandResult = { ok: true, message: 'selected' }
    const asyncClient = await start(
      createStubHandlers({
        setSelection: async () => selected,
        getEditorState: async () => editor,
        getDocumentText: async () => text,
        getDiagnostics: async () => diagnostics,
        getLog: async () => ['a', 'b'],
      }).handlers,
    )
    const answers = async (client: McpTestClient) => [
      await client.call('set_selection', { start_line: 2 }),
      await client.call('get_editor_state'),
      await client.call('get_document_text'),
      await client.call('get_diagnostics', { path: '/ws/a.orbs' }),
      await client.call('get_log', { lines: 2 }),
    ]
    const fromAsync = await answers(asyncClient)
    await asyncClient.close()
    const syncClient = await start(
      createStubHandlers({
        setSelection: () => selected,
        getEditorState: () => editor,
        getDocumentText: () => text,
        getDiagnostics: () => diagnostics,
        getLog: () => ['a', 'b'],
      }).handlers,
    )
    expect(fromAsync).toEqual(await answers(syncClient))
    expect(fromAsync.map((answer) => answer.content[0]!.text)).toEqual([
      'selected',
      JSON.stringify(editor),
      JSON.stringify(text),
      JSON.stringify(diagnostics),
      'a\nb',
    ])
  })

  it('a handler that throws answers in the errorResult envelope (layer 2 unreachable, no editor)', async () => {
    const client = await start(
      createStubHandlers({
        getEditorState: async () => {
          throw new Error('no editor is attached')
        },
        startEngine: async () => {
          throw new Error('OrbitStudio is not running')
        },
      }).handlers,
    )
    expect(await client.call('get_editor_state')).toEqual({
      content: [{ type: 'text', text: 'error: no editor is attached' }],
      isError: true,
    })
    expect(await client.call('start_engine')).toEqual({
      content: [{ type: 'text', text: 'error: OrbitStudio is not running' }],
      isError: true,
    })
  })

  it('docs tools read the DocsToolSource with the site and the frozen limit rule', async () => {
    const { docs, get, search } = stubDocs()
    const client = await start(createStubHandlers().handlers, docs)
    expect(await client.call('get_dev_doc', { path: 'guide/a.md' })).toEqual({
      content: [{ type: 'text', text: '# dev:guide/a.md' }],
    })
    await client.call('get_user_doc', { path: 'b.md' })
    await client.call('search_user_docs', { query: 'kick' })
    await client.call('search_dev_docs', { query: 'kick', limit: 2.9 })
    await client.call('search_dev_docs', { query: 'kick', limit: -1 })
    expect(get.mock.calls).toEqual([
      ['dev', 'guide/a.md'],
      ['user', 'b.md'],
    ])
    expect(search.mock.calls).toEqual([
      ['user', 'kick', 10],
      ['dev', 'kick', 2],
      ['dev', 'kick', 0],
    ])
  })

  it('a docs failure from layer 2 keeps its frozen wording in the error envelope', async () => {
    const { docs } = stubDocs({
      get: async () => {
        throw new Error('development document not found')
      },
    })
    const client = await start(createStubHandlers().handlers, docs)
    expect(await client.call('get_dev_doc', { path: 'nope.md' })).toEqual({
      content: [{ type: 'text', text: 'error: development document not found' }],
      isError: true,
    })
  })
})
