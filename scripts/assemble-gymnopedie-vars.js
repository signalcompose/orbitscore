#!/usr/bin/env node
// Rebuild examples/20_gymnopedie_linkaudio.orbs with the 78-bar piano part
// consolidated via pattern variables (Phase R, decision #17: bare-tuple binding,
// value-passed at eval). 78 bars → 36 unique bars bound to g01..g36, then a
// play() of 78 variable references. Expansion is byte-identical to the inlined
// transcription, so `_` tie / `[ ]` stack semantics are preserved exactly.

const fs = require('fs')
const path = require('path')
const ROOT = path.resolve(__dirname, '..')

// --- Extract the verified bars from the raw transcription. ---
const srcLines = fs
  .readFileSync(path.join(ROOT, 'tools/midi-monitor/gymnopedie.orbs'), 'utf8')
  .split('\n')
const bars = []
for (const l of srcLines) {
  const t = l.trimEnd()
  if (/^\s{2}\(/.test(t)) bars.push(t.replace(/,\s*$/, '').trim())
}
if (bars.length !== 78) throw new Error(`expected 78 bars, got ${bars.length}`)

// --- Assign a variable name to each unique bar (first-occurrence order). ---
const idOf = new Map()
const seq = []
for (const b of bars) {
  if (idOf.has(b) === false) idOf.set(b, idOf.size + 1)
  seq.push(idOf.get(b))
}
const name = (id) => 'g' + String(id).padStart(2, '0')

// Variable definitions in first-occurrence order.
const defs = []
for (const [bar, id] of idOf) defs.push(`var ${name(id)} = ${bar}`)

// play() reference list, formatted to mirror the source's bar rows and annotated
// with the large-scale structure (A / A' repeat / coda) discovered by analysis.
function refRow(fromIdx, count) {
  return '  ' + seq.slice(fromIdx, fromIdx + count).map((id) => name(id)).join(', ')
}
const playBody = [
  '  // --- A section (bars 1-39) ---',
  refRow(0, 13) + ',',
  refRow(13, 13) + ',',
  refRow(26, 13) + ',',
  '  // --- A repeat (bars 40-71 == bars 1-32 verbatim) ---',
  refRow(39, 13) + ',',
  refRow(52, 13) + ',',
  refRow(65, 6) + ',',
  '  // --- coda (bars 72-78) ---',
  refRow(71, 7),
].join('\n')

const content = `// Satie Gymnopédie No.1 + LinkAudio coexistence — OrbitScore v2.0.0-dev (#209/#278/#283)
//
// IAC (MIDI): Gymnopédie No.1 全曲 (78小節) を [ ] 和音で IAC ch1 へ (piano)。
//   78小節中ユニークは36小節。Phase R のパターン変数 (g01..g36) に束縛し、
//   play() は78個の変数参照に圧縮 (値渡し: 展開結果は元のトランスクリプションと同一)。
//   bars 40-71 が bars 1-32 の完全反復であることが構造として見える。
// LinkAudio (Audio): ドラム4ch。本ファイル固有の 3/4 ワルツ (1拍=スロット3つ)
//   kick=1拍目, rim=2+3拍 (ズン・チャ・チャ), bell=3拍目 — 4/4 の例19/コラールとは別パターン。
//
// 前提: Ableton Live 12.4+ (Link + Link Audio 有効, SR 48000)。
//   #283 によりこのファイルの global.tempo(66) が Link tempo を駆動 → Live は自動追従。
//   テンポは OrbitScore 側で設定し、Live のテンポは触らない (last-setter-wins)。
//   MIDI トラック x1 = IAC ch1。Audio トラック x4 = OrbitScore の kick/rim/hat/bell。
// 注: サンプルは差し替え前提のプレースホルダ (test-assets のドラム音)。
var global = init GLOBAL
global.tempo(66)
global.beat(3 by 4)
global.key("D")
global.linkAudio()
global.start()

// === Gymnopédie — 36 unique bars as pattern variables (Phase R) ===
${defs.join('\n')}

var piano = init global.seq
piano.midi("IAC", 1).octave(4).gate(0.95).vel(76)
piano.length(78)
piano.play(
${playBody}
)

// === LinkAudio drums (3/4 waltz, gymnopédie-specific groove) ===
var kick = init global.seq
kick.length(1)
kick.audio("../test-assets/audio/kick.wav").output("kick")
kick.play(1, 0, 0)

var rim = init global.seq
rim.length(1)
rim.audio("../test-assets/audio/snare.wav").output("rim")
rim.play(0, 1, 1)

var hat = init global.seq
hat.length(1)
hat.audio("../test-assets/audio/hihat_closed.wav").output("hat")
hat.play((1, 1), (1, 1), (1, 1))

var bell = init global.seq
bell.length(1)
bell.audio("../test-assets/audio/hihat_open.wav").output("bell")
bell.play(0, 0, 1)

LOOP(piano, kick, rim, hat, bell)
`

fs.writeFileSync(path.join(ROOT, 'examples/20_gymnopedie_linkaudio.orbs'), content)
console.log(
  `wrote examples/20_gymnopedie_linkaudio.orbs: ${idOf.size} unique bar vars, ${seq.length} refs, ${content.split('\n').length} lines`,
)
