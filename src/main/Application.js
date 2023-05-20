import { EventEmitter } from 'node:events'
import { readFile, unlink } from 'node:fs'
import { extname, basename } from 'node:path'
import { app, shell, dialog, ipcMain } from 'electron'
import is from 'electron-is'
import { isEmpty, isEqual } from 'lodash'

import {
  APP_RUN_MODE,
  AUTO_SYNC_TRACKER_INTERVAL,
  AUTO_CHECK_UPDATE_INTERVAL,
  PROXY_SCOPES
} from '@shared/constants'
import { checkIsNeedRun } from '@shared/utils'
import {
  convertTrackerDataToComma,
  fetchBtTrackerFromSource,
  reduceTrackerString
} from '@shared/utils/tracker'
import { showItemInFolder } from './utils'
import logger from './core/Logger'
import Context from './core/Context'
import ConfigManager from './core/ConfigManager'
import { setupLocaleManager } from './ui/Locale'
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

export default class Application extends EventEmitter {
  constructor () {
    super()
    this.isReady = false
    this.init()
  }

  init () {
    this.initContext()

    this.initConfigManager()

    this.setupLogger()

    this.initLocaleManager()

    this.setupApplicationMenu()

    this.initWindowManager()

    this.initUPnPManager()

    this.startEngine()

    this.initEngineClient()

    this.initThemeManager()

    this.initTrayManager()

    this.initTouchBarManager()

    this.initDockManager()

    this.initAutoLaunchManager()

    this.initEnergyManager()

    this.initProtocolManager()

    this.initUpdaterManager()

    this.handleCommands()

    this.handleEvents()

    this.handleIpcMessages()

    this.handleIpcInvokes()

    this.emit('application:initialized')
  }

  initContext () {
    this.context = new Context()
  }

  initConfigManager () {
    this.configListeners = {}
    this.configManager = new ConfigManager()
  }

  offConfigListeners () {
    try {
      Object.keys(this.configListeners).forEach((key) => {
        this.configListeners[key]()
      })
    } catch (e) {
      logger.warn('[Motrix] offConfigListeners===>', e)
    }
    this.configListeners = {}
  }

  setupLogger () {
    const { userConfig } = this.configManager
    const key = 'log-level'
    const logLevel = userConfig.get(key)
    logger.transports.file.level = logLevel

    this.configListeners[key] = userConfig.onDidChange(key, async (newValue, oldValue) => {
      logger.info(`[Motrix] detected ${key} value change event:`, newValue, oldValue)
      logger.transports.file.level = newValue
    })
  }

  initLocaleManager () {
    this.locale = this.configManager.getLocale()
    this.localeManager = setupLocaleManager(this.locale)
    this.i18n = this.localeManager.getI18n()
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
    logger.info('[Motrix] stopEngine===>')
    try {
      await this.engineClient.shutdown({ force: true })
      logger.info('[Motrix] stopEngine.setImmediate===>')
      setImmediate(() => {
        this.engine.stop()
      })
    } catch (err) {
      logger.warn('[Motrix] shutdown engine fail: ', err.message)
    } finally {
      // no finally
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

  initAutoLaunchManager () {
    this.autoLaunchManager = new AutoLaunchManager()
  }

  initEnergyManager () {
    this.energyManager = new EnergyManager()
  }

  initTrayManager () {
    this.trayManager = new TrayManager({
      theme: this.configManager.getUserConfig('tray-theme'),
      systemTheme: this.themeManager.getSystemTheme(),
      speedometer: this.configManager.getUserConfig('tray-speedometer'),
      runMode: this.configManager.getUserConfig('run-mode')
    })

    this.watchTraySpeedometerEnabledChange()

    this.trayManager.on('mouse-down', ({ focused }) => {
      this.sendCommandToAll('application:update-tray-focused', { focused })
    })

    this.trayManager.on('mouse-up', ({ focused }) => {
      this.sendCommandToAll('application:update-tray-focused', { focused })
    })

    this.trayManager.on('drop-files', (files = []) => {
      this.handleFile(files[0])
    })

    this.trayManager.on('drop-text', (text) => {
      this.handleProtocol(text)
    })
  }

  watchTraySpeedometerEnabledChange () {
    const { userConfig } = this.configManager
    const key = 'tray-speedometer'
    this.configListeners[key] = userConfig.onDidChange(key, async (newValue, oldValue) => {
      logger.info(`[Motrix] detected ${key} value change event:`, newValue, oldValue)
      this.trayManager.handleSpeedometerEnableChange(newValue)
    })
  }

  initDockManager () {
    this.dockManager = new DockManager({
      runMode: this.configManager.getUserConfig('run-mode')
    })
  }

  watchOpenAtLoginChange () {
    const { userConfig } = this.configManager
    const key = 'open-at-login'
    this.configListeners[key] = userConfig.onDidChange(key, async (newValue, oldValue) => {
      logger.info(`[Motrix] detected ${key} value change event:`, newValue, oldValue)
      if (is.linux()) {
        return
      }

      if (newValue) {
        this.autoLaunchManager.enable()
      } else {
        this.autoLaunchManager.disable()
      }
    })
  }

  watchProtocolsChange () {
    const { userConfig } = this.configManager
    const key = 'protocols'
    this.configListeners[key] = userConfig.onDidChange(key, async (newValue, oldValue) => {
      logger.info(`[Motrix] detected ${key} value change event:`, newValue, oldValue)

      if (!newValue || isEqual(newValue, oldValue)) {
        return
      }

      logger.info('[Motrix] setup protocols client:', newValue)
      this.protocolManager.setup(newValue)
    })
  }

  watchRunModeChange () {
    const { userConfig } = this.configManager
    const key = 'run-mode'
    this.configListeners[key] = userConfig.onDidChange(key, async (newValue, oldValue) => {
      logger.info(`[Motrix] detected ${key} value change event:`, newValue, oldValue)
      this.trayManager.handleRunModeChange(newValue)

      if (newValue !== APP_RUN_MODE.TRAY) {
        this.dockManager.show()
      } else {
        this.dockManager.hide()
        // Hiding the dock icon will trigger the entire app to hide.
        this.show()
      }
    })
  }

  watchProxyChange () {
    const { userConfig } = this.configManager
    const key = 'proxy'
    this.configListeners[key] = userConfig.onDidChange(key, async (newValue, oldValue) => {
      logger.info(`[Motrix] detected ${key} value change event:`, newValue, oldValue)
      this.updateManager.setupProxy(newValue)

      const { enable, server, bypass, scope = [] } = newValue
      const system = enable && server && scope.includes(PROXY_SCOPES.DOWNLOAD)
        ? {
          'all-proxy': server,
          'no-proxy': bypass
        }
        : {}
      this.configManager.setSystemConfig(system)
      this.engineClient.call('changeGlobalOption', system)
    })
  }

  watchLocaleChange () {
    const { userConfig } = this.configManager
    const key = 'locale'
    this.configListeners[key] = userConfig.onDidChange(key, async (newValue, oldValue) => {
      logger.info(`[Motrix] detected ${key} value change event:`, newValue, oldValue)
      this.localeManager.changeLanguageByLocale(newValue)
        .then(() => {
          this.menuManager.handleLocaleChange(newValue)
          this.trayManager.handleLocaleChange(newValue)
        })
      this.sendCommandToAll('application:update-locale', { locale: newValue })
    })
  }

  watchThemeChange () {
    const { userConfig } = this.configManager
    const key = 'theme'
    this.configListeners[key] = userConfig.onDidChange(key, async (newValue, oldValue) => {
      logger.info(`[Motrix] detected ${key} value change event:`, newValue, oldValue)
      this.themeManager.updateSystemTheme(newValue)
      this.sendCommandToAll('application:update-theme', { theme: newValue })
    })
  }

  watchShowProgressBarChange () {
    const { userConfig } = this.configManager
    const key = 'show-progress-bar'
    this.configListeners[key] = userConfig.onDidChange(key, async (newValue, oldValue) => {
      logger.info(`[Motrix] detected ${key} value change event:`, newValue, oldValue)

      if (newValue) {
        this.bindProgressChange()
      } else {
        this.unbindProgressChange()
      }
    })
  }

  initUPnPManager () {
    this.upnp = new UPnPManager()

    this.watchUPnPEnabledChange()

    this.watchUPnPPortsChange()

    const enabled = this.configManager.getUserConfig('enable-upnp')
    if (!enabled) {
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
      logger.warn('[Motrix] start UPnP mapping fail', e.message)
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

  watchUPnPPortsChange () {
    const { systemConfig } = this.configManager
    const watchKeys = ['listen-port', 'dht-listen-port']

    watchKeys.forEach((key) => {
      this.configListeners[key] = systemConfig.onDidChange(key, async (newValue, oldValue) => {
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

  watchUPnPEnabledChange () {
    const { userConfig } = this.configManager
    const key = 'enable-upnp'
    this.configListeners[key] = userConfig.onDidChange(key, async (newValue, oldValue) => {
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

  syncTrackers (source, proxy) {
    if (isEmpty(source)) {
      return
    }

    setTimeout(() => {
      fetchBtTrackerFromSource(source, proxy).then((data) => {
        logger.warn('[Motrix] auto sync tracker data:', data)
        if (!data || data.length === 0) {
          return
        }

        let tracker = convertTrackerDataToComma(data)
        tracker = reduceTrackerString(tracker)
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

  autoSyncTrackers () {
    const enable = this.configManager.getUserConfig('auto-sync-tracker')
    const lastTime = this.configManager.getUserConfig('last-sync-tracker-time')
    const result = checkIsNeedRun(enable, lastTime, AUTO_SYNC_TRACKER_INTERVAL)
    logger.info('[Motrix] auto sync tracker checkIsNeedRun:', result)
    if (!result) {
      return
    }

    const source = this.configManager.getUserConfig('tracker-source')
    const proxy = this.configManager.getUserConfig('proxy', { enable: false })

    this.syncTrackers(source, proxy)
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
      if (mode === APP_RUN_MODE.TRAY) {
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

  stop () {
    try {
      const promises = [
        this.stopEngine(),
        this.shutdownUPnPManager(),
        this.energyManager.stopPowerSaveBlocker(),
        this.trayManager.destroy()
      ]

      return promises
    } catch (err) {
      logger.warn('[Motrix] stop error: ', err.message)
    }
  }

  async stopAllSettled () {
    await Promise.allSettled(this.stop())
  }

  async quit () {
    await this.stopAllSettled()
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
      this.trayManager.handleSystemThemeChange(theme)
      this.sendCommandToAll('application:update-system-theme', { theme })
    })
  }

  initTouchBarManager () {
    if (!is.macOS()) {
      return
    }

    this.touchBarManager = new TouchBarManager()
  }

  initProtocolManager () {
    const protocols = this.configManager.getUserConfig('protocols', {})
    this.protocolManager = new ProtocolManager({
      protocols
    })
  }

  handleProtocol (url) {
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

    const name = basename(filePath)
    readFile(filePath, (err, data) => {
      if (err) {
        logger.warn(`[Motrix] read file error: ${filePath}`, err.message)
        return
      }
      const dataURL = Buffer.from(data).toString('base64')
      this.sendCommandToAll('application:new-bt-task-with-file', {
        name,
        dataURL
      })
    })
  }

  initUpdaterManager () {
    if (is.mas()) {
      return
    }

    const enabled = this.configManager.getUserConfig('auto-check-update')
    const proxy = this.configManager.getSystemConfig('all-proxy')
    const lastTime = this.configManager.getUserConfig('last-check-update-time')
    const autoCheck = checkIsNeedRun(enabled, lastTime, AUTO_CHECK_UPDATE_INTERVAL)
    this.updateManager = new UpdateManager({
      autoCheck,
      proxy
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
      win.setProgressBar(1)
    })

    this.updateManager.on('update-cancelled', (event) => {
      this.menuManager.updateMenuItemEnabledState('app.check-for-updates', true)
      this.trayManager.updateMenuItemEnabledState('app.check-for-updates', true)
      const win = this.windowManager.getWindow('index')
      win.setProgressBar(-1)
    })

    this.updateManager.on('will-updated', async (event) => {
      this.windowManager.setWillQuit(true)
      await this.stopAllSettled()
    })

    this.updateManager.on('update-error', (event) => {
      this.menuManager.updateMenuItemEnabledState('app.check-for-updates', true)
      this.trayManager.updateMenuItemEnabledState('app.check-for-updates', true)
    })
  }

  async relaunch () {
    await this.stopAllSettled()
    app.relaunch()
    app.exit()
  }

  async resetSession () {
    await this.stopEngine()

    app.clearRecentDocuments()

    const sessionPath = this.context.get('session-path')
    setTimeout(() => {
      unlink(sessionPath, (err) => {
        logger.info('[Motrix] Removed the download seesion file:', err)
      })

      this.engine.start()
    }, 3000)
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

    this.on('application:update-tray', (tray) => {
      this.trayManager.updateTrayByImage(tray)
    })

    this.on('application:relaunch', () => {
      this.relaunch()
    })

    this.on('application:quit', () => {
      this.quit()
    })

    this.on('application:show', ({ page }) => {
      this.show(page)
    })

    this.on('application:hide', ({ page }) => {
      this.hide(page)
    })

    this.on('application:reset-session', () => this.resetSession())

    this.on('application:factory-reset', () => {
      this.offConfigListeners()
      this.configManager.reset()
      this.relaunch()
    })

    this.on('application:check-for-updates', () => {
      this.updateManager.check()
    })

    this.on('application:change-theme', (theme) => {
      this.themeManager.updateSystemTheme(theme)
      this.sendCommandToAll('application:update-theme', { theme })
    })

    this.on('application:change-locale', (locale) => {
      this.localeManager.changeLanguageByLocale(locale)
        .then(() => {
          this.menuManager.handleLocaleChange(locale)
          this.trayManager.handleLocaleChange(locale)
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
      if (is.dev() || is.mas() || !protocols) {
        return
      }
      logger.info('[Motrix] setup protocols client:', protocols)
      this.protocolManager.setup(protocols)
    })

    this.on('application:open-external', (url) => {
      this.openExternal(url)
    })

    this.on('application:reveal-in-folder', (data) => {
      const { gid, path } = data
      logger.info('[Motrix] application:reveal-in-folder===>', path)
      if (path) {
        showItemInFolder(path)
      }
      if (gid) {
        this.sendCommandToAll('application:show-task-detail', { gid })
      }
    })

    this.on('help:official-website', () => {
      const url = 'https://motrix.app/'
      this.openExternal(url)
    })

    this.on('help:manual', () => {
      const url = 'https://motrix.app/manual'
      this.openExternal(url)
    })

    this.on('help:release-notes', () => {
      const url = 'https://motrix.app/release'
      this.openExternal(url)
    })

    this.on('help:report-problem', () => {
      const url = 'https://motrix.app/report'
      this.openExternal(url)
    })
  }

  openExternal (url) {
    if (!url) {
      return
    }

    shell.openExternal(url)
  }

  handleConfigChange (configName) {
    this.sendCommandToAll('application:update-preference-config', { configName })
  }

  handleEvents () {
    this.once('application:initialized', () => {
      this.autoSyncTrackers()

      this.autoResumeTask()

      this.adjustMenu()
    })

    this.configManager.userConfig.onDidAnyChange(() => this.handleConfigChange('user'))
    this.configManager.systemConfig.onDidAnyChange(() => this.handleConfigChange('system'))

    this.watchOpenAtLoginChange()
    this.watchProtocolsChange()
    this.watchRunModeChange()
    this.watchShowProgressBarChange()
    this.watchProxyChange()
    this.watchLocaleChange()
    this.watchThemeChange()

    this.on('download-status-change', (downloading) => {
      this.trayManager.handleDownloadStatusChange(downloading)
      if (downloading) {
        this.energyManager.startPowerSaveBlocker()
      } else {
        this.energyManager.stopPowerSaveBlocker()
      }
    })

    this.on('speed-change', (speed) => {
      this.dockManager.handleSpeedChange(speed)
      this.trayManager.handleSpeedChange(speed)
    })

    this.on('task-download-complete', (task, path) => {
      this.dockManager.openDock(path)

      if (is.linux()) {
        return
      }
      app.addRecentDocument(path)
    })

    if (this.configManager.userConfig.get('show-progress-bar')) {
      this.bindProgressChange()
    }
  }

  handleProgressChange (progress) {
    if (this.updateManager.isChecking) {
      return
    }
    if (!is.windows() && progress === 2) {
      progress = 0
    }
    this.windowManager.getWindow('index').setProgressBar(progress)
  }

  bindProgressChange () {
    if (this.listeners('progress-change').length > 0) {
      return
    }

    this.on('progress-change', this.handleProgressChange)
  }

  unbindProgressChange () {
    if (this.listeners('progress-change').length === 0) {
      return
    }

    this.off('progress-change', this.handleProgressChange)
    this.windowManager.getWindow('index').setProgressBar(-1)
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

  handleIpcInvokes () {
    ipcMain.handle('get-app-config', async () => {
      const systemConfig = this.configManager.getSystemConfig()
      const userConfig = this.configManager.getUserConfig()
      const context = this.context.get()

      const result = {
        ...systemConfig,
        ...userConfig,
        ...context
      }
      return result
    })
  }
}
