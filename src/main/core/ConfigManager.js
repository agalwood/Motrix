import { app } from 'electron'
import is from 'electron-is'
import Store from 'electron-store'
import {
  getDhtPath,
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

  /**
   * Some aria2 conf
   * https://aria2.github.io/manual/en/html/aria2c.html
   */
  initSystemConfig () {
    this.systemConfig = new Store({
      name: 'system',
      defaults: {
        'all-proxy': '',
        'allow-overwrite': true,
        'auto-file-renaming': true,
        'continue': true,
        'dht-file-path': getDhtPath(4),
        'dht-file-path6': getDhtPath(6),
        'dir': getUserDownloadsPath(),
        'max-concurrent-downloads': 5,
        'max-connection-per-server': is.macOS() ? 64 : 16,
        'max-download-limit': 0,
        'max-overall-download-limit': 0,
        'max-overall-upload-limit': '128K',
        'min-split-size': '1M',
        'pause': true,
        'rpc-listen-port': 16800,
        'rpc-secret': '',
        'split': 16,
        'user-agent': 'Transmission/2.94'
      }
    })
  }

  initUserConfig () {
    this.userConfig = new Store({
      name: 'user',
      // Schema need electron-store upgrade to 3.x.x,
      // but it will cause the application build to fail.
      // schema: {
      //   theme: {
      //     type: 'string',
      //     enum: ['auto', 'light', 'dark']
      //   }
      // },
      defaults: {
        'all-proxy-backup': '',
        'auto-check-update': false,
        'hide-app-menu': is.windows() || is.linux(),
        'last-check-update-time': 0,
        'locale': app.getLocale(),
        'log-path': getLogPath(),
        'new-task-show-downloading': true,
        'resume-all-when-app-launched': false,
        'session-path': getSessionPath(),
        'task-notification': true,
        'theme': 'auto',
        'update-channel': 'latest',
        'use-proxy': false
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
