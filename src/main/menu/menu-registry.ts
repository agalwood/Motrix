import type { MenuId } from './menu-ids'
import type { MenuItem } from './types'

export class MenuRegistry {
  private items = new Map<MenuId, MenuItem[]>()

  appendItem(item: MenuItem): void {
    const list = this.items.get(item.menuId) ?? []
    list.push(item)
    this.items.set(item.menuId, list)
  }

  getItems(menuId: MenuId): readonly MenuItem[] {
    const list = this.items.get(menuId) ?? []
    return [...list].sort((a, b) => {
      if (a.group !== b.group) return a.group < b.group ? -1 : 1
      return (a.order ?? 0) - (b.order ?? 0)
    })
  }

  listMenuIds(): readonly MenuId[] {
    return [...this.items.keys()]
  }
}
