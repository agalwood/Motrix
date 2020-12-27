import is from 'electron-is'
import { EventEmitter } from 'events'
import { app } from 'electron'

import { bytesToSize } from '@shared/utils'

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

  show = isMac
    ? () => {
      if (app.dock.isVisible()) {
        return
      }

      return app.dock.show()
    }
    : () => {}

  hide = isMac
    ? () => {
      if (!app.dock.isVisible()) {
        return
      }

      app.dock.hide()
    }
    : () => {}

  setBadge = isMac
    ? (text) => {
      app.dock.setBadge(text)
    }
    : (text) => {}

  handleSpeedChange = isMac
    ? (speed) => {
      const { downloadSpeed } = speed
      const text = downloadSpeed > 0 ? `${bytesToSize(downloadSpeed)}/s` : ''
      this.setBadge(text)
    }
    : (text) => {}

  openDock = isMac
    ? (path) => {
      app.dock.downloadFinished(path)
    }
    : (path) => {}
}
