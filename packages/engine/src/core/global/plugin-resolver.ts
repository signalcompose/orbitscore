/**
 * Plugin path resolver.
 *
 * Shared role-aware extension-validation + path-resolution logic for plugin
 * specs.
 *
 * `resolvePluginPath` validates the extension first, then resolves the path
 * (`resolvePathDirect`) — this single entry point always does both, in that
 * order, so callers can't accidentally skip validation. Callers that also
 * need to gate on other state (e.g. `PluginEffectManager.effect()` rejecting
 * while LinkAudio is enabled) should run that check *between* validation and
 * resolution — call `validatePluginExtension(spec, role)` directly first, do the
 * gating check, then call `resolvePluginPath` (which re-validates; the
 * function is pure so the repeat call is harmless).
 */

import path from 'node:path'

import { resolvePathDirect } from './audio-resolver'

export function resolvePluginPath(
  spec: string,
  audioPaths: readonly string[],
  documentDirectory: string,
  role: PluginRole,
): string {
  validatePluginExtension(spec, role)
  return resolvePathDirect(spec, audioPaths, documentDirectory)
}

export type PluginRole = 'effect' | 'instrument'

export function validatePluginExtension(spec: string, role: PluginRole): void {
  const extension = path.extname(spec).toLowerCase()
  if (extension === '.clap') return
  if (extension === '.vst3' && role === 'instrument') return
  if (extension === '.vst3' || extension === '.component') {
    throw new Error(
      `${extension} plugins are not yet supported for ${role} (reserved for future VST3/AU support).`,
    )
  }
  const expected = role === 'instrument' ? '.clap or .vst3' : '.clap'
  throw new Error(`Unknown plugin extension "${extension || '(none)'}"; expected ${expected}.`)
}
