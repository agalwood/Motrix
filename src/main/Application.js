import { EventEmitter } from 'events'
import { app, shell, dialog, ipcMain } from 'electron'
import is from 'electron-is'
import { readFile } from 'fs'
import { extname, basename } from 'path'

import logger from './core/Logger'
import ConfigManager from './core/ConfigManager'
import { setupLocaleManager } from '@/ui/Locale'
import Engine from './core/Engine'
import UpdateManager from './core/UpdateManager'
import EnergyManager from './core/EnergyManager'
import ProtocolManager from './core/ProtocolManager'
import WindowManager from './ui/WindowManager'
import MenuManager from './ui/MenuManager'
import TouchBarManager from './ui/TouchBarManager'
import TrayManager from './ui/TrayManager'
import ThemeManager from './ui/ThemeManager'

export default class Application extends EventEmitter {
  constructor () {
    super()
    this.isReady = false
    this.init()
  }

  init () {
    this.configManager = new ConfigManager()

    this.locale = this.configManager.getLocale()
    this.localeManager = setupLocaleManager(this.locale)
    this.i18n = this.localeManager.getI18n()

    this.menuManager = new MenuManager()
    this.menuManager.setup(this.locale)

    this.initTouchBarManager()

    this.windowManager = new WindowManager({
      userConfig: this.configManager.getUserConfig()
    })

    this.engine = new Engine({
      systemConfig: this.configManager.getSystemConfig(),
      userConfig: this.configManager.getUserConfig()
    })
    this.startEngine()

    this.trayManager = new TrayManager()

    this.initThemeManager()

    this.energyManager = new EnergyManager()

    this.initUpdaterManager()

    this.initProtocolManager()

    this.handleCommands()
    this.handleIpcMessages()
  }

  startEngine () {
    try {
      this.engine.start()
    } catch (err) {
      const { message } = err
      dialog.showMessageBox({
        type: 'error',
        title: this.i18n.t('app.system-error-title'),
        message: this.i18n.t('app.system-error-message', { message })
      }, () => {
        setTimeout(() => {
          app.quit()
        }, 100)
      })
    }
  }

  start (page) {
    this.showPage(page)
  }

  showPage (page) {
    const win = this.windowManager.openWindow(page)
    win.once('ready-to-show', () => {
      this.isReady = true
      this.emit('ready')
    })
    if (is.macOS()) {
      this.touchBarManager.setup(page, win)
    }
  }

  show (page = 'index') {
    this.windowManager.showWindow(page)
  }

  hide (page) {
    if (page) {
      this.windowManager.hideWindow(page)
    } else {
      this.windowManager.hideAllWindow()
    }
  }

  toggle (page = 'index') {
    this.windowManager.toggleWindow(page)
  }

  closePage (page) {
    this.windowManager.destroyWindow(page)
  }

  stop () {
    this.engine.stop()
    this.energyManager.stopPowerSaveBlocker()
  }

  sendCommand (command, ...args) {
    if (!this.emit(command, ...args)) {
      const window = this.windowManager.getFocusedWindow()
      if (window) {
        this.windowManager.sendCommandTo(window, command, ...args)
      }
    }
  }

  sendCommandToAll (command, ...args) {
    if (!this.emit(command, ...args)) {
      this.windowManager.getWindowList().forEach(window => {
        this.windowManager.sendCommandTo(window, command, ...args)
      })
    }
  }

  sendMessageToAll (channel, ...args) {
    this.windowManager.getWindowList().forEach(window => {
      this.windowManager.sendMessageTo(window, channel, ...args)
    })
  }

  initThemeManager () {
    this.themeManager = new ThemeManager()
    this.themeManager.on('system-theme-changed', (theme) => {
      this.trayManager.changeIconTheme(theme)
      this.sendCommandToAll('application:system-theme', theme)
    })
  }

  initTouchBarManager () {
    if (!is.macOS()) {
      return
    }
    this.touchBarManager = new TouchBarManager()
  }

  initProtocolManager () {
    if (is.dev() || is.mas()) {
      return
    }
    this.protocolManager = new ProtocolManager()
  }

  handleProtocol (url) {
    if (is.dev() || is.mas()) {
      return
    }

    this.show()

    this.protocolManager.handle(url)
  }

  handleFile (filePath) {
    if (!filePath) {
      return
    }

    if (extname(filePath).toLowerCase() !== '.torrent') {
      return
    }

    this.show()

    const fileName = basename(filePath)
    readFile(filePath, (err, data) => {
      if (err) {
        logger.warn(`[Motrix] read file error: ${filePath}`, err.message)
        return
      }
      const file = Buffer.from(data).toString('base64')
      const args = [fileName, file]
      this.sendCommandToAll('application:new-bt-task-with-file', ...args)
    })
  }

  initUpdaterManager () {
    if (is.mas()) {
      return
    }
    this.updateManager = new UpdateManager({
      autoCheck: this.configManager.getUserConfig('auto-check-update')
        ? (new Date().getTime() - this.configManager.getUserConfig('last-check-update-time') > 7 * 24 * 60 * 60 * 1000)
        : false,
      setCheckTime: this.configManager
    })
    this.handleUpdaterEvents()
  }

  handleUpdaterEvents () {
    this.updateManager.on('checking', (event) => {
      this.menuManager.updateMenuItemEnabledState('app.check-for-updates', false)
    })

    this.updateManager.on('download-progress', (event) => {
      const win = this.windowManager.getWindow('index')
      win.setProgressBar(event.percent / 100)
    })

    this.updateManager.on('update-not-available', (event) => {
      this.menuManager.updateMenuItemEnabledState('app.check-for-updates', true)
    })

    this.updateManager.on('update-downloaded', (event) => {
      this.menuManager.updateMenuItemEnabledState('app.check-for-updates', true)
      const win = this.windowManager.getWindow('index')
      win.setProgressBar(0)
    })

    this.updateManager.on('will-updated', (event) => {
      this.windowManager.setWillQuit(true)
    })

    this.updateManager.on('update-error', (event) => {
      this.menuManager.updateMenuItemEnabledState('app.check-for-updates', true)
    })
  }

  relaunch (page = 'index') {
    this.stop()
    app.relaunch()
    app.exit()
    // this.closePage(page)
    // if (page === 'index') {
    //   this.engine.restart()
    // }
    // setTimeout(() => {
    //   this.showPage(page)
    // }, 500)
  }

  handleCommands () {
    this.on('application:relaunch', () => {
      this.relaunch()
    })

    this.on('application:exit', () => {
      this.engine.stop()
      app.exit()
    })

    this.on('application:show', (page) => {
      this.show(page)
    })

    this.on('application:hide', (page) => {
      this.hide(page)
    })

    this.on('application:reset', () => {
      this.configManager.reset()
      this.relaunch()
    })

    this.on('application:check-for-updates', () => {
      this.updateManager.check()
    })

    this.on('application:change-theme', (theme) => {
      this.themeManager.updateAppAppearance(theme)
      this.sendCommandToAll('application:theme', theme)
    })

    this.on('application:change-locale', (locale) => {
      logger.info('[Motrix] application:change-locale===>', locale)
      this.localeManager.changeLanguageByLocale(locale)
        .then(() => {
          this.menuManager.setup(locale)
          this.trayManager.setup(locale)
        })
    })

    this.on('application:open-file', (event) => {
      dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [
          {
            name: 'Torrent',
            extensions: ['torrent']
          }
        ]
      }, (filePaths) => {
        if (!filePaths || filePaths.length === 0) {
          return
        }

        const [filePath] = filePaths
        this.handleFile(filePath)
      })
    })

    this.on('application:clear-recent-tasks', () => {
      app.clearRecentDocuments()
    })

    this.on('help:official-website', () => {
      const url = 'https://motrix.app/'
      shell.openExternal(url)
    })

    this.on('help:manual', () => {
      const url = 'https://motrix.app/manual'
      shell.openExternal(url)
    })

    this.on('help:release-notes', () => {
      const url = 'https://motrix.app/release'
      shell.openExternal(url)
    })

    this.on('help:report-problem', () => {
      const url = 'https://motrix.app/report'
      shell.openExternal(url)
    })
  }

  handleIpcMessages () {
    ipcMain.on('command', (event, command, ...args) => {
      logger.log('receive command', command, ...args)
      this.emit(command, ...args)
    })

    ipcMain.on('update-menu-states', (event, visibleStates, enabledStates, checkedStates) => {
      this.menuManager.updateStates(visibleStates, enabledStates, checkedStates)
    })

    ipcMain.on('download-status-change', (event, status) => {
      this.trayManager.updateStatus(status)
    })
  }
}
