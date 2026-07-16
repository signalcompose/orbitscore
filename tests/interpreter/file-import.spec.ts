/**
 * File import (IM.1-IM.6, #456) — parser + interpreter.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'
import { InterpreterV2 } from '../../packages/engine/src/interpreter/interpreter-v2'

describe('file import — parser (IM.1)', () => {
  it('parses names and path into the fileImports bucket', () => {
    const ir = parseAudioDSL(`import { kick, snare } from "./drums.orbs"\nvar global = init GLOBAL`)
    expect(ir.fileImports).toEqual([
      { type: 'file_import', names: ['kick', 'snare'], path: './drums.orbs' },
    ])
    expect(ir.globalInit?.variableName).toBe('global')
  })

  it('keeps `import chords` (stdlib) parsing unchanged', () => {
    const ir = parseAudioDSL(`import chords`)
    expect(ir.fileImports).toEqual([])
    expect(ir.statements).toEqual([{ type: 'import', module: 'chords' }])
  })

  it('rejects a non-relative path', () => {
    expect(() => parseAudioDSL(`import { a } from "/abs/x.orbs"`)).toThrow('start with ./ or ../')
    expect(() => parseAudioDSL(`import { a } from "bare.orbs"`)).toThrow('start with ./ or ../')
  })

  it('rejects a path without the .orbs extension', () => {
    expect(() => parseAudioDSL(`import { a } from "./x"`)).toThrow('.orbs extension is required')
  })

  it('rejects a missing `from`', () => {
    expect(() => parseAudioDSL(`import { a } "./x.orbs"`)).toThrow()
  })

  it('rejects a file import after a non-import statement (IM.1 head-position rule)', () => {
    expect(() => parseAudioDSL(`var global = init GLOBAL\nimport { a } from "./x.orbs"`)).toThrow(
      'must appear before any other statement',
    )
  })

  it('allows file import after stdlib import (both are head-area imports)', () => {
    const ir = parseAudioDSL(`import chords\nimport { a } from "./x.orbs"`)
    expect(ir.fileImports).toHaveLength(1)
  })
})

describe('file import — interpreter (IM.2-IM.6)', () => {
  let dir: string
  let interpreter: InterpreterV2

  function write(name: string, content: string): string {
    const p = path.join(dir, name)
    fs.writeFileSync(p, content)
    return p
  }

  async function run(entryFile: string) {
    const source = fs.readFileSync(entryFile, 'utf8')
    const ir = parseAudioDSL(source)
    await interpreter.execute(ir, {
      sourceFile: entryFile,
      documentDirectory: path.dirname(entryFile),
    })
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbs-import-'))
    interpreter = new InterpreterV2()
    const audioEngine = (interpreter as any).state.audioEngine
    audioEngine.boot = vi.fn().mockResolvedValue(undefined)
    audioEngine.getCurrentTime = vi.fn().mockReturnValue(0)
    audioEngine.scheduleEvent = vi.fn()
    audioEngine.scheduleSliceEvent = vi.fn()
    audioEngine.getMasterGainDb = vi.fn().mockReturnValue(0)
    await interpreter.boot()
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('merges imported declarations into the shared namespace (IM.2)', async () => {
    write('drums.orbs', `var global = init GLOBAL\nvar kick = init global.seq\n`)
    const entry = write(
      'main.orbs',
      `import { kick } from "./drums.orbs"\nvar global = init GLOBAL\n`,
    )
    await run(entry)
    const state = interpreter.getState()
    expect(state.sequences).toHaveProperty('kick')
    // 名前キー reconciliation: entry の `var global` は module が作った Global と同一
    expect(Object.keys(state.globals)).toEqual(['global'])
  })

  it('rejects an import name that the file does not declare (IM.1 contract check)', async () => {
    write('drums.orbs', `var global = init GLOBAL\nvar kick = init global.seq\n`)
    const entry = write('main.orbs', `import { nope } from "./drums.orbs"\n`)
    await expect(run(entry)).rejects.toThrow('"nope" is not declared in that file')
  })

  it('rejects a missing file with the resolved path in the message (IM.4)', async () => {
    const entry = write('main.orbs', `import { a } from "./ghost.orbs"\n`)
    await expect(run(entry)).rejects.toThrow('file not found')
  })

  it('detects a circular import (IM.2)', async () => {
    write(
      'a.orbs',
      `import { b } from "./b.orbs"\nvar global = init GLOBAL\nvar a = init global.seq\n`,
    )
    write(
      'b.orbs',
      `import { a } from "./a.orbs"\nvar global = init GLOBAL\nvar b = init global.seq\n`,
    )
    const entry = write('main.orbs', `import { a } from "./a.orbs"\n`)
    await expect(run(entry)).rejects.toThrow('circular import')
  })

  it('detects a self-import via the entry file (IM.2)', async () => {
    const entry = write('main.orbs', `import { x } from "./main.orbs"\n`)
    await expect(run(entry)).rejects.toThrow('circular import')
  })

  it('evaluates a diamond exactly once and succeeds (IM.2)', async () => {
    write('shared.orbs', `var global = init GLOBAL\nvar pad = init global.seq\n`)
    write(
      'a.orbs',
      `import { pad } from "./shared.orbs"\nvar global = init GLOBAL\nvar a = init global.seq\n`,
    )
    write(
      'b.orbs',
      `import { pad } from "./shared.orbs"\nvar global = init GLOBAL\nvar b = init global.seq\n`,
    )
    const entry = write(
      'main.orbs',
      `import { a } from "./a.orbs"\nimport { b } from "./b.orbs"\nvar global = init GLOBAL\n`,
    )
    await run(entry)
    const state = interpreter.getState()
    expect(Object.keys(state.sequences).sort()).toEqual(['a', 'b', 'pad'])
  })

  it('rejects transport commands in an imported file (IM.3)', async () => {
    write('perf.orbs', `var global = init GLOBAL\nvar kick = init global.seq\nRUN(kick)\n`)
    const entry = write('main.orbs', `import { kick } from "./perf.orbs"\n`)
    await expect(run(entry)).rejects.toThrow('not allowed in an imported file')
  })

  it('resolves transitive import paths against the importing file (IM.4)', async () => {
    fs.mkdirSync(path.join(dir, 'sub'))
    write('sub/inner.orbs', `var global = init GLOBAL\nvar inner = init global.seq\n`)
    write(
      'sub/outer.orbs',
      `import { inner } from "./inner.orbs"\nvar global = init GLOBAL\nvar outer = init global.seq\n`,
    )
    const entry = write('main.orbs', `import { outer } from "./sub/outer.orbs"\n`)
    await run(entry)
    const state = interpreter.getState()
    expect(Object.keys(state.sequences).sort()).toEqual(['inner', 'outer'])
  })

  it('falls back to documentDirectory when there is no sourceFile (REPL, IM.6)', async () => {
    write('drums.orbs', `var global = init GLOBAL\nvar kick = init global.seq\n`)
    const ir = parseAudioDSL(`import { kick } from "./drums.orbs"\n`)
    await interpreter.execute(ir, { documentDirectory: dir })
    expect(interpreter.getState().sequences).toHaveProperty('kick')
  })

  it('errors when neither sourceFile nor documentDirectory is available (IM.6)', async () => {
    const ir = parseAudioDSL(`import { kick } from "./drums.orbs"\n`)
    await expect(interpreter.execute(ir)).rejects.toThrow('cannot resolve the base directory')
  })
})
