import { describe, expect, it } from 'vitest'
import { MenuIds } from './menu-ids'
import { MenuRegistry } from './menu-registry'

describe('MenuRegistry', () => {
  it('returns items sorted by group then order', () => {
    const r = new MenuRegistry()
    r.appendItem({
      id: 'b',
      type: 'normal',
      menuId: MenuIds.MenubarTask,
      group: '2_primary',
      order: 20,
      commandId: 'b',
    })
    r.appendItem({
      id: 'a1',
      type: 'normal',
      menuId: MenuIds.MenubarTask,
      group: '1_new',
      order: 10,
      commandId: 'a1',
    })
    r.appendItem({
      id: 'a2',
      type: 'normal',
      menuId: MenuIds.MenubarTask,
      group: '1_new',
      order: 20,
      commandId: 'a2',
    })
    r.appendItem({
      id: 'b0',
      type: 'normal',
      menuId: MenuIds.MenubarTask,
      group: '2_primary',
      order: 10,
      commandId: 'b0',
    })
    const ids = r.getItems(MenuIds.MenubarTask).map((i) => i.commandId)
    expect(ids).toEqual(['a1', 'a2', 'b0', 'b'])
  })

  it('returns empty array for unknown menuId', () => {
    const r = new MenuRegistry()
    expect(r.getItems(MenuIds.Tray)).toEqual([])
  })

  it('listMenuIds returns every registered id', () => {
    const r = new MenuRegistry()
    r.appendItem({
      id: 'menubar.x',
      type: 'normal',
      menuId: MenuIds.MenubarTask,
      group: '1',
      commandId: 'x',
    })
    r.appendItem({
      id: 'tray.y',
      type: 'normal',
      menuId: MenuIds.Tray,
      group: '1',
      commandId: 'y',
    })
    expect(new Set(r.listMenuIds())).toEqual(
      new Set([MenuIds.MenubarTask, MenuIds.Tray])
    )
  })

  it('rejects duplicate stable ids across menu surfaces', () => {
    const r = new MenuRegistry()
    r.appendItem({
      id: 'duplicate',
      type: 'normal',
      menuId: MenuIds.MenubarTask,
      group: '1',
      commandId: 'x',
    })
    expect(() =>
      r.appendItem({
        id: 'duplicate',
        type: 'normal',
        menuId: MenuIds.Tray,
        group: '1',
        commandId: 'y',
      })
    ).toThrow('already registered')
  })

  it('rejects ambiguous or actionless menu definitions', () => {
    const r = new MenuRegistry()
    expect(() =>
      r.appendItem({
        id: 'ambiguous',
        type: 'normal',
        menuId: MenuIds.Tray,
        group: '1',
        commandId: 'x',
        role: 'quit',
      })
    ).toThrow('exactly one action')
    expect(() =>
      r.appendItem({
        id: 'actionless',
        type: 'normal',
        menuId: MenuIds.Tray,
        group: '1',
      })
    ).toThrow('exactly one action')
  })

  it('requires an explicit group only for radio items', () => {
    const r = new MenuRegistry()
    expect(() =>
      r.appendItem({
        id: 'radio.missing-group',
        type: 'radio',
        menuId: MenuIds.MenubarTask,
        group: '1',
        commandId: 'radio',
      })
    ).toThrow('invalid radio group')
    expect(() =>
      r.appendItem({
        id: 'normal.with-group',
        type: 'normal',
        menuId: MenuIds.MenubarTask,
        group: '1',
        commandId: 'normal',
        radioGroupId: 'mode',
      })
    ).toThrow('invalid radio group')
    expect(() =>
      r.appendItem({
        id: 'checkbox.role',
        type: 'checkbox',
        menuId: MenuIds.MenubarTask,
        group: '1',
        role: 'toggleSpellChecker',
      })
    ).toThrow('must use a command')
  })

  it('requires adjacent radio items to share Electron native grouping', () => {
    const r = new MenuRegistry()
    r.appendItem({
      id: 'radio.compact',
      type: 'radio',
      menuId: MenuIds.MenubarTask,
      group: '1',
      order: 1,
      commandId: 'compact',
      radioGroupId: 'density',
    })
    r.appendItem({
      id: 'radio.light',
      type: 'radio',
      menuId: MenuIds.MenubarTask,
      group: '1',
      order: 2,
      commandId: 'light',
      radioGroupId: 'theme',
    })

    expect(() => r.getItems(MenuIds.MenubarTask, 'win32')).toThrow(
      'must share a group'
    )

    const separated = new MenuRegistry()
    separated.appendItem({
      id: 'radio.compact',
      type: 'radio',
      menuId: MenuIds.MenubarTask,
      group: '1_density',
      commandId: 'compact',
      radioGroupId: 'density',
    })
    separated.appendItem({
      id: 'radio.light',
      type: 'radio',
      menuId: MenuIds.MenubarTask,
      group: '2_theme',
      commandId: 'light',
      radioGroupId: 'theme',
    })
    expect(() => separated.getItems(MenuIds.MenubarTask, 'win32')).not.toThrow()
  })
})
