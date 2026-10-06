/**
 * daemon の stderr を行に組み直し、エラー行とそれ以外（tracing の INFO 等）に分ける部品。
 * spawn やプロトコルを持つ `daemon-client.ts` から切り離した、状態を持たない行処理だけを置く
 * （クロージャ内の `partial` を除く）。拡張側の同型は `createLinePrefixer`（engine-handlers.ts）。
 */

/** daemon の tracing 出力が付ける ANSI 色コード（level 判定の前に剥がす）。 */
// eslint-disable-next-line no-control-regex -- ESC (\x1b) はまさに剥がしたい対象の制御文字
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g

/**
 * 起動後に転送する daemon stderr 行のうち、エラーとして扱うべきでないものを判定する
 * （tracing の `TRACE`/`DEBUG`/`INFO` 行）。
 *
 * 🔴 #605 の転送は全行を `console.error` に流していたため、daemon の INFO tracing
 * （例: `INFO orbit_audio_daemon: listening on 127.0.0.1:...`）まで拡張側で
 * `ERROR:` として記録され、get_log の ERROR 前後比較を数える側（gated E2E・LLM の
 * 自己検証）が実際に壊れた。level token を読み取れない行（panic・生 print）は
 * fail-loud に error 側へ倒す。
 */
export function isDaemonNonErrorTracingLine(line: string): boolean {
  const plain = line.replace(ANSI_ESCAPE_RE, '')
  // tracing 既定形式の「ISO timestamp + level token」だけを non-error と認める。
  // 判定を緩めて本文中の "INFO" を拾うと本物のエラーが log から消える側に倒れるので、
  // 迷ったら error 側（従来挙動）へ。
  //
  // 🔴 `WARN` を非エラー側に入れているのは意図的（owner 判断・2026-08-28）。**警告は定義上
  // エラーではない。** #628 で rack child に tracing subscriber を入れたところ、副作用で
  // `orbit-clap-host` の中継が un-silence され、**プラグイン自身の正常動作の警告**
  // （`NotePortsExtension なし; port 0 を使用` 等）が `ERROR:` として記録された。
  // 実機ゲートで**既存テストを含む 7 件**が「ERROR 行が増えた」で落ちたのがこれ
  // （15 → 17）。行そのものは `get_log` に残る — `console.error` ではなく
  // `console.log` へ回るだけで、**診断が消えるわけではない**。
  if (/^\s*\d{4}-\d{2}-\d{2}T\S+\s+(TRACE|DEBUG|INFO|WARN)\s/.test(plain)) return true
  // child プロセスは daemon の stderr を継承し、tracing を持たない(依存を足していない)。
  // level トークンを自分で名乗った行だけを非エラーとして認める(例: "plugin.process() failed")。
  //
  // 🔴 タグは `-child` に限らない(#625)。VST3/CLAP の host crate は **child プロセスの中に
  // リンクされて動く**ので、行の出所は child でもタグは `[orbit-vst3-host]` のように名乗る。
  // 以前は `-child` 終端だけを認めていたため、host が `INFO ` を名乗っても ERROR へ倒れ、
  // **state 復元のたびに正常動作が ERROR として記録されていた**(実機 E2E で発覚)。
  // 判定に load-bearing なのは (1) 自分のコンポーネントのタグであること (2) 非エラーの
  // level を名乗っていること の 2 点で、接尾辞ではない。
  return /^\s*(TRACE|DEBUG|INFO|WARN)\s+\[orbit-[a-z0-9-]+\]\s/.test(plain)
}

/**
 * daemon stderr の chunk を**完全な行**へ組み直し、level で振り分けて emit する。
 *
 * 🔴 chunk 境界は行境界と一致しない。素朴に `split('\n')` すると行の後半が独立した
 * 「行」になり、level トークンを持たないので **成功行の続きが ERROR として記録される**
 * （#618 の E2E をカタログ経路へ寄せた際、行数が増えて境界がずれ実際に発生した）。
 * 改行が来るまで持ち越すことでこれを防ぐ。呼び出し側でクロージャに埋めると
 * テストできないので、純関数として切り出してある。
 */
export function createDaemonStderrLineRouter(
  onNonError: (line: string) => void,
  onError: (line: string) => void,
): { push: (chunk: string) => void; flush: () => void } {
  let partial = ''
  const route = (line: string): void => {
    if (!line.trim()) return
    if (isDaemonNonErrorTracingLine(line)) onNonError(line)
    else onError(line)
  }
  return {
    push(chunk: string): void {
      partial += chunk
      const lines = partial.split('\n')
      partial = lines.pop() ?? ''
      for (const line of lines) route(line)
    },
    // 🔴 #777: stderr の終端で、改行の無い最後の行を吐き出す。daemon が panic / SIGSEGV で
    // 死ぬとき最後の診断は改行なしで切れることがあり、持ち越したままだと**クラッシュ経路の
    // 最後の手がかりが構造的に落ちる**。拡張側の双子 `createLinePrefixer`（#756）と同じ形。
    flush(): void {
      const remaining = partial
      partial = ''
      route(remaining)
    },
  }
}
