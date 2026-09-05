/**
 * 実機の出力デバイス一覧（`orbit-audio-daemon --list-audio-devices`）を読む。
 *
 * 🔴 なぜヘルパーにするか（2026-09-05・#661）: 「daemon を叩いて既定の出力デバイス名を取る」
 * 5 行が gated spec の中に **3 箇所**（D-0 / D-2 / D-3）並んでいた。`--list-audio-devices` の
 * 出力形（`isDefault` フィールド名など）が変われば 3 箇所を漏れなく直す必要があり、
 * 実際 D-3 は D-2 のラムダ変数名だけを変えた丸写しになっていた。
 *
 * デバイス解決の正本は `resolveDaemonBinaryPath()`（explicit → env → release → debug → bundled）。
 * ここでその正本を経由することで、テストが別のバイナリを見に行く事故も同時に塞ぐ。
 */
import { execFileSync } from 'child_process'

import { resolveDaemonBinaryPath } from '../../../packages/engine/src/audio/rust-engine/daemon-client'

export interface ListedAudioDevice {
  readonly name: string
  readonly isDefault: boolean
}

/** daemon が報告する出力デバイス。空配列もありうる（呼び出し側が判定する）。 */
export function listOutputDevices(): readonly ListedAudioDevice[] {
  const daemonBinary = resolveDaemonBinaryPath().path
  const listed = JSON.parse(
    execFileSync(daemonBinary, ['--list-audio-devices'], { encoding: 'utf8' }),
  ) as { devices: ListedAudioDevice[] }
  return listed.devices
}

/**
 * 既定の出力デバイス名。`isDefault` が無ければ先頭を使う。
 *
 * `label` は失敗時に**どのテストが要求したか**を示すために使う（実機は 1 テスト 8〜15 秒
 * かかるので、どのケースで足りなかったかが分からないと測り直しになる）。
 */
export function defaultOutputDeviceName(label: string): string {
  const devices = listOutputDevices()
  const requested = devices.find((device) => device.isDefault) ?? devices[0]
  if (!requested) throw new Error(`${label} requires an output device, but the daemon listed none`)
  return requested.name
}
