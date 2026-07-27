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
 *   npm run test:e2e:gated
 *
 * Do not pass the spec path as a positional CLI argument: it can glob-match
 * stale copies under .claude/worktrees/ and launch multiple real GUI apps.
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
// Real built CLAP bundles (rust-spike test fixtures, also used by the Rust-side
// outproc_*_gated tests) — used below so a real instrument declaration can
// actually succeed and stay registered, rather than a made-up path that fails
// to load and rolls back (see EffectChainMap.declareBody in effect-slot.ts).
const CLAP_TEST_SYNTH_PATH = path.join(
  REPO_ROOT,
  'rust-spike/clap-test-synth/target/release/CLAPTestSynth.clap',
)
const CLAP_TEST_EFFECT_PATH = path.join(
  REPO_ROOT,
  'rust-spike/clap-test-effect/target/release/CLAPTestEffect.clap',
)

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
  // #392: save_file persists to disk (unlike edit_replace, which only touched
  // the in-memory buffer). We open a scratch copy inside tmpRoot — not the
  // tracked repo fixture — so the write lands in the temp dir that afterAll
  // already removes, and never dirties a committed file.
  let kickLoopWorkPath: string | undefined

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
      // Scratch copy of the kick-loop fixture (basename preserved so the
      // languageId/path assertions below still hold): save_file writes here,
      // inside the tmpRoot that afterAll removes, instead of the tracked fixture.
      //
      // #528: the copy MUST reproduce the fixture's directory depth. The fixture
      // deliberately uses `audioPath("../../../test-assets/audio")` to prove that
      // `setDocumentDirectory` resolves relative paths against the edited file's
      // own directory — that relative form is the assertion, not an accident.
      // Copying it to a flat tmpRoot (the #392 behaviour) made `../../../` climb
      // out to `/var/folders/<x>/test-assets/audio`, so kick.wav was never found
      // (`[SAMPLE_NOT_FOUND]`) and the capture came back silent — the suite's most
      // valuable assertion was failing for a harness reason, unnoticed.
      //
      // Recreating `tests/fixtures/mcp-e2e/` under tmpRoot keeps the relative
      // resolution genuinely exercised (now rooted at tmpRoot instead of the repo).
      const fixtureRelDir = path.dirname(path.relative(REPO_ROOT, KICK_LOOP_FIXTURE))
      const workFixtureDir = path.join(tmpRoot, fixtureRelDir)
      fs.mkdirSync(workFixtureDir, { recursive: true })
      kickLoopWorkPath = path.join(workFixtureDir, path.basename(KICK_LOOP_FIXTURE))
      fs.copyFileSync(KICK_LOOP_FIXTURE, kickLoopWorkPath)
      // The audio the fixture's relative path must land on, mirrored at the same
      // depth from tmpRoot as it sits from REPO_ROOT.
      const workAudioDir = path.join(tmpRoot, 'test-assets/audio')
      fs.mkdirSync(workAudioDir, { recursive: true })
      fs.copyFileSync(
        path.join(REPO_ROOT, 'test-assets/audio/kick.wav'),
        path.join(workAudioDir, 'kick.wav'),
      )
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
      // 拡張は activate 時に engine を自動起動する。capture は spawn 時の
      // `ORBIT_CAPTURE_WAV` でしか有効化できない (#528) ので、自動起動した engine を
      // 一度落としてから capture 付きで起動し直す。自動起動の spawn 完了を待たずに
      // stop すると取りこぼすため、running を確認してから止める。
      const waitForEngine = (running: boolean, timeoutMs: number, label: string) =>
        waitUntil(
          async () => {
            const stateRes = await client!.call('get_engine_state')
            return (JSON.parse(stateRes.text) as { running: boolean }).running === running
          },
          { intervalMs: 500, timeoutMs, label },
        )

      await waitForEngine(true, 30_000, 'auto-started engine running')
      // #528 回帰ピン: capture は spawn 時にしか有効化できないので、既に走っている
      // engine に対する capture 付き start_engine は **失敗を返さなければならない**。
      // 旧実装はここで `ok: true, 'engine already running'` を返して captureWav を
      // 黙って捨てていた — 呼び出し側は録れていると信じ、capture.wav を読む段で
      // 初めて ENOENT に気づく（agent からは原因の分からない失敗になる）。
      const captureWhileRunning = await client.call('start_engine', {
        capture_wav: captureWavPath,
      })
      expect(captureWhileRunning.isError, captureWhileRunning.text).toBe(true)
      expect(captureWhileRunning.text).toContain('stop_engine')
      const stateAfterCaptureReject = await client.call('get_engine_state')
      expect(
        (JSON.parse(stateAfterCaptureReject.text) as { running: boolean }).running,
        stateAfterCaptureReject.text,
      ).toBe(true)

      const debugWhileRunning = await client.call('start_engine', { debug: true })
      expect(debugWhileRunning.isError, debugWhileRunning.text).toBe(true)
      expect(debugWhileRunning.text).toContain('stop_engine')

      const preStopRes = await client.call('stop_engine')
      expect(preStopRes.isError, preStopRes.text).toBe(false)
      await waitForEngine(false, 15_000, 'engine stopped')

      const startRes = await client.call('start_engine', { capture_wav: captureWavPath })
      expect(startRes.isError, startRes.text).toBe(false)

      try {
        await waitForEngine(true, 15_000, 'engine running')
      } catch (err) {
        // engine が上がらなかった理由は output channel にしか出ない（MCP の
        // get_engine_state は running の真偽しか返さない）。タイムアウトだけを
        // 報告すると毎回ここで手動再現する羽目になるので、失敗時にログを添える。
        let logText = '(unable to retrieve OrbitScore output channel)'
        try {
          logText = (await client.call('get_log', { lines: 120 })).text
        } catch (getLogErr) {
          // get_log 自身の失敗理由（例: ECONNREFUSED = 拡張ホストごと落ちた）は
          // 診断上重要なので握り潰さない。元の engine 起動タイムアウトは維持する。
          logText = `(unable to retrieve OrbitScore output channel: ${
            getLogErr instanceof Error ? getLogErr.message : String(getLogErr)
          })`
        }
        throw new Error(`${(err as Error).message}\n--- OrbitScore output channel ---\n${logText}`)
      }
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
      const openKickRes = await client.call('open_file', { path: kickLoopWorkPath })
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

      const kickLoopContent = fs.readFileSync(kickLoopWorkPath, 'utf8')
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

      // ── 6a. #392: get_document_text sees the buffer edit; save_file persists it ──
      const docTextRes = await client.call('get_document_text')
      const docTextAfterEdit = JSON.parse(docTextRes.text) as {
        path: string | null
        text: string | null
      }
      expect(docTextAfterEdit.text?.includes('global.tempo(180)')).toBe(true)
      expect(docTextAfterEdit.text?.includes('global.tempo(120)')).toBe(false)

      const saveRes = await client.call('save_file')
      expect(saveRes.isError, saveRes.text).toBe(false)

      const savedFixtureContent = fs.readFileSync(kickLoopWorkPath, 'utf8')
      expect(
        savedFixtureContent.includes('global.tempo(180)'),
        'save_file did not persist the edit_replace change to disk',
      ).toBe(true)

      // Save again with nothing pending: the document is now clean, so this
      // exercises the isDirty no-op branch — the guard's whole reason to exist.
      // It must read as "clean" (ok, no write), NOT as a save failure.
      const saveNoopRes = await client.call('save_file')
      expect(saveNoopRes.isError, saveNoopRes.text).toBe(false)
      expect(saveNoopRes.text).toContain('no changes to save')

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

      // ── 6b. #527 (S4 PR-1a): instrument duplicate declaration carries the S4
      // stage marker. The whole Global has exactly one v1 instrument slot
      // (PluginInstrumentManager — shared across sequences), so declaring a
      // second, different instrument must be rejected with a message that
      // names the follow-on stage (S4 PR-1b / #517 #522), not just a generic
      // "one instrument" message. Uses a dedicated fresh sequence (not `drum`,
      // which already has audio()/chop() — combining that with instrument()
      // hits a different, sequence-level guard first). `evaluate_orbitscore`'s
      // `ok` only means "accepted and written" (packages/vscode-extension/src/
      // extension.ts evaluateForAgent) — the actual accept/reject only shows
      // up in the engine's own stdout/stderr, surfaced here via get_log.
      const declareInstSeqRes = await client.call('evaluate_orbitscore', {
        code: 'var instSeq = init global.seq',
      })
      expect(declareInstSeqRes.isError, declareInstSeqRes.text).toBe(false)

      const firstInstrumentRes = await client.call('evaluate_orbitscore', {
        code: `instSeq.instrument("${CLAP_TEST_SYNTH_PATH}")`,
      })
      expect(firstInstrumentRes.isError, firstInstrumentRes.text).toBe(false)
      await sleep(6000) // real out-of-process CLAP attach: spawn + IPC handshake

      const afterFirstInstrumentLog = (await client.call('get_log', { lines: 500 })).text
      const firstInstrumentAttachFailed =
        afterFirstInstrumentLog.includes('[OUTPROC_ATTACH_FAILED]')

      if (firstInstrumentAttachFailed) {
        // The real CLAP bundle failed to attach in this environment (e.g. no
        // outproc instrument child binary / codesigning gate in the packaged
        // extension host) — the duplicate-declaration branch requires an
        // existing successful registration to collide with, so it is not
        // reachable here. Recorded rather than silently asserting a vacuous
        // pass; see the invoking report for the actual log line observed.
        // eslint-disable-next-line no-console
        console.log(
          '[orbitstudio-mcp-gated] first instrument() attach failed — duplicate-declaration ' +
            `branch not exercised. Log tail: ${afterFirstInstrumentLog.slice(-400)}`,
        )
      } else {
        const secondInstrumentRes = await client.call('evaluate_orbitscore', {
          code: `instSeq.instrument("${CLAP_TEST_EFFECT_PATH}")`,
        })
        expect(secondInstrumentRes.isError, secondInstrumentRes.text).toBe(false)
        await sleep(1000) // duplicate rejection is synchronous once the first slot is registered

        const afterSecondInstrumentLog = (await client.call('get_log', { lines: 500 })).text
        expect(
          afterSecondInstrumentLog,
          `expected the S4 stage-marker duplicate error, got log tail: ${afterSecondInstrumentLog.slice(-800)}`,
        ).toContain(
          'seq.instrument() supports one instrument instance in v1. ' +
            'S4 PR-1b (#517/#522) will allow independent instances per note sequence.',
        )
      }

      // ── 6c. #527: a failed plugin declaration surfaces loudly AND the engine
      // remains usable afterward (EffectChainMap rollback path). Uses a
      // deliberately nonexistent plugin path — no real plugin binary is needed
      // for this half, since resolvePluginSpec doesn't check fs existence for
      // path-direct specs (only the async out-of-process attach can fail).
      const beforeEffectFailLog = (await client.call('get_log', { lines: 500 })).text
      const attachFailedBefore = (beforeEffectFailLog.match(/\[OUTPROC_ATTACH_FAILED\]/g) ?? [])
        .length

      const badEffectRes = await client.call('evaluate_orbitscore', {
        code: 'global.effect("nonexistent-plugin.clap")',
      })
      expect(badEffectRes.isError, badEffectRes.text).toBe(false)
      await sleep(6000) // real out-of-process attach attempt, then failure

      const afterEffectFailLog = (await client.call('get_log', { lines: 500 })).text
      expect(
        afterEffectFailLog,
        `expected an OUTPROC_ATTACH_FAILED error, got log tail: ${afterEffectFailLog.slice(-800)}`,
      ).toContain('[OUTPROC_ATTACH_FAILED] child exited before publishing READY')

      // Engine survives: a normal statement right after the failure must still
      // be accepted, and must not add a NEW attach failure of its own.
      const recoveryRes = await client.call('evaluate_orbitscore', {
        code: 'global.beat(4 by 4)',
      })
      expect(recoveryRes.isError, recoveryRes.text).toBe(false)
      await sleep(1000)

      const engineStateAfterFailure = await client.call('get_engine_state')
      expect(JSON.parse(engineStateAfterFailure.text).running).toBe(true)

      const afterRecoveryLog = (await client.call('get_log', { lines: 500 })).text
      const attachFailedAfterRecovery = (afterRecoveryLog.match(/\[OUTPROC_ATTACH_FAILED\]/g) ?? [])
        .length
      // Exactly one NEW attach failure (the deliberate one above) — the
      // recovery statement must not add another.
      expect(attachFailedAfterRecovery).toBe(attachFailedBefore + 1)

      // ── 6d. #521/#517 S3 regression guard: the mixer/routing DSL (bus-name
      // chain methods — mix.output/sum/aux, `.verb(0.3)` send, `.drums` sum
      // routing, `.master`) still evaluates cleanly through the real app after
      // the four-manager migration (#527). No ERROR: line (packages/vscode-
      // extension/src/extension.ts stderr handler) must appear for this batch.
      const beforeMixerLog = (await client.call('get_log', { lines: 500 })).text
      const errorCountBeforeMixer = (beforeMixerLog.match(/ERROR:/g) ?? []).length

      const mixerRes = await client.call('evaluate_orbitscore', {
        code: [
          'var mix = init global.mixer',
          'var master = mix.output(1, 2)',
          'var drums = mix.sum',
          'var verb = mix.aux',
          'verb.master',
          'drum.verb(0.3).drums',
          'drums.master',
        ].join('\n'),
      })
      expect(mixerRes.isError, mixerRes.text).toBe(false)
      await sleep(1500)

      const afterMixerLog = (await client.call('get_log', { lines: 500 })).text
      const errorCountAfterMixer = (afterMixerLog.match(/ERROR:/g) ?? []).length
      expect(
        errorCountAfterMixer,
        `expected no new ERROR: lines from the mixer/routing DSL, got log tail: ${afterMixerLog.slice(-800)}`,
      ).toBe(errorCountBeforeMixer)

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
