/**
 * rack effect child（#628）の PID を **daemon のログから**読む。
 *
 * 🔴 なぜ `pluginChildPids` を使えないか: あれは child のコマンドラインに
 * `--plugin <絶対パス>` が現れることを前提に `pgrep -f` する。rack child は
 * **`--chain <manifest.json>`** で起動するので、プラグインのパスはコマンドラインに
 * 出ない（manifest はテンポラリファイル）。#628 §6 の R28-E1〜E10 はいずれも
 * 「child PID 不変 = respawn していない」を判定条件にしているため、別経路が要る。
 *
 * daemon は spawn 時に `[orbit-effect-rack] child spawned pid=<n> shm=<path>` を
 * `tracing::info!` で名乗る（`outproc_effect.rs`）。**MCP の tool 表面を増やさず**、
 * ERROR 計数や `[plugin-state]` 行と同じ `get_log` 経路で読めるようにしてある。
 *
 * 🔴 **なぜ spec ではなくここに置くか**（#668 §3.4・PR-E1）: 以前は gated spec が
 * これを export し、`rack-child-pid-oracle.spec.ts` が `.spec.ts` から import していた。
 * spec を分割すると import 元が消えるうえ、テストファイルを他のテストが読む形は
 * vitest の発見単位とも噛み合わない。helper へ出して両方がここを見る。
 */

/**
 * ログに現れた順の rack child PID。
 *
 * @returns 最後の要素が最新の spawn
 */
export function rackChildPidsFromLog(logText: string): number[] {
  const pids: number[] = []
  for (const match of logText.matchAll(/\[orbit-effect-rack\] child spawned pid=(\d+)/g)) {
    const pid = Number(match[1])
    if (Number.isSafeInteger(pid) && pid > 0) pids.push(pid)
  }
  return pids
}

/** rack child の最新 PID。spawn がまだなら null。 */
export function latestRackChildPid(logText: string): number | null {
  const pids = rackChildPidsFromLog(logText)
  return pids.length > 0 ? pids[pids.length - 1] : null
}
