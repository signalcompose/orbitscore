/**
 * daemon を子プロセスとして起動する形（引数と stdio）。
 *
 * 🔴 #996: daemon は **stdin の EOF**（主）と**親 PID の付け替え**（補助）で engine の死を
 * 自分で知る（Rust 側 `orbit-audio-daemon/src/parent_watch.rs`・設計 848 §4.4 F-1）。
 * engine が SIGKILL で落ちても、カーネルが stdin の書き端を閉じるので daemon は EOF を受ける。
 * そのため engine は stdin を**パイプ**で渡し、生きている間は閉じない（何も書かない）。
 *
 * どちらの監視も **daemon は引数で明示された時だけ**行う。古い engine は stdin を `'ignore'`
 * （= `/dev/null`）で渡すので、無条件に EOF を親の死とみなす daemon は古い engine と組むと
 * 起動直後に終了してしまう。逆に新しい engine と古い daemon の組み合わせでは、daemon は未知の
 * 引数を無視し stdin を読まないので、従来どおり動く。
 */
import { ChildProcess, spawn } from 'child_process'

/**
 * daemon の argv。`--audio-device <name>` は daemon 起動時のみ honor される（#484 D1・
 * ランタイム切替は D2）。名前が不一致でも daemon は起動を落とさず stderr に警告して host 既定へ
 * 縮退する。
 */
export function daemonSpawnArgs(audioDevice: string | undefined, parentPid: number): string[] {
  return [
    ...(audioDevice ? ['--audio-device', audioDevice] : []),
    '--exit-on-stdin-eof',
    '--parent-pid',
    String(parentPid),
  ]
}

/** daemon を起動する。親 PID はこのプロセス（engine）自身。 */
export function spawnDaemonProcess(
  binary: string,
  audioDevice: string | undefined,
  env: NodeJS.ProcessEnv,
): ChildProcess {
  const child = spawn(binary, daemonSpawnArgs(audioDevice, process.pid), {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  })
  // 書き端の 'error'（daemon が先に死んだ後の EPIPE 等）を拾わないと、EventEmitter の
  // unhandled 'error' が engine ごと落とす（`connectWebSocket` の永続 error listener と同じ理由）。
  child.stdin?.on('error', (err) => console.warn('DaemonClient: daemon stdin error:', err))
  return child
}
