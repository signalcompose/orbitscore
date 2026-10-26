/**
 * gated suite（`orbitstudio-mcp-gated.spec.ts`）の `it` を TypeScript の構文木で読む（設計 848 §1.2 D-1）。
 *
 * パリティ台帳（`native-parity-ledger.ts`）の分類のうち、**機械で決まるもの**をここで出す:
 * - 題名（`it` / `it.skipIf(…)` の第 1 引数の文字列）
 * - そのテストが呼ぶ MCP ツール（本文の `.call('<tool>'` に加え、同じファイルの関数と
 *   `tests/e2e/helpers/` の関数を辿った推移閉包）→ エディタのツールを呼ぶか（`needs-editor`）
 * - 自前でアプリを起こすか（`launchIsolatedOrbitStudio` を呼ぶか）→ 共有セッションに依るか
 *
 * 台帳はこの結果を手で写し、spec が食い違いを red にする（分類を黙ってずらさない）。
 */
import * as fs from 'fs'
import * as path from 'path'

import ts from 'typescript'

/** エディタが無いと答えられないツール（設計 §6: headless では `NO_EDITOR_ATTACHED`）。 */
export const EDITOR_TOOLS: ReadonlySet<string> = new Set([
  'open_file',
  'set_selection',
  'run_selection',
  'edit_replace',
  'get_editor_state',
  'save_file',
  'get_document_text',
  'get_diagnostics',
  'configure_flash',
  'open_plugin_ui_at_cursor',
])

export interface GatedTestFacts {
  line: number
  title: string
  tools: string[]
  editorTools: string[]
  /** 本文で `launchIsolatedOrbitStudio` を呼ぶ（共有セッションに依らない）。 */
  ownApp: boolean
}

interface FunctionFacts {
  tools: Set<string>
  calls: Set<string>
}

function collect(node: ts.Node, facts: FunctionFacts): void {
  const visit = (current: ts.Node): void => {
    if (ts.isCallExpression(current)) {
      const callee = current.expression
      const first = current.arguments[0]
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'call' &&
        first !== undefined &&
        ts.isStringLiteral(first)
      ) {
        facts.tools.add(first.text)
      }
    }
    // 呼び出しだけでなく、コールバックとして渡された関数名も辿る。
    if (ts.isIdentifier(current)) facts.calls.add(current.text)
    ts.forEachChild(current, visit)
  }
  visit(node)
}

function scanFunctions(source: ts.SourceFile, into: Map<string, FunctionFacts>): void {
  const add = (name: string, body: ts.Node): void => {
    const facts = into.get(name) ?? { tools: new Set<string>(), calls: new Set<string>() }
    collect(body, facts)
    into.set(name, facts)
  }
  const walk = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) add(node.name.text, node.body)
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      add(node.name.text, node.initializer.body)
    }
    ts.forEachChild(node, walk)
  }
  walk(source)
}

function toolClosure(
  facts: FunctionFacts,
  functions: Map<string, FunctionFacts>,
  seen = new Set<string>(),
): Set<string> {
  const tools = new Set(facts.tools)
  for (const name of facts.calls) {
    const callee = functions.get(name)
    if (!callee || seen.has(name)) continue
    seen.add(name)
    for (const tool of toolClosure(callee, functions, seen)) tools.add(tool)
  }
  return tools
}

function parse(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)
}

/**
 * gated suite の本文（`suiteText`）と helpers のディレクトリから、`it` ごとの事実を出す。
 * 基準タグの suite を読む時は `git show <tag>:<path>` の本文を渡す。
 */
export function analyzeGatedSuite(suiteText: string, helpersDir: string): GatedTestFacts[] {
  const functions = new Map<string, FunctionFacts>()
  for (const entry of fs.readdirSync(helpersDir)) {
    if (!entry.endsWith('.ts') || entry.endsWith('.spec.ts')) continue
    const file = path.join(helpersDir, entry)
    scanFunctions(parse(file, fs.readFileSync(file, 'utf8')), functions)
  }
  const suite = parse('orbitstudio-mcp-gated.spec.ts', suiteText)
  scanFunctions(suite, functions)

  const tests: GatedTestFacts[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      let root: ts.Expression = node.expression
      while (ts.isCallExpression(root) || ts.isPropertyAccessExpression(root))
        root = root.expression
      const [title, body] = node.arguments
      if (
        ts.isIdentifier(root) &&
        (root.text === 'it' || root.text === 'test') &&
        title !== undefined &&
        body !== undefined &&
        (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))
      ) {
        const facts: FunctionFacts = { tools: new Set(), calls: new Set() }
        collect(body, facts)
        const tools = [...toolClosure(facts, functions)].sort()
        tests.push({
          line: suite.getLineAndCharacterOfPosition(node.getStart(suite)).line + 1,
          title: title.text,
          tools,
          editorTools: tools.filter((tool) => EDITOR_TOOLS.has(tool)),
          ownApp: facts.calls.has('launchIsolatedOrbitStudio'),
        })
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(suite)
  return tests
}
