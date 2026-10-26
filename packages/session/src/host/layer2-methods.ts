/**
 * 層 2 の audio・plugin・docs のメソッド（設計 848 §5.3.2・§5.3.3・§5.3.5）。
 *
 * 振る舞いは凍結版の MCP ハンドラ（`packages/vscode-extension/src/agent-handlers.ts` /
 * `plugin-commands.ts`）と同じにする — MCP ツールはこれらの薄い写しで（D-4）、v1 の間は戻りの形と
 * 文言が関門に入る（§6.1・台帳 P-03）。凍結版が子プロセスへメタ行で頼んでいたもの（`//#savePluginState`
 * / `//#pluginUi` / `//#selectAudioDevice`）は、層 2 が in-process の `InterpreterV2` を直接呼ぶ。
 */
import fs from 'node:fs'

import { analyzeWavBuffer } from '../services/wav-analysis'
import { resolveDeviceClickAction, translateSelectAudioDeviceError } from '../services/engine-view'
import { loadPluginCatalog, runPluginScan } from '../plugin-catalog-reader'
import { DEV_DOCS_UNAVAILABLE_MESSAGE, readDevDoc, searchDevDocs } from '../mcp/mcp-docs'
import { RpcError } from '../rpc/protocol'
import type { RequestHandler } from '../rpc/server'

import type { CommandResult, EngineHost, StartEngineParams } from './engine-host'
import type { DocsSites } from './docs-sites'

const ENGINE_NOT_RUNNING = 'engine is not running — start the engine first'

function errorDetails(error: any): { error: string; code?: string; details?: unknown } {
  return {
    error: error?.message ?? String(error),
    ...(typeof error?.code === 'string' ? { code: error.code } : {}),
    ...(error?.details === undefined ? {} : { details: error.details }),
  }
}

export interface Layer2MethodDeps {
  engine: EngineHost
  /** `engine.start` / `engine.stop` と同じ経路（`engine.state` の通知を送る・`SessionCore`）。 */
  startEngine(params: StartEngineParams): Promise<CommandResult>
  stopEngine(): Promise<CommandResult>
  /** transport が動いているか（plugin state は止めてから保存する・凍結版と同じ）。 */
  transportPlaying(): boolean
  docs: DocsSites
  /** 層 2 の行（`SessionCore.sessionLog`）。 */
  log(level: 'error' | 'warn' | 'info', text: string): void
}

export function audioMethods(deps: Layer2MethodDeps): Record<string, RequestHandler> {
  return {
    // 凍結版と同じ: Rust の engine にはデバイスを列挙する口が無い（doc 662 §6 / #660）。
    'audio.listDevices': () => ({
      ok: false,
      error:
        'audio device selection is not supported with the Rust engine; the system default output device is used',
    }),
    'audio.analyze': (params: { wavPath: string; windowMs?: number; perChannel?: boolean }) => {
      try {
        const analysis = analyzeWavBuffer(fs.readFileSync(params.wavPath), {
          ...(params.windowMs !== undefined ? { windowMs: params.windowMs } : {}),
          ...(params.perChannel ? { perChannel: true } : {}),
        })
        return { ok: true, analysis }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    /**
     * 凍結版の Engine ビューのクリックと同じ 3 つの動作（`resolveDeviceClickAction`）。凍結版は選択を
     * 設定 `orbitscore.audioDevice` に書いて次の起動に持ち越したが、層 2 は設定を持たない（設定は
     * アプリの環境設定・§7.1）。ここでの「選択中」は engine を起こした・切り替えたデバイスで、層 2 の
     * メモリにだけある。
     */
    // PROVISIONAL(P-20): 選択の永続化の持ち主が未決（アプリへ知らせるか・層 2 が持つか）。
    'audio.selectDevice': async (params: { device: string }) => {
      const { engine } = deps
      const action = resolveDeviceClickAction(params.device, engine.audioDevice, engine.running)
      if (action === 'deselect-stop') {
        engine.audioDevice = ''
        if (engine.running) {
          const stopped = await deps.stopEngine()
          if (!stopped.ok) return stopped
        }
        return { ok: true, message: 'audio device deselected and engine stopped' }
      }
      if (action === 'start') {
        const started = await deps.startEngine({ audioDevice: params.device })
        if (!started.ok) return started
        return { ok: true, message: `audio device selected: ${params.device}; engine started` }
      }
      const interpreter = engine.current()
      const audioEngine = interpreter?.audioEngine
      if (!audioEngine?.selectAudioDevice) {
        return {
          ok: false,
          error: 'selectAudioDevice is not supported by the current audio engine backend',
        }
      }
      try {
        const device = await audioEngine.selectAudioDevice(params.device)
        engine.audioDevice = device
        return { ok: true, message: `audio device switched to: ${device}` }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // 凍結版 `executeSelectAudioDeviceMeta`（`repl-mode.ts`）が engine の console に書いていた行。
        deps.log('error', `❌ live device switch to "${params.device}" failed: ${message}`)
        return { ok: false, error: translateSelectAudioDeviceError(message) }
      }
    },
  }
}

export function pluginMethods(deps: Layer2MethodDeps): Record<string, RequestHandler> {
  const running = () => deps.engine.current()
  return {
    'plugin.saveState': async (params: { receiver: string; index: number }) => {
      const interpreter = running()
      if (!interpreter) return { ok: false, error: ENGINE_NOT_RUNNING }
      if (deps.transportPlaying()) {
        return {
          ok: false,
          error: 'plugin state cannot be saved while the transport is running; stop first',
        }
      }
      try {
        return { ok: true, saved: await interpreter.savePluginState(params.receiver, params.index) }
      } catch (error) {
        return { ok: false, ...errorDetails(error) }
      }
    },
    'plugin.openUi': async (params: { receiver: string; index: number; expectedName?: string }) => {
      const interpreter = running()
      if (!interpreter) return { ok: false, error: ENGINE_NOT_RUNNING }
      try {
        return {
          ok: true,
          result: await interpreter.openPluginUi(
            params.receiver,
            params.index,
            params.expectedName,
          ),
        }
      } catch (error) {
        return { ok: false, ...errorDetails(error) }
      }
    },
    'plugin.closeUi': async (params: { receiver: string; index: number }) => {
      const interpreter = running()
      if (!interpreter) return { ok: false, error: ENGINE_NOT_RUNNING }
      try {
        return { ok: true, result: await interpreter.closePluginUi(params.receiver, params.index) }
      } catch (error) {
        return { ok: false, ...errorDetails(error) }
      }
    },
    'plugin.list': () => {
      const catalog = loadPluginCatalog()
      if (!catalog) {
        return {
          ok: false,
          error: 'plugin catalog not found — run "OrbitScore: Rescan Plugin Catalog" first',
        }
      }
      return {
        ok: true,
        plugins: catalog.plugins.map((entry) => ({ ...entry, roles: [...entry.roles] })),
      }
    },
    'plugin.rescan': async () => {
      const result = await runPluginScan()
      if (!result.ok) return { ok: false, error: result.error }
      return {
        ok: true,
        count: result.count,
        artifactCount: result.artifactCount,
        skipped: [...result.skipped],
        failures: result.failures.map((failure) => ({
          ...failure,
          ...(failure.slices ? { slices: [...failure.slices] } : {}),
        })),
        summary: result.summary,
      }
    },
  }
}

export function docsMethods(deps: Layer2MethodDeps): Record<string, RequestHandler> {
  const siteOf = (site: 'user' | 'dev') => {
    const location = deps.docs[site]
    if (location) return location
    // dev は `.app` に同梱しない（owner 決定 2026-09-18）。凍結版と同じ案内（「見つからない」と区別する）。
    if (site === 'dev') throw new RpcError('DOCS_UNAVAILABLE', DEV_DOCS_UNAVAILABLE_MESSAGE)
    // user は同梱されるので、無いのは壊れたインストールだけ（凍結版も unavailable の分岐を持たない）。
    return null
  }
  return {
    'docs.get': (params: { site: 'user' | 'dev'; path: string }) => {
      const location = siteOf(params.site)
      const text = location ? readDevDoc(location.sourceRoot, params.path) : null
      if (text === null) {
        throw new RpcError(
          'DOC_NOT_FOUND',
          params.site === 'dev' ? 'development document not found' : 'user document not found',
        )
      }
      return { text }
    },
    'docs.search': (params: { site: 'user' | 'dev'; query: string; limit?: number }) => {
      const location = siteOf(params.site)
      // 凍結版 `parseSearchLimit`（`mcp-tools-editor.ts`）: 既定 10・小数は切り捨て・負は 0。
      const requested = typeof params.limit === 'number' ? params.limit : 10
      const limit = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 10
      return { matches: location ? searchDevDocs(location.sourceRoot, params.query, limit) : [] }
    },
  }
}
