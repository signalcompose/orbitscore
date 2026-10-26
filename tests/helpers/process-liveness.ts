import { execFileSync } from 'child_process'

/**
 * pid のプロセスがまだ動いているか。刈り取られるまで残るゾンビは動作中とみなさない。
 */
export function isProcessRunning(pid: number): boolean {
  let stat: string
  try {
    stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  } catch (error) {
    const failed = error as { status?: unknown; stdout?: unknown }
    const stdout =
      typeof failed.stdout === 'string'
        ? failed.stdout
        : Buffer.isBuffer(failed.stdout)
          ? failed.stdout.toString('utf8')
          : undefined
    // ps の「該当 PID なし」は exit 1 + 空の stdout。それ以外は検査失敗であり、
    // プロセスが消えた証拠にはならない。
    if (failed.status === 1 && stdout?.trim() === '') return false
    throw error
  }
  if (stat === '') throw new Error(`ps succeeded without reporting state for pid ${pid}`)
  return !stat.startsWith('Z')
}
