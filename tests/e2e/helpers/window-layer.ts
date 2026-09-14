/**
 * Read the window server's record of a process's windows (#940).
 *
 * 🔴 The design for #940 claimed window stacking "cannot be observed automatically"
 * and put the whole check in a manual gate. **That was wrong** — `kCGWindowLayer`
 * is readable from `CGWindowListCopyWindowInfo`, so the level a plugin window
 * actually got is assertable. This helper is what makes the E2E possible.
 *
 * The reader is an external Swift script rather than a question asked of the child:
 * the child could report its own `window.level()`, but that proves what the process
 * believes, not what the compositor applied.
 */

import { spawnSync } from 'child_process'
import * as path from 'path'

/** `kCGWindowLayer` values we care about. AppKit's NSFloatingWindowLevel is 3. */
export const WINDOW_LAYER_NORMAL = 0
export const WINDOW_LAYER_FLOATING = 3

export interface ObservedWindow {
  readonly pid: number
  readonly layer: number
  readonly name: string
}

const READER = path.join(__dirname, 'window-layer.swift')

/** See the note in `observeWindows` — the resolved spelling matters to swift. */
const MODULE_CACHE = '/private/tmp/orbit-swift-module-cache'

/**
 * Every on-screen or off-screen window owned by `pid`, as the window server sees it.
 *
 * Returns an empty array when the process owns no window — that is a real answer
 * ("nothing is open"), not an error, and the caller decides whether it is a failure.
 */
export function observeWindows(pid: number): ObservedWindow[] {
  // 🔴 `execFileSync` ではなく `spawnSync`（`run-cli.ts` と同じ規約・silent-failure レビュー
  // 2026-09-04）。`execFileSync` は**成功時に stdout の文字列しか返さない**ので、swift が
  // stderr へ書いても呼び出し元からは**原理的に見えない**ため、別種の helper 失敗を
  // 見逃さないよう stderr も検査する。画面録画権限が無い実測ケースでは stderr/exit は
  // 正常のまま、対象 pid の窓が `name: ""` として返るため、そちらは soloWindowLayer が
  // フィルタ前の一覧から診断する。signal も見る（タイムアウトで殺されたのと swift が
  // 非ゼロで終わったのは別の失敗）。
  const result = spawnSync('swift', [READER, String(pid)], {
    encoding: 'utf8',
    // The module cache defaults under $HOME; pinning it keeps repeated calls at
    // ~0.2s instead of recompiling the AppKit interface each run.
    //
    // 🔴 `/private/tmp`, not `/tmp`. They are the same directory (a symlink), but
    // swift records the cache path verbatim and then refuses a second run that
    // reaches the same .pcm by the other spelling:
    //   error: module 'Darwin' is defined in both '/private/tmp/...' and '/tmp/...'
    // Using the resolved path makes every caller agree on one spelling.
    env: { ...process.env, CLANG_MODULE_CACHE_PATH: MODULE_CACHE },
    timeout: 30_000,
  })
  if (result.error) throw result.error
  if (result.signal) {
    throw new Error(`window-layer.swift was killed by ${result.signal} (pid ${pid})`)
  }
  if (result.status !== 0) {
    throw new Error(
      `window-layer.swift exited ${result.status} for pid ${pid}: ${result.stderr.trim()}`,
    )
  }
  if (result.stderr.trim().length > 0) {
    throw new Error(
      `window-layer.swift wrote to stderr for pid ${pid} — the window list may be ` +
        `incomplete (screen-recording permission?): ${result.stderr.trim()}`,
    )
  }
  return result.stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ObservedWindow)
}

/**
 * The layer of the single plugin window owned by `pid`.
 *
 * 🔴 Throws when the count is not exactly one. A plugin child that owns two windows
 * (or none) makes "the layer" meaningless, and silently picking the first would let
 * a broken state pass as a number.
 */
export function soloWindowLayer(pid: number): number {
  const observed = observeWindows(pid)
  const named = observed.filter((window) => window.name.length > 0)
  if (observed.length > 0 && named.length === 0) {
    throw new Error(
      `all ${observed.length} windows for pid ${pid} have empty names; ` +
        'grant Screen Recording permission to the process running this test. ' +
        `Unfiltered windows: ${JSON.stringify(observed)}`,
    )
  }
  if (named.length !== 1) {
    throw new Error(
      `expected exactly 1 named window for pid ${pid}, got ${named.length}. ` +
        `Named windows: ${JSON.stringify(named)}. ` +
        `Unfiltered windows: ${JSON.stringify(observed)}`,
    )
  }
  return named[0]!.layer
}
