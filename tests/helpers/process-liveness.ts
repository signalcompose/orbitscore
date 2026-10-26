import { execFileSync } from 'child_process'

/**
 * pid のプロセスがまだ動いているか。刈り取られるまで残るゾンビは動作中とみなさない。
 */
export function isProcessRunning(pid: number): boolean {
  let stat = ''
  try {
    stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  } catch {
    // ps は該当プロセスが無いと非ゼロで終わる。
  }
  return stat !== '' && !stat.startsWith('Z')
}
