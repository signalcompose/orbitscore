/**
 * 出荷 `.vsix` の cold install ゲート（#878 / #873）。
 *
 * 🔴 **dev host（`--extensionDevelopmentPath`）はこの層を構造的に一度も通らない。**
 * daemon の解決経路（`monorepo-release` ではなく `extension-bundle`）も、拡張自身の同梱依存も、
 * engine を起動する Node ランタイムの選び方も、cold install でしか実行されない。
 * v3.0.0 では `activate()` すら走らない `.vsix` が凍結タグ直前まで残った（#873）。
 *
 * ここでは 2 つの構成で確かめる:
 *
 * | 構成 | 何を守るか |
 * |---|---|
 * | **strict**（CLI ラッパ経由 + node の無い最小 PATH） | **#878**。VS Code のシェル環境解決に救われない条件。修正前は確定で `spawn node ENOENT` |
 * | **finder**（app 本体を直接起動） | 利用者の通常経路。`.vsix` を入れただけで音が出ること |
 *
 * 🔴 **strict を「Finder より厳しすぎる」と切り捨てない。** `code .` を、nodenv を初期化しない
 * ログインシェルから叩けば同じ条件になる。engine の起動を PATH に依存させない限り両方緑になる。
 *
 * 実行:
 *   cd packages/vscode-extension && npx vsce package --target darwin-arm64 --no-yarn --no-dependencies
 *   ORBIT_GATED_COLD_INSTALL=1 npx vitest run tests/e2e/vsix-cold-install-gated.spec.ts
 */
import { spawn, spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { describe, expect, it, onTestFinished } from 'vitest'

import { createGatedSession, type GatedCatalog } from './helpers/gated-session'
import {
  IPC_SOCKET_SUFFIX_ALLOWANCE,
  UNIX_SOCKET_PATH_MAX,
  userDataDirExceedsSocketLimit,
} from './helpers/harness-processes'
import { pollInitialize } from './helpers/mcp-client'
import { runScore } from './helpers/run-score'

const REPO_ROOT = path.resolve(__dirname, '../..')
const APP = '/Applications/Visual Studio Code.app'
/** インストール用の CLI。`--install-extension` はこちらでしか受けられない。 */
const CODE_CLI = path.join(APP, 'Contents/Resources/app/bin/code')
/**
 * 🔴 通常経路の再現は **app 本体**を直接叩く。`bin/code`（CLI ラッパ）経由だと VS Code は
 * ログインシェルの環境解決を**省く**（端末から引き継ぐ前提のため）ので Finder 相当にならない。
 */
const CODE_APP_BIN = path.join(APP, 'Contents/MacOS/Code')
/** `/etc/paths` 相当。nodenv / Homebrew の node はここに無い。 */
const NODE_LESS_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

const enabled = process.env.ORBIT_GATED_COLD_INSTALL === '1'

function locateVsix(): string {
  const dir = path.join(REPO_ROOT, 'packages/vscode-extension')
  const hits = fs
    .readdirSync(dir)
    .filter((f) => /^orbitscore-darwin-arm64-.*\.vsix$/.test(f))
    .map((f) => path.join(dir, f))
  if (hits.length !== 1) {
    throw new Error(
      `expected exactly 1 packaged .vsix in ${dir}, got ${hits.length}. ` +
        `Run: cd packages/vscode-extension && npx vsce package --target darwin-arm64 ` +
        `--no-yarn --no-dependencies`,
    )
  }
  return hits[0]
}

interface ColdInstall {
  readonly tmpRoot: string
  readonly port: number
}

/**
 * 空の extensions-dir へ `.vsix` を入れ、`--extensionDevelopmentPath` **無し**で起動する。
 * `launcher` と `env` の違いだけが strict / finder の差である。
 */
async function coldInstallAndLaunch(
  slug: string,
  launcher: string,
  env: NodeJS.ProcessEnv,
): Promise<ColdInstall> {
  const vsix = locateVsix()
  // 🔴 `--user-data-dir` は /tmp の短いパスに。macOS の Unix ソケット上限は 103 文字で、
  // VS Code は `<user-data-dir>/<version>-main.sock` を開く（#830）。
  const userDataDir = fs.mkdtempSync(`/tmp/orbcold-u-${slug}-`)
  const extensionsDir = fs.mkdtempSync(`/tmp/orbcold-e-${slug}-`)
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `orbcold-ws-${slug}-`))
  // 🔴 後片付けは**テスト境界**で行う（`afterAll` にまとめない）。この spec はテストごとに
  // VS Code を新規に立てるので、まとめると test 1 のホストと daemon が test 2 の実行中も
  // 生き続け、2 つの daemon が同じオーディオデバイスを奪い合う
  // （memory `orphan-daemon-pins-coreaudio-context` の型）。
  onTestFinished(() => {
    for (const dir of [userDataDir, extensionsDir, tmpRoot]) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  // 🔴 既存ガードを継承する。ここは #830（macOS の Unix ソケット 103 文字上限）に
  // 当たる場所で、`orbitstudio-mcp-gated.spec.ts` は同じ検査を持っている。
  // 引っかかると VS Code は `listen EINVAL` で**ウィンドウを開かずに死ぬ**ので、
  // 60 秒の MCP タイムアウトではなくここで理由ごと落とす。
  if (userDataDirExceedsSocketLimit(userDataDir)) {
    throw new Error(
      `--user-data-dir is too long for a macOS unix socket (${userDataDir.length} chars + ` +
        `~${IPC_SOCKET_SUFFIX_ALLOWANCE} for the socket name > ${UNIX_SOCKET_PATH_MAX}): ` +
        `${userDataDir}. Shorten the per-test prefix.`,
    )
  }

  // 譜面が参照する音素材を workspace 配下へ（相対 audioPath を保つ・#528）。
  fs.mkdirSync(path.join(tmpRoot, 'test-assets'), { recursive: true })
  fs.cpSync(path.join(REPO_ROOT, 'test-assets/audio'), path.join(tmpRoot, 'test-assets/audio'), {
    recursive: true,
  })

  const install = spawnSync(
    CODE_CLI,
    [
      `--extensions-dir=${extensionsDir}`,
      `--user-data-dir=${userDataDir}`,
      '--force',
      '--install-extension',
      vsix,
    ],
    { encoding: 'utf8' },
  )
  expect(install.status, `install failed: ${install.stderr}`).toBe(0)
  expect(fs.readdirSync(extensionsDir).filter((e) => e.includes('orbitscore')).length).toBe(1)

  const port = 39500 + Math.floor(Math.random() * 300)
  const child = spawn(
    launcher,
    [
      '--new-window',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-updates',
      '--disable-telemetry',
      `--user-data-dir=${userDataDir}`,
      `--extensions-dir=${extensionsDir}`,
      tmpRoot,
    ],
    { env: { ...env, ORBITSCORE_MCP_PORT: String(port) }, stdio: 'ignore', detached: false },
  )
  onTestFinished(() => {
    if (!child.killed) child.kill()
    // `userDataDir` は mkdtemp で一意なので、この blanket pkill が利用者の生きた
    // ウィンドウに当たることはない（共有 prefix で当てて事故った過去があるため明記する）。
    spawnSync('pkill', ['-f', `user-data-dir=${userDataDir}`])
  })

  return { tmpRoot, port }
}

/** `.vsix` だけが入った VS Code で、実際に音が出るところまで通す。 */
async function expectSoundFromColdInstall(slug: string, install: ColdInstall): Promise<void> {
  // activate() が走らなければ MCP サーバは立たない — #873 はここで落ちる。
  const client = await pollInitialize(install.port, { intervalMs: 2000, timeoutMs: 90_000 })

  const session = createGatedSession(client, install.tmpRoot, {} as GatedCatalog)
  let windows
  try {
    windows = await runScore(
      session,
      {
        slug,
        lines: [
          'var global = init GLOBAL',
          'global.tempo(120)',
          'global.beat(4 by 4)',
          'global.audioPath("./test-assets/audio")',
          'global.start()',
          '',
          'var kick = init global.seq',
          'kick.beat(4 by 4).length(1)',
          'kick.audio("kick.wav").chop(1)',
          'kick.output()',
          'kick.play(1, 1, 1, 1)',
          '',
          'LOOP(kick)',
        ],
      },
      async (ctx) => {
        await ctx.captureSegment('sound', 2000)
      },
      { capture: true },
    )
  } catch (error) {
    // engine 起動失敗の一次情報は output channel にしか出ない（#878 は `spawn node ENOENT`）。
    const log = (await client.call('get_log', { lines: 500 })).text
    throw new Error(`${String(error)}\n--- OrbitScore output channel ---\n${log}`)
  }

  expect(windows, 'no capture windows were produced').toBeDefined()
  // 🔴 `ok` で終わらせない。音が出たことは WAV の RMS でしか言えない。
  expect(windows!.rms('sound')).toBeGreaterThan(0.01)

  const log = (await client.call('get_log', { lines: 500 })).text
  expect(
    log.split('\n').filter((l) => l.includes('Cannot find module')),
    'the packaged .vsix failed to resolve a bundled dependency',
  ).toEqual([])
}

describe.skipIf(!enabled)('cold install of the packaged .vsix', () => {
  it('makes sound when node is absent from PATH and the shell env is never resolved (#878)', async () => {
    const install = await coldInstallAndLaunch('cold-strict', CODE_CLI, {
      HOME: process.env.HOME ?? '',
      PATH: NODE_LESS_PATH,
      // SHELL を渡さない = VS Code がログインシェルの環境を解決できない。
      // engine の起動が PATH に依存していると、ここで確定で `spawn node ENOENT` になる。
    })
    await expectSoundFromColdInstall('cold-strict', install)
  }, 600_000)

  it('makes sound through the ordinary Finder-equivalent launch (#873)', async () => {
    const install = await coldInstallAndLaunch('cold-finder', CODE_APP_BIN, {
      HOME: process.env.HOME ?? '',
      PATH: NODE_LESS_PATH,
      SHELL: process.env.SHELL ?? '/bin/zsh',
      USER: process.env.USER ?? '',
    })
    await expectSoundFromColdInstall('cold-finder', install)
  }, 600_000)
})
