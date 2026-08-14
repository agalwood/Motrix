import type { MenuId } from './menu-ids'
import type { MenuItem, MenuPlatform } from './types'

export class MenuRegistry {
  private items = new Map<MenuId, MenuItem[]>()
  private itemIds = new Set<string>()

  appendItem(item: MenuItem): void {
    if (this.itemIds.has(item.id)) {
      throw new Error(`Menu item already registered: ${item.id}`)
    }
    if ((item.type === 'submenu') !== Boolean(item.submenu)) {
      throw new Error(`Menu item ${item.id} has an invalid submenu type`)
    }
    if ((item.type === 'radio') !== Boolean(item.radioGroupId)) {
      throw new Error(`Menu item ${item.id} has an invalid radio group`)
    }
    if (
      (item.type === 'checkbox' || item.type === 'radio') &&
      !item.commandId
    ) {
      throw new Error(`Menu item ${item.id} must use a command when checkable`)
    }
    const actionCount = [item.commandId, item.role, item.submenu].filter(
      Boolean
    ).length
    if (actionCount !== 1) {
      throw new Error(`Menu item ${item.id} must declare exactly one action`)
    }
    this.itemIds.add(item.id)
    const list = this.items.get(item.menuId) ?? []
    list.push(item)
    this.items.set(item.menuId, list)
  }

  getItems(menuId: MenuId, platform?: MenuPlatform): readonly MenuItem[] {
    const list = this.items.get(menuId) ?? []
    const sortedItems = [...list]
      .filter(
        (item) =>
          !platform || !item.platforms || item.platforms.includes(platform)
      )
      .sort((a, b) => {
        if (a.group !== b.group) return a.group < b.group ? -1 : 1
        return (a.order ?? 0) - (b.order ?? 0)
      })

    for (let index = 1; index < sortedItems.length; index += 1) {
      const previous = sortedItems[index - 1]
      const current = sortedItems[index]
      if (
        previous?.type === 'radio' &&
        current?.type === 'radio' &&
        previous.group === current.group &&
        previous.radioGroupId !== current.radioGroupId
      ) {
        throw new Error(
          `Adjacent radio items ${previous.id} and ${current.id} must share a group`
        )
      }
    }

    return sortedItems
  }

  listMenuIds(): readonly MenuId[] {
    return [...this.items.keys()]
  }
}
