/**
 * rack child の PID オラクル（#628 §6）のパース部分。
 *
 * E2E 本体は gated（実機 OrbitStudio が要る）なので普段は走らない。
 * **ログの読み取りだけは常時守れる**ようにここへ切り出す — R28-E1〜E10 は
 * すべて「child PID 不変」を判定条件にしており、この関数が黙って壊れると
 * **10 シナリオが揃って無意味になる**。
 */

import { describe, expect, it } from 'vitest'

import { latestRackChildPid, rackChildPidsFromLog } from './orbitstudio-mcp-gated.spec'

const SPAWN = (pid: number, shm = '/tmp/orbit-shm-0') =>
  `2026-08-28T02:31:44.123456Z  INFO orbit_audio_daemon::outproc_effect: ` +
  `[orbit-effect-rack] child spawned pid=${pid} shm=${shm}`

describe('rackChildPidsFromLog', () => {
  it('spawn 行から PID を拾う', () => {
    expect(rackChildPidsFromLog(SPAWN(48732))).toEqual([48732])
  })

  it('🔴 複数の spawn を出現順に返す（respawn の検出に使う）', () => {
    const log = [SPAWN(100), 'unrelated line', SPAWN(200), SPAWN(300)].join('\n')
    expect(rackChildPidsFromLog(log)).toEqual([100, 200, 300])
  })

  it('spawn 行が無ければ空', () => {
    expect(rackChildPidsFromLog('nothing here\nERROR: something')).toEqual([])
  })

  it('🔴 別の PID らしき数値を拾わない（タグで限定する）', () => {
    const log = [
      'INFO [orbit-vst3-instrument-child] state restored pid=999',
      'daemon started with pid=1234',
      SPAWN(48732),
    ].join('\n')
    expect(rackChildPidsFromLog(log)).toEqual([48732])
  })

  it('0 や負値は採らない', () => {
    expect(rackChildPidsFromLog(SPAWN(0))).toEqual([])
  })
})

describe('latestRackChildPid', () => {
  it('🔴 最後の spawn を返す（PID 不変の判定は「最新」どうしの比較）', () => {
    expect(latestRackChildPid([SPAWN(100), SPAWN(200)].join('\n'))).toBe(200)
  })

  it('spawn が無ければ null', () => {
    expect(latestRackChildPid('')).toBeNull()
  })
})
