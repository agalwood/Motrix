import { CommandIds } from '@shared/commands-catalog'
import { describe, expect, it } from 'vitest'
import { KeybindingRegistry } from './keybinding-registry'

describe('KeybindingRegistry', () => {
  it('returns the Electron accelerator for a known command', () => {
    const r = new KeybindingRegistry()
    expect(r.forCommand(CommandIds.TaskNew)).toBe('CommandOrControl+N')
    expect(r.forCommand(CommandIds.TaskPauseAll)).toBe(
      'CommandOrControl+Shift+P'
    )
  })

  it('returns undefined for commands without bindings', () => {
    const r = new KeybindingRegistry()
    expect(r.forCommand(CommandIds.HelpOpenWebsite)).toBeUndefined()
  })
})
