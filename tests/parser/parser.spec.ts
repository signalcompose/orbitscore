import * as fs from 'node:fs'

import { describe, it, expect } from 'vitest'

import { parseSourceToIR } from '../../packages/engine/src/parser/parser'

describe('Parser', () => {
  it('should parse demo.osc correctly', () => {
    const src = fs.readFileSync('../../examples/demo.osc', 'utf8')
    console.log('Demo source loaded:', src.substring(0, 100) + '...')

    const ir = parseSourceToIR(src)
    console.log('Parsed IR:', JSON.stringify(ir, null, 2))

    expect(ir.sequences.length).toBeGreaterThanOrEqual(1)
    expect(ir.global.tempo).toBe(120)
    expect(ir.global.key).toBe('C')
    expect(ir.global.meter.n).toBe(4)
    expect(ir.global.meter.d).toBe(4)
    expect(ir.global.meter.align).toBe('shared')

    console.log('✅ Basic parser test passed!')
  })
})
