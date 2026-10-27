import { beforeEach, describe, expect, it, vi } from 'vitest'

import { isProcessRunning } from './process-liveness'

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }))

vi.mock('child_process', () => ({ execFileSync: execFileSyncMock }))

function mockFailure(error: unknown): void {
  execFileSyncMock.mockImplementation(() => {
    throw error
  })
}

function expectRethrown(error: unknown): void {
  mockFailure(error)
  try {
    isProcessRunning(42)
  } catch (caught) {
    expect(caught).toBe(error)
    return
  }
  throw new Error('expected isProcessRunning to rethrow')
}

describe('isProcessRunning', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset()
  })

  it('returns false only for ps exit 1 with empty stdout', () => {
    mockFailure({ status: 1, stdout: '' })

    expect(isProcessRunning(42)).toBe(false)
  })

  it('rethrows a ps exit status other than 1', () => {
    expectRethrown({ status: 2 })
  })

  it('rethrows ps exit 1 when stdout is not empty', () => {
    expectRethrown({ status: 1, stdout: 'x' })
  })

  it('rethrows ENOENT', () => {
    expectRethrown(Object.assign(new Error('spawnSync ps ENOENT'), { code: 'ENOENT' }))
  })

  it('throws when ps succeeds with empty stdout', () => {
    execFileSyncMock.mockReturnValue('')

    expect(() => isProcessRunning(42)).toThrowError(
      'ps succeeded without reporting state for pid 42',
    )
  })

  it('returns false for a zombie process', () => {
    execFileSyncMock.mockReturnValue('Z')

    expect(isProcessRunning(42)).toBe(false)
  })

  it('returns true for a running process', () => {
    execFileSyncMock.mockReturnValue('S')

    expect(isProcessRunning(42)).toBe(true)
  })
})
