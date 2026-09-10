const path = require('path')
const fs = require('fs/promises')

/** `tsc` が 1 つの `.ts` から出す 4 種類の成果物。 */
const TS_OUTPUT_SUFFIXES = ['.js', '.js.map', '.d.ts', '.d.ts.map']

function sourceStemFor(fileName) {
  for (const suffix of TS_OUTPUT_SUFFIXES) {
    if (fileName.endsWith(suffix)) return fileName.slice(0, -suffix.length)
  }
  return null
}

async function exists(target) {
  try {
    await fs.stat(target)
    return true
  } catch (error) {
    // 🔴 ENOENT だけを「不在」として扱う（#840 レビュー指摘）。ここの結果はそのまま
    // `fs.rm` の根拠になるので、EACCES 等の一時的な I/O エラーを不在に畳むと
    // **正当な出力を消して `.vsix` からモジュールが欠ける**。#654 と同じ形の障害になる。
    if (error && error.code === 'ENOENT') return false
    throw error
  }
}

/**
 * `dist` から「対応するソースがもう無い出力」を落とす。
 *
 * `tsc --build` のインクリメンタルは、ソースを削除しても**既に出力された
 * `.js` / `.d.ts` とその map を消さない**。したがって dist をそのままコピーすると、
 * 削除済みモジュールが `.vsix` に載る。
 *
 * 🔴 特定のバックエンド名を列挙しない。**`src` に `.ts`（または `.tsx`）が在るか**で
 * 判定するので、次に何を消しても、このスクリプトを直す必要がない。
 * `.ts` 以外から来た成果物（コピーされた `.json` 等）には触らない。
 * 空になったディレクトリは畳む。
 *
 * @returns 削除した項目のパス（呼び出し側のログ用）
 */
async function pruneOrphanedOutputs(distDir, srcDir) {
  const entries = await fs.readdir(distDir, { withFileTypes: true })
  // 1 ディレクトリ内の項目は互いに独立なので並行に処理する（`npm run build` の毎回の経路）。
  const removedPerEntry = await Promise.all(
    entries.map(async (entry) => {
      const distPath = path.join(distDir, entry.name)
      if (entry.isDirectory()) {
        const removed = await pruneOrphanedOutputs(distPath, path.join(srcDir, entry.name))
        if ((await fs.readdir(distPath)).length === 0) {
          await fs.rm(distPath, { recursive: true, force: true })
          removed.push(distPath)
        }
        return removed
      }
      const stem = sourceStemFor(entry.name)
      if (!stem) return []
      const [hasTs, hasTsx] = await Promise.all([
        exists(path.join(srcDir, `${stem}.ts`)),
        exists(path.join(srcDir, `${stem}.tsx`)),
      ])
      if (hasTs || hasTsx) return []
      await fs.rm(distPath, { force: true })
      return [distPath]
    }),
  )
  return removedPerEntry.flat()
}

async function copyDist() {
  const engineDir = path.resolve(__dirname, '..')
  const distDir = path.join(engineDir, 'dist')
  const srcDir = path.join(engineDir, 'src')

  const vscodeEngineDir = path.resolve(engineDir, '../vscode-extension/engine')

  // Copy dist directory
  const distTarget = path.join(vscodeEngineDir, 'dist')
  await fs.rm(distTarget, { recursive: true, force: true })
  await fs.mkdir(distTarget, { recursive: true })
  await fs.cp(distDir, distTarget, { recursive: true })
  const orphans = await pruneOrphanedOutputs(distTarget, srcDir)

  // 一度きりの移行掃除: 旧 root-copy / bundle 経路が `engine/` 直下へ置いていた成果物。
  // これらは `tsc` の出力ではないので上の突き合わせでは拾えない。開発者の既存ツリーに
  // 残っていると `.vsix` へ再び載りうるため、明示的に消す。
  await Promise.all(
    ['supercollider', 'scsynth', 'audio/supercollider'].map((legacy) =>
      fs.rm(path.join(vscodeEngineDir, legacy), { recursive: true, force: true }),
    ),
  )

  console.log(`📦 Synced engine dist -> ${distTarget}`)
  if (orphans.length > 0) {
    console.log(`   pruned ${orphans.length} output(s) whose source no longer exists`)
  }
}

// 直接実行された時だけ走らせる。`require()` しても副作用が無いので
// `pruneOrphanedOutputs` をユニットテストから呼べる（出荷物 `.vsix` の中身を決めるロジックなので
// テスト可能であること自体が要件・#840 レビュー指摘）。
if (require.main === module) {
  copyDist().catch((error) => {
    console.error('❌ Failed to sync engine dist:', error)
    process.exit(1)
  })
}

module.exports = { pruneOrphanedOutputs, sourceStemFor, copyDist }
