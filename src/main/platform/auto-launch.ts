import { app } from 'electron'

export function syncAutoLaunch(enabled: boolean): void {
  if (process.platform === 'linux') return
  // macOS/Windows: setLoginItemSettings requires a signed, packaged app.
  // In dev mode the call throws "Operation not permitted" — skip it.
  if (!app.isPackaged) return

  app.setLoginItemSettings({
    openAtLogin: enabled,
    args: enabled ? ['--opened-at-login=1'] : [],
  })
}
