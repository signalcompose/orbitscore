const fs = require('fs')
const buf = fs.readFileSync(process.argv[2])
let p = 0
const u32 = () => { const v = buf.readUInt32BE(p); p += 4; return v }
const u16 = () => { const v = buf.readUInt16BE(p); p += 2; return v }
const u8  = () => buf[p++]
// header
if (buf.toString('ascii', 0, 4) !== 'MThd') throw new Error('not SMF')
p = 4; u32(); const fmt = u16(); const ntrk = u16(); const div = u16()
const vlq = () => { let v = 0, c; do { c = u8(); v = (v << 7) | (c & 0x7f) } while (c & 0x80); return v }
const notes = []
for (let t = 0; t < ntrk; t++) {
  if (buf.toString('ascii', p, p + 4) !== 'MTrk') break
  p += 4; const len = u32(); const end = p + len
  let tick = 0, status = 0
  const on = {} // key note|ch -> [startTick, vel]
  while (p < end) {
    tick += vlq()
    let b = buf[p]
    if (b & 0x80) { status = b; p++ } // new status, else running status
    const type = status & 0xf0, ch = status & 0x0f
    if (status === 0xff) { const mt = u8(); const l = vlq(); p += l }
    else if (status === 0xf0 || status === 0xf7) { const l = vlq(); p += l }
    else if (type === 0x90) { const n = u8(), v = u8(); if (v > 0) on[n + '|' + ch] = [tick, v]; else { const k = n + '|' + ch; if (on[k]) { notes.push({ tick: on[k][0], note: n, dur: tick - on[k][0], ch }); delete on[k] } } }
    else if (type === 0x80) { const n = u8(); u8(); const k = n + '|' + ch; if (on[k]) { notes.push({ tick: on[k][0], note: n, dur: tick - on[k][0], ch }); delete on[k] } }
    else if (type === 0xc0 || type === 0xd0) { u8() }
    else { u8(); u8() }
  }
  p = end
}
const bar = 4 * div // 4/4
const maxTick = bar * 8
notes.sort((a, b) => a.tick - b.tick || a.note - b.note)
console.log(`format ${fmt} tracks ${ntrk} div ${div} (bar=${bar} ticks)`)
const NN = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
const name = (n) => NN[n % 12] + (Math.floor(n / 12) - 1)
for (const e of notes) {
  if (e.tick >= maxTick) break
  const barNo = Math.floor(e.tick / bar) + 1
  const beat = ((e.tick % bar) / div).toFixed(2)
  console.log(`bar${barNo} beat${beat}\t${name(e.note)} (${e.note})\tdur ${(e.dur/div).toFixed(2)}q\tch${e.ch}`)
}
