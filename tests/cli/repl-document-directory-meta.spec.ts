/**
 * REPL メタ行 `//#documentDirectory <path>`（I3, #456 / IM.6）。
 * エディタ統合が import の基準ディレクトリを帯域外で先渡しするチャネル。
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { describe, it, expect, vi } from 'vitest'

import { extractDocumentDirectoryMeta } from '../../packages/engine/src/cli/repl-mode'
import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'
import { InterpreterV2 } from '../../packages/engine/src/interpreter/interpreter-v2'

describe('extractDocumentDirectoryMeta', () => {
  it('extracts the path from a meta line', () => {
    expect(extractDocumentDirectoryMeta('//#documentDirectory /songs/live\nvar x = 1')).toBe(
      '/songs/live',
    )
  })

  it('returns undefined when absent', () => {
    expect(extractDocumentDirectoryMeta('var global = init GLOBAL')).toBeUndefined()
  })

  it('takes the last value when repeated', () => {
    expect(extractDocumentDirectoryMeta('//#documentDirectory /a\n//#documentDirectory /b\n')).toBe(
      '/b',
    )
  })

  it('tolerates leading whitespace and preserves spaces inside the path', () => {
    expect(extractDocumentDirectoryMeta('  //#documentDirectory /My Songs/set 1\n')).toBe(
      '/My Songs/set 1',
    )
  })

  it('is inert for the DSL parser (plain // comment)', () => {
    const ir = parseAudioDSL('//#documentDirectory /songs\nvar global = init GLOBAL\n')
    expect(ir.globalInit?.variableName).toBe('global')
  })
})

describe('meta-provided documentDirectory feeds import resolution (IM.6)', () => {
  it('resolves an import against the meta directory when there is no sourceFile', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbs-repl-meta-'))
    try {
      fs.writeFileSync(
        path.join(dir, 'drums.orbs'),
        'var global = init GLOBAL\nvar kick = init global.seq\n',
      )
      const interpreter = new InterpreterV2()
      const audioEngine = (interpreter as any).state.audioEngine
      audioEngine.boot = vi.fn().mockResolvedValue(undefined)
      await interpreter.boot()

      // REPL 経路の等価形: sourceFile なし・メタ行から得た documentDirectory を渡す
      const code = `//#documentDirectory ${dir}\nimport { kick } from "./drums.orbs"\n`
      const ir = parseAudioDSL(code)
      await interpreter.execute(ir, {
        source: code,
        documentDirectory: extractDocumentDirectoryMeta(code),
      })
      expect(interpreter.getState().sequences).toHaveProperty('kick')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
