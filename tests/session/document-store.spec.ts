/**
 * document の写し（設計 848 §5.5）: LSP と同じ 0 始まり・UTF-16 の座標で変更を当てる。
 */
import { describe, expect, it } from 'vitest'

import {
  applyChanges,
  documentPath,
  DocumentStore,
  editorStateOf,
  inferLanguageId,
  lineStarts,
  offsetAt,
  positionAt,
} from '../../packages/session/src/host/document-store'

describe('positions (0-based, UTF-16, \\n / \\r\\n / \\r)', () => {
  it('finds line starts for every line break style', () => {
    expect(lineStarts('a\nb\r\nc\rd')).toEqual([0, 2, 5, 7])
    expect(lineStarts('')).toEqual([0])
    expect(lineStarts('x\n')).toEqual([0, 2])
  })

  it('maps positions to offsets and back, clamping past the line and the document', () => {
    const text = 'ab\r\ncd'
    expect(offsetAt(text, { line: 1, character: 1 })).toBe(5)
    expect(offsetAt(text, { line: 0, character: 99 })).toBe(2) // 区切りの手前で止まる
    expect(offsetAt(text, { line: 9, character: 0 })).toBe(text.length)
    expect(positionAt(text, 5)).toEqual({ line: 1, character: 1 })
    expect(positionAt(text, 99)).toEqual({ line: 1, character: 2 })
  })

  it('counts a surrogate pair as two UTF-16 units (LSP default)', () => {
    const text = 'a🎵b'
    expect(offsetAt(text, { line: 0, character: 3 })).toBe(3)
    expect(
      applyChanges(text, [
        { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } }, text: 'X' },
      ]),
    ).toBe('aXb')
  })
})

describe('applyChanges (LSP TextDocumentContentChangeEvent)', () => {
  it('applies range replacements in order, and a change without range replaces everything', () => {
    const start = 'global.tempo(120)\nkick.play(1)\n'
    const edited = applyChanges(start, [
      {
        range: { start: { line: 0, character: 13 }, end: { line: 0, character: 16 } },
        text: '140',
      },
      { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, text: '// ' },
    ])
    expect(edited).toBe('global.tempo(140)\n// kick.play(1)\n')
    expect(applyChanges(edited, [{ text: 'all new' }])).toBe('all new')
  })

  it('inserts across lines and deletes a line break', () => {
    expect(
      applyChanges('a\nb', [
        { range: { start: { line: 0, character: 1 }, end: { line: 1, character: 0 } }, text: '' },
      ]),
    ).toBe('ab')
    expect(
      applyChanges('ab', [
        {
          range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
          text: '\r\n',
        },
      ]),
    ).toBe('a\r\nb')
  })
})

describe('DocumentStore', () => {
  const uri = 'file:///ws/piece/a.orbs'

  it('keeps the copy, its version, selection and the active document', () => {
    const store = new DocumentStore()
    store.open(uri, 1, 'global.tempo(120)\n', '/ws/piece')
    expect(store.change(uri, 2, [{ text: 'global.tempo(90)\n' }])).toBe(true)
    store.select(uri, { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } })
    store.setActive(uri)
    expect(store.active()).toMatchObject({ uri, version: 2, text: 'global.tempo(90)\n' })
    expect(store.list()).toEqual([{ uri, version: 2 }])
  })

  it('ignores a stale or duplicate version and a change to a closed document, with a reason', () => {
    const logged: string[] = []
    const store = new DocumentStore((_level, text) => logged.push(text))
    store.open(uri, 3, 'x', null)
    expect(store.change(uri, 3, [{ text: 'dup' }])).toBe(false)
    expect(store.change(uri, 2, [{ text: 'old' }])).toBe(false)
    expect(store.change('file:///ws/b.orbs', 9, [{ text: 'nope' }])).toBe(false)
    expect(store.get(uri)?.text).toBe('x')
    expect(logged).toHaveLength(3)
  })

  it('closing the active document leaves no active document; clear() forgets everything', () => {
    const store = new DocumentStore()
    store.open(uri, 1, 'x', null)
    store.setActive(uri)
    store.close(uri)
    expect(store.active()).toBeNull()
    expect(store.activeUriValue).toBeNull()
    store.open(uri, 1, 'x', null)
    store.setActive(uri)
    store.clear()
    expect(store.list()).toEqual([])
    expect(store.activeUriValue).toBeNull()
  })
})

describe('editorStateOf — the MCP get_editor_state shape (frozen getEditorStateForAgent)', () => {
  it('is all null without an active document', () => {
    expect(editorStateOf(null)).toEqual({
      path: null,
      languageId: null,
      cursor: null,
      selection: null,
      lineCount: null,
      isDirty: null,
    })
  })

  it('reports 1-based positions, the path, the line count and whether it changed since opening', () => {
    const store = new DocumentStore()
    store.open('file:///ws/piece/a.orbs', 1, 'line one\nline two\n', '/ws/piece')
    store.select(
      'file:///ws/piece/a.orbs',
      { start: { line: 0, character: 2 }, end: { line: 1, character: 4 } },
      { line: 1, character: 4 },
    )
    expect(editorStateOf(store.get('file:///ws/piece/a.orbs')!)).toEqual({
      path: '/ws/piece/a.orbs',
      languageId: 'orbitscore',
      cursor: { line: 2, character: 5 },
      selection: { start: { line: 1, character: 3 }, end: { line: 2, character: 5 } },
      lineCount: 3,
      isDirty: false,
    })
    store.change('file:///ws/piece/a.orbs', 2, [{ text: 'edited' }])
    expect(editorStateOf(store.get('file:///ws/piece/a.orbs')!).isDirty).toBe(true)
    store.markSaved('file:///ws/piece/a.orbs')
    expect(editorStateOf(store.get('file:///ws/piece/a.orbs')!).isDirty).toBe(false)
  })

  it('infers the language from the extension and keeps non-file uris as they are', () => {
    expect(inferLanguageId('file:///ws/A.ORBS')).toBe('orbitscore')
    expect(inferLanguageId('file:///ws/notes.md')).toBe('plaintext')
    expect(inferLanguageId('untitled:Untitled-1')).toBe('plaintext')
    expect(documentPath('untitled:Untitled-1')).toBe('untitled:Untitled-1')
    expect(documentPath('file:///ws/odd%20name/a.orbs')).toBe('/ws/odd name/a.orbs')
  })
})
