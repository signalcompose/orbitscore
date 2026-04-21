#!/usr/bin/env node
/**
 * scsynth standalone boot verification test.
 *
 * Related: docs/research/SCSYNTH_STANDALONE.md, Issue #133
 *
 * Usage:
 *   1. Boot scsynth separately:
 *        /path/to/scsynth -u 57202 -i 0
 *   2. Run this script (SC_PORT overrides default 57202):
 *        SC_PORT=57202 node scsynth-standalone-boot.js
 *
 * Verifies:
 *   - /status → /status.reply round-trip
 *   - /d_recv of orbitPlayBuf.scsyndef → /done
 *
 * Exit 0 on success, 1 on any OSC timeout or failure.
 */
const dgram = require('dgram')
const fs = require('fs')
const path = require('path')

function padNull(str) {
  const buf = Buffer.from(str + '\0')
  const pad = 4 - (buf.length % 4 || 4)
  return Buffer.concat([buf, Buffer.alloc(pad === 4 ? 0 : pad)])
}
function encodeInt(v) {
  const b = Buffer.alloc(4)
  b.writeInt32BE(v, 0)
  return b
}
function encodeBlob(buf) {
  const sz = Buffer.alloc(4)
  sz.writeInt32BE(buf.length, 0)
  const pad = 4 - (buf.length % 4 || 4)
  return Buffer.concat([sz, buf, Buffer.alloc(pad === 4 ? 0 : pad)])
}
function encodeMessage(addr, types, args) {
  const parts = [padNull(addr), padNull(',' + types)]
  args.forEach((a, i) => {
    const t = types[i]
    if (t === 'i') parts.push(encodeInt(a))
    else if (t === 'b') parts.push(encodeBlob(a))
    else throw new Error('unsupported OSC type ' + t)
  })
  return Buffer.concat(parts)
}
function decodeAddress(buf) {
  let end = 0
  while (buf[end] !== 0 && end < buf.length) end++
  return buf.slice(0, end).toString()
}

const PORT = process.env.SC_PORT ? parseInt(process.env.SC_PORT, 10) : 57202
const DEF_PATH =
  process.env.SC_SYNTHDEF_PATH ||
  path.resolve(
    __dirname,
    '../../../packages/engine/supercollider/synthdefs/orbitPlayBuf.scsyndef',
  )

const socket = dgram.createSocket('udp4')
const flags = { statusReply: false, defLoaded: false }

socket.on('message', (msg) => {
  const addr = decodeAddress(msg)
  console.log('[recv]', addr)
  if (addr === '/status.reply') flags.statusReply = true
  if (addr === '/done') flags.defLoaded = true
})

function send(buf) {
  return new Promise((resolve, reject) => {
    socket.send(buf, PORT, '127.0.0.1', (err) => (err ? reject(err) : resolve()))
  })
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  await send(encodeMessage('/status', '', []))
  await wait(500)
  console.log('[step] /status.reply:', flags.statusReply ? 'OK' : 'NO RESPONSE')

  await send(encodeMessage('/notify', 'i', [1]))
  await wait(200)

  const defData = fs.readFileSync(DEF_PATH)
  console.log('[step] loading', DEF_PATH, 'size=', defData.length)
  await send(encodeMessage('/d_recv', 'b', [defData]))
  await wait(500)
  console.log('[step] /d_recv /done:', flags.defLoaded ? 'OK' : 'NO RESPONSE')

  socket.close()
  const ok = flags.statusReply && flags.defLoaded
  console.log('[summary] boot verification:', ok ? 'PASS' : 'FAIL')
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
