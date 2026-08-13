import type { MenuItemConstructorOptions } from 'electron'
import type { WhenExpr } from '../commands/when'
import type { MenuId } from './menu-ids'

export type MenuPlatform = 'darwin' | 'win32' | 'linux'
export type MenuItemType = 'normal' | 'submenu' | 'checkbox' | 'radio'

export interface MenuItem {
  id: string
  type: MenuItemType
  menuId: MenuId
  commandId?: string
  submenu?: MenuId
  role?: MenuItemConstructorOptions['role']
  group: string
  order?: number
  when?: WhenExpr
  toggled?: WhenExpr
  titleOverride?: string
  visible?: boolean
  platforms?: readonly MenuPlatform[]
  includeInApplicationMenu?: boolean
  radioGroupId?: string
  contextBinding?: 'selectedTask'
}
