import { describe, expect, it } from 'vitest'

import {
  IPC_SOCKET_SUFFIX_ALLOWANCE,
  selectRootPids,
  UNIX_SOCKET_PATH_MAX,
  userDataDirExceedsSocketLimit,
} from './helpers/harness-processes'

/**
 * これは「型が保証している誤り」ではなく、**取り違えるとダイアログが復活する分類ロジック**である
 * （#830）。DSL からは駆動できず、実機 gated の成否にも現れないので、ここで固定する。
 */
describe('selectRootPids', () => {
  it('本体だけを返し、ヘルパーは返さない', () => {
    // 実測の形: 1 インスタンス = 本体 1 + ヘルパー複数。ヘルパーの親は本体。
    const rows = [
      { pid: 100, ppid: 1 }, // 本体（親は launchd = 非 owned）
      { pid: 101, ppid: 100 },
      { pid: 102, ppid: 100 },
      { pid: 103, ppid: 101 }, // 孫
    ]
    expect(selectRootPids(rows)).toEqual([100])
  })

  it('本体を 2 つ起動していれば 2 つとも返す', () => {
    const rows = [
      { pid: 100, ppid: 1 },
      { pid: 101, ppid: 100 },
      { pid: 200, ppid: 1 },
      { pid: 201, ppid: 200 },
    ]
    expect(selectRootPids(rows)).toEqual([100, 200])
  })

  it('🔴 親が不明なものを本体として扱わない（不明は安全側）', () => {
    // 走査と親の取得の間にプロセスが消える / `ps` 自体が失敗する場合。
    // ここで root に入れてしまうと、ヘルパーへ直接 SIGTERM が飛びダイアログが出る。
    const rows = [
      { pid: 100, ppid: 1 },
      { pid: 101, ppid: undefined },
    ]
    expect(selectRootPids(rows)).toEqual([100])
  })

  it('全件の親が不明なら root は空になる（呼び出し側の sweep が拾う）', () => {
    const rows = [
      { pid: 100, ppid: undefined },
      { pid: 101, ppid: undefined },
    ]
    expect(selectRootPids(rows)).toEqual([])
  })

  it('親が NaN のものを本体として扱わない', () => {
    // `Number(ps の出力)` が壊れた場合。Set.has(NaN) は false なので、素朴に書くと root になる。
    const rows = [
      { pid: 100, ppid: 1 },
      { pid: 101, ppid: Number.NaN },
    ]
    expect(selectRootPids(rows)).toEqual([100])
  })

  it('空入力で空を返す', () => {
    expect(selectRootPids([])).toEqual([])
  })
})

describe('userDataDirExceedsSocketLimit', () => {
  const budget = UNIX_SOCKET_PATH_MAX - IPC_SOCKET_SUFFIX_ALLOWANCE

  it('ちょうど上限までは通す', () => {
    expect(userDataDirExceedsSocketLimit('x'.repeat(budget))).toBe(false)
  })

  it('1 文字超えたら拒否する', () => {
    expect(userDataDirExceedsSocketLimit('x'.repeat(budget + 1))).toBe(true)
  })

  it('実際に落ちたパスを拒否する（#830 の実測・105 文字のソケットパス）', () => {
    // `/var/folders/<2>/<28>/T/orbitstudio-named-device-XXXXXX/user-data`
    const observed =
      '/var/folders/kf/ysg5kk1d2yz7r8044qv0wc8w0000gn/T/orbitstudio-named-device-0IgvF5/user-data'
    expect(userDataDirExceedsSocketLimit(observed)).toBe(true)
  })

  it('現在のハーネスが作るパスは通る', () => {
    expect(userDataDirExceedsSocketLimit('/tmp/orbe2e-dev-Ab12Cd/user-data')).toBe(false)
  })
})
