import { app } from 'electron'

export function syncAutoLaunch(enabled: boolean): void {
  // Linux login startup is managed in the desktop environment; settings link
  // to the manual instead of offering an automatic registration switch.
  if (process.platform === 'linux') return
  // macOS/Windows: setLoginItemSettings requires a signed, packaged app.
  // In dev mode the call throws "Operation not permitted" — skip it.
  if (!app.isPackaged) return

  app.setLoginItemSettings({
    openAtLogin: enabled,
    args: enabled ? ['--opened-at-login=1'] : [],
  })
}
