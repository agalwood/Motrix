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
   *
   * Best bt trackers
   * https://github.com/ngosang/trackerslist
   */
  initSystemConfig () {
    this.systemConfig = new Store({
      name: 'system',
      defaults: {
        'all-proxy': '',
        'allow-overwrite': true,
        'auto-file-renaming': true,
        'bt-tracker': [
          'udp://62.138.0.158:6969/announce',
          'udp://188.241.58.209:6969/announce',
          'udp://188.241.58.209:6969/announce',
          'udp://208.83.20.20:6969/announce',
          'udp://151.80.120.115:2710/announce',
          'udp://185.225.17.100:1337/announce',
          'udp://151.80.120.113:2710/announce',
          'udp://62.210.88.151:1337/announce',
          'http://176.113.71.19:6961/announce',
          'http://104.27.134.253:8080/announce',
          'udp://5.2.79.219:1337/announce',
          'udp://91.216.110.52:451/announce',
          'udp://5.206.58.23:6969/announce',
          'udp://159.100.245.181:6969/announce',
          'udp://5.2.79.22:6969/announce',
          'udp://176.31.241.153:80/announce',
          'udp://95.211.168.204:2710/announce',
          'udp://188.246.227.212:80/announce',
          'udp://51.38.184.185:6969/announce',
          'udp://51.15.40.114:80/announce',
          'udp://tracker.coppersurfer.tk:6969/announce',
          'udp://tracker.open-internet.nl:6969/announce',
          'udp://tracker.leechers-paradise.org:6969/announce',
          'udp://exodus.desync.com:6969/announce',
          'udp://tracker.internetwarriors.net:1337/announce',
          'udp://9.rarbg.to:2710/announce',
          'udp://9.rarbg.me:2710/announce',
          'udp://tracker.opentrackr.org:1337/announce',
          'http://tracker3.itzmx.com:6961/announce',
          'http://tracker1.itzmx.com:8080/announce',
          'udp://open.demonii.si:1337/announce',
          'udp://tracker.torrent.eu.org:451/announce',
          'udp://tracker.tiny-vps.com:6969/announce',
          'udp://tracker.cyberia.is:6969/announce',
          'udp://denis.stalker.upeer.me:6969/announce',
          'udp://thetracker.org:80/announce',
          'udp://bt.xxx-tracker.com:2710/announce',
          'udp://open.stealth.si:80/announce',
          'udp://tracker.port443.xyz:6969/announce',
          'udp://ipv4.tracker.harry.lu:80/announce'
        ].join(','),
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
