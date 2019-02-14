import { app } from 'electron'
import is from 'electron-is'
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
        // 断点续传
        continue: true,
        pause: true,
        split: 16,
        'rpc-listen-port': 16800,
        'rpc-secret': '',
        'auto-file-renaming': true,
        'allow-overwrite': true,
        'max-concurrent-downloads': 5,
        // macOS 版本修改过源码自己编译的，Linux 和 Windows 版本 暂未处理
        'max-connection-per-server': is.macOS() ? 64 : 16,
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
        'hide-app-menu': is.windows() || is.linux(),
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

  getLocale () {
    return this.getUserConfig('locale') || app.getLocale()
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
