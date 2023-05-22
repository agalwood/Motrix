import { app } from 'electron'
import is from 'electron-is'
import Store from 'electron-store'

import {
  getConfigBasePath,
  getDhtPath,
  getMaxConnectionPerServer,
  getUserDownloadsPath
} from '../utils/index'
import {
  APP_RUN_MODE,
  APP_THEME,
  EMPTY_STRING,
  ENGINE_RPC_PORT,
  IP_VERSION,
  LOGIN_SETTING_OPTIONS,
  NGOSANG_TRACKERS_BEST_IP_URL_CDN,
  NGOSANG_TRACKERS_BEST_URL_CDN,
  PROXY_SCOPES,
  PROXY_SCOPE_OPTIONS
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
    this.initUserConfig()
    this.initSystemConfig()
  }

  /**
   * Aria2 Configuration Priority
   * system.json > built-in aria2.conf
   * https://aria2.github.io/manual/en/html/aria2c.html
   *
   */
  initSystemConfig () {
    this.systemConfig = new Store({
      name: 'system',
      cwd: getConfigBasePath(),
      /* eslint-disable quote-props */
      defaults: {
        'all-proxy': EMPTY_STRING,
        'allow-overwrite': false,
        'auto-file-renaming': true,
        'bt-exclude-tracker': EMPTY_STRING,
        'bt-force-encryption': false,
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
        'max-overall-upload-limit': 0,
        'no-proxy': EMPTY_STRING,
        'pause-metadata': false,
        'pause': true,
        'rpc-listen-port': ENGINE_RPC_PORT,
        'rpc-secret': EMPTY_STRING,
        'seed-ratio': 2,
        'seed-time': 2880,
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
      cwd: getConfigBasePath(),
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
        'auto-check-update': is.macOS(),
        'auto-hide-window': false,
        'auto-sync-tracker': true,
        'enable-upnp': true,
        'engine-max-connection-per-server': getMaxConnectionPerServer(),
        'favorite-directories': [],
        'hide-app-menu': is.windows() || is.linux(),
        'history-directories': [],
        'keep-seeding': false,
        'keep-window-state': false,
        'last-check-update-time': 0,
        'last-sync-tracker-time': 0,
        'locale': app.getLocale(),
        'log-level': 'warn',
        'new-task-show-downloading': true,
        'no-confirm-before-delete-task': false,
        'open-at-login': false,
        'protocols': { 'magnet': true, 'thunder': false },
        'proxy': {
          'enable': false,
          'server': EMPTY_STRING,
          'bypass': EMPTY_STRING,
          'scope': PROXY_SCOPE_OPTIONS
        },
        'resume-all-when-app-launched': false,
        'run-mode': APP_RUN_MODE.STANDARD,
        'show-progress-bar': true,
        'task-notification': true,
        'theme': APP_THEME.AUTO,
        'tracker-source': [
          NGOSANG_TRACKERS_BEST_IP_URL_CDN,
          NGOSANG_TRACKERS_BEST_URL_CDN
        ],
        'tray-theme': APP_THEME.AUTO,
        'tray-speedometer': is.macOS(),
        'update-channel': 'latest',
        'window-state': {}
      }
      /* eslint-enable quote-props */
    })
    this.fixUserConfig()
  }

  fixSystemConfig () {
    // Remove aria2c unrecognized options
    const { others } = separateConfig(this.systemConfig.store)
    if (others && Object.keys(others).length > 0) {
      Object.keys(others).forEach(key => {
        this.systemConfig.delete(key)
      })
    }

    const proxy = this.getUserConfig('proxy', { enable: false })
    const { enable, server, bypass, scope = [] } = proxy
    if (enable && server && scope.includes(PROXY_SCOPES.DOWNLOAD)) {
      this.setSystemConfig('all-proxy', server)
      this.setSystemConfig('no-proxy', bypass)
    }

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
