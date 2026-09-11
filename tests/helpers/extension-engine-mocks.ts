/**
 * `startEngine()` / `startEngineForAgent()` をユニットで駆動するための共有部品。
 *
 * 🔴 **`vi.mock()` はここに置けない。** ファイル先頭へ巻き上げられるので、各 spec が自分の
 * 相対パスで宣言する必要がある。ここに集めるのは**巻き上げに依存しない部分**だけ:
 * 偽の子プロセスと、`extension.ts` のモジュールスコープ状態のリセットである。
 *
 * リセットの一覧を共有するのが要点で、`__set*ForTest` が 1 本増えた時に**片方の spec だけ
 * 直して他方が黙って古いまま**になるのを防ぐ（現状 2 ファイルが同じ 4 本を呼んでいる）。
 */
import type * as child_process from 'child_process'

/** `__set*ForTest` を持つ extension モジュール（spec ごとに import 経路が違うので構造で受ける）。 */
export interface ExtensionTestHooks {
  __setEngineProcessForTest(process: child_process.ChildProcess | null): void
  __setStatusBarItemForTest(item: { text: string; tooltip: string }): void
  __setOutputChannelForTest(channel: {
    appendLine(line: string): void
    append(s: string): void
  }): void
  __setEngineViewProviderForTest(provider: { refresh(): void }): void
}

export interface FakeSpawnedProcess {
  proc: child_process.ChildProcess
  /** `spawn` の 'error'（ENOENT 等）を次 tick で発火させる。 */
  fireError: (err: Error) => void
}

/**
 * `spawn()` の戻り値として使える最小の子プロセス。
 *
 * `on('error')` の購読を覚えているので、`fireError()` で **Node が実際にやるのと同じ
 * 非同期の経路**（次 tick）で失敗を起こせる。同期 throw との違いが `startEngine` の
 * 検出経路の分かれ目なので、そこを潰さないこと（#533）。
 */
export function fakeSpawnedProcess(): FakeSpawnedProcess {
  const errorListeners: Array<(err: Error) => void> = []
  const proc: Partial<child_process.ChildProcess> = {
    killed: false,
    on: ((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'error') errorListeners.push(cb as (err: Error) => void)
      return proc
    }) as child_process.ChildProcess['on'],
    stdout: { on: () => {} } as unknown as child_process.ChildProcess['stdout'],
    stderr: { on: () => {} } as unknown as child_process.ChildProcess['stderr'],
    stdin: { on: () => {} } as unknown as child_process.ChildProcess['stdin'],
  }
  return {
    proc: proc as child_process.ChildProcess,
    fireError: (err) => {
      process.nextTick(() => errorListeners.forEach((cb) => cb(err)))
    },
  }
}

/**
 * `extension.ts` のモジュールスコープ状態を、engine 起動を駆動できる形へ戻す。
 *
 * 🔴 **`beforeEach` で呼ぶ。** ここを 1 本でも取りこぼすと、`startEngine()` が
 * `statusBarItem!` 等で落ちるのではなく**前のテストの状態を引き継いで**通ってしまう。
 */
export function resetExtensionEngineTestState(ext: ExtensionTestHooks): void {
  ext.__setEngineProcessForTest(null)
  ext.__setStatusBarItemForTest({ text: '', tooltip: '' })
  ext.__setOutputChannelForTest({ appendLine: () => {}, append: () => {} })
  ext.__setEngineViewProviderForTest({ refresh: () => {} })
}
