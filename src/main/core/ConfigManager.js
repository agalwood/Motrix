import { app } from 'electron'
import is from 'electron-is'
import Store from 'electron-store'
import tracker from '../configs/tracker'
import {
  getDhtPath,
  getLogPath,
  getSessionPath,
  getUserDownloadsPath
} from '../utils/index'
import {
  APP_THEME,
  EMPTY_STRING,
  APP_RUN_MODE,
  NGOSANG_TRACKERS_ALL_URL,
  NGOSANG_TRACKERS_ALL_IP_URL
} from '@shared/constants'
import { separateConfig } from '@shared/utils'

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
   *
   * Best bt trackers
   * @see https://github.com/ngosang/trackerslist
   *
   * @see https://github.com/XIU2/TrackersListCollection
   */
  initSystemConfig () {
    this.systemConfig = new Store({
      name: 'system',
      defaults: {
        'all-proxy': EMPTY_STRING,
        'allow-overwrite': true,
        'auto-file-renaming': true,
        'bt-tracker': tracker.join(','),
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
        'no-proxy': EMPTY_STRING,
        'pause': true,
        'rpc-listen-port': 16800,
        'rpc-secret': EMPTY_STRING,
        'seed-time': 60,
        'split': 16,
        'user-agent': 'Transmission/2.94'
      }
    })
    this.fixSystemConfig()
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
        'all-proxy-backup': EMPTY_STRING,
        'auto-check-update': is.macOS(),
        'auto-sync-tracker': true,
        'hide-app-menu': is.windows() || is.linux(),
        'last-check-update-time': 0,
        'last-sync-tracker-time': 0,
        'locale': app.getLocale(),
        'log-path': getLogPath(),
        'new-task-show-downloading': true,
        'open-at-login': false,
        'run-mode': APP_RUN_MODE.STANDARD,
        'protocols': { 'magnet': true, 'thunder': false },
        'resume-all-when-app-launched': false,
        'keep-window-state': false,
        'session-path': getSessionPath(),
        'task-notification': true,
        'theme': APP_THEME.AUTO,
        'auto-hide-window': false,
        'tracker-source': [
          NGOSANG_TRACKERS_ALL_IP_URL,
          NGOSANG_TRACKERS_ALL_URL
        ],
        'update-channel': 'latest',
        'use-proxy': false,
        'window-state': {}
      }
    })
    this.fixUserConfig()
  }

  fixSystemConfig () {
    // Remove aria2c unrecognized options
    const { others } = separateConfig(this.systemConfig.store)
    if (!others) {
      return
    }

    Object.keys(others).forEach(key => {
      this.systemConfig.delete(key)
    })
  }

  fixUserConfig () {
    // Fix the value of open-at-login when the user delete
    // the Motrix self-starting item through startup management.
    const openAtLogin = app.getLoginItemSettings().openAtLogin
    if (this.getUserConfig('open-at-login') !== openAtLogin) {
      this.setUserConfig('open-at-login', openAtLogin)
    }

    if (this.getUserConfig('tracker-source').length === 0) {
      this.setUserConfig('tracker-source', [
        NGOSANG_TRACKERS_ALL_IP_URL,
        NGOSANG_TRACKERS_ALL_URL
      ])
    }
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
