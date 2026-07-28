import * as fs from 'fs'
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
function copiedByScript(): string[] {
  const script = fs.readFileSync(COPY_SCRIPT, 'utf8')
  return [...script.matchAll(/^copy_binary\s+"([^"]+)"/gm)].map((m) => m[1]).sort()
}

/** 台帳B-2: 実際にバンドルされたファイル（ビルド済みのときのみ存在。gitignore 対象）。 */
function bundledBinaries(): string[] | undefined {
  const dir = path.join(
    REPO_ROOT,
    'packages/vscode-extension/engine/bin',
    `${process.platform}-${process.arch}`,
  )
  if (!fs.existsSync(dir)) return undefined
  return fs.readdirSync(dir).sort()
}

describe('#548 bundled out-of-process child binaries', () => {
  it('daemon が spawn しうる child はすべて copy-daemon-bin.sh のコピー対象である', () => {
    const required = requiredChildBinaries()
    const copied = copiedByScript()

    // 🔴 台帳Aの取りこぼしを検出する。空振り（0件）だけでなく **部分的な縮み** も
    // success にしない — 各 outproc モジュールは Clap / Vst3 の2分岐を必ず持つ。
    // format を増やしたらここが落ちるので、バンドル側の追従が強制される。
    for (const [file, names] of requiredChildBinariesByModule()) {
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
    // `cargo build --release -p A -p B ...` 群に現れる package 名を集める。
    const built = new Set([...script.matchAll(/-p\s+(orbit-[a-z0-9-]+)/g)].map((m) => m[1]))

    const notBuilt = copiedByScript().filter((name) => !built.has(name))
    expect(
      notBuilt,
      `copy_binary の対象なのに cargo build の -p に無い: ${notBuilt.join(', ')} — ` +
        `stale なバイナリが黙ってコピーされる（#487 の再発）`,
    ).toEqual([])
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
