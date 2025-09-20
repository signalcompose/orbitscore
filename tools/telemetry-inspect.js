#!/usr/bin/env node
const fs = require('fs')
const path = require('path')

function readAll(p) {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch (e) {
    console.error(`[inspect] Failed to read ${p}: ${e.message}`)
    process.exit(1)
  }
}

function parseJsonl(input) {
  const lines = input.split(/\r?\n/).filter(Boolean)
  const events = []
  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      if (obj && typeof obj.type === 'string') events.push(obj)
    } catch {}
  }
  return events
}

function metrics(events) {
  const notes = events.filter((e) => e.type === 'note')
  const ccs = events.filter((e) => e.type === 'cc')
  const pbs = events.filter((e) => e.type === 'pb')
  const ts = events.map((e) => e.t || Date.now())
  const span = ts.length ? Math.max(...ts) - Math.min(...ts) : 0
  const nps = span > 0 ? (notes.length * 1000) / span : 0
  const channels = [...new Set(events.map((e) => e.ch || 1))]
  return { count: events.length, notes: notes.length, ccs: ccs.length, pbs: pbs.length, timeSpanMs: span, notesPerSec: Number(nps.toFixed(2)), channels }
}

function findLatestLog(dir = path.join(process.cwd(), 'logs')) {
  if (!fs.existsSync(dir)) return null
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('max-telemetry-') && f.endsWith('.jsonl'))
    .map((f) => path.join(dir, f))
  if (!files.length) return null
  return files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
}

const p = process.argv[2] || process.env.TELEMETRY_LOG || findLatestLog()
if (!p) {
  console.error('[inspect] No log file found. Pass a path or set TELEMETRY_LOG.')
  process.exit(1)
}

const raw = readAll(p)
const evs = parseJsonl(raw)
const m = metrics(evs)
console.log(`[inspect] File: ${p}`)
console.log(`[inspect] Metrics:`, m)
console.log(`[inspect] Sample (last 5):`)
evs.slice(-5).forEach((e) => console.log(e))

