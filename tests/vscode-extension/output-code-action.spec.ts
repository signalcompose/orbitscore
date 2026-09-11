import { beforeEach, describe, expect, it } from 'vitest'

import { registerOutputCodeActionProvider } from '../../packages/vscode-extension/src/extension'
import * as vscode from '../mocks/vscode'

describe('missing-output quick fix provider (#883)', () => {
  beforeEach(() => vscode.resetRegisteredCodeActionProviders())

  it('executes the registered CodeAction and inserts <name>.output() after the diagnostic line', () => {
    const subscriptions: Array<{ dispose(): void }> = []
    registerOutputCodeActionProvider({ subscriptions } as never)
    expect(vscode.registeredCodeActionProviders).toHaveLength(1)

    const source = ['var kick = init global.seq', 'kick.play(1)'].join('\n')
    const uri = vscode.Uri.file('/score.orbs')
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(1, 0, 1, 'kick.play('.length),
      "Sequence 'kick' has no output",
      vscode.DiagnosticSeverity.Warning,
    )
    diagnostic.code = 'output-missing'
    const document = {
      uri,
      getText: () => source,
      lineAt: (line: number) => ({ text: source.split('\n')[line] }),
    }

    const actions = vscode.registeredCodeActionProviders[0].provider.provideCodeActions(
      document,
      diagnostic.range,
      { diagnostics: [diagnostic] },
    ) as vscode.CodeAction[]

    expect(actions).toHaveLength(1)
    expect(actions[0].title).toBe('Add kick.output()')
    expect(actions[0].edit?.inserts).toEqual([
      {
        uri,
        position: new vscode.Position(1, 'kick.play(1)'.length),
        text: '\nkick.output()',
      },
    ])
  })
})
