import type { MenuItemConstructorOptions } from 'electron'
import type { WhenExpr } from '../commands/when'
import type { MenuId } from './menu-ids'

export interface MenuItem {
  menuId: MenuId
  commandId?: string
  submenu?: MenuId
  role?: MenuItemConstructorOptions['role']
  group: string
  order?: number
  when?: WhenExpr
  toggled?: WhenExpr
  titleOverride?: string
}
