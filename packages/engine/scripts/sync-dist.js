const path = require('path')
const fs = require('fs/promises')

async function copyDist() {
  const engineDir = path.resolve(__dirname, '..')
  const distDir = path.join(engineDir, 'dist')

  const targets = [
    path.resolve(engineDir, '../vscode-extension/engine/dist'),
  ]

  for (const target of targets) {
    await fs.rm(target, { recursive: true, force: true })
    await fs.mkdir(target, { recursive: true })
    await fs.cp(distDir, target, { recursive: true })
    console.log(`📦 Synced engine dist -> ${target}`)
  }
}

copyDist().catch((error) => {
  console.error('❌ Failed to sync engine dist:', error)
  process.exit(1)
})

