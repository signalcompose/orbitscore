import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { describe, it, expect } from 'vitest'

/**
 * #548 回帰ピン: daemon が spawn しうる out-of-process child が、拡張のバンドルに
 * 含まれていることを保証する。
 *
 * **なぜ二重台帳か**: `orbit-vst3-effect-child` は daemon 側（`outproc_effect.rs`）が
 * `ORBIT_EFFECT_FORMAT=vst3` のとき spawn しようとするのに、`copy-daemon-bin.sh` の
 * コピー対象から漏れていた。出荷された拡張で VST3 エフェクトの spawn が
 * `No such file or directory (os error 2)` で失敗する（実機で再現確認済み）。
 *
 * この欠落を **gated テストは構造的に検出できない** — gated テストは自前で
 * `cargo build -p orbit-vst3-effect-child` してから走るため、バンドル経路を通らない。
 *
 * 台帳A（要求）= daemon Rust ソース中の child 実行ファイル名リテラル
 * 台帳B（供給）= `copy-daemon-bin.sh` のコピー対象 + 実際にバンドルされたファイル
 *
 * A ⊆ B を検査する。daemon に新しい format を足すと自動的に本テストが要求を増やす。
 */

const REPO_ROOT = path.resolve(__dirname, '../..')
const DAEMON_SRC = path.join(REPO_ROOT, 'rust/crates/orbit-audio-daemon/src')
const COPY_SCRIPT = path.join(REPO_ROOT, 'scripts/copy-daemon-bin.sh')
const RELEASE_WORKFLOW = path.join(REPO_ROOT, '.github/workflows/release.yml')

/** daemon の outproc モジュールと、それぞれが必ず持つ format 分岐の数（Clap / Vst3）。 */
const OUTPROC_MODULES = ['outproc_effect.rs', 'outproc_instrument.rs'] as const
const FORMATS_PER_MODULE = 2

/**
 * 台帳A: daemon が spawn しうる child 実行ファイル名（Rust ソースのリテラルから導出）。
 *
 * **パターンを名前の形に依存させない**: 初版は `orbit-[a-z0-9-]+-child` と綴りを決め打ちして
 * いたため、child をリネームすると**抽出が黙って取りこぼして台帳Aが縮み、テストが pass して
 * しまう**（変異検証で発覚）。`=>` の右辺の `orbit-*` リテラルをすべて拾い、件数で
 * 取りこぼしを検出する。
 */
function requiredChildBinariesByModule(): Map<string, string[]> {
  const byModule = new Map<string, string[]>()
  for (const file of OUTPROC_MODULES) {
    const src = fs.readFileSync(path.join(DAEMON_SRC, file), 'utf8')
    // `Self::Vst3 => "orbit-vst3-effect-child",` の形の match アームから抽出する。
    const names = new Set([...src.matchAll(/=>\s*"(orbit-[^"]+)"/g)].map((m) => m[1]))
    byModule.set(file, [...names].sort())
  }
  return byModule
}

function requiredChildBinaries(): string[] {
  const all = new Set<string>()
  for (const names of requiredChildBinariesByModule().values()) {
    for (const n of names) all.add(n)
  }
  return [...all].sort()
}

/** 台帳B-1: `copy-daemon-bin.sh` が copy_binary で運ぶ名前。 */
function copiedByScript(script: string): string[] {
  return [...script.matchAll(/^copy_binary\s+"([^"]+)"/gm)].map((m) => m[1]).sort()
}

/** `cargo build ... -p NAME` 群に現れる package 名（copy-daemon-bin.sh / release.yml 共通）。 */
function cargoBuiltPackages(text: string): Set<string> {
  return new Set([...text.matchAll(/-p\s+(orbit-[a-z0-9-]+)/g)].map((m) => m[1]))
}

/**
 * 台帳B-2: 実際にバンドルされたファイル（ビルド済みのときのみ存在。gitignore 対象）。
 *
 * `<platform>-<arch>` のディレクトリ命名は Node 慣習で、production 側の
 * `plugin-catalog-reader.ts`（`resolvePluginScanBinaryPath`）と
 * `daemon-client.ts`（`resolveDaemonBinaryPath`）が同じ規則で組み立てている。
 * 共有ヘルパは存在しないため、ここでも同じ規則を再現している（規則を変えるときは3箇所同時）。
 */
function bundledBinaries(): string[] | undefined {
  const dir = path.join(
    REPO_ROOT,
    'packages/vscode-extension/engine/bin',
    `${process.platform}-${process.arch}`,
  )
  if (!fs.existsSync(dir)) return undefined
  return fs.readdirSync(dir).sort()
}

/**
 * 台帳C: `release.yml` の post-package gate が **出荷 `.vsix` に対して**存在を検査する child 名。
 *
 * **この gate が本バグの唯一のセーフティネットである** — `copy_binary` の行が将来誤って
 * 削除されても、gate が検査していれば出荷前に落ちる。gate 自身が台帳から漏れていると、
 * 同じ実害が無警告で再出荷される（初版はまさにこの状態だった）。
 */
function checkedByReleaseGate(workflow: string): string[] {
  const m = workflow.match(/for\s+CHILD_BIN\s+in\s+([^;]+);/)
  if (!m) return []
  return m[1].trim().split(/\s+/).sort()
}

/**
 * `release.yml` の post-package gate（`for CHILD_BIN … done`）を **原文のまま抜き出す**。
 *
 * 台帳照合（テキスト）だけでは `exit 1` が消えても検出できない — 実際に走らせて
 * 終了コードを見るための素材を取る。YAML の `run: |` ブロック内なので共通インデントを剥がす。
 */
function extractReleaseGateScript(workflow: string): string {
  const start = workflow.indexOf('          for CHILD_BIN in')
  if (start < 0) return ''
  const endMarker = '\n          done\n'
  const end = workflow.indexOf(endMarker, start)
  if (end < 0) return ''
  return workflow
    .slice(start, end + endMarker.length)
    .split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n')
}

/** 抽出した gate を、与えたバイナリ集合を持つ一時 .vsix 展開ディレクトリに対して実行する。 */
function runReleaseGate(gateScript: string, presentBinaries: string[]): number {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-gate-'))
  try {
    const binDir = path.join(root, 'extension/engine/bin/darwin-arm64')
    fs.mkdirSync(binDir, { recursive: true })
    for (const name of presentBinaries) {
      const p = path.join(binDir, name)
      fs.writeFileSync(p, '#!/bin/sh\nexit 0\n')
      fs.chmodSync(p, 0o755)
    }
    try {
      execFileSync('bash', ['-c', `set -euo pipefail\nVSIX_CHECK="${root}"\n${gateScript}`], {
        stdio: 'pipe',
      })
      return 0
    } catch (error) {
      return (error as { status?: number }).status ?? -1
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe('#548 bundled out-of-process child binaries', () => {
  it('daemon が spawn しうる child はすべて copy-daemon-bin.sh のコピー対象である', () => {
    const byModule = requiredChildBinariesByModule()
    const required = [...new Set([...byModule.values()].flat())].sort()
    const copied = copiedByScript(fs.readFileSync(COPY_SCRIPT, 'utf8'))

    // 🔴 台帳Aの取りこぼしを検出する。空振り（0件）だけでなく **部分的な縮み** も
    // success にしない — 各 outproc モジュールは Clap / Vst3 の2分岐を必ず持つ。
    // format を増やしたらここが落ちるので、バンドル側の追従が強制される。
    for (const [file, names] of byModule) {
      expect(
        names.length,
        `${file} から抽出した child 名が ${names.length} 件（期待: ${FORMATS_PER_MODULE} 以上）— ` +
          `抽出パターンが実装に追従できていないか、format が増減した`,
      ).toBeGreaterThanOrEqual(FORMATS_PER_MODULE)
    }

    const missing = required.filter((name) => !copied.includes(name))
    expect(
      missing,
      `daemon は spawn しようとするのに copy-daemon-bin.sh がコピーしない child: ` +
        `${missing.join(', ')} — 出荷版で spawn が ENOENT で失敗する`,
    ).toEqual([])
  })

  it('コピー対象は cargo の再ビルド対象にも含まれている', () => {
    const script = fs.readFileSync(COPY_SCRIPT, 'utf8')
    const built = cargoBuiltPackages(script)

    const notBuilt = copiedByScript(script).filter((name) => !built.has(name))
    expect(
      notBuilt,
      `copy_binary の対象なのに cargo build の -p に無い: ${notBuilt.join(', ')} — ` +
        `stale なバイナリが黙ってコピーされる（#487 の再発）`,
    ).toEqual([])
  })

  it('release.yml が required child をビルドし、post-package gate で検査している', () => {
    const workflow = fs.readFileSync(RELEASE_WORKFLOW, 'utf8')
    const required = requiredChildBinaries()

    const notBuilt = required.filter((name) => !cargoBuiltPackages(workflow).has(name))
    expect(
      notBuilt,
      `release.yml の cargo build に無い child: ${notBuilt.join(', ')} — ` +
        `ビルド失敗が fail-loud 経路を通らず、copy-daemon-bin.sh の best-effort に落ちる`,
    ).toEqual([])

    const gated = checkedByReleaseGate(workflow)
    expect(gated.length, 'post-package gate の CHILD_BIN ループを抽出できていない').toBeGreaterThan(
      0,
    )

    const notGated = required.filter((name) => !gated.includes(name))
    expect(
      notGated,
      `post-package gate が出荷 .vsix で検査しない child: ${notGated.join(', ')} — ` +
        `copy_binary の行が将来削除されても検出できず、同じ実害が無警告で再出荷される`,
    ).toEqual([])
  })

  // 🔴 台帳照合（テキスト）だけでは `exit 1` が消えても検出できない — gate から
  // `exit 1` を抜いてもリスト抽出結果は同一なので上のテストは green のままになる。
  // **gate を実際に走らせて終了コードを見る**ことでしか、fail-loud は保証できない。
  it('post-package gate は child が欠けていると実際に非ゼロ終了する', () => {
    const workflow = fs.readFileSync(RELEASE_WORKFLOW, 'utf8')
    const gateScript = extractReleaseGateScript(workflow)
    expect(
      gateScript,
      'release.yml から post-package gate の for ループを抽出できていない',
    ).toContain('CHILD_BIN')

    const required = requiredChildBinaries()

    // 全部揃っていれば通過する（gate が常に落ちるだけの無意味な検査になっていないことの確認）。
    expect(runReleaseGate(gateScript, required), 'すべて揃っているのに gate が落ちた').toBe(0)

    // 1つずつ欠かして、**必ず**非ゼロ終了することを確認する。
    for (const omitted of required) {
      const present = required.filter((name) => name !== omitted)
      expect(
        runReleaseGate(gateScript, present),
        `${omitted} が欠けているのに gate が通過した — 出荷ゲートが fail-loud でない`,
      ).not.toBe(0)
    }
  })

  it('ビルド済みなら、バンドル実体にも required child がすべて存在する', () => {
    const bundled = bundledBinaries()
    if (bundled === undefined) {
      // 未ビルド環境（fresh clone / CI の build 前）では実体が無い。ここを skip にしても
      // 上2つの台帳照合が原因側を押さえているので穴にはならない。
      return
    }
    const missing = requiredChildBinaries().filter((name) => !bundled.includes(name))
    expect(
      missing,
      `バンドル実体に無い child: ${missing.join(', ')} — ` +
        `スクリプトは正しいがビルド成果物が古い可能性がある（npm run build:clean を試す）`,
    ).toEqual([])
  })
})
