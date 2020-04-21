import { EventEmitter } from 'events'
import { resolve } from 'path'
import { dialog } from 'electron'
import is from 'electron-is'
import { autoUpdater } from 'electron-updater'

import logger from './Logger'
import { getI18n } from '@/ui/Locale'

if (is.dev()) {
  autoUpdater.updateConfigPath = resolve(__dirname, '../../../app-update.yml')
}

export default class UpdateManager extends EventEmitter {
  constructor (options = {}) {
    super()
    this.options = options
    this.i18n = getI18n()

    this.updater = autoUpdater
    this.updater.autoDownload = false
    this.updater.logger = logger
    this.autoCheckData = {
      checkEnable: this.options.autoCheck,
      userCheck: false
    }
    this.init()
  }

  init () {
    // Event: error
    // Event: checking-for-update
    // Event: update-available
    // Event: update-not-available
    // Event: download-progress
    // Event: update-downloaded

    this.updater.on('checking-for-update', this.checkingForUpdate.bind(this))
    this.updater.on('update-available', this.updateAvailable.bind(this))
    this.updater.on('update-not-available', this.updateNotAvailable.bind(this))
    this.updater.on('download-progress', this.updateDownloadProgress.bind(this))
    this.updater.on('update-downloaded', this.updateDownloaded.bind(this))
    this.updater.on('error', this.updateError.bind(this))

    if (this.autoCheckData.checkEnable) {
      this.autoCheckData.userCheck = false
      this.updater.checkForUpdates()
    }
  }

  check () {
    this.autoCheckData.userCheck = true
    this.updater.checkForUpdates()
  }

  checkingForUpdate () {
    this.emit('checking')
  }

  updateAvailable (event, info) {
    this.emit('update-available', info)
    dialog.showMessageBox({
      type: 'info',
      title: this.i18n.t('app.check-for-updates-title'),
      message: this.i18n.t('app.update-available-message'),
      buttons: [this.i18n.t('app.yes'), this.i18n.t('app.no')],
      cancelId: 1
    }).then(({ response }) => {
      if (response === 0) {
        this.updater.downloadUpdate()
      }
    })
  }

  updateNotAvailable (event, info) {
    this.emit('update-not-available', info)
    if (this.autoCheckData.userCheck) {
      dialog.showMessageBox({
        title: this.i18n.t('app.check-for-updates-title'),
        message: this.i18n.t('app.update-not-available-message')
      })
    }
  }

  /**
   * autoUpdater:download-progress
   * @param {Object} event
   * progress,
   * bytesPerSecond,
   * percent,
   * total,
   * transferred
   */
  updateDownloadProgress (event) {
    this.emit('download-progress', event)
  }

  updateDownloaded (event, info) {
    this.emit('update-downloaded', info)
    this.updater.logger.log(`Update Downloaded: ${info}`)
    dialog.showMessageBox({
      title: this.i18n.t('app.check-for-updates-title'),
      message: this.i18n.t('app.update-downloaded-message')
    }).then(_ => {
      this.emit('will-updated')
      setImmediate(() => {
        this.updater.quitAndInstall()
      })
    })
  }

  updateError (event, error) {
    this.emit('update-error', error)
    const msg = (error == null)
      ? this.i18n.t('update-error-message')
      : (error.stack || error).toString()

    this.updater.logger.warn(`[Motrix] update-error: ${msg}`)
    dialog.showErrorBox(msg)
  }
}
