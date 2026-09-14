import { describe, expect, it } from 'vitest'

import { readExtensionManifest } from '../helpers/vscode-extension-manifest'

interface CommandContribution {
  readonly command?: string
  readonly title?: string
  readonly category?: string
  readonly icon?: string
}

interface MenuContribution {
  readonly command?: string
  readonly when?: string
  readonly group?: string
}

describe('plugin UI editor context menu', () => {
  const manifest = readExtensionManifest() as {
    contributes?: {
      commands?: readonly CommandContribution[]
      menus?: { 'editor/context'?: readonly MenuContribution[] }
    }
  }
  const commandId = 'orbitscore.openPluginUiAtCursor'

  it('contributes the command with its fixed user-facing metadata', () => {
    expect(manifest.contributes?.commands?.filter((entry) => entry.command === commandId)).toEqual([
      {
        command: commandId,
        title: 'OrbitScore: Open Plugin UI',
        category: 'OrbitScore',
        icon: '$(window)',
      },
    ])
  })

  it('adds exactly one .orbs-only item to the existing orbitscore group', () => {
    const contextItems = manifest.contributes?.menus?.['editor/context'] ?? []
    expect(contextItems.filter((entry) => entry.command === commandId)).toEqual([
      {
        command: commandId,
        when: 'resourceExtname == .orbs',
        group: 'orbitscore',
      },
    ])
    expect(contextItems.every((entry) => entry.when?.includes('resourceExtname == .orbs'))).toBe(
      true,
    )
  })
})
