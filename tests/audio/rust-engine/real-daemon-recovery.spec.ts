/**
 * RustEnginePlayer の recovery floor（daemon supervision + auto-respawn / #300）を
 * 実 daemon に対して検証する gated kill-test。
 *
 * （#335 拡張）ファイル末尾に A4-PR4 = interpreter 駆動の active-loops across-respawn e2e を
 * 追加（full DSL を実 InterpreterV2 + 実 daemon で respawn 跨ぎ検証 + 非gated fixture-integrity
 * guard）。詳細は末尾の #335 セクションコメント参照。
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

import { afterEach, describe, expect, it, vi } from 'vitest'

import { InterpreterV2 } from '../../../packages/engine/src/interpreter/interpreter-v2'
import { parseAudioDSL } from '../../../packages/engine/src/parser'
import type { DispatchInfo } from '../../../packages/engine/src/audio/rust-engine/rust-engine-player'
import { RustEnginePlayer } from '../../../packages/engine/src/audio/rust-engine/rust-engine-player'
import { RecordingScheduler } from '../verify/recording-scheduler'

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

/**
 * respawn 後の recovery 不変式（#300 と #335 が共有）。実時間 kill は非決定的なので invariant
 * ベースで検証する（exact-match / toEqual はしない）。
 * @param p respawn 済み player（新 daemon に再接続済み）。
 * @param post kill mark 以降の dispatch（gap 中は guard が drop するので全て respawn 後）。
 * @param preKillPid kill 前の daemon pid（respawn で必ず変わる）。
 * @param preKillNowSec kill 直前の daemon transport now（再 anchor がこれを下回るべき基準）。
 * @param killWallMs kill した瞬間の `Date.now()`（新 daemon の uptime 上界を実時間で測るため）。
 */
async function assertRecoveryInvariants(
  p: RustEnginePlayer,
  post: DispatchInfo[],
  preKillPid: number | undefined,
  preKillNowSec: number,
  killWallMs: number,
): Promise<void> {
  // (1) liveness: poll は止まらず、daemon は respawn（新 pid）し、loops が復帰している。
  expect(p.isRunning).toBe(true)
  expect(post.length).toBeGreaterThan(0)
  const postPid = p.daemonPid
  expect(postPid).toBeGreaterThan(0)
  expect(postPid).not.toBe(preKillPid)

  // (2) transport 再 anchor（desync 無し）: 新 daemon は transport≈0 から始まるので、復帰後の
  //     daemonNowSec は kill 直前より大きく下がる（stale anchor の ~Ns を引きずらない）。
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
  // fresh daemon: 新 daemon の uptime は kill からの経過実時間を超えない（古い daemon の累積
  //   uptime ≥ preKillNowSec を引き継いでいない）。preKillNowSec 基準だと #335 の長い recovery
  //   待ちで margin が薄れるため、wall-clock の経過を上界にする（+2s は status RTT 等の余裕）。
  const elapsedSinceKillSec = (Date.now() - killWallMs) / 1000
  expect(Number(status.uptime_sec)).toBeLessThan(elapsedSinceKillSec + 2)
  expect(Number(status.loaded_samples)).toBeGreaterThanOrEqual(1) // sample 再ロード済み
  expect(Number(status.active_plays)).toBeGreaterThanOrEqual(0) // orphan なし（有限・健全）
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
    const killWallMs = Date.now()

    // 復旧を待つ。gap 中は executePlayback の guard が dispatch を drop し onDispatch を呼ばないので、
    // killMark を超える dispatch は全て respawn 後（= active loops の構造的復帰の観測）。
    await waitFor(() => dispatches.length > killMark + 3, { timeoutMs: 12000 })

    const post = dispatches.slice(killMark)

    // recovery 不変式（liveness/新 pid・transport 再 anchor・onset clip なし・daemon 状態）。
    await assertRecoveryInvariants(p, post, preKillPid, preKillNowSec, killWallMs)
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

// =============================================================================
// #335 — A4-PR4: active-loops across-respawn e2e（full DSL・interpreter 駆動）
//
// #300 の recovery floor は player-level proxy（`p.scheduleEvent()` 直叩き）で active loops
// の復帰を「構造論 + 連続供給の代理」で確認した（上の describe）。本ブロックはその意図的 defer
// を A4 完了時点で consolidation する: 実 interpreter（InterpreterV2）が full DSL の `LOOP()` を
// 駆動し、実 daemon を respawn 跨いで dispatch が継続することを state-level に観測する。
//
// 「createAudioEngine 経由」(spec §4/§5) の意 = 実 interpreter + 実 RustEnginePlayer 経路。
// createAudioEngine(rust) は `new RustEnginePlayer()` を引数なしで構築するだけの薄い env factory
// なので、onDispatch を得るために booted player を直接構築して InterpreterV2 に注入する
// （production 変更ゼロ・leg2 の RecordingScheduler 注入と同じ seam）。
//
// full DSL surface（pan / chop 領域 / per-sequence gain / varispeed rate≠1.0 / LinkAudio output
// channel / tempo leader）はすべて fixture に載る。ただし DispatchInfo は timing + gain + sample
// しか surface しない（pan / rate / output_channel は daemon.playAt へ渡るが onDispatch にも
// GetStatus にも出ない）ため、state-assert できるのは dispatch 継続 / 再 anchor / lead /
// per-sequence gain / sample 再ロード / active_plays まで。pan / rate / output_channel は payload
// として respawn 跨ぎで exercise されるが値は assert しない（per-param 正しさは PR1-3 の offline
// テスト + 下の非gated rate guard が担保・capture ベース検証は §6 で OUT）。
// daemon は default build（feature `link-audio` OFF）なので LinkAudio egress / tempo push は
// warn-once no-op（hardware bus へ）= LinkAudio 自体の recovery は検証しない（観測 seam 不在）。
// =============================================================================

const SNARE = path.join(REPO_ROOT, 'test-assets/audio/snare.wav')
const ARPEGGIO = path.join(REPO_ROOT, 'test-assets/audio/arpeggio_c.wav')

/** fixture が参照する全サンプルの実尺（秒）。varispeed rate の決定論計算に使う。 */
const DURATIONS: Record<string, number> = {
  [KICK]: 0.5,
  [SNARE]: 0.2,
  [ARPEGGIO]: 1.0,
}

/**
 * full DSL の `.orbs` ソース。`trigger` で RUN（one-shot・非gated guard 用）/ LOOP（継続・
 * gated e2e 用）を切り替える。audio パスは documentDirectory=REPO_ROOT 相対。
 *
 * chopd: arpeggio(1.0s) を chop(2)→sliceDur 0.5s。tempo120/4-4/length1 → barDur 2.0s、play 8
 * 要素 → eventDur 0.25s。rate = sliceDur/eventDur = 0.5/0.25 = 2.0（genuine varispeed・rate≠1.0）。
 * kick/snare は chop(1)=plain event（slice 経路を通らず自然尺 rate=1.0）。3 seq で pan /
 * per-sequence gain / output channel が分かれる。
 */
function buildFullDslSource(trigger: 'RUN' | 'LOOP'): string {
  return [
    'var global = init GLOBAL',
    'global.tempo(120)',
    'global.beat(4 by 4)',
    'global.linkAudio()',
    'global.start()',
    '',
    'var kick = init global.seq',
    'kick.length(1)',
    'kick.audio("test-assets/audio/kick.wav").chop(1)',
    'kick.output("kick")',
    'kick.defaultGain(-3).defaultPan(-60)',
    'kick.play(1, 0, 1, 0)',
    '',
    'var snare = init global.seq',
    'snare.length(1)',
    'snare.audio("test-assets/audio/snare.wav").chop(1)',
    'snare.output("snare")',
    'snare.defaultGain(-6).defaultPan(60)',
    'snare.play(0, 1, 0, 1)',
    '',
    'var chopd = init global.seq',
    'chopd.beat(4 by 4).length(1)',
    'chopd.audio("test-assets/audio/arpeggio_c.wav").chop(2)',
    'chopd.output("drums")',
    'chopd.defaultGain(-4).defaultPan(20)',
    'chopd.play(1, 2, 1, 2, 1, 2, 1, 2)',
    '',
    `${trigger}(kick, snare, chopd)`,
    '',
  ].join('\n')
}

// --- 非gated: fixture が full DSL を genuine に exercise する証明（CI 常時・daemon 不要） ---
// gated e2e の "full DSL" 主張が hollow（例: 取り違えで varispeed rate=1.0）にならないための
// fixture-integrity guard。#300 recovery の焼き直しではなく、interpreter が出すスケジュールの
// param（rate / pan / gain）を leg2 系（RecordingScheduler）で機械チェックする。
describe('#335 fixture integrity — full DSL produces non-degenerate params (no daemon)', () => {
  afterEach(() => vi.useRealTimers())

  it('chopd は genuine varispeed(rate=2.0)・kick/snare は rate=1.0・pan/gain が分かれる', async () => {
    vi.useFakeTimers()
    const recording = new RecordingScheduler(DURATIONS)
    const interp = new InterpreterV2({ audioEngine: recording })
    await interp.execute(parseAudioDSL(buildFullDslSource('RUN')), {
      documentDirectory: REPO_ROOT,
    })
    const recorded = recording.getRecorded()
    expect(recorded.length).toBeGreaterThan(0)

    // toDaemonParams（本番共有変換）で rate / pan / gain を解決する（1 play 1 回だけ）。
    const resolver = new RustEnginePlayer()
    for (const [abs, sec] of Object.entries(DURATIONS)) resolver.seedDuration(abs, sec)
    const params = recorded.map((play) => ({
      filepath: play.filepath,
      ...resolver.toDaemonParams(play),
    }))

    const arp = params.filter((p) => p.filepath.includes('arpeggio'))
    const nonArp = params.filter((p) => !p.filepath.includes('arpeggio'))
    expect(arp.length).toBeGreaterThan(0)
    expect(nonArp.length).toBeGreaterThan(0)

    // varispeed: chop(2) スロット詰めで rate=2.0（≠1.0 が genuine に起きる）。
    for (const p of arp) expect(p.rate).toBeCloseTo(2.0, 2)
    // kick/snare は chop(1) = slice 経路を通らない plain event（event-scheduler は chopDivisions>1
    //   のときだけ scheduleSliceEvent）。slice なし → toDaemonParams は自然尺 rate=1.0 を返す。
    for (const p of nonArp) expect(p.rate).toBeCloseTo(1.0, 2)

    // pan が 3 seq で別々の正規化値（kick -60→-0.6 / snare +60→+0.6 / chopd +20→+0.2）。
    //   件数でなく値を固定し sign/scale 回帰も捕まえる。
    const pans = new Set(params.map((p) => p.pan.toFixed(3)))
    expect(pans).toEqual(new Set(['-0.600', '0.600', '0.200']))

    // per-sequence gain（各 seq の defaultGain -3/-6/-4 dB が dispatch ごとに乗る）が別々の線形 amp。
    const gains = new Set(params.map((p) => p.gain.toFixed(4)))
    expect(gains.size).toBeGreaterThanOrEqual(3)
  })
})

// --- gated: interpreter 駆動 loop() が daemon SIGKILL→respawn を跨いで dispatch 継続（Done） ---
describe.runIf(RUN)('RustEnginePlayer active-loops across respawn — full DSL (#335)', () => {
  let player: RustEnginePlayer | null = null
  let interp: InterpreterV2 | null = null

  afterEach(async () => {
    // loop timer（loop-sequence.ts の setTimeout・daemon 非依存）を確実に止める。
    // 各 Sequence.stop() = clearTimeout(loopTimer) + setLooping(false)（= 空 LOOP() と同じ経路）。
    // player.quit() だけだと timer が leak して event loop を生かし続ける。stop が throw しても
    // 実 daemon プロセスを確実に終了させるため player.quit() は finally に置く。
    try {
      if (interp) {
        const seqs = (
          interp as unknown as { state?: { sequences?: Map<string, { stop: () => void }> } }
        ).state?.sequences
        // 構造 drift（state/sequences の rename）で cleanup を silent skip しないよう不在なら throw。
        if (!seqs)
          throw new Error('afterEach: interp.state.sequences 不在 — loop timer が leak する恐れ')
        for (const seq of seqs.values()) seq.stop() // Sequence.stop() は必ず存在（?. で握り潰さない）
        interp = null
      }
    } finally {
      if (player) {
        await player.quit()
        player = null
      }
    }
  })

  it('full DSL の LOOP() が SIGKILL→respawn 後も複数 loop で dispatch 継続', async () => {
    const dispatches: DispatchInfo[] = []
    const p = new RustEnginePlayer({
      daemonPath: DAEMON_BIN,
      lookaheadSec: LOOKAHEAD_SEC,
      onDispatch: (info) => dispatches.push(info),
    })
    player = p
    // 実 interpreter に実 player を注入（= createAudioEngine(rust) と同じ player を、onDispatch
    // を得るために直接構築して inject）。execute() が audioEngine.boot() を駆動し、ソース内の
    // global.start() が transportControl→globalScheduler.start()（= p.start()）を呼ぶ。
    const i = new InterpreterV2({ audioEngine: p })
    interp = i
    await i.execute(parseAudioDSL(buildFullDslSource('LOOP')), { documentDirectory: REPO_ROOT })

    // transport を十分進めてから kill（stale anchor ≠ fresh anchor の差を作る。loop は 2s バー
    // 境界で発火するので ≥4s 待つと複数バー分の dispatch が貯まる）。
    await waitFor(() => dispatches.some((d) => d.daemonNowSec >= 4.0), { timeoutMs: 20_000 })

    const preKillPid = p.daemonPid
    const preKillNowSec = dispatches[dispatches.length - 1].daemonNowSec
    const killMark = dispatches.length
    expect(preKillPid).toBeGreaterThan(0)
    expect(preKillNowSec).toBeGreaterThan(4.0)

    // --- SIGKILL（panic hook 素通り = C-ABI segfault 代理）---
    // expect は型を narrow しないので、process.kill(number) のために number|undefined を絞る。
    if (!preKillPid) throw new Error('no daemon pid to kill')
    process.kill(preKillPid, 'SIGKILL')
    const killWallMs = Date.now()

    // respawn + 全 loop の復帰を待つ。復帰判定を sample 多様性に直結させる: chopd は 8 ev/bar と
    // 密なので単純な件数 wait（killMark+N）だと kick/snare が復帰する前に満たされ得る → 3 seq
    // （kick/snare/chopd）すべてが respawn 後に再 dispatch するまで待つ。gap 中の dispatch は guard
    // が drop するので killMark 超えは全て respawn 後。boot+sample 再ロードに時間がかかるので広め。
    const uniquePostSamples = () =>
      new Set(dispatches.slice(killMark).map((d) => path.basename(d.filepath))).size
    await waitFor(() => uniquePostSamples() >= 3, { timeoutMs: 25_000 })

    const post = dispatches.slice(killMark)

    // #300 と共有する recovery 不変式（liveness/新 pid・再 anchor・onset clip なし・daemon 状態）。
    await assertRecoveryInvariants(p, post, preKillPid, preKillNowSec, killWallMs)

    // 以下は interpreter 駆動 full DSL 固有の追加検証（#300 proxy では出せない観測）:
    // (A) active loops（全 3 seq）の漏れない復帰: post dispatch が 3 サンプル全てにまたがる。
    //     上の wait と同条件だが tautology ではない — どれか 1 seq でも復帰しなければ wait が
    //     timeout してテストは fail する（= 「loop 群が漏れなく再 establish」を強制）。
    const postSamples = new Set(post.map((d) => path.basename(d.filepath)))
    expect(postSamples.size).toBe(3)

    // (B) per-sequence gain（各 seq の defaultGain）が respawn を跨いで保持（複数の異なる gain が
    //     流れ続ける）。
    const postGains = new Set(post.map((d) => d.gain.toFixed(4)))
    expect(postGains.size).toBeGreaterThanOrEqual(2)
  }, 70_000)
})
