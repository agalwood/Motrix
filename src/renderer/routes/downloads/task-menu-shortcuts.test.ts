import { describe, expect, it } from 'vitest'
import {
  matchesTaskMenuShortcut,
  taskMenuShortcuts,
} from './task-menu-shortcuts'

describe('task menu shortcuts', () => {
  it('uses macOS symbols and the actual desktop new-task binding', () => {
    const bindings = taskMenuShortcuts(true, true)
    expect(bindings.newTask).toMatchObject({ label: '⌘N', aria: 'Meta+N' })
    expect(bindings.inspector).toMatchObject({ label: '⌘I', aria: 'Meta+I' })
    expect(bindings.copyUrl).toMatchObject({ label: '⌘C', aria: 'Meta+C' })
    expect(bindings.remove).toMatchObject({
      label: '⌘⌫',
      aria: 'Meta+Backspace',
    })
  })
  it('uses Ctrl and Delete on Windows/Linux, and the web new-task override on Mac', () => {
    expect(taskMenuShortcuts(false, true).copyUrl.label).toBe('Ctrl+C')
    expect(taskMenuShortcuts(false, true).remove.label).toBe('Delete')
    expect(taskMenuShortcuts(true, false).newTask).toBeNull()
  })
  it('matches exact modifiers and never treats bare macOS Backspace as Remove', () => {
    const event = {
      key: 'c',
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    }
    expect(
      matchesTaskMenuShortcut(event, taskMenuShortcuts(true, true).copyUrl)
    ).toBe(true)
    expect(
      matchesTaskMenuShortcut(
        { ...event, ctrlKey: true },
        taskMenuShortcuts(true, true).copyUrl
      )
    ).toBe(false)
    expect(
      matchesTaskMenuShortcut(
        { ...event, shiftKey: true },
        taskMenuShortcuts(true, true).copyUrl
      )
    ).toBe(false)
    expect(
      matchesTaskMenuShortcut(
        { ...event, key: 'Backspace', metaKey: false },
        taskMenuShortcuts(true, true).remove
      )
    ).toBe(false)
  })
})
