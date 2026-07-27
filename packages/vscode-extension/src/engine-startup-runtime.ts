import * as fs from 'fs'

export interface EngineBinaryResolution {
  path: string
  source: string
}

/**
 * Runtime boundary for the engine build copied into the packaged extension.
 *
 * Keeping the dynamic require here lets unit tests replace this boundary
 * without requiring the ignored extension build artifacts to exist.
 */
export function resolveDaemonBinaryForExtension(): EngineBinaryResolution {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const daemonModule = require('../engine/dist/audio/rust-engine/daemon-client') as {
    resolveDaemonBinaryPath: (explicitPath?: string) => EngineBinaryResolution
  }
  return daemonModule.resolveDaemonBinaryPath()
}

export function extensionEngineFileExists(enginePath: string): boolean {
  return fs.existsSync(enginePath)
}
