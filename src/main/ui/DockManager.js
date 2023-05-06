import is from 'electron-is'
import { EventEmitter } from 'node:events'
import { app } from 'electron'

import { bytesToSize } from '@shared/utils'

import {
  APP_RUN_MODE
} from '@shared/constants'

const enabled = is.macOS()

export default class DockManager extends EventEmitter {
  constructor (options) {
    super()
    this.options = options
    const { runMode } = this.options
    if (runMode === APP_RUN_MODE.TRAY) {
      this.hide()
    }
  }

  show = enabled
    ? () => {
      if (app.dock.isVisible()) {
        return
      }

      return app.dock.show()
    }
    : () => {}

  hide = enabled
    ? () => {
      if (!app.dock.isVisible()) {
        return
      }

      app.dock.hide()
    }
    : () => {}

  // macOS setBadge not working
  // @see https://github.com/electron/electron/issues/25745#issuecomment-702826143
  setBadge = enabled
    ? (text) => {
      app.dock.setBadge(text)
    }
    : (text) => {}

  handleSpeedChange = enabled
    ? (speed) => {
      const { downloadSpeed } = speed
      const text = downloadSpeed > 0 ? `${bytesToSize(downloadSpeed)}/s` : ''
      this.setBadge(text)
    }
    : (text) => {}

  openDock = enabled
    ? (path) => {
      app.dock.downloadFinished(path)
    }
    : (path) => {}
}
