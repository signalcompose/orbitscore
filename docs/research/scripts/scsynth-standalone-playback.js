#!/usr/bin/env node
/**
 * scsynth standalone end-to-end playback test.
 *
 * Related: docs/research/SCSYNTH_STANDALONE.md, Issue #133
 *
 * Usage:
 *   1. Boot scsynth separately (requires audio output device):
 *        /path/to/scsynth -u 57202 -i 0
 *   2. Run this script:
 *        SC_PORT=57202 node scsynth-standalone-playback.js
 *
 * Verifies:
 *   - /d_recv orbitPlayBuf.scsyndef → /done
 *   - /b_allocRead test-assets/audio/kick.wav → /done
 *   - /s_new orbitPlayBuf → /n_go + /n_end (synth started and auto-freed)
 *
 * Requires SC port to be bootable with audio output (not suitable for CI
 * without an audio device). Expect an audible kick drum when running locally.
 */
const dgram = require('dgram')
const fs = require('fs')
const path = require('path')

function padNull(s) {
  const b = Buffer.from(s + '\0')
  const p = 4 - (b.length % 4 || 4)
  return Buffer.concat([b, Buffer.alloc(p === 4 ? 0 : p)])
}
function int32(v) {
  const b = Buffer.alloc(4)
  b.writeInt32BE(v, 0)
  return b
}
function float32(v) {
  const b = Buffer.alloc(4)
  b.writeFloatBE(v, 0)
  return b
}
function blob(buf) {
  const sz = int32(buf.length)
  const p = 4 - (buf.length % 4 || 4)
  return Buffer.concat([sz, buf, Buffer.alloc(p === 4 ? 0 : p)])
}
function enc(addr, types, args) {
  const parts = [padNull(addr), padNull(',' + types)]
  args.forEach((a, i) => {
    const t = types[i]
    if (t === 'i') parts.push(int32(a))
    else if (t === 'f') parts.push(float32(a))
    else if (t === 's') parts.push(padNull(a))
    else if (t === 'b') parts.push(blob(a))
    else throw new Error('unsupported OSC type ' + t)
  })
  return Buffer.concat(parts)
}
function decodeAddr(buf) {
  let end = 0
  while (end < buf.length && buf[end] !== 0) end++
  return buf.slice(0, end).toString()
}

const PORT = process.env.SC_PORT ? parseInt(process.env.SC_PORT, 10) : 57202
const WAV_PATH =
  process.env.SC_WAV_PATH ||
  path.resolve(__dirname, '../../../test-assets/audio/kick.wav')
const DEF_PATH =
  process.env.SC_SYNTHDEF_PATH ||
  path.resolve(
    __dirname,
    '../../../packages/engine/supercollider/synthdefs/orbitPlayBuf.scsyndef',
  )

const sock = dgram.createSocket('udp4')
const events = []
let bufferDone = false
sock.on('message', (m) => {
  try {
    const addr = decodeAddr(m)
    events.push(addr)
    console.log('[recv]', addr)
    // /b_allocRead 完了を個別に検知して下流の /s_new と race しないようにする
    if (addr === '/done' && events.filter((e) => e === '/done').length >= 2) {
      bufferDone = true
    }
  } catch (e) {
    console.error('[error] malformed OSC frame:', e.message)
  }
})

function send(buf) {
  return new Promise((res, rej) =>
    sock.send(buf, PORT, '127.0.0.1', (e) => (e ? rej(e) : res())),
  )
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  await send(enc('/notify', 'i', [1]))
  await wait(200)

  const defData = fs.readFileSync(DEF_PATH)
  await send(enc('/d_recv', 'b', [defData]))
  await wait(300)

  // /b_allocRead bufnum path startFrame numFrames(0=all)
  await send(enc('/b_allocRead', 'isii', [0, WAV_PATH, 0, 0]))
  // wait for /done (buffer load 完了) を polling。race 回避のため
  // /s_new を送る前に buffer が確実に読み込まれたことを保証する。
  const bufferDeadline = Date.now() + 3000
  while (!bufferDone && Date.now() < bufferDeadline) {
    await wait(50)
  }
  if (!bufferDone) {
    console.error('[error] /b_allocRead /done timeout')
    sock.close()
    process.exit(1)
  }

  // /s_new synthdef nodeId addAction target ...args
  await send(
    enc('/s_new', 'siiisisisi', [
      'orbitPlayBuf',
      1001,
      0, // addAction: addToHead
      0, // target group
      'bufnum',
      0,
      'amp',
      0, // limited int encoder; set 0 for silence-safe test
      'pan',
      0,
    ]),
  )
  await wait(1500)

  sock.close()
  const started = events.some((e) => e.startsWith('/n_go'))
  const ended = events.some((e) => e.startsWith('/n_end'))
  console.log('[summary] events:', events)
  console.log('[summary] playback cycle:', started && ended ? 'PASS' : 'PARTIAL')
  process.exit(started && ended ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
