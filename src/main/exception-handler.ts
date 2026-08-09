import { getLogger } from '@core/logger'
import { Events } from '@shared/protocol/events'
import type { BrowserWindow } from 'electron'
import { app } from 'electron'

export function setupExceptionHandler(options: {
  isDev: boolean
  getWindow: () => BrowserWindow | null
  onFatalError: () => Promise<void>
}): void {
  const log = getLogger('crash')

  process.on('uncaughtException', (err, origin) => {
    log.fatal({ err, origin }, 'uncaught exception')

    if (!options.isDev && app.isReady()) {
      try {
        const win = options.getWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send(Events.AppCrash, {
            message: err.message,
          })
        }
      } catch {
        /* ignore — we are already crashing */
      }

      options
        .onFatalError()
        .catch(() => {})
        .finally(() => process.exit(1))
    }
  })

  process.on('unhandledRejection', (reason) => {
    log.error({ reason }, 'unhandled rejection')

    try {
      const win = options.getWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send(Events.AppError, {
          message: reason instanceof Error ? reason.message : String(reason),
          fatal: false,
        })
      }
    } catch {
      /* ignore */
    }
  })
}
