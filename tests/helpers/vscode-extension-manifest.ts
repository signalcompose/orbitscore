/**
 * VS Code 拡張マニフェスト（`packages/vscode-extension/package.json`）を読む共有ヘルパー。
 *
 * マニフェストは**振る舞いを宣言で決める**ファイルなので、テストから検査する箇所が増えていく
 * （`contributes.configuration` の既定値・`capabilities` の宣言・`activationEvents` …）。
 * 読み取りを各 spec に散らすと、**マニフェストの構造が変わった時に直す場所が増える**。
 *
 * 抽出の経緯（#385 / PR-S-T1）: `playhead.spec.ts` が `new URL(…, import.meta.url)` で、
 * 新規の `untrusted-workspace-capability.spec.ts` が `path.resolve(__dirname, …)` で、
 * **同じファイルを別々の書き方で読んでいた**。パスの相対階層が 2 箇所に散っていたので 1 本にした。
 *
 * 読み込みは**モジュールスコープで 1 回だけ**行う。マニフェストはテスト実行中に変化しないので、
 * spec ごとに読み直す理由が無い。
 */
import * as fs from 'node:fs'

/** リポジトリルートからの相対階層はここ 1 箇所だけが持つ。 */
const MANIFEST_URL = new URL('../../packages/vscode-extension/package.json', import.meta.url)

/**
 * 検査したいところだけを型で表す。マニフェスト全体を型付けしない —
 * 使わないフィールドまで宣言すると、`package.json` を触るたびに型を追随させることになる。
 */
export interface VscodeExtensionManifest {
  readonly capabilities?: {
    readonly untrustedWorkspaces?: {
      readonly supported?: unknown
      readonly description?: unknown
      readonly restrictedConfigurations?: unknown
    }
  }
  readonly contributes?: {
    readonly configuration?: {
      readonly properties?: Readonly<Record<string, unknown>>
    }
  }
  readonly [key: string]: unknown
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST_URL, 'utf8')) as VscodeExtensionManifest

/** 拡張マニフェストのパース済み内容（プロセス内で 1 回だけ読む）。 */
export function readExtensionManifest(): VscodeExtensionManifest {
  return manifest
}

/**
 * `contributes.configuration.properties` が宣言する設定キーの集合。
 * 「宣言していないキーを他所から参照していないか」の検査に使う（綴り間違いの検出）。
 */
export function declaredConfigurationKeys(): ReadonlySet<string> {
  return new Set(Object.keys(manifest.contributes?.configuration?.properties ?? {}))
}
