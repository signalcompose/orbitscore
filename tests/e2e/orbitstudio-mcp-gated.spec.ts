/**
 * REAL OrbitStudio E2E over the Agent Bridge MCP server (#388).
 *
 * Launches an actual OrbitStudio.app (VSCodium-based) Extension Development
 * Host, drives it entirely through MCP tool calls (no vscode API, no
 * keyboard/UI automation), and verifies produced audio objectively via the
 * capture-seam WAV analyzer (wav-analysis.ts) — the same "verify without
 * listening" philosophy as WORK_LOG 6.189.
 *
 * ── Env contract ──
 *   ORBIT_GATED_ORBITSTUDIO=1   Required to enable this suite at all. Unset
 *                               (the default) → the whole describe block is
 *                               skipped via describe.skipIf, so this file
 *                               always parses and collects cleanly in normal
 *                               `npm test` runs.
 *   ORBITSTUDIO_APP=<path>      Overrides the OrbitStudio.app bundle path.
 *                               Default:
 *                               /Users/yamato/Src/proj_orbitscore/orbitstudio-build/vscodium/VSCode-darwin-arm64/OrbitStudio.app
 *                               If the resolved path doesn't exist, the test
 *                               is skipped with a console note (rather than
 *                               failing) even when the gate env var is set.
 *
 * Run gated (this launches a real GUI app and plays audible sound — do NOT
 * run unattended/unprompted):
 *
 *   ORBIT_GATED_ORBITSTUDIO=1 npx vitest run --dir ../../tests --globals \
 *     --pool=forks --poolOptions.forks.singleFork=true orbitstudio-mcp-gated
 *   (run from packages/engine, per the project's targeted-vitest convention)
 *
 * SAFETY (repeated at the kill call site too): the teardown/setup kill
 * pattern targets `OrbitStudio.app/Contents/MacOS` — a path fragment unique
 * to the OrbitStudio.app bundle. It must NEVER be broadened to something
 * that could match a general "Visual Studio Code" / Electron process —
 * killing the user's actual VS Code is a known past incident.
 */

import { spawn, execFileSync, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { describe, it, expect, afterAll } from 'vitest'

import { analyzeWavBuffer } from '../../packages/vscode-extension/src/wav-analysis'

import { McpClient, pollInitialize, sleep, waitUntil } from './helpers/mcp-client'

const GATE_ENV = 'ORBIT_GATED_ORBITSTUDIO'
const DEFAULT_APP_PATH =
  '/Users/yamato/Src/proj_orbitscore/orbitstudio-build/vscodium/VSCode-darwin-arm64/OrbitStudio.app'

const gated = Boolean(process.env[GATE_ENV])
const appPath = process.env.ORBITSTUDIO_APP?.trim() || DEFAULT_APP_PATH
const appAvailable = fs.existsSync(appPath)

if (gated && !appAvailable) {
  // eslint-disable-next-line no-console
  console.log(
    `[orbitstudio-mcp-gated] OrbitStudio app not found at ${appPath} — SKIPPING. ` +
      'Set ORBITSTUDIO_APP to override the default path.',
  )
}

const REPO_ROOT = path.resolve(__dirname, '../..')
const EXTENSION_DEV_PATH = path.join(REPO_ROOT, 'packages/vscode-extension')
const KICK_LOOP_FIXTURE = path.join(REPO_ROOT, 'tests/fixtures/mcp-e2e/kick_loop.orbs')
const DIAGNOSTIC_FIXTURE = path.join(REPO_ROOT, 'tests/fixtures/mcp-e2e/diagnostic_case.orbs')

const TEST_TIMEOUT_MS = 120_000
const TEARDOWN_TIMEOUT_MS = 30_000

/**
 * SAFETY: this exact pattern ONLY. `OrbitStudio.app/Contents/MacOS` is a path
 * fragment unique to the OrbitStudio.app bundle — it must never be widened
 * to match "Code" / "Electron" / VSCodium generally. Killing the user's
 * actual VS Code by an overbroad pkill pattern is a known past incident.
 * Uses execFileSync (no shell, fixed argv — not a template-built command
 * string) rather than exec/execSync.
 */
function killOrbitStudio(): void {
  try {
    execFileSync('pkill', ['-f', 'OrbitStudio.app/Contents/MacOS'], { stdio: 'ignore' })
  } catch {
    // pkill exits non-zero when no process matched — not an error here.
  }
}

describe.skipIf(!gated)('OrbitStudio Agent Bridge MCP E2E (gated, real app)', () => {
  let child: ChildProcess | undefined
  let client: McpClient | undefined
  let tmpRoot: string | undefined

  afterAll(async () => {
    // Teardown: best-effort, always runs, never throws past this hook.
    if (client) {
      try {
        await client.call('stop_engine')
      } catch {
        // best-effort — the process may already be gone.
      }
    }
    killOrbitStudio()
    if (child && !child.killed) {
      try {
        child.kill()
      } catch {
        // best-effort
      }
    }
    if (tmpRoot) {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true })
      } catch {
        // best-effort
      }
    }
  }, TEARDOWN_TIMEOUT_MS)

  it.skipIf(!appAvailable)(
    'drives real OrbitStudio end-to-end: diagnostics-on-open, run_selection, live edit, capture verification',
    async () => {
      // ── 1. Setup: clear stray instances, fresh isolated dirs, pick a port ──
      killOrbitStudio()
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orbitstudio-mcp-e2e-'))
      const userDataDir = path.join(tmpRoot, 'user-data')
      const extensionsDir = path.join(tmpRoot, 'extensions')
      fs.mkdirSync(userDataDir, { recursive: true })
      fs.mkdirSync(extensionsDir, { recursive: true })
      const captureWavPath = path.join(tmpRoot, 'capture.wav')
      const port = 39400 + Math.floor(Math.random() * 200)

      // ── 2. Launch: `orbs` CLI with the extension in dev mode ──
      const orbsBin = path.join(appPath, 'Contents/Resources/app/bin/orbs')
      child = spawn(
        orbsBin,
        [
          '--new-window',
          `--extensionDevelopmentPath=${EXTENSION_DEV_PATH}`,
          `--user-data-dir=${userDataDir}`,
          `--extensions-dir=${extensionsDir}`,
          REPO_ROOT,
        ],
        {
          env: { ...process.env, ORBITSCORE_MCP_PORT: String(port) },
          stdio: 'ignore',
          detached: false,
        },
      )

      client = await pollInitialize(port, { intervalMs: 2000, timeoutMs: 60_000 })

      // ── 3. start_engine with capture_wav, wait for it to come up ──
      const startRes = await client.call('start_engine', { capture_wav: captureWavPath })
      expect(startRes.isError, startRes.text).toBe(false)

      await waitUntil(
        async () => {
          const stateRes = await client!.call('get_engine_state')
          const state = JSON.parse(stateRes.text) as { running: boolean }
          return state.running === true
        },
        { intervalMs: 500, timeoutMs: 15_000, label: 'engine running' },
      )
      await sleep(2500) // audio init settle

      // ── 4. #384 behavioral check: diagnostics fire on open, no edit needed ──
      const openDiagRes = await client.call('open_file', { path: DIAGNOSTIC_FIXTURE })
      expect(openDiagRes.isError, openDiagRes.text).toBe(false)
      await sleep(1500)

      const diagRes = await client.call('get_diagnostics', { path: DIAGNOSTIC_FIXTURE })
      const diagList = JSON.parse(diagRes.text) as Array<{
        path: string
        diagnostics: unknown[]
      }>
      // Scoped by `path`, so getDiagnosticsForAgent() returns a single-element
      // array echoing the input path. Sum diagnostics across the returned list
      // rather than re-matching `.path` exactly — robust to any path
      // normalization difference between what we sent and what comes back.
      const totalDiagnostics = diagList.reduce((sum, d) => sum + d.diagnostics.length, 0)
      expect(
        totalDiagnostics,
        `expected >=1 diagnostic for ${DIAGNOSTIC_FIXTURE}, got: ${diagRes.text}`,
      ).toBeGreaterThanOrEqual(1)

      // ── 5. Open kick_loop.orbs, sanity-check editor state, run the whole file ──
      const openKickRes = await client.call('open_file', { path: KICK_LOOP_FIXTURE })
      expect(openKickRes.isError, openKickRes.text).toBe(false)
      await sleep(500)

      const editorStateRes = await client.call('get_editor_state')
      const editorState = JSON.parse(editorStateRes.text) as {
        path: string | null
        languageId: string | null
        lineCount: number | null
      }
      expect(editorState.languageId).toBe('orbitscore')
      // Both fixtures have languageId 'orbitscore' — also confirm kick_loop.orbs
      // (not diagnostic_case.orbs, opened just before it) is the active document.
      expect(editorState.path?.endsWith('kick_loop.orbs')).toBe(true)

      const kickLoopContent = fs.readFileSync(KICK_LOOP_FIXTURE, 'utf8')
      const kickLoopLines = kickLoopContent.split('\n')
      const totalLines = kickLoopLines.length

      const selectAllRes = await client.call('set_selection', {
        start_line: 1,
        start_char: 1,
        end_line: totalLines,
        end_char: 999_999, // clamped by editor.document.validatePosition — see extension.ts setSelectionForAgent
      })
      expect(selectAllRes.isError, selectAllRes.text).toBe(false)

      const runAllRes = await client.call('run_selection')
      expect(runAllRes.isError, runAllRes.text).toBe(false)
      await sleep(4000) // sound plays at 120bpm

      // ── 6. Live edit: tempo 120 -> 180, re-run just that line ──
      const editRes = await client.call('edit_replace', {
        find: 'global.tempo(120)',
        replace: 'global.tempo(180)',
      })
      expect(editRes.isError, editRes.text).toBe(false)

      const tempoLineIndex = kickLoopLines.findIndex((line) => line.includes('global.tempo(120)'))
      expect(tempoLineIndex, 'global.tempo(120) line not found in kick_loop.orbs fixture').not.toBe(
        -1,
      )
      const tempoLine1Based = tempoLineIndex + 1

      const selectTempoRes = await client.call('set_selection', {
        start_line: tempoLine1Based,
        start_char: 1,
        end_line: tempoLine1Based,
        end_char: 999_999,
      })
      expect(selectTempoRes.isError, selectTempoRes.text).toBe(false)

      const runTempoRes = await client.call('run_selection')
      expect(runTempoRes.isError, runTempoRes.text).toBe(false)
      await sleep(4000) // sound plays at 180bpm

      // ── 7. get_log sanity check — non-empty, evidence of engine activity ──
      const logRes = await client.call('get_log', { lines: 100 })
      expect(logRes.text.length).toBeGreaterThan(0)

      // ── 8. stop_engine, wait for capture to finalize ──
      const stopRes = await client.call('stop_engine')
      expect(stopRes.isError, stopRes.text).toBe(false)
      await sleep(1500)

      // ── 9. Objective audio verification (no listening required) ──
      const wavBuf = fs.readFileSync(captureWavPath)
      const analysis = analyzeWavBuffer(wavBuf)
      expect(analysis.soundDetected, JSON.stringify(analysis)).toBe(true)

      const gapsAt120bpm = analysis.onsetGaps.filter((g) => g >= 0.45 && g <= 0.57)
      const gapsAt180bpm = analysis.onsetGaps.filter((g) => g >= 0.29 && g <= 0.4)
      expect(
        gapsAt120bpm.length,
        `expected >=3 gaps in [0.45,0.57]s (120bpm), got onsetGaps: ${JSON.stringify(analysis.onsetGaps)}`,
      ).toBeGreaterThanOrEqual(3)
      expect(
        gapsAt180bpm.length,
        `expected >=3 gaps in [0.29,0.40]s (180bpm), got onsetGaps: ${JSON.stringify(analysis.onsetGaps)}`,
      ).toBeGreaterThanOrEqual(3)
    },
    TEST_TIMEOUT_MS,
  )
})
