import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  createRenderScore,
  parseRenderScore,
  serializeRenderScore,
  type RenderScore,
} from '../../../packages/engine/src/audio/rust-engine/render-score'

/**
 * 🔴 wire 契約の**単一の正本**。この同じファイルを daemon 側
 * （`orbit-audio-daemon/src/session.rs` の `render_score_accepts_the_manifest_the_engine_emits`）が
 * `include_str!` で読み、`validate_render_score_params` に通す。
 *
 * **なぜ共有 fixture が要るか**（2026-08-01・main の変異検証で発見）: TS 側の
 * round-trip（TS 生成 → TS 検証）と Rust 側の検証（手書き JSON）は**互いを見ていない**。
 * `out_dir` を **TS 側だけ**一貫して `outDir` にリネームする変異は、
 * **TS 19 passed / Rust 4 passed** で完全に生き残った — engine が daemon の受け付けない
 * payload を出す状態が、両側緑のまま成立してしまう。
 *
 * P1 の受け入れ基準は「manifest の round-trip（**TS 生成 → daemon 検証**）」であり、
 * 両側が別々の fixture を検証している限りその基準は満たされない。
 */
const WIRE_FIXTURE = join(__dirname, '../../fixtures/render-score-manifest.json')

function manifest(): RenderScore {
  return {
    sample_rate: 48_000,
    duration_sec: 12,
    block_frames: 128,
    samples: [{ name: 'kick', path: '/score/audio/kick.wav' }],
    buses: [
      {
        name: '1',
        chain: [
          {
            plugin: '/plugins/Glue.vst3',
            plugin_id: 'com.example.glue',
            target: { role: 'effect', bus: '1' },
            state: '/score/states/glue.state',
          },
        ],
      },
    ],
    master: { chain: [] },
    events: [
      {
        start_sec: 0.25,
        sample: 'kick',
        gain: 0.8,
        pan: -0.25,
        offset_sec: 0,
        duration_sec: 0.5,
        rate: 1,
        bus: '1',
      },
    ],
    out_dir: '/score/render',
  }
}

describe('RenderScore manifest (#598 P1)', () => {
  it('emits exactly the wire payload the daemon validates', () => {
    const emitted = JSON.parse(serializeRenderScore(createRenderScore(manifest())))
    const fixture = JSON.parse(readFileSync(WIRE_FIXTURE, 'utf8'))

    // 🔴 このアサーションが落ちたら、**engine が出す JSON と daemon が受理する JSON が
    // 食い違った**ということ。fixture を engine 側に合わせて更新するだけでは不十分で、
    // daemon 側（session.rs の validate_render_score_params）が新しい形を受理するかを
    // 必ず確認すること — fixture は両側が読む単一の正本である。
    expect(emitted).toEqual(fixture)
  })

  it('round-trips every required field from TS generation through wire validation', () => {
    const generated = createRenderScore(manifest())
    const parsed = parseRenderScore(serializeRenderScore(generated))

    expect(parsed).toEqual(generated)
    expect(parsed.buses[0].chain[0].state).toBe('/score/states/glue.state')
    expect(parsed.events[0]).toMatchObject({ sample: 'kick', bus: '1', duration_sec: 0.5 })
  })

  it.each([
    'sample_rate',
    'duration_sec',
    'block_frames',
    'samples',
    'buses',
    'master',
    'events',
    'out_dir',
  ] as const)('rejects a dropped top-level field: %s', (field) => {
    const value = manifest() as unknown as Record<string, unknown>
    delete value[field]
    expect(() => parseRenderScore(JSON.stringify(value))).toThrow(/required/)
  })

  it.each(['start_sec', 'sample', 'gain', 'pan', 'offset_sec', 'duration_sec', 'rate', 'bus'])(
    'rejects a dropped event field: %s',
    (field) => {
      const value = manifest() as unknown as { events: Record<string, unknown>[] }
      delete value.events[0][field]
      expect(() => parseRenderScore(JSON.stringify(value))).toThrow(/required/)
    },
  )

  // 🔴 重複名の検査（2026-08-01・main の変異検証で発見）: `ensureUnique` の
  // `seen.has(name)` を無効化する変異が **20 passed のまま生き残った**。
  // 重複した宣言名は「どちらが勝つか」が manifest の解釈依存になり、
  // events の参照先が silent に入れ替わる（レンダ結果が宣言順に依存する）。
  it('rejects duplicate sample names', () => {
    const duplicated = manifest()
    duplicated.samples = [
      { name: 'kick', path: '/score/audio/kick.wav' },
      { name: 'kick', path: '/score/audio/other.wav' },
    ]
    expect(() => createRenderScore(duplicated)).toThrow(/duplicates sample "kick"/)
  })

  it('rejects duplicate bus names', () => {
    const duplicated = manifest()
    duplicated.buses = [
      { name: '1', chain: [] },
      { name: '1', chain: [] },
    ]
    expect(() => createRenderScore(duplicated)).toThrow(/duplicates bus "1"/)
  })

  it('rejects undeclared sample and bus references', () => {
    const badSample = manifest()
    badSample.events[0].sample = 'missing'
    expect(() => createRenderScore(badSample)).toThrow(/undeclared sample/)

    const badBus = manifest()
    badBus.events[0].bus = '2'
    expect(() => createRenderScore(badBus)).toThrow(/undeclared bus/)
  })

  it('shares GetPluginState target vocabulary and pins bus-chain matching', () => {
    const omittedBus = manifest()
    omittedBus.buses[0].chain[0].target = { role: 'effect' }
    expect(() => createRenderScore(omittedBus)).not.toThrow()

    const wrongBus = manifest()
    wrongBus.buses[0].chain[0].target = { role: 'effect', bus: '2' }
    expect(() => createRenderScore(wrongBus)).toThrow(/match containing bus/)

    const relativeState = manifest()
    relativeState.buses[0].chain[0].state = 'states/glue.state'
    expect(() => createRenderScore(relativeState)).toThrow(/absolute path/)
  })
})
