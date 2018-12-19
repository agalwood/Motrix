import { app } from 'electron'
import is from 'electron-is'

import logger from './core/Logger'
import Application from './Application'

if (process.env.NODE_ENV !== 'development') {
  global.__static = require('path').join(__dirname, '/static').replace(/\\/g, '\\\\')
}

function init () {
  app.on('ready', () => {
    global.application = new Application()

    global.application.start('index')
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

  if (is.mas()) {
    return
  }
  /**
   * May not working on MAS build
   * https://stackoverflow.com/questions/26601840/making-app-default-handler-on-osx-10-10-with-sandbox-enabled
   */
  app.on('open-url', (event, url) => {
    logger.info(`You arrived from: ${url}`)
    global.application.handleProtocol(event, url)
  })
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
