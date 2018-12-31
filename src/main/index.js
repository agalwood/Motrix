import { app } from 'electron'
import is from 'electron-is'

import logger from './core/Logger'
import {
  isRunningInDmg,
  moveAppToApplicationsFolder
} from './utils/index'
import Application from './Application'

if (process.env.NODE_ENV !== 'development') {
  global.__static = require('path').join(__dirname, '/static').replace(/\\/g, '\\\\')
}

function _init () {
  let openURL = null
  if (!is.mas()) {
    app.on('open-url', (event, url) => {
      logger.info(`You arrived from: ${url}`)
      event.preventDefault()
      openURL = url
      if (global.application) {
        global.application.handleProtocol(openURL)
      }
    })
  }

  app.on('ready', () => {
    global.application = new Application()
    global.application.start('index')

    if (openURL) {
      global.application.handleProtocol(openURL)
    }
  })

  app.on('will-quit', () => {
    logger.warn('will-quit')
    global.application && global.application.stop()
  })

  // Quit when all windows are closed.
  app.on('window-all-closed', function () {
    // On OS X it's common NOT to close app even if all windows are closed
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('activate', () => {
    global.application.showPage('index')
  })
}

function init () {
  if (isRunningInDmg()) {
    moveAppToApplicationsFolder()
    return
  }
  _init()
}

// Mac App Store Sandboxed App Not support requestSingleInstanceLock
if (is.mas()) {
  init()
} else {
  const gotSingleLock = app.requestSingleInstanceLock()

  if (!gotSingleLock) {
    app.quit()
  } else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
      global.application.showPage('index')
    })

    init()
  }
}
