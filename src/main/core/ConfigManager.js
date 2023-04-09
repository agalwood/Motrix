import { app } from 'electron'
import is from 'electron-is'
import Store from 'electron-store'

import {
  getDhtPath,
  getLogPath,
  getSessionPath,
  getUserDownloadsPath,
  getMaxConnectionPerServer
} from '../utils/index'
import {
  APP_RUN_MODE,
  APP_THEME,
  EMPTY_STRING,
  IP_VERSION,
  LOGIN_SETTING_OPTIONS,
  NGOSANG_TRACKERS_BEST_IP_URL_CDN,
  NGOSANG_TRACKERS_BEST_URL_CDN
} from '@shared/constants'
import { CHROME_UA } from '@shared/ua'
import { separateConfig } from '@shared/utils'
import { reduceTrackerString } from '@shared/utils/tracker'

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
      /* eslint-disable quote-props */
      defaults: {
        'all-proxy': EMPTY_STRING,
        'allow-overwrite': false,
        'auto-file-renaming': true,
        'bt-force-encryption': false,
        'bt-exclude-tracker': EMPTY_STRING,
        'bt-load-saved-metadata': true,
        'bt-save-metadata': true,
        'bt-tracker': EMPTY_STRING,
        'continue': true,
        'dht-file-path': getDhtPath(IP_VERSION.V4),
        'dht-file-path6': getDhtPath(IP_VERSION.V6),
        'dht-listen-port': 26701,
        'dir': getUserDownloadsPath(),
        'enable-dht6': true,
        'follow-metalink': true,
        'follow-torrent': true,
        'listen-port': 21301,
        'max-concurrent-downloads': 5,
        'max-connection-per-server': getMaxConnectionPerServer(),
        'max-download-limit': 0,
        'max-overall-download-limit': 0,
        'max-overall-upload-limit': '1M',
        'no-proxy': EMPTY_STRING,
        'pause': true,
        'pause-metadata': false,
        'rpc-listen-port': 16800,
        'rpc-secret': EMPTY_STRING,
        'seed-ratio': 1,
        'seed-time': 60,
        'split': getMaxConnectionPerServer(),
        'user-agent': CHROME_UA
      }
      /* eslint-enable quote-props */
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
      /* eslint-disable quote-props */
      defaults: {
        'all-proxy-backup': EMPTY_STRING,
        'auto-check-update': is.macOS(),
        'auto-hide-window': false,
        'auto-sync-tracker': true,
        'enable-upnp': true,
        'engine-max-connection-per-server': getMaxConnectionPerServer(),
        'hide-app-menu': is.windows() || is.linux(),
        'keep-seeding': false,
        'keep-window-state': false,
        'last-check-update-time': 0,
        'last-sync-tracker-time': 0,
        'locale': app.getLocale(),
        'log-path': getLogPath(),
        'new-task-show-downloading': true,
        'no-confirm-before-delete-task': false,
        'open-at-login': false,
        'protocols': { 'magnet': true, 'thunder': false },
        'resume-all-when-app-launched': false,
        'run-mode': APP_RUN_MODE.STANDARD,
        'session-path': getSessionPath(),
        'task-notification': true,
        'theme': APP_THEME.AUTO,
        'tracker-source': [
          NGOSANG_TRACKERS_BEST_IP_URL_CDN,
          NGOSANG_TRACKERS_BEST_URL_CDN
        ],
        'tray-theme': APP_THEME.AUTO,
        'tray-speedometer': is.macOS(),
        'update-channel': 'latest',
        'use-proxy': false,
        'window-state': {}
      }
      /* eslint-enable quote-props */
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

    // Fix spawn ENAMETOOLONG on Windows
    const tracker = reduceTrackerString(this.systemConfig.get('bt-tracker'))
    this.setSystemConfig('bt-tracker', tracker)
  }

  fixUserConfig () {
    // Fix the value of open-at-login when the user delete
    // the Motrix self-starting item through startup management.
    const openAtLogin = app.getLoginItemSettings(LOGIN_SETTING_OPTIONS).openAtLogin
    if (this.getUserConfig('open-at-login') !== openAtLogin) {
      this.setUserConfig('open-at-login', openAtLogin)
    }

    if (this.getUserConfig('tracker-source').length === 0) {
      this.setUserConfig('tracker-source', [
        NGOSANG_TRACKERS_BEST_IP_URL_CDN,
        NGOSANG_TRACKERS_BEST_URL_CDN
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
