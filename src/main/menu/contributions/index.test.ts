import { describe, expect, it } from 'vitest'
import { MenuIds } from '../menu-ids'
import { MenuRegistry } from '../menu-registry'
import { installAllMenubarContributions } from './index'

describe('installAllMenubarContributions', () => {
  it('darwin populates MenubarApp but not MenubarFile', () => {
    const reg = new MenuRegistry()
    installAllMenubarContributions(reg, 'darwin')
    const ids = new Set(reg.listMenuIds())
    expect(ids.has(MenuIds.MenubarApp)).toBe(true)
    expect(ids.has(MenuIds.MenubarFile)).toBe(false)
  })

  it('win32 populates MenubarFile but not MenubarApp', () => {
    const reg = new MenuRegistry()
    installAllMenubarContributions(reg, 'win32')
    const ids = new Set(reg.listMenuIds())
    expect(ids.has(MenuIds.MenubarFile)).toBe(true)
    expect(ids.has(MenuIds.MenubarApp)).toBe(false)
  })

  it('task menu starts with New/NewBt/OpenFile', () => {
    const reg = new MenuRegistry()
    installAllMenubarContributions(reg, 'darwin')
    const items = reg.getItems(MenuIds.MenubarTask)
    expect(items[0].commandId).toBe('motrix.task.new')
    expect(items[1].commandId).toBe('motrix.task.newBt')
    expect(items[2].commandId).toBe('motrix.task.openFile')
  })
})
