/**
 * 現在稼働中の interpreter の登録簿。
 *
 * 🔴 なぜ必要か（#607・2026-08-25 実測）
 *
 * `cli-audio.ts` は `executeCommand()` の**戻り値**で `globalInterpreter` を代入し、
 * shutdown ハンドラはそれを見ていた。しかし REPL / test など**長時間走るモードでは
 * `executeCommand()` は返らない**（`execute-command.ts` のコメントが
 * "startREPLMode() never resolves, so this never returns" と明記している）。
 *
 * 結果、拡張が使う live coding（REPL）モードでは shutdown ハンドラが常に `null` を受け取り、
 * `if (interpreter)` ブロックごと飛ばして `process.exit(0)` に直行していた。
 * **`audioEngine.quit()` は一度も呼ばれず、Rust daemon が孤児化する。**
 *
 * 実測（stop_engine 後）:
 *   [PROBE] shutdown entered interpreter=false
 *   → daemon PID は生存・PPID=1 へ reparent・coreaudiod の音声出力コンテキストを保持し続ける
 *
 * 孤児が溜まると coreaudiod が暴走する（同日実測: 残留 65 個で CPU 907%・メモリ 9GB）。
 *
 * 対策は「**生成時に publish する**」こと。戻り値の代入に依存しない。
 */

import { InterpreterV2 } from '../interpreter/interpreter-v2'

let activeInterpreter: InterpreterV2 | null = null

/** interpreter を生成した側が、生成直後に必ず呼ぶ。 */
export function setActiveInterpreter(interpreter: InterpreterV2 | null): void {
  activeInterpreter = interpreter
}

/** shutdown ハンドラ等が、いま生きている interpreter を取得する。 */
export function getActiveInterpreter(): InterpreterV2 | null {
  return activeInterpreter
}
