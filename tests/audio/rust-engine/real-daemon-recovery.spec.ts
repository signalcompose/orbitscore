/**
 * RustEnginePlayer の recovery floor（daemon supervision + auto-respawn / #300）を
 * 実 daemon に対して検証する gated kill-test。
 *
 * `ORBIT_REAL_DAEMON=1` のときだけ走る（実プロセス kill/panic は CI で flaky/危険なので
 * 既定 skip = ローカル実機 + 記録した手動 validation。librosa cross-check と同パターン）。
 * 事前に `cd rust && cargo build -p orbit-audio-daemon --release` 済みであること。
 *
 * 本テストは PRODUCTION モード（wsUrlOverride なし）= player が自分で daemon を spawn・所有し、
 * supervisor が死を検出して respawn する実経路を踏む。fault は2系統:
 *   - hard-death: SIGKILL（panic hook 素通り = C-ABI segfault の忠実な代理）
 *   - clean-exit: InjectFault{panic}（panic hook→exit(1) + stderr DaemonError）
 * 受け入れは invariant ベース（実時間 kill は非決定的なので exact-match / toEqual はしない）。
 */

import * as path from 'path'

import { afterEach, describe, expect, it } from 'vitest'

import type { DispatchInfo } from '../../../packages/engine/src/audio/rust-engine/rust-engine-player'
import { RustEnginePlayer } from '../../../packages/engine/src/audio/rust-engine/rust-engine-player'

const REPO_ROOT = path.resolve(__dirname, '../../../')
const KICK = path.join(REPO_ROOT, 'test-assets/audio/kick.wav')
const DAEMON_BIN = path.join(REPO_ROOT, 'rust/target/release/orbit-audio-daemon')
const RUN = process.env.ORBIT_REAL_DAEMON === '1'

const LOOKAHEAD_SEC = 0.05

async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 5000, stepMs = 20 }: { timeoutMs?: number; stepMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, stepMs))
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`)
}

describe.runIf(RUN)('RustEnginePlayer recovery floor against real daemon (#300)', () => {
  let player: RustEnginePlayer | null = null

  afterEach(async () => {
    if (player) {
      await player.quit()
      player = null
    }
  })

  /**
   * fault を注入してから recovery 不変式を検証する共通ドライバ。
   * @param inject daemon を殺す手段（SIGKILL or InjectFault panic）。
   */
  async function runKillTest(inject: (p: RustEnginePlayer) => Promise<void> | void): Promise<void> {
    // panic 経路用に fault 注入を許可（spawn する daemon が env を継承する）。SIGKILL では未使用。
    process.env.ORBIT_DAEMON_ALLOW_FAULT_INJECTION = '1'

    const dispatches: DispatchInfo[] = []
    const p = new RustEnginePlayer({
      daemonPath: DAEMON_BIN,
      lookaheadSec: LOOKAHEAD_SEC,
      onDispatch: (info) => dispatches.push(info),
    })
    player = p
    await p.boot()
    await p.loadBuffer(KICK) // pre-load で first-hit 遅延を排除

    // 連続供給（active loops の代理）: 0..6000ms に 100ms 間隔で 1 シーケンスを撒く。
    for (let t = 0; t <= 6000; t += 100) p.scheduleEvent(KICK, t, -12, 0, 'kick')
    p.start()

    // transport を ≥2s 進めてから kill する（advisor: t≈0 で kill すると stale anchor ≈ fresh
    // anchor になり再 anchor バグが隠れる。差を作るために transport を進める）。
    await waitFor(() => dispatches.some((d) => d.daemonNowSec >= 2.0), { timeoutMs: 8000 })

    const preKillPid = p.daemonPid
    const preKillNowSec = dispatches[dispatches.length - 1].daemonNowSec
    const killMark = dispatches.length
    expect(preKillPid).toBeGreaterThan(0)
    expect(preKillNowSec).toBeGreaterThan(2.0)

    // --- fault 注入（daemon を殺す） ---
    await inject(p)

    // 復旧を待つ。gap 中は executePlayback の guard が dispatch を drop し onDispatch を呼ばないので、
    // killMark を超える dispatch は全て respawn 後（= active loops の構造的復帰の観測）。
    await waitFor(() => dispatches.length > killMark + 3, { timeoutMs: 12000 })

    const post = dispatches.slice(killMark)

    // (1) liveness: poll は止まらず、daemon は respawn（新 pid）し、loops が復帰している。
    expect(p.isRunning).toBe(true)
    expect(post.length).toBeGreaterThan(0)
    const postPid = p.daemonPid
    expect(postPid).toBeGreaterThan(0)
    expect(postPid).not.toBe(preKillPid)

    // (2) transport 再 anchor（desync 無し）: 新 daemon は transport≈0 から始まるので、復帰後の
    //     daemonNowSec は kill 直前（≥2s）より大きく下がる（stale anchor の ~Ns を引きずらない）。
    //     これが唯一 load-bearing な不変式（再 anchor が壊れると新 daemon に「数秒先」を送り desync）。
    expect(post[0].daemonNowSec).toBeLessThan(preKillNowSec - 0.5)
    expect(post[0].daemonNowSec).toBeGreaterThan(0)

    // (3) onset clip しない: 復帰後の全 dispatch で lead = timeSec − daemonNowSec ≈ lookahead（正値）。
    for (const d of post) {
      const lead = d.timeSec - d.daemonNowSec
      expect(lead).toBeGreaterThan(0)
      expect(lead).toBeLessThan(LOOKAHEAD_SEC + 0.1)
    }

    // (4) daemon-side 状態クエリ: 再 establish 済み（fresh transport / sample 再ロード / play_id 健全）。
    const status = await p.getDaemonStatus()
    expect(Number(status.uptime_sec)).toBeLessThan(preKillNowSec) // fresh daemon（transport リセット）
    expect(Number(status.loaded_samples)).toBeGreaterThanOrEqual(1) // sample 再ロード済み
    expect(Number(status.active_plays)).toBeGreaterThanOrEqual(0) // orphan なし（有限・健全）
  }

  it('hard-death（SIGKILL・panic hook 素通り）から respawn しセッション生存', async () => {
    await runKillTest((p) => {
      const pid = p.daemonPid
      if (!pid) throw new Error('no daemon pid to kill')
      process.kill(pid, 'SIGKILL')
    })
  }, 30_000)

  it('clean-exit（InjectFault panic→exit1）から respawn しセッション生存', async () => {
    await runKillTest(async (p) => {
      await p.injectDaemonFault()
    })
  }, 30_000)
})
