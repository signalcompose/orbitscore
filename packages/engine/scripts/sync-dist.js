const path = require('path')
const fs = require('fs/promises')

async function removeRetiredBackend(target) {
  await fs.rm(path.join(target, 'audio/supercollider'), { recursive: true, force: true })
  for (const suffix of ['.d.ts', '.d.ts.map', '.js', '.js.map']) {
    await fs.rm(path.join(target, `audio/supercollider-player${suffix}`), { force: true })
  }
}

async function copyDist() {
  const engineDir = path.resolve(__dirname, '..')
  const distDir = path.join(engineDir, 'dist')

  const vscodeEngineDir = path.resolve(engineDir, '../vscode-extension/engine')

  // Copy dist directory
  const distTarget = path.join(vscodeEngineDir, 'dist')
  await fs.rm(distTarget, { recursive: true, force: true })
  await fs.mkdir(distTarget, { recursive: true })
  await fs.cp(distDir, distTarget, { recursive: true })
  await removeRetiredBackend(distTarget)

  // Clean ignored artifacts produced by the old root-copy and bundle paths so
  // a local rebuild cannot accidentally reintroduce retired files into a VSIX.
  await removeRetiredBackend(vscodeEngineDir)
  await fs.rm(path.join(vscodeEngineDir, 'supercollider'), { recursive: true, force: true })
  await fs.rm(path.join(vscodeEngineDir, 'scsynth'), { recursive: true, force: true })
  console.log(`📦 Synced engine dist -> ${distTarget}`)
}

copyDist().catch((error) => {
  console.error('❌ Failed to sync engine dist:', error)
  process.exit(1)
})
