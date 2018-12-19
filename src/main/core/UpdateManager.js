import { EventEmitter } from 'events'
import { dialog } from 'electron'
import is from 'electron-is'
import { autoUpdater } from 'electron-updater'
import { resolve } from 'path'
import logger from './Logger'

if (is.dev()) {
  autoUpdater.updateConfigPath = resolve(__dirname, '../../../app-update.yml')
}

export default class UpdateManager extends EventEmitter {
  constructor (options = {}) {
    super()
    this.options = options

    this.updater = autoUpdater
    this.updater.logger = logger
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
    this.updater.on('download-downloaded', this.updateDownloaded.bind(this))
    this.updater.on('error', this.updateError.bind(this))
  }

  check () {
    this.updater.checkForUpdates()
  }

  checkingForUpdate () {
    this.emit('checking')
  }

  updateAvailable (event, info) {
    this.emit('update-available', info)
    dialog.showMessageBox({
      type: 'info',
      title: '发现新版本',
      message: '发现新版本，是否现在更新？',
      buttons: ['是', '否'],
      cancelId: 1
    }, (buttonIndex) => {
      if (buttonIndex === 0) {
        this.updater.downloadUpdate()
      }
    })
  }

  updateNotAvailable (event, info) {
    this.emit('update-not-available', info)
    dialog.showMessageBox({
      title: '没有更新的版本',
      message: '您目前使用的已是最新版本'
    })
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
    dialog.showMessageBox({
      title: '安装更新',
      message: '更新下载完成，应用程序将退出并开始更新...'
    }, () => {
      this.emit('will-updated')
      setImmediate(() => {
        this.updater.quitAndInstall()
      })
    })
  }

  updateError (event, error) {
    this.emit('update-error', error)
    const msg = error == null ? '未知错误' : (error.stack || error).toString()
    dialog.showErrorBox('错误: ', msg)
  }
}
