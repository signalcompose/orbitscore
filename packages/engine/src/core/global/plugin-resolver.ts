/**
 * Plugin path resolver.
 *
 * Shared extension-validation + path-resolution logic for `.clap` plugin
 * specs. Extracted from `PluginEffectManager` (`global.effect()`) so #427's
 * `seq.instrument()` can reuse the same validation + resolution without
 * duplicating it.
 *
 * `resolvePluginPath` validates the extension first, then resolves the path
 * (`resolvePathDirect`) — this single entry point always does both, in that
 * order, so callers can't accidentally skip validation. Callers that also
 * need to gate on other state (e.g. `PluginEffectManager.effect()` rejecting
 * while LinkAudio is enabled) should run that check *between* validation and
 * resolution — call `validatePluginExtension(spec)` directly first, do the
 * gating check, then call `resolvePluginPath` (which re-validates; the
 * function is pure so the repeat call is harmless).
 */

import path from 'node:path'

import { resolvePathDirect } from './audio-resolver'

export function resolvePluginPath(
  spec: string,
  audioPaths: readonly string[],
  documentDirectory: string,
): string {
  validatePluginExtension(spec)
  return resolvePathDirect(spec, audioPaths, documentDirectory)
}

export function validatePluginExtension(spec: string): void {
  const extension = path.extname(spec).toLowerCase()
  if (extension === '.clap') return
  if (extension === '.vst3' || extension === '.component') {
    throw new Error(
      `${extension} plugins are not yet supported (reserved for future VST3/AU support).`,
    )
  }
  throw new Error(`Unknown plugin extension "${extension || '(none)'}"; expected .clap.`)
}
