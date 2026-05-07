import { describe, it, expect } from 'vitest'

import {
  analyzeAudioPathOrdering,
  analyzeGlobalOncePerFile,
  analyzeOutputWithoutLinkAudio,
} from '../../packages/vscode-extension/src/diagnostics-analysis'

describe('analyzeGlobalOncePerFile', () => {
  it('should return no issues for single occurrence of each state-setter', () => {
    const text = [
      'var global = init GLOBAL',
      'global.tempo(120)',
      'global.beat(4 by 4)',
      'global.audioPath("./audio")',
      'global.start()',
    ].join('\n')

    expect(analyzeGlobalOncePerFile(text)).toEqual([])
  })

  it('should flag the second occurrence of global.tempo()', () => {
    const text = ['global.tempo(120)', 'global.tempo(140)'].join('\n')

    const issues = analyzeGlobalOncePerFile(text)
    expect(issues).toHaveLength(1)
    expect(issues[0].line).toBe(1)
    expect(issues[0].message).toContain('Duplicate global.tempo()')
  })

  it('should flag duplicates per method independently', () => {
    const text = [
      'global.tempo(120)',
      'global.audioPath("./a")',
      'global.tempo(140)',
      'global.audioPath("./b")',
    ].join('\n')

    const issues = analyzeGlobalOncePerFile(text)
    expect(issues).toHaveLength(2)
    expect(issues.find((i) => i.line === 2)?.message).toContain('global.tempo()')
    expect(issues.find((i) => i.line === 3)?.message).toContain('global.audioPath()')
  })

  it('should NOT flag init global.seq (sequence declarations)', () => {
    const text = [
      'var drum = init global.seq',
      'var snare = init global.seq',
      'var hat = init global.seq',
    ].join('\n')

    expect(analyzeGlobalOncePerFile(text)).toEqual([])
  })

  it('should NOT flag uppercase transport commands (LOOP, RUN, MUTE)', () => {
    const text = ['LOOP(drum)', 'RUN(kick)', 'MUTE(snare)', 'LOOP(drum, snare)', 'RUN()'].join('\n')

    expect(analyzeGlobalOncePerFile(text)).toEqual([])
  })

  it('should NOT flag seq.* methods (per-sequence is allowed)', () => {
    const text = ['drum.gain(-6)', 'snare.gain(-3)', 'drum.tempo(140)', 'snare.tempo(120)'].join(
      '\n',
    )

    expect(analyzeGlobalOncePerFile(text)).toEqual([])
  })

  it('should skip full-line comments', () => {
    const text = ['// global.tempo(120)', '// global.tempo(140)', 'global.tempo(100)'].join('\n')

    expect(analyzeGlobalOncePerFile(text)).toEqual([])
  })

  it('should skip inline comments after code (#4)', () => {
    const text = [
      'global.tempo(120) // global.tempo(100) for comparison',
      'global.beat(4 by 4) // also: global.beat(3 by 4)',
    ].join('\n')

    expect(analyzeGlobalOncePerFile(text)).toEqual([])
  })

  it('should detect duplicates across all once-per-file methods', () => {
    const methods = [
      'tempo',
      'beat',
      'audioPath',
      'start',
      'stop',
      'gain',
      'key',
      'normalizer',
      'limiter',
      'compressor',
    ]
    for (const method of methods) {
      const text = `global.${method}(1)\nglobal.${method}(2)`
      const issues = analyzeGlobalOncePerFile(text)
      expect(issues, `method: ${method}`).toHaveLength(1)
      expect(issues[0].message).toContain(`global.${method}()`)
    }
  })
})

describe('analyzeAudioPathOrdering', () => {
  it('should return no issues when audioPath precedes audio()', () => {
    const text = [
      'global.audioPath("./audio")',
      'var drum = init global.seq',
      'drum.audio("kick.wav")',
    ].join('\n')

    expect(analyzeAudioPathOrdering(text)).toEqual([])
  })

  it('should flag relative audio() that appears before audioPath()', () => {
    const text = [
      'var drum = init global.seq',
      'drum.audio("kick.wav")',
      'global.audioPath("./audio")',
    ].join('\n')

    const issues = analyzeAudioPathOrdering(text)
    expect(issues).toHaveLength(1)
    expect(issues[0].line).toBe(1)
    expect(issues[0].message).toContain('declared at line 3')
  })

  it('should flag relative audio() when no audioPath() exists', () => {
    const text = ['var drum = init global.seq', 'drum.audio("kick.wav")'].join('\n')

    const issues = analyzeAudioPathOrdering(text)
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('no audioPath found')
  })

  it('should NOT flag absolute audio() paths', () => {
    const text = [
      'var drum = init global.seq',
      'drum.audio("/abs/kick.wav")',
      'snare.audio("~/sounds/snare.wav")',
    ].join('\n')

    expect(analyzeAudioPathOrdering(text)).toEqual([])
  })

  it('should NOT flag Windows-style absolute paths', () => {
    const text = ['drum.audio("C:\\\\sounds\\\\kick.wav")'].join('\n')

    expect(analyzeAudioPathOrdering(text)).toEqual([])
  })

  it('should NOT flag the audioPath() declaration line itself', () => {
    const text = ['global.audioPath("./samples")'].join('\n')

    expect(analyzeAudioPathOrdering(text)).toEqual([])
  })

  it('should skip audio() in full-line comments', () => {
    const text = ['global.audioPath("./audio")', '// drum.audio("kick.wav") -- old version'].join(
      '\n',
    )

    expect(analyzeAudioPathOrdering(text)).toEqual([])
  })

  it('should skip audio() in inline comments after code (#4)', () => {
    const text = [
      'global.audioPath("./audio")',
      'drum.audio("kick.wav") // alternative: drum.audio("snare.wav")',
    ].join('\n')

    expect(analyzeAudioPathOrdering(text)).toEqual([])
  })

  it('should flag multiple violations independently', () => {
    const text = [
      'a.audio("a.wav")',
      'b.audio("/abs/b.wav")',
      'c.audio("c.wav")',
      'global.audioPath("./samples")',
    ].join('\n')

    const issues = analyzeAudioPathOrdering(text)
    expect(issues).toHaveLength(2)
    expect(issues.map((i) => i.line)).toEqual([0, 2])
  })
})

describe('integration: getting started example', () => {
  // examples/01_getting_started.orbs に近い内容
  const exampleText = [
    '// OrbitScore Getting Started',
    '',
    'var global = init GLOBAL',
    'global.tempo(100)',
    'global.beat(4 by 4)',
    'global.audioPath("./audio")',
    'global.start()',
    '',
    'var drum = init global.seq',
    'drum.beat(5 by 4).length(1)',
    'drum.audio("kick.wav").chop(1)',
    'drum.play(1, 1, 1, 1)',
    '',
    'var snare = init global.seq',
    'snare.beat(4 by 4).length(1)',
    'snare.audio("snare.wav").chop(1)',
    'snare.play(1, 1, 1, 1)',
    '',
    'LOOP(drum, snare)',
    'LOOP()',
  ].join('\n')

  it('should not flag the well-formed example', () => {
    expect(analyzeGlobalOncePerFile(exampleText)).toEqual([])
    expect(analyzeAudioPathOrdering(exampleText)).toEqual([])
  })
})

describe('analyzeOutputWithoutLinkAudio', () => {
  it('returns no issues when global.linkAudio() is declared above seq.output()', () => {
    const text = [
      'global.linkAudio()',
      'var s = init global.seq',
      's.audio("kick.wav").output("kick")',
    ].join('\n')

    expect(analyzeOutputWithoutLinkAudio(text)).toEqual([])
  })

  it('returns no issues when global.linkAudio(SR) declared anywhere in the file', () => {
    // Declared after the .output() call — still counts as "file declares
    // LinkAudio mode" because the analyzer is whole-file.
    const text = ['s.audio("kick.wav").output("kick")', 'global.linkAudio(48000)'].join('\n')

    expect(analyzeOutputWithoutLinkAudio(text)).toEqual([])
  })

  it('flags every .output() when global.linkAudio() is missing', () => {
    const text = [
      'var s1 = init global.seq',
      's1.audio("kick.wav").output("kick")',
      'var s2 = init global.seq',
      's2.audio("snare.wav").output("snare")',
    ].join('\n')

    const issues = analyzeOutputWithoutLinkAudio(text)
    expect(issues).toHaveLength(2)
    expect(issues[0].line).toBe(1)
    expect(issues[0].message).toContain('global.linkAudio()')
    expect(issues[1].line).toBe(3)
  })

  it('ignores commented-out .output() calls', () => {
    const text = ['// s1.audio("kick.wav").output("kick")', 's1.audio("kick.wav").chop(1)'].join(
      '\n',
    )

    expect(analyzeOutputWithoutLinkAudio(text)).toEqual([])
  })

  it('ignores commented-out global.linkAudio() (still flags real .output() calls)', () => {
    const text = ['// global.linkAudio()', 's.audio("kick.wav").output("kick")'].join('\n')

    const issues = analyzeOutputWithoutLinkAudio(text)
    expect(issues).toHaveLength(1)
  })

  it('returns no issues when there are no .output() calls at all', () => {
    const text = [
      'global.tempo(120)',
      'var s = init global.seq',
      's.audio("kick.wav").play(1, 0, 1, 0)',
    ].join('\n')

    expect(analyzeOutputWithoutLinkAudio(text)).toEqual([])
  })
})

describe('analyzeGlobalOncePerFile — linkAudio entry', () => {
  it('flags the second occurrence of global.linkAudio()', () => {
    const text = ['global.linkAudio()', 'global.linkAudio(48000)'].join('\n')

    const issues = analyzeGlobalOncePerFile(text)
    expect(issues).toHaveLength(1)
    expect(issues[0].line).toBe(1)
    expect(issues[0].message).toContain('Duplicate global.linkAudio()')
  })

  it('does not flag a single occurrence of global.linkAudio()', () => {
    const text = ['global.tempo(120)', 'global.linkAudio()'].join('\n')

    expect(analyzeGlobalOncePerFile(text)).toEqual([])
  })
})
