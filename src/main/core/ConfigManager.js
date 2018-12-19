import { app } from 'electron'
import Store from 'electron-store'
import {
  getLogPath,
  getSessionPath,
  getUserDownloadsPath
} from '../utils/index'

export default class ConfigManager {
  constructor () {
    this.systemConfig = {}
    this.userConfig = {}

    this.init()
  }

  init () {
    this.initSystemConfig()
    this.initUserConfig()
  }

  initSystemConfig () {
    this.systemConfig = new Store({
      name: 'system',
      defaults: {
        dir: getUserDownloadsPath(),
        continue: true, // 断点续传
        pause: true,
        split: 32,
        'rpc-listen-port': 16800,
        'rpc-secret': '',
        'auto-file-renaming': true,
        'allow-overwrite': true,
        'max-concurrent-downloads': 5,
        'max-connection-per-server': 64,
        'min-split-size': '1M',
        'max-overall-download-limit': 0,
        'max-overall-upload-limit': 0,
        'max-download-limit': 0,
        'all-proxy': '',
        'user-agent': 'Transmission/2.94'
      }
    })
  }

  initUserConfig () {
    this.userConfig = new Store({
      name: 'user',
      defaults: {
        'resume-all-when-app-launched': false,
        'task-notification': true,
        'new-task-show-downloading': true,
        'auto-check-for-updates': false,
        'update-channel': 'latest',
        'use-proxy': false,
        'all-proxy-backup': '',
        'log-path': getLogPath(),
        'session-path': getSessionPath(),
        'locale': app.getLocale()
      }
    })
  }

  getSystemConfig (key, defaultValue) {
    if (typeof key === 'undefined' &&
        typeof defaultValue === 'undefined') {
      return this.systemConfig.store
    }

    return this.systemConfig.get(key, defaultValue)
  }

  getUserConfig (key, defaultValue) {
    if (typeof key === 'undefined' &&
        typeof defaultValue === 'undefined') {
      return this.userConfig.store
    }

    return this.userConfig.get(key, defaultValue)
  }

  setSystemConfig (...args) {
    this.systemConfig.set(...args)
  }

  setUserConfig (...args) {
    this.userConfig.set(...args)
  }

  reset () {
    this.systemConfig.clear()
    this.userConfig.clear()
  }
}
