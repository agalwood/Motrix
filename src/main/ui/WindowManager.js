import { join } from 'path'
import { EventEmitter } from 'events'
import { app, shell, screen, BrowserWindow } from 'electron'
import is from 'electron-is'
import pageConfig from '../configs/page'
import logger from '../core/Logger'

const defaultBrowserOptions = {
  titleBarStyle: 'hiddenInset',
  useContentSize: true,
  show: false,
  width: 1024,
  height: 768,
  webPreferences: {
    nodeIntegration: true
  }
}

export default class WindowManager extends EventEmitter {
  constructor (options = {}) {
    super()
    this.userConfig = options.userConfig || {}

    this.windows = {}

    this.willQuit = false

    this.handleBeforeQuit()

    this.handleAllWindowClosed()
  }

  setWillQuit (flag) {
    this.willQuit = flag
  }

  getPageOptions (page) {
    const result = pageConfig[page] || {}
    const hideAppMenu = this.userConfig['hide-app-menu']
    if (hideAppMenu) {
      result.attrs.frame = false
    }

    // Optimized for small screen users
    const { width, height } = screen.getPrimaryDisplay().workAreaSize
    const widthScale = width >= 1280 ? 1 : 0.875
    const heightScale = height >= 800 ? 1 : 0.875
    result.attrs.width *= widthScale
    result.attrs.height *= heightScale

    // fix AppImage Dock Icon Missing
    // https://github.com/AppImage/AppImageKit/wiki/Bundling-Electron-apps
    if (is.linux()) {
      result.attrs.icon = join(__static, './512x512.png')
    }

    return result
  }

  openWindow (page) {
    const options = this.getPageOptions(page)

    let window = this.windows[page] || null
    if (window) {
      window.restore()
      window.focus()
      return window
    }

    window = new BrowserWindow({
      ...defaultBrowserOptions,
      ...options.attrs
    })

    window.webContents.on('new-window', (e, url) => {
      e.preventDefault()
      shell.openExternal(url)
    })

    if (options.url) {
      window.loadURL(options.url)
    }

    window.once('ready-to-show', () => {
      window.show()
    })

    if (options.bindCloseToHide) {
      this.bindCloseToHide(page, window)
    }

    this.bindAfterClosed(page, window)

    this.addWindow(page, window)
    return window
  }

  getWindow (page) {
    return this.windows[page]
  }

  getWindows () {
    return this.windows || {}
  }

  getWindowList () {
    return Object.values(this.getWindows())
  }

  addWindow (page, window) {
    this.windows[page] = window
  }

  destroyWindow (page) {
    const win = this.getWindow(page)
    this.removeWindow(page)
    win.destroy()
  }

  removeWindow (page) {
    this.windows[page] = null
  }

  bindAfterClosed (page, window) {
    window.on('closed', (event) => {
      this.removeWindow(page)
    })
  }

  bindCloseToHide (page, window) {
    window.on('close', (event) => {
      if (!this.willQuit) {
        event.preventDefault()
        window.hide()
      }
    })
  }

  showWindow (page) {
    const window = this.getWindow(page)
    if (!window) {
      return
    }
    window.show()
  }

  hideWindow (page) {
    const window = this.getWindow(page)
    if (!window) {
      return
    }
    window.hide()
  }

  hideAllWindow () {
    this.getWindowList().forEach((window) => {
      window.hide()
    })
  }

  toggleWindow (page) {
    const window = this.getWindow(page)
    if (!window) {
      return
    }
    if (window.isVisible()) {
      window.hide()
    } else {
      window.show()
    }
  }

  getFocusedWindow () {
    return BrowserWindow.getFocusedWindow()
  }

  handleBeforeQuit () {
    app.on('before-quit', () => {
      this.setWillQuit(true)
    })
  }

  handleAllWindowClosed () {
    app.on('window-all-closed', (event) => {
      event.preventDefault()
    })
  }

  sendCommandTo (window, command, ...args) {
    if (!window) {
      return
    }
    logger.info('[Motrix] sendCommandTo===>', window, command, ...args)
    window.webContents.send('command', command, ...args)
  }

  sendMessageTo (window, channel, ...args) {
    if (!window) {
      return
    }
    window.webContents.send(channel, ...args)
  }
}
