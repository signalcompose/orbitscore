/**
 * S2 parity verdict — 実 daemon に対する timing 計測（Issue #296）。
 *
 * **gated**: `ORBIT_REAL_DAEMON=1` のときだけ走る。実 daemon バイナリ
 * (`rust/target/release/orbit-audio-daemon`) と実音声デバイスが要るため通常 CI では skip。
 *
 * 検証する load-bearing unknown（A0 §13 / master plan §5）= SC の fire-now と daemon の
 * schedule-ahead を「poll-and-fire-now + 定数 lookahead」で繋いだとき:
 *   1. **ahead-of-cursor**: 各 dispatch の time_sec が、その瞬間の真の transport now_sec
 *      （observer 接続の StreamStats を ground truth に）を上回る（onset clip しない）。
 *   2. **相対 timing 保存**: 等間隔パターンの time_sec 間隔がパターン間隔に一致（quantize/polymeter parity）。
 *   3. **xruns 0**: 発音中に観測 xrun が出ない。
 *   4. **clock anchor 精度**: adapter の daemonNowSec 推定が ground truth と数 ms 以内。
 *
 * 1 つの daemon プロセスに adapter（駆動）と observer（read-only）の 2 接続を張る。
 */

import { spawn, ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import * as path from 'path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DaemonClient } from '../../../packages/engine/src/audio/rust-engine/daemon-client'
import {
  DispatchInfo,
  RustEnginePlayer,
} from '../../../packages/engine/src/audio/rust-engine/rust-engine-player'

const RUN = process.env.ORBIT_REAL_DAEMON === '1'
const REPO_ROOT = path.resolve(__dirname, '../../../')
const DAEMON_BIN = path.join(REPO_ROOT, 'rust/target/release/orbit-audio-daemon')
const KICK = path.join(REPO_ROOT, 'test-assets/audio/kick.wav')
const SNARE = path.join(REPO_ROOT, 'test-assets/audio/snare.wav')

interface StatsSample {
  wallMs: number
  nowSec: number
  xruns: number
}

/** daemon を 1 プロセス起動し ws url を返す（ready line を読む）。 */
async function spawnDaemon(): Promise<{ url: string; child: ChildProcess }> {
  const child = spawn(DAEMON_BIN, [], { stdio: ['ignore', 'pipe', 'pipe'] })
  const reader = createInterface({ input: child.stdout! })
  const port = await new Promise<number>((resolve, reject) => {
    // 失敗時は child を kill して leak（audio device 占有）を防ぐ。
    const fail = (err: Error): void => {
      child.kill('SIGKILL')
      reject(err)
    }
    const to = setTimeout(() => fail(new Error('daemon ready line timeout')), 15_000)
    reader.on('line', (line) => {
      try {
        const parsed = JSON.parse(line)
        if (parsed.ready) {
          clearTimeout(to)
          reader.close()
          resolve(parsed.port)
        }
      } catch {
        /* skip non-JSON banner lines */
      }
    })
    child.once('exit', (code) => {
      clearTimeout(to)
      reject(new Error(`daemon exited before ready (code=${code})`))
    })
  })
  return { url: `ws://127.0.0.1:${port}`, child }
}

describe.runIf(RUN)('RustEnginePlayer timing against real daemon', () => {
  let daemon: { url: string; child: ChildProcess }
  let observer: DaemonClient
  const stats: StatsSample[] = []

  beforeAll(async () => {
    daemon = await spawnDaemon()
    observer = new DaemonClient()
    observer.on('stream-stats', (data: unknown) => {
      const d = data as { now_sec?: number; xruns?: number }
      if (typeof d.now_sec === 'number') {
        stats.push({ wallMs: Date.now(), nowSec: d.now_sec, xruns: Number(d.xruns ?? 0) })
      }
    })
    await observer.start({ wsUrlOverride: daemon.url })
  }, 20_000)

  afterAll(async () => {
    await observer?.quit()
    daemon?.child.kill('SIGTERM')
  })

  it('schedules ahead of the transport cursor, preserves relative timing, no xruns', async () => {
    const dispatches: DispatchInfo[] = []
    const player = new RustEnginePlayer({
      wsUrlOverride: daemon.url,
      lookaheadSec: 0.05,
      onDispatch: (info) => dispatches.push(info),
    })
    await player.boot()
    await player.loadBuffer(KICK) // pre-load so first-hit latency doesn't skew timing

    const HITS = 8
    const SPACING_MS = 300
    for (let i = 0; i < HITS; i++) {
      player.scheduleEvent(KICK, i * SPACING_MS, 0, 0, 'kick')
    }
    player.start()

    // パターン長 2.1s + lookahead + 観測 StreamStats(>=3) のため十分待つ。
    await new Promise((r) => setTimeout(r, HITS * SPACING_MS + 1500))
    await player.quit()

    // --- ground truth: observer StreamStats から trueNow(wallMs) を作る ---
    expect(stats.length).toBeGreaterThanOrEqual(2)
    const rate = (() => {
      const a = stats[0]
      const b = stats[stats.length - 1]
      return (b.nowSec - a.nowSec) / ((b.wallMs - a.wallMs) / 1000)
    })()
    const trueNow = (wallMs: number): number => {
      // 直近の observer sample から rate で外挿（transport ≈ wall, rate≈1）。
      let nearest = stats[0]
      for (const s of stats)
        if (Math.abs(s.wallMs - wallMs) < Math.abs(nearest.wallMs - wallMs)) nearest = s
      return nearest.nowSec + ((wallMs - nearest.wallMs) / 1000) * rate
    }

    // --- 1. 全 8 hit が dispatch された ---
    expect(dispatches.length).toBe(HITS)

    // --- 2. ahead-of-cursor: 各 dispatch の time_sec > 真の now_sec ---
    const leads = dispatches.map((d) => d.timeSec - trueNow(d.wallMs))
    const minLead = Math.min(...leads)
    const maxLead = Math.max(...leads)

    // --- 3. clock anchor 精度: adapter 推定 vs ground truth ---
    const drifts = dispatches.map((d) => d.daemonNowSec - trueNow(d.wallMs))
    const maxAbsDrift = Math.max(...drifts.map(Math.abs))

    // --- 4. 相対 timing: time_sec 間隔がパターン間隔(0.3s)に一致 ---
    const deltas: number[] = []
    for (let i = 1; i < dispatches.length; i++) {
      deltas.push(dispatches[i].timeSec - dispatches[i - 1].timeSec)
    }
    const maxDeltaErr = Math.max(...deltas.map((dt) => Math.abs(dt - SPACING_MS / 1000)))

    // --- 5. xruns 0 ---
    const maxXruns = Math.max(...stats.map((s) => s.xruns))

    // verdict サマリ（人間が読む）。
    console.log('\n===== S2 timing verdict (real daemon) =====')
    console.log(
      `observer StreamStats samples: ${stats.length}, transport rate ≈ ${rate.toFixed(4)} (expect ≈1.0)`,
    )
    console.log(`dispatches: ${dispatches.length}/${HITS}`)
    console.log(
      `lead (time_sec - trueNow): min=${(minLead * 1000).toFixed(1)}ms max=${(maxLead * 1000).toFixed(1)}ms (lookahead=50ms)`,
    )
    console.log(`anchor drift |est - truth|: max=${(maxAbsDrift * 1000).toFixed(1)}ms`)
    console.log(
      `inter-onset deltas: max err vs ${SPACING_MS}ms = ${(maxDeltaErr * 1000).toFixed(1)}ms`,
    )
    console.log(`max observed xruns: ${maxXruns}`)
    console.log('==========================================\n')

    // assertions（verdict 条件）
    expect(rate).toBeGreaterThan(0.95)
    expect(rate).toBeLessThan(1.05)
    expect(minLead).toBeGreaterThan(0) // 全 dispatch が cursor を上回る = onset clip しない
    expect(maxAbsDrift).toBeLessThan(0.05) // anchor 推定が真値と 50ms 以内
    expect(maxDeltaErr).toBeLessThan(0.05) // 相対 timing が ±50ms 以内で保存
    expect(maxXruns).toBe(0)
  }, 20_000)

  it('polymeter: 2 シーケンスが各自の周期を独立に保持する（3:4）', async () => {
    // seqA(KICK)=400ms 周期・seqB(SNARE)=300ms 周期 を同時走行。各シーケンスの
    // inter-onset が自分の周期を保てば、daemon 経路で polymeter parity が成立する
    // （周期計算は不変の TS Sequence 層の責務。本テストは backend が与えられた時刻を
    // 崩さないことを実証する）。
    const dispatches: Array<DispatchInfo & { file: string }> = []
    const player = new RustEnginePlayer({
      wsUrlOverride: daemon.url,
      lookaheadSec: 0.05,
      onDispatch: (info) => dispatches.push({ ...info, file: info.filepath }),
    })
    await player.boot()
    await player.loadBuffer(KICK)
    await player.loadBuffer(SNARE)

    const A_MS = 400 // 3 against
    const B_MS = 300 // 4 against
    const SPAN_MS = 2400 // LCM 周期
    for (let t = 0; t <= SPAN_MS; t += A_MS) player.scheduleEvent(KICK, t, 0, 0, 'seqA')
    for (let t = 0; t <= SPAN_MS; t += B_MS) player.scheduleEvent(SNARE, t, 0, 0, 'seqB')
    player.start()
    await new Promise((r) => setTimeout(r, SPAN_MS + 1200))
    await player.quit()

    const interOnsetErr = (file: string, periodMs: number): number => {
      const times = dispatches
        .filter((d) => d.file === file)
        .map((d) => d.timeSec)
        .sort((a, b) => a - b)
      let maxErr = 0
      for (let i = 1; i < times.length; i++) {
        maxErr = Math.max(maxErr, Math.abs(times[i] - times[i - 1] - periodMs / 1000))
      }
      return maxErr
    }
    const aCount = dispatches.filter((d) => d.file === KICK).length
    const bCount = dispatches.filter((d) => d.file === SNARE).length
    const aErr = interOnsetErr(KICK, A_MS)
    const bErr = interOnsetErr(SNARE, B_MS)
    const maxXruns = Math.max(...stats.map((s) => s.xruns))

    console.log('\n===== S2 polymeter verdict (real daemon) =====')
    console.log(`seqA(400ms): ${aCount} hits, inter-onset max err = ${(aErr * 1000).toFixed(1)}ms`)
    console.log(`seqB(300ms): ${bCount} hits, inter-onset max err = ${(bErr * 1000).toFixed(1)}ms`)
    console.log(`max observed xruns: ${maxXruns}`)
    console.log('==============================================\n')

    expect(aCount).toBe(SPAN_MS / A_MS + 1) // 7 hits
    expect(bCount).toBe(SPAN_MS / B_MS + 1) // 9 hits
    expect(aErr).toBeLessThan(0.05) // seqA の 400ms 周期が保存
    expect(bErr).toBeLessThan(0.05) // seqB の 300ms 周期が独立に保存
    expect(maxXruns).toBe(0)
  }, 20_000)
})
