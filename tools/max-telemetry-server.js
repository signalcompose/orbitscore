#!/usr/bin/env node
/*
 Max Telemetry UDP Server
 - Listens on 127.0.0.1:7474
 - Appends each received line (expected JSON) to logs/max-telemetry-YYYYMMDD.jsonl
 - Creates logs/ if missing
*/
const dgram = require('dgram')
const fs = require('fs')
const path = require('path')

const HOST = '127.0.0.1'
const PORT = 7474

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function logPath() {
  const ts = new Date()
  const y = ts.getFullYear()
  const m = String(ts.getMonth() + 1).padStart(2, '0')
  const d = String(ts.getDate()).padStart(2, '0')
  return path.join(process.cwd(), 'logs', `max-telemetry-${y}${m}${d}.jsonl`)
}

ensureDir(path.join(process.cwd(), 'logs'))
const file = logPath()
console.log(`[max-telemetry] Writing to ${file}`)

const socket = dgram.createSocket('udp4')
socket.on('error', (err) => {
  console.error(`[max-telemetry] UDP error: ${err.message}`)
  socket.close()
})

socket.on('message', (msg, rinfo) => {
  const now = Date.now()
  let line = null

  // Try to interpret as OSC bundle/message carrying a single string arg
  // Very small OSC parser for address + typetags + 1 string argument
  function parseOSC(buf) {
    // Helper to read a null-terminated, 4-byte aligned string
    const readPaddedString = (offset) => {
      let end = offset
      while (end < buf.length && buf[end] !== 0) end++
      const str = buf.slice(offset, end).toString('utf8')
      // advance to next multiple of 4
      let next = end + 1
      while (next % 4 !== 0) next++
      return { str, next }
    }
    try {
      // Address
      const a = readPaddedString(0)
      if (!a.str.startsWith('/')) return null
      // Type tag string
      const t = readPaddedString(a.next)
      if (!t.str.startsWith(',')) return null
      // We only handle one string argument (',s')
      if (!t.str.includes('s')) return null
      const arg = readPaddedString(t.next)
      return arg.str
    } catch (_) {
      return null
    }
  }

  // Prefer OSC payload string if present, else fall back to raw text
  const oscStr = parseOSC(msg)
  if (oscStr && oscStr.length) {
    try {
      const parsed = JSON.parse(oscStr)
      if (typeof parsed.t !== 'number') parsed.t = now
      line = JSON.stringify(parsed)
    } catch {
      line = JSON.stringify({ t: now, raw: oscStr })
    }
  } else {
    const raw = msg.toString('utf8').trim()
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw)
        if (typeof parsed.t !== 'number') parsed.t = now
        line = JSON.stringify(parsed)
      } catch {
        line = JSON.stringify({ t: now, raw })
      }
    } else {
      line = JSON.stringify({ t: now, raw })
    }
  }
  fs.appendFile(file, line + '\n', () => {})
})

socket.bind(PORT, HOST, () => {
  console.log(`[max-telemetry] Listening on udp://${HOST}:${PORT}`)
})
