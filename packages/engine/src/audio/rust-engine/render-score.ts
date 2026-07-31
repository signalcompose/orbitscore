import path from 'node:path'

import type { PluginStateSaveTarget } from '../types'

import { wireObject } from './wire-validation'

export interface RenderScoreSample {
  name: string
  path: string
}

export interface RenderScorePlugin {
  plugin: string
  plugin_id?: string
  target: PluginStateSaveTarget
  /** Absolute state file path resolved from project.yaml before manifest creation (P0-C). */
  state?: string
}

export interface RenderScoreBus {
  /** Canonical decimal render-bus name ("1".."16"). */
  name: string
  chain: RenderScorePlugin[]
}

export interface RenderScoreMaster {
  chain: RenderScorePlugin[]
}

export interface RenderScoreEvent {
  start_sec: number
  sample: string
  gain: number
  pan: number
  offset_sec: number
  duration_sec: number
  rate: number
  bus: string
}

/** Self-contained P1 wire manifest accepted by the daemon's RenderScore RPC. */
export interface RenderScore {
  sample_rate: number
  duration_sec: number
  block_frames: number
  samples: RenderScoreSample[]
  buses: RenderScoreBus[]
  master: RenderScoreMaster | null
  events: RenderScoreEvent[]
  out_dir: string
}

const TOP_LEVEL_FIELDS = [
  'sample_rate',
  'duration_sec',
  'block_frames',
  'samples',
  'buses',
  'master',
  'events',
  'out_dir',
] as const

/**
 * 宣言名の一意性を検査して登録する。samples / buses が同じ規約を共有する
 * （3つ目の宣言種別が増えても同じ形を複製しない）。daemon 側 `insert_unique` と対。
 */
function ensureUnique(seen: Set<string>, name: string, kind: string, location: string): void {
  if (seen.has(name)) throw new Error(`${location}.name duplicates ${kind} "${name}"`)
  seen.add(name)
}

function exactFields(
  object: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  location: string,
): void {
  for (const field of required) {
    if (!Object.prototype.hasOwnProperty.call(object, field)) {
      throw new Error(`${location}.${field} is required`)
    }
  }
  const allowed = new Set([...required, ...optional])
  for (const field of Object.keys(object)) {
    if (!allowed.has(field)) throw new Error(`${location}.${field} is not supported`)
  }
}

function nonEmptyString(value: unknown, location: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${location} must be a non-empty string`)
  }
  return value
}

function finiteNumber(value: unknown, location: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${location} must be a finite number`)
  }
  return value
}

function positiveInteger(value: unknown, location: string): number {
  const number = finiteNumber(value, location)
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${location} must be a positive integer`)
  }
  return number
}

function renderBusName(value: unknown, location: string): string {
  const name = nonEmptyString(value, location)
  if (!/^(?:[1-9]|1[0-6])$/.test(name)) {
    throw new Error(`${location} must be a canonical render bus name from "1" to "16"`)
  }
  return name
}

function pluginTarget(value: unknown, location: string, expectedBus: string | undefined): void {
  const target = wireObject(value, location)
  exactFields(target, ['role'], ['bus', 'instance'], location)
  if (target.role !== 'effect') {
    throw new Error(`${location}.role must be "effect" in a P1 render chain`)
  }
  if (Object.prototype.hasOwnProperty.call(target, 'instance')) {
    throw new Error(`${location}.instance is only valid for role="instrument"`)
  }
  if (expectedBus === undefined) {
    if (Object.prototype.hasOwnProperty.call(target, 'bus')) {
      throw new Error(`${location}.bus is not valid for the master chain`)
    }
    return
  }
  if (target.bus !== undefined && nonEmptyString(target.bus, `${location}.bus`) !== expectedBus) {
    throw new Error(`${location}.bus must match containing bus "${expectedBus}"`)
  }
}

function pluginChain(value: unknown, location: string, expectedBus: string | undefined): void {
  if (!Array.isArray(value)) throw new Error(`${location} must be an array`)
  value.forEach((entry, index) => {
    const entryLocation = `${location}[${index}]`
    const plugin = wireObject(entry, entryLocation)
    exactFields(plugin, ['plugin', 'target'], ['plugin_id', 'state'], entryLocation)
    const pluginPath = nonEmptyString(plugin.plugin, `${entryLocation}.plugin`)
    if (!path.isAbsolute(pluginPath)) {
      throw new Error(`${entryLocation}.plugin must be an absolute path`)
    }
    if (plugin.plugin_id !== undefined) {
      nonEmptyString(plugin.plugin_id, `${entryLocation}.plugin_id`)
    }
    if (plugin.state !== undefined) {
      const state = nonEmptyString(plugin.state, `${entryLocation}.state`)
      if (!path.isAbsolute(state))
        throw new Error(`${entryLocation}.state must be an absolute path`)
    }
    pluginTarget(plugin.target, `${entryLocation}.target`, expectedBus)
  })
}

/** Validates the exact P1 wire shape and all cross-references. */
export function validateRenderScore(value: unknown): asserts value is RenderScore {
  const score = wireObject(value, 'RenderScore')
  exactFields(score, TOP_LEVEL_FIELDS, [], 'RenderScore')

  positiveInteger(score.sample_rate, 'RenderScore.sample_rate')
  const duration = finiteNumber(score.duration_sec, 'RenderScore.duration_sec')
  if (duration <= 0) throw new Error('RenderScore.duration_sec must be greater than zero')
  positiveInteger(score.block_frames, 'RenderScore.block_frames')
  nonEmptyString(score.out_dir, 'RenderScore.out_dir')

  if (!Array.isArray(score.samples)) throw new Error('RenderScore.samples must be an array')
  const sampleNames = new Set<string>()
  score.samples.forEach((entry, index) => {
    const location = `RenderScore.samples[${index}]`
    const sample = wireObject(entry, location)
    exactFields(sample, ['name', 'path'], [], location)
    const name = nonEmptyString(sample.name, `${location}.name`)
    nonEmptyString(sample.path, `${location}.path`)
    ensureUnique(sampleNames, name, 'sample', location)
  })

  if (!Array.isArray(score.buses)) throw new Error('RenderScore.buses must be an array')
  const busNames = new Set<string>()
  score.buses.forEach((entry, index) => {
    const location = `RenderScore.buses[${index}]`
    const bus = wireObject(entry, location)
    exactFields(bus, ['name', 'chain'], [], location)
    const name = renderBusName(bus.name, `${location}.name`)
    ensureUnique(busNames, name, 'bus', location)
    pluginChain(bus.chain, `${location}.chain`, name)
  })

  if (score.master !== null) {
    const master = wireObject(score.master, 'RenderScore.master')
    exactFields(master, ['chain'], [], 'RenderScore.master')
    pluginChain(master.chain, 'RenderScore.master.chain', undefined)
  }

  if (!Array.isArray(score.events)) throw new Error('RenderScore.events must be an array')
  score.events.forEach((entry, index) => {
    const location = `RenderScore.events[${index}]`
    const event = wireObject(entry, location)
    exactFields(
      event,
      ['start_sec', 'sample', 'gain', 'pan', 'offset_sec', 'duration_sec', 'rate', 'bus'],
      [],
      location,
    )
    const start = finiteNumber(event.start_sec, `${location}.start_sec`)
    if (start < 0 || start >= duration) {
      throw new Error(`${location}.start_sec must be within [0, RenderScore.duration_sec)`)
    }
    const sample = nonEmptyString(event.sample, `${location}.sample`)
    if (!sampleNames.has(sample)) throw new Error(`${location}.sample references undeclared sample`)
    finiteNumber(event.gain, `${location}.gain`)
    finiteNumber(event.pan, `${location}.pan`)
    const offset = finiteNumber(event.offset_sec, `${location}.offset_sec`)
    const eventDuration = finiteNumber(event.duration_sec, `${location}.duration_sec`)
    const rate = finiteNumber(event.rate, `${location}.rate`)
    if (offset < 0) throw new Error(`${location}.offset_sec must be non-negative`)
    if (eventDuration < 0) throw new Error(`${location}.duration_sec must be non-negative`)
    if (rate <= 0) throw new Error(`${location}.rate must be greater than zero`)
    const bus = renderBusName(event.bus, `${location}.bus`)
    if (!busNames.has(bus)) throw new Error(`${location}.bus references undeclared bus`)
  })
}

export function createRenderScore(value: RenderScore): RenderScore {
  validateRenderScore(value)
  return value
}

export function serializeRenderScore(value: RenderScore): string {
  validateRenderScore(value)
  return JSON.stringify(value)
}

export function parseRenderScore(serialized: string): RenderScore {
  const value: unknown = JSON.parse(serialized)
  validateRenderScore(value)
  return value
}
