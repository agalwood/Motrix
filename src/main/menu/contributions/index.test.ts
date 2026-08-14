import { describe, expect, it } from 'vitest'
import { MenuIds } from '../menu-ids'
import { MenuRegistry } from '../menu-registry'
import { installAllMenubarContributions } from './index'

describe('installAllMenubarContributions', () => {
  it('registers one cross-platform app menu and projects Darwin extras', () => {
    const reg = new MenuRegistry()
    installAllMenubarContributions(reg)
    const ids = new Set(reg.listMenuIds())
    expect(ids.has(MenuIds.MenubarApp)).toBe(true)
    expect(ids.has(MenuIds.MenubarFile)).toBe(false)
    expect(
      reg
        .getItems(MenuIds.MenubarWindow, 'darwin')
        .some((item) => item.platforms?.includes('darwin'))
    ).toBe(true)
  })

  it('filters Darwin-only items from the Windows projection', () => {
    const reg = new MenuRegistry()
    installAllMenubarContributions(reg)
    expect(
      reg
        .getItems(MenuIds.MenubarWindow, 'win32')
        .some((item) => item.platforms?.includes('darwin'))
    ).toBe(false)
    expect(reg.getItems(MenuIds.MenubarApp, 'win32')).not.toHaveLength(0)
  })

  it('task menu starts with New/NewBt/OpenFile', () => {
    const reg = new MenuRegistry()
    installAllMenubarContributions(reg)
    const items = reg.getItems(MenuIds.MenubarTask)
    expect(items[0].commandId).toBe('motrix.task.new')
    expect(items[1].commandId).toBe('motrix.task.newBt')
    expect(items[2].commandId).toBe('motrix.task.openFile')
  })
})
