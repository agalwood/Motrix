import { EventEmitter } from 'events'
import { app, shell, dialog, ipcMain } from 'electron'
import is from 'electron-is'
import logger from './core/Logger'
import ConfigManager from './core/ConfigManager'
import Engine from './core/Engine'
import UpdateManager from './core/UpdateManager'
import EnergyManager from './core/EnergyManager'
import ProtocolManager from './core/ProtocolManager'
import WindowManager from './ui/WindowManager'
import MenuManager from './ui/MenuManager'
import TouchBarManager from './ui/TouchBarManager'

export default class Application extends EventEmitter {
  constructor () {
    super()

    this.locale = app.getLocale()
    logger.log('this.locale', this.locale)

    this.configManager = new ConfigManager()

    this.engine = new Engine({
      systemConfig: this.configManager.getSystemConfig(),
      userConfig: this.configManager.getUserConfig()
    })
    this.startEngine()

    this.windowManager = new WindowManager()

    this.menuManager = new MenuManager()
    this.menuManager.setup(this.locale)

    this.touchBarManager = new TouchBarManager()

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
      dialog.showMessageBox({
        type: 'error',
        title: '系统错误',
        message: `应用启动失败：${err.message}`,
        buttons: ['知道了'],
        cancelId: 1
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
    this.touchBarManager.setup(page, win)
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
      this.windowManager.getWindows().forEach(window => {
        this.windowManager.sendCommandTo(window, command, ...args)
      })
    }
  }

  sendMessageToAll (channel, ...args) {
    this.windowManager.getWindows().forEach(window => {
      this.windowManager.sendMessageTo(window, channel, ...args)
    })
  }

  initProtocolManager () {
    if (is.mas()) {
      return
    }
    this.protocolManager = new ProtocolManager()
  }

  handleProtocol (event, url) {
    if (is.mas()) {
      return
    }
    this.protocolManager.handle(event, url)
    this.showPage('index')
  }

  initUpdaterManager () {
    if (is.mas()) {
      return
    }
    this.updateManager = new UpdateManager()
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

    this.on('application:show', (page = 'index') => {
      this.showPage(page)
    })

    this.on('application:reset', () => {
      this.configManager.reset()
      this.relaunch()
    })

    this.on('application:check-for-updates', () => {
      this.updateManager.check()
    })

    this.on('application:set-locale', (locale) => {
      this.menuManager.setup(locale)
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
  }
}
