import { EventEmitter } from 'events'
import { app } from 'electron'
import is from 'electron-is'

import ExceptionHandler from './core/ExceptionHandler'
import logger from './core/Logger'
import Application from './Application'
import { parseArgv } from './utils'

const EMPTY_STRING = ''

export default class Launcher extends EventEmitter {
  constructor () {
    super()
    this.url = EMPTY_STRING
    this.file = EMPTY_STRING

    this.makeSingleInstance(() => {
      this.init()
    })
  }

  makeSingleInstance (callback) {
    // Mac App Store Sandboxed App not support requestSingleInstanceLock
    if (is.mas()) {
      callback()
      return
    }

    const gotSingleLock = app.requestSingleInstanceLock()

    if (!gotSingleLock) {
      app.quit()
    } else {
      app.on('second-instance', (event, argv, workingDirectory) => {
        logger.warn('second-instance argv===>', argv)
        logger.warn('second-instance workingDirectory===>', workingDirectory)
        global.application.showPage('index')
        if (!is.macOS() && argv.length > 1) { // Windows, Linux
          this.file = parseArgv(argv)
          this.sendFileToApplication()
        }
      })

      callback()
    }
  }

  init () {
    this.exceptionHandler = new ExceptionHandler()

    this.handleAppEvents()
  }

  handleAppEvents () {
    this.handleOpenUrl()
    this.handleOpenFile()

    this.handelAppReady()
    this.handleAppWillQuit()
  }

  /**
   * handleOpenUrl
   * "name": "Motrix Protocol",
   * "schemes": ["mo", "motrix"]
   */
  handleOpenUrl () {
    if (is.mas()) {
      return
    }
    app.on('open-url', (event, url) => {
      logger.info(`[Motrix] open-url path: ${url}`)
      event.preventDefault()
      this.url = url
      if (this.url && global.application && global.application.isReady) {
        global.application.handleProtocol(this.url)
        this.url = EMPTY_STRING
      }
    })
  }

  /**
   * handleOpenFile [WIP]
   * handle open torrent file
   */
  handleOpenFile () {
    // macOS
    if (is.macOS()) {
      app.on('open-file', (event, path) => {
        logger.info(`[Motrix] open-file path: ${path}`)
        event.preventDefault()
        this.file = path
        this.sendFileToApplication()
      })
    } else if (process.argv.length > 1) { // Windows, Linux
      logger.warn('handleOpenFile argv===>', process.argv)
      this.file = parseArgv(process.argv)
      this.sendFileToApplication()
    }
  }

  sendFileToApplication () {
    if (this.file && global.application && global.application.isReady) {
      global.application.handleFile(this.file)
      this.file = EMPTY_STRING
    }
  }

  handelAppReady () {
    app.on('ready', () => {
      global.application = new Application()

      global.application.start('index')

      global.application.on('ready', () => {
        if (this.url) {
          global.application.handleProtocol(this.url)
        }

        if (this.file) {
          global.application.handleFile(this.file)
        }
      })
    })

    app.on('activate', () => {
      if (global.application) {
        logger.info('[Motrix] activate')
        global.application.showPage('index')
      }
    })
  }

  handleAppWillQuit () {
    app.on('will-quit', () => {
      logger.info('[Motrix] will-quit')
      if (global.application) {
        global.application.stop()
      }
    })
  }
}
