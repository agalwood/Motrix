import type { MenuRegistry } from '../menu-registry'
import { contributeDarwinMenubar } from './menubar.darwin'
import { contributeWin32Menubar } from './menubar.win32'
import { contributeSharedMenubar } from './shared'
import { contributeTrayMenu } from './tray'

export function installAllMenubarContributions(
  menuReg: MenuRegistry,
  platform: NodeJS.Platform
): void {
  if (platform === 'darwin') {
    contributeDarwinMenubar(menuReg)
  } else {
    contributeWin32Menubar(menuReg)
  }
  contributeSharedMenubar(menuReg)
  contributeTrayMenu(menuReg)
}
