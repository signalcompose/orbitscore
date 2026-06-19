#!/usr/bin/env node
// One-off assembler for the IAC(MIDI)+LinkAudio coexistence examples (#209/#278/#283).
// Extracts the *verified* MIDI sequence block verbatim from a midi-monitor source
// and wraps it with a LinkAudio-enabled global header + a per-file drum block.
// Keeps the auto-transcription untouched so the rendered pitches stay correct.

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')

/** Slice the MIDI sequence block (first `var ... = init global.seq` … line before LOOP). */
function extractMidiBlock(srcPath) {
  const lines = fs.readFileSync(srcPath, 'utf8').split('\n')
  const firstVar = lines.findIndex((l) => /^var\s+\w+\s*=\s*init\s+global\.seq/.test(l))
  const loopIdx = lines.findIndex((l) => /^LOOP\(/.test(l))
  if (firstVar === -1 || loopIdx === -1 || loopIdx <= firstVar) {
    throw new Error(`cannot locate MIDI block in ${srcPath}`)
  }
  // Trim trailing blank lines between the play() close and LOOP.
  let end = loopIdx - 1
  while (end > firstVar && lines[end].trim() === '') end--
  return lines.slice(firstVar, end + 1).join('\n')
}

function build({ src, out, header, midiSeqName, drums, loopExtras }) {
  const midiBlock = extractMidiBlock(path.join(ROOT, src))
  const content = `${header}
${midiBlock}

${drums}
LOOP(${midiSeqName}, ${loopExtras})
`
  fs.writeFileSync(path.join(ROOT, out), content)
  console.log(`wrote ${out} (${content.split('\n').length} lines)`)
}

// ---- Chorale: 4/4, tempo 60, key D — single chordal voice `choir` on IAC ch1. ----
// Drum groove distinct from example 19: hat on quarters (not eighths), kick with a
// subdivided beat 3, "ride" (open hat) on beat 3. Four LinkAudio channels.
build({
  src: 'tools/midi-monitor/chorale.orbs',
  out: 'examples/21_chorale_linkaudio.orbs',
  midiSeqName: 'choir',
  loopExtras: 'kick, snare, hat, ride',
  header: `// Bach Chorale + LinkAudio coexistence — OrbitScore v2.0.0-dev (#209/#278/#283)
//
// IAC (MIDI): «O Haupt voll Blut und Wunden» 8小節を [ ] 和音で IAC ch1 へ (choir)。
// LinkAudio (Audio): ドラム4ch。本ファイル固有の 4/4 グルーヴ
//   (hat=4分, kick=3拍目を分割, ride=3拍目) — 例19/ジムノペティとは別パターン。
//
// 前提: Ableton Live 12.4+ (Link + Link Audio 有効, SR 48000)。
//   #283 によりこのファイルの global.tempo(60) が Link tempo を駆動 → Live は自動追従。
//   テンポは OrbitScore 側で設定し、Live のテンポは触らない (last-setter-wins)。
//   MIDI トラック x1 = IAC ch1。Audio トラック x4 = OrbitScore の kick/snare/hat/ride。
// 注: サンプルは差し替え前提のプレースホルダ (test-assets のドラム音)。
var global = init GLOBAL
global.tempo(60)
global.beat(4 by 4)
global.key("D")
global.linkAudio()
global.start()
`,
  drums: `// === LinkAudio drums (4/4, chorale-specific groove) ===
var kick = init global.seq
kick.length(1)
kick.audio("../test-assets/audio/kick.wav").output("kick")
kick.play(1, 0, (1, 0), 0)

var snare = init global.seq
snare.length(1)
snare.audio("../test-assets/audio/snare.wav").output("snare")
snare.play(0, 1, 0, 1)

var hat = init global.seq
hat.length(1)
hat.audio("../test-assets/audio/hihat_closed.wav").output("hat")
hat.play(1, 1, 1, 1)

var ride = init global.seq
ride.length(1)
ride.audio("../test-assets/audio/hihat_open.wav").output("ride")
ride.play(0, 0, 1, 0)
`,
})

// ---- Gymnopédie No.1: 3/4, tempo 66, key D — single chordal voice `piano` on IAC ch1. ----
// Drum groove is a 3/4 waltz (3 slots/bar) — structurally distinct from the 4/4
// files: kick on beat 1, rim on beats 2+3 (oom-pah-pah), bell on beat 3.
build({
  src: 'tools/midi-monitor/gymnopedie.orbs',
  out: 'examples/20_gymnopedie_linkaudio.orbs',
  midiSeqName: 'piano',
  loopExtras: 'kick, rim, hat, bell',
  header: `// Satie Gymnopédie No.1 + LinkAudio coexistence — OrbitScore v2.0.0-dev (#209/#278/#283)
//
// IAC (MIDI): Gymnopédie No.1 全曲 (78小節) を [ ] 和音で IAC ch1 へ (piano)。
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
`,
  drums: `// === LinkAudio drums (3/4 waltz, gymnopédie-specific groove) ===
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
`,
})
