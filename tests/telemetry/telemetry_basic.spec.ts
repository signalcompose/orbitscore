import * as fs from 'fs'
import * as path from 'path'

import { describe, it, expect } from 'vitest'

import { parseJsonl, computeMetrics, checkBasicSanity } from './analyzer'

function readLog(): string {
  const envPath = process.env.TELEMETRY_LOG?.trim()
  if (envPath && fs.existsSync(envPath)) return fs.readFileSync(envPath, 'utf8')
  const fixture = path.join(__dirname, '..', 'fixtures', 'telemetry', 'sample.jsonl')
  return fs.readFileSync(fixture, 'utf8')
}

describe('Max Telemetry basic sanity', () => {
  it('parses JSONL and computes simple metrics', () => {
    const input = readLog()
    const events = parseJsonl(input)
    expect(events.length).toBeGreaterThan(0)
    checkBasicSanity(events)
    const m = computeMetrics(events)
    expect(m.notes).toBeGreaterThan(0)
    expect(m.channels.length).toBeGreaterThan(0)
  })
})
