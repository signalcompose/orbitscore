/**
 * Audio sample spec resolver.
 *
 * Pure helpers used by AudioManager / Sequence.audio() to turn a user-supplied
 * spec string into an absolute file path. Three resolution modes:
 *
 * 1. Path-direct  — spec starts with `./`, `../`, `~/`, `/` or contains `/`.
 *                   Existing path semantics are preserved; `~/` is expanded.
 *
 * 2. Bank lookup  — bare name (no separator). Searches each entry of
 *                   `audioPaths` for a folder matching the bank name and
 *                   returns the sorted Nth audio file inside it. The Nth
 *                   variant can be selected with `bd:2` syntax.
 *
 * 3. Legacy fallback — bare name with audio extension (e.g. "kick.wav").
 *                   When bank lookup fails, behaves like the pre-#221
 *                   `audioPath(string) + audio("file.wav")` join, so
 *                   existing `.orbs` files keep working.
 *
 * Resolution failures throw — the caller decides how to surface them.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const AUDIO_EXTENSIONS = /\.(wav|aif|aiff|mp3|mp4|flac)$/i

export function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

export function looksLikePath(spec: string): boolean {
  return (
    spec.startsWith('./') ||
    spec.startsWith('../') ||
    spec.startsWith('~/') ||
    spec.startsWith('/') ||
    spec.includes('/')
  )
}

export interface ResolveAudioOptions {
  spec: string
  audioPaths: readonly string[]
  documentDirectory: string
  cache: Map<string, string>
}

export function resolveAudio(options: ResolveAudioOptions): string {
  const { spec, audioPaths, documentDirectory, cache } = options

  const cacheKey = `${audioPaths.join('|')}::${documentDirectory}::${spec}`
  const cached = cache.get(cacheKey)
  if (cached !== undefined) return cached

  const result = looksLikePath(spec)
    ? resolvePathDirect(spec, audioPaths, documentDirectory)
    : resolveBareName(spec, audioPaths, documentDirectory)

  cache.set(cacheKey, result)
  return result
}

function resolvePathDirect(
  spec: string,
  audioPaths: readonly string[],
  documentDirectory: string,
): string {
  const expanded = expandHome(spec)
  if (path.isAbsolute(expanded)) return expanded
  if (documentDirectory) return path.resolve(documentDirectory, expanded)
  if (audioPaths.length > 0) return path.resolve(audioPaths[0]!, expanded)
  throw new Error(
    `Cannot resolve relative audio("${spec}"): no audioPath() or document context. ` +
      `Set audioPath() first, save the .orbs file, or use an absolute path.`,
  )
}

function resolveBareName(
  spec: string,
  audioPaths: readonly string[],
  documentDirectory: string,
): string {
  const colonIdx = spec.indexOf(':')
  const hasIndex = colonIdx !== -1
  const bank = hasIndex ? spec.slice(0, colonIdx) : spec
  const idxStr = hasIndex ? spec.slice(colonIdx + 1) : '0'
  const variantIdx = Number(idxStr)
  if (
    hasIndex &&
    (!Number.isFinite(variantIdx) || variantIdx < 0 || !Number.isInteger(variantIdx))
  ) {
    throw new Error(
      `Invalid variant index in audio("${spec}"): "${idxStr}" must be a non-negative integer.`,
    )
  }

  if (audioPaths.length === 0) {
    if (!hasIndex && AUDIO_EXTENSIONS.test(spec) && documentDirectory) {
      return path.resolve(documentDirectory, spec)
    }
    throw new Error(
      `Cannot resolve audio("${spec}"): no audioPath() or document context. ` +
        `Use global.audioPath("path1", "path2", ...) to register sample directories, ` +
        `save the .orbs file, or use an absolute path.`,
    )
  }

  // Bank lookup: try each search path for a folder named `bank`
  for (const root of audioPaths) {
    const folder = path.join(root, bank)
    const files = listAudioFiles(folder)
    if (files.length > 0) {
      return path.join(folder, files[variantIdx % files.length]!)
    }
  }

  if (hasIndex) {
    throw new Error(
      `Sample bank not found: "${bank}" in audioPath ${JSON.stringify([...audioPaths])}. ` +
        `Create a folder named "${bank}/" with audio files inside.`,
    )
  }

  // Legacy fallback for `audio("kick.wav")`-style bare names with extensions.
  if (AUDIO_EXTENSIONS.test(spec)) {
    for (const root of audioPaths) {
      const filepath = path.join(root, spec)
      if (existsAsFile(filepath)) return filepath
    }
    if (documentDirectory) {
      const filepath = path.resolve(documentDirectory, spec)
      if (existsAsFile(filepath)) return filepath
    }
    return path.join(audioPaths[0]!, spec)
  }

  const banks = listAvailableBanks(audioPaths)
  const hint = banks.length > 0 ? ` Available banks: ${banks.join(', ')}.` : ''
  throw new Error(
    `Sample not found: "${spec}" in audioPath ${JSON.stringify([...audioPaths])}.${hint}`,
  )
}

function listAudioFiles(folder: string): string[] {
  try {
    if (!fs.statSync(folder).isDirectory()) return []
    return fs
      .readdirSync(folder)
      .filter((f) => AUDIO_EXTENSIONS.test(f))
      .sort()
  } catch {
    return []
  }
}

function existsAsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function listAvailableBanks(audioPaths: readonly string[]): string[] {
  const banks = new Set<string>()
  for (const root of audioPaths) {
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) banks.add(entry.name)
      }
    } catch {
      // unreadable root — skip
    }
  }
  return [...banks].sort()
}
