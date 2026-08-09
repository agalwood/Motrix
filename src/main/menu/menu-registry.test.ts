import { describe, expect, it } from 'vitest'
import { MenuIds } from './menu-ids'
import { MenuRegistry } from './menu-registry'

describe('MenuRegistry', () => {
  it('returns items sorted by group then order', () => {
    const r = new MenuRegistry()
    r.appendItem({
      menuId: MenuIds.MenubarTask,
      group: '2_primary',
      order: 20,
      commandId: 'b',
    })
    r.appendItem({
      menuId: MenuIds.MenubarTask,
      group: '1_new',
      order: 10,
      commandId: 'a1',
    })
    r.appendItem({
      menuId: MenuIds.MenubarTask,
      group: '1_new',
      order: 20,
      commandId: 'a2',
    })
    r.appendItem({
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
    r.appendItem({ menuId: MenuIds.MenubarTask, group: '1', commandId: 'x' })
    r.appendItem({ menuId: MenuIds.Tray, group: '1', commandId: 'y' })
    expect(new Set(r.listMenuIds())).toEqual(
      new Set([MenuIds.MenubarTask, MenuIds.Tray])
    )
  })
})
