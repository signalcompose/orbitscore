/**
 * DSL の言語機能のプロバイダ登録（#887 束 E・`extension.ts` から移した）。
 *
 * 🔴 **本文は 1 行も書き換えていない。** 補完・quick fix・hover の登録は
 * `activate()` から呼ばれる配線で、vscode に触るのでここに置く
 * （`dsl-completion-context.ts` / `dsl-method-catalog.ts` は vscode 非依存の純モジュールで、
 * そちらへ配線を持ち込むのは「戻す」ではなく「壊す」— 設計 `887-extension-split-design.md` §4.1）。
 */

/**
 * OrbitScore VS Code extension root and public re-export surface.
 *
 * Engine wiring function bodies were moved unchanged to the engine modules;
 * formerly private helpers are imported only where this root still wires them.
 */
import * as path from 'path'
// import * as os from 'os'

import * as vscode from 'vscode'

import { analyzeMethodChain, getContextualCompletions } from './completion-context'
import { analyzeMissingOutput, missingOutputQuickFixEdit } from './diagnostics-analysis'
import {
  detectDslCompletionContext,
  extractDeclaredBusNames,
  extractDeclaredMixerNodeNames,
  extractTopLevelDeclaredNames,
  filterDslCandidates,
  extractDeclaredGlobalNames,
  extractDeclaredSequenceNames,
} from './dsl-completion-context'
import { BUS_METHODS, GLOBAL_METHODS, SEQUENCE_METHODS } from './dsl-method-catalog'
import {
  detectRackArgContext,
  filterCatalogEntries,
  RACK_SCAN_MAX_LINES,
} from './plugin-catalog-completion'
import { loadPluginCatalog } from './plugin-catalog-reader'
import { outputChannel, pluginCatalogHintShown, setPluginCatalogHintShown } from './extension-state'

/**
 * 補完プロバイダの登録（#495）。
 *
 * export しているのは**登録内容（トリガー文字を含む）をテストで固定する**ため。
 * トリガーに `.` が無いと、provider 本体が正しくてもユーザーが打った時に出てこない
 * — provider を直接呼ぶテストでは気づけない穴だった（変異検証で発見）。
 */
export function registerCompletionProviders(context: vscode.ExtensionContext) {
  // Context-aware completion provider
  const completionProvider = vscode.languages.registerCompletionItemProvider(
    'orbitscore',
    {
      provideCompletionItems(document, position) {
        const lineText = document.lineAt(position).text
        const linePrefix = lineText.substr(0, position.character)

        // Check if we're typing after a dot
        if (!linePrefix.endsWith('.')) {
          return undefined
        }

        // Detect pitch-scope chain context: cursor is after `).` and we are INSIDE
        // the argument list of a .play() call (paren balance > 0 after the last .play(
        // token). This distinguishes the inner-group position `play((A)(B).` (balance 1)
        // from the post-play position `play(1,2,3).` (balance 0). The check also avoids
        // firing when .play( is on an earlier line (linePrefix won't contain it at all).
        if (/\)\.$/.test(linePrefix)) {
          const playIdx = linePrefix.lastIndexOf('.play(')
          if (playIdx !== -1) {
            const afterPlay = linePrefix.slice(playIdx + 1) // starts with "play("
            let balance = 0
            for (const ch of afterPlay) {
              if (ch === '(') balance++
              else if (ch === ')') balance--
            }
            // balance > 0: the play( is still open → cursor is inside play args
            if (balance > 0) {
              return getPitchScopeCompletions()
            }
            // balance === 0: play() has closed → fall through to existing completions
          }
        }

        // Analyze the method chain context
        const chainContext = analyzeMethodChain(lineText, position.character)

        // Determine if this is a global or sequence context
        const isGlobal = linePrefix.includes('global.')

        // Get contextual completions
        return getContextualCompletions(chainContext, isGlobal)
      },
    },
    '.', // Trigger on dot
  )

  context.subscriptions.push(completionProvider)

  // Plugin catalog name completion (#463 C3, spec §PC.3). Triggers on `"` but
  // — per owner requirement 2026-07-17 — must also keep narrowing while the
  // user types further characters inside the string; VS Code does this
  // client-side via each item's `range`, so no re-trigger characters are
  // needed for the common case (registered `"` covers the initial open-quote
  // fire; detectRackArgContext itself matches a partial, unclosed string,
  // so a real re-invocation — e.g. Ctrl+Space — still resolves correctly too).
  const pluginCompletionProvider = vscode.languages.registerCompletionItemProvider(
    'orbitscore',
    {
      provideCompletionItems(document, position) {
        // #628: ラックは配列・複数行・`layer` の入れ子になるため、単一行 regex では
        // 発火しない（SC.10.10 規範 1 の退行点）。有界の後方スキャナを主経路にし、
        // 単一行の判定はその特殊ケースとして吸収される。
        // 🔴 スキャナは後方 RACK_SCAN_MAX_LINES 行までしか読まない。**文書全体を
        // materialize すると、その有界性を呼び出し側が台無しにする** — 数千行のファイルで
        // `"` を打つたびに全行をコピーすることになる。読む範囲だけを切り出して渡す。
        const firstRow = Math.max(0, position.line - RACK_SCAN_MAX_LINES)
        const lines: string[] = []
        for (let row = firstRow; row <= position.line; row += 1) {
          lines.push(document.lineAt(row).text)
        }
        const pluginContext = detectRackArgContext(
          lines,
          position.line - firstRow,
          position.character,
        )
        if (!pluginContext) return undefined

        const catalog = loadPluginCatalog()
        if (!catalog) {
          if (!pluginCatalogHintShown) {
            setPluginCatalogHintShown(true)
            vscode.window.showInformationMessage(
              'OrbitScore: no plugin catalog found. Run "OrbitScore: Rescan Plugin Catalog" to enable name completion.',
            )
          }
          return undefined
        }

        const matches = filterCatalogEntries(
          catalog.plugins,
          pluginContext.verb,
          pluginContext.typed,
        )
        const range = new vscode.Range(
          new vscode.Position(position.line, pluginContext.quoteStartChar),
          new vscode.Position(position.line, position.character),
        )
        return matches.map(({ entry, label, insertText }) => {
          const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Value)
          item.detail = `${entry.vendor} · ${entry.format.toUpperCase()}`
          item.insertText = insertText
          item.range = range
          item.filterText = label
          return item
        })
      },
    },
    '"',
  )
  context.subscriptions.push(pluginCompletionProvider)

  // DSL completion surfaces introduced by #512.  Context recognition lives in
  // dsl-completion-context.ts so this provider is only responsible for VS Code
  // I/O and CompletionItem construction.
  // 🔴 #495: provider 本体は vscode API を直接叩く層で、文脈検出のユニットテストでは
  // 通らない。#614 で「配線はユニットテストの視野の外」を踏んだので、**named export に
  // 切り出してテストから直接駆動できるようにする**。
  const dslCompletionProvider = vscode.languages.registerCompletionItemProvider(
    'orbitscore',
    dslCompletionItemProvider,
    '"',
    '{',
    // #495 第1段: `<receiver>.` の後のメソッド補完を出すためのトリガー。
    // これが無いと、明示的に補完を呼び出さない限り出てこない。
    '.',
    // #883: destination completion starts as soon as `.output(` is typed.
    '(',
  )
  context.subscriptions.push(dslCompletionProvider)
}

/** Register the quick fix shared by output-missing and dry-not-routed diagnostics. */
export function registerOutputCodeActionProvider(context: vscode.ExtensionContext) {
  const provider = vscode.languages.registerCodeActionsProvider(
    'orbitscore',
    {
      provideCodeActions(document, _range, actionContext) {
        const source = document.getText()
        const issues = analyzeMissingOutput(source)
        const actions: vscode.CodeAction[] = []
        for (const diagnostic of actionContext.diagnostics) {
          if (diagnostic.code !== 'output-missing' && diagnostic.code !== 'dry-not-routed') continue
          const issue = issues.find(
            (candidate) =>
              candidate.code === diagnostic.code && candidate.line === diagnostic.range.start.line,
          )
          if (!issue) continue
          const insertion = missingOutputQuickFixEdit(source, issue)
          const action = new vscode.CodeAction(
            `Add ${issue.sequenceName}.output()`,
            vscode.CodeActionKind.QuickFix,
          )
          action.diagnostics = [diagnostic]
          action.isPreferred = diagnostic.code === 'output-missing'
          action.edit = new vscode.WorkspaceEdit()
          action.edit.insert(
            document.uri,
            new vscode.Position(insertion.line, document.lineAt(insertion.line).text.length),
            insertion.insertText,
          )
          actions.push(action)
        }
        return actions
      },
    },
    { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
  )
  context.subscriptions.push(provider)
  return provider
}

/**
 * DSL 補完の provider 本体（#495）。
 *
 * `activate()` の中に埋めるとテストから駆動できないので named export にしてある
 * （#614 の教訓: 配線はユニットテストの視野の外）。
 */
export const dslCompletionItemProvider: vscode.CompletionItemProvider = {
  async provideCompletionItems(document, position) {
    const lineText = document.lineAt(position).text
    const completionContext = detectDslCompletionContext(lineText, position.character)
    if (!completionContext) return undefined

    const typedRange = new vscode.Range(
      new vscode.Position(position.line, position.character - completionContext.typed.length),
      position,
    )
    const makeItems = (candidates: readonly string[], kind: vscode.CompletionItemKind) =>
      filterDslCandidates(candidates, completionContext.typed).map((candidate) => {
        const item = new vscode.CompletionItem(candidate, kind)
        item.insertText = candidate
        item.range = typedRange
        return item
      })

    switch (completionContext.kind) {
      case 'method': {
        // #495 第1段: `<receiver>.` の後にメソッドを出す。
        // 候補源は engine の DSL 語彙の写し（`dsl-method-catalog.ts`。乖離はテストが検知）。
        //
        // 🔴 **この面には既に持ち主がいる。** `completionProvider`（本ファイル上部・本 PR より前
        // から存在）が同じ `.` トリガーで、メソッドチェーンの文脈に応じて絞り込んだスニペット
        // 候補（`tempo(${1:120})` 等）を返す。ここで語彙を丸ごと返すと**同じ label が2つ並ぶ**
        // （実測で確認）。
        //
        // したがってこの provider は **既存が返さなかった語彙だけを補う**。既存は手書きの
        // 候補表で語彙テーブルと同期していないため、`ui`（#617）のような新しいメソッドが
        // 出てこない — その穴を埋めるのがここの役割。既存の「文脈で絞る」挙動は壊さない。
        //
        // 行だけでは変数のレシーバ種別が決まらないので、ここで**文書全体の宣言**を見る。
        // `var g = init GLOBAL` で宣言された名前なら Global、`init global.seq` なら Sequence。
        const text = document.getText()
        let methods: readonly string[]
        if (completionContext.receiver === 'bus') {
          methods = BUS_METHODS
        } else if (completionContext.receiver === 'global') {
          methods = GLOBAL_METHODS
        } else {
          // 変数名。宣言を見て決める。判定できない識別子には出さない
          // （無関係な `foo.` にまで DSL メソッドを並べない）。
          const head = completionContext.identifier
          if (!head) return undefined
          if (extractDeclaredGlobalNames(text).includes(head)) methods = GLOBAL_METHODS
          else if (extractDeclaredSequenceNames(text).includes(head)) methods = SEQUENCE_METHODS
          else return undefined
        }
        // 既存 provider が同じ位置で返す候補を除き、二重表示を防ぐ。
        //
        // 🔴 `isGlobal` は**既存 provider と同じ規則で計算する**（#619 Fable 監査 F5）。
        // こちらの宣言ベース判定を使うと、`myglobal.` のように **'global' で終わる変数名**で
        // 食い違う（実測: 旧は部分一致で Global 候補17件を返すのに、こちらは sequence 側を
        // 除外集合にするため全部二重表示になった）。
        //
        // 引き算は**相手の実際の出力**を引かなければ意味がない。判定を自前で持たず、
        // 旧の式（`linePrefix.includes('global.')`）をそのまま使う。
        const linePrefix = lineText.slice(0, position.character)
        const alreadyOffered = new Set(
          getContextualCompletions(
            analyzeMethodChain(lineText, position.character),
            linePrefix.includes('global.'),
          ).map((item) => String(item.label)),
        )
        return makeItems(
          methods.filter((method) => !alreadyOffered.has(method)),
          vscode.CompletionItemKind.Method,
        )
      }
      case 'output-string':
        return makeItems(
          [
            'master',
            ...extractDeclaredBusNames(document.getText(), 'sum'),
            ...extractDeclaredBusNames(document.getText(), 'aux'),
          ],
          vscode.CompletionItemKind.Value,
        )
      case 'output-node':
        return makeItems(
          ['master', ...extractDeclaredMixerNodeNames(document.getText())],
          vscode.CompletionItemKind.Variable,
        )
      case 'aux-name':
        return makeItems(
          extractDeclaredBusNames(document.getText(), 'aux'),
          vscode.CompletionItemKind.Value,
        )
      case 'import-names': {
        const importUri = vscode.Uri.file(
          path.resolve(path.dirname(document.uri.fsPath), completionContext.importPath),
        )
        let importedSource: string
        try {
          importedSource = Buffer.from(await vscode.workspace.fs.readFile(importUri)).toString(
            'utf8',
          )
        } catch (error) {
          // The import may still be mid-edit or absent; completion must not
          // turn that ordinary editing state into a provider error. Logged
          // so real failures (e.g. permissions) remain diagnosable.
          outputChannel?.appendLine(
            `⚠️ DSL import-name completion: could not read ${importUri.fsPath}: ${error}`,
          )
          return undefined
        }
        return makeItems(
          extractTopLevelDeclaredNames(importedSource),
          vscode.CompletionItemKind.Variable,
        )
      }
      case 'import-path': {
        const files = await vscode.workspace.findFiles('**/*.orbs')
        const currentDirectory = path.dirname(document.uri.fsPath)
        const candidates = files
          .filter((uri) => uri.fsPath !== document.uri.fsPath)
          .map((uri) => {
            const relativePath = path
              .relative(currentDirectory, uri.fsPath)
              .split(path.sep)
              .join('/')
            return relativePath.startsWith('.') ? relativePath : `./${relativePath}`
          })
        return makeItems(candidates, vscode.CompletionItemKind.File)
      }
    }
  },
}

/**
 * Completion items for pitch-scope group chains: .root() / .mode() / .oct() (§2.3, §3).
 * Offered when the cursor follows a `)` inside a play() argument list.
 */
function getPitchScopeCompletions(): vscode.CompletionItem[] {
  const root = new vscode.CompletionItem('root', vscode.CompletionItemKind.Method)
  root.documentation = new vscode.MarkdownString(
    '**root(note | degree)** — Set pitch-class root for the preceding group or juxtaposition run (§2.3, §3).\n\n' +
      'Note names: `C`, `Db`, `D`, `Eb`, `E`, `F`, `F#`, `Gb`, `G`, `Ab`, `A`, `Bb`, `B`\n\n' +
      'Degrees (of `global.key()`): `1`–`9`, `11`, `13`, `b3`, `#5`, etc.\n\n' +
      'Examples: `(1, 2, 3).root(F#)` · `(A)(B).root(Bb)` · `(A).root(b6)`',
  )
  root.insertText = new vscode.SnippetString('root(${1:F})')
  root.sortText = '1'

  const mode = new vscode.CompletionItem('mode', vscode.CompletionItemKind.Method)
  mode.documentation = new vscode.MarkdownString(
    '**mode(name)** — Set modal context for the group (§2.3). _v1.1: syntax reserved; dispatch throws. Arrives in Phase 2.2._',
  )
  mode.insertText = new vscode.SnippetString('mode(${1:dorian})')
  mode.sortText = '2'

  const oct = new vscode.CompletionItem('oct', vscode.CompletionItemKind.Method)
  oct.documentation = new vscode.MarkdownString(
    '**oct(N)** — Set group-lexical octave register (§2.3, §3). Integer.\n\nExample: `(1, 2, 3).oct(4)` · `(A)(B).root(C).oct(5)`',
  )
  oct.insertText = new vscode.SnippetString('oct(${1:4})')
  oct.sortText = '3'

  return [root, mode, oct]
}

export function registerHoverProvider(context: vscode.ExtensionContext) {
  const provider = vscode.languages.registerHoverProvider('orbitscore', {
    provideHover(document, position) {
      const range = document.getWordRangeAtPosition(position)
      const word = document.getText(range)

      const hoverTexts: { [key: string]: string } = {
        global: '**global**\n\nGlobal transport object for controlling playback',
        tempo: '**tempo(bpm)**\n\nSet tempo in beats per minute (20-999)',
        beat: '**beat(n by m)**\n\nSet time signature (e.g., 4 by 4, 5 by 4)',
        quantize:
          '**quantize(value)**\n\nLaunch quantize for `LOOP()` and LOOP-time `play()` updates.\n\nValues: `"off"` | `"beat"` | `"bar"` | `"2bar"` | `"4bar"` | `"8bar"`. Default: `"bar"`. `RUN()` is always immediate.',
        play: '**play(...slices)**\n\nPlay audio slices. Supports numbers, nested structures, and modifiers',
        root: '**root(note | degree)**\n\nSet the pitch-class root for a group or juxtaposition run (§2.3, §3).\n\nExamples: `(1, 2, 3).root(F#)` · `(A)(B).root(Bb)` · `(1, 2).root(3)` · `(A).root(b6)`\n\nNote names: `C`, `Db`, `D`, `Eb`, `E`, `F`, `F#`, `Gb`, `G`, `Ab`, `A`, `Bb`, `B`\nDegrees (of `global.key()`): `1`–`9`, `11`, `13`, `b3`, `#5`, etc.',
        mode: '**mode(name)**\n\nSet the modal context for a group (§2.3). _v1.1: syntax reserved; dispatch throws. Arrives in Phase 2.2._',
        oct: '**oct(N)**\n\nSet the group-lexical octave register for a group or run (§2.3, §3). Integer.\n\nExample: `(1, 2, 3).oct(4)` · `(A)(B).root(C).oct(5)`',
        chop: '**chop(n)**\n\nDivide audio into n equal slices',
        fixpitch:
          '**fixpitch(semitones)** _(planned, not yet implemented — see issue #213)_\n\nPitch shift in semitones, preserving slice duration.',
        var: '**var**\n\nDeclare a variable',
        init: '**init**\n\nInitialize a transport or sequence',
        GLOBAL: '**GLOBAL**\n\nGlobal transport constant',
      }

      const text = hoverTexts[word]
      if (text) {
        return new vscode.Hover(new vscode.MarkdownString(text))
      }

      return undefined
    },
  })

  context.subscriptions.push(provider)
}
