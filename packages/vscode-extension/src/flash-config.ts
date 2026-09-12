/** VS Code command and agent wiring for flash configuration. */
import * as vscode from 'vscode'

import type { FlashConfigInput, FlashConfigResult } from './mcp-server'

async function configureFlash() {
  const config = vscode.workspace.getConfiguration('orbitscore')

  // Get current values
  const currentCount = config.get<number>('flashCount', 3)
  const currentDuration = config.get<number>('flashDuration', 150)
  const currentColor = config.get<string>('flashColor', 'selection')
  const currentCustomColor = config.get<string>('flashCustomColor', '#ff6b6b')

  // Show configuration options
  const options = [
    {
      label: `🔢 Flash Count: ${currentCount}`,
      description: 'Number of flashes (1-5)',
      detail: 'Current: ' + currentCount,
      action: 'count',
    },
    {
      label: `⏱️ Flash Duration: ${currentDuration}ms`,
      description: 'Duration of each flash (50-500ms)',
      detail: 'Current: ' + currentDuration + 'ms',
      action: 'duration',
    },
    {
      label: `🎨 Flash Color: ${currentColor}`,
      description: 'Color theme for flash',
      detail: 'Current: ' + currentColor,
      action: 'color',
    },
    {
      label: `🎯 Custom Color: ${currentCustomColor}`,
      description: 'Custom color (hex format)',
      detail: 'Current: ' + currentCustomColor,
      action: 'customColor',
    },
    {
      label: '🧪 Test Flash',
      description: 'Test current flash settings',
      detail: 'Preview the flash effect',
      action: 'test',
    },
  ]

  const selected = await vscode.window.showQuickPick(options, {
    placeHolder: 'Configure flash settings',
    title: '⚡ Flash Configuration',
  })

  if (!selected) return

  switch (selected.action) {
    case 'count': {
      const newCount = await vscode.window.showInputBox({
        prompt: 'Enter flash count (1-5)',
        value: currentCount.toString(),
        validateInput: (value) => {
          const num = parseInt(value)
          if (isNaN(num) || num < 1 || num > 5) {
            return 'Please enter a number between 1 and 5'
          }
          return null
        },
      })
      if (newCount) {
        await config.update('flashCount', parseInt(newCount), vscode.ConfigurationTarget.Global)
        vscode.window.showInformationMessage(`✅ Flash count set to ${newCount}`)
      }
      break
    }

    case 'duration': {
      const newDuration = await vscode.window.showInputBox({
        prompt: 'Enter flash duration in milliseconds (50-500)',
        value: currentDuration.toString(),
        validateInput: (value) => {
          const num = parseInt(value)
          if (isNaN(num) || num < 50 || num > 500) {
            return 'Please enter a number between 50 and 500'
          }
          return null
        },
      })
      if (newDuration) {
        await config.update(
          'flashDuration',
          parseInt(newDuration),
          vscode.ConfigurationTarget.Global,
        )
        vscode.window.showInformationMessage(`✅ Flash duration set to ${newDuration}ms`)
      }
      break
    }

    case 'color': {
      const colorOptions = [
        { label: 'selection', description: 'Editor selection color' },
        { label: 'error', description: 'Error color (red)' },
        { label: 'warning', description: 'Warning color (yellow)' },
        { label: 'info', description: 'Info color (blue)' },
        { label: 'custom', description: 'Custom color' },
      ]
      const selectedColor = await vscode.window.showQuickPick(colorOptions, {
        placeHolder: 'Select flash color theme',
      })
      if (selectedColor) {
        await config.update('flashColor', selectedColor.label, vscode.ConfigurationTarget.Global)
        vscode.window.showInformationMessage(`✅ Flash color set to ${selectedColor.label}`)
      }
      break
    }

    case 'customColor': {
      const newCustomColor = await vscode.window.showInputBox({
        prompt: 'Enter custom color (hex format, e.g., #ff6b6b)',
        value: currentCustomColor,
        validateInput: (value) => {
          if (!/^#[0-9A-Fa-f]{6}$/.test(value)) {
            return 'Please enter a valid hex color (e.g., #ff6b6b)'
          }
          return null
        },
      })
      if (newCustomColor) {
        await config.update('flashCustomColor', newCustomColor, vscode.ConfigurationTarget.Global)
        vscode.window.showInformationMessage(`✅ Custom color set to ${newCustomColor}`)
      }
      break
    }

    case 'test': {
      // Test flash by simulating a runSelection call
      const editor = vscode.window.activeTextEditor
      if (editor) {
        const line = editor.document.lineAt(editor.selection.active.line)
        const range = new vscode.Range(line.range.start, line.range.end)

        // Use the same flash logic as runSelection
        const flashCount = config.get<number>('flashCount', 3)
        const flashDuration = config.get<number>('flashDuration', 150)
        const flashColor = config.get<string>('flashColor', 'selection')
        const flashCustomColor = config.get<string>('flashCustomColor', '#ff6b6b')

        let backgroundColor: string | vscode.ThemeColor
        switch (flashColor) {
          case 'error':
            backgroundColor = new vscode.ThemeColor('editorError.foreground')
            break
          case 'warning':
            backgroundColor = new vscode.ThemeColor('editorWarning.foreground')
            break
          case 'info':
            backgroundColor = new vscode.ThemeColor('editorInfo.foreground')
            break
          case 'custom':
            backgroundColor = flashCustomColor
            break
          default:
            backgroundColor = new vscode.ThemeColor('editor.selectionBackground')
            break
        }

        const createFlash = (flashIndex: number) => {
          const decoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: backgroundColor,
            isWholeLine: true,
          })
          editor.setDecorations(decoration, [range])

          setTimeout(() => {
            decoration.dispose()
            if (flashIndex < flashCount - 1) {
              setTimeout(() => createFlash(flashIndex + 1), 100)
            }
          }, flashDuration)
        }

        createFlash(0)
        vscode.window.showInformationMessage('🧪 Flash test completed!')
      } else {
        vscode.window.showWarningMessage('⚠️ Please open a file to test flash')
      }
      break
    }
  }
}

/**
 * Apply flash settings for the MCP `configure_flash` tool. Value constraints
 * mirror `contributes.configuration` in package.json (orbitscore.flash*).
 * Workspace-scoped (`ConfigurationTarget.Workspace`) rather than Global (as
 * the "Configure Flash" command's QuickPick flow writes) — agent-driven
 * config changes should stay local to the workspace, not leak into the
 * user's global settings.
 */
async function configureFlashForAgent(options: FlashConfigInput): Promise<FlashConfigResult> {
  if (
    options.count !== undefined &&
    (!Number.isInteger(options.count) || options.count < 1 || options.count > 5)
  ) {
    return { ok: false, error: 'count must be an integer between 1 and 5' }
  }
  if (
    options.duration !== undefined &&
    (!Number.isInteger(options.duration) || options.duration < 50 || options.duration > 500)
  ) {
    return { ok: false, error: 'duration must be an integer between 50 and 500' }
  }
  const validColors = ['selection', 'error', 'warning', 'info', 'custom']
  if (options.color !== undefined && !validColors.includes(options.color)) {
    return { ok: false, error: `color must be one of: ${validColors.join(', ')}` }
  }
  if (options.customColor !== undefined && !/^#[0-9A-Fa-f]{6}$/.test(options.customColor)) {
    return { ok: false, error: 'custom_color must be a hex color, e.g. #ff6b6b' }
  }

  try {
    const config = vscode.workspace.getConfiguration('orbitscore')
    if (options.count !== undefined) {
      await config.update('flashCount', options.count, vscode.ConfigurationTarget.Workspace)
    }
    if (options.duration !== undefined) {
      await config.update('flashDuration', options.duration, vscode.ConfigurationTarget.Workspace)
    }
    if (options.color !== undefined) {
      await config.update('flashColor', options.color, vscode.ConfigurationTarget.Workspace)
    }
    if (options.customColor !== undefined) {
      await config.update(
        'flashCustomColor',
        options.customColor,
        vscode.ConfigurationTarget.Workspace,
      )
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  const updated = vscode.workspace.getConfiguration('orbitscore')
  return {
    ok: true,
    config: {
      count: updated.get<number>('flashCount', 3),
      duration: updated.get<number>('flashDuration', 150),
      color: updated.get<string>('flashColor', 'selection'),
      customColor: updated.get<string>('flashCustomColor', '#ff6b6b'),
    },
  }
}

export { configureFlash, configureFlashForAgent }
