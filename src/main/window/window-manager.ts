import { getLogger } from '@core/logger'
import type { SettingsManager } from '@core/settings/settings-manager'
import {
  Events,
  type WindowMaximizedChangedPayload,
} from '@shared/protocol/events'
import type { AddTaskUrlParams } from '@shared/schemas/add-task'
import type { WindowBounds, WindowState } from '@shared/types/settings'
import { BrowserWindow, screen, shell } from 'electron'
import type { LiquidGlassController } from './liquid-glass'
import { buildPlatformOptions } from './platform-options'
import {
  getRendererUrlPolicy,
  type RendererUrlPolicy,
} from './renderer-url-policy'
import type { WindowId } from './window-configs'
import { WINDOW_CONFIGS } from './window-configs'

const log = getLogger('window')

export interface WindowManagerDeps {
  settingsManager: SettingsManager
  preloadPath: string
  loadUrl: (win: BrowserWindow, route: string) => void
  liquidGlass?: LiquidGlassController
  /**
   * Platform for window chrome decisions; defaults to process.platform.
   * Injected by tests so platform-specific chrome is verifiable on any host.
   */
  platform?: string
  /** Enables the development-only macOS in-window application-menu preview. */
  previewMacMenu?: boolean
  /** Central legal/startup gate for every window-opening entry point. */
  resolveOpenTarget?: (requested: WindowId) => WindowId
  /** Invoked when Windows first queries or confirms that the session will end. */
  onSessionEnd?: () => void
  /** Frozen renderer trust policy shared with IPC sender validation. */
  rendererUrlPolicy?: RendererUrlPolicy
  /** Live policy so a settings change affects the next window dismissal
   * without rebuilding the manager or restarting the application. */
  retentionPolicy?: WindowRetentionPolicy
}

export interface WindowRetentionPolicy {
  releaseMainOnDismiss(): boolean
  prewarmAddTask(): boolean
}

export class WindowManager {
  private windows = new Map<WindowId, BrowserWindow | null>()
  private deps: WindowManagerDeps
  private willQuit = false
  private boundsTimers = new Map<WindowId, ReturnType<typeof setTimeout>>()
  private rendererUrlPolicy: RendererUrlPolicy
  // The window the user most recently asked to be brought to the
  // foreground. Read by each window's `ready-to-show` handler: a window
  // that finishes loading after this changes (e.g. main rendering after
  // a cold-start magnet/torrent triggered `show('add-task')`) shows
  // itself via `showInactive()` so it doesn't steal focus.
  private lastFocusRequested: WindowId | null = null

  constructor(deps: WindowManagerDeps) {
    this.deps = deps
    this.rendererUrlPolicy = deps.rendererUrlPolicy ?? getRendererUrlPolicy()
  }

  open(id: WindowId, options: { show?: boolean } = {}): BrowserWindow {
    id = this.resolveOpenTarget(id)
    const existing = this.windows.get(id)
    if (existing && !existing.isDestroyed()) {
      existing.show()
      existing.focus()
      return existing
    }

    const show = options.show ?? true
    if (show) {
      this.lastFocusRequested = id
    }
    const win = this.registerWindow(id, show)
    this.setupBoundsTracking(id, win)
    this.restoreBounds(id, win)
    return win
  }

  precreate(id: WindowId): void {
    id = this.resolveOpenTarget(id)
    const existing = this.windows.get(id)
    if (existing && !existing.isDestroyed()) return

    this.registerWindow(id, false)
  }

  show(
    id: WindowId,
    options?: AddTaskUrlParams | { mode?: 'links' | 'torrent' }
  ): void {
    const requestedId = id
    id = this.resolveOpenTarget(id)
    if (id !== requestedId) options = undefined
    this.lastFocusRequested = id
    let win = this.windows.get(id)
    if (!win || win.isDestroyed()) {
      // Self-heal: a window with closeBehavior 'destroy' may have been
      // destroyed by the user (e.g. clicking the traffic-light close
      // button). Recreate it instead of silently no-opping.
      win = this.open(id)
    }

    const config = WINDOW_CONFIGS[id]

    if (id !== 'main') {
      const mainWin = this.windows.get('main')
      if (mainWin && !mainWin.isDestroyed() && mainWin.isVisible()) {
        const mainBounds = mainWin.getBounds()
        const x = Math.round(
          mainBounds.x + (mainBounds.width - config.width) / 2
        )
        const y = Math.round(
          mainBounds.y + (mainBounds.height - config.height) / 2
        )
        win.setBounds({ x, y, width: config.width, height: config.height })
      } else {
        win.center()
      }
    }

    win.show()
    win.focus()

    if (options && id === 'add-task') {
      setTimeout(() => {
        if (!win.isDestroyed()) {
          win.webContents.send(Events.SetAddTaskMode, options)
        }
      }, 100)
    }
  }

  toggle(id: WindowId): void {
    id = this.resolveOpenTarget(id)
    const win = this.windows.get(id)
    if (!win || win.isDestroyed()) {
      this.open(id)
      return
    }

    if (win.isVisible() && win.isFocused()) {
      this.close(id)
    } else {
      win.show()
      win.focus()
    }
  }

  hide(id: WindowId): void {
    const win = this.windows.get(id)
    if (!win || win.isDestroyed()) return
    win.hide()
  }

  close(id: WindowId): void {
    const win = this.windows.get(id)
    if (!win || win.isDestroyed()) return

    const config = WINDOW_CONFIGS[id]

    if (config.closeBehavior === 'hide' && !this.shouldReleaseOnDismiss(id)) {
      this.saveBounds(id)
      win.hide()
    } else {
      this.release(id)
    }
  }

  release(id: WindowId): void {
    const win = this.windows.get(id)
    if (!win || win.isDestroyed()) return

    this.saveBounds(id)
    this.clearBoundsTimer(id)
    win.webContents.removeAllListeners()
    win.removeAllListeners()
    win.destroy()
    this.windows.set(id, null)
  }

  closeAndRecycle(id: WindowId): void {
    this.close(id)
    const config = WINDOW_CONFIGS[id]
    if (
      config.closeBehavior === 'destroy' &&
      (id !== 'add-task' || this.shouldPrewarmAddTask())
    ) {
      this.precreate(id)
    }
  }

  /** Reconcile already-created hidden windows after lightweight mode changes. */
  reconcileWindowRetention(): void {
    const main = this.get('main')
    if (main && !main.isVisible() && this.shouldReleaseOnDismiss('main')) {
      this.release('main')
    }

    const addTask = this.get('add-task')
    if (this.shouldPrewarmAddTask()) {
      if (!addTask) this.precreate('add-task')
    } else if (addTask && !addTask.isVisible()) {
      this.release('add-task')
    }
  }

  recreate(id: WindowId): BrowserWindow {
    id = this.resolveOpenTarget(id)
    const existing = this.get(id)
    const shouldShow = existing?.isVisible() ?? true

    if (existing) {
      this.release(id)
    }

    const win = this.registerWindow(id, shouldShow)
    this.setupBoundsTracking(id, win)
    this.restoreBounds(id, win)
    return win
  }

  get(id: WindowId): BrowserWindow | null {
    const win = this.windows.get(id) ?? null
    if (win?.isDestroyed()) {
      this.windows.set(id, null)
      return null
    }
    return win
  }

  getAllWindows(): BrowserWindow[] {
    const result: BrowserWindow[] = []
    for (const win of this.windows.values()) {
      if (win && !win.isDestroyed()) {
        result.push(win)
      }
    }
    return result
  }

  getWindowIdBySender(sender: Electron.WebContents): WindowId | null {
    for (const [id, win] of this.windows.entries()) {
      if (win && !win.isDestroyed() && win.webContents === sender) {
        return id
      }
    }
    return null
  }

  broadcast(channel: string, ...args: unknown[]): void {
    for (const win of this.windows.values()) {
      if (!win || win.isDestroyed()) continue
      try {
        win.webContents.send(channel, ...args)
      } catch (error) {
        // A renderer can be destroyed between isDestroyed() and send(). One
        // closing window must not prevent the remaining windows from
        // receiving state-reconciliation events such as LocaleChanged.
        log.warn({ err: error, channel }, 'window broadcast failed')
      }
    }
  }

  setWillQuit(value: boolean): void {
    this.willQuit = value
  }

  destroyAll(): void {
    for (const [id, win] of this.windows.entries()) {
      this.clearBoundsTimer(id)
      if (win && !win.isDestroyed()) {
        win.webContents.removeAllListeners()
        win.removeAllListeners()
        win.destroy()
      }
      this.windows.set(id, null)
    }
  }

  saveBounds(id: WindowId): void {
    const config = WINDOW_CONFIGS[id]
    if (!config.persistBounds) return

    const win = this.windows.get(id)
    if (!win || win.isDestroyed()) return

    const state: WindowState = {
      ...win.getNormalBounds(),
      maximized: win.isMaximized(),
    }
    this.deps.settingsManager
      .update({ windowState: { [id]: state } })
      .catch(() => {})
  }

  // ─── Private ──────────────────────────────────────────

  private resolveOpenTarget(id: WindowId): WindowId {
    return this.deps.resolveOpenTarget?.(id) ?? id
  }

  private registerWindow(id: WindowId, show: boolean): BrowserWindow {
    const config = WINDOW_CONFIGS[id]
    const win = this.createBrowserWindow(config, show)
    const previewMacMenu =
      id === 'main' &&
      (this.deps.platform ?? process.platform) === 'darwin' &&
      (this.deps.previewMacMenu ??
        (process.env.VITE_DEV_SERVER_URL !== undefined &&
          process.env.MOTRIX_PREVIEW_MAC_MENU === '1'))

    this.windows.set(id, win)
    if (config.liquidGlass) {
      this.deps.liquidGlass?.attach(id, win)
    }
    if (previewMacMenu) {
      // Local-only product preview: liquid glass may have made the native
      // buttons visible during attach(), so apply the preview override last.
      win.setWindowButtonVisibility(false)
    }
    this.setupWindowStateTracking(win)
    this.deps.loadUrl(win, config.route)
    this.setupCloseHandler(id, win)
    win.once('closed', () => {
      this.clearBoundsTimer(id)
      if (this.windows.get(id) === win) {
        this.windows.set(id, null)
      }
    })

    return win
  }

  private clearBoundsTimer(id: WindowId): void {
    const timer = this.boundsTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.boundsTimers.delete(id)
    }
  }

  private shouldReleaseOnDismiss(id: WindowId): boolean {
    return (
      id === 'main' &&
      this.deps.retentionPolicy?.releaseMainOnDismiss() === true
    )
  }

  private shouldPrewarmAddTask(): boolean {
    return this.deps.retentionPolicy?.prewarmAddTask() ?? true
  }

  private createBrowserWindow(
    config: (typeof WINDOW_CONFIGS)[WindowId],
    show: boolean
  ): BrowserWindow {
    const platform = this.deps.platform ?? process.platform
    const liquidGlass =
      config.liquidGlass &&
      this.deps.liquidGlass?.shouldUseLiquidGlass() === true
    const platformOpts = buildPlatformOptions(platform, {
      vibrancy: config.vibrancy && !liquidGlass,
      liquidGlass,
    })

    const win = new BrowserWindow({
      title: config.title,
      width: config.width,
      height: config.height,
      minWidth: config.minWidth,
      minHeight: config.minHeight,
      resizable: config.resizable,
      maximizable: config.maximizable,
      show: false,
      ...platformOpts,
      webPreferences: {
        preload: this.deps.preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    })

    win.on('page-title-updated', (event) => {
      event.preventDefault()
    })

    if (platform === 'win32' || platform === 'linux') {
      win.setAutoHideMenuBar(false)
      win.setMenuBarVisibility(false)
    }

    if (config.minWidth && config.minHeight) {
      win.setMinimumSize(config.minWidth, config.minHeight)
    }

    // Route target="_blank" / window.open to the system browser for
    // http(s)/mailto; deny everything else. Keeps <a target="_blank">
    // working in any window without special handling at call sites.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^(https?|mailto):/i.test(url)) {
        void shell.openExternal(url)
      }
      return { action: 'deny' }
    })

    const preventUntrustedNavigation = (
      event: Electron.Event,
      url: string
    ): void => {
      if (this.rendererUrlPolicy.isTrustedUrl(url)) return
      event.preventDefault()
      log.warn({ url }, 'blocked renderer navigation outside trusted entry')
    }
    win.webContents.on('will-navigate', preventUntrustedNavigation)
    win.webContents.on('will-redirect', preventUntrustedNavigation)

    if (show) {
      win.once('ready-to-show', () => {
        if (win.isDestroyed()) return
        // Cold-start race: main + add-task can both have pending
        // `ready-to-show` events when the app launches via magnet/
        // torrent. Whichever finishes loading last would otherwise
        // steal focus. If the user has since asked for a different
        // window to be in front, show this one in the background.
        const front = this.lastFocusRequested
        if (front !== null && front !== config.id) {
          win.showInactive()
        } else {
          win.show()
        }
      })
    }

    this.attachRendererDiagnostics(win, config.id)

    return win
  }

  private attachRendererDiagnostics(win: BrowserWindow, id: WindowId): void {
    const report = (event: string, payload: Record<string, unknown>) => {
      log.error({ id, ...payload }, `webContents ${event}`)
    }

    win.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        report('did-fail-load', {
          errorCode,
          errorDescription,
          validatedURL,
          isMainFrame,
        })
      }
    )

    win.webContents.on('preload-error', (_event, preloadPath, error) => {
      report('preload-error', { preloadPath, error })
    })

    win.webContents.on('render-process-gone', (_event, details) => {
      report('render-process-gone', {
        reason: details.reason,
        exitCode: details.exitCode,
      })
    })

    // Forward renderer warnings and errors to the main-process logger.
    win.webContents.on('console-message', (event) => {
      if (event.level === 'info' || event.level === 'debug') return
      const fields = {
        id,
        level: event.level,
        message: event.message,
        line: event.lineNumber,
        sourceId: event.sourceId,
      }
      if (event.level === 'error') {
        log.error(fields, 'renderer console-message')
      } else {
        log.warn(fields, 'renderer console-message')
      }
    })
  }

  private setupCloseHandler(id: WindowId, win: BrowserWindow): void {
    const config = WINDOW_CONFIGS[id]

    win.on('close', (event) => {
      if (config.closeBehavior === 'hide' && !this.willQuit) {
        this.saveBounds(id)
        if (this.shouldReleaseOnDismiss(id)) return
        event.preventDefault()
        win.hide()
      }
    })

    if (id === 'main') {
      win.on('query-session-end', () => this.deps.onSessionEnd?.())
      win.on('session-end', () => this.deps.onSessionEnd?.())
    }
  }

  private setupWindowStateTracking(win: BrowserWindow): void {
    const publish = () => {
      if (win.isDestroyed()) return
      const payload: WindowMaximizedChangedPayload = {
        maximized: win.isMaximized(),
      }
      win.webContents.send(Events.WindowMaximizedChanged, payload)
    }

    // did-finish-load supplies the initial snapshot; maximize/unmaximize keep
    // it correct for caption clicks, title-bar double-clicks, and OS actions.
    // Cocoa can leave the maximized state via a manual resize without emitting
    // unmaximize, so reconcile once the resize gesture finishes as well.
    win.webContents.on('did-finish-load', publish)
    win.on('maximize', publish)
    win.on('unmaximize', publish)
    win.on('resized', publish)
  }

  private setupBoundsTracking(id: WindowId, win: BrowserWindow): void {
    const config = WINDOW_CONFIGS[id]
    if (!config.persistBounds) return

    const debouncedSave = () => {
      const existing = this.boundsTimers.get(id)
      if (existing) clearTimeout(existing)
      this.boundsTimers.set(
        id,
        setTimeout(() => this.saveBounds(id), 500)
      )
    }

    win.on('resize', debouncedSave)
    win.on('move', debouncedSave)
  }

  private restoreBounds(id: WindowId, win: BrowserWindow): void {
    const config = WINDOW_CONFIGS[id]
    if (!config.persistBounds) return

    const settings = this.deps.settingsManager.get()
    const saved = settings.windowState[id] as WindowState | undefined
    if (!saved) {
      win.center()
      return
    }

    const { maximized = false, ...bounds } = saved
    if (this.isBoundsVisible(bounds)) {
      win.setBounds(bounds)
    } else {
      win.center()
    }

    if (maximized && config.maximizable) {
      win.maximize()
    }
  }

  private isBoundsVisible(bounds: WindowBounds): boolean {
    const displays = screen.getAllDisplays()
    const MARGIN = 50

    for (const display of displays) {
      const db = display.bounds
      const overlapX =
        Math.min(bounds.x + bounds.width, db.x + db.width) -
        Math.max(bounds.x, db.x)
      const overlapY =
        Math.min(bounds.y + bounds.height, db.y + db.height) -
        Math.max(bounds.y, db.y)

      if (overlapX >= MARGIN && overlapY >= MARGIN) {
        return true
      }
    }
    return false
  }
}
