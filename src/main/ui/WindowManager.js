import { join } from 'path'
import { EventEmitter } from 'events'
import { app, shell, screen, BrowserWindow } from 'electron'
import is from 'electron-is'
import pageConfig from '../configs/page'
import logger from '../core/Logger'
import { debounce } from 'lodash'

const defaultBrowserOptions = {
  titleBarStyle: 'hiddenInset',
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

  getPageBounds (page) {
    const enabled = this.userConfig['keep-window-state']
    const windowStateMap = this.userConfig['window-state'] || {}
    let result = null
    if (enabled) {
      result = windowStateMap[page]
    }

    return result
  }

  openWindow (page, options = {}) {
    const pageOptions = this.getPageOptions(page)
    const { hidden } = options

    let window = this.windows[page] || null
    if (window) {
      window.show()
      window.focus()
      return window
    }

    window = new BrowserWindow({
      ...defaultBrowserOptions,
      ...pageOptions.attrs
    })

    const bounds = this.getPageBounds(page)
    console.log('bounds ====>', bounds)
    if (bounds) {
      window.setBounds(bounds)
    }

    window.webContents.on('new-window', (e, url) => {
      e.preventDefault()
      shell.openExternal(url)
    })

    if (pageOptions.url) {
      window.loadURL(pageOptions.url)
    }

    window.once('ready-to-show', () => {
      if (!hidden) {
        window.show()
      }
    })

    this.handleWindowState(page, window)

    this.handleWindowClose(pageOptions, page, window)

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
    win.removeListener('closed')
    win.removeListener('move')
    win.removeListener('resize')
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

  handleWindowState (page, window) {
    window.on('resize', debounce(() => {
      const bounds = window.getBounds()
      this.emit('window-resized', { page, bounds })
    }, 500))

    window.on('move', debounce(() => {
      const bounds = window.getBounds()
      this.emit('window-moved', { page, bounds })
    }, 500))
  }

  handleWindowClose (pageOptions, page, window) {
    window.on('close', (event) => {
      if (pageOptions.bindCloseToHide && !this.willQuit) {
        event.preventDefault()
        window.hide()
      }
      const bounds = window.getBounds()
      this.emit('window-closed', { page, bounds })
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
    logger.info('[Motrix] sendCommandTo===>', command, ...args)
    window.webContents.send('command', command, ...args)
  }

  sendMessageTo (window, channel, ...args) {
    if (!window) {
      return
    }
    window.webContents.send(channel, ...args)
  }
}
