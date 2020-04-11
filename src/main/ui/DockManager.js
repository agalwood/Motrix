import is from 'electron-is'
import { EventEmitter } from 'events'
import { app } from 'electron'
import {
  APP_RUN_MODE
} from '@shared/constants'

const isMac = is.macOS()

export default class DockManager extends EventEmitter {
  constructor (options) {
    super()
    this.options = options
    const { runMode } = this.options
    if (runMode !== APP_RUN_MODE.STANDARD) {
      this.hide()
    }
  }

  show = isMac ? () => {
    return app.dock.show()
  } : () => {}

  hide = isMac ? () => {
    app.dock.hide()
  } : () => {}

  setBadge = isMac ? (text) => {
    app.dock.setBadge(text)
  } : (text) => {}

  openDock = isMac ? (path) => {
    app.dock.downloadFinished(path)
  } : (path) => {}
}
