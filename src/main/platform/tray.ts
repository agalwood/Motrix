import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { EventBus } from '@core/events/event-bus'
import { getLogger } from '@core/logger'
import type { SettingsManager } from '@core/settings/settings-manager'
import { RunMode } from '@shared/constants'
import { Events } from '@shared/protocol/events'
import type { AppSettings } from '@shared/types/settings'
import { app, type Menu, Tray } from 'electron'
import type { MenuManager } from '../menu/menu-manager'
import { resolveDesktopBackgroundPolicy } from './desktop-background-policy'
import type { createProtocolManager } from './protocol-manager'
import type { TrayIconProvider } from './tray-icon'
import { createIconProvider } from './tray-icon'
import type { SpeedometerHandle } from './tray-speedometer'
import { createSpeedometer } from './tray-speedometer'

// NOTE: logger is created inside setupTray(), not at module scope.
// Module-scope getLogger() runs before initLogger() and would only
// write to stdout (invisible in packaged apps).

// Keep this value stable: macOS uses it to restore the tray item's position
// between launches.
const MACOS_TRAY_GUID = '493f17b6-d4ac-48d3-8723-c3ac490b14cf'

// Linux requires setContextMenu for the context menu to work.
function applyMenuToTray(tray: Tray, menu: Menu): void {
  if (process.platform === 'linux') {
    tray.setContextMenu(menu)
  }
}

export interface TrayDeps {
  eventBus: EventBus
  settingsManager: SettingsManager
  menuManager: MenuManager
  protocolManager: ReturnType<typeof createProtocolManager>
  extraResourceDir: string
  toggleMainWindow: () => void
}

export interface TrayHandle {
  destroy(): void
}

export function setupTray(deps: TrayDeps): TrayHandle {
  const log = getLogger('tray')
  const {
    eventBus,
    settingsManager,
    menuManager,
    protocolManager,
    extraResourceDir,
    toggleMainWindow,
  } = deps

  // Resolve asset paths — all tray assets live in extra/tray/
  const trayAssetDir = path.join(extraResourceDir, 'tray')
  const svgPath = path.join(trayAssetDir, 'tray.svg')

  // State
  let tray: Tray | null = null
  let iconProvider: TrayIconProvider | null = null
  let speedometer: SpeedometerHandle | null = null
  let offTrayRebuilt: (() => void) | null = null
  let isActive = false

  // ─── Icon SVG content (for speedometer) ─────────────────

  let iconSvgContent: string | null = null
  function getIconSvg(): string {
    if (!iconSvgContent) {
      iconSvgContent = readFileSync(svgPath, 'utf-8')
      iconSvgContent = iconSvgContent.replace(/fill="[^"]*"/g, 'fill="black"')
    }
    return iconSvgContent
  }

  // ─── Create / Destroy ───────────────────────────────────

  async function createTray() {
    if (tray) return
    log.info('creating tray')

    iconProvider = createIconProvider(svgPath, trayAssetDir)
    await iconProvider.init()

    const icon = iconProvider.getIcon(false)
    tray =
      process.platform === 'darwin'
        ? new Tray(icon, MACOS_TRAY_GUID)
        : new Tray(icon)

    if (process.platform !== 'darwin') {
      tray.setToolTip('Motrix')
    }

    // macOS: speedometer
    if (process.platform === 'darwin') {
      speedometer = createSpeedometer(() => tray, getIconSvg(), trayAssetDir)
      speedometer.setEnabled(settingsManager.getApp().traySpeedometer)
    }

    // Menu
    let currentMenu = menuManager.getTrayMenu()
    if (currentMenu) applyMenuToTray(tray, currentMenu)

    offTrayRebuilt = menuManager.onTrayRebuilt((newMenu) => {
      currentMenu = newMenu
      if (tray) applyMenuToTray(tray, newMenu)
    })

    // Events
    tray.on('click', () => {
      if (process.platform !== 'darwin') {
        toggleMainWindow()
        return
      }

      if (currentMenu) tray?.popUpContextMenu(currentMenu)
    })

    // Electron only supports right-click and popUpContextMenu on macOS and
    // Windows. Linux delegates the context action to setContextMenu above.
    if (process.platform !== 'linux') {
      tray.on('right-click', () => {
        if (currentMenu) tray?.popUpContextMenu(currentMenu)
      })
    }

    // macOS: ignore double-click, enable drop
    if (process.platform === 'darwin') {
      tray.setIgnoreDoubleClickEvents(true)

      tray.on('drop-files', (_event, files) => {
        for (const file of files) {
          if (file.toLowerCase().endsWith('.torrent')) {
            protocolManager.handleTorrentFile(file)
          }
        }
      })

      tray.on('drop-text', (_event, text) => {
        protocolManager.handle(text)
      })
    }

    log.info('tray created')
  }

  function destroyTray() {
    if (!tray) return
    log.info('destroying tray')

    offTrayRebuilt?.()
    offTrayRebuilt = null

    speedometer?.destroy()
    speedometer = null

    tray.removeAllListeners()
    tray.destroy()
    tray = null
    iconProvider = null
  }

  // ─── Dock Visibility (macOS only) ───────────────────────

  function syncDockVisibility(mode: RunMode): void {
    if (process.platform !== 'darwin') return

    if (mode === RunMode.TrayOnly) {
      app.dock?.hide()
    } else {
      app.dock?.show()
    }
  }

  // ─── EventBus Listeners ─────────────────────────────────

  function onSettingsChanged(payload: unknown) {
    const { old: oldSettings, updated } = payload as {
      old: AppSettings
      updated: AppSettings
    }

    // Run mode and lightweight mode jointly decide whether a tray reopen
    // surface is required.
    if (
      oldSettings.app.runMode !== updated.app.runMode ||
      oldSettings.app.lightweightMode !== updated.app.lightweightMode
    ) {
      const newMode = updated.app.runMode
      const policy = resolveDesktopBackgroundPolicy({
        lightweightMode: updated.app.lightweightMode,
        platform: process.platform,
        runMode: newMode,
      })
      log.info(
        {
          keepTray: policy.keepTray,
          lightweightMode: updated.app.lightweightMode,
          runMode: newMode,
        },
        'desktop background policy changed'
      )

      if (policy.keepTray && !tray) {
        createTray().catch((err) => log.error({ err }, 'tray creation failed'))
      } else if (!policy.keepTray) {
        destroyTray()
      }
      if (oldSettings.app.runMode !== newMode) {
        syncDockVisibility(newMode)
      }
    }

    // Speedometer toggled
    if (oldSettings.app.traySpeedometer !== updated.app.traySpeedometer) {
      speedometer?.setEnabled(updated.app.traySpeedometer)
      if (!updated.app.traySpeedometer && tray && iconProvider) {
        // Revert to static icon
        tray.setImage(iconProvider.getIcon(isActive))
      }
    }
  }

  function onEngineActiveChanged(active: unknown) {
    isActive = active as boolean
    if (tray && iconProvider && !settingsManager.getApp().traySpeedometer) {
      tray.setImage(iconProvider.getIcon(isActive))
    }
  }

  function onStatsUpdated(stats: unknown) {
    const { totalUploadSpeed, totalDownloadSpeed } = stats as {
      totalUploadSpeed: number
      totalDownloadSpeed: number
    }
    speedometer?.onSpeedChange(totalUploadSpeed, totalDownloadSpeed)
  }

  // ─── Init ───────────────────────────────────────────────

  const appSettings = settingsManager.getApp()
  const runMode = appSettings.runMode
  const policy = resolveDesktopBackgroundPolicy({
    lightweightMode: appSettings.lightweightMode,
    platform: process.platform,
    runMode,
  })

  if (policy.keepTray) {
    createTray().catch((err) => log.error({ err }, 'tray creation failed'))
  }
  syncDockVisibility(runMode)

  // Subscribe to events
  eventBus.on(Events.SettingsChanged, onSettingsChanged)
  eventBus.on(Events.EngineActiveChanged, onEngineActiveChanged)
  eventBus.on(Events.StatsUpdated, onStatsUpdated)

  log.info({ keepTray: policy.keepTray, runMode }, 'tray setup complete')

  // ─── Handle ─────────────────────────────────────────────

  return {
    destroy() {
      eventBus.off(Events.SettingsChanged, onSettingsChanged)
      eventBus.off(Events.EngineActiveChanged, onEngineActiveChanged)
      eventBus.off(Events.StatsUpdated, onStatsUpdated)
      destroyTray()
      log.info('tray destroyed')
    },
  }
}
