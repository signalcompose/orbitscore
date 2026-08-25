/**
 * 子プロセスを spawn するテストのための共有フィクスチャ。
 *
 * 🔴 なぜ必要か（2026-08-25 に実測して判明・#520）
 *
 * macOS は**新規に作成された実行ファイル**の spawn 時にセキュリティ評価
 * （Gatekeeper / XProtect / syspolicyd）を行う。実測:
 *
 * | spawn 対象                     | p50     | max     |
 * |--------------------------------|---------|---------|
 * | 既存のシステムバイナリ(/bin/echo) | 1.0ms   | 3ms     |
 * | 毎回新規作成した実行ファイル       | 93.8ms  | 178ms   |
 *
 * さらに、**評価済み(warm)の実行ファイルでも 40 回に 1 回ほど数秒〜24 秒停止する**
 * （実測: 675ms / 3.8s / 9.0s / 24.6s）。この裾は原因未特定で、本ヘルパーでは消せない。
 *
 * この2つが重なると、spawn を含むテストは「検証対象でない deadline」に負けて落ちる。
 * 実際に #520 / #491 / #529 や Rust の oracle_parity が同じ機序で落ちていた。
 *
 * 対策は2段構え:
 *   1. 実行ファイルの新規作成を **per-test から per-file へ**減らし、作成直後に
 *      1 回だけ空 spawn して評価を済ませておく（= 本ヘルパー）
 *   2. それでも残る裾に対し、deadline を実測の裾に耐える値にする（= SPAWN_TEST_TIMEOUT_MS）
 */

import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

/**
 * spawn を含むテストに与える vitest タイムアウト。
 *
 * vitest の既定は 5000ms で、実測の裾（最大 24.6s）に負ける。ここで待つのは
 * **検証対象ではない**（テストが検証するのは argv の中身や scan の結果であって、
 * 子プロセスが何 ms で起動するかではない）ので、裾に耐える値まで広げる。
 * 正常時は数 ms で抜けるため、広げても実行時間は変わらない。
 *
 * 🔴 これを 5000ms 付近まで下げるとフレークが戻る。
 */
export const SPAWN_TEST_TIMEOUT_MS = 30_000

/**
 * 実行可能なスクリプトを作成し、**1 回だけ空 spawn して macOS の評価を済ませて**返す。
 *
 * 呼び出し側は `beforeAll` で 1 回だけ呼ぶこと（`beforeEach` で呼ぶと per-test で
 * 新規ファイルが増え、対策の意味が無くなる）。
 */
export async function createWarmExecutable(
  dir: string,
  name: string,
  script: string,
): Promise<string> {
  const binPath = path.join(dir, name)
  fs.writeFileSync(binPath, script, { mode: 0o755 })
  await warmUpExecutable(binPath)
  return binPath
}

/**
 * 既に存在する実行ファイルを 1 回空 spawn して、初回評価のコストを先払いする。
 *
 * 🔴 **exit を待ってはいけない。** 対象にはわざとハングするフィクスチャ
 * （`tests/fixtures/plugin-catalog/scan-hang.sh` 等）が含まれ、exit は永遠に来ない。
 * 待つべきは Node の `'spawn'` イベント = **プロセスの起動が成功した時点**で、
 * macOS の評価はここまでに完了している。目的を達したら即 kill する。
 */
export async function warmUpExecutable(binPath: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn(binPath, [], { stdio: ['ignore', 'ignore', 'ignore'] })
    child.once('spawn', () => {
      try {
        child.kill('SIGKILL')
      } catch {
        // 既に終了している場合の kill は no-op。warm up の目的は達成済み。
      }
      resolve()
    })
    // spawn 自体が失敗する対象（存在しない interpreter の shebang 等）もある。
    // その場合も評価は走っているので、warm up としては成功扱いでよい。
    child.once('error', () => resolve())
  })
}
