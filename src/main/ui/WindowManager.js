import { EventEmitter } from 'events'
import { app, shell, BrowserWindow } from 'electron'
import pageConfig from '../configs/page'

const defaultBrowserOptions = {
  titleBarStyle: 'hiddenInset',
  useContentSize: true,
  show: false,
  width: 1024,
  height: 768
}

export default class WindowManager extends EventEmitter {
  constructor (options = {}) {
    super()
    this.options = options

    this.windows = {}

    this.willQuit = false

    app.on('before-quit', () => {
      this.setWillQuit(true)
    })
  }

  setWillQuit (flag) {
    this.willQuit = flag
  }

  openWindow (page) {
    const options = pageConfig[page] || {}
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

    if (options.bindCloseToHide && process.platform === 'darwin') {
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

  getFocusedWindow () {
    return BrowserWindow.getFocusedWindow()
  }

  sendCommandTo (window, command, ...args) {
    if (!window) {
      return
    }
    console.log('sendCommandTo====>', window, command, ...args)
    window.webContents.send('command', command, ...args)
  }

  sendMessageTo (window, channel, ...args) {
    if (!window) {
      return
    }
    window.webContents.send(channel, ...args)
  }
}
