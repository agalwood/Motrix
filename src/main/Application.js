import { EventEmitter } from 'events'
import { app, shell, dialog, ipcMain } from 'electron'
import is from 'electron-is'
import { readFile } from 'fs'
import { extname, basename } from 'path'
import { isEmpty } from 'lodash'

import logger from './core/Logger'
import ConfigManager from './core/ConfigManager'
import { setupLocaleManager } from '@/ui/Locale'
import Engine from './core/Engine'
import EngineClient from './core/EngineClient'
import UPnPManager from './core/UPnPManager'
import AutoLaunchManager from './core/AutoLaunchManager'
import UpdateManager from './core/UpdateManager'
import EnergyManager from './core/EnergyManager'
import ProtocolManager from './core/ProtocolManager'
import WindowManager from './ui/WindowManager'
import MenuManager from './ui/MenuManager'
import TouchBarManager from './ui/TouchBarManager'
import TrayManager from './ui/TrayManager'
import DockManager from './ui/DockManager'
import ThemeManager from './ui/ThemeManager'
import {
  APP_RUN_MODE,
  AUTO_SYNC_TRACKER_INTERVAL,
  AUTO_CHECK_UPDATE_INTERVAL
} from '@shared/constants'
import { checkIsNeedRun } from '@shared/utils'
import {
  convertTrackerDataToComma,
  fetchBtTrackerFromSource
} from '@shared/utils/tracker'

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

    this.setupApplicationMenu()

    this.initWindowManager()

    this.initUPnPManager()

    this.startEngine()

    this.initEngineClient()

    this.initTouchBarManager()

    this.initThemeManager()

    this.initTrayManager()

    this.initDockManager()

    this.autoLaunchManager = new AutoLaunchManager()

    this.energyManager = new EnergyManager()

    this.initUpdaterManager()

    this.initProtocolManager()

    this.handleCommands()

    this.handleEvents()

    this.handleIpcMessages()

    this.emit('application:initialized')
  }

  setupApplicationMenu () {
    this.menuManager = new MenuManager()
    this.menuManager.setup(this.locale)
  }

  adjustMenu () {
    if (is.mas()) {
      const visibleStates = {
        'app.check-for-updates': false,
        'task.new-bt-task': false
      }
      this.menuManager.updateMenuStates(visibleStates, null, null)
      this.trayManager.updateMenuStates(visibleStates, null, null)
    }
  }

  startEngine () {
    const self = this

    try {
      this.engine = new Engine({
        systemConfig: this.configManager.getSystemConfig(),
        userConfig: this.configManager.getUserConfig()
      })
      this.engine.start()
    } catch (err) {
      const { message } = err
      dialog.showMessageBox({
        type: 'error',
        title: this.i18n.t('app.system-error-title'),
        message: this.i18n.t('app.system-error-message', { message })
      }).then(_ => {
        setTimeout(() => {
          self.quit()
        }, 100)
      })
    }
  }

  async stopEngine () {
    try {
      await this.engineClient.shutdown({ force: true })
      setImmediate(() => {
        this.engine.stop()
      })
    } catch (err) {
      logger.warn('[Motrix] shutdown engine fail: ', err.message)
    } finally {
    }
  }

  initEngineClient () {
    const port = this.configManager.getSystemConfig('rpc-listen-port')
    const secret = this.configManager.getSystemConfig('rpc-secret')
    this.engineClient = new EngineClient({
      port,
      secret
    })
  }

  initTrayManager () {
    this.trayManager = new TrayManager({
      theme: this.configManager.getUserConfig('tray-theme')
    })
  }

  initDockManager () {
    this.dockManager = new DockManager({
      runMode: this.configManager.getUserConfig('run-mode')
    })
  }

  initUPnPManager () {
    this.upnp = new UPnPManager()

    this.watchEnableUPnPChange()

    this.watchPortsChange()

    const enable = this.configManager.getUserConfig('enable-upnp')
    if (!enable) {
      return
    }

    this.startUPnPMapping()
  }

  async startUPnPMapping () {
    const btPort = this.configManager.getSystemConfig('listen-port')
    const dhtPort = this.configManager.getSystemConfig('dht-listen-port')

    const promises = [
      this.upnp.map(btPort),
      this.upnp.map(dhtPort)
    ]
    try {
      await Promise.allSettled(promises)
    } catch (e) {
      logger.warn('[Motrix] start UPnP mapping fail', e)
    }
  }

  async stopUPnPMapping () {
    const btPort = this.configManager.getSystemConfig('listen-port')
    const dhtPort = this.configManager.getSystemConfig('dht-listen-port')

    const promises = [
      this.upnp.unmap(btPort),
      this.upnp.unmap(dhtPort)
    ]
    try {
      await Promise.allSettled(promises)
    } catch (e) {
      logger.warn('[Motrix] stop UPnP mapping fail', e)
    }
  }

  watchPortsChange () {
    const watchKeys = ['listen-port', 'dht-listen-port']

    watchKeys.map((key) => {
      this.configManager.systemConfig.onDidChange(key, async (newValue, oldValue) => {
        logger.info('[Motrix] detected port change event:', key, newValue, oldValue)
        const enable = this.configManager.getUserConfig('enable-upnp')
        if (!enable) {
          return
        }

        const promises = [
          this.upnp.unmap(oldValue),
          this.upnp.map(newValue)
        ]
        try {
          await Promise.allSettled(promises)
        } catch (e) {
          logger.info('[Motrix] change UPnP port mapping failed:', e)
        }
      })
    })
  }

  watchEnableUPnPChange () {
    this.configManager.userConfig.onDidChange('enable-upnp', async (newValue, oldValue) => {
      logger.info('[Motrix] detected enable-upnp value change event:', newValue, oldValue)
      if (newValue) {
        this.startUPnPMapping()
      } else {
        await this.stopUPnPMapping()
        this.upnp.closeClient()
      }
    })
  }

  async shutdownUPnPManager () {
    const enable = this.configManager.getUserConfig('enable-upnp')
    if (enable) {
      await this.stopUPnPMapping()
    }

    this.upnp.closeClient()
  }

  autoSyncTracker () {
    const enable = this.configManager.getUserConfig('auto-sync-tracker')
    const lastTime = this.configManager.getUserConfig('last-sync-tracker-time')
    const result = checkIsNeedRun(enable, lastTime, AUTO_SYNC_TRACKER_INTERVAL)
    logger.info('[Motrix] auto sync tracker checkIsNeedRun:', result)
    if (!result) {
      return
    }

    setTimeout(() => {
      const source = this.configManager.getUserConfig('tracker-source')
      fetchBtTrackerFromSource(source).then((data) => {
        logger.warn('[Motrix] auto sync tracker data:', data)
        const tracker = convertTrackerDataToComma(data)
        this.savePreference({
          system: {
            'bt-tracker': tracker
          },
          user: {
            'last-sync-tracker-time': Date.now()
          }
        })
      }).catch((err) => {
        logger.warn('[Motrix] auto sync tracker failed:', err.message)
      })
    }, 500)
  }

  autoResumeTask () {
    const enabled = this.configManager.getUserConfig('resume-all-when-app-launched')
    if (!enabled) {
      return
    }

    this.engineClient.call('unpauseAll')
  }

  initWindowManager () {
    this.windowManager = new WindowManager({
      userConfig: this.configManager.getUserConfig()
    })

    this.windowManager.on('window-resized', (data) => {
      this.storeWindowState(data)
    })

    this.windowManager.on('window-moved', (data) => {
      this.storeWindowState(data)
    })

    this.windowManager.on('window-closed', (data) => {
      this.storeWindowState(data)
    })

    this.windowManager.on('enter-full-screen', (window) => {
      this.dockManager.show()
    })

    this.windowManager.on('leave-full-screen', (window) => {
      const mode = this.configManager.getUserConfig('run-mode')
      if (mode !== APP_RUN_MODE.STANDARD) {
        this.dockManager.hide()
      }
    })
  }

  storeWindowState (data = {}) {
    const enabled = this.configManager.getUserConfig('keep-window-state')
    if (!enabled) {
      return
    }

    const state = this.configManager.getUserConfig('window-state', {})
    const { page, bounds } = data
    const newState = {
      ...state,
      [page]: bounds
    }
    this.configManager.setUserConfig('window-state', newState)
  }

  start (page, options = {}) {
    const win = this.showPage(page, options)

    win.once('ready-to-show', () => {
      this.isReady = true
      this.emit('ready')
    })
    if (is.macOS()) {
      this.touchBarManager.setup(page, win)
    }
  }

  showPage (page, options = {}) {
    const { openedAtLogin } = options
    const autoHideWindow = this.configManager.getUserConfig('auto-hide-window')
    return this.windowManager.openWindow(page, {
      hidden: openedAtLogin || autoHideWindow
    })
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

  async stop () {
    try {
      await this.shutdownUPnPManager()

      this.energyManager.stopPowerSaveBlocker()

      await this.stopEngine()

      this.trayManager.destroy()
    } catch (err) {
      logger.warn('[Motrix] stop error: ', err.message)
    }
  }

  async quit () {
    await this.stop()
    app.exit()
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
    this.themeManager.on('system-theme-change', (theme) => {
      this.trayManager.changeIconTheme(theme)
      this.sendCommandToAll('application:update-system-theme', theme)
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

    const protocols = this.configManager.getUserConfig('protocols', {})
    this.protocolManager = new ProtocolManager({
      protocols
    })
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

    const enable = this.configManager.getUserConfig('auto-check-update')
    const lastTime = this.configManager.getUserConfig('last-check-update-time')
    this.updateManager = new UpdateManager({
      autoCheck: checkIsNeedRun(enable, lastTime, AUTO_CHECK_UPDATE_INTERVAL)
    })
    this.handleUpdaterEvents()
  }

  handleUpdaterEvents () {
    this.updateManager.on('checking', (event) => {
      this.menuManager.updateMenuItemEnabledState('app.check-for-updates', false)
      this.trayManager.updateMenuItemEnabledState('app.check-for-updates', false)
      this.configManager.setUserConfig('last-check-update-time', Date.now())
    })

    this.updateManager.on('download-progress', (event) => {
      const win = this.windowManager.getWindow('index')
      win.setProgressBar(event.percent / 100)
    })

    this.updateManager.on('update-not-available', (event) => {
      this.menuManager.updateMenuItemEnabledState('app.check-for-updates', true)
      this.trayManager.updateMenuItemEnabledState('app.check-for-updates', true)
    })

    this.updateManager.on('update-downloaded', (event) => {
      this.menuManager.updateMenuItemEnabledState('app.check-for-updates', true)
      this.trayManager.updateMenuItemEnabledState('app.check-for-updates', true)
      const win = this.windowManager.getWindow('index')
      win.setProgressBar(0)
    })

    this.updateManager.on('will-updated', (event) => {
      this.windowManager.setWillQuit(true)
    })

    this.updateManager.on('update-error', (event) => {
      this.menuManager.updateMenuItemEnabledState('app.check-for-updates', true)
      this.trayManager.updateMenuItemEnabledState('app.check-for-updates', true)
    })
  }

  relaunch () {
    this.stop()
    app.relaunch()
    app.exit()
  }

  savePreference (config = {}) {
    logger.info('[Motrix] save preference:', config)
    const { system, user } = config
    if (!isEmpty(system)) {
      console.info('[Motrix] main save system config: ', system)
      this.configManager.setSystemConfig(system)
      this.engineClient.changeGlobalOption(system)
    }

    if (!isEmpty(user)) {
      console.info('[Motrix] main save user config: ', user)
      this.configManager.setUserConfig(user)
    }
  }

  handleCommands () {
    this.on('application:save-preference', this.savePreference)

    this.on('application:relaunch', () => {
      this.relaunch()
    })

    this.on('application:quit', () => {
      this.quit()
    })

    this.on('application:open-at-login', (openAtLogin) => {
      if (is.linux()) {
        return
      }

      if (openAtLogin) {
        this.autoLaunchManager.enable()
      } else {
        this.autoLaunchManager.disable()
      }
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
      this.sendCommandToAll('application:update-theme', theme)
    })

    this.on('application:change-locale', (locale) => {
      this.localeManager.changeLanguageByLocale(locale)
        .then(() => {
          this.trayManager.setup(locale)
          this.menuManager.handleLocaleChange(locale)
        })
    })

    this.on('application:toggle-dock', (visible) => {
      if (visible) {
        this.dockManager.show()
      } else {
        this.dockManager.hide()
        // Hiding the dock icon will trigger the entire app to hide.
        this.show()
      }
    })

    this.on('application:auto-hide-window', (hide) => {
      if (hide) {
        this.windowManager.handleWindowBlur()
      } else {
        this.windowManager.unbindWindowBlur()
      }
    })

    this.on('application:change-menu-states', (visibleStates, enabledStates, checkedStates) => {
      this.menuManager.updateMenuStates(visibleStates, enabledStates, checkedStates)
      this.trayManager.updateMenuStates(visibleStates, enabledStates, checkedStates)
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
      }).then(({ canceled, filePaths }) => {
        if (canceled || filePaths.length === 0) {
          return
        }

        const [filePath] = filePaths
        this.handleFile(filePath)
      })
    })

    this.on('application:clear-recent-tasks', () => {
      app.clearRecentDocuments()
    })

    this.on('application:setup-protocols-client', (protocols) => {
      if (is.dev() || is.mas()) {
        return
      }
      logger.info('[Motrix] setup protocols client:', protocols)
      this.protocolManager.setup(protocols)
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

  handleConfigChange (configName) {
    this.sendCommandToAll('application:update-preference-config', configName)
  }

  handleEvents () {
    this.once('application:initialized', () => {
      this.autoSyncTracker()

      this.autoResumeTask()

      this.adjustMenu()
    })

    this.configManager.userConfig.onDidAnyChange(() => this.handleConfigChange('user'))
    this.configManager.systemConfig.onDidAnyChange(() => this.handleConfigChange('system'))

    this.on('download-status-change', (downloading) => {
      this.trayManager.updateTrayByStatus(downloading)
      if (downloading) {
        this.energyManager.startPowerSaveBlocker()
      } else {
        this.energyManager.stopPowerSaveBlocker()
      }
    })

    this.on('download-speed-change', (speed) => {
      this.dockManager.setBadge(speed)
    })

    this.on('task-download-complete', (task, path) => {
      this.dockManager.openDock(path)
    })
  }

  handleIpcMessages () {
    ipcMain.on('command', (event, command, ...args) => {
      logger.log('[Motrix] ipc receive command', command, ...args)
      this.emit(command, ...args)
    })

    ipcMain.on('event', (event, eventName, ...args) => {
      logger.log('[Motrix] ipc receive event', eventName, ...args)
      this.emit(eventName, ...args)
    })
  }
}
