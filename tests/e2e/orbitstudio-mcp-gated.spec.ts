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
 * `npm run test:e2e:gated` itself passes a positional pattern
 * (`e2e/orbitstudio-mcp-gated`), but scoped under `--dir tests` — resolved
 * relative to that root, it can only match this one file. The dangerous case
 * is a MANUAL `npx vitest run <pattern>` WITHOUT `--dir tests`: from the repo
 * root, an unscoped positional pattern can glob-match stale copies under
 * .claude/worktrees/ and launch multiple real GUI apps.
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
import { parse, stringify } from 'yaml'

import {
  analyzeWavBuffer,
  estimateFundamentalHz,
} from '../../packages/vscode-extension/src/wav-analysis'

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
/// 🔴 CLAP oracle も VST3 と同じく**その場でビルドする**。
///
/// 以前はパス定数を指すだけで、`fs.existsSync` で存在を確認していた。しかし
/// **存在は鮮度を意味しない** — 実際に 2026-07-29、`target/release/` に残っていた
/// 1ヶ月前（#557 で `PluginStateImpl` を足す前）のバンドルを掴み、
/// `plugin が CLAP_EXT_STATE を持たない` で state 保存が落ちた。テストは
/// **1ヶ月前の成果物を検証していた**。
///
/// VST3 側は最初から `package-oracle.sh` をその場で叩いており、CLAP 側だけが
/// 非対称だった。同じ形に揃える。`bundle-macos.sh` は `cd` を持たず cwd 依存なので
/// `cwd` を明示すること。
const CLAP_TEST_SYNTH_BUNDLE_SCRIPT = path.join(
  REPO_ROOT,
  'rust-spike/clap-test-synth/bundle-macos.sh',
)
const CLAP_TEST_EFFECT_BUNDLE_SCRIPT = path.join(
  REPO_ROOT,
  'rust-spike/clap-test-effect/bundle-macos.sh',
)
const VST3_SYNTH_PACKAGE_SCRIPT = path.join(
  REPO_ROOT,
  'rust/crates/orbit-vst3-synth-oracle/package-oracle.sh',
)
const VST3_EFFECT_PACKAGE_SCRIPT = path.join(
  REPO_ROOT,
  'rust/crates/orbit-vst3-gain-oracle/package-oracle.sh',
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
  let catalogSynthPath: string | undefined
  let brokenCatalogPath: string | undefined

  const waitForEngine = (running: boolean, timeoutMs: number, label: string) =>
    waitUntil(
      async () => {
        const stateRes = await client!.call('get_engine_state')
        return (JSON.parse(stateRes.text) as { running: boolean }).running === running
      },
      { intervalMs: 500, timeoutMs, label },
    )

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
      // tmpRoot を workspace にしたため、リポジトリの .vscode/settings.json は効かない。
      // autoStartConfiguredRustEngine は保存済み audioDevice が無いと即 return するので、
      // デバイス名の存在確認をスキップするセンチネル __default__ を設定し、
      // マシン固有のデバイス名に依存せず拡張の auto-start を有効化する。
      const workspaceSettingsDir = path.join(tmpRoot, '.vscode')
      fs.mkdirSync(workspaceSettingsDir, { recursive: true })
      fs.writeFileSync(
        path.join(workspaceSettingsDir, 'settings.json'),
        JSON.stringify(
          {
            'orbitscore.audioDevice': '__default__',
            'orbitscore.engineDebug': false,
          },
          null,
          2,
        ) + '\n',
      )
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
      // 実プラグインを attach する前に CLAP oracle を release でビルドし直す
      // （定数の doc を参照 — 古いバンドルを検証してしまう事故が実際に起きた）。
      for (const script of [CLAP_TEST_SYNTH_BUNDLE_SCRIPT, CLAP_TEST_EFFECT_BUNDLE_SCRIPT]) {
        execFileSync('/bin/bash', [script, '--release'], {
          cwd: path.dirname(script),
          encoding: 'utf8',
        })
      }
      const catalogFixtureDir = path.join(tmpRoot, 'plugin-catalog-fixtures')
      fs.mkdirSync(catalogFixtureDir, { recursive: true })
      catalogSynthPath = path.join(catalogFixtureDir, 'CLAPTestSynth.clap')
      fs.symlinkSync(CLAP_TEST_SYNTH_PATH, catalogSynthPath)
      brokenCatalogPath = path.join(catalogFixtureDir, 'BrokenCatalogFixture.clap')
      fs.writeFileSync(brokenCatalogPath, 'not a loadable CLAP bundle')

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
          // `evaluate_orbitscore` は workspace root を documentDirectory として渡すので、
          // プロジェクト（project.yaml / states/）を置く tmpRoot を workspace として開く。
          // これはユーザーが曲フォルダを開く実際の使い方とも一致する。
          tmpRoot,
        ],
        {
          env: {
            ...process.env,
            ORBITSCORE_MCP_PORT: String(port),
            ORBIT_PLUGIN_PATH: catalogFixtureDir,
          },
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
      // #527 review round 3 Minor #1: a `running === true` re-check here was
      // removed — capture and debug rejects both fall through
      // decideStartEngineForAgent's SAME single `spawnOnlyOptions.length > 0`
      // branch (engine-lifecycle.ts), which returns before touching engine
      // state either way. The `stateAfterCaptureReject` check above already
      // exercises that exact early-return path end-to-end; repeating it here
      // adds no additional detection power (a mutant that made either reject
      // branch tear the engine down would already be caught above). What
      // DOES still add value for the debug case — and is kept — is the
      // `.toContain('stop_engine')` message-content check just above, which
      // proves the rejection message mentions "debug" rather than being
      // hardcoded to the capture wording (see the unit-level equivalent in
      // engine-lifecycle.spec.ts's `decideStartEngineForAgent` describe).

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
      expect(
        firstInstrumentAttachFailed,
        `the #562 real MCP state path requires a live CLAP instrument. Log tail: ${afterFirstInstrumentLog.slice(-800)}`,
      ).toBe(false)

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
        // ── #562: the same MCP state-save tool reaches all four hosted forms.
        // Package the repository-owned VST3 oracles into ignored rust/target
        // fixtures, then attach one CLAP and one VST3 effect to audio receivers
        // (v1 deliberately rejects seq.effect() on instrument sequences). This
        // stays below the one-instrument/one-effect-per-receiver limits while
        // exercising both daemon role selectors.
        expect(fs.existsSync(CLAP_TEST_EFFECT_PATH), CLAP_TEST_EFFECT_PATH).toBe(true)
        const vst3SynthPath = execFileSync(
          '/bin/bash',
          [VST3_SYNTH_PACKAGE_SCRIPT, 'release', 'mcp-e2e'],
          { encoding: 'utf8' },
        ).trim()
        const vst3EffectPath = execFileSync('/bin/bash', [VST3_EFFECT_PACKAGE_SCRIPT, 'release'], {
          encoding: 'utf8',
        }).trim()

        const declareVst3SeqRes = await client.call('evaluate_orbitscore', {
          code: 'var vst3StateSeq = init global.seq',
        })
        expect(declareVst3SeqRes.isError, declareVst3SeqRes.text).toBe(false)
        const attachVst3InstrumentRes = await client.call('evaluate_orbitscore', {
          code: `vst3StateSeq.instrument("${vst3SynthPath}")`,
        })
        expect(attachVst3InstrumentRes.isError, attachVst3InstrumentRes.text).toBe(false)
        const attachClapEffectRes = await client.call('evaluate_orbitscore', {
          code: `drum.effect("${CLAP_TEST_EFFECT_PATH}")`,
        })
        expect(attachClapEffectRes.isError, attachClapEffectRes.text).toBe(false)
        const declareVst3EffectSeqRes = await client.call('evaluate_orbitscore', {
          code: 'var vst3EffectSeq = init global.seq',
        })
        expect(declareVst3EffectSeqRes.isError, declareVst3EffectSeqRes.text).toBe(false)
        const attachVst3EffectRes = await client.call('evaluate_orbitscore', {
          code: `vst3EffectSeq.effect("${vst3EffectPath}")`,
        })
        expect(attachVst3EffectRes.isError, attachVst3EffectRes.text).toBe(false)
        await sleep(12_000) // three real child spawns + READY handshakes

        const afterFourFormAttachLog = (await client.call('get_log', { lines: 500 })).text
        expect(
          (afterFourFormAttachLog.match(/\[OUTPROC_ATTACH_FAILED\]/g) ?? []).length,
          `all four #562 plugin forms must be live. Log tail: ${afterFourFormAttachLog.slice(-1200)}`,
        ).toBe(0)

        // Playing requests are rejected at the MCP boundary and must not stop
        // transport as a side effect. Count the engine's own stop marker before
        // and after the rejected request rather than inferring from process state.
        const stoppedBeforeRejectedSave = (
          afterFourFormAttachLog.match(/(?:✅ Global stopped|⏹ Global)/g) ?? []
        ).length
        const rejectedWhilePlaying = await client.call('save_plugin_state', {
          sequence: 'instSeq',
          index: 0,
        })
        expect(rejectedWhilePlaying.isError, rejectedWhilePlaying.text).toBe(true)
        expect(rejectedWhilePlaying.text).toContain('transport is running')
        await sleep(500)
        const afterRejectedSaveLog = (await client.call('get_log', { lines: 500 })).text
        expect(
          (afterRejectedSaveLog.match(/(?:✅ Global stopped|⏹ Global)/g) ?? []).length,
          `save rejection must not auto-stop transport. Log tail: ${afterRejectedSaveLog.slice(-800)}`,
        ).toBe(stoppedBeforeRejectedSave)

        // evaluate_orbitscore normally refreshes the workspace directory. Set
        // the scratch project directory last in this same evaluation so
        // project.yaml and states/ can only be written under tmpRoot.
        const escapedProjectDirectory = tmpRoot.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        const stopForSaveRes = await client.call('evaluate_orbitscore', {
          code: `global.stop()\nglobal.setDocumentDirectory("${escapedProjectDirectory}")`,
        })
        expect(stopForSaveRes.isError, stopForSaveRes.text).toBe(false)
        await waitUntil(
          async () => {
            const log = (await client!.call('get_log', { lines: 500 })).text
            return (
              (log.match(/(?:✅ Global stopped|⏹ Global)/g) ?? []).length >
              stoppedBeforeRejectedSave
            )
          },
          { intervalMs: 200, timeoutMs: 5_000, label: 'transport stopped before state save' },
        )

        const errorsBeforeStateSave = (
          (await client.call('get_log', { lines: 500 })).text.match(/ERROR:/g) ?? []
        ).length
        const stateRequests = [
          { sequence: 'instSeq', index: 0, identity: 'instSeq/instrument/CLAPTestSynth/0' },
          { sequence: 'drum', index: 1, identity: 'drum/effect/CLAPTestEffect/0' },
          {
            sequence: 'vst3StateSeq',
            index: 0,
            identity: 'vst3StateSeq/instrument/SynthOracle/0',
          },
          {
            sequence: 'vst3EffectSeq',
            index: 1,
            identity: 'vst3EffectSeq/effect/GainOracle/0',
          },
        ] as const
        for (const request of stateRequests) {
          const response = await client.call('save_plugin_state', request)
          expect(response.isError, response.text).toBe(false)
          const saved = JSON.parse(response.text) as {
            path: string
            bytesWritten: number
            identityKey: string
            projectFile: string
            projectStatePath: string
          }
          expect(saved.bytesWritten).toBeGreaterThan(0)
          expect(saved.identityKey).toBe(request.identity)
          expect(saved.projectFile).toBe(path.join(tmpRoot, 'project.yaml'))
          expect(saved.projectStatePath.startsWith('states/')).toBe(true)
          expect(saved.path.startsWith(path.join(tmpRoot, 'states') + path.sep)).toBe(true)
          expect(fs.statSync(saved.path).size).toBe(saved.bytesWritten)
        }
        const projectYaml = fs.readFileSync(path.join(tmpRoot, 'project.yaml'), 'utf8')
        for (const request of stateRequests) expect(projectYaml).toContain(request.identity)

        const invalidStateIndex = await client.call('save_plugin_state', {
          sequence: 'drum',
          index: 99,
        })
        expect(invalidStateIndex.isError, invalidStateIndex.text).toBe(true)
        expect(invalidStateIndex.text).toContain('Valid indices:')
        expect(invalidStateIndex.text).toContain('1 (effect, CLAPTestEffect)')

        const stateSaveLog = (await client.call('get_log', { lines: 500 })).text
        expect(
          (stateSaveLog.match(/ERROR:/g) ?? []).length,
          `successful #562 saves must add no ERROR: lines. Log tail: ${stateSaveLog.slice(-1200)}`,
        ).toBe(errorsBeforeStateSave)

        // ── #540 P1 (a): 同一シーケンスへの別 plugin 再宣言 = v1 の差し替え拒否。
        // エラー文言は回避策（エンジン再起動）を案内する新文言であること。
        const secondInstrumentRes = await client.call('evaluate_orbitscore', {
          code: `instSeq.instrument("${CLAP_TEST_EFFECT_PATH}")`,
        })
        expect(secondInstrumentRes.isError, secondInstrumentRes.text).toBe(false)
        await sleep(1000) // duplicate rejection is synchronous once the first slot is registered

        const afterSecondInstrumentLog = (await client.call('get_log', { lines: 500 })).text
        expect(
          afterSecondInstrumentLog,
          `expected the v1 replacement rejection, got log tail: ${afterSecondInstrumentLog.slice(-800)}`,
        ).toContain("Sequence 'instSeq' already has an instrument instance")
        expect(afterSecondInstrumentLog).toContain('restart the engine to change the plugin')

        // ── #540 P1 (b): 別シーケンスは自分の独立インスタンスを持てる（旧「エンジン
        // 全体で1台」制限の撤去がこの PR の表面）。同じ synth をもう1台 attach し、
        // 新規の attach 失敗も「already has」拒否も**増えない**ことを確認する。
        const attachFailuresBeforeSecondSeq = (
          afterSecondInstrumentLog.match(/\[OUTPROC_ATTACH_FAILED\]/g) ?? []
        ).length
        const declareInstSeq2Res = await client.call('evaluate_orbitscore', {
          code: 'var instSeq2 = init global.seq',
        })
        expect(declareInstSeq2Res.isError, declareInstSeq2Res.text).toBe(false)
        const secondSeqInstrumentRes = await client.call('evaluate_orbitscore', {
          code: `instSeq2.instrument("${CLAP_TEST_SYNTH_PATH}")`,
        })
        expect(secondSeqInstrumentRes.isError, secondSeqInstrumentRes.text).toBe(false)
        await sleep(6000) // 2台目の実 out-of-process attach（spawn + IPC handshake）

        const afterSecondSeqLog = (await client.call('get_log', { lines: 500 })).text
        const attachFailuresAfterSecondSeq = (
          afterSecondSeqLog.match(/\[OUTPROC_ATTACH_FAILED\]/g) ?? []
        ).length
        expect(
          attachFailuresAfterSecondSeq,
          `second sequence's own instrument must attach (no new OUTPROC_ATTACH_FAILED). Log tail: ${afterSecondSeqLog.slice(-800)}`,
        ).toBe(attachFailuresBeforeSecondSeq)
        expect(
          afterSecondSeqLog,
          `second sequence must NOT hit the same-sequence duplicate rejection. Log tail: ${afterSecondSeqLog.slice(-800)}`,
        ).not.toContain("Sequence 'instSeq2' already has an instrument instance")
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

  it.skipIf(!appAvailable)(
    'rescans catalog v2 through MCP, reports a broken bundle, and preserves a known CLAP fixture',
    async () => {
      expect(client, 'main gated phase must initialize the MCP client first').toBeDefined()
      expect(catalogSynthPath, 'main gated phase must create the known CLAP fixture').toBeDefined()
      expect(
        brokenCatalogPath,
        'main gated phase must create the deliberately broken bundle',
      ).toBeDefined()
      if (!client || !catalogSynthPath || !brokenCatalogPath) {
        throw new Error('main gated phase did not initialize catalog fixture state')
      }

      const beforeCatalogLog = (await client.call('get_log', { lines: 500 })).text
      const catalogErrorsBefore = (beforeCatalogLog.match(/ERROR:/g) ?? []).length
      const rescanCatalog = await client.call('rescan_plugins')
      expect(rescanCatalog.isError, rescanCatalog.text).toBe(false)
      const rescanResult = JSON.parse(rescanCatalog.text) as {
        count: number
        artifactCount: number
        failures: Array<{ path: string; code: string; message: string }>
        summary: { success: number; pending: number; failure: number }
      }
      expect(
        rescanResult.summary.success + rescanResult.summary.pending + rescanResult.summary.failure,
      ).toBe(rescanResult.artifactCount)
      expect(rescanResult.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: brokenCatalogPath,
            code: 'bundleLoad',
          }),
        ]),
      )

      const listedCatalog = await client.call('list_plugins')
      expect(listedCatalog.isError, listedCatalog.text).toBe(false)
      const listedPlugins = JSON.parse(listedCatalog.text) as Array<{
        name: string
        path: string
      }>
      expect(listedPlugins).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'CLAP Test Synth',
            path: catalogSynthPath,
          }),
        ]),
      )
      const afterCatalogLog = (await client.call('get_log', { lines: 500 })).text
      expect(
        (afterCatalogLog.match(/ERROR:/g) ?? []).length,
        `catalog rescan must add no ERROR: lines. Log tail: ${afterCatalogLog.slice(-1200)}`,
      ).toBe(catalogErrorsBefore)
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!appAvailable)(
    'reports an ambiguous bare mixer name through run_selection and get_log',
    async () => {
      expect(client, 'main gated phase must initialize the MCP client first').toBeDefined()
      expect(tmpRoot, 'main gated phase must initialize the scratch root first').toBeDefined()
      if (!client || !tmpRoot) throw new Error('main gated phase did not initialize suite state')
      const activeClient = client
      const dslPath = path.join(tmpRoot, 'ambiguous-mixer-name.orbs')
      const dslLines = [
        'var global = init GLOBAL',
        'global.sum("drum")',
        'global.aux("drum")',
        'drum.effect("MustNotLoad.clap")',
      ]
      fs.writeFileSync(dslPath, dslLines.join('\n') + '\n')

      const start = await activeClient.call('start_engine')
      expect(start.isError, start.text).toBe(false)
      try {
        await waitForEngine(true, 15_000, 'ambiguous mixer-name E2E engine running')
        const opened = await activeClient.call('open_file', { path: dslPath })
        expect(opened.isError, opened.text).toBe(false)
        const selected = await activeClient.call('set_selection', {
          start_line: 1,
          start_char: 1,
          end_line: dslLines.length,
          end_char: 999_999,
        })
        expect(selected.isError, selected.text).toBe(false)

        const errorPrefix = '[ERROR] Mixer bus name "drum" is ambiguous'
        const beforeLog = (await activeClient.call('get_log', { lines: 500 })).text
        const errorsBefore = beforeLog.split(errorPrefix).length - 1
        const run = await activeClient.call('run_selection')
        expect(run.isError, run.text).toBe(false)
        await waitUntil(
          async () => {
            const log = (await activeClient.call('get_log', { lines: 500 })).text
            return log.split(errorPrefix).length - 1 > errorsBefore
          },
          { intervalMs: 200, timeoutMs: 5_000, label: 'ambiguous mixer-name error in get_log' },
        )

        const afterLog = (await activeClient.call('get_log', { lines: 500 })).text
        expect(afterLog).toContain(errorPrefix)
        expect(afterLog).toContain('global.sum("drum")')
        expect(afterLog).toContain('global.aux("drum")')
      } finally {
        const stop = await activeClient.call('stop_engine')
        expect(stop.isError, stop.text).toBe(false)
        await waitForEngine(false, 15_000, 'ambiguous mixer-name E2E engine stopped')
      }
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!appAvailable)(
    'restores an MCP-saved non-default instrument state across an engine restart with the same measured pitch',
    async () => {
      expect(client, 'main gated phase must initialize the MCP client first').toBeDefined()
      expect(tmpRoot, 'main gated phase must initialize the scratch root first').toBeDefined()
      if (!client || !tmpRoot) throw new Error('main gated phase did not initialize suite state')
      const activeClient = client
      const root = tmpRoot

      // get_log は要求値にかかわらず末尾 500 行へ cap する。ERROR/attach 失敗の前後比較は
      // このスライディングウィンドウ内の補助判定で、復元の主判定は下の pitch assert。
      const RESTORE_LOG_LINES = 500
      const fixturesDir = path.join(root, 'fixtures')
      fs.mkdirSync(fixturesDir, { recursive: true })
      const handStatePath = path.join(fixturesDir, 'orc1-offset7.state')
      const magic = Buffer.alloc(4)
      magic.writeUInt32LE(0x4f52_4331)
      const offset = Buffer.alloc(4)
      offset.writeInt32LE(7)
      const handState = Buffer.concat([magic, offset])
      // This literal is Cycle A input only. If it drifts from clap-test-synth's
      // encode_state, apply_state_bytes rejects ORC1 before READY, attach fails
      // loudly, and a false pass is structurally impossible.
      fs.writeFileSync(handStatePath, handState)

      const shiftedWav = path.join(root, 'shifted.wav')
      const restoredWav = path.join(root, 'restored.wav')
      const countLogMarker = (log: string, marker: RegExp): number =>
        (log.match(marker) ?? []).length
      const countErrors = (log: string): number => countLogMarker(log, /ERROR:/g)
      const countAttachFailures = (log: string): number =>
        countLogMarker(log, /\[OUTPROC_ATTACH_FAILED\]/g)
      const countGlobalStops = (log: string): number =>
        countLogMarker(log, /(?:✅ Global stopped|⏹ Global)/g)

      // ── Cycle A: hand-built non-default state → audible pitch → MCP save.
      const beforeCycleALog = (await activeClient.call('get_log', { lines: RESTORE_LOG_LINES }))
        .text
      const errorsBeforeCycleA = countErrors(beforeCycleALog)
      const startShifted = await activeClient.call('start_engine', { capture_wav: shiftedWav })
      expect(startShifted.isError, startShifted.text).toBe(false)
      await waitForEngine(true, 15_000, 'Cycle A engine running')
      await sleep(2500)

      // A fresh engine has no Global and play() only installs a pattern. The
      // transport setup plus RUN are the minimum executable scaffold around the
      // adjudicated instrument(path, statePath) and play(1) operations.
      const initShifted = await activeClient.call('evaluate_orbitscore', {
        code: [
          'var global = init GLOBAL',
          'global.key("C")',
          'global.start()',
          'var stSeq = init global.seq',
        ].join('\n'),
      })
      expect(initShifted.isError, initShifted.text).toBe(false)
      const attachFailuresBeforeShifted = countAttachFailures(
        (await activeClient.call('get_log', { lines: RESTORE_LOG_LINES })).text,
      )
      const attachShifted = await activeClient.call('evaluate_orbitscore', {
        code: `stSeq.instrument(${JSON.stringify(CLAP_TEST_SYNTH_PATH)}, ${JSON.stringify(handStatePath)})`,
      })
      expect(attachShifted.isError, attachShifted.text).toBe(false)
      await sleep(6000)
      const afterShiftedAttachLog = (
        await activeClient.call('get_log', { lines: RESTORE_LOG_LINES })
      ).text
      expect(
        countAttachFailures(afterShiftedAttachLog),
        `Cycle A instrument attach must add no OUTPROC_ATTACH_FAILED. Log tail: ${afterShiftedAttachLog.slice(-1200)}`,
      ).toBe(attachFailuresBeforeShifted)

      const playShifted = await activeClient.call('evaluate_orbitscore', {
        code: ['stSeq.play(1)', 'RUN(stSeq)'].join('\n'),
      })
      expect(playShifted.isError, playShifted.text).toBe(false)
      await sleep(3000)

      const stopsBeforeShifted = countGlobalStops(
        (await activeClient.call('get_log', { lines: RESTORE_LOG_LINES })).text,
      )
      const stopShifted = await activeClient.call('evaluate_orbitscore', {
        code: ['stSeq.stop()', 'global.stop()'].join('\n'),
      })
      expect(stopShifted.isError, stopShifted.text).toBe(false)
      await waitUntil(
        async () =>
          countGlobalStops(
            (await activeClient.call('get_log', { lines: RESTORE_LOG_LINES })).text,
          ) > stopsBeforeShifted,
        {
          intervalMs: 200,
          timeoutMs: 5_000,
          label: 'Cycle A transport stopped before state save',
        },
      )

      const saveShifted = await activeClient.call('save_plugin_state', {
        sequence: 'stSeq',
        index: 0,
      })
      expect(saveShifted.isError, saveShifted.text).toBe(false)
      const saved = JSON.parse(saveShifted.text) as {
        path: string
        bytesWritten: number
        identityKey: string
        projectFile: string
        projectStatePath: string
      }
      expect(saved.bytesWritten).toBe(handState.length)
      expect(saved.identityKey).toBe('stSeq/instrument/CLAPTestSynth/0')
      expect(saved.projectFile).toBe(path.join(root, 'project.yaml'))
      expect(saved.path.startsWith(path.join(root, 'states') + path.sep)).toBe(true)
      expect(
        fs.readFileSync(saved.path).equals(handState),
        'MCP-saved state must be byte-identical to the Cycle A input',
      ).toBe(true)

      const stopCycleAEngine = await activeClient.call('stop_engine')
      expect(stopCycleAEngine.isError, stopCycleAEngine.text).toBe(false)
      await waitForEngine(false, 15_000, 'Cycle A engine stopped')
      await sleep(1500)
      const afterCycleALog = (await activeClient.call('get_log', { lines: RESTORE_LOG_LINES })).text
      expect(
        countErrors(afterCycleALog),
        `Cycle A must add no ERROR: lines. Log tail: ${afterCycleALog.slice(-1200)}`,
      ).toBe(errorsBeforeCycleA)

      // ── Cycle B: project.yaml registration from the MCP save is the restore input.
      const errorsBeforeCycleB = countErrors(afterCycleALog)
      const startRestored = await activeClient.call('start_engine', { capture_wav: restoredWav })
      expect(startRestored.isError, startRestored.text).toBe(false)
      await waitForEngine(true, 15_000, 'Cycle B engine running')
      await sleep(2500)

      const initRestored = await activeClient.call('evaluate_orbitscore', {
        code: [
          'var global = init GLOBAL',
          'global.key("C")',
          'global.start()',
          'var stSeq = init global.seq',
        ].join('\n'),
      })
      expect(initRestored.isError, initRestored.text).toBe(false)
      const attachFailuresBeforeRestored = countAttachFailures(
        (await activeClient.call('get_log', { lines: RESTORE_LOG_LINES })).text,
      )
      const attachRestored = await activeClient.call('evaluate_orbitscore', {
        code: `stSeq.instrument(${JSON.stringify(CLAP_TEST_SYNTH_PATH)})`,
      })
      expect(attachRestored.isError, attachRestored.text).toBe(false)
      await sleep(6000)
      const afterRestoredAttachLog = (
        await activeClient.call('get_log', { lines: RESTORE_LOG_LINES })
      ).text
      expect(
        countAttachFailures(afterRestoredAttachLog),
        `Cycle B instrument attach must add no OUTPROC_ATTACH_FAILED. Log tail: ${afterRestoredAttachLog.slice(-1200)}`,
      ).toBe(attachFailuresBeforeRestored)
      expect(
        afterRestoredAttachLog,
        `Cycle B must surface the automatic project-state restore. Log tail: ${afterRestoredAttachLog.slice(-1200)}`,
      ).toMatch(/\[plugin-state\] restoring[^\r\n]*stSeq\/instrument\/CLAPTestSynth\/0/)

      const playRestored = await activeClient.call('evaluate_orbitscore', {
        code: ['stSeq.play(1)', 'RUN(stSeq)'].join('\n'),
      })
      expect(playRestored.isError, playRestored.text).toBe(false)
      await sleep(3000)

      const stopsBeforeRestored = countGlobalStops(
        (await activeClient.call('get_log', { lines: RESTORE_LOG_LINES })).text,
      )
      const stopRestored = await activeClient.call('evaluate_orbitscore', {
        code: ['stSeq.stop()', 'global.stop()'].join('\n'),
      })
      expect(stopRestored.isError, stopRestored.text).toBe(false)
      await waitUntil(
        async () =>
          countGlobalStops(
            (await activeClient.call('get_log', { lines: RESTORE_LOG_LINES })).text,
          ) > stopsBeforeRestored,
        {
          intervalMs: 200,
          timeoutMs: 5_000,
          label: 'Cycle B transport stopped before engine stop',
        },
      )

      const stopCycleBEngine = await activeClient.call('stop_engine')
      expect(stopCycleBEngine.isError, stopCycleBEngine.text).toBe(false)
      await waitForEngine(false, 15_000, 'Cycle B engine stopped')
      await sleep(1500)
      const afterCycleBLog = (await activeClient.call('get_log', { lines: RESTORE_LOG_LINES })).text
      expect(
        countErrors(afterCycleBLog),
        `Cycle B must add no ERROR: lines. Log tail: ${afterCycleBLog.slice(-1200)}`,
      ).toBe(errorsBeforeCycleB)

      // ── Frequency-only verdict: no state decode is duplicated in the test.
      const shiftedBuf = fs.readFileSync(shiftedWav)
      const restoredBuf = fs.readFileSync(restoredWav)
      const shiftedDuration = analyzeWavBuffer(shiftedBuf).durationSec
      const restoredDuration = analyzeWavBuffer(restoredBuf).durationSec
      const shiftedHz = estimateFundamentalHz(shiftedBuf, {
        fromSec: 0,
        toSec: shiftedDuration,
      })
      const restoredHz = estimateFundamentalHz(restoredBuf, {
        fromSec: 0,
        toSec: restoredDuration,
      })
      expect(shiftedHz, 'Cycle A capture has no measurable steady fundamental').toBeDefined()
      expect(restoredHz, 'Cycle B capture has no measurable steady fundamental').toBeDefined()

      // MIDI-standard pitch formula is the independent musical specification.
      const midiFrequencyHz = (midiNote: number): number => 440 * 2 ** ((midiNote - 69) / 12)
      const expectedDefaultHz = midiFrequencyHz(60)
      const expectedShiftedHz = midiFrequencyHz(60 + 7)
      const shiftedMeasured = shiftedHz!
      const restoredMeasured = restoredHz!
      expect(
        Math.abs(shiftedMeasured - expectedShiftedHz) / expectedShiftedHz,
        `Cycle A ${shiftedMeasured.toFixed(2)}Hz must be offset-7 pitch ${expectedShiftedHz.toFixed(2)}Hz`,
      ).toBeLessThanOrEqual(0.02)
      expect(
        Math.abs(shiftedMeasured - expectedDefaultHz) / expectedDefaultHz,
        `Cycle A ${shiftedMeasured.toFixed(2)}Hz must be clearly distinct from default ${expectedDefaultHz.toFixed(2)}Hz`,
      ).toBeGreaterThan(0.1)
      expect(
        Math.abs(restoredMeasured - shiftedMeasured) / shiftedMeasured,
        `restored ${restoredMeasured.toFixed(2)}Hz must match saved ${shiftedMeasured.toFixed(2)}Hz`,
      ).toBeLessThanOrEqual(0.01)
      expect(
        Math.abs(restoredMeasured - expectedShiftedHz) / expectedShiftedHz,
        `restored ${restoredMeasured.toFixed(2)}Hz must be offset-7 pitch ${expectedShiftedHz.toFixed(2)}Hz`,
      ).toBeLessThanOrEqual(0.02)
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!appAvailable)(
    'restores a non-default sum-bus insert across restart through its prefixed receiver identity',
    async () => {
      expect(client, 'main gated phase must initialize the MCP client first').toBeDefined()
      expect(tmpRoot, 'main gated phase must initialize the scratch root first').toBeDefined()
      if (!client || !tmpRoot) throw new Error('main gated phase did not initialize suite state')
      const activeClient = client
      const root = tmpRoot
      const projectFile = path.join(root, 'project.yaml')
      const sourcePath = path.join(root, 'test-assets/audio/kick.wav')
      const dslPath = path.join(root, 'sum-bus-state.orbs')
      const defaultWav = path.join(root, 'sum-bus-default.wav')
      const changedWav = path.join(root, 'sum-bus-changed.wav')
      const restoredWav = path.join(root, 'sum-bus-restored.wav')
      const receiverKey = 'sum:drum/effect/CLAPTestEffect/0'
      const unprefixedDecoyKey = 'drum/effect/CLAPTestEffect/0'
      const wrongKindDecoyKey = 'aux:drum/effect/CLAPTestEffect/0'
      // 音声オラクルは sum 側だけに置く。aux 側は「daemon 往復まで実機で通る」ことを
      // get_log の restore 行で1点だけ証明する（フル音声オラクルの複製はコスト不適合）。
      const auxReceiverKey = 'aux:wet/effect/CLAPTestEffect/0'

      const dslLines = [
        'var global = init GLOBAL',
        'global.tempo(120)',
        'global.beat(4 by 4)',
        `global.sum("drum").effect(${JSON.stringify(CLAP_TEST_EFFECT_PATH)})`,
        `global.aux("wet").effect(${JSON.stringify(CLAP_TEST_EFFECT_PATH)})`,
        'var busStateSource = init global.seq',
        `busStateSource.audio(${JSON.stringify(sourcePath)}).chop(1).output("drum")`,
        'busStateSource.play(1, 1, 1, 1)',
        'global.start()',
        'LOOP(busStateSource)',
        'busStateSource.stop()',
        'global.stop()',
      ]
      // 1-based line numbers derived from the script so edits cannot silently
      // desynchronize the run_selection ranges below.
      const playEndLine = dslLines.indexOf('LOOP(busStateSource)') + 1
      const stopStartLine = dslLines.indexOf('busStateSource.stop()') + 1
      const stopEndLine = dslLines.indexOf('global.stop()') + 1
      expect(playEndLine).toBeGreaterThan(0)
      expect(stopStartLine).toBe(playEndLine + 1)
      expect(stopEndLine).toBe(stopStartLine + 1)
      fs.writeFileSync(dslPath, dslLines.join('\n') + '\n')
      const openDsl = await activeClient.call('open_file', { path: dslPath })
      expect(openDsl.isError, openDsl.text).toBe(false)

      const runDslLines = async (startLine: number, endLine: number): Promise<void> => {
        const selected = await activeClient.call('set_selection', {
          start_line: startLine,
          start_char: 1,
          end_line: endLine,
          end_char: 999_999,
        })
        expect(selected.isError, selected.text).toBe(false)
        const run = await activeClient.call('run_selection')
        expect(run.isError, run.text).toBe(false)
      }
      const startCapture = async (wavPath: string, label: string): Promise<void> => {
        const started = await activeClient.call('start_engine', { capture_wav: wavPath })
        expect(started.isError, started.text).toBe(false)
        await waitForEngine(true, 15_000, label)
        await sleep(2500)
      }
      const stopTransportThroughDsl = async (label: string): Promise<void> => {
        const before = (await activeClient.call('get_log', { lines: 500 })).text
        const stopsBefore = (before.match(/(?:✅ Global stopped|⏹ Global)/g) ?? []).length
        await runDslLines(stopStartLine, stopEndLine)
        await waitUntil(
          async () => {
            const log = (await activeClient.call('get_log', { lines: 500 })).text
            return (log.match(/(?:✅ Global stopped|⏹ Global)/g) ?? []).length > stopsBefore
          },
          { intervalMs: 200, timeoutMs: 5_000, label },
        )
      }
      const stopEngine = async (label: string): Promise<void> => {
        const stopped = await activeClient.call('stop_engine')
        expect(stopped.isError, stopped.text).toBe(false)
        await waitForEngine(false, 15_000, label)
        await sleep(1500)
      }
      const readManifestStates = (): Record<string, string> => {
        if (!fs.existsSync(projectFile)) return {}
        const manifest = parse(fs.readFileSync(projectFile, 'utf8')) as {
          states?: Record<string, string>
        }
        return { ...(manifest.states ?? {}) }
      }
      const writeManifestStates = (states: Record<string, string>): void => {
        fs.writeFileSync(projectFile, stringify({ version: 1, states }))
      }
      const writeEffectState = (relativePath: string, gain: number): void => {
        const absolutePath = path.resolve(root, relativePath)
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
        const bytes = Buffer.alloc(12)
        bytes.writeUInt32LE(0x4f52_4531, 0)
        bytes.writeDoubleLE(gain, 4)
        fs.writeFileSync(absolutePath, bytes)
      }

      // Baseline oracle: the same DSL and source through the effect's default
      // gain (0.5), captured before any receiver-specific state is registered.
      const baselineStates = readManifestStates()
      delete baselineStates[receiverKey]
      delete baselineStates[unprefixedDecoyKey]
      delete baselineStates[wrongKindDecoyKey]
      delete baselineStates[auxReceiverKey]
      writeManifestStates(baselineStates)
      await startCapture(defaultWav, 'sum-bus default capture engine running')
      await runDslLines(1, playEndLine)
      await sleep(4000)
      await stopTransportThroughDsl('sum-bus default transport stopped')
      await stopEngine('sum-bus default capture engine stopped')

      // Bootstrap the non-default 0.125 gain plus two measurable decoys. The
      // correct prefixed key is removed after load below, so only state recording
      // can make the subsequent restart reproduce this sound.
      const correctRelativePath = 'states/e2e-sum-gain-0125.state'
      const unprefixedDecoyPath = 'states/e2e-unprefixed-gain-0900.state'
      const wrongKindDecoyPath = 'states/e2e-aux-gain-0800.state'
      writeEffectState(correctRelativePath, 0.125)
      writeEffectState(unprefixedDecoyPath, 0.9)
      writeEffectState(wrongKindDecoyPath, 0.8)
      writeManifestStates({
        ...readManifestStates(),
        [receiverKey]: correctRelativePath,
        [unprefixedDecoyKey]: unprefixedDecoyPath,
        [wrongKindDecoyKey]: wrongKindDecoyPath,
      })

      // 1. .orbs の sum bus insert を、ユーザーと同じ run_selection で評価する。
      await startCapture(changedWav, 'sum-bus changed capture engine running')
      await runDslLines(1, playEndLine)
      await sleep(4000)

      // 2. 正しい receiver key から非既定 gain が適用済み。bootstrap key を消してから
      // DSL で停止し、保存経路だけが restart 用の登記を作れる状態にする。
      const loadedStates = readManifestStates()
      delete loadedStates[receiverKey]
      writeManifestStates(loadedStates)
      await stopTransportThroughDsl('sum-bus changed transport stopped before state save')

      // 3. 自動記録される。
      // stop() の snapshot は fire-and-forget なので、明示保存を挟まず、両 receiver が
      // committed manifest に登記されるまで待って非同期の daemon 往復を吸収する。
      await waitUntil(
        () => {
          const states = readManifestStates()
          return Boolean(states[receiverKey] && states[auxReceiverKey])
        },
        { intervalMs: 200, timeoutMs: 10_000, label: 'sum/aux auto-snapshot registered' },
      )
      const registeredStates = readManifestStates()
      expect(registeredStates[receiverKey]).toMatch(/^states\//)
      expect(registeredStates[auxReceiverKey]).toMatch(/^states\//)
      expect(registeredStates[unprefixedDecoyKey]).toBe(unprefixedDecoyPath)
      expect(registeredStates[wrongKindDecoyKey]).toBe(wrongKindDecoyPath)

      // 4. エンジンを再起動する。
      await stopEngine('sum-bus changed capture engine stopped')
      await startCapture(restoredWav, 'sum-bus restored capture engine running')

      // 5. 同じ .orbs を run_selection で再評価し、capture で音の一致を確認する。
      await runDslLines(1, playEndLine)
      await sleep(4000)
      // aux 側は restore が daemon まで往復した証拠として engine ログの
      // `[plugin-state] restoring 'aux:wet/…'` 行を確認する。
      await waitUntil(
        async () => {
          const log = (await activeClient.call('get_log', { lines: 1000 })).text
          return log.includes(`[plugin-state] restoring '${auxReceiverKey}'`)
        },
        { intervalMs: 200, timeoutMs: 10_000, label: 'aux-bus insert restored from prefixed key' },
      )
      await stopTransportThroughDsl('sum-bus restored transport stopped')
      await stopEngine('sum-bus restored capture engine stopped')

      const defaultAnalysis = analyzeWavBuffer(fs.readFileSync(defaultWav))
      const changedAnalysis = analyzeWavBuffer(fs.readFileSync(changedWav))
      const restoredAnalysis = analyzeWavBuffer(fs.readFileSync(restoredWav))
      expect(defaultAnalysis.soundDetected, JSON.stringify(defaultAnalysis)).toBe(true)
      expect(changedAnalysis.soundDetected, JSON.stringify(changedAnalysis)).toBe(true)
      expect(restoredAnalysis.soundDetected, JSON.stringify(restoredAnalysis)).toBe(true)

      const peakRatioFromDefault = changedAnalysis.peak / defaultAnalysis.peak
      const rmsRatioFromDefault = changedAnalysis.rms / defaultAnalysis.rms
      expect(
        peakRatioFromDefault,
        `non-default peak ratio ${peakRatioFromDefault} must reflect gain 0.125 / default 0.5`,
      ).toBeGreaterThan(0.15)
      expect(peakRatioFromDefault).toBeLessThan(0.35)
      expect(
        rmsRatioFromDefault,
        `non-default RMS ratio ${rmsRatioFromDefault} must reflect gain 0.125 / default 0.5`,
      ).toBeGreaterThan(0.12)
      expect(rmsRatioFromDefault).toBeLessThan(0.4)

      const restoredPeakDelta =
        Math.abs(restoredAnalysis.peak - changedAnalysis.peak) / changedAnalysis.peak
      const restoredRmsDelta =
        Math.abs(restoredAnalysis.rms - changedAnalysis.rms) / changedAnalysis.rms
      expect(
        restoredPeakDelta,
        `restored peak ${restoredAnalysis.peak} must match pre-restart ${changedAnalysis.peak}`,
      ).toBeLessThanOrEqual(0.08)
      expect(
        restoredRmsDelta,
        `restored RMS ${restoredAnalysis.rms} must match pre-restart ${changedAnalysis.rms}`,
      ).toBeLessThanOrEqual(0.15)
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!appAvailable)(
    'auto-records and restores all five plugin receiver kinds across a restart without explicit saves',
    async () => {
      expect(client, 'main gated phase must initialize the MCP client first').toBeDefined()
      expect(tmpRoot, 'main gated phase must initialize the scratch root first').toBeDefined()
      if (!client || !tmpRoot) throw new Error('main gated phase did not initialize suite state')
      const activeClient = client
      const root = tmpRoot
      const projectFile = path.join(root, 'project.yaml')
      const sourcePath = path.join(root, 'test-assets/audio/kick.wav')
      const dslPath = path.join(root, 'all-receiver-auto-snapshot.orbs')
      const defaultWav = path.join(root, 'all-receiver-default.wav')
      const preRestartWav = path.join(root, 'all-receiver-pre-restart.wav')
      const restoredWav = path.join(root, 'all-receiver-restored.wav')
      const receiverKeys = [
        'master/effect/CLAPTestEffect/0',
        'sum:autoSnapshotSum/effect/CLAPTestEffect/0',
        'aux:autoSnapshotAux/effect/CLAPTestEffect/0',
        'autoSnapshotEffect/effect/CLAPTestEffect/0',
        'autoSnapshotInstrument/instrument/CLAPTestSynth/0',
      ] as const

      const instrumentDeclaration = `autoSnapshotInstrument.instrument(${JSON.stringify(CLAP_TEST_SYNTH_PATH)})`
      const dslLines = [
        'var global = init GLOBAL',
        // The solo segment plays `autoSnapshotInstrument.play(1)`, a MIDI
        // degree the engine rejects without a root — keep the key declared
        // (the ERROR-count assertion caught the omission on a real device).
        'global.key("C")',
        'global.tempo(120)',
        'global.beat(4 by 4)',
        'var mix = init global.mixer',
        'var master = mix.output(1, 2)',
        'var autoSnapshotSum = mix.sum',
        'var autoSnapshotAux = mix.aux',
        `global.effect(${JSON.stringify(CLAP_TEST_EFFECT_PATH)})`,
        `autoSnapshotSum.effect(${JSON.stringify(CLAP_TEST_EFFECT_PATH)})`,
        `autoSnapshotAux.effect(${JSON.stringify(CLAP_TEST_EFFECT_PATH)})`,
        'var autoSnapshotEffect = init global.seq',
        `autoSnapshotEffect.audio(${JSON.stringify(sourcePath)}).chop(1)`,
        `autoSnapshotEffect.effect(${JSON.stringify(CLAP_TEST_EFFECT_PATH)})`,
        'autoSnapshotEffect.autoSnapshotSum',
        'autoSnapshotSum.autoSnapshotAux(1).master',
        'autoSnapshotAux.master',
        'var autoSnapshotInstrument = init global.seq',
        instrumentDeclaration,
        'autoSnapshotEffect.play(1, 1, 1, 1)',
        'global.start()',
        'LOOP(autoSnapshotEffect)',
        // Solo segment: stop the kick loop, then run the synth alone so the
        // capture tail holds a clean fundamental for the pitch oracle.
        'autoSnapshotEffect.stop()',
        'autoSnapshotInstrument.play(1)',
        'RUN(autoSnapshotInstrument)',
        'autoSnapshotInstrument.stop()',
        'global.stop()',
      ]
      const declarationsEndLine = dslLines.indexOf(instrumentDeclaration) + 1
      const playbackStartLine = dslLines.indexOf('autoSnapshotEffect.play(1, 1, 1, 1)') + 1
      const playbackEndLine = dslLines.indexOf('LOOP(autoSnapshotEffect)') + 1
      const soloStartLine = dslLines.indexOf('autoSnapshotEffect.stop()') + 1
      const soloEndLine = dslLines.indexOf('RUN(autoSnapshotInstrument)') + 1
      const stopStartLine = dslLines.indexOf('autoSnapshotInstrument.stop()') + 1
      const stopEndLine = dslLines.indexOf('global.stop()') + 1
      expect(declarationsEndLine).toBeGreaterThan(0)
      expect(playbackStartLine).toBe(declarationsEndLine + 1)
      expect(playbackEndLine).toBe(playbackStartLine + 2)
      expect(soloStartLine).toBe(playbackEndLine + 1)
      expect(soloEndLine).toBe(soloStartLine + 2)
      expect(stopStartLine).toBe(soloEndLine + 1)
      expect(stopEndLine).toBe(stopStartLine + 1)
      fs.writeFileSync(dslPath, dslLines.join('\n') + '\n')
      const openDsl = await activeClient.call('open_file', { path: dslPath })
      expect(openDsl.isError, openDsl.text).toBe(false)

      const runDslLines = async (startLine: number, endLine: number): Promise<void> => {
        const selected = await activeClient.call('set_selection', {
          start_line: startLine,
          start_char: 1,
          end_line: endLine,
          end_char: 999_999,
        })
        expect(selected.isError, selected.text).toBe(false)
        const run = await activeClient.call('run_selection')
        expect(run.isError, run.text).toBe(false)
      }
      const stopTransportThroughDsl = async (label: string): Promise<void> => {
        const before = (await activeClient.call('get_log', { lines: 500 })).text
        const stopsBefore = (before.match(/(?:✅ Global stopped|⏹ Global)/g) ?? []).length
        await runDslLines(stopStartLine, stopEndLine)
        await waitUntil(
          async () => {
            const log = (await activeClient.call('get_log', { lines: 500 })).text
            return (log.match(/(?:✅ Global stopped|⏹ Global)/g) ?? []).length > stopsBefore
          },
          { intervalMs: 200, timeoutMs: 5_000, label },
        )
      }
      const stopEngine = async (label: string): Promise<void> => {
        const stopped = await activeClient.call('stop_engine')
        expect(stopped.isError, stopped.text).toBe(false)
        await waitForEngine(false, 15_000, label)
        await sleep(1500)
      }
      const readManifestStates = (): Record<string, string> => {
        if (!fs.existsSync(projectFile)) return {}
        const manifest = parse(fs.readFileSync(projectFile, 'utf8')) as {
          states?: Record<string, string>
        }
        return { ...(manifest.states ?? {}) }
      }
      const writeManifestStates = (states: Record<string, string>): void => {
        fs.writeFileSync(projectFile, stringify({ version: 1, states }))
      }
      // ORE1 magic + f64 LE gain — clap-test-effect's encode_state. Byte
      // equality against auto-recorded files works because both encoders are
      // deterministic.
      const effectStateBytes = (gain: number): Buffer => {
        const bytes = Buffer.alloc(12)
        bytes.writeUInt32LE(0x4f52_4531, 0)
        bytes.writeDoubleLE(gain, 4)
        return bytes
      }
      // ORC1 magic + i32 LE semitone offset — clap-test-synth's encode_state.
      const instrumentStateBytes = (semitoneOffset: number): Buffer => {
        const bytes = Buffer.alloc(8)
        bytes.writeUInt32LE(0x4f52_4331, 0)
        bytes.writeInt32LE(semitoneOffset, 4)
        return bytes
      }
      const writeStateFile = (relativePath: string, bytes: Buffer): void => {
        const absolutePath = path.resolve(root, relativePath)
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
        fs.writeFileSync(absolutePath, bytes)
      }
      const countErrors = (log: string): number => (log.match(/ERROR:/g) ?? []).length
      // ProjectStateStore.stateFileNameForIdentity: the identity tuple as
      // JSON, base64url-encoded. Restated here so the test pins the on-disk
      // contract instead of importing the implementation it verifies.
      const expectedAutoStatePath = (receiverKey: string): string => {
        const [receiver, role, normalizedName, occurrence] = receiverKey.split('/')
        const encoded = Buffer.from(
          JSON.stringify([receiver, role, normalizedName, Number(occurrence)]),
          'utf8',
        ).toString('base64url')
        return `states/${encoded}.state`
      }
      // Path-bound restore-line counter: a matching line proves this receiver
      // was restored FROM this file. The sound oracle cannot see a state swap
      // between the three series receivers (their gains multiply
      // commutatively), so the manifest-level wiring is pinned here instead.
      const countRestoreLines = (log: string, receiverKey: string, statePath: string): number =>
        log
          .split('\n')
          .filter(
            (line) =>
              line.includes(`[plugin-state] restoring '${receiverKey}' from `) &&
              line.trimEnd().endsWith(`/${statePath}`),
          ).length
      // Scan 1 s windows backwards from the end of the capture: the synth solo
      // is the last sounding segment, so the first window with a steady
      // fundamental measures it (tail silence stays under the amplitude floor
      // and yields undefined).
      const lastSteadyFundamentalHz = (buf: Buffer): number | undefined => {
        const { durationSec } = analyzeWavBuffer(buf)
        for (let toSec = durationSec; toSec >= 1; toSec -= 0.25) {
          const hz = estimateFundamentalHz(buf, { fromSec: toSec - 1, toSec })
          if (hz !== undefined) return hz
        }
        return undefined
      }
      let engineRunning = false
      const startCapture = async (wavPath: string, label: string): Promise<void> => {
        const started = await activeClient.call('start_engine', { capture_wav: wavPath })
        expect(started.isError, started.text).toBe(false)
        engineRunning = true
        await waitForEngine(true, 15_000, label)
        await sleep(2500)
      }
      // Keep every cycle's timeline identical so whole-file RMS stays
      // comparable across the three captures.
      const runPlaybackPhases = async (): Promise<void> => {
        await sleep(6000)
        await runDslLines(playbackStartLine, playbackEndLine)
        await sleep(4000)
        await runDslLines(soloStartLine, soloEndLine)
        await sleep(4000)
      }

      const baselineStates = readManifestStates()
      for (const receiverKey of receiverKeys) delete baselineStates[receiverKey]
      writeManifestStates(baselineStates)
      const clearedStates = readManifestStates()
      for (const receiverKey of receiverKeys) {
        expect(clearedStates).not.toHaveProperty(receiverKey)
      }

      // Topology (NOT a series chain): the sum bus feeds master directly AND
      // sends to aux (amount 1), whose return also feeds master. With an ideal
      // zero-latency adder the graph would collapse to
      //   T = g_master · g_sequence · g_sum · (1 + g_aux)
      // Reverting any one SERIES gain to the 0.5 default moves the capture by
      // 44.4% (master), 41.2% (sum) or 37.5% (sequence) — measured on real
      // hardware, red as predicted. The aux term is different: every OOP
      // insert is pipelined (+1 block of latency), so the aux return lags the
      // direct leg by one device block. The kick's file peak lands ~66 samples
      // after onset — inside that block — so the whole-file peak is
      // mathematically insensitive to g_aux at ANY tolerance, and whole-file
      // RMS moves only ~4% (measured signed −4.11% for g_aux 0.95 → 0.0; the
      // ideal 23.1% shrinks under the kick's negative lag-autocorrelation
      // plus silence/synth dilution). That 4.11% is real signal, not noise:
      // the no-mutation noise floor between two same-settings captures is
      // 3.4e-6. So the RMS restore assert below runs at 2% tolerance — tight
      // enough that a lost aux restore goes red — while peak keeps 15% and
      // covers the series gains only (#587: measurement sensitivity, not a
      // signal-path defect). The aux leg itself is pinned at bus level by the
      // daemon gated test set_bus_routing_wires_sum_send_to_aux_and_return
      // (rust/crates/orbit-audio-daemon/tests/outproc_mixer_bus_gated.rs);
      // the committed-bytes equality and the path-bound restore-line assert
      // cover the aux STATE from the manifest side. T is commutative in the
      // series gains, so a state SWAP between them is inaudible; the
      // path-bound restore-line asserts cover that failure class too.
      const effectStates = [
        {
          receiverKey: receiverKeys[0],
          relativePath: 'states/e2e-auto-master-gain-0900.state',
          gain: 0.9,
        },
        {
          receiverKey: receiverKeys[1],
          relativePath: 'states/e2e-auto-sum-gain-0850.state',
          gain: 0.85,
        },
        {
          receiverKey: receiverKeys[2],
          relativePath: 'states/e2e-auto-aux-gain-0950.state',
          gain: 0.95,
        },
        {
          receiverKey: receiverKeys[3],
          relativePath: 'states/e2e-auto-sequence-gain-0800.state',
          gain: 0.8,
        },
      ] as const
      // The gain product cannot see a pitch state, so the instrument carries
      // its own oracle: a non-default semitone offset measured as the solo
      // segment's fundamental (same semantics as the MCP-save instrument test).
      const instrumentState = {
        receiverKey: receiverKeys[4],
        relativePath: 'states/e2e-auto-instrument-offset-0007.state',
        semitoneOffset: 7,
      } as const
      const bootstrapEntries: readonly { receiverKey: string; relativePath: string }[] = [
        ...effectStates,
        instrumentState,
      ]

      try {
        // ── Cycle 0: default baseline. No registered states — every plugin
        // keeps its built-in default (gain 0.5, offset 0). The loaded cycles
        // must differ audibly from this capture; without the baseline, a
        // pipeline that never applied state in either loaded cycle would
        // still pass their mutual match.
        await startCapture(defaultWav, 'all-receiver default-baseline capture engine running')
        const beforeDefaultLog = (await activeClient.call('get_log', { lines: 500 })).text
        const errorsBeforeDefault = countErrors(beforeDefaultLog)
        await runDslLines(1, declarationsEndLine)
        await runPlaybackPhases()
        await stopTransportThroughDsl('all-receiver default-baseline transport stopped')
        const afterDefaultLog = (await activeClient.call('get_log', { lines: 500 })).text
        expect(
          countErrors(afterDefaultLog),
          `default-baseline cycle must add no ERROR: lines. Log tail: ${afterDefaultLog.slice(-1200)}`,
        ).toBe(errorsBeforeDefault)
        await stopEngine('all-receiver default-baseline engine stopped')
        engineRunning = false

        // Bootstrap: hand-written non-default states stand in for "shape the
        // sound in the plugin UI" until #474 ships an openable UI. This write
        // also overwrites the registrations left by the cycle-0 stop snapshot;
        // the committed registrations consumed by the restart are produced by
        // the cycle-1 stop snapshot alone (asserted below).
        for (const state of effectStates) {
          writeStateFile(state.relativePath, effectStateBytes(state.gain))
        }
        writeStateFile(
          instrumentState.relativePath,
          instrumentStateBytes(instrumentState.semitoneOffset),
        )
        writeManifestStates({
          ...readManifestStates(),
          ...Object.fromEntries(
            bootstrapEntries.map((state) => [state.receiverKey, state.relativePath]),
          ),
        })

        // ── Cycle 1: load the five bootstrap states, prove they are audible,
        // then let the stop snapshot auto-record them.
        await startCapture(preRestartWav, 'all-receiver pre-restart capture engine running')
        const beforeLog = (await activeClient.call('get_log', { lines: 500 })).text
        const errorsBefore = countErrors(beforeLog)
        const bootstrapRestoreCountsBefore = new Map(
          bootstrapEntries.map((state) => [
            state.receiverKey,
            countRestoreLines(beforeLog, state.receiverKey, state.relativePath),
          ]),
        )
        await runDslLines(1, declarationsEndLine)
        await waitUntil(
          async () => {
            const log = (await activeClient.call('get_log', { lines: 500 })).text
            const missing = bootstrapEntries.filter(
              (state) =>
                countRestoreLines(log, state.receiverKey, state.relativePath) <=
                bootstrapRestoreCountsBefore.get(state.receiverKey)!,
            )
            if (missing.length > 0) {
              throw new Error(
                `missing bootstrap restore log lines: ${missing.map((s) => s.receiverKey).join(', ')}`,
              )
            }
            return true
          },
          {
            intervalMs: 200,
            timeoutMs: 10_000,
            label: 'all five bootstrap state restore log lines',
          },
        )
        await runPlaybackPhases()

        // Remove every bootstrap registration after the loaded plugins have
        // applied it. Only the automatic stop snapshot may create the committed
        // registrations consumed by the restart below.
        const loadedStates = readManifestStates()
        for (const receiverKey of receiverKeys) delete loadedStates[receiverKey]
        writeManifestStates(loadedStates)
        const statesBeforeAutoSnapshot = readManifestStates()
        for (const receiverKey of receiverKeys) {
          expect(statesBeforeAutoSnapshot).not.toHaveProperty(receiverKey)
        }
        await stopTransportThroughDsl('all-receiver transport stopped before auto-snapshot')

        await waitUntil(
          () => {
            const states = readManifestStates()
            return receiverKeys.every((receiverKey) => Boolean(states[receiverKey]))
          },
          {
            intervalMs: 200,
            timeoutMs: 10_000,
            label: 'all five receiver auto-snapshots registered',
          },
        )
        const registeredStates = readManifestStates()
        for (const receiverKey of receiverKeys) {
          expect(registeredStates[receiverKey]).toBe(expectedAutoStatePath(receiverKey))
        }
        // The snapshot must have re-saved the LIVE plugin state, not left the
        // cycle-0 default bytes behind: the committed files must equal the
        // exact bytes the plugins loaded from the bootstrap.
        for (const state of effectStates) {
          expect(
            fs
              .readFileSync(path.join(root, expectedAutoStatePath(state.receiverKey)))
              .equals(effectStateBytes(state.gain)),
            `auto-recorded '${state.receiverKey}' must hold the loaded gain ${state.gain}`,
          ).toBe(true)
        }
        expect(
          fs
            .readFileSync(path.join(root, expectedAutoStatePath(instrumentState.receiverKey)))
            .equals(instrumentStateBytes(instrumentState.semitoneOffset)),
          `auto-recorded '${instrumentState.receiverKey}' must hold semitone offset ` +
            `${instrumentState.semitoneOffset}`,
        ).toBe(true)

        const afterRecordLog = (await activeClient.call('get_log', { lines: 500 })).text
        expect(
          countErrors(afterRecordLog),
          `all-receiver auto-snapshot must add no ERROR: lines. Log tail: ${afterRecordLog.slice(-1200)}`,
        ).toBe(errorsBefore)

        // Restart with only the stop-triggered committed manifest as restore
        // input, then re-declare every receiver. The daemon emits this marker
        // only when the registered state is actually sent back for application.
        await stopEngine('all-receiver auto-snapshot engine stopped before restore')
        engineRunning = false
        await startCapture(restoredWav, 'all-receiver restore capture engine running')

        const restoreBaselineLog = (await activeClient.call('get_log', { lines: 500 })).text
        const errorsBeforeRestore = countErrors(restoreBaselineLog)
        // Path-bound markers: each receiver must be restored from ITS
        // deterministic committed file. Cycle-1 bootstrap lines used the
        // hand-written paths, so they cannot satisfy these counts.
        const restoreCountsBeforeDeclarations = new Map(
          receiverKeys.map((receiverKey) => [
            receiverKey,
            countRestoreLines(restoreBaselineLog, receiverKey, expectedAutoStatePath(receiverKey)),
          ]),
        )

        await runDslLines(1, declarationsEndLine)
        await waitUntil(
          async () => {
            const log = (await activeClient.call('get_log', { lines: 500 })).text
            const missingReceiverKeys = receiverKeys.filter(
              (receiverKey) =>
                countRestoreLines(log, receiverKey, expectedAutoStatePath(receiverKey)) <=
                restoreCountsBeforeDeclarations.get(receiverKey)!,
            )
            if (missingReceiverKeys.length > 0) {
              throw new Error(
                `missing restore log lines for receiver keys: ${missingReceiverKeys.join(', ')}`,
              )
            }
            return true
          },
          {
            intervalMs: 200,
            timeoutMs: 10_000,
            label: 'all five receiver state restore log lines after engine restart',
          },
        )

        await runPlaybackPhases()
        await stopTransportThroughDsl('all-receiver restored transport stopped')

        const afterRestoreLog = (await activeClient.call('get_log', { lines: 500 })).text
        expect(
          countErrors(afterRestoreLog),
          `all-receiver restore must not increase ERROR: lines from the post-restart baseline. Log tail: ${afterRestoreLog.slice(-1200)}`,
        ).toBeLessThanOrEqual(errorsBeforeRestore)

        await stopEngine('all-receiver restored capture engine stopped')
        engineRunning = false

        const defaultBuf = fs.readFileSync(defaultWav)
        const preRestartBuf = fs.readFileSync(preRestartWav)
        const restoredBuf = fs.readFileSync(restoredWav)
        const defaultAnalysis = analyzeWavBuffer(defaultBuf)
        const preRestartAnalysis = analyzeWavBuffer(preRestartBuf)
        const restoredAnalysis = analyzeWavBuffer(restoredBuf)
        expect(defaultAnalysis.soundDetected, JSON.stringify(defaultAnalysis)).toBe(true)
        expect(preRestartAnalysis.soundDetected, JSON.stringify(preRestartAnalysis)).toBe(true)
        expect(restoredAnalysis.soundDetected, JSON.stringify(restoredAnalysis)).toBe(true)

        // Loaded states must be audibly ABOVE the default baseline. Physics:
        // the kick leg scales by T(loaded)/T(default) = 1.1934/0.1875 ≈ 6.4×
        // and the synth leg (master gain only) by 0.9/0.5 = 1.8×, so the
        // mixed capture gains at least ~44% — assert a 30% floor for margin.
        expect(
          (preRestartAnalysis.rms - defaultAnalysis.rms) / preRestartAnalysis.rms,
          `loaded RMS ${preRestartAnalysis.rms} must clearly exceed default ${defaultAnalysis.rms}`,
        ).toBeGreaterThan(0.3)
        expect(
          (preRestartAnalysis.peak - defaultAnalysis.peak) / preRestartAnalysis.peak,
          `loaded peak ${preRestartAnalysis.peak} must clearly exceed default ${defaultAnalysis.peak}`,
        ).toBeGreaterThan(0.3)

        const restoredPeakDelta =
          Math.abs(restoredAnalysis.peak - preRestartAnalysis.peak) / preRestartAnalysis.peak
        const restoredRmsDelta =
          Math.abs(restoredAnalysis.rms - preRestartAnalysis.rms) / preRestartAnalysis.rms
        expect(
          restoredPeakDelta,
          `restored peak ${restoredAnalysis.peak} must match pre-restart ${preRestartAnalysis.peak}`,
        ).toBeLessThanOrEqual(0.15)
        // RMS tolerance is 2%, not the peak's 15%. Measured on real hardware
        // (#587): the no-mutation noise floor between two same-settings
        // captures is 3.4e-6 (0.00034%), while the smallest real fault — the
        // aux insert's contribution going missing — moves whole-file RMS by
        // 4.11% (signed, measured for g_aux 0.95 → 0.0). 2% sits ~6000× above
        // the measured floor and ~2× under that smallest fault, so a lost aux
        // restore goes red here while same-machine reruns stay green. The
        // peak assert keeps 15%: its cross-run floor is unmeasured, and the
        // whole-file peak is structurally blind to the aux leg (the pipelined
        // aux return lags one device block behind the direct leg, and the
        // kick's peak sits inside that block), so tightening it buys no aux
        // detection — RMS is the discriminating meter here.
        expect(
          restoredRmsDelta,
          `restored RMS ${restoredAnalysis.rms} must match pre-restart ${preRestartAnalysis.rms}`,
        ).toBeLessThanOrEqual(0.02)

        // Instrument leg: pitch, not level. Thresholds mirror the MCP-save
        // instrument test (±2% against the musical spec, ≤1% across restart).
        const midiFrequencyHz = (midiNote: number): number => 440 * 2 ** ((midiNote - 69) / 12)
        const expectedDefaultHz = midiFrequencyHz(60)
        const expectedShiftedHz = midiFrequencyHz(60 + instrumentState.semitoneOffset)
        const defaultHz = lastSteadyFundamentalHz(defaultBuf)
        const preRestartHz = lastSteadyFundamentalHz(preRestartBuf)
        const restoredHz = lastSteadyFundamentalHz(restoredBuf)
        expect(defaultHz, 'default capture has no measurable solo fundamental').toBeDefined()
        expect(preRestartHz, 'pre-restart capture has no measurable solo fundamental').toBeDefined()
        expect(restoredHz, 'restored capture has no measurable solo fundamental').toBeDefined()
        expect(
          Math.abs(defaultHz! - expectedDefaultHz) / expectedDefaultHz,
          `default solo ${defaultHz!.toFixed(2)}Hz must be the offset-0 pitch ` +
            `${expectedDefaultHz.toFixed(2)}Hz`,
        ).toBeLessThanOrEqual(0.02)
        expect(
          Math.abs(preRestartHz! - expectedShiftedHz) / expectedShiftedHz,
          `loaded solo ${preRestartHz!.toFixed(2)}Hz must be the offset-` +
            `${instrumentState.semitoneOffset} pitch ${expectedShiftedHz.toFixed(2)}Hz`,
        ).toBeLessThanOrEqual(0.02)
        expect(
          Math.abs(restoredHz! - preRestartHz!) / preRestartHz!,
          `restored solo ${restoredHz!.toFixed(2)}Hz must match pre-restart ` +
            `${preRestartHz!.toFixed(2)}Hz`,
        ).toBeLessThanOrEqual(0.01)
        expect(
          Math.abs(restoredHz! - expectedShiftedHz) / expectedShiftedHz,
          `restored solo ${restoredHz!.toFixed(2)}Hz must be the offset-` +
            `${instrumentState.semitoneOffset} pitch ${expectedShiftedHz.toFixed(2)}Hz`,
        ).toBeLessThanOrEqual(0.02)
      } finally {
        if (engineRunning) {
          await stopEngine('all-receiver auto-record/restore engine stopped')
        }
      }
    },
    // Three engine cycles (default / loaded / restored), each with a kick and
    // a solo segment — the shared two-cycle budget is not enough.
    TEST_TIMEOUT_MS * 2,
  )
})
