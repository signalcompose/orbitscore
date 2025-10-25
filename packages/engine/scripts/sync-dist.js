const path = require('path')
const fs = require('fs/promises')

async function copyDist() {
  const engineDir = path.resolve(__dirname, '..')
  const distDir = path.join(engineDir, 'dist')
  const supercolliderDir = path.join(engineDir, 'supercollider')

  const vscodeEngineDir = path.resolve(engineDir, '../vscode-extension/engine')

  // Copy dist directory
  const distTarget = path.join(vscodeEngineDir, 'dist')
  await fs.rm(distTarget, { recursive: true, force: true })
  await fs.mkdir(distTarget, { recursive: true })
  await fs.cp(distDir, distTarget, { recursive: true })
  console.log(`📦 Synced engine dist -> ${distTarget}`)

  // Copy supercollider directory
  const supercolliderTarget = path.join(vscodeEngineDir, 'supercollider')
  await fs.rm(supercolliderTarget, { recursive: true, force: true })
  await fs.mkdir(supercolliderTarget, { recursive: true })
  await fs.cp(supercolliderDir, supercolliderTarget, { recursive: true })
  console.log(`📦 Synced supercollider -> ${supercolliderTarget}`)
}

copyDist().catch((error) => {
  console.error('❌ Failed to sync engine dist:', error)
  process.exit(1)
})

