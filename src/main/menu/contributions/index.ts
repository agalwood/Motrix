import type { MenuRegistry } from '../menu-registry'
import { contributeApplicationMenubar } from './menubar.app'
import { contributeDarwinMenubar } from './menubar.darwin'
import { contributeWin32Menubar } from './menubar.win32'
import { contributeSharedMenubar } from './shared'
import { contributeTrayMenu } from './tray'

export function installAllMenubarContributions(menuReg: MenuRegistry): void {
  contributeApplicationMenubar(menuReg)
  contributeDarwinMenubar(menuReg)
  contributeWin32Menubar(menuReg)
  contributeSharedMenubar(menuReg)
  contributeTrayMenu(menuReg)
}
