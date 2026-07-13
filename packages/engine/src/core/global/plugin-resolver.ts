/**
 * Plugin path resolver.
 *
 * Shared extension-validation + path-resolution logic for `.clap` plugin
 * specs. Extracted from `PluginEffectManager` (`global.effect()`) so #427's
 * `seq.instrument()` can reuse the same validation + resolution without
 * duplicating it.
 *
 * Order (unchanged from the previous inline implementation): extension
 * validation first, then `resolvePathDirect`. Error messages are identical.
 */

import path from 'node:path'

import { resolvePathDirect } from './audio-resolver'

export function resolvePluginPath(
  spec: string,
  audioPaths: readonly string[],
  documentDirectory: string,
): string {
  validateExtension(spec)
  return resolvePathDirect(spec, audioPaths, documentDirectory)
}

function validateExtension(spec: string): void {
  const extension = path.extname(spec).toLowerCase()
  if (extension === '.clap') return
  if (extension === '.vst3' || extension === '.component') {
    throw new Error(
      `${extension} plugins are not yet supported (reserved for future VST3/AU support).`,
    )
  }
  throw new Error(`Unknown plugin extension "${extension || '(none)'}"; expected .clap.`)
}
